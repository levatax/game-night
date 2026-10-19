// Pooled particle bursts. Owner: client-fx.

import type * as THREE from "three";
import type { BurstOptions, ParticleKind } from "./types";

/**
 * Cheap pooled sprites/instanced quads (softDotTexture + simple procedural star/feather/confetti
 * shapes drawn on canvas), additive or alpha-blended per kind, gravity/drag per kind. Hard cap
 * ~600 live particles (fewer on low quality).
 */
export class Particles {
  constructor(scene: THREE.Scene) {
    void scene;
  }

  burst(kind: ParticleKind, pos: { x: number; y: number; z: number }, opts?: BurstOptions): void {
    void kind;
    void pos;
    void opts;
  }

  /**
   * Continuous emitter following a target (speed lines while zoomies/dashing, dust skid while
   * stunned on the ground). Call every frame with on = true; stops when not refreshed for 0.1 s.
   */
  emit(key: string, kind: ParticleKind, pos: { x: number; y: number; z: number }, opts?: BurstOptions): void {
    void key;
    void kind;
    void pos;
    void opts;
  }

  update(dt: number): void {
    void dt;
  }

  setQualityScale(scale: number): void {
    void scale;
  }

  clear(): void {}

  dispose(): void {}
}
