// MonsterSystem against the fake WorldContext (server/world/life/testkit.ts). Owner: server-world-life.

import { describe, expect, it } from "vitest";
import {
  BAIT_TICKS,
  BIOMES,
  BOSS_BAIT_TICKS,
  CRAB_FLIP_TICKS,
  DIFFICULTIES,
  FENCE_GNAW_TICKS,
  FENCE_HP,
  FIRE_LIGHT_RADIUS,
  GULL_CARRY_TICKS,
  GULL_CIRCLES,
  MONSTER_CAP,
  MONSTER_SPAWN_WINDOW,
  MONSTERS,
  MVP_POINTS,
  RAFT_GNAW_TICKS,
  TORCH_LIGHT_RADIUS,
  TORCH_SWING_SCARE_TICKS,
  nightWave,
} from "../../shared/constants.js";
import { mulberry32 } from "../../shared/island/noise.js";
import { heightAt } from "../../shared/island/heightfield.js";
import type { Difficulty, MonsterKind } from "../../shared/types.js";
import { ProjectileEntity, StructureState, type MonsterState } from "../schema.js";
import { FakeWorld, SHORE_R, type BenchOptions } from "./life/testkit.js";
import { FLEE_TIMEOUT_TICKS, MONKEY_TREE_TICKS } from "./life/tuning.js";
import { pickShoreCell, planWave, scheduleWave } from "./life/waves.js";
import { MonsterSystem } from "./monsters.js";

function bench(o: BenchOptions = {}): { w: FakeWorld; mon: MonsterSystem } {
  const w = new FakeWorld(o);
  return { w, mon: new MonsterSystem(w) };
}

/** Step the monsters `n` ticks (tick++ then step). `each` runs after every step. */
function run(w: FakeWorld, mon: MonsterSystem, n: number, each?: () => void): void {
  w.run(n, () => {
    mon.step();
    each?.();
  });
}

function projectile(w: FakeWorld, kind: ProjectileEntity["kind"], x: number, z: number, ownerId = "ana"): ProjectileEntity {
  const b = w.spawnProjectile(kind, { x, y: heightAt(w.island.grid, x, z) + 0.3, z }, { x: 0, y: 0, z: 0 }, { state: "live", ownerId });
  if (!b) throw new Error("no projectile");
  return b;
}

function fence(w: FakeWorld, id: string, x: number, z: number, yaw = 0): StructureState {
  const s = new StructureState();
  s.id = id;
  s.kind = "fence";
  s.x = x;
  s.z = z;
  s.y = heightAt(w.island.grid, x, z);
  s.yaw = yaw;
  s.hp = FENCE_HP;
  w.state.structures.set(id, s);
  w.cover.setStructures(w.state.structures.values());
  return s;
}

function torch(w: FakeWorld, id: string, x: number, z: number): StructureState {
  const s = new StructureState();
  s.id = id;
  s.kind = "torch";
  s.x = x;
  s.z = z;
  s.y = heightAt(w.island.grid, x, z);
  s.life = 60000;
  w.state.structures.set(id, s);
  return s;
}

const mon0 = (w: FakeWorld): MonsterState => w.monsters()[0]!;

/* ================================================================ waves */

describe("wave sizes", () => {
  const plan = (night: number, seats: number, difficulty: Difficulty = "normal", biome: keyof typeof BIOMES = "tropic", fullMoon = false, flare = false) =>
    planWave({ night, seats, difficulty: DIFFICULTIES[difficulty], biome: BIOMES[biome], fullMoon, flare });

  it("follows nightWave(night, seats) on normal in the tropics", () => {
    for (let seats = 2; seats <= 6; seats++) {
      for (let night = 1; night <= 3; night++) {
        const base = nightWave(night, seats);
        expect(plan(night, seats)).toEqual({ crabs: base.crabs, puffers: base.puffers, boss: base.boss, skipped: false });
      }
    }
    expect(plan(1, 3)).toMatchObject({ crabs: 6, puffers: 0, boss: 0 });
    expect(plan(2, 4)).toMatchObject({ crabs: 12, puffers: 2, boss: 0 });
    expect(plan(3, 6)).toMatchObject({ crabs: 20, puffers: 3, boss: 1 });
  });

  it("scales with difficulty (vacation ×0.6, nightmare ×1.5 and a night-2 boss)", () => {
    expect(plan(1, 3, "vacation")).toMatchObject({ crabs: 4, puffers: 0, boss: 0 });
    expect(plan(2, 3, "vacation")).toMatchObject({ crabs: 6, puffers: 1, boss: 0 });
    expect(plan(3, 3, "vacation")).toMatchObject({ crabs: 7, puffers: 2, boss: 1 });
    expect(plan(1, 3, "nightmare")).toMatchObject({ crabs: 9, puffers: 0, boss: 0 });
    expect(plan(2, 3, "nightmare")).toMatchObject({ crabs: 15, puffers: 3, boss: 1 });
    expect(plan(3, 3, "nightmare")).toMatchObject({ crabs: 18, puffers: 5, boss: 1 });
  });

  it("scales with the biome (swamp crabs ×1.5, volcanic puffers ×2) and the full moon (×1.5)", () => {
    expect(plan(1, 3, "normal", "swamp").crabs).toBe(9);
    expect(plan(2, 3, "normal", "volcanic")).toMatchObject({ crabs: 10, puffers: 4 });
    expect(plan(1, 3, "normal", "tropic", true).crabs).toBe(9);
    expect(plan(2, 3, "normal", "tropic", true).puffers).toBe(3);
    expect(plan(3, 3, "normal", "tropic", true).boss).toBe(1);
    expect(plan(1, 2, "nightmare", "swamp", true).crabs).toBe(Math.round(5 * 1.5 * 1.5 * 1.5));
  });

  it("a flare skips the night entirely", () => {
    expect(plan(3, 6, "nightmare", "volcanic", true, true)).toEqual({ crabs: 0, puffers: 0, boss: 0, skipped: true });
  });

  it("spreads a wave over the first 60% of the night with the boss mid-window", () => {
    const night = 1500;
    const spawns = scheduleWave({ crabs: 12, puffers: 3, boss: 1, skipped: false }, night, mulberry32(4));
    expect(spawns).toHaveLength(16);
    for (const s of spawns) expect(s.at).toBeLessThan(night * MONSTER_SPAWN_WINDOW);
    expect(spawns[0]!.kind).toBe("crab");
    expect(spawns.find((s) => s.kind === "boss")!.at).toBe(Math.floor((night * MONSTER_SPAWN_WINDOW) / 2));
    for (let k = 1; k < spawns.length; k++) expect(spawns[k]!.at).toBeGreaterThanOrEqual(spawns[k - 1]!.at);
  });

  it("prefers shore cells on the far side of the camp", () => {
    const shore = [...Array(32).keys()].map((k) => ({ x: Math.cos((k / 32) * Math.PI * 2) * 28, z: Math.sin((k / 32) * Math.PI * 2) * 28 }));
    const camp = { x: 0, z: 18 };
    const rng = mulberry32(9);
    let far = 0;
    for (let k = 0; k < 2000; k++) if (pickShoreCell(shore, camp, rng, () => false)!.z < 0) far++;
    expect(far / 2000).toBeGreaterThan(0.6);
    // Cells flagged bad (lit, next to a player) are avoided when possible.
    for (let k = 0; k < 200; k++) expect(pickShoreCell(shore, camp, rng, (c) => c.z < 0)!.z).toBeGreaterThanOrEqual(0);
  });
});

describe("night spawning", () => {
  it("plans the wave at night start and releases it from shore cells within the spawn window", () => {
    const { w, mon } = bench({ seats: 3 });
    const clock = w.setClock(w.clockFor(1, "night"));
    mon.onClock(null, clock);
    expect(mon.wavePlan(0)).toMatchObject({ crabs: 6, puffers: 0, boss: 0 });
    const start = w.state.tick;
    run(w, mon, Math.ceil(w.timings.night * MONSTER_SPAWN_WINDOW) + 1);
    const spawns = w.ofType("monsterSpawn");
    expect(spawns).toHaveLength(6);
    for (const s of spawns) {
      expect(s.night).toBe(1);
      expect(s.kind).toBe("crab");
      expect(Math.hypot(s.pos.x, s.pos.z)).toBeCloseTo(SHORE_R, 0);
      expect(s.tick - start).toBeLessThanOrEqual(w.timings.night * MONSTER_SPAWN_WINDOW + 1);
    }
    expect(w.monsters().every((m) => m.kind === "crab")).toBe(true);
  });

  it("monsters climb out of the surf (emerge, harmless) before they hunt", () => {
    const { w, mon } = bench();
    mon.onClock(null, w.setClock(w.clockFor(1, "night")));
    run(w, mon, 1);
    const m = mon0(w);
    expect(m.mode).toBe("emerge");
    expect(m.modeTicks).toBeGreaterThan(0);
    run(w, mon, 50);
    expect(w.monsters()[0]!.mode).not.toBe("emerge");
  });

  it("a flare skips one night (and is used up); the next night comes as usual", () => {
    const { w, mon } = bench({ seats: 2 });
    w.team(0).flare = true;
    mon.onClock(null, w.setClock(w.clockFor(1, "night")));
    expect(mon.wavePlan(0)!.skipped).toBe(true);
    expect(w.team(0).flare).toBe(false);
    run(w, mon, w.timings.night - 2);
    expect(w.ofType("monsterSpawn")).toHaveLength(0);
    mon.onClock(null, w.setClock(w.clockFor(2, "night")));
    expect(mon.wavePlan(0)).toMatchObject({ crabs: 8, puffers: 2, skipped: false });
    run(w, mon, Math.ceil(w.timings.night * MONSTER_SPAWN_WINDOW) + 1);
    expect(w.ofType("monsterSpawn").length).toBe(10);
  });

  it("full moon tonight means ×1.5", () => {
    const { w, mon } = bench({ seats: 3 });
    w.state.weather = "fullmoon";
    mon.onClock(null, w.setClock(w.clockFor(1, "night")));
    expect(mon.wavePlan(0)!.crabs).toBe(9);
  });

  it(`never has more than MONSTER_CAP (${MONSTER_CAP}) alive; the rest queues`, () => {
    const { w, mon } = bench({ seats: 6, difficulty: "nightmare", biome: "swamp" });
    w.state.weather = "fullmoon";
    mon.onClock(null, w.setClock(w.clockFor(3, "night")));
    let max = 0;
    run(w, mon, w.timings.night - 5, () => {
      max = Math.max(max, w.state.monsters.size);
    });
    expect(max).toBe(MONSTER_CAP);
    expect(mon.queued()).toBeGreaterThan(0);
  });

  it("plans each night once even when the clock arrives every tick (onClock and step)", () => {
    const { w, mon } = bench({ seats: 2 });
    w.setClock(w.clockFor(1, "night") - 1);
    run(w, mon, 3, () => mon.onClock(null, w.setClock(w.state.clockTicks)));
    run(w, mon, Math.ceil(w.timings.night * MONSTER_SPAWN_WINDOW) + 1);
    expect(w.ofType("monsterSpawn")).toHaveLength(5);
  });
});

/* ======================================================== light rings */

describe("light rings", () => {
  it("night monsters never step into a light ring (property over a whole night)", () => {
    for (const seed of [1, 2, 3]) {
      const { w, mon } = bench({ seed, seats: 6, difficulty: "nightmare" });
      // Campfire (origin, 5 m), a planted torch guarding the raft, a torch-holder on the far side, and two loose rings.
      torch(w, "t1", 0, 22);
      const holder = w.addPlayer("holder", -14, -14);
      holder.inv0 = "torch";
      holder.cnt0 = 1;
      holder.torchTicks = 60000;
      w.extraLights.push({ x: 18, z: -6, r: TORCH_LIGHT_RADIUS, kind: "planted", team: 0 }, { x: -20, z: 8, r: FIRE_LIGHT_RADIUS, kind: "fire", team: 0 });
      const campers = [w.addPlayer("camper", 0.5, 0.5), w.addPlayer("guard", 0, 23)];
      const walker = w.addPlayer("walker", 12, 12);
      mon.onClock(null, w.setClock(w.clockFor(3, "night")));
      const rng = mulberry32(seed * 31);
      let violations = 0;
      let checks = 0;
      run(w, mon, w.timings.night - 2, () => {
        for (const p of [...campers, walker, holder]) {
          p.hp = 100;
          p.downed = false;
        }
        if (w.state.tick % 45 === 0) w.place(walker, (rng() * 2 - 1) * 22, (rng() * 2 - 1) * 22);
        for (const m of w.state.monsters.values()) {
          if (m.kind === "boss") continue;
          checks++;
          if (w.inLight(m.x, m.z)) violations++;
        }
      });
      expect(checks).toBeGreaterThan(5000);
      expect(violations).toBe(0);
    }
  }, 30_000);

  it("players inside a ring are safe from crabs: they wait at the edge", () => {
    const { w, mon } = bench();
    const camper = w.addPlayer("camper", 0, -1);
    w.team(0).hullWood = 0; // nothing to gnaw: the crab goes for the lit camper
    mon.spawnMonster("crab", 0, -12);
    run(w, mon, 300);
    const m = mon0(w);
    expect(w.ofType("playerHurt")).toHaveLength(0);
    expect(camper.hp).toBe(100);
    const d = Math.hypot(m.x, m.z);
    expect(d).toBeGreaterThanOrEqual(FIRE_LIGHT_RADIUS);
    expect(d).toBeLessThan(FIRE_LIGHT_RADIUS + 1.5);
    expect(m.targetId).toBe("camper");
  });

  it("the boss walks into the light, slowed", () => {
    const { w, mon } = bench();
    w.addPlayer("camper", 0, 0);
    w.team(0).hullWood = 0;
    mon.spawnMonster("boss", 0, -8);
    let inside = false;
    run(w, mon, 400, () => {
      const b = w.monsters().find((m) => m.kind === "boss");
      if (b && w.inLight(b.x, b.z)) inside = true;
    });
    expect(inside).toBe(true);
    expect(w.ofType("playerHurt").some((e) => e.cause === "boss" && e.amount === MONSTERS.boss.damage)).toBe(true);
  });

  it("a crab caught inside a new ring walks out of it", () => {
    const { w, mon } = bench();
    w.team(0).fireFuel = 0;
    mon.spawnMonster("crab", 0, -12);
    run(w, mon, 2);
    w.extraLights.push({ x: 0, z: -12, r: TORCH_LIGHT_RADIUS, kind: "planted", team: 0 });
    run(w, mon, 120);
    const m = mon0(w);
    expect(Math.hypot(m.x, m.z + 12)).toBeGreaterThanOrEqual(TORCH_LIGHT_RADIUS);
  });
});

/* =============================================================== combat */

describe("crabs", () => {
  it("flip at 2 damage (credit the flipper), stay helpless CRAB_FLIP_TICKS, then get back up", () => {
    const { w, mon } = bench();
    const ana = w.addPlayer("ana", -20, -20);
    const m = mon.spawnMonster("crab", 10, -10);
    const hit = () => mon.hitByProjectile(m, projectile(w, "coconut", m.x, m.z), 1, { x: 1, y: 0, z: 0 }, "ana");
    expect(hit()).toBe("bounce");
    expect(m.hp).toBe(1);
    expect(m.mode).not.toBe("flipped");
    expect(w.ofType("monsterHurt").at(-1)).toMatchObject({ id: m.id, hp: 1, damage: 1, byId: "ana" });
    hit();
    expect(m.mode).toBe("flipped");
    expect(m.modeTicks).toBe(CRAB_FLIP_TICKS);
    expect(w.ofType("monsterFlip").at(-1)).toMatchObject({ id: m.id, flipped: true, byId: "ana" });
    expect(ana.stats.kills).toBe(1);
    expect(ana.score).toBe(MVP_POINTS.kill);
    // Hitting a crab on its back does nothing more.
    hit();
    expect(m.mode).toBe("flipped");
    run(w, mon, CRAB_FLIP_TICKS - 1);
    expect(m.mode).toBe("flipped");
    expect(m.modeTicks).toBe(1);
    run(w, mon, 1);
    expect(m.mode).not.toBe("flipped");
    expect(m.hp).toBe(MONSTERS.crab.hp);
    expect(w.ofType("monsterFlip").at(-1)).toMatchObject({ id: m.id, flipped: false });
  });

  it("a spear sticks; a flipped crab can be collected as a raw crab", () => {
    const { w, mon } = bench();
    const ana = w.addPlayer("ana", -20, -20);
    const m = mon.spawnMonster("crab", 10, -10);
    expect(mon.hitByProjectile(m, projectile(w, "spear", 10, -10), 2, { x: 0, y: 0, z: 1 }, "ana")).toBe("stick");
    expect(m.mode).toBe("flipped");
    expect(mon.collect(m, ana)).toBe(true);
    expect(w.state.monsters.has(m.id)).toBe(false);
    expect(w.ofType("monsterDie").at(-1)).toMatchObject({ id: m.id, collected: true, fled: false, byId: "ana" });
    expect(w.ofType("pickup").at(-1)).toMatchObject({ playerId: "ana", kind: "crab_raw", source: "crab" });
    expect(ana.inv0).toBe("crab_raw");
    const n = mon.spawnMonster("crab", 5, -10);
    expect(mon.collect(n, ana)).toBe(false);
  });

  it("bite a reachable player: wind-up, 15 damage, knockback, cooldown", () => {
    const { w, mon } = bench();
    const ana = w.addPlayer("ana", 12, -12);
    mon.spawnMonster("crab", 12, -16);
    run(w, mon, 120);
    const bites = w.ofType("monsterAttack").filter((e) => e.targetType === "player");
    expect(bites.length).toBeGreaterThanOrEqual(1);
    const hurt = w.ofType("playerHurt");
    expect(hurt[0]).toMatchObject({ playerId: "ana", amount: MONSTERS.crab.damage, cause: "crab" });
    expect(ana.stunTicks).toBeGreaterThan(0);
    // Cooldown: no more than one bite per biteCooldownTicks.
    for (let k = 1; k < bites.length; k++) expect(bites[k]!.tick - bites[k - 1]!.tick).toBeGreaterThanOrEqual(MONSTERS.crab.biteCooldownTicks);
  });

  it("gnaw the raft only when nobody guards it", () => {
    const unguarded = bench();
    unguarded.w.addPlayer("far", -20, -15);
    unguarded.mon.spawnMonster("crab", 0, 22);
    run(unguarded.w, unguarded.mon, RAFT_GNAW_TICKS * 3 + 90);
    const dmg = unguarded.w.ofType("raftDamage");
    expect(dmg.length).toBeGreaterThanOrEqual(2);
    expect(dmg.length).toBeLessThanOrEqual(4);
    expect(dmg[0]!.byMonsterId).toBe(mon0(unguarded.w).id);
    expect(unguarded.w.team(0).hullWood).toBe(10 - dmg.length);
    for (let k = 1; k < dmg.length; k++) expect(dmg[k]!.tick - dmg[k - 1]!.tick).toBe(RAFT_GNAW_TICKS);

    const guarded = bench();
    guarded.w.addPlayer("guard", 4, 24);
    guarded.mon.spawnMonster("crab", 0, 22);
    run(guarded.w, guarded.mon, RAFT_GNAW_TICKS * 3 + 90, () => {
      const g = guarded.w.state.players.get("guard")!;
      g.hp = 100;
    });
    expect(guarded.w.ofType("raftDamage")).toHaveLength(0);
    expect(mon0(guarded.w).targetId).toBe("guard");
    expect(guarded.w.ofType("playerHurt").length).toBeGreaterThan(0);
  });

  it("a torch planted by the raft keeps the gnawers off it", () => {
    const { w, mon } = bench();
    torch(w, "t", 0, 25.5);
    mon.spawnMonster("crab", 0, 17);
    run(w, mon, RAFT_GNAW_TICKS * 3);
    expect(w.ofType("raftDamage")).toHaveLength(0);
  });

  it("gnaw through a fence in its way (FENCE_HP hits over FENCE_GNAW_TICKS)", () => {
    const { w, mon } = bench();
    fence(w, "f1", 0, 20);
    const m = mon.spawnMonster("crab", 0, 15);
    let destroyedAt = -1;
    let firstHit = -1;
    run(w, mon, FENCE_GNAW_TICKS * 4, () => {
      if (firstHit < 0 && w.ofType("structureHit").length > 0) firstHit = w.state.tick;
      if (destroyedAt < 0 && w.ofType("structureDestroyed").length > 0) destroyedAt = w.state.tick;
    });
    const hits = w.ofType("structureHit");
    expect(hits.map((h) => h.hp)).toEqual([3, 2, 1, 0]);
    expect(hits.every((h) => h.byId === m.id)).toBe(true);
    expect(w.ofType("structureDestroyed")[0]).toMatchObject({ id: "f1", byId: m.id });
    expect(w.state.structures.has("f1")).toBe(false);
    expect(destroyedAt - firstHit).toBeLessThanOrEqual(FENCE_GNAW_TICKS);
    expect(destroyedAt - firstHit).toBeGreaterThanOrEqual(FENCE_GNAW_TICKS - Math.round(FENCE_GNAW_TICKS / FENCE_HP) - 1);
  });

  it("go for bait over the raft, and come back when it's gone", () => {
    const { w, mon } = bench();
    const m = mon.spawnMonster("crab", 6, 20);
    run(w, mon, 10);
    expect(m.targetId).toBe("raft");
    const fish = w.spawnProjectile("fish_raw", { x: -6, y: 1.2, z: 14 }, { x: 0, y: 0, z: 0 }, { state: "rest" })!;
    fish.baitTicks = BAIT_TICKS;
    mon.onBait(fish);
    run(w, mon, 2, () => fish.baitTicks--);
    expect(m.mode).toBe("lured");
    expect(m.targetId).toBe(fish.id);
    run(w, mon, BAIT_TICKS - 20, () => (fish.baitTicks = Math.max(0, fish.baitTicks - 1)));
    expect(Math.hypot(m.x - fish.x, m.z - fish.z)).toBeLessThan(2);
    run(w, mon, 40, () => (fish.baitTicks = Math.max(0, fish.baitTicks - 1)));
    expect(m.targetId).toBe("raft");
  });

  it("back off from a torch swing", () => {
    const { w, mon } = bench();
    const m = mon.spawnMonster("crab", 10, -10);
    const before = Math.hypot(m.x - 9, m.z + 10);
    mon.scare({ x: 9, y: 1, z: -10 }, 2, TORCH_SWING_SCARE_TICKS);
    expect(m.mode).toBe("stunned");
    run(w, mon, TORCH_SWING_SCARE_TICKS - 1);
    expect(Math.hypot(m.x - 9, m.z + 10)).toBeGreaterThan(before + 1);
    run(w, mon, 2);
    expect(m.mode).not.toBe("stunned");
  });
});

describe("puffers and the boss", () => {
  it("a puffer rolling into a player: 20 damage + knockback, and it pops", () => {
    const { w, mon } = bench();
    const ana = w.addPlayer("ana", 12, -12);
    const m = mon.spawnMonster("puffer", 12, -20);
    run(w, mon, 90);
    expect(w.ofType("playerHurt")[0]).toMatchObject({ playerId: "ana", amount: MONSTERS.puffer.damage, cause: "puffer" });
    expect(w.state.monsters.has(m.id)).toBe(false);
    expect(w.ofType("monsterDie")[0]).toMatchObject({ id: m.id, fled: false });
    expect(Math.hypot(ana.vx, ana.vz)).toBeCloseTo(MONSTERS.puffer.knockH, 3);
  });

  it("one damage pops a puffer; a puffer snags on a fence and pops on it", () => {
    const { w, mon } = bench();
    w.addPlayer("ana", -20, -20);
    const p = mon.spawnMonster("puffer", 10, -10);
    mon.hitByProjectile(p, projectile(w, "stone", 10, -10), 1, { x: 0, y: 0, z: 0 }, "ana");
    expect(w.state.monsters.has(p.id)).toBe(false);
    expect(w.state.players.get("ana")!.stats.kills).toBe(1);

    const b2 = bench();
    fence(b2.w, "f", 0, 20);
    const q = b2.mon.spawnMonster("puffer", 0, 14);
    run(b2.w, b2.mon, 60);
    expect(q.mode).toBe("stunned");
    run(b2.w, b2.mon, 200);
    expect(b2.w.state.monsters.has(q.id)).toBe(false);
    expect(b2.w.state.structures.get("f")!.hp).toBe(FENCE_HP - 1);
  });

  it("the boss smashes fences at once and gnaws the raft harder", () => {
    const { w, mon } = bench();
    fence(w, "f", 0, 20);
    mon.spawnMonster("boss", 0, 14);
    run(w, mon, RAFT_GNAW_TICKS * 2 + 200);
    expect(w.ofType("structureHit")).toHaveLength(0);
    expect(w.ofType("structureDestroyed")[0]).toMatchObject({ id: "f" });
    const dmg = w.ofType("raftDamage");
    expect(dmg.length).toBeGreaterThan(0);
    expect(dmg[0]!.amount).toBe(2);
  });

  it("the boss never flips and dies at 0 hp", () => {
    const { w, mon } = bench();
    const ana = w.addPlayer("ana", -20, -20);
    const boss = mon.spawnMonster("boss", 10, -10);
    for (let k = 0; k < 5; k++) mon.hitByProjectile(boss, projectile(w, "spear", 10, -10), 2, { x: 1, y: 0, z: 0 }, "ana");
    expect(boss.hp).toBe(2);
    expect(boss.mode).not.toBe("flipped");
    mon.blast({ x: 10, y: 1, z: -10 }, 3, 2, "ana");
    expect(w.state.monsters.has(boss.id)).toBe(false);
    expect(ana.stats.kills).toBe(1);
  });

  it("the boss falls for bait for BOSS_BAIT_TICKS only", () => {
    const { w, mon } = bench();
    const boss = mon.spawnMonster("boss", 6, 16);
    const fish = w.spawnProjectile("fish_raw", { x: -5, y: 1.2, z: 10 }, { x: 0, y: 0, z: 0 }, { state: "rest" })!;
    fish.baitTicks = 60000;
    mon.onBait(fish);
    let lured = 0;
    run(w, mon, BOSS_BAIT_TICKS + 60, () => {
      if (boss.mode === "lured") lured++;
    });
    expect(lured).toBeGreaterThan(BOSS_BAIT_TICKS - 10);
    expect(lured).toBeLessThanOrEqual(BOSS_BAIT_TICKS + 1);
    expect(boss.targetId).toBe("raft");
  });

  it("a blast flips crabs, pops puffers and returns who it hit", () => {
    const { w, mon } = bench();
    w.addPlayer("ana", -20, -20);
    const c = mon.spawnMonster("crab", 10, -10);
    const p = mon.spawnMonster("puffer", 11, -10);
    const far = mon.spawnMonster("crab", -10, 10);
    const ids = mon.blast({ x: 10.5, y: 1.3, z: -10 }, 3, 2, "ana");
    expect(ids.sort()).toEqual([c.id, p.id].sort());
    expect(c.mode).toBe("flipped");
    expect(w.state.monsters.has(p.id)).toBe(false);
    expect(far.mode).toBe("hunt");
  });

  it("a puffer's direct hit and its blast damage a monster only once", () => {
    const { w, mon } = bench();
    w.addPlayer("ana", -20, -20);
    const boss = mon.spawnMonster("boss", 10, -10);
    expect(mon.hitByProjectile(boss, projectile(w, "puffer", 10, -10), 2, { x: 0, y: 0, z: 0 }, "ana")).toBe("consume");
    mon.blast({ x: 10, y: 1.3, z: -10 }, 3, 2, "ana");
    expect(boss.hp).toBe(MONSTERS.boss.hp - 2);
  });
});

/* ================================================================== dawn */

describe("dawn", () => {
  it("everything flees to the shore and despawns (flipped crabs once they're up)", () => {
    const { w, mon } = bench({ seats: 4 });
    w.addPlayer("ana", 0, 0);
    mon.onClock(null, w.setClock(w.clockFor(2, "night")));
    run(w, mon, 400);
    const kinds: MonsterKind[] = ["crab", "puffer", "boss"];
    for (const k of kinds) mon.spawnMonster(k, -8, -14);
    const flipped = mon.spawnMonster("crab", 8, -14);
    mon.blast({ x: 8, y: 1, z: -14 }, 1, 0, "ana");
    expect(flipped.mode).toBe("flipped");
    const alive = w.state.monsters.size;
    expect(alive).toBeGreaterThan(4);
    const queuedBefore = mon.queued();
    w.clearEvents();
    w.setClock(w.clockFor(3, "day"));
    run(w, mon, 1);
    expect(queuedBefore).toBeGreaterThanOrEqual(0);
    expect(mon.queued()).toBe(0);
    for (const m of w.state.monsters.values()) if (m.id !== flipped.id) expect(m.mode).toBe("flee");
    run(w, mon, FLEE_TIMEOUT_TICKS + CRAB_FLIP_TICKS + 5);
    expect(w.state.monsters.size).toBe(0);
    const dies = w.ofType("monsterDie");
    expect(dies).toHaveLength(alive);
    expect(dies.every((d) => d.fled)).toBe(true);
    expect(w.ofType("monsterSpawn")).toHaveLength(0);
  });
});

/* ============================================================ visitors */

describe("Şükrü the gull", () => {
  it("steals a raw fish, circles GULL_CIRCLES times, then drops it on the beach", () => {
    const { w, mon } = bench();
    const ana = w.addPlayer("ana", 8, 10);
    ana.inv1 = "fish_raw";
    ana.cnt1 = 2;
    const [id] = mon.spawnVisitor("gull", ana);
    expect(id).toBeDefined();
    const gull = w.state.monsters.get(id!)!;
    expect(gull.kind).toBe("gull");
    expect(gull.y).toBeGreaterThan(4);
    let stoleAt = -1;
    let droppedAt = -1;
    const path: { x: number; z: number }[] = [];
    run(w, mon, 900, () => {
      const steals = w.ofType("steal");
      if (stoleAt < 0 && steals.some((s) => !s.dropped)) stoleAt = w.state.tick;
      if (droppedAt < 0 && steals.some((s) => s.dropped)) droppedAt = w.state.tick;
      const g = w.state.monsters.get(id!);
      if (g && g.mode === "carry" && g.modeTicks > 0) path.push({ x: g.x, z: g.z });
    });
    expect(stoleAt).toBeGreaterThan(0);
    expect(ana.cnt1).toBe(1);
    expect(w.ofType("steal")[0]).toMatchObject({ monsterId: id, kind: "gull", item: "fish_raw", fromId: "ana", dropped: false });
    expect(droppedAt - stoleAt).toBeGreaterThanOrEqual(GULL_CARRY_TICKS);
    // Total angle swept around the circle's center.
    const cx = path.reduce((s, p) => s + p.x, 0) / path.length;
    const cz = path.reduce((s, p) => s + p.z, 0) / path.length;
    let swept = 0;
    for (let k = 1; k < path.length; k++) {
      let d = Math.atan2(path[k]!.z - cz, path[k]!.x - cx) - Math.atan2(path[k - 1]!.z - cz, path[k - 1]!.x - cx);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      swept += d;
    }
    expect(Math.abs(swept) / (Math.PI * 2)).toBeCloseTo(GULL_CIRCLES, 0);
    const fish = [...w.state.projectiles.values()].find((p) => p.kind === "fish_raw");
    expect(fish).toBeDefined();
    expect(heightAt(w.island.grid, fish!.x, fish!.z)).toBeGreaterThan(0.1);
    expect(w.state.monsters.has(id!)).toBe(false);
    expect(w.ofType("monsterDie").at(-1)).toMatchObject({ id, fled: true });
  });

  it("drops the fish at once when hit", () => {
    const { w, mon } = bench();
    const ana = w.addPlayer("ana", 8, 10);
    ana.inv0 = "fish_raw";
    ana.cnt0 = 1;
    const [id] = mon.spawnVisitor("gull", ana);
    run(w, mon, 600, () => {
      const g = w.state.monsters.get(id!);
      if (g && g.carry === "fish_raw") {
        mon.hitByProjectile(g, projectile(w, "coconut", g.x, g.z), 1, { x: 0, y: 0, z: 0 }, "ana");
      }
    });
    const steals = w.ofType("steal");
    expect(steals.map((s) => s.dropped)).toEqual([false, true]);
    expect(steals[1]!.tick - steals[0]!.tick).toBeLessThan(5);
    expect([...w.state.projectiles.values()].some((p) => p.kind === "fish_raw")).toBe(true);
  });

  it("raids the chest when no player is given", () => {
    const { w, mon } = bench();
    w.team(0).chest.set("fish_raw", 1);
    mon.spawnVisitor("gull", null);
    run(w, mon, 600);
    expect(w.ofType("steal")[0]).toMatchObject({ fromId: "chest", item: "fish_raw", dropped: false });
    expect(w.team(0).chest.get("fish_raw") ?? 0).toBe(0);
  });
});

describe("monkeys", () => {
  it("steal from the chest, escape up a tree, and drop the loot when hit", () => {
    const { w, mon } = bench({ rng: () => 0.9 });
    w.team(0).chest.set("rope", 1);
    const ids = mon.spawnVisitor("monkey", null);
    expect(ids).toHaveLength(1);
    const m = w.state.monsters.get(ids[0]!)!;
    let perched = false;
    run(w, mon, 600, () => {
      if (m.carry !== "" && m.y > heightAt(w.island.grid, m.x, m.z) + 2) perched = true;
    });
    expect(w.ofType("steal")[0]).toMatchObject({ kind: "monkey", item: "rope", fromId: "chest", dropped: false });
    expect(w.team(0).chest.get("rope") ?? 0).toBe(0);
    expect(perched).toBe(true);
    expect(m.mode).toBe("carry");
    mon.hitByProjectile(m, projectile(w, "coconut", m.x, m.z), 1, { x: 0, y: 0, z: 0 }, "ana");
    expect(w.ofType("steal").at(-1)).toMatchObject({ item: "rope", dropped: true });
    expect(m.carry).toBe("");
    expect([...w.state.projectiles.values()].some((p) => p.kind === "rope")).toBe(true);
    run(w, mon, 300);
    expect(w.state.monsters.has(m.id)).toBe(false);
  });

  it("a hit at the chest puts the loot straight back", () => {
    const { w, mon } = bench({ rng: () => 0.9 });
    w.team(0).chest.set("wood", 2);
    const [id] = mon.spawnVisitor("monkey", null);
    const m = w.state.monsters.get(id!)!;
    let done = false;
    run(w, mon, 600, () => {
      if (!done && m.carry !== "") {
        done = true;
        mon.hitByProjectile(m, projectile(w, "coconut", m.x, m.z), 1, { x: 0, y: 0, z: 0 }, "ana");
      }
    });
    expect(done).toBe(true);
    expect(w.team(0).chest.get("wood")).toBe(2);
    expect(w.ofType("chestChanged").map((e) => e.op)).toEqual(["steal", "return"]);
  });

  it("left alone up the tree, a monkey vanishes with the loot", () => {
    const { w, mon } = bench({ rng: () => 0.9 });
    w.team(0).chest.set("stone", 1);
    const [id] = mon.spawnVisitor("monkey", null);
    run(w, mon, 600 + MONKEY_TREE_TICKS);
    expect(w.state.monsters.has(id!)).toBe(false);
    expect(w.ofType("monsterDie").at(-1)).toMatchObject({ id, fled: true });
    expect(w.ofType("steal").filter((s) => s.dropped)).toHaveLength(0);
  });

  it("the first monkey goes for Fenomen", () => {
    const { w, mon } = bench({ rng: () => 0.9 });
    w.team(0).chest.set("wood", 1);
    const fen = w.addPlayer("fen", 4, 6, "fenomen");
    fen.inv0 = "coconut";
    fen.cnt0 = 1;
    const ids = mon.spawnVisitor("monkey", fen);
    expect(ids).toHaveLength(2);
    expect(w.state.monsters.get(ids[0]!)!.targetId).toBe("fen");
    run(w, mon, 600);
    const fromFen = w.ofType("steal").find((s) => s.fromId === "fen");
    expect(fromFen).toMatchObject({ item: "coconut", dropped: false });
    expect(fen.cnt0).toBe(0);
  });

  it("dusk sends the visitors home", () => {
    const { w, mon } = bench({ rng: () => 0.9 });
    w.team(0).chest.set("wood", 1);
    mon.spawnVisitor("monkey", null);
    mon.onClock(null, w.setClock(w.clockFor(1, "day", 10)));
    mon.onClock(null, w.setClock(w.clockFor(1, "dusk")));
    expect(w.state.monsters.size).toBe(0);
  });
});

describe("clear", () => {
  it("removes every monster and forgets the wave", () => {
    const { w, mon } = bench();
    mon.onClock(null, w.setClock(w.clockFor(1, "night")));
    run(w, mon, 300);
    expect(w.state.monsters.size).toBeGreaterThan(0);
    mon.clear();
    expect(w.state.monsters.size).toBe(0);
    expect(mon.queued()).toBe(0);
    expect(mon.aliveCount()).toBe(0);
  });
});
