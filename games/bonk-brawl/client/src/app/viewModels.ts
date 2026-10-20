// Net state → ui/models.ts view models (HUD, scoreboard, lobby, round end, podium). Owner: client-app.
// Pure builders plus two small caches; the UI never reads net state itself.

import {
  CATCH_COOLDOWN_TICKS,
  CHARACTERS,
  CHARGE_FULL_TICKS,
  CHARACTER_IDS,
  DEFAULT_CHARACTER,
  FULL_CHARGE_THRESHOLD,
  MATCH_END_LOBBY_TICKS,
  MATCH_END_MIN_TICKS,
  MAX_HEARTS,
  MAX_HELD_BALLS,
  MAX_HELD_BALLS_TRIPLE,
  MAX_PLAYERS,
  MIN_PLAYERS_TO_START,
  PALETTE,
  ROLL_COOLDOWN_TICKS,
  TICK_RATE,
  ZOOMIES_TICKS,
  playerColor,
} from "../../../shared/constants";
import type { RoundWinEvent, StandingEntry } from "../../../shared/protocol";
import type { BonkStateView, CharacterId, Phase, PlayerSimFields, PlayerView } from "../../../shared/types";
import type {
  AbilityHud,
  FeedPlayer,
  HudModel,
  LobbyModel,
  LobbyPlayerCard,
  MatchEndModel,
  PodiumEntry,
  RoundEndModel,
  ScoreRow,
} from "../ui/models";

export type SpectateReason = "ko" | "ringOut" | "spectator";

type SpectatingHud = NonNullable<HudModel["spectating"]>;

/** One frozen object per reason so the per-frame HUD build never allocates it. */
const SPECTATING: Readonly<Record<SpectateReason, Readonly<SpectatingHud>>> = {
  ko: { reason: "ko", text: "BONKED OUT! You're a ghost until the round ends" },
  ringOut: { reason: "ringOut", text: "RUNG OUT! You're a ghost until the round ends" },
  spectator: { reason: "spectator", text: "Match in progress: spectating" },
};

export function isRoundPhase(phase: Phase): boolean {
  return phase === "countdown" || phase === "playing" || phase === "suddenDeath" || phase === "roundEnd";
}

/* ============================================================ players */

interface KnownPlayer {
  name: string;
  character: CharacterId;
  slot: number;
}

const UNKNOWN_FEED_PLAYER: Readonly<FeedPlayer> = { name: "Someone", emoji: "❔", color: PALETTE.ink };

/**
 * Player lookups that keep working after a player left mid-frame (kill feed lines and voices for
 * events that reference someone no longer in state.players).
 */
export class PlayerDirectory {
  private readonly known = new Map<string, KnownPlayer>();

  constructor(private readonly getState: () => BonkStateView | null) {}

  view(id: string): PlayerView | null {
    if (!id) return null;
    const v = this.getState()?.players.get(id) ?? null;
    if (v) this.remember(v);
    return v;
  }

  /** Slot color, PALETTE.neutralBall when unknown (allocation-free: called per ball per frame). */
  color(id: string): string {
    if (!id) return PALETTE.neutralBall;
    const v = this.getState()?.players.get(id);
    if (v) return playerColor(v.slot);
    const k = this.known.get(id);
    return k ? playerColor(k.slot) : PALETTE.neutralBall;
  }

  character(id: string): CharacterId | null {
    return this.view(id)?.character ?? this.known.get(id)?.character ?? null;
  }

  feed(id: string): FeedPlayer {
    this.view(id);
    const k = this.known.get(id);
    if (!k) return UNKNOWN_FEED_PLAYER;
    return { name: k.name, emoji: CHARACTERS[k.character]?.emoji ?? "❔", color: playerColor(k.slot) };
  }

  /** Remember every current player (call when the roster changes, not every frame). */
  rememberAll(state: BonkStateView): void {
    state.players.forEach((v) => this.remember(v));
  }

  clear(): void {
    this.known.clear();
  }

  private remember(v: PlayerView): void {
    const k = this.known.get(v.id);
    if (!k) {
      this.known.set(v.id, { name: v.nickname, character: v.character, slot: v.slot });
      return;
    }
    k.name = v.nickname;
    k.character = v.character;
    k.slot = v.slot;
  }
}

/* ========================================================= scoreboard */

function mix(h: number, v: number): number {
  return (Math.imul(h, 31) + (v | 0)) | 0;
}

function scoreHash(state: BonkStateView, localId: string, version: number): number {
  let h = mix(version, state.players.size);
  h = mix(h, state.crownId.length);
  for (const p of state.players.values()) {
    h = mix(h, p.slot);
    h = mix(h, p.points);
    h = mix(h, p.hearts);
    h = mix(h, (p.alive ? 1 : 0) | (p.connected ? 2 : 0) | (p.spectator ? 4 : 0) | (p.id === state.crownId ? 8 : 0));
    h = mix(h, (p.id === localId ? 1 : 0) | (CHARACTER_IDS.indexOf(p.character) << 1));
    h = mix(h, p.ping);
    h = mix(h, p.nickname.length);
    const s = p.stats;
    if (s) {
      h = mix(h, s.roundWins);
      h = mix(h, s.hits);
      h = mix(h, s.catches);
      h = mix(h, s.ringOuts);
    }
  }
  return h;
}

function buildScoreRow(p: PlayerView, state: BonkStateView, localId: string): ScoreRow {
  const def = CHARACTERS[p.character] ?? CHARACTERS[DEFAULT_CHARACTER];
  return {
    id: p.id,
    nickname: p.nickname,
    character: def.id,
    emoji: def.emoji,
    color: playerColor(p.slot),
    points: p.points,
    hasCrown: state.crownId !== "" && state.crownId === p.id,
    isYou: p.id === localId,
    alive: p.alive,
    hearts: p.hearts,
    connected: p.connected,
    ping: Math.round(p.ping),
    roundWins: p.stats?.roundWins ?? 0,
    hits: p.stats?.hits ?? 0,
    catches: p.stats?.catches ?? 0,
    ringOuts: p.stats?.ringOuts ?? 0,
  };
}

function compareRows(a: ScoreRow, b: ScoreRow, slotOf: (id: string) => number): number {
  return b.points - a.points || b.roundWins - a.roundWins || slotOf(a.id) - slotOf(b.id);
}

/**
 * Scoreboard rows (non-spectators, sorted by points), rebuilt only when something they show
 * changed, so the per-frame HUD build doesn't allocate rows.
 */
export class ScoreRowsCache {
  private rows: ScoreRow[] = [];
  private hash = NaN;

  get(state: BonkStateView, localId: string, version: number): ScoreRow[] {
    const h = scoreHash(state, localId, version);
    if (h === this.hash) return this.rows;
    this.hash = h;
    const rows: ScoreRow[] = [];
    for (const p of state.players.values()) {
      if (!p.spectator) rows.push(buildScoreRow(p, state, localId));
    }
    const slotOf = (id: string): number => state.players.get(id)?.slot ?? MAX_PLAYERS;
    rows.sort((a, b) => compareRows(a, b, slotOf));
    this.rows = rows;
    return rows;
  }

  invalidate(): void {
    this.hash = NaN;
  }
}

/* ================================================================ HUD */

export interface HudInputs {
  state: BonkStateView;
  me: PlayerView | null;
  /** Predicted local sim (net.localSim) or, when not predicting, the server view. */
  sim: Readonly<PlayerSimFields> | null;
  timerSec: number;
  countdown: number | null;
  scoreboard: ScoreRow[];
  spectating: SpectateReason | null;
}

function frac(ticks: number | undefined, total: number): number {
  return total > 0 ? Math.min(1, Math.max(0, (ticks ?? 0) / total)) : 0;
}

/** Crosshair gap at full charge (1 = idle width). */
const CROSSHAIR_MIN_SPREAD = 0.15;

/**
 * Builds the per-frame HudModel into ONE reused object (the UI diffs values, never references),
 * so the hot path doesn't allocate.
 */
export class HudModelBuilder {
  private readonly ability: AbilityHud = { name: "", icon: "", cooldownFrac: 0, ready: true, active: false, armed: false };
  private readonly model: HudModel = {
    phase: "lobby",
    round: 0,
    totalRounds: 0,
    timerSec: 0,
    suddenDeath: false,
    countdown: null,
    hearts: 0,
    maxHearts: MAX_HEARTS,
    ability: this.ability,
    charge: 0,
    charging: false,
    fullCharge: false,
    crosshairSpread: 1,
    heldBalls: 0,
    maxHeld: MAX_HELD_BALLS,
    powerUp: "",
    zoomiesFrac: 0,
    catchCooldownFrac: 0,
    rollCooldownFrac: 0,
    scoreboard: [],
    spectating: null,
    color: PALETTE.uiYellow,
    ping: 0,
  };

  build(i: HudInputs): HudModel {
    const { state, me, sim } = i;
    const m = this.model;
    const chargeTicks = sim?.chargeTicks ?? 0;
    const charge = Math.min(1, chargeTicks / CHARGE_FULL_TICKS);
    const powerUp = sim?.powerUp ?? "";
    m.phase = state.phase;
    m.round = state.round;
    m.totalRounds = state.totalRounds;
    m.timerSec = i.timerSec;
    m.suddenDeath = state.phase === "suddenDeath";
    m.countdown = i.countdown;
    m.hearts = me?.hearts ?? 0;
    this.fillAbility(me?.character ?? DEFAULT_CHARACTER, sim);
    m.charge = charge;
    m.charging = chargeTicks > 0;
    m.fullCharge = charge >= FULL_CHARGE_THRESHOLD;
    m.crosshairSpread = 1 - (1 - CROSSHAIR_MIN_SPREAD) * charge;
    m.heldBalls = sim?.heldCount ?? 0;
    m.maxHeld = powerUp === "triple" ? MAX_HELD_BALLS_TRIPLE : MAX_HELD_BALLS;
    m.powerUp = powerUp;
    m.zoomiesFrac = frac(sim?.zoomiesTicks, ZOOMIES_TICKS);
    m.catchCooldownFrac = frac(sim?.catchCooldown, CATCH_COOLDOWN_TICKS);
    m.rollCooldownFrac = frac(sim?.rollCooldown, ROLL_COOLDOWN_TICKS);
    m.scoreboard = i.scoreboard;
    m.spectating = i.spectating ? SPECTATING[i.spectating] : null;
    m.color = me ? playerColor(me.slot) : PALETTE.uiYellow;
    m.ping = Math.round(me?.ping ?? 0);
    return m;
  }

  private fillAbility(character: CharacterId, sim: Readonly<PlayerSimFields> | null): void {
    const def = (CHARACTERS[character] ?? CHARACTERS[DEFAULT_CHARACTER]).ability;
    const a = this.ability;
    const cooldown = sim?.abilityCooldown ?? 0;
    a.name = def.name;
    a.icon = def.icon;
    a.active = (sim?.abilityTicks ?? 0) > 0;
    a.cooldownFrac = def.cooldownTicks > 0 ? Math.min(1, cooldown / def.cooldownTicks) : 0;
    a.ready = cooldown <= 0 && !a.active;
    a.armed = sim?.curveArmed ?? false;
  }
}

/* ============================================================== lobby */

function lobbyCard(p: PlayerView, state: BonkStateView, localId: string): LobbyPlayerCard {
  const def = CHARACTERS[p.character] ?? CHARACTERS[DEFAULT_CHARACTER];
  return {
    id: p.id,
    nickname: p.nickname,
    character: def.id,
    emoji: def.emoji,
    slot: p.slot,
    color: playerColor(p.slot),
    ready: p.ready,
    isHost: p.id === state.hostId,
    isYou: p.id === localId,
    connected: p.connected,
    spectator: p.spectator,
    ping: Math.round(p.ping),
  };
}

function startHint(isHost: boolean, players: LobbyPlayerCard[]): string {
  const contenders = players.filter((p) => !p.spectator);
  if (contenders.length < MIN_PLAYERS_TO_START) return `Need at least ${MIN_PLAYERS_TO_START} players — share the code!`;
  const disconnected = contenders.filter((p) => !p.connected).length;
  if (disconnected > 0) return disconnected === 1 ? "Waiting for a player to reconnect…" : `Waiting for ${disconnected} players to reconnect…`;
  const notReady = contenders.filter((p) => !p.ready).length;
  if (notReady > 0) return notReady === 1 ? "Waiting for 1 player to get ready" : `Waiting for ${notReady} players to get ready`;
  return isHost ? "" : "Waiting for the host to start…";
}

export function buildLobbyModel(state: BonkStateView, localId: string, code: string, origin: string): LobbyModel {
  const players: LobbyPlayerCard[] = [];
  for (const p of state.players.values()) players.push(lobbyCard(p, state, localId));
  players.sort((a, b) => a.slot - b.slot);
  const me = state.players.get(localId);
  const isHost = state.hostId === localId;
  const hint = startHint(isHost, players);
  return {
    code,
    shareUrl: `${origin}/r/${code}`,
    players: players.slice(0, MAX_PLAYERS),
    you: {
      id: localId,
      character: me?.character ?? DEFAULT_CHARACTER,
      ready: me?.ready ?? false,
      isHost,
      spectator: me?.spectator ?? false,
    },
    settings: { map: state.settings.map, rounds: state.settings.rounds, powerUps: state.settings.powerUps },
    canStart: isHost && hint === "" && state.phase === "lobby",
    startHint: hint,
    phase: state.phase,
  };
}

/* ========================================================== round end */

export function buildRoundEndModel(ev: RoundWinEvent, state: BonkStateView | null, localId: string, dir: PlayerDirectory): RoundEndModel {
  const winnerView = ev.winnerId ? dir.view(ev.winnerId) : null;
  const winnerChar = ev.winnerId ? dir.character(ev.winnerId) : null;
  const winnerFeed = ev.winnerId ? dir.feed(ev.winnerId) : null;
  const rows: RoundEndModel["rows"] = [];
  if (state) {
    for (const p of state.players.values()) {
      if (p.spectator) continue;
      rows.push({
        id: p.id,
        name: p.nickname,
        emoji: (CHARACTERS[p.character] ?? CHARACTERS[DEFAULT_CHARACTER]).emoji,
        color: playerColor(p.slot),
        roundPoints: ev.roundPoints[p.id] ?? p.roundPoints,
        totalPoints: p.points,
        isWinner: p.id === ev.winnerId,
        isYou: p.id === localId,
      });
    }
  }
  rows.sort((a, b) => b.totalPoints - a.totalPoints || b.roundPoints - a.roundPoints);
  return {
    round: ev.round,
    totalRounds: state?.totalRounds ?? ev.round,
    winner:
      winnerFeed && winnerChar
        ? { id: ev.winnerId, name: winnerView?.nickname ?? winnerFeed.name, character: winnerChar, emoji: winnerFeed.emoji, color: winnerFeed.color }
        : null,
    rows,
    nextRound: ev.nextRound,
  };
}

/* ========================================================== match end */

function podiumEntry(p: PlayerView, place: number, localId: string): PodiumEntry {
  const def = CHARACTERS[p.character] ?? CHARACTERS[DEFAULT_CHARACTER];
  const s = p.stats;
  const hits = s?.hits ?? 0;
  return {
    id: p.id,
    name: p.nickname,
    character: def.id,
    emoji: def.emoji,
    color: playerColor(p.slot),
    place,
    points: p.points,
    isYou: p.id === localId,
    stats: {
      hits,
      catches: s?.catches ?? 0,
      ringOuts: s?.ringOuts ?? 0,
      kos: s?.kos ?? 0,
      roundWins: s?.roundWins ?? 0,
      accuracy: Math.min(100, Math.round((100 * hits) / Math.max(1, s?.throws ?? 0))),
    },
  };
}

/** Seconds until the room returns to the lobby, and whether the server accepts a rematch yet. */
export function matchEndTiming(state: BonkStateView): { autoLobbySec: number; canRematch: boolean } {
  const left = state.phase === "matchEnd" ? Math.max(0, state.phaseTicksLeft) : 0;
  return {
    autoLobbySec: Math.ceil(left / TICK_RATE),
    canRematch: state.phase === "matchEnd" && MATCH_END_LOBBY_TICKS - left >= MATCH_END_MIN_TICKS,
  };
}

/**
 * Podium from the live state (works after a reconnect), ordered by the MatchEndEvent standings
 * when we got them, else by state.place / points.
 */
export function buildMatchEndModel(state: BonkStateView, localId: string, standings: readonly StandingEntry[] | null): MatchEndModel {
  const placeOf = new Map<string, number>();
  standings?.forEach((s) => placeOf.set(s.id, s.place));
  const entries: PodiumEntry[] = [];
  for (const p of state.players.values()) {
    if (p.spectator) continue;
    const place = placeOf.get(p.id) ?? (p.place > 0 ? p.place : 0);
    entries.push(podiumEntry(p, place, localId));
  }
  entries.sort((a, b) => (a.place || 99) - (b.place || 99) || b.points - a.points);
  entries.forEach((e, i) => {
    if (e.place <= 0) e.place = i + 1;
  });
  const timing = matchEndTiming(state);
  return {
    entries,
    winnerId: state.matchWinnerId || entries[0]?.id || "",
    canRematch: timing.canRematch,
    autoLobbySec: timing.autoLobbySec,
  };
}
