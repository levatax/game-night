// Shore field texture for the water shader: for every texel over the heightfield extent, the water depth and
// the distance to the coastline (two-pass chamfer distance transform at 2 texels per meter). RGBA8 so it filters
// everywhere: R = depth / SHORE_DEPTH_MAX, G = coast distance / SHORE_DIST_MAX, B = 1 on land. Outside the grid
// the clamp-to-edge border reads as "deep, far from any coast". Owner: client-render.

import * as THREE from "three";
import { WATER_Y } from "../../../../shared/constants";
import { heightAt } from "../../../../shared/island/heightfield";
import type { Heightfield } from "../../../../shared/island/types";

/** Encoding ranges (the shader decodes with the same numbers). */
export const SHORE_DEPTH_MAX = 6;
export const SHORE_DIST_MAX = 12;
/** Texels per meter. */
const RES = 2;

export interface ShoreField {
  texture: THREE.DataTexture;
  /** World rectangle the texture covers: (originX, originZ, sizeX, sizeZ). */
  rect: THREE.Vector4;
}

export function buildShoreField(grid: Heightfield): ShoreField {
  const sizeX = (grid.cols - 1) * grid.cell;
  const sizeZ = (grid.rows - 1) * grid.cell;
  const w = Math.max(2, Math.round(sizeX * RES) + 1);
  const h = Math.max(2, Math.round(sizeZ * RES) + 1);
  const depth = new Float32Array(w * h);
  const dist = new Float32Array(w * h);
  const BIG = 1e6;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = grid.originX + (i / (w - 1)) * sizeX;
      const z = grid.originZ + (j / (h - 1)) * sizeZ;
      const d = WATER_Y - heightAt(grid, x, z);
      depth[j * w + i] = d;
      dist[j * w + i] = d <= 0 ? 0 : BIG;
    }
  }
  // Chamfer 1 / √2 in texels, forward then backward.
  const D = 1;
  const D2 = Math.SQRT2;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      let v = dist[k]!;
      if (v === 0) continue;
      if (i > 0) v = Math.min(v, dist[k - 1]! + D);
      if (j > 0) {
        v = Math.min(v, dist[k - w]! + D);
        if (i > 0) v = Math.min(v, dist[k - w - 1]! + D2);
        if (i < w - 1) v = Math.min(v, dist[k - w + 1]! + D2);
      }
      dist[k] = v;
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      let v = dist[k]!;
      if (v === 0) continue;
      if (i < w - 1) v = Math.min(v, dist[k + 1]! + D);
      if (j < h - 1) {
        v = Math.min(v, dist[k + w]! + D);
        if (i < w - 1) v = Math.min(v, dist[k + w + 1]! + D2);
        if (i > 0) v = Math.min(v, dist[k + w - 1]! + D2);
      }
      dist[k] = v;
    }
  }
  const data = new Uint8Array(w * h * 4);
  for (let k = 0; k < w * h; k++) {
    const d = depth[k]!;
    const meters = dist[k]! / RES;
    data[k * 4] = Math.round(Math.min(1, Math.max(0, d / SHORE_DEPTH_MAX)) * 255);
    data[k * 4 + 1] = Math.round(Math.min(1, meters / SHORE_DIST_MAX) * 255);
    data[k * 4 + 2] = d <= 0 ? 255 : 0;
    data[k * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.name = "shoreField";
  texture.needsUpdate = true;
  return { texture, rect: new THREE.Vector4(grid.originX, grid.originZ, sizeX, sizeZ) };
}
