// Camera vs world (cover + floor) using the shared sim raycast, so the camera collides with
// exactly the shapes that block players and balls.

import * as THREE from "three";
import type { FloorQuery } from "../../../../shared/sim/context";
import { raycastWorld } from "../../../../shared/sim/geometry";
import { vec3, type Vec3 } from "../../../../shared/sim/math";

const origin: Vec3 = vec3();
const direction: Vec3 = vec3();
const side = new THREE.Vector3();
const lift = new THREE.Vector3();
const start = new THREE.Vector3();
const offsets: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

function ray(q: FloorQuery, from: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
  origin.x = from.x;
  origin.y = from.y;
  origin.z = from.z;
  direction.x = dir.x;
  direction.y = dir.y;
  direction.z = dir.z;
  return raycastWorld(q, origin, direction, maxDist);
}

/**
 * How far a sphere of `radius` can travel from `from` along unit `dir` (up to `maxDist`) before
 * touching cover or the floor. Approximated with 5 rays: the center plus 4 rays offset by the
 * radius perpendicular to `dir`, each shortened by the radius.
 */
export function sphereCastDistance(q: FloorQuery, from: THREE.Vector3, dir: THREE.Vector3, maxDist: number, radius: number): number {
  side.crossVectors(dir, THREE.Object3D.DEFAULT_UP);
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  lift.crossVectors(side, dir).normalize();
  offsets[0].set(0, 0, 0);
  offsets[1].copy(side).multiplyScalar(radius);
  offsets[2].copy(side).multiplyScalar(-radius);
  offsets[3].copy(lift).multiplyScalar(radius);
  offsets[4].copy(lift).multiplyScalar(-radius);
  let best = maxDist + radius;
  for (const offset of offsets) {
    start.copy(from).add(offset);
    best = Math.min(best, ray(q, start, dir, best));
  }
  return Math.max(0, Math.min(maxDist, best - radius));
}

/** Single-ray clearance (minus `margin`) from `from` along unit `dir`, clamped to [0, maxDist]. */
export function rayClearance(q: FloorQuery, from: THREE.Vector3, dir: THREE.Vector3, maxDist: number, margin: number): number {
  const hit = ray(q, from, dir, maxDist + margin);
  return Math.max(0, Math.min(maxDist, hit - margin));
}
