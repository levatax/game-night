// The reconnect stand-in (server/room/bots.ts, BotSeatOptions.standIn) against the real RaftWorld at NORMAL
// timings: a dropped human's seat is driven from dusk through the whole first night with food, water and wood in
// its pockets and a stocked camp chest. It must leave both exactly as they were, cause no throw / toss / eat /
// deliver / craft / chest / gather / fish / pickup / place event and no host craft / chest / emote / marker call,
// and come through the night unhurt by staying in the fire's light; a full bot of the same role on the same seat
// does act. (Fast timings would hide it: their bots barely get to act.) It still revives a downed teammate and
// boards the ready raft, also past a coconut lying in front of it (pickup outranks board), and its E gate
// (standInE) allows exactly what the server then does with the command: a turn or a step that brings an item
// into reach would pick it up. The desk-level button mask: bots.test.ts.
// Run: npx vitest run games/raft-rush/server/room

import { describe, expect, it } from "vitest";
import { CHARACTER_IDS, DOWNED_TICKS, FIRE_FUEL_MAX_TICKS, FIRE_LIGHT_RADIUS, secToTicks, timingsFor } from "../../shared/constants.js";
import { raftCost } from "../../shared/items.js";
import { generateIsland } from "../../shared/island/generate.js";
import { heightAt } from "../../shared/island/heightfield.js";
import { mulberry32 } from "../../shared/island/noise.js";
import { BTN, type InputCmd } from "../../shared/protocol.js";
import { resolveInteraction } from "../../shared/rules/interact.js";
import { addItem, clearInventory, slotsOf } from "../../shared/rules/inventory.js";
import { clockAt } from "../../shared/rules/schedule.js";
import { wrapAngle, yawFromDir } from "../../shared/sim/math.js";
import type { BotRole, ItemKind } from "../../shared/types.js";
import { PlayerState, ProjectileEntity, RaftState } from "../schema.js";
import type { GameEvent } from "../world/events.js";
import { RaftWorld } from "../world/World.js";
import { BotDesk, roleForCharacter, standInE, type BotHost } from "./bots.js";

/** Events that mean the seat used, spent, added or placed an item (or tried to and was refused). */
const ACTING = new Set<string>(["throw", "pickup", "catch", "gather", "palmShake", "use", "eat", "crafted", "fireFuel", "chestChanged", "deliver", "structurePlaced", "fishCast", "reject"]);
const POCKETS: [ItemKind, number][] = [
  ["wood", 3],
  ["water", 2],
  ["coconut", 2],
  ["fish_cooked", 1],
];
const CHEST: [ItemKind, number][] = [
  ["wood", 6],
  ["rope", 2],
  ["stone", 3],
  ["fish_cooked", 2],
  ["water", 2],
];
const ROLES: BotRole[] = ["asci", "bekci", "hamal", "balikci"];
const SEED = 16838; // a tropic island: cold nights (warmth matters)
const T = timingsFor(false);
/** First ticks of the last night: the only window in which the raft may be boarded. */
const LAST_NIGHT = 2 * (T.day + T.dusk + T.night) + T.day + T.dusk + 5;

interface Match {
  state: RaftState;
  world: RaftWorld;
  desk: BotDesk;
  /** The dropped human's seat. */
  h: PlayerState;
  /** Host calls the desk made, as "craft:<id>", "chest:<id>", "emote:<id>", "marker:<id>". */
  calls: string[];
  /** Drop every monster each tick (boarding tests want no night wave). */
  peaceful: boolean;
  /** Run the room's per-tick order (clock → bots → world) from clock tick `from` up to `to`; returns the events. */
  run(from: number, to: number): GameEvent[];
}

/** A solo match on the real world with seat "h1" (the dropped human) driven as a stand-in or as a full bot. */
function match(role: BotRole, standIn: boolean, seed: number, extra: (state: RaftState) => string[] = () => []): Match {
  const timings = timingsFor(false);
  const state = new RaftState();
  const island = generateIsland(seed, "solo");
  const world = new RaftWorld(state, island, { fast: false, difficulty: "normal", rng: mulberry32(seed ^ 0x51ed) });
  state.difficulty = "normal";
  state.settings.difficulty = "normal";
  const h = new PlayerState();
  h.id = "h1";
  h.nickname = "Dropped";
  h.character = CHARACTER_IDS.find((c) => roleForCharacter(c) === role)!;
  h.seat = 0;
  h.ready = true;
  state.players.set(h.id, h);
  world.startMatch([h.id, ...extra(state)], 2);
  h.connected = false;
  if (!standIn) {
    // The leaver's seat for good (RaftRoom.takeOver): a bot of the same role.
    h.bot = true;
    h.botRole = role;
  }
  clearInventory(h);
  for (const [kind, n] of POCKETS) addItem(h, kind, n);
  h.torchTicks = 0;
  h.fuseTicks = 0;
  const team = state.teams[0]!;
  team.chest.clear();
  for (const [kind, n] of CHEST) team.chest.set(kind, n);
  team.fireFuel = FIRE_FUEL_MAX_TICKS; // the camp stays lit all night: nobody has to feed it

  const calls: string[] = [];
  const host: BotHost = {
    state,
    world,
    rng: mulberry32(seed ^ 0xb075),
    queueInput: (id, cmd) => world.queueInput(id, cmd),
    craft: (id, recipe) => (calls.push(`craft:${id}`), world.craft(id, recipe)),
    chest: (id, msg) => (calls.push(`chest:${id}`), world.chest(id, msg)),
    emote: (id) => (calls.push(`emote:${id}`), true),
    marker: (id) => (calls.push(`marker:${id}`), true),
  };
  const desk = new BotDesk(host);
  desk.add(h.id, role, { standIn });
  desk.reset();
  state.phase = "playing";
  state.day = 1;
  const m: Match = {
    state, world, desk, h, calls, peaceful: false,
    run: (from: number, to: number): GameEvent[] => {
    const events: GameEvent[] = [];
    for (state.clockTicks = from; state.clockTicks < to; ) {
      state.tick++;
      state.clockTicks++;
      const clock = clockAt(state.clockTicks, timings);
      state.day = clock.day;
      state.dayPhase = clock.dayPhase;
      state.phaseTicksLeft = clock.phaseLeft;
      if (m.peaceful) state.monsters.clear();
      desk.tick();
      events.push(...world.step({ locked: false, clock }));
    }
      return events;
    },
  };
  return m;
}

function actorOf(ev: GameEvent): string {
  if (ev.type === "throw") return ev.ownerId;
  return "playerId" in ev ? ev.playerId : "";
}

function chestOf(state: RaftState): string {
  const out: string[] = [];
  state.teams[0]!.chest.forEach((n, k) => {
    if (n > 0) out.push(`${k}×${n}`);
  });
  return out.sort().join(" ");
}

interface Night {
  inventoryBefore: string;
  inventoryAfter: string;
  chestBefore: string;
  chestAfter: string;
  /** Event types the seat caused (ACTING only). */
  acted: string[];
  /** Host calls the desk made for the seat ("craft", "chest", "emote", "marker"). */
  calls: string[];
  hurt: number;
  alive: boolean;
  downed: boolean;
  /** Distance from the campfire at dawn. */
  fromFire: number;
}

/** Seat "h1", hungry and thirsty, from the start of dusk 1 to dawn 2. */
function night(role: BotRole, standIn: boolean, seed: number): Night {
  const timings = timingsFor(false);
  const m = match(role, standIn, seed);
  const h = m.h;
  h.hunger = 44; // a full bot eats / drinks below 45
  h.thirst = 44;
  const inventoryBefore = JSON.stringify(slotsOf(h));
  const chestBefore = chestOf(m.state);
  // Straight into dusk: the day's event (monkeys at the chest, the gull) is not replayed for a day seen at its end.
  expect(clockAt(timings.day, timings).dayPhase).toBe("dusk");
  const events = m.run(timings.day - 1, timings.day + timings.dusk + timings.night + secToTicks(2));
  const fire = m.world.island.sites[0]!.campfire;
  let hurt = 0;
  const acted: string[] = [];
  for (const ev of events) {
    if (actorOf(ev) !== h.id) continue;
    if (ACTING.has(ev.type)) acted.push(ev.type);
    if (ev.type === "playerHurt") hurt += ev.amount;
  }
  return {
    inventoryBefore,
    inventoryAfter: JSON.stringify(slotsOf(h)),
    chestBefore,
    chestAfter: chestOf(m.state),
    acted,
    calls: m.calls.filter((c) => c.endsWith(`:${h.id}`)).map((c) => c.split(":")[0]!),
    hurt,
    alive: h.alive,
    downed: h.downed,
    fromFire: Math.hypot(h.x - fire.x, h.z - fire.z),
  };
}

/**
 * The raft is ready; seat h1 stands at the board flow's land-side stand point, its look `yawOff` off facing the
 * raft, and a coconut it has room for lies `dist` m away, `angle` off facing the raft. Returns that facing yaw.
 */
function atTheRaft(m: Match, yawOff: number, angle: number, dist: number): number {
  const team = m.state.teams[0]!;
  Object.assign(team, raftCost(team.seats));
  team.stage = 3;
  // No night wave, so the test measures boarding alone.
  m.peaceful = true;
  const { raft, campfire } = m.world.island.sites[0]!;
  const l = Math.hypot(campfire.x - raft.x, campfire.z - raft.z);
  const h = m.h;
  h.x = raft.x + ((campfire.x - raft.x) / l) * 2.4;
  h.z = raft.z + ((campfire.z - raft.z) / l) * 2.4;
  h.y = heightAt(m.world.island.grid, h.x, h.z);
  const facing = yawFromDir(raft.x - h.x, raft.z - h.z);
  h.yaw = wrapAngle(facing + yawOff);
  const c = new ProjectileEntity();
  c.id = "c1";
  c.kind = "coconut";
  c.state = "rest";
  c.x = h.x - Math.sin(facing + angle) * dist;
  c.z = h.z - Math.cos(facing + angle) * dist;
  c.y = heightAt(m.world.island.grid, c.x, c.z) + c.radius;
  m.state.projectiles.set(c.id, c);
  return facing;
}

describe("reconnect stand-in in the real world (normal timings)", () => {
  for (const role of ROLES) {
    it(`a ${role} stand-in spends nothing of the absent player's through dusk and night 1; a full ${role} does`, () => {
      const s = night(role, true, SEED);
      expect(s.inventoryAfter).toBe(s.inventoryBefore);
      expect(s.chestAfter).toBe(s.chestBefore);
      expect(s.acted).toEqual([]);
      expect(s.calls).toEqual([]);
      // Kept safe in the light: never bitten, back by the fire at dawn.
      expect(s.alive && !s.downed).toBe(true);
      expect(s.hurt).toBe(0);
      expect(s.fromFire).toBeLessThan(FIRE_LIGHT_RADIUS);

      const b = night(role, false, SEED);
      expect(b.acted).toContain("eat");
      expect(b.inventoryAfter === b.inventoryBefore && b.chestAfter === b.chestBefore).toBe(false);
    });
  }

  it("still revives a downed teammate, and boards the ready raft so the absent player isn't left ashore", () => {
    // A connected teammate who went down 3 m away (and never presses a key).
    const m = match("asci", true, SEED, (state) => {
      const mate = new PlayerState();
      mate.id = "h2";
      mate.nickname = "Mate";
      mate.character = "kaptan";
      mate.seat = 1;
      state.players.set(mate.id, mate);
      return [mate.id];
    });
    const mate = m.state.players.get("h2")!;
    mate.x = m.h.x + 3;
    mate.z = m.h.z;
    mate.hp = 0;
    mate.downed = true;
    mate.downedTicks = DOWNED_TICKS;
    const inventory = JSON.stringify(slotsOf(m.h));
    const revived = m.run(0, secToTicks(8)).filter((ev) => ev.type === "playerRevived");
    expect(revived).toMatchObject([{ playerId: "h2", byId: "h1" }]);

    // The raft is ready and the mate stands by it: the stand-in walks over and boards (E), nothing else.
    const team = m.state.teams[0]!;
    Object.assign(team, raftCost(team.seats));
    team.stage = 3;
    m.peaceful = true;
    const raft = m.world.island.sites[0]!.raft;
    mate.x = raft.x + 2;
    mate.z = raft.z;
    m.h.x = raft.x - 1;
    m.h.z = raft.z;
    m.h.y = heightAt(m.world.island.grid, m.h.x, m.h.z);
    const events = m.run(LAST_NIGHT, LAST_NIGHT + secToTicks(30));
    expect(m.h.boarded).toBe(true);
    expect(events.filter((ev) => actorOf(ev) === "h1" && ACTING.has(ev.type))).toEqual([]);
    expect(events.some((ev) => ev.type === "board" && ev.playerId === "h1")).toBe(true);
    expect(JSON.stringify(slotsOf(m.h))).toBe(inventory);
  });
  it("boards past a coconut lying in front of the raft (pickup outranks board) and leaves it there", () => {
    // Ahead and a little to either side (turning away gets it out of view), and at the seat's feet (reachable from
    // every side: the seat first steps around the raft).
    for (const [angle, dist] of [
      [0, 1.4],
      [0.26, 1.4],
      [-0.26, 1.4],
      [0, 0.35],
    ] as const) {
      const label = `coconut ${dist} m off at ${angle} rad`;
      const m = match("asci", true, SEED);
      atTheRaft(m, 0, angle, dist);
      const inventory = JSON.stringify(slotsOf(m.h));
      expect(resolveInteraction({ island: m.world.island, state: m.state }, m.h)?.kind, label).toBe("pickup");
      const events = m.run(LAST_NIGHT, LAST_NIGHT + secToTicks(6));
      expect(m.h.boarded, label).toBe(true);
      expect(events.filter((ev) => actorOf(ev) === "h1" && ACTING.has(ev.type)), label).toEqual([]);
      expect(JSON.stringify(slotsOf(m.h)), label).toBe(inventory);
      expect(m.state.projectiles.has("c1"), label).toBe(true);
    }
  });

  it("allows E exactly when the server, after the command's turn and step, would board rather than pick up", () => {
    const right = -Math.PI / 2;
    const cases: { label: string; yawOff: number; angle: number; dist: number; turn: boolean; walk: boolean; did: string }[] = [
      // A turn step off the raft, a coconut just outside the view cone on the other side: the turn brings it in.
      { label: "turning, coconut on the left", yawOff: 0.1, angle: -(Math.PI / 3 - 0.05), dist: 1.4, turn: true, walk: false, did: "pickup" },
      { label: "turning, coconut on the right", yawOff: -0.1, angle: Math.PI / 3 - 0.05, dist: 1.4, turn: true, walk: false, did: "pickup" },
      { label: "not turning", yawOff: 0.1, angle: -(Math.PI / 3 - 0.05), dist: 1.4, turn: false, walk: false, did: "board" },
      // Walking right, a coconut just out of arm's reach on that side: the step brings it within reach.
      { label: "stepping toward a coconut at the side", yawOff: 0, angle: right, dist: 0.9, turn: false, walk: true, did: "pickup" },
      { label: "standing by a coconut at the side", yawOff: 0, angle: right, dist: 0.9, turn: false, walk: false, did: "board" },
    ];
    for (const c of cases) {
      const setUp = (): { m: Match; cmd: InputCmd } => {
        const m = match("asci", true, SEED);
        const facing = atTheRaft(m, c.yawOff, c.angle, c.dist);
        if (c.walk) {
          m.h.vx = Math.cos(facing) * 4.6;
          m.h.vz = -Math.sin(facing) * 4.6;
        }
        const yaw = c.turn ? facing : m.h.yaw;
        return { m, cmd: { seq: m.h.lastSeq + 1, moveX: c.walk ? 1 : 0, moveZ: 0, yaw, pitch: 0, buttons: BTN.INTERACT_PRESS | BTN.INTERACT } };
      };
      // What the gate says ...
      const a = setUp();
      const w = a.m.world;
      const allowed = standInE({ island: w.island, state: a.m.state }, { terrain: w.island.grid, cover: w.cover, bounds: w.island.bounds }, a.m.h, a.cmd);
      // ... and what the server does with the same command, sent unmasked.
      const b = setUp();
      b.m.desk.remove(b.m.h.id);
      b.m.world.queueInput(b.m.h.id, b.cmd);
      const did = b.m.run(LAST_NIGHT, LAST_NIGHT + 1).find((ev) => actorOf(ev) === "h1" && (ev.type === "board" || ev.type === "pickup"));
      expect(did?.type, c.label).toBe(c.did);
      expect(allowed, c.label).toBe(c.did === "board");
    }
  });
});
