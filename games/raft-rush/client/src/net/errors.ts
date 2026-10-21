// User-facing connection errors (pure, no colyseus.js import so it is unit-testable). Owner: client-net.
// Adapted from games/bonk-brawl/client/src/net/errors.ts: NetError.message is an i18n key under `menu.`
// (docs/ARCHITECTURE.md §7; client-ui writes the English + Turkish text), never a raw server string.

import { CLOSE_CODE, JOIN_ERROR } from "../../../shared/protocol";
import type { NetError } from "./types";

/** Colyseus matchmaker codes (colyseus.js ErrorCode), mirrored to keep this module dependency-free. */
export const MATCHMAKE_INVALID_ROOM_ID = 4212;
export const MATCHMAKE_EXPIRED = 4214;
/**
 * WebSocket close codes. 1000 (normal closure) is NOT final: reverse proxies and idle timeouts send it when they
 * drop a socket the room never closed, so it is retried like a network drop. Only 4000 (the room closed itself,
 * or our own consented leave) means "don't reconnect".
 */
export const CLOSE_NORMAL = 1000;
export const CLOSE_CONSENTED = 4000;

/** i18n key for every NetError kind (ARCHITECTURE §7: `menu.err<Kind>`). */
export const ERROR_KEYS: Readonly<Record<NetError["kind"], string>> = {
  roomFull: "menu.errRoomFull",
  notFound: "menu.errNotFound",
  badNickname: "menu.errBadNickname",
  badCharacter: "menu.errBadCharacter",
  serverDown: "menu.errServerDown",
  serverBusy: "menu.errServerBusy",
  serverRestart: "menu.errServerRestart",
  outdated: "menu.errOutdated",
  kicked: "menu.errKicked",
  unknown: "menu.errUnknown",
};

/** A NetError of `kind` with its i18n key as the message. */
export function netError(kind: NetError["kind"]): NetError {
  return { kind, message: ERROR_KEYS[kind] };
}

const KIND_BY_JOIN_ERROR: Readonly<Record<number, NetError["kind"]>> = {
  [JOIN_ERROR.ROOM_FULL]: "roomFull",
  [JOIN_ERROR.BAD_NICKNAME]: "badNickname",
  [JOIN_ERROR.BAD_CHARACTER]: "badCharacter",
  [JOIN_ERROR.NOT_FOUND]: "notFound",
  [JOIN_ERROR.SERVER_BUSY]: "serverBusy",
  [JOIN_ERROR.OUTDATED]: "outdated",
};

/** Messages of a failed fetch / socket that never reached the server. */
const NETWORK_MESSAGE = /fetch|network|offline|timed? ?out|econnrefused|enotfound|socket|xhr|load failed|abort/i;

/**
 * Map anything colyseus.js (or the browser) rejected a create / join / reconnect with to a NetError:
 * the room's JOIN_ERROR codes 1:1; Colyseus 4212 with "locked" (or "full") in the message → roomFull, other 4212
 * → notFound; network failures → serverDown; anything else → unknown (Net logs the raw error; it is never shown).
 */
export function toNetError(err: unknown): NetError {
  if (isNetError(err)) return err;
  const code = errorCode(err);
  const message = errorText(err);
  const known = code !== null ? KIND_BY_JOIN_ERROR[code] : undefined;
  if (known) return netError(known);
  if (code === MATCHMAKE_INVALID_ROOM_ID) return netError(/locked|full/i.test(message) ? "roomFull" : "notFound");
  if (isNetworkFailure(err, code, message)) return netError("serverDown");
  return netError("unknown");
}

/** The room no longer exists (reconnecting is pointless). */
export function isRoomGone(err: unknown): boolean {
  return errorCode(err) === MATCHMAKE_INVALID_ROOM_ID;
}

/**
 * A close that the server (or we) meant: don't auto-reconnect after it (4000 and CLOSE_CODE.SERVER_RESTART, see
 * CLOSE_NORMAL).
 */
export function isFinalClose(code: number): boolean {
  return code === CLOSE_CONSENTED || code === CLOSE_CODE.SERVER_RESTART;
}

/** What a final close means for the player: the server restarting, or the room sending us away. */
export function finalCloseError(code: number): NetError {
  return netError(code === CLOSE_CODE.SERVER_RESTART ? "serverRestart" : "kicked");
}

/** The server speaks another protocol version (JOIN_ERROR.OUTDATED, or Net's own welcome check): retrying is pointless. */
export function isOutdated(err: unknown): boolean {
  return toNetError(err).kind === "outdated";
}

function isNetError(err: unknown): err is NetError {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Partial<NetError>;
  return typeof e.kind === "string" && typeof e.message === "string" && !("code" in err) && e.kind in ERROR_KEYS;
}

function errorCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  const code = (err as { code: unknown }).code;
  return typeof code === "number" && Number.isFinite(code) ? code : null;
}

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (typeof err !== "object" || err === null || !("message" in err)) return "";
  const message = (err as { message: unknown }).message;
  return typeof message === "string" ? message : "";
}

/**
 * No server answer: fetch/XHR failures (no code or an HTTP 5xx/0 status), socket errors and
 * closes before joining (codes 1001–1015), aborted requests.
 */
function isNetworkFailure(err: unknown, code: number | null, message: string): boolean {
  if (err instanceof TypeError) return true;
  if (code === null || code === 0) return !message || NETWORK_MESSAGE.test(message);
  if (code >= 1001 && code <= 1015) return true;
  if (code >= 500 && code < 600) return true;
  return NETWORK_MESSAGE.test(message);
}
