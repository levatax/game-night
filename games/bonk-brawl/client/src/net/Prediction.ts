// Own-player client-side prediction + server reconciliation. Owner: client-net.

import {
  DT,
  MAX_PENDING_INPUTS,
  PREDICTION_KNOCK_SMOOTH_MS,
  PREDICTION_KNOCK_SNAP_DIST,
  PREDICTION_SMOOTH_MS,
  PREDICTION_SNAP_DIST,
} from "../../../shared/constants";
import type { InputCmd } from "../../../shared/protocol";
import type { SimContext } from "../../../shared/sim/context";
import { lerp } from "../../../shared/sim/math";
import {
  copyPlayerSim,
  createPlayerSim,
  emptyStepResult,
  stepPlayer,
  stepPlayerInto,
  type PlayerSim,
  type StepPlayerResult,
} from "../../../shared/sim/player";
import type { PlayerSimFields, PlayerView } from "../../../shared/types";

const SMOOTH_TAU_SEC = PREDICTION_SMOOTH_MS / 1000;
const KNOCK_SMOOTH_TAU_SEC = PREDICTION_KNOCK_SMOOTH_MS / 1000;

/** An input the server has not acknowledged yet, plus the lock it was predicted with. */
interface PendingInput {
  cmd: InputCmd;
  locked: boolean;
}

/**
 * Algorithm (TECH_BRIEF §3):
 * - predict(cmd): push cmd to `pending` (cap MAX_PENDING_INPUTS, drop oldest), prev = copy(current),
 *   stepPlayer(current, cmd, ctx); return that result (the FIRST prediction of this seq — the only
 *   one whose one-shots trigger feedback).
 * - reconcile(server): when server.lastSeq changed (or every patch): base = copyPlayerSim(server);
 *   drop pending with seq <= server.lastSeq; replay the rest with stepPlayer (results ignored);
 *   error = old current position - replayed position; if |error| > PREDICTION_SNAP_DIST snap
 *   (offset = 0), else offset += error. current = replayed. If the server says !alive, stop.
 * - render: lerp(prev, current, alpha) for position + offset; offset decays as
 *   offset *= exp(-dt / tau) each frame. Discrete fields from current.
 * - knockback onset (server.stunTicks > 0 while the pre-reconcile prediction had stunTicks 0):
 *   the knockback only reaches the victim through reconciliation, so at launch speeds the error
 *   easily exceeds PREDICTION_SNAP_DIST. Then errors up to PREDICTION_KNOCK_SNAP_DIST blend
 *   (instead of teleporting) and the offset decays faster: tau = PREDICTION_KNOCK_SMOOTH_MS until
 *   the offset is gone, else PREDICTION_SMOOTH_MS.
 *
 * Input lock on replay: each pending input remembers the `ctx.locked` it was predicted with, and
 * is replayed with `reconcileCtx.locked && thatLock`. Net predicts the countdown → playing
 * transition from the server clock (an input that will reach the server after "go" is predicted
 * unlocked), so a replay during countdown keeps that decision, and once the server reports
 * `playing` every pending input replays unlocked (the server consumes them after that tick).
 */
export class Prediction {
  /** Latest predicted state (HUD reads timers/charge/heldCount from here). */
  readonly current: PlayerSim = createPlayerSim();

  /** Position of the predicted tick before `current` (render interpolation). */
  private readonly prev = { x: 0, y: 0, z: 0 };
  /** Visual error offset (old prediction − corrected prediction), decaying to 0. */
  private readonly offset = { x: 0, y: 0, z: 0 };
  private readonly pending: PendingInput[] = [];
  private readonly replayResult = emptyStepResult();
  /** Reused replay context (a per-input copy of the reconcile context with its own lock). */
  private replayCtx: SimContext | null = null;
  private activeFlag = false;
  /** Current offset decay time constant (seconds): faster right after a knockback onset. */
  private smoothTau = SMOOTH_TAU_SEC;

  /** True between reset() and stop(). */
  get active(): boolean {
    return this.activeFlag;
  }

  /** Start predicting from authoritative state: clears pending inputs and the smoothing offset. */
  reset(server: PlayerView): void {
    copyPlayerSim(server, this.current);
    this.setPrevFromCurrent();
    this.pending.length = 0;
    this.clearOffset();
    this.activeFlag = true;
  }

  stop(): void {
    this.activeFlag = false;
    this.pending.length = 0;
    this.clearOffset();
  }

  /** Predict one tick for a freshly sampled input. */
  predict(cmd: InputCmd, ctx: SimContext): StepPlayerResult {
    if (!this.activeFlag) return emptyStepResult();
    this.pending.push({ cmd: { ...cmd }, locked: ctx.locked });
    if (this.pending.length > MAX_PENDING_INPUTS) this.pending.shift();
    this.setPrevFromCurrent();
    return stepPlayer(this.current, cmd, ctx);
  }

  /** Reconcile against the server's copy of the local player (call on every state patch). */
  reconcile(server: PlayerView, ctx: SimContext): void {
    if (!this.activeFlag) return;
    if (!server.alive) {
      this.stop();
      return;
    }
    const oldX = this.current.x;
    const oldY = this.current.y;
    const oldZ = this.current.z;
    const oldStun = this.current.stunTicks;

    copyPlayerSim(server, this.current);
    this.dropAcknowledged(server.lastSeq);
    this.replay(ctx);
    // A knockback the prediction never saw: a fresh stun, or a re-launch of an already stunned body
    // (stun only counts down in prediction, so a replayed stun above the old one is a new server launch).
    const knockOnset = server.stunTicks > 0 && (oldStun === 0 || this.current.stunTicks > oldStun);
    this.absorbError(oldX - this.current.x, oldY - this.current.y, oldZ - this.current.z, knockOnset);
  }

  /**
   * Fill `out` with the render state: positions lerped between the previous and current predicted
   * tick by `alpha` (0..1, fraction of the fixed step accumulated) plus the decaying smoothing
   * offset; every other field from `current`. `dtSec` advances the offset decay.
   */
  getRenderSim(alpha: number, dtSec: number, out: PlayerSimFields): PlayerSimFields {
    this.decayOffset(dtSec);
    const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const cur = this.current;
    copyPlayerSim(cur, out);
    out.x = lerp(this.prev.x, cur.x, t) + this.offset.x;
    out.y = lerp(this.prev.y, cur.y, t) + this.offset.y;
    out.z = lerp(this.prev.z, cur.z, t) + this.offset.z;
    return out;
  }

  /** Inputs not yet acknowledged by the server. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Current visual smoothing offset (read-only view, for tests and debugging). */
  get smoothingOffset(): Readonly<{ x: number; y: number; z: number }> {
    return this.offset;
  }

  private dropAcknowledged(lastSeq: number): void {
    let acked = 0;
    while (acked < this.pending.length && this.pending[acked].cmd.seq <= lastSeq) acked++;
    if (acked > 0) this.pending.splice(0, acked);
  }

  /** Re-run every pending input on top of the server state; `prev` ends one tick before `current`. */
  private replay(ctx: SimContext): void {
    const cur = this.current;
    if (this.pending.length === 0) {
      // No unacked input: the tick before the server's is unknown, extrapolate it backwards.
      this.prev.x = cur.x - cur.vx * DT;
      this.prev.y = cur.y - cur.vy * DT;
      this.prev.z = cur.z - cur.vz * DT;
      return;
    }
    const rc = (this.replayCtx ??= { ...ctx });
    rc.arena = ctx.arena;
    rc.rings = ctx.rings;
    rc.character = ctx.character;
    rc.dt = ctx.dt;
    for (const input of this.pending) {
      rc.locked = ctx.locked && input.locked;
      this.setPrevFromCurrent();
      stepPlayerInto(cur, input.cmd, rc, this.replayResult);
    }
  }

  private absorbError(ex: number, ey: number, ez: number, knockOnset: boolean): void {
    const o = this.offset;
    if (knockOnset) this.smoothTau = KNOCK_SMOOTH_TAU_SEC;
    const snap = knockOnset ? PREDICTION_KNOCK_SNAP_DIST : PREDICTION_SNAP_DIST;
    if (ex * ex + ey * ey + ez * ez > snap * snap) {
      this.clearOffset();
      return;
    }
    o.x += ex;
    o.y += ey;
    o.z += ez;
    // While an onset blend is still decaying, the accumulated offset may stay above the normal snap distance.
    const limit = this.smoothTau === KNOCK_SMOOTH_TAU_SEC ? PREDICTION_KNOCK_SNAP_DIST : PREDICTION_SNAP_DIST;
    if (o.x * o.x + o.y * o.y + o.z * o.z > limit * limit) this.clearOffset();
  }

  private decayOffset(dtSec: number): void {
    if (!(dtSec > 0)) return;
    const k = Math.exp(-dtSec / this.smoothTau);
    const o = this.offset;
    o.x *= k;
    o.y *= k;
    o.z *= k;
    if (Math.abs(o.x) + Math.abs(o.y) + Math.abs(o.z) < 1e-5) this.clearOffset();
  }

  private setPrevFromCurrent(): void {
    this.prev.x = this.current.x;
    this.prev.y = this.current.y;
    this.prev.z = this.current.z;
  }

  private clearOffset(): void {
    this.offset.x = 0;
    this.offset.y = 0;
    this.offset.z = 0;
    this.smoothTau = SMOOTH_TAU_SEC;
  }
}
