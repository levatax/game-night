// Dev harness for the client-ui module: renders every screen and HUD state with mock models.
// Not part of the production build. Open /games/bonk-brawl/dev/client-ui.html?s=<scenario>[&hide=1].
// Keys: H toggles the control panel, [ / ] previous / next scenario. window.harness drives it from devtools.

import "../src/ui/ui.css";
import { CHARACTERS, MAX_HEARTS, playerColor } from "../../shared/constants";
import type { CharacterId, Phase } from "../../shared/types";
import { DEFAULT_SETTINGS, type Settings } from "../src/app/settings";
import type {
  HudModel,
  KillFeedEntry,
  LobbyModel,
  LobbyPlayerCard,
  MatchEndModel,
  OffscreenIndicator,
  RoundEndModel,
  ScoreRow,
  UiEventMap,
} from "../src/ui/models";
import { Ui } from "../src/ui/Ui";

/* ================================================================ mocks */

interface MockPlayer {
  id: string;
  nickname: string;
  character: CharacterId;
  slot: number;
}

const PLAYERS: MockPlayer[] = [
  { id: "p1", nickname: "BonkMaster", character: "quacky", slot: 0 },
  { id: "p2", nickname: "Hopsy", character: "hopsworth", slot: 1 },
  { id: "p3", nickname: "Captain Noodle", character: "mochi", slot: 2 },
  { id: "p4", nickname: "Gruffalo", character: "gruff", slot: 3 },
];
const YOU = "p1";

function feedPlayer(p: MockPlayer) {
  return { name: p.nickname, emoji: CHARACTERS[p.character].emoji, color: playerColor(p.slot) };
}

function lobbyCard(p: MockPlayer, patch: Partial<LobbyPlayerCard> = {}): LobbyPlayerCard {
  return {
    id: p.id,
    nickname: p.nickname,
    character: p.character,
    emoji: CHARACTERS[p.character].emoji,
    slot: p.slot,
    color: playerColor(p.slot),
    ready: false,
    isHost: p.id === YOU,
    isYou: p.id === YOU,
    connected: true,
    spectator: false,
    ping: 30 + p.slot * 37,
    ...patch,
  };
}

function lobbyModel(count: number, patch: Partial<LobbyModel> = {}, cards?: LobbyPlayerCard[]): LobbyModel {
  const players = cards ?? PLAYERS.slice(0, count).map((p) => lobbyCard(p));
  const me = players.find((p) => p.isYou) ?? players[0];
  return {
    code: "KBZW",
    shareUrl: `${location.origin}/r/KBZW`,
    players,
    you: { id: me.id, character: me.character, ready: me.ready, isHost: me.isHost, spectator: me.spectator },
    settings: { map: "random", rounds: 5, powerUps: true },
    canStart: false,
    startHint: "",
    phase: "lobby",
    ...patch,
  };
}

function scoreRows(patch: (r: ScoreRow) => Partial<ScoreRow> = () => ({})): ScoreRow[] {
  const points = [9, 12, 4, 7];
  const rows = PLAYERS.map((p, i): ScoreRow => {
    const base: ScoreRow = {
      id: p.id,
      nickname: p.nickname,
      character: p.character,
      emoji: CHARACTERS[p.character].emoji,
      color: playerColor(p.slot),
      points: points[i],
      hasCrown: i === 1,
      isYou: p.id === YOU,
      alive: i !== 2,
      hearts: [2, 3, 0, 1][i],
      connected: true,
      ping: [34, 78, 141, 212][i],
      roundWins: [1, 2, 0, 1][i],
      hits: [5, 6, 3, 4][i],
      catches: [1, 2, 0, 1][i],
      ringOuts: [1, 0, 0, 1][i],
    };
    return { ...base, ...patch(base) };
  });
  return rows.sort((a, b) => b.points - a.points);
}

function hudModel(patch: Partial<HudModel> = {}): HudModel {
  const def = CHARACTERS.quacky.ability;
  return {
    phase: "playing",
    round: 2,
    totalRounds: 5,
    timerSec: 42.3,
    suddenDeath: false,
    countdown: null,
    hearts: MAX_HEARTS,
    maxHearts: MAX_HEARTS,
    ability: { name: def.name, icon: def.icon, cooldownFrac: 0, ready: true, active: false, armed: false },
    charge: 0,
    charging: false,
    fullCharge: false,
    crosshairSpread: 1,
    heldBalls: 1,
    maxHeld: 1,
    powerUp: "",
    zoomiesFrac: 0,
    catchCooldownFrac: 0,
    rollCooldownFrac: 0,
    scoreboard: scoreRows(),
    spectating: null,
    color: playerColor(0),
    ping: 34,
    ...patch,
  };
}

function feedEntries(): KillFeedEntry[] {
  const [a, b, c, d] = PLAYERS.map(feedPlayer);
  return [
    { id: 1, kind: "bonk", actor: a, victim: b },
    { id: 2, kind: "catch", actor: c, victim: d },
    { id: 3, kind: "ringOut", actor: d, victim: b },
    { id: 4, kind: "fell", actor: null, victim: c },
    { id: 5, kind: "ko", actor: null, victim: d },
    { id: 6, kind: "dropped", actor: null, victim: a },
  ];
}

function indicators(): OffscreenIndicator[] {
  const w = innerWidth;
  const h = innerHeight;
  return [
    { id: "b1", x: 48, y: h * 0.55, angle: Math.PI, color: playerColor(1), urgency: 0.35 },
    { id: "b2", x: w - 48, y: h * 0.3, angle: -0.35, color: playerColor(3), urgency: 0.8 },
    { id: "b3", x: w * 0.62, y: h - 48, angle: Math.PI / 2.2, color: playerColor(2), urgency: 0.55 },
  ];
}

function roundEndModel(draw = false): RoundEndModel {
  const winner = PLAYERS[1];
  const round = [0, 6, 1, 2];
  const totals = [9, 12, 4, 7];
  return {
    round: 2,
    totalRounds: 5,
    winner: draw ? null : { id: winner.id, name: winner.nickname, character: winner.character, emoji: CHARACTERS[winner.character].emoji, color: playerColor(winner.slot) },
    rows: PLAYERS.map((p, i) => ({
      id: p.id,
      name: p.nickname,
      emoji: CHARACTERS[p.character].emoji,
      color: playerColor(p.slot),
      roundPoints: draw ? Math.min(round[i], 2) : round[i],
      totalPoints: totals[i],
      isWinner: !draw && p.id === winner.id,
      isYou: p.id === YOU,
    })).sort((a, b) => b.roundPoints - a.roundPoints),
    nextRound: 3,
  };
}

function matchEndModel(count: number, patch: Partial<MatchEndModel> = {}): MatchEndModel {
  const order = [PLAYERS[1], PLAYERS[0], PLAYERS[3], PLAYERS[2]].slice(0, count);
  const pts = [21, 17, 11, 6];
  const stats = [
    { hits: 11, catches: 3, ringOuts: 2, kos: 3, roundWins: 3, accuracy: 61 },
    { hits: 9, catches: 4, ringOuts: 0, kos: 2, roundWins: 1, accuracy: 47 },
    { hits: 6, catches: 1, ringOuts: 3, kos: 1, roundWins: 1, accuracy: 38 },
    { hits: 3, catches: 0, ringOuts: 0, kos: 0, roundWins: 0, accuracy: 18 },
  ];
  return {
    entries: order.map((p, i) => ({
      id: p.id,
      name: p.nickname,
      character: p.character,
      emoji: CHARACTERS[p.character].emoji,
      color: playerColor(p.slot),
      place: i + 1,
      points: pts[i],
      isYou: p.id === YOU,
      stats: stats[i],
    })),
    winnerId: order[0].id,
    canRematch: true,
    autoLobbySec: 38,
    ...patch,
  };
}

/* ============================================================= harness */

const gameRoot = document.getElementById("game") as HTMLElement;
const uiRoot = document.getElementById("ui") as HTMLElement;
const panel = document.getElementById("harness") as HTMLElement;
const ui = new Ui(uiRoot);
let settings: Settings = { ...DEFAULT_SETTINGS, nickname: "BonkMaster" };
let hud = hudModel();
let animating = 0;
let feedId = 100;

const EVENT_NAMES: Array<keyof UiEventMap> = [
  "createRoom", "joinRoom", "selectCharacter", "setReady", "updateSettings", "startMatch", "rematch",
  "leaveRoom", "backToPortal", "settingsChange", "resume", "emote", "uiSound",
];
const eventLog: Array<{ type: string; payload: unknown }> = [];
for (const name of EVENT_NAMES) {
  ui.events.on(name, (payload) => {
    eventLog.push({ type: name, payload });
    if (name !== "uiSound") console.log(`[ui event] ${name}`, payload ?? "");
  });
}
ui.events.on("settingsChange", (patch) => (settings = { ...settings, ...patch }));
ui.events.on("resume", () => ui.setClickToPlay(false));
ui.onSettingsRequest(() => ui.openSettings(settings, ui.screen === "lobby"));

function drawBackdrop(mode: "menu" | "game"): void {
  const animals = mode === "menu" ? ["🦆", "🐸", "🐻", "🐱", "🐧", "🐐"] : ["🐸", "🐻", "🐐"];
  const scene = document.createElement("div");
  scene.className = "fake-scene";
  const clouds = [
    [8, 12],
    [62, 8],
    [80, 26],
    [30, 22],
  ];
  for (const [x, y] of clouds) {
    const c = document.createElement("div");
    c.className = "fake-scene__cloud";
    c.style.cssText = `left:${x}%;top:${y}%`;
    scene.append(c);
  }
  const island = document.createElement("div");
  island.className = "fake-scene__island";
  scene.append(island);
  animals.forEach((emoji, i) => {
    const a = document.createElement("div");
    a.className = "fake-scene__animal";
    a.textContent = emoji;
    const x = mode === "menu" ? 10 + i * 15 : 28 + i * 20;
    const y = mode === "menu" ? 62 + (i % 2) * 10 : 52 + (i % 2) * 8;
    a.style.cssText = `left:${x}%;top:${y}%;animation-delay:${-i * 0.37}s`;
    scene.append(a);
  });
  if (mode === "game") {
    for (const [x, y] of [[46, 70], [58, 64]]) {
      const b = document.createElement("div");
      b.className = "fake-scene__ball";
      b.style.cssText = `left:${x}%;top:${y}%`;
      scene.append(b);
    }
  }
  gameRoot.replaceChildren(scene);
}

/** Stand-in for the 3D CharacterPreview turntable: the animal emoji drawn into the canvas. */
function drawPreview(character: CharacterId): void {
  const canvas = ui.previewCanvas;
  // getBoundingClientRect includes the UI zoom on big screens (clientWidth does not).
  const size = Math.max(1, Math.round(canvas.getBoundingClientRect().width * devicePixelRatio));
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, size, size);
  ctx.font = `${Math.round(size * 0.5)}px system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(CHARACTERS[character].emoji, size / 2, size * 0.5);
}

function stopAnimation(): void {
  cancelAnimationFrame(animating);
  animating = 0;
}

function enterGame(patch: Partial<HudModel> = {}): void {
  drawBackdrop("game");
  ui.showScreen("game");
  hud = hudModel(patch);
  ui.updateHud(hud);
  ui.setIndicators([]);
}

function setLobby(model: LobbyModel): void {
  drawBackdrop("menu");
  ui.showScreen("lobby");
  ui.setLobby(model);
  requestAnimationFrame(() => drawPreview(model.you.character));
}

function resetOverlays(): void {
  stopAnimation();
  ui.closeSettings();
  ui.setClickToPlay(false);
  ui.setScoreboard(false, []);
  ui.hideRoundEnd();
}

const ready = (p: MockPlayer) => lobbyCard(p, { ready: true });

const SCENARIOS: Record<string, () => void> = {
  home: () => {
    drawBackdrop("menu");
    ui.showScreen("home");
    ui.setHome({ nickname: "BonkMaster", code: "", busy: false, error: null });
  },
  "home-empty": () => {
    drawBackdrop("menu");
    ui.showScreen("home");
    ui.setHome({ nickname: "", code: "", busy: false, error: null });
  },
  "home-invite": () => {
    drawBackdrop("menu");
    ui.showScreen("home");
    ui.setHome({ nickname: "BonkMaster", code: "KBZW", busy: false, error: null });
  },
  "home-busy": () => {
    drawBackdrop("menu");
    ui.showScreen("home");
    ui.setHome({ nickname: "BonkMaster", code: "", busy: true, error: null });
  },
  "home-room-full": () => {
    drawBackdrop("menu");
    ui.showScreen("home");
    ui.setHome({ nickname: "BonkMaster", code: "KBZW", busy: false, error: "Room full — 4 animals are already bonking in there." });
  },
  "home-not-found": () => {
    drawBackdrop("menu");
    ui.showScreen("home");
    ui.setHome({ nickname: "BonkMaster", code: "QWXZ", busy: false, error: "No room with that code" });
  },
  "home-server-down": () => {
    drawBackdrop("menu");
    ui.showScreen("home");
    ui.setHome({ nickname: "BonkMaster", code: "", busy: false, error: "Can't reach the game server. Try again in a moment." });
  },
  connecting: () => {
    drawBackdrop("menu");
    ui.setConnecting("Joining KBZW…");
    ui.showScreen("connecting");
  },
  "reconnecting-in-game": () => {
    enterGame();
    ui.setConnecting("Reconnecting…");
    ui.showScreen("connecting");
  },
  "lobby-solo-host": () =>
    setLobby(lobbyModel(1, { startHint: "Need at least 2 players — share the code!" })),
  "lobby-host-waiting": () =>
    setLobby(
      lobbyModel(3, { startHint: "Waiting for 1 player to get ready" }, [
        ready(PLAYERS[0]),
        lobbyCard(PLAYERS[1]),
        ready(PLAYERS[2]),
      ]),
    ),
  "lobby-host-can-start": () =>
    setLobby(
      lobbyModel(4, { canStart: true, startHint: "", you: { id: YOU, character: "quacky", ready: true, isHost: true, spectator: false } }, [
        ready(PLAYERS[0]),
        ready(PLAYERS[1]),
        ready(PLAYERS[2]),
        lobbyCard({ ...PLAYERS[3], character: "quacky" }, { ready: true }),
      ]),
    ),
  "lobby-guest": () => {
    const cards = [
      lobbyCard(PLAYERS[0], { isHost: false, character: "whiskers", emoji: CHARACTERS.whiskers.emoji }),
      lobbyCard(PLAYERS[1], { isHost: true, ready: true }),
      lobbyCard(PLAYERS[2], { connected: false }),
    ];
    setLobby(
      lobbyModel(3, {
        you: { id: YOU, character: "whiskers", ready: false, isHost: false, spectator: false },
        settings: { map: "bath", rounds: 7, powerUps: false },
        startHint: "Waiting for a player to reconnect…",
      }, cards),
    );
  },
  "lobby-spectator": () => {
    const cards = PLAYERS.map((p) => lobbyCard(p, { isHost: p.id === "p2", spectator: p.id === YOU }));
    setLobby(
      lobbyModel(4, {
        you: { id: YOU, character: "quacky", ready: false, isHost: false, spectator: true },
        phase: "playing" as Phase,
        startHint: "",
      }, cards),
    );
  },
  "hud-playing": () => enterGame(),
  "hud-no-ball": () => enterGame({ heldBalls: 0 }),
  "hud-charging": () => enterGame({ charging: true, charge: 0.55, crosshairSpread: 1 - 0.85 * 0.55 }),
  "hud-full-charge": () =>
    enterGame({ charging: true, charge: 1, fullCharge: true, crosshairSpread: 0.15, powerUp: "mega" }),
  "hud-triple": () => enterGame({ powerUp: "triple", heldBalls: 2, maxHeld: 2 }),
  "hud-cooldowns": () =>
    enterGame({
      hearts: 1,
      ability: { name: "Flap Dash", icon: "🪶", cooldownFrac: 0.62, ready: false, active: false, armed: false },
      catchCooldownFrac: 0.7,
      rollCooldownFrac: 0.35,
      zoomiesFrac: 0.6,
      powerUp: "boomerang",
    }),
  "hud-ability-active": () =>
    enterGame({ ability: { name: "Belly Bounce", icon: "🫧", cooldownFrac: 1, ready: false, active: true, armed: false } }),
  "hud-curve-armed": () =>
    enterGame({ color: playerColor(3), ability: { name: "Curveball", icon: "🌀", cooldownFrac: 1, ready: false, active: false, armed: true } }),
  "hud-low-time": () => enterGame({ timerSec: 7.2, hearts: 2 }),
  "hud-sudden-death": () => {
    enterGame({ phase: "suddenDeath", suddenDeath: true, timerSec: 3.4, hearts: 2 });
    ui.banner("SUDDEN DEATH!", "danger");
  },
  "hud-countdown": () => enterGame({ phase: "countdown", countdown: 3, timerSec: 2.6, round: 3 }),
  "hud-countdown-go": () => enterGame({ phase: "countdown", countdown: 0, timerSec: 0, round: 3 }),
  "hud-ghost": () =>
    enterGame({ hearts: 0, spectating: { reason: "ko", text: "BONKED OUT! Spectating — WASD to fly, Space/Shift up/down" } }),
  "hud-ringout-ghost": () =>
    enterGame({ hearts: 2, spectating: { reason: "ringOut", text: "RUNG OUT! Spectating — WASD to fly, Space/Shift up/down" } }),
  "hud-spectator": () =>
    enterGame({ spectating: { reason: "spectator", text: "Match in progress — you'll play in the next one. WASD to fly around!" } }),
  "hud-indicators": () => {
    enterGame();
    ui.setIndicators(indicators());
  },
  "hud-killfeed": () => {
    enterGame();
    for (const e of feedEntries().slice(0, 5)) ui.pushKillFeed(e);
  },
  "hud-scoreboard": () => {
    enterGame();
    ui.setScoreboard(true, scoreRows((r) => (r.id === "p4" ? { connected: false } : {})));
  },
  "hud-animated": () => {
    enterGame();
    animateHud();
  },
  "round-end": () => {
    enterGame({ phase: "roundEnd" });
    ui.showRoundEnd(roundEndModel());
  },
  "round-end-draw": () => {
    enterGame({ phase: "roundEnd" });
    ui.showRoundEnd({ ...roundEndModel(true), nextRound: 0 });
  },
  "match-end-4": () => {
    drawBackdrop("game");
    ui.showScreen("matchEnd");
    ui.setMatchEnd(matchEndModel(4));
  },
  "match-end-3": () => {
    drawBackdrop("game");
    ui.showScreen("matchEnd");
    ui.setMatchEnd(matchEndModel(3));
  },
  "match-end-2-locked": () => {
    drawBackdrop("game");
    ui.showScreen("matchEnd");
    ui.setMatchEnd(matchEndModel(2, { canRematch: false, autoLobbySec: 44 }));
  },
  "settings-in-game": () => {
    enterGame();
    ui.openSettings(settings, true);
  },
  "settings-home": () => {
    SCENARIOS.home();
    ui.openSettings(settings, false);
  },
  "click-to-play": () => {
    enterGame();
    ui.setClickToPlay(true);
  },
  "banner-round": () => {
    enterGame({ phase: "countdown", countdown: null, round: 3 });
    ui.banner("ROUND 3", "info");
  },
  toasts: () => {
    SCENARIOS["lobby-host-waiting"]();
    ui.toast("Link copied!", "success");
    ui.toast("Gruffalo joined the room", "info");
    ui.toast("Lost connection to the server…", "error");
  },
};

const NAMES = Object.keys(SCENARIOS);
let currentName = "";

function run(name: string): void {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  resetOverlays();
  currentName = name;
  scenario();
  const url = new URL(location.href);
  url.searchParams.set("s", name);
  history.replaceState(null, "", url);
  const select = panel.querySelector("select");
  if (select) select.value = name;
}

/** Plays a little loop: charge → throw, cooldowns ticking, timer running, hearts dropping. */
function animateHud(): void {
  const start = performance.now();
  let lastHeart = 0;
  const frame = (now: number) => {
    const t = (now - start) / 1000;
    const chargePhase = t % 2.2;
    const charge = Math.min(1, Math.max(0, (chargePhase - 0.3) / 1.0));
    const charging = chargePhase > 0.3 && chargePhase < 1.8;
    const heartsLost = Math.floor(t / 3) % (MAX_HEARTS + 1);
    if (heartsLost !== lastHeart) lastHeart = heartsLost;
    hud = {
      ...hud,
      timerSec: Math.max(0, 60 - t * 2),
      charging,
      charge: charging ? charge : 0,
      fullCharge: charging && charge >= 1,
      crosshairSpread: charging ? 1 - 0.85 * charge : 1,
      heldBalls: charging ? 1 : chargePhase > 1.8 ? 0 : 1,
      hearts: MAX_HEARTS - heartsLost,
      ability: { ...hud.ability, cooldownFrac: (1 - (t % 6) / 6), ready: t % 6 > 5.5, active: false },
      catchCooldownFrac: Math.max(0, 1 - (t % 2)),
      rollCooldownFrac: Math.max(0, 1 - (t % 3) / 1.5),
    };
    ui.updateHud(hud);
    animating = requestAnimationFrame(frame);
  };
  animating = requestAnimationFrame(frame);
}

/* ---------------------------------------------------------- live actions */

const ACTIONS: Record<string, () => void> = {
  "−♥": () => ui.updateHud((hud = { ...hud, hearts: Math.max(0, hud.hearts - 1) })),
  "+♥": () => ui.updateHud((hud = { ...hud, hearts: Math.min(MAX_HEARTS, hud.hearts + 1) })),
  "feed+": () => {
    const entries = feedEntries();
    const e = entries[feedId % entries.length];
    ui.pushKillFeed({ ...e, id: ++feedId });
  },
  "3-2-1": () => {
    const steps: Array<number | null> = [3, 2, 1, 0, null];
    steps.forEach((n, i) => window.setTimeout(() => ui.updateHud((hud = { ...hud, phase: n === null ? "playing" : "countdown", countdown: n })), i * 1000));
  },
  "round end": () => ui.showRoundEnd(roundEndModel()),
  "hide card": () => ui.hideRoundEnd(),
  "+pts": () => {
    const rows = hud.scoreboard.map((r) => (r.id === "p3" ? { ...r, points: r.points + 9 } : r)).sort((a, b) => b.points - a.points);
    ui.updateHud((hud = { ...hud, scoreboard: rows }));
  },
  "SD banner": () => ui.banner("SUDDEN DEATH!", "danger"),
  toast: () => ui.toast(`Toast at ${new Date().toLocaleTimeString()}`, "info"),
  "err toast": () => ui.toast("Lost connection to the server…", "error"),
  "Esc menu": () => ui.openSettings(settings, ui.screen !== "home"),
  "click-to-play": () => ui.setClickToPlay(true),
  arrows: () => ui.setIndicators(indicators()),
  "no arrows": () => ui.setIndicators([]),
};

function buildPanel(): void {
  const title = document.createElement("h1");
  title.textContent = "Bonk Brawl UI harness (H hides, [ ] steps)";
  const select = document.createElement("select");
  for (const name of NAMES) select.append(new Option(name, name));
  select.addEventListener("change", () => run(select.value));
  const row = document.createElement("div");
  row.className = "row";
  for (const [label, fn] of Object.entries(ACTIONS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", fn);
    row.append(b);
  }
  const note = document.createElement("p");
  note.textContent = "UI events are logged to the console.";
  panel.append(title, select, row, note);
}

function step(dir: 1 | -1): void {
  const i = NAMES.indexOf(currentName);
  run(NAMES[(i + dir + NAMES.length) % NAMES.length]);
}

document.addEventListener("keydown", (e) => {
  const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.type !== "range";
  if (typing || e.metaKey || e.ctrlKey) return;
  if (e.key === "h" || e.key === "H") panel.hidden = !panel.hidden;
  if (e.key === "]") step(1);
  if (e.key === "[") step(-1);
});

const harness = {
  ui,
  run,
  names: NAMES,
  events: eventLog,
  setHud(patch: Partial<HudModel>) {
    hud = { ...hud, ...patch };
    ui.updateHud(hud);
  },
  hidePanel(hidden = true) {
    panel.hidden = hidden;
  },
};
(window as unknown as { harness: typeof harness }).harness = harness;

buildPanel();
const params = new URLSearchParams(location.search);
panel.hidden = params.get("hide") === "1";
run(NAMES.includes(params.get("s") ?? "") ? (params.get("s") as string) : "home");
