// Hand-made islands and helpers for the deterministic sim test suites. Owner: sim.
// Used by shared/sim/*.test.ts; other roles' tests (bots, world) may import it too. Never imported by runtime
// code. Pure and deterministic (no Math.random): every "random" helper is a seeded LCG.
//
// Islands are full IslandDef objects (no sites unless asked, no fish spots) so buildCover() and everything that
// takes an IslandDef work on them. Heights are sampled per vertex from a profile function, so features sit on
// exact vertex lines: a step "at x = a" is the cell face between the vertices at a and a + cell.

import { CHARACTERS, DT, PALM_TRUNK_RADIUS, SWIM_DEPTH, SWIM_FLOAT_DEPTH, TREE_TRUNK_RADIUS, WATER_Y } from "../constants.js";
import { createHeightfield, gridHash, heightAt } from "../island/heightfield.js";
import type { Heightfield, IslandDef, IslandSite, NodeDef } from "../island/types.js";
import type { InputCmd } from "../protocol.js";
import type { CharacterId, ItemKind, NodeKind } from "../types.js";
import type { ProjectileContext, SimContext } from "./context.js";
import { buildCover, type CoverIndex, type CoverQuery } from "./cover.js";
import { createPlayerSim, stepPlayer, type PlayerSim, type StepPlayerResult } from "./player.js";
import { createProjectileSim, stepProjectile, type ProjectileSim, type StepProjectileResult } from "./projectile.js";

/* ============================================================ heightfields */

/** A square heightfield `size` meters across centered on the origin, h(x, z) sampled at every vertex. */
export function heightfieldFrom(size: number, cell: number, h: (x: number, z: number) => number): Heightfield {
  const n = Math.round(size / cell) + 1;
  const origin = -((n - 1) * cell) / 2;
  const hf = createHeightfield(n, n, cell, origin, origin);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) hf.heights[r * n + c] = Math.fround(h(origin + c * cell, origin + r * cell));
  }
  return hf;
}

/** Wrap a heightfield (+ nodes / sites) into an IslandDef. Bounds = the grid shrunk by `margin`. */
export function islandFrom(grid: Heightfield, nodes: NodeDef[] = [], sites: IslandSite[] = [], margin = 1): IslandDef {
  const maxX = grid.originX + (grid.cols - 1) * grid.cell;
  const maxZ = grid.originZ + (grid.rows - 1) * grid.cell;
  return {
    seed: 0,
    layout: "solo",
    biome: "tropic",
    grid,
    sites,
    nodes: nodes.map((n, i) => ({ ...n, i })),
    fishSpots: [],
    bounds: { minX: grid.originX + margin, maxX: maxX - margin, minZ: grid.originZ + margin, maxZ: maxZ - margin },
    gridHash: gridHash(grid),
    defHash: 0,
  };
}

/** Flat dry land at `height` (32 × 32 m, 1 m cells). */
export function flatIsland(height = 1, nodes: NodeDef[] = [], size = 32): IslandDef {
  return islandFrom(heightfieldFrom(size, 1, () => height), nodes);
}

/** A plane rising along +x: h = base + grade · x (grade 0.3 ≈ 17°, walkable; 2 ≈ 63°, a wall). */
export function slopeIsland(grade = 0.3, base = 5, size = 32): IslandDef {
  return islandFrom(heightfieldFrom(size, 1, (x) => base + grade * x));
}

/** Layout constants of cliffIsland() (x positions of the faces, heights of the terraces). */
export const CLIFF = {
  cell: 0.25,
  /** The 0.3 m step: the face between x = STEP_X and STEP_X + cell. */
  stepX: -6,
  low: 1,
  mid: 1.3,
  /** The 2 m cliff: the face between x = CLIFF_X and CLIFF_X + cell. */
  cliffX: 0,
  high: 3.3,
} as const;

/**
 * Terraces along +x on a fine 0.25 m grid: low ground (1 m) up to x = −6, a 0.3 m step, a middle terrace
 * (1.3 m) up to x = 0, then a 2 m cliff (gradient 8, a wall) up to the high terrace (3.3 m).
 */
export function cliffIsland(nodes: NodeDef[] = []): IslandDef {
  return islandFrom(
    heightfieldFrom(32, CLIFF.cell, (x) => (x <= CLIFF.stepX ? CLIFF.low : x <= CLIFF.cliffX ? CLIFF.mid : CLIFF.high)),
    nodes,
  );
}

/** Layout constants of poolIsland(). */
export const POOL = {
  cell: 0.5,
  /** Dry beach (1 m) for x ≤ beachX, then a gentle ramp (gradient 0.5) down to the seabed at rampEndX. */
  beachX: -10,
  beach: 1,
  rampEndX: -2,
  seabed: -3,
  /** Deep water up to x = wallX, then a steep wall up to a ledge 0.3 m above the water. */
  wallX: 6,
  ledge: 0.3,
} as const;

/** A sea channel across z: gentle beach on the −x side, deep water (−3 m) in the middle, a steep shore ledge on +x. */
export function poolIsland(nodes: NodeDef[] = []): IslandDef {
  const ramp = (x: number): number =>
    POOL.beach + ((POOL.seabed - POOL.beach) * (x - POOL.beachX)) / (POOL.rampEndX - POOL.beachX);
  return islandFrom(
    heightfieldFrom(40, POOL.cell, (x) =>
      x <= POOL.beachX ? POOL.beach : x <= POOL.rampEndX ? ramp(x) : x <= POOL.wallX ? POOL.seabed : POOL.ledge,
    ),
    nodes,
  );
}

/** A resource node standing on `grid` (its y from the terrain). Trunks get the stock radius, rocks 0.8 m. */
export function node(grid: Heightfield, kind: NodeKind, x: number, z: number, opts: Partial<NodeDef> = {}): NodeDef {
  const radius = kind === "tree" ? TREE_TRUNK_RADIUS : kind === "palm" ? PALM_TRUNK_RADIUS : kind === "rock" ? 0.8 : 0;
  return {
    i: 0,
    kind,
    x,
    z,
    y: heightAt(grid, x, z),
    radius,
    height: kind === "rock" ? 1 : kind === "bush" ? 0 : 4,
    yield: "none",
    amount: 2,
    island: 0,
    yaw: 0,
    scale: 1,
    variant: 0,
    ...opts,
  };
}

/** A minimal camp site (wreck, chest…) for cover tests. Positions not given sit far away in a corner. */
export function site(opts: Partial<IslandSite> = {}): IslandSite {
  const far = { x: 100, z: 100 };
  return {
    team: 0,
    center: { x: 0, z: 0 },
    wreck: { x: far.x, z: far.z, yaw: 0 },
    spawns: [],
    campfire: far,
    chest: far,
    raft: { x: far.x, z: far.z, yaw: 0 },
    spring: far,
    cave: null,
    secretChest: far,
    shore: [],
    ...opts,
  };
}

/* ================================================================ contexts */

/** stepPlayer context on an island (cover built from it unless given). */
export function makeSimContext(
  island: IslandDef,
  character: CharacterId = "kaptan",
  opts: { locked?: boolean; cover?: CoverQuery } = {},
): SimContext {
  return {
    terrain: island.grid,
    cover: opts.cover ?? buildCover(island),
    bounds: island.bounds,
    character,
    dt: DT,
    locked: opts.locked ?? false,
  };
}

/** stepProjectile context on an island (cover built from it unless given). */
export function makeProjectileContext(island: IslandDef, cover?: CoverQuery): ProjectileContext {
  return { terrain: island.grid, cover: cover ?? buildCover(island), bounds: island.bounds, dt: DT };
}

/** Same terrain / bounds, a different character (shares the cover). */
export function withCharacter(ctx: SimContext, character: CharacterId): SimContext {
  return { ...ctx, character };
}

/** A cover index with no circles at all (for terrain-only measurements). */
export const NO_COVER: CoverQuery = { query: () => 0 };

/** The CoverIndex of a context built by makeSimContext / makeProjectileContext. */
export function coverOf(ctx: { cover: CoverQuery }): CoverIndex {
  return ctx.cover as CoverIndex;
}

/* ================================================================= players */

/** An InputCmd with everything neutral except the given fields. */
export function cmd(partial: Partial<InputCmd> = {}): InputCmd {
  return { seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, ...partial };
}

/** An alive player on the island at (x, z) looking along yaw: standing on the ground, or floating over deep water. */
export function spawnPlayer(island: IslandDef, x = 0, z = 0, yaw = 0): PlayerSim {
  const p = createPlayerSim();
  p.alive = true;
  p.x = x;
  p.z = z;
  const ground = heightAt(island.grid, x, z);
  p.y = Math.max(ground, WATER_Y - SWIM_FLOAT_DEPTH);
  p.yaw = yaw;
  p.grounded = ground >= p.y;
  p.swimming = p.y < WATER_Y - SWIM_DEPTH;
  return p;
}

/** Put `kind` in slot 0 and select it. */
export function holding(p: PlayerSim, kind: ItemKind | ""): PlayerSim {
  p.inv0 = kind;
  p.activeSlot = 0;
  return p;
}

/** Step `ticks` times with a fixed command or a per-tick command factory (tick index from 0). */
export function runPlayer(
  p: PlayerSim,
  ctx: SimContext,
  ticks: number,
  input: InputCmd | ((tick: number) => InputCmd),
): StepPlayerResult[] {
  const results: StepPlayerResult[] = [];
  for (let i = 0; i < ticks; i++) results.push(stepPlayer(p, typeof input === "function" ? input(i) : input, ctx));
  return results;
}

export function horizontalSpeed(v: { vx: number; vz: number }): number {
  return Math.hypot(v.vx, v.vz);
}

/** Capsule radius of a character (CHARACTERS lookup). */
export function radiusOf(character: CharacterId): number {
  return CHARACTERS[character].radius;
}

/* ============================================================= projectiles */

/** A projectile of `kind` with fields overridden. */
export function projectile(kind: ItemKind, fields: Partial<ProjectileSim> = {}): ProjectileSim {
  return { ...createProjectileSim(kind), ...fields };
}

/** Step a projectile `ticks` times. */
export function runProjectile(b: ProjectileSim, ctx: ProjectileContext, ticks: number): StepProjectileResult[] {
  const results: StepProjectileResult[] = [];
  for (let i = 0; i < ticks; i++) results.push(stepProjectile(b, ctx));
  return results;
}

/** Deterministic pseudo-random sequence (LCG) in [0, 1), so "random" test inputs replay exactly. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
