// Landmarks of one island site: raft slip, wreck, campfire, chest, spawns, cave, spring, secret chest.
// Owner: island.
//
// Order (generate.ts drives it): chooseCore picks raft → wreck → camp together (each choice must leave room for
// the next: wreck 13–24 m from the raft, camp CAMP_FROM_WRECK_MIN..MAX inland of the wreck and 11–26 m from the
// raft, straight walkable lines wreck→camp→raft), flattenCore levels them, then the cave, spring and secret
// chest are picked among vertices reachable on foot from the camp (walk.ts), and finally the chest and spawns.
// Gameplay positions use only + − × ÷ and Math.sqrt (directions come from rational.ts, never from angles);
// the raft / wreck `yaw` are cosmetic and use Math.atan2.

import {
  CAMP_FROM_WRECK_MAX,
  CAMP_FROM_WRECK_MIN,
  CHEST_FROM_FIRE,
  SHELTER_RADIUS,
  WORLD_EDGE_MARGIN,
} from "../constants.js";
import { heightAt, normalAt } from "./heightfield.js";
import { hash01 } from "./noise.js";
import { DIRS32, DIRS8, ROT_16, ROT_37, ROT_M16, ROT_M37, rotX, rotZ, type Rot } from "./rational.js";
import { flattenArea, vertexIndex, vertexX, vertexZ, type Terrain } from "./terrain.js";
import { segmentWalkable } from "./walk.js";
import type { Vec3Like } from "../types.js";
import type { Heightfield, XZ } from "./types.js";

/** Raft, wreck and camp of one site, with the seaward unit directions measured at the raft and the wreck. */
export interface CoreSite {
  raft: XZ;
  raftDir: XZ;
  wreck: XZ;
  wreckDir: XZ;
  camp: XZ;
}

/** Cave plus the unit uphill direction at its mouth (the back wall side). */
export interface CaveSpot {
  x: number;
  z: number;
  radius: number;
  up: XZ;
}

const scratchN: Vec3Like = { x: 0, y: 1, z: 0 };

/** Raft slip plane: height at the raft center and its seaward tilt (m per m). */
const RAFT_H = 0.14;
const RAFT_TILT = 0.1;
/** Wreck beach plane. */
const WRECK_H = 0.3;
const WRECK_TILT = 0.07;
/** Flatten radii (inner = fully level, outer = blended back to the terrain). */
const RAFT_FLAT = { inner: 3.2, outer: 6.5 } as const;
const WRECK_FLAT = { inner: 4.5, outer: 8 } as const;
const CAMP_FLAT = { inner: 4.2, outer: 7.5 } as const;
const CAVE_FLAT = { inner: 1.8, outer: 4.2 } as const;
const SPRING_FLAT = { inner: 1.2, outer: 3 } as const;

function dist(a: XZ, b: XZ): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Unit downhill (seaward) direction at (x, z) from ±2 m central differences; falls back to "away from center". */
export function seaward(grid: Heightfield, x: number, z: number, cx: number, cz: number): XZ {
  const gx = heightAt(grid, x + 2, z) - heightAt(grid, x - 2, z);
  const gz = heightAt(grid, x, z + 2) - heightAt(grid, x, z - 2);
  const len = Math.sqrt(gx * gx + gz * gz);
  if (len > 1e-3) return { x: -gx / len, z: -gz / len };
  const ox = x - cx;
  const oz = z - cz;
  const ol = Math.sqrt(ox * ox + oz * oz);
  return ol > 1e-6 ? { x: ox / ol, z: oz / ol } : { x: 1, z: 0 };
}

/** Any vertex within `r` of (x, z) (center + 8 directions) belongs to a cliff wall. */
function nearCliff(t: Terrain, x: number, z: number, r: number): boolean {
  if (t.lip[vertexIndex(t.grid, x, z)]! > 1.01) return true;
  for (const d of DIRS8) {
    if (t.lip[vertexIndex(t.grid, x + d.x * r, z + d.z * r)]! > 1.01) return true;
    if (t.lip[vertexIndex(t.grid, x + d.x * r * 0.5, z + d.z * r * 0.5)]! > 1.01) return true;
  }
  return false;
}

/** Walkable bounds of the grid (IslandDef.bounds). */
function innerBounds(grid: Heightfield): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return {
    minX: grid.originX + WORLD_EDGE_MARGIN,
    maxX: grid.originX + (grid.cols - 1) * grid.cell - WORLD_EDGE_MARGIN,
    minZ: grid.originZ + WORLD_EDGE_MARGIN,
    maxZ: grid.originZ + (grid.rows - 1) * grid.cell - WORLD_EDGE_MARGIN,
  };
}

/** A ray from (x, z) along (dx, dz) meets no land between 4 and 38 m (leaving the walkable bounds = open sea). */
function rayOpen(grid: Heightfield, x: number, z: number, dx: number, dz: number): boolean {
  const b = innerBounds(grid);
  for (let s = 4; s <= 38; s += 2) {
    const px = x + dx * s;
    const pz = z + dz * s;
    if (px < b.minX || px > b.maxX || pz < b.minZ || pz > b.maxZ) return true;
    if (heightAt(grid, px, pz) >= 0) return false;
  }
  return true;
}

const FAN: ReadonlyArray<{ rot: Rot | null; w: number }> = [
  { rot: null, w: 2 },
  { rot: ROT_16, w: 1.5 },
  { rot: ROT_M16, w: 1.5 },
  { rot: ROT_37, w: 1 },
  { rot: ROT_M37, w: 1 },
];

/** Weighted share (0..1) of a 5-ray fan around `n` that reaches open sea; −1 when the center ray is blocked. */
function openness(grid: Heightfield, x: number, z: number, n: XZ): number {
  let sum = 0;
  let total = 0;
  for (const f of FAN) {
    const dx = f.rot ? rotX(n.x, n.z, f.rot) : n.x;
    const dz = f.rot ? rotZ(n.x, n.z, f.rot) : n.z;
    const open = rayOpen(grid, x, z, dx, dz);
    if (!f.rot && !open) return -1;
    total += f.w;
    if (open) sum += f.w;
  }
  return sum / total;
}

interface Option {
  i: number;
  x: number;
  z: number;
  n: XZ;
  score: number;
}

function byScore(a: Option, b: Option): number {
  return b.score - a.score || a.i - b.i;
}

/**
 * Search limits, tried in order: STRICT (the intended layout), RELAXED (wider distances), LAST (also beaches
 * near cliffs and rafts without a fully open sea view). Every tier keeps the walkable wreck→camp→raft lines.
 */
interface Limits {
  raftMaxH: number;
  /** Raft / wreck candidates must be this far from any cliff wall (0 = no check). */
  cliffClear: number;
  /** The raft's center ray must reach open sea. */
  needOpen: boolean;
  /** Duel: lowest allowed dot(seaward, away from the other island). */
  minFacing: number;
  wreckMin: number;
  wreckMax: number;
  campRaftMin: number;
  campRaftMax: number;
  campRough: number;
}

const STRICT: Limits = { raftMaxH: 0.45, cliffClear: 4, needOpen: true, minFacing: -0.2, wreckMin: 13, wreckMax: 24, campRaftMin: 11, campRaftMax: 26, campRough: 1 };
const RELAXED: Limits = { raftMaxH: 0.6, cliffClear: 2.5, needOpen: true, minFacing: -0.2, wreckMin: 11, wreckMax: 30, campRaftMin: 9, campRaftMax: 32, campRough: 1.6 };
const LAST: Limits = { raftMaxH: 0.6, cliffClear: 0, needOpen: false, minFacing: -0.2, wreckMin: 9, wreckMax: 40, campRaftMin: 9, campRaftMax: 40, campRough: 2.4 };

function raftOptions(t: Terrain, k: number, coast: Float32Array, away: XZ | null, seed: number, lim: Limits): Option[] {
  const g = t.grid;
  const h = g.heights;
  const plan = t.plans[k]!;
  const out: Option[] = [];
  for (let i = 0; i < h.length; i++) {
    if (t.owner[i] !== k) continue;
    const y = h[i]!;
    if (y < 0.02 || y > lim.raftMaxH || coast[i]! > 1.01) continue;
    const x = vertexX(g, i);
    const z = vertexZ(g, i);
    if (lim.cliffClear > 0 && nearCliff(t, x, z, lim.cliffClear)) continue;
    const n = seaward(g, x, z, plan.cx, plan.cz);
    const facing = away ? n.x * away.x + n.z * away.z : 0;
    if (away && facing < lim.minFacing) continue;
    const hIn5 = heightAt(g, x - n.x * 5, z - n.z * 5);
    if (hIn5 < 0.2 || hIn5 > 2.2) continue;
    if (heightAt(g, x + n.x * 2, z + n.z * 2) > 0.02) continue;
    const tx = -n.z;
    const tz = n.x;
    const hL = heightAt(g, x + tx * 3.5, z + tz * 3.5);
    const hR = heightAt(g, x - tx * 3.5, z - tz * 3.5);
    if (hL < -0.5 || hR < -0.5) continue;
    const open = openness(g, x, z, n);
    if (open < 0 && lim.needOpen) continue;
    const rise = (hIn5 - y) / 5;
    const pen = Math.abs(rise - 0.1) * 5 + Math.abs(hL - hR) * 0.6 + (Math.abs(hL - y) + Math.abs(hR - y)) * 0.3;
    const score = 3 * open - pen + 0.25 * hash01(i, k, seed) + 0.5 * facing;
    out.push({ i, x, z, n, score });
  }
  return out.sort(byScore);
}

function wreckOptions(t: Terrain, k: number, coast: Float32Array, raft: XZ, away: XZ | null, seed: number, lim: Limits): Option[] {
  const g = t.grid;
  const h = g.heights;
  const plan = t.plans[k]!;
  const out: Option[] = [];
  for (let i = 0; i < h.length; i++) {
    if (t.owner[i] !== k) continue;
    const y = h[i]!;
    if (y < 0.12 || y > 0.55) continue;
    const cd = coast[i]!;
    if (cd < 1.4 || cd > 5.5) continue;
    const x = vertexX(g, i);
    const z = vertexZ(g, i);
    const d = dist({ x, z }, raft);
    if (d < lim.wreckMin || d > lim.wreckMax) continue;
    if (lim.cliffClear > 0 && nearCliff(t, x, z, lim.cliffClear)) continue;
    const n = seaward(g, x, z, plan.cx, plan.cz);
    const facing = away ? n.x * away.x + n.z * away.z : 0;
    if (away && facing < lim.minFacing) continue;
    const hIn6 = heightAt(g, x - n.x * 6, z - n.z * 6);
    if (hIn6 < 0.35 || hIn6 > 3.5) continue;
    if (heightAt(g, x + n.x * 5, z + n.z * 5) > 0.1) continue;
    const hL = heightAt(g, x - n.z * 4, z + n.x * 4);
    const hR = heightAt(g, x + n.z * 4, z - n.x * 4);
    if (hL < -0.3 || hR < -0.3) continue;
    const rise = (hIn6 - y) / 6;
    const pen = Math.abs(hL - hR) * 0.5 + Math.abs(rise - 0.08) * 4;
    const score = -Math.abs(d - 17) * 0.06 - pen + 0.45 * hash01(i, k + 17, seed) + 0.3 * facing;
    out.push({ i, x, z, n, score });
  }
  return out.sort(byScore);
}

const CAMP_RINGS: ReadonlyArray<number> = (() => {
  const out: number[] = [];
  const span = CAMP_FROM_WRECK_MAX - CAMP_FROM_WRECK_MIN;
  for (let s = 0; s < 4; s++) out.push(CAMP_FROM_WRECK_MIN + (span * (s + 0.5)) / 4);
  return out;
})();

function campFor(t: Terrain, k: number, coast: Float32Array, wreck: Option, raft: XZ, seed: number, lim: Limits): XZ | null {
  const g = t.grid;
  let best: XZ | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let di = 0; di < DIRS32.length; di++) {
    const dir = DIRS32[di]!;
    const inland = -(dir.x * wreck.n.x + dir.z * wreck.n.z);
    if (inland < 0.25) continue;
    for (let ri = 0; ri < CAMP_RINGS.length; ri++) {
      const r = CAMP_RINGS[ri]!;
      const p = { x: wreck.x + dir.x * r, z: wreck.z + dir.z * r };
      const vi = vertexIndex(g, p.x, p.z);
      if (t.owner[vi] !== k) continue;
      const y = heightAt(g, p.x, p.z);
      if (y < 0.55 || y > 4.5 || g.heights[vi]! < 0 || coast[vi]! < 3) continue;
      const dcr = dist(p, raft);
      if (dcr < lim.campRaftMin || dcr > lim.campRaftMax) continue;
      if (lim.cliffClear > 0 && nearCliff(t, p.x, p.z, lim.cliffClear + 1)) continue;
      let rough = 0;
      for (let a = 0; a < 4; a++) {
        const d = DIRS8[a * 2]!;
        const dh = Math.abs(heightAt(g, p.x + d.x * 2.5, p.z + d.z * 2.5) - y);
        if (dh > rough) rough = dh;
      }
      if (rough > lim.campRough) continue;
      if (!segmentWalkable(g, wreck, p, -0.3) || !segmentWalkable(g, p, raft, -0.3)) continue;
      const score =
        -Math.abs(dcr - 15) * 0.08 - rough * 1.5 - Math.max(0, y - 1.6) * 0.3 + 0.3 * hash01(di, ri + 31 * k, seed) + inland * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}

/**
 * Raft (flattest open-facing beach cell at the waterline), wreck (beach 13–24 m from it) and camp (8–12 m
 * inland of the wreck) of island `k`. `away` (duel) is the unit direction pointing away from the other island:
 * the raft and the wreck never face the strait. `coast` = coastDistance() of the current terrain.
 */
export function chooseCore(t: Terrain, k: number, coast: Float32Array, away: XZ | null, seed: number): CoreSite {
  for (const lim of [STRICT, RELAXED, LAST]) {
    const rafts = raftOptions(t, k, coast, away, seed, lim);
    for (let a = 0; a < rafts.length && a < 14; a++) {
      const raft = rafts[a]!;
      const wrecks = wreckOptions(t, k, coast, raft, away, seed, lim);
      for (let b = 0; b < wrecks.length && b < 10; b++) {
        const wreck = wrecks[b]!;
        const camp = campFor(t, k, coast, wreck, raft, seed, lim);
        if (camp) return { raft: { x: raft.x, z: raft.z }, raftDir: raft.n, wreck: { x: wreck.x, z: wreck.z }, wreckDir: wreck.n, camp };
      }
    }
  }
  return emergencyCore(t, k, coast, away);
}

/**
 * Last resort (not hit in 1000 solo / 200 duel test seeds): the lowest coastal vertex facing away from the
 * other island, the wreck 13 m along the beach, the camp 10 m inland of it.
 */
function emergencyCore(t: Terrain, k: number, coast: Float32Array, away: XZ | null): CoreSite {
  const g = t.grid;
  const plan = t.plans[k]!;
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < g.heights.length; i++) {
    const y = g.heights[i]!;
    if (t.owner[i] !== k || y < 0.02 || coast[i]! > 1.5) continue;
    const n = seaward(g, vertexX(g, i), vertexZ(g, i), plan.cx, plan.cz);
    const score = (away ? 2 * (n.x * away.x + n.z * away.z) : 0) - y;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  const rx = best >= 0 ? vertexX(g, best) : plan.cx + 20;
  const rz = best >= 0 ? vertexZ(g, best) : plan.cz;
  const n = seaward(g, rx, rz, plan.cx, plan.cz);
  const wreck = { x: rx - n.z * 13 - n.x * 2, z: rz + n.x * 13 - n.z * 2 };
  return { raft: { x: rx, z: rz }, raftDir: n, wreck, wreckDir: n, camp: { x: wreck.x - n.x * 10, z: wreck.z - n.z * 10 } };
}

/** Level the raft slip, the wreck beach and the camp clearing (call clampSlopes afterwards). */
export function flattenCore(t: Terrain, core: CoreSite): void {
  const g = t.grid;
  flattenArea(g, core.raft.x, core.raft.z, RAFT_FLAT.inner, RAFT_FLAT.outer, RAFT_H, RAFT_TILT, core.raftDir.x, core.raftDir.z);
  flattenArea(g, core.wreck.x, core.wreck.z, WRECK_FLAT.inner, WRECK_FLAT.outer, WRECK_H, WRECK_TILT, core.wreckDir.x, core.wreckDir.z);
  let sum = heightAt(g, core.camp.x, core.camp.z);
  for (const d of DIRS8) sum += heightAt(g, core.camp.x + d.x * 2.5, core.camp.z + d.z * 2.5);
  let ch = sum / 9;
  if (ch < 0.8) ch = 0.8;
  else if (ch > 4.2) ch = 4.2;
  flattenArea(g, core.camp.x, core.camp.z, CAMP_FLAT.inner, CAMP_FLAT.outer, ch);
}

/** Summit (highest vertex) of island k. */
export function summitOf(t: Terrain, k: number): XZ & { y: number } {
  const i = t.summit[k]!;
  return { x: vertexX(t.grid, i), z: vertexZ(t.grid, i), y: t.grid.heights[i]! };
}

/** Unit uphill direction and slope (m per m) from ±2 m central differences. */
function uphill(grid: Heightfield, x: number, z: number): { x: number; z: number; m: number } {
  const gx = (heightAt(grid, x + 2, z) - heightAt(grid, x - 2, z)) / 4;
  const gz = (heightAt(grid, x, z + 2) - heightAt(grid, x, z - 2)) / 4;
  const m = Math.sqrt(gx * gx + gz * gz);
  return m > 1e-6 ? { x: gx / m, z: gz / m, m } : { x: 1, z: 0, m: 0 };
}

/**
 * Cave: a reachable spot at the foot of a slope (the hill rises ≥ 1.3 m within 4 m behind it), away from the
 * camp / raft / wreck and the summit; null when the island has no such slope. Flattens its floor.
 */
export function chooseCave(t: Terrain, k: number, core: CoreSite, reach: Uint8Array, seed: number): CaveSpot | null {
  const g = t.grid;
  const h = g.heights;
  const top = summitOf(t, k);
  let best: CaveSpot | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < h.length; i++) {
    if (t.owner[i] !== k || !reach[i]) continue;
    const y = h[i]!;
    if (y < 1 || y > top.y * 0.72) continue;
    const p = { x: vertexX(g, i), z: vertexZ(g, i) };
    if (dist(p, top) < 7 || dist(p, core.camp) < 14 || dist(p, core.raft) < 12 || dist(p, core.wreck) < 12) continue;
    const up = uphill(g, p.x, p.z);
    if (up.m < 0.28 || up.m > 1.05) continue;
    const back = heightAt(g, p.x + up.x * 4, p.z + up.z * 4) - y;
    if (back < 1.3) continue;
    if (heightAt(g, p.x - up.x * 3, p.z - up.z * 3) < 0.25) continue;
    const cliffy = nearCliff(t, p.x, p.z, 5) ? 0.3 : 0;
    const score = (back < 3 ? back : 3) * 0.4 + 0.6 * hash01(i, 71 + k, seed) + cliffy;
    if (score > bestScore) {
      bestScore = score;
      best = { x: p.x, z: p.z, radius: SHELTER_RADIUS, up: { x: up.x, z: up.z } };
    }
  }
  if (best) flattenArea(g, best.x, best.z, CAVE_FLAT.inner, CAVE_FLAT.outer, heightAt(g, best.x, best.z));
  return best;
}

/**
 * Spring: inland and reachable — most of the time high on the hill, sometimes in a valley, occasionally inside
 * the cave. Never on the summit vertex itself (the peak height stays intact). Flattens a small pool.
 */
export function chooseSpring(
  t: Terrain,
  k: number,
  core: CoreSite,
  cave: CaveSpot | null,
  reach: Uint8Array,
  coast: Float32Array,
  rng: () => number,
): XZ {
  const g = t.grid;
  const h = g.heights;
  const top = summitOf(t, k);
  const roll = rng();
  if (cave && roll < 0.18) return { x: cave.x + cave.up.x * 1.2, z: cave.z + cave.up.z * 1.2 };
  const hillMode = roll < 0.72;
  const all: XZ[] = [];
  const picked: XZ[] = [];
  for (const strict of [true, false]) {
    for (let i = 0; i < h.length; i++) {
      if (t.owner[i] !== k || !reach[i]) continue;
      const y = h[i]!;
      if (y < (strict ? 1.2 : 0.8) || y > top.y - 0.7) continue;
      if (coast[i]! < (strict ? 6 : 3)) continue;
      const p = { x: vertexX(g, i), z: vertexZ(g, i) };
      if (dist(p, top) < 3.5) continue;
      if (dist(p, core.camp) < (strict ? 14 : 8) || dist(p, core.raft) < (strict ? 12 : 8) || dist(p, core.wreck) < (strict ? 10 : 6)) continue;
      if (cave && dist(p, cave) < 7) continue;
      if (normalAt(g, p.x, p.z, scratchN).y < 0.75) continue;
      all.push(p);
      if (hillMode ? y >= top.y * 0.55 : y <= top.y * 0.5) picked.push(p);
    }
    if (all.length > 0) break;
  }
  const list = picked.length > 0 ? picked : all;
  const spring = list.length > 0 ? list[Math.floor(rng() * list.length)]! : { x: core.camp.x - core.wreckDir.x * 6, z: core.camp.z - core.wreckDir.z * 6 };
  flattenArea(g, spring.x, spring.z, SPRING_FLAT.inner, SPRING_FLAT.outer, heightAt(g, spring.x, spring.z));
  return spring;
}

/** Secret chest: a reachable, dry, level spot among the most remote ones (far from camp, raft and wreck). */
export function chooseSecretChest(
  t: Terrain,
  k: number,
  core: CoreSite,
  spring: XZ,
  cave: CaveSpot | null,
  reach: Uint8Array,
  coast: Float32Array,
  rng: () => number,
): XZ {
  const g = t.grid;
  const h = g.heights;
  const top = summitOf(t, k);
  const cands: { p: XZ; s: number }[] = [];
  let bestS = 0;
  for (let i = 0; i < h.length; i++) {
    if (t.owner[i] !== k || !reach[i]) continue;
    if (h[i]! < 0.35 || coast[i]! < 2) continue;
    const p = { x: vertexX(g, i), z: vertexZ(g, i) };
    if (dist(p, spring) < 6 || dist(p, top) < 2 || (cave && dist(p, cave) < 6)) continue;
    if (normalAt(g, p.x, p.z, scratchN).y < 0.8) continue;
    const s = Math.min(dist(p, core.camp), dist(p, core.raft), dist(p, core.wreck));
    cands.push({ p, s });
    if (s > bestS) bestS = s;
  }
  const pool = cands.filter((c) => c.s >= bestS * 0.85);
  if (pool.length === 0) return { x: spring.x + 3, z: spring.z };
  return pool[Math.floor(rng() * pool.length)]!.p;
}

/** Camp chest: CHEST_FROM_FIRE from the fire, toward the wreck turned ≈ 37° to one side (off the walking line). */
export function chestSpot(core: CoreSite, left: boolean): XZ {
  const dx = core.wreck.x - core.camp.x;
  const dz = core.wreck.z - core.camp.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  const ux = len > 1e-6 ? dx / len : 1;
  const uz = len > 1e-6 ? dz / len : 0;
  const rot = left ? ROT_37 : ROT_M37;
  return { x: core.camp.x + rotX(ux, uz, rot) * CHEST_FROM_FIRE, z: core.camp.z + rotZ(ux, uz, rot) * CHEST_FROM_FIRE };
}

/**
 * Six spawn points on dry sand around the wreck (≥ 1.6 m apart, clear of the wreck hull, the fire and the
 * chest), preferring the inland side nearest the wreck.
 */
export function chooseSpawns(t: Terrain, k: number, core: CoreSite, chest: XZ, count = 6): XZ[] {
  const g = t.grid;
  const out: XZ[] = [];
  for (const maxY of [0.7, 1.6, 3]) {
    const cands: { p: XZ; s: number; k: number }[] = [];
    for (const r of [3, 3.8, 4.6, 5.4, 6.2, 7]) {
      for (const d of DIRS32) {
        const p = { x: core.wreck.x + d.x * r, z: core.wreck.z + d.z * r };
        if (t.owner[vertexIndex(g, p.x, p.z)] !== k) continue;
        const y = heightAt(g, p.x, p.z);
        if (y < 0.1 || y > maxY) continue;
        if (normalAt(g, p.x, p.z, scratchN).y < 0.85) continue;
        if (dist(p, chest) < 1.6 || dist(p, core.camp) < 1.8) continue;
        const inland = -(d.x * core.wreckDir.x + d.z * core.wreckDir.z);
        cands.push({ p, s: r + (1 - inland) * 0.7, k: cands.length });
      }
    }
    cands.sort((a, b) => a.s - b.s || a.k - b.k);
    for (const c of cands) {
      if (out.length >= count) break;
      if (out.every((q) => dist(q, c.p) >= 1.6)) out.push(c.p);
    }
    if (out.length >= count) break;
  }
  return out;
}

/** Cosmetic yaw that faces along the unit direction (dx, dz) (yaw 0 faces −Z, forward = (−sin, −cos)). */
export function yawToward(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz); // cosmetic-trig: yaw is display-only
}

/**
 * Cosmetic helper for the renderer: unit direction from a cave's center toward its open side (downhill), from
 * the terrain sampled on a ring just outside the leveled floor. The back wall is the opposite direction.
 */
export function caveFacing(grid: Heightfield, cave: XZ & { radius: number }): XZ {
  let ux = 0;
  let uz = 0;
  const r = cave.radius + 1.5;
  for (const d of DIRS32) {
    const y = heightAt(grid, cave.x + d.x * r, cave.z + d.z * r);
    ux += d.x * y;
    uz += d.z * y;
  }
  const len = Math.sqrt(ux * ux + uz * uz);
  return len > 1e-6 ? { x: -ux / len, z: -uz / len } : { x: 0, z: 1 };
}
