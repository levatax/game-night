// Seed → IslandDef: the procedural island(s) of game4.md §9 / docs/ARCHITECTURE.md §5.3. Owner: island.
//
// Pipeline (every stage deterministic; gameplay data uses integer-hash noise, mulberry32, + − × ÷,
// Math.floor / Math.sqrt / Math.fround only — the raft / wreck yaw and node yaw / variant are cosmetic):
//   1. shape.ts      plan each island (elliptical mask, rational rotation, ring-noise coast, low rolling lowland
//                    with knolls / tors and a gentle main rise, peak 4–7 m) and rasterize it in island-local
//                    coordinates;
//      duel         solve the integer center distance that leaves a 26–30 m strait (team 0 left, team 1 right),
//                    sometimes with a walkable sandbar across it;
//   2. terrain.ts    compose the rasters into the grid, scale the hills to the planned peak, clamp slopes so the
//                    land stays walkable (cliff walls excepted);
//   3. landmarks.ts  raft (flattest open-facing beach cell at the waterline) → wreck → camp, flattened; then the
//                    cave, spring and secret chest among the vertices reachable on foot from the camp; chest and
//                    six spawns on the sand around the wreck;
//   4. coast.ts      ≥ 24 shore cells spread around the coast, 4–6 (+ biome extra) fish spots;
//   5. placement.ts  BASE_NODE_COUNTS × biome nodes with spacing, keep-outs and corridors.
// Cost (Node 22, warm): ~3 ms solo, ~9 ms duel on average; the first cold call ~25 / ~45 ms.

import {
  BIOMES,
  BIOME_IDS,
  CELL_SIZE,
  DUEL_GRID,
  FISH_SPOTS_MAX,
  FISH_SPOTS_MIN,
  SOLO_GRID,
  STRAIT_MAX,
  STRAIT_MIN,
  WORLD_EDGE_MARGIN,
} from "../constants.js";
import type { Biome, BushYield, Layout, NodeKind } from "../types.js";
import { chooseFishSpots, chooseShore } from "./coast.js";
import { createHeightfield, gridHash } from "./heightfield.js";
import {
  chestSpot,
  chooseCave,
  chooseCore,
  chooseSecretChest,
  chooseSpawns,
  chooseSpring,
  flattenCore,
  yawToward,
  type CaveSpot,
  type CoreSite,
} from "./landmarks.js";
import { fnv1aInts, hash01, mulberry32, subSeed } from "./noise.js";
import { placeNodes, type PlacementSite } from "./placement.js";
import { planIsland, rasterizeIsland, solveStraitOffset, type IslandPlan, type IslandRaster } from "./shape.js";
import { clampSlopes, coastDistance, composeTerrain, solvePeaks, type Terrain } from "./terrain.js";
import type { FishSpotDef, Heightfield, IslandDef, IslandSite, XZ } from "./types.js";
import { reachableFrom } from "./walk.js";

/** Raster half-size (m) of a duel island: land ≤ ~60 m from its center + the shelf and drop-off. */
const DUEL_RASTER_HALF = 84;
/** Chance that a duel strait has a walkable sandbar across it (game4.md §13). */
const SANDBAR_CHANCE = 0.4;

/** Biome picked by a seed (stable). */
export function biomeForSeed(seed: number): Biome {
  return BIOME_IDS[subSeed(seed, 11) % BIOME_IDS.length]!;
}

/** Generate the island(s) for `seed` (any number; normalized to uint32). Pure and deterministic. */
export function generateIsland(seed: number, layout: Layout = "solo"): IslandDef {
  const s = seed >>> 0;
  const biome = biomeForSeed(s);
  const duel = layout === "duel";
  const dims = duel ? DUEL_GRID : SOLO_GRID;
  const originX = -((dims.cols - 1) * CELL_SIZE) / 2;
  const originZ = -((dims.rows - 1) * CELL_SIZE) / 2;
  const grid = createHeightfield(dims.cols, dims.rows, CELL_SIZE, originX, originZ);

  // 1. Shapes (+ duel layout).
  const layoutRng = mulberry32(subSeed(s, 150));
  const plans: IslandPlan[] = duel ? [planIsland(s, 0, biome, true), planIsland(s, 1, biome, true)] : [planIsland(s, 0, biome, false)];
  const half = duel ? DUEL_RASTER_HALF : (dims.cols - 1) / 2;
  const rasters = plans.map((p) => rasterizeIsland(p, half));
  if (duel) placeDuelIslands(rasters, layoutRng);

  // 2. Terrain.
  const t = composeTerrain(grid, rasters, subSeed(s, 160));
  solvePeaks(t);
  if (duel && layoutRng() < SANDBAR_CHANCE) addSandbar(t, layoutRng);

  // 3. Landmarks.
  const away = plans.map((_, k) => awayDir(plans, k));
  const coast0 = coastDistance(grid);
  const cores: CoreSite[] = plans.map((_, k) => chooseCore(t, k, coast0, away[k]!, s));
  for (const core of cores) flattenCore(t, core);
  clampSlopes(grid, t.lip);
  const caves: (CaveSpot | null)[] = cores.map((core, k) => chooseCave(t, k, core, reachableFrom(grid, t.owner, k, core.camp.x, core.camp.z), s));
  clampSlopes(grid, t.lip);
  const coast1 = coastDistance(grid);
  const siteRngs = plans.map((_, k) => mulberry32(subSeed(s, 400 + k)));
  const springs: XZ[] = cores.map((core, k) =>
    chooseSpring(t, k, core, caves[k]!, reachableFrom(grid, t.owner, k, core.camp.x, core.camp.z), coast1, siteRngs[k]!),
  );
  clampSlopes(grid, t.lip);
  const coast = coastDistance(grid);

  const sites: IslandSite[] = [];
  const placement: PlacementSite[] = [];
  const fishSpots: FishSpotDef[] = [];
  cores.forEach((core, k) => {
    const rng = siteRngs[k]!;
    const cave = caves[k]!;
    const reach = reachableFrom(grid, t.owner, k, core.camp.x, core.camp.z);
    const secretChest = chooseSecretChest(t, k, core, springs[k]!, cave, reach, coast, rng);
    const chest = chestSpot(core, hash01(k, 3, s) < 0.5);
    const site: IslandSite = {
      team: k,
      center: { x: plans[k]!.cx, z: plans[k]!.cz },
      wreck: { x: core.wreck.x, z: core.wreck.z, yaw: yawToward(-core.wreckDir.x, -core.wreckDir.z) },
      spawns: chooseSpawns(t, k, core, chest),
      campfire: { x: core.camp.x, z: core.camp.z },
      chest,
      raft: { x: core.raft.x, z: core.raft.z, yaw: yawToward(core.raftDir.x, core.raftDir.z) },
      spring: springs[k]!,
      cave: cave ? { x: cave.x, z: cave.z, radius: cave.radius } : null,
      secretChest,
      shore: chooseShore(t, k, coast, core.camp),
    };
    sites.push(site);
    // 4. Fish spots.
    const fishRng = mulberry32(subSeed(s, 500 + k));
    const count = FISH_SPOTS_MIN + Math.floor(fishRng() * (FISH_SPOTS_MAX - FISH_SPOTS_MIN + 1)) + BIOMES[biome].extraFishSpots;
    const spots = chooseFishSpots(t, k, coast, core.camp, count, fishRng);
    for (const f of spots) fishSpots.push({ i: fishSpots.length, x: f.x, z: f.z, island: k });
    placement.push({ island: k, site, raftDir: core.raftDir, cave, fishSpots: spots });
  });

  // 5. Nodes.
  const nodes = placeNodes(t, coast, biome, s, placement);

  const maxX = originX + (dims.cols - 1) * CELL_SIZE;
  const maxZ = originZ + (dims.rows - 1) * CELL_SIZE;
  const def: IslandDef = {
    seed: s,
    layout,
    biome,
    grid,
    sites,
    nodes,
    fishSpots,
    bounds: { minX: originX + WORLD_EDGE_MARGIN, maxX: maxX - WORLD_EDGE_MARGIN, minZ: originZ + WORLD_EDGE_MARGIN, maxZ: maxZ - WORLD_EDGE_MARGIN },
    gridHash: gridHash(grid),
    defHash: 0,
  };
  def.defHash = defHash(def);
  return def;
}

const LAYOUT_CODE: Record<Layout, number> = { solo: 1, duel: 2 };
const KIND_CODE: Record<NodeKind, number> = { tree: 1, palm: 2, rock: 3, bush: 4 };
const YIELD_CODE: Record<BushYield, number> = { none: 0, rope: 1, berry: 2 };

/**
 * Placement hash (WelcomeMsg.defHash): FNV-1a over the layout, biome, every site field (spawns, cave and shore
 * cells included), every node's gameplay fields (kind, x, z, collider radius / height, yield, amount, island)
 * and the fish spots; positions × 100 rounded.
 */
export function defHash(def: IslandDef): number {
  const p = (n: number): number => Math.round(n * 100);
  const v: number[] = [
    def.seed | 0,
    LAYOUT_CODE[def.layout],
    BIOME_IDS.indexOf(def.biome),
    def.grid.cols,
    def.grid.rows,
    def.sites.length,
    def.nodes.length,
    def.fishSpots.length,
  ];
  const xz = (q: XZ): void => {
    v.push(p(q.x), p(q.z));
  };
  for (const s of def.sites) {
    v.push(s.team);
    xz(s.center);
    xz(s.wreck);
    v.push(s.spawns.length);
    s.spawns.forEach(xz);
    xz(s.campfire);
    xz(s.chest);
    xz(s.raft);
    xz(s.spring);
    if (s.cave) {
      v.push(1, p(s.cave.radius));
      xz(s.cave);
    } else v.push(0);
    xz(s.secretChest);
    v.push(s.shore.length);
    s.shore.forEach(xz);
  }
  for (const n of def.nodes) v.push(KIND_CODE[n.kind], p(n.x), p(n.z), p(n.radius), p(n.height), YIELD_CODE[n.yield], n.amount, n.island);
  for (const f of def.fishSpots) v.push(p(f.x), p(f.z), f.island);
  return fnv1aInts(v);
}

/* ------------------------------------------------------------------ duel */

/** Unit direction from the other island's center toward island k (null in solo). */
function awayDir(plans: IslandPlan[], k: number): XZ | null {
  if (plans.length < 2) return null;
  const me = plans[k]!;
  const other = plans[1 - k]!;
  const dx = me.cx - other.cx;
  const dz = me.cz - other.cz;
  const len = Math.sqrt(dx * dx + dz * dz);
  return len > 1e-6 ? { x: dx / len, z: dz / len } : { x: k === 0 ? -1 : 1, z: 0 };
}

/**
 * Integer centers for the two duel islands: island 0 left, island 1 right, the closest coast-to-coast distance
 * as near as possible to a random target in 27–29 m (STRAIT_MIN..MAX with a margin for the beach flattening),
 * small random z offsets, and the pair centered on the grid.
 */
function placeDuelIslands(rasters: IslandRaster[], rng: () => number): void {
  const [left, right] = rasters as [IslandRaster, IslandRaster];
  const target = STRAIT_MIN + 1 + rng() * (STRAIT_MAX - STRAIT_MIN - 2);
  const z0 = Math.floor(rng() * 7) - 3;
  const z1 = Math.floor(rng() * 7) - 3;
  const d = solveStraitOffset(left, right, z1 - z0, target);
  let cx0 = -Math.floor(d / 2);
  let cx1 = cx0 + d;
  // Land extent (local x) of an island raster toward `sign` (−1: its leftmost land, +1: its rightmost land).
  const extent = (r: IslandRaster, sign: number): number => {
    let best = 0;
    for (let i = 0; i < r.delta.length; i++) {
      if (r.delta[i]! < 0) continue;
      const lx = (i % r.size) - r.half;
      if (lx * sign > best * sign) best = lx;
    }
    return best;
  };
  const shift = Math.round(-(cx0 + extent(left, -1) + (cx1 + extent(right, 1))) / 2);
  cx0 += shift;
  cx1 += shift;
  left.plan.cx = cx0;
  left.plan.cz = z0;
  right.plan.cx = cx1;
  right.plan.cz = z1;
}

/**
 * A sandbar across the strait: a gently curved band 0.42 m under water (walkable, never land) between the two
 * island centers, its flanks sloping 0.8 m per m so the slope clamp leaves it intact.
 */
function addSandbar(t: Terrain, rng: () => number): void {
  const g: Heightfield = t.grid;
  const [a, b] = t.plans as [IslandPlan, IslandPlan];
  const zb = (a.cz + b.cz) / 2 + Math.floor(rng() * 25) - 12;
  const bend = (rng() - 0.5) * 16;
  const span = b.cx - a.cx;
  const h = g.heights;
  for (let r = 0; r < g.rows; r++) {
    const z = g.originZ + r * g.cell;
    for (let c = 0; c < g.cols; c++) {
      const x = g.originX + c * g.cell;
      const u = (x - a.cx) / span;
      if (u <= 0 || u >= 1) continue;
      const zc = zb + bend * 4 * u * (1 - u);
      const d = z > zc ? z - zc : zc - z;
      const bar = -0.42 - (d > 1.2 ? (d - 1.2) * 0.8 : 0);
      const i = r * g.cols + c;
      if (h[i]! < 0 && bar > h[i]!) {
        h[i] = Math.fround(bar);
        t.sandbar[i] = 1;
      }
    }
  }
}
