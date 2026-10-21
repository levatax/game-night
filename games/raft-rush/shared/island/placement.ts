// Resource node placement (trees, palms, rocks, bushes) with spacing, keep-outs and corridors. Owner: island.
//
// Per island, counts are round(BASE_NODE_COUNTS × BIOMES[b].counts) (duel: each island gets the full set).
// Order: rocks around the cave mouth and next to fish spots, two palms near the camp (coconuts within reach of
// the spawn), then trees (inland on grass, clustered by a forest noise), palms (on / near the beach), rocks
// (anywhere, more on slopes) and bushes (in clusters). Each kind first samples with its density, then fills up
// the rest with only the hard rules, so the counts are met on every seed.
//
// Hard rules: on the node's own island, terrain height / slope / coast distance per kind, never in the keep-out
// discs of the landmarks, never within CORRIDOR_WIDTH / 2 (+ the node's collider radius) of a corridor segment
// (wreck↔camp, camp↔raft, wreck↔raft, raft↔sea, camp↔spring), and min spacing to every other node.
//
// Gameplay fields (kind, x, z, y, radius, height, yield, amount) come from a mulberry32 stream with + − × ÷
// only. yaw and variant are cosmetic and come from a separate stream (changing them never moves a node).
//
// Archetype scale contract for the renderer: trees are modeled TREE_HEIGHT tall and palms PALM_HEIGHT tall at
// scale 1 (their collider `height` = that × scale); a rock archetype has radius 1 and height 1, drawn scaled by
// (radius, height, radius) — its `scale` equals its radius; bushes are BUSH_SIZE wide at scale 1.

import {
  BASE_NODE_COUNTS,
  BIOMES,
  CORRIDOR_WIDTH,
  FIRE_LIGHT_RADIUS,
  NODE_AMOUNT,
  PALM_TRUNK_RADIUS,
  RAFT_RANGE,
  ROCK_RADIUS_MAX,
  ROCK_RADIUS_MIN,
  SPRING_RANGE,
  TREE_TRUNK_RADIUS,
  WORLD_EDGE_MARGIN,
} from "../constants.js";
import type { Biome, BushYield, NodeKind, Vec3Like } from "../types.js";
import { heightAt, normalAt } from "./heightfield.js";
import { fbm2, mulberry32, smoothstep, subSeed } from "./noise.js";
import { DIRS16, DIRS32 } from "./rational.js";
import type { CaveSpot } from "./landmarks.js";
import { vertexIndex, vertexX, vertexZ, type Terrain } from "./terrain.js";
import type { IslandSite, NodeDef, XZ } from "./types.js";

/** Tree archetype height at scale 1 (m); collider height = TREE_HEIGHT × scale. */
export const TREE_HEIGHT = 4.2;
/** Palm archetype height at scale 1 (m); collider height = PALM_HEIGHT × scale. */
export const PALM_HEIGHT = 5.2;
/** Bush archetype width at scale 1 (m). Bushes don't collide. */
export const BUSH_SIZE = 1.1;
/** Keep-out around the wreck hull (its collider is 1.8 m; the spawns stand around it). */
export const WRECK_KEEP_OUT = 4.2;
/** Node-free clearing around the campfire (its light ring + 0.5 m: room to craft and to fight). */
export const CAMP_KEEP_OUT = FIRE_LIGHT_RADIUS + 0.5;

const KINDS: ReadonlyArray<NodeKind> = ["tree", "palm", "rock", "bush"];

/** Minimum center distance between two node kinds (before the collider radii rule). */
const PAIR_SPACING: Readonly<Record<NodeKind, Readonly<Record<NodeKind, number>>>> = {
  tree: { tree: 1.6, palm: 1.8, rock: 0, bush: 1 },
  palm: { tree: 1.8, palm: 2.4, rock: 0, bush: 1.1 },
  rock: { tree: 0, palm: 0, rock: 0, bush: 0 },
  bush: { tree: 1, palm: 1.1, rock: 0, bush: 1.2 },
};
/** Clear gap between two colliders (≈ a player's width), and between a collider and a bush. */
const COLLIDER_GAP = 0.75;
const BUSH_GAP = 0.45;
/** Largest possible spacing (two max rocks): the spatial hash bucket must be at least this. */
const BUCKET = 3;

/** Hard terrain rules per kind: height band, minimum slope normal.y and distance to the water (m). */
interface KindRule {
  minY: number;
  maxY: number;
  minNy: number;
  minCoast: number;
  maxCoast: number;
}

const RULES: Readonly<Record<NodeKind, KindRule>> = {
  tree: { minY: 0.85, maxY: 1e9, minNy: 0.72, minCoast: 2.5, maxCoast: 1e9 },
  palm: { minY: 0.08, maxY: 2.4, minNy: 0.8, minCoast: 0, maxCoast: 9 },
  rock: { minY: 0.05, maxY: 1e9, minNy: 0.55, minCoast: 0, maxCoast: 1e9 },
  bush: { minY: 0.4, maxY: 1e9, minNy: 0.65, minCoast: 1.5, maxCoast: 1e9 },
};
const CAMP_PALM_RULE: KindRule = { minY: 0.08, maxY: 3, minNy: 0.78, minCoast: 0, maxCoast: 1e9 };

/** Everything the placement of one island needs to know about its site. */
export interface PlacementSite {
  island: number;
  site: IslandSite;
  /** Unit seaward direction at the raft (the launch corridor). */
  raftDir: XZ;
  cave: CaveSpot | null;
  fishSpots: XZ[];
}

interface Draft {
  kind: NodeKind;
  x: number;
  z: number;
  radius: number;
  height: number;
  scale: number;
  island: number;
}

interface Circle {
  x: number;
  z: number;
  r: number;
}

interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

const scratchN: Vec3Like = { x: 0, y: 1, z: 0 };

/** Target node counts per island for a biome. */
export function nodeTargets(biome: Biome): Record<NodeKind, number> {
  const c = BIOMES[biome].counts;
  return {
    tree: Math.round(BASE_NODE_COUNTS.tree * c.tree),
    palm: Math.round(BASE_NODE_COUNTS.palm * c.palm),
    rock: Math.round(BASE_NODE_COUNTS.rock * c.rock),
    bush: Math.round(BASE_NODE_COUNTS.bush * c.bush),
  };
}

/** Corridor segments of a site (CORRIDOR_WIDTH clear of nodes). */
export function siteCorridors(site: IslandSite, raftDir: XZ): Segment[] {
  const sea = { x: site.raft.x + raftDir.x * 8, z: site.raft.z + raftDir.z * 8 };
  const seg = (a: XZ, b: XZ): Segment => ({ ax: a.x, az: a.z, bx: b.x, bz: b.z });
  return [seg(site.wreck, site.campfire), seg(site.campfire, site.raft), seg(site.wreck, site.raft), seg(site.raft, sea), seg(site.campfire, site.spring)];
}

/** Keep-out discs of a site (nodes must stay outside r + their own radius). */
export function siteKeepOuts(site: IslandSite): Circle[] {
  const out: Circle[] = [
    { x: site.wreck.x, z: site.wreck.z, r: WRECK_KEEP_OUT },
    { x: site.campfire.x, z: site.campfire.z, r: CAMP_KEEP_OUT },
    { x: site.chest.x, z: site.chest.z, r: 1.6 },
    { x: site.raft.x, z: site.raft.z, r: RAFT_RANGE + 0.5 },
    { x: site.spring.x, z: site.spring.z, r: SPRING_RANGE + 0.6 },
    { x: site.secretChest.x, z: site.secretChest.z, r: 2 },
  ];
  for (const s of site.spawns) out.push({ x: s.x, z: s.z, r: 1 });
  if (site.cave) out.push({ x: site.cave.x, z: site.cave.z, r: site.cave.radius + 0.6 });
  return out;
}

/** Distance from (x, z) to segment s. */
export function distToSegment(x: number, z: number, s: Segment): number {
  const vx = s.bx - s.ax;
  const vz = s.bz - s.az;
  const wx = x - s.ax;
  const wz = z - s.az;
  const vv = vx * vx + vz * vz;
  let t = vv > 1e-12 ? (wx * vx + wz * vz) / vv : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = wx - vx * t;
  const dz = wz - vz * t;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Place every island's nodes. Returns them grouped by island, then kind (tree, palm, rock, bush), indexed. */
export function placeNodes(t: Terrain, coast: Float32Array, biome: Biome, seed: number, sites: PlacementSite[]): NodeDef[] {
  const placer = new Placer(t, coast, biome, subSeed(seed, 650));
  const drafts: Draft[] = [];
  for (const ps of sites) drafts.push(...placer.placeIsland(ps, seed));
  const yields = assignYields(drafts, biome, mulberry32(subSeed(seed, 700)));
  const cosmetic = mulberry32(subSeed(seed, 900));
  return drafts.map((d, i) => {
    const y = yields[i]!;
    return {
      i,
      kind: d.kind,
      x: d.x,
      z: d.z,
      y: heightAt(t.grid, d.x, d.z),
      radius: d.radius,
      height: d.height,
      yield: y,
      amount: d.kind === "bush" && y === "none" ? 0 : NODE_AMOUNT[d.kind],
      island: d.island,
      yaw: cosmetic() * Math.PI * 2,
      scale: d.scale,
      variant: Math.floor(cosmetic() * 4),
    };
  });
}

/** Bush yields in exact biome shares (rope / berry / decorative), shuffled over the bushes. */
function assignYields(drafts: Draft[], biome: Biome, rng: () => number): BushYield[] {
  const out: BushYield[] = drafts.map(() => "none");
  const islands = new Set(drafts.map((d) => d.island));
  const b = BIOMES[biome];
  for (const island of [...islands].sort((p, q) => p - q)) {
    const idx: number[] = [];
    drafts.forEach((d, i) => {
      if (d.kind === "bush" && d.island === island) idx.push(i);
    });
    const rope = Math.round(idx.length * b.ropeShare);
    const berry = Math.min(idx.length - rope, Math.round(idx.length * b.berryShare));
    const pool: BushYield[] = [];
    for (let k = 0; k < idx.length; k++) pool.push(k < rope ? "rope" : k < rope + berry ? "berry" : "none");
    for (let k = pool.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      const tmp = pool[k]!;
      pool[k] = pool[j]!;
      pool[j] = tmp;
    }
    idx.forEach((di, k) => {
      out[di] = pool[k]!;
    });
  }
  return out;
}

/** Stateful placer: spatial hash of placed nodes plus the current island's constraints. */
class Placer {
  private readonly buckets: number[][];
  private readonly bcols: number;
  private readonly brows: number;
  private readonly placed: Draft[] = [];
  private keep: Circle[] = [];
  private corridors: Segment[] = [];
  private island = 0;
  private readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };

  constructor(
    private readonly t: Terrain,
    private readonly coast: Float32Array,
    private readonly biome: Biome,
    /** Seed of the forest-density noise (tree / bush clustering). */
    private readonly forestSeed: number,
  ) {
    const g = t.grid;
    const w = (g.cols - 1) * g.cell;
    const d = (g.rows - 1) * g.cell;
    this.bcols = Math.ceil(w / BUCKET) + 1;
    this.brows = Math.ceil(d / BUCKET) + 1;
    this.buckets = [];
    for (let k = 0; k < this.bcols * this.brows; k++) this.buckets.push([]);
    this.bounds = {
      minX: g.originX + WORLD_EDGE_MARGIN + 1,
      maxX: g.originX + w - WORLD_EDGE_MARGIN - 1,
      minZ: g.originZ + WORLD_EDGE_MARGIN + 1,
      maxZ: g.originZ + d - WORLD_EDGE_MARGIN - 1,
    };
  }

  /** All nodes of one island, grouped by kind. */
  placeIsland(ps: PlacementSite, seed: number): Draft[] {
    this.island = ps.island;
    this.keep = siteKeepOuts(ps.site);
    this.corridors = siteCorridors(ps.site, ps.raftDir);
    const rng = mulberry32(subSeed(seed, 600 + ps.island));
    const target = nodeTargets(this.biome);
    const box = this.landBox(ps.island);
    const mine: Draft[] = [];
    const tally: Record<NodeKind, number> = { tree: 0, palm: 0, rock: 0, bush: 0 };
    const count = (kind: NodeKind): number => tally[kind];
    const add = (d: Draft | null): boolean => {
      if (!d) return false;
      mine.push(d);
      tally[d.kind]++;
      return true;
    };
    const rocky = this.biome === "rocky";

    // 1. A rock cluster around the cave mouth (uphill side first).
    if (ps.cave) {
      const want = rocky ? 6 : 4;
      let got = 0;
      const start = Math.floor(rng() * DIRS16.length);
      for (let a = 0; a < 48 && got < want && count("rock") < target.rock; a++) {
        const d = DIRS16[(start + a * 5) % DIRS16.length]!;
        if (a < 32 && d.x * ps.cave.up.x + d.z * ps.cave.up.z < -0.3) continue;
        const r = ps.cave.radius + 0.9 + rng() * 1.6;
        if (add(this.tryRock(ps.cave.x + d.x * r, ps.cave.z + d.z * r, rng, RULES.rock))) got++;
      }
    }
    // 2. Rocks on the beach next to fish spots (rocky: every spot, else every other one).
    ps.fishSpots.forEach((f, j) => {
      if (!rocky && j % 2 === 1) return;
      if (count("rock") >= target.rock) return;
      const land = this.nearestLand(f, ps.island, 10);
      if (land) add(this.tryRock(land.x + (rng() - 0.5) * 0.6, land.z + (rng() - 0.5) * 0.6, rng, RULES.rock));
    });
    // 3. Two palms 7–14 m from the campfire.
    let campPalms = 0;
    for (let a = 0; a < 80 && campPalms < 2; a++) {
      const d = DIRS32[Math.floor(rng() * DIRS32.length)]!;
      const r = 7 + rng() * 7;
      const x = ps.site.campfire.x + d.x * r;
      const z = ps.site.campfire.z + d.z * r;
      const scale = 0.85 + rng() * 0.35;
      if (add(this.tryAdd("palm", x, z, PALM_TRUNK_RADIUS, PALM_HEIGHT * scale, scale, CAMP_PALM_RULE))) campPalms++;
    }
    // 4–7. Density passes, then fill passes with the hard rules only.
    for (const kind of KINDS) {
      if (kind === "bush") this.bushClusters(target.bush - tally.bush, box, rng, add);
      for (let pass = 0; pass < 2; pass++) {
        const tries = target[kind] * 40;
        for (let a = 0; a < tries && count(kind) < target[kind]; a++) {
          const x = box.minX + rng() * (box.maxX - box.minX);
          const z = box.minZ + rng() * (box.maxZ - box.minZ);
          if (pass === 0 && rng() > this.density(kind, x, z)) continue;
          add(this.tryKind(kind, x, z, rng));
        }
      }
    }
    const order = (d: Draft): number => KINDS.indexOf(d.kind);
    return mine.map((d, k) => ({ d, k })).sort((a, b) => order(a.d) - order(b.d) || a.k - b.k).map((e) => e.d);
  }

  /** Bushes in clusters of 3–6 around accepted centers. */
  private bushClusters(
    target: number,
    box: { minX: number; maxX: number; minZ: number; maxZ: number },
    rng: () => number,
    add: (d: Draft | null) => boolean,
  ): void {
    let bushes = 0;
    for (let c = 0; c < target * 3 && bushes < target; c++) {
      const cx = box.minX + rng() * (box.maxX - box.minX);
      const cz = box.minZ + rng() * (box.maxZ - box.minZ);
      if (rng() > this.density("bush", cx, cz)) continue;
      if (!this.terrainOk(cx, cz, RULES.bush)) continue;
      const size = 3 + Math.floor(rng() * 4);
      let got = 0;
      for (let m = 0; m < size * 4 && got < size && bushes < target; m++) {
        const ox = (rng() * 2 - 1) * 3.2;
        const oz = (rng() * 2 - 1) * 3.2;
        if (ox * ox + oz * oz > 3.2 * 3.2) continue;
        if (add(this.tryKind("bush", cx + ox, cz + oz, rng))) {
          got++;
          bushes++;
        }
      }
    }
  }

  /** Acceptance probability of a density pass. */
  private density(kind: NodeKind, x: number, z: number): number {
    const g = this.t.grid;
    if (kind === "tree" || kind === "bush") {
      const forest = fbm2(x * 0.05 + 13.1, z * 0.05 - 7.7, this.forestSeed, 3);
      return kind === "tree" ? 0.12 + 0.88 * smoothstep(0.36, 0.6, forest) : 0.3 + 0.7 * smoothstep(0.3, 0.55, forest);
    }
    if (kind === "palm") {
      const vi = vertexIndex(g, x, z);
      const cd = g.heights[vi]! >= 0 ? this.coast[vi]! : 0;
      return 1 - 0.75 * smoothstep(2, 7, cd);
    }
    const ny = normalAt(g, x, z, scratchN).y;
    const peakY = g.heights[this.t.summit[this.island]!]!;
    const y = heightAt(g, x, z);
    const rugged = BIOMES[this.biome].rugged;
    return 0.25 + 0.75 * smoothstep(0.95, 0.72, ny) + rugged * 0.4 * smoothstep(0.45, 0.8, y / peakY);
  }

  /** Draw the kind's size from the rng and try to add it. */
  private tryKind(kind: NodeKind, x: number, z: number, rng: () => number): Draft | null {
    if (kind === "rock") return this.tryRock(x, z, rng, RULES.rock);
    const scale = kind === "bush" ? 0.8 + rng() * 0.45 : 0.85 + rng() * 0.35;
    if (kind === "tree") return this.tryAdd("tree", x, z, TREE_TRUNK_RADIUS, TREE_HEIGHT * scale, scale, RULES.tree);
    if (kind === "palm") return this.tryAdd("palm", x, z, PALM_TRUNK_RADIUS, PALM_HEIGHT * scale, scale, RULES.palm);
    return this.tryAdd("bush", x, z, 0, 0, scale, RULES.bush);
  }

  private tryRock(x: number, z: number, rng: () => number, rule: KindRule): Draft | null {
    const radius = ROCK_RADIUS_MIN + rng() * (ROCK_RADIUS_MAX - ROCK_RADIUS_MIN);
    const height = radius * (0.9 + rng() * 0.5);
    return this.tryAdd("rock", x, z, radius, height, radius, rule);
  }

  /** Terrain rules only (island, height band, slope, coast distance, bounds). */
  private terrainOk(x: number, z: number, rule: KindRule): boolean {
    const b = this.bounds;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return false;
    const g = this.t.grid;
    const vi = vertexIndex(g, x, z);
    if (this.t.owner[vi] !== this.island || g.heights[vi]! < 0) return false;
    const y = heightAt(g, x, z);
    if (y < rule.minY || y > rule.maxY) return false;
    const cd = this.coast[vi]!;
    if (cd < rule.minCoast || cd > rule.maxCoast) return false;
    return normalAt(g, x, z, scratchN).y >= rule.minNy;
  }

  /** Every rule; on success the node is registered in the spatial hash and returned. */
  private tryAdd(kind: NodeKind, x: number, z: number, radius: number, height: number, scale: number, rule: KindRule): Draft | null {
    if (!this.terrainOk(x, z, rule)) return null;
    for (const c of this.keep) {
      const dx = x - c.x;
      const dz = z - c.z;
      const r = c.r + radius;
      if (dx * dx + dz * dz < r * r) return null;
    }
    const clear = CORRIDOR_WIDTH / 2 + radius + 0.15;
    for (const s of this.corridors) if (distToSegment(x, z, s) < clear) return null;
    if (!this.spaced(kind, x, z, radius)) return null;
    const d: Draft = { kind, x, z, radius, height, scale, island: this.island };
    this.placed.push(d);
    this.buckets[this.bucketOf(x, z)]!.push(this.placed.length - 1);
    return d;
  }

  private bucketOf(x: number, z: number): number {
    const g = this.t.grid;
    let bc = Math.floor((x - g.originX) / BUCKET);
    let br = Math.floor((z - g.originZ) / BUCKET);
    if (bc < 0) bc = 0;
    else if (bc >= this.bcols) bc = this.bcols - 1;
    if (br < 0) br = 0;
    else if (br >= this.brows) br = this.brows - 1;
    return br * this.bcols + bc;
  }

  /** Min spacing to every placed node (3 × 3 buckets cover the largest spacing). */
  private spaced(kind: NodeKind, x: number, z: number, radius: number): boolean {
    const b = this.bucketOf(x, z);
    const bc = b % this.bcols;
    const br = Math.floor(b / this.bcols);
    for (let r = br - 1; r <= br + 1; r++) {
      if (r < 0 || r >= this.brows) continue;
      for (let c = bc - 1; c <= bc + 1; c++) {
        if (c < 0 || c >= this.bcols) continue;
        for (const j of this.buckets[r * this.bcols + c]!) {
          const o = this.placed[j]!;
          const both = radius > 0 && o.radius > 0;
          let min = radius + o.radius + (both ? COLLIDER_GAP : BUSH_GAP);
          const pair = PAIR_SPACING[kind][o.kind];
          if (pair > min) min = pair;
          const dx = x - o.x;
          const dz = z - o.z;
          if (dx * dx + dz * dz < min * min) return false;
        }
      }
    }
    return true;
  }

  /** Bounding box of the island's land vertices. */
  private landBox(island: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const g = this.t.grid;
    let minX = 1e9;
    let maxX = -1e9;
    let minZ = 1e9;
    let maxZ = -1e9;
    for (let i = 0; i < g.heights.length; i++) {
      if (this.t.owner[i] !== island || g.heights[i]! < 0) continue;
      const x = vertexX(g, i);
      const z = vertexZ(g, i);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    return { minX, maxX, minZ, maxZ };
  }

  /** Nearest land vertex (height ≥ 0.1) of `island` within `radius` of p. */
  private nearestLand(p: XZ, island: number, radius: number): XZ | null {
    const g = this.t.grid;
    let best: XZ | null = null;
    let bestD = radius * radius;
    const c0 = Math.floor(p.x - radius - g.originX);
    const r0 = Math.floor(p.z - radius - g.originZ);
    const span = Math.ceil(radius * 2) + 1;
    for (let r = r0; r <= r0 + span; r++) {
      if (r < 0 || r >= g.rows) continue;
      for (let c = c0; c <= c0 + span; c++) {
        if (c < 0 || c >= g.cols) continue;
        const i = r * g.cols + c;
        if (this.t.owner[i] !== island || g.heights[i]! < 0.1) continue;
        const x = vertexX(g, i);
        const z = vertexZ(g, i);
        const dx = x - p.x;
        const dz = z - p.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = { x, z };
        }
      }
    }
    return best;
  }
}
