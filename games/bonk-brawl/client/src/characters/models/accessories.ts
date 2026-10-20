// Small accessory builders shared by several animals (bows, bells, sailor hat). Positions are in
// feet space relative to `at`. Owner: client-characters.

import * as THREE from "three";
import { type Paint, type PartBuilder, type V3, bellGeometry } from "../parts";

const add = (a: V3, x: number, y: number, z: number): V3 => [a[0] + x, a[1] + y, a[2] + z];

/** Bow (tie): two pyramids meeting at a round knot, spread along X. */
export function buildBow(b: PartBuilder, parent: THREE.Object3D, at: V3, size: number, paint: Paint): THREE.Group {
  const group = b.group(parent, at, "bow");
  for (const side of [-1, 1]) {
    const wing = b.cone(group, paint, add(at, side * size, 0, 0), add(at, side * size * 0.12, 0, 0), size * 0.62, 4);
    wing.rotateY(Math.PI / 4);
  }
  b.sphere(group, paint, at, [size * 0.32, size * 0.36, size * 0.3], "lo");
  return group;
}

/** Hand bell hanging from `at` (its top), mouth down, with a dark clapper. */
export function buildBell(b: PartBuilder, parent: THREE.Object3D, at: V3, radius: number, paint: Paint): THREE.Group {
  const group = b.group(parent, at, "bell");
  const height = radius * 1.4;
  const bell = b.mesh(group, bellGeometry(), paint, add(at, 0, -height, 0));
  bell.scale.set(radius, height, radius);
  b.sphere(group, "ink", add(at, 0, -height - radius * 0.12, 0), radius * 0.28, "lo");
  b.sphere(group, paint, add(at, 0, radius * 0.08, 0), radius * 0.22, "lo");
  return group;
}

/** Tiny white sailor (Dixie cup) hat with a slot-colored band, tilted jauntily. */
export function buildSailorHat(b: PartBuilder, parent: THREE.Object3D, at: V3, scale = 1): THREE.Group {
  const group = b.group(parent, at, "sailorHat");
  const s = scale;
  b.cylinder(group, "#FFFFFF", add(at, 0, 0.0, 0), add(at, 0, 0.1 * s, 0), 0.115 * s, 0.82, 12);
  b.cylinder(group, "slot", add(at, 0, 0.012 * s, 0), add(at, 0, 0.045 * s, 0), 0.119 * s, 0.97, 12);
  b.torus(group, "#FFFFFF", add(at, 0, 0.006 * s, 0), 0.128 * s, 0.034 * s);
  return group;
}
