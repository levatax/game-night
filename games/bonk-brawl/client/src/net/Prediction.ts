// Own-player client-side prediction + server reconciliation. Owner: client-net.

import type { InputCmd } from "../../../shared/protocol";
import type { SimContext } from "../../../shared/sim/context";
import { createPlayerSim, emptyStepResult, type PlayerSim, type StepPlayerResult } from "../../../shared/sim/player";
import type { PlayerSimFields, PlayerView } from "../../../shared/types";

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
 *   offset *= exp(-dt / (PREDICTION_SMOOTH_MS/1000)) each frame. Discrete fields from current.
 */
export class Prediction {
  /** Latest predicted state (HUD reads timers/charge/heldCount from here). */
  readonly current: PlayerSim = createPlayerSim();

  /** True between reset() and stop(). */
  get active(): boolean {
    return false; // TODO(client-net)
  }

  /** Start predicting from authoritative state: clears pending inputs and the smoothing offset. */
  reset(server: PlayerView): void {
    void server;
  }

  stop(): void {}

  /** Predict one tick for a freshly sampled input. */
  predict(cmd: InputCmd, ctx: SimContext): StepPlayerResult {
    void cmd;
    void ctx;
    return emptyStepResult(); // TODO(client-net)
  }

  /** Reconcile against the server's copy of the local player (call on every state patch). */
  reconcile(server: PlayerView, ctx: SimContext): void {
    void server;
    void ctx;
  }

  /**
   * Fill `out` with the render state: positions lerped between the previous and current predicted
   * tick by `alpha` (0..1, fraction of the fixed step accumulated) plus the decaying smoothing
   * offset; every other field from `current`. `dtSec` advances the offset decay.
   */
  getRenderSim(alpha: number, dtSec: number, out: PlayerSimFields): PlayerSimFields {
    void alpha;
    void dtSec;
    return out;
  }

  /** Inputs not yet acknowledged by the server. */
  get pendingCount(): number {
    return 0;
  }
}
