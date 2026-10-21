// Reconnect ticket in sessionStorage[RECONNECT_STORAGE_KEY] = JSON { roomId, token }. Owner: client-net.
// Lets a page reload (or the language switch, which reloads) rejoin the same room within the grace window.
// Storage can be missing or blocked (private mode, tests): every access is guarded; reconnecting after a reload
// is a convenience, never a requirement.

import { RECONNECT_STORAGE_KEY } from "../../../shared/constants";

/** What survives a page reload. `token` is colyseus.js `room.reconnectionToken`. */
export interface ReconnectTicket {
  roomId: string;
  token: string;
}

/** The subset of the Web Storage API we use (sessionStorage, or a fake in tests). */
export interface TicketStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): TicketStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The stored ticket, or null when there is none / it is unreadable. */
export function readTicket(storage: TicketStorage | null = defaultStorage()): ReconnectTicket | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(RECONNECT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const { roomId, token } = parsed as { roomId?: unknown; token?: unknown };
      if (typeof token === "string" && token !== "") return { roomId: typeof roomId === "string" ? roomId : "", token };
    }
  } catch {
    // Not JSON: fall through.
  }
  return null;
}

/** Remember the room we are in (overwrites the previous ticket). Empty tokens are ignored. */
export function storeTicket(ticket: ReconnectTicket, storage: TicketStorage | null = defaultStorage()): void {
  if (!storage || !ticket.token) return;
  try {
    storage.setItem(RECONNECT_STORAGE_KEY, JSON.stringify({ roomId: ticket.roomId, token: ticket.token }));
  } catch {
    // Quota / blocked storage: reload-reconnect just won't be available.
  }
}

/** Forget the ticket (consented leave, room gone, failed reconnect). */
export function clearTicket(storage: TicketStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(RECONNECT_STORAGE_KEY);
  } catch {
    // See storeTicket.
  }
}
