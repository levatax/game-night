// Executes one bot Goal as a stream of per-tick inputs (move / look / buttons). Owner: server-bots.
//
// A Motor is created per goal and ticked once per server tick by the BotDesk. It walks with steer(), turns at
// a human rate, and drives the buttons with the protocol's rules (shared/protocol.ts BTN): EDGE bits
// (INTERACT_PRESS, USE_PRESS, EAT, DROP, JUMP, SLOT1–4) are set for exactly one tick, LEVEL bits (INTERACT,
// THROW, SPRINT) are held as long as needed. What E would do is checked with the shared resolveInteraction()
// before pressing (with a geometric fallback when the resolver has no answer), so a bot never stands there
// mashing E at the wrong thing. The check uses the look the command sends (the server turns the seat before it
// resolves E), and when something that outranks the target wins E (an item lying in front of the raft), the bot
// looks past it or steps around the target to where E reaches it. Crafting and the chest go through the host
// (the same validation a human's CraftMsg / ChestMsg gets). Every stage has a timeout: a goal that can't make
// progress fails, and the desk blacklists it for a while and thinks again.

import {
  CHARGE_FULL_TICKS,
  CHEST_RANGE,
  CRAFT_RANGE,
  EYE_HEIGHT,
  FISH_STATE,
  INTERACT_CONE_COS,
  INTERACT_RANGE,
  MONSTERS,
  PALM_HIT_RANGE,
  PICKUP_RANGE,
  PLACE_DISTANCE,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  ESCORT_RADIUS,
  RAFT_HP_MAX,
  RAFT_RANGE,
  RAFT_REPAIR_WOOD_COST,
  REVIVE_RANGE,
  SPRING_RANGE,
  TORCH_SWING_RANGE,
  WATER_Y,
  WRECK_RANGE,
  secToTicks,
  type Timings,
} from "../../shared/constants.js";
import { heightAt } from "../../shared/island/heightfield.js";
import type { IslandDef, XZ } from "../../shared/island/types.js";
import { BTN, type ChestMsg } from "../../shared/protocol.js";
import { emptyInteraction, raftMaterialsDone, resolveInteraction, type Interaction } from "../../shared/rules/interact.js";
import { countOf, heavyCount, roomFor, slotCount, slotKind } from "../../shared/rules/inventory.js";
import { angleDelta, clamp, wrapAngle, yawFromDir } from "../../shared/sim/math.js";
import { throwOrigin } from "../../shared/sim/throw.js";
import type { BotRole, InteractKind, ItemKind, RecipeId } from "../../shared/types.js";
import type { PlayerState, RaftState } from "../schema.js";
import { aimFromPlayer, aimVelocity, applyAimNoise, shotClear, type AimSolution, type ShotObstacle } from "./botAim.js";
import { aimNoiseFor } from "./botBrain.js";
import { palmHandSlot, RAFT_REPAIR_TARGET } from "./botNeeds.js";
import { moveFor, resetSteerMemory, steer, type SteerMemory, type SteerWorld } from "./botSteer.js";
import type { BotSlot, Goal } from "./botTypes.js";

/** Max yaw / pitch change per tick (≈ 10 rad/s, a quick human flick). */
export const MAX_TURN = 0.32;
export const MAX_PITCH_TURN = 0.14;
/** Turned "enough" to act (radians). */
const FACE_TOLERANCE = 0.12;
/** Ticks between repeated station actions (craft, chest) and E presses. */
const ACTION_GAP = 7;
/** A goal that is still walking after this long fails (unreachable target). */
const WALK_TIMEOUT = secToTicks(22);
/** A goal stuck in an acting stage after this long fails. */
const ACT_TIMEOUT = secToTicks(7);
/** Sidestep distance when a throw's line of fire is blocked. */
const SIDESTEP = 2.2;
/** Where the guard stands to plant the night torch: PLACE_DISTANCE + 2.4 m from the raft center. */
const TORCH_STAND = PLACE_DISTANCE + 2.4;
/** Idle bots amble to a new spot within this radius every WANDER_MIN..+SPAN ticks. */
const WANDER_RADIUS = 2.2;
const WANDER_MIN_TICKS = secToTicks(4);
const WANDER_SPAN_TICKS = secToTicks(6);
/** Fishing: reaction window after the bobber dips (ticks), and the chance of reacting too late. */
const BITE_REACTION_MIN = 6;
const BITE_REACTION_SPAN = 8;
const BITE_MISS_CHANCE = 0.08;
/** Look offsets from facing the target that clearLook tries, nearest first (π: turned right round). */
const ASIDE_LOOKS = [0, 0.3, -0.3, 0.6, -0.6, 1, -1, 1.5, -1.5, 2.1, -2.1, 2.7, -2.7, Math.PI];
/** Steps around the target (radians of bearing, at the same distance) clearLook tries when no look works here. */
const ASIDE_SPOTS = [0.6, -0.6];
/** Longest walk to such a spot. */
const ASIDE_WALK_TICKS = secToTicks(2);
/** Longest a bot holds E at the raft for one stage (a mast waiting for its second holder, a slow hand assembly). */
const ASSEMBLE_HOLD_LIMIT = secToTicks(120);
/** A guard picks up a flipped crab this close, and throws at a scared-off crab this close. */
const GUARD_COLLECT_REACH = 6;
const GUARD_THROW_RANGE = 9;
/** A posted guard steps away from Captain Crab when he comes this close. */
const GUARD_BOSS_KITE = 5.5;
/** A guard swings its torch at a crab this close (TORCH_SWING_RANGE ahead + the crab's body + a step). */
const GUARD_SWING_REACH = TORCH_SWING_RANGE + 1.1;
/** A repair goes on (one plank / 2 wood per press) up to this hp. */
const REPAIR_GOAL_HP = RAFT_REPAIR_TARGET;

function carriesHeavy(p: PlayerState): boolean {
  return heavyCount(p) > 0;
}

/** What the motor may read and do. */
export interface MotorCtx {
  readonly state: RaftState;
  readonly island: IslandDef;
  readonly world: SteerWorld;
  readonly timings: Readonly<Timings>;
  readonly role: BotRole;
  rng(): number;
  craft(recipe: RecipeId): boolean;
  chest(msg: ChestMsg): boolean;
  /** Estimated ground velocity of a monster (desk tracking), undefined when unknown. */
  velocity(id: string): { vx: number; vz: number } | undefined;
  /** Shore stand points per fish spot (index-aligned with island.fishSpots). */
  fishStands(): ReadonlyArray<XZ | null>;
}

/** One tick of input (InputCmd minus seq). */
export interface MotorFrame {
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  buttons: number;
}

export type MotorStatus = "running" | "done" | "failed";

interface ThrowPlan {
  slot: number;
  kind: ItemKind;
  chargeTicks: number;
  /** Personality noise offsets, fixed for the whole throw. */
  noiseYaw: number;
  noisePitch: number;
  /** Charge fraction, fixed once chosen (the aim is re-solved for it every tick while charging). */
  charge: number;
}

interface Point {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vz?: number;
  /** Target body radius (line-of-fire check stops this short). */
  r?: number;
}

function slotsOfPlayer(p: PlayerState): BotSlot[] {
  return [0, 1, 2, 3].map((i) => ({ kind: slotKind(p, i), count: slotCount(p, i) }));
}

function dist(p: XZ, q: XZ): number {
  return Math.hypot(p.x - q.x, p.z - q.z);
}

/** Turn `from` toward `to` by at most `max` radians. */
export function turnToward(from: number, to: number, max: number): number {
  const d = angleDelta(from, to);
  return Math.abs(d) <= max ? wrapAngle(to) : wrapAngle(from + Math.sign(d) * max);
}

/**
 * Seat `p` as seen standing at (x, y, z) and looking along `yaw`, everything else read through from the seat: lets
 * resolveInteraction() say what E would do from a look or a spot the state isn't in yet, without writing the state.
 */
export function posed(p: PlayerState, x: number, y: number, z: number, yaw: number): PlayerState {
  return new Proxy(p, {
    get: (seat, key) => (key === "x" ? x : key === "y" ? y : key === "z" ? z : key === "yaw" ? yaw : Reflect.get(seat, key)),
  });
}

/** Look pitch from the eye at a point. */
function pitchTo(p: PlayerState, x: number, y: number, z: number): number {
  const eyeY = p.y + EYE_HEIGHT;
  return Math.atan2(y - eyeY, Math.hypot(x - p.x, z - p.z));
}

export class Motor {
  status: MotorStatus = "running";
  /** Short failure reason (for the desk's blacklist and debugging). */
  reason = "";
  private stage = 0;
  private ticks = 0;
  private stageTicks = 0;
  private attempts = 0;
  private gap = 0;
  private channelSeen = false;
  private presses = 0;
  private plan: ThrowPlan | null = null;
  private biteAt = -1;
  private lookYaw = NaN;
  private lookPitch = -0.1;
  private lookTimer = 0;
  private putIndex = 0;
  private putCount = 0;
  private signature = 0;
  /** guard: a sub-task ("throw" a stone at / "collect" a flipped crab), its monster and the ammo slot. */
  private guardSub: "" | "throw" | "collect" = "";
  private guardTarget = "";
  private guardSlot = 0;
  /** fell: the tree is down; the log to pick up and when it fell. */
  private felled = false;
  private felledAt = 0;
  private logId = "";
  private awayMode = false;
  private wanderTimer = 0;
  private wanderX = 0;
  private wanderZ = 0;
  private awayPoint: Point | null = null;
  /** E flow: look offset from facing the target, and a spot to step to first (clearLook). */
  private aside = 0;
  private spot: XZ | null = null;
  private spotUntil = 0;
  private readonly scratch: Interaction = emptyInteraction();

  constructor(
    readonly goal: Goal,
    private readonly mem: SteerMemory,
  ) {
    resetSteerMemory(mem);
  }

  /** Produce this tick's input for seat `p` into `out` (reset by the caller). */
  tick(ctx: MotorCtx, p: PlayerState, out: MotorFrame): void {
    this.ticks++;
    this.stageTicks++;
    if (this.gap > 0) this.gap--;
    out.yaw = p.yaw;
    out.pitch = p.pitch;
    if (this.status !== "running") {
      this.idleLook(ctx, p, out);
      return;
    }
    this.safeHand(p, out);
    const g = this.goal;
    switch (g.kind) {
      case "idle":
        this.idleLook(ctx, p, out);
        return;
      case "crawl":
        this.walk(ctx, p, g.to.x, g.to.z, 1.5, out, false);
        return;
      case "flee":
        if (this.walk(ctx, p, g.to.x, g.to.z, 1.2, out, true)) this.finish();
        else this.timeout(WALK_TIMEOUT);
        return;
      case "camp":
        this.wanderAround(ctx, p, g.at, out);
        return;
      case "guard":
        this.guard(ctx, p, g.at, out);
        return;
      case "wait":
        this.hangAround(ctx, p, g.at, out);
        return;
      case "warm":
        this.hangAround(ctx, p, this.site(ctx, p).campfire, out, 1.8);
        return;
      case "follow":
        this.follow(ctx, p, g.playerId, out);
        return;
      case "eat":
        this.eat(ctx, p, g.slot, out);
        return;
      case "revive":
        this.revive(ctx, p, g.playerId, out);
        return;
      case "board":
        this.board(ctx, p, out);
        return;
      case "deliver":
        this.deliver(ctx, p, out);
        return;
      case "assemble":
        this.assemble(ctx, p, out);
        return;
      case "repair":
        this.repair(ctx, p, out);
        return;
      case "salvage":
        this.salvage(ctx, p, out);
        return;
      case "fell":
        this.fell(ctx, p, g.node, out);
        return;
      case "escort":
        this.escort(ctx, p, g.playerId, out);
        return;
      case "spring":
        this.spring(ctx, p, g.uses, out);
        return;
      case "pickup":
        this.pickup(ctx, p, g.projectileId, out);
        return;
      case "collectCrab":
        this.collectCrab(ctx, p, g.monsterId, out);
        return;
      case "gather":
        this.gather(ctx, p, g.node, out);
        return;
      case "shake":
        this.shake(ctx, p, g.node, out);
        return;
      case "fish":
        this.fish(ctx, p, g.spot, out);
        return;
      case "craft":
        this.craft(ctx, p, g.recipe, g.count, out);
        return;
      case "chestTake":
        this.chestTake(ctx, p, g.items, out);
        return;
      case "chestPut":
        this.chestPut(ctx, p, g.items, out);
        return;
      case "attack":
        this.attack(ctx, p, g.monsterId, g.slot, !!g.push, out);
        return;
      case "throwAway":
        this.throwAway(ctx, p, g.slot, g.monsterId, out);
        return;
      case "burn":
        this.burn(ctx, p, g.slot, out);
        return;
      case "pass":
        this.pass(ctx, p, g.playerId, g.slot, out);
        return;
      case "plantTorch":
        this.plantTorch(ctx, p, g.slot, out);
        return;
    }
  }

  /* ============================================================ basics */

  private finish(): void {
    this.status = "done";
  }

  private fail(reason: string): void {
    this.status = "failed";
    this.reason = reason;
  }

  private next(stage: number): void {
    this.stage = stage;
    this.stageTicks = 0;
    if (stage === 0) {
      this.aside = 0;
      this.spot = null;
    }
  }

  private timeout(limit: number, reason = "timeout"): boolean {
    if (this.stageTicks <= limit) return false;
    this.fail(reason);
    return true;
  }

  private site(ctx: MotorCtx, p: PlayerState) {
    return ctx.island.sites[p.team] ?? ctx.island.sites[0]!;
  }

  /** Walk toward (x, z); true once within `r`. Sprints on long legs when `sprint` and not hungry. */
  private walk(ctx: MotorCtx, p: PlayerState, x: number, z: number, r: number, out: MotorFrame, sprint: boolean): boolean {
    const s = steer(ctx.world, p, { x, z, r }, this.mem, () => ctx.rng());
    if (s.arrived) {
      out.moveX = 0;
      out.moveZ = 0;
      return true;
    }
    const yaw = turnToward(p.yaw, s.yaw, MAX_TURN);
    const m = moveFor(s.dirX, s.dirZ, s.speed, yaw);
    out.yaw = yaw;
    out.pitch = turnToward(p.pitch, -0.08, MAX_PITCH_TURN);
    out.moveX = m.moveX;
    out.moveZ = m.moveZ;
    if (s.jump) out.buttons |= BTN.JUMP;
    if ((sprint || s.dist > 12) && s.dist > 5 && p.hunger > 30 && !p.swimming && p.chargeTicks === 0) out.buttons |= BTN.SPRINT;
    return false;
  }

  /** Turn toward yaw / pitch; true when the sent look is on target. */
  private face(p: PlayerState, yaw: number, pitch: number, out: MotorFrame): boolean {
    out.yaw = turnToward(p.yaw, yaw, MAX_TURN);
    out.pitch = clamp(turnToward(p.pitch, pitch, MAX_PITCH_TURN), -1.45, 1.45);
    return Math.abs(angleDelta(out.yaw, yaw)) < 1e-6 && Math.abs(out.pitch - clamp(pitch, -1.45, 1.45)) < 1e-6;
  }

  /** The state already reflects facing `yaw` (turned enough to act; E is then probed at the exact look sent). */
  private faced(p: PlayerState, yaw: number): boolean {
    return Math.abs(angleDelta(p.yaw, yaw)) < FACE_TOLERANCE;
  }

  /** Make `slot` the active one (an edge for one tick); true once it is. */
  private select(p: PlayerState, slot: number, out: MotorFrame): boolean {
    if (p.activeSlot === slot) return true;
    if (slot >= 0 && slot < 4) out.buttons |= BTN.SLOT1 << slot;
    return false;
  }

  /** Never keep a stinging jellyfish in hand; only hold a torch (it burns) when it's dark. */
  private safeHand(p: PlayerState, out: MotorFrame): void {
    const g = this.goal;
    const held = slotKind(p, p.activeSlot);
    const wantsHeld = (g.kind === "burn" || (g.kind === "chestPut" && g.items.some((i) => i.kind === "jellyfish"))) && held === "jellyfish";
    if (held === "jellyfish" && !wantsHeld) {
      for (let i = 0; i < 4; i++) {
        if (slotKind(p, i) !== "jellyfish") {
          out.buttons |= BTN.SLOT1 << i;
          return;
        }
      }
    }
  }

  /** Stand around somewhere, looking about (toward the nearest threat when there is one). */
  private hangAround(ctx: MotorCtx, p: PlayerState, at: XZ, out: MotorFrame, r = 1.1): void {
    if (!this.walk(ctx, p, at.x, at.z, r, out, false)) return;
    this.idleLook(ctx, p, out);
  }

  /** Like hangAround, but every few seconds amble to another spot within WANDER_RADIUS (nobody stands frozen). */
  private wanderAround(ctx: MotorCtx, p: PlayerState, at: XZ, out: MotorFrame): void {
    if (this.wanderTimer-- <= 0) {
      this.wanderTimer = WANDER_MIN_TICKS + Math.floor(ctx.rng() * WANDER_SPAN_TICKS);
      const a = ctx.rng() * Math.PI * 2;
      const r = ctx.rng() * WANDER_RADIUS;
      this.wanderX = Math.cos(a) * r;
      this.wanderZ = Math.sin(a) * r;
    }
    this.hangAround(ctx, p, { x: at.x + this.wanderX, z: at.z + this.wanderZ }, out);
  }

  /**
   * Night watch at the raft (Long Tide §3.3): hold a lit torch and swing it at any crab that comes close (a swing
   * scares every crab around for TORCH_SWING_SCARE_TICKS — crabs going for the raft walk through torch light, so
   * this is how a guard keeps them off it and off itself).
   */
  private guard(ctx: MotorCtx, p: PlayerState, at: XZ, out: MotorFrame): void {
    // A sub-task in progress (a stone at a crab, picking up a flipped crab): run it to its end, then back on watch.
    if (this.guardSub !== "") {
      if (this.guardSub === "throw") this.throwFlow(ctx, p, this.guardSlot, out, () => this.monsterPoint(ctx, this.guardTarget), { maxRange: GUARD_THROW_RANGE, stay: true, checkShot: true });
      else this.collectCrab(ctx, p, this.guardTarget, out);
      if (this.status !== "running") {
        this.status = "running";
        this.reason = "";
        this.guardSub = "";
        this.guardTarget = "";
        this.plan = null;
        this.next(0);
      }
      return;
    }
    const torch = [0, 1, 2, 3].find((i) => slotKind(p, i) === "torch");
    let crab: XZ | null = null;
    let best = GUARD_SWING_REACH;
    let near = false;
    let boss: XZ | null = null;
    let flipped = "";
    let flippedD = GUARD_COLLECT_REACH;
    let shot = "";
    let shotD = GUARD_THROW_RANGE;
    let threats = 0;
    let bossFar = "";
    ctx.state.monsters.forEach((m) => {
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (m.kind === "crab" && m.mode === "flipped") {
        if (d < flippedD) {
          flippedD = d;
          flipped = m.id;
        }
        return;
      }
      if (m.mode === "flee" || m.mode === "emerge") return;
      if (m.kind === "boss" && d < GUARD_BOSS_KITE) boss = m;
      else if (m.kind === "boss" && d < GUARD_THROW_RANGE + 4) bossFar = m.id;
      if (m.kind !== "crab") return;
      if (d < 8) near = true;
      if (d < 4) threats++;
      if (d < best) {
        best = d;
        crab = m;
      }
      // Scared-off crabs (backing away, slow to turn) are the easy throws: two stones flip one.
      if (m.mode === "stunned" && d > 2.2 && d < shotD) {
        shotD = d;
        shot = m.id;
      }
    });
    // The torch only burns in hand: light it for the night, or when a crab comes.
    if (torch !== undefined && p.activeSlot !== torch && (ctx.state.dayPhase === "night" || near)) this.select(p, torch, out);
    const b = boss as XZ | null;
    if (b) {
      // Captain Crab goes for the guard: keep the raft between us (in the torch light he is slowed to half).
      const raft = this.site(ctx, p).raft;
      const ax = raft.x - b.x;
      const az = raft.z - b.z;
      const al = Math.hypot(ax, az) || 1;
      this.walk(ctx, p, raft.x + (ax / al) * 4.5, raft.z + (az / al) * 4.5, 0.6, out, true);
      return;
    }
    const c = crab as XZ | null;
    if (c && torch !== undefined && p.activeSlot === torch && p.torchTicks > 0) {
      const yaw = yawFromDir(c.x - p.x, c.z - p.z);
      this.face(p, yaw, -0.2, out);
      if (p.throwTicks === 0 && Math.abs(angleDelta(out.yaw, yaw)) < 0.5) out.buttons |= BTN.USE_PRESS;
      return;
    }
    // Nothing at arm's length: finish the job — a flipped crab picked up is one crab less tonight.
    if (flipped !== "" && threats === 0 && roomFor(p, "crab_raw") > 0) {
      this.guardSub = "collect";
      this.guardTarget = flipped;
      this.next(0);
      return;
    }
    const stone = [0, 1, 2, 3].find((i) => slotKind(p, i) === "spear") ?? [0, 1, 2, 3].find((i) => slotKind(p, i) === "stone");
    // Captain Crab still out of reach (slowed in our light): a stone or the spear at him — the compass is his.
    if (bossFar !== "" && stone !== undefined && threats === 0) {
      this.guardSub = "throw";
      this.guardTarget = bossFar;
      this.guardSlot = stone;
      this.next(0);
      return;
    }
    if (shot !== "" && stone !== undefined && threats === 0) {
      this.guardSub = "throw";
      this.guardTarget = shot;
      this.guardSlot = stone;
      this.next(0);
      return;
    }
    this.hangAround(ctx, p, at, out);
  }


  /** Keep within a couple of meters of a teammate (their position is re-read every tick: they move). */
  private follow(ctx: MotorCtx, p: PlayerState, id: string, out: MotorFrame): void {
    const m = ctx.state.players.get(id);
    if (!m || !m.alive || m.boarded) {
      this.finish();
      return;
    }
    this.hangAround(ctx, p, m, out, 2.4);
  }

  private idleLook(ctx: MotorCtx, p: PlayerState, out: MotorFrame): void {
    if (this.lookTimer-- <= 0 || Number.isNaN(this.lookYaw)) {
      this.lookTimer = 35 + Math.floor(ctx.rng() * 60);
      let target: XZ | null = null;
      let best = 25;
      ctx.state.monsters.forEach((m) => {
        const d = Math.hypot(m.x - p.x, m.z - p.z);
        if (d < best && m.mode !== "flee") {
          best = d;
          target = m;
        }
      });
      const t = target as XZ | null;
      this.lookYaw = t ? yawFromDir(t.x - p.x, t.z - p.z) : wrapAngle(p.yaw + (ctx.rng() - 0.5) * 2.2);
      this.lookPitch = -0.25 + ctx.rng() * 0.35;
    }
    out.yaw = turnToward(p.yaw, this.lookYaw, MAX_TURN * 0.35);
    out.pitch = turnToward(p.pitch, this.lookPitch, MAX_PITCH_TURN * 0.5);
  }

  /** What E resolves to for `view` (posed): "go" (wanted & ok), "refused" (wanted but not ok), "other" / "none". */
  private probeE(ctx: MotorCtx, view: PlayerState, want: (it: Interaction) => boolean, geometricOk: boolean): "go" | "refused" | "other" | "none" {
    const it = resolveInteraction({ island: ctx.island, state: ctx.state }, view, this.scratch);
    if (!it) return geometricOk ? "go" : "none";
    if (want(it)) return it.ok ? "go" : "refused";
    return "other";
  }

  /** Within `reach` of (x, z) and looking at it inside the interaction cone (fallback when the resolver says nothing). */
  private geometric(p: PlayerState, x: number, z: number, reach: number): boolean {
    const dx = x - p.x;
    const dz = z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > reach) return false;
    if (d < 1.2) return true;
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    return (fx * dx + fz * dz) / d >= INTERACT_CONE_COS;
  }

  /**
   * Shared E flow. Stage 0 walks to `stand` meters of the target, stage 1 faces it (or a look past whatever
   * outranks it, clearLook) and presses E when the resolver agrees, stage 2 holds E (hold kinds) or waits for the
   * tap to land, then calls `after`.
   * `after` returns "again" (press once more), "done" or "wait" (keep waiting this stage).
   */
  private flowE(
    ctx: MotorCtx,
    p: PlayerState,
    out: MotorFrame,
    target: Point | null,
    o: {
      stand: number;
      reach: number;
      want: (it: Interaction) => boolean;
      hold: boolean;
      keep?: () => boolean;
      after?: () => "again" | "done" | "wait";
      sprint?: boolean;
      /** Longest a hold may last before the goal fails (default ACT_TIMEOUT × 3; assembly holds much longer). */
      holdLimit?: number;
    },
  ): void {
    if (!target) {
      this.fail("gone");
      return;
    }
    const yaw = yawFromDir(target.x - p.x, target.z - p.z);
    const pitch = clamp(pitchTo(p, target.x, target.y, target.z), -0.9, 0.5);
    if (o.keep && !o.keep()) {
      // Not worth it any more (node empty, inventory full, revived by someone else).
      this.finish();
      return;
    }
    switch (this.stage) {
      case 0: {
        if (this.walk(ctx, p, target.x, target.z, o.stand, out, !!o.sprint)) this.next(1);
        else this.timeout(WALK_TIMEOUT, "unreachable");
        return;
      }
      case 1: {
        const d = Math.hypot(target.x - p.x, target.z - p.z);
        if (d > o.reach + 0.4) {
          this.next(0);
          return;
        }
        if (this.spot) {
          // Stepping around the target to where E reaches it (clearLook); given up after ASIDE_WALK_TICKS.
          if (!this.walk(ctx, p, this.spot.x, this.spot.z, 0.3, out, false)) {
            if (this.ticks >= this.spotUntil) this.spot = null;
            return;
          }
          this.spot = null;
        }
        const look = wrapAngle(yaw + this.aside);
        this.face(p, look, pitch, out);
        if (!this.faced(p, look) || this.gap > 0) return;
        // The server applies the command's look before it resolves E: probe that look, not the state's.
        const r = this.probeE(ctx, posed(p, p.x, p.y, p.z, out.yaw), o.want, this.geometric(p, target.x, target.z, o.reach));
        if (r === "go") {
          out.buttons |= BTN.INTERACT_PRESS | BTN.INTERACT;
          this.presses++;
          this.channelSeen = false;
          this.next(2);
          return;
        }
        if (r === "refused") {
          this.fail("refused");
          return;
        }
        // Something else is in the way (or nothing is in reach): look past what outranks the target, else edge
        // closer and try a slightly different angle.
        this.attempts++;
        if (this.attempts > 40) {
          this.fail("blocked");
          return;
        }
        if (r === "other" && this.clearLook(ctx, p, target, o.want)) return;
        this.aside = 0;
        const closer = Math.max(0.6, o.stand * 0.6);
        if (d > closer + 0.15) this.walk(ctx, p, target.x, target.z, closer, out, false);
        else out.yaw = wrapAngle(yaw + (this.attempts % 2 ? 0.25 : -0.25));
        return;
      }
      case 2: {
        this.face(p, wrapAngle(yaw + this.aside), pitch, out);
        if (o.hold) {
          if (p.channel !== 0) this.channelSeen = true;
          if (this.channelSeen && p.channel === 0) {
            // Unit chain ended (empty node / revive done); press again if still wanted.
            const next = o.after ? o.after() : "done";
            if (next === "again" && this.presses < 12) {
              this.gap = 2;
              this.next(1);
            } else this.finish();
            return;
          }
          if (!this.channelSeen && this.stageTicks > 6) {
            this.attempts++;
            this.gap = 3;
            if (this.attempts > 4) this.fail("noChannel");
            else this.next(1);
            return;
          }
          out.buttons |= BTN.INTERACT;
          this.timeout(o.holdLimit ?? ACT_TIMEOUT * 3);
          return;
        }
        if (this.stageTicks < 4) return;
        const next = o.after ? o.after() : "done";
        if (next === "again" && this.presses < 8) {
          this.gap = ACTION_GAP;
          this.next(1);
        } else if (next === "done") this.finish();
        else this.timeout(ACT_TIMEOUT);
        return;
      }
    }
  }

  /**
   * Something that outranks the target wins E from here (an item lying in front of the raft, a flipped crab).
   * Find a look, as an offset from facing the target, at which E resolves to the wanted kind: from here, or else
   * from a spot a step around the target at the same distance (no look gets past an item at the bot's feet: it is
   * reachable from every side). Sets `aside` (and `spot` to walk to first); false when nothing works.
   */
  private clearLook(ctx: MotorCtx, p: PlayerState, target: Point, want: (it: Interaction) => boolean): boolean {
    const d = Math.hypot(p.x - target.x, p.z - target.z);
    const bearing = Math.atan2(p.x - target.x, p.z - target.z);
    for (let s = -1; s < ASIDE_SPOTS.length; s++) {
      let x = p.x;
      let y = p.y;
      let z = p.z;
      if (s >= 0) {
        x = target.x + Math.sin(bearing + ASIDE_SPOTS[s]!) * d;
        z = target.z + Math.cos(bearing + ASIDE_SPOTS[s]!) * d;
        y = heightAt(ctx.island.grid, x, z);
        if (y < WATER_Y) continue; // not out into the sea
      }
      const toTarget = yawFromDir(target.x - x, target.z - z);
      for (const off of ASIDE_LOOKS) {
        if (this.probeE(ctx, posed(p, x, y, z, wrapAngle(toTarget + off)), want, false) !== "go") continue;
        this.aside = off;
        this.spot = s < 0 ? null : { x, z };
        this.spotUntil = this.ticks + ASIDE_WALK_TICKS;
        return true;
      }
    }
    return false;
  }

  /* ============================================================ goals */

  private eat(ctx: MotorCtx, p: PlayerState, slot: number, out: MotorFrame): void {
    void ctx;
    const kind = slotKind(p, slot);
    if (kind === "") {
      this.finish();
      return;
    }
    if (!this.select(p, slot, out)) {
      this.timeout(10, "slot");
      return;
    }
    if (this.stage === 0) {
      this.presses = slotCount(p, slot); // units before the bite
      out.buttons |= BTN.EAT;
      this.next(1);
      return;
    }
    if (slotCount(p, slot) < this.presses || slotKind(p, slot) !== kind) this.finish();
    else if (this.stageTicks > 6) {
      this.attempts++;
      if (this.attempts > 2) this.fail("notEaten");
      else this.next(0);
    }
  }

  private revive(ctx: MotorCtx, p: PlayerState, id: string, out: MotorFrame): void {
    const m = ctx.state.players.get(id);
    const target = m && m.alive && m.downed ? { x: m.x, y: m.y + 0.3, z: m.z } : null;
    if (!target) {
      this.finish();
      return;
    }
    this.flowE(ctx, p, out, target, {
      stand: 1.2,
      reach: REVIVE_RANGE,
      hold: true,
      sprint: true,
      want: (it) => it.kind === "revive" && it.playerId === id,
      keep: () => !!m && m.downed && m.alive,
      after: () => (m?.downed ? "again" : "done"),
    });
  }

  private raftTarget(ctx: MotorCtx, p: PlayerState): { stand: XZ; center: Point } {
    const site = this.site(ctx, p);
    const r = site.raft;
    const dx = site.campfire.x - r.x;
    const dz = site.campfire.z - r.z;
    const l = Math.hypot(dx, dz) || 1;
    const stand = { x: r.x + (dx / l) * 2.4, z: r.z + (dz / l) * 2.4 };
    return { stand, center: { x: r.x, y: heightAt(ctx.island.grid, r.x, r.z) + 0.4, z: r.z } };
  }

  /** Walk to the raft's land-side stand point first, then run the E flow against the raft center. */
  private raftFlow(
    ctx: MotorCtx,
    p: PlayerState,
    out: MotorFrame,
    want: InteractKind,
    after: () => "again" | "done" | "wait",
    hold?: { keep: () => boolean; limit: number },
  ): void {
    const { stand, center } = this.raftTarget(ctx, p);
    if (this.stage === 0 && dist(p, stand) > 0.8) {
      if (hold && !hold.keep()) {
        this.finish();
        return;
      }
      if (!this.walk(ctx, p, stand.x, stand.z, 0.8, out, true)) this.timeout(WALK_TIMEOUT, "unreachable");
      return;
    }
    if (this.stage === 0) this.next(1);
    this.flowE(ctx, p, out, center, {
      stand: 2.4,
      reach: RAFT_RANGE,
      hold: !!hold,
      want: (it) => it.kind === want,
      after,
      ...(hold ? { keep: hold.keep, holdLimit: hold.limit } : {}),
    });
  }

  /** Hold E at the raft (CHANNEL.BUILD) until the stage is assembled (or its materials / the day lock change). */
  private assemble(ctx: MotorCtx, p: PlayerState, out: MotorFrame): void {
    const team = ctx.state.teams[p.team] ?? ctx.state.teams[0];
    if (!team) {
      this.fail("gone");
      return;
    }
    if (this.ticks === 1) this.signature = team.stage;
    const keep = () => team.stage === this.signature && raftMaterialsDone(team);
    this.raftFlow(ctx, p, out, "assemble", () => (keep() ? "again" : "done"), { keep, limit: ASSEMBLE_HOLD_LIMIT });
  }

  /** E at the raft with a hammer: a plank (or 2 wood) per press while the hp is low and there is something to spend. */
  private repair(ctx: MotorCtx, p: PlayerState, out: MotorFrame): void {
    const team = ctx.state.teams[p.team] ?? ctx.state.teams[0];
    if (!team) {
      this.fail("gone");
      return;
    }
    const can = () => team.raftHp < RAFT_HP_MAX && (countOf(p, "raft_part") > 0 || countOf(p, "wood") >= RAFT_REPAIR_WOOD_COST);
    if (this.ticks === 1) {
      this.signature = team.raftHp;
      if (!can()) {
        this.fail("nothing");
        return;
      }
    }
    this.raftFlow(ctx, p, out, "repair", () => {
      if (team.raftHp > this.signature) {
        this.signature = team.raftHp;
        return can() && team.raftHp < REPAIR_GOAL_HP ? "again" : "done";
      }
      if (this.presses < 3) return "again";
      this.fail("notRepaired");
      return "wait";
    });
  }

  /** Hold E at the wreck with a hammer for scrap while it has some and there is room. */
  private salvage(ctx: MotorCtx, p: PlayerState, out: MotorFrame): void {
    const site = this.site(ctx, p);
    const team = ctx.state.teams[p.team] ?? ctx.state.teams[0];
    const w = site.wreck;
    const keep = (): boolean => !!team && team.wreckScrap > 0 && countOf(p, "hammer") > 0 && roomFor(p, "scrap") > 0;
    // Stand just outside the hull's collider (WRECK_RADIUS 1.8), within WRECK_RANGE of its center.
    this.flowE(ctx, p, out, { x: w.x, y: heightAt(ctx.island.grid, w.x, w.z) + 0.6, z: w.z }, {
      stand: WRECK_RANGE - 0.4,
      reach: WRECK_RANGE,
      hold: true,
      want: (it) => it.kind === "salvage",
      keep,
      after: () => (keep() ? "again" : "done"),
    });
  }

  /**
   * Chop tree `node` with the axe to its last unit (it falls and drops a log: Long Tide §4.1), then pick the log up
   * once it lies still at the foot of the tree.
   */
  private fell(ctx: MotorCtx, p: PlayerState, node: number, out: MotorFrame): void {
    const n = ctx.island.nodes[node];
    if (!n) {
      this.fail("gone");
      return;
    }
    if (!this.felled && (ctx.state.nodes[node] ?? 0) <= 0) {
      // Down (by us or someone else): now the log.
      this.felled = true;
      this.felledAt = this.ticks;
      this.presses = 0;
      this.next(0);
    }
    if (!this.felled) {
      if (countOf(p, "axe") <= 0) {
        this.fail("noAxe");
        return;
      }
      this.flowE(ctx, p, out, { x: n.x, y: n.y + 1, z: n.z }, {
        stand: n.radius + 0.95,
        reach: INTERACT_RANGE + n.radius,
        hold: true,
        want: (it) => it.kind === "gather" && it.node === node,
        after: () => "again",
      });
      // The channel ends when the tree falls: that is not the end of this goal.
      if (this.status === "done") {
        this.status = "running";
        this.felled = (ctx.state.nodes[node] ?? 0) <= 0;
        this.felledAt = this.ticks;
        this.presses = 0;
        this.next(0);
      }
      return;
    }
    if (this.logId === "" || !ctx.state.projectiles.has(this.logId)) {
      this.logId = "";
      let best = 4.5;
      ctx.state.projectiles.forEach((pr) => {
        if (pr.kind !== "log") return;
        const d = Math.hypot(pr.x - n.x, pr.z - n.z);
        if (d < best) {
          best = d;
          this.logId = pr.id;
        }
      });
      if (this.logId === "") {
        if (this.ticks - this.felledAt > 20) this.finish();
        return;
      }
    }
    const pr = ctx.state.projectiles.get(this.logId)!;
    if (pr.state !== "rest" && pr.state !== "stuck") {
      // Still rolling: wait beside it.
      this.walk(ctx, p, pr.x, pr.z, 1.2, out, false);
      if (this.ticks - this.felledAt > secToTicks(6)) this.finish();
      return;
    }
    if (roomFor(p, "log") <= 0) {
      this.fail("full");
      return;
    }
    this.pickup(ctx, p, this.logId, out);
  }

  /** Walk beside a teammate while they carry heavy cargo (within ESCORT_RADIUS they carry it faster). */
  private escort(ctx: MotorCtx, p: PlayerState, id: string, out: MotorFrame): void {
    const m = ctx.state.players.get(id);
    if (!m || !m.alive || m.downed || m.boarded || !carriesHeavy(m)) {
      this.finish();
      return;
    }
    if (this.ticks > secToTicks(60)) {
      this.finish();
      return;
    }
    // Walk to a spot just beside them (on our side), keep there.
    const dx = p.x - m.x;
    const dz = p.z - m.z;
    const d = Math.hypot(dx, dz) || 1;
    const at = { x: m.x + (dx / d) * 1.3, z: m.z + (dz / d) * 1.3 };
    if (d <= ESCORT_RADIUS - 1) {
      // Close enough: match their walk (no sprinting past them), look about.
      if (!this.walk(ctx, p, at.x, at.z, 0.4, out, false)) out.buttons &= ~BTN.SPRINT;
      else this.idleLook(ctx, p, out);
      return;
    }
    this.walk(ctx, p, at.x, at.z, 0.4, out, true);
  }

  private board(ctx: MotorCtx, p: PlayerState, out: MotorFrame): void {
    if (p.boarded) {
      this.finish();
      return;
    }
    this.raftFlow(ctx, p, out, "board", () => {
      if (p.boarded) return "done";
      if (this.presses < 4) return "again";
      this.fail("notBoarded");
      return "wait";
    });
  }

  private deliver(ctx: MotorCtx, p: PlayerState, out: MotorFrame): void {
    if (this.ticks === 1) this.signature = this.inventorySignature(p);
    this.raftFlow(ctx, p, out, "deliver", () => {
      if (this.inventorySignature(p) !== this.signature) return "done";
      if (this.presses < 3) return "again";
      this.fail("nothingDelivered");
      return "wait";
    });
  }

  /** Cheap fingerprint of the inventory (detects that a delivery / pickup happened). */
  private inventorySignature(p: PlayerState): number {
    let h = 0;
    for (let i = 0; i < 4; i++) h = h * 31 + slotCount(p, i) * 7 + slotKind(p, i).length;
    return h;
  }

  private spring(ctx: MotorCtx, p: PlayerState, uses: number, out: MotorFrame): void {
    const sp = this.site(ctx, p).spring;
    const target = { x: sp.x, y: heightAt(ctx.island.grid, sp.x, sp.z) + 0.2, z: sp.z };
    this.flowE(ctx, p, out, target, {
      stand: 1.3,
      reach: SPRING_RANGE,
      hold: false,
      want: (it) => it.kind === "spring",
      after: () => (this.presses < uses && (roomFor(p, "water") > 0 || p.thirst < 90) ? "again" : "done"),
    });
  }

  private pickup(ctx: MotorCtx, p: PlayerState, id: string, out: MotorFrame): void {
    const pr = ctx.state.projectiles.get(id);
    if (!pr || pr.state === "live") {
      if (this.presses > 0) this.finish();
      else this.fail("gone");
      return;
    }
    if (roomFor(p, pr.kind) <= 0) {
      this.fail("full");
      return;
    }
    this.flowE(ctx, p, out, { x: pr.x, y: pr.y, z: pr.z }, {
      stand: 1.0,
      reach: PICKUP_RANGE,
      hold: false,
      want: (it) => it.kind === "pickup",
      after: () => (ctx.state.projectiles.has(id) ? "again" : "done"),
    });
  }

  private collectCrab(ctx: MotorCtx, p: PlayerState, id: string, out: MotorFrame): void {
    const m = ctx.state.monsters.get(id);
    if (!m || m.mode !== "flipped") {
      if (this.presses > 0 || !m) this.finish();
      else this.fail("notFlipped");
      return;
    }
    this.flowE(ctx, p, out, { x: m.x, y: m.y + 0.3, z: m.z }, {
      stand: 1.1,
      reach: INTERACT_RANGE + MONSTERS.crab.radius,
      hold: false,
      want: (it) => it.kind === "collectCrab" && it.monsterId === id,
      after: () => (ctx.state.monsters.has(id) ? "again" : "done"),
    });
  }

  private gather(ctx: MotorCtx, p: PlayerState, node: number, out: MotorFrame): void {
    const n = ctx.island.nodes[node];
    if (!n) {
      this.fail("gone");
      return;
    }
    const left = (): number => ctx.state.nodes[node] ?? 0;
    const berry = n.kind === "bush" && n.yield === "berry";
    const yieldKind: ItemKind = n.kind === "tree" ? "wood" : n.kind === "rock" ? "stone" : "rope";
    const keep = (): boolean => left() > 0 && (berry ? p.hunger < 95 : roomFor(p, yieldKind) > 0);
    this.flowE(ctx, p, out, { x: n.x, y: n.y + 1, z: n.z }, {
      stand: n.radius + (n.radius > 0 ? 0.95 : 1.3),
      reach: INTERACT_RANGE + n.radius,
      hold: true,
      want: (it) => it.kind === "gather" && it.node === node,
      keep,
      after: () => (keep() ? "again" : "done"),
    });
  }

  private shake(ctx: MotorCtx, p: PlayerState, node: number, out: MotorFrame): void {
    const n = ctx.island.nodes[node];
    if (!n || (ctx.state.nodes[node] ?? 0) <= 0) {
      this.finish();
      return;
    }
    const slot = palmHandSlot(slotsOfPlayer(p));
    if (slot < 0) {
      this.fail("hands");
      return;
    }
    if (this.stage === 0) {
      if (this.walk(ctx, p, n.x, n.z, Math.min(PALM_HIT_RANGE - 0.9, n.radius + 1.1), out, false)) this.next(1);
      else this.timeout(WALK_TIMEOUT, "unreachable");
      return;
    }
    const yaw = yawFromDir(n.x - p.x, n.z - p.z);
    const pitch = 0.25;
    if (this.stage === 1) {
      const selected = this.select(p, slot, out);
      const faced = this.face(p, yaw, pitch, out);
      if (selected && faced && this.faced(p, yaw) && p.throwTicks === 0 && this.gap === 0) {
        this.presses = ctx.state.nodes[node] ?? 0;
        out.buttons |= BTN.USE_PRESS;
        this.next(2);
      } else this.timeout(ACT_TIMEOUT, "aim");
      return;
    }
    this.face(p, yaw, pitch, out);
    if ((ctx.state.nodes[node] ?? 0) < this.presses) {
      this.finish();
      return;
    }
    if (this.stageTicks > 12) {
      this.attempts++;
      this.gap = 4;
      if (this.attempts > 3) this.fail("noShake");
      else this.next(1);
    }
  }

  private fish(ctx: MotorCtx, p: PlayerState, spotIndex: number, out: MotorFrame): void {
    const spot = ctx.island.fishSpots[spotIndex];
    const rod = [0, 1, 2, 3].find((i) => slotKind(p, i) === "rod");
    if (!spot || rod === undefined) {
      this.fail("noRod");
      return;
    }
    const yaw = yawFromDir(spot.x - p.x, spot.z - p.z);
    const pitch = clamp(pitchTo(p, spot.x, WATER_Y, spot.z), -1.2, 0);
    switch (this.stage) {
      case 0: {
        const standGoal = this.fishStand(ctx, spotIndex);
        if (!standGoal) {
          this.fail("noStand");
          return;
        }
        if (this.walk(ctx, p, standGoal.x, standGoal.z, 0.6, out, false)) this.next(1);
        else this.timeout(WALK_TIMEOUT, "unreachable");
        return;
      }
      case 1: {
        const selected = this.select(p, rod, out);
        const faced = this.face(p, yaw, pitch, out);
        if (p.fishState !== FISH_STATE.NONE) {
          this.next(3);
          return;
        }
        if (selected && faced && this.faced(p, yaw) && p.throwTicks === 0 && this.gap === 0) {
          out.buttons |= BTN.USE_PRESS;
          this.next(2);
        } else this.timeout(ACT_TIMEOUT, "aim");
        return;
      }
      case 2: {
        this.face(p, yaw, pitch, out);
        if (p.fishState !== FISH_STATE.NONE) {
          this.next(3);
          return;
        }
        if (this.stageTicks > 10) {
          this.attempts++;
          this.gap = 6;
          if (this.attempts > 3) this.fail("noCast");
          else this.next(1);
        }
        return;
      }
      case 3: {
        // Line in the water: stand still, wait for the dip, strike within the window.
        this.face(p, yaw, pitch, out);
        if (p.activeSlot !== rod) this.select(p, rod, out);
        if (p.fishState === FISH_STATE.BITE) {
          if (this.biteAt < 0) {
            const late = ctx.rng() < BITE_MISS_CHANCE;
            this.biteAt = this.ticks + (late ? 30 : BITE_REACTION_MIN + Math.floor(ctx.rng() * BITE_REACTION_SPAN));
          }
          if (this.ticks >= this.biteAt) {
            out.buttons |= BTN.USE_PRESS;
            this.biteAt = -1;
            this.next(4);
          }
          return;
        }
        this.biteAt = -1;
        if (p.fishState === FISH_STATE.NONE) {
          this.finish();
          return;
        }
        this.timeout(secToTicks(10), "noBite");
        return;
      }
      default: {
        // Reeling: wait for the catch to land in the inventory.
        this.face(p, yaw, pitch, out);
        if (p.fishState === FISH_STATE.NONE) this.finish();
        else if (p.fishState === FISH_STATE.CAST) this.next(3);
        else this.timeout(secToTicks(6), "reel");
      }
    }
  }

  private fishStand(ctx: MotorCtx, spotIndex: number): XZ | null {
    const spot = ctx.island.fishSpots[spotIndex];
    if (!spot) return null;
    return ctx.fishStands()[spotIndex] ?? null;
  }

  /** Walk to a station (campfire / chest) and run `act` every ACTION_GAP ticks until it returns done / failed. */
  private station(ctx: MotorCtx, p: PlayerState, at: XZ, reach: number, out: MotorFrame, act: () => "again" | "done" | "failed"): void {
    if (this.stage === 0) {
      if (this.walk(ctx, p, at.x, at.z, Math.max(1.2, reach - 1), out, false)) {
        this.next(1);
        this.gap = 3;
      } else this.timeout(WALK_TIMEOUT, "unreachable");
      return;
    }
    if (dist(p, at) > reach + 0.3) {
      this.next(0);
      return;
    }
    this.face(p, yawFromDir(at.x - p.x, at.z - p.z), -0.35, out);
    if (this.gap > 0) return;
    this.gap = ACTION_GAP;
    const r = act();
    if (r === "done") this.finish();
    else if (r === "failed") this.fail("station");
    else this.timeout(ACT_TIMEOUT * 2);
  }

  private craft(ctx: MotorCtx, p: PlayerState, recipe: RecipeId, count: number, out: MotorFrame): void {
    const site = this.site(ctx, p);
    this.station(ctx, p, site.campfire, CRAFT_RANGE, out, () => {
      const team = ctx.state.teams[p.team] ?? ctx.state.teams[0];
      if (recipe !== "fuel" && team && team.fireFuel <= 0) {
        // Relight first (one wood), then craft.
        return ctx.craft("fuel") ? "again" : "failed";
      }
      if (!ctx.craft(recipe)) return this.presses > 0 ? "done" : "failed";
      this.presses++;
      return this.presses >= count ? "done" : "again";
    });
  }

  private chestTake(ctx: MotorCtx, p: PlayerState, items: { kind: ItemKind; count: number }[], out: MotorFrame): void {
    const site = this.site(ctx, p);
    this.station(ctx, p, site.chest, CHEST_RANGE, out, () => {
      const item = items[this.putIndex];
      if (!item) return this.presses > 0 ? "done" : "failed";
      this.putIndex++;
      const n = Math.min(item.count, roomFor(p, item.kind));
      if (n > 0 && ctx.chest({ op: "take", kind: item.kind, count: n })) this.presses++;
      return this.putIndex >= items.length ? (this.presses > 0 ? "done" : "failed") : "again";
    });
  }

  private chestPut(ctx: MotorCtx, p: PlayerState, items: { kind: ItemKind; count: number }[], out: MotorFrame): void {
    const at = this.site(ctx, p).chest;
    if (this.stage === 0) {
      if (this.walk(ctx, p, at.x, at.z, Math.max(1.2, CHEST_RANGE - 1), out, false)) {
        this.next(1);
        this.gap = 3;
      } else this.timeout(WALK_TIMEOUT, "unreachable");
      return;
    }
    if (dist(p, at) > CHEST_RANGE + 0.3) {
      this.next(0);
      return;
    }
    this.face(p, yawFromDir(at.x - p.x, at.z - p.z), -0.35, out);
    if (this.timeout(ACT_TIMEOUT * 2)) return;
    // ChestMsg "put" takes from the ACTIVE slot: select the slot of the next kind (an edge), then put from it.
    const item = items[this.putIndex];
    if (!item) {
      if (this.presses > 0) this.finish();
      else this.fail("station");
      return;
    }
    const slot = [0, 1, 2, 3].find((i) => slotKind(p, i) === item.kind);
    if (slot === undefined || this.putCount >= item.count) {
      this.putIndex++;
      this.putCount = 0;
      return;
    }
    if (!this.select(p, slot, out) || this.gap > 0) return;
    const n = Math.min(item.count - this.putCount, slotCount(p, slot));
    this.gap = 3;
    if (ctx.chest({ op: "put", count: n })) {
      this.presses++;
      this.putCount += n;
    } else {
      this.putIndex++;
      this.putCount = 0;
    }
  }

  /* ============================================================ throwing */

  /**
   * Charge-and-release flow at `target()` (re-read every tick, led by its velocity). Holds position while
   * charging; walks closer when out of `maxRange` unless `stay`.
   */
  private throwFlow(
    ctx: MotorCtx,
    p: PlayerState,
    slot: number,
    out: MotorFrame,
    target: () => Point | null,
    o: { maxRange: number; stay: boolean; charge?: number; checkShot?: boolean },
  ): void {
    const kind = slotKind(p, slot);
    const t = target();
    if (kind === "" || !t) {
      if (this.stage >= 3) this.finish();
      else this.fail(kind === "" ? "noAmmo" : "gone");
      return;
    }
    const d = Math.hypot(t.x - p.x, t.z - p.z);
    switch (this.stage) {
      case 0: {
        if (d > o.maxRange) {
          if (o.stay) this.fail("outOfRange");
          else if (!this.walk(ctx, p, t.x, t.z, o.maxRange * 0.8, out, true)) this.timeout(WALK_TIMEOUT, "unreachable");
          return;
        }
        const selected = this.select(p, slot, out);
        this.face(p, yawFromDir(t.x - p.x, t.z - p.z), pitchTo(p, t.x, t.y, t.z), out);
        if (!selected || p.throwTicks > 0 || p.chargeTicks > 0) {
          this.timeout(ACT_TIMEOUT, "ready");
          return;
        }
        const vel = t.vx !== undefined ? { x: t.vx, z: t.vz ?? 0 } : null;
        let aim = aimFromPlayer(p, t, vel, kind as ItemKind, 0, () => ctx.rng(), o.charge !== undefined ? { charge: o.charge } : {});
        if (!aim) {
          if (o.stay) this.fail("outOfRange");
          else this.walk(ctx, p, t.x, t.z, Math.max(3, d * 0.6), out, true);
          return;
        }
        if (o.checkShot && !this.shotOk(ctx, p, aim, t, kind as ItemKind)) {
          // Something's in the way (a trunk, a rock, a teammate): lob over it, else step aside and look again.
          const lob = o.charge === undefined ? aimFromPlayer(p, t, vel, kind as ItemKind, 0, () => ctx.rng(), { high: true }) : null;
          aim = lob && this.shotOk(ctx, p, lob, t, kind as ItemKind) ? lob : null;
          if (!aim) {
            if (o.stay || this.attempts >= 2) {
              this.fail("noShot");
              return;
            }
            this.attempts++;
            const side = this.attempts % 2 ? 1 : -1;
            const ux = (t.x - p.x) / (d || 1);
            const uz = (t.z - p.z) / (d || 1);
            this.awayPoint = { x: p.x - uz * side * SIDESTEP, y: p.y, z: p.z + ux * side * SIDESTEP };
            this.next(5);
            return;
          }
        }
        const noise = applyAimNoise({ ...aim, yaw: 0, pitch: 0 }, aimNoiseFor(ctx.role, ctx.rng()), () => ctx.rng());
        this.plan = { slot, kind: kind as ItemKind, chargeTicks: Math.max(1, aim.chargeTicks), noiseYaw: noise.yaw, noisePitch: noise.pitch, charge: aim.charge };
        this.next(1);
        return;
      }
      case 1:
      case 2: {
        const plan = this.plan!;
        if (slotKind(p, plan.slot) !== plan.kind || p.activeSlot !== plan.slot) {
          this.fail("slot");
          return;
        }
        const aim = this.aimNow(ctx, p, t, plan);
        if (!aim) {
          this.fail("outOfRange");
          return;
        }
        const yaw = aim.yaw + plan.noiseYaw;
        const pitch = aim.pitch + plan.noisePitch;
        const faced = this.face(p, yaw, pitch, out);
        if (this.stage === 1) {
          if (faced && this.faced(p, yaw)) this.next(2);
          else this.timeout(ACT_TIMEOUT, "aim");
          return;
        }
        // Charging: hold LMB until the planned charge, then let go (no THROW bit) with the final aim.
        if (p.chargeTicks < plan.chargeTicks) {
          out.buttons |= BTN.THROW;
          if (this.stageTicks > CHARGE_FULL_TICKS + 12) this.fail("charge");
          return;
        }
        out.yaw = wrapAngle(yaw);
        out.pitch = clamp(pitch, -1.5, 1.5);
        this.next(3);
        return;
      }
      case 5: {
        // Sidestepping for a clear shot.
        const to = this.awayPoint!;
        if (this.walk(ctx, p, to.x, to.z, 0.5, out, false) || this.stageTicks > secToTicks(2.5)) this.next(0);
        return;
      }
      default:
        if (p.throwTicks === 0 || this.stageTicks > 10) this.finish();
    }
  }

  /** The throw's path is clear of terrain, cover and teammates up to the target. */
  private shotOk(ctx: MotorCtx, p: PlayerState, aim: AimSolution, t: Point, kind: ItemKind): boolean {
    const origin = throwOrigin({ x: p.x, y: p.y, z: p.z, yaw: aim.yaw });
    const lead = { x: t.x + (t.vx ?? 0) * aim.time, y: t.y, z: t.z + (t.vz ?? 0) * aim.time };
    const mates: ShotObstacle[] = [];
    ctx.state.players.forEach((o) => {
      if (o.id === p.id || !o.alive || o.boarded || o.spectator) return;
      mates.push({ x: o.x, y: o.y, z: o.z, r: PLAYER_RADIUS + 0.05, h: PLAYER_HEIGHT });
    });
    return shotClear(ctx.world, origin, aimVelocity(aim), kind, lead, t.r ?? 0.3, mates);
  }

  private aimNow(ctx: MotorCtx, p: PlayerState, t: Point, plan: ThrowPlan): AimSolution | null {
    return aimFromPlayer(p, t, t.vx !== undefined ? { x: t.vx, z: t.vz ?? 0 } : null, plan.kind, 0, () => ctx.rng(), { charge: plan.charge });
  }

  private monsterPoint(ctx: MotorCtx, id: string): Point | null {
    const m = ctx.state.monsters.get(id);
    if (!m || m.mode === "flee") return null;
    const def = MONSTERS[m.kind];
    const vel = ctx.velocity(id);
    return { x: m.x, y: m.y + def.height * 0.5, z: m.z, vx: vel?.vx ?? 0, vz: vel?.vz ?? 0, r: def.radius };
  }

  private attack(ctx: MotorCtx, p: PlayerState, id: string, slot: number, push: boolean, out: MotorFrame): void {
    // At night a bot throws from where it stands (inside the light) unless it was sent out to defend the raft.
    const stay = ctx.state.dayPhase === "night" && !push;
    this.throwFlow(ctx, p, slot, out, () => this.monsterPoint(ctx, id), { maxRange: push ? 14 : 26, stay, checkShot: true });
  }

  private throwAway(ctx: MotorCtx, p: PlayerState, slot: number, monsterId: string, out: MotorFrame): void {
    if (!this.awayMode && monsterId && ctx.state.monsters.has(monsterId)) {
      this.throwFlow(ctx, p, slot, out, () => this.monsterPoint(ctx, monsterId), { maxRange: 28, stay: true });
      // Couldn't get a shot at the monster: the puffer still has to go, so lob it away instead.
      if (this.status === "failed" && this.reason !== "noAmmo") {
        this.status = "running";
        this.reason = "";
        this.awayMode = true;
        this.next(0);
      }
      return;
    }
    this.awayMode = true;
    if (!this.awayPoint) this.awayPoint = this.awayFrom(ctx, p);
    const pt = this.awayPoint;
    this.throwFlow(ctx, p, slot, out, () => pt, { maxRange: 40, stay: true });
  }

  /** A point 22 m away from the camp and the teammates (where a puffer can blow up harmlessly). */
  private awayFrom(ctx: MotorCtx, p: PlayerState): Point {
    const site = this.site(ctx, p);
    let ax = p.x - site.campfire.x;
    let az = p.z - site.campfire.z;
    ctx.state.players.forEach((o) => {
      if (o.id === p.id || !o.alive) return;
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const d2 = dx * dx + dz * dz + 1;
      ax += (dx / d2) * 30;
      az += (dz / d2) * 30;
    });
    const l = Math.hypot(ax, az) || 1;
    const x = p.x + (ax / l) * 22;
    const z = p.z + (az / l) * 22;
    return { x, y: Math.max(WATER_Y, heightAt(ctx.island.grid, x, z)) + 0.3, z };
  }

  private burn(ctx: MotorCtx, p: PlayerState, slot: number, out: MotorFrame): void {
    const fire = this.site(ctx, p).campfire;
    const pt = { x: fire.x, y: heightAt(ctx.island.grid, fire.x, fire.z) + 0.25, z: fire.z };
    if (this.stage === 0 && dist(p, fire) > 4.5) {
      if (!this.walk(ctx, p, fire.x, fire.z, 3.2, out, false)) this.timeout(WALK_TIMEOUT, "unreachable");
      return;
    }
    this.throwFlow(ctx, p, slot, out, () => pt, { maxRange: 6, stay: true, charge: 1 / CHARGE_FULL_TICKS });
  }

  /** Q toss toward a point (pass to a teammate, plant a torch): walk within `range`, face, DROP once. */
  private tossFlow(ctx: MotorCtx, p: PlayerState, slot: number, out: MotorFrame, at: Point, range: number, yawPitch: (() => { yaw: number; pitch: number }) | null): void {
    const kind = slotKind(p, slot);
    if (kind === "") {
      if (this.stage >= 2) this.finish();
      else this.fail("noItem");
      return;
    }
    if (this.stage === 0) {
      if (this.walk(ctx, p, at.x, at.z, range, out, true)) this.next(1);
      else this.timeout(WALK_TIMEOUT, "unreachable");
      return;
    }
    const look = yawPitch ? yawPitch() : { yaw: yawFromDir(at.x - p.x, at.z - p.z), pitch: -0.5 };
    const selected = this.select(p, slot, out);
    const faced = this.face(p, look.yaw, look.pitch, out);
    if (this.stage === 1) {
      if (selected && faced && this.faced(p, look.yaw) && p.throwTicks === 0 && p.chargeTicks === 0) {
        out.buttons |= BTN.DROP;
        this.presses = countOf(p, kind as ItemKind);
        this.next(2);
      } else this.timeout(ACT_TIMEOUT, "aim");
      return;
    }
    if (countOf(p, kind as ItemKind) < this.presses) this.finish();
    else if (this.stageTicks > 8) this.fail("refused"); // the server didn't take it (no room to plant, …)
  }

  private pass(ctx: MotorCtx, p: PlayerState, id: string, slot: number, out: MotorFrame): void {
    const m = ctx.state.players.get(id);
    if (!m || !m.alive || m.downed) {
      this.fail("gone");
      return;
    }
    const kind = slotKind(p, slot);
    const at = { x: m.x, y: m.y + 0.2, z: m.z };
    this.tossFlow(ctx, p, slot, out, at, 3.5, () => {
      const aim = kind === "" ? null : aimFromPlayer(p, at, null, kind, 0, () => ctx.rng(), { toss: true });
      return aim ?? { yaw: yawFromDir(at.x - p.x, at.z - p.z), pitch: -0.3 };
    });
  }

  private plantTorch(ctx: MotorCtx, p: PlayerState, slot: number, out: MotorFrame): void {
    // The world plants PLACE_DISTANCE in front of the player and keeps placeables RAFT_KEEP_OUT (2.2 m) off
    // the raft slip: stand TORCH_STAND from the raft on the land side so the torch lands ~2.4 m inland of it.
    const { center } = this.raftTarget(ctx, p);
    const site = this.site(ctx, p);
    const dx = site.campfire.x - center.x;
    const dz = site.campfire.z - center.z;
    const l = Math.hypot(dx, dz) || 1;
    const stand = { x: center.x + (dx / l) * TORCH_STAND, y: center.y, z: center.z + (dz / l) * TORCH_STAND };
    if (this.stage === 0) {
      if (this.walk(ctx, p, stand.x, stand.z, 0.7, out, true)) this.next(1);
      else this.timeout(WALK_TIMEOUT, "unreachable");
      return;
    }
    this.tossFlow(ctx, p, slot, out, stand, 0.7, () => ({ yaw: yawFromDir(center.x - p.x, center.z - p.z), pitch: -0.9 }));
  }
}
