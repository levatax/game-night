// Walkability queries the generator uses to keep its promises (reachable spring / cave / secret chest, walkable
// corridors). Owner: island.
//
// The model is conservative relative to shared/sim stepPlayer: a 4-neighbour vertex step is walkable when both
// vertices are on land or the walkable shelf (feet above WATER_Y − SWIM_DEPTH) and the height difference is at
// most WALK_EDGE_RISE (1 m per 1 m: the slope clamp's limit, normal.y ≥ 0.577 > MAX_WALK_NORMAL_Y). Cliff walls
// (steeper) and deep water break the graph. Bots get the same guarantee from it (their BFS fallback is theirs).

import { MAX_WALK_NORMAL_Y, SWIM_DEPTH, WATER_Y } from "../constants.js";
import { heightAt, normalAt } from "./heightfield.js";
import { vertexIndex } from "./terrain.js";
import type { Vec3Like } from "../types.js";
import type { Heightfield, XZ } from "./types.js";

/** Max height difference (m) of a walkable 4-neighbour step. */
export const WALK_EDGE_RISE = 1.0;
/** Lowest walkable ground (shallow shelf: feet still above the swim threshold), with a small margin. */
export const WALK_MIN_Y = WATER_Y - SWIM_DEPTH + 0.05;

/**
 * Vertices reachable on foot from the vertex nearest (x, z), restricted to vertices whose owner is `island`
 * (pass owner = null to ignore ownership). Returns 1 for reachable vertices.
 */
export function reachableFrom(grid: Heightfield, owner: Int8Array | null, island: number, x: number, z: number): Uint8Array {
  const { cols, rows } = grid;
  const h = grid.heights;
  const seen = new Uint8Array(cols * rows);
  const queue = new Int32Array(cols * rows);
  const start = vertexIndex(grid, x, z);
  if (h[start]! < WALK_MIN_Y) return seen;
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  while (head < tail) {
    const i = queue[head++]!;
    const c = i % cols;
    const hi = h[i]!;
    for (let k = 0; k < 4; k++) {
      let j: number;
      if (k === 0) {
        if (c === 0) continue;
        j = i - 1;
      } else if (k === 1) {
        if (c === cols - 1) continue;
        j = i + 1;
      } else if (k === 2) {
        if (i < cols) continue;
        j = i - cols;
      } else {
        if (i >= (rows - 1) * cols) continue;
        j = i + cols;
      }
      if (seen[j]) continue;
      const hj = h[j]!;
      if (hj < WALK_MIN_Y) continue;
      if (owner && owner[j] !== island) continue;
      const d = hj - hi;
      if (d > WALK_EDGE_RISE || d < -WALK_EDGE_RISE) continue;
      if (!edgeSlopesOk(grid, i, j)) continue;
      seen[j] = 1;
      queue[tail++] = j;
    }
  }
  return seen;
}

const scratchN: Vec3Like = { x: 0, y: 1, z: 0 };

/**
 * The bilinear cells on both sides of the grid edge i–j are walkable at the edge (normal.y ≥ MAX_WALK_NORMAL_Y,
 * sampled 0.25 m into each cell at the edge midpoint) — what stepPlayer checks when a step rises.
 */
export function edgeSlopesOk(grid: Heightfield, i: number, j: number): boolean {
  const a = i < j ? i : j;
  const c = a % grid.cols;
  const r = Math.floor(a / grid.cols);
  const x = grid.originX + c * grid.cell;
  const z = grid.originZ + r * grid.cell;
  const q = grid.cell * 0.25;
  const half = grid.cell * 0.5;
  if (j - i === 1 || i - j === 1) {
    return normalAt(grid, x + half, z - q, scratchN).y >= MAX_WALK_NORMAL_Y && normalAt(grid, x + half, z + q, scratchN).y >= MAX_WALK_NORMAL_Y;
  }
  return normalAt(grid, x - q, z + half, scratchN).y >= MAX_WALK_NORMAL_Y && normalAt(grid, x + q, z + half, scratchN).y >= MAX_WALK_NORMAL_Y;
}

/**
 * A straight walk from a to b stays on walkable ground: samples every 0.5 m are above `minY` (default: not
 * swimming), rise at most 0.45 m per sample and stand on slopes with normal.y ≥ MAX_WALK_NORMAL_Y + 0.04.
 */
export function segmentWalkable(grid: Heightfield, a: XZ, b: XZ, minY = WALK_MIN_Y): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  const steps = Math.max(1, Math.ceil(len / 0.5));
  let prev = heightAt(grid, a.x, a.z);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    const y = heightAt(grid, x, z);
    if (y < minY) return false;
    const rise = y - prev;
    if (rise > 0.45 || rise < -0.45) return false;
    if (normalAt(grid, x, z, scratchN).y < MAX_WALK_NORMAL_Y + 0.04) return false;
    prev = y;
  }
  return true;
}
