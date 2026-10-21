// Own-player client-side prediction + server reconciliation. Owner: client-net.
// Adapted from games/bonk-brawl/client/src/net/Prediction.ts: the algorithm is unchanged, only the SimContext
// differs ({ terrain, cover, bounds, character, dt, locked }, game4.md §19).

import { DT, MAX_PENDING_INPUTS, PREDICTION_SMOOTH_MS, PREDICTION_SNAP_DIST } from "../../../shared/constants";
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
import type { PlayerSimFields } from "../../../shared/types";

const SMOOTH_TAU_SEC = PREDICTION_SMOOTH_MS / 1000;

/** An input the server has not acknowledged yet, plus the lock it was predicted with. */
interface PendingInput {
  cmd: InputCmd;
  locked: boolean;
}

/** The server's copy of the local player: sim fields plus the last consumed input seq (PlayerView satisfies it). */
export type ServerPlayer = PlayerSimFields & { lastSeq: number };

export interface ReconcileOptions {
  /**
   * true (default): a pending input replays with `ctx.locked && <the lock it was predicted with>`. Use it while the
   * lock is about to end on a known tick (the landing wake-up): an input predicted to reach the server after the
   * unlock stays unlocked on replay. false: every pending input replays with `ctx.locked` (launch / storm: the
   * lock never ends, so inputs still in flight will be consumed locked).
   */
  trustPredictedLock?: boolean;
  /**
   * Last input seq the server consumed FROM THIS PAGE, when it differs from server.lastSeq: after a reload the
   * page restarts at seq 1 while the seat's lastSeq still holds the previous page's (or a bot's) value, so Net
   * passes 0 until the server acknowledges one of ours. Defaults to server.lastSeq.
   */
  ackedSeq?: number;
}

/**
 * Algorithm (Bonk TECH_BRIEF §3, game4.md §19):
 * - predict(cmd): push cmd to `pending` (cap MAX_PENDING_INPUTS, drop oldest), prev = copy(current),
 *   stepPlayer(current, cmd, ctx); return that result (the FIRST prediction of this seq — the only
 *   one whose one-shots trigger feedback).
 * - reconcile(server) on every patch: base = copyPlayerSim(server); drop pending with seq <= server.lastSeq;
 *   replay the rest with stepPlayer (results ignored); error = old current position − replayed position;
 *   if |error| > PREDICTION_SNAP_DIST snap (offset = 0), else offset += error. current = replayed. If the server
 *   says !alive, stop.
 * - render: lerp(prev, current, alpha) for position + offset; offset decays as
 *   offset *= exp(-dt / (PREDICTION_SMOOTH_MS/1000)) each frame. Discrete fields from current.
 *
 * Read-only sim fields (inventory, bars, alive / downed / boarded, channel) come from the server copy at every
 * reconcile, so the replay always runs against the authoritative inventory and channel state.
 */
export class Prediction {
  /** Latest predicted state (HUD reads charge / timers / active slot from here). */
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

  /** True between reset() and stop(). */
  get active(): boolean {
    return this.activeFlag;
  }

  /** Start predicting from authoritative state: clears pending inputs and the smoothing offset. */
  reset(server: PlayerSimFields): void {
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
  reconcile(server: ServerPlayer, ctx: SimContext, opts: ReconcileOptions = {}): void {
    if (!this.activeFlag) return;
    if (!server.alive) {
      this.stop();
      return;
    }
    const oldX = this.current.x;
    const oldY = this.current.y;
    const oldZ = this.current.z;

    copyPlayerSim(server, this.current);
    this.dropAcknowledged(opts.ackedSeq ?? server.lastSeq);
    this.replay(ctx, opts.trustPredictedLock ?? true);
    this.absorbError(oldX - this.current.x, oldY - this.current.y, oldZ - this.current.z);
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
    while (acked < this.pending.length && this.pending[acked]!.cmd.seq <= lastSeq) acked++;
    if (acked > 0) this.pending.splice(0, acked);
  }

  /** Re-run every pending input on top of the server state; `prev` ends one tick before `current`. */
  private replay(ctx: SimContext, trustPredictedLock: boolean): void {
    const cur = this.current;
    if (this.pending.length === 0) {
      // No unacked input: the tick before the server's is unknown, extrapolate it backwards.
      this.prev.x = cur.x - cur.vx * DT;
      this.prev.y = cur.y - cur.vy * DT;
      this.prev.z = cur.z - cur.vz * DT;
      return;
    }
    const rc = (this.replayCtx ??= { ...ctx });
    rc.terrain = ctx.terrain;
    rc.cover = ctx.cover;
    rc.bounds = ctx.bounds;
    rc.character = ctx.character;
    rc.dt = ctx.dt;
    for (const input of this.pending) {
      rc.locked = ctx.locked && (!trustPredictedLock || input.locked);
      this.setPrevFromCurrent();
      stepPlayerInto(cur, input.cmd, rc, this.replayResult);
    }
  }

  private absorbError(ex: number, ey: number, ez: number): void {
    const o = this.offset;
    if (ex * ex + ey * ey + ez * ez > PREDICTION_SNAP_DIST * PREDICTION_SNAP_DIST) {
      this.clearOffset();
      return;
    }
    o.x += ex;
    o.y += ey;
    o.z += ez;
    if (o.x * o.x + o.y * o.y + o.z * o.z > PREDICTION_SNAP_DIST * PREDICTION_SNAP_DIST) this.clearOffset();
  }

  private decayOffset(dtSec: number): void {
    if (!(dtSec > 0)) return;
    const k = Math.exp(-dtSec / SMOOTH_TAU_SEC);
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
  }
}
