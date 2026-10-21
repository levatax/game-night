// Unit tests for the BotDesk shell (server/room/bots.ts) with a minimal fake host: input seqs, one InputCmd per
// bot per tick, edge vs level buttons (holding E through a gather channel), takeovers and roles, the reconnect
// stand-in's button mask and re-adds, and the desk's memory staying bounded (goal blocks, monster tracks).
// The stand-in against the real RaftWorld at normal timings: botStandIn.test.ts.
// Run: npx vitest run games/raft-rush/server/room

import { describe, expect, it } from "vitest";
import { CHANNEL, CHARACTER_IDS, DT, WALK_SPEED, secToTicks, timingsFor } from "../../shared/constants.js";
import { mulberry32 } from "../../shared/island/noise.js";
import { BTN, BUTTON_MASK, type InputCmd } from "../../shared/protocol.js";
import { addItem, setSlot, slotsOf } from "../../shared/rules/inventory.js";
import { buildCover } from "../../shared/sim/cover.js";
import type { BotRole, CharacterId } from "../../shared/types.js";
import { MonsterState, PlayerState, ProjectileEntity, RaftState, TeamState } from "../schema.js";
import type { RaftWorld } from "../world/World.js";
import { dutyOwner } from "./botBrain.js";
import { BotDesk, ROLE_BY_CHARACTER, roleForCharacter, standInButtons, type BotHost } from "./bots.js";
import { buildView } from "./botSense.js";
import { testIsland } from "./botTestkit.js";

interface Table {
  state: RaftState;
  desk: BotDesk;
  world: RaftWorld;
  /** Inputs per tick: tick index → id → inputs queued that tick. */
  log: Map<string, InputCmd>[];
  /** Host actions the desk asked for, as "craft:<id>", "chest:<id>", "emote:<id>", "marker:<id>". */
  calls: string[];
  /** Ids whose charged throw the fake step released. */
  throws: string[];
  step(): void;
}

function player(id: string, x: number, z: number, bot = true): PlayerState {
  const p = new PlayerState();
  p.id = id;
  p.nickname = id;
  p.bot = bot;
  p.alive = true;
  p.x = x;
  p.y = 1;
  p.z = z;
  return p;
}

/**
 * Two bots on the hand-made test island next to its tree (node 0 at (3, -3)). The fake "world step" applies
 * look, slot edges (a change cancels a charge), THROW charge / release and a little movement, and runs the
 * hold-E channel like RaftWorld: INTERACT_PRESS near the tree starts CHANNEL.GATHER, releasing INTERACT clears
 * it, every 2.5 s of holding yields one wood.
 */
function table(): Table {
  const island = testIsland();
  const state = new RaftState();
  state.phase = "playing";
  state.clockTicks = 300;
  state.day = 1;
  state.dayPhase = "day";
  const team = new TeamState();
  team.seats = 2;
  team.fireFuel = secToTicks(60);
  team.hullWood = 3;
  state.teams.push(team);
  for (const n of island.nodes) state.nodes.push(n.amount);
  const throws: string[] = [];
  const a = player("bot-1", 3, -1.7);
  a.seat = 1;
  const b = player("bot-2", -1, 0);
  b.seat = 2;
  state.players.set(a.id, a);
  state.players.set(b.id, b);

  const world = { island, cover: buildCover(island), timings: timingsFor(false) } as unknown as RaftWorld;
  const rng = mulberry32(7);
  let pending = new Map<string, InputCmd>();
  const log: Map<string, InputCmd>[] = [];
  const calls: string[] = [];
  const host: BotHost = {
    state,
    world,
    rng,
    queueInput: (id, cmd) => {
      expect(pending.has(id)).toBe(false);
      pending.set(id, cmd);
    },
    craft: (id) => (calls.push(`craft:${id}`), false),
    chest: (id) => (calls.push(`chest:${id}`), false),
    emote: (id) => (calls.push(`emote:${id}`), true),
    marker: (id) => (calls.push(`marker:${id}`), true),
  };
  const desk = new BotDesk(host);
  desk.add("bot-1", "hamal");
  desk.add("bot-2", "balikci");
  const tree = island.nodes[0]!;
  const step = (): void => {
    pending = new Map();
    desk.tick();
    log.push(pending);
    for (const [id, cmd] of pending) {
      const p = state.players.get(id)!;
      p.lastSeq = cmd.seq;
      p.yaw = cmd.yaw;
      p.pitch = cmd.pitch;
      const slotBefore = p.activeSlot;
      for (let s = 0; s < 4; s++) if (cmd.buttons & (BTN.SLOT1 << s)) p.activeSlot = s;
      // A slot change cancels a charge; letting go of THROW while charged throws (stepPlayer's rules).
      if (p.activeSlot !== slotBefore) p.chargeTicks = 0;
      if (cmd.buttons & BTN.THROW) p.chargeTicks++;
      else if (p.chargeTicks > 0) {
        throws.push(id);
        p.chargeTicks = 0;
      }
      const holding = (cmd.buttons & BTN.INTERACT) !== 0;
      if (p.channel !== CHANNEL.NONE) {
        if (!holding) {
          p.channel = CHANNEL.NONE;
          p.channelTicks = 0;
          p.channelTarget = -1;
        } else if (++p.channelTicks >= secToTicks(2.5)) {
          p.channelTicks = 0;
          addItem(p, "wood", 1);
          state.nodes[tree.i] = (state.nodes[tree.i] ?? 1) - 1;
          if (state.nodes[tree.i]! <= 0) {
            p.channel = CHANNEL.NONE;
            p.channelTarget = -1;
          }
        }
      } else if (cmd.buttons & BTN.INTERACT_PRESS && Math.hypot(tree.x - p.x, tree.z - p.z) < 2.4 + tree.radius && (state.nodes[tree.i] ?? 0) > 0) {
        p.channel = CHANNEL.GATHER;
        p.channelTarget = tree.i;
        p.channelTicks = 0;
      }
      if (p.channel === CHANNEL.NONE) {
        const s = Math.sin(p.yaw);
        const c = Math.cos(p.yaw);
        p.x += (c * cmd.moveX - s * cmd.moveZ) * WALK_SPEED * DT;
        p.z += (-s * cmd.moveX - c * cmd.moveZ) * WALK_SPEED * DT;
      }
    }
  };
  return { state, desk, world, log, calls, throws, step };
}

const EDGES = [BTN.INTERACT_PRESS, BTN.USE_PRESS, BTN.EAT, BTN.DROP];

describe("BotDesk", () => {
  it("queues exactly one input per bot per tick with strictly increasing seqs", () => {
    const t = table();
    for (let i = 0; i < 240; i++) t.step();
    const last = new Map<string, number>();
    for (const tick of t.log) {
      expect([...tick.keys()].sort()).toEqual(["bot-1", "bot-2"]);
      for (const [id, cmd] of tick) {
        expect(cmd.seq).toBeGreaterThan(last.get(id) ?? 0);
        last.set(id, cmd.seq);
        expect(Math.abs(cmd.moveX)).toBeLessThanOrEqual(1);
        expect(Math.abs(cmd.moveZ)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("presses E once and holds it across ticks while gathering", () => {
    const t = table();
    for (let i = 0; i < 400; i++) t.step();
    const buttons = t.log.map((tick) => tick.get("bot-1")!.buttons);
    const press = buttons.findIndex((b) => (b & BTN.INTERACT_PRESS) !== 0);
    expect(press).toBeGreaterThanOrEqual(0);
    // INTERACT (level) held from the press on for the whole channel: three wood at 2.5 s each.
    let held = 0;
    for (let i = press; i < buttons.length && buttons[i]! & BTN.INTERACT; i++) held++;
    expect(held).toBeGreaterThanOrEqual(secToTicks(2.5) * 3);
    expect(t.state.nodes[0]).toBe(0);
    const p = t.state.players.get("bot-1")!;
    expect(p.inv0 === "wood" || p.inv1 === "wood").toBe(true);
    // Edge bits never stay down for two ticks in a row.
    for (const bit of EDGES) {
      for (let i = 1; i < buttons.length; i++) expect((buttons[i - 1]! & bit) !== 0 && (buttons[i]! & bit) !== 0).toBe(false);
    }
  });

  it("continues a taken-over seat from its lastSeq, with a role from the character", () => {
    const t = table();
    const human = player("h1", -2, -2, false);
    human.character = "amca";
    human.lastSeq = 1234;
    human.seat = 0;
    t.state.players.set(human.id, human);
    t.desk.add(human.id, roleForCharacter(human.character));
    expect(t.desk.roleOf("h1")).toBe("bekci");
    t.step();
    expect(t.log[0]!.get("h1")!.seq).toBe(1235);
    t.step();
    expect(t.log[1]!.get("h1")!.seq).toBe(1236);
    t.desk.remove("h1");
    t.step();
    expect(t.log[2]!.has("h1")).toBe(false);
    expect(t.desk.size).toBe(2);
  });

  it("sends nothing for washed seats or outside the simulated phases", () => {
    const t = table();
    t.state.players.get("bot-2")!.alive = false;
    t.step();
    expect([...t.log[0]!.keys()]).toEqual(["bot-1"]);
    t.state.phase = "lobby";
    t.step();
    expect(t.log[1]!.size).toBe(0);
  });

  it("stands still while input is locked (landing wake-up)", () => {
    const t = table();
    t.state.phase = "landing";
    t.state.phaseTicksLeft = timingsFor(false).landing;
    t.step();
    for (const cmd of t.log[0]!.values()) {
      expect(cmd.buttons).toBe(0);
      expect(cmd.moveX).toBe(0);
      expect(cmd.moveZ).toBe(0);
    }
  });

  it("reset() keeps the seats and keeps seqs increasing", () => {
    const t = table();
    for (let i = 0; i < 10; i++) t.step();
    const before = t.log[9]!.get("bot-1")!.seq;
    t.desk.reset();
    expect(t.desk.size).toBe(2);
    t.step();
    expect(t.log[10]!.get("bot-1")!.seq).toBeGreaterThan(before);
  });

  it("maps every character to a stand-in role (the only character → role table)", () => {
    expect(roleForCharacter("kaptan")).toBe("hamal");
    expect(roleForCharacter("fenomen")).toBe("asci");
    expect(roleForCharacter("amca")).toBe("bekci");
    expect(roleForCharacter("gelin")).toBe("balikci");
    expect(roleForCharacter("sef")).toBe("asci");
    expect(roleForCharacter("cocuk")).toBe("hamal");
    expect(Object.keys(ROLE_BY_CHARACTER).sort()).toEqual([...CHARACTER_IDS].sort());
    // Every role is somebody's: a full room of tourists still gets all four personalities.
    expect(new Set(Object.values(ROLE_BY_CHARACTER))).toEqual(new Set<BotRole>(["hamal", "balikci", "bekci", "asci"]));
    expect(roleForCharacter("nobody" as CharacterId)).toBe("hamal");
  });
});

/** Every button a reconnect stand-in must never send (they spend, move or add an item). */
const SPENDING = BTN.THROW | BTN.USE_PRESS | BTN.CATCH | BTN.DROP | BTN.EAT | BTN.SLOT1 | BTN.SLOT2 | BTN.SLOT3 | BTN.SLOT4 | BTN.SLOT_NEXT | BTN.SLOT_PREV;

/** A dropped human ("h1", connected = false) right by the tree, hungry and thirsty, with food, water and wood. */
function dropped(t: Table): PlayerState {
  const h = player("h1", 2.6, -1.6, false);
  h.connected = false;
  h.character = "sef";
  h.seat = 0;
  h.hunger = 10;
  h.thirst = 10;
  setSlot(h, 0, "wood", 2);
  setSlot(h, 1, "water", 2);
  setSlot(h, 2, "coconut", 2);
  t.state.players.set(h.id, h);
  return h;
}

describe("BotDesk reconnect stand-ins", () => {
  it("masks a stand-in's buttons: movement, and E only to revive or board", () => {
    const p = player("h1", 0, 0, false);
    expect(standInButtons(BUTTON_MASK, p, false)).toBe(BTN.JUMP | BTN.SPRINT);
    expect(standInButtons(BUTTON_MASK, p, true)).toBe(BTN.JUMP | BTN.SPRINT | BTN.INTERACT | BTN.INTERACT_PRESS);
    // Holding E only keeps a revive going; a gather channel the player started is let go.
    p.channel = CHANNEL.GATHER;
    expect(standInButtons(BTN.INTERACT, p, false)).toBe(0);
    // ... even when E is pressed to revive or board: the server ignores a press mid-channel, and held E chops on.
    expect(standInButtons(BTN.INTERACT_PRESS | BTN.INTERACT, p, true)).toBe(0);
    p.channel = CHANNEL.REVIVE;
    expect(standInButtons(BTN.INTERACT, p, false)).toBe(BTN.INTERACT);
    p.channel = CHANNEL.NONE;
    // A stinging jellyfish leaves the hand: to an empty slot first, never onto a torch (it would burn down).
    setSlot(p, 0, "jellyfish", 1);
    setSlot(p, 1, "torch", 1);
    setSlot(p, 2, "wood", 2);
    expect(standInButtons(0, p, false)).toBe(BTN.SLOT4);
    setSlot(p, 3, "stone", 1);
    expect(standInButtons(0, p, false)).toBe(BTN.SLOT3);
    // A charge the player held when they dropped is cancelled by a slot change instead of released as a throw.
    setSlot(p, 0, "coconut", 1);
    p.chargeTicks = 6;
    expect(standInButtons(BTN.THROW, p, false)).toBe(BTN.SLOT3);
    setSlot(p, 2, "jellyfish", 1);
    setSlot(p, 3, "jellyfish", 1);
    expect(standInButtons(0, p, false)).toBe(BTN.THROW); // nowhere safe to switch to: keep holding, never release
    p.chargeTicks = 0;
    setSlot(p, 0, "wood", 1);
    expect(standInButtons(0, p, false)).toBe(0);
  });

  it("never eats, throws, tosses, uses, crafts or chats for the absent player; a full bot of the seat does", () => {
    const t = table();
    const h = dropped(t);
    // They dropped mid-chop: the stand-in lets go of the channel instead of chopping on.
    h.channel = CHANNEL.GATHER;
    h.channelTarget = 0;
    const inv = JSON.stringify(slotsOf(h));
    t.desk.add(h.id, roleForCharacter(h.character), { standIn: true });
    expect(t.desk.isStandIn(h.id)).toBe(true);
    for (let i = 0; i < secToTicks(20); i++) t.step();
    const sent = t.log.map((tick) => tick.get(h.id)!);
    expect(sent.every((cmd) => (cmd.buttons & SPENDING) === 0)).toBe(true);
    expect(sent.every((cmd) => (cmd.buttons & (BTN.INTERACT | BTN.INTERACT_PRESS)) === 0)).toBe(true);
    expect(h.channel).toBe(CHANNEL.NONE);
    expect(JSON.stringify(slotsOf(h))).toBe(inv);
    expect(t.calls.filter((c) => c.endsWith(":h1"))).toEqual([]);
    // They left for good: the same seat, re-added as a full bot (no remove() first), eats and drinks at once.
    t.desk.add(h.id, roleForCharacter(h.character));
    expect(t.desk.isStandIn(h.id)).toBe(false);
    const from = t.log.length;
    for (let i = 0; i < secToTicks(5); i++) t.step();
    expect(t.log.slice(from).some((tick) => (tick.get(h.id)!.buttons & BTN.EAT) !== 0)).toBe(true);
  });

  it("cancels a throw the player was charging when they dropped instead of releasing it", () => {
    const t = table();
    const h = dropped(t);
    h.activeSlot = 2; // the coconuts
    h.chargeTicks = 8;
    t.desk.add(h.id, roleForCharacter(h.character), { standIn: true });
    for (let i = 0; i < 60; i++) t.step();
    expect(t.throws).toEqual([]);
    expect(t.log[0]!.get(h.id)!.buttons).toBe(BTN.SLOT4); // the empty slot
    expect(h.chargeTicks).toBe(0);
    expect(h.activeSlot).toBe(3);
    // The same drop driven by a full bot's input (no stand-in mask) lets go and throws.
    const u = table();
    const g = dropped(u);
    g.hunger = g.thirst = 100; // nothing to eat first (an eat would switch slots and cancel the charge too)
    g.activeSlot = 2;
    g.chargeTicks = 8;
    u.desk.add(g.id, roleForCharacter(g.character));
    u.step();
    expect(u.throws).toEqual(["h1"]);
  });

  it("re-adding a seat resets it for its new mandate, and keeps the plan when nothing changes", () => {
    const t = table();
    const h = dropped(t);
    t.desk.add(h.id, "asci");
    for (let i = 0; i < 40; i++) t.step();
    const key = t.desk.goalOf("bot-1");
    expect(key).not.toBe("");
    t.desk.add("bot-1", "hamal");
    expect(t.desk.goalOf("bot-1")).toBe(key);
    // Full bot → stand-in (a takeOver undone) and remove() + add() (the room's takeOver): each starts afresh.
    t.desk.add(h.id, "asci", { standIn: true });
    expect(t.desk.goalOf(h.id)).toBe("");
    const from = t.log.length;
    for (let i = 0; i < secToTicks(10); i++) t.step();
    expect(t.log.slice(from).every((tick) => (tick.get(h.id)!.buttons & SPENDING) === 0)).toBe(true);
    t.desk.remove(h.id);
    t.desk.add(h.id, "asci");
    expect(t.desk.isStandIn(h.id)).toBe(false);
    const back = t.log.length;
    for (let i = 0; i < secToTicks(5); i++) t.step();
    expect(t.log.slice(back).some((tick) => (tick.get(h.id)!.buttons & BTN.EAT) !== 0)).toBe(true);
  });

  it("gives a stand-in no team duty: the other bots see it as driven, with no role", () => {
    const t = table();
    const h = dropped(t);
    t.desk.add(h.id, "bekci", { standIn: true });
    const island = t.world.island;
    const view = (standIns: ReadonlySet<string>) =>
      buildView({
        state: t.state,
        island,
        timings: t.world.timings,
        query: { terrain: island.grid, cover: t.world.cover, bounds: island.bounds },
        id: "bot-1",
        role: "hamal",
        roles: new Map<string, BotRole>([
          ["bot-1", "hamal"],
          ["bot-2", "balikci"],
          ["h1", "bekci"],
        ]),
        standIns,
        velocity: new Map(),
        claims: { nodes: new Set(), items: new Set(), crabs: new Set(), spots: new Set() },
        blocked: () => false,
        current: null,
        roll: 0.5,
      })!;
    const seen = view(new Set(["h1"]));
    expect(seen.mates.find((m) => m.id === "h1")).toMatchObject({ driven: true, human: false, role: "" });
    expect(dutyOwner(seen, "guard")).toBe("bot-1");
    // Read as a full Bekçi it would have taken the night guard.
    expect(dutyOwner(view(new Set()), "guard")).toBe("h1");
  });
});

describe("BotDesk memory stays bounded", () => {
  it("prunes expired goal blocks on every think instead of piling them up over the match", () => {
    const t = table();
    t.desk.remove("bot-2");
    t.state.nodes[0] = 0; // nothing to chop: the only goals that fail are the pickups below
    const p = t.state.players.get("bot-1")!;
    let most = 0;
    for (let round = 0; round < 12; round++) {
      // A coconut at its feet, gone again the moment the bot goes for it: one more failed (blocked) goal.
      const c = new ProjectileEntity();
      c.id = `p${round}`;
      c.kind = "coconut";
      c.state = "rest";
      c.x = p.x + 1;
      c.y = p.y;
      c.z = p.z;
      t.state.projectiles.set(c.id, c);
      for (let i = 0; i < 120 && t.desk.goalOf("bot-1") !== `pickup:${c.id}`; i++) t.step();
      expect(t.desk.goalOf("bot-1")).toBe(`pickup:${c.id}`);
      t.state.projectiles.delete(c.id);
      for (let i = 0; i < 45; i++) {
        t.step();
        most = Math.max(most, t.desk.footprint().blocked);
      }
    }
    // A failed pickup stays blocked 2 s (60 ticks): with one failure every ~1.5–2 s at most a few are live.
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(3);
    for (let i = 0; i < secToTicks(4); i++) t.step();
    expect(t.desk.footprint().blocked).toBe(0);
  });

  it("forgets monsters that are gone (tracks, bosses already called out) and clears with the last seat", () => {
    const t = table();
    const monster = (id: string, kind: MonsterState["kind"], x: number, z: number): void => {
      const m = new MonsterState();
      m.id = id;
      m.kind = kind;
      m.mode = "hunt";
      m.x = x;
      m.y = 1;
      m.z = z;
      t.state.monsters.set(id, m);
    };
    for (let night = 0; night < 3; night++) {
      monster(`m${night}a`, "crab", 10, 10);
      monster(`m${night}b`, "crab", -10, 10);
      monster(`boss${night}`, "boss", 0, 12);
      for (let i = 0; i < secToTicks(2); i++) t.step();
      expect(t.desk.footprint()).toMatchObject({ tracks: 3, bossSpotted: 1 });
      // Dawn: the wave flees and despawns.
      t.state.monsters.clear();
      t.step();
      expect(t.desk.footprint()).toMatchObject({ tracks: 0, bossSpotted: 0 });
    }
    // Each night's boss was a new one: called out ("Tehlike!") once per night.
    expect(t.calls.filter((c) => c.startsWith("marker:")).length).toBe(3);
    monster("m9", "crab", 10, 10);
    t.step();
    t.desk.remove("bot-1");
    t.desk.remove("bot-2");
    expect(t.desk.footprint()).toEqual({ blocked: 0, tracks: 0, bossSpotted: 0 });
  });
});
