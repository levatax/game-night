// shared/rules/interact.ts: resolveInteraction priorities / reaches / cones and the raft delivery helpers.
// Owner: server-world (the resolver is shared by the server, the client prompt and the bots).

import { describe, expect, it } from "vitest";
import { CHANNEL, GATHER_SEC, REVIVE_TICKS, secToTicks } from "../../shared/constants.js";
import { raftCost } from "../../shared/items.js";
import {
  channelTicksFor,
  emptyInteraction,
  gatherTicksFor,
  gatherYield,
  INTERACT_PRIORITY,
  planRaftDelivery,
  planWood,
  raftPartValue,
  raftRemaining,
  raftStageFor,
  resolveInteraction,
  type InteractWorld,
} from "../../shared/rules/interact.js";
import { setSlot } from "../../shared/rules/inventory.js";
import { MonsterState, ProjectileEntity, StructureState, type PlayerState } from "../schema.js";
import { Bench, NODE } from "./testkit.js";

function world(b: Bench): InteractWorld {
  return { island: b.island, state: b.state };
}

function itemAt(b: Bench, id: string, kind: ProjectileEntity["kind"], x: number, z: number): ProjectileEntity {
  const p = new ProjectileEntity();
  Object.assign(p, { id, kind, x, y: 1.2, z, state: "rest", radius: 0.2 });
  b.state.projectiles.set(id, p);
  return p;
}

function resolve(b: Bench, p: PlayerState) {
  return resolveInteraction(world(b), p);
}

describe("resolveInteraction", () => {
  it("gathers what you look at: wood 2.5 s, 1 s with an axe; stone; rope; berries", () => {
    const b = new Bench([["a"]]);
    const tree = b.island.nodes[NODE.tree]!;
    const p = b.placeFacing("a", tree.x, tree.z, 0, 1.5);
    const it = resolve(b, p)!;
    expect(it).toMatchObject({ kind: "gather", hold: true, channel: CHANNEL.GATHER, node: NODE.tree, item: "wood", ok: true });
    expect(it.ticks).toBe(secToTicks(GATHER_SEC.wood));
    b.give("a", "axe", 1, 2);
    expect(resolve(b, p)!.ticks).toBe(secToTicks(GATHER_SEC.woodAxe));
    const rock = b.island.nodes[NODE.rock]!;
    b.placeFacing("a", rock.x, rock.z, 0, -1.6);
    expect(resolve(b, p)).toMatchObject({ kind: "gather", item: "stone", ticks: secToTicks(GATHER_SEC.stone) });
    const rope = b.island.nodes[NODE.ropeBush]!;
    b.placeFacing("a", rope.x, rope.z, 0, 1.2);
    expect(resolve(b, p)).toMatchObject({ item: "rope", ticks: secToTicks(GATHER_SEC.rope) });
    const berry = b.island.nodes[NODE.berryBush]!;
    b.placeFacing("a", berry.x, berry.z, 0, 1.2);
    expect(resolve(b, p)).toMatchObject({ item: "berry", ticks: secToTicks(GATHER_SEC.berry) });
  });

  it("ignores empty nodes, decorative bushes, palms and anything behind you", () => {
    const b = new Bench([["a"]]);
    const tree = b.island.nodes[NODE.tree]!;
    const p = b.placeFacing("a", tree.x, tree.z, 0, 1.5);
    b.state.nodes[NODE.tree] = 0;
    expect(resolve(b, p)).toBeNull();
    b.state.nodes[NODE.tree] = 3;
    p.yaw += Math.PI;
    expect(resolve(b, p)).toBeNull();
    const dead = b.island.nodes[NODE.deadBush]!;
    b.placeFacing("a", dead.x, dead.z, 0, 1);
    expect(resolve(b, p)).toBeNull();
    const palm = b.island.nodes[NODE.palm]!;
    b.placeFacing("a", palm.x, palm.z, 0, 1.6);
    expect(resolve(b, p)).toBeNull();
  });

  it("priority: revive > collectCrab > pickup > gather", () => {
    const b = new Bench([["a"], ["b"]]);
    const tree = b.island.nodes[NODE.tree]!;
    const p = b.placeFacing("a", tree.x, tree.z, 0, 2);
    itemAt(b, "p1", "coconut", tree.x, tree.z + 1);
    expect(resolve(b, p)).toMatchObject({ kind: "pickup", projectileId: "p1", item: "coconut", ok: true });
    const crab = new MonsterState();
    Object.assign(crab, { id: "m1", kind: "crab", x: tree.x + 0.3, y: 1, z: tree.z + 1.2, mode: "flipped" });
    b.state.monsters.set("m1", crab);
    expect(resolve(b, p)).toMatchObject({ kind: "collectCrab", monsterId: "m1", item: "crab_raw" });
    const down = b.place("b", tree.x - 0.3, tree.z + 1.1, 0);
    down.downed = true;
    expect(resolve(b, p)).toMatchObject({ kind: "revive", playerId: "b", hold: true, channel: CHANNEL.REVIVE, ticks: REVIVE_TICKS });
    expect(INTERACT_PRIORITY.indexOf("revive")).toBe(0);
    expect(INTERACT_PRIORITY.at(-1)).toBe("gather");
  });

  it("a greyed-out candidate never hides one that works (full pockets: the tree still gathers)", () => {
    const b = new Bench([["a"]]);
    const tree = b.island.nodes[NODE.tree]!;
    const p = b.placeFacing("a", tree.x, tree.z, 0, 2);
    itemAt(b, "p1", "stone", tree.x, tree.z + 1);
    for (let s = 0; s < 4; s++) setSlot(p, s, "rope", 5);
    expect(resolve(b, p)).toMatchObject({ kind: "gather", ok: true });
    b.state.nodes[NODE.tree] = 0;
    expect(resolve(b, p)).toMatchObject({ kind: "pickup", ok: false, reason: "full" });
  });

  it("the campfire workbench beats the chest; the chest opens when only it is in reach", () => {
    const b = new Bench([["a"]]);
    const site = b.island.sites[0]!;
    const p = b.place("a", site.campfire.x + 1.1, site.campfire.z + 1.6, Math.PI);
    expect(resolve(b, p)).toMatchObject({ kind: "craft", ok: true, team: 0, reason: "" });
    b.state.teams[0]!.fireFuel = 0;
    expect(resolve(b, p)).toMatchObject({ kind: "craft", ok: true, reason: "fireOut" });
    b.place("a", site.chest.x + 1.5, site.chest.z, Math.PI / 2);
    expect(resolve(b, p)).toMatchObject({ kind: "chest", ok: true });
  });

  it("big sites work from any direction up close", () => {
    const b = new Bench([["a"]]);
    const site = b.island.sites[0]!;
    // Back to the campfire, 1.5 m away.
    const p = b.place("a", site.campfire.x, site.campfire.z - 1.5, 0);
    expect(resolve(b, p)!.kind).toBe("craft");
    b.place("a", site.campfire.x, site.campfire.z - 3.2, 0);
    expect(resolve(b, p)).toBeNull();
  });

  it("the raft: deliver what the stage needs, say why otherwise, board when ready", () => {
    const b = new Bench([["a"], ["b"]]);
    const r = b.island.sites[0]!.raft;
    const p = b.placeFacing("a", r.x, r.z, 0, -2);
    expect(resolve(b, p)).toMatchObject({ kind: "deliver", ok: false, reason: "nothingToDeliver", item: "wood" });
    setSlot(p, 0, "coconut", 1);
    expect(resolve(b, p)).toMatchObject({ kind: "deliver", ok: false, reason: "wrongStage" });
    setSlot(p, 1, "wood", 2);
    expect(resolve(b, p)).toMatchObject({ kind: "deliver", ok: true });
    const team = b.state.teams[0]!;
    const cost = raftCost(team.seats);
    Object.assign(team, { hullWood: cost.hullWood, mastWood: cost.mastWood, mastRope: cost.mastRope, food: cost.food, water: cost.water, stage: 3 });
    expect(resolve(b, p)).toMatchObject({ kind: "board", ok: true });
  });

  it("spring, collector and the secret chest", () => {
    const b = new Bench([["a"]]);
    const site = b.island.sites[0]!;
    const p = b.placeFacing("a", site.spring.x, site.spring.z, 1.5, 0);
    expect(resolve(b, p)).toMatchObject({ kind: "spring", ok: true, item: "water" });
    for (let s = 0; s < 4; s++) setSlot(p, s, "stone", 3);
    expect(resolve(b, p)).toMatchObject({ kind: "spring", ok: false, reason: "full" });
    p.thirst = 40;
    expect(resolve(b, p)!.ok).toBe(true);

    const c = new StructureState();
    Object.assign(c, { id: "s1", kind: "collector", x: -10, y: 1, z: 0, team: 0, uses: 0 });
    b.state.structures.set("s1", c);
    b.placeFacing("a", c.x, c.z, 0, 1.5);
    expect(resolve(b, p)).toMatchObject({ kind: "collector", ok: false, reason: "empty", structureId: "s1" });
    c.uses = 2;
    expect(resolve(b, p)!.ok).toBe(true);

    const sc = site.secretChest;
    b.placeFacing("a", sc.x, sc.z, 0, 1.5);
    expect(resolve(b, p)).toBeNull();
    b.state.teams[0]!.secretRevealed = true;
    expect(resolve(b, p)).toMatchObject({ kind: "secretChest", ok: true });
    b.state.teams[0]!.secretOpened = true;
    expect(resolve(b, p)).toBeNull();
  });

  it("nothing while downed, aboard or outside play; writes into `out`", () => {
    const b = new Bench([["a"]]);
    const tree = b.island.nodes[NODE.tree]!;
    const p = b.placeFacing("a", tree.x, tree.z, 0, 1.5);
    const out = emptyInteraction();
    expect(resolveInteraction(world(b), p, out)).toBe(out);
    p.downed = true;
    expect(resolve(b, p)).toBeNull();
    p.downed = false;
    p.boarded = true;
    expect(resolve(b, p)).toBeNull();
    p.boarded = false;
    b.state.phase = "lobby";
    expect(resolve(b, p)).toBeNull();
  });
});

describe("gather / channel helpers", () => {
  it("yields and channel ticks", () => {
    const b = new Bench([["a"]]);
    const n = b.island.nodes;
    expect(gatherYield(n[NODE.tree]!)).toBe("wood");
    expect(gatherYield(n[NODE.palm]!)).toBe("coconut");
    expect(gatherYield(n[NODE.deadBush]!)).toBeNull();
    expect(gatherTicksFor(n[NODE.tree]!, true)).toBe(30);
    expect(channelTicksFor(CHANNEL.REVIVE, null, false)).toBe(REVIVE_TICKS);
    expect(channelTicksFor(CHANNEL.GATHER, n[NODE.rock]!, false)).toBe(60);
    expect(channelTicksFor(CHANNEL.NONE, null, false)).toBe(0);
  });
});

describe("raft helpers", () => {
  it("planWood: whole parts while they fit, wood singles, one overshooting part last", () => {
    expect(planWood(7, 1, 5, 3)).toEqual({ parts: 1, wood: 4, credited: 7 });
    expect(planWood(2, 1, 0, 3)).toEqual({ parts: 1, wood: 0, credited: 2 });
    expect(planWood(10, 4, 0, 3)).toEqual({ parts: 4, wood: 0, credited: 10 });
    expect(planWood(10, 2, 1, 4)).toEqual({ parts: 2, wood: 1, credited: 9 });
    expect(planWood(0, 3, 3, 3)).toEqual({ parts: 0, wood: 0, credited: 0 });
  });

  it("stage = first incomplete requirement; remaining needs", () => {
    const cost = raftCost(4);
    const team = { stage: 0 as const, seats: 4, hullWood: cost.hullWood, mastWood: 4, mastRope: 2, food: 0, water: 0 };
    expect(raftStageFor(team, cost)).toBe(1);
    expect(raftRemaining(team, cost)).toEqual({ hullWood: 0, mastWood: 0, mastRope: cost.mastRope - 2, food: cost.food, water: cost.water });
    expect(raftStageFor({ ...team, hullWood: cost.hullWood - 1 }, cost)).toBe(0);
    expect(raftStageFor({ ...team, mastRope: cost.mastRope, food: cost.food, water: cost.water }, cost)).toBe(3);
    expect(raftPartValue("kaptan")).toBe(4);
    expect(raftPartValue("sef")).toBe(3);
  });

  it("planRaftDelivery only takes what the current stage needs (cheap food first)", () => {
    const cost = raftCost(2);
    const inv = { inv0: "fish_golden" as const, inv1: "coconut" as const, inv2: "water" as const, inv3: "rope" as const, cnt0: 1, cnt1: 3, cnt2: 3, cnt3: 5 };
    const team = { stage: 2 as const, seats: 2, hullWood: 10, mastWood: 4, mastRope: 4, food: 0, water: 1 };
    const plan = planRaftDelivery(inv, team, cost, 3)!;
    expect(plan.items).toEqual([
      { kind: "coconut", count: 2 },
      { kind: "water", count: 1 },
    ]);
    expect([plan.food, plan.water, plan.credited]).toEqual([2, 1, 3]);
    expect(planRaftDelivery(inv, { ...team, stage: 0, hullWood: 3 }, cost, 3)).toBeNull();
    expect(planRaftDelivery(inv, { ...team, stage: 3 }, cost, 3)).toBeNull();
  });
});
