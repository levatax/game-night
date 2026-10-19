// Blob shadows under players and balls. Owner: client-fx.

import type * as THREE from "three";
import type { FloorQuery } from "../../../shared/sim/context";
import type { ShadowCaster } from "./types";

/**
 * One soft dark disc (softDotTexture, multiply/alpha) per caster, projected straight down onto
 * groundHeightAt(q, x, z, radius, y) + 0.01; shrinks and fades with height above the ground
 * (readable height cue while aiming). Hidden when there's no ground below (over the void).
 * Instanced or pooled meshes; never cast/receive shadows themselves.
 */
export class BlobShadows {
  constructor(scene: THREE.Scene) {
    void scene;
  }

  setFloorQuery(q: FloorQuery | null): void {
    void q;
  }

  update(casters: readonly ShadowCaster[]): void {
    void casters;
  }

  dispose(): void {}
}
