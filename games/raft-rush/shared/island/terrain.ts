// World terrain: composes island rasters into the authoritative heightfield and sculpts it. Owner: island.
//
// Stages (all deterministic: + − × ÷, Math.sqrt, Math.fround; heights live in the Float32Array grid):
//   composeTerrain  — paste each island raster at its integer center (the island with the larger coast distance
//                     wins a vertex), add sea-floor noise, remember which island owns each vertex;
//   solvePeaks      — scale each island's hill field so its summit lands on the plan's peak, re-measured after
//                     the slope clamp (a few proportional iterations);
//   clampSlopes     — lowering-only Lipschitz clamp: |Δh| between 4-neighbours ≤ lip (1 m per m everywhere
//                     except cliff walls), so bilinear slopes stay walkable (|∇h| ≤ √2 → normal.y ≥ 0.577 >
//                     MAX_WALK_NORMAL_Y) and no unwalkable pits remain;
//   flattenArea     — blend a disc toward a (gently tilted) plane (camp, wreck, raft, spring, cave);
//   coastDistance   — chamfer distance from every vertex to the other side of the waterline.

import { SEA_FLOOR_Y, WATER_Y } from "../constants.js";
import { fbm2, smoothstep } from "./noise.js";
import type { IslandPlan, IslandRaster } from "./shape.js";
import type { Heightfield } from "./types.js";

/** Working terrain: the grid plus per-vertex bookkeeping used by the later stages. */
export interface Terrain {
  grid: Heightfield;
  plans: IslandPlan[];
  /** Island index per vertex (−1 = open sea outside every raster). */
  owner: Int8Array;
  base: Float64Array;
  hill: Float64Array;
  terrace: Float64Array;
  crater: Float64Array;
  /** Sea-floor noise already weighted by the raster's `deep`. */
  floor: Float64Array;
  /** Allowed slope per vertex for clampSlopes(). */
  lip: Float32Array;
  /** Hill scale per island (solved by solvePeaks). */
  hillScale: number[];
  /** Vertex index of each island's summit (after solvePeaks). */
  summit: number[];
  /** 1 where a duel sandbar raised the strait floor (those shallows belong to nobody's coast). */
  sandbar: Uint8Array;
}

/** Paste the rasters (centers = plan.cx/cz) into `grid` and prepare the bookkeeping arrays. */
export function composeTerrain(grid: Heightfield, rasters: IslandRaster[], floorSeed: number): Terrain {
  const n = grid.cols * grid.rows;
  const t: Terrain = {
    grid,
    plans: rasters.map((r) => r.plan),
    owner: new Int8Array(n).fill(-1),
    base: new Float64Array(n).fill(SEA_FLOOR_Y),
    hill: new Float64Array(n),
    terrace: new Float64Array(n),
    crater: new Float64Array(n),
    floor: new Float64Array(n),
    lip: new Float32Array(n).fill(1),
    hillScale: rasters.map(() => 1),
    summit: rasters.map(() => 0),
    sandbar: new Uint8Array(n),
  };
  const bestDelta = new Float64Array(n).fill(Number.NEGATIVE_INFINITY);
  const deep = new Float64Array(n).fill(1);
  for (let k = 0; k < rasters.length; k++) {
    const r = rasters[k]!;
    const ox = r.plan.cx - r.half;
    const oz = r.plan.cz - r.half;
    for (let lr = 0; lr < r.size; lr++) {
      const row = Math.round(oz + lr - grid.originZ);
      if (row < 0 || row >= grid.rows) continue;
      for (let lc = 0; lc < r.size; lc++) {
        const col = Math.round(ox + lc - grid.originX);
        if (col < 0 || col >= grid.cols) continue;
        const li = lr * r.size + lc;
        const wi = row * grid.cols + col;
        const d = r.delta[li]!;
        if (d <= bestDelta[wi]!) continue;
        bestDelta[wi] = d;
        t.owner[wi] = k;
        t.base[wi] = r.base[li]!;
        t.hill[wi] = r.hill[li]!;
        t.terrace[wi] = r.terrace[li]!;
        t.crater[wi] = r.crater[li]!;
        t.lip[wi] = r.lip[li]!;
        deep[wi] = r.deep[li]!;
      }
    }
  }
  for (let row = 0; row < grid.rows; row++) {
    const z = grid.originZ + row * grid.cell;
    for (let col = 0; col < grid.cols; col++) {
      const i = row * grid.cols + col;
      const w = deep[i]!;
      if (w <= 0) continue;
      const x = grid.originX + col * grid.cell;
      t.floor[i] = 0.4 * (fbm2(x * 0.05 + 31.7, z * 0.05 + 11.3, floorSeed, 2) - 0.5) * w;
    }
  }
  return t;
}

/** Write heights from the components with the current hill scales (no clamp). */
function writeHeights(t: Terrain): void {
  const h = t.grid.heights;
  for (let i = 0; i < h.length; i++) {
    const k = t.owner[i]!;
    const s = k >= 0 ? t.hillScale[k]! : 0;
    const hill = s * t.hill[i]! - t.crater[i]!;
    const up = hill > t.terrace[i]! ? hill : t.terrace[i]!;
    h[i] = Math.fround(t.base[i]! + (up > 0 ? up : 0) + t.floor[i]!);
  }
}

/**
 * Scale each island's hills so the summit (after the slope clamp) is within 0.06 m of plan.peak. Writes the
 * final pre-landmark heights into the grid and records each island's summit vertex.
 */
export function solvePeaks(t: Terrain): void {
  const islands = t.plans.length;
  const maxHill = new Array<number>(islands).fill(0);
  for (let i = 0; i < t.hill.length; i++) {
    const k = t.owner[i]!;
    if (k >= 0 && t.hill[i]! > maxHill[k]!) maxHill[k] = t.hill[i]!;
  }
  for (let k = 0; k < islands; k++) t.hillScale[k] = (t.plans[k]!.peak - 1.25) / (maxHill[k]! > 0.05 ? maxHill[k]! : 0.05);
  for (let iter = 0; iter < 6; iter++) {
    writeHeights(t);
    clampSlopes(t.grid, t.lip);
    const peaks = measurePeaks(t);
    let done = true;
    for (let k = 0; k < islands; k++) {
      const target = t.plans[k]!.peak;
      const got = peaks[k]!;
      if (Math.abs(got - target) > 0.06) {
        done = false;
        t.hillScale[k] = t.hillScale[k]! * ((target - 1.2) / (got - 1.2 > 0.5 ? got - 1.2 : 0.5));
      }
    }
    if (done) break;
  }
}

/** Highest vertex per island (also stores the summit indices). */
export function measurePeaks(t: Terrain): number[] {
  const h = t.grid.heights;
  const peaks = t.plans.map(() => Number.NEGATIVE_INFINITY);
  for (let i = 0; i < h.length; i++) {
    const k = t.owner[i]!;
    if (k < 0) continue;
    if (h[i]! > peaks[k]!) {
      peaks[k] = h[i]!;
      t.summit[k] = i;
    }
  }
  return peaks;
}

/**
 * Lowering-only slope clamp: h[i] ≤ h[j] + lip[i] for every 4-neighbour j. Two forward/backward sweeps (exact
 * for a constant lip, a tight bound otherwise).
 */
export function clampSlopes(grid: Heightfield, lip: Float32Array): void {
  const { cols, rows } = grid;
  const h = grid.heights;
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const L = lip[i]!;
        let v = h[i]!;
        if (c > 0 && h[i - 1]! + L < v) v = h[i - 1]! + L;
        if (r > 0 && h[i - cols]! + L < v) v = h[i - cols]! + L;
        h[i] = Math.fround(v);
      }
    }
    for (let r = rows - 1; r >= 0; r--) {
      for (let c = cols - 1; c >= 0; c--) {
        const i = r * cols + c;
        const L = lip[i]!;
        let v = h[i]!;
        if (c < cols - 1 && h[i + 1]! + L < v) v = h[i + 1]! + L;
        if (r < rows - 1 && h[i + cols]! + L < v) v = h[i + cols]! + L;
        h[i] = Math.fround(v);
      }
    }
  }
}

/**
 * Blend the disc around (x0, z0) toward the plane h0 − tilt·((x − x0)·nx + (z − z0)·nz): full weight inside
 * `inner`, smooth falloff to 0 at `outer`. (nx, nz) is a unit direction (the plane descends along it).
 */
export function flattenArea(
  grid: Heightfield,
  x0: number,
  z0: number,
  inner: number,
  outer: number,
  h0: number,
  tilt = 0,
  nx = 0,
  nz = 0,
): void {
  const c0 = Math.floor((x0 - outer - grid.originX) / grid.cell);
  const c1 = Math.ceil((x0 + outer - grid.originX) / grid.cell);
  const r0 = Math.floor((z0 - outer - grid.originZ) / grid.cell);
  const r1 = Math.ceil((z0 + outer - grid.originZ) / grid.cell);
  const h = grid.heights;
  for (let r = r0 < 0 ? 0 : r0; r <= r1 && r < grid.rows; r++) {
    const z = grid.originZ + r * grid.cell;
    for (let c = c0 < 0 ? 0 : c0; c <= c1 && c < grid.cols; c++) {
      const x = grid.originX + c * grid.cell;
      const dx = x - x0;
      const dz = z - z0;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= outer) continue;
      const w = smoothstep(outer, inner, d);
      const i = r * grid.cols + c;
      const target = h0 - tilt * (dx * nx + dz * nz);
      h[i] = Math.fround(h[i]! + (target - h[i]!) * w);
    }
  }
}

/**
 * Chamfer distance (m) from every vertex to the nearest vertex on the other side of the waterline: for land
 * vertices the distance to water, for water vertices the distance to land. Land = height ≥ WATER_Y.
 */
export function coastDistance(grid: Heightfield): Float32Array {
  const h = grid.heights;
  const toWater = distanceField(grid, (y) => y < WATER_Y);
  const toLand = distanceField(grid, (y) => y >= WATER_Y);
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) out[i] = h[i]! >= WATER_Y ? toWater[i]! : toLand[i]!;
  return out;
}

/**
 * Chamfer distance (m) from every vertex to the nearest vertex satisfying `seed(height, index)` (0 on those).
 */
export function distanceField(grid: Heightfield, seed: (y: number, i: number) => boolean): Float32Array {
  const { cols, rows } = grid;
  const h = grid.heights;
  const d = new Float32Array(cols * rows);
  for (let i = 0; i < d.length; i++) d[i] = seed(h[i]!, i) ? 0 : 1e9;
  chamfer(d, cols, rows);
  return d;
}

const D1 = 1;
const D2 = Math.SQRT2;

function chamfer(d: Float32Array, cols: number, rows: number): void {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      let v = d[i]!;
      if (v === 0) continue;
      if (c > 0 && d[i - 1]! + D1 < v) v = d[i - 1]! + D1;
      if (r > 0) {
        if (d[i - cols]! + D1 < v) v = d[i - cols]! + D1;
        if (c > 0 && d[i - cols - 1]! + D2 < v) v = d[i - cols - 1]! + D2;
        if (c < cols - 1 && d[i - cols + 1]! + D2 < v) v = d[i - cols + 1]! + D2;
      }
      d[i] = v;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      let v = d[i]!;
      if (v === 0) continue;
      if (c < cols - 1 && d[i + 1]! + D1 < v) v = d[i + 1]! + D1;
      if (r < rows - 1) {
        if (d[i + cols]! + D1 < v) v = d[i + cols]! + D1;
        if (c < cols - 1 && d[i + cols + 1]! + D2 < v) v = d[i + cols + 1]! + D2;
        if (c > 0 && d[i + cols - 1]! + D2 < v) v = d[i + cols - 1]! + D2;
      }
      d[i] = v;
    }
  }
}

/** Grid vertex index nearest to world (x, z), clamped to the grid. */
export function vertexIndex(grid: Heightfield, x: number, z: number): number {
  let c = Math.floor((x - grid.originX) / grid.cell + 0.5);
  let r = Math.floor((z - grid.originZ) / grid.cell + 0.5);
  if (c < 0) c = 0;
  else if (c >= grid.cols) c = grid.cols - 1;
  if (r < 0) r = 0;
  else if (r >= grid.rows) r = grid.rows - 1;
  return r * grid.cols + c;
}

/** World x of vertex index i. */
export function vertexX(grid: Heightfield, i: number): number {
  return grid.originX + (i % grid.cols) * grid.cell;
}

/** World z of vertex index i. */
export function vertexZ(grid: Heightfield, i: number): number {
  return grid.originZ + Math.floor(i / grid.cols) * grid.cell;
}
