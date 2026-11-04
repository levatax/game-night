// RaftWorld bench (game4.md §20 "World bench", docs/ARCHITECTURE.md §4.3–4.5). Owner: server-world.
// Runs the real shared sim (stepPlayer / stepProjectile) and the real life systems on a hand-made island
// (testkit.ts). Monster AI is kept out of the way: day clocks (no waves), or no clock at all where a test puts a
// monster into the state by hand.

import { describe, expect, it, vi } from "vitest";
import {
  BERRY_FOOD,
  CHARGE_FULL_TICKS,
  COCONUT_BALL_COUNT,
  COLLECTOR_FILL_TICKS,
  BIOMES,
  DIFFICULTIES,
  DOWNED_TICKS,
  DROWN_DAMAGE_PER_SEC,
  DROWN_TICKS,
  FENCE_HP,
  ESCORT_RADIUS,
  FIRE_DAY_BURN_MULT,
  HEAVY_CARRY_ALONE,
  HEAVY_CARRY_ESCORT,
  FIRE_FUEL_MAX_TICKS,
  FIRE_LIGHT_RADIUS_MIN,
  FIRE_REPEL_MIN_FRACTION,
  fireLightRadius,
  fireRepels,
  FIRE_START_FUEL_TICKS,
  FIRE_WOOD_FUEL_TICKS,
  FUEL_CAN_TICKS,
  GATHER_SEC,
  JELLYFISH_DAMAGE_PER_SEC,
  KRAKEN_HIT_INTERVAL_TICKS,
  KRAKEN_TICKS,
  LAUNCH_MIN_TICKS,
  LAUNCH_WAIT_TICKS,
  MVP_POINTS,
  PALM_REGROW_TICKS,
  PIRATE_HAT_SCORE,
  PUFFER_FUSE_TICKS,
  PUFFER_SELF_DAMAGE,
  RAFT_HP_AFTER_LOSS,
  RAFT_HP_MAX,
  RAFT_LAUNCH_STAGE,
  RAFT_REPAIR_PLANK_HP,
  RAIN_FIRE_DRAIN_MULT,
  RESPAWN_BARS,
  RESPAWN_HP,
  REVIVE_HP,
  REVIVE_TICKS,
  SPRING_RECHARGE_TICKS,
  SPRING_WATER,
  SPYGLASS_TICKS,
  TORCH_BURN_TICKS,
  WRECK_SCRAP_BASE,
  secToTicks,
} from "../../shared/constants.js";
import { raftAssemblyTicks, raftStageNeeds } from "../../shared/items.js";
import { BTN } from "../../shared/protocol.js";
import { countOf, slotCount, slotKind } from "../../shared/rules/inventory.js";
import { snapYaw8, type CoverCircle } from "../../shared/sim/cover.js";
import { computeThrowVelocities } from "../../shared/sim/throw.js";
import { RaftState, PlayerState } from "../schema.js";
import { hungerDrainPerTick, secondsToEmpty, thirstDrainPerTick, warmthPerSec } from "./rules.js";
import { Bench, benchIsland, NODE, PLATEAU_Y } from "./testkit.js";
import { planLaunchWave } from "./life/waves.js";
import { mulberry32 } from "../../shared/island/noise.js";
import { RaftWorld, STARTER_ITEMS } from "./World.js";

const SEC = 30;

/** Stand `id` next to the campfire. */
function atCamp(b: Bench, id: string): PlayerState {
  const site = b.island.sites[0]!;
  return b.place(id, site.campfire.x, site.campfire.z + 1.5, 0);
}

/** Stand `id` 2 m in front of the raft, facing it. */
function atRaft(b: Bench, id: string, dx = 0): PlayerState {
  const r = b.island.sites[0]!.raft;
  return b.placeFacing(id, r.x + dx, r.z, 0, -2);
}

/** Every stage assembled, a sound raft, and the clock on the launch day (Normal: day 7). */
function readyRaft(b: Bench): void {
  b.world.raft.setStage(0, RAFT_LAUNCH_STAGE);
  b.setClock(DIFFICULTIES.normal.launchDay, "day");
}

/** Hold E at the raft (assembly) for `ticks`. */
function assemble(b: Bench, id: string, ticks: number): ReturnType<Bench["run"]> {
  return b.hold(id, BTN.INTERACT, ticks, BTN.INTERACT_PRESS);
}

describe("RaftWorld: match start", () => {
  it("wakes participants at their spawns with full bars and one starter item; sizes and stocks the camp", () => {
    const state = new RaftState();
    const island = benchIsland();
    for (const [id, seat] of [["a", 0], ["b", 1], ["watcher", 2]] as const) {
      const p = new PlayerState();
      p.id = id;
      p.seat = seat;
      state.players.set(id, p);
    }
    const world = new RaftWorld(state, island, { fast: false, difficulty: "normal", rng: mulberry32(3) });
    state.nodes[NODE.tree] = 0;
    world.startMatch(["a", "b"], 3);

    const site = island.sites[0]!;
    for (const id of ["a", "b"]) {
      const p = state.players.get(id)!;
      expect(p.alive).toBe(true);
      expect([p.x, p.z]).toEqual([site.spawns[p.seat]!.x, site.spawns[p.seat]!.z]);
      expect([p.hp, p.hunger, p.thirst, p.warmth]).toEqual([100, 100, 100, 100]);
      const starters = STARTER_ITEMS.filter((s) => countOf(p, s.kind) === s.count);
      expect(starters.length).toBe(1);
    }
    expect(state.players.get("watcher")!.alive).toBe(false);
    const team = state.teams[0]!;
    expect(team.seats).toBe(3);
    expect(team.stage).toBe(0);
    expect([...team.raftHave]).toEqual([0, 0, 0]);
    expect([...team.raftNeed]).toEqual(raftStageNeeds(0, 3));
    expect([team.raftWork, team.raftWorkNeed, team.raftHp]).toEqual([0, raftAssemblyTicks(0), 0]);
    expect([team.benchTier, team.wreckScrap, team.springCharges, team.bossDown]).toEqual([0, WRECK_SCRAP_BASE + 3, 4 + 2 * 3, false]);
    expect(team.fireFuel).toBe(FIRE_START_FUEL_TICKS);
    expect(team.chest.size).toBe(2);
    expect(state.nodes[NODE.tree]).toBe(4);
  });

  it("the fast test raft needs one of everything", () => {
    const b = new Bench([["a"]], { fast: true });
    expect([...b.state.teams[0]!.raftNeed]).toEqual([1, 1, 0]);
    expect(b.state.teams[0]!.raftWorkNeed).toBe(secToTicks(1));
  });

  it("resetToLobby clears entities and bodies in place", () => {
    const b = new Bench([["a"]]);
    const projectiles = b.state.projectiles;
    b.world.spawnProjectile("coconut", { x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: 0 }, { state: "rest" });
    b.give("a", "wood", 3);
    b.world.resetToLobby();
    expect(b.state.projectiles).toBe(projectiles);
    expect(b.state.projectiles.size).toBe(0);
    expect(b.p("a").alive).toBe(false);
    expect(countOf(b.p("a"), "wood")).toBe(0);
  });
});

describe("RaftWorld: gathering", () => {
  it("a hold-E channel yields one wood per 4 s, decrements the node and fills a slot; by hand no log", () => {
    const b = new Bench([["a"]]);
    const tree = b.island.nodes[NODE.tree]!;
    b.placeFacing("a", tree.x, tree.z, 0, 1.5);
    const unit = secToTicks(GATHER_SEC.wood);
    const first = b.hold("a", BTN.INTERACT, unit + 1, BTN.INTERACT_PRESS);
    const g = b.of("gather", first);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ playerId: "a", node: NODE.tree, kind: "wood", count: 1, depleted: false, dropped: false, eaten: false });
    expect(b.state.nodes[NODE.tree]).toBe(3);
    expect(countOf(b.p("a"), "wood")).toBe(1);
    expect(b.p("a").stats.gathered).toBe(1);
    expect(b.p("a").score).toBe(MVP_POINTS.gather);
    // Keep holding: the channel restarts on the same tree until it is empty.
    b.hold("a", BTN.INTERACT, unit * 3);
    expect(b.state.nodes[NODE.tree]).toBe(0);
    expect(countOf(b.p("a"), "wood")).toBe(4);
    expect(b.of("gather").at(-1)!.depleted).toBe(true);
    expect(b.of("gather").at(-1)!.felled).toBeUndefined();
    expect([...b.state.projectiles.values()].some((p) => p.kind === "log")).toBe(false);
    expect(b.p("a").channel).toBe(0);
  });

  it("an axe anywhere in the inventory makes wood take 1.5 s, and its last chop fells the tree: a log", () => {
    const b = new Bench([["a"]]);
    const tree = b.island.nodes[NODE.tree]!;
    b.placeFacing("a", tree.x, tree.z, 0, 1.5);
    b.give("a", "axe", 1, 3);
    const unit = secToTicks(GATHER_SEC.woodAxe);
    b.hold("a", BTN.INTERACT, unit + 1, BTN.INTERACT_PRESS);
    expect(countOf(b.p("a"), "wood")).toBe(1);
    b.hold("a", BTN.INTERACT, unit * 3 + 3);
    const last = b.of("gather").at(-1)!;
    expect(last.depleted).toBe(true);
    const log = b.state.projectiles.get(last.felled!)!;
    expect(log.kind).toBe("log");
    b.run(60);
    expect(log.state).toBe("rest");
    // Logs never despawn.
    b.state.tick += secToTicks(400);
    b.run(2);
    expect(b.state.projectiles.has(log.id)).toBe(true);
  });

  it("releasing E stops the channel without a unit", () => {
    const b = new Bench([["a"]]);
    const rock = b.island.nodes[NODE.rock]!;
    b.placeFacing("a", rock.x, rock.z, 0, -1.6);
    b.hold("a", BTN.INTERACT, 20, BTN.INTERACT_PRESS);
    b.run(5, () => b.send("a"));
    b.hold("a", BTN.INTERACT, 30);
    expect(b.of("gather")).toHaveLength(0);
    expect(b.state.nodes[NODE.rock]).toBe(2);
  });

  it("a full inventory drops the gathered unit at the feet", () => {
    const b = new Bench([["a"]]);
    const bush = b.island.nodes[NODE.ropeBush]!;
    b.placeFacing("a", bush.x, bush.z, 0, 1.2);
    for (let s = 0; s < 4; s++) b.give("a", "stone", 3, s);
    b.hold("a", BTN.INTERACT, secToTicks(GATHER_SEC.rope) + 1, BTN.INTERACT_PRESS);
    const g = b.of("gather");
    expect(g).toHaveLength(1);
    expect(g[0]!.dropped).toBe(true);
    const ground = [...b.state.projectiles.values()].filter((p) => p.kind === "rope");
    expect(ground).toHaveLength(1);
    expect(ground[0]!.state).toBe("rest");
  });

  it("berries are eaten on the spot", () => {
    const b = new Bench([["a"]]);
    const bush = b.island.nodes[NODE.berryBush]!;
    b.placeFacing("a", bush.x, bush.z, 0, 1.2);
    b.p("a").hunger = 50;
    b.hold("a", BTN.INTERACT, secToTicks(GATHER_SEC.berry) + 1, BTN.INTERACT_PRESS);
    expect(b.of("gather")[0]).toMatchObject({ kind: "berry", eaten: true });
    expect(b.p("a").hunger).toBeGreaterThanOrEqual(50 + BERRY_FOOD - 1);
    expect(countOf(b.p("a"), "wood") + countOf(b.p("a"), "rope")).toBe(0);
  });
});

describe("RaftWorld: palms", () => {
  it("LMB shakes one coconut loose; it falls, rests and E picks it up", () => {
    const b = new Bench([["a"]]);
    const palm = b.island.nodes[NODE.palm]!;
    b.placeFacing("a", palm.x, palm.z, 0, 1.6);
    b.send("a", { buttons: BTN.USE_PRESS });
    const evs = b.tick();
    const shake = b.of("palmShake", evs);
    expect(shake).toHaveLength(1);
    expect(shake[0]!.projectileIds).toHaveLength(1);
    expect(b.state.nodes[NODE.palm]).toBe(1);
    const nut = b.state.projectiles.get(shake[0]!.projectileIds[0]!)!;
    b.run(90, () => b.send("a"));
    expect(nut.state).toBe("rest");
    // Face the coconut and press E.
    b.placeFacing("a", nut.x, nut.z, 0, 1);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    const got = b.of("pickup", b.tick());
    expect(got[0]).toMatchObject({ playerId: "a", kind: "coconut", source: "ground" });
    expect(countOf(b.p("a"), "coconut")).toBe(1);
    expect(b.state.projectiles.has(nut.id)).toBe(false);
  });

  it("an axe in hand drops every coconut; an empty palm is a whiff and regrows", () => {
    const b = new Bench([["a"]]);
    const palm = b.island.nodes[NODE.palm]!;
    b.placeFacing("a", palm.x, palm.z, 0, 1.6);
    b.give("a", "axe", 1);
    b.send("a", { buttons: BTN.USE_PRESS });
    expect(b.of("palmShake", b.tick())[0]!.projectileIds).toHaveLength(2);
    expect(b.state.nodes[NODE.palm]).toBe(0);
    b.run(15, () => b.send("a"));
    b.send("a", { buttons: BTN.USE_PRESS });
    expect(b.of("use", b.tick())[0]).toMatchObject({ what: "whiffPalm" });
    b.state.tick += PALM_REGROW_TICKS;
    b.tick();
    expect(b.state.nodes[NODE.palm]).toBe(2);
  });

  it("LMB elsewhere with an empty hand is a punch", () => {
    const b = new Bench([["a"]]);
    b.place("a", 0, 0, 0);
    b.send("a", { buttons: BTN.USE_PRESS });
    expect(b.of("use", b.tick())[0]).toMatchObject({ playerId: "a", what: "punch" });
  });
});

describe("RaftWorld: throws, tosses, catches", () => {
  it("a full-charge release consumes one unit and launches it with computeThrowVelocities", () => {
    const b = new Bench([["a"]]);
    const p = b.place("a", 0, 0, 0.3);
    b.give("a", "coconut", 2);
    b.hold("a", BTN.THROW, CHARGE_FULL_TICKS);
    const seq = b.send("a");
    const evs = b.tick();
    const t = b.of("throw", evs);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ ownerId: "a", throwSeq: seq, kind: "coconut", charge: 1, toss: false });
    const want = computeThrowVelocities({ kind: "coconut", charge: 1, toss: false, yaw: p.yaw, pitch: p.pitch })[0]!;
    expect(t[0]!.velocities[0]!.x).toBeCloseTo(want.x, 9);
    expect(t[0]!.velocities[0]!.z).toBeCloseTo(want.z, 9);
    expect(countOf(p, "coconut")).toBe(1);
    const proj = b.state.projectiles.get(t[0]!.projectileIds[0]!)!;
    expect(proj.state).toBe("live");
    expect(proj.throwSeq).toBe(seq);
  });

  it("a coconut cluster releases three coconuts", () => {
    const b = new Bench([["a"]]);
    b.place("a", 0, 0, 0);
    b.give("a", "coconut_ball", 1);
    b.hold("a", BTN.THROW, 10);
    b.send("a");
    const t = b.of("throw", b.tick())[0]!;
    expect(t.kind).toBe("coconut_ball");
    expect(t.projectileIds).toHaveLength(COCONUT_BALL_COUNT);
    for (const id of t.projectileIds) expect(b.state.projectiles.get(id)!.kind).toBe("coconut");
    expect(countOf(b.p("a"), "coconut_ball")).toBe(0);
  });

  it("Q tosses one unit as a harmless loose item a teammate can catch", () => {
    const b = new Bench([["a"], ["b"]]);
    b.place("a", 0, 0, 0); // faces -Z
    b.place("b", 0, -3.2, Math.PI); // faces +Z, toward a
    b.give("a", "wood", 3);
    b.send("a", { buttons: BTN.DROP });
    const t = b.of("throw", b.tick())[0]!;
    expect(t.toss).toBe(true);
    expect(b.state.projectiles.get(t.projectileIds[0]!)!.state).toBe("loose");
    expect(countOf(b.p("a"), "wood")).toBe(2);
    const caught = b.of("catch", b.run(30, (i) => b.send("b", { buttons: i === 2 ? BTN.CATCH : 0 })));
    expect(caught).toHaveLength(1);
    expect(caught[0]).toMatchObject({ playerId: "b", throwerId: "a", kind: "wood", kept: true });
    expect(countOf(b.p("b"), "wood")).toBe(1);
    expect(b.of("hit")).toHaveLength(0);
  });

  it("a tossed torch is planted as a torch structure that keeps its burn", () => {
    const b = new Bench([["a"]]);
    b.place("a", 0, 0, 0);
    b.give("a", "torch", 1);
    b.p("a").torchTicks = 1000;
    b.send("a", { buttons: BTN.DROP });
    const placed = b.of("structurePlaced", b.tick());
    expect(placed).toHaveLength(1);
    expect(placed[0]!.kind).toBe("torch");
    const s = b.state.structures.get(placed[0]!.id)!;
    expect(s.life).toBeGreaterThan(990);
    expect(countOf(b.p("a"), "torch")).toBe(0);
    expect(b.p("a").torchTicks).toBe(0);
    expect(b.world.lights().some((l) => l.kind === "planted")).toBe(true);
  });

  it("a live projectile hitting a teammate only knocks them back (coop)", () => {
    const b = new Bench([["a"], ["b"]]);
    b.place("a", 0, 6, 0);
    const target = b.place("b", 0, 0, 0);
    b.clockTicks = null;
    b.world.spawnProjectile("coconut", { x: 0, y: PLATEAU_Y + 1.2, z: 1.2 }, { x: 0, y: 0, z: -12 }, { state: "live", ownerId: "a", team: 0 });
    const hit = b.of("hit", b.run(3));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ targetType: "player", targetId: "b", throwerId: "a", damage: 0 });
    expect(Math.hypot(hit[0]!.knockback.x, hit[0]!.knockback.z)).toBeGreaterThan(0);
    expect(target.hp).toBe(100);
    expect(target.stats.hits).toBe(0);
  });

  it("projectile hits on monsters make events and credit the thrower", () => {
    const b = new Bench([["a"]]);
    b.place("a", 8, 8, 0);
    b.clockTicks = null;
    const crab = b.monster("m1", "crab", 0, 3);
    b.world.spawnProjectile("stone", { x: 0, y: PLATEAU_Y + 0.4, z: 4.2 }, { x: 0, y: 0, z: -12 }, { state: "live", ownerId: "a", team: 0 });
    const hits = b.of("hit", b.run(4));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ targetType: "monster", targetId: crab.id, damage: 1, throwerId: "a" });
    expect(b.p("a").stats.hits).toBe(1);
    expect(b.p("a").score).toBeGreaterThanOrEqual(MVP_POINTS.hit);
  });

  it("a spear the monster system sticks stays at the monster's spot as a pickup", () => {
    const b = new Bench([["a"]]);
    b.place("a", 8, 8, 0);
    b.clockTicks = null;
    b.monster("m1", "crab", 0, 3);
    const spy = vi.spyOn(b.world.monsters, "hitByProjectile").mockReturnValue("stick");
    const spear = b.world.spawnProjectile("spear", { x: 0, y: PLATEAU_Y + 0.4, z: 4.2 }, { x: 0, y: 0, z: -12 }, { state: "live", ownerId: "a", team: 0 })!;
    const evs = b.run(4);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(b.of("stick", evs)).toHaveLength(1);
    expect(spear.state).toBe("stuck");
    expect(spear.z).toBeCloseTo(3, 5);
  });

  it("a thrown puffer explodes on contact (blast, monsters.blast)", () => {
    const b = new Bench([["a"], ["b"]]);
    b.place("a", 10, 10, 0);
    const near = b.place("b", 0, 1, 0);
    b.clockTicks = null;
    const spy = vi.spyOn(b.world.monsters, "blast");
    b.world.spawnProjectile("puffer", { x: 0, y: PLATEAU_Y + 3, z: 0 }, { x: 0, y: -2, z: 0 }, { state: "live", ownerId: "a", team: 0 });
    const blasts = b.of("blast", b.run(30));
    expect(blasts).toHaveLength(1);
    expect(blasts[0]).toMatchObject({ byId: "a", inHand: false });
    expect(blasts[0]!.players).toContain("b");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(near.hp).toBe(100);
    expect(b.state.projectiles.size).toBe(0);
  });

  it("wood thrown into the lit campfire burns as fuel", () => {
    const b = new Bench([["a"]]);
    b.place("a", 6, 14, 0);
    const site = b.island.sites[0]!;
    const team = b.state.teams[0]!;
    team.fireFuel = 600;
    b.clockTicks = null;
    b.world.spawnProjectile("wood", { x: site.campfire.x, y: PLATEAU_Y + 2, z: site.campfire.z }, { x: 0, y: 0, z: 0 }, { state: "loose", ownerId: "a" });
    const fuel = b.of("fireFuel", b.run(30));
    expect(fuel).toHaveLength(1);
    expect(fuel[0]).toMatchObject({ source: "throw", playerId: "a", added: FIRE_WOOD_FUEL_TICKS });
    expect(team.fireFuel).toBe(600 + FIRE_WOOD_FUEL_TICKS);
    expect(b.state.projectiles.size).toBe(0);
  });

  it("a raw fish coming to rest becomes bait", () => {
    const b = new Bench([["a"]]);
    b.clockTicks = null;
    const bait = vi.spyOn(b.world.monsters, "onBait");
    const fish = b.world.spawnProjectile("fish_raw", { x: 0, y: PLATEAU_Y + 1, z: 0 }, { x: 0, y: 0, z: 0 }, { state: "loose" })!;
    b.run(40);
    expect(fish.state).toBe("rest");
    expect(bait).toHaveBeenCalledTimes(1);
    expect(fish.baitTicks).toBeGreaterThan(0);
  });
});

describe("RaftWorld: eating", () => {
  it("F eats the active item: bars, heal, stats", () => {
    const b = new Bench([["a"]]);
    const p = b.place("a", 0, 0, 0);
    b.give("a", "coconut", 2);
    Object.assign(p, { hunger: 50, thirst: 60, hp: 70 });
    b.send("a", { buttons: BTN.EAT });
    const eat = b.of("eat", b.tick());
    expect(eat[0]).toMatchObject({ kind: "coconut", hunger: 20, thirst: 20 });
    expect(p.hunger).toBeGreaterThanOrEqual(69);
    expect(p.thirst).toBeGreaterThanOrEqual(79);
    expect(p.hp).toBeGreaterThanOrEqual(79);
    expect(countOf(p, "coconut")).toBe(1);
    expect(p.stats.eaten).toBe(1);
    expect(p.stats.coconuts).toBe(1);
  });

  it("the golden fish lights the nameplate and pays MVP points; the chef gets +5 from cooked food", () => {
    const b = new Bench([["a"], ["chef", "sef"]]);
    const a = b.place("a", 0, 0, 0);
    const chef = b.place("chef", 3, 0, 0);
    b.give("a", "fish_golden", 1);
    b.give("chef", "fish_cooked", 1);
    a.hunger = 10;
    chef.hunger = 10;
    b.send("a", { buttons: BTN.EAT });
    b.send("chef", { buttons: BTN.EAT });
    const eat = b.of("eat", b.tick());
    expect(a.golden).toBe(true);
    expect(a.score).toBe(MVP_POINTS.golden);
    expect(eat.find((e) => e.playerId === "chef")!.hunger).toBe(45 + 5);
  });

  it("an empty hand can't eat", () => {
    const b = new Bench([["a"]]);
    b.place("a", 0, 0, 0);
    b.send("a", { buttons: BTN.EAT });
    expect(b.of("reject", b.tick())[0]).toMatchObject({ action: "eat", reason: "empty" });
  });
});

describe("RaftWorld: crafting & the camp chest", () => {
  it("takes the exact counts from the inventory first, then the chest", () => {
    const b = new Bench([["a"]]);
    atCamp(b, "a");
    const team = b.state.teams[0]!;
    team.chest.clear();
    team.chest.set("stone", 2);
    b.give("a", "wood", 3);
    expect(b.world.craft("a", "spear")).toBe(true);
    const evs = b.world.drainEvents();
    expect(countOf(b.p("a"), "wood")).toBe(2);
    expect(countOf(b.p("a"), "spear")).toBe(1);
    expect(team.chest.get("stone")).toBe(1);
    expect(b.of("chestChanged", evs)[0]).toMatchObject({ op: "take", items: [{ kind: "stone", count: 1 }] });
    expect(b.of("crafted", evs)[0]).toMatchObject({ recipe: "spear", item: "spear", dropped: false });
    expect(b.p("a").stats.crafted).toBe(1);
  });

  it("rejects missing ingredients, a dead fire, distance and locked recipes", () => {
    const b = new Bench([["a"]]);
    atCamp(b, "a");
    const team = b.state.teams[0]!;
    team.chest.clear();
    b.give("a", "wood", 1);
    const reasons = (): string[] => b.of("reject", b.world.drainEvents()).map((r) => r.reason);
    expect(b.world.craft("a", "axe")).toBe(false);
    expect(reasons()).toEqual(["missing"]);
    expect(countOf(b.p("a"), "wood")).toBe(1);
    expect(b.world.craft("a", "coconut_ball")).toBe(false);
    expect(reasons()).toEqual(["locked"]);
    expect(b.world.craft("a", "hut")).toBe(false);
    expect(reasons()).toEqual(["locked"]);
    team.fireFuel = 0;
    expect(b.world.craft("a", "torch")).toBe(false);
    expect(reasons()).toEqual(["fireOut"]);
    b.place("a", 0, -10, 0);
    expect(b.world.craft("a", "fuel")).toBe(false);
    expect(reasons()).toEqual(["tooFar"]);
  });

  it("feeding the fire works when it is out (relit) and refuses a full fire", () => {
    const b = new Bench([["a"]]);
    atCamp(b, "a");
    const team = b.state.teams[0]!;
    team.fireFuel = 0;
    b.give("a", "wood", 3);
    expect(b.world.craft("a", "fuel")).toBe(true);
    expect(b.of("fireFuel", b.world.drainEvents())[0]).toMatchObject({ source: "relit", added: FIRE_WOOD_FUEL_TICKS });
    expect(team.fireFuel).toBe(FIRE_WOOD_FUEL_TICKS);
    team.fireFuel = FIRE_FUEL_MAX_TICKS;
    expect(b.world.craft("a", "fuel")).toBe(false);
    expect(countOf(b.p("a"), "wood")).toBe(2);
  });

  it("a crafted item that doesn't fit drops at the feet; cooking the kraken feeds the team", () => {
    const b = new Bench([["a"], ["b"]]);
    atCamp(b, "a");
    b.place("b", -10, -10, 0);
    for (let s = 1; s < 4; s++) b.give("a", "stone", 3, s);
    b.give("a", "wood", 2, 0);
    expect(b.world.craft("a", "fence")).toBe(true);
    expect(b.of("crafted", b.world.drainEvents())[0]!.dropped).toBe(false);
    b.give("a", "kraken", 1, 0);
    b.p("b").hunger = 20;
    expect(b.world.craft("a", "cook_kraken")).toBe(true);
    const evs = b.world.drainEvents();
    expect(b.of("eat", evs).map((e) => e.playerId).sort()).toEqual(["a", "b"]);
    expect(b.p("b").hunger).toBeGreaterThanOrEqual(49);
    b.state.teams[0]!.benchTier = 1;
    b.give("a", "log", 1, 0);
    expect(b.world.craft("a", "raft_part")).toBe(true);
    // the log consumed → slot 0 freed → the 3 planks fit there.
    expect(b.of("crafted", b.world.drainEvents())[0]!.dropped).toBe(false);
    expect(countOf(b.p("a"), "raft_part")).toBe(3);
    for (let s = 0; s < 4; s++) b.give("a", "stone", 3, s);
    b.state.teams[0]!.chest.set("wood", 1);
    b.state.teams[0]!.chest.set("rope", 1);
    expect(b.world.craft("a", "torch")).toBe(true);
    expect(b.of("crafted", b.world.drainEvents())[0]!.dropped).toBe(true);
    expect([...b.state.projectiles.values()].some((p) => p.kind === "torch" && p.state === "rest")).toBe(true);
  });

  it("chest put / take / putAll move exact stacks", () => {
    const b = new Bench([["a"]]);
    const site = b.island.sites[0]!;
    b.place("a", site.chest.x, site.chest.z + 1.4, 0);
    const team = b.state.teams[0]!;
    team.chest.clear();
    b.give("a", "wood", 4, 0);
    b.give("a", "spear", 1, 1);
    b.give("a", "coconut", 2, 2);
    expect(b.world.chest("a", { op: "put", count: 3 })).toBe(true);
    expect(team.chest.get("wood")).toBe(3);
    expect(slotCount(b.p("a"), 0)).toBe(1);
    expect(b.world.chest("a", { op: "putAll" })).toBe(true);
    expect(team.chest.get("wood")).toBe(4);
    expect(team.chest.get("coconut")).toBe(2);
    expect(slotKind(b.p("a"), 1)).toBe("spear");
    expect(b.world.chest("a", { op: "take", kind: "wood", count: 2 })).toBe(true);
    expect(countOf(b.p("a"), "wood")).toBe(2);
    expect(team.chest.get("wood")).toBe(2);
    expect(b.world.chest("a", { op: "take", kind: "rope" })).toBe(false);
    const evs = b.world.drainEvents();
    expect(b.of("chestChanged", evs).map((e) => e.op)).toEqual(["put", "put", "take"]);
    expect(b.of("reject", evs)[0]).toMatchObject({ action: "chest", reason: "empty" });
    b.place("a", 0, -12, 0);
    expect(b.world.chest("a", { op: "putAll" })).toBe(false);
    expect(b.of("reject", b.world.drainEvents())[0]!.reason).toBe("tooFar");
  });

  it("chest put takes the named pocket (`slot`), else the active one; a bad slot or a changed pocket moves nothing", () => {
    const b = new Bench([["a"]]);
    const site = b.island.sites[0]!;
    b.place("a", site.chest.x, site.chest.z + 1.4, 0);
    const team = b.state.teams[0]!;
    team.chest.clear();
    const a = b.p("a");
    b.give("a", "axe", 1, 0);
    b.give("a", "wood", 4, 2);
    b.give("a", "stone", 3, 3);
    a.activeSlot = 0;
    // A pocket that isn't held: exact, the held axe stays (and stays held).
    expect(b.world.chest("a", { op: "put", slot: 2, kind: "wood", count: 1 })).toBe(true);
    expect(team.chest.get("wood")).toBe(1);
    expect(slotCount(a, 2)).toBe(3);
    expect(b.world.chest("a", { op: "put", slot: 2 })).toBe(true);
    expect(team.chest.get("wood")).toBe(4);
    expect(slotKind(a, 2)).toBe("");
    expect([a.activeSlot, slotKind(a, 0)]).toEqual([0, "axe"]);
    // No slot: the active one, as before (its `kind` isn't checked there).
    a.activeSlot = 3;
    expect(b.world.chest("a", { op: "put", kind: "rope", count: 2 })).toBe(true);
    expect(team.chest.get("stone")).toBe(2);
    expect(slotCount(a, 3)).toBe(1);
    let evs = b.world.drainEvents();
    expect(b.of("chestChanged", evs).map((e) => e.items)).toEqual([[{ kind: "wood", count: 1 }], [{ kind: "wood", count: 3 }], [{ kind: "stone", count: 2 }]]);
    expect(b.of("reject", evs)).toEqual([]);
    // The named pocket holds something else by now, or is empty: refused as "empty" (drained one by one: identical
    // rejects of one tick coalesce).
    expect(b.world.chest("a", { op: "put", slot: 3, kind: "wood" })).toBe(false);
    evs = b.world.drainEvents();
    expect(b.world.chest("a", { op: "put", slot: 1 })).toBe(false);
    evs = [...evs, ...b.world.drainEvents()];
    expect(b.of("reject", evs).map((e) => [e.action, e.reason])).toEqual([["chest", "empty"], ["chest", "empty"]]);
    // Out of range / not an integer: ignored without a reject.
    for (const slot of [-1, 4, 1.5, Number.NaN]) expect(b.world.chest("a", { op: "put", slot })).toBe(false);
    expect(b.world.drainEvents()).toEqual([]);
    expect([slotCount(a, 0), slotCount(a, 3), team.chest.get("stone")]).toEqual([1, 1, 2]);
    // Alive, phase and range rules apply as for any put.
    a.downed = true;
    expect(b.world.chest("a", { op: "put", slot: 3 })).toBe(false);
    expect(b.of("reject", b.world.drainEvents())[0]!.reason).toBe("dead");
    a.downed = false;
    b.state.phase = "launch";
    expect(b.world.chest("a", { op: "put", slot: 3 })).toBe(false);
    b.state.phase = "playing";
    b.place("a", 0, -12, 0);
    expect(b.world.chest("a", { op: "put", slot: 3 })).toBe(false);
    expect(b.of("reject", b.world.drainEvents())[0]!.reason).toBe("tooFar");
    expect(slotCount(a, 3)).toBe(1);
  });

  it("monkeys steal from the chest and give back", () => {
    const b = new Bench([["a"]]);
    const team = b.state.teams[0]!;
    team.chest.clear();
    team.chest.set("rope", 1);
    expect(b.world.stealFromChest(0)).toBe("rope");
    expect(team.chest.has("rope")).toBe(false);
    expect(b.world.stealFromChest(0)).toBe(null);
    b.world.returnToChest(0, "rope", 1);
    expect(team.chest.get("rope")).toBe(1);
    expect(b.of("chestChanged", b.world.drainEvents()).map((e) => e.op)).toEqual(["steal", "return"]);
  });
});

describe("RaftWorld: crafting tiers", () => {
  it("bench recipes need the workbench / anvil; the anvil waits for day 3; a bench is built once", () => {
    const b = new Bench([["a"]]);
    atCamp(b, "a");
    const team = b.state.teams[0]!;
    team.chest.clear();
    const reasons = (): string[] => b.of("reject", b.world.drainEvents()).map((r) => r.reason);
    b.give("a", "log", 1, 0);
    expect(b.world.craft("a", "raft_part")).toBe(false);
    expect(reasons()).toEqual(["needBench"]);
    for (const [k, n] of [["wood", 6], ["rope", 2], ["stone", 2]] as const) team.chest.set(k, n);
    expect(b.world.craft("a", "bench_1")).toBe(true);
    expect(team.benchTier).toBe(1);
    expect(b.p("a").score).toBe(MVP_POINTS.craftProcessed);
    for (const [k, n] of [["wood", 6], ["rope", 2], ["stone", 2]] as const) team.chest.set(k, n);
    expect(b.world.craft("a", "bench_1")).toBe(false);
    expect(reasons()).toEqual(["built"]);
    expect(b.world.craft("a", "raft_part")).toBe(true);
    for (const [k, n] of [["raft_part", 3], ["stone", 4], ["scrap", 2]] as const) team.chest.set(k, n);
    expect(b.world.craft("a", "bench_2")).toBe(false);
    expect(reasons()).toEqual(["tooEarly"]);
    b.setClock(3, "day");
    b.tick();
    expect(b.world.craft("a", "bench_2")).toBe(true);
    expect(team.benchTier).toBe(2);
    b.give("a", "scrap", 1, 1);
    b.give("a", "stone", 1, 2);
    b.give("a", "", 0, 3);
    expect(b.world.craft("a", "nails")).toBe(true);
    expect(countOf(b.p("a"), "nails")).toBe(3);
  });

  it("the chef cooks two from one raw fish", () => {
    const b = new Bench([["sef", "sef"], ["b"]]);
    atCamp(b, "sef");
    b.give("sef", "fish_raw", 1);
    expect(b.world.craft("sef", "cook_fish")).toBe(true);
    expect(countOf(b.p("sef"), "fish_cooked")).toBe(2);
    atCamp(b, "b");
    b.give("b", "fish_raw", 1);
    expect(b.world.craft("b", "cook_fish")).toBe(true);
    expect(countOf(b.p("b"), "fish_cooked")).toBe(1);
  });
});

describe("RaftWorld: the raft", () => {
  it("delivery fills the current stage from the pockets; surplus stays; nothing before the stage's day", () => {
    const b = new Bench([["a"], ["b"]]); // 2 seats: keel 2 logs + 3 rope
    atRaft(b, "a");
    b.give("a", "log", 1, 0);
    b.give("a", "rope", 5, 1);
    b.give("a", "raft_part", 2, 2);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    const d = b.of("deliver", b.tick());
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ stage: 0, newStage: 0, materialsDone: false, items: [{ kind: "log", count: 1 }, { kind: "rope", count: 3 }] });
    const team = b.state.teams[0]!;
    expect([...team.raftHave]).toEqual([1, 3, 0]);
    expect(countOf(b.p("a"), "rope")).toBe(2);
    expect(countOf(b.p("a"), "raft_part")).toBe(2); // the deck's, not the keel's
    expect(b.p("a").stats.delivered).toBe(4);
    expect(b.p("a").score).toBe(MVP_POINTS.deliver * 4 + MVP_POINTS.heavy);
    // The deck is day 2: planks are refused on day 1 even once the keel is assembled.
    b.world.raft.setStage(0, 1);
    b.run(3, () => b.send("a"));
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("reject", b.tick())[0]).toMatchObject({ action: "deliver", reason: "stageLocked" });
    expect(countOf(b.p("a"), "raft_part")).toBe(2);
    b.setClock(2, "day");
    b.run(3, () => b.send("a"));
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("deliver", b.tick())[0]).toMatchObject({ stage: 1, items: [{ kind: "raft_part", count: 2 }, { kind: "rope", count: 2 }] });
  });

  it("a heavy delivery pays the escort walking beside the carrier", () => {
    const b = new Bench([["a"], ["b"]]);
    atRaft(b, "a");
    atRaft(b, "b", 1.5);
    b.give("a", "log", 1);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    b.tick();
    expect(b.p("b").score).toBe(MVP_POINTS.escort);
  });

  it("says why when there is nothing the stage needs", () => {
    const b = new Bench([["a"], ["b"]]);
    atRaft(b, "a");
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("reject", b.tick())[0]).toMatchObject({ reason: "nothingToDeliver", interact: "deliver" });
    b.run(3, () => b.send("a"));
    b.give("a", "cloth", 1);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("reject", b.tick())[0]).toMatchObject({ reason: "wrongStage" });
  });

  it("assembly: hold E once the materials are in; a hammer works twice as fast; progress is kept", () => {
    const b = new Bench([["a"], ["b"]]);
    atRaft(b, "a");
    b.give("a", "log", 2, 0);
    b.give("a", "rope", 3, 1);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("deliver", b.tick())[0]!.materialsDone).toBe(true);
    b.run(3, () => b.send("a"));
    const team = b.state.teams[0]!;
    const need = raftAssemblyTicks(0);
    // Bare hands: half speed.
    assemble(b, "a", 61);
    expect(b.p("a").channel).toBe(3);
    expect(team.raftWork).toBeGreaterThanOrEqual(29);
    expect(team.raftWork).toBeLessThanOrEqual(31);
    b.run(3, () => b.send("a")); // let go: the work stays
    expect(team.raftWork).toBeGreaterThanOrEqual(29);
    b.give("a", "hammer", 1, 2);
    const evs = assemble(b, "a", need);
    const done = b.of("raftStage", evs);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ stage: 0, newStage: 1, lost: false, playerIds: ["a"] });
    expect(team.stage).toBe(1);
    expect(team.raftHp).toBe(RAFT_HP_MAX);
    expect([...team.raftHave]).toEqual([0, 0, 0]);
    expect(team.raftWork).toBe(0);
    expect(b.p("a").channel).toBe(0);
    expect(b.p("a").score).toBeGreaterThan(MVP_POINTS.deliver * 5);
  });

  it("the mast needs two people holding E at once", () => {
    const b = new Bench([["a"], ["b"]]);
    b.world.raft.setStage(0, 2);
    b.setClock(3, "day");
    const team = b.state.teams[0]!;
    const prog = b.world.raft as unknown as { progress: Map<number, { have: number[] }[]> };
    prog.progress.get(0)![2]!.have = [...team.raftNeed];
    b.world.raft.sync(team);
    atRaft(b, "a", -0.8);
    atRaft(b, "b", 0.8);
    b.give("a", "hammer", 1);
    b.give("b", "hammer", 1);
    assemble(b, "a", 60);
    expect(team.raftWork).toBe(0);
    expect(b.p("a").channel).toBe(3); // holding, but alone
    b.run(30, () => {
      b.send("a", { buttons: BTN.INTERACT });
      b.send("b", { buttons: BTN.INTERACT | (b.p("b").channel === 0 ? BTN.INTERACT_PRESS : 0) });
    });
    expect(team.raftWork).toBeGreaterThan(50); // 2 × 1.0 × 1.2 per tick
  });

  it("raft hp: a hammer repairs; at 0 the raft is wrecked but keeps its assembled stages", () => {
    const b = new Bench([["a"], ["b"]]);
    b.world.raft.setStage(0, 2, 30);
    b.setClock(3, "day");
    const team = b.state.teams[0]!;
    atRaft(b, "a");
    b.give("a", "hammer", 1, 0);
    b.give("a", "raft_part", 1, 1);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("raftRepair", b.tick())[0]).toMatchObject({ kind: "raft_part", added: RAFT_REPAIR_PLANK_HP, hp: 30 + RAFT_REPAIR_PLANK_HP });
    expect(b.p("a").score).toBe(MVP_POINTS.repair);
    b.world.damageRaft(0, 49, "m7", { x: 0, y: 0, z: 0 });
    expect(team.raftHp).toBe(1);
    b.world.damageRaft(0, 4, "m7", { x: 0, y: 0, z: 0 });
    const evs = b.world.drainEvents();
    expect(b.of("raftStage", evs)).toHaveLength(0);
    expect(b.of("raftDamage", evs).at(-1)).toMatchObject({ amount: 1, hp: 0 });
    expect(team.stage).toBe(2);
    // A wrecked raft takes no more damage until it is repaired.
    b.world.damageRaft(0, 4, "m7", { x: 0, y: 0, z: 0 });
    expect(b.of("raftDamage", b.world.drainEvents())).toHaveLength(0);
    // Before the keel nothing can be gnawed.
    b.world.raft.setStage(0, 0);
    b.world.damageRaft(0, 10, "m7", { x: 0, y: 0, z: 0 });
    expect(b.of("raftDamage", b.world.drainEvents())).toHaveLength(0);
  });

  it("the finished raft can't be boarded before the launch day, nor with a weak hull", () => {
    const b = new Bench([["a"], ["b"]]);
    b.world.raft.setStage(0, RAFT_LAUNCH_STAGE);
    b.setClock(DIFFICULTIES.normal.launchDay - 1, "night", b.timings.night - 3);
    atRaft(b, "a");
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("reject", b.tick())[0]).toMatchObject({ action: "board", reason: "seaRough" });
    expect(b.p("a").boarded).toBe(false);
    b.setClock(DIFFICULTIES.normal.launchDay, "day");
    b.state.teams[0]!.raftHp = 49;
    b.run(3, () => b.send("a"));
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("reject", b.tick())[0]).toMatchObject({ action: "board", reason: "raftWeak" });
    b.state.teams[0]!.raftHp = 50;
    b.run(3, () => b.send("a"));
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    b.tick();
    expect(b.p("a").boarded).toBe(true);
  });

  it("push-off: the first aboard starts it; everyone aboard leaves only after the minimum", () => {
    const b = new Bench([["a"], ["b"]]);
    readyRaft(b);
    b.world.drainEvents();
    atRaft(b, "a", -0.6);
    atRaft(b, "b", 0.6);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    const first = b.tick();
    expect(b.of("board", first)[0]).toMatchObject({ playerId: "a", launchTicksLeft: LAUNCH_WAIT_TICKS });
    expect(b.p("a").score).toBe(MVP_POINTS.firstAboard);
    expect(b.state.launchTicksLeft).toBe(LAUNCH_WAIT_TICKS - 1);
    b.run(5, () => b.send("b"));
    b.send("b", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("launchRequest", b.tick())).toHaveLength(0); // everyone aboard, but not 30 s yet
    expect(b.p("b").boarded).toBe(true);
    // (The launch wave is another test's business: keep the beach empty here.)
    const evs = b.run(LAUNCH_MIN_TICKS, () => b.state.monsters.clear());
    const req = b.of("launchRequest", evs);
    expect(req).toHaveLength(1);
    expect(req[0]!.tick - first[0]!.tick).toBe(LAUNCH_MIN_TICKS - 1); // the boarding tick already counted one
    expect(req[0]!.aboard.sort()).toEqual(["a", "b"]);
    expect([req[0]!.left, req[0]!.leftBehind]).toEqual([[], []]);
    expect(b.p("b").score).toBe(0);
    expect(b.of("launchRequest", b.run(5))).toHaveLength(0); // only once
  });

  it("the push-off brings the launch wave: 0.6 × the last night's crabs, 3 puffers and Captain Crab", () => {
    const b = new Bench([["a"], ["b"]]);
    readyRaft(b);
    atRaft(b, "a");
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    const evs = [...b.tick(), ...b.run(Math.floor(LAUNCH_WAIT_TICKS / 2) + 5)];
    const kinds = b.of("monsterSpawn", evs).map((e) => e.kind);
    const plan = planLaunchWave({ seats: b.state.teams[0]!.seats, difficulty: DIFFICULTIES.normal, biome: BIOMES[b.island.biome], lastNight: b.timings.days });
    expect(kinds.filter((k) => k === "boss")).toHaveLength(1);
    expect(kinds.filter((k) => k === "puffer")).toHaveLength(3);
    expect(kinds.filter((k) => k === "crab")).toHaveLength(plan.crabs);
  });

  it("the push-off leaves the latecomers behind; a broken raft aborts it", () => {
    const b = new Bench([["a"], ["b"]], { fast: true });
    readyRaft(b);
    atRaft(b, "a");
    b.place("b", 0, 0, 0);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    b.tick();
    const req = b.of("launchRequest", b.run(b.timings.launchWait + 1));
    expect(req).toHaveLength(1);
    expect(req[0]).toMatchObject({ aboard: ["a"], left: ["b"], leftBehind: ["b"] });

    const c = new Bench([["a"], ["b"]]);
    readyRaft(c);
    atRaft(c, "a");
    c.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    c.tick();
    expect(c.state.launchTicksLeft).toBeGreaterThan(0);
    c.world.damageRaft(0, 200, "m7", { x: 0, y: 0, z: 0 });
    expect(c.p("a").boarded).toBe(false);
    expect(c.state.launchTicksLeft).toBe(0);
    expect(c.state.teams[0]!.stage).toBe(RAFT_LAUNCH_STAGE - 1);
    expect(c.of("launchRequest", c.run(LAUNCH_WAIT_TICKS + 5))).toHaveLength(0);
  });

  it("regression: a solo player with every stage built still can't sail before the launch day", () => {
    const b = new Bench([["a"], ["b"]]);
    b.world.raft.setStage(0, RAFT_LAUNCH_STAGE);
    atRaft(b, "a");
    for (let day = 1; day < DIFFICULTIES.normal.launchDay; day++) {
      b.setClock(day, "day", 30);
      b.run(3, () => b.send("a"));
      b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
      b.tick();
      expect(b.p("a").boarded, `day ${day}`).toBe(false);
    }
    expect(b.of("launchRequest")).toHaveLength(0);
  });

  it("a raft that isn't finished can't be boarded", () => {
    const b = new Bench([["a"], ["b"]]);
    b.give("a", "wood", 1);
    expect(b.world.raft.board(b.p("a"))).toBe(false);
    expect(b.of("reject", b.world.drainEvents())[0]).toMatchObject({ action: "board", reason: "notReady" });
  });
});

describe("RaftWorld: the camp economy", () => {
  it("spring charges run out and refill", () => {
    const b = new Bench([["a"]]);
    const spring = b.island.sites[0]!.spring;
    b.placeFacing("a", spring.x, spring.z, 1.5, 0);
    const team = b.state.teams[0]!;
    team.springCharges = 1;
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("pickup", b.tick())[0]).toMatchObject({ kind: "water", source: "spring" });
    expect(team.springCharges).toBe(0);
    b.run(2, () => b.send("a"));
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("reject", b.tick())[0]).toMatchObject({ reason: "springDry" });
    b.run(SPRING_RECHARGE_TICKS);
    expect(team.springCharges).toBe(1);
  });

  it("the wreck yields scrap to a hammer, one per 3 s, and more at dawn", () => {
    const b = new Bench([["a", "gelin"]]);
    const w = b.island.sites[0]!.wreck;
    b.placeFacing("a", w.x, w.z, 0, 2);
    const team = b.state.teams[0]!;
    team.wreckScrap = 2;
    b.hold("a", BTN.INTERACT, 10, BTN.INTERACT_PRESS);
    expect(b.p("a").channel).toBe(0); // no hammer
    b.run(2, () => b.send("a"));
    b.give("a", "hammer", 1, 0);
    b.hold("a", BTN.INTERACT, secToTicks(GATHER_SEC.salvage) * 2 + 3, BTN.INTERACT_PRESS);
    expect(countOf(b.p("a"), "scrap")).toBe(2);
    expect(team.wreckScrap).toBe(0);
    expect(b.p("a").score).toBe(2 * MVP_POINTS.salvage);
    b.setClock(2, "day");
    b.tick();
    expect(team.wreckScrap).toBe(1);
  });

  it("the old sail puts sailcloth into the chest", () => {
    const b = new Bench([["a"]]);
    const team = b.state.teams[0]!;
    team.chest.clear();
    b.world.applyTreasure(b.p("a"), "old_sail");
    expect(team.chest.get("cloth")).toBe(2);
  });

  it("a compass is never lost: washed ashore with it, it goes back to the chest", () => {
    const b = new Bench([["a"], ["b"]]);
    const team = b.state.teams[0]!;
    team.chest.clear();
    b.give("b", "compass", 1);
    b.world.damagePlayer(b.p("b"), 200, "crab", "m1");
    b.run(DOWNED_TICKS + 1);
    expect(b.p("b").washed).toBe(true);
    expect(team.chest.get("compass")).toBe(1);
  });
});

describe("RaftWorld: downed, revive, wash, respawn", () => {
  it("hp 0 downs a player; a teammate holding E for 3 s revives them at half hp", () => {
    const b = new Bench([["a"], ["b"]]);
    const down = b.place("b", 0, 0, 0);
    b.placeFacing("a", 0, 0, 0, 1.2);
    b.world.damagePlayer(down, 120, "crab", "m1");
    const evs = b.world.drainEvents();
    expect(b.of("playerHurt", evs)[0]).toMatchObject({ playerId: "b", cause: "crab", hp: 0 });
    expect(b.of("playerDowned", evs)).toHaveLength(1);
    expect(down.downed).toBe(true);
    expect(down.downedTicks).toBe(DOWNED_TICKS);
    expect(down.stats.downs).toBe(1);
    // Downed players take no more damage.
    b.world.damagePlayer(down, 10, "crab", "m1");
    expect(b.of("playerHurt", b.world.drainEvents())).toHaveLength(0);
    const rev = b.of("playerRevived", b.hold("a", BTN.INTERACT, REVIVE_TICKS + 1, BTN.INTERACT_PRESS));
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ playerId: "b", byId: "a" });
    expect(down.downed).toBe(false);
    expect(down.hp).toBe(REVIVE_HP);
    expect(b.p("a").stats.revives).toBe(1);
    expect(b.p("a").score).toBe(MVP_POINTS.revive);
  });

  it("the timer running out washes the player ashore; the next dawn brings them back at the wreck", () => {
    const b = new Bench([["a"], ["b"]]);
    const p = b.place("b", 0, 0, 0);
    b.give("b", "wood", 4);
    b.world.damagePlayer(p, 200, "puffer", "m2");
    const evs = b.run(DOWNED_TICKS);
    const washed = b.of("playerWashed", evs);
    expect(washed).toHaveLength(1);
    expect(washed[0]).toMatchObject({ playerId: "b", willRespawn: true });
    expect([p.alive, p.washed, p.downed]).toEqual([false, true, false]);
    expect(countOf(p, "wood")).toBe(0);
    expect(b.of("teamWiped", evs)).toHaveLength(0);
    // Washed players are not stepped and ignore input.
    b.send("b", { moveZ: 1 });
    b.tick();
    expect(p.alive).toBe(false);
    b.setClock(2, "day");
    const dawn = b.tick();
    expect(b.of("playerRespawn", dawn)[0]).toMatchObject({ playerId: "b" });
    const spawn = b.island.sites[0]!.spawns[p.seat]!;
    expect([p.alive, p.washed]).toEqual([true, false]);
    expect([p.x, p.z]).toEqual([spawn.x, spawn.z]);
    expect(p.hp).toBe(RESPAWN_HP);
    expect([p.hunger, p.thirst, p.warmth].every((v) => Math.abs(v - RESPAWN_BARS) <= 1)).toBe(true);
  });

  it("Long Tide T4: a team wipe on day 2 is a loss; the washed only come back while a teammate lives", () => {
    const b = new Bench([["a"], ["b"]]);
    b.setClock(2, "night");
    b.tick();
    expect(DOWNED_TICKS).toBe(25 * SEC);
    b.world.damagePlayer(b.p("a"), 200, "crab", "m1");
    b.run(DOWNED_TICKS + 1);
    expect(b.p("a").washed).toBe(true);
    b.world.damagePlayer(b.p("b"), 200, "crab", "m1");
    const evs = b.run(DOWNED_TICKS + 1);
    expect(b.of("playerWashed", evs)[0]).toMatchObject({ playerId: "b", willRespawn: false });
    expect(b.of("teamWiped", evs)).toEqual([expect.objectContaining({ type: "teamWiped", team: 0 })]);
    b.setClock(3, "day");
    expect(b.of("playerRespawn", b.tick())).toHaveLength(0);
    expect([b.p("a").alive, b.p("b").alive]).toEqual([false, false]);
  });

  it("a downed player's compass goes straight back to the team chest", () => {
    const b = new Bench([["a"], ["b"]]);
    const p = b.place("a", 0, 0, 0);
    b.give("a", "compass", 1, 1);
    b.world.damagePlayer(p, 200, "boss", "m1");
    expect(countOf(p, "compass")).toBe(0);
    expect(b.state.teams[0]!.chest.get("compass")).toBe(1);
  });

  it("on the last day nobody comes back: everyone washed is a team wipe", () => {
    const b = new Bench([["a"]]);
    b.setClock(b.timings.days, "day");
    b.tick();
    b.world.damagePlayer(b.p("a"), 200, "crab", "m1");
    const evs = b.run(DOWNED_TICKS + 1);
    expect(b.of("playerWashed", evs)[0]!.willRespawn).toBe(false);
    expect(b.of("teamWiped", evs)).toEqual([expect.objectContaining({ type: "teamWiped", team: 0 })]);
  });
});

describe("RaftWorld: heavy cargo (Long Tide T1)", () => {
  it("loadMult is 55 alone and 85 with an escort within 3 m; character kits change it", () => {
    const b = new Bench([["a"], ["b"], ["kid", "cocuk"], ["amca", "amca"]]);
    const a = b.place("a", -10, -10, 0);
    b.place("b", 10, 10, 0);
    b.place("kid", -10, 10, 0);
    b.place("amca", 10, -10, 0);
    b.give("a", "log", 1, 1);
    b.give("kid", "barrel", 1);
    b.give("amca", "log", 1);
    b.tick();
    expect([a.loadMult, b.p("kid").loadMult, b.p("amca").loadMult, b.p("b").loadMult]).toEqual([HEAVY_CARRY_ALONE, 75, 70, 100]);
    b.place("b", -10 + ESCORT_RADIUS - 0.5, -10, 0);
    b.place("kid", 10, -10 + 2, 0);
    b.tick();
    expect([a.loadMult, b.p("kid").loadMult, b.p("amca").loadMult]).toEqual([HEAVY_CARRY_ESCORT, 95, HEAVY_CARRY_ESCORT]);
    // A downed teammate escorts nobody.
    b.world.damagePlayer(b.p("b"), 200, "crab", "m1");
    b.tick();
    expect(a.loadMult).toBe(HEAVY_CARRY_ALONE);
  });

  it("loaded: slower, no sprint, no throw; the drop key sets the cargo down; one heavy item at a time", () => {
    const b = new Bench([["a"], ["b"]]);
    const free = b.place("b", 8, -12, 0);
    const a = b.place("a", -8, -12, 0);
    b.give("a", "log", 1, 1);
    b.give("a", "stone", 2, 0);
    b.run(SEC, () => {
      b.send("a", { moveZ: -1, buttons: BTN.SPRINT });
      b.send("b", { moveZ: -1, buttons: BTN.SPRINT });
    });
    expect(a.sprinting).toBe(false);
    expect(free.sprinting).toBe(true);
    const speed = (p: PlayerState) => Math.hypot(p.vx, p.vz);
    expect(speed(a)).toBeLessThan(speed(free) * 0.5);
    // No throw while loaded (the stone stays in hand).
    b.run(10, () => b.send("a", { buttons: BTN.THROW }));
    b.send("a");
    b.tick();
    expect(countOf(a, "stone")).toBe(2);
    // A second log is too heavy.
    b.world.spawnProjectile("log", { x: a.x + 0.3, y: a.y + 0.35, z: a.z }, { x: 0, y: 0, z: 0 }, { state: "rest" });
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("reject", b.tick())).toEqual([expect.objectContaining({ reason: "tooHeavy", interact: "pickup" })]);
    expect(countOf(a, "log")).toBe(1);
    // The drop key (whatever slot is active) puts the log down at the feet.
    b.run(12, () => b.send("a"));
    b.send("a", { buttons: BTN.DROP });
    b.tick();
    expect(countOf(a, "log")).toBe(0);
    expect(countOf(a, "stone")).toBe(2);
    expect([...b.state.projectiles.values()].filter((pr) => pr.kind === "log" && pr.state === "rest")).toHaveLength(2);
    b.tick();
    expect(a.loadMult).toBe(100);
  });
});

describe("RaftWorld: survival bars", () => {
  it("drain rates empty a full bar in the documented time per difficulty", () => {
    for (const [id, mult] of [["vacation", 0.7], ["normal", 1], ["nightmare", 1.3]] as const) {
      const diff = DIFFICULTIES[id];
      expect(secondsToEmpty(hungerDrainPerTick(diff, 1, false))).toBeCloseTo(500 / mult, 6);
      expect(secondsToEmpty(thirstDrainPerTick(diff, 1, false, false))).toBeCloseTo(375 / mult, 6);
    }
    const normal = DIFFICULTIES.normal;
    expect(secondsToEmpty(hungerDrainPerTick(normal, 1, true))).toBeCloseTo(500 / 1.5, 6);
    expect(secondsToEmpty(thirstDrainPerTick(normal, 1, true, false))).toBeCloseTo(375 / 2, 6);
    expect(secondsToEmpty(thirstDrainPerTick(normal, 1, true, true))).toBeCloseTo(375, 6);
    expect(secondsToEmpty(hungerDrainPerTick(normal, 20, false))).toBeCloseTo(25, 6);
    const cold = { nearFire: false, nightChill: true, rainChill: false, waterChill: false, litTorch: false, daylight: false };
    expect(100 / -warmthPerSec(cold)).toBe(50);
    expect(warmthPerSec({ ...cold, nightChillMult: 0.5 })).toBe(-1); // volcanic ground
    expect(warmthPerSec({ ...cold, nightChillMult: 0.5, rainChill: true })).toBe(-2); // rain chills in full
    expect(warmthPerSec({ ...cold, litTorch: true })).toBe(-1);
    expect(warmthPerSec({ ...cold, nearFire: true })).toBe(5);
    expect(warmthPerSec({ ...cold, nightChill: false })).toBe(0);
  });

  it("hunger empties in 500 s of play on normal, then costs 3 hp a second", () => {
    const b = new Bench([["a"]]);
    const p = b.place("a", -12, -12, 0);
    let ticks = 0;
    while (p.hunger > 0 && ticks < 20000) {
      if (ticks % 300 === 0) p.thirst = 100;
      b.tick();
      ticks++;
    }
    expect(Math.abs(ticks - 500 * SEC)).toBeLessThanOrEqual(2);
    expect(p.hp).toBe(100);
    p.thirst = 100;
    b.run(SEC * 2);
    expect(p.hp).toBeLessThanOrEqual(100 - 3);
    expect(p.hp).toBeGreaterThanOrEqual(100 - 2 * 3);
    expect(b.of("playerHurt").some((e) => e.cause === "hunger")).toBe(true);
    expect(b.of("lowBar").some((e) => e.bar === "hunger")).toBe(true);
  });

  it("thirst empties faster on nightmare and the bars don't drain without a clock", () => {
    const b = new Bench([["a"]], { difficulty: "nightmare" });
    const p = b.place("a", -12, -12, 0);
    b.clockTicks = null;
    b.run(300);
    expect([p.hunger, p.thirst]).toEqual([100, 100]);
    b.clockTicks = 10;
    let ticks = 0;
    while (p.thirst > 0 && ticks < 20000) {
      if (ticks % 300 === 0) p.hunger = 100;
      b.tick();
      ticks++;
    }
    expect(Math.abs(ticks - (375 * SEC) / 1.3)).toBeLessThanOrEqual(2);
  });

  it("warmth: the night chills, a lit torch halves it, the fire warms and heals", () => {
    const b = new Bench([["a"], ["b"], ["c"]]);
    b.state.teams[0]!.flare = true; // no monsters tonight
    b.state.teams[0]!.fireFuel = FIRE_FUEL_MAX_TICKS;
    b.setClock(1, "night");
    const cold = b.place("a", -12, -12, 0);
    const torch = b.place("b", 12, -12, 0);
    b.give("b", "torch", 1);
    const camp = atCamp(b, "c");
    camp.warmth = 50;
    camp.hp = 50;
    b.run(10 * SEC);
    expect(Math.abs(cold.warmth - 80)).toBeLessThanOrEqual(1);
    expect(Math.abs(torch.warmth - 90)).toBeLessThanOrEqual(1);
    expect(camp.warmth).toBeGreaterThanOrEqual(99);
    expect(Math.abs(camp.hp - 60)).toBeLessThanOrEqual(1); // FIRE_HEAL_PER_SEC 1
    expect(torch.torchTicks).toBe(TORCH_BURN_TICKS - 10 * SEC);
  });

  it("rain chills outside the cave and makes the fire burn twice as fast", () => {
    const b = new Bench([["a"], ["b"]]);
    b.tick();
    b.state.weather = "rain";
    const team = b.state.teams[0]!;
    team.fireFuel = 300;
    const wet = b.place("a", -12, -12, 0);
    const cave = b.island.sites[0]!.cave!;
    const dry = b.place("b", cave.x, cave.z, 0);
    // By day the fire burns at half rate; the rain doubles it back to one fuel tick per tick.
    expect(RAIN_FIRE_DRAIN_MULT * FIRE_DAY_BURN_MULT).toBe(1);
    const evs = b.run(300);
    expect(team.fireFuel).toBe(0);
    expect(b.of("fireFuel", evs)[0]).toMatchObject({ source: "out", fuel: 0 });
    expect(wet.warmth).toBeLessThan(95);
    expect(dry.warmth).toBe(100);
    expect(b.world.lights().some((l) => l.kind === "fire")).toBe(false);
  });

  it("the campfire burns at half rate by day and full rate at night; its ring shrinks and stops repelling below 20 %", () => {
    const b = new Bench([["a"]]);
    b.place("a", -12, -12, 0);
    const team = b.state.teams[0]!;
    team.fireFuel = FIRE_START_FUEL_TICKS;
    const before = b.run(2 * FIRE_START_FUEL_TICKS - 2);
    expect(b.of("fireFuel", before)).toHaveLength(0);
    expect(team.fireFuel).toBe(1);
    const out = b.run(2);
    expect(team.fireFuel).toBe(0);
    expect(b.of("fireFuel", out)).toHaveLength(1);

    const n = new Bench([["a"]]);
    n.state.teams[0]!.flare = true;
    n.setClock(1, "night");
    n.place("a", -12, -12, 0);
    const t = n.state.teams[0]!;
    t.fireFuel = FIRE_FUEL_MAX_TICKS;
    n.run(SEC);
    expect(t.fireFuel).toBe(FIRE_FUEL_MAX_TICKS - SEC);
    const ring = (): number => n.world.lights().find((l) => l.kind === "fire")?.r ?? 0;
    expect(ring()).toBeCloseTo(fireLightRadius(t.fireFuel), 2);
    expect(ring()).toBeGreaterThan(5.9);
    t.fireFuel = Math.ceil(FIRE_REPEL_MIN_FRACTION * FIRE_FUEL_MAX_TICKS) + 2;
    n.world.lightsChanged();
    expect(ring()).toBeCloseTo(FIRE_LIGHT_RADIUS_MIN, 0);
    n.run(5);
    expect(n.world.lights().some((l) => l.kind === "fire")).toBe(false); // below 20 %: no ring for the monsters
    expect(fireLightRadius(0)).toBe(0);
    expect(fireRepels(t.fireFuel)).toBe(false);
  });

  it("the fire only heals the fed and watered", () => {
    const b = new Bench([["a"], ["b"]]);
    b.state.teams[0]!.fireFuel = FIRE_FUEL_MAX_TICKS;
    const fed = atCamp(b, "a");
    const starving = b.place("b", b.island.sites[0]!.campfire.x + 1.5, b.island.sites[0]!.campfire.z, 0);
    fed.hp = 50;
    starving.hp = 50;
    b.run(5 * SEC, () => {
      starving.hunger = 0;
    });
    expect(fed.hp).toBeGreaterThanOrEqual(54);
    expect(starving.hp).toBeLessThan(50);
  });

  it("a jellyfish in hand stings, a puffer in hand blows up after its fuse", () => {
    const b = new Bench([["a"], ["b"]]);
    const jelly = b.place("a", -12, -12, 0);
    b.give("a", "jellyfish", 1);
    b.run(3 * SEC);
    expect(jelly.hp).toBe(100 - 3 * JELLYFISH_DAMAGE_PER_SEC);
    expect(b.of("playerHurt").every((e) => e.cause === "jellyfish")).toBe(true);

    const puff = b.place("b", 12, -12, 0);
    b.give("b", "puffer", 1, 2);
    expect(puff.fuseTicks).toBe(PUFFER_FUSE_TICKS);
    const evs = b.run(PUFFER_FUSE_TICKS);
    const blast = b.of("blast", evs);
    expect(blast).toHaveLength(1);
    expect(blast[0]).toMatchObject({ byId: "b", inHand: true });
    expect(puff.hp).toBe(100 - PUFFER_SELF_DAMAGE);
    expect(countOf(puff, "puffer")).toBe(0);
    expect(puff.fuseTicks).toBe(0);
  });

  it("deep water chills (not the floatie kid) and drowns after 20 s", () => {
    const b = new Bench([["a"], ["kid", "cocuk"]]);
    const swimmer = b.place("a", -3, -37, 0);
    const kid = b.place("kid", 3, -37, 0);
    b.run(SEC);
    expect(swimmer.swimming).toBe(true);
    expect(kid.swimming).toBe(true);
    b.run(DROWN_TICKS - SEC + 2 * SEC);
    expect(swimmer.warmth).toBeLessThan(65);
    expect(kid.warmth).toBe(100);
    const drown = b.of("playerHurt").filter((e) => e.cause === "drown");
    expect(drown.length).toBeGreaterThanOrEqual(2);
    expect(drown.every((e) => e.amount === DROWN_DAMAGE_PER_SEC)).toBe(true);
  });

  it("a held torch burns out and leaves the hand", () => {
    const b = new Bench([["a"]]);
    const p = b.place("a", -12, -12, 0);
    b.give("a", "torch", 1);
    p.torchTicks = 5;
    expect(b.world.lights().some((l) => l.kind === "torch")).toBe(true);
    b.run(5);
    expect(countOf(p, "torch")).toBe(0);
    expect(b.world.lights().some((l) => l.kind === "torch")).toBe(false);
  });
});

describe("RaftWorld: structures & sites", () => {
  it("places a fence in front with a snapped yaw and makes it collide", () => {
    const b = new Bench([["a"]]);
    const p = b.place("a", -10, 0, 0.5);
    b.give("a", "fence", 1);
    b.send("a", { buttons: BTN.USE_PRESS });
    const placed = b.of("structurePlaced", b.tick());
    expect(placed).toHaveLength(1);
    const s = b.state.structures.get(placed[0]!.id)!;
    expect(s.kind).toBe("fence");
    expect(s.yaw).toBe(snapYaw8(p.yaw));
    expect(s.hp).toBe(FENCE_HP);
    expect(countOf(p, "fence")).toBe(0);
    const hits: CoverCircle[] = [];
    expect(b.world.cover.query(s.x, s.z, 0.2, hits)).toBeGreaterThan(0);
    expect(hits.some((c) => c.kind === "fence")).toBe(true);
  });

  it("refuses to place into deep water", () => {
    const b = new Bench([["a"]]);
    b.place("a", 0, -33.5, 0);
    b.give("a", "collector", 1);
    b.send("a", { buttons: BTN.USE_PRESS });
    expect(b.of("reject", b.tick())[0]).toMatchObject({ action: "place", reason: "noRoom" });
    expect(countOf(b.p("a"), "collector")).toBe(1);
  });

  it("a kraken thrashes every second for 10 s, then goes", () => {
    const b = new Bench([["a"]]);
    b.place("a", -10, 0, 0);
    b.give("a", "kraken", 1);
    const slam = vi.spyOn(b.world.monsters, "blast");
    b.send("a", { buttons: BTN.USE_PRESS });
    b.tick();
    const evs = b.run(KRAKEN_TICKS + 5);
    expect(slam).toHaveBeenCalledTimes(KRAKEN_TICKS / KRAKEN_HIT_INTERVAL_TICKS);
    expect(b.of("structureDestroyed", evs)[0]).toMatchObject({ kind: "kraken", byId: "" });
  });

  it("a torch swing scares crabs", () => {
    const b = new Bench([["a"]]);
    b.place("a", -10, 0, 0);
    b.give("a", "torch", 1);
    const scare = vi.spyOn(b.world.monsters, "scare");
    b.send("a", { buttons: BTN.USE_PRESS });
    expect(b.of("use", b.tick())[0]).toMatchObject({ what: "torchSwing" });
    expect(scare).toHaveBeenCalledTimes(1);
  });

  it("the spring fills a gourd, or quenches when the pockets are full", () => {
    const b = new Bench([["a"]]);
    const spring = b.island.sites[0]!.spring;
    const p = b.placeFacing("a", spring.x, spring.z, 1.5, 0);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("pickup", b.tick())[0]).toMatchObject({ kind: "water", source: "spring" });
    b.run(2, () => b.send("a"));
    for (let s = 0; s < 4; s++) b.give("a", "stone", 3, s);
    p.thirst = 30;
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("eat", b.tick())[0]).toMatchObject({ kind: "spring", thirst: SPRING_WATER });
  });

  it("collectors fill in the rain and give a drink", () => {
    const b = new Bench([["a"]]);
    b.tick();
    b.state.weather = "rain";
    const p = b.place("a", -10, 0, 0);
    b.give("a", "collector", 1);
    b.send("a", { buttons: BTN.USE_PRESS });
    const id = b.of("structurePlaced", b.tick())[0]!.id;
    const s = b.state.structures.get(id)!;
    expect(s.uses).toBe(0);
    b.run(COLLECTOR_FILL_TICKS);
    expect(s.uses).toBe(1);
    b.placeFacing("a", s.x, s.z, 0, 1.5);
    p.thirst = 20;
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("eat", b.tick())[0]).toMatchObject({ kind: "collector" });
    expect(s.uses).toBe(0);
  });

  it("the secret chest (once revealed) spins two treasure reels", () => {
    const b = new Bench([["a"]]);
    const reel = vi.spyOn(b.world.fishing, "treasureReel");
    const sc = b.island.sites[0]!.secretChest;
    b.placeFacing("a", sc.x, sc.z, 0, 1.5);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    b.tick();
    expect(reel).not.toHaveBeenCalled();
    b.world.applyBottle(b.p("a"));
    b.run(2, () => b.send("a"));
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    b.tick();
    expect(reel).toHaveBeenCalledTimes(2);
    expect(b.state.teams[0]!.secretOpened).toBe(true);
  });
});

describe("RaftWorld: treasures & bottles", () => {
  it("applies every treasure to the finder's team", () => {
    const b = new Bench([["a"]]);
    const p = b.p("a");
    const team = b.state.teams[0]!;
    team.fireFuel = 100;
    b.world.applyTreasure(p, "flare");
    b.world.applyTreasure(p, "pirate_hat");
    b.world.applyTreasure(p, "spyglass");
    b.world.applyTreasure(p, "fuel_can");
    expect(team.flare).toBe(true);
    expect(p.cosmetic).toBe("pirate_hat");
    expect(p.score).toBe(PIRATE_HAT_SCORE);
    expect(team.spyglassTicks).toBe(SPYGLASS_TICKS);
    expect(team.fireFuel).toBe(100 + FUEL_CAN_TICKS);
    b.run(10);
    expect(team.spyglassTicks).toBe(SPYGLASS_TICKS - 10);
  });

  it("bottles reveal the secret chest, then the spring, then the coconut-ball recipe", () => {
    const b = new Bench([["a"]]);
    for (let i = 0; i < 3; i++) b.world.applyBottle(b.p("a"));
    expect(b.of("bottle", b.world.drainEvents()).map((e) => e.effect)).toEqual(["secretChest", "spring", "recipe"]);
    const team = b.state.teams[0]!;
    expect([team.secretRevealed, team.springRevealed, team.ballRecipe]).toEqual([true, true, true]);
  });
});

describe("RaftWorld: context helpers", () => {
  it("giveItem fills the inventory and drops the rest", () => {
    const b = new Bench([["a"]]);
    const p = b.place("a", 0, 0, 0);
    for (let s = 1; s < 4; s++) b.give("a", "rope", 5, s);
    expect(b.world.giveItem(p, "stone", 5, "treasure")).toBe(3);
    const evs = b.world.drainEvents();
    expect(b.of("pickup", evs)[0]).toMatchObject({ kind: "stone", count: 3, source: "treasure" });
    expect([...b.state.projectiles.values()].filter((x) => x.kind === "stone")).toHaveLength(2);
  });

  it("the projectile cap evicts the oldest resting item", () => {
    const b = new Bench([["a"]]);
    const first = b.world.spawnProjectile("stone", { x: 1, y: 2, z: 1 }, { x: 0, y: 0, z: 0 }, { state: "rest" })!;
    b.state.tick++;
    for (let i = 0; i < 60; i++) b.world.spawnProjectile("stone", { x: 1, y: 2, z: 1 + i * 0.1 }, { x: 0, y: 0, z: 0 }, { state: "rest" });
    expect(b.state.projectiles.size).toBe(48);
    expect(b.state.projectiles.has(first.id)).toBe(false);
  });

  it("knockback stuns and interrupts a channel; boarded players are immune", () => {
    const b = new Bench([["a"]]);
    const p = b.place("a", 0, 0, 0);
    p.channel = 1;
    b.world.knockPlayer(p, { x: 3, y: 2, z: 0 });
    expect([p.vx, p.vy, p.stunTicks, p.channel]).toEqual([3, 2, secToTicks(0.3), 0]);
    p.boarded = true;
    b.world.knockPlayer(p, { x: 9, y: 9, z: 9 });
    expect(p.vx).toBe(3);
  });
});
