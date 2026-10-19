// Power-up pickups + pedestal shimmer. Owner: client-fx.

import type * as THREE from "three";
import type { ArenaDef } from "../../../shared/maps";
import type { PowerUpView } from "../../../shared/types";

/**
 * Models (procedural, toon + outline): mega = giant red beach ball, triple = 3 small balls in a
 * bundle, boomerang = banana-shaped ball, zoomies = sneakers with wings. Ready pickups hover at
 * PEDESTAL_HEIGHT + POWERUP_HOVER_Y, spin and bob, with a glow ring. "warning" phase: pedestal
 * shimmer column (sparkles + pulsing light) without the model. Removal = shrink-pop.
 */
export class PowerUpVisuals {
  constructor(scene: THREE.Scene) {
    void scene;
  }

  setArena(def: ArenaDef): void {
    void def;
  }

  sync(powerUps: readonly PowerUpView[], dt: number, elapsed: number): void {
    void powerUps;
    void dt;
    void elapsed;
  }

  clear(): void {}

  dispose(): void {}
}
