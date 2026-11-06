// Island shape: per-island plan (seeded parameters) and its height raster in island-local coordinates.
// Owner: island.
//
// One island = an elliptical mask (semi-axes 0.85–1.15 × ISLAND_RADIUS, rotated by a rational rotation from
// rational.ts) whose coast radius is perturbed by a low-frequency "ring" noise (noise sampled on the unit circle
// of directions → big bays and capes, no angles involved) plus a small positional wiggle. Every vertex gets a
// signed distance to the coast `delta` (meters, + inland) and from it:
//   - base: a wide beach ramp (sand band ≈ 0..0.6 m), then a gentle lowland rise; under water a walkable shelf
//     (0..−0.6 m) that drops to SEA_FLOOR_Y;
//   - hill: a low rolling lowland — an inland plateau with very-low-frequency undulation (swells and shallow
//     dips), a few soft knolls / dunes, one or two small flat-topped rock tors (steep sides: cave sites) and one
//     broad, gentle main rise around an off-center summit (volcanic: a cone with a crater), plus fbm2 / ridged2
//     detail (BIOMES[b].rugged) — unscaled, the terrain stage scales it so the summit lands at the plan's peak
//     (the biome's range inside PEAK_MIN..MAX);
//   - terrace: coastal bluffs in "cliff" sectors (rocky / volcanic), allowed to be steeper via `lip`;
//   - crater: a summit dip (volcanic).
// Local coordinates are integers relative to an integer island center, so a raster can be computed once and
// pasted into the world grid at any integer offset (the duel layout measures the strait that way).
// Deterministic: integer-hash noise, + − × ÷, Math.sqrt / Math.floor only.

import { BIOMES, ISLAND_RADIUS, PEAK_MAX, PEAK_MIN, SEA_FLOOR_Y } from "../constants.js";
import type { Biome } from "../types.js";
import { fbm2, mulberry32, ridged2, smoothstep, subSeed } from "./noise.js";
import { DIRS32, ISLAND_ROTATIONS, type Rot } from "./rational.js";
import type { XZ } from "./types.js";

/** Terrain look per biome (generator-only tuning; gameplay numbers live in constants.ts). */
export interface BiomeStyle {
  /** Ring-noise amplitude of the coast radius (fraction of the radius, peak to peak). */
  coastAmp: number;
  /** Positional coast wiggle (meters, ±). */
  wiggle: number;
  /** Beach ramp width (m); the sand band (< BEACH_MAX_Y) is roughly 0.7 of it. */
  beachW: number;
  /** Walkable underwater shelf width (m) before the drop-off. */
  shelfW: number;
  /** Approximate share of the coastline with cliffs (0 = none). */
  cliffShare: number;
  /** Cliff (bluff) height above the beach (m). */
  cliffH: number;
  /** Main rise radius (fraction of the mean island radius) and weight (hill units). */
  domeR: number;
  domeW: number;
  /** 0 = rounded rise, 1 = straight cone. */
  cone: number;
  /** Inland plateau level (hill units) and its low-frequency undulation amplitude (±, hill units). */
  plateau: number;
  roll: number;
  /** Soft knolls / dunes: count and height (hill units). */
  knolls: number;
  knollH: number;
  /** Small flat-topped rock tors (steep sides, cave sites): count and height (hill units). */
  tors: number;
  torH: number;
  /** Fine detail amplitude (hill units, ±). */
  detail: number;
  /** Lowland bias: hill × (1 − k + k·hill) keeps most land low (swamp). */
  lowland: number;
  /** Summit crater depth (m), 0 = none. */
  crater: number;
  /** Summit height range (m), inside PEAK_MIN..PEAK_MAX. */
  peakLo: number;
  peakHi: number;
}

export const BIOME_STYLES: Readonly<Record<Biome, BiomeStyle>> = {
  tropic: {
    coastAmp: 0.55, wiggle: 2.4, beachW: 11, shelfW: 6.5, cliffShare: 0, cliffH: 0,
    domeR: 0.62, domeW: 0.55, cone: 0, plateau: 0.34, roll: 0.16, knolls: 4, knollH: 0.3, tors: 1, torH: 0.42, detail: 0.05,
    lowland: 0.1, crater: 0, peakLo: 4.4, peakHi: 5.4,
  },
  rocky: {
    coastAmp: 0.65, wiggle: 3, beachW: 7, shelfW: 4.2, cliffShare: 0.42, cliffH: 3, domeR: 0.55, domeW: 0.5, cone: 0.15,
    plateau: 0.36, roll: 0.18, knolls: 3, knollH: 0.3, tors: 2, torH: 0.45, detail: 0.08, lowland: 0, crater: 0, peakLo: 4.8, peakHi: 5.9,
  },
  swamp: {
    coastAmp: 0.6, wiggle: 3.4, beachW: 9, shelfW: 7.5, cliffShare: 0, cliffH: 0, domeR: 0.6, domeW: 0.55, cone: 0,
    plateau: 0.3, roll: 0.2, knolls: 5, knollH: 0.28, tors: 1, torH: 0.48, detail: 0.04, lowland: 0.35, crater: 0, peakLo: 4.1, peakHi: 4.8,
  },
  volcanic: {
    coastAmp: 0.45, wiggle: 2.2, beachW: 8, shelfW: 4.6, cliffShare: 0.28, cliffH: 2.4, domeR: 0.42, domeW: 0.8, cone: 0.6,
    plateau: 0.24, roll: 0.12, knolls: 3, knollH: 0.18, tors: 1, torH: 0.3, detail: 0.06, lowland: 0.1, crater: 1.4, peakLo: 6, peakHi: 6.8,
  },
};

/** Underwater shelf depth at its outer edge (just past the SWIM_DEPTH walkable limit). */
const SHELF_DEPTH = 0.62;
/** Width of the drop-off from the shelf to the sea floor (m). */
const DROP_W = 10;
/** Inland (above the beach ramp) lowland rise (m) and its width. */
const LOWLAND_RISE = 0.7;
const LOWLAND_W = 18;
/** Beach ramp top (m). */
const BEACH_TOP = 0.7;
/** The coast radius is soft-capped: radii beyond START approach START + SPAN (keeps the shelf inside the grid). */
const CAP_START_SOLO = 51;
const CAP_START_DUEL = 48;
const CAP_SPAN = 6;
/** Cliff wall: the beach strip below it (m), and how much steeper than 1 m/m the clamp lets it be. */
const CLIFF_START = 1.2;
const CLIFF_LIP = 3.8;
/** Ring noise "radius" in noise space: ~2π·K lattice cells around the coast. */
const RING_K = 1.6;
const CLIFF_K = 1.15;
/** Rolling-lowland undulation frequency (1/m): swells and dips ~35 m across. */
const ROLL_F = 0.028;

/** Seeded parameters of one island. Positions are in meters; (cx, cz) is an integer world vertex. */
export interface IslandPlan {
  index: number;
  biome: Biome;
  style: BiomeStyle;
  rugged: number;
  cx: number;
  cz: number;
  /** Ellipse semi-axes along the rotated u / v axes. */
  ax: number;
  az: number;
  rot: Rot;
  /** sqrt(ax·az). */
  rm: number;
  /** Soft cap start for the coast radius. */
  capStart: number;
  /** Target summit height (the biome's peakLo..peakHi, inside PEAK_MIN..MAX). */
  peak: number;
  /** Main rise center (local) and radius. */
  hillX: number;
  hillZ: number;
  domeR: number;
  /** Knolls and tors (local centers, radius m, height in hill units, flat-top fraction of the radius). */
  bumps: Bump[];
  /**
   * Cliff threshold on the cliff ring noise (∞ when the biome has no cliffs): the (1 − cliffShare) quantile of
   * that noise around this island's coast, so cliffs never take more than the biome's share of the coastline.
   */
  cliffThr: number;
  seeds: { coast: number; wiggle: number; cliff: number; hill: number; ridge: number };
  /** Noise-space offsets (decorrelate islands sharing a seed). */
  off: number[];
}

/** A knoll (soft, flat = 0) or a tor (flat-topped, steep sides) on the lowland. */
export interface Bump {
  x: number;
  z: number;
  r: number;
  h: number;
  flat: number;
}

/**
 * Plan island `index` of a layout. Duel islands are elongated along z (the strait runs along z) and only lightly
 * rotated so two of them fit side by side in DUEL_GRID.
 */
export function planIsland(seed: number, index: number, biome: Biome, duel: boolean): IslandPlan {
  const rng = mulberry32(subSeed(seed, 200 + index));
  const style = BIOME_STYLES[biome];
  // Axes: one in 0.85..1.15, the other ≈ its reciprocal (±8%) so the area stays near π·R².
  const k1 = 0.85 + rng() * 0.3;
  let k2 = (1 / k1) * (0.92 + rng() * 0.16);
  if (k2 < 0.85) k2 = 0.85;
  else if (k2 > 1.15) k2 = 1.15;
  let ax = ISLAND_RADIUS * k1;
  let az = ISLAND_RADIUS * k2;
  let rot: Rot;
  if (duel) {
    if (ax > az) {
      const t = ax;
      ax = az;
      az = t;
    }
    const mild = ISLAND_ROTATIONS.filter((r) => r.c > 0.89);
    rot = mild[Math.floor(rng() * mild.length)]!;
  } else {
    rot = ISLAND_ROTATIONS[Math.floor(rng() * ISLAND_ROTATIONS.length)]!;
  }
  const rm = Math.sqrt(ax * az);
  let peak = style.peakLo + rng() * (style.peakHi - style.peakLo);
  if (peak < PEAK_MIN + 0.1) peak = PEAK_MIN + 0.1;
  else if (peak > PEAK_MAX - 0.1) peak = PEAK_MAX - 0.1;
  // Summit off-center (up to 0.3 rm).
  const hillX = (rng() * 2 - 1) * 0.3 * rm;
  const hillZ = (rng() * 2 - 1) * 0.3 * rm;
  // Knolls anywhere on the lowland (≤ 0.7 rm), tors a bit inland (0.2–0.6 rm) and off the main rise's top.
  const bumps: Bump[] = [];
  const spot = (lo: number, hi: number): XZ => {
    for (let a = 0; a < 24; a++) {
      const x = (rng() * 2 - 1) * hi * rm;
      const z = (rng() * 2 - 1) * hi * rm;
      const d2 = x * x + z * z;
      if (d2 <= hi * hi * rm * rm && d2 >= lo * lo * rm * rm) return { x, z };
    }
    return { x: lo * rm, z: 0 };
  };
  for (let k = 0; k < style.knolls; k++) {
    const p = spot(0, 0.7);
    bumps.push({ x: p.x, z: p.z, r: 8 + rng() * 8, h: style.knollH * (0.6 + rng() * 0.8), flat: 0 });
  }
  for (let k = 0; k < style.tors; k++) {
    let p = spot(0.2, 0.6);
    const dx = p.x - hillX;
    const dz = p.z - hillZ;
    if (dx * dx + dz * dz < 0.04 * rm * rm) p = { x: -p.x, z: -p.z };
    bumps.push({ x: p.x, z: p.z, r: 5 + rng() * 2.5, h: style.torH * (0.85 + rng() * 0.3), flat: 0.5 });
  }
  const off: number[] = [];
  for (let k = 0; k < 12; k++) off.push(rng() * 200 - 100);
  const cliffSeed = subSeed(seed, 320 + index);
  let cliffThr = Number.POSITIVE_INFINITY;
  if (style.cliffShare > 0) {
    const ring = DIRS32.map((d) => fbm2(d.x * CLIFF_K + off[4]!, d.z * CLIFF_K + off[5]!, cliffSeed, 2)).sort((a, b) => a - b);
    cliffThr = ring[Math.floor((1 - style.cliffShare) * ring.length)]!;
  }
  return {
    index,
    biome,
    style,
    rugged: BIOMES[biome].rugged,
    cx: 0,
    cz: 0,
    ax,
    az,
    rot,
    rm,
    capStart: duel ? CAP_START_DUEL : CAP_START_SOLO,
    peak,
    hillX,
    hillZ,
    domeR: style.domeR * rm,
    bumps,
    cliffThr,
    seeds: {
      coast: subSeed(seed, 300 + index),
      wiggle: subSeed(seed, 310 + index),
      cliff: cliffSeed,
      hill: subSeed(seed, 330 + index),
      ridge: subSeed(seed, 340 + index),
    },
    off,
  };
}

/** Height components of one island on a local (2·half+1)² vertex grid centered on the island center. */
export interface IslandRaster {
  plan: IslandPlan;
  half: number;
  size: number;
  /** Signed distance to the coast (m, + inland). */
  delta: Float64Array;
  /** Beach / lowland / shelf profile (no hills). */
  base: Float64Array;
  /** Unscaled hill field (land only, ≈ 0..1). */
  hill: Float64Array;
  /** Coastal bluff height (cliff sectors, land only). */
  terrace: Float64Array;
  /** Summit crater dip (m). */
  crater: Float64Array;
  /** Sea-floor noise weight: 0 near the coast → 1 in open water. */
  deep: Float64Array;
  /** Allowed slope (m per 1 m cell) for the slope clamp: 1 everywhere, steeper on cliff walls. */
  lip: Float32Array;
}

/** Rasterize `plan` on a local grid spanning [−half, half]² (integer offsets from the island center). */
export function rasterizeIsland(plan: IslandPlan, half: number): IslandRaster {
  const size = half * 2 + 1;
  const n = size * size;
  const r: IslandRaster = {
    plan,
    half,
    size,
    delta: new Float64Array(n),
    base: new Float64Array(n),
    hill: new Float64Array(n),
    terrace: new Float64Array(n),
    crater: new Float64Array(n),
    deep: new Float64Array(n),
    lip: new Float32Array(n),
  };
  const st = plan.style;
  const o = plan.off;
  const shelfW = st.shelfW;
  const floorDrop = -SEA_FLOOR_Y - SHELF_DEPTH;
  for (let lr = 0; lr < size; lr++) {
    const lz = lr - half;
    for (let lc = 0; lc < size; lc++) {
      const lx = lc - half;
      const i = lr * size + lc;
      const dist = Math.sqrt(lx * lx + lz * lz);
      const dx = dist > 1e-9 ? lx / dist : 1;
      const dz = dist > 1e-9 ? lz / dist : 0;
      const delta = coastDelta(plan, lx, lz, dist, dx, dz);
      r.delta[i] = delta;
      const cliff =
        plan.cliffThr === Number.POSITIVE_INFINITY
          ? 0
          : smoothstep(plan.cliffThr, plan.cliffThr + 0.07, fbm2(dx * CLIFF_K + o[4]!, dz * CLIFF_K + o[5]!, plan.seeds.cliff, 2));
      let lip = 1;
      if (cliff > 0) {
        const band = smoothstep(-1.5, 0, delta) * (1 - smoothstep(CLIFF_START + 3, CLIFF_START + 6, delta));
        lip = 1 + CLIFF_LIP * cliff * band;
      }
      r.lip[i] = lip;
      if (delta >= 0) {
        r.base[i] = BEACH_TOP * smoothstep(0, st.beachW, delta) + LOWLAND_RISE * smoothstep(st.beachW, st.beachW + LOWLAND_W, delta);
        r.hill[i] = hillAt(plan, lx, lz, delta);
        if (cliff > 0) {
          r.terrace[i] =
            cliff *
            st.cliffH *
            smoothstep(CLIFF_START, CLIFF_START + 1.1, delta) *
            (1 - smoothstep(CLIFF_START + 7, CLIFF_START + 16, delta));
        }
        if (st.crater > 0) {
          const hx = lx - plan.hillX;
          const hz = lz - plan.hillZ;
          const dh = Math.sqrt(hx * hx + hz * hz) / plan.domeR;
          r.crater[i] = st.crater * smoothstep(0.24, 0.09, dh);
        }
      } else {
        const w = -delta;
        r.base[i] = -SHELF_DEPTH * smoothstep(0, shelfW, w) - floorDrop * smoothstep(shelfW * 0.75, shelfW + DROP_W, w);
        r.deep[i] = smoothstep(shelfW + 3, shelfW + 13, w);
      }
    }
  }
  return r;
}

/** Signed distance (m, + inland) from local (lx, lz) to the noisy elliptical coast. */
function coastDelta(plan: IslandPlan, lx: number, lz: number, dist: number, dx: number, dz: number): number {
  const o = plan.off;
  // Direction in the ellipse frame → ellipse radius in that direction.
  const du = dx * plan.rot.c + dz * plan.rot.s;
  const dv = -dx * plan.rot.s + dz * plan.rot.c;
  const eu = du / plan.ax;
  const ev = dv / plan.az;
  const rEll = 1 / Math.sqrt(eu * eu + ev * ev);
  // Ring noise: sampled on a circle of directions (bays / capes).
  const ring = fbm2(dx * RING_K + o[0]!, dz * RING_K + o[1]!, plan.seeds.coast, 3);
  let rad = rEll * (1 + plan.style.coastAmp * (ring - 0.5));
  if (rad > plan.capStart) {
    const x = rad - plan.capStart;
    rad = plan.capStart + (CAP_SPAN * x) / (CAP_SPAN + x);
  }
  const wig = fbm2(lx * 0.09 + o[2]!, lz * 0.09 + o[3]!, plan.seeds.wiggle, 2);
  return rad - dist + plan.style.wiggle * (wig - 0.5) * 2;
}

/** Unscaled hill height at local (lx, lz), `delta` meters inland (≈ 0..1.4 hill units, ≥ 0). */
function hillAt(plan: IslandPlan, lx: number, lz: number, delta: number): number {
  const st = plan.style;
  const o = plan.off;
  const inland = smoothstep(st.beachW * 0.8, st.beachW + 16, delta);
  if (inland <= 0) return 0;
  // Broad main rise (a rounded swell, or a cone on volcanic islands).
  const hx = lx - plan.hillX;
  const hz = lz - plan.hillZ;
  const dh = Math.sqrt(hx * hx + hz * hz) / plan.domeR;
  const smooth = smoothstep(1, 0, dh);
  const cone = dh >= 1 ? 0 : 1 - dh;
  const dome = smooth + (cone - smooth) * st.cone;
  // Rolling lowland: plateau + very-low-frequency swells and shallow dips.
  const roll = fbm2(lx * ROLL_F + o[10]!, lz * ROLL_F + o[11]!, plan.seeds.hill + 1, 3);
  // Knolls / dunes (soft) and tors (flat tops, steep sides).
  let bumps = 0;
  for (const b of plan.bumps) {
    const bx = lx - b.x;
    const bz = lz - b.z;
    const d2 = bx * bx + bz * bz;
    if (d2 >= b.r * b.r) continue;
    bumps += b.h * smoothstep(b.r, b.r * b.flat, Math.sqrt(d2));
  }
  // Fine detail (rugged biomes: ridges).
  const n1 = fbm2(lx * 0.07 + o[6]!, lz * 0.07 + o[7]!, plan.seeds.hill, 3);
  const n2 = ridged2(lx * 0.05 + o[8]!, lz * 0.05 + o[9]!, plan.seeds.ridge, 3);
  const detail = n1 + (n2 - n1) * plan.rugged;
  let hill = inland * (st.plateau + st.roll * (roll - 0.5) * 2 + st.domeW * dome + bumps + st.detail * (detail - 0.5) * 2);
  if (hill < 0) hill = 0;
  hill *= 1 - st.lowland + st.lowland * hill;
  return hill;
}

/** Waterline crossings (delta = 0 between 4-neighbours, linearly interpolated), in local coordinates. */
export function coastPoints(r: IslandRaster): XZ[] {
  const out: XZ[] = [];
  const { size, half, delta } = r;
  for (let lr = 0; lr < size; lr++) {
    for (let lc = 0; lc < size; lc++) {
      const i = lr * size + lc;
      const a = delta[i]!;
      if (lc + 1 < size) {
        const b = delta[i + 1]!;
        if ((a >= 0) !== (b >= 0)) out.push({ x: lc - half + a / (a - b), z: lr - half });
      }
      if (lr + 1 < size) {
        const b = delta[i + size]!;
        if ((a >= 0) !== (b >= 0)) out.push({ x: lc - half, z: lr - half + a / (a - b) });
      }
    }
  }
  return out;
}

/**
 * Integer x distance D between the centers of a left and a right island (the right one shifted by `dz` in z)
 * such that the closest distance between their coastlines is as close as possible to `target`.
 */
export function solveStraitOffset(left: IslandRaster, right: IslandRaster, dz: number, target: number): number {
  const pl = coastPoints(left);
  const pr = coastPoints(right);
  let maxL = -1e9;
  let minR = 1e9;
  for (const p of pl) if (p.x > maxL) maxL = p.x;
  for (const p of pr) if (p.x < minR) minR = p.x;
  // Only the facing halves can be closest.
  const facingL = pl.filter((p) => p.x > maxL - 36);
  const facingR = pr.filter((p) => p.x < minR + 36);
  const gapAt = (d: number): number => {
    let best = 1e18;
    for (const a of facingL) {
      for (const b of facingR) {
        const ex = b.x + d - a.x;
        const ez = b.z + dz - a.z;
        const q = ex * ex + ez * ez;
        if (q < best) best = q;
      }
    }
    return Math.sqrt(best);
  };
  // At d0 the bounding boxes alone are `target` apart, so the true gap is ≥ target; walk d down from there.
  const d0 = Math.ceil(maxL - minR + target);
  let bestD = d0;
  let bestErr = Math.abs(gapAt(d0) - target);
  for (let d = d0 - 1; d > d0 - 48; d--) {
    const g = gapAt(d);
    const err = Math.abs(g - target);
    if (err < bestErr) {
      bestErr = err;
      bestD = d;
    }
    if (g < target - 1.5) break;
  }
  return bestD;
}
