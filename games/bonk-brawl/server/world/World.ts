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

import type { ArenaDef } from "../../shared/maps.js";
import type { InputCmd } from "../../shared/protocol.js";
import type { PowerUpType } from "../../shared/types.js";
import type { BonkState } from "../schema.js";
import type { GameEvent } from "./events.js";

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

export class GameWorld {
  readonly state: BonkState;
  /** Current arena (changes between rounds via setArena). */
  arena: ArenaDef;

  constructor(state: BonkState, arena: ArenaDef, opts: WorldOptions = {}) {
    this.state = state;
    this.arena = arena;
    void opts;
  }

  /* ------------------------------------------------------------------ inputs */

  /**
   * Validate and enqueue one input for a player. Drop it if the player doesn't exist, isn't
   * alive, or seq <= the last queued/consumed seq. Clamp: moveX/moveZ to [-1,1] (and the vector
   * length to 1), pitch to ±PITCH_LIMIT, yaw finite (wrap), buttons & 31. Non-finite numbers → drop.
   * If the queue already holds INPUT_QUEUE_MAX inputs, drop the OLDEST first — but OR its edge
   * bits (EDGE_BUTTONS) into the next remaining input so a press is never lost.
   */
  queueInput(sessionId: string, cmd: InputCmd): void {
    void sessionId;
    void cmd;
  }

  /**
   * Forget a player's queued inputs, last input AND last seen seq, and set player.lastSeq = 0
   * (all players when sessionId is omitted). The room calls it for a player on join and on every
   * reconnect, because a reloaded client restarts its seq counter at 1 (any strictly increasing
   * sequence is accepted after this). resetForRound does NOT call it: the client's seq keeps
   * increasing across rounds within a connection.
   */
  clearInputs(sessionId?: string): void {
    void sessionId;
  }

  /**
   * Lag-compensation rewind for a player's catches, from the room's RTT EMA:
   * rewindTicksForRtt(rtt) (≤ LAG_COMP_MAX_TICKS). Also delays hits ON this player (see step()).
   */
  setRewindTicks(sessionId: string, ticks: number): void {
    void sessionId;
    void ticks;
  }

  /* --------------------------------------------------------- round lifecycle */

  /**
   * Switch arena (room calls it before resetForRound when the map changes). Resizes state.rings
   * IN PLACE (clear()/push or index writes) — never assign a new ArraySchema to state.rings, so
   * client FloorQuery objects holding the decoded state.rings stay valid.
   */
  setArena(arena: ArenaDef): void {
    this.arena = arena;
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
    void participants;
  }

  /**
   * Eliminate a player outside normal combat (disconnect grace expired mid-round, or a consented
   * leave while alive mid-round): alive = false, drop held balls (as dead balls at their chest with
   * zero velocity, ownerId ""), clear their power-up, emit `ko` { cause: "disconnect", byId: "" }.
   * No-op if not alive.
   */
  eliminate(sessionId: string, cause: "disconnect"): void {
    void sessionId;
    void cause;
  }

  /** Forget everything about a player who left the room (queues, rewind, history, pending hits). */
  removePlayer(sessionId: string): void {
    void sessionId;
  }

  /* ---------------------------------------------------------------- spawning */

  /**
   * Add a neutral ball dropping from the sky at arena.ballDrop + BALL_DROP_OFFSETS[dropIndex %
   * length], y = BALL_SPAWN_HEIGHT, zero velocity. If that spot's ring has fallen, use the
   * ballDrop center. Ids are "b1", "b2", ... (never reused within the room). Emits `ballSpawn`.
   * Returns the ball id.
   */
  spawnBall(dropIndex: number): string {
    void dropIndex;
    return "";
  }

  /** Balls in play that count toward the arena target: every non-bonus ball, in any state (incl. held). */
  countBalls(): number {
    return 0;
  }

  /**
   * Put a power-up on a pedestal in "warning" phase (shimmer, not pickable). Ids "p1", "p2", ...
   * Emits `powerUpWarning`. Returns the id. The room calls activatePowerUp after POWERUP_WARNING_TICKS.
   */
  spawnPowerUpWarning(pedestal: number, type: PowerUpType): string {
    void pedestal;
    void type;
    return "";
  }

  /** warning → ready (pickable). Emits `powerUpSpawn`. No-op if the id is gone (ring fell). */
  activatePowerUp(id: string): void {
    void id;
  }

  /** Remove all power-ups (no events). */
  clearPowerUps(): void {}

  /* -------------------------------------------------------------------- rings */

  /** state.rings[index] = RING_SHAKING; emits `ringShake`. Ring 0 never shakes. */
  shakeRing(index: number): void {
    void index;
  }

  /**
   * state.rings[index] = RING_FALLEN; emits `ringDrop`. Removes power-ups whose pedestal lies on
   * that ring (no pickup). Players/balls on it start falling naturally next tick via the sim.
   * Ring 0 never falls.
   */
  dropRing(index: number): void {
    void index;
  }

  /** Index of the outermost ring still RING_SOLID (>= 1), or -1 when only ring 0 remains. */
  outermostSolidRing(): number {
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
   *       (horizontal) and |dy| < 1.5: knockback away from the center (SHOCKWAVE_KNOCK_H, +
   *       SHOCKWAVE_KNOCK_UP), stunTicks = KNOCKBACK_STUN_TICKS, record last-hitter credit; no damage.
   *       Roll i-frames dodge it. Emit `shockwave` with the affected ids.
   *     - fellOut (combat): eliminate with `ringOut` (creditId = last hitter if within
   *       RING_OUT_CREDIT_TICKS, else ""); pos = last grounded position.
   *  3. Headbutt: for each alive Gruff with abilityTicks > 0: the first other alive player whose
   *     capsule is within HEADBUTT_HIT_RANGE in front of Gruff's chest (front half-space) gets
   *     knockback along Gruff's dir (HEADBUTT_KNOCK_H, HEADBUTT_KNOCK_UP), stun, credit; Gruff's
   *     abilityTicks = 0. Roll i-frames dodge it; Mochi's Belly Bounce does NOT. Emit `headbutt`.
   *  4. Player separation: push overlapping alive capsules apart horizontally (half each) so their
   *     centers are >= PLAYER_SEPARATION apart; skip pairs with |dy| > PLAYER_HEIGHT.
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
   *        its center is within CATCH_RANGE (+ ball radius) of catchCenter = chest + forward(yaw) *
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
   *     b. HIT: sphereCapsuleOverlap(ball, radius, player feet, PLAYER_RADIUS, playerHeight(p, char)).
   *        - isInvulnerable (roll i-frames or hurtTicks): the ball passes through, no effect.
   *        - Mochi bouncy: reflect the ball's horizontal velocity away from Mochi at
   *          BELLY_BOUNCE_DEFLECT_SPEED, state dead, emit `deflect`. No damage.
   *        - otherwise: if the target's rewind r == 0 apply now; else record a PendingHit
   *          { ball, target, tick, knockback } resolved at tick + r unless a catch converts it
   *          (the ball is set dead immediately and bounces off as usual so visuals stay prompt).
   *          Applying a hit: hearts -= HIT_DAMAGE; knockback velocity = horizontal ball direction *
   *          KNOCKBACK_H + up KNOCKBACK_UP, both × knockbackMultiplier(charge, kind); write
   *          vx/vy/vz, grounded = false, stunTicks = KNOCKBACK_STUN_TICKS, hurtTicks =
   *          HURT_INVULN_TICKS; cancel roll, ability (abilityTicks = 0, abilityPhase = 0), charge,
   *          catch window; last-hitter = thrower @ tick. Ball → dead with its velocity reflected
   *          and halved. Emit `hit` (then `ko` cause "hits" if hearts == 0).
   *        A live ball never hits its own thrower (OWNER_IMMUNE).
   *  9. Eliminations (combat): alive = false; held balls dropped as dead balls at the chest
   *     (ownerId ""), heldCount = 0; powerUp = ""; zoomies/ability/charge/catch cleared. Eliminated
   *     players are no longer stepped (stepPlayer no-ops when !alive), so their schema position
   *     freezes: where they were KO'd, or just below RING_OUT_Y for ring-outs. The client animates
   *     the KO pop / ring-out fall and the ghost cosmetically (Characters "ko" / "ringOut").
   *
   * Every emitted event has tick = state.tick.
   */
  step(opts: WorldStepOptions): GameEvent[] {
    void opts;
    return this.drainEvents();
  }

  /** Return and clear events produced outside step() (spawn/ring/eliminate calls in non-stepping phases). */
  drainEvents(): GameEvent[] {
    return [];
  }

  /** sessionIds of alive players (participants still in the round), in insertion order. */
  alivePlayers(): string[] {
    const ids: string[] = [];
    this.state.players.forEach((p, id) => {
      if (p.alive) ids.push(id);
    });
    return ids;
  }
}
