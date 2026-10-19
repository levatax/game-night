// Comic pop-up words (BONK! / CATCH! / OUT!). Owner: client-fx.

import type * as THREE from "three";
import type { PopTextKind } from "./types";

/**
 * Canvas-lettered sprites (Fredoka 700, thick ink outline, slight rotation), scale-pop in
 * (0 → 1.3 → 1 over 0.15 s), float up 0.8 m, fade after 0.7 s. Colors: bonk = yellow/red,
 * catch = cyan, out = red, miss = grey, boing = pink, ding = gold.
 */
export class PopText {
  constructor(scene: THREE.Scene) {
    void scene;
  }

  show(kind: PopTextKind, pos: { x: number; y: number; z: number }, color?: string): void {
    void kind;
    void pos;
    void color;
  }

  update(dt: number): void {
    void dt;
  }

  clear(): void {}

  dispose(): void {}
}
