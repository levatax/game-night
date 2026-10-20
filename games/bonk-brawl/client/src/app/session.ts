// Deep links (?room=CODE), the stored reconnection token and user-facing connection errors.
// Owner: client-app.

import { CODE_PATTERN, RECONNECT_STORAGE_KEY } from "../../../shared/constants";
import type { NetError } from "../net/types";

const ROOM_PARAM = "room";
const FALLBACK_ERROR = "Couldn't reach the game server. Try again in a moment.";

/** Room code from `?room=CODE` (the hub redirects /r/ABCD there), or null if absent/invalid. */
export function readRoomCodeFromUrl(): string | null {
  try {
    const code = (new URLSearchParams(window.location.search).get(ROOM_PARAM) ?? "").trim().toUpperCase();
    return CODE_PATTERN.test(code) ? code : null;
  } catch {
    return null;
  }
}

/** Keep `?room=CODE` in the address bar while in a room (a reload rejoins it); null removes it. */
export function setRoomInUrl(code: string | null): void {
  try {
    const url = new URL(window.location.href);
    if (code) url.searchParams.set(ROOM_PARAM, code);
    else url.searchParams.delete(ROOM_PARAM);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  } catch {
    // Sandboxed frames can refuse history updates; the URL is a convenience only.
  }
}

/** A Colyseus reconnection token from an earlier page load in this tab (Net writes it). */
export function hasReconnectToken(): boolean {
  try {
    return !!window.sessionStorage.getItem(RECONNECT_STORAGE_KEY);
  } catch {
    return false;
  }
}

function isNetError(err: unknown): err is NetError {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Partial<NetError>;
  return typeof e.kind === "string" && typeof e.message === "string";
}

/** Display text for a failed create/join/reconnect (Net rejects with NetError). */
export function errorMessage(err: unknown): string {
  return isNetError(err) && err.message ? err.message : FALLBACK_ERROR;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
