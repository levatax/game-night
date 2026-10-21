// Heightfield queries shared by the sim, the server and the client. Owner: island (written by the architect,
// complete; the island owner may optimize but must keep results bit-identical and signatures unchanged).
//
// heightAt is bilinear over the vertex grid (outside the grid: clamped to the edge vertices). normalAt is the
// analytic normal of that bilinear patch. Everything is + − × ÷ and Math.sqrt only (deterministic).

import { WATER_Y } from "../constants.js";
import type { Vec3Like } from "../types.js";
import { fnv1a } from "./noise.js";
import type { Heightfield } from "./types.js";

export function createHeightfield(cols: number, rows: number, cell: number, originX: number, originZ: number): Heightfield {
  return { cols, rows, cell, originX, originZ, heights: new Float32Array(cols * rows) };
}

/** Height of vertex (c, r), clamped to the grid. */
export function vertexHeight(hf: Heightfield, c: number, r: number): number {
  const cc = c < 0 ? 0 : c >= hf.cols ? hf.cols - 1 : c;
  const rr = r < 0 ? 0 : r >= hf.rows ? hf.rows - 1 : r;
  return hf.heights[rr * hf.cols + cc]!;
}

/** Bilinear terrain height at world (x, z). */
export function heightAt(hf: Heightfield, x: number, z: number): number {
  let gx = (x - hf.originX) / hf.cell;
  let gz = (z - hf.originZ) / hf.cell;
  const maxX = hf.cols - 1;
  const maxZ = hf.rows - 1;
  if (gx < 0) gx = 0;
  else if (gx > maxX) gx = maxX;
  if (gz < 0) gz = 0;
  else if (gz > maxZ) gz = maxZ;
  let c = Math.floor(gx);
  let r = Math.floor(gz);
  if (c >= maxX) c = maxX - 1;
  if (r >= maxZ) r = maxZ - 1;
  const fx = gx - c;
  const fz = gz - r;
  const i = r * hf.cols + c;
  const h00 = hf.heights[i]!;
  const h10 = hf.heights[i + 1]!;
  const h01 = hf.heights[i + hf.cols]!;
  const h11 = hf.heights[i + hf.cols + 1]!;
  const a = h00 + (h10 - h00) * fx;
  const b = h01 + (h11 - h01) * fx;
  return a + (b - a) * fz;
}

/** Unit surface normal of the bilinear patch at (x, z). */
export function normalAt(hf: Heightfield, x: number, z: number, out: Vec3Like = { x: 0, y: 1, z: 0 }): Vec3Like {
  let gx = (x - hf.originX) / hf.cell;
  let gz = (z - hf.originZ) / hf.cell;
  const maxX = hf.cols - 1;
  const maxZ = hf.rows - 1;
  if (gx < 0) gx = 0;
  else if (gx > maxX) gx = maxX;
  if (gz < 0) gz = 0;
  else if (gz > maxZ) gz = maxZ;
  let c = Math.floor(gx);
  let r = Math.floor(gz);
  if (c >= maxX) c = maxX - 1;
  if (r >= maxZ) r = maxZ - 1;
  const fx = gx - c;
  const fz = gz - r;
  const i = r * hf.cols + c;
  const h00 = hf.heights[i]!;
  const h10 = hf.heights[i + 1]!;
  const h01 = hf.heights[i + hf.cols]!;
  const h11 = hf.heights[i + hf.cols + 1]!;
  // d/dx and d/dz of the bilinear patch (per meter).
  const dx = (h10 - h00 + (h11 - h01 - h10 + h00) * fz) / hf.cell;
  const dz = (h01 - h00 + (h11 - h01 - h10 + h00) * fx) / hf.cell;
  const len = Math.sqrt(dx * dx + 1 + dz * dz);
  out.x = -dx / len;
  out.y = 1 / len;
  out.z = -dz / len;
  return out;
}

/** Slope as the normal's y component (1 = flat, 0 = vertical). */
export function slopeAt(hf: Heightfield, x: number, z: number): number {
  const n = normalAt(hf, x, z, scratch);
  return n.y;
}
const scratch: Vec3Like = { x: 0, y: 1, z: 0 };

/** Terrain is under water here. */
export function isWater(hf: Heightfield, x: number, z: number): boolean {
  return heightAt(hf, x, z) < WATER_Y;
}

/** Water depth at (x, z) (0 on land). */
export function waterDepthAt(hf: Heightfield, x: number, z: number): number {
  const d = WATER_Y - heightAt(hf, x, z);
  return d > 0 ? d : 0;
}

/** (x, z) is inside the grid shrunk by `margin` meters. */
export function inGrid(hf: Heightfield, x: number, z: number, margin = 0): boolean {
  const maxX = hf.originX + (hf.cols - 1) * hf.cell;
  const maxZ = hf.originZ + (hf.rows - 1) * hf.cell;
  return x >= hf.originX + margin && x <= maxX - margin && z >= hf.originZ + margin && z <= maxZ - margin;
}

/**
 * Ray vs terrain: distance along the unit `dir` to the first point at or below the surface, or -1 within
 * maxDist. Marches in 0.25 m steps then bisects (deterministic).
 */
export function raycastTerrain(hf: Heightfield, origin: Vec3Like, dir: Vec3Like, maxDist: number): number {
  const step = 0.25;
  let prev = 0;
  for (let t = step; t <= maxDist + 1e-9; t += step) {
    const x = origin.x + dir.x * t;
    const y = origin.y + dir.y * t;
    const z = origin.z + dir.z * t;
    if (y <= heightAt(hf, x, z)) {
      let lo = prev;
      let hi = t;
      for (let k = 0; k < 8; k++) {
        const mid = (lo + hi) * 0.5;
        const my = origin.y + dir.y * mid;
        if (my <= heightAt(hf, origin.x + dir.x * mid, origin.z + dir.z * mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    prev = t;
  }
  return -1;
}

/** FNV-1a 32-bit of the height bytes (WelcomeMsg.gridHash). */
export function gridHash(hf: Heightfield): number {
  return fnv1a(new Uint8Array(hf.heights.buffer, hf.heights.byteOffset, hf.heights.byteLength));
}
