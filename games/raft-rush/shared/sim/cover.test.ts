// CoverIndex tests: spatial hash vs brute force, deterministic order, structures, contacts. Owner: sim.

import { describe, expect, it } from "vitest";
import { DUEL_GRID, FENCE_LENGTH } from "../constants.js";
import { createHeightfield } from "../island/heightfield.js";
import type { NodeDef } from "../island/types.js";
import {
  CHEST_HEIGHT_M,
  CHEST_RADIUS,
  COLLECTOR_RADIUS,
  FENCE_HEIGHT,
  FENCE_POST_RADIUS,
  HUT_RADIUS,
  WRECK_HEIGHT,
  WRECK_RADIUS,
  buildCover,
  fenceAxis,
  overlapsY,
  snapYaw8,
  sphereCircleContact,
  type CoverCircle,
  type CoverContact,
  type CoverStructure,
} from "./cover.js";
import { flatIsland, islandFrom, lcg, node, site } from "./testkit.js";

/** Brute-force reference of CoverQuery.query over an explicit circle list. */
function scan(circles: CoverCircle[], x: number, z: number, radius: number): CoverCircle[] {
  return circles.filter((c) => {
    const dx = c.x - x;
    const dz = c.z - z;
    const rr = c.r + radius;
    return dx * dx + dz * dz < rr * rr;
  });
}

function randomIsland(seed: number, count: number) {
  const rand = lcg(seed);
  const grid = createHeightfield(DUEL_GRID.cols, DUEL_GRID.rows, 1, -(DUEL_GRID.cols - 1) / 2, -(DUEL_GRID.rows - 1) / 2);
  const kinds = ["tree", "palm", "rock", "bush"] as const;
  const nodes: NodeDef[] = [];
  for (let i = 0; i < count; i++) {
    const kind = kinds[Math.floor(rand() * 4)]!;
    // Some outside the grid on purpose (they clamp to the edge buckets).
    nodes.push(node(grid, kind, (rand() - 0.5) * 210, (rand() - 0.5) * 140, { radius: kind === "bush" ? 0 : 0.2 + rand() * 2.2 }));
  }
  return islandFrom(grid, nodes, [site({ wreck: { x: 3, z: 4, yaw: 0 }, chest: { x: -5, z: 2 } })]);
}

describe("spatial hash", () => {
  it("returns exactly what a linear scan returns, in insertion order", () => {
    const island = randomIsland(1, 900);
    const cover = buildCover(island);
    const structures: CoverStructure[] = [];
    const rand = lcg(2);
    for (let i = 0; i < 24; i++) {
      const kinds = ["fence", "collector", "hut", "torch"] as const;
      structures.push({ id: `s${i}`, kind: kinds[i % 4]!, x: (rand() - 0.5) * 100, y: 0, z: (rand() - 0.5) * 60, yaw: snapYaw8(rand() * 7) });
    }
    cover.setStructures(structures);
    const all = cover.all();
    expect(all.length).toBe(cover.staticCount + cover.dynamicCount);
    const out: CoverCircle[] = [];
    for (let q = 0; q < 4000; q++) {
      const x = (rand() - 0.5) * 230;
      const z = (rand() - 0.5) * 160;
      const radius = rand() < 0.1 ? rand() * 8 : rand() * 1.2;
      const n = cover.query(x, z, radius, out);
      expect(out.slice(0, n)).toEqual(scan(all, x, z, radius));
      for (let i = 1; i < n; i++) expect(all.indexOf(out[i]!)).toBeGreaterThan(all.indexOf(out[i - 1]!));
    }
  });

  it("puts island nodes first (index order), then each site's wreck and chest, skipping bushes", () => {
    const base = flatIsland(1);
    const island = flatIsland(1, [node(base.grid, "tree", 1, 1), node(base.grid, "bush", 2, 2), node(base.grid, "rock", 3, 3)]);
    island.sites.push(site({ wreck: { x: -4, z: -4, yaw: 0 }, chest: { x: 4, z: -4 } }));
    const cover = buildCover(island);
    const all = cover.all();
    expect(all.map((c) => c.kind)).toEqual(["tree", "rock", "wreck", "chest"]);
    expect(all.map((c) => c.node)).toEqual([0, 2, -1, -1]);
    expect(all[0]).toMatchObject({ x: 1, z: 1, bottom: 0, top: 5 });
    expect(all[2]).toMatchObject({ r: WRECK_RADIUS, top: 1 + WRECK_HEIGHT });
    expect(all[3]).toMatchObject({ r: CHEST_RADIUS, top: 1 + CHEST_HEIGHT_M });
  });

  it("fills `out` in place without growing it, and grows a short one", () => {
    const base = flatIsland(1);
    const island = flatIsland(1, [node(base.grid, "rock", 0, 0), node(base.grid, "rock", 0.5, 0), node(base.grid, "tree", 0, 0.5)]);
    const cover = buildCover(island);
    const long: CoverCircle[] = new Array(8).fill(cover.all()[0]);
    expect(cover.query(0, 0, 0.5, long)).toBe(3);
    expect(long.length).toBe(8);
    const short: CoverCircle[] = [];
    expect(cover.query(0, 0, 0.5, short)).toBe(3);
    expect(short.length).toBe(3);
    expect(cover.query(10, 10, 0.5, short)).toBe(0);
  });

  it("rejects non-finite queries", () => {
    const base = flatIsland(1);
    const cover = buildCover(flatIsland(1, [node(base.grid, "rock", 0, 0)]));
    const out: CoverCircle[] = [];
    expect(cover.query(Number.NaN, 0, 1, out)).toBe(0);
    expect(cover.query(0, Infinity, 1, out)).toBe(0);
    expect(cover.query(0, 0, Number.NaN, out)).toBe(0);
  });
});

describe("structures", () => {
  it("turns a fence into three posts along its axis", () => {
    const cover = buildCover(flatIsland(1));
    cover.setStructures([{ id: "s1", kind: "fence", x: 2, y: 1, z: 3, yaw: 0 }]);
    const posts = cover.all();
    expect(posts).toHaveLength(3);
    expect(posts.map((c) => c.x)).toEqual([2 - FENCE_LENGTH / 3, 2, 2 + FENCE_LENGTH / 3]);
    expect(posts.every((c) => c.z === 3 && c.r === FENCE_POST_RADIUS && c.top === 1 + FENCE_HEIGHT && c.id === "s1")).toBe(true);

    cover.setStructures([{ id: "s1", kind: "fence", x: 2, y: 1, z: 3, yaw: Math.PI / 2 }]);
    const turned = cover.all();
    // yaw π/2: right = (cos, −sin) = (0, −1)
    expect(turned.map((c) => c.z)).toEqual([3 + FENCE_LENGTH / 3, 3, 3 - FENCE_LENGTH / 3]);
    expect(turned.every((c) => Math.abs(c.x - 2) < 1e-12)).toBe(true);
  });

  it("adds collectors and huts, ignores torches, krakens and canoes, and replaces the whole layer", () => {
    const cover = buildCover(flatIsland(1));
    cover.setStructures([
      { id: "s1", kind: "torch", x: 0, y: 1, z: 0, yaw: 0 },
      { id: "s2", kind: "collector", x: 1, y: 1, z: 0, yaw: 0 },
      { id: "s3", kind: "kraken", x: 2, y: 1, z: 0, yaw: 0 },
      { id: "s4", kind: "hut", x: 6, y: 1, z: 0, yaw: 0 },
      { id: "s5", kind: "canoe", x: 9, y: 1, z: 0, yaw: 0 },
    ]);
    expect(cover.all().map((c) => [c.kind, c.r])).toEqual([
      ["collector", COLLECTOR_RADIUS],
      ["hut", HUT_RADIUS],
    ]);
    const out: CoverCircle[] = [];
    expect(cover.query(6, 0, 0.4, out)).toBe(1);
    cover.setStructures([]);
    expect(cover.dynamicCount).toBe(0);
    expect(cover.query(6, 0, 0.4, out)).toBe(0);
  });

  it("orders structures by id whatever order they're iterated in", () => {
    const a = buildCover(flatIsland(1));
    const b = buildCover(flatIsland(1));
    const list: CoverStructure[] = [
      { id: "s10", kind: "collector", x: 0, y: 1, z: 0, yaw: 0 },
      { id: "s2", kind: "collector", x: 0.2, y: 1, z: 0, yaw: 0 },
      { id: "s1", kind: "fence", x: 0, y: 1, z: 0.3, yaw: 0 },
    ];
    a.setStructures(list);
    b.setStructures([...list].reverse());
    expect(b.all()).toEqual(a.all());
    expect(a.all().map((c) => c.id)).toEqual(["s1", "s1", "s1", "s2", "s10"]);
  });
});

describe("fence yaw table", () => {
  it("snaps to multiples of π/4 in (−π, π] and matches cos / −sin", () => {
    for (let k = -12; k <= 12; k++) {
      const yaw = (k * Math.PI) / 4;
      const snapped = snapYaw8(yaw + 0.1);
      expect(snapped).toBeGreaterThan(-Math.PI - 1e-9);
      expect(snapped).toBeLessThanOrEqual(Math.PI + 1e-9);
      expect(Math.cos(snapped)).toBeCloseTo(Math.cos(yaw), 9);
      expect(Math.sin(snapped)).toBeCloseTo(Math.sin(yaw), 9);
      const [ax, az] = fenceAxis(snapped);
      expect(ax).toBeCloseTo(Math.cos(yaw), 12);
      expect(az).toBeCloseTo(-Math.sin(yaw), 12);
    }
  });
});

describe("sphere vs cylinder", () => {
  const rock: CoverCircle = { x: 0, z: 0, r: 1, bottom: 0, top: 1, kind: "rock", node: 0, id: "" };
  const trunk: CoverCircle = { ...rock, kind: "palm", r: 0.3, top: 4 };
  const out: CoverContact = { nx: 0, ny: 0, nz: 0, depth: 0 };

  it("touches sides, the top face and pushes centers inside out the nearest way", () => {
    expect(sphereCircleContact(rock, 1.1, 0.5, 0, 0.2, out)).toBe(true);
    expect(out.nx).toBeCloseTo(1, 12);
    expect(out.depth).toBeCloseTo(0.1, 12);
    expect(sphereCircleContact(rock, 0.2, 1.1, 0, 0.2, out)).toBe(true);
    expect(out.ny).toBeCloseTo(1, 12);
    expect(out.depth).toBeCloseTo(0.1, 12);
    expect(sphereCircleContact(rock, 0.5, 0.9, 0, 0.2, out)).toBe(true); // inside, near the top
    expect(out).toMatchObject({ nx: 0, ny: 1, nz: 0 });
    expect(sphereCircleContact(rock, 0, 0.5, 0.9, 0.2, out)).toBe(true); // inside, near the side
    expect(out.nz).toBeCloseTo(1, 12);
    expect(out.depth).toBeCloseTo(0.3, 12);
    expect(sphereCircleContact(rock, 1.3, 0.5, 0, 0.2, out)).toBe(false);
    expect(sphereCircleContact(rock, 0, 1.3, 0, 0.2, out)).toBe(false);
  });

  it("treats trunks as side-only: their tops hide in the crown", () => {
    expect(sphereCircleContact(trunk, 0, 4.1, 0, 0.2, out)).toBe(false);
    expect(sphereCircleContact(trunk, 0, 3.9, 0, 0.2, out)).toBe(true);
    expect(out).toMatchObject({ nx: 1, ny: 0, nz: 0 });
    expect(sphereCircleContact(trunk, 0.45, 2, 0, 0.2, out)).toBe(true);
    expect(out.nx).toBeCloseTo(1, 12);
  });

  it("checks vertical overlap", () => {
    expect(overlapsY(rock, -1, 0.5)).toBe(true);
    expect(overlapsY(rock, 1, 2)).toBe(false);
    expect(overlapsY(rock, -2, 0)).toBe(false);
  });
});
