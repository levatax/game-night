// Test helpers for the RaftWorld suites (World.test.ts, interact.test.ts). Owner: server-world. Never imported by
// runtime code.
//
// benchIsland() is a hand-made round island (flat plateau at 1 m, a sandy shelf into the sea) with fixed sites and
// a handful of nodes at known spots, so the tests don't depend on the procedural generator. Bench wraps a
// RaftState + RaftWorld with players already in a started match, an input sender and a tick driver that keeps
// state.clockTicks and the clock it passes to step() consistent (the life systems re-derive the clock from
// state.clockTicks).

import { BAR_MAX, MAX_HP, NODE_AMOUNT, PALM_TRUNK_RADIUS, SOLO_GRID, TREE_TRUNK_RADIUS, WORLD_EDGE_MARGIN, timingsFor } from "../../shared/constants.js";
import { defHash } from "../../shared/island/generate.js";
import { createHeightfield, gridHash, heightAt } from "../../shared/island/heightfield.js";
import type { IslandDef, IslandSite, NodeDef, XZ } from "../../shared/island/types.js";
import { mulberry32 } from "../../shared/island/noise.js";
import type { InputCmd } from "../../shared/protocol.js";
import { setSlot } from "../../shared/rules/inventory.js";
import { clockAt, cycleTicks, type ClockInfo } from "../../shared/rules/schedule.js";
import { yawFromDir } from "../../shared/sim/math.js";
import type { CharacterId, Difficulty, ItemKind, Phase } from "../../shared/types.js";
import { MonsterState, PlayerState, RaftState } from "../schema.js";
import type { GameEvent, GameEventOf, GameEventType } from "./events.js";
import { RaftWorld } from "./World.js";

/** Node indices of benchIsland(). */
export const NODE = { tree: 0, palm: 1, rock: 2, ropeBush: 3, berryBush: 4, deadBush: 5, farTree: 6 } as const;

/** Plateau height of benchIsland(). */
export const PLATEAU_Y = 1;

function islandHeight(x: number, z: number): number {
  const r = Math.sqrt(x * x + z * z);
  if (r <= 28) return PLATEAU_Y;
  if (r <= 34) return PLATEAU_Y - ((r - 28) / 6) * 2; // sandy shelf: 1 m → −1 m
  if (r <= 40) return -1 - ((r - 34) / 6) * 3; // drop-off: −1 m → −4 m
  return -4;
}

function node(i: number, kind: NodeDef["kind"], x: number, z: number, extra: Partial<NodeDef> = {}): NodeDef {
  const radius = kind === "tree" ? TREE_TRUNK_RADIUS : kind === "palm" ? PALM_TRUNK_RADIUS : kind === "rock" ? 0.7 : 0;
  const height = kind === "rock" ? 1 : kind === "bush" ? 0 : 4;
  return {
    i,
    kind,
    x,
    z,
    y: PLATEAU_Y,
    radius,
    height,
    yield: "none",
    amount: kind === "bush" ? NODE_AMOUNT.bush : NODE_AMOUNT[kind],
    island: 0,
    yaw: 0,
    scale: 1,
    variant: 0,
    ...extra,
  };
}

/** The bench island (deterministic, no generator). */
export function benchIsland(): IslandDef {
  const cols = SOLO_GRID.cols;
  const rows = SOLO_GRID.rows;
  const origin = -(cols - 1) / 2;
  const grid = createHeightfield(cols, rows, 1, origin, origin);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) grid.heights[r * cols + c] = Math.fround(islandHeight(origin + c, origin + r));
  const shore: XZ[] = [];
  // 24 shore cells on the r = 32 ring (a rational-ish walk; trig is fine in a test fixture).
  for (let k = 0; k < 24; k++) shore.push({ x: Math.cos((k / 24) * Math.PI * 2) * 32, z: Math.sin((k / 24) * Math.PI * 2) * 32 });
  const site: IslandSite = {
    team: 0,
    center: { x: 0, z: 0 },
    wreck: { x: 8, z: 22, yaw: 0 },
    spawns: [
      { x: 2, z: 20 },
      { x: 4, z: 20 },
      { x: 2, z: 18 },
      { x: 4, z: 18 },
      { x: 2, z: 16 },
      { x: 4, z: 16 },
    ],
    campfire: { x: 0, z: 10 },
    chest: { x: 2.2, z: 10 },
    raft: { x: -6, z: 27, yaw: Math.PI },
    spring: { x: -14, z: 0 },
    cave: { x: 16, z: -6, radius: 3.5 },
    secretChest: { x: 18, z: -16 },
    shore,
  };
  const nodes: NodeDef[] = [
    node(NODE.tree, "tree", 10, 0),
    node(NODE.palm, "palm", -8, 4),
    node(NODE.rock, "rock", 10, 6),
    node(NODE.ropeBush, "bush", 0, -8, { yield: "rope" }),
    node(NODE.berryBush, "bush", -4, -8, { yield: "berry" }),
    node(NODE.deadBush, "bush", 4, -12, { yield: "none", amount: 0 }),
    node(NODE.farTree, "tree", -16, -16),
  ];
  const max = origin + (cols - 1);
  const def: IslandDef = {
    seed: 4471,
    layout: "solo",
    biome: "tropic",
    grid,
    sites: [site],
    nodes,
    fishSpots: [{ i: 0, x: 0, z: 34, island: 0 }],
    bounds: { minX: origin + WORLD_EDGE_MARGIN, maxX: max - WORLD_EDGE_MARGIN, minZ: origin + WORLD_EDGE_MARGIN, maxZ: max - WORLD_EDGE_MARGIN },
    gridHash: gridHash(grid),
    defHash: 0,
  };
  def.defHash = defHash(def);
  return def;
}

export interface BenchOptions {
  difficulty?: Difficulty;
  fast?: boolean;
  seed?: number;
  /** Seats the raft is sized for (default max(2, players)). */
  seats?: number;
  /** Room phase while stepping (default "playing"). */
  phase?: Phase;
}

/** A started match on benchIsland() with players (seat = index), driven tick by tick. */
export class Bench {
  readonly state = new RaftState();
  readonly world: RaftWorld;
  readonly island = benchIsland();
  readonly events: GameEvent[] = [];
  /** Clock mode: a fixed clockTicks (default: early day 1) or null (landing / cinematic: no clock). */
  clockTicks: number | null = 10;
  /** Locked input (landing wake-up / cinematics). */
  locked = false;
  private readonly seqs = new Map<string, number>();

  constructor(players: Array<[string, CharacterId?]>, opts: BenchOptions = {}) {
    players.forEach(([id, character], seat) => {
      const p = new PlayerState();
      p.id = id;
      p.nickname = id;
      p.character = character ?? "fenomen";
      p.seat = seat;
      p.team = 0;
      this.state.players.set(id, p);
    });
    this.state.phase = opts.phase ?? "playing";
    this.state.fast = opts.fast ?? false;
    this.world = new RaftWorld(this.state, this.island, { fast: opts.fast ?? false, difficulty: opts.difficulty ?? "normal", rng: mulberry32(opts.seed ?? 7) });
    this.world.startMatch(
      players.map(([id]) => id),
      opts.seats ?? Math.max(2, players.length),
    );
    this.world.drainEvents();
    // Empty pockets: each test hands out exactly what it needs.
    this.state.players.forEach((p) => {
      for (let s = 0; s < 4; s++) setSlot(p, s, "", 0);
      this.world.bag.sync(p);
    });
  }

  get timings() {
    return timingsFor(this.state.fast);
  }

  p(id: string): PlayerState {
    const p = this.state.players.get(id);
    if (!p) throw new Error(`no player ${id}`);
    return p;
  }

  /** Stand `id` at (x, z) on the ground, still, looking along `yaw`. */
  place(id: string, x: number, z: number, yaw = 0): PlayerState {
    const p = this.p(id);
    Object.assign(p, { x, y: heightAt(this.island.grid, x, z), z, yaw, pitch: 0, vx: 0, vy: 0, vz: 0, grounded: true });
    return p;
  }

  /** Stand `dist` m from (tx, tz) on the side of (fromX, fromZ) direction, facing the target. */
  placeFacing(id: string, tx: number, tz: number, dx: number, dz: number): PlayerState {
    const x = tx + dx;
    const z = tz + dz;
    return this.place(id, x, z, yawFromDir(tx - x, tz - z));
  }

  /** Put `count` of `kind` in slot `slot` (timers synced). */
  give(id: string, kind: ItemKind | "", count: number, slot = 0): PlayerState {
    const p = this.p(id);
    setSlot(p, slot, kind, count);
    this.world.bag.sync(p);
    return p;
  }

  /** Queue one input for `id` (look defaults to the player's current look). */
  send(id: string, partial: Partial<InputCmd> = {}): number {
    const seq = (this.seqs.get(id) ?? 0) + 1;
    this.seqs.set(id, seq);
    const p = this.p(id);
    this.world.queueInput(id, { seq, moveX: 0, moveZ: 0, yaw: p.yaw, pitch: p.pitch, buttons: 0, ...partial });
    return seq;
  }

  /** The clock step() gets this tick. */
  clock(): ClockInfo | null {
    if (this.clockTicks === null) return null;
    return clockAt(this.clockTicks, this.timings);
  }

  /** Set the clock to `day` / phase + `elapsed` ticks into it. */
  setClock(day: number, phase: "day" | "dusk" | "night", elapsed = 5): void {
    const t = this.timings;
    const offset = phase === "day" ? 0 : phase === "dusk" ? t.day : t.day + t.dusk;
    this.clockTicks = (Math.min(t.days, Math.max(1, day)) - 1) * cycleTicks(t) + offset + elapsed;
  }

  tick(): GameEvent[] {
    this.state.tick++;
    const clock = this.clock();
    if (clock) {
      this.state.clockTicks = this.clockTicks ?? 0;
      this.state.day = clock.day;
      this.state.dayPhase = clock.dayPhase;
    }
    const evs = this.world.step({ locked: this.locked, clock });
    this.events.push(...evs);
    return evs;
  }

  /** Run `n` ticks (each callback may queue inputs first). Returns the events of those ticks. */
  run(n: number, each?: (i: number) => void): GameEvent[] {
    const out: GameEvent[] = [];
    for (let i = 0; i < n; i++) {
      each?.(i);
      out.push(...this.tick());
    }
    return out;
  }

  /** Press-and-hold `buttons` for `ticks` ticks (the first input also carries `press`). */
  hold(id: string, buttons: number, ticks: number, press = 0, look: Partial<InputCmd> = {}): GameEvent[] {
    return this.run(ticks, (i) => this.send(id, { ...look, buttons: buttons | (i === 0 ? press : 0) }));
  }

  /** Put a monster into the state directly (tests only). */
  monster(id: string, kind: MonsterState["kind"], x: number, z: number, fields: Partial<MonsterState> = {}): MonsterState {
    const m = new MonsterState();
    Object.assign(m, { id, kind, x, y: heightAt(this.island.grid, x, z), z, hp: kind === "boss" ? 12 : kind === "crab" ? 2 : 1, mode: "hunt" }, fields);
    this.state.monsters.set(id, m);
    return m;
  }

  of<T extends GameEventType>(type: T, evs: GameEvent[] = this.events): Array<GameEventOf<T>> {
    return evs.filter((e): e is GameEventOf<T> => e.type === type);
  }

  /** Full bars on everyone (keeps long tests from starving). */
  topUp(id: string): void {
    const p = this.p(id);
    p.hp = MAX_HP;
    p.hunger = BAR_MAX;
    p.thirst = BAR_MAX;
    p.warmth = BAR_MAX;
  }
}
