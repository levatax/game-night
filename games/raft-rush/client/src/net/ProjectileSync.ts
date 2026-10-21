// Projectile dead-reckoning + predicted own throws. Owner: client-net.
// Adapted from games/bonk-brawl/client/src/net/BallSync.ts: no held balls / curve / boomerang; the shared
// stepProjectile runs against the island terrain + cover; own throws are matched by ownerId + throwSeq + index
// (the index comes from ThrowEvent.projectileIds, which is aligned with ThrowEvent.velocities).

import { DT, PREDICTED_PROJECTILE_TIMEOUT_MS, PROJECTILE_SMOOTH_MS, PROJECTILE_SNAP_DIST, TICK_RATE } from "../../../shared/constants";
import { ITEMS } from "../../../shared/items";
import type { ThrowEvent } from "../../../shared/protocol";
import type { ProjectileContext, WorldQuery } from "../../../shared/sim/context";
import type { Vec3 } from "../../../shared/sim/math";
import {
  copyProjectileSim,
  createProjectileSim,
  emptyProjectileResult,
  stepProjectileInto,
  type ProjectileSim,
} from "../../../shared/sim/projectile";
import type { ItemKind, MapView, ProjectileView } from "../../../shared/types";
import type { ProjectileFrame } from "./types";

/**
 * Where a thrower's hand is drawn this frame (throwOrigin of the RENDERED player: interpolated remotes are
 * ~RTT/2 + INTERP_DELAY_MS in the past). Null for unknown ids. The returned vector is read immediately.
 */
export type HandResolver = (ownerId: string) => Vec3 | null;

/** Patch fast-forward cap (≈ 200 ms): older patches are simply rendered a little in the past. */
export const MAX_FAST_FORWARD_TICKS = 6;
/** After a stall (background tab) don't burn through a backlog: the next patch re-anchors time. */
const MAX_STEPS_PER_UPDATE = 8;
/** Local projectile time further than this from the server clock jumps instead of slewing. */
const TIME_SNAP_TICKS = 3;
/** Fraction of the local-time drift removed at each patch (spreads tiny corrections out). */
const TIME_SLEW_GAIN = 0.25;
/** A server throw this young (ticks) by someone else starts at the thrower's rendered hand. */
const REMOTE_THROW_MAX_AGE_TICKS = 10;
const REMOTE_THROW_MAX_OFFSET = 10;
/** A server projectile older than this can't be the one our pending prediction stands for. */
const PREDICTED_MATCH_MAX_AGE_TICKS = 45;
/** A server throw whose seq is this close to a prediction's (and of the same kind) is that prediction. */
const PREDICTED_SEQ_SLACK = 3;
/** Predicted → server takeovers blend out offsets up to this size (RTT puts the server projectile behind). */
const TAKEOVER_MAX_OFFSET = 8;
const PREDICTED_FADE_MS = 200;
const SMOOTH_TAU_SEC = PROJECTILE_SMOOTH_MS / 1000;
/** Throw starts (hand → true position, predicted → server) blend over 2 × PROJECTILE_SMOOTH_MS. */
const THROW_SMOOTH_TAU_SEC = 2 * SMOOTH_TAU_SEC;
/** Throw events remembered for index matching (older ones are dropped). */
const MAX_REMEMBERED_THROWS = 64;
const OFFSET_EPS = 1e-4;

interface XYZ {
  x: number;
  y: number;
  z: number;
}

interface TrackedProjectile {
  id: string;
  /** Simulation state at `ProjectileSync.simTick` (rest / stuck: the server's position, not simulated). */
  sim: ProjectileSim;
  /** Position one tick before `sim` (render interpolation). */
  prev: XYZ;
  /** Visual offset added to the interpolated position, decaying with `tau`. */
  offset: XYZ;
  tau: number;
  ownerId: string;
  charge: number;
  throwSeq: number;
  /** Index inside its throw (coconut ball: 0..2), -1 when unknown. */
  throwIndex: number;
  baitTicks: number;
  predicted: boolean;
  /** Predicted: release velocity (fallback matching when no ThrowEvent names the index). */
  launchVx: number;
  launchVz: number;
  /** Predicted projectiles: real time since spawn (timeout / fade). */
  ageMs: number;
  opacity: number;
  /** Sank locally: hidden until the server removes it (or, predicted, until it is matched / times out). */
  sunk: boolean;
  bounced: boolean;
  bounceSpeed: number;
  /** Highest ageTicks already checked for bounces (patch fast-forwards never report one twice). */
  reportedAge: number;
  /** onServerState() pass that last saw this server projectile. */
  stamp: number;
  frame: ProjectileFrame;
}

/**
 * Algorithm (Bonk TECH_BRIEF §3, game4.md §19):
 * - Every tracked projectile keeps a local ProjectileSim stepped with the shared stepProjectile in fixed DT
 *   substeps of real time (accumulator), so flight between 20 Hz patches is smooth & ballistic, with the same
 *   terrain / cover / water rules as the server.
 * - onServerState(): for each server projectile, take its fields at patchTick and fast-forward a copy by
 *   k = clamp(simTick − patchTick, 0, 6) steps → target. New projectile → start at target. Known projectile →
 *   offset = local render − target (snap if > PROJECTILE_SNAP_DIST); the render position adds the offset decaying
 *   with PROJECTILE_SMOOTH_MS. `rest` / `stuck` projectiles are not simulated: they render at their server
 *   position (plus the decaying offset left by the move into rest). Projectiles missing from state are removed.
 * - Remote throws: a NEW live projectile (ageTicks ≤ 10) owned by someone other than the local player starts with
 *   offset = hands(ownerId) − target (up to 10 m), so it visibly leaves the thrower's rendered hand and catches up
 *   to its true position over 2 × PROJECTILE_SMOOTH_MS.
 * - Predicted throws: addPredictedThrow() creates projectiles "pred:<seq>:<index>" simulated the same way (a
 *   coconut ball predicts COCONUT_BALL_COUNT coconuts). A server projectile with ownerId === local id and
 *   throwSeq === seq takes over the predicted one with the same index (ThrowEvent.projectileIds[index] === id;
 *   without the event: the closest launch direction; a release the server stepped a tick or two apart: the
 *   nearest seq within PREDICTED_SEQ_SLACK): offset = predicted pos − server target (blends out), predicted
 *   removed. Unmatched after PREDICTED_PROJECTILE_TIMEOUT_MS → fade out (opacity) and remove.
 * - Bounces reported by stepProjectile set ProjectileFrame.bounced / bounceSpeed until the next getFrames(); each
 *   tick of a projectile's life (ageTicks) is reported at most once, so a replayed fast-forward stays quiet.
 *
 * Time model: every simulated projectile sits at the same integer server tick `simTick`; the render time `time`
 * (fractional ticks) lies in [simTick − 1, simTick] and positions are interpolated between `prev` and `sim`.
 * `time` runs on real time and is slewed toward the server clock at each patch, so "now" for the fast-forward and
 * for rendering is the same instant (offsets are computed in render space and stay continuous).
 */
export class ProjectileSync {
  private readonly tracked = new Map<string, TrackedProjectile>();
  /** Predicted projectiles by `${ownerId}|${throwSeq}|${index}`. */
  private readonly predictedByKey = new Map<string, TrackedProjectile>();
  /** Server projectile id → index inside its throw, from ThrowEvents (insertion-ordered, capped). */
  private readonly throwIndexById = new Map<string, number>();
  private ctx: ProjectileContext | null = null;
  private readonly stepResult = emptyProjectileResult();
  private readonly frames: ProjectileFrame[] = [];
  private localId = "";
  private time = 0;
  private simTick = 0;
  private anchored = false;
  private stamp = 0;

  /** The local sessionId: its throws are predicted instead of starting at a lagging hand. */
  setLocalId(id: string): void {
    this.localId = id;
  }

  /** Remember which projectile id is which index of a throw (call for every ThrowEvent, before or after the patch). */
  noteThrow(ev: Pick<ThrowEvent, "projectileIds">): void {
    ev.projectileIds.forEach((id, index) => this.throwIndexById.set(id, index));
    while (this.throwIndexById.size > MAX_REMEMBERED_THROWS) {
      const oldest = this.throwIndexById.keys().next().value;
      if (oldest === undefined) break;
      this.throwIndexById.delete(oldest);
    }
  }

  /** Apply a decoded state patch: `patchTick` = state.tick, `serverTickNow` = Clock.serverTickAt(now). */
  onServerState(
    projectiles: MapView<ProjectileView>,
    patchTick: number,
    serverTickNow: number,
    q: WorldQuery,
    hands: HandResolver,
  ): void {
    this.syncTime(serverTickNow > 0 ? serverTickNow : patchTick, q);
    const stamp = ++this.stamp;
    const alpha = this.alpha();
    projectiles.forEach((view, id) => this.applyServerProjectile(id, view, patchTick, alpha, q, hands));
    for (const [id, p] of this.tracked) {
      if (!p.predicted && p.stamp !== stamp) {
        this.tracked.delete(id);
        this.throwIndexById.delete(id);
      }
    }
  }

  /**
   * Spawn the local prediction of a release: one projectile per velocity (computeThrowVelocities order), all of
   * `kind` (pass projectileKindForThrow(kind): a coconut ball releases plain coconuts).
   */
  addPredictedThrow(ownerId: string, seq: number, origin: Vec3, velocities: Vec3[], kind: ItemKind, charge: number): void {
    velocities.forEach((v, index) => {
      const p = this.create(`pred:${seq}:${index}`, true, kind);
      const sim = p.sim;
      sim.x = origin.x;
      sim.y = origin.y;
      sim.z = origin.z;
      sim.vx = v.x;
      sim.vy = v.y;
      sim.vz = v.z;
      sim.state = "live";
      setXYZ(p.prev, origin.x, origin.y, origin.z);
      p.ownerId = ownerId;
      p.charge = charge;
      p.throwSeq = seq;
      p.throwIndex = index;
      p.launchVx = v.x;
      p.launchVz = v.z;
      this.tracked.set(p.id, p);
      this.predictedByKey.set(predictedKey(ownerId, seq, index), p);
    });
  }

  /** Advance by real frame time (dtSec): simulation substeps, smoothing decay and predicted timeouts. */
  update(dtSec: number, q: WorldQuery): void {
    if (!(dtSec > 0)) return;
    this.time += dtSec * TICK_RATE;
    this.advance(q);
    for (const p of this.tracked.values()) {
      decayOffset(p, dtSec);
      if (p.predicted) this.agePredicted(p, dtSec);
    }
  }

  /** Render list (reused objects, valid until the next call). Clears the `bounced` flags. */
  getFrames(): ProjectileFrame[] {
    const out = this.frames;
    out.length = 0;
    const alpha = this.alpha();
    for (const p of this.tracked.values()) {
      if (!p.sunk) out.push(this.fillFrame(p, alpha));
      p.bounced = false;
      p.bounceSpeed = 0;
    }
    return out;
  }

  clear(): void {
    this.tracked.clear();
    this.predictedByKey.clear();
    this.throwIndexById.clear();
    this.frames.length = 0;
    this.time = 0;
    this.simTick = 0;
    this.anchored = false;
  }

  /** Tracked projectiles (server + predicted, sunk included). */
  get size(): number {
    return this.tracked.size;
  }

  /* ================================================================ time */

  /** Interpolation factor between `prev` (simTick − 1) and `sim` (simTick). */
  private alpha(): number {
    const a = this.time - (this.simTick - 1);
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  /** Pull local projectile time toward the server's present (jump when far off). */
  private syncTime(nowTick: number, q: WorldQuery): void {
    if (!this.anchored) {
      this.anchored = true;
      this.time = nowTick;
      this.simTick = Math.ceil(nowTick);
      return;
    }
    const drift = nowTick - this.time;
    if (Math.abs(drift) <= TIME_SNAP_TICKS) {
      this.time += drift * TIME_SLEW_GAIN;
      this.advance(q);
      return;
    }
    // Server projectiles are rebuilt from this patch; only predicted ones need moving to the new tick.
    const target = Math.ceil(nowTick);
    const steps = clampInt(target - this.simTick, 0, MAX_FAST_FORWARD_TICKS);
    for (const p of this.tracked.values()) {
      if (!p.predicted) continue;
      for (let i = 0; i < steps; i++) this.step(p, q);
    }
    this.time = nowTick;
    this.simTick = target;
  }

  /** Step every simulated projectile until the sims are at or just ahead of the render time. */
  private advance(q: WorldQuery): void {
    let steps = 0;
    while (this.time > this.simTick) {
      if (steps >= MAX_STEPS_PER_UPDATE) {
        this.time = this.simTick;
        break;
      }
      for (const p of this.tracked.values()) this.step(p, q);
      this.simTick++;
      steps++;
    }
  }

  /* =================================================== server projectiles */

  private applyServerProjectile(
    id: string,
    view: ProjectileView,
    patchTick: number,
    alpha: number,
    q: WorldQuery,
    hands: HandResolver,
  ): void {
    const known = this.tracked.get(id);
    const p = known ?? this.create(id, false, view.kind);
    const oldX = renderCoord(p.prev.x, p.sim.x, p.offset.x, alpha);
    const oldY = renderCoord(p.prev.y, p.sim.y, p.offset.y, alpha);
    const oldZ = renderCoord(p.prev.z, p.sim.z, p.offset.z, alpha);
    const wasSunk = p.sunk;

    p.stamp = this.stamp;
    p.ownerId = view.ownerId;
    p.charge = view.charge;
    p.throwSeq = view.throwSeq;
    p.baitTicks = view.baitTicks;
    p.throwIndex = this.throwIndexById.get(id) ?? p.throwIndex;
    p.sunk = false;
    copyProjectileSim(view, p.sim);
    if (!known) {
      this.tracked.set(id, p);
      p.reportedAge = view.ageTicks;
    }

    // Take over a predicted throw before fast-forwarding, so a bounce it already showed isn't replayed. Every
    // throw spawns new projectile ids, so only a projectile seen for the first time can stand for a prediction.
    const predicted = known ? null : this.takePredicted(id, view);
    let px = 0;
    let py = 0;
    let pz = 0;
    if (predicted) {
      px = renderCoord(predicted.prev.x, predicted.sim.x, predicted.offset.x, alpha);
      py = renderCoord(predicted.prev.y, predicted.sim.y, predicted.offset.y, alpha);
      pz = renderCoord(predicted.prev.z, predicted.sim.z, predicted.offset.z, alpha);
      p.reportedAge = Math.max(p.reportedAge, predicted.reportedAge);
      if (predicted.bounced) markBounce(p, predicted.bounceSpeed);
      if (predicted.throwIndex >= 0) p.throwIndex = predicted.throwIndex;
    }

    this.fastForward(p, clampInt(this.simTick - patchTick, 0, MAX_FAST_FORWARD_TICKS), q);
    const baseX = renderCoord(p.prev.x, p.sim.x, 0, alpha);
    const baseY = renderCoord(p.prev.y, p.sim.y, 0, alpha);
    const baseZ = renderCoord(p.prev.z, p.sim.z, 0, alpha);

    if (predicted) {
      if (predicted.sunk) setXYZ(p.offset, 0, 0, 0);
      else setOffset(p, px - baseX, py - baseY, pz - baseZ, TAKEOVER_MAX_OFFSET, THROW_SMOOTH_TAU_SEC);
    } else if (known && !wasSunk) {
      setOffset(p, oldX - baseX, oldY - baseY, oldZ - baseZ, PROJECTILE_SNAP_DIST, p.tau);
    } else if (!known && this.isRemoteThrow(view)) {
      const hand = hands(view.ownerId);
      if (hand) setOffset(p, hand.x - baseX, hand.y - baseY, hand.z - baseZ, REMOTE_THROW_MAX_OFFSET, THROW_SMOOTH_TAU_SEC);
      else setXYZ(p.offset, 0, 0, 0);
    } else {
      setXYZ(p.offset, 0, 0, 0);
    }
  }

  /** Re-simulate the server's snapshot up to `simTick`; `prev` ends one tick before (rest / stuck: in place). */
  private fastForward(p: TrackedProjectile, ticks: number, q: WorldQuery): void {
    const s = p.sim;
    if (isStatic(s)) {
      setXYZ(p.prev, s.x, s.y, s.z);
      return;
    }
    if (ticks === 0) {
      setXYZ(p.prev, s.x - s.vx * DT, s.y - s.vy * DT, s.z - s.vz * DT);
      return;
    }
    for (let i = 0; i < ticks; i++) this.step(p, q);
  }

  private isRemoteThrow(view: ProjectileView): boolean {
    return (
      view.state === "live" &&
      view.ownerId !== "" &&
      view.ownerId !== this.localId &&
      view.throwSeq > 0 &&
      view.ageTicks <= REMOTE_THROW_MAX_AGE_TICKS
    );
  }

  /** The predicted projectile this server projectile stands for (removed from tracking), or null. */
  private takePredicted(id: string, view: ProjectileView): TrackedProjectile | null {
    if (!view.ownerId || view.ownerId !== this.localId || view.throwSeq <= 0) return null;
    if (view.ageTicks > PREDICTED_MATCH_MAX_AGE_TICKS) return null;
    const index = this.throwIndexById.get(id);
    const exact = index !== undefined ? this.predictedByKey.get(predictedKey(view.ownerId, view.throwSeq, index)) : undefined;
    const predicted = exact ?? this.closestPredicted(view, index);
    if (!predicted) return null;
    this.predictedByKey.delete(predictedKey(predicted.ownerId, predicted.throwSeq, predicted.throwIndex));
    this.tracked.delete(predicted.id);
    return predicted;
  }

  /**
   * No exact (seq, index) match: the unmatched prediction of the same kind whose seq is closest (within
   * PREDICTED_SEQ_SLACK: the server may release a tick or two apart from the prediction; two throws are always
   * THROW_RECOVER_TICKS apart), with the same index when the ThrowEvent named it, else the closest launch
   * direction (or position, for a projectile that is barely moving).
   */
  private closestPredicted(view: ProjectileView, index: number | undefined): TrackedProjectile | null {
    const vh = Math.hypot(view.vx, view.vz);
    let best: TrackedProjectile | null = null;
    let bestSeqGap = Infinity;
    let bestScore = -Infinity;
    for (const p of this.predictedByKey.values()) {
      if (p.ownerId !== view.ownerId || p.sim.kind !== view.kind) continue;
      const seqGap = Math.abs(p.throwSeq - view.throwSeq);
      if (seqGap > PREDICTED_SEQ_SLACK) continue;
      if (index !== undefined && p.throwIndex !== index) continue;
      let score: number;
      const lh = Math.hypot(p.launchVx, p.launchVz);
      if (vh > 0.5 && lh > 1e-6) {
        score = (view.vx * p.launchVx + view.vz * p.launchVz) / (vh * lh);
      } else {
        const dx = p.sim.x - view.x;
        const dz = p.sim.z - view.z;
        score = -(dx * dx + dz * dz);
      }
      if (seqGap < bestSeqGap || (seqGap === bestSeqGap && score > bestScore)) {
        bestSeqGap = seqGap;
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  /* ========================================================== simulation */

  private step(p: TrackedProjectile, q: WorldQuery): void {
    const sim = p.sim;
    if (p.sunk || isStatic(sim)) {
      setXYZ(p.prev, sim.x, sim.y, sim.z);
      return;
    }
    setXYZ(p.prev, sim.x, sim.y, sim.z);
    const ctx = (this.ctx ??= { terrain: q.terrain, cover: q.cover, bounds: q.bounds, dt: DT });
    ctx.terrain = q.terrain;
    ctx.cover = q.cover;
    ctx.bounds = q.bounds;
    ctx.dt = DT;
    const result = stepProjectileInto(sim, ctx, this.stepResult);
    if (result.sank) {
      p.sunk = true;
      return;
    }
    if (sim.ageTicks > p.reportedAge) {
      p.reportedAge = sim.ageTicks;
      if (result.bounced) markBounce(p, result.bounceSpeed);
    }
  }

  private agePredicted(p: TrackedProjectile, dtSec: number): void {
    p.ageMs += dtSec * 1000;
    const over = p.ageMs - PREDICTED_PROJECTILE_TIMEOUT_MS;
    if (over > 0) p.opacity = Math.max(0, 1 - over / PREDICTED_FADE_MS);
    if (p.opacity <= 0) this.removePredicted(p);
  }

  private removePredicted(p: TrackedProjectile): void {
    this.tracked.delete(p.id);
    this.predictedByKey.delete(predictedKey(p.ownerId, p.throwSeq, p.throwIndex));
  }

  /* ============================================================== output */

  private create(id: string, predicted: boolean, kind: ItemKind): TrackedProjectile {
    return {
      id,
      sim: createProjectileSim(kind),
      prev: { x: 0, y: 0, z: 0 },
      offset: { x: 0, y: 0, z: 0 },
      tau: SMOOTH_TAU_SEC,
      ownerId: "",
      charge: 0,
      throwSeq: 0,
      throwIndex: -1,
      baitTicks: 0,
      predicted,
      launchVx: 0,
      launchVz: 0,
      ageMs: 0,
      opacity: 1,
      sunk: false,
      bounced: false,
      bounceSpeed: 0,
      reportedAge: 0,
      stamp: this.stamp,
      frame: emptyProjectileFrame(id, predicted, kind),
    };
  }

  private fillFrame(p: TrackedProjectile, alpha: number): ProjectileFrame {
    const f = p.frame;
    const s = p.sim;
    f.x = renderCoord(p.prev.x, s.x, p.offset.x, alpha);
    f.y = renderCoord(p.prev.y, s.y, p.offset.y, alpha);
    f.z = renderCoord(p.prev.z, s.z, p.offset.z, alpha);
    f.vx = s.vx;
    f.vy = s.vy;
    f.vz = s.vz;
    f.state = s.state;
    f.kind = s.kind;
    f.radius = s.radius;
    f.ownerId = p.ownerId;
    f.charge = p.charge;
    f.bait = p.baitTicks > 0;
    f.bounced = p.bounced;
    f.bounceSpeed = p.bounceSpeed;
    f.opacity = p.opacity;
    f.age = s.ageTicks / TICK_RATE;
    return f;
  }
}

/** A blank render frame for a projectile id. */
export function emptyProjectileFrame(id: string, predicted: boolean, kind: ItemKind = "coconut"): ProjectileFrame {
  return {
    id,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    state: "live",
    kind,
    radius: ITEMS[kind].radius,
    ownerId: "",
    charge: 0,
    bait: false,
    predicted,
    bounced: false,
    bounceSpeed: 0,
    opacity: 1,
    age: 0,
  };
}

function isStatic(s: ProjectileSim): boolean {
  return s.state === "rest" || s.state === "stuck";
}

function predictedKey(ownerId: string, seq: number, index: number): string {
  return `${ownerId}|${seq}|${index}`;
}

function renderCoord(prev: number, cur: number, offset: number, alpha: number): number {
  return prev + (cur - prev) * alpha + offset;
}

function setXYZ(v: XYZ, x: number, y: number, z: number): void {
  v.x = x;
  v.y = y;
  v.z = z;
}

/** Visual offset to blend out, or none (snap) if it is larger than `maxLength`. */
function setOffset(p: TrackedProjectile, x: number, y: number, z: number, maxLength: number, tau: number): void {
  if (x * x + y * y + z * z > maxLength * maxLength) {
    setXYZ(p.offset, 0, 0, 0);
    p.tau = SMOOTH_TAU_SEC;
    return;
  }
  setXYZ(p.offset, x, y, z);
  p.tau = tau;
}

function decayOffset(p: TrackedProjectile, dtSec: number): void {
  const o = p.offset;
  if (o.x === 0 && o.y === 0 && o.z === 0) return;
  const k = Math.exp(-dtSec / p.tau);
  o.x *= k;
  o.y *= k;
  o.z *= k;
  if (Math.abs(o.x) + Math.abs(o.y) + Math.abs(o.z) < OFFSET_EPS) {
    setXYZ(o, 0, 0, 0);
    p.tau = SMOOTH_TAU_SEC;
  }
}

function markBounce(p: TrackedProjectile, speed: number): void {
  p.bounced = true;
  p.bounceSpeed = Math.max(p.bounceSpeed, speed);
}

function clampInt(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
