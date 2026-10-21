// Room session plumbing: share links (?room=CODE and /r/CODE), the address bar, the remembered nickname, the
// reconnect ticket probe (the room it is for, and dropStaleTicket: an invite link to another room overrides it at
// boot), the share URL, the automatic reconnect window (ReconnectWindow:
// the pill + pointer release) and the expired-seat note after a failed reload rejoin (SeatExpiry). Owner: client-app.
// Adapted from games/bonk-brawl/client/src/app/session.ts and games/kasala/client/src/game/session.ts.

import { CODE_PATTERN, NICKNAME_MAX, NICKNAME_MIN, RECONNECT_STORAGE_KEY } from "../../../shared/constants";
import { clearTicket, readTicket } from "../net/reconnectToken";

const ROOM_PARAM = "room";
const SHARE_PATH = /\/r\/([A-Za-z]{4})\/?$/;
const FALLBACK_BASE = "/games/raft-rush/";

/** Normalize a typed / pasted code: trims, upper-cases, accepts a pasted share link. null when invalid. */
export function parseRoomCode(raw: string): string | null {
  const text = raw.trim();
  const link = /(?:\/r\/|[?&]room=)([A-Za-z]{4})\b/.exec(text);
  const code = (link ? link[1]! : text).toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

/** The room code from `?room=CODE` or a `…/r/CODE` path (null when none / invalid). */
export function readRoomCodeFromUrl(loc: Pick<Location, "search" | "pathname"> = window.location): string | null {
  try {
    const q = new URLSearchParams(loc.search).get(ROOM_PARAM) ?? "";
    const fromQuery = parseRoomCode(q);
    if (fromQuery) return fromQuery;
    const m = SHARE_PATH.exec(loc.pathname);
    return m ? parseRoomCode(m[1]!) : null;
  } catch {
    return null;
  }
}

/** Keep the address bar shareable: …/games/raft-rush/?room=CODE in a room, the bare game URL otherwise. */
export function setRoomInUrl(code: string | null): void {
  try {
    const url = new URL(window.location.href);
    if (SHARE_PATH.test(url.pathname)) url.pathname = baseUrl();
    if (code) url.searchParams.set(ROOM_PARAM, code);
    else url.searchParams.delete(ROOM_PARAM);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url.href);
  } catch {
    // Sandboxed frames can refuse history updates; the URL is a convenience only.
  }
}

function baseUrl(): string {
  try {
    return import.meta.env.BASE_URL || FALLBACK_BASE;
  } catch {
    return FALLBACK_BASE;
  }
}

/** The link players share: `${origin}/r/CODE` (the hub redirects it to the right game). */
export function shareLink(code: string, origin: string = safeOrigin()): string {
  return code ? `${origin}/r/${code}` : "";
}

function safeOrigin(): string {
  try {
    return window.location.origin;
  } catch {
    return "";
  }
}

/** A reload-rejoin ticket from an earlier page load in this tab (Net writes it). */
export function hasReconnectToken(): boolean {
  try {
    return !!window.sessionStorage.getItem(RECONNECT_STORAGE_KEY);
  } catch {
    return false;
  }
}

/** The room that ticket is for, upper-cased ("" when there is none or it doesn't say). Read it before tryReconnect(). */
export function reconnectTicketRoom(): string {
  return readTicket()?.roomId.toUpperCase() ?? "";
}

/**
 * Boot with a reconnect ticket: rejoin the ticket's room, unless the address bar is an invite to ANOTHER room (a tab
 * that still held a ticket for ABCD, inside its grace window, opened a link to WXYZ): then the link wins (false). No
 * link, the same room, or a ticket that doesn't say its room: true, rejoin as before.
 */
export function rejoinTicketAtBoot(linkCode: string, ticketRoom: string): boolean {
  const link = linkCode.trim().toUpperCase();
  const room = ticketRoom.trim().toUpperCase();
  return link === "" || room === "" || link === room;
}

/**
 * Boot, before the reload rejoin: forget a ticket that rejoinTicketAtBoot() says the invite link `linkCode`
 * overrides, so App follows the link; the old seat keeps its grace window, then a bot takes it. True when dropped.
 */
export function dropStaleTicket(linkCode: string): boolean {
  if (rejoinTicketAtBoot(linkCode, reconnectTicketRoom())) return false;
  clearTicket();
  return true;
}

/**
 * The automatic reconnect window as the app sees it (Net `reconnecting { attempt }` … `connected` / `disconnected`):
 * the attempt the pill shows, and whether an event opens the window (the moment to hand the mouse back).
 */
export class ReconnectWindow {
  private current: number | null = null;

  /** The attempt Net is on, or null outside a reconnect window. */
  get attempt(): number | null {
    return this.current;
  }

  /** Net started attempt `n`. True when this opens the window (the first attempt after a drop). */
  attempted(n: number): boolean {
    const opens = this.current === null;
    this.current = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
    return opens;
  }

  /** Reconnected, or dropped to Home for good. True when a window was open (the pill must go). */
  close(): boolean {
    const was = this.current !== null;
    this.current = null;
    return was;
  }
}

/**
 * A page reload whose reconnect ticket was refused (back after the 30 s grace: a bot plays the old seat now) while
 * the address bar still named that ticket's room: the deep-link auto-join that follows takes a NEW seat. Remembered
 * so that join can say so; any other create / join (or a failed one) forgets it. A deep link to another room (an
 * invite opened in a tab that still held an old ticket) is no "old seat".
 */
export class SeatExpiry {
  private code = "";

  /**
   * tryReconnect() failed at boot; `code` is the deep link about to be auto-joined ("" = none), `ticketRoom` the
   * room the refused ticket was for (reconnectTicketRoom(), read before the attempt).
   */
  expired(code: string, ticketRoom: string): void {
    this.code = code !== "" && code.toUpperCase() === ticketRoom.toUpperCase() ? code : "";
  }

  /** A create / join settled: true (once) when it joined the expired seat's room as a new castaway. */
  settle(code: string, joined: boolean): boolean {
    const hit = joined && this.code !== "" && code === this.code;
    this.code = "";
    return hit;
  }
}

/** Trim + collapse whitespace + clamp to NICKNAME_MAX. "" when it's not a usable nickname. */
export function cleanNickname(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, NICKNAME_MAX).trim();
  return name.length >= NICKNAME_MIN ? name : "";
}

/** Copy text to the clipboard (async API, then the legacy execCommand fallback). Resolves false on failure. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied / insecure context: try the fallback.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
