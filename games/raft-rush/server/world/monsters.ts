// Night monsters (crabs, puffer balls, Kaptan Yengeç) and daytime thieves (monkeys, Şükrü the gull).
// Owner: server-world-life. Signatures by the architect (RaftWorld calls them); keep them.
//
// Spawning: night waves planned at night start (nightWave × difficulty × biome × full moon; flare skips one night;
// nightmare boss on night 2), released over MONSTER_SPAWN_WINDOW of the night from shore cells weighted to the far
// side of the camp, MONSTER_CAP alive. AI (think every MONSTER_THINK_TICKS, move every tick): see
// docs/ARCHITECTURE.md §2.10 (light rings, target priority, bait, gnawing, fences, boss), §2.14 (monkeys / gull).
// Movement: walk on the heightfield (crabs stay on land + shallows, never deep water except emerging / fleeing),
// steer around cover, separate from each other. Events: monsterSpawn / monsterAttack / monsterHurt /
// monsterFlip / monsterDie / steal.
//
// Files: life/waves.ts (wave sizes, schedule, shore cells), life/night.ts (crab / puffer / boss AI),
// life/visitors.ts (monkeys, gull), life/steer.ts (locomotion + the light rule), life/env.ts (per-tick caches,
// spawn / despawn), life/brain.ts (server-only memory). Credits: flips and kills add stats.kills + MVP_POINTS.kill
// here; RaftWorld credits the hit itself (stats.hits, MVP_POINTS.hit) when it detects the contact.

import { BAIT_RADIUS, BIOMES, MONSTER_CAP, MONSTER_EMERGE_TICKS, MONSTER_THINK_TICKS, MONSTERS } from "../../shared/constants.js";
import { ITEMS } from "../../shared/items.js";
import { clockAt, type ClockInfo } from "../../shared/rules/schedule.js";
import { yawFromDir } from "../../shared/sim/math.js";
import type { MonsterKind, MonsterMode, Vec3Like } from "../../shared/types.js";
import type { MonsterState, PlayerState, ProjectileEntity, WorldContext } from "./context.js";
import { ClockRewind } from "./life/clock.js";
import { LifeEnv } from "./life/env.js";
import { damageNight, flipCrab, isNightKind, scareCrab, shove, stepNight } from "./life/night.js";
import { CRAB_KNOCK_MULT, SEPARATION_RATE } from "./life/tuning.js";
import { d2 } from "./life/util.js";
import { dismissVisitor, hitVisitor, spawnGull, spawnMonkeys, stepVisitor } from "./life/visitors.js";
import { pickShoreCell, planWave, scheduleWave, type WavePlan, type WaveSpawn } from "./life/waves.js";

/** MonsterSystem.spawnMonster options (defaults: team 0, night 1, mode "hunt"). */
export interface SpawnMonsterOptions {
  team?: number;
  night?: number;
  mode?: MonsterMode;
  modeTicks?: number;
}

/** A night's spawn queue for one team's camp. */
interface WaveQueue {
  team: number;
  night: number;
  /** Tick the night began. */
  start: number;
  spawns: WaveSpawn[];
  next: number;
}

export class MonsterSystem {
  private env: LifeEnv;
  private waves: WaveQueue[] = [];
  private plans = new Map<number, WavePlan>();
  private rewind = new ClockRewind();
  private plannedNight = 0;
  private dawnDay = 0;
  private duskDay = 0;
  /** Same-tick dedupe between a puffer's direct hit and its blast (a monster takes the puffer damage once). */
  private pufferHits = new Map<string, number>();
  private blastHits = new Map<string, number>();
  /** Visible DDA: wave size multiplier (1 = dengeli, 0.8 yardım, 1.25 sert). */
  private waveMult = 1;

  /** RaftWorld: the director's level sets tonight's wave size (announced, not smoothed). */
  setWaveMult(mult: number): void {
    if (Number.isFinite(mult) && mult > 0) this.waveMult = mult;
  }

  constructor(protected ctx: WorldContext) {
    this.env = new LifeEnv(ctx);
  }

  /** Clock transitions (RaftWorld step 1): night start → plan the wave; dawn → everything flees. `prev` null at playing start. */
  onClock(prev: ClockInfo | null, clock: ClockInfo): void {
    void prev;
    this.sync(clock);
  }

  /** Spawn a daytime visitor for a day event ("monkeys" → 1–2 monkeys at the chest, "gull" → Şükrü for `victim`). Returns the monster ids. */
  spawnVisitor(kind: "monkey" | "gull", victim: PlayerState | null): string[] {
    this.env.refresh();
    const team = victim && this.ctx.state.teams[victim.team] ? victim.team : 0;
    if (!this.ctx.state.teams[team]) return [];
    return kind === "gull" ? spawnGull(this.env, victim, team) : spawnMonkeys(this.env, victim, team);
  }

  /** RaftWorld step 4: AI + movement + attacks for every monster. */
  step(): void {
    const st = this.ctx.state;
    if (st.phase === "playing") this.sync(clockAt(st.clockTicks, this.ctx.timings));
    this.env.refresh();
    this.release();
    if (st.monsters.size > 0) {
      this.separate();
      const tick = this.ctx.tick();
      for (const m of this.env.list()) {
        if (!st.monsters.has(m.id)) continue;
        const b = this.env.brain(m);
        if (b.visit) stepVisitor(this.env, m, b);
        else if (isNightKind(m.kind)) stepNight(this.env, m, b, (tick + b.phase) % MONSTER_THINK_TICKS === 0);
      }
    }
    this.pufferHits.clear();
    this.blastHits.clear();
  }

  /**
   * A live projectile hit monster `m` (RaftWorld detects the contact). Applies damage / flip / knockback, makes
   * thieves drop their loot, spears stick (returns "stick"), bait fish lure. Returns what happened to the
   * projectile: "bounce" (becomes loose), "stick" (spear stays in the monster's spot as a stuck pickup) or "consume".
   */
  hitByProjectile(m: MonsterState, proj: ProjectileEntity, damage: number, knock: Vec3Like, byId: string): "bounce" | "stick" | "consume" {
    if (!this.ctx.state.monsters.has(m.id)) return "bounce";
    const b = this.env.brain(m);
    if (b.visit) {
      hitVisitor(this.env, m, b, byId);
      return "bounce";
    }
    if (!isNightKind(m.kind)) return "bounce";
    let dmg = damage;
    if (proj.kind === "puffer") {
      if (this.blastHits.get(m.id) === this.ctx.tick()) dmg = 0;
      else this.pufferHits.set(m.id, this.ctx.tick());
    }
    damageNight(this.env, m, b, dmg, byId, knock);
    // A thrown fish that bonks a crab makes it reconsider (it will be bait once it lands).
    if (proj.kind === "fish_raw") b.forceThink = true;
    if (proj.kind === "puffer") return "consume";
    return ITEMS[proj.kind].sticks ? "stick" : "bounce";
  }

  /** Puffer blast / kraken slam at `pos`: damage + flip crabs within `radius`. Returns hit monster ids. */
  blast(pos: Vec3Like, radius: number, damage: number, byId: string): string[] {
    const out: string[] = [];
    const tick = this.ctx.tick();
    for (const m of this.env.list()) {
      if (!this.ctx.state.monsters.has(m.id)) continue;
      const def = MONSTERS[m.kind];
      const dx = m.x - pos.x;
      const dz = m.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d > radius + def.radius || Math.abs(m.y + def.height / 2 - pos.y) > radius + def.height) continue;
      out.push(m.id);
      const b = this.env.brain(m);
      if (b.visit) {
        hitVisitor(this.env, m, b, byId);
        continue;
      }
      if (!isNightKind(m.kind)) continue;
      let dmg = damage;
      if (this.pufferHits.get(m.id) === tick) dmg = 0;
      else this.blastHits.set(m.id, tick);
      const fling = (radius - Math.min(d, radius) + 1) * 2.5;
      const knock = d > 1e-3 ? { x: (dx / d) * fling, y: 0, z: (dz / d) * fling } : { x: fling, y: 0, z: 0 };
      if (m.kind === "crab") {
        if (m.mode !== "flipped") {
          if (dmg > 0) {
            m.hp = Math.max(0, m.hp - dmg);
            this.ctx.emit({ type: "monsterHurt", tick, id: m.id, kind: m.kind, hp: m.hp, damage: dmg, byId, pos: { x: m.x, y: m.y, z: m.z } });
          }
          flipCrab(this.env, m, b, byId);
        }
        shove(b, knock, CRAB_KNOCK_MULT);
      } else if (m.kind === "puffer") {
        damageNight(this.env, m, b, Math.max(1, dmg), byId, knock);
      } else {
        damageNight(this.env, m, b, dmg, byId, knock);
      }
    }
    return out;
  }

  /** Torch swing: crabs within `radius` of `pos` flee for `ticks`. */
  scare(pos: Vec3Like, radius: number, ticks: number): void {
    for (const m of this.env.list()) {
      if (m.kind !== "crab") continue;
      const r = radius + MONSTERS.crab.radius;
      if (d2(m.x, m.z, pos.x, pos.z) > r * r) continue;
      scareCrab(m, this.env.brain(m), pos, ticks);
    }
  }

  /** E on a flipped crab: remove it (monsterDie collected). True when it was collectable. */
  collect(m: MonsterState, by: PlayerState): boolean {
    if (m.kind !== "crab" || m.mode !== "flipped" || !this.ctx.state.monsters.has(m.id)) return false;
    this.env.remove(m, by.id, false, true);
    this.ctx.giveItem(by, "crab_raw", 1, "crab");
    return true;
  }

  /** A fish projectile came to rest: crabs (and the boss briefly) within BAIT_RADIUS may switch to it. */
  onBait(proj: ProjectileEntity): void {
    for (const m of this.env.list()) {
      if (m.kind !== "crab" && m.kind !== "boss") continue;
      if (d2(m.x, m.z, proj.x, proj.z) > BAIT_RADIUS * BAIT_RADIUS) continue;
      const b = this.env.brain(m);
      if (m.kind === "boss" && b.ignoreBait.has(proj.id)) continue;
      b.forceThink = true;
    }
  }

  /** Monsters alive (HUD / drums). */
  aliveCount(): number {
    return this.ctx.state.monsters.size;
  }

  /** Match start / lobby: remove everything, forget the wave. */
  clear(): void {
    this.ctx.state.monsters.clear();
    this.env.brains.clear();
    this.waves = [];
    this.plans.clear();
    this.resetMarks();
    this.rewind.reset();
    this.pufferHits.clear();
    this.blastHits.clear();
  }

  /**
   * Put a night monster straight onto the island (dev harness / tests; waves use the shore + emerge path).
   * Mode "hunt" unless given.
   */
  spawnMonster(kind: MonsterKind, x: number, z: number, opts: SpawnMonsterOptions = {}): MonsterState {
    return this.env.spawn(kind, x, z, { night: opts.night ?? 1, team: opts.team ?? 0, mode: opts.mode ?? "hunt", modeTicks: opts.modeTicks ?? 0 });
  }

  /** Tonight's plan for a team's camp (null before the first night). */
  wavePlan(team = 0): WavePlan | null {
    return this.plans.get(team) ?? null;
  }

  /** Night monsters still waiting in tonight's queue. */
  queued(): number {
    let n = 0;
    for (const w of this.waves) n += w.spawns.length - w.next;
    return n;
  }

  /* ------------------------------------------------------------ internals */

  private resetMarks(): void {
    this.plannedNight = 0;
    this.dawnDay = 0;
    this.duskDay = 0;
  }

  private sync(clock: ClockInfo): void {
    if (this.rewind.rewound(clock, this.ctx.timings)) {
      this.resetMarks();
      this.waves = [];
    }
    if (clock.over) return;
    if (clock.dayPhase === "day" && this.dawnDay < clock.day) {
      this.dawnDay = clock.day;
      this.dawn();
    }
    if (clock.dayPhase !== "day" && this.duskDay < clock.day) {
      this.duskDay = clock.day;
      this.dusk();
    }
    if (clock.dayPhase === "night" && this.plannedNight < clock.day) {
      this.plannedNight = clock.day;
      this.planNight(clock.day, clock.phaseElapsed);
    }
  }

  /** Night start: one wave per team camp (a flare skips it and is used up). */
  private planNight(night: number, elapsed: number): void {
    this.waves = [];
    const teams = Math.min(this.ctx.state.teams.length, this.ctx.island.sites.length);
    for (let t = 0; t < teams; t++) {
      const team = this.ctx.team(t);
      const plan = planWave({
        night,
        seats: team.seats,
        difficulty: this.ctx.difficulty,
        biome: BIOMES[this.ctx.island.biome],
        fullMoon: this.ctx.state.weather === "fullmoon",
        flare: team.flare,
        strength: this.waveMult,
      });
      if (team.flare) team.flare = false;
      this.plans.set(t, plan);
      if (plan.skipped) continue;
      this.waves.push({ team: t, night, start: this.ctx.tick() - elapsed, spawns: scheduleWave(plan, this.ctx.timings.night, this.ctx.rng), next: 0 });
    }
  }

  /** Release due spawns while there is room under MONSTER_CAP. */
  private release(): void {
    if (this.waves.length === 0) return;
    const now = this.ctx.tick();
    for (const w of this.waves) {
      while (w.next < w.spawns.length) {
        const s = w.spawns[w.next]!;
        if (now - w.start < s.at || this.ctx.state.monsters.size >= MONSTER_CAP) break;
        this.spawnNight(s.kind, w);
        w.next++;
      }
    }
  }

  private spawnNight(kind: MonsterKind, w: WaveQueue): void {
    const site = this.ctx.site(w.team);
    const players = this.env.targets;
    const cell = pickShoreCell(site.shore, site.campfire, this.ctx.rng, (c) => {
      if (this.env.lit(c.x, c.z)) return true;
      for (const p of players) if (d2(p.x, p.z, c.x, c.z) < 25) return true;
      return false;
    });
    if (!cell) return;
    const yaw = yawFromDir(site.campfire.x - cell.x, site.campfire.z - cell.z);
    this.env.spawn(kind, cell.x, cell.z, { night: w.night, team: w.team, mode: "emerge", modeTicks: MONSTER_EMERGE_TICKS, yaw });
  }

  /** Dawn: tonight's queue is dropped, every night monster heads back to the sea (flipped crabs once they're up). */
  private dawn(): void {
    this.waves = [];
    for (const m of this.env.list()) {
      if (!isNightKind(m.kind)) continue;
      const b = this.env.brain(m);
      if (b.visit) continue;
      b.dawn = true;
      b.fenceId = "";
      b.windup = 0;
      if (m.mode === "flipped") continue;
      m.mode = "flee";
      m.modeTicks = 0;
      m.targetId = "";
      b.goal = "none";
      b.fleeTicks = 0;
    }
  }

  /** Dusk: daytime visitors go home. */
  private dusk(): void {
    for (const m of this.env.list()) {
      const b = this.env.brain(m);
      if (b.visit) dismissVisitor(this.env, m, b);
    }
  }

  /** Soft separation: overlapping walkers push apart (flipped crabs don't budge; gulls and perched monkeys skip). */
  private separate(): void {
    // Pushes not consumed by a walk last tick (a gull, a grabbing monkey) must not pile up.
    for (const b of this.env.brains.values()) {
      b.px = 0;
      b.pz = 0;
    }
    const ms = this.env.list().filter((m) => {
      if (m.kind === "gull") return false;
      const v = this.env.brains.get(m.id)?.visit;
      return !(v && v.phase === "perch");
    });
    for (let i = 0; i < ms.length; i++) {
      const a = ms[i]!;
      const ra = MONSTERS[a.kind].radius;
      const wa = a.mode === "flipped" ? 0 : 1;
      for (let j = i + 1; j < ms.length; j++) {
        const c = ms[j]!;
        const rr = ra + MONSTERS[c.kind].radius;
        const dd = d2(a.x, a.z, c.x, c.z);
        if (dd >= rr * rr) continue;
        const wc = c.mode === "flipped" ? 0 : 1;
        if (wa + wc === 0) continue;
        const d = Math.sqrt(dd);
        const nx = d > 1e-6 ? (c.x - a.x) / d : 1;
        const nz = d > 1e-6 ? (c.z - a.z) / d : 0;
        const share = ((rr - d) * SEPARATION_RATE) / (wa + wc);
        const ba = this.env.brain(a);
        const bc = this.env.brain(c);
        ba.px -= nx * share * wa;
        ba.pz -= nz * share * wa;
        bc.px += nx * share * wc;
        bc.pz += nz * share * wc;
      }
    }
  }
}
