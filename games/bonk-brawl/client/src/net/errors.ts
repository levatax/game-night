// User-facing connection errors (pure, no colyseus.js import so it is unit-testable). Owner: client-net.

import { JOIN_ERROR, JOIN_ERROR_TEXT } from "../../../shared/protocol";
import type { NetError } from "./types";

/** Colyseus matchmaker codes (colyseus.js ErrorCode), mirrored to keep this module dependency-free. */
export const MATCHMAKE_INVALID_ROOM_ID = 4212;
export const MATCHMAKE_EXPIRED = 4214;
/** WebSocket close codes after which we must not try to reconnect (normal / consented close). */
export const CLOSE_NORMAL = 1000;
export const CLOSE_CONSENTED = 4000;

export const MESSAGES = {
  serverDown: "Couldn't reach the game server. Try again in a moment.",
  lostConnection: "Lost connection to the server.",
  roomClosed: "The room was closed.",
  kicked: "You were disconnected from the room.",
  unknown: "Something went wrong. Try again.",
  busy: "Already connected to a room.",
} as const;

const KIND_BY_JOIN_ERROR: Readonly<Record<number, NetError["kind"]>> = {
  [JOIN_ERROR.ROOM_FULL]: "roomFull",
  [JOIN_ERROR.BAD_NICKNAME]: "badNickname",
  [JOIN_ERROR.BAD_CHARACTER]: "badCharacter",
  [JOIN_ERROR.NOT_FOUND]: "notFound",
};

/** Messages of a failed fetch / socket that never reached the server. */
const NETWORK_MESSAGE = /fetch|network|offline|timed? ?out|econnrefused|enotfound|socket|xhr|load failed|abort/i;

/** Map anything colyseus.js (or the browser) rejected a create/join/reconnect with to a NetError. */
export function toNetError(err: unknown): NetError {
  if (isNetError(err)) return err;
  const code = errorCode(err);
  const message = errorText(err);
  const known = code !== null ? KIND_BY_JOIN_ERROR[code] : undefined;
  if (known && code !== null) return { kind: known, message: JOIN_ERROR_TEXT[code] };
  if (code === MATCHMAKE_INVALID_ROOM_ID) {
    return /locked/i.test(message)
      ? { kind: "roomFull", message: JOIN_ERROR_TEXT[JOIN_ERROR.ROOM_FULL] }
      : { kind: "notFound", message: JOIN_ERROR_TEXT[JOIN_ERROR.NOT_FOUND] };
  }
  if (isNetworkFailure(err, code, message)) return { kind: "serverDown", message: MESSAGES.serverDown };
  return { kind: "unknown", message: message || MESSAGES.unknown };
}

/** The room no longer exists (reconnecting is pointless). */
export function isRoomGone(err: unknown): boolean {
  return errorCode(err) === MATCHMAKE_INVALID_ROOM_ID;
}

/** A close that the server (or we) meant: don't auto-reconnect after it. */
export function isFinalClose(code: number): boolean {
  return code === CLOSE_NORMAL || code === CLOSE_CONSENTED;
}

function isNetError(err: unknown): err is NetError {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Partial<NetError>;
  return typeof e.kind === "string" && typeof e.message === "string" && !("code" in err);
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
