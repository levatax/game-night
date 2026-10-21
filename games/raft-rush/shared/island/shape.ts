// Island shape: per-island plan (seeded parameters) and its height raster in island-local coordinates.
// Owner: island.
//
// One island = an elliptical mask (semi-axes 0.85–1.15 × ISLAND_RADIUS, rotated by a rational rotation from
// rational.ts) whose coast radius is perturbed by a low-frequency "ring" noise (noise sampled on the unit circle
// of directions → big bays and capes, no angles involved) plus a small positional wiggle. Every vertex gets a
// signed distance to the coast `delta` (meters, + inland) and from it:
//   - base: beach ramp (sand band ≈ 0..0.6 m), then a gentle lowland rise; under water a walkable shelf
//     (0..−0.6 m) that drops to SEA_FLOOR_Y;
//   - hill: main dome around an off-center summit + fbm2 / ridged2 detail (BIOMES[b].rugged) — unscaled, the
//     terrain stage scales it so the summit lands at the plan's peak (PEAK_MIN..MAX);
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
  /** Weight of the main dome against the detail noise. */
  domeW: number;
  /** 0 = rounded dome, 1 = straight cone. */
  cone: number;
  /** Lowland bias: hill × (1 − k + k·hill) keeps most land low (swamp). */
  lowland: number;
  /** Summit crater depth (m), 0 = none. */
  crater: number;
}

export const BIOME_STYLES: Readonly<Record<Biome, BiomeStyle>> = {
  tropic: { coastAmp: 0.7, wiggle: 2, beachW: 6, shelfW: 5.5, cliffShare: 0, cliffH: 0, domeW: 0.62, cone: 0, lowland: 0.2, crater: 0 },
  rocky: { coastAmp: 0.85, wiggle: 2.6, beachW: 3.8, shelfW: 3.4, cliffShare: 0.42, cliffH: 3.4, domeW: 0.45, cone: 0.15, lowland: 0, crater: 0 },
  swamp: { coastAmp: 0.8, wiggle: 3, beachW: 4.6, shelfW: 6.5, cliffShare: 0, cliffH: 0, domeW: 0.7, cone: 0, lowland: 0.6, crater: 0 },
  volcanic: { coastAmp: 0.55, wiggle: 1.8, beachW: 4.2, shelfW: 3.8, cliffShare: 0.28, cliffH: 2.6, domeW: 0.8, cone: 0.6, lowland: 0.15, crater: 1.8 },
};

/** Underwater shelf depth at its outer edge (just past the SWIM_DEPTH walkable limit). */
const SHELF_DEPTH = 0.62;
/** Width of the drop-off from the shelf to the sea floor (m). */
const DROP_W = 10;
/** Inland (above the beach ramp) lowland rise (m) and its width. */
const LOWLAND_RISE = 0.55;
const LOWLAND_W = 12;
/** Beach ramp top (m). */
const BEACH_TOP = 0.7;
/** The coast radius is soft-capped: radii beyond START approach START + SPAN (keeps the shelf inside the grid). */
const CAP_START_SOLO = 31;
const CAP_START_DUEL = 29;
const CAP_SPAN = 4;
/** Cliff wall: the beach strip below it (m), and how much steeper than 1 m/m the clamp lets it be. */
const CLIFF_START = 1.2;
const CLIFF_LIP = 3.8;
/** Ring noise "radius" in noise space: ~2π·K lattice cells around the coast. */
const RING_K = 1.6;
const CLIFF_K = 1.15;

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
  /** Target summit height (PEAK_MIN..MAX with a margin). */
  peak: number;
  /** Main dome center (local) and radius. */
  hillX: number;
  hillZ: number;
  domeR: number;
  /**
   * Cliff threshold on the cliff ring noise (∞ when the biome has no cliffs): the (1 − cliffShare) quantile of
   * that noise around this island's coast, so cliffs never take more than the biome's share of the coastline.
   */
  cliffThr: number;
  seeds: { coast: number; wiggle: number; cliff: number; hill: number; ridge: number };
  /** Noise-space offsets (decorrelate islands sharing a seed). */
  off: number[];
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
  const peak = PEAK_MIN + 0.4 + rng() * (PEAK_MAX - PEAK_MIN - 0.8);
  // Summit off-center (up to 0.3 rm), dome radius ~0.95 rm.
  const hillX = (rng() * 2 - 1) * 0.3 * rm;
  const hillZ = (rng() * 2 - 1) * 0.3 * rm;
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
    domeR: 0.95 * rm,
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
          r.crater[i] = st.crater * smoothstep(0.17, 0.06, dh);
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

/** Unscaled hill height at local (lx, lz), `delta` meters inland. */
function hillAt(plan: IslandPlan, lx: number, lz: number, delta: number): number {
  const st = plan.style;
  const o = plan.off;
  const inland = smoothstep(st.beachW * 0.5, st.beachW + 10, delta);
  if (inland <= 0) return 0;
  const hx = lx - plan.hillX;
  const hz = lz - plan.hillZ;
  const dh = Math.sqrt(hx * hx + hz * hz) / plan.domeR;
  const smooth = smoothstep(1, 0, dh);
  const cone = dh >= 1 ? 0 : 1 - dh;
  const dome = smooth + (cone - smooth) * st.cone;
  const n1 = fbm2(lx * 0.055 + o[6]!, lz * 0.055 + o[7]!, plan.seeds.hill, 4);
  const n2 = ridged2(lx * 0.042 + o[8]!, lz * 0.042 + o[9]!, plan.seeds.ridge, 4);
  const detail = n1 + (n2 - n1) * plan.rugged;
  let hill = inland * (st.domeW * dome + (1 - st.domeW) * detail * (0.3 + 0.7 * dome));
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
  const facingL = pl.filter((p) => p.x > maxL - 24);
  const facingR = pr.filter((p) => p.x < minR + 24);
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
  for (let d = d0 - 1; d > d0 - 30; d--) {
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
