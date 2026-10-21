// View models from a fake decoded state: HUD bars / slots / prompt / fishing / raft parts / fire / compass
// bearings / downed / washed, the craft + chest panels, the lobby and the podium. Owner: client-app.
// Run: npx vitest run games/raft-rush/client/src/app

import { describe, expect, it } from "vitest";
import {
  CHANNEL,
  DAYS,
  FIRE_START_FUEL_TICKS,
  FISH_STATE,
  NORMAL_TIMINGS,
  REVIVE_TICKS,
  SOLO_AUTO_BOTS,
  STORM_WARN_SEC,
  TICK_RATE,
  TORCH_BURN_TICKS,
  playerColor,
} from "../../../shared/constants";
import type { IslandDef } from "../../../shared/island/types";
import type { MatchEndEvent } from "../../../shared/protocol";
import { emptyInteraction, type Interaction } from "../../../shared/rules/interact";
import { cycleTicks, matchTicks } from "../../../shared/rules/schedule";
import type { PlayerView, RaftStateView } from "../../../shared/types";
import type { PingMark } from "./frameHelpers";
import { fakeMonster, fakePlayer, fakeState, fakeTeam, testIsland } from "./testkit";
import {
  buildChestPanel,
  buildCraftPanel,
  buildHudModel,
  buildLobbyModel,
  buildMatchEndModel,
  buildScoreRows,
  PlayerDirectory,
  raftParts,
  type HudInputs,
} from "./viewModels";

function island(): IslandDef {
  const def = testIsland();
  const site = def.sites[0]!;
  // Landmarks at known bearings from the origin: camp due "north" (−Z), raft due "east" (+X).
  site.campfire = { x: 0, z: -10 };
  site.raft = { x: 10, z: 0, yaw: 0 };
  site.spring = { x: -5, z: 0 };
  site.chest = { x: 1, z: -9 };
  site.secretChest = { x: 0, z: 12 };
  return def;
}

function inputs(state: RaftStateView, def: IslandDef, me: PlayerView | null, over: Partial<HudInputs> = {}): HudInputs {
  return {
    state,
    phase: state.phase,
    island: def,
    me,
    sim: me,
    origin: me ? { x: me.x, z: me.z, yaw: me.yaw } : null,
    timings: NORMAL_TIMINGS,
    clockTicks: state.clockTicks,
    serverTick: state.tick,
    interaction: null,
    lmb: null,
    fishBite: null,
    willRespawn: null,
    pings: [],
    known: { spring: false, cave: false },
    monsters: [],
    cinematic: false,
    needsPointer: false,
    reducedFlashing: false,
    ...over,
  };
}

function gatherWood(node: number): Interaction {
  const it = emptyInteraction();
  it.kind = "gather";
  it.hold = true;
  it.channel = CHANNEL.GATHER;
  it.ticks = 75;
  it.node = node;
  it.item = "wood";
  it.ok = true;
  return it;
}

describe("HUD model: bars, slots, prompt", () => {
  it("normalizes the bars and flags the low ones", () => {
    const me = fakePlayer("me", 0, 0, { hp: 50, hunger: 20, thirst: 100, warmth: 29 });
    const def = island();
    const hud = buildHudModel(inputs(fakeState([me], {}, def), def, me));
    expect(hud.hp).toBeCloseTo(0.5);
    expect(hud.hunger).toBeCloseTo(0.2);
    expect(hud.thirst).toBe(1);
    expect(hud.low).toEqual({ hp: false, hunger: true, thirst: false, warmth: true });
  });

  it("builds the four slots with counts and torch / puffer meters, active slot from the prediction", () => {
    const me = fakePlayer("me", 0, 0, { inv0: "wood", cnt0: 3, inv1: "torch", cnt1: 1, torchTicks: TORCH_BURN_TICKS / 2, inv3: "puffer", cnt3: 1, fuseTicks: 75 });
    const sim = { ...me, activeSlot: 1 };
    const def = island();
    const hud = buildHudModel(inputs(fakeState([me], {}, def), def, me, { sim }));
    expect(hud.slots).toEqual([
      { kind: "wood", count: 3, meter: -1 },
      { kind: "torch", count: 1, meter: 0.5 },
      { kind: "", count: 0, meter: -1 },
      { kind: "puffer", count: 1, meter: 0.5 },
    ]);
    expect(hud.activeSlot).toBe(1);
  });

  it("turns a gather interaction into a hold prompt with the channel progress", () => {
    const me = fakePlayer("me");
    const def = island();
    def.nodes.push({ i: 0, kind: "tree", x: 1, z: -1, y: 1, radius: 0.35, height: 3, yield: "none", amount: 3, island: 0, yaw: 0, scale: 1, variant: 0 });
    const sim = { ...me, channel: CHANNEL.GATHER, channelTarget: 0, channelTicks: 30 };
    const hud = buildHudModel(inputs(fakeState([me], {}, def), def, me, { sim, interaction: gatherWood(0) }));
    expect(hud.prompt).toMatchObject({ kind: "gather", key: "prompt.gather_wood", keyGlyph: "E", hold: true, ok: true, reason: "" });
    expect(hud.prompt!.progress).toBeCloseTo(30 / 75);
    expect(hud.crosshair).toBe("interact");
  });

  it("strike beats E, E (ok) beats the LMB hints, and a greyed-out E keeps its reason", () => {
    const me = fakePlayer("me");
    const def = island();
    const state = fakeState([me], {}, def);
    const it = gatherWood(0);
    expect(buildHudModel(inputs(state, def, me, { interaction: it, lmb: "strike" })).prompt?.key).toBe("prompt.strike");
    expect(buildHudModel(inputs(state, def, me, { interaction: it, lmb: "palm" })).prompt?.key).toBe("prompt.gather_wood");
    const full = emptyInteraction();
    full.kind = "pickup";
    full.item = "coconut";
    full.ok = false;
    full.reason = "full";
    expect(buildHudModel(inputs(state, def, me, { interaction: full, lmb: "palm" })).prompt?.key).toBe("prompt.palm");
    const hud = buildHudModel(inputs(state, def, me, { interaction: full }));
    expect(hud.prompt).toMatchObject({ key: "prompt.pickup", ok: false, reason: "full" });
    expect(typeof hud.prompt!.params!.item).toBe("string");
  });

  it("shows the throw crosshair while charging and hides it in cinematics", () => {
    const me = fakePlayer("me", 0, 0, { inv0: "coconut", cnt0: 1 });
    const def = island();
    const state = fakeState([me], {}, def);
    expect(buildHudModel(inputs(state, def, me)).crosshair).toBe("throw");
    expect(buildHudModel(inputs(state, def, me, { sim: { ...me, chargeTicks: 9 } })).charge).toBeCloseTo(0.5);
    expect(buildHudModel(inputs(state, def, me, { cinematic: true })).crosshair).toBe("hidden");
  });
});

describe("HUD model: fishing, raft, fire, clock", () => {
  it("runs the bite window from the fishBite event down to 0", () => {
    const def = island();
    const me = fakePlayer("me", 0, 0, { fishState: FISH_STATE.BITE });
    const state = fakeState([me], {}, def);
    const hud = buildHudModel(inputs(state, def, me, { fishBite: { tick: 100, windowTicks: 18 }, serverTick: 109 }));
    expect(hud.fishing).toEqual({ state: "bite", windowFrac: 0.5 });
    const cast = buildHudModel(inputs(fakeState([{ ...me, fishState: FISH_STATE.CAST }], {}, def), def, { ...me, fishState: FISH_STATE.CAST }));
    expect(cast.fishing).toEqual({ state: "cast", windowFrac: 0 });
  });

  it("lists every raft requirement with have clamped to need, plus aboard / total", () => {
    const def = island();
    const me = fakePlayer("me");
    const mate = fakePlayer("mate", 3, 3, { boarded: true });
    const team = fakeTeam({ seats: 4, stage: 1, hullWood: 18, mastWood: 2, mastRope: 1 });
    const state = fakeState([me, mate], { teams: [team] }, def);
    const hud = buildHudModel(inputs(state, def, me));
    expect(hud.raft.stage).toBe(1);
    expect(hud.raft.parts).toEqual([
      { part: "hullWood", have: 16, need: 16 },
      { part: "mastWood", have: 2, need: 4 },
      { part: "mastRope", have: 1, need: 6 },
      { part: "food", have: 0, need: 4 },
      { part: "water", have: 0, need: 4 },
    ]);
    expect(hud.raft.aboard).toBe(1);
    expect(hud.raft.total).toBe(2);
    expect(raftParts(team, { hullWood: 1, mastWood: 1, mastRope: 1, food: 1, water: 1 })[0]).toEqual({ part: "hullWood", have: 1, need: 1 });
  });

  it("fire: lit / low / seconds left (rain drains ×3)", () => {
    const def = island();
    const me = fakePlayer("me");
    const low = fakeState([me], { teams: [fakeTeam({ fireFuel: 0.1 * FIRE_START_FUEL_TICKS })] }, def);
    expect(buildHudModel(inputs(low, def, me)).fire).toMatchObject({ lit: true, low: true });
    const out = fakeState([me], { teams: [fakeTeam({ fireFuel: 0 })] }, def);
    expect(buildHudModel(inputs(out, def, me)).fire).toMatchObject({ lit: false, low: false, secLeft: 0 });
    const rain = fakeState([me], { weather: "rain", teams: [fakeTeam({ fireFuel: 30 * TICK_RATE })] }, def);
    expect(buildHudModel(inputs(rain, def, me)).fire.secLeft).toBeCloseTo(10);
  });

  it("clock: the landing shows day 1 untouched; the last night warns before the storm", () => {
    const def = island();
    const me = fakePlayer("me");
    const landing = fakeState([me], { phase: "landing", phaseTicksLeft: 150, clockTicks: 0 }, def);
    const l = buildHudModel(inputs(landing, def, me));
    expect(l).toMatchObject({ day: 1, days: DAYS, dayPhase: "day", phaseSecLeft: NORMAL_TIMINGS.day / TICK_RATE });
    expect(l.stormSecLeft).toBeCloseTo((matchTicks(NORMAL_TIMINGS) + 150) / TICK_RATE);
    const end = matchTicks(NORMAL_TIMINGS) - (STORM_WARN_SEC - 5) * TICK_RATE;
    const lastNight = fakeState([me], { clockTicks: end }, def);
    const h = buildHudModel(inputs(lastNight, def, me, { clockTicks: end }));
    expect(h).toMatchObject({ day: DAYS, dayPhase: "night", stormWarning: true });
    const early = fakeState([me], { clockTicks: cycleTicks(NORMAL_TIMINGS) + 10 }, def);
    expect(buildHudModel(inputs(early, def, me, { clockTicks: early.clockTicks })).stormWarning).toBe(false);
  });
});

describe("HUD model: downed, washed, launch", () => {
  it("downed: seconds left and the revive progress of whoever channels on my seat", () => {
    const def = island();
    const me = fakePlayer("me", 0, 0, { downed: true, downedTicks: 5 * TICK_RATE, seat: 2, hp: 0 });
    const medic = fakePlayer("medic", 1, 0, { channel: CHANNEL.REVIVE, channelTarget: 2, channelTicks: REVIVE_TICKS / 2 });
    const hud = buildHudModel(inputs(fakeState([me, medic], {}, def), def, me));
    expect(hud.downed).toEqual({ secLeft: 5, revive: 0.5 });
  });

  it("washed: waits for the next dawn, unless it's the last day", () => {
    const def = island();
    const me = fakePlayer("me", 0, 0, { washed: true, alive: false });
    const night1 = NORMAL_TIMINGS.day + NORMAL_TIMINGS.dusk + 10;
    const hud = buildHudModel(inputs(fakeState([me], { clockTicks: night1 }, def), def, me, { clockTicks: night1, willRespawn: true }));
    expect(hud.washed?.willRespawn).toBe(true);
    expect(hud.washed?.secToDawn).toBeCloseTo((NORMAL_TIMINGS.night - 10) / TICK_RATE);
    expect(hud.crosshair).toBe("hidden");
    const day3 = 2 * cycleTicks(NORMAL_TIMINGS) + 30;
    expect(buildHudModel(inputs(fakeState([me], { clockTicks: day3 }, def), def, me, { clockTicks: day3 })).washed?.willRespawn).toBe(false);
  });

  it("boarding countdown while the raft waits for the rest", () => {
    const def = island();
    const me = fakePlayer("me", 10, 0, { boarded: true });
    const mate = fakePlayer("mate", 0, 0);
    const state = fakeState([me, mate], { launchTicksLeft: 15 * TICK_RATE, teams: [fakeTeam({ stage: 3 })] }, def);
    const hud = buildHudModel(inputs(state, def, me));
    expect(hud.launch).toEqual({ secLeft: 15, aboard: 1, total: 2 });
    expect(hud.boarded).toBe(true);
    expect(hud.raft.ready).toBe(true);
  });
});

describe("HUD model: compass", () => {
  it("puts the camp and the raft at their world bearings (yaw convention: 0 = −Z)", () => {
    const def = island();
    const me = fakePlayer("me");
    const hud = buildHudModel(inputs(fakeState([me], {}, def), def, me));
    const camp = hud.compass.marks.find((m) => m.kind === "camp")!;
    const raft = hud.compass.marks.find((m) => m.kind === "raft")!;
    expect(camp.bearing).toBeCloseTo(0);
    expect(camp.dist).toBeCloseTo(10);
    expect(raft.bearing).toBeCloseTo(-Math.PI / 2);
    expect(raft.dist).toBeCloseTo(10);
    expect(hud.compass.marks.some((m) => m.kind === "spring")).toBe(false);
    expect(hud.compass.yaw).toBe(0);
  });

  it("adds known / revealed landmarks, teammates, pings; fog keeps only the pings", () => {
    const def = island();
    const me = fakePlayer("me");
    const mate = fakePlayer("mate", 0, 5, { seat: 1, downed: true });
    const team = fakeTeam({ secretRevealed: true });
    const ping: PingMark = { playerId: "mate", kind: "need", pos: { x: -3, y: 0, z: 0 }, need: "wood", expiresAt: 1e9 };
    const state = fakeState([me, mate], { teams: [team] }, def);
    const hud = buildHudModel(inputs(state, def, me, { known: { spring: true, cave: false }, pings: [ping] }));
    const kinds = hud.compass.marks.map((m) => m.kind).sort();
    expect(kinds).toEqual(["camp", "ping", "player", "raft", "secret", "spring"]);
    const mateMark = hud.compass.marks.find((m) => m.kind === "player")!;
    expect(mateMark).toMatchObject({ label: "MATE", color: playerColor(1), icon: "🤕" });
    expect(mateMark.bearing).toBeCloseTo(Math.PI);
    const pingMark = hud.compass.marks.find((m) => m.kind === "ping")!;
    expect(pingMark.bearing).toBeCloseTo(Math.PI / 2);
    expect(pingMark.icon).toBe("🪵");
    const fog = buildHudModel(inputs(fakeState([me, mate], { weather: "fog", teams: [team] }, def), def, me, { pings: [ping] }));
    expect(fog.compass.marks.map((m) => m.kind)).toEqual(["ping"]);
  });

  it("monsters near at night show as danger (nearest first), never by day", () => {
    const def = island();
    const me = fakePlayer("me");
    const night = NORMAL_TIMINGS.day + NORMAL_TIMINGS.dusk + 30;
    const monsters = [
      fakeMonster("far", { x: 0, z: 50 }),
      fakeMonster("near", { x: 5, z: 0 }),
      fakeMonster("boss", { kind: "boss", x: 0, z: 8 }),
      fakeMonster("fled", { x: 2, z: 0, mode: "flee" }),
    ];
    const hud = buildHudModel(inputs(fakeState([me], { clockTicks: night }, def), def, me, { clockTicks: night, monsters }));
    const danger = hud.compass.marks.filter((m) => m.kind === "danger");
    expect(danger.map((m) => m.dist)).toEqual([5, 8]);
    expect(danger[1]!.icon).toBe("👑");
    const day = buildHudModel(inputs(fakeState([me], {}, def), def, me, { monsters }));
    expect(day.compass.marks.some((m) => m.kind === "danger")).toBe(false);
  });

  it("the spyglass shows the nearest resources of each kind", () => {
    const def = island();
    for (let i = 0; i < 5; i++) def.nodes.push({ i, kind: "rock", x: i + 2, z: 0, y: 1, radius: 0.6, height: 1, yield: "none", amount: 2, island: 0, yaw: 0, scale: 1, variant: 0 });
    const me = fakePlayer("me");
    const state = fakeState([me], { teams: [fakeTeam({ spyglassTicks: 100 })] }, def);
    const hud = buildHudModel(inputs(state, def, me));
    const rocks = hud.compass.marks.filter((m) => m.kind === "resource" && m.icon === "🪨");
    expect(rocks.map((m) => m.dist)).toEqual([2, 3, 4]);
  });
});

describe("panels", () => {
  it("craft rows count the inventory plus the chest, need a lit fire (except fuel) and hide locked / duel recipes", () => {
    const me = fakePlayer("me", 0, 0, { inv0: "wood", cnt0: 1 });
    const team = fakeTeam({ chest: new Map([["stone", 1]]) });
    const state = fakeState([me], { teams: [team] });
    const panel = buildCraftPanel(state, me);
    const spear = panel.recipes.find((r) => r.id === "spear")!;
    expect(spear.cost).toEqual([
      { kind: "wood", have: 1, need: 1 },
      { kind: "stone", have: 1, need: 1 },
    ]);
    expect(spear.ok).toBe(true);
    expect(panel.recipes.find((r) => r.id === "coconut_ball")).toMatchObject({ locked: true, ok: false });
    expect(panel.recipes.some((r) => r.id === "hut" || r.id === "canoe")).toBe(false);
    const out = buildCraftPanel(fakeState([me], { teams: [fakeTeam({ fireFuel: 0, chest: new Map([["stone", 1]]) })] }), me);
    expect(out.fireLit).toBe(false);
    expect(out.recipes.find((r) => r.id === "spear")!.ok).toBe(false);
    expect(out.recipes.find((r) => r.id === "fuel")!.ok).toBe(true);
  });

  it("chest contents in item order, plus the hotbar", () => {
    const me = fakePlayer("me", 0, 0, { inv2: "rope", cnt2: 2 });
    const team = fakeTeam({ chest: new Map([["coconut", 2], ["wood", 7], ["junk", 3], ["stone", 0]]) });
    const panel = buildChestPanel(fakeState([me], { teams: [team] }), me, 2);
    expect(panel.chest).toEqual([
      { kind: "wood", count: 7 },
      { kind: "coconut", count: 2 },
    ]);
    expect(panel.slots[2]).toEqual({ kind: "rope", count: 2, meter: -1 });
    expect(panel.activeSlot).toBe(2);
  });

  it("scoreboard rows sort by score, skip spectators", () => {
    const a = fakePlayer("a", 0, 0, { score: 5, seat: 0 });
    const b = fakePlayer("b", 0, 0, { score: 9, seat: 1 });
    const c = fakePlayer("c", 0, 0, { score: 50, seat: 2, spectator: true });
    const rows = buildScoreRows(fakeState([a, b, c]), "a");
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows[1]!.you).toBe(true);
  });
});

describe("lobby and podium", () => {
  it("lobby: host, readiness, bots, auto bots and the Start hint", () => {
    const host = fakePlayer("host", 0, 0, { seat: 0 });
    const guest = fakePlayer("guest", 0, 0, { seat: 1, ready: false });
    const state = fakeState([host, guest], { phase: "lobby" });
    const lobby = buildLobbyModel(state, "host", "ABCD", "https://x/r/ABCD", (c) => `img:${c}`);
    expect(lobby).toMatchObject({ code: "ABCD", isHost: true, canStart: false, startHint: "menu.startHint_notReady", canAddBot: true, autoBots: 0 });
    expect(lobby.players.map((p) => p.id)).toEqual(["host", "guest"]);
    expect(lobby.players[0]!.portrait).toBe("img:kaptan");
    const ready = buildLobbyModel(fakeState([host, { ...guest, ready: true }], { phase: "lobby" }), "host", "ABCD", "", () => "");
    expect(ready.canStart).toBe(true);
    const asGuest = buildLobbyModel(state, "guest", "ABCD", "", () => "");
    expect(asGuest).toMatchObject({ isHost: false, canStart: false, startHint: "menu.startHint_host" });
    const solo = buildLobbyModel(fakeState([host], { phase: "lobby" }), "host", "ABCD", "", () => "");
    expect(solo).toMatchObject({ canStart: true, autoBots: SOLO_AUTO_BOTS });
  });

  it("podium: standings order, win flag, rematch timing, players who left", () => {
    const me = fakePlayer("me", 0, 0, { seat: 0 });
    const bot = fakePlayer("bot-1", 0, 0, { seat: 1, bot: true });
    const gone = fakePlayer("gone", 0, 0, { seat: 2 });
    const dir = new PlayerDirectory(() => fakeState([me, bot, gone]));
    dir.view("gone");
    const state = fakeState([me, bot], { phase: "matchEnd", phaseTicksLeft: NORMAL_TIMINGS.matchEndLobby - 4 * TICK_RATE, winnerTeam: 0, winReason: "launched" });
    const stats = buildScoreRows(state, "me")[0]!.stats;
    const ev: MatchEndEvent = {
      tick: 1,
      winnerTeam: 0,
      reason: "launched",
      ticksLeft: 40 * TICK_RATE,
      teamScores: [812],
      mvpId: "bot-1",
      standings: [
        { id: "me", place: 2, score: 10, team: 0, titles: ["tourist"], stats, aboard: true },
        { id: "bot-1", place: 1, score: 30, team: 0, titles: ["mvp", "porter"], stats, aboard: true },
        { id: "gone", place: 3, score: 1, team: 0, titles: [], stats, aboard: false },
      ],
      seed: 42,
      biome: "swamp",
    };
    const model = buildMatchEndModel(state, "me", ev, NORMAL_TIMINGS, dir);
    expect(model).toMatchObject({ win: true, reason: "launched", secLeft: 40, teamScore: 812, seed: 42, biome: "swamp", mvpId: "bot-1", canRematch: true, secToLobby: 56 });
    expect(model.rows.map((r) => r.id)).toEqual(["bot-1", "me", "gone"]);
    expect(model.rows[2]).toMatchObject({ nickname: "GONE", color: playerColor(2) });
    expect(model.rows[1]).toMatchObject({ you: true, titles: ["tourist"] });
    const lost = buildMatchEndModel({ ...state, winnerTeam: -1, winReason: "storm" }, "me", null, NORMAL_TIMINGS, null);
    expect(lost.win).toBe(false);
    expect(lost.rows.map((r) => r.place)).toEqual([1, 2]);
  });
});
