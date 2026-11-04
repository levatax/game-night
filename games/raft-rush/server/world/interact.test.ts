// shared/rules/interact.ts: resolveInteraction priorities / reaches / cones and the raft delivery helpers.
// Owner: server-world (the resolver is shared by the server, the client prompt and the bots).

import { describe, expect, it } from "vitest";
import { CHANNEL, CHARACTERS, GATHER_SEC, RAFT_LAUNCH_STAGE, REVIVE_TICKS, secToTicks } from "../../shared/constants.js";
import { raftAssemblyTicks, raftStageNeeds } from "../../shared/items.js";
import {
  assemblyWorkPerTick,
  channelTicksFor,
  emptyInteraction,
  gatherTicksFor,
  gatherYield,
  INTERACT_PRIORITY,
  planRaftDelivery,
  planRaftRepair,
  raftMaterialsDone,
  raftWantedItem,
  resolveInteraction,
  salvageTicksFor,
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
  it("gathers what you look at: wood 4 s, 1.5 s with an axe (Amca 1.1 s); stone; rope; berries", () => {
    const b = new Bench([["a"]]);
    const tree = b.island.nodes[NODE.tree]!;
    const p = b.placeFacing("a", tree.x, tree.z, 0, 1.5);
    const it = resolve(b, p)!;
    expect(it).toMatchObject({ kind: "gather", hold: true, channel: CHANNEL.GATHER, node: NODE.tree, item: "wood", ok: true });
    expect(it.ticks).toBe(secToTicks(GATHER_SEC.wood));
    b.give("a", "axe", 1, 2);
    expect(resolve(b, p)!.ticks).toBe(secToTicks(GATHER_SEC.woodAxe));
    p.character = "amca";
    expect(resolve(b, p)!.ticks).toBe(secToTicks(CHARACTERS.amca.chopSec));
    p.character = "fenomen";
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

  it("the raft: deliver what the open stage needs, say why otherwise", () => {
    const b = new Bench([["a"], ["b"]]);
    const r = b.island.sites[0]!.raft;
    const p = b.placeFacing("a", r.x, r.z, 0, -2);
    expect(resolve(b, p)).toMatchObject({ kind: "deliver", ok: false, reason: "nothingToDeliver", item: "log" });
    setSlot(p, 0, "raft_part", 3); // planks: the deck's, not the keel's
    expect(resolve(b, p)).toMatchObject({ kind: "deliver", ok: false, reason: "wrongStage" });
    setSlot(p, 1, "rope", 2);
    expect(resolve(b, p)).toMatchObject({ kind: "deliver", ok: true });
    // The deck opens on day 2: on day 1 the planks are refused.
    const team = b.state.teams[0]!;
    team.stage = 1;
    team.raftNeed[0] = 9;
    team.raftNeed[1] = 3;
    b.state.day = 1;
    expect(resolve(b, p)).toMatchObject({ kind: "deliver", ok: false, reason: "stageLocked" });
    b.state.day = 2;
    expect(resolve(b, p)).toMatchObject({ kind: "deliver", ok: true, item: "raft_part" });
  });

  it("the raft: hold E to assemble once every material is in; a hammer repairs", () => {
    const b = new Bench([["a"]]);
    const r = b.island.sites[0]!.raft;
    const p = b.placeFacing("a", r.x, r.z, 0, -2);
    const team = b.state.teams[0]!;
    team.raftHave[0] = team.raftNeed[0]!;
    team.raftHave[1] = team.raftNeed[1]!;
    const it = resolve(b, p)!;
    expect(it).toMatchObject({ kind: "assemble", ok: true, hold: true, channel: CHANNEL.BUILD, team: 0 });
    expect(it.ticks).toBe(team.raftWorkNeed - team.raftWork);
    // Deck stage, nothing to deliver, raft scratched: a hammer and a plank (or 2 wood) repair it.
    team.stage = 1;
    team.raftHave[0] = 0;
    team.raftHave[1] = 0;
    team.raftNeed[0] = 9;
    team.raftNeed[1] = 3;
    team.raftHp = 70;
    b.state.day = 2;
    setSlot(p, 0, "hammer", 1);
    setSlot(p, 1, "wood", 2);
    expect(resolve(b, p)).toMatchObject({ kind: "repair", ok: true, item: "wood" });
    team.raftHp = 100;
    expect(resolve(b, p)).toMatchObject({ kind: "deliver", ok: false });
  });

  it("the raft: board only in the launch window with a sound raft (or once the push-off counts)", () => {
    const b = new Bench([["a"]]);
    const r = b.island.sites[0]!.raft;
    const p = b.placeFacing("a", r.x, r.z, 0, -2);
    const team = b.state.teams[0]!;
    team.stage = RAFT_LAUNCH_STAGE;
    team.raftHp = 100;
    b.state.day = 6;
    expect(resolve(b, p)).toMatchObject({ kind: "board", ok: false, reason: "seaRough" });
    b.state.day = 7;
    expect(resolve(b, p)).toMatchObject({ kind: "board", ok: true });
    team.raftHp = 40;
    expect(resolve(b, p)).toMatchObject({ kind: "board", ok: false, reason: "raftWeak" });
    setSlot(p, 0, "hammer", 1);
    setSlot(p, 1, "raft_part", 1);
    expect(resolve(b, p)).toMatchObject({ kind: "repair", ok: true, item: "raft_part" });
    b.state.launchTicksLeft = 100;
    expect(resolve(b, p)).toMatchObject({ kind: "board", ok: true });
  });

  it("the wreck: salvage scrap with a hammer while it lasts", () => {
    const b = new Bench([["a"]]);
    const w = b.island.sites[0]!.wreck;
    const p = b.placeFacing("a", w.x, w.z, 0, 2);
    p.character = "gelin";
    expect(resolve(b, p)).toMatchObject({ kind: "salvage", ok: false, reason: "needHammer" });
    setSlot(p, 2, "hammer", 1);
    expect(resolve(b, p)).toMatchObject({ kind: "salvage", ok: true, hold: true, channel: CHANNEL.SALVAGE, ticks: secToTicks(GATHER_SEC.salvage), item: "scrap" });
    p.character = "fenomen";
    expect(resolve(b, p)!.ticks).toBe(salvageTicksFor("fenomen"));
    expect(salvageTicksFor("fenomen")).toBe(secToTicks(CHARACTERS.fenomen.salvageSec));
    b.state.teams[0]!.wreckScrap = 0;
    expect(resolve(b, p)).toMatchObject({ kind: "salvage", ok: false, reason: "wreckEmpty" });
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
    b.state.teams[0]!.springCharges = 0;
    expect(resolve(b, p)).toMatchObject({ kind: "spring", ok: false, reason: "springDry" });

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
    expect(gatherTicksFor(n[NODE.tree]!, true)).toBe(45);
    expect(gatherTicksFor(n[NODE.tree]!, false)).toBe(120);
    expect(channelTicksFor(CHANNEL.REVIVE, null, false)).toBe(REVIVE_TICKS);
    expect(channelTicksFor(CHANNEL.GATHER, n[NODE.rock]!, false)).toBe(75);
    expect(channelTicksFor(CHANNEL.SALVAGE, null, false)).toBe(90);
    expect(channelTicksFor(CHANNEL.BUILD, null, false)).toBe(0);
    expect(channelTicksFor(CHANNEL.NONE, null, false)).toBe(0);
  });
});

describe("raft helpers", () => {
  it("stage needs scale with seats and the difficulty (a 1 stays 1); fast mode needs 1 of everything", () => {
    expect(raftStageNeeds(0, 3)).toEqual([2, 4, 0]);
    expect(raftStageNeeds(0, 6)).toEqual([4, 7, 0]);
    expect(raftStageNeeds(0, 1)).toEqual(raftStageNeeds(0, 2));
    expect(raftStageNeeds(2, 3, 1.25)).toEqual([1, 5, 7]); // one mast log whatever the difficulty
    expect(raftStageNeeds(4, 3, 1.25)[2]).toBe(1); // one compass
    expect(raftStageNeeds(1, 3, 0.75)).toEqual([9, 3, 0]);
    expect(raftStageNeeds(5, 4, 1, true)).toEqual([1, 1, 0]);
    expect(raftStageNeeds(RAFT_LAUNCH_STAGE, 3)).toEqual([0, 0, 0]);
    expect(raftAssemblyTicks(2)).toBe(secToTicks(30));
    expect(raftAssemblyTicks(2, true)).toBe(secToTicks(1));
  });

  it("assembly rate: 1, 2 and 3 holders, with and without a hammer; the mast needs two", () => {
    const h = (hammer: boolean, character: "fenomen" | "kaptan" = "fenomen") => ({ hammer, character });
    expect(assemblyWorkPerTick([h(true)])).toBe(1);
    expect(assemblyWorkPerTick([h(false)])).toBe(0.5);
    expect(assemblyWorkPerTick([h(true), h(true)])).toBeCloseTo(2.4);
    expect(assemblyWorkPerTick([h(true), h(false), h(false)])).toBeCloseTo(2 * 1.4);
    expect(assemblyWorkPerTick([h(true, "kaptan")])).toBe(1.5);
    expect(assemblyWorkPerTick([h(true), h(true), h(true), h(true), h(true)])).toBeCloseTo(4 * 1.4); // 4 count
    expect(assemblyWorkPerTick([h(true)], 2)).toBe(0);
    expect(assemblyWorkPerTick([h(true), h(false)], 2)).toBeCloseTo(1.5 * 1.2);
    expect(assemblyWorkPerTick([])).toBe(0);
  });

  it("planRaftDelivery only takes what the current stage still needs (cheapest cooked food first)", () => {
    const inv = { inv0: "fish_golden" as const, inv1: "fish_cooked" as const, inv2: "barrel" as const, inv3: "fish_raw" as const, cnt0: 1, cnt1: 3, cnt2: 1, cnt3: 3 };
    const team = { stage: 5, raftHave: [1, 1, 0], raftNeed: [4, 2, 0], raftWork: 0, raftWorkNeed: 300, raftHp: 80 };
    const plan = planRaftDelivery(inv, team)!;
    expect(plan.items).toEqual([
      { kind: "fish_cooked", count: 3 },
      { kind: "barrel", count: 1 },
    ]);
    expect([plan.slots, plan.units, plan.heavy]).toEqual([[3, 1, 0], 4, 1]);
    expect(planRaftDelivery(inv, { ...team, stage: 0 })).toBeNull(); // raw fish and the rest aren't keel goods
    expect(planRaftDelivery(inv, { ...team, stage: RAFT_LAUNCH_STAGE })).toBeNull();
    expect(raftMaterialsDone({ ...team, raftHave: [4, 2, 0] })).toBe(true);
    expect(raftWantedItem(team)).toBe("fish_cooked");
    expect(planRaftRepair(inv, team)).toBeNull(); // no hammer
    expect(planRaftRepair({ ...inv, inv3: "hammer", cnt3: 1 }, { stage: 0, raftHp: 50 })).toBeNull(); // no keel yet
  });
});
