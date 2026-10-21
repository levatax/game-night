// Test bench for the life systems: a hand-made island and a FAKE WorldContext (the real RaftWorld is written by
// server-world; these tests must not depend on it). Owner: server-world-life. Used only by
// server/world/{monsters,fishing,weather,loot}.test.ts.
//
// Island: 96 m grid, flat plateau (1 m) to r = 22, beach slope to the waterline at r = 26, shallows to r = 30
// (−1 m), deep water beyond. Campfire at the origin, chest 2.2 m toward the wreck (+z), raft on the +z beach at
// the waterline, 32 shore cells on the r = 28 ring (0.5 m deep), 4 fish spots at r = 31, a ring of 12 trees at
// r = 15, 8 palms at r = 21, 4 rocks at r = 9.

import {
  BAR_MAX,
  CELL_SIZE,
  DIFFICULTIES,
  FIRE_FUEL_MAX_TICKS,
  FIRE_LIGHT_RADIUS,
  FIRE_START_FUEL_TICKS,
  NODE_AMOUNT,
  PALM_TRUNK_RADIUS,
  SOLO_GRID,
  TORCH_LIGHT_RADIUS,
  TREE_TRUNK_RADIUS,
  WORLD_EDGE_MARGIN,
  timingsFor,
  type DifficultyDef,
  type Timings,
} from "../../../shared/constants.js";
import { createHeightfield, gridHash, heightAt } from "../../../shared/island/heightfield.js";
import { mulberry32 } from "../../../shared/island/noise.js";
import type { FishSpotDef, IslandDef, IslandSite, NodeDef, XZ } from "../../../shared/island/types.js";
import { ITEMS } from "../../../shared/items.js";
import type { PickupEvent } from "../../../shared/protocol.js";
import { addItem } from "../../../shared/rules/inventory.js";
import { clockAt, type ClockInfo } from "../../../shared/rules/schedule.js";
import { buildCover, type CoverIndex } from "../../../shared/sim/cover.js";
import { heldKind } from "../../../shared/sim/player.js";
import type { Biome, CharacterId, Difficulty, HurtCause, ItemKind, NodeKind, TreasureId, Vec3Like } from "../../../shared/types.js";
import { PlayerState, ProjectileEntity, RaftState, TeamState, type MonsterState } from "../../schema.js";
import type { LightRing, SpawnProjectileOptions, WorldContext } from "../context.js";
import type { GameEvent, GameEventOf, GameEventType } from "../events.js";

/** Plateau radius, waterline radius, shore ring radius. */
export const PLATEAU_R = 22;
export const WATERLINE_R = 26;
export const SHORE_R = 28;

function terrain(d: number): number {
  if (d <= PLATEAU_R) return 1;
  if (d <= 30) return 1 - (d - PLATEAU_R) * 0.25;
  if (d <= 40) return -1 - (d - 30) * 0.3;
  return -4;
}

function ring(n: number, r: number, offset = 0): XZ[] {
  const out: XZ[] = [];
  for (let k = 0; k < n; k++) {
    const a = offset + (k / n) * Math.PI * 2;
    out.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }
  return out;
}

/** The bench island (biome only changes the IslandDef.biome tag; terrain is identical). */
export function testIsland(biome: Biome = "tropic"): IslandDef {
  const cols = SOLO_GRID.cols;
  const rows = SOLO_GRID.rows;
  const originX = -((cols - 1) * CELL_SIZE) / 2;
  const originZ = -((rows - 1) * CELL_SIZE) / 2;
  const grid = createHeightfield(cols, rows, CELL_SIZE, originX, originZ);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = originX + c * CELL_SIZE;
      const z = originZ + r * CELL_SIZE;
      grid.heights[r * cols + c] = Math.fround(terrain(Math.hypot(x, z)));
    }
  }
  const nodes: NodeDef[] = [];
  const addNodes = (kind: NodeKind, pts: XZ[], radius: number, height: number) => {
    for (const p of pts) {
      const y = heightAt(grid, p.x, p.z);
      nodes.push({ i: nodes.length, kind, x: p.x, z: p.z, y, radius, height, yield: "none", amount: NODE_AMOUNT[kind], island: 0, yaw: 0, scale: 1, variant: 0 });
    }
  };
  addNodes("tree", ring(12, 15, 0.13), TREE_TRUNK_RADIUS, 4);
  addNodes("palm", ring(8, 21, 0.39), PALM_TRUNK_RADIUS, 4);
  addNodes("rock", ring(4, 9, 0.78), 0.6, 1);
  const wreck = { x: 0, z: 12, yaw: Math.PI };
  const site: IslandSite = {
    team: 0,
    center: { x: 0, z: 0 },
    wreck,
    spawns: [
      { x: -2, z: 9 },
      { x: 0, z: 9 },
      { x: 2, z: 9 },
      { x: -2, z: 7 },
      { x: 0, z: 7 },
      { x: 2, z: 7 },
    ],
    campfire: { x: 0, z: 0 },
    chest: { x: 0, z: 2.2 },
    raft: { x: 0, z: 25.5, yaw: 0 },
    spring: { x: -10, z: -10 },
    cave: null,
    secretChest: { x: 12, z: -12 },
    shore: ring(32, SHORE_R),
  };
  const fishSpots: FishSpotDef[] = ring(4, 31, Math.PI / 4).map((p, i) => ({ i, x: p.x, z: p.z, island: 0 }));
  const maxX = originX + (cols - 1) * CELL_SIZE;
  const maxZ = originZ + (rows - 1) * CELL_SIZE;
  return {
    seed: 1234,
    layout: "solo",
    biome,
    grid,
    sites: [site],
    nodes,
    fishSpots,
    bounds: { minX: originX + WORLD_EDGE_MARGIN, maxX: maxX - WORLD_EDGE_MARGIN, minZ: originZ + WORLD_EDGE_MARGIN, maxZ: maxZ - WORLD_EDGE_MARGIN },
    gridHash: gridHash(grid),
    defHash: 0,
  };
}

export interface BenchOptions {
  seed?: number;
  difficulty?: Difficulty;
  biome?: Biome;
  fast?: boolean;
  seats?: number;
  /** Replace the rng (rigged tests). */
  rng?: () => number;
  /** Use this island instead of the bench island (e.g. a generated one). */
  island?: IslandDef;
}

/** A fake WorldContext over a real RaftState and the bench island. */
export class FakeWorld implements WorldContext {
  readonly state = new RaftState();
  readonly island: IslandDef;
  readonly cover: CoverIndex;
  readonly timings: Readonly<Timings>;
  difficulty: Readonly<DifficultyDef>;
  readonly events: GameEvent[] = [];
  /** Extra static light rings (on top of the campfire, planted and held torches). */
  extraLights: LightRing[] = [];
  readonly treasures: { playerId: string; treasure: TreasureId }[] = [];
  readonly bottles: string[] = [];
  private rand: () => number;
  private pseq = 0;

  constructor(o: BenchOptions = {}) {
    this.island = o.island ?? testIsland(o.biome ?? "tropic");
    this.cover = buildCover(this.island);
    this.timings = timingsFor(o.fast ?? false);
    this.difficulty = DIFFICULTIES[o.difficulty ?? "normal"];
    this.rand = o.rng ?? mulberry32(o.seed ?? 7);
    this.state.biome = this.island.biome;
    this.state.seed = this.island.seed;
    const t = new TeamState();
    t.index = 0;
    t.seats = o.seats ?? 3;
    t.hullWood = 10;
    t.fireFuel = FIRE_START_FUEL_TICKS;
    this.state.teams.push(t);
  }

  rng = (): number => this.rand();

  setRng(r: () => number): void {
    this.rand = r;
  }

  tick(): number {
    return this.state.tick;
  }

  emit(ev: GameEvent): void {
    this.events.push(ev);
  }

  alivePlayers(team?: number): PlayerState[] {
    const out: PlayerState[] = [];
    this.state.players.forEach((p) => {
      if (p.alive && !p.washed && !p.spectator && (team === undefined || p.team === team)) out.push(p);
    });
    return out;
  }

  damagePlayer(p: PlayerState, amount: number, cause: HurtCause, byId: string): void {
    if (!p.alive || p.downed || p.boarded || p.washed) return;
    p.hp = Math.max(0, p.hp - Math.round(amount));
    this.emit({ type: "playerHurt", tick: this.tick(), playerId: p.id, amount, hp: p.hp, cause, byId, pos: { x: p.x, y: p.y, z: p.z } });
    if (p.hp === 0) {
      p.downed = true;
      this.emit({ type: "playerDowned", tick: this.tick(), playerId: p.id, cause, pos: { x: p.x, y: p.y, z: p.z } });
    }
  }

  knockPlayer(p: PlayerState, knock: Vec3Like, stunTicks = 9): void {
    p.vx = knock.x;
    p.vy = knock.y;
    p.vz = knock.z;
    p.stunTicks = stunTicks;
  }

  giveItem(p: PlayerState, kind: ItemKind, count: number, source: PickupEvent["source"]): number {
    const added = addItem(p, kind, count);
    for (let k = added; k < count; k++) this.spawnProjectile(kind, { x: p.x, y: p.y + 0.3, z: p.z }, { x: 0, y: 0, z: 0 }, { state: "rest" });
    this.emit({ type: "pickup", tick: this.tick(), playerId: p.id, kind, count, pos: { x: p.x, y: p.y, z: p.z }, projectileId: "", source });
    return added;
  }

  addScore(p: PlayerState, points: number): void {
    p.score += points;
  }

  spawnProjectile(kind: ItemKind, pos: Vec3Like, vel: Vec3Like, opts: SpawnProjectileOptions = {}): ProjectileEntity | null {
    const b = new ProjectileEntity();
    b.id = `p${++this.pseq}`;
    b.kind = kind;
    b.radius = ITEMS[kind].radius;
    b.x = pos.x;
    b.y = pos.y;
    b.z = pos.z;
    b.vx = vel.x;
    b.vy = vel.y;
    b.vz = vel.z;
    b.state = opts.state ?? "loose";
    b.ownerId = opts.ownerId ?? "";
    b.team = opts.team ?? -1;
    b.throwSeq = opts.throwSeq ?? 0;
    b.charge = opts.charge ?? 0;
    this.state.projectiles.set(b.id, b);
    return b;
  }

  removeProjectile(id: string): void {
    this.state.projectiles.delete(id);
  }

  site(team: number): IslandSite {
    return this.island.sites[team] ?? this.island.sites[0]!;
  }

  team(team: number): TeamState {
    return this.state.teams[team] ?? this.state.teams[0]!;
  }

  lights(): LightRing[] {
    const out: LightRing[] = [];
    this.state.teams.forEach((t, i) => {
      if (t.fireFuel > 0) {
        const s = this.site(i);
        out.push({ x: s.campfire.x, z: s.campfire.z, r: FIRE_LIGHT_RADIUS, kind: "fire", team: i });
      }
    });
    this.state.structures.forEach((s) => {
      if (s.kind === "torch" && s.life > 0) out.push({ x: s.x, z: s.z, r: TORCH_LIGHT_RADIUS, kind: "planted", team: s.team });
    });
    this.state.players.forEach((p) => {
      if (p.alive && heldKind(p) === "torch" && p.torchTicks > 0) out.push({ x: p.x, z: p.z, r: TORCH_LIGHT_RADIUS, kind: "torch", team: p.team });
    });
    return out.concat(this.extraLights);
  }

  inLight(x: number, z: number): boolean {
    for (const r of this.lights()) if ((x - r.x) ** 2 + (z - r.z) ** 2 < r.r * r.r) return true;
    return false;
  }

  damageRaft(team: number, amount: number, byMonsterId: string, pos: Vec3Like): void {
    const t = this.team(team);
    const lost = Math.min(t.hullWood, amount);
    t.hullWood -= lost;
    this.emit({ type: "raftDamage", tick: this.tick(), team, amount: lost, byMonsterId, pos, hullWood: t.hullWood });
  }

  stealFromChest(team: number, kind?: ItemKind): ItemKind | null {
    const chest = this.team(team).chest;
    let k: ItemKind | null = null;
    if (kind) k = (chest.get(kind) ?? 0) > 0 ? kind : null;
    else
      chest.forEach((n, key) => {
        if (!k && n > 0) k = key as ItemKind;
      });
    if (!k) return null;
    const left = (chest.get(k) ?? 0) - 1;
    if (left > 0) chest.set(k, left);
    else chest.delete(k);
    this.emit({ type: "chestChanged", tick: this.tick(), team, playerId: "", op: "steal", items: [{ kind: k, count: 1 }] });
    return k;
  }

  returnToChest(team: number, kind: ItemKind, count: number): void {
    const chest = this.team(team).chest;
    chest.set(kind, (chest.get(kind) ?? 0) + count);
    this.emit({ type: "chestChanged", tick: this.tick(), team, playerId: "", op: "return", items: [{ kind, count }] });
  }

  addFireFuel(team: number, ticks: number, byId: string, source: "wood" | "throw" | "jellyfish" | "fuelCan"): void {
    const t = this.team(team);
    t.fireFuel = Math.min(FIRE_FUEL_MAX_TICKS, t.fireFuel + ticks);
    this.emit({ type: "fireFuel", tick: this.tick(), team, playerId: byId, added: ticks, fuel: t.fireFuel, source });
  }

  applyTreasure(p: PlayerState, treasure: TreasureId): void {
    this.treasures.push({ playerId: p.id, treasure });
    if (treasure === "flare") this.team(p.team).flare = true;
  }

  applyBottle(p: PlayerState): void {
    this.bottles.push(p.id);
    this.emit({ type: "bottle", tick: this.tick(), playerId: p.id, team: p.team, effect: "spring" });
  }

  /* ------------------------------------------------------------- helpers */

  addPlayer(id: string, x: number, z: number, character: CharacterId = "kaptan"): PlayerState {
    const p = new PlayerState();
    p.id = id;
    p.nickname = id;
    p.character = character;
    p.seat = this.state.players.size;
    p.alive = true;
    p.x = x;
    p.z = z;
    p.y = heightAt(this.island.grid, x, z);
    p.hp = BAR_MAX;
    this.state.players.set(id, p);
    return p;
  }

  /** Move a player (feet on the terrain). */
  place(p: PlayerState, x: number, z: number): void {
    p.x = x;
    p.z = z;
    p.y = heightAt(this.island.grid, x, z);
  }

  ofType<T extends GameEventType>(type: T): GameEventOf<T>[] {
    return this.events.filter((e): e is GameEventOf<T> => e.type === type);
  }

  clearEvents(): void {
    this.events.length = 0;
  }

  /** Set the match clock (phase playing) and return it. */
  setClock(clockTicks: number): ClockInfo {
    this.state.phase = "playing";
    this.state.clockTicks = clockTicks;
    const c = clockAt(clockTicks, this.timings);
    this.state.day = c.day;
    this.state.dayPhase = c.dayPhase;
    return c;
  }

  /** Clock ticks at the start of `day`'s `phase` (+ offset ticks). */
  clockFor(day: number, phase: "day" | "dusk" | "night", offset = 0): number {
    const t = this.timings;
    const cyc = t.day + t.dusk + t.night;
    const at = phase === "day" ? 0 : phase === "dusk" ? t.day : t.day + t.dusk;
    return (day - 1) * cyc + at + offset;
  }

  /** Advance the server tick by one and run `fn` (the systems' step calls). */
  run(ticks: number, fn: () => void): void {
    for (let k = 0; k < ticks; k++) {
      this.state.tick++;
      if (this.state.phase === "playing") this.setClock(this.state.clockTicks + 1);
      fn();
    }
  }

  monsters(): MonsterState[] {
    return [...this.state.monsters.values()];
  }
}
