// Test-only helpers for the client-net vitest suites (*.test.ts in this folder). Owner: client-net.
// Never imported by runtime code (Vite only bundles what main.ts reaches). Builds tiny hand-made islands so the
// net tests don't depend on the procedural generator: a flat plateau with an optional sea on the +X side and
// optional cover posts, run through the real CoverIndex / stepPlayer / stepProjectile.

import { DT } from "../../../shared/constants";
import { createHeightfield, gridHash } from "../../../shared/island/heightfield";
import type { IslandDef, IslandSite, NodeDef } from "../../../shared/island/types";
import type { InputCmd } from "../../../shared/protocol";
import type { ProjectileContext, SimContext } from "../../../shared/sim/context";
import { buildCover, type CoverIndex } from "../../../shared/sim/cover";
import { createPlayerSim, type PlayerSim } from "../../../shared/sim/player";
import { createProjectileSim, type ProjectileSim } from "../../../shared/sim/projectile";
import type { CharacterId, ItemKind, MonsterView, PlayerView, ProjectileView, StructureView } from "../../../shared/types";

export interface TestIslandOptions {
  /** Plateau height (m). */
  height?: number;
  /** Half the grid size in meters (grid spans −half..half on both axes). */
  half?: number;
  /** Everything with x ≥ this is sea at SEA depth (default: no sea). */
  seaFromX?: number;
  seaDepth?: number;
  /** Rock posts (static cover) at these positions. */
  rocks?: { x: number; z: number; r?: number }[];
  seed?: number;
}

/** A hand-made IslandDef: flat land at `height`, an optional sea strip, optional rock posts. */
export function testIsland(opts: TestIslandOptions = {}): IslandDef {
  const height = opts.height ?? 1;
  const half = opts.half ?? 24;
  const n = half * 2 + 1;
  const grid = createHeightfield(n, n, 1, -half, -half);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = -half + c;
      const sea = opts.seaFromX !== undefined && x >= opts.seaFromX;
      grid.heights[r * n + c] = Math.fround(sea ? -(opts.seaDepth ?? 3) : height);
    }
  }
  const far = { x: -half + 2, z: -half + 2 };
  const site: IslandSite = {
    team: 0,
    center: { x: 0, z: 0 },
    wreck: { ...far, yaw: 0 },
    spawns: [{ x: 0, z: 0 }],
    campfire: { x: far.x + 1, z: far.z + 4 },
    chest: { x: far.x + 4, z: far.z + 4 },
    raft: { x: far.x, z: far.z + 8, yaw: 0 },
    spring: { x: far.x + 6, z: far.z },
    cave: null,
    secretChest: { x: far.x + 8, z: far.z },
    shore: [],
  };
  const nodes: NodeDef[] = (opts.rocks ?? []).map((rock, i) => ({
    i,
    kind: "rock",
    x: rock.x,
    z: rock.z,
    y: height,
    radius: rock.r ?? 0.8,
    height: 1.5,
    yield: "none",
    amount: 2,
    island: 0,
    yaw: 0,
    scale: 1,
    variant: 0,
  }));
  return {
    seed: opts.seed ?? 1,
    layout: "solo",
    biome: "tropic",
    grid,
    sites: [site],
    nodes,
    fishSpots: [],
    bounds: { minX: -half + 1, maxX: half - 1, minZ: -half + 1, maxZ: half - 1 },
    gridHash: gridHash(grid),
    defHash: 1234,
  };
}

/** SimContext over a test island (a fresh CoverIndex unless one is given). */
export function simCtx(island: IslandDef, character: CharacterId = "kaptan", locked = false, cover: CoverIndex = buildCover(island)): SimContext {
  return { terrain: island.grid, cover, bounds: island.bounds, character, dt: DT, locked };
}

/** ProjectileContext / WorldQuery over a test island. */
export function projectileCtx(island: IslandDef, cover: CoverIndex = buildCover(island)): ProjectileContext {
  return { terrain: island.grid, cover, bounds: island.bounds, dt: DT };
}

/** An InputCmd with everything neutral except the given fields. */
export function cmd(partial: Partial<InputCmd> = {}): InputCmd {
  return { seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, ...partial };
}

/** An alive, grounded player standing on the plateau at (x, z). */
export function spawnPlayer(x = 0, z = 0, yaw = 0, y = 1): PlayerSim {
  const p = createPlayerSim();
  p.alive = true;
  p.x = x;
  p.y = y;
  p.z = z;
  p.yaw = yaw;
  p.grounded = true;
  return p;
}

/** A PlayerView around sim fields (what the decoded state hands Prediction / Interpolation). */
export function playerView(sim: PlayerSim, lastSeq = 0, fields: Partial<PlayerView> = {}): PlayerView {
  return {
    ...sim,
    id: "me",
    nickname: "Me",
    character: "kaptan",
    seat: 0,
    team: 0,
    bot: false,
    botRole: "",
    ready: false,
    connected: true,
    spectator: false,
    ping: 0,
    lastSeq,
    cnt0: 0,
    cnt1: 0,
    cnt2: 0,
    cnt3: 0,
    downedTicks: 0,
    washed: false,
    fishState: 0,
    fishSpot: -1,
    fuseTicks: 0,
    torchTicks: 0,
    cosmetic: "",
    golden: false,
    score: 0,
    stats: { gathered: 0, delivered: 0, hits: 0, kills: 0, revives: 0, fish: 0, eaten: 0, coconuts: 0, downs: 0, crafted: 0, raids: 0 },
    ...fields,
  };
}

/** A ProjectileView (server entity shape) with the given fields. */
export function projectileView(fields: Partial<ProjectileView> & { id: string; kind?: ItemKind }): ProjectileView {
  const sim: ProjectileSim = createProjectileSim(fields.kind ?? "coconut");
  return { ...sim, ownerId: "", throwSeq: 0, team: 0, charge: 0, baitTicks: 0, ...fields };
}

/** A MonsterView with the given fields. */
export function monsterView(fields: Partial<MonsterView> & { id: string }): MonsterView {
  return { kind: "crab", x: 0, y: 0, z: 0, yaw: 0, hp: 2, mode: "hunt", modeTicks: 0, targetId: "", team: 0, carry: "", ...fields };
}

/** A StructureView with the given fields. */
export function structureView(fields: Partial<StructureView> & { id: string }): StructureView {
  return { kind: "fence", x: 0, y: 1, z: 0, yaw: 0, team: 0, ownerId: "", hp: 4, life: 0, uses: 0, ...fields };
}

/** A Map standing in for a decoded MapSchema (MapView). */
export function mapOf<V extends { id: string }>(...items: V[]): Map<string, V> {
  return new Map(items.map((v) => [v.id, v]));
}

/** Deterministic pseudo-random sequence (LCG), so "random" test inputs replay exactly. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
