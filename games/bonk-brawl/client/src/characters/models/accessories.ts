// Accessory builders shared by animals and KO mementos (sailor hat, bow, bell, nightcap, scarf
// tails, ribbons). Everything is recorded on the given pivot in feet space; tilts are baked in.
// Owner: client-characters.

import * as THREE from "three";
import type { Paint, PartBuilder, V3 } from "../parts";
import { add } from "./common";

const ACC = { accessory: true, flair: true } as const;

/** Rotate a feet-space offset by an Euler XYZ (for points inside a tilted frame). */
export function rotateOffset(v: V3, rot: V3): V3 {
  const r = new THREE.Vector3(v[0], v[1], v[2]).applyEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
  return [r.x, r.y, r.z];
}

/**
 * White sailor (Dixie cup) hat with a slot-colored band, base centered at `at`, tilted by `tilt`
 * around its base. Returns the feet-space point at the back of the rim (ribbon anchor).
 */
export function buildSailorHat(b: PartBuilder, pivot: THREE.Object3D, at: V3, scale: number, tilt: V3): V3 {
  const s = scale;
  b.frame(at, tilt, () => {
    b.cylinder(pivot, "#FFFFFF", add(at, 0, 0, 0), add(at, 0, 0.1 * s, 0), 0.115 * s, { ...ACC, topRatio: 0.82, segments: 12 });
    b.cylinder(pivot, "slot", add(at, 0, 0.012 * s, 0), add(at, 0, 0.048 * s, 0), 0.119 * s, {
      ...ACC,
      topRatio: 0.97,
      segments: 12,
      outline: false,
      gradient: 0,
    });
    b.torus(pivot, "#FFFFFF", add(at, 0, 0.006 * s, 0), 0.128 * s, 0.034 * s, { ...ACC, tubular: 14, radial: 5 });
  });
  const back = rotateOffset([0, 0.01 * s, 0.13 * s], tilt);
  return add(at, back[0], back[1], back[2]);
}

/** Bow (tie): two pyramids meeting at a round knot, spread along X. */
export function buildBow(b: PartBuilder, pivot: THREE.Object3D, at: V3, size: number, paint: Paint, knot: Paint = paint): void {
  for (const side of [-1, 1]) {
    b.cone(pivot, paint, add(at, side * size, 0, 0), add(at, side * size * 0.12, 0, 0), size * 0.62, {
      ...ACC,
      segments: 4,
      rot: [0, Math.PI / 4, 0],
    });
  }
  b.sphere(pivot, knot, at, [size * 0.32, size * 0.36, size * 0.3], { ...ACC, detail: "lo" });
}

/** Hand bell hanging from `top`, mouth down, with a dark clapper and a loop. */
export function buildBell(b: PartBuilder, pivot: THREE.Object3D, top: V3, radius: number, paint: Paint): void {
  const height = radius * 1.4;
  b.bell(pivot, paint, add(top, 0, -height, 0), radius, height, ACC);
  b.sphere(pivot, "ink", add(top, 0, -height - radius * 0.12, 0), radius * 0.28, { ...ACC, detail: "xs", outline: false, hiOnly: true });
  b.sphere(pivot, paint, add(top, 0, radius * 0.08, 0), radius * 0.22, { ...ACC, detail: "xs" });
}

/** Little ribbon bow (two loops + knot) facing `normal` — tail bows, hat bows. */
export function buildRibbonBow(b: PartBuilder, pivot: THREE.Object3D, at: V3, size: number, paint: Paint): void {
  for (const side of [-1, 1]) {
    b.sphere(pivot, paint, add(at, side * size * 0.7, size * 0.15, 0), [size * 0.6, size * 0.42, size * 0.22], {
      ...ACC,
      detail: "xs",
      rot: [0, 0, side * 0.35],
    });
  }
  b.sphere(pivot, paint, at, size * 0.3, { ...ACC, detail: "xs" });
}
