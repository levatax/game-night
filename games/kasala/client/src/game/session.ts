// Room session plumbing: share links, the remembered nickname, an empty state for clearing modules, and
// a fallback match-end summary built from state (reconnect during the podium). Owner: client-net-game.

import { CODE_LENGTH, DEFAULT_DECISION_SEC, NICKNAME_STORAGE_KEY, RECONNECT_STORAGE_KEY } from "../../../shared/constants";
import type { KasalaStateView, MapLike, MatchEndMsg, PlayerView } from "../../../shared/protocol";
import { participants } from "./turn";

const CODE_RE = new RegExp(`^[A-Za-z]{${CODE_LENGTH}}$`);

/** The room code from `?room=CODE` or a `/games/kasala/r/CODE` path (null when none). */
export function shareCode(): string | null {
  try {
    const q = new URLSearchParams(location.search).get("room") ?? "";
    if (CODE_RE.test(q)) return q.toUpperCase();
    const m = /\/r\/([A-Za-z]+)\/?$/.exec(location.pathname);
    if (m && CODE_RE.test(m[1])) return m[1].toUpperCase();
  } catch {
    /* sandboxed */
  }
  return null;
}

/** Keep the address bar shareable: /games/kasala/?room=CODE in a room, the bare game URL otherwise. */
export function setUrlRoom(code: string): void {
  try {
    const url = new URL(location.href);
    const base = import.meta.env.BASE_URL || "/games/kasala/";
    if (/\/r\/[A-Za-z]+\/?$/.test(url.pathname)) url.pathname = base;
    if (code) url.searchParams.set("room", code);
    else url.searchParams.delete("room");
    if (url.href !== location.href) history.replaceState(null, "", url.href);
  } catch {
    /* sandboxed iframe etc. */
  }
}

export function storedNickname(): string {
  try {
    return localStorage.getItem(NICKNAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeNickname(nickname: string): void {
  try {
    localStorage.setItem(NICKNAME_STORAGE_KEY, nickname);
  } catch {
    /* private mode */
  }
}

/** A reload-rejoin token is waiting (Net.tryReconnect will try it). */
export function hasReconnectToken(): boolean {
  try {
    return !!sessionStorage.getItem(RECONNECT_STORAGE_KEY);
  } catch {
    return false;
  }
}

function emptyMap<T>(): MapLike<T> {
  return new Map<string, T>();
}

/** A state with nobody in it: modules that only clear through sync/update get a clean slate. */
export function emptyState(): KasalaStateView {
  return {
    phase: "lobby",
    code: "",
    hostId: "",
    settings: { mode: "classic", turns: 0, decisionSec: DEFAULT_DECISION_SEC, loans: true, sideBets: false },
    players: emptyMap<PlayerView>(),
    turnOrder: [],
    round: 0,
    totalRounds: 0,
    turnInRound: 0,
    turnsPerRound: 0,
    activeId: "",
    timeLeft: 0,
    timeTotal: 0,
    busy: false,
    sirenLevel: 0,
    raidChance: 0,
    floorBonus: 0,
    turnPot: 0,
    row: [],
    marketDone: [],
    flips: 0,
    lawyers: 0,
    curseArmed: false,
    kumbara: 0,
    finalTable: false,
    betsLocked: false,
    lastCard: { flipNo: 0, id: "", rarity: "", value: 0, targetId: "" },
    pendingCard: "",
    wheelSlice: "",
    lastChanceId: "",
    bets: emptyMap(),
    debts: emptyMap(),
    offers: emptyMap(),
  };
}

/** Match-end summary rebuilt from state (we joined after MATCH_END went out): standings only. */
export function matchEndFromState(s: KasalaStateView): MatchEndMsg {
  const players = participants(s);
  const ranked = players.slice().sort((a, b) => {
    if (a.place > 0 && b.place > 0) return a.place - b.place;
    if (a.place > 0) return -1;
    if (b.place > 0) return 1;
    return b.kasa - a.kasa;
  });
  const standings = ranked.map((p, i) => ({ playerId: p.id, place: p.place > 0 ? p.place : i + 1, kasa: p.kasa }));
  return {
    mode: s.settings.mode,
    collections: [],
    titles: [],
    standings,
    winnerId: standings[0]?.playerId ?? "",
  };
}
