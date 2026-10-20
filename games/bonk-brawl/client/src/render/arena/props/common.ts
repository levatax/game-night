// Small helpers shared by the cover-prop builders.

import * as THREE from "three";
import type { CoverDef } from "../../../../../shared/maps";
import type { Animated, ArenaKit } from "../kit";

/** Everything a cover builder needs. Geometry/material lifetimes go through kit.bank. */
export interface PropContext {
  kit: ArenaKit;
  rng: () => number;
}

/** A built cover piece: a group in the cover's local frame (origin at the footprint center, y = 0). */
export interface PropBuild {
  object: THREE.Object3D;
  animated?: Animated[];
}

/** Mesh registered with the arena's bank; environment receives shadows but never casts. */
export function propMesh(
  ctx: PropContext,
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  name: string,
): THREE.Mesh {
  const mesh = new THREE.Mesh(ctx.kit.bank.geo(geometry), material);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

/** Multiply a geometry's UVs (tile a shared cached texture without cloning it). */
export function scaleUv(geometry: THREE.BufferGeometry, su: number, sv: number): THREE.BufferGeometry {
  const uv = geometry.getAttribute("uv");
  if (!uv) return geometry;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geometry;
}

/** Position + yaw a prop group on its cover footprint (THREE rotation.y matches the sim's box frame). */
export function placeOnCover(object: THREE.Object3D, cover: CoverDef): void {
  object.position.set(cover.x, 0, cover.z);
  object.rotation.y = cover.rotation;
}

/** Lathe from (radius, y) pairs. */
export function lathe(points: ReadonlyArray<readonly [number, number]>, segments: number): THREE.LatheGeometry {
  return new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
  );
}
