// The world's event buffer (server/world/eventBuffer.ts: reject coalescing, the cap) and RaftWorld's reject
// events (every one names the acting player and the right action). Owner: server-world.

import { afterEach, describe, expect, it, vi } from "vitest";
import { BTN } from "../../shared/protocol.js";
import { countOf } from "../../shared/rules/inventory.js";
import type { RejectAction } from "./core.js";
import { duplicateKey, EVENT_BUFFER_CAP, EventBuffer } from "./eventBuffer.js";
import type { GameEvent } from "./events.js";
import { Bench, benchIsland } from "./testkit.js";

const reject = (playerId: string, reason: string, tick = 1, action: RejectAction = "craft"): GameEvent => ({ type: "reject", tick, playerId, action, reason });
const chest = (playerId: string, tick = 1): GameEvent => ({ type: "chestChanged", tick, team: 0, playerId, op: "put", items: [{ kind: "wood", count: 1 }] });
const punch = (playerId: string, tick = 1): GameEvent => ({ type: "use", tick, playerId, what: "punch", pos: { x: 0, y: 0, z: 0 } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EventBuffer", () => {
  it("coalesces identical rejects of one tick until the next drain", () => {
    const buf = new EventBuffer();
    buf.push(reject("a", "missing"));
    buf.push(reject("a", "missing"));
    buf.push(reject("a", "tooFar"));
    buf.push(reject("b", "missing"));
    buf.push(reject("a", "missing", 1, "chest"));
    buf.push({ type: "reject", tick: 1, playerId: "a", action: "interact", reason: "full", interact: "spring" });
    buf.push({ type: "reject", tick: 1, playerId: "a", action: "interact", reason: "full", interact: "pickup" });
    buf.push(reject("a", "missing", 2));
    buf.push(reject("a", "missing", 2));
    expect(buf.drain()).toHaveLength(7);
    expect(buf.stats().coalesced).toBe(2);
    // A drain starts over: the same reject in the same tick goes out again.
    buf.push(reject("a", "missing", 2));
    expect(buf.drain()).toHaveLength(1);
  });

  it("at the cap a newcomer displaces the oldest event of the most repeated (type, actor), while that one holds 2 more", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const buf = new EventBuffer(8);
    for (let i = 0; i < 8; i++) buf.push(chest("a"));
    expect(warn).not.toHaveBeenCalled();
    buf.push(chest("a")); // the flooder's own repeat: dropped
    expect(buf.length).toBe(8);
    buf.push(reject("b", "empty")); // somebody else's reject: the oldest chestChanged of "a" makes room
    buf.push(chest("b"));
    buf.push(chest("b")); // b's second chestChanged too ("a" still holds 5)
    buf.push(reject("a", "tooFar")); // the flooder's first reject gets in as well
    buf.push({ type: "launchRequest", tick: 1, team: 0, aboard: ["a"], left: [], leftBehind: [] }); // internal: always in
    expect(buf.length).toBe(8);
    // "a" holds 3 chestChanged, "b" 2: b's third would only swap one repeat for another, so it's dropped too.
    buf.push(chest("b"));
    buf.push(chest("a"));
    expect(buf.length).toBe(8);
    expect(warn).toHaveBeenCalledTimes(1);
    const out = buf.drain();
    expect(out.map(duplicateKey)).toEqual([
      ...Array<string>(3).fill("chestChanged|a"),
      "reject|b",
      "chestChanged|b",
      "chestChanged|b",
      "reject|a",
      "launchRequest",
    ]);
    expect(buf.stats().dropped).toBe(8);
    // A later overflow of the same world doesn't warn again.
    for (let i = 0; i < 20; i++) buf.push(chest("a", 2));
    expect(buf.length).toBe(8);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("internal events always get in, even past a buffer of distinct events", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const buf = new EventBuffer(3);
    buf.push(chest("a"));
    buf.push(chest("b"));
    buf.push(chest("c"));
    buf.push(chest("d")); // distinct, nothing duplicated to evict: dropped
    buf.push({ type: "teamWiped", tick: 1, team: 0 }); // evicts the oldest broadcast event
    expect(buf.drain().map(duplicateKey)).toEqual(["chestChanged|b", "chestChanged|c", "teamWiped"]);
    for (let i = 0; i < 4; i++) buf.push({ type: "teamWiped", tick: 2, team: i });
    expect(buf.drain()).toHaveLength(4);
  });
});

describe("RaftWorld: event flood", () => {
  it("hundreds of craft / chest messages in one tick stay bounded, other players' events still go out, the world stays exact", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = new Bench([["a"], ["b"], ["c"]]);
    const site = b.island.sites[0]!;
    const a = b.place("a", site.chest.x, site.chest.z + 1.4, 0); // in reach of the chest and the campfire
    const team = b.state.teams[0]!;
    team.chest.clear();
    b.give("a", "wood", 2, 0);
    b.give("b", "coconut", 1, 0);
    b.place("c", 0, 0, 0); // empty hands
    for (let i = 0; i < 400; i++) {
      b.world.craft("a", "axe"); // wood only: "missing" every time
      b.world.craft("a", "coconut_ball"); // "locked" every time
      b.world.chest("a", { op: "put", count: 1 });
      b.world.chest("a", { op: "take", kind: "wood", count: 1 });
    }
    b.send("b", { buttons: BTN.EAT });
    b.send("c", { buttons: BTN.EAT });
    const evs = b.tick();
    expect(evs.length).toBeLessThanOrEqual(EVENT_BUFFER_CAP);
    expect(b.of("eat", evs)).toEqual([expect.objectContaining({ playerId: "b", kind: "coconut" })]);
    // a's two rejects came first and stay; c's reject of the same tick gets in at a's expense.
    expect(b.of("reject", evs).map((r) => [r.playerId, r.action, r.reason])).toEqual([
      ["a", "craft", "missing"],
      ["a", "craft", "locked"],
      ["c", "eat", "empty"],
    ]);
    expect(b.of("chestChanged", evs).length).toBeGreaterThan(EVENT_BUFFER_CAP / 2);
    expect(countOf(a, "wood")).toBe(2);
    expect(team.chest.get("wood") ?? 0).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(b.world.eventStats().coalesced).toBeGreaterThanOrEqual(2 * 400 - 2);
    // The next tick is back to normal: one reject per (player, action, reason).
    b.world.craft("a", "axe");
    b.world.craft("a", "axe");
    expect(b.of("reject", b.tick())).toEqual([expect.objectContaining({ playerId: "a", action: "craft", reason: "missing" })]);
  });
});

describe("RaftWorld: reject events", () => {
  it("every reject names the acting player and its action", () => {
    const seen = new Set<RejectAction>();
    const expectReject = (b: Bench, evs: GameEvent[], want: { playerId: string; action: RejectAction; reason: string; interact?: string }): void => {
      const rejects = b.of("reject", evs);
      expect(rejects).toEqual([expect.objectContaining(want)]);
      for (const r of rejects) seen.add(r.action);
    };
    const site = benchIsland().sites[0]!;

    // craft (at the fire, nothing to build with)
    let b = new Bench([["a"], ["b"]]);
    b.place("a", site.campfire.x, site.campfire.z + 1.5, 0);
    b.world.craft("a", "axe");
    expectReject(b, b.world.drainEvents(), { playerId: "a", action: "craft", reason: "missing" });
    // chest (nothing of that kind inside)
    b.place("b", site.chest.x, site.chest.z + 1.4, 0);
    b.state.teams[0]!.chest.clear();
    b.world.chest("b", { op: "take", kind: "rope" });
    expectReject(b, b.world.drainEvents(), { playerId: "b", action: "chest", reason: "empty" });
    // fish (a rod, no fish spot in view)
    b = new Bench([["a"], ["b"]]);
    b.place("b", 0, 0, 0);
    b.give("b", "rod", 1);
    b.send("b", { buttons: BTN.USE_PRESS, pitch: 1.2 });
    expectReject(b, b.tick(), { playerId: "b", action: "fish", reason: "noSpot" });
    // interact (the spring with full pockets and a full thirst bar)
    b = new Bench([["a"], ["b"]]);
    const spring = site.spring;
    b.placeFacing("b", spring.x, spring.z, 1.5, 0);
    for (let s = 0; s < 4; s++) b.give("b", "stone", 1, s);
    b.send("b", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expectReject(b, b.tick(), { playerId: "b", action: "interact", reason: "full", interact: "spring" });
    // deliver (empty pockets at an unfinished raft: the greyed-out prompt and the delivery agree)
    b = new Bench([["a"], ["b"]]);
    const raft = site.raft;
    b.placeFacing("b", raft.x, raft.z, 0, -2);
    b.send("b", { buttons: BTN.INTERACT_PRESS | BTN.INTERACT });
    expectReject(b, b.tick(), { playerId: "b", action: "deliver", reason: "nothingToDeliver", interact: "deliver" });
    b.world.raft.deliver(b.p("b"));
    expectReject(b, b.world.drainEvents(), { playerId: "b", action: "deliver", reason: "nothingToDeliver", interact: "deliver" });
    // board (the raft isn't ready)
    b.world.raft.board(b.p("b"));
    expectReject(b, b.world.drainEvents(), { playerId: "b", action: "board", reason: "notReady" });
    // eat (empty hand)
    b = new Bench([["a"], ["b"]]);
    b.place("b", 0, 0, 0);
    b.send("b", { buttons: BTN.EAT });
    expectReject(b, b.tick(), { playerId: "b", action: "eat", reason: "empty" });
    // place (a collector into deep water)
    b.place("b", 0, -33.5, 0);
    b.give("b", "collector", 1);
    b.send("b", { buttons: BTN.USE_PRESS });
    expectReject(b, b.tick(), { playerId: "b", action: "place", reason: "noRoom" });

    expect(seen).toEqual(new Set(["craft", "chest", "fish", "interact", "deliver", "board", "eat", "place"]));
  });
});
