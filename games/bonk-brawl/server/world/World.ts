// Authoritative per-tick simulation. Owner: server-world.
//
// GameWorld owns every gameplay RULE that happens inside a tick: inputs → shared sim → pickups,
// throws, hits, knockback, catches (lag-compensated), dodge i-frames, the 6 abilities, the 4
// power-up effects, ring-outs + last-hitter credit, player separation, hearts and eliminations.
// It mutates the schema state directly (players' sim fields + hearts/alive, balls, powerUps, rings)
// and reports what happened as GameEvents.
//
// It does NOT own: phases/timers, scoring/points/stats/crown, deciding when to spawn balls or
// power-ups or drop rings, ping/RTT measurement, joining/leaving, broadcasting. That is BonkRoom.
//
// Determinism: player/ball motion goes exclusively through shared/sim stepPlayer/stepBall so the
// client's prediction matches. Iterate players and balls in a stable order (insertion order of
// the MapSchemas) every tick.

import {
  BALL_RADIUS,
  BALL_SPAWN_ATTEMPTS,
  BALL_SPAWN_EDGE_MARGIN,
  BALL_SPAWN_HEIGHT,
  BALL_SPAWN_SPACING,
  BELLY_BOUNCE_DEFLECT_SPEED,
  BOOMERANG_CATCH_RADIUS,
  BUMP_MIN_SPEED,
  BUMP_POP_VY,
  BUMP_RESTITUTION,
  BUMP_STUN_MIN_IMPULSE,
  BUMP_STUN_TICKS,
  CATCH_WINDOW_TICKS,
  CHARACTERS,
  CHEST_HEIGHT,
  DT,
  FULL_CHARGE_THRESHOLD,
  HEADBUTT_HIT_RANGE,
  HEADBUTT_KNOCK_H,
  HEADBUTT_KNOCK_UP,
  HIT_DAMAGE,
  HURT_INVULN_TICKS,
  LAG_COMP_MAX_TICKS,
  MAX_HEARTS,
  PEDESTAL_HEIGHT,
  PICKUP_MAX_HEIGHT,
  PICKUP_RADIUS,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SEPARATION,
  POWERUP_HOVER_Y,
  POWERUP_PICKUP_RADIUS,
  RING_FALLEN,
  RING_OUT_CREDIT_TICKS,
  RING_SHAKING,
  RING_SOLID,
  SHOCKWAVE_KNOCK_H,
  SHOCKWAVE_KNOCK_UP,
  SHOCKWAVE_RADIUS,
  ZOOMIES_TICKS,
} from "../../shared/constants.js";
import { pedestalPosition, type ArenaDef } from "../../shared/maps.js";
import type { InputCmd } from "../../shared/protocol.js";
import { stepBall } from "../../shared/sim/ball.js";
import type { BallContext, FloorQuery, SimContext } from "../../shared/sim/context.js";
import {
  isFloorAt,
  pointInCover,
  resolveCoverCollision,
  ringIndexAt,
  segmentCapsuleOverlap,
  sphereCapsuleOverlap,
} from "../../shared/sim/geometry.js";
import { vec3, type Vec3 } from "../../shared/sim/math.js";
import {
  copyPlayerSim,
  createPlayerSim,
  DASH_EXIT_SPEED,
  hasRollIFrames,
  isBouncy,
  isInvulnerable,
  isMovementAbilityActive,
  playerHeight,
  stepPlayer,
  type StepPlayerResult,
  type ThrowRequest,
} from "../../shared/sim/player.js";
import {
  aimDirection,
  ballKindForPowerUp,
  chestPosition,
  computeThrowVelocities,
  heartsKnockMultiplier,
  knockStunTicks,
  launchVelocity,
  throwOrigin,
} from "../../shared/sim/throw.js";
import type { BallKind, CharacterId, PowerUpType, Vec3Like } from "../../shared/types.js";
import { BallEntity, PowerUpEntity, type BonkState, type PlayerState } from "../schema.js";
import { ballIdNumber, bounceOffTarget, deflectAway, launch, makeHeld, makeLoose } from "./balls.js";
import type { GameEvent } from "./events.js";
import { BallHistory, type BallSample } from "./history.js";
import { InputQueues, sanitizeInput } from "./inputs.js";
import { ballHitKnockback, catchDistance, catchDistanceSwept, maxHeldBalls, radialKnockback, ringOutCredit, SHOCKWAVE_MAX_DY } from "./rules.js";

export interface WorldOptions {
  /** RNG for cosmetic jitter only (e.g. dead-ball scatter). Default Math.random. */
  random?: () => number;
}

export interface WorldStepOptions {
  /**
   * Integration scale: 1 normally, ROUND_END_SLOWMO_SCALE during the round-end slow-mo.
   * Passed to the sim as ctx.dt = DT * dtScale. Timers still tick by 1 per step.
   */
  dtScale: number;
  /** Input locked (countdown, round-end): look only, no movement/buttons (SimContext.locked). */
  locked: boolean;
  /**
   * Combat rules on (playing/suddenDeath). When false: no pickups, power-up pickups, hits,
   * catches, deflects, headbutt hits, shockwave knockback or eliminations. Balls and players
   * still move and bounce (round-end slow-mo, countdown ball drop).
   */
  combat: boolean;
}

/** A player's lag-compensated catch window: covers ticks [start, end). */
interface CatchWindow {
  start: number;
  end: number;
  rewind: number;
  /** Next ball-history tick to test. */
  nextTest: number;
}

/** After a catch, balls of the same throw bounce off the catcher until `until`. */
interface SiblingGuard {
  ownerId: string;
  throwSeq: number;
  until: number;
}

/** Per-player data that lives for one round. */
interface PlayerRuntime {
  lastHitBy: string;
  lastHitTick: number;
  /** Last grounded feet position (ring-out ghost anchor). */
  ground: Vec3;
  window: CatchWindow | null;
  guard: SiblingGuard | null;
}

/** A hit on a player with rewind ticks, delayed so a late-arriving catch press can still win. */
interface PendingHit {
  ballId: string;
  targetId: string;
  throwerId: string;
  throwSeq: number;
  hitTick: number;
  applyAt: number;
  pos: Vec3Like;
  radius: number;
  knockback: Vec3Like;
  charge: number;
  kind: BallKind;
}

interface CatchCandidate {
  ballId: string;
  pos: Vec3Like;
  distance: number;
  pending: PendingHit | null;
}

interface RosterEntry {
  id: string;
  p: PlayerState;
}

/** Abilities whose event direction is the locked dash/lunge/slide direction (else the aim). */
const DIRECTIONAL_ABILITIES: ReadonlySet<string> = new Set(["flapDash", "bellySlide", "headbutt"]);
/** Pickup band below the feet (balls resting on the floor sit at feet + radius). */
const PICKUP_MIN_DY = -0.3;
/** Power-ups are only reachable from roughly floor level (not while falling past a pedestal). */
const POWERUP_PICKUP_MIN_Y = -1;
const POWERUP_PICKUP_MAX_Y = 2.5;
/** Horizontal scatter of balls dropped by an eliminated player (cosmetic). */
const DROP_SCATTER_SPEED = 0.6;

function point(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

function posOf(o: Vec3Like): Vec3Like {
  return { x: o.x, y: o.y, z: o.z };
}

function dist2D(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Launch a player (ball hit, shockwave, headbutt): velocity = v, airborne, stunned for
 * knockStunTicks(v) (the whole flight + a short get-up), jump/skid cleared, roll, charge and
 * movement abilities cancelled. Ball hits add damage-specific bits on top (see applyHit).
 */
function applyLaunch(p: PlayerState, v: Vec3Like): void {
  p.vx = v.x;
  p.vy = v.y;
  p.vz = v.z;
  p.grounded = false;
  p.stunTicks = knockStunTicks(v);
  p.jumping = false;
  p.skid = false;
  p.rollTicks = 0;
  p.chargeTicks = 0;
  if (isMovementAbilityActive(p, p.character)) {
    p.abilityTicks = 0;
    p.abilityPhase = 0;
  }
}

function speedOf(v: Vec3Like): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function clampHorizontalSpeed(p: PlayerState, max: number): void {
  const speed = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  if (speed <= max) return;
  p.vx *= max / speed;
  p.vz *= max / speed;
}

export class GameWorld {
  readonly state: BonkState;
  /** Current arena (changes between rounds via setArena). */
  arena: ArenaDef;

  private readonly random: () => number;
  private readonly inputs = new InputQueues();
  private readonly rewind = new Map<string, number>();
  private readonly history = new BallHistory();
  private readonly runtime = new Map<string, PlayerRuntime>();
  /** Plain mirror of state.rings: the sim's floor queries read it every sub-step. */
  private readonly rings: number[] = [];
  private pendingHits: PendingHit[] = [];
  private events: GameEvent[] = [];
  private nextBallId = 1;
  private nextPowerUpId = 1;

  private readonly simCtx: SimContext;
  private readonly ballCtx: BallContext;
  private readonly steer = vec3();
  private readonly returnTarget = vec3();
  private readonly scratch = vec3();
  /** Each loose ball's position before this tick's stepBall (swept hit tests), by ball id. */
  private readonly prevPos = new Map<string, Vec3>();
  /** separatePlayers scratch (reused every tick, no per-tick allocation). */
  private readonly sepAlive: RosterEntry[] = [];
  private readonly sepMoved: boolean[] = [];

  constructor(state: BonkState, arena: ArenaDef, opts: WorldOptions = {}) {
    this.state = state;
    this.arena = arena;
    this.random = opts.random ?? Math.random;
    this.simCtx = { arena, rings: this.rings, character: "quacky", dt: DT, locked: false };
    this.ballCtx = { arena, rings: this.rings, dt: DT, steer: null, returnTarget: null };
    this.fitRings();
  }

  /* ------------------------------------------------------------------ inputs */

  /**
   * Validate and enqueue one input for a player. Drop it if the player doesn't exist, isn't
   * alive, or seq <= the last queued/consumed seq. Clamp: moveX/moveZ to [-1,1] (and the vector
   * length to 1), pitch to ±PITCH_LIMIT, yaw finite (wrap), buttons & 63. Non-finite numbers → drop.
   * If the queue already holds INPUT_QUEUE_MAX inputs, drop the OLDEST first — but OR its edge
   * bits (EDGE_BUTTONS) into the next remaining input so a press is never lost.
   */
  queueInput(sessionId: string, cmd: InputCmd): void {
    const p = this.state.players.get(sessionId);
    if (!p || !p.alive) return;
    const clean = sanitizeInput(cmd);
    if (clean) this.inputs.push(sessionId, clean);
  }

  /**
   * Forget a player's queued inputs, last input AND last seen seq, and set player.lastSeq = 0
   * (all players when sessionId is omitted). The room calls it for a player on join and on every
   * reconnect, because a reloaded client restarts its seq counter at 1 (any strictly increasing
   * sequence is accepted after this). resetForRound does NOT call it: the client's seq keeps
   * increasing across rounds within a connection.
   */
  clearInputs(sessionId?: string): void {
    this.inputs.clear(sessionId);
    if (sessionId === undefined) {
      this.state.players.forEach((p) => {
        p.lastSeq = 0;
      });
      return;
    }
    const p = this.state.players.get(sessionId);
    if (p) p.lastSeq = 0;
  }

  /**
   * Lag-compensation rewind for a player's catches, from the room's RTT EMA:
   * rewindTicksForRtt(rtt) (≤ LAG_COMP_MAX_TICKS). Also delays hits ON this player (see step()).
   */
  setRewindTicks(sessionId: string, ticks: number): void {
    const r = Number.isFinite(ticks) ? Math.max(0, Math.min(LAG_COMP_MAX_TICKS, Math.round(ticks))) : 0;
    this.rewind.set(sessionId, r);
  }

  /** Current rewind ticks of a player (0 when unknown). */
  rewindTicksOf(sessionId: string): number {
    return this.rewind.get(sessionId) ?? 0;
  }

  /* --------------------------------------------------------- round lifecycle */

  /**
   * Switch arena (room calls it before resetForRound when the map changes). Resizes state.rings
   * IN PLACE (clear()/push or index writes) — never assign a new ArraySchema to state.rings, so
   * client FloorQuery objects holding the decoded state.rings stay valid.
   */
  setArena(arena: ArenaDef): void {
    this.arena = arena;
    this.fitRings();
  }

  /**
   * Prepare a new round:
   * - state.rings = arena.ringRadii.length zeros (in place); balls and powerUps cleared with
   *   MapSchema.clear() (never reassign any state collection: clients hold references); internal histories,
   *   pending hits, last-hitter records, last-grounded positions and queued inputs cleared (the
   *   per-player last seen seq is kept, see clearInputs).
   * - For each participant (sessionIds, in slot order): copyPlayerSim(createPlayerSim()) then
   *   position at arena.spawns[player.slot] (y = 0, yaw = spawn.yaw, pitch = 0, dir = forward),
   *   alive = true, hearts = MAX_HEARTS, grounded = true. Everyone else in state.players:
   *   copyPlayerSim(createPlayerSim()) too (alive = false, heldCount = 0, powerUp = "").
   * Does NOT spawn balls (the room calls spawnBall) and does not touch points/stats/lastSeq.
   * The room also calls resetForRound([]) when returning to the lobby: it clears balls, power-ups
   * and rings and leaves everyone alive = false.
   */
  resetForRound(participants: readonly string[]): void {
    this.resetRings();
    this.state.balls.clear();
    this.state.powerUps.clear();
    this.history.clear();
    this.prevPos.clear();
    this.pendingHits = [];
    this.runtime.clear();
    this.inputs.resetQueues();

    const fresh = createPlayerSim();
    const inRound = new Set(participants);
    this.state.players.forEach((p, id) => {
      copyPlayerSim(fresh, p);
      p.hearts = MAX_HEARTS;
      if (inRound.has(id)) this.placeAtSpawn(id, p);
    });
  }

  /**
   * Eliminate a player outside normal combat (disconnect grace expired mid-round, or a consented
   * leave while alive mid-round): alive = false, drop held balls (as dead balls at their chest with
   * zero velocity, ownerId ""), clear their power-up, emit `ko` { cause: "disconnect", byId: "" }.
   * No-op if not alive.
   */
  eliminate(sessionId: string, cause: "disconnect"): void {
    const p = this.state.players.get(sessionId);
    if (!p || !p.alive) return;
    const pos = posOf(p);
    this.eliminatePlayer(sessionId, p);
    this.emit({ type: "ko", tick: this.state.tick, playerId: sessionId, byId: "", cause, pos });
  }

  /** Forget everything about a player who left the room (queues, rewind, history, pending hits). */
  removePlayer(sessionId: string): void {
    const p = this.state.players.get(sessionId);
    if (p) this.dropHeldBalls(sessionId, p);
    this.inputs.clear(sessionId);
    this.rewind.delete(sessionId);
    this.runtime.delete(sessionId);
    this.pendingHits = this.pendingHits.filter((h) => h.targetId !== sessionId);
    for (const rt of this.runtime.values()) {
      if (rt.lastHitBy === sessionId) rt.lastHitBy = "";
    }
  }

  /* ---------------------------------------------------------------- spawning */

  /**
   * Add a neutral ball dropping from the sky at a random spot on the remaining island
   * (randomBallSpot), y = BALL_SPAWN_HEIGHT, zero velocity. Ids are "b1", "b2", ... (never reused
   * within the room). Emits `ballSpawn`. Returns the ball id.
   */
  spawnBall(): string {
    const { x, z } = this.randomBallSpot();
    const ball = this.createBall();
    makeLoose(ball, "neutral", point(x, BALL_SPAWN_HEIGHT, z));
    this.emit({ type: "ballSpawn", tick: this.state.tick, ballId: ball.id, pos: posOf(ball) });
    return ball.id;
  }

  /** Balls in play that count toward the arena target: every non-bonus ball, in any state (incl. held). */
  countBalls(): number {
    let count = 0;
    this.state.balls.forEach((b) => {
      if (b.kind !== "bonus") count++;
    });
    return count;
  }

  /**
   * Put a power-up on a pedestal in "warning" phase (shimmer, not pickable). Ids "p1", "p2", ...
   * Emits `powerUpWarning`. Returns the id. The room calls activatePowerUp after POWERUP_WARNING_TICKS.
   */
  spawnPowerUpWarning(pedestal: number, type: PowerUpType): string {
    const last = this.arena.pedestals.length - 1;
    const index = Number.isFinite(pedestal) ? Math.max(0, Math.min(last, Math.floor(pedestal))) : 0;
    const spot = pedestalPosition(this.arena, index);
    const pu = new PowerUpEntity();
    pu.id = `p${this.nextPowerUpId++}`;
    pu.type = type;
    pu.pedestal = index;
    pu.phase = "warning";
    pu.x = spot.x;
    pu.z = spot.z;
    this.state.powerUps.set(pu.id, pu);
    const pos = this.powerUpPos(pu);
    this.emit({ type: "powerUpWarning", tick: this.state.tick, id: pu.id, powerUpType: pu.type, pedestal: index, pos });
    return pu.id;
  }

  /** warning → ready (pickable). Emits `powerUpSpawn`. No-op if the id is gone (ring fell). */
  activatePowerUp(id: string): void {
    const pu = this.state.powerUps.get(id);
    if (!pu || pu.phase !== "warning") return;
    pu.phase = "ready";
    this.emit({ type: "powerUpSpawn", tick: this.state.tick, id, powerUpType: pu.type, pedestal: pu.pedestal, pos: this.powerUpPos(pu) });
  }

  /** Remove all power-ups (no events). */
  clearPowerUps(): void {
    this.state.powerUps.clear();
  }

  /** Power-ups on the map (warning or ready). */
  powerUpCount(): number {
    return this.state.powerUps.size;
  }

  /** Indexes of pedestals standing on a RING_SOLID ring (not shaking, not fallen). */
  solidPedestals(): number[] {
    const out: number[] = [];
    this.arena.pedestals.forEach((ped, i) => {
      const ring = ringIndexAt(this.arena, ped.x, ped.z);
      if (ring >= 0 && (ring >= this.rings.length || this.rings[ring] === RING_SOLID)) out.push(i);
    });
    return out;
  }

  /* -------------------------------------------------------------------- rings */

  /** state.rings[index] = RING_SHAKING; emits `ringShake`. Ring 0 never shakes. */
  shakeRing(index: number): void {
    if (!this.isDroppableRing(index) || this.rings[index] !== RING_SOLID) return;
    this.setRing(index, RING_SHAKING);
    this.emit({ type: "ringShake", tick: this.state.tick, ring: index });
  }

  /**
   * state.rings[index] = RING_FALLEN; emits `ringDrop`. Removes power-ups whose pedestal lies on
   * that ring (no pickup). Players/balls on it start falling naturally next tick via the sim.
   * Ring 0 never falls.
   */
  dropRing(index: number): void {
    if (!this.isDroppableRing(index) || this.rings[index] === RING_FALLEN) return;
    this.setRing(index, RING_FALLEN);
    const stranded: string[] = [];
    this.state.powerUps.forEach((pu, id) => {
      if (!isFloorAt(this.floor(), pu.x, pu.z)) stranded.push(id);
    });
    for (const id of stranded) this.state.powerUps.delete(id);
    this.emit({ type: "ringDrop", tick: this.state.tick, ring: index });
  }

  /** Index of the outermost ring still RING_SOLID (>= 1), or -1 when only ring 0 remains. */
  outermostSolidRing(): number {
    for (let i = this.rings.length - 1; i >= 1; i--) {
      if (this.rings[i] === RING_SOLID) return i;
    }
    return -1;
  }

  /* ------------------------------------------------------------------ the tick */

  /**
   * Advance the world by one server tick. Returns every event since the last step/drain, in order.
   *
   * Order:
   *  1. Inputs: for each player in state.players with alive = true: take ONE input from the queue
   *     (empty → repeat the last input with EDGE_BUTTONS cleared; disconnected players → a neutral
   *     input: no move, no buttons, same look). player.lastSeq = consumed seq (unchanged when repeating).
   *     Players not alive: drain their queue, still update lastSeq.
   *  2. Players: stepPlayer(player, input, { arena, rings, character, dt: DT*dtScale, locked }).
   *     Handle the StepPlayerResult:
   *     - throw: (combat only; when !combat the sim never throws because locked cancels charges)
   *       turn the player's first held ball (lowest id with holderId === player) into a live ball
   *       at result.origin with computeThrowVelocities(charge, yaw, pitch, powerUp)[0];
   *       kind = ballKindForPowerUp, radius MEGA_BALL_RADIUS for mega (else BALL_RADIUS), ownerId,
   *       holderId "", throwSeq = input.seq, throwIndex 0, charge, curve, ageTicks/restTicks/
   *       bounces 0, returning false. Triple Shot also creates 2 NEW balls (kind "bonus",
   *       throwIndex 1/2, same ownerId/throwSeq/charge/curve) with the side velocities, all at
   *       result.origin. If the server finds no held ball (prediction mismatch) nothing is thrown
   *       and no event is emitted. Emit `throw`.
   *     - catchStarted: open the lag-compensated window (see catches below).
   *     - whiffStarted: emit `whiff`.
   *     - abilityStarted: emit `ability` (all 6). Whiskers' curveball just arms.
   *     - slamLanded: shockwave — every OTHER alive player whose feet are within SHOCKWAVE_RADIUS
   *       (horizontal) and |dy| < 1.5: applyLaunch(radialKnockback(SHOCKWAVE_KNOCK_H,
   *       SHOCKWAVE_KNOCK_UP, × heartsKnockMultiplier(their hearts))), record last-hitter credit; no
   *       damage. Roll i-frames dodge it. Emit `shockwave` with the affected ids and their knockbacks.
   *     - fellOut (combat): eliminate with `ringOut` (creditId = last hitter if within
   *       RING_OUT_CREDIT_TICKS, else ""); pos = last grounded position.
   *  3. Headbutt: for each alive Gruff with abilityTicks > 0: the first other alive player whose
   *     capsule is within HEADBUTT_HIT_RANGE in front of Gruff's chest (front half-space) gets
   *     applyLaunch(launchVelocity(Gruff's dir, HEADBUTT_KNOCK_H, HEADBUTT_KNOCK_UP,
   *     heartsKnockMultiplier(target hearts))), credit; Gruff's abilityTicks = 0. Roll i-frames
   *     dodge it; Mochi's Belly Bounce does NOT. Emit `headbutt` (+ launchSpeed).
   *  4. Player separation: push overlapping alive capsules apart horizontally (half each) so their
   *     centers are >= PLAYER_SEPARATION apart; skip pairs with |dy| > PLAYER_HEIGHT. With combat on,
   *     a pair where at least one is stunned and the relative normal speed > BUMP_MIN_SPEED bumps
   *     (momentum exchange, pop/stun of the non-stunned one, credit inherited; see bump()). `bump`.
   *  5. Held balls: position at the holder's throwOrigin, zero velocity.
   *  6. Pickups (combat): neutral ball within PICKUP_RADIUS horizontally and feet-0.3 ≤ ball.y ≤
   *     feet+PICKUP_MAX_HEIGHT of an alive player with heldCount < max (MAX_HELD_BALLS, or
   *     MAX_HELD_BALLS_TRIPLE while powerUp === "triple") and catchTicks == 0 → make it a plain
   *     HELD ball: state "held", holderId, ownerId "", kind "normal", radius BALL_RADIUS, v = 0,
   *     charge 0, curve/returning false, throwSeq/throwIndex 0, ageTicks/restTicks/bounces 0;
   *     heldCount++. Closest player wins; ties → lower slot. Emit `pickup`. Bonus balls are never
   *     picked up (they are removed when they come to rest).
   *     Power-up pickups: alive player within POWERUP_PICKUP_RADIUS of a "ready" power-up:
   *     zoomies → zoomiesTicks = ZOOMIES_TICKS; others → player.powerUp = type (replaces any held one).
   *     Remove it, emit `powerUpPickup`.
   *  7. Balls: for each non-held ball: stepBall(ball, { arena, rings, dt, steer, returnTarget })
   *     where steer = owner's current aim direction for live curve balls and returnTarget = owner's
   *     chest for boomerangs (null if owner not alive). Handle the result:
   *     - startedReturning → emit `boomerangReturn` { caught: false }.
   *     - becameNeutral on a bonus ball → remove it, emit internal `ballLost` { respawn: false }.
   *     - lost → remove it, emit `ballLost` { respawn: kind !== "bonus" }.
   *     A returning live boomerang within BOOMERANG_CATCH_RADIUS of its owner's chest (combat or
   *     not): if the owner is alive and has room → a plain held ball of the owner like a pickup
   *     (heldCount++), else it turns dead; emit `boomerangReturn` { caught: true }. No points.
   *     Then record every ball's (x, y, z, state) in its history ring buffer (BALL_HISTORY_TICKS).
   *  8. Catches & hits (combat), per live ball, per alive non-owner player (stable order):
   *     a. CATCH (lag-compensated). A player's catch window, opened at server tick T by a catch
   *        press with rewind r = that player's rewind ticks, covers ticks [S, S + CATCH_WINDOW_TICKS)
   *        with S = T - r. On opening, test the history of every live ball at ticks S..T; each tick
   *        after, test current positions while tick < S + CATCH_WINDOW_TICKS. A ball is caught when
   *        its center (swept between consecutive in-window history samples) is within CATCH_RANGE (+ ball radius) of catchCenter = chest + forward(yaw) *
   *        CATCH_FORWARD_OFFSET AND it is in the front half-space (dot(ballPos - chest, forward) > 0).
   *        Catch result: ball → a plain HELD ball of the catcher exactly like a pickup (a caught
   *        mega/boomerang/bonus ball becomes kind "normal"; the arena may then briefly hold more
   *        balls than its target, which the room's respawn rule absorbs), heldCount++ — or, if
   *        their hands are full, dropped neutral at their feet (kind "normal" too; kept = false);
   *        catcher catchTicks = 0, whiffTicks = 0 (no whiff);
   *        THROWER loses 1 heart (0 → eliminate with `ko` cause "caught", byId = catcher).
   *        Emit `catch` (then `ko` if any). Also converts a PENDING hit (below) on that player whose
   *        hit tick is >= S.
   *        One catch per press: the window closes on the first catch (several candidates in the
   *        same test → the closest to catchCenter). Sibling balls of the caught throw (same ownerId
   *        + throwSeq, i.e. the Triple Shot side balls) that touch the catcher during the next
   *        CATCH_WINDOW_TICKS ticks (or are pending hits on them) bounce off harmlessly exactly
   *        like a Belly Bounce deflect (dead, emit `deflect`), so one catch never costs the
   *        thrower more than 1 heart and the catcher isn't hit right after a perfect catch.
   *     b. HIT: segmentCapsuleOverlap(ball position before this tick's step → now, radius, player
   *        feet, PLAYER_RADIUS, playerHeight(p, char)) (swept, so a fast ball can't skip the capsule).
   *        - isInvulnerable (roll i-frames or hurtTicks): the ball passes through, no effect.
   *        - Mochi bouncy: reflect the ball's horizontal velocity away from Mochi at
   *          BELLY_BOUNCE_DEFLECT_SPEED, state dead, emit `deflect`. No damage.
   *        - otherwise: if the target's rewind r == 0 apply now; else record a PendingHit
   *          { ball, target, tick, knockback } resolved at tick + r unless a catch converts it
   *          (the ball is set dead immediately and bounces off as usual so visuals stay prompt).
   *          Applying a hit: hearts -= HIT_DAMAGE; knockback = ballHitKnockback(ball, target, hearts
   *          after the hit) (launchVelocity of the ball's horizontal direction, KNOCKBACK_H/UP ×
   *          knockbackMultiplier(charge, kind) × heartsKnockMultiplier, ≤ KNOCK_MAX_SPEED);
   *          applyLaunch (velocity, airborne, stunTicks = knockStunTicks), hurtTicks =
   *          max(HURT_INVULN_TICKS, stunTicks) (no juggling a tumbling body); cancel roll, ability
   *          (abilityTicks = 0, abilityPhase = 0), charge, catch window; last-hitter = thrower @ tick. Ball → dead with its velocity reflected
   *          and halved. Emit `hit` (then `ko` cause "hits" if hearts == 0).
   *        A live ball never hits its own thrower (OWNER_IMMUNE).
   *  9. Eliminations (combat): alive = false; held balls dropped as dead balls at the chest
   *     (ownerId ""), heldCount = 0; powerUp = ""; zoomies/ability/charge/catch cleared. Eliminated
   *     players are no longer stepped (stepPlayer no-ops when !alive), so their schema position
   *     freezes: where they were KO'd, or just below RING_OUT_Y for ring-outs. The client animates
   *     the KO pop / ring-out fall and the ghost cosmetically (Characters "ko" / "ringOut").
   *
   * Every emitted event has tick = state.tick.
   *
   * Implementation notes: a player with a pending hit is treated as already hit (further balls
   * pass through, like the post-hit mercy window of an immediate hit), and a pending hit that
   * comes due while its target is no longer alive is discarded.
   */
  step(opts: WorldStepOptions): GameEvent[] {
    const tick = this.state.tick;
    const dt = DT * (Number.isFinite(opts.dtScale) && opts.dtScale > 0 ? opts.dtScale : 1);
    this.simCtx.arena = this.arena;
    this.ballCtx.arena = this.arena;

    const roster = this.roster();
    this.stepPlayers(roster, tick, dt, opts);
    if (opts.combat) this.resolveHeadbutts(roster, tick);
    this.separatePlayers(roster, tick, opts.combat);
    this.pinHeldBalls();
    if (opts.combat) {
      this.pickUpBalls(roster, tick);
      this.pickUpPowerUps(roster, tick);
    }
    this.stepBalls(tick, dt);
    if (opts.combat) {
      this.resolveCatches(roster, tick);
      this.resolvePendingHits(tick);
      this.resolveHits(roster, tick);
    }
    return this.drainEvents();
  }

  /** Return and clear events produced outside step() (spawn/ring/eliminate calls in non-stepping phases). */
  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** sessionIds of alive players (participants still in the round), in insertion order. */
  alivePlayers(): string[] {
    const ids: string[] = [];
    this.state.players.forEach((p, id) => {
      if (p.alive) ids.push(id);
    });
    return ids;
  }

  /* ============================================================ 1–2. players */

  private stepPlayers(roster: RosterEntry[], tick: number, dt: number, opts: WorldStepOptions): void {
    for (const { id, p } of roster) {
      const input = this.nextInput(id, p);
      if (!p.alive) continue;
      const result = stepPlayer(p, input, this.playerCtx(p.character, dt, opts.locked));
      if (p.grounded) this.rememberGround(id, p);
      this.handleStepResult(id, p, input, result, tick, opts.combat, roster);
    }
  }

  private nextInput(id: string, p: PlayerState): InputCmd {
    if (!p.alive || !p.connected) {
      const drained = this.inputs.drain(id);
      if (drained > 0) p.lastSeq = drained;
      // A dropped connection must not fire the half-charged throw it was holding.
      if (p.alive) p.chargeTicks = 0;
      return this.neutralInput(p);
    }
    const taken = this.inputs.take(id);
    if (!taken) return this.neutralInput(p);
    if (taken.consumed) p.lastSeq = taken.cmd.seq;
    return taken.cmd;
  }

  private neutralInput(p: PlayerState): InputCmd {
    return { seq: p.lastSeq, moveX: 0, moveZ: 0, yaw: p.yaw, pitch: p.pitch, buttons: 0 };
  }

  private playerCtx(character: CharacterId, dt: number, locked: boolean): SimContext {
    this.simCtx.character = character;
    this.simCtx.dt = dt;
    this.simCtx.locked = locked;
    return this.simCtx;
  }

  private handleStepResult(
    id: string,
    p: PlayerState,
    input: InputCmd,
    result: StepPlayerResult,
    tick: number,
    combat: boolean,
    roster: RosterEntry[],
  ): void {
    if (result.throw) this.performThrow(id, p, result.throw, input.seq, tick);
    if (result.catchStarted) this.openCatchWindow(id, tick);
    if (result.whiffStarted) {
      this.runtimeOf(id).window = null;
      this.emit({ type: "whiff", tick, playerId: id, pos: posOf(p) });
    }
    if (result.abilityStarted) this.emitAbility(id, p, tick);
    if (result.slamLanded) this.shockwave(id, p, roster, tick, combat);
    if (result.fellOut && combat) this.ringOut(id, p, tick);
  }

  private performThrow(id: string, p: PlayerState, req: ThrowRequest, seq: number, tick: number): void {
    const ball = this.firstHeldBall(id);
    if (!ball) {
      p.heldCount = this.countHeld(id);
      return;
    }
    const velocities = computeThrowVelocities(req.charge, req.yaw, req.pitch, req.powerUp);
    const kind = ballKindForPowerUp(req.powerUp);
    const base = { ownerId: id, throwSeq: seq, charge: req.charge, curve: req.curve, origin: req.origin };
    const ballIds: string[] = [];
    velocities.forEach((velocity, throwIndex) => {
      const b = throwIndex === 0 ? ball : this.createBall();
      launch(b, { ...base, throwIndex, kind: throwIndex === 0 ? kind : "bonus", velocity });
      this.history.delete(b.id);
      ballIds.push(b.id);
    });
    this.emit({
      type: "throw",
      tick,
      ownerId: id,
      character: p.character,
      throwSeq: seq,
      ballIds,
      charge: req.charge,
      kind,
      powerUp: req.powerUp,
      curve: req.curve,
      origin: posOf(req.origin),
      velocities: velocities.map(posOf),
    });
  }

  private openCatchWindow(id: string, tick: number): void {
    const rewind = this.rewindTicksOf(id);
    const start = tick - rewind;
    this.runtimeOf(id).window = { start, end: start + CATCH_WINDOW_TICKS, rewind, nextTest: start };
  }

  private emitAbility(id: string, p: PlayerState, tick: number): void {
    const ability = CHARACTERS[p.character].ability.id;
    const dir = DIRECTIONAL_ABILITIES.has(ability) ? point(p.dirX, 0, p.dirZ) : posOf(aimDirection(p.yaw, p.pitch));
    this.emit({ type: "ability", tick, playerId: id, character: p.character, ability, pos: posOf(p), dir });
  }

  /** Ground Pound landed: knock nearby players away (no damage). Knockback only with combat on. */
  private shockwave(id: string, p: PlayerState, roster: RosterEntry[], tick: number, combat: boolean): void {
    const affected: string[] = [];
    const knockbacks: Vec3Like[] = [];
    if (combat) {
      const facing = { x: -Math.sin(p.yaw), z: -Math.cos(p.yaw) };
      for (const other of roster) {
        const q = other.p;
        if (other.id === id || !q.alive || hasRollIFrames(q)) continue;
        if (Math.abs(q.y - p.y) >= SHOCKWAVE_MAX_DY) continue;
        if (dist2D(q.x, q.z, p.x, p.z) > SHOCKWAVE_RADIUS) continue;
        const knockback = radialKnockback(p, q, facing, SHOCKWAVE_KNOCK_H, SHOCKWAVE_KNOCK_UP, heartsKnockMultiplier(q.hearts));
        applyLaunch(q, knockback);
        this.creditKnock(other.id, id, tick);
        affected.push(other.id);
        knockbacks.push(knockback);
      }
    }
    this.emit({ type: "shockwave", tick, playerId: id, pos: posOf(p), radius: SHOCKWAVE_RADIUS, affected, knockbacks });
  }

  private ringOut(id: string, p: PlayerState, tick: number): void {
    const rt = this.runtimeOf(id);
    const creditId = ringOutCredit(id, rt.lastHitBy, rt.lastHitTick, tick, RING_OUT_CREDIT_TICKS);
    const pos = posOf(rt.ground);
    this.eliminatePlayer(id, p);
    this.emit({ type: "ringOut", tick, playerId: id, creditId, pos });
  }

  /* ============================================================== 3. headbutt */

  private resolveHeadbutts(roster: RosterEntry[], tick: number): void {
    for (const { id, p } of roster) {
      if (!p.alive || p.character !== "gruff" || p.abilityTicks <= 0) continue;
      const target = this.headbuttTarget(id, p, roster);
      if (!target) continue;
      const mult = heartsKnockMultiplier(target.p.hearts);
      const knockback = posOf(launchVelocity(p.dirX, p.dirZ, HEADBUTT_KNOCK_H, HEADBUTT_KNOCK_UP, mult, this.scratch));
      applyLaunch(target.p, knockback);
      this.creditKnock(target.id, id, tick);
      p.abilityTicks = 0;
      clampHorizontalSpeed(p, DASH_EXIT_SPEED);
      const pos = posOf(chestPosition(target.p));
      this.emit({ type: "headbutt", tick, attackerId: id, targetId: target.id, pos, knockback, launchSpeed: speedOf(knockback) });
    }
  }

  /** Closest other alive player whose capsule is within HEADBUTT_HIT_RANGE of Gruff's chest, in front. */
  private headbuttTarget(id: string, p: PlayerState, roster: RosterEntry[]): RosterEntry | null {
    const chest = chestPosition(p, this.scratch);
    let best: RosterEntry | null = null;
    let bestDist = Infinity;
    for (const other of roster) {
      const q = other.p;
      if (other.id === id || !q.alive || hasRollIFrames(q)) continue;
      if ((q.x - p.x) * p.dirX + (q.z - p.z) * p.dirZ <= 0) continue;
      if (!sphereCapsuleOverlap(chest, HEADBUTT_HIT_RANGE, q, PLAYER_RADIUS, playerHeight(q, q.character))) continue;
      const d = dist2D(q.x, q.z, p.x, p.z);
      if (d < bestDist) {
        best = other;
        bestDist = d;
      }
    }
    return best;
  }

  /* ============================================================ 4. separation */

  private separatePlayers(roster: RosterEntry[], tick: number, combat: boolean): void {
    const alive = this.sepAlive;
    const moved = this.sepMoved;
    alive.length = 0;
    for (const e of roster) if (e.p.alive) alive.push(e);
    moved.length = alive.length;
    moved.fill(false);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i].p;
        const b = alive[j].p;
        if (Math.abs(a.y - b.y) > PLAYER_HEIGHT) continue;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        let d = Math.sqrt(dx * dx + dz * dz);
        if (d >= PLAYER_SEPARATION) continue;
        if (d < 1e-6) {
          dx = 1;
          dz = 0;
          d = 1;
        }
        const push = (PLAYER_SEPARATION - Math.min(d, PLAYER_SEPARATION)) * 0.5;
        const nx = dx / d;
        const nz = dz / d;
        a.x -= nx * push;
        a.z -= nz * push;
        b.x += nx * push;
        b.z += nz * push;
        moved[i] = true;
        moved[j] = true;
        if (combat && (a.stunTicks > 0 || b.stunTicks > 0)) this.bump(alive[i], alive[j], nx, nz, tick);
      }
    }
    for (let i = 0; i < alive.length; i++) if (moved[i]) this.pushOutOfCover(alive[i].p);
  }

  /**
   * Body bump: a stunned (tumbling) body crashing into another player at a relative normal speed
   * above BUMP_MIN_SPEED exchanges momentum (equal masses, restitution BUMP_RESTITUTION). A
   * non-stunned player that gets bumped pops up (BUMP_POP_VY) and, on a hard bump, is stunned for
   * BUMP_STUN_TICKS. Its ring-out credit goes to whoever launched the tumbling body (or that body
   * itself). A non-stunned player in roll i-frames is skipped (no exchange, no event). Walk-vs-walk pairs never get here (positional push only: no prediction mismatch).
   * (nx, nz) = unit horizontal normal from a to b.
   */
  private bump(ea: RosterEntry, eb: RosterEntry, nx: number, nz: number, tick: number): void {
    const a = ea.p;
    const b = eb.p;
    // Roll i-frames dodge body bumps like every other knockback (positional push still applies).
    if ((!a.stunTicks && hasRollIFrames(a)) || (!b.stunTicks && hasRollIFrames(b))) return;
    const vRel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
    if (vRel <= BUMP_MIN_SPEED) return;
    const j = ((1 + BUMP_RESTITUTION) / 2) * vRel;
    a.vx -= j * nx;
    a.vz -= j * nz;
    b.vx += j * nx;
    b.vz += j * nz;
    const aStunned = a.stunTicks > 0;
    const bStunned = b.stunTicks > 0;
    if (!aStunned) this.bumped(ea, eb, j, tick);
    if (!bStunned) this.bumped(eb, ea, j, tick);
    // The tumbling body (or, both tumbling, the faster one) is the "bumper".
    const aFirst = aStunned !== bStunned ? aStunned : a.vx * a.vx + a.vz * a.vz >= b.vx * b.vx + b.vz * b.vz;
    const bumper = aFirst ? ea : eb;
    const target = aFirst ? eb : ea;
    const pos = point((a.x + b.x) * 0.5, (a.y + b.y) * 0.5 + CHEST_HEIGHT, (a.z + b.z) * 0.5);
    this.emit({ type: "bump", tick, playerId: bumper.id, targetId: target.id, pos, impulse: j });
  }

  /** `victim` (not stunned) was hit by the tumbling `by`: pop, maybe stun, inherit the knock credit. */
  private bumped(victim: RosterEntry, by: RosterEntry, impulse: number, tick: number): void {
    const p = victim.p;
    p.vy = Math.max(p.vy, BUMP_POP_VY);
    p.grounded = false;
    if (impulse > BUMP_STUN_MIN_IMPULSE) {
      p.stunTicks = Math.max(p.stunTicks, BUMP_STUN_TICKS);
      p.jumping = false;
      p.skid = false;
      p.rollTicks = 0;
      p.chargeTicks = 0;
      if (isMovementAbilityActive(p, p.character)) {
        p.abilityTicks = 0;
        p.abilityPhase = 0;
      }
    }
    const rt = this.runtime.get(by.id);
    const inherited = rt ? ringOutCredit(by.id, rt.lastHitBy, rt.lastHitTick, tick, RING_OUT_CREDIT_TICKS) : "";
    this.creditKnock(victim.id, inherited || by.id, tick);
  }

  private pushOutOfCover(p: PlayerState): void {
    const probe = this.scratch;
    probe.x = p.x;
    probe.y = p.y;
    probe.z = p.z;
    if (!resolveCoverCollision(this.arena, probe, PLAYER_RADIUS, playerHeight(p, p.character))) return;
    p.x = probe.x;
    p.z = probe.z;
  }

  /* ======================================================= 5–6. held + pickups */

  private pinHeldBalls(): void {
    this.state.balls.forEach((b) => {
      if (b.state !== "held") return;
      const holder = this.state.players.get(b.holderId);
      if (!holder || !holder.alive) {
        makeLoose(b, "dead", posOf(b));
        return;
      }
      const hand = throwOrigin(holder, this.scratch);
      b.x = hand.x;
      b.y = hand.y;
      b.z = hand.z;
      b.vx = 0;
      b.vy = 0;
      b.vz = 0;
    });
  }

  private canTakeBall(p: PlayerState): boolean {
    return p.alive && p.catchTicks === 0 && p.heldCount < maxHeldBalls(p);
  }

  private pickUpBalls(roster: RosterEntry[], tick: number): void {
    this.state.balls.forEach((ball, ballId) => {
      if (ball.state !== "neutral" || ball.kind === "bonus") return;
      let best: RosterEntry | null = null;
      let bestDist = Infinity;
      for (const entry of roster) {
        const p = entry.p;
        if (!this.canTakeBall(p)) continue;
        const dy = ball.y - p.y;
        if (dy < PICKUP_MIN_DY || dy > PICKUP_MAX_HEIGHT) continue;
        const d = dist2D(ball.x, ball.z, p.x, p.z);
        if (d > PICKUP_RADIUS) continue;
        if (d < bestDist || (d === bestDist && best !== null && p.slot < best.p.slot)) {
          best = entry;
          bestDist = d;
        }
      }
      if (!best) return;
      this.giveBall(best.id, best.p, ball);
      this.emit({ type: "pickup", tick, playerId: best.id, ballId, pos: posOf(ball) });
    });
  }

  private giveBall(id: string, p: PlayerState, ball: BallEntity): void {
    makeHeld(ball, id, throwOrigin(p, this.scratch));
    this.history.delete(ball.id);
    p.heldCount++;
  }

  private pickUpPowerUps(roster: RosterEntry[], tick: number): void {
    const taken: string[] = [];
    this.state.powerUps.forEach((pu, id) => {
      if (pu.phase !== "ready") return;
      let best: RosterEntry | null = null;
      let bestDist = Infinity;
      for (const entry of roster) {
        const p = entry.p;
        if (!p.alive || p.y < POWERUP_PICKUP_MIN_Y || p.y > POWERUP_PICKUP_MAX_Y) continue;
        const d = dist2D(pu.x, pu.z, p.x, p.z);
        if (d <= POWERUP_PICKUP_RADIUS && d < bestDist) {
          best = entry;
          bestDist = d;
        }
      }
      if (!best) return;
      if (pu.type === "zoomies") best.p.zoomiesTicks = ZOOMIES_TICKS;
      else best.p.powerUp = pu.type;
      taken.push(id);
      this.emit({ type: "powerUpPickup", tick, id, playerId: best.id, powerUpType: pu.type, pos: this.powerUpPos(pu) });
    });
    for (const id of taken) this.state.powerUps.delete(id);
  }

  /* ================================================================ 7. balls */

  private stepBalls(tick: number, dt: number): void {
    this.ballCtx.dt = dt;
    for (const id of [...this.state.balls.keys()]) {
      const ball = this.state.balls.get(id);
      if (!ball) continue;
      this.rememberPrev(id, ball);
      if (ball.state !== "held" && !this.stepOneBall(id, ball, tick)) continue;
      this.history.record(id, tick, ball, ball.state === "live");
    }
  }

  /** Ball position before this tick's step (start of its swept segment). */
  private rememberPrev(id: string, ball: BallEntity): void {
    let prev = this.prevPos.get(id);
    if (!prev) {
      prev = vec3();
      this.prevPos.set(id, prev);
    }
    prev.x = ball.x;
    prev.y = ball.y;
    prev.z = ball.z;
  }

  /** Steps one loose ball; returns false when it left play (removed). */
  private stepOneBall(id: string, ball: BallEntity, tick: number): boolean {
    const owner = ball.ownerId ? this.state.players.get(ball.ownerId) : undefined;
    const ownerAlive = owner !== undefined && owner.alive;
    const live = ball.state === "live";
    this.ballCtx.steer = live && ball.curve && ownerAlive ? aimDirection(owner.yaw, owner.pitch, this.steer) : null;
    this.ballCtx.returnTarget = ball.kind === "boomerang" && ownerAlive ? chestPosition(owner, this.returnTarget) : null;

    const result = stepBall(ball, this.ballCtx);
    if (result.startedReturning) {
      this.emit({ type: "boomerangReturn", tick, ballId: id, ownerId: ball.ownerId, pos: posOf(ball), caught: false });
    }
    if (result.lost || (result.becameNeutral && ball.kind === "bonus")) {
      const respawn = ball.kind !== "bonus";
      this.removeBall(id);
      this.emit({ type: "ballLost", tick, ballId: id, respawn });
      return false;
    }
    if (ball.state === "live" && ball.returning && owner) this.tryBoomerangCatch(id, ball, owner, tick);
    return true;
  }

  private tryBoomerangCatch(id: string, ball: BallEntity, owner: PlayerState, tick: number): void {
    const chest = chestPosition(owner, this.scratch);
    const dx = ball.x - chest.x;
    const dy = ball.y - chest.y;
    const dz = ball.z - chest.z;
    if (dx * dx + dy * dy + dz * dz > BOOMERANG_CATCH_RADIUS * BOOMERANG_CATCH_RADIUS) return;
    if (!this.canTakeBall(owner)) {
      ball.state = "dead";
      ball.returning = false;
      return;
    }
    const ownerId = ball.ownerId;
    const pos = posOf(ball);
    this.giveBall(ownerId, owner, ball);
    this.emit({ type: "boomerangReturn", tick, ballId: id, ownerId, pos, caught: true });
  }

  /* ============================================================== 8a. catches */

  private resolveCatches(roster: RosterEntry[], tick: number): void {
    for (const { id, p } of roster) {
      const rt = this.runtime.get(id);
      const window = rt?.window;
      if (!rt || !window) continue;
      if (!p.alive || p.catchTicks === 0) {
        rt.window = null;
        continue;
      }
      const candidate = this.findCatchCandidate(id, p, window, Math.min(tick, window.end - 1));
      window.nextTest = tick + 1;
      if (candidate) this.performCatch(id, p, rt, window, candidate, tick);
      else if (window.nextTest >= window.end) rt.window = null;
    }
  }

  /**
   * Best catch among the ball-history samples not tested yet (and pending hits on this player).
   * Each live sample is tested swept from the previous in-window live sample (the ball's path
   * during that tick), so a fast ball can't skip the catch sphere between samples; the first
   * sample of the window is tested as a point.
   */
  private findCatchCandidate(id: string, p: PlayerState, window: CatchWindow, lastTick: number): CatchCandidate | null {
    let best: CatchCandidate | null = null;
    const consider = (ballId: string, pos: Vec3Like, distance: number, pending: PendingHit | null) => {
      if (distance >= 0 && (!best || distance < best.distance)) best = { ballId, pos: posOf(pos), distance, pending };
    };
    const at = vec3();
    const from = Math.max(window.start, window.nextTest - 1);
    this.state.balls.forEach((ball, ballId) => {
      if (ball.state !== "live" || ball.ownerId === id) return;
      let prev: BallSample | null = null;
      for (const sample of this.history.range(ballId, from, lastTick)) {
        if (sample.tick >= window.nextTest && sample.live) {
          if (prev && prev.live && prev.tick === sample.tick - 1) {
            consider(ballId, at, catchDistanceSwept(p, prev, sample, ball.radius, at), null);
          } else {
            consider(ballId, sample, catchDistance(p, sample, ball.radius), null);
          }
        }
        prev = sample;
      }
    });
    for (const hit of this.pendingHits) {
      if (hit.targetId === id && hit.hitTick >= window.start && this.state.balls.has(hit.ballId)) {
        consider(hit.ballId, hit.pos, catchDistance(p, hit.pos, hit.radius), hit);
      }
    }
    return best;
  }

  private performCatch(id: string, p: PlayerState, rt: PlayerRuntime, window: CatchWindow, c: CatchCandidate, tick: number): void {
    const ball = this.state.balls.get(c.ballId);
    if (!ball) return;
    const throwerId = c.pending ? c.pending.throwerId : ball.ownerId;
    const throwSeq = c.pending ? c.pending.throwSeq : ball.throwSeq;
    this.pendingHits = this.pendingHits.filter((h) => h.ballId !== c.ballId);

    const kept = p.heldCount < maxHeldBalls(p);
    if (kept) this.giveBall(id, p, ball);
    else makeLoose(ball, "neutral", point(p.x, p.y + BALL_RADIUS, p.z));
    p.catchTicks = 0;
    p.whiffTicks = 0;
    rt.window = null;
    rt.guard = { ownerId: throwerId, throwSeq, until: tick + CATCH_WINDOW_TICKS };
    this.deflectPendingSiblings(id, p, rt.guard, tick);

    const thrower = this.state.players.get(throwerId);
    const costsHeart = thrower !== undefined && thrower.alive;
    if (thrower && costsHeart) thrower.hearts = Math.max(0, thrower.hearts - HIT_DAMAGE);
    const throwerHeartsLeft = thrower ? thrower.hearts : 0;
    this.emit({ type: "catch", tick, ballId: c.ballId, catcherId: id, throwerId, pos: c.pos, throwerHeartsLeft, rewindTicks: window.rewind, kept });
    if (thrower && costsHeart && thrower.hearts === 0) this.knockOut(throwerId, thrower, id, "caught", tick);
  }

  /** Pending hits on the catcher from the caught throw's siblings bounce off instead. */
  private deflectPendingSiblings(id: string, p: PlayerState, guard: SiblingGuard, tick: number): void {
    const keep: PendingHit[] = [];
    for (const hit of this.pendingHits) {
      const sibling = hit.targetId === id && hit.throwerId === guard.ownerId && hit.throwSeq === guard.throwSeq;
      if (!sibling) {
        keep.push(hit);
        continue;
      }
      const ball = this.state.balls.get(hit.ballId);
      if (ball) deflectAway(ball, p, BELLY_BOUNCE_DEFLECT_SPEED);
      this.emit({ type: "deflect", tick, ballId: hit.ballId, playerId: id, pos: posOf(hit.pos) });
    }
    this.pendingHits = keep;
  }

  /* ================================================================= 8b. hits */

  private resolvePendingHits(tick: number): void {
    if (this.pendingHits.length === 0) return;
    const due = this.pendingHits.filter((h) => h.applyAt <= tick);
    if (due.length === 0) return;
    this.pendingHits = this.pendingHits.filter((h) => h.applyAt > tick);
    for (const hit of due) this.applyHit(hit, tick);
  }

  private resolveHits(roster: RosterEntry[], tick: number): void {
    this.state.balls.forEach((ball, ballId) => {
      if (ball.state !== "live") return;
      const prev = this.prevPos.get(ballId) ?? ball;
      for (const { id, p } of roster) {
        if (!p.alive || id === ball.ownerId) continue;
        if (!segmentCapsuleOverlap(prev, ball, ball.radius, p, PLAYER_RADIUS, playerHeight(p, p.character))) continue;
        const sibling = this.isGuardedSibling(id, ball, tick);
        if (!sibling && (isInvulnerable(p) || this.hasPendingHit(id))) continue;
        if (sibling || isBouncy(p, p.character)) {
          deflectAway(ball, p, BELLY_BOUNCE_DEFLECT_SPEED);
          this.emit({ type: "deflect", tick, ballId, playerId: id, pos: posOf(ball) });
        } else {
          this.registerHit(ballId, ball, id, p, tick);
        }
        return;
      }
    });
  }

  private isGuardedSibling(id: string, ball: BallEntity, tick: number): boolean {
    const guard = this.runtime.get(id)?.guard;
    return !!guard && tick <= guard.until && ball.ownerId === guard.ownerId && ball.throwSeq === guard.throwSeq;
  }

  private hasPendingHit(id: string): boolean {
    return this.pendingHits.some((h) => h.targetId === id);
  }

  private registerHit(ballId: string, ball: BallEntity, targetId: string, target: PlayerState, tick: number): void {
    const rewind = this.rewindTicksOf(targetId);
    const hit: PendingHit = {
      ballId,
      targetId,
      throwerId: ball.ownerId,
      throwSeq: ball.throwSeq,
      hitTick: tick,
      applyAt: tick + rewind,
      pos: posOf(ball),
      radius: ball.radius,
      knockback: ballHitKnockback(ball, target, Math.max(0, target.hearts - HIT_DAMAGE)),
      charge: ball.charge,
      kind: ball.kind,
    };
    bounceOffTarget(ball);
    if (rewind === 0) this.applyHit(hit, tick);
    else this.pendingHits.push(hit);
  }

  private applyHit(hit: PendingHit, tick: number): void {
    const p = this.state.players.get(hit.targetId);
    if (!p || !p.alive) return;
    p.hearts = Math.max(0, p.hearts - HIT_DAMAGE);
    applyLaunch(p, hit.knockback);
    // Mercy covers the whole helpless flight: a tumbling body can't be juggled by a second ball.
    p.hurtTicks = Math.max(HURT_INVULN_TICKS, p.stunTicks);
    p.abilityTicks = 0;
    p.abilityPhase = 0;
    p.catchTicks = 0;
    this.runtimeOf(hit.targetId).window = null;
    this.creditKnock(hit.targetId, hit.throwerId, tick);
    this.emit({
      type: "hit",
      tick,
      ballId: hit.ballId,
      throwerId: hit.throwerId,
      targetId: hit.targetId,
      pos: hit.pos,
      knockback: hit.knockback,
      launchSpeed: speedOf(hit.knockback),
      charge: hit.charge,
      kind: hit.kind,
      heartsLeft: p.hearts,
      fullCharge: hit.charge >= FULL_CHARGE_THRESHOLD,
    });
    if (p.hearts === 0) this.knockOut(hit.targetId, p, hit.throwerId, "hits", tick);
  }

  /* ============================================================ eliminations */

  private knockOut(id: string, p: PlayerState, byId: string, cause: "hits" | "caught", tick: number): void {
    const pos = posOf(p);
    this.eliminatePlayer(id, p);
    this.emit({ type: "ko", tick, playerId: id, byId, cause, pos });
  }

  /** alive = false, held balls dropped, power-up/timers cleared, body frozen in place. */
  private eliminatePlayer(id: string, p: PlayerState): void {
    p.alive = false;
    this.dropHeldBalls(id, p);
    p.heldCount = 0;
    p.powerUp = "";
    p.zoomiesTicks = 0;
    p.abilityTicks = 0;
    p.abilityPhase = 0;
    p.chargeTicks = 0;
    p.catchTicks = 0;
    p.curveArmed = false;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    const rt = this.runtimeOf(id);
    rt.window = null;
    rt.guard = null;
    this.pendingHits = this.pendingHits.filter((h) => h.targetId !== id);
  }

  /** Every ball held by `id` falls as a plain dead ball from their chest. */
  private dropHeldBalls(id: string, p: PlayerState): void {
    const chest = posOf(chestPosition(p, this.scratch));
    this.state.balls.forEach((b) => {
      if (b.state !== "held" || b.holderId !== id) return;
      const angle = this.random() * Math.PI * 2;
      const speed = this.random() * DROP_SCATTER_SPEED;
      makeLoose(b, "dead", chest, Math.cos(angle) * speed, 0, Math.sin(angle) * speed);
      this.history.delete(b.id);
    });
  }

  private creditKnock(victimId: string, byId: string, tick: number): void {
    if (!byId || byId === victimId) return;
    const rt = this.runtimeOf(victimId);
    rt.lastHitBy = byId;
    rt.lastHitTick = tick;
  }

  /* ================================================================= helpers */

  /**
   * Uniform random spot on solid floor for a ball drop: a RING_SOLID ring (never shaking or fallen),
   * at least BALL_SPAWN_EDGE_MARGIN inside that solid floor's edge, clear of cover. Once the island
   * has started crumbling, the outermost solid ring is skipped too, since it may shake and fall
   * before the ball lands. The first half of the attempts also keeps BALL_SPAWN_SPACING from other
   * loose balls so simultaneous drops spread out. Falls back to arena.ballDrop (ring 0 never falls).
   */
  private randomBallSpot(): { x: number; z: number } {
    const radii = this.arena.ringRadii;
    const edge = radii[radii.length - 1];
    const crumbling = this.rings.some((r) => r !== RING_SOLID);
    const outer = this.outermostSolidRing();
    const maxRing = crumbling && outer >= 1 ? outer - 1 : radii.length - 1;
    for (let attempt = 0; attempt < BALL_SPAWN_ATTEMPTS; attempt++) {
      const x = (this.random() * 2 - 1) * edge;
      const z = (this.random() * 2 - 1) * edge;
      if (!this.isSpawnFloor(x, z, maxRing)) continue;
      const d = Math.hypot(x, z);
      if (d > 0) {
        const s = (d + BALL_SPAWN_EDGE_MARGIN) / d;
        if (!this.isSpawnFloor(x * s, z * s, maxRing)) continue;
      }
      if (this.arena.cover.some((c) => pointInCover(c, x, z, BALL_RADIUS))) continue;
      if (attempt < BALL_SPAWN_ATTEMPTS / 2 && this.ballNear(x, z, BALL_SPAWN_SPACING)) continue;
      return { x, z };
    }
    return { x: this.arena.ballDrop.x, z: this.arena.ballDrop.z };
  }

  /** (x, z) lies on a RING_SOLID ring no further out than `maxRing`. */
  private isSpawnFloor(x: number, z: number, maxRing: number): boolean {
    const ring = ringIndexAt(this.arena, x, z);
    if (ring < 0 || ring > maxRing) return false;
    return ring >= this.rings.length || this.rings[ring] === RING_SOLID;
  }

  /** Some loose (not held) ball is within `dist` horizontally of (x, z). */
  private ballNear(x: number, z: number, dist: number): boolean {
    let near = false;
    this.state.balls.forEach((b) => {
      if (!near && b.state !== "held" && Math.hypot(b.x - x, b.z - z) < dist) near = true;
    });
    return near;
  }

  /** Floor query over the current arena and ring states. */
  private floor(): FloorQuery {
    this.simCtx.arena = this.arena;
    return this.simCtx;
  }

  private emit(ev: GameEvent): void {
    this.events.push(ev);
  }

  private roster(): RosterEntry[] {
    const out: RosterEntry[] = [];
    this.state.players.forEach((p, id) => out.push({ id, p }));
    return out;
  }

  private runtimeOf(id: string): PlayerRuntime {
    let rt = this.runtime.get(id);
    if (!rt) {
      const p = this.state.players.get(id);
      rt = { lastHitBy: "", lastHitTick: 0, ground: vec3(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0), window: null, guard: null };
      this.runtime.set(id, rt);
    }
    return rt;
  }

  private rememberGround(id: string, p: PlayerState): void {
    const g = this.runtimeOf(id).ground;
    g.x = p.x;
    g.y = p.y;
    g.z = p.z;
  }

  private placeAtSpawn(id: string, p: PlayerState): void {
    const spawns = this.arena.spawns;
    const spawn = spawns[((p.slot % spawns.length) + spawns.length) % spawns.length];
    p.x = spawn.x;
    p.y = 0;
    p.z = spawn.z;
    p.yaw = spawn.yaw;
    p.pitch = 0;
    p.dirX = -Math.sin(spawn.yaw);
    p.dirZ = -Math.cos(spawn.yaw);
    p.grounded = true;
    p.alive = true;
    this.rememberGround(id, p);
  }

  private createBall(): BallEntity {
    const ball = new BallEntity();
    ball.id = `b${this.nextBallId++}`;
    this.state.balls.set(ball.id, ball);
    return ball;
  }

  private removeBall(id: string): void {
    this.state.balls.delete(id);
    this.history.delete(id);
    this.prevPos.delete(id);
  }

  private firstHeldBall(id: string): BallEntity | null {
    let best: BallEntity | null = null;
    this.state.balls.forEach((b) => {
      if (b.state === "held" && b.holderId === id && (!best || ballIdNumber(b.id) < ballIdNumber(best.id))) best = b;
    });
    return best;
  }

  private countHeld(id: string): number {
    let n = 0;
    this.state.balls.forEach((b) => {
      if (b.state === "held" && b.holderId === id) n++;
    });
    return n;
  }

  private powerUpPos(pu: PowerUpEntity): Vec3Like {
    return point(pu.x, PEDESTAL_HEIGHT + POWERUP_HOVER_Y, pu.z);
  }

  private isDroppableRing(index: number): boolean {
    return Number.isInteger(index) && index >= 1 && index < this.rings.length;
  }

  private setRing(index: number, value: number): void {
    this.rings[index] = value;
    this.state.rings[index] = value;
  }

  /** Size state.rings to the arena (in place) and refresh the plain mirror. */
  private fitRings(): void {
    const n = this.arena.ringRadii.length;
    if (this.state.rings.length !== n) {
      this.resetRings();
      return;
    }
    this.rings.length = n;
    for (let i = 0; i < n; i++) this.rings[i] = this.state.rings[i];
  }

  /** All rings solid, in place. */
  private resetRings(): void {
    const n = this.arena.ringRadii.length;
    const rings = this.state.rings;
    if (rings.length !== n) {
      rings.clear();
      for (let i = 0; i < n; i++) rings.push(RING_SOLID);
    } else {
      for (let i = 0; i < n; i++) if (rings[i] !== RING_SOLID) rings[i] = RING_SOLID;
    }
    this.rings.length = n;
    this.rings.fill(RING_SOLID);
  }
}
