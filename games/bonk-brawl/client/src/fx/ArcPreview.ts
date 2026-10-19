// Full-charge trajectory hint (first ~25%). Owner: client-fx.

import type * as THREE from "three";
import type { Vec3Like } from "../../../shared/types";

/**
 * Dotted/dashed tube or line of small dots along `points` (from sampleTrajectory with
 * ARC_PREVIEW_FRACTION), tinted with the player color, fading toward the end. Hidden when
 * points is null or has < 2 points.
 */
export class ArcPreview {
  constructor(scene: THREE.Scene) {
    void scene;
  }

  update(points: readonly Vec3Like[] | null, color: string): void {
    void points;
    void color;
  }

  dispose(): void {}
}
