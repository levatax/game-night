// Island generator tests (docs/ARCHITECTURE.md §5.3, game4.md §20 "Saf üreteç"). Owner: island.
//
// Determinism (same seed → same gridHash / defHash, golden values, no transcendental Math in gameplay code),
// 50 solo seeds + 10 duel seeds against every placement promise, and the generation time budget.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  BEACH_MAX_Y,
  BIOMES,
  BIOME_IDS,
  CAMP_FROM_WRECK_MAX,
  CAMP_FROM_WRECK_MIN,
  CHEST_FROM_FIRE,
  CORRIDOR_WIDTH,
  DUEL_GRID,
  FIRE_LIGHT_RADIUS,
  FISH_CAST_RANGE,
  FISH_SPOT_RADIUS,
  FISH_SPOTS_MAX,
  FISH_SPOTS_MIN,
  MAX_WALK_NORMAL_Y,
  NODE_AMOUNT,
  PALM_TRUNK_RADIUS,
  PEAK_MAX,
  PEAK_MIN,
  RAFT_RANGE,
  ROCK_RADIUS_MAX,
  ROCK_RADIUS_MIN,
  SOLO_GRID,
  SPRING_RANGE,
  STRAIT_MAX,
  STRAIT_MIN,
  TREE_TRUNK_RADIUS,
  WORLD_EDGE_MARGIN,
} from "../constants.js";
import type { NodeKind } from "../types.js";
import { biomeForSeed, defHash, generateIsland } from "./generate.js";
import { gridHash, heightAt, normalAt } from "./heightfield.js";
import { nodeTargets } from "./placement.js";
import type { Heightfield, IslandDef, IslandSite, XZ } from "./types.js";

// 60 full islands with exhaustive checks: give slow CI machines room.
vi.setConfig({ testTimeout: 120_000 });

// Stress knob: ISLAND_SEEDS=500 ISLAND_DUEL_SEEDS=100 npx vitest run games/raft-rush/shared/island
const SOLO_COUNT = Number(process.env.ISLAND_SEEDS ?? 50);
const DUEL_COUNT = Number(process.env.ISLAND_DUEL_SEEDS ?? 10);
const SOLO_SEEDS = Array.from({ length: SOLO_COUNT }, (_, k) => (k * 2654435761 + 12345) >>> 0);
const DUEL_SEEDS = Array.from({ length: DUEL_COUNT }, (_, k) => (k * 40503 + 977) >>> 0);

/* ------------------------------------------------------------- helpers */

function dist(a: XZ, b: XZ): number {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z));
}

function distToSegment(p: XZ, a: XZ, b: XZ): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const vv = vx * vx + vz * vz;
  let t = vv > 0 ? ((p.x - a.x) * vx + (p.z - a.z) * vz) / vv : 0;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + vx * t, z: a.z + vz * t });
}

/** Independent walk graph (mirrors stepPlayer's rules conservatively): 4-neighbour steps on ground above the
 * swim threshold, rise ≤ 1 m, bilinear cells on both sides of the edge no steeper than MAX_WALK_NORMAL_Y. */
function walkReach(g: Heightfield, from: XZ, keep: (x: number, z: number) => boolean): Uint8Array {
  const seen = new Uint8Array(g.cols * g.rows);
  const idx = (x: number, z: number): number => Math.round(z - g.originZ) * g.cols + Math.round(x - g.originX);
  const start = idx(from.x, from.z);
  const q = [start];
  seen[start] = 1;
  const steep = (x: number, z: number): boolean => normalAt(g, x, z).y < MAX_WALK_NORMAL_Y;
  while (q.length) {
    const i = q.pop()!;
    const c = i % g.cols;
    const r = Math.floor(i / g.cols);
    const x = g.originX + c;
    const z = g.originZ + r;
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue;
      const j = nr * g.cols + nc;
      if (seen[j]) continue;
      const hj = g.heights[j]!;
      if (hj < -0.55 || Math.abs(hj - g.heights[i]!) > 1 || !keep(x + dc, z + dr)) continue;
      const mx = x + dc * 0.5;
      const mz = z + dr * 0.5;
      if (dc !== 0 ? steep(mx, mz - 0.25) || steep(mx, mz + 0.25) : steep(mx - 0.25, mz) || steep(mx + 0.25, mz)) continue;
      seen[j] = 1;
      q.push(j);
    }
  }
  return seen;
}

function vIndex(g: Heightfield, p: XZ): number {
  return Math.round(p.z - g.originZ) * g.cols + Math.round(p.x - g.originX);
}

/** Every land vertex within `r` m of p is ≥ `minDepthBelow` … (used for "no water nearby" / "water nearby"). */
function minHeightAround(g: Heightfield, p: XZ, r: number): number {
  let m = Infinity;
  for (let dz = -r; dz <= r; dz += 0.5) for (let dx = -r; dx <= r; dx += 0.5) if (dx * dx + dz * dz <= r * r) m = Math.min(m, heightAt(g, p.x + dx, p.z + dz));
  return m;
}

/** Waterline crossings of the final heightfield along grid edges. */
function coastline(g: Heightfield): XZ[] {
  const out: XZ[] = [];
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c;
      const a = g.heights[i]!;
      const x = g.originX + c;
      const z = g.originZ + r;
      if (c + 1 < g.cols) {
        const b = g.heights[i + 1]!;
        if (a >= 0 !== b >= 0) out.push({ x: x + a / (a - b), z });
      }
      if (r + 1 < g.rows) {
        const b = g.heights[i + g.cols]!;
        if (a >= 0 !== b >= 0) out.push({ x, z: z + a / (a - b) });
      }
    }
  }
  return out;
}

/**
 * Island index of a point in a duel: land vertices by the nearest site center, water vertices by the nearest
 * land (multi-source BFS over the grid, computed once per def).
 */
function islandOf(def: IslandDef, p: XZ): number {
  if (def.sites.length < 2) return 0;
  let map = islandMaps.get(def);
  if (!map) {
    const g = def.grid;
    map = new Int8Array(g.cols * g.rows).fill(-1);
    const queue: number[] = [];
    for (let i = 0; i < map.length; i++) {
      if (g.heights[i]! < 0) continue;
      const q = { x: g.originX + (i % g.cols), z: g.originZ + Math.floor(i / g.cols) };
      map[i] = dist(q, def.sites[0]!.center) <= dist(q, def.sites[1]!.center) ? 0 : 1;
      queue.push(i);
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head]!;
      const c = i % g.cols;
      for (const j of [c > 0 ? i - 1 : -1, c < g.cols - 1 ? i + 1 : -1, i - g.cols, i + g.cols]) {
        if (j < 0 || j >= map.length || map[j] !== -1) continue;
        map[j] = map[i]!;
        queue.push(j);
      }
    }
    islandMaps.set(def, map);
  }
  return map[vIndex(def.grid, p)]!;
}
const islandMaps = new WeakMap<IslandDef, Int8Array>();

/** Every promise of §5.3 for one site of `def`. */
function checkSite(def: IslandDef, site: IslandSite): void {
  const g = def.grid;
  const k = site.team;
  const mine = (x: number, z: number): boolean => islandOf(def, { x, z }) === k;
  const h = (p: XZ): number => heightAt(g, p.x, p.z);
  const label = `seed ${def.seed} ${def.layout} ${def.biome} island ${k}`;

  // Peak.
  let peak = -Infinity;
  for (let i = 0; i < g.heights.length; i++) {
    const x = g.originX + (i % g.cols);
    const z = g.originZ + Math.floor(i / g.cols);
    if (mine(x, z)) peak = Math.max(peak, g.heights[i]!);
  }
  expect(peak, label).toBeGreaterThanOrEqual(PEAK_MIN);
  expect(peak, label).toBeLessThanOrEqual(PEAK_MAX);

  // Wreck on the beach (dry sand), camp 8–12 m inland (dry, flat), chest beside the fire.
  expect(h(site.wreck), label).toBeGreaterThan(0.05);
  expect(h(site.wreck), label).toBeLessThanOrEqual(BEACH_MAX_Y);
  expect(minHeightAround(g, site.wreck, 6), `${label} wreck near water`).toBeLessThan(0);
  const dw = dist(site.campfire, site.wreck);
  expect(dw, label).toBeGreaterThanOrEqual(CAMP_FROM_WRECK_MIN - 1e-9);
  expect(dw, label).toBeLessThanOrEqual(CAMP_FROM_WRECK_MAX + 1e-9);
  expect(h(site.campfire), label).toBeGreaterThan(0.6);
  expect(normalAt(g, site.campfire.x, site.campfire.z).y, `${label} camp flat`).toBeGreaterThan(0.95);
  expect(minHeightAround(g, site.campfire, 3), `${label} camp dry`).toBeGreaterThan(0.3);
  expect(Math.abs(dist(site.chest, site.campfire) - CHEST_FROM_FIRE), label).toBeLessThan(1e-9);
  expect(h(site.chest), label).toBeGreaterThan(0.3);

  // Spawns: six on dry sand around the wreck, apart, walkable, clear of the hull.
  expect(site.spawns.length, label).toBe(6);
  for (const s of site.spawns) {
    expect(h(s), label).toBeGreaterThan(0.05);
    expect(h(s), label).toBeLessThanOrEqual(1.6);
    expect(normalAt(g, s.x, s.z).y, label).toBeGreaterThan(0.85);
    expect(dist(s, site.wreck), label).toBeGreaterThanOrEqual(2.9);
    expect(dist(s, site.wreck), label).toBeLessThanOrEqual(7.01);
    for (const o of site.spawns) if (o !== s) expect(dist(s, o), label).toBeGreaterThanOrEqual(1.5);
  }
  expect(site.spawns.filter((s) => h(s) <= BEACH_MAX_Y + 0.1).length, `${label} spawns on sand`).toBeGreaterThanOrEqual(4);

  // Raft at the waterline on sand, facing open sea (yaw forward = (−sin, −cos)).
  const hr = h(site.raft);
  expect(hr, label).toBeGreaterThan(0);
  expect(hr, label).toBeLessThan(BEACH_MAX_Y);
  const fx = -Math.sin(site.raft.yaw);
  const fz = -Math.cos(site.raft.yaw);
  expect(heightAt(g, site.raft.x + fx * 2.5, site.raft.z + fz * 2.5), `${label} water in front of the raft`).toBeLessThan(0);
  for (let s = 4; s <= 20; s += 1) {
    const p = { x: site.raft.x + fx * s, z: site.raft.z + fz * s };
    if (p.x < def.bounds.minX || p.x > def.bounds.maxX || p.z < def.bounds.minZ || p.z > def.bounds.maxZ) break;
    expect(heightAt(g, p.x, p.z), `${label} open sea ahead of the raft at ${s} m`).toBeLessThan(0);
  }
  expect(normalAt(g, site.raft.x, site.raft.z).y, `${label} raft flat`).toBeGreaterThan(0.98);
  const dr = dist(site.raft, site.campfire);
  expect(dr, label).toBeGreaterThanOrEqual(9);
  expect(dr, label).toBeLessThanOrEqual(34);

  // Walkable corridors: wreck → camp → raft.
  for (const [a, b] of [
    [site.wreck, site.campfire],
    [site.campfire, site.raft],
  ] as const) {
    const n = Math.ceil(dist(a, b) / 0.25);
    for (let s = 0; s <= n; s++) {
      const x = a.x + ((b.x - a.x) * s) / n;
      const z = a.z + ((b.z - a.z) * s) / n;
      expect(heightAt(g, x, z), `${label} corridor dry`).toBeGreaterThan(-0.3);
      expect(normalAt(g, x, z).y, `${label} corridor slope`).toBeGreaterThanOrEqual(MAX_WALK_NORMAL_Y);
    }
  }

  // Reachable on foot from the camp: spring, cave, secret chest; no unwalkable pits.
  const reach = walkReach(g, site.campfire, mine);
  const reachable = (p: XZ): boolean => {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (reach[vIndex(g, { x: p.x + dx, z: p.z + dz })]) return true;
    return false;
  };
  expect(h(site.spring), label).toBeGreaterThan(0.8);
  expect(minHeightAround(g, site.spring, 3), `${label} spring inland`).toBeGreaterThan(0);
  expect(reachable(site.spring), `${label} spring reachable`).toBe(true);
  expect(reachable(site.wreck) && reachable(site.raft), `${label} wreck / raft reachable`).toBe(true);
  for (const s of site.spawns) expect(reachable(s), `${label} spawn reachable`).toBe(true);
  if (site.cave) {
    expect(site.cave.radius, label).toBeGreaterThan(0);
    expect(h(site.cave), label).toBeGreaterThan(0.5);
    expect(reachable(site.cave), `${label} cave reachable`).toBe(true);
  }
  expect(h(site.secretChest), label).toBeGreaterThan(0.3);
  expect(reachable(site.secretChest), `${label} secret chest reachable`).toBe(true);
  expect(dist(site.secretChest, site.campfire), `${label} secret chest remote`).toBeGreaterThan(15);
  // An unreachable land vertex may only be part of a cliff wall (within 2 m of a too-steep cell).
  let land = 0;
  let stranded = 0;
  for (let i = 0; i < g.heights.length; i++) {
    if (g.heights[i]! < 0 || reach[i]) continue;
    const x = g.originX + (i % g.cols);
    const z = g.originZ + Math.floor(i / g.cols);
    if (!mine(x, z)) continue;
    land++;
    let nearWall = false;
    for (let dz = -2; dz <= 2 && !nearWall; dz += 0.5) for (let dx = -2; dx <= 2 && !nearWall; dx += 0.5) nearWall = normalAt(g, x + dx, z + dz).y < MAX_WALK_NORMAL_Y;
    if (!nearWall) stranded++;
  }
  expect(stranded, `${label} stranded land vertices (of ${land} unreachable)`).toBe(0);

  // Shore cells: ≥ 24, in 0.3–1.5 m water, around the whole coast, outside the fire light.
  expect(site.shore.length, label).toBeGreaterThanOrEqual(24);
  const octants = new Set<number>();
  for (const s of site.shore) {
    const y = h(s);
    expect(y, label).toBeLessThanOrEqual(-0.3);
    expect(y, label).toBeGreaterThanOrEqual(-1.5);
    expect(dist(s, site.campfire), label).toBeGreaterThan(FIRE_LIGHT_RADIUS);
    expect(islandOf(def, s), label).toBe(k);
    octants.add(Math.floor(((Math.atan2(s.z - site.center.z, s.x - site.center.x) + Math.PI) / (2 * Math.PI)) * 8) % 8);
  }
  expect(octants.size, `${label} shore spread`).toBeGreaterThanOrEqual(def.layout === "solo" ? 8 : 7);

  // Fish spots: count, depth 1–3 m, ≥ 8 m apart, whole circle in water, castable from standable ground.
  const spots = def.fishSpots.filter((f) => f.island === k);
  const extra = BIOMES[def.biome].extraFishSpots;
  expect(spots.length, label).toBeGreaterThanOrEqual(FISH_SPOTS_MIN + extra);
  expect(spots.length, label).toBeLessThanOrEqual(FISH_SPOTS_MAX + extra);
  for (const f of spots) {
    const y = h(f);
    expect(y, label).toBeLessThanOrEqual(-1);
    expect(y, label).toBeGreaterThanOrEqual(-3);
    expect(islandOf(def, f), label).toBe(k);
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      expect(heightAt(g, f.x + Math.cos(ang) * FISH_SPOT_RADIUS, f.z + Math.sin(ang) * FISH_SPOT_RADIUS), `${label} spot rim wet`).toBeLessThan(0);
    }
    for (const o of spots) if (o !== f) expect(dist(f, o), label).toBeGreaterThanOrEqual(8);
    let stand = Infinity;
    for (let dz = -12; dz <= 12; dz++) {
      for (let dx = -12; dx <= 12; dx++) {
        if (heightAt(g, f.x + dx, f.z + dz) >= -0.55) stand = Math.min(stand, Math.sqrt(dx * dx + dz * dz));
      }
    }
    expect(stand, `${label} castable`).toBeLessThanOrEqual(FISH_CAST_RANGE - 4);
  }

  // Nodes of this island: counts, terrain, keep-outs, corridors.
  const nodes = def.nodes.filter((n) => n.island === k);
  const target = nodeTargets(def.biome);
  const count: Record<NodeKind, number> = { tree: 0, palm: 0, rock: 0, bush: 0 };
  for (const n of nodes) count[n.kind]++;
  for (const kind of ["tree", "palm", "rock", "bush"] as const) {
    expect(Math.abs(count[kind] - target[kind]), `${label} ${kind} count`).toBeLessThanOrEqual(Math.ceil(target[kind] * 0.1));
  }
  const bushes = nodes.filter((n) => n.kind === "bush");
  const ropes = bushes.filter((n) => n.yield === "rope").length;
  const berries = bushes.filter((n) => n.yield === "berry").length;
  expect(Math.abs(ropes - bushes.length * BIOMES[def.biome].ropeShare), label).toBeLessThanOrEqual(1);
  expect(Math.abs(berries - bushes.length * BIOMES[def.biome].berryShare), label).toBeLessThanOrEqual(1);
  const corridors: [XZ, XZ][] = [
    [site.wreck, site.campfire],
    [site.campfire, site.raft],
    [site.wreck, site.raft],
    [site.campfire, site.spring],
    [site.raft, { x: site.raft.x + fx * 8, z: site.raft.z + fz * 8 }],
  ];
  for (const n of nodes) {
    expect(islandOf(def, n), label).toBe(k);
    expect(n.y, label).toBe(heightAt(g, n.x, n.z));
    expect(n.y, `${label} ${n.kind} on land`).toBeGreaterThan(0);
    for (const [a, b] of corridors) expect(distToSegment(n, a, b), `${label} ${n.kind} in a corridor`).toBeGreaterThanOrEqual(CORRIDOR_WIDTH / 2 + n.radius);
    expect(dist(n, site.campfire) - n.radius, `${label} camp clearing`).toBeGreaterThanOrEqual(FIRE_LIGHT_RADIUS);
    expect(dist(n, site.raft) - n.radius, `${label} raft clear`).toBeGreaterThanOrEqual(RAFT_RANGE);
    expect(dist(n, site.spring) - n.radius, `${label} spring clear`).toBeGreaterThanOrEqual(SPRING_RANGE);
    expect(dist(n, site.wreck) - n.radius, `${label} wreck clear`).toBeGreaterThanOrEqual(3);
    for (const s of site.spawns) expect(dist(n, s) - n.radius, `${label} spawn clear`).toBeGreaterThanOrEqual(0.9);
    if (site.cave) expect(dist(n, site.cave) - n.radius, `${label} cave clear`).toBeGreaterThanOrEqual(site.cave.radius);
  }
}

/** Layout-independent node invariants (kinds, fields, spacing, bounds). */
function checkNodes(def: IslandDef): void {
  const label = `seed ${def.seed} ${def.layout}`;
  def.nodes.forEach((n, i) => {
    expect(n.i, label).toBe(i);
    expect(n.x, label).toBeGreaterThan(def.bounds.minX);
    expect(n.x, label).toBeLessThan(def.bounds.maxX);
    expect(n.z, label).toBeGreaterThan(def.bounds.minZ);
    expect(n.z, label).toBeLessThan(def.bounds.maxZ);
    expect(n.variant, label).toBeGreaterThanOrEqual(0);
    expect(n.variant, label).toBeLessThanOrEqual(3);
    expect(Number.isFinite(n.yaw) && n.scale > 0, label).toBe(true);
    if (n.kind === "tree") expect(n.radius, label).toBe(TREE_TRUNK_RADIUS);
    if (n.kind === "palm") expect(n.radius, label).toBe(PALM_TRUNK_RADIUS);
    if (n.kind === "rock") {
      expect(n.radius, label).toBeGreaterThanOrEqual(ROCK_RADIUS_MIN);
      expect(n.radius, label).toBeLessThanOrEqual(ROCK_RADIUS_MAX);
    }
    if (n.kind === "bush") {
      expect(n.radius, label).toBe(0);
      expect(n.amount, label).toBe(n.yield === "none" ? 0 : NODE_AMOUNT.bush);
    } else {
      expect(n.yield, label).toBe("none");
      expect(n.amount, label).toBe(NODE_AMOUNT[n.kind]);
      expect(n.height, label).toBeGreaterThan(0.4);
    }
  });
  // Spacing: colliders never overlap (a player-wide gap stays), trees ≥ 1.6 m apart.
  for (let a = 0; a < def.nodes.length; a++) {
    const p = def.nodes[a]!;
    for (let b = a + 1; b < def.nodes.length; b++) {
      const q = def.nodes[b]!;
      const d = dist(p, q);
      if (d > 4) continue;
      if (p.radius > 0 && q.radius > 0) expect(d, label).toBeGreaterThanOrEqual(p.radius + q.radius + 0.7);
      if (p.kind === "tree" && q.kind === "tree") expect(d, label).toBeGreaterThanOrEqual(1.6);
    }
  }
}

function checkGrid(def: IslandDef): void {
  const dims = def.layout === "duel" ? DUEL_GRID : SOLO_GRID;
  const g = def.grid;
  expect(g.cols).toBe(dims.cols);
  expect(g.rows).toBe(dims.rows);
  expect(g.cell).toBe(1);
  expect(g.originX).toBe(-(dims.cols - 1) / 2);
  expect(g.originZ).toBe(-(dims.rows - 1) / 2);
  expect(g.heights.length).toBe(dims.cols * dims.rows);
  for (const y of g.heights) expect(Number.isFinite(y)).toBe(true);
  expect(def.bounds).toEqual({
    minX: g.originX + WORLD_EDGE_MARGIN,
    maxX: g.originX + dims.cols - 1 - WORLD_EDGE_MARGIN,
    minZ: g.originZ + WORLD_EDGE_MARGIN,
    maxZ: g.originZ + dims.rows - 1 - WORLD_EDGE_MARGIN,
  });
  // The walkable rim of the world is open water (nothing to stand on at the invisible wall).
  for (const p of coastline(g)) {
    expect(p.x, `seed ${def.seed} land inside the bounds`).toBeGreaterThan(def.bounds.minX + 2);
    expect(p.x).toBeLessThan(def.bounds.maxX - 2);
    expect(p.z).toBeGreaterThan(def.bounds.minZ + 2);
    expect(p.z).toBeLessThan(def.bounds.maxZ - 2);
  }
  expect(def.gridHash).toBe(gridHash(g));
  expect(def.defHash).toBe(defHash(def));
  expect(def.biome).toBe(biomeForSeed(def.seed));
}

/* --------------------------------------------------------------- tests */

describe("determinism", () => {
  it("same seed → bit-identical island (heights, placement, hashes)", () => {
    for (const seed of [1, 4471, 9023, 0xdeadbeef]) {
      for (const layout of ["solo", "duel"] as const) {
        const a = generateIsland(seed, layout);
        const b = generateIsland(seed, layout);
        expect(b.gridHash).toBe(a.gridHash);
        expect(b.defHash).toBe(a.defHash);
        expect(Array.from(b.grid.heights)).toEqual(Array.from(a.grid.heights));
        expect(b.sites).toEqual(a.sites);
        expect(b.nodes).toEqual(a.nodes);
        expect(b.fishSpots).toEqual(a.fishSpots);
      }
    }
  });

  it("golden hashes (regression lock: update only on an intentional generator change)", () => {
    const got = [generateIsland(4471), generateIsland(9023), generateIsland(1), generateIsland(6), generateIsland(22, "duel")].map((d) => [
      d.biome,
      d.gridHash,
      d.defHash,
    ]);
    expect(got).toEqual(GOLDEN);
  });

  it("seeds are normalized to uint32 and different seeds give different islands", () => {
    expect(generateIsland(-1).defHash).toBe(generateIsland(0xffffffff).defHash);
    const hashes = new Set(SOLO_SEEDS.slice(0, 20).map((s) => generateIsland(s).gridHash));
    expect(hashes.size).toBe(20);
  });

  it("defHash reacts to any gameplay change", () => {
    const def = generateIsland(77);
    const base = defHash(def);
    const moved = { ...def, nodes: def.nodes.map((n, i) => (i === 10 ? { ...n, x: n.x + 0.05 } : n)) };
    expect(defHash(moved)).not.toBe(base);
    const site = def.sites[0]!;
    const spawned = { ...def, sites: [{ ...site, spawns: site.spawns.map((s, i) => (i === 2 ? { ...s, z: s.z + 0.05 } : s)) }] };
    expect(defHash(spawned)).not.toBe(base);
    const yielded = { ...def, nodes: def.nodes.map((n) => (n.kind === "bush" && n.yield === "rope" ? { ...n, yield: "berry" as const } : n)) };
    expect(defHash(yielded)).not.toBe(base);
    // Cosmetic fields are not part of it.
    const spun = { ...def, nodes: def.nodes.map((n) => ({ ...n, yaw: n.yaw + 1, variant: (n.variant + 1) % 4 })) };
    expect(defHash(spun)).toBe(base);
  });

  it("biomeForSeed is stable and every biome shows up", () => {
    const seen = new Set(SOLO_SEEDS.map((s) => biomeForSeed(s)));
    expect([...seen].sort()).toEqual([...BIOME_IDS].sort());
    for (const s of SOLO_SEEDS) expect(biomeForSeed(s)).toBe(biomeForSeed(s));
  });

  it("gameplay code uses no engine-dependent Math (sin/cos/pow/exp/log/…) or randomness", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThanOrEqual(8);
    const banned = /Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|pow|exp|expm1|log|log2|log10|log1p|cbrt|hypot|random)\b|Date\.now|performance\.now|\*\*/;
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
      src.split("\n").forEach((line, n) => {
        if (line.includes("cosmetic-trig")) return;
        const code = line.replace(/\/\/.*$/, "");
        expect(banned.test(code), `${f}:${n + 1}: ${line.trim()}`).toBe(false);
      });
    }
  });
});

describe(`solo island: ${SOLO_COUNT} seeds`, () => {
  const defs = SOLO_SEEDS.map((s) => generateIsland(s));

  it("grid, bounds, hashes", () => {
    for (const def of defs) {
      expect(def.layout).toBe("solo");
      expect(def.sites.length).toBe(1);
      expect(def.sites[0]!.team).toBe(0);
      expect(def.sites[0]!.center).toEqual({ x: 0, z: 0 });
      checkGrid(def);
    }
  });

  it("landmarks, shore, fish spots, corridors, reachability, nodes", () => {
    for (const def of defs) {
      checkSite(def, def.sites[0]!);
      checkNodes(def);
      expect(def.fishSpots.map((f) => f.i)).toEqual(def.fishSpots.map((_, i) => i));
    }
  });

  it("varied: landmarks move around, caves exist on most islands", () => {
    const quadrant = (p: XZ): number => (p.x >= 0 ? 1 : 0) + (p.z >= 0 ? 2 : 0);
    expect(new Set(defs.map((d) => quadrant(d.sites[0]!.raft))).size).toBe(4);
    expect(new Set(defs.map((d) => quadrant(d.sites[0]!.spring))).size).toBe(4);
    expect(defs.filter((d) => d.sites[0]!.cave).length).toBeGreaterThanOrEqual(Math.floor(defs.length * 0.8));
  });
});

describe(`duel islands: ${DUEL_COUNT} seeds`, () => {
  const defs = DUEL_SEEDS.map((s) => generateIsland(s, "duel"));

  it("two islands, team 0 left / team 1 right, every site promise holds", () => {
    for (const def of defs) {
      expect(def.layout).toBe("duel");
      checkGrid(def);
      expect(def.sites.map((s) => s.team)).toEqual([0, 1]);
      const [left, right] = def.sites as [IslandSite, IslandSite];
      expect(left.center.x).toBeLessThan(0);
      expect(right.center.x).toBeGreaterThan(0);
      for (const site of def.sites) checkSite(def, site);
      checkNodes(def);
      expect(def.nodes.some((n) => n.island === 0) && def.nodes.some((n) => n.island === 1)).toBe(true);
    }
  });

  it("the strait between the coasts is water and 26–30 m wide", () => {
    for (const def of defs) {
      const coast = coastline(def.grid);
      const a = coast.filter((p) => islandOf(def, p) === 0);
      const b = coast.filter((p) => islandOf(def, p) === 1);
      let gap = Infinity;
      for (const p of a) for (const q of b) gap = Math.min(gap, dist(p, q));
      expect(gap, `seed ${def.seed}`).toBeGreaterThanOrEqual(STRAIT_MIN);
      expect(gap, `seed ${def.seed}`).toBeLessThanOrEqual(STRAIT_MAX);
      // Along the line between the centers there is a water run at least as wide as the strait.
      const c0 = def.sites[0]!.center;
      const c1 = def.sites[1]!.center;
      const len = dist(c0, c1);
      let run = 0;
      let best = 0;
      for (let s = 0; s <= len; s += 0.25) {
        const wet = heightAt(def.grid, c0.x + ((c1.x - c0.x) * s) / len, c0.z + ((c1.z - c0.z) * s) / len) < 0;
        run = wet ? run + 0.25 : 0;
        best = Math.max(best, run);
      }
      expect(best, `seed ${def.seed}`).toBeGreaterThanOrEqual(STRAIT_MIN - 0.5);
    }
  });

  it("rafts and wrecks never face the other island", () => {
    for (const def of defs) {
      for (const site of def.sites) {
        const other = def.sites[1 - site.team]!.center;
        const ax = site.center.x - other.x;
        const az = site.center.z - other.z;
        const al = Math.sqrt(ax * ax + az * az);
        const fx = -Math.sin(site.raft.yaw);
        const fz = -Math.cos(site.raft.yaw);
        expect((fx * ax + fz * az) / al, `seed ${def.seed} team ${site.team}`).toBeGreaterThan(-0.25);
      }
    }
  });
});

describe("performance", () => {
  // Budget: < 40 ms solo / < 80 ms duel on average (§5.3). CI machines are slow and noisy: ×3 slack.
  const CI = 3;
  it("solo and duel generation stay within the time budget", () => {
    generateIsland(123);
    generateIsland(123, "duel");
    const time = (layout: "solo" | "duel", n: number): number => {
      const t0 = performance.now();
      for (let k = 0; k < n; k++) generateIsland(1000 + k * 7, layout);
      return (performance.now() - t0) / n;
    };
    const solo = time("solo", 20);
    const duel = time("duel", 8);
    console.info(`island generation: solo ${solo.toFixed(1)} ms, duel ${duel.toFixed(1)} ms (average)`);
    expect(solo).toBeLessThan(40 * CI);
    expect(duel).toBeLessThan(80 * CI);
  });
});

/**
 * [biome, gridHash, defHash] of seeds 4471, 9023, 1, 6 (solo) and 22 (duel). A change here means every
 * server/client pair built before and after it disagrees on the island: bump it only on purpose.
 */
const GOLDEN: [string, number, number][] = [
  ["swamp", 3564759874, 1849935829],
  ["swamp", 330088526, 1788469798],
  ["rocky", 152634470, 1540110296],
  ["volcanic", 3274731, 3042361994],
  ["rocky", 471476578, 200819455],
];
