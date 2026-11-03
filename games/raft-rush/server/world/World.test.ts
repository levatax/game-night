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
  DIFFICULTIES,
  DOWNED_TICKS,
  DROWN_DAMAGE_PER_SEC,
  DROWN_TICKS,
  FENCE_HP,
  FIRE_FUEL_MAX_TICKS,
  FIRE_START_FUEL_TICKS,
  FIRE_WOOD_FUEL_TICKS,
  FUEL_CAN_TICKS,
  GATHER_SEC,
  JELLYFISH_DAMAGE_PER_SEC,
  KRAKEN_HIT_INTERVAL_TICKS,
  KRAKEN_TICKS,
  LAUNCH_WAIT_TICKS,
  MVP_POINTS,
  PALM_REGROW_TICKS,
  PIRATE_HAT_SCORE,
  PUFFER_FUSE_TICKS,
  PUFFER_SELF_DAMAGE,
  RAFT_PART_WOOD,
  RAIN_FIRE_DRAIN_MULT,
  RESPAWN_BARS,
  RESPAWN_HP,
  REVIVE_HP,
  REVIVE_TICKS,
  SPRING_WATER,
  SPYGLASS_TICKS,
  TORCH_BURN_TICKS,
  WRECK_HULL_WOOD,
  secToTicks,
} from "../../shared/constants.js";
import { raftCost } from "../../shared/items.js";
import { BTN } from "../../shared/protocol.js";
import { countOf, slotCount, slotKind } from "../../shared/rules/inventory.js";
import { snapYaw8, type CoverCircle } from "../../shared/sim/cover.js";
import { computeThrowVelocities } from "../../shared/sim/throw.js";
import { RaftState, PlayerState } from "../schema.js";
import { hungerDrainPerTick, secondsToEmpty, thirstDrainPerTick, warmthPerSec } from "./rules.js";
import { Bench, benchIsland, NODE, PLATEAU_Y } from "./testkit.js";
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

function readyRaft(b: Bench): void {
  const team = b.state.teams[0]!;
  const cost = raftCost(team.seats, b.timings.cheapRaft);
  Object.assign(team, { hullWood: cost.hullWood, mastWood: cost.mastWood, mastRope: cost.mastRope, food: cost.food, water: cost.water });
  b.world.raft.refreshStage(0);
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
    expect(team.hullWood).toBe(WRECK_HULL_WOOD);
    expect(team.stage).toBe(0);
    expect(team.fireFuel).toBe(FIRE_START_FUEL_TICKS);
    expect(team.chest.size).toBe(2);
    expect(state.nodes[NODE.tree]).toBe(3);
  });

  it("never lets the wreck finish a one-wood test raft by itself", () => {
    const b = new Bench([["a"]], { fast: true });
    expect(b.state.teams[0]!.hullWood).toBe(0);
    expect(b.state.teams[0]!.stage).toBe(0);
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
  it("a hold-E channel yields one wood per 2.5 s, decrements the node and fills a slot", () => {
    const b = new Bench([["a"]]);
    const tree = b.island.nodes[NODE.tree]!;
    b.placeFacing("a", tree.x, tree.z, 0, 1.5);
    const unit = secToTicks(GATHER_SEC.wood);
    const first = b.hold("a", BTN.INTERACT, unit + 1, BTN.INTERACT_PRESS);
    const g = b.of("gather", first);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ playerId: "a", node: NODE.tree, kind: "wood", count: 1, depleted: false, dropped: false, eaten: false });
    expect(b.state.nodes[NODE.tree]).toBe(2);
    expect(countOf(b.p("a"), "wood")).toBe(1);
    expect(b.p("a").stats.gathered).toBe(1);
    expect(b.p("a").score).toBe(MVP_POINTS.gather);
    // Keep holding: the channel restarts on the same tree until it is empty.
    b.hold("a", BTN.INTERACT, unit * 2);
    expect(b.state.nodes[NODE.tree]).toBe(0);
    expect(countOf(b.p("a"), "wood")).toBe(3);
    expect(b.of("gather").at(-1)!.depleted).toBe(true);
    expect(b.p("a").channel).toBe(0);
  });

  it("an axe anywhere in the inventory makes wood take 1 s", () => {
    const b = new Bench([["a"]]);
    const tree = b.island.nodes[NODE.tree]!;
    b.placeFacing("a", tree.x, tree.z, 0, 1.5);
    b.give("a", "axe", 1, 3);
    b.hold("a", BTN.INTERACT, secToTicks(GATHER_SEC.woodAxe) + 1, BTN.INTERACT_PRESS);
    expect(countOf(b.p("a"), "wood")).toBe(1);
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
    expect(eat[0]).toMatchObject({ kind: "coconut", hunger: 25, thirst: 25 });
    expect(p.hunger).toBeGreaterThanOrEqual(74);
    expect(p.thirst).toBeGreaterThanOrEqual(84);
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
    b.give("a", "wood", 3, 0);
    expect(b.world.craft("a", "raft_part")).toBe(true);
    // wood (3) consumed → slot 0 freed → the part fits there.
    expect(b.of("crafted", b.world.drainEvents())[0]!.dropped).toBe(false);
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

describe("RaftWorld: the raft", () => {
  it("delivery fills the current stage exactly, surplus moves on only when the next stage is current", () => {
    const b = new Bench([["a"], ["b"]]); // 2 seats: hull 10 (wreck 3), mast 4 + 4, provisions 2 + 2
    atRaft(b, "a");
    b.give("a", "raft_part", 1, 0);
    b.give("a", "wood", 5, 1);
    b.give("a", "fish_cooked", 1, 2);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    const evs = b.tick();
    const d = b.of("deliver", evs);
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ stage: 0, newStage: 1, items: [{ kind: "raft_part", count: 1 }, { kind: "wood", count: 4 }] });
    expect(d[1]).toMatchObject({ stage: 1, newStage: 1, items: [{ kind: "wood", count: 1 }] });
    const team = b.state.teams[0]!;
    expect([team.hullWood, team.mastWood, team.stage]).toEqual([10, 1, 1]);
    expect(countOf(b.p("a"), "fish_cooked")).toBe(1); // not needed yet: stays with you
    expect(b.p("a").stats.delivered).toBe(RAFT_PART_WOOD + 4 + 1);
    expect(b.p("a").score).toBe(MVP_POINTS.deliver * (RAFT_PART_WOOD + 5));
    b.run(3, () => b.send("a"));
    b.give("a", "wood", 3, 0);
    b.give("a", "rope", 5, 1);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    b.tick();
    expect([team.mastWood, team.mastRope, team.stage]).toEqual([4, 4, 2]);
    expect(countOf(b.p("a"), "rope")).toBe(1);
    b.run(3, () => b.send("a"));
    b.give("a", "coconut", 1, 0);
    b.give("a", "water", 2, 1);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    const last = b.tick();
    expect([team.food, team.water, team.stage]).toEqual([2, 2, 3]);
    expect(b.of("raftReady", last)).toHaveLength(1);
  });

  it("the captain's raft parts count one extra wood", () => {
    const b = new Bench([["cap", "kaptan"], ["b"]]);
    atRaft(b, "cap");
    b.give("cap", "raft_part", 1);
    b.send("cap", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    b.tick();
    expect(b.state.teams[0]!.hullWood).toBe(WRECK_HULL_WOOD + RAFT_PART_WOOD + 1);
  });

  it("says why when there is nothing the stage needs", () => {
    const b = new Bench([["a"], ["b"]]);
    atRaft(b, "a");
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("reject", b.tick())[0]).toMatchObject({ reason: "nothingToDeliver", interact: "deliver" });
    b.run(3, () => b.send("a"));
    b.give("a", "water", 1);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expect(b.of("reject", b.tick())[0]).toMatchObject({ reason: "wrongStage" });
  });

  it("bots never deliver objective goods on a team with a human; a bot-only team builds alone", () => {
    // Human + 2 bots: the bots stand at the raft with stage goods and are refused.
    const b = new Bench([["h1"], ["bot-2"], ["bot-3"]]);
    b.p("bot-2").bot = true;
    b.p("bot-3").bot = true;
    atRaft(b, "bot-2", -0.6);
    atRaft(b, "bot-3", 0.6);
    b.give("bot-2", "raft_part", 1);
    b.give("bot-3", "wood", 4);
    b.world.drainEvents();
    b.send("bot-2", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    const botEvs = b.tick();
    expect(b.of("deliver", botEvs)).toHaveLength(0);
    expect(b.p("bot-2").stats.delivered).toBe(0);
    expect(countOf(b.p("bot-2"), "raft_part")).toBe(1); // the goods stay in the bot's pockets
    expect(b.of("reject", botEvs)[0]).toMatchObject({ playerId: "bot-2", action: "deliver", reason: "botDelivers" });

    // The human's own press still loads the raft.
    atRaft(b, "h1");
    b.give("h1", "raft_part", 1);
    b.send("h1", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    const loaded = b.tick();
    expect(b.of("deliver", loaded)).toHaveLength(1);
    expect(b.p("h1").stats.delivered).toBe(RAFT_PART_WOOD);

    // Bot-only team: no human to build it, so the bots deliver.
    const solo = new Bench([["bot-4"], ["bot-5"]]);
    solo.p("bot-4").bot = true;
    solo.p("bot-5").bot = true;
    atRaft(solo, "bot-4");
    solo.give("bot-4", "raft_part", 1);
    solo.world.drainEvents();
    solo.send("bot-4", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    const soloEvs = solo.tick();
    expect(solo.of("deliver", soloEvs)).toHaveLength(1);
    expect(solo.p("bot-4").stats.delivered).toBe(RAFT_PART_WOOD);
    expect(solo.state.teams[0]!.hullWood).toBe(WRECK_HULL_WOOD + RAFT_PART_WOOD);
  });

  it("the old sail completes the mast as soon as the hull is done", () => {
    const b = new Bench([["a"], ["b"]]);
    b.world.applyTreasure(b.p("a"), "old_sail");
    const team = b.state.teams[0]!;
    expect(team.sail).toBe(true);
    atRaft(b, "a");
    b.give("a", "wood", 5, 0);
    b.give("a", "wood", 2, 1);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    b.tick();
    expect(team.stage).toBe(2);
    expect(team.sail).toBe(false);
    const cost = raftCost(2);
    expect([team.mastWood, team.mastRope]).toEqual([cost.mastWood, cost.mastRope]);
  });

  it("gnawing lowers the hull and drops a finished raft back to the hull stage", () => {
    const b = new Bench([["a"], ["b"]]);
    readyRaft(b);
    b.setClock(3, "night");
    const team = b.state.teams[0]!;
    atRaft(b, "a");
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    b.tick();
    expect(b.p("a").boarded).toBe(true);
    b.world.damageRaft(0, 1, "m7", { x: 0, y: 0, z: 0 });
    const dmg = b.of("raftDamage", b.world.drainEvents());
    expect(dmg[0]).toMatchObject({ amount: 1, byMonsterId: "m7", hullWood: raftCost(2).hullWood - 1 });
    expect(team.stage).toBe(0);
    expect(b.p("a").boarded).toBe(false);
    expect(b.state.launchTicksLeft).toBe(0);
    b.world.damageRaft(0, 100, "m7", { x: 0, y: 0, z: 0 });
    expect(team.hullWood).toBe(0);
  });

  it("boarding: the first aboard starts the countdown, the last one requests the launch", () => {
    const b = new Bench([["a"], ["b"]]);
    readyRaft(b);
    b.setClock(3, "night");
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
    const last = b.tick();
    expect(b.of("board", last)[0]).toMatchObject({ playerId: "b", launchTicksLeft: 0 });
    const req = b.of("launchRequest", last);
    expect(req).toHaveLength(1);
    expect(req[0]!.aboard.sort()).toEqual(["a", "b"]);
    expect(req[0]!.left).toEqual([]);
    expect(b.p("b").score).toBe(0);
    // Only once.
    expect(b.of("launchRequest", b.run(5))).toHaveLength(0);
  });

  it("the countdown leaves the latecomers on the beach; downed players don't hold the raft", () => {
    const b = new Bench([["a"], ["b"]], { fast: true });
    readyRaft(b);
    b.setClock(3, "night");
    atRaft(b, "a");
    b.place("b", 0, 0, 0);
    b.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    b.tick();
    const evs = b.run(b.timings.launchWait + 1);
    const req = b.of("launchRequest", evs);
    expect(req).toHaveLength(1);
    expect(req[0]).toMatchObject({ aboard: ["a"], left: ["b"] });

    const c = new Bench([["a"], ["b"]]);
    readyRaft(c);
    c.setClock(3, "night");
    atRaft(c, "a");
    c.place("b", 0, 0, 0);
    c.world.damagePlayer(c.p("b"), 500, "crab", "m1");
    c.send("a", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    const now = c.tick();
    expect(c.of("launchRequest", now)[0]).toMatchObject({ aboard: ["a"], left: ["b"] });
  });

  it("bots never start the departure: an idle human plus two bots never launches", () => {
    const b = new Bench([["h1"], ["bot-2"], ["bot-3"]], { fast: true });
    b.p("bot-2").bot = true;
    b.p("bot-3").bot = true;
    readyRaft(b);
    b.setClock(3, "night");
    // The human stays idle at the camp; the bots walk to the raft and take their seats.
    b.place("h1", 0, 0, 0);
    atRaft(b, "bot-2", -0.6);
    atRaft(b, "bot-3", 0.6);
    b.world.drainEvents();
    b.send("bot-2", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    b.tick();
    b.send("bot-3", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    b.tick();
    expect(b.p("bot-2").boarded).toBe(true);
    expect(b.p("bot-3").boarded).toBe(true);
    // Bots aboard do not start the countdown, and the launch never fires while no human is aboard.
    expect(b.state.launchTicksLeft).toBe(0);
    const idle = b.run(b.timings.launchWait + 60);
    expect(b.of("launchRequest", idle)).toHaveLength(0);
    expect(b.state.phase).toBe("playing");
    // A human boarding still starts the departure: the rule is about who may begin it, not about the crew.
    atRaft(b, "h1");
    b.send("h1", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    const human = b.tick();
    expect(b.p("h1").boarded).toBe(true);
    expect(b.of("launchRequest", human)).toHaveLength(1);
  });

  it("a raft that isn't ready can't be boarded", () => {
    const b = new Bench([["a"], ["b"]]);
    b.give("a", "wood", 1);
    expect(b.world.raft.board(b.p("a"))).toBe(false);
    expect(b.of("reject", b.world.drainEvents())[0]).toMatchObject({ action: "board", reason: "notReady" });
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

  it("on day 3 nobody comes back: everyone washed is a team wipe", () => {
    const b = new Bench([["a"]]);
    b.setClock(3, "day");
    b.tick();
    b.world.damagePlayer(b.p("a"), 200, "crab", "m1");
    const evs = b.run(DOWNED_TICKS + 1);
    expect(b.of("playerWashed", evs)[0]!.willRespawn).toBe(false);
    expect(b.of("teamWiped", evs)).toEqual([expect.objectContaining({ type: "teamWiped", team: 0 })]);
  });
});

describe("RaftWorld: survival bars", () => {
  it("drain rates empty a full bar in the documented time per difficulty", () => {
    for (const [id, mult] of [["vacation", 0.7], ["normal", 1], ["nightmare", 1.3]] as const) {
      const diff = DIFFICULTIES[id];
      expect(secondsToEmpty(hungerDrainPerTick(diff, 1, false))).toBeCloseTo(240 / mult, 6);
      expect(secondsToEmpty(thirstDrainPerTick(diff, 1, false, false))).toBeCloseTo((100 / 33) * 60 / mult, 6);
    }
    const normal = DIFFICULTIES.normal;
    expect(secondsToEmpty(hungerDrainPerTick(normal, 1, true))).toBeCloseTo(160, 6);
    expect(secondsToEmpty(thirstDrainPerTick(normal, 1, true, false))).toBeCloseTo((100 / 66) * 60, 6);
    expect(secondsToEmpty(thirstDrainPerTick(normal, 1, true, true))).toBeCloseTo((100 / 33) * 60, 6);
    expect(secondsToEmpty(hungerDrainPerTick(normal, 20, false))).toBeCloseTo(12, 6);
    const cold = { nearFire: false, nightChill: true, rainChill: false, waterChill: false, litTorch: false, daylight: false };
    expect(100 / -warmthPerSec(cold)).toBe(50);
    expect(warmthPerSec({ ...cold, litTorch: true })).toBe(-1);
    expect(warmthPerSec({ ...cold, nearFire: true })).toBe(5);
    expect(warmthPerSec({ ...cold, nightChill: false })).toBe(0);
  });

  it("hunger empties in 4 minutes of play on normal, then costs hp", () => {
    const b = new Bench([["a"]]);
    const p = b.place("a", -12, -12, 0);
    let ticks = 0;
    while (p.hunger > 0 && ticks < 9000) {
      if (ticks % 300 === 0) p.thirst = 100;
      b.tick();
      ticks++;
    }
    expect(Math.abs(ticks - 240 * SEC)).toBeLessThanOrEqual(2);
    expect(p.hp).toBe(100);
    p.thirst = 100;
    b.run(SEC * 2);
    expect(p.hp).toBeLessThanOrEqual(98);
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
    while (p.thirst > 0 && ticks < 9000) {
      if (ticks % 300 === 0) p.hunger = 100;
      b.tick();
      ticks++;
    }
    expect(Math.abs(ticks - ((100 / 33) * 60 * SEC) / 1.3)).toBeLessThanOrEqual(2);
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
    expect(Math.abs(camp.hp - 80)).toBeLessThanOrEqual(1);
    expect(torch.torchTicks).toBe(TORCH_BURN_TICKS - 10 * SEC);
  });

  it("rain chills outside the cave and makes the fire burn three times faster", () => {
    const b = new Bench([["a"], ["b"]]);
    b.tick();
    b.state.weather = "rain";
    const team = b.state.teams[0]!;
    team.fireFuel = 300;
    const wet = b.place("a", -12, -12, 0);
    const cave = b.island.sites[0]!.cave!;
    const dry = b.place("b", cave.x, cave.z, 0);
    const evs = b.run(100);
    expect(team.fireFuel).toBe(0);
    expect(b.of("fireFuel", evs)[0]).toMatchObject({ source: "out", fuel: 0 });
    expect(300 / RAIN_FIRE_DRAIN_MULT).toBe(100);
    expect(wet.warmth).toBeLessThan(95);
    expect(dry.warmth).toBe(100);
    expect(b.world.lights().some((l) => l.kind === "fire")).toBe(false);
  });

  it("the campfire burns out after 60 s, always", () => {
    const b = new Bench([["a"]]);
    b.place("a", -12, -12, 0);
    const team = b.state.teams[0]!;
    team.fireFuel = FIRE_START_FUEL_TICKS;
    const before = b.run(FIRE_START_FUEL_TICKS - 1);
    expect(b.of("fireFuel", before)).toHaveLength(0);
    expect(team.fireFuel).toBe(1);
    const out = b.tick();
    expect(team.fireFuel).toBe(0);
    expect(b.of("fireFuel", out)).toHaveLength(1);
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
