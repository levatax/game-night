// Coast features of one island: shore cells (where night monsters climb out) and fish spots. Owner: island.
//
// Both are picked from water vertices by farthest-point sampling, so they spread evenly around the whole
// coastline whatever its shape (bays, capes, elongated islands). Positions are grid vertices: exact integers.

import { FIRE_LIGHT_RADIUS, FISH_SPOT_RADIUS } from "../constants.js";
import { heightAt } from "./heightfield.js";
import { DIRS8, diamondAngle } from "./rational.js";
import { distanceField, vertexX, vertexZ, type Terrain } from "./terrain.js";
import type { XZ } from "./types.js";
import { WALK_MIN_Y } from "./walk.js";

/** Shore cells wanted per island (contract minimum is 24). */
export const SHORE_TARGET = 36;
/** Shore cell water depth band (m). */
export const SHORE_DEPTH_MIN = 0.3;
export const SHORE_DEPTH_MAX = 1.5;
/** Fish spot center depth band (m) and minimum spacing. */
export const FISH_DEPTH_MIN = 1;
export const FISH_DEPTH_MAX = 3;
export const FISH_SPOT_SPACING = 8;

function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/** Shore cells are looked for up to this far (m) from their coastal anchor (wide shelves push them out). */
const SHORE_SEARCH = 10;
/** Max distance (m) from standable ground to a fish spot center, widened step by step on wide shelves. */
const FISH_REACH: ReadonlyArray<number> = [3.5, 5, 7, 9];

/**
 * Shore cells of island k, spread along the coastline itself: coastal land vertices (land with a water
 * neighbour) are sampled evenly by farthest-point sampling (starting farthest from the camp), and each sample
 * takes the nearest water vertex 0.3–1.5 m deep (within SHORE_SEARCH, outside the campfire light ring + 2 m,
 * ≥ 2 m from the cells already taken). Sorted around the island center.
 */
export function chooseShore(t: Terrain, k: number, coast: Float32Array, camp: XZ): XZ[] {
  const g = t.grid;
  const h = g.heights;
  const keep = (FIRE_LIGHT_RADIUS + 2) * (FIRE_LIGHT_RADIUS + 2);
  const ax: number[] = [];
  const az: number[] = [];
  for (let i = 0; i < h.length; i++) {
    if (t.owner[i] !== k || h[i]! < 0 || coast[i]! > 1.01) continue;
    ax.push(vertexX(g, i));
    az.push(vertexZ(g, i));
  }
  const out: XZ[] = [];
  for (const want of [SHORE_TARGET, SHORE_TARGET * 2]) {
    out.length = 0;
    for (const a of farthestPoints(ax, az, camp, want, 2, null)) {
      const cell = nearestShoreCell(t, k, ax[a]!, az[a]!, camp, keep, out);
      if (cell) out.push(cell);
    }
    if (out.length >= SHORE_TARGET) break;
  }
  const plan = t.plans[k]!;
  out.sort((a, b) => diamondAngle(a.x - plan.cx, a.z - plan.cz) - diamondAngle(b.x - plan.cx, b.z - plan.cz) || a.x - b.x || a.z - b.z);
  return out;
}

/** Nearest water vertex of island k in the shore depth band to (x0, z0), honoring the camp ring and spacing. */
function nearestShoreCell(t: Terrain, k: number, x0: number, z0: number, camp: XZ, keep: number, taken: XZ[]): XZ | null {
  const g = t.grid;
  const c0 = Math.round(x0 - g.originX);
  const r0 = Math.round(z0 - g.originZ);
  let best: XZ | null = null;
  let bestD = SHORE_SEARCH * SHORE_SEARCH + 1e-9;
  for (let r = r0 - SHORE_SEARCH; r <= r0 + SHORE_SEARCH; r++) {
    if (r < 0 || r >= g.rows) continue;
    for (let c = c0 - SHORE_SEARCH; c <= c0 + SHORE_SEARCH; c++) {
      if (c < 0 || c >= g.cols) continue;
      const i = r * g.cols + c;
      if (t.owner[i] !== k) continue;
      const y = g.heights[i]!;
      if (y > -SHORE_DEPTH_MIN - 0.02 || y < -SHORE_DEPTH_MAX + 0.02) continue;
      const x = g.originX + c * g.cell;
      const z = g.originZ + r * g.cell;
      const d = dist2(x, z, x0, z0);
      if (d >= bestD || dist2(x, z, camp.x, camp.z) < keep) continue;
      let free = true;
      for (const q of taken) {
        if (dist2(x, z, q.x, q.z) < 4) {
          free = false;
          break;
        }
      }
      if (!free) continue;
      bestD = d;
      best = { x, z };
    }
  }
  return best;
}

/**
 * Fish spots of island k: `count` spots in water 1–3 m deep, at least 3 m off the beach and close to ground of
 * that island a fisher can stand on (its beach or walkable shelf: 3.5 m, widened up to 9 m on wide shelves —
 * always well inside FISH_CAST_RANGE), the whole FISH_SPOT_RADIUS circle in water, ≥ FISH_SPOT_SPACING apart. The first is
 * the one nearest the camp (handy for the fisher bot), the rest spread around the coast with some randomness.
 */
export function chooseFishSpots(t: Terrain, k: number, coast: Float32Array, camp: XZ, count: number, rng: () => number): XZ[] {
  const g = t.grid;
  const h = g.heights;
  // Standable ground of this island only (its beach and walkable shelf; a duel sandbar doesn't count).
  const toStand = distanceField(g, (y, i) => y >= WALK_MIN_Y && t.owner[i] === k && t.sandbar[i] === 0);
  // Candidates per reach band, closest first: foamy water right off the beach, further out on wide shelves.
  const wet: number[] = [];
  for (let i = 0; i < h.length; i++) {
    if (t.owner[i] !== k) continue;
    const y = h[i]!;
    if (y > -FISH_DEPTH_MIN - 0.15 || y < -FISH_DEPTH_MAX + 0.15) continue;
    if (coast[i]! < 3 || toStand[i]! > FISH_REACH[FISH_REACH.length - 1]!) continue;
    const x = vertexX(g, i);
    const z = vertexZ(g, i);
    let ok = true;
    for (const d of DIRS8) {
      if (heightAt(g, x + d.x * FISH_SPOT_RADIUS, z + d.z * FISH_SPOT_RADIUS) > -0.15) {
        ok = false;
        break;
      }
    }
    if (ok) wet.push(i);
  }
  let picked: number[] = [];
  let xs: number[] = [];
  let zs: number[] = [];
  for (const reach of FISH_REACH) {
    xs = [];
    zs = [];
    for (const i of wet) {
      if (toStand[i]! > reach) continue;
      xs.push(vertexX(g, i));
      zs.push(vertexZ(g, i));
    }
    if (xs.length === 0) continue;
    // First: nearest to the camp.
    let first = 0;
    for (let j = 1; j < xs.length; j++) {
      if (dist2(xs[j]!, zs[j]!, camp.x, camp.z) < dist2(xs[first]!, zs[first]!, camp.x, camp.z)) first = j;
    }
    // The deterministic run decides whether this band is wide enough; the randomized one adds variety and falls
    // back to the deterministic choice when its random picks boxed it in.
    const plain = farthestPoints(xs, zs, null, count, FISH_SPOT_SPACING, null, first);
    if (plain.length < count && reach !== FISH_REACH[FISH_REACH.length - 1]) continue;
    const varied = farthestPoints(xs, zs, null, count, FISH_SPOT_SPACING, rng, first);
    picked = varied.length >= plain.length ? varied : plain;
    break;
  }
  return picked.map((j) => ({ x: xs[j]!, z: zs[j]! }));
}

/**
 * Greedy farthest-point sampling over candidates (xs, zs). Starts at `first` (or the candidate farthest from
 * `from`), then repeatedly adds the candidate whose distance to the chosen set is largest — or, with `rng`, a
 * random one among those within 75% of the largest. Stops at `count` or when nothing is ≥ `minSpacing` away.
 */
function farthestPoints(
  xs: number[],
  zs: number[],
  from: XZ | null,
  count: number,
  minSpacing: number,
  rng: (() => number) | null,
  first = -1,
): number[] {
  const n = xs.length;
  if (n === 0 || count <= 0) return [];
  let start = first;
  if (start < 0) {
    start = 0;
    if (from) {
      for (let j = 1; j < n; j++) {
        if (dist2(xs[j]!, zs[j]!, from.x, from.z) > dist2(xs[start]!, zs[start]!, from.x, from.z)) start = j;
      }
    }
  }
  const minD = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const out: number[] = [];
  let cur = start;
  const min2 = minSpacing * minSpacing;
  while (out.length < count) {
    out.push(cur);
    const cx = xs[cur]!;
    const cz = zs[cur]!;
    let best = -1;
    let bestD = -1;
    for (let j = 0; j < n; j++) {
      const d = dist2(xs[j]!, zs[j]!, cx, cz);
      if (d < minD[j]!) minD[j] = d;
      if (minD[j]! > bestD) {
        bestD = minD[j]!;
        best = j;
      }
    }
    if (best < 0 || bestD < min2) break;
    if (rng) {
      const floor = Math.max(min2, bestD * 0.5625); // (0.75 × distance)²
      const pool: number[] = [];
      for (let j = 0; j < n; j++) if (minD[j]! >= floor) pool.push(j);
      cur = pool[Math.floor(rng() * pool.length)]!;
    } else {
      cur = best;
    }
  }
  return out;
}
