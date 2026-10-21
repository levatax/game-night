// UI harness: drives the real Ui facade with mock models so every screen, HUD state, panel, wheel and reel can be
// seen (and screenshotted) without a server. Owner: client-ui. ?state=<id> opens a state directly, ?anim=0 freezes
// the HUD animation (compass turning, clock running) for stable screenshots. Every UiEventMap event is logged.

import { CHARACTER_IDS, PLAYER_COLORS } from "../../shared/constants";
import { RECIPES, RECIPE_IDS, raftCost } from "../../shared/items";
import type { CharacterId, FishLoot, ItemKind, RecipeId, StatsView, TreasureId } from "../../shared/types";
import { settings } from "../src/app/settings";
import { setLanguage } from "../src/i18n";
import type {
  ChestPanelModel,
  CompassMark,
  CraftPanelModel,
  HomeModel,
  HudModel,
  LobbyModel,
  LobbyPlayerModel,
  MatchEndModel,
  ScoreRow,
  TeammateModel,
  UiEventMap,
} from "../src/ui/models";
import { Ui } from "../src/ui/Ui";

const params = new URLSearchParams(location.search);
const ui = new Ui(document.getElementById("ui")!);
const game = document.getElementById("game")!;
const dev = document.getElementById("dev")!;
let animate = params.get("anim") !== "0";
let hud: HudModel | null = null;
let t0 = performance.now();

/* ================================================================== mocks */

const NAMES = ["Ada", "Bahri", "Mercan", "Yakamoz", "Poyraz", "Lodos"];

function stats(seed: number): StatsView {
  const r = (k: number) => (seed * 7 + k * 13) % 17;
  return { gathered: r(1) + 3, delivered: r(2), hits: r(3) % 9, kills: r(4) % 6, revives: r(5) % 3, fish: r(6) % 5, eaten: r(7) % 8, coconuts: r(8) % 4, downs: r(9) % 3, crafted: r(10) % 6, raids: 0 };
}

function homeModel(over: Partial<HomeModel> = {}): HomeModel {
  return { nickname: "", joinCode: "", busy: false, error: null, language: settings.get().language, ...over };
}

function lobbyPlayer(i: number, over: Partial<LobbyPlayerModel> = {}): LobbyPlayerModel {
  return {
    id: i === 0 ? "me" : `p${i}`,
    nickname: NAMES[i] ?? `Player ${i}`,
    character: CHARACTER_IDS[i % CHARACTER_IDS.length]!,
    seat: i,
    color: PLAYER_COLORS[i]!,
    ready: i % 2 === 1,
    host: i === 0,
    bot: false,
    botRole: "",
    you: i === 0,
    connected: true,
    ping: 30 + i * 37,
    portrait: "",
    ...over,
  };
}

function lobbyModel(kind: "solo" | "full" | "guest"): LobbyModel {
  const players: LobbyPlayerModel[] = [lobbyPlayer(0, { ready: false })];
  if (kind !== "solo") {
    players.push(lobbyPlayer(1), lobbyPlayer(2, { ready: false, connected: false }));
    players.push(lobbyPlayer(3, { bot: true, botRole: "hamal", ready: true, nickname: "Bahri", character: "amca", ping: 0 }));
    players.push(lobbyPlayer(4, { bot: true, botRole: "bekci", ready: true, nickname: "Yakamoz", character: "cocuk", ping: 0 }));
  }
  if (kind === "guest") {
    players[0] = { ...players[0]!, host: false };
    players[1] = { ...players[1]!, host: true };
  }
  return {
    code: "KRAB",
    link: `${location.origin}/r/KRAB`,
    youId: "me",
    isHost: kind !== "guest",
    players,
    maxPlayers: 6,
    mode: "coop",
    difficulty: kind === "full" ? "nightmare" : "normal",
    seedSetting: kind === "full" ? 4471 : 0,
    previewSeed: 4471,
    biome: kind === "full" ? "volcanic" : "tropic",
    canAddBot: players.length < 6,
    canStart: kind === "solo",
    startHint: kind === "solo" ? "" : "menu.startHint_notReady",
    ready: false,
    autoBots: 2,
  };
}

function marks(yaw: number): CompassMark[] {
  void yaw;
  return [
    { kind: "camp", bearing: 0.4, dist: 18, color: "#FFB347", icon: "🔥", label: "" },
    { kind: "raft", bearing: -0.9, dist: 32, color: "#B07A45", icon: "🛶", label: "" },
    { kind: "spring", bearing: 2.2, dist: 41, color: "#3FB7D9", icon: "💧", label: "" },
    { kind: "ping", bearing: -0.25, dist: 9, color: "#3FA7F5", icon: "📍", label: "Bahri" },
    { kind: "player", bearing: 0.9, dist: 6, color: "#5CC25B", icon: "🙂", label: "" },
    { kind: "danger", bearing: -2.7, dist: 14, color: "#FF4D3A", icon: "⚠️", label: "" },
  ];
}

function mates(): TeammateModel[] {
  return [
    { id: "p1", nickname: "Mercan", character: "fenomen", color: PLAYER_COLORS[1]!, bot: false, hp: 0.8, downed: false, washed: false, boarded: false, connected: true },
    { id: "p2", nickname: "Bahri", character: "amca", color: PLAYER_COLORS[2]!, bot: true, hp: 0.2, downed: true, washed: false, boarded: false, connected: true },
    { id: "p3", nickname: "Yakamoz", character: "cocuk", color: PLAYER_COLORS[3]!, bot: true, hp: 0, downed: false, washed: true, boarded: false, connected: true },
    { id: "p4", nickname: "Poyraz", character: "sef", color: PLAYER_COLORS[4]!, bot: false, hp: 1, downed: false, washed: false, boarded: false, connected: false },
  ];
}

function baseHud(): HudModel {
  const cost = raftCost(4);
  return {
    phase: "playing",
    day: 2,
    days: 3,
    dayPhase: "day",
    phaseSecLeft: 95,
    stormSecLeft: 322,
    cycle: 0.12,
    weather: "clear",
    hp: 0.86,
    hunger: 0.64,
    thirst: 0.42,
    warmth: 1,
    low: { hp: false, hunger: false, thirst: false, warmth: false },
    slots: [
      { kind: "wood", count: 4, meter: -1 },
      { kind: "coconut", count: 2, meter: -1 },
      { kind: "torch", count: 1, meter: 0.62 },
      { kind: "", count: 0, meter: -1 },
    ],
    activeSlot: 1,
    prompt: { kind: "gather", key: "prompt.gather_wood", keyGlyph: "E", hold: true, progress: 0, ok: true, reason: "" },
    charge: 0,
    fishing: null,
    raft: {
      stage: 1,
      parts: [
        { part: "hullWood", have: cost.hullWood, need: cost.hullWood },
        { part: "mastWood", have: 3, need: cost.mastWood },
        { part: "mastRope", have: 2, need: cost.mastRope },
        { part: "food", have: 0, need: cost.food },
        { part: "water", have: 0, need: cost.water },
      ],
      ready: false,
      aboard: 0,
      total: 5,
    },
    fire: { frac: 0.55, lit: true, low: false, secLeft: 99 },
    compass: { yaw: 0, marks: marks(0) },
    downed: null,
    washed: null,
    boarded: false,
    launch: null,
    stormWarning: false,
    spectator: false,
    crosshair: "interact",
    teammates: mates(),
    needsPointer: false,
    reducedFlashing: settings.get().reducedFlashing,
  };
}

function craftModel(lit = true): CraftPanelModel {
  const have: Partial<Record<ItemKind, number>> = { wood: 5, stone: 1, rope: 0, fish_raw: 2, coconut: 2, crab_raw: 0, kraken: 0 };
  const ids = RECIPE_IDS.filter((id) => !RECIPES[id].duelOnly);
  return {
    fireLit: lit,
    fuelFrac: lit ? 0.4 : 0,
    fuelSec: lit ? 72 : 0,
    recipes: ids.map((id: RecipeId) => {
      const def = RECIPES[id];
      const cost = (Object.entries(def.cost) as [ItemKind, number][]).map(([kind, need]) => ({ kind, have: have[kind] ?? 0, need }));
      const locked = def.locked;
      const ok = !locked && (lit || id === "fuel") && cost.every((c) => c.have >= c.need);
      return { id, cost, ok, locked, out: def.out };
    }),
  };
}

function chestModel(empty = false): ChestPanelModel {
  return {
    chest: empty
      ? []
      : [
          { kind: "wood", count: 9 },
          { kind: "rope", count: 3 },
          { kind: "stone", count: 2 },
          { kind: "fish_cooked", count: 2 },
          { kind: "water", count: 1 },
          { kind: "coconut", count: 5 },
        ],
    slots: baseHud().slots,
    activeSlot: 0,
  };
}

function scoreRows(): ScoreRow[] {
  return NAMES.slice(0, 5).map((n, i) => ({
    id: i === 0 ? "me" : `p${i}`,
    nickname: n,
    character: CHARACTER_IDS[i]!,
    color: PLAYER_COLORS[i]!,
    bot: i >= 3,
    you: i === 0,
    score: 120 - i * 17 + (i === 2 ? 40 : 0),
    stats: stats(i + 1),
    ping: i >= 3 ? 0 : 40 + i * 60,
  }));
}

function matchEndModel(win: boolean): MatchEndModel {
  const rows = scoreRows()
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({
      ...r,
      place: i + 1,
      titles: (i === 0 ? ["mvp", "porter"] : i === 1 ? ["crabSlayer", "hero"] : i === 2 ? ["fishLord"] : i === 3 ? ["victim", "coconutAddict"] : ["tourist"]) as MatchEndModel["rows"][number]["titles"],
      aboard: win ? i !== 3 : false,
    }));
  return { win, reason: win ? "launched" : "storm", secLeft: win ? 72 : 0, teamScore: win ? 1094 : 312, seed: 4471, biome: "tropic", mvpId: rows[0]!.id, rows, canRematch: true, secToLobby: 52 };
}

/* ================================================================= states */

type State = { id: string; group: string; label: string; run(): void };

function showHud(patch: (m: HudModel) => void, tod: "day" | "dusk" | "night" = "day"): void {
  const m = baseHud();
  patch(m);
  hud = m;
  game.dataset.tod = tod;
  game.dataset.scene = "game";
  ui.showScreen("game");
  ui.updateHud(m);
}

const STATES: State[] = [
  { id: "home", group: "Screens", label: "Home", run: () => screen("home", () => ui.setHome(homeModel({ nickname: settings.get().nickname }))) },
  { id: "home-invite", group: "Screens", label: "Home · invite", run: () => screen("home", () => ui.setHome(homeModel({ nickname: "Ada", joinCode: "KRAB" }))) },
  { id: "home-error", group: "Screens", label: "Home · error", run: () => screen("home", () => ui.setHome(homeModel({ nickname: "Ada", joinCode: "ZZZZ", error: "menu.errNotFound" }))) },
  { id: "home-busy", group: "Screens", label: "Home · busy", run: () => screen("home", () => ui.setHome(homeModel({ nickname: "Ada", busy: true }))) },
  { id: "connecting", group: "Screens", label: "Connecting", run: () => screen("connecting", () => ui.setConnecting("")) },
  { id: "lobby-solo", group: "Screens", label: "Lobby · solo host", run: () => screen("lobby", () => ui.setLobby(lobbyModel("solo"))) },
  { id: "lobby-full", group: "Screens", label: "Lobby · host + bots", run: () => screen("lobby", () => ui.setLobby(lobbyModel("full"))) },
  { id: "lobby-guest", group: "Screens", label: "Lobby · guest", run: () => screen("lobby", () => ui.setLobby(lobbyModel("guest"))) },
  { id: "end-win", group: "Screens", label: "Match end · win", run: () => screen("matchEnd", () => ui.setMatchEnd(matchEndModel(true))) },
  { id: "end-lose", group: "Screens", label: "Match end · lose", run: () => screen("matchEnd", () => ui.setMatchEnd(matchEndModel(false))) },

  { id: "hud-day", group: "HUD", label: "Day · gathering", run: () => showHud(() => undefined) },
  {
    id: "hud-landing",
    group: "HUD",
    label: "Landing",
    run: () => showHud((m) => {
      m.phase = "landing";
      m.day = 1;
      m.phaseSecLeft = 8;
      m.stormSecLeft = 465;
      m.prompt = null;
      m.crosshair = "dot";
      m.raft = { ...m.raft, stage: 0, parts: m.raft.parts.map((p) => ({ ...p, have: p.part === "hullWood" ? 3 : 0 })) };
    }),
  },
  {
    id: "hud-hold",
    group: "HUD",
    label: "Hold E · 60%",
    run: () => showHud((m) => {
      m.prompt = { kind: "gather", key: "prompt.gather_wood", keyGlyph: "E", hold: true, progress: 0.6, ok: true, reason: "" };
    }),
  },
  {
    id: "hud-blocked",
    group: "HUD",
    label: "Prompt · blocked",
    run: () => showHud((m) => {
      m.prompt = { kind: "deliver", key: "prompt.deliver", keyGlyph: "E", hold: false, progress: 0, ok: false, reason: "wrongStage" };
    }),
  },
  {
    id: "hud-charge",
    group: "HUD",
    label: "Charging a throw",
    run: () => showHud((m) => {
      m.charge = 0.7;
      m.crosshair = "throw";
      m.prompt = null;
    }),
  },
  {
    id: "hud-fish-cast",
    group: "HUD",
    label: "Fishing · waiting",
    run: () => showHud((m) => {
      m.slots[3] = { kind: "rod", count: 1, meter: -1 };
      m.activeSlot = 3;
      m.fishing = { state: "cast", windowFrac: 0 };
      m.prompt = null;
      m.crosshair = "dot";
    }),
  },
  {
    id: "hud-fish-bite",
    group: "HUD",
    label: "Fishing · BITE",
    run: () => showHud((m) => {
      m.slots[3] = { kind: "rod", count: 1, meter: -1 };
      m.activeSlot = 3;
      m.fishing = { state: "bite", windowFrac: 0.65 };
      m.prompt = { kind: "gather", key: "prompt.strike", keyGlyph: "LMB", hold: false, progress: 0, ok: true, reason: "" };
      m.crosshair = "dot";
    }),
  },
  {
    id: "hud-dusk",
    group: "HUD",
    label: "Dusk · fire low",
    run: () =>
      showHud((m) => {
        m.dayPhase = "dusk";
        m.cycle = 0.64;
        m.phaseSecLeft = 7;
        m.fire = { frac: 0.12, lit: true, low: true, secLeft: 11 };
        m.weather = "rain";
      }, "dusk"),
  },
  {
    id: "hud-night",
    group: "HUD",
    label: "Night · low bars",
    run: () =>
      showHud((m) => {
        m.day = 3;
        m.dayPhase = "night";
        m.cycle = 0.85;
        m.phaseSecLeft = 28;
        m.stormSecLeft = 28;
        m.stormWarning = true;
        m.hp = 0.24;
        m.hunger = 0.12;
        m.thirst = 0.05;
        m.warmth = 0.22;
        m.low = { hp: true, hunger: true, thirst: true, warmth: true };
        m.weather = "fullmoon";
        m.slots[3] = { kind: "puffer", count: 1, meter: 0.35 };
        m.activeSlot = 3;
        m.prompt = { kind: "revive", key: "prompt.revive", params: { name: "Bahri" }, keyGlyph: "E", hold: true, progress: 0.35, ok: true, reason: "" };
      }, "night"),
  },
  {
    id: "hud-fire-out",
    group: "HUD",
    label: "Fire out",
    run: () =>
      showHud((m) => {
        m.dayPhase = "night";
        m.cycle = 0.78;
        m.fire = { frac: 0, lit: false, low: true, secLeft: 0 };
        m.prompt = { kind: "craft", key: "prompt.craft", keyGlyph: "E", hold: false, progress: 0, ok: true, reason: "" };
      }, "night"),
  },
  {
    id: "hud-ready",
    group: "HUD",
    label: "Raft ready + boarding",
    run: () =>
      showHud((m) => {
        m.day = 3;
        m.raft = { ...m.raft, stage: 3, parts: m.raft.parts.map((p) => ({ ...p, have: p.need })), ready: true, aboard: 3, total: 5 };
        m.launch = { secLeft: 14, aboard: 3, total: 5 };
        m.prompt = { kind: "board", key: "prompt.board", keyGlyph: "E", hold: false, progress: 0, ok: true, reason: "" };
      }, "dusk"),
  },
  {
    id: "hud-boarded",
    group: "HUD",
    label: "Boarded",
    run: () =>
      showHud((m) => {
        m.raft = { ...m.raft, stage: 3, parts: m.raft.parts.map((p) => ({ ...p, have: p.need })), ready: true, aboard: 4, total: 5 };
        m.launch = { secLeft: 4, aboard: 4, total: 5 };
        m.boarded = true;
        m.prompt = null;
        m.crosshair = "dot";
      }, "dusk"),
  },
  {
    id: "hud-downed",
    group: "HUD",
    label: "Downed",
    run: () =>
      showHud((m) => {
        m.hp = 0;
        m.downed = { secLeft: 6.2, revive: 0 };
        m.prompt = null;
      }, "night"),
  },
  {
    id: "hud-reviving",
    group: "HUD",
    label: "Downed · being revived",
    run: () =>
      showHud((m) => {
        m.hp = 0;
        m.downed = { secLeft: 4.1, revive: 0.55 };
        m.prompt = null;
      }, "night"),
  },
  {
    id: "hud-washed",
    group: "HUD",
    label: "Washed · respawn",
    run: () =>
      showHud((m) => {
        m.washed = { willRespawn: true, secToDawn: 34 };
        m.prompt = null;
      }, "night"),
  },
  {
    id: "hud-washed-final",
    group: "HUD",
    label: "Washed · no dawn",
    run: () =>
      showHud((m) => {
        m.day = 3;
        m.washed = { willRespawn: false, secToDawn: 0 };
        m.prompt = null;
      }, "night"),
  },
  {
    id: "hud-spectator",
    group: "HUD",
    label: "Spectator",
    run: () => showHud((m) => {
      m.spectator = true;
      m.prompt = null;
    }),
  },
  {
    id: "hud-storm",
    group: "HUD",
    label: "Storm cinematic",
    run: () =>
      showHud((m) => {
        m.phase = "storm";
        m.dayPhase = "night";
        m.prompt = null;
      }, "night"),
  },
  {
    id: "hud-pointer",
    group: "HUD",
    label: "Click to play veil",
    run: () => showHud((m) => {
      m.needsPointer = true;
    }),
  },

  { id: "craft", group: "Panels", label: "Craft", run: () => panel("craft") },
  { id: "craft-out", group: "Panels", label: "Craft · fire out", run: () => panel("craft", false) },
  { id: "chest", group: "Panels", label: "Chest", run: () => panel("chest") },
  { id: "chest-empty", group: "Panels", label: "Chest · empty", run: () => panel("chest", true, true) },
  { id: "settings", group: "Panels", label: "Esc menu", run: () => panel("settings") },
  { id: "legend", group: "Panels", label: "H guide", run: () => panel("legend") },
  { id: "ping", group: "Panels", label: "Ping wheel", run: () => panel("pingWheel") },
  { id: "emote", group: "Panels", label: "Emote wheel", run: () => panel("emoteWheel") },
  {
    id: "stats",
    group: "Panels",
    label: "Tab stats",
    run: () => {
      if (ui.screen !== "game") showHud(() => undefined);
      ui.setScoreboard(scoreRows());
    },
  },

  { id: "reel-fish", group: "Transient", label: "Reel · fish", run: () => reel("fish", ["boot", "fish", "crab", "jellyfish", "fish", "golden", "puffer"], 4) },
  { id: "reel-golden", group: "Transient", label: "Reel · golden", run: () => reel("fish", ["fish", "crab", "boot", "puffer", "fish", "golden", "fish"], 5) },
  { id: "reel-tease", group: "Transient", label: "Reel · so close", run: () => reel("fish", ["crab", "fish", "boot", "jellyfish", "boot", "kraken", "fish"], 4) },
  { id: "reel-treasure", group: "Transient", label: "Reel · treasure", run: () => reel("treasure", ["spyglass", "flare", "fuel_can", "pirate_hat", "old_sail", "flare"], 3) },
  { id: "reel-other", group: "Transient", label: "Reel · teammate", run: () => reel("fish", ["fish", "boot", "crab", "fish", "puffer", "fish"], 2, "Mercan") },
  {
    id: "feed",
    group: "Transient",
    label: "Feed lines",
    run: () => {
      if (ui.screen !== "game") showHud(() => undefined);
      ui.feed({ key: "server.joined3", params: { n: "Mercan" }, icon: "", tone: "info" });
      window.setTimeout(() => ui.feed({ key: "items.bottle_recipe", icon: "🍾", tone: "gold" }), 600);
    },
  },
  {
    id: "banner",
    group: "Transient",
    label: "Banner",
    run: () => {
      if (ui.screen !== "game") showHud(() => undefined, "dusk");
      ui.banner({ key: "hud.launchTitle", sub: "hud.launchGo", tone: "warn", duration: 3 });
    },
  },
  { id: "toast", group: "Transient", label: "Toast", run: () => ui.toast("🔌 Mercan dried their phone in a bag of rice and is back!", "good") },
  {
    id: "coach",
    group: "Transient",
    label: "Coach tip (fire)",
    run: () => {
      if (ui.screen !== "game") showHud(() => undefined);
      settings.set({ seenTips: [] });
      ui.coach("fire");
    },
  },
];

function screen(id: "home" | "connecting" | "lobby" | "matchEnd", fill: () => void): void {
  hud = null;
  ui.openPanel(null);
  game.dataset.tod = id === "matchEnd" ? "dusk" : "day";
  game.dataset.scene = id === "lobby" ? "lobby" : "menu";
  fill();
  ui.showScreen(id);
}

function panel(p: "craft" | "chest" | "settings" | "legend" | "pingWheel" | "emoteWheel", lit = true, empty = false): void {
  if (ui.screen !== "game") showHud(() => undefined);
  if (p === "craft") ui.setCraftPanel(craftModel(lit));
  if (p === "chest") ui.setChestPanel(chestModel(empty));
  ui.openPanel(null);
  ui.openPanel(p);
}

function reel(kind: "fish" | "treasure", base: (FishLoot | TreasureId)[], baseStop: number, who = ""): void {
  if (ui.screen !== "game") showHud(() => undefined);
  // Pad like the server (32-long strip, stop at 26).
  const strip: (FishLoot | TreasureId)[] = [];
  for (let i = 0; i < 32; i++) strip.push(base[(i + baseStop) % base.length]!);
  const stop = 26;
  for (let k = -3; k <= 3; k++) strip[stop + k] = base[(baseStop + k + base.length * 4) % base.length]!;
  ui.reel({ kind, strip, stopIndex: stop, durationMs: 2500, who });
}

/* ================================================================== panel */

function buildDev(): void {
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.append("🛶 UI harness");
  const min = document.createElement("button");
  min.textContent = "–";
  min.addEventListener("click", () => dev.classList.toggle("min"));
  bar.append(min);
  dev.append(bar);
  const groups = new Map<string, HTMLElement>();
  for (const s of STATES) {
    let g = groups.get(s.group);
    if (!g) {
      const h = document.createElement("h2");
      h.textContent = s.group;
      g = document.createElement("div");
      dev.append(h, g);
      groups.set(s.group, g);
    }
    const b = document.createElement("button");
    b.textContent = s.label;
    b.title = `?state=${s.id}`;
    b.addEventListener("click", () => {
      s.run();
      history.replaceState(null, "", `?state=${s.id}${animate ? "" : "&anim=0"}`);
    });
    g.append(b);
  }
  const h = document.createElement("h2");
  h.textContent = "Options";
  dev.append(h);
  const opt = (label: string, on: boolean, fn: (v: boolean) => void) => {
    const l = document.createElement("label");
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = on;
    c.addEventListener("change", () => fn(c.checked));
    l.append(c, ` ${label}`);
    dev.append(l);
  };
  opt("Animate HUD", animate, (v) => (animate = v));
  opt("Reduced flashing", settings.get().reducedFlashing, (v) => settings.set({ reducedFlashing: v }));
  const lang = document.createElement("button");
  lang.textContent = settings.get().language === "tr" ? "🇬🇧 English" : "🇹🇷 Türkçe";
  lang.addEventListener("click", () => setLanguage(settings.get().language === "tr" ? "en" : "tr"));
  dev.append(lang);
  const log = document.createElement("div");
  log.id = "log";
  dev.append(log);
}

function logEvent(name: string, payload: unknown): void {
  const log = document.getElementById("log");
  if (!log) return;
  if (name === "sound") return;
  const line = document.createElement("div");
  line.textContent = `${name} ${payload === undefined ? "" : JSON.stringify(payload)}`;
  log.prepend(line);
  while (log.childElementCount > 40) log.lastElementChild?.remove();
}

/** Log every UI event and react the way the app would for the obvious ones. */
function wireEvents(): void {
  const names: (keyof UiEventMap)[] = ["create", "join", "leave", "ready", "character", "roomSettings", "start", "addBot", "removeBot", "copyLink", "rematch", "craft", "chest", "closePanel", "marker", "emote", "settings", "language", "resume", "sound"];
  for (const n of names) ui.events.on(n, (p: unknown) => logEvent(n, p));
  ui.events.on("craft", ({ recipe }) => ui.feed({ key: "items.recipe_" + recipe, icon: "🔨", tone: "good" }));
  ui.events.on("resume", () => {
    if (hud) {
      hud.needsPointer = false;
      ui.updateHud(hud);
    }
  });
  ui.events.on("create", () => STATES.find((s) => s.id === "connecting")?.run());
  ui.events.on("leave", () => STATES.find((s) => s.id === "home")?.run());
  ui.events.on("character", ({ character }) => {
    const m = lobbyModel("solo");
    m.players[0] = { ...m.players[0]!, character: character as CharacterId };
    ui.setLobby(m);
  });
}

/* =================================================================== loop */

function frame(now: number): void {
  if (hud && ui.screen === "game" && animate) {
    const t = (now - t0) / 1000;
    hud.compass.yaw = Math.sin(t * 0.35) * 1.4;
    hud.cycle = (hud.cycle + 0.0004) % 1;
    hud.phaseSecLeft = Math.max(0, hud.phaseSecLeft - 1 / 60);
    hud.stormSecLeft = Math.max(0, hud.stormSecLeft - 1 / 60);
    if (hud.charge > 0) hud.charge = Math.min(1, ((t * 0.8) % 1.3) + 0.05);
    if (hud.prompt?.hold && hud.prompt.ok && hud.prompt.progress > 0) hud.prompt.progress = (t * 0.4) % 1;
    if (hud.fishing?.state === "bite") hud.fishing.windowFrac = 1 - ((t * 0.9) % 1);
    if (hud.downed) hud.downed.secLeft = 10 - ((t * 1) % 10);
    hud.fire.secLeft = Math.max(0, hud.fire.secLeft - 1 / 60);
    ui.updateHud(hud);
  }
  requestAnimationFrame(frame);
}

buildDev();
if (params.get("dev") === "0") dev.classList.add("min");
wireEvents();
const start = STATES.find((s) => s.id === params.get("state")) ?? STATES[0]!;
start.run();
t0 = performance.now();
requestAnimationFrame(frame);
