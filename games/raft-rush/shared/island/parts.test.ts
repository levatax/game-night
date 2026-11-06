// Unit tests of the island generator's building blocks: rational directions, terrain sculpting, walkability,
// shape rasters and the strait solver, placement helpers. Owner: island.

import { describe, expect, it } from "vitest";
import { BASE_NODE_COUNTS, BIOMES, BIOME_IDS, ISLAND_RADIUS, MAX_WALK_NORMAL_Y, PEAK_MAX, PEAK_MIN, SEA_FLOOR_Y, SOLO_GRID } from "../constants.js";
import { createHeightfield, heightAt, normalAt } from "./heightfield.js";
import { distToSegment, nodeTargets } from "./placement.js";
import { DIRS16, DIRS32, DIRS8, ISLAND_ROTATIONS, diamondAngle, rotX, rotZ } from "./rational.js";
import { BIOME_STYLES, coastPoints, planIsland, rasterizeIsland, solveStraitOffset } from "./shape.js";
import { clampSlopes, coastDistance, flattenArea, vertexIndex, vertexX, vertexZ } from "./terrain.js";
import type { Heightfield } from "./types.js";
import { reachableFrom, segmentWalkable } from "./walk.js";

function grid(cols: number, rows: number, f: (x: number, z: number) => number): Heightfield {
  const g = createHeightfield(cols, rows, 1, -(cols - 1) / 2, -(rows - 1) / 2);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) g.heights[r * cols + c] = Math.fround(f(g.originX + c, g.originZ + r));
  return g;
}

describe("rational directions", () => {
  it("DIRS32 are unit vectors in increasing angle, ~11.25° apart", () => {
    expect(DIRS32.length).toBe(32);
    expect(DIRS16.length).toBe(16);
    expect(DIRS8.length).toBe(8);
    let prev = -Infinity;
    DIRS32.forEach((d, k) => {
      expect(Math.hypot(d.x, d.z)).toBeCloseTo(1, 12);
      const a = Math.atan2(d.z, d.x);
      const ang = a < -1e-9 ? a + 2 * Math.PI : a;
      expect(ang).toBeGreaterThan(prev);
      expect(Math.abs(ang - (k * Math.PI) / 16)).toBeLessThan(0.02);
      prev = ang;
    });
  });

  it("island rotations are exact unit rotations covering the half circle", () => {
    const angles = new Set<number>();
    for (const r of ISLAND_ROTATIONS) {
      expect(r.c * r.c + r.s * r.s).toBeCloseTo(1, 14);
      angles.add(Math.round((Math.atan2(r.s, r.c) * 180) / Math.PI));
      // rotX / rotZ rotate (1, 0) onto (c, s).
      expect(rotX(1, 0, r)).toBe(r.c);
      expect(rotZ(1, 0, r)).toBe(r.s);
    }
    expect(angles.size).toBeGreaterThanOrEqual(50);
    expect(Math.min(...angles)).toBeLessThanOrEqual(-80);
    expect(Math.max(...angles)).toBeGreaterThanOrEqual(80);
  });

  it("diamondAngle orders points exactly like atan2", () => {
    const pts: [number, number][] = [];
    for (let k = 0; k < 500; k++) pts.push([Math.cos(k * 1.7) * (1 + (k % 7)), Math.sin(k * 1.7) * (1 + (k % 7))]);
    const norm = (a: number): number => (a < 0 ? a + 2 * Math.PI : a);
    const byAtan = [...pts].sort((a, b) => norm(Math.atan2(a[1], a[0])) - norm(Math.atan2(b[1], b[0])));
    const byDiamond = [...pts].sort((a, b) => diamondAngle(a[0], a[1]) - diamondAngle(b[0], b[1]));
    expect(byDiamond).toEqual(byAtan);
    expect(diamondAngle(1, 0)).toBe(0);
    expect(diamondAngle(0, 1)).toBe(1);
    expect(diamondAngle(-1, 0)).toBe(2);
    expect(diamondAngle(0, -1)).toBe(3);
    expect(diamondAngle(0, 0)).toBe(0);
  });
});

describe("terrain sculpting", () => {
  it("clampSlopes only lowers and leaves no step above the lip", () => {
    const g = grid(31, 31, (x, z) => (Math.abs(x) < 2 && Math.abs(z) < 2 ? 9 : 0.2 * x));
    const before = Float32Array.from(g.heights);
    const lip = new Float32Array(g.heights.length).fill(1);
    clampSlopes(g, lip);
    for (let i = 0; i < g.heights.length; i++) expect(g.heights[i]!).toBeLessThanOrEqual(before[i]!);
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const i = r * g.cols + c;
        if (c + 1 < g.cols) expect(Math.abs(g.heights[i]! - g.heights[i + 1]!)).toBeLessThanOrEqual(1 + 1e-6);
        if (r + 1 < g.rows) expect(Math.abs(g.heights[i]! - g.heights[i + g.cols]!)).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
    // Slopes ≤ 1 m per m keep every bilinear patch walkable.
    for (let z = -14.5; z < 14.5; z += 0.5) for (let x = -14.5; x < 14.5; x += 0.5) expect(normalAt(g, x, z).y).toBeGreaterThan(MAX_WALK_NORMAL_Y);
  });

  it("a steeper lip keeps a cliff wall", () => {
    const g = grid(21, 5, (x) => (x > 0 ? 4 : 0));
    const lip = new Float32Array(g.heights.length).fill(1);
    for (let i = 0; i < lip.length; i++) if (vertexX(g, i) === 1) lip[i] = 5;
    clampSlopes(g, lip);
    expect(heightAt(g, 1, 0) - heightAt(g, 0, 0)).toBe(4);
  });

  it("flattenArea levels the inner disc onto the tilted plane and blends out", () => {
    const g = grid(41, 41, (x, z) => 2 + 0.3 * x + 0.1 * z);
    flattenArea(g, 0, 0, 3, 7, 0.5, 0.1, 1, 0);
    expect(heightAt(g, 0, 0)).toBeCloseTo(0.5, 6);
    expect(heightAt(g, 2, 0)).toBeCloseTo(0.3, 5);
    expect(heightAt(g, -2, 1)).toBeCloseTo(0.7, 5);
    expect(heightAt(g, 10, 0)).toBeCloseTo(5, 5);
  });

  it("coastDistance matches a brute-force nearest search (chamfer accuracy)", () => {
    const g = grid(41, 41, (x, z) => 3 - Math.sqrt(x * x + z * z * 1.7) * 0.25);
    const d = coastDistance(g);
    for (let i = 0; i < g.heights.length; i += 7) {
      const land = g.heights[i]! >= 0;
      let best = Infinity;
      for (let j = 0; j < g.heights.length; j++) {
        if (g.heights[j]! >= 0 === land) continue;
        best = Math.min(best, Math.hypot(vertexX(g, i) - vertexX(g, j), vertexZ(g, i) - vertexZ(g, j)));
      }
      expect(d[i]!).toBeGreaterThanOrEqual(best - 1e-4); // stored as float32
      expect(d[i]!).toBeLessThanOrEqual(best * 1.09 + 1e-6);
    }
  });

  it("vertexIndex rounds to the nearest vertex and clamps to the grid", () => {
    const g = grid(11, 11, () => 0);
    expect(vertexIndex(g, 0.4, -0.4)).toBe(5 * 11 + 5);
    expect(vertexIndex(g, 0.6, 0.6)).toBe(6 * 11 + 6);
    expect(vertexIndex(g, -100, 100)).toBe(10 * 11);
  });
});

describe("walkability", () => {
  it("a cliff blocks the walk, a ramp around it does not", () => {
    // Plateau 3 m high on x > 0, walled except for a ramp at z ≥ 6.
    const g = grid(31, 31, (x, z) => {
      if (x <= 0) return 0.5;
      if (z >= 6) return 0.5 + Math.min(2.5, x * 0.4);
      return 3;
    });
    const reach = reachableFrom(g, null, 0, -5, -5);
    expect(reach[vertexIndex(g, 10, -10)]).toBe(1);
    expect(segmentWalkable(g, { x: -3, z: -5 }, { x: 3, z: -5 })).toBe(false);
    expect(segmentWalkable(g, { x: -3, z: 10 }, { x: 3, z: 10 })).toBe(true);
    // Without the ramp the plateau is unreachable.
    const walled = grid(31, 31, (x) => (x <= 0 ? 0.5 : 3));
    expect(reachableFrom(walled, null, 0, -5, -5)[vertexIndex(walled, 10, -10)]).toBe(0);
  });

  it("deep water stops the walk but the walkable shelf doesn't", () => {
    const g = grid(31, 11, (x) => (Math.abs(x) < 2 ? -0.4 : Math.abs(x) < 4 ? -2 : 0.5));
    expect(reachableFrom(g, null, 0, -10, 0)[vertexIndex(g, 10, 0)]).toBe(0);
    const shelf = grid(31, 11, (x) => (Math.abs(x) < 4 ? -0.4 : 0.5));
    expect(reachableFrom(shelf, null, 0, -10, 0)[vertexIndex(shelf, 10, 0)]).toBe(1);
  });

  it("ownership restricts the walk to one island", () => {
    const g = grid(21, 5, () => 1);
    const owner = new Int8Array(g.heights.length);
    for (let i = 0; i < owner.length; i++) owner[i] = vertexX(g, i) > 0 ? 1 : 0;
    const reach = reachableFrom(g, owner, 0, -5, 0);
    expect(reach[vertexIndex(g, -9, 0)]).toBe(1);
    expect(reach[vertexIndex(g, 5, 0)]).toBe(0);
  });
});

describe("shape", () => {
  it("plans stay inside the documented ranges for every biome", () => {
    for (const biome of BIOME_IDS) {
      for (let seed = 1; seed < 60; seed++) {
        for (const duel of [false, true]) {
          const p = planIsland(seed * 7777, 0, biome, duel);
          expect(p.ax).toBeGreaterThanOrEqual(ISLAND_RADIUS * 0.85 - 1e-9);
          expect(p.ax).toBeLessThanOrEqual(ISLAND_RADIUS * 1.15 + 1e-9);
          expect(p.az).toBeGreaterThanOrEqual(ISLAND_RADIUS * 0.85 - 1e-9);
          expect(p.az).toBeLessThanOrEqual(ISLAND_RADIUS * 1.15 + 1e-9);
          expect(p.peak).toBeGreaterThanOrEqual(BIOME_STYLES[biome].peakLo);
          expect(p.peak).toBeLessThanOrEqual(BIOME_STYLES[biome].peakHi);
          expect(p.peak).toBeGreaterThan(PEAK_MIN);
          expect(p.peak).toBeLessThan(PEAK_MAX);
          if (duel) expect(p.az).toBeGreaterThanOrEqual(p.ax);
          expect(Number.isFinite(p.cliffThr)).toBe(BIOMES[biome].rugged >= 0.5);
        }
      }
    }
  });

  it("rasters: land in the middle, coast within the soft cap, sea floor far out", () => {
    for (const biome of BIOME_IDS) {
      const half = (SOLO_GRID.cols - 1) / 2;
      const r = rasterizeIsland(planIsland(99, 0, biome, false), half);
      const mid = half * r.size + half;
      expect(r.delta[mid]!).toBeGreaterThan(25);
      expect(r.base[0]!).toBeCloseTo(SEA_FLOOR_Y, 3);
      // Soft cap 51 + 6 m, plus the positional wiggle (≤ 3.4 m).
      for (const p of coastPoints(r)) expect(Math.hypot(p.x, p.z)).toBeLessThan(51 + 6 + 3.4 + 1e-6);
      for (let i = 0; i < r.hill.length; i++) {
        expect(r.hill[i]!).toBeGreaterThanOrEqual(0);
        if (r.delta[i]! < 0) expect(r.hill[i]!).toBe(0);
      }
    }
  });

  it("cliffs take at most about the biome's share of the coastline", () => {
    for (const biome of ["rocky", "volcanic"] as const) {
      let cliffCoast = 0;
      let coast = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const r = rasterizeIsland(planIsland(seed * 31337, 0, biome, false), (SOLO_GRID.cols - 1) / 2);
        for (let i = 0; i < r.delta.length; i++) {
          if (r.delta[i]! < 0 || r.delta[i]! > 1) continue;
          coast++;
          if (r.lip[i]! > 1.5) cliffCoast++;
        }
      }
      const share = cliffCoast / coast;
      expect(share).toBeGreaterThan(0.1);
      expect(share).toBeLessThan(BIOMES[biome].rugged > 0.7 ? 0.5 : 0.36);
    }
  });

  it("solveStraitOffset hits the requested coast-to-coast gap within half a meter", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const a = rasterizeIsland(planIsland(seed, 0, "tropic", true), 84);
      const b = rasterizeIsland(planIsland(seed, 1, "tropic", true), 84);
      for (const target of [26.5, 28, 29.5]) {
        const d = solveStraitOffset(a, b, 2, target);
        const pa = coastPoints(a);
        const pb = coastPoints(b);
        let gap = Infinity;
        for (const p of pa) for (const q of pb) gap = Math.min(gap, Math.hypot(q.x + d - p.x, q.z + 2 - p.z));
        expect(Math.abs(gap - target)).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
  });
});

describe("placement helpers", () => {
  it("nodeTargets = round(BASE_NODE_COUNTS × biome counts)", () => {
    for (const biome of BIOME_IDS) {
      const t = nodeTargets(biome);
      for (const k of ["tree", "palm", "rock", "bush"] as const) expect(t[k]).toBe(Math.round(BASE_NODE_COUNTS[k] * BIOMES[biome].counts[k]));
    }
  });

  it("distToSegment", () => {
    const s = { ax: 0, az: 0, bx: 10, bz: 0 };
    expect(distToSegment(5, 3, s)).toBe(3);
    expect(distToSegment(-4, 3, s)).toBe(5);
    expect(distToSegment(13, -4, s)).toBe(5);
    expect(distToSegment(1, 1, { ax: 2, az: 2, bx: 2, bz: 2 })).toBeCloseTo(Math.SQRT2, 12);
  });
});
