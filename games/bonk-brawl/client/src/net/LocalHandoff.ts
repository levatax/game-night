// Smooth switch of the local player from predicted to interpolated rendering. Owner: client-net.

import { PREDICTION_SMOOTH_MS, PREDICTION_SNAP_DIST } from "../../../shared/constants";

interface XYZ {
  x: number;
  y: number;
  z: number;
}

const TAU_SEC = PREDICTION_SMOOTH_MS / 1000;

/**
 * When prediction stops (round-end slow-mo, KO, ring-out) the local player starts being drawn
 * from snapshots ~RTT/2 + INTERP_DELAY_MS in the past, which would snap it back along its path.
 * This keeps the last predicted render position and blends from it into the interpolated one
 * (same time constant as prediction smoothing; jumps larger than PREDICTION_SNAP_DIST snap).
 */
export class LocalHandoff {
  private readonly last: XYZ = { x: 0, y: 0, z: 0 };
  private hasLast = false;
  private readonly offset: XYZ = { x: 0, y: 0, z: 0 };

  /** The local player was drawn from prediction at `frame`. */
  predicted(frame: Readonly<XYZ>): void {
    this.last.x = frame.x;
    this.last.y = frame.y;
    this.last.z = frame.z;
    this.hasLast = true;
    this.setOffset(0, 0, 0);
  }

  /** The local player is drawn from interpolation: shift `frame` by the decaying hand-off offset. */
  interpolated(frame: XYZ, dtSec: number): void {
    if (this.hasLast) {
      this.hasLast = false;
      const dx = this.last.x - frame.x;
      const dy = this.last.y - frame.y;
      const dz = this.last.z - frame.z;
      if (dx * dx + dy * dy + dz * dz <= PREDICTION_SNAP_DIST * PREDICTION_SNAP_DIST) this.setOffset(dx, dy, dz);
    } else if (dtSec > 0) {
      const k = Math.exp(-dtSec / TAU_SEC);
      this.setOffset(this.offset.x * k, this.offset.y * k, this.offset.z * k);
    }
    frame.x += this.offset.x;
    frame.y += this.offset.y;
    frame.z += this.offset.z;
  }

  reset(): void {
    this.hasLast = false;
    this.setOffset(0, 0, 0);
  }

  private setOffset(x: number, y: number, z: number): void {
    const tiny = Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e-5;
    this.offset.x = tiny ? 0 : x;
    this.offset.y = tiny ? 0 : y;
    this.offset.z = tiny ? 0 : z;
  }
}
