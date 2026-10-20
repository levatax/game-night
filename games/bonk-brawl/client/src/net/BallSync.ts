// Ball dead-reckoning + predicted throws. Owner: client-net.

import {
  BALL_KILL_Y,
  BALL_RADIUS,
  BALL_SMOOTH_MS,
  BALL_SNAP_DIST,
  DT,
  MEGA_BALL_RADIUS,
  PREDICTED_BALL_TIMEOUT_MS,
  TICK_RATE,
} from "../../../shared/constants";
import { copyBallSim, createBallSim, emptyBallResult, stepBallInto, type BallSim } from "../../../shared/sim/ball";
import type { BallContext, FloorQuery } from "../../../shared/sim/context";
import type { Vec3 } from "../../../shared/sim/math";
import type { BallKind, BallView, MapView } from "../../../shared/types";
import type { BallFrame } from "./types";

/**
 * Owner info BallSync needs to dead-reckon curveballs and boomerangs like the server does, built by
 * Net from the RENDERED players (predicted local player, interpolated remotes):
 * aim = aimDirection(yaw, pitch) (BallContext.steer for live curve balls), chest = chestPosition
 * (BallContext.returnTarget for boomerangs), hand = throwOrigin of the rendered player.
 * Returns null for unknown ids; alive = false → steer/returnTarget null (like the server).
 */
export type OwnerResolver = (ownerId: string) => { aim: Vec3; chest: Vec3; hand: Vec3; alive: boolean } | null;

/** Patch fast-forward cap (≈ 200 ms): older patches are simply rendered a little in the past. */
export const MAX_FAST_FORWARD_TICKS = 6;
/** After a stall (background tab) don't burn through a backlog: the next patch re-anchors time. */
const MAX_STEPS_PER_UPDATE = 8;
/** Local ball time further than this from the server clock jumps instead of slewing. */
const TIME_SNAP_TICKS = 3;
/** Fraction of the local-time drift removed at each patch (spreads tiny corrections out). */
const TIME_SLEW_GAIN = 0.25;
/** A server throw this young (ticks) by someone else starts at the thrower's rendered hand. */
const REMOTE_THROW_MAX_AGE_TICKS = 10;
const REMOTE_THROW_MAX_OFFSET = 10;
/** A server ball older than this can't be the one our pending prediction stands for. */
const PREDICTED_MATCH_MAX_AGE_TICKS = 45;
/** Predicted → server takeovers blend out offsets up to this size (RTT puts the server ball behind). */
const TAKEOVER_MAX_OFFSET = 8;
const PREDICTED_FADE_MS = 200;
const SMOOTH_TAU_SEC = BALL_SMOOTH_MS / 1000;
/** Throw starts (hand → true position, predicted → server) blend over 2 × BALL_SMOOTH_MS. */
const THROW_SMOOTH_TAU_SEC = 2 * SMOOTH_TAU_SEC;
/** Balls this far below the kill plane are gone from the server; stop simulating them. */
const STOP_SIM_Y = BALL_KILL_Y - 10;
const OFFSET_EPS = 1e-4;

interface XYZ {
  x: number;
  y: number;
  z: number;
}

interface TrackedBall {
  id: string;
  /** Simulation state at `BallSync.simTick` (held balls: the server's pinned position). */
  sim: BallSim;
  /** Position one tick before `sim` (render interpolation). */
  prev: XYZ;
  /** Visual offset added to the interpolated position, decaying with `tau`. */
  offset: XYZ;
  tau: number;
  ownerId: string;
  holderId: string;
  charge: number;
  throwSeq: number;
  throwIndex: number;
  predicted: boolean;
  /** Predicted balls: real time since spawn (timeout / fade). */
  ageMs: number;
  opacity: number;
  bounced: boolean;
  bounceSpeed: number;
  /** Highest `sim.bounces` already reported (patch fast-forwards never report a bounce twice). */
  reportedBounces: number;
  /** onServerState() pass that last saw this server ball. */
  stamp: number;
  frame: BallFrame;
}

/**
 * Algorithm (TECH_BRIEF §3):
 * - Every tracked ball keeps a local BallSim stepped with the shared stepBall in fixed DT
 *   substeps of real time (accumulator), so motion between 20 Hz patches is smooth & ballistic.
 *   BallContext per step: { arena, rings, dt: DT, steer, returnTarget } from `owners` (never pass
 *   returnTarget = null for a returning boomerang whose owner is alive, or it turns dead locally).
 * - onServerState(): for each server ball, take its fields at patchTick and fast-forward a copy by
 *   k = clamp(round(serverTickNow - patchTick), 0, 6) stepBall ticks → target. New ball → start at
 *   target. Known ball → offset = local - target (snap if > BALL_SNAP_DIST); local = target; the
 *   render position adds the offset decaying with BALL_SMOOTH_MS. Held balls are not simulated.
 *   Balls missing from state are removed.
 * - Remote throws: a NEW live ball (ageTicks <= 10) owned by someone other than the local player
 *   starts with offset = owners(ownerId).hand - target (no snap limit up to 10 m), so it visibly
 *   leaves the thrower's rendered hand (remote players are drawn ~RTT/2 + 100 ms in the past)
 *   and catches up to its true position over 2 × BALL_SMOOTH_MS.
 * - Predicted throws: addPredictedThrow creates balls with id "pred:<seq>:<index>" simulated the
 *   same way: index 0 gets `kind`, indices 1/2 kind "bonus"; all share charge/curve. When a server
 *   ball with ownerId === local id, throwSeq === seq and the same throwIndex appears, it takes over:
 *   offset = predicted pos - server target (blends out), predicted removed.
 *   Unmatched after PREDICTED_BALL_TIMEOUT_MS → fade out (opacity) and remove.
 * - Bounces reported by stepBall set BallFrame.bounced/bounceSpeed until the next getFrames().
 *
 * Time model: every simulated ball sits at the same integer server tick `simTick`; the render
 * time `time` (fractional ticks) lies in [simTick - 1, simTick] and positions are interpolated
 * between `prev` and `sim`. `time` runs on real time and is slewed toward the server clock at
 * each patch, so "now" for the fast-forward and for rendering is the same instant (the offsets
 * are computed in render space and stay continuous).
 */
export class BallSync {
  private readonly balls = new Map<string, TrackedBall>();
  /** Predicted balls by `${ownerId}|${throwSeq}|${throwIndex}`. */
  private readonly predictedByKey = new Map<string, TrackedBall>();
  /** Reused step context (created on the first step, then mutated). */
  private ctx: BallContext | null = null;
  private readonly stepResult = emptyBallResult();
  private readonly frames: BallFrame[] = [];
  private localId = "";
  private time = 0;
  private simTick = 0;
  private anchored = false;
  private stamp = 0;

  /** The local sessionId: its throws are predicted instead of starting at a lagging hand. */
  setLocalId(id: string): void {
    this.localId = id;
  }

  onServerState(
    balls: MapView<BallView>,
    patchTick: number,
    serverTickNow: number,
    q: FloorQuery,
    owners: OwnerResolver,
  ): void {
    this.syncTime(serverTickNow > 0 ? serverTickNow : patchTick, q, owners);
    const stamp = ++this.stamp;
    const alpha = this.alpha();
    balls.forEach((view, id) => this.applyServerBall(id, view, patchTick, alpha, q, owners));
    for (const [id, ball] of this.balls) {
      if (!ball.predicted && ball.stamp !== stamp) this.balls.delete(id);
    }
  }

  addPredictedThrow(
    ownerId: string,
    seq: number,
    origin: Vec3,
    velocities: Vec3[],
    kind: BallKind,
    charge: number,
    curve: boolean,
  ): void {
    velocities.forEach((v, index) => {
      const ballKind: BallKind = index === 0 ? kind : "bonus";
      const ball = this.createBall(`pred:${seq}:${index}`, true);
      const sim = ball.sim;
      sim.x = origin.x;
      sim.y = origin.y;
      sim.z = origin.z;
      sim.vx = v.x;
      sim.vy = v.y;
      sim.vz = v.z;
      sim.state = "live";
      sim.kind = ballKind;
      sim.radius = ballKind === "mega" ? MEGA_BALL_RADIUS : BALL_RADIUS;
      sim.curve = curve;
      setXYZ(ball.prev, origin.x, origin.y, origin.z);
      ball.ownerId = ownerId;
      ball.charge = charge;
      ball.throwSeq = seq;
      ball.throwIndex = index;
      this.balls.set(ball.id, ball);
      this.predictedByKey.set(predictedKey(ownerId, seq, index), ball);
    });
  }

  /** Advance by real frame time (dtSec), smoothing and predicted-ball timeouts. */
  update(dtSec: number, q: FloorQuery, owners: OwnerResolver): void {
    if (!(dtSec > 0)) return;
    this.time += dtSec * TICK_RATE;
    this.advance(q, owners);
    for (const ball of this.balls.values()) {
      decayOffset(ball, dtSec);
      if (ball.predicted) this.agePredicted(ball, dtSec);
    }
  }

  /**
   * Render list. Server balls held by `localId` beyond `localHeldCount` (the predicted count) are
   * omitted, so a just-thrown ball never shows both in hand and in flight. Clears `bounced` flags.
   */
  getFrames(localId: string, localHeldCount: number): BallFrame[] {
    const out = this.frames;
    out.length = 0;
    const alpha = this.alpha();
    let localHeld = 0;
    for (const ball of this.balls.values()) {
      const hidden = ball.sim.state === "held" && ball.holderId === localId && ++localHeld > localHeldCount;
      if (!hidden) out.push(this.fillFrame(ball, alpha));
      ball.bounced = false;
      ball.bounceSpeed = 0;
    }
    return out;
  }

  clear(): void {
    this.balls.clear();
    this.predictedByKey.clear();
    this.frames.length = 0;
    this.time = 0;
    this.simTick = 0;
    this.anchored = false;
  }

  /** Tracked balls (server + predicted). */
  get size(): number {
    return this.balls.size;
  }

  /* ================================================================ time */

  /** Interpolation factor between `prev` (simTick - 1) and `sim` (simTick). */
  private alpha(): number {
    const a = this.time - (this.simTick - 1);
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  /** Pull local ball time toward the server's present (jump when far off). */
  private syncTime(nowTick: number, q: FloorQuery, owners: OwnerResolver): void {
    if (!this.anchored) {
      this.anchored = true;
      this.time = nowTick;
      this.simTick = Math.ceil(nowTick);
      return;
    }
    const drift = nowTick - this.time;
    if (Math.abs(drift) <= TIME_SNAP_TICKS) {
      this.time += drift * TIME_SLEW_GAIN;
      this.advance(q, owners);
      return;
    }
    // Server balls are rebuilt from this patch; only predicted ones need moving to the new tick.
    const target = Math.ceil(nowTick);
    const steps = clampInt(target - this.simTick, 0, MAX_FAST_FORWARD_TICKS);
    for (const ball of this.balls.values()) {
      if (!ball.predicted) continue;
      for (let i = 0; i < steps; i++) this.stepBall(ball, q, owners);
    }
    this.time = nowTick;
    this.simTick = target;
  }

  /** Step every simulated ball until the sims are at or just ahead of the render time. */
  private advance(q: FloorQuery, owners: OwnerResolver): void {
    let steps = 0;
    while (this.time > this.simTick) {
      if (steps >= MAX_STEPS_PER_UPDATE) {
        this.time = this.simTick;
        break;
      }
      for (const ball of this.balls.values()) this.stepBall(ball, q, owners);
      this.simTick++;
      steps++;
    }
  }

  /* ========================================================= server balls */

  private applyServerBall(
    id: string,
    view: BallView,
    patchTick: number,
    alpha: number,
    q: FloorQuery,
    owners: OwnerResolver,
  ): void {
    const known = this.balls.get(id);
    const ball = known ?? this.createBall(id, false);
    const fresh = !known || known.sim.state === "held";
    const oldX = renderCoord(ball.prev.x, ball.sim.x, ball.offset.x, alpha);
    const oldY = renderCoord(ball.prev.y, ball.sim.y, ball.offset.y, alpha);
    const oldZ = renderCoord(ball.prev.z, ball.sim.z, ball.offset.z, alpha);

    ball.stamp = this.stamp;
    ball.ownerId = view.ownerId;
    ball.holderId = view.holderId;
    ball.charge = view.charge;
    ball.throwSeq = view.throwSeq;
    ball.throwIndex = view.throwIndex;
    copyBallSim(view, ball.sim);
    if (!known) {
      this.balls.set(id, ball);
      ball.reportedBounces = view.bounces;
    }

    if (view.state === "held") {
      setXYZ(ball.prev, view.x, view.y, view.z);
      setXYZ(ball.offset, 0, 0, 0);
      ball.reportedBounces = 0;
      return;
    }

    // Take over a predicted throw before fast-forwarding, so a bounce it already showed isn't replayed.
    const predicted = this.takePredicted(view);
    let px = 0;
    let py = 0;
    let pz = 0;
    if (predicted) {
      px = renderCoord(predicted.prev.x, predicted.sim.x, predicted.offset.x, alpha);
      py = renderCoord(predicted.prev.y, predicted.sim.y, predicted.offset.y, alpha);
      pz = renderCoord(predicted.prev.z, predicted.sim.z, predicted.offset.z, alpha);
      ball.reportedBounces = Math.max(ball.reportedBounces, predicted.reportedBounces);
      if (predicted.bounced) markBounce(ball, predicted.bounceSpeed);
    }

    this.fastForward(ball, clampInt(this.simTick - patchTick, 0, MAX_FAST_FORWARD_TICKS), q, owners);
    const baseX = renderCoord(ball.prev.x, ball.sim.x, 0, alpha);
    const baseY = renderCoord(ball.prev.y, ball.sim.y, 0, alpha);
    const baseZ = renderCoord(ball.prev.z, ball.sim.z, 0, alpha);

    if (predicted) {
      setOffset(ball, px - baseX, py - baseY, pz - baseZ, TAKEOVER_MAX_OFFSET, THROW_SMOOTH_TAU_SEC);
    } else if (!fresh) {
      setOffset(ball, oldX - baseX, oldY - baseY, oldZ - baseZ, BALL_SNAP_DIST, ball.tau);
    } else if (this.isRemoteThrow(view)) {
      const hand = owners(view.ownerId)?.hand;
      if (hand) setOffset(ball, hand.x - baseX, hand.y - baseY, hand.z - baseZ, REMOTE_THROW_MAX_OFFSET, THROW_SMOOTH_TAU_SEC);
      else setXYZ(ball.offset, 0, 0, 0);
    } else {
      setXYZ(ball.offset, 0, 0, 0);
    }
  }

  /** Re-simulate the server's snapshot up to `simTick`; `prev` ends one tick before. */
  private fastForward(ball: TrackedBall, ticks: number, q: FloorQuery, owners: OwnerResolver): void {
    if (ticks === 0) {
      const s = ball.sim;
      setXYZ(ball.prev, s.x - s.vx * DT, s.y - s.vy * DT, s.z - s.vz * DT);
      return;
    }
    for (let i = 0; i < ticks; i++) this.stepBall(ball, q, owners);
  }

  private isRemoteThrow(view: BallView): boolean {
    return (
      (view.state === "live" || view.state === "dead") &&
      view.ownerId !== "" &&
      view.ownerId !== this.localId &&
      view.ageTicks <= REMOTE_THROW_MAX_AGE_TICKS
    );
  }

  /** The predicted ball this server ball stands for (removed from tracking), or null. */
  private takePredicted(view: BallView): TrackedBall | null {
    if (view.state !== "live" && view.state !== "dead") return null;
    if (!view.ownerId || view.throwSeq <= 0 || view.ageTicks > PREDICTED_MATCH_MAX_AGE_TICKS) return null;
    const key = predictedKey(view.ownerId, view.throwSeq, view.throwIndex);
    const predicted = this.predictedByKey.get(key);
    if (!predicted) return null;
    this.predictedByKey.delete(key);
    this.balls.delete(predicted.id);
    return predicted;
  }

  /* ========================================================== simulation */

  private stepBall(ball: TrackedBall, q: FloorQuery, owners: OwnerResolver): void {
    const sim = ball.sim;
    if (sim.state === "held" || sim.y < STOP_SIM_Y) return;
    setXYZ(ball.prev, sim.x, sim.y, sim.z);
    const ctx = (this.ctx ??= { arena: q.arena, rings: q.rings, dt: DT, steer: null, returnTarget: null });
    ctx.arena = q.arena;
    ctx.rings = q.rings;
    const thrown = sim.state === "live" || sim.state === "dead";
    const owner = thrown && ball.ownerId ? owners(ball.ownerId) : null;
    const alive = owner !== null && owner.alive;
    ctx.steer = alive && sim.curve && sim.state === "live" ? owner.aim : null;
    ctx.returnTarget = alive ? owner.chest : null;
    const result = stepBallInto(sim, ctx, this.stepResult);
    if (result.bounced && sim.bounces > ball.reportedBounces) {
      ball.reportedBounces = sim.bounces;
      markBounce(ball, result.impactSpeed);
    }
  }

  private agePredicted(ball: TrackedBall, dtSec: number): void {
    ball.ageMs += dtSec * 1000;
    const over = ball.ageMs - PREDICTED_BALL_TIMEOUT_MS;
    if (over > 0) ball.opacity = Math.max(0, 1 - over / PREDICTED_FADE_MS);
    if (ball.opacity <= 0 || ball.sim.y < BALL_KILL_Y) this.removePredicted(ball);
  }

  private removePredicted(ball: TrackedBall): void {
    this.balls.delete(ball.id);
    this.predictedByKey.delete(predictedKey(ball.ownerId, ball.throwSeq, ball.throwIndex));
  }

  /* ============================================================== output */

  private createBall(id: string, predicted: boolean): TrackedBall {
    return {
      id,
      sim: createBallSim(),
      prev: { x: 0, y: 0, z: 0 },
      offset: { x: 0, y: 0, z: 0 },
      tau: SMOOTH_TAU_SEC,
      ownerId: "",
      holderId: "",
      charge: 0,
      throwSeq: 0,
      throwIndex: 0,
      predicted,
      ageMs: 0,
      opacity: 1,
      bounced: false,
      bounceSpeed: 0,
      reportedBounces: 0,
      stamp: this.stamp,
      frame: emptyFrame(id, predicted),
    };
  }

  private fillFrame(ball: TrackedBall, alpha: number): BallFrame {
    const f = ball.frame;
    const s = ball.sim;
    const held = s.state === "held";
    f.x = held ? s.x : renderCoord(ball.prev.x, s.x, ball.offset.x, alpha);
    f.y = held ? s.y : renderCoord(ball.prev.y, s.y, ball.offset.y, alpha);
    f.z = held ? s.z : renderCoord(ball.prev.z, s.z, ball.offset.z, alpha);
    f.vx = s.vx;
    f.vy = s.vy;
    f.vz = s.vz;
    f.state = s.state;
    f.kind = s.kind;
    f.radius = s.radius;
    f.ownerId = ball.ownerId;
    f.holderId = ball.holderId;
    f.charge = ball.charge;
    f.curve = s.curve;
    f.returning = s.returning;
    f.bounced = ball.bounced;
    f.bounceSpeed = ball.bounceSpeed;
    f.opacity = ball.opacity;
    return f;
  }
}

function predictedKey(ownerId: string, seq: number, index: number): string {
  return `${ownerId}|${seq}|${index}`;
}

function emptyFrame(id: string, predicted: boolean): BallFrame {
  return {
    id,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    state: "neutral",
    kind: "normal",
    radius: BALL_RADIUS,
    ownerId: "",
    holderId: "",
    charge: 0,
    curve: false,
    returning: false,
    predicted,
    bounced: false,
    bounceSpeed: 0,
    opacity: 1,
  };
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
function setOffset(ball: TrackedBall, x: number, y: number, z: number, maxLength: number, tau: number): void {
  if (x * x + y * y + z * z > maxLength * maxLength) {
    setXYZ(ball.offset, 0, 0, 0);
    ball.tau = SMOOTH_TAU_SEC;
    return;
  }
  setXYZ(ball.offset, x, y, z);
  ball.tau = tau;
}

function decayOffset(ball: TrackedBall, dtSec: number): void {
  const o = ball.offset;
  if (o.x === 0 && o.y === 0 && o.z === 0) return;
  const k = Math.exp(-dtSec / ball.tau);
  o.x *= k;
  o.y *= k;
  o.z *= k;
  if (Math.abs(o.x) + Math.abs(o.y) + Math.abs(o.z) < OFFSET_EPS) {
    setXYZ(o, 0, 0, 0);
    ball.tau = SMOOTH_TAU_SEC;
  }
}

function markBounce(ball: TrackedBall, speed: number): void {
  ball.bounced = true;
  ball.bounceSpeed = Math.max(ball.bounceSpeed, speed);
}

function clampInt(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
