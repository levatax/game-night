// Home screen state that lives outside the DOM (unit-tested in node): whether this device has the keyboard +
// mouse the game needs (no fine pointer = the "needs a keyboard and a mouse" card; App skips the invite auto-join
// while it is due), and the typed nickname / room code kept across the reload a language switch (i18n setLanguage)
// or the "game was updated" Reload button triggers. Both live in sessionStorage: one tab, gone with it. Owner: client-ui.

import { CODE_LENGTH, NICKNAME_MAX } from "../../../../shared/constants";

/** Nickname + room code typed on Home but not submitted yet, saved right before a language reload. */
export const HOME_DRAFT_KEY = "raft-rush.homeDraft";
/** "Continue anyway" was picked on the keyboard + mouse card in this tab. */
export const DEVICE_NOTICE_KEY = "raft-rush.deviceNotice";

export interface HomeDraft {
  nickname: string;
  code: string;
}

/** A media query test, e.g. `(q) => matchMedia(q).matches`. */
export type MediaTest = (query: string) => boolean;

/** The slice of Storage the helpers use (tests pass a Map-backed fake). */
export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * True when no fine pointer (mouse, trackpad, pen) is attached: phones and most tablets. A touch laptop or a
 * tablet with a mouse has one and passes. Engines without `any-pointer` (none of its values match) fall back to
 * the primary pointer being coarse; no matchMedia at all counts as a desktop.
 */
export function lacksFinePointer(matches: MediaTest | null): boolean {
  if (!matches) return false;
  const anySupported = matches("(any-pointer: fine)") || matches("(any-pointer: coarse)") || matches("(any-pointer: none)");
  if (!anySupported) return matches("(pointer: coarse)");
  return !matches("(any-pointer: fine)");
}

/** window.matchMedia as a MediaTest (null where there is none). */
export function browserMedia(): MediaTest | null {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
    return (query) => window.matchMedia(query).matches;
  } catch {
    return null;
  }
}

/** This tab's sessionStorage, or null when blocked (private mode, sandboxed frames). */
export function sessionStore(): DraftStore | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** Keep what was typed for the next page load (both fields empty = nothing to keep). */
export function saveHomeDraft(store: DraftStore | null, draft: HomeDraft): void {
  if (!store) return;
  const nickname = draft.nickname.slice(0, NICKNAME_MAX);
  const code = draft.code.slice(0, CODE_LENGTH);
  try {
    if (!nickname.trim() && !code) store.removeItem(HOME_DRAFT_KEY);
    else store.setItem(HOME_DRAFT_KEY, JSON.stringify({ nickname, code }));
  } catch {
    // Storage full or blocked: the fields just come back empty.
  }
}

/** Home's "Reload the page" (under menu.errOutdated): keep what was typed for the fresh page, then reload. */
export function reloadKeepingDraft(store: DraftStore | null, draft: HomeDraft, reload: () => void): void {
  saveHomeDraft(store, draft);
  reload();
}

/** Read and forget the saved draft (null when none or unreadable). */
export function takeHomeDraft(store: DraftStore | null): HomeDraft | null {
  if (!store) return null;
  try {
    const raw = store.getItem(HOME_DRAFT_KEY);
    if (raw === null) return null;
    store.removeItem(HOME_DRAFT_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { nickname, code } = parsed as Record<string, unknown>;
    return {
      nickname: typeof nickname === "string" ? nickname.slice(0, NICKNAME_MAX) : "",
      code: typeof code === "string" ? code.slice(0, CODE_LENGTH) : "",
    };
  } catch {
    return null;
  }
}

/** "Continue anyway" on the keyboard + mouse card was already picked in this tab. */
export function deviceNoticeDismissed(store: DraftStore | null): boolean {
  try {
    return store?.getItem(DEVICE_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The keyboard + mouse card stands in for Home's form: no fine pointer and not waved through in this tab yet. App
 * asks too, so an invite link with a saved nickname lands on the card instead of joining straight from boot.
 */
export function deviceNoticeDue(matches: MediaTest | null, store: DraftStore | null): boolean {
  return lacksFinePointer(matches) && !deviceNoticeDismissed(store);
}

export function dismissDeviceNotice(store: DraftStore | null): void {
  try {
    store?.setItem(DEVICE_NOTICE_KEY, "1");
  } catch {
    // Blocked storage: the card simply shows again after a reload.
  }
}
