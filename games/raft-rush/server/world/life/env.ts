// The monster systems' view of the world for one tick: the WorldContext plus per-tick caches (light rings,
// targetable players), the brains map, spawning / despawning with their events, kill credit. Owner:
// server-world-life. Shared by the night AI (night.ts), the visitors (visitors.ts) and MonsterSystem.

import { MONSTER_THINK_TICKS, MONSTERS, MVP_POINTS } from "../../../shared/constants.js";
import { heightAt } from "../../../shared/island/heightfield.js";
import type { CoverCircle } from "../../../shared/sim/cover.js";
import type { MonsterKind, MonsterMode } from "../../../shared/types.js";
import { MonsterState } from "../../schema.js";
import type { LightRing, PlayerState, WorldContext } from "../context.js";
import { createBrain, type MonsterBrain } from "./brain.js";
import { inRings, posOf, vec } from "./util.js";

export interface SpawnOptions {
  night: number;
  team: number;
  mode: MonsterMode;
  modeTicks: number;
  yaw?: number;
  /** Feet height (default: terrain height). */
  y?: number;
}

export class LifeEnv {
  readonly brains = new Map<string, MonsterBrain>();
  /** Light rings this tick (ctx.lights() cached once per step). */
  rings: LightRing[] = [];
  /** Players monsters may target this tick: alive, not downed, not aboard, not washed. */
  targets: PlayerState[] = [];
  private seq = 0;
  private buf: CoverCircle[] = [];

  constructor(readonly ctx: WorldContext) {}

  /** Refresh the per-tick caches (call at the start of every step and before out-of-step queries). */
  refresh(): void {
    this.rings = this.ctx.lights();
    this.targets = this.ctx.alivePlayers().filter((p) => p.alive && !p.downed && !p.boarded && !p.washed && !p.spectator);
  }

  tick(): number {
    return this.ctx.tick();
  }

  /** The brain of `m` (a missing one is recreated, so a monster added by someone else can't crash the AI). */
  brain(m: MonsterState): MonsterBrain {
    let b = this.brains.get(m.id);
    if (!b) {
      b = createBrain(m.kind, 0, this.brains.size % MONSTER_THINK_TICKS);
      this.brains.set(m.id, b);
    }
    return b;
  }

  /** (x, z) is inside a light ring right now. */
  lit(x: number, z: number): boolean {
    return inRings(this.rings, x, z);
  }

  ground(x: number, z: number): number {
    return heightAt(this.ctx.island.grid, x, z);
  }

  /** Cover circles near (x, z) within `radius` (a reused buffer: copy before the next call). */
  cover(x: number, z: number, radius: number): ReadonlyArray<CoverCircle> {
    if (this.buf.length < 64) this.buf.length = 64;
    let n = this.ctx.cover.query(x, z, radius, this.buf);
    if (n > this.buf.length) {
      this.buf.length = n * 2;
      n = this.ctx.cover.query(x, z, radius, this.buf);
    }
    return this.buf.slice(0, n);
  }

  player(id: string): PlayerState | undefined {
    return this.ctx.state.players.get(id);
  }

  /** Add a monster (state + brain) and emit monsterSpawn. */
  spawn(kind: MonsterKind, x: number, z: number, o: SpawnOptions): MonsterState {
    const m = new MonsterState();
    m.id = `m${++this.seq}`;
    m.kind = kind;
    m.x = x;
    m.z = z;
    m.y = o.y ?? this.ground(x, z);
    m.yaw = o.yaw ?? 0;
    m.hp = MONSTERS[kind].hp;
    m.mode = o.mode;
    m.modeTicks = o.modeTicks;
    m.targetId = "";
    m.team = o.team;
    m.carry = "";
    this.ctx.state.monsters.set(m.id, m);
    this.brains.set(m.id, createBrain(kind, o.night, this.seq % MONSTER_THINK_TICKS));
    this.ctx.emit({ type: "monsterSpawn", tick: this.tick(), id: m.id, kind, pos: posOf(m), night: o.night });
    return m;
  }

  /** Remove a monster and emit monsterDie. */
  remove(m: MonsterState, byId: string, fled: boolean, collected = false): void {
    if (!this.ctx.state.monsters.has(m.id)) return;
    this.ctx.emit({ type: "monsterDie", tick: this.tick(), id: m.id, kind: m.kind, byId, pos: vec(m.x, m.y, m.z), fled, collected });
    this.ctx.state.monsters.delete(m.id);
    this.brains.delete(m.id);
  }

  /** A player killed / flipped a monster: stats.kills + MVP kill points. */
  creditKill(byId: string): void {
    const p = this.player(byId);
    if (!p || p.spectator) return;
    p.stats.kills++;
    this.ctx.addScore(p, MVP_POINTS.kill);
  }

  /** Monsters in insertion order (a snapshot: safe to remove while iterating). */
  list(): MonsterState[] {
    return [...this.ctx.state.monsters.values()];
  }
}
