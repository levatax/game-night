// Net state + local prediction → ui/models.ts view models (home, lobby, HUD, panels, scoreboard, match end).
// Owner: client-app. Pure builders plus a player directory; the UI never reads net state itself. Every model is a
// fresh object (the UI may keep the previous one for diffing). Text a model field marks "already translated" is
// resolved here with i18n; everything else is an i18n key / id the UI translates.

import {
  BAR_MAX,
  CHANNEL,
  CHARACTERS,
  DEFAULT_CHARACTER,
  FIRE_DAY_BURN_MULT,
  FIRE_FUEL_MAX_TICKS,
  FIRE_LOW_FRACTION,
  FIRE_START_FUEL_TICKS,
  FISH_STATE,
  LOW_BAR_FRACTION,
  MAX_BOTS,
  MAX_PLAYERS,
  PALETTE,
  PUFFER_FUSE_TICKS,
  RAFT_HP_BOARD,
  RAFT_HP_MAX,
  RAFT_LAUNCH_STAGE,
  RAFT_STAGES,
  RAIN_FIRE_DRAIN_MULT,
  REVIVE_TICKS,
  SOLO_AUTO_BOTS,
  STORM_WARN_SEC,
  TICK_RATE,
  TORCH_BURN_TICKS,
  DIFFICULTIES,
  fireRepels,
  playerColor,
  type Timings,
} from "../../../shared/constants";
import type { IslandDef, IslandSite } from "../../../shared/island/types";
import { ITEM_KINDS, ITEMS, RECIPES, RECIPE_IDS, isHeavy, isItemKind, isThrowable } from "../../../shared/items";
import type { MatchEndEvent, StandingEntry } from "../../../shared/protocol";
import { channelTicksFor, type Interaction } from "../../../shared/rules/interact";
import { countOf, roomFor, slotCount, slotKind, SLOTS, type Inventory } from "../../../shared/rules/inventory";
import { clockAt, launchDayFor, matchTicks, stageDayLock, type ClockInfo } from "../../../shared/rules/schedule";
import { wrapAngle, yawFromDir } from "../../../shared/sim/math";
import { chargeFraction, heldKind } from "../../../shared/sim/player";
import type {
  CharacterId,
  InvKind,
  ItemKind,
  MonsterKind,
  MonsterMode,
  Phase,
  PlayerSimFields,
  PlayerView,
  RaftStateView,
  StatsView,
  TeamView,
} from "../../../shared/types";
import { has, itemName, t } from "../i18n";
import type {
  ChestPanelModel,
  CompassMark,
  CraftPanelModel,
  HomeModel,
  HudModel,
  LobbyModel,
  LobbyPlayerModel,
  MatchEndModel,
  MatchEndRow,
  PromptModel,
  RaftHudModel,
  RaftPartModel,
  StatusModel,
  RecipeRowModel,
  ScoreRow,
  SlotModel,
  TeammateModel,
} from "../ui/models";
import type { PingMark } from "./frameHelpers";
import type { Lang } from "./settings";

/* ================================================================ players */

interface KnownPlayer {
  nickname: string;
  character: CharacterId;
  seat: number;
  team: number;
  bot: boolean;
}

/**
 * Player lookups that keep working after a player left (feed lines and voices for events that reference
 * someone no longer in state.players, match-end rows for players who left the podium).
 */
export class PlayerDirectory {
  private readonly known = new Map<string, KnownPlayer>();

  constructor(private readonly getState: () => RaftStateView | null) {}

  view(id: string): PlayerView | null {
    if (!id) return null;
    const v = this.getState()?.players.get(id) ?? null;
    if (v) this.remember(v);
    return v;
  }

  /** Raw nickname ("" when unknown). Nicknames are never translated. */
  name(id: string): string {
    return this.view(id)?.nickname ?? this.known.get(id)?.nickname ?? "";
  }

  character(id: string): CharacterId | null {
    return this.view(id)?.character ?? this.known.get(id)?.character ?? null;
  }

  seat(id: string): number {
    return this.view(id)?.seat ?? this.known.get(id)?.seat ?? -1;
  }

  /** Seat color; the HUD accent when unknown. */
  color(id: string): string {
    const seat = this.seat(id);
    return seat >= 0 ? playerColor(seat) : PALETTE.hud;
  }

  known_(id: string): KnownPlayer | null {
    this.view(id);
    return this.known.get(id) ?? null;
  }

  /** Remember every current player (on roster changes). */
  rememberAll(state: RaftStateView): void {
    state.players.forEach((v) => this.remember(v));
  }

  clear(): void {
    this.known.clear();
  }

  private remember(v: PlayerView): void {
    const k = this.known.get(v.id);
    if (!k) {
      this.known.set(v.id, { nickname: v.nickname, character: v.character, seat: v.seat, team: v.team, bot: v.bot });
      return;
    }
    k.nickname = v.nickname;
    k.character = v.character;
    k.seat = v.seat;
    k.team = v.team;
    k.bot = v.bot;
  }
}

/** Players taking part in the match (not mid-match spectators). */
export function participants(state: RaftStateView): PlayerView[] {
  const out: PlayerView[] = [];
  state.players.forEach((p) => {
    if (!p.spectator) out.push(p);
  });
  out.sort((a, b) => a.seat - b.seat);
  return out;
}

/** The site of a team (coop: the only one). */
export function siteOf(island: IslandDef | null, team: number): IslandSite | null {
  if (!island) return null;
  return island.sites[team] ?? island.sites[0] ?? null;
}

export function teamOf(state: RaftStateView, team: number): TeamView | null {
  return state.teams[team] ?? state.teams[0] ?? null;
}

/* ================================================================== home */

export function buildHomeModel(i: { nickname: string; joinCode: string; busy: boolean; error: string | null; language: Lang }): HomeModel {
  return { nickname: i.nickname, joinCode: i.joinCode, busy: i.busy, error: i.error, language: i.language };
}

/* ================================================================= lobby */

/** Keys explaining a disabled Start button: client-ui's menu.startHint_* when present, else ours (prompt.*). */
export const START_HINT = {
  host: ["menu.startHint_host", "prompt.startHint_host"],
  away: ["menu.startHint_away", "prompt.startHint_away"],
  ready: ["menu.startHint_notReady", "prompt.startHint_ready"],
  full: ["menu.startHint_notLobby", "prompt.startHint_phase"],
} as const;

function hintKey(pair: readonly [string, string]): string {
  return has(pair[0]) ? pair[0] : pair[1];
}

export function buildLobbyModel(
  state: RaftStateView,
  localId: string,
  code: string,
  link: string,
  portrait: (character: CharacterId) => string,
): LobbyModel {
  const players: LobbyPlayerModel[] = [];
  let bots = 0;
  let humans = 0;
  let notReady = 0;
  let away = 0;
  state.players.forEach((p) => {
    if (p.spectator) return;
    if (p.bot) bots++;
    else {
      humans++;
      if (p.id !== state.hostId) {
        if (!p.connected) away++;
        else if (!p.ready) notReady++;
      }
    }
    players.push({
      id: p.id,
      nickname: p.nickname,
      character: p.character,
      seat: p.seat,
      color: playerColor(p.seat),
      ready: p.bot || p.ready,
      host: p.id === state.hostId,
      bot: p.bot,
      botRole: p.botRole,
      you: p.id === localId,
      connected: p.connected,
      ping: Math.round(p.ping),
      portrait: safePortrait(portrait, p.character),
    });
  });
  players.sort((a, b) => a.seat - b.seat);
  const isHost = localId !== "" && state.hostId === localId;
  const me = state.players.get(localId);
  let startHint = "";
  if (state.phase !== "lobby") startHint = hintKey(START_HINT.full);
  else if (!isHost) startHint = hintKey(START_HINT.host);
  else if (away > 0) startHint = hintKey(START_HINT.away);
  else if (notReady > 0) startHint = hintKey(START_HINT.ready);
  const seats = players.length;
  return {
    code,
    link,
    youId: localId,
    isHost,
    players,
    maxPlayers: MAX_PLAYERS,
    mode: state.settings.mode,
    difficulty: state.settings.difficulty,
    seedSetting: state.settings.seed,
    previewSeed: state.seed,
    biome: state.biome,
    canAddBot: isHost && state.phase === "lobby" && seats < MAX_PLAYERS && bots < MAX_BOTS,
    canStart: isHost && state.phase === "lobby" && startHint === "",
    startHint,
    ready: me?.ready ?? false,
    autoBots: humans === 1 && bots === 0 ? SOLO_AUTO_BOTS : 0,
  };
}

function safePortrait(portrait: (c: CharacterId) => string, c: CharacterId): string {
  try {
    const url = portrait(c);
    return typeof url === "string" ? url : "";
  } catch {
    return "";
  }
}

/* =================================================================== HUD */

/** What LMB would do right now when E has nothing better (computed by the controller from the aim). */
export type LmbHint = "strike" | "cast" | "palm" | null;

export interface HudInputs {
  state: RaftStateView;
  /** Effective phase (flow messages beat patches). */
  phase: Phase;
  island: IslandDef | null;
  me: PlayerView | null;
  /** Predicted local sim (Net.localSim) or the rendered local frame / server view when not predicting. */
  sim: Readonly<PlayerSimFields> | null;
  /** Local position + look used for bearings (rendered frame), null = me. */
  origin: { x: number; z: number; yaw: number } | null;
  timings: Readonly<Timings>;
  /** Fractional state.clockTicks right now (Net.clockTicksAt). */
  clockTicks: number;
  /** Fractional server tick right now (timers advanced between patches). */
  serverTick: number;
  interaction: Interaction | null;
  lmb: LmbHint;
  /** The latest fishBite for me (tick + window). */
  fishBite: { tick: number; windowTicks: number } | null;
  /** From my last playerWashed event (null = unknown). */
  willRespawn: boolean | null;
  pings: ReadonlyArray<PingMark>;
  /** Landmarks the local player has discovered by walking near them. */
  known: { spring: boolean; cave: boolean };
  /** Monsters to show as danger (interpolated frames or state views). */
  monsters: ReadonlyArray<{ x: number; z: number; kind: MonsterKind; mode: MonsterMode }>;
  /** Camera is in a cinematic (launch / storm / wake-up): crosshair hidden. */
  cinematic: boolean;
  needsPointer: boolean;
  reducedFlashing: boolean;
}

/** Day / phase clock for the HUD, the sky and the sound (landing = day 1 before it starts). */
export function hudClock(phase: Phase, state: RaftStateView, timings: Readonly<Timings>, clockTicks: number): ClockInfo {
  if (phase === "landing" || phase === "lobby") {
    const c = clockAt(0, timings);
    const left = phase === "landing" ? Math.max(0, state.phaseTicksLeft) : 0;
    return { ...c, stormLeft: matchTicks(timings) + left };
  }
  return clockAt(Math.max(0, clockTicks), timings);
}

/** Ticks from `clock` until the next dawn (end of the current day cycle). */
export function ticksToDawn(clock: ClockInfo, timings: Readonly<Timings>): number {
  if (clock.dayPhase === "day") return clock.phaseLeft + timings.dusk + timings.night;
  if (clock.dayPhase === "dusk") return clock.phaseLeft + timings.night;
  return clock.phaseLeft;
}

const frac01 = (v: number, max: number): number => (max > 0 ? Math.max(0, Math.min(1, v / max)) : 0);

export function buildHudModel(i: HudInputs): HudModel {
  const { state, me, timings } = i;
  const sim = i.sim ?? me;
  const clock = hudClock(i.phase, state, timings, i.clockTicks);
  const team = me ? teamOf(state, me.team) : teamOf(state, 0);
  const hp = frac01(me?.hp ?? 0, BAR_MAX);
  const hunger = frac01(me?.hunger ?? 0, BAR_MAX);
  const thirst = frac01(me?.thirst ?? 0, BAR_MAX);
  const warmth = frac01(me?.warmth ?? 0, BAR_MAX);
  const alive = !!me && me.alive && !me.washed && !me.spectator;
  const prompt = alive ? buildPrompt(i) : null;
  const charge = sim ? chargeFraction(sim) : 0;
  const held: InvKind = sim ? heldKind(sim) : "";
  const crosshair: HudModel["crosshair"] =
    !alive || i.cinematic || me?.boarded
      ? "hidden"
      : charge > 0 || (held !== "" && isThrowable(held) && !prompt)
        ? "throw"
        : prompt
          ? "interact"
          : "dot";
  const raft = raftHud(state, team, timings, clock.day);
  return {
    phase: i.phase,
    day: clock.day,
    days: timings.days,
    dayPhase: clock.dayPhase,
    phaseSecLeft: i.phase === "landing" ? timings.day / TICK_RATE : clock.phaseLeft / TICK_RATE,
    stormSecLeft: clock.stormLeft / TICK_RATE,
    cycle: clock.cycle,
    weather: state.weather,
    hp,
    hunger,
    thirst,
    warmth,
    low: {
      hp: alive && hp < LOW_BAR_FRACTION,
      hunger: alive && hunger < LOW_BAR_FRACTION,
      thirst: alive && thirst < LOW_BAR_FRACTION,
      warmth: alive && warmth < LOW_BAR_FRACTION,
    },
    slots: buildSlots(me),
    activeSlot: sim?.activeSlot ?? 0,
    prompt,
    charge,
    fishing: fishingHud(me, i.fishBite, i.serverTick),
    raft,
    status: statusHud(i, team, timings, clock),
    heavy: heavyHud(me),
    fire: fireHud(team, state.weather, clock.dayPhase),
    compass: { yaw: i.origin?.yaw ?? me?.yaw ?? 0, marks: buildCompassMarks(i, clock) },
    downed: me && me.downed && me.alive ? { secLeft: me.downedTicks / TICK_RATE, revive: reviveProgress(state, me) } : null,
    washed:
      me && me.washed && !me.spectator
        ? {
            willRespawn: (i.willRespawn ?? true) && clock.day < timings.days,
            secToDawn: ticksToDawn(clock, timings) / TICK_RATE,
          }
        : null,
    boarded: !!me?.boarded,
    launch: state.launchTicksLeft > 0 && (i.phase === "playing" || i.phase === "landing") ? { secLeft: state.launchTicksLeft / TICK_RATE, aboard: raft.aboard, total: raft.total } : null,
    stormWarning:
      i.phase === "storm" ||
      (i.phase === "playing" && clock.day >= timings.days && clock.dayPhase === "night" && clock.stormLeft <= STORM_WARN_SEC * TICK_RATE),
    spectator: !!me?.spectator,
    crosshair,
    teammates: buildTeammates(state, me),
    needsPointer: i.needsPointer,
    reducedFlashing: i.reducedFlashing,
  };
}

/** The 4 hotbar slots (counts from the server, kinds / active slot from the prediction). */
export function buildSlots(me: PlayerView | null): SlotModel[] {
  const out: SlotModel[] = [];
  for (let s = 0; s < SLOTS; s++) {
    const kind = me ? slotKind(me, s) : "";
    const count = me ? slotCount(me, s) : 0;
    let meter = -1;
    if (kind === "torch" && me) meter = frac01(me.torchTicks, TORCH_BURN_TICKS);
    else if (kind === "puffer" && me && me.fuseTicks > 0) meter = frac01(me.fuseTicks, PUFFER_FUSE_TICKS);
    out.push({ kind, count, meter });
  }
  return out;
}

/** Prompt under the crosshair: strike > E (ok) > cast > palm > E (greyed out). */
export function buildPrompt(i: Pick<HudInputs, "interaction" | "lmb" | "sim" | "me" | "island" | "state">): PromptModel | null {
  const it = i.interaction;
  if (i.lmb === "strike") return lmbPrompt("strike");
  if (it && it.ok) return interactionPrompt(it, i);
  if (i.lmb) return lmbPrompt(i.lmb);
  if (it) return interactionPrompt(it, i);
  return null;
}

function lmbPrompt(kind: "strike" | "cast" | "palm"): PromptModel {
  return { kind: "gather", key: `prompt.${kind}`, keyGlyph: t("prompt.glyphLmb"), hold: false, progress: 0, ok: true, reason: "" };
}

/** The i18n key for an Interaction (prompt.<kind>[_<item>]). */
export function promptKey(it: Interaction, inv: Inventory | null): string {
  switch (it.kind) {
    case "gather":
      return it.item === "wood" || it.item === "stone" || it.item === "rope" || it.item === "berry" ? `prompt.gather_${it.item}` : "prompt.gather";
    case "spring":
      return inv && roomFor(inv, "water") <= 0 ? "prompt.spring_drink" : "prompt.spring";
    default:
      return `prompt.${it.kind}`;
  }
}

function interactionPrompt(it: Interaction, i: Pick<HudInputs, "sim" | "me" | "island" | "state">): PromptModel {
  const params: Record<string, string | number> = {};
  if (it.kind === "pickup" || it.kind === "deliver" || it.kind === "gather") params.item = it.item ? itemName(it.item) : "";
  if (it.kind === "revive") params.name = i.state.players.get(it.playerId)?.nickname ?? "";
  return {
    kind: it.kind,
    key: promptKey(it, i.me),
    params,
    keyGlyph: "E",
    hold: it.hold,
    progress: channelProgress(it, i.sim, i.me, i.island, i.state),
    ok: it.ok,
    reason: it.ok ? "" : it.reason,
    ...(it.ok ? {} : reasonParamsFor(it.reason, i.state, i.me)),
  };
}

/** {day} for the day-locked raft reasons (the server's reject carries none: computed from the shared schedule). */
function reasonParamsFor(reason: string, state: RaftStateView, me: PlayerView | null): { reasonParams?: Record<string, string | number> } {
  if (reason !== "stageLocked" && reason !== "seaRough") return {};
  const team = me ? teamOf(state, me.team) : teamOf(state, 0);
  if (!team) return {};
  const timings = { cheapRaft: state.fast };
  const day = reason === "seaRough" ? launchDayFor(state.difficulty, timings) : stageDayLock(team.stage, timings);
  return { reasonParams: { day } };
}

/** 0..1 of the running hold channel when it targets this interaction. */
export function channelProgress(
  it: Interaction,
  sim: Readonly<PlayerSimFields> | null,
  me: PlayerView | null,
  island: IslandDef | null,
  state: RaftStateView,
): number {
  if (!it.hold || !sim || sim.channel === CHANNEL.NONE || sim.channel !== it.channel) return 0;
  if (it.channel === CHANNEL.GATHER) {
    if (sim.channelTarget !== it.node) return 0;
    const node = island?.nodes[it.node] ?? null;
    const need = channelTicksFor(CHANNEL.GATHER, node, me ? countOf(me, "axe") > 0 : false);
    return frac01(sim.channelTicks, need);
  }
  if (it.channel === CHANNEL.BUILD) {
    // Assembly is a team bar: the current stage's work.
    const team = me ? teamOf(state, me.team) : null;
    return team && team.raftWorkNeed > 0 ? frac01(team.raftWork, team.raftWorkNeed) : 0;
  }
  if (it.channel === CHANNEL.SALVAGE) return frac01(sim.channelTicks, channelTicksFor(CHANNEL.SALVAGE, null, false, me?.character));
  if (it.channel === CHANNEL.REVIVE) {
    const target = state.players.get(it.playerId);
    if (!target || target.seat !== sim.channelTarget) return 0;
    return frac01(sim.channelTicks, REVIVE_TICKS);
  }
  return 0;
}

function fishingHud(me: PlayerView | null, bite: HudInputs["fishBite"], serverTick: number): HudModel["fishing"] {
  if (!me) return null;
  if (me.fishState === FISH_STATE.CAST) return { state: "cast", windowFrac: 0 };
  if (me.fishState === FISH_STATE.BITE) {
    const frac = bite && bite.windowTicks > 0 ? 1 - (serverTick - bite.tick) / bite.windowTicks : 1;
    return { state: "bite", windowFrac: Math.max(0, Math.min(1, frac)) };
  }
  if (me.fishState === FISH_STATE.REEL) return { state: "reel", windowFrac: 0 };
  return null;
}

/** The current stage's requirement rows (have clamped to need), in slot order; empty on the launch stage. */
export function raftParts(team: TeamView): RaftPartModel[] {
  const def = RAFT_STAGES[team.stage];
  if (!def) return [];
  return def.req.map((r, i) => {
    const need = team.raftNeed[i] ?? 0;
    return { item: r.item, have: Math.max(0, Math.min(team.raftHave[i] ?? 0, need)), need };
  });
}

/** Day the team's current stage (or, on the launch stage, the launch window) opens; 0 once it is open on `day`. */
export function raftLockDay(state: RaftStateView, team: TeamView, timings: Readonly<Timings>, day: number): number {
  const lock = team.stage >= RAFT_LAUNCH_STAGE ? launchDayFor(state.difficulty, timings) : stageDayLock(team.stage, timings);
  return Math.max(1, day) >= lock ? 0 : lock;
}

/** The raft card for `team` (Long Tide: six build stages + the launch). */
export function raftHud(state: RaftStateView, team: TeamView | null, timings: Readonly<Timings>, day: number): RaftHudModel {
  const stages = RAFT_LAUNCH_STAGE + 1;
  if (!team) return { stage: 0, stages, parts: [], lockDay: 0, assembly: -1, minHolders: 1, holders: 0, hp: -1, hpLow: false, ready: false, aboard: 0, total: 0 };
  let aboard = 0;
  let required = 0;
  let holders = 0;
  state.players.forEach((p) => {
    if (p.spectator || p.team !== team.index) return;
    if (p.boarded) aboard++;
    else if (p.alive && !p.downed && !p.washed) required++;
    if (p.alive && !p.downed && p.channel === CHANNEL.BUILD) holders++;
  });
  const parts = raftParts(team);
  const lockDay = raftLockDay(state, team, timings, day);
  const finished = team.stage >= RAFT_LAUNCH_STAGE;
  const matsDone = !finished && parts.every((p) => p.have >= p.need);
  const hp = team.stage >= 1 ? frac01(team.raftHp, RAFT_HP_MAX) : -1;
  const hpLow = team.stage >= 1 && team.raftHp < RAFT_HP_BOARD;
  return {
    stage: team.stage,
    stages,
    parts,
    lockDay,
    assembly: matsDone && team.raftWorkNeed > 0 ? frac01(team.raftWork, team.raftWorkNeed) : -1,
    minHolders: RAFT_STAGES[team.stage]?.minHolders ?? 1,
    holders,
    hp,
    hpLow,
    // Boardable: the launch window open and hp ≥ 50, or the push-off already counting (anyone may still board).
    ready: finished && (state.launchTicksLeft > 0 || (lockDay === 0 && !hpLow)),
    aboard,
    total: aboard + required,
  };
}

/** Objective / launch window / Captain Crab / spring line under the clock. */
export function statusHud(i: Pick<HudInputs, "state" | "monsters" | "phase">, team: TeamView | null, timings: Readonly<Timings>, clock: ClockInfo): StatusModel {
  if (!team || (i.phase !== "playing" && i.phase !== "landing")) return { objective: "", launchDay: 0, launchOpen: false, boss: "", spring: -1 };
  const day = Math.max(1, clock.day);
  const objDay = Math.min(7, team.stage >= RAFT_LAUNCH_STAGE ? 7 : Math.max(team.stage + 1, 1));
  const launchDay = launchDayFor(i.state.difficulty, timings);
  let boss: StatusModel["boss"] = "";
  if (!team.bossDown) {
    const here = i.monsters.some((m) => m.kind === "boss");
    const from = timings.cheapRaft ? 1 : (DIFFICULTIES[i.state.difficulty] ?? DIFFICULTIES.normal).bossFromNight;
    if (here) boss = "here";
    else if (day > from) boss = "returns";
    else if (day === from) boss = "tonight";
  }
  return { objective: `coach.obj_day${objDay}`, launchDay, launchOpen: day >= launchDay, boss, spring: team.springCharges };
}

/** Heavy cargo (log / barrel) in any slot: the escort indicator (loadMult above the lone value = escorted). */
export function heavyHud(me: PlayerView | null): HudModel["heavy"] {
  if (!me || !me.alive || me.washed) return null;
  let heavy = false;
  for (let s = 0; s < SLOTS; s++) {
    const k = slotKind(me, s);
    if (k !== "" && slotCount(me, s) > 0 && isHeavy(k)) heavy = true;
  }
  if (!heavy) return null;
  const pct = me.loadMult > 0 && me.loadMult < 100 ? me.loadMult : 100;
  const alone = carryAloneOf(me);
  return { escorted: pct > alone, pct };
}

function carryAloneOf(me: PlayerView): number {
  const c = CHARACTERS[me.character] ?? CHARACTERS[DEFAULT_CHARACTER];
  const log = countOf(me, "log") > 0;
  return log ? c.logCarryAlone : c.carryAlone;
}

function fireHud(team: TeamView | null, weather: RaftStateView["weather"], dayPhase: ClockInfo["dayPhase"]): HudModel["fire"] {
  const fuel = team?.fireFuel ?? 0;
  // Half rate by day, full at dusk / night; rain ×RAIN_FIRE_DRAIN_MULT (survival.ts; a hut's shelter is ignored here).
  const drain = (weather === "rain" ? RAIN_FIRE_DRAIN_MULT : 1) * (dayPhase === "day" ? FIRE_DAY_BURN_MULT : 1);
  return {
    frac: frac01(fuel, FIRE_FUEL_MAX_TICKS),
    lit: fuel > 0,
    // Low: about to go out, or already too weak to keep monsters out of the ring (fireRepels).
    low: fuel > 0 && (fuel < FIRE_LOW_FRACTION * FIRE_START_FUEL_TICKS * (weather === "rain" ? 2 : 1) || !fireRepels(fuel)),
    secLeft: fuel / TICK_RATE / drain,
  };
}

function reviveProgress(state: RaftStateView, me: PlayerView): number {
  let best = 0;
  state.players.forEach((q) => {
    if (q.id === me.id || q.channel !== CHANNEL.REVIVE || q.channelTarget !== me.seat) return;
    best = Math.max(best, frac01(q.channelTicks, REVIVE_TICKS));
  });
  return best;
}

export function buildTeammates(state: RaftStateView, me: PlayerView | null): TeammateModel[] {
  const out: TeammateModel[] = [];
  const team = me?.team ?? 0;
  for (const p of participants(state)) {
    if (me && p.id === me.id) continue;
    if (p.team !== team) continue;
    out.push({
      id: p.id,
      nickname: p.nickname,
      character: p.character,
      color: playerColor(p.seat),
      bot: p.bot,
      hp: frac01(p.hp, BAR_MAX),
      downed: p.downed,
      washed: p.washed,
      boarded: p.boarded,
      connected: p.connected,
    });
  }
  return out;
}

/* ============================================================== compass */

/** Danger marks: monsters within this range (m), nearest first, at most DANGER_MAX. */
export const DANGER_RANGE = 30;
export const DANGER_MAX = 6;
/** Spyglass: the nearest few nodes of each resource kind. */
export const SPYGLASS_PER_KIND = 3;

const MARKER_ICON: Readonly<Record<PingMark["kind"], string>> = { here: "📍", help: "🆘", need: "❗", danger: "⚠️" };
const MONSTER_ICON: Readonly<Record<MonsterKind, string>> = { crab: "🦀", puffer: "🐡", boss: "👑", monkey: "🐒", gull: "🐦" };

/** Compass strip marks (fog hides everything but pings, game4.md §9). */
export function buildCompassMarks(i: HudInputs, clock: ClockInfo): CompassMark[] {
  const marks: CompassMark[] = [];
  const me = i.me;
  const ox = i.origin?.x ?? me?.x ?? 0;
  const oz = i.origin?.z ?? me?.z ?? 0;
  const add = (kind: CompassMark["kind"], x: number, z: number, color: string, icon: string, label: string): void => {
    const dx = x - ox;
    const dz = z - oz;
    const dist = Math.hypot(dx, dz);
    marks.push({ kind, bearing: dist > 1e-3 ? wrapAngle(yawFromDir(dx, dz)) : 0, dist, color, icon, label });
  };
  for (const p of i.pings) {
    const label = p.kind === "need" && p.need ? itemName(p.need) : t(`prompt.mark_${p.kind}`);
    const seat = i.state.players.get(p.playerId)?.seat ?? -1;
    const icon = p.kind === "need" && p.need ? ITEMS[p.need].icon : MARKER_ICON[p.kind];
    add("ping", p.pos.x, p.pos.z, seat >= 0 ? playerColor(seat) : PALETTE.hud, icon, label);
  }
  if (i.state.weather === "fog") return marks;
  const team = me?.team ?? 0;
  const site = siteOf(i.island, team);
  const teamView = teamOf(i.state, team);
  if (site) {
    add("camp", site.campfire.x, site.campfire.z, PALETTE.fire, "🔥", t("prompt.mark_camp"));
    add("raft", site.raft.x, site.raft.z, PALETTE.hud, "🛶", t("prompt.mark_raft"));
    if (teamView?.springRevealed || i.known.spring) add("spring", site.spring.x, site.spring.z, PALETTE.sea, "💧", t("prompt.mark_spring"));
    if (teamView?.secretRevealed && !teamView.secretOpened) add("secret", site.secretChest.x, site.secretChest.z, PALETTE.hud, "💰", t("prompt.mark_secret"));
    if (site.cave && i.known.cave) add("cave", site.cave.x, site.cave.z, PALETTE.cream, "⛰️", t("prompt.mark_cave"));
  }
  for (const p of participants(i.state)) {
    if (me && p.id === me.id) continue;
    if (p.team !== team || !p.alive || p.washed) continue;
    add("player", p.x, p.z, playerColor(p.seat), p.downed ? "🤕" : "🧍", p.nickname);
  }
  if (teamView && teamView.spyglassTicks > 0 && i.island) addSpyglassMarks(i, ox, oz, add);
  if (clock.dayPhase !== "day" || i.phase === "storm") addDangerMarks(i, ox, oz, add);
  return marks;
}

type AddMark = (kind: CompassMark["kind"], x: number, z: number, color: string, icon: string, label: string) => void;

function addSpyglassMarks(i: HudInputs, ox: number, oz: number, add: AddMark): void {
  const island = i.island!;
  const nodes = i.state.nodes;
  const buckets = new Map<string, { x: number; z: number; d: number }[]>();
  for (const n of island.nodes) {
    const amount = n.i < nodes.length ? (nodes[n.i] ?? 0) : n.amount;
    if (amount <= 0) continue;
    const key = n.kind === "bush" ? `bush_${n.yield}` : n.kind;
    if (key === "bush_none") continue;
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push({ x: n.x, z: n.z, d: Math.hypot(n.x - ox, n.z - oz) });
  }
  const look: Record<string, { icon: string; item: ItemKind | "berry" }> = {
    tree: { icon: "🌳", item: "wood" },
    rock: { icon: "🪨", item: "stone" },
    palm: { icon: "🥥", item: "coconut" },
    bush_rope: { icon: "🧵", item: "rope" },
    bush_berry: { icon: "🫐", item: "berry" },
  };
  for (const [key, list] of buckets) {
    const meta = look[key];
    if (!meta) continue;
    list.sort((a, b) => a.d - b.d);
    for (const p of list.slice(0, SPYGLASS_PER_KIND)) add("resource", p.x, p.z, PALETTE.grass, meta.icon, itemName(meta.item));
  }
  const spots = island.fishSpots.map((s) => ({ x: s.x, z: s.z, d: Math.hypot(s.x - ox, s.z - oz) })).sort((a, b) => a.d - b.d);
  for (const s of spots.slice(0, SPYGLASS_PER_KIND)) add("resource", s.x, s.z, PALETTE.sea, "🎣", t("prompt.mark_fish"));
}

function addDangerMarks(i: HudInputs, ox: number, oz: number, add: AddMark): void {
  const near: { x: number; z: number; d: number; kind: MonsterKind }[] = [];
  for (const m of i.monsters) {
    if (m.kind === "monkey" || m.kind === "gull") continue;
    if (m.mode === "flee" || m.mode === "flipped") continue;
    const d = Math.hypot(m.x - ox, m.z - oz);
    if (d <= DANGER_RANGE) near.push({ x: m.x, z: m.z, d, kind: m.kind });
  }
  near.sort((a, b) => a.d - b.d);
  for (const m of near.slice(0, DANGER_MAX)) add("danger", m.x, m.z, PALETTE.crab, MONSTER_ICON[m.kind], t(`prompt.mark_${m.kind}`));
}

/* ================================================================ panels */

/** Craft panel rows: ingredients count the inventory plus the camp chest (game4.md §7). */
export function buildCraftPanel(state: RaftStateView, me: PlayerView | null): CraftPanelModel {
  const team = me ? teamOf(state, me.team) : teamOf(state, 0);
  const fuel = team?.fireFuel ?? 0;
  const fireLit = fuel > 0;
  const recipes: RecipeRowModel[] = [];
  for (const id of RECIPE_IDS) {
    const def = RECIPES[id];
    if (def.duelOnly && state.layout !== "duel") continue;
    const locked = def.locked && !(team?.ballRecipe ?? false);
    const cost: RecipeRowModel["cost"] = [];
    let enough = true;
    for (const kind of Object.keys(def.cost) as ItemKind[]) {
      const need = def.cost[kind] ?? 0;
      if (need <= 0) continue;
      const have = (me ? countOf(me, kind) : 0) + chestCount(team, kind);
      if (have < need) enough = false;
      cost.push({ kind, have, need });
    }
    const alive = !!me && me.alive && !me.downed && !me.washed;
    const tier = team?.benchTier ?? 0;
    const day = Math.max(1, state.day);
    let gate: NonNullable<RecipeRowModel["gate"]> = "";
    const gateParams: Record<string, string | number> = {};
    if (def.effect === "bench" && tier >= def.tier) gate = "built";
    else if (def.bench > tier) {
      gate = "needBench";
      gateParams.bench = t(`hud.bench_${def.bench}`);
    } else if (!state.fast && def.minDay > day) {
      gate = "tooEarly";
      gateParams.day = def.minDay;
    }
    recipes.push({ id, cost, ok: alive && enough && !locked && gate === "" && (fireLit || def.effect === "fuel"), locked, out: def.out, gate, gateParams });
  }
  return { recipes, benchTier: team?.benchTier ?? 0, fireLit, fuelFrac: frac01(fuel, FIRE_FUEL_MAX_TICKS), fuelSec: fuel / TICK_RATE };
}

function chestCount(team: TeamView | null, kind: ItemKind): number {
  const n = team?.chest.get(kind);
  return typeof n === "number" && n > 0 ? n : 0;
}

/** Camp chest contents (ITEMS order) + the hotbar. */
export function buildChestPanel(state: RaftStateView, me: PlayerView | null, activeSlot: number): ChestPanelModel {
  const team = me ? teamOf(state, me.team) : teamOf(state, 0);
  const chest: { kind: ItemKind; count: number }[] = [];
  if (team) {
    team.chest.forEach((count, kind) => {
      if (isItemKind(kind) && count > 0) chest.push({ kind, count });
    });
  }
  chest.sort((a, b) => ITEM_KINDS.indexOf(a.kind) - ITEM_KINDS.indexOf(b.kind));
  return { chest, slots: buildSlots(me), activeSlot };
}

/* ============================================================ scoreboard */

function scoreRow(p: PlayerView, localId: string): ScoreRow {
  return {
    id: p.id,
    nickname: p.nickname,
    character: p.character,
    color: playerColor(p.seat),
    bot: p.bot,
    you: p.id === localId,
    score: p.score,
    stats: copyStats(p.stats),
    ping: Math.round(p.ping),
  };
}

/** Tab table: participants by MVP score (ties: delivered, then seat). */
export function buildScoreRows(state: RaftStateView, localId: string): ScoreRow[] {
  const players = participants(state);
  players.sort((a, b) => b.score - a.score || (b.stats?.delivered ?? 0) - (a.stats?.delivered ?? 0) || a.seat - b.seat);
  return players.map((p) => scoreRow(p, localId));
}

function copyStats(s: StatsView | undefined): StatsView {
  return {
    gathered: s?.gathered ?? 0,
    delivered: s?.delivered ?? 0,
    hits: s?.hits ?? 0,
    kills: s?.kills ?? 0,
    revives: s?.revives ?? 0,
    fish: s?.fish ?? 0,
    eaten: s?.eaten ?? 0,
    coconuts: s?.coconuts ?? 0,
    downs: s?.downs ?? 0,
    crafted: s?.crafted ?? 0,
    raids: s?.raids ?? 0,
  };
}

/** A stable signature of what the scoreboard shows (rebuild rows only when it changes). */
export function scoreSignature(state: RaftStateView): string {
  let sig = "";
  state.players.forEach((p) => {
    const s = p.stats;
    sig += `${p.id}:${p.score}:${p.seat}:${p.spectator ? 1 : 0}:${Math.round(p.ping / 10)}:${s?.gathered}:${s?.delivered}:${s?.hits}:${s?.kills}:${s?.revives}:${s?.fish}|`;
  });
  return sig;
}

/* ============================================================= match end */

/** Rematch accepted after timings.matchEndMin on the podium; auto-lobby countdown. */
export function matchEndTiming(state: RaftStateView, timings: Readonly<Timings>): { canRematch: boolean; secToLobby: number } {
  const left = state.phase === "matchEnd" ? Math.max(0, state.phaseTicksLeft) : 0;
  return {
    canRematch: state.phase === "matchEnd" && timings.matchEndLobby - left >= timings.matchEndMin,
    secToLobby: Math.ceil(left / TICK_RATE),
  };
}

/**
 * Podium from the MatchEndEvent standings when we got them (rows for players who left come from the
 * directory), else rebuilt from the live state (reconnect during the podium).
 */
export function buildMatchEndModel(
  state: RaftStateView,
  localId: string,
  ev: MatchEndEvent | null,
  timings: Readonly<Timings>,
  dir: PlayerDirectory | null,
): MatchEndModel {
  const me = state.players.get(localId) ?? null;
  const myTeam = me?.team ?? 0;
  const winnerTeam = ev ? ev.winnerTeam : state.winnerTeam;
  const rows: MatchEndRow[] = [];
  if (ev && ev.standings.length > 0) {
    for (const s of ev.standings) rows.push(standingRow(s, state, localId, dir));
  } else {
    const ranked = buildScoreRows(state, localId);
    ranked.forEach((r, idx) => {
      const p = state.players.get(r.id);
      rows.push({ ...r, place: idx + 1, titles: [], aboard: !!p?.boarded });
    });
  }
  rows.sort((a, b) => a.place - b.place);
  const timing = matchEndTiming(state, timings);
  const mvpId = ev?.mvpId || rows[0]?.id || "";
  return {
    win: winnerTeam >= 0 && winnerTeam === myTeam,
    reason: ev?.reason ?? state.winReason,
    secLeft: (ev?.ticksLeft ?? 0) / TICK_RATE,
    teamScore: ev?.teamScores[myTeam] ?? teamOf(state, myTeam)?.score ?? 0,
    seed: ev?.seed ?? state.seed,
    biome: ev?.biome ?? state.biome,
    mvpId,
    rows,
    canRematch: timing.canRematch,
    secToLobby: timing.secToLobby,
  };
}

function standingRow(s: StandingEntry, state: RaftStateView, localId: string, dir: PlayerDirectory | null): MatchEndRow {
  const p = state.players.get(s.id);
  const known = dir?.known_(s.id) ?? null;
  const seat = p?.seat ?? known?.seat ?? 0;
  return {
    id: s.id,
    nickname: p?.nickname ?? known?.nickname ?? "?",
    character: p?.character ?? known?.character ?? DEFAULT_CHARACTER,
    color: playerColor(seat),
    bot: p?.bot ?? known?.bot ?? false,
    you: s.id === localId,
    score: s.score,
    stats: copyStats(s.stats),
    ping: Math.round(p?.ping ?? 0),
    place: s.place,
    titles: [...s.titles],
    aboard: s.aboard,
  };
}

/* ================================================================= misc */

/** Translated short name of a player for feed params (nickname; "?" when unknown). */
export function nameOf(dir: PlayerDirectory, id: string): string {
  return dir.name(id) || "?";
}
