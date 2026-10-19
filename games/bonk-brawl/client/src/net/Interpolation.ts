// Snapshot interpolation for remote players. Owner: client-net.

import type { PlayerSimFields } from "../../../shared/types";

/**
 * Per-player snapshot buffers keyed by server tick (state.tick of the patch they came from).
 * Render time = clock.serverTickAt(now) - (clock.rttMs / 2 + INTERP_DELAY_MS) / TICK_MS.
 * (serverTickAt is the server's PRESENT; the newest snapshot is ~RTT/2 old on arrival, so the
 * extra RTT/2 keeps a real ~100 ms ≈ 2-patch buffer behind the newest snapshot.)
 * Used for remote players and for the local player whenever it is not being predicted.
 * sample(): find snapshots a (≤ t) and b (> t); positions/velocities lerp, yaw/pitch lerpAngle,
 * every discrete field (timers, flags, powerUp, heldCount...) from `a`. Past the newest snapshot:
 * extrapolate positions with velocity for at most MAX_EXTRAPOLATION_MS, then hold. Before the
 * oldest: use the oldest. Keep about 1 s of snapshots per player.
 * Teleports: when `alive` flips false → true (round reset) or two consecutive snapshots are more
 * than 4 m apart (faster than anything legal: ≤ 1.5 m per 50 ms patch), drop the older snapshots
 * so the player appears at the new spot instead of sliding across the island. Ghosts (alive =
 * false) are never extrapolated.
 */
export class Interpolation {
  /** Record a snapshot (copied). Ignores ticks <= the newest stored tick for that id. */
  push(id: string, tick: number, sim: PlayerSimFields): void {
    void id;
    void tick;
    void sim;
  }

  /** Sample at fractional server tick `renderTick` into `out`. Returns false if no snapshot exists. */
  sample(id: string, renderTick: number, out: PlayerSimFields): boolean {
    void id;
    void renderTick;
    void out;
    return false; // TODO(client-net)
  }

  remove(id: string): void {
    void id;
  }

  clear(): void {}
}
