// Home helpers: the keyboard + mouse check and the nickname / code draft kept across a language reload (and the
// "game was updated" Reload button). Owner: client-ui. Run: npx vitest run games/raft-rush/client/src/ui

import { describe, expect, it } from "vitest";
import { NICKNAME_MAX } from "../../../../shared/constants";
import {
  browserMedia,
  deviceNoticeDismissed,
  deviceNoticeDue,
  dismissDeviceNotice,
  HOME_DRAFT_KEY,
  lacksFinePointer,
  reloadKeepingDraft,
  saveHomeDraft,
  takeHomeDraft,
  type DraftStore,
  type MediaTest,
} from "./homeState";

/** A device answering the media queries in `on` (everything else is false). */
const device = (...on: string[]): MediaTest => (q) => on.includes(q);

function memoryStore(): DraftStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("lacksFinePointer", () => {
  it("flags phones and tablets (coarse pointers only, or none)", () => {
    expect(lacksFinePointer(device("(pointer: coarse)", "(any-pointer: coarse)"))).toBe(true);
    expect(lacksFinePointer(device("(pointer: none)", "(any-pointer: none)"))).toBe(true);
  });

  it("lets desktops, touch laptops and tablets with a mouse through", () => {
    expect(lacksFinePointer(device("(pointer: fine)", "(any-pointer: fine)"))).toBe(false);
    expect(lacksFinePointer(device("(pointer: coarse)", "(any-pointer: coarse)", "(any-pointer: fine)"))).toBe(false);
  });

  it("falls back to the primary pointer without any-pointer, and to desktop without matchMedia", () => {
    expect(lacksFinePointer(device("(pointer: coarse)"))).toBe(true);
    expect(lacksFinePointer(device("(pointer: fine)"))).toBe(false);
    expect(lacksFinePointer(device())).toBe(false);
    expect(lacksFinePointer(null)).toBe(false);
    expect(browserMedia()).toBeNull(); // node: no window
  });
});

describe("home draft", () => {
  it("round-trips the typed nickname and code once", () => {
    const store = memoryStore();
    saveHomeDraft(store, { nickname: "Salty Sam", code: "ABCD" });
    expect(takeHomeDraft(store)).toEqual({ nickname: "Salty Sam", code: "ABCD" });
    expect(takeHomeDraft(store)).toBeNull();
  });

  it("keeps a half-typed code and clamps both fields", () => {
    const store = memoryStore();
    saveHomeDraft(store, { nickname: "x".repeat(40), code: "ABCDEF" });
    const draft = takeHomeDraft(store);
    expect(draft?.nickname).toHaveLength(NICKNAME_MAX);
    expect(draft?.code).toBe("ABCD");
    saveHomeDraft(store, { nickname: "", code: "AB" });
    expect(takeHomeDraft(store)).toEqual({ nickname: "", code: "AB" });
  });

  it("saves nothing for empty fields and clears an older draft", () => {
    const store = memoryStore();
    saveHomeDraft(store, { nickname: "Old", code: "" });
    saveHomeDraft(store, { nickname: "   ", code: "" });
    expect(store.data.has(HOME_DRAFT_KEY)).toBe(false);
  });

  it("survives junk, missing and throwing storage", () => {
    const store = memoryStore();
    store.data.set(HOME_DRAFT_KEY, "{not json");
    expect(takeHomeDraft(store)).toBeNull();
    store.data.set(HOME_DRAFT_KEY, JSON.stringify({ nickname: 7, code: "QRST" }));
    expect(takeHomeDraft(store)).toEqual({ nickname: "", code: "QRST" });
    expect(takeHomeDraft(null)).toBeNull();
    const broken: DraftStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => saveHomeDraft(broken, { nickname: "A", code: "" })).not.toThrow();
    expect(takeHomeDraft(broken)).toBeNull();
    expect(deviceNoticeDismissed(broken)).toBe(false);
    expect(() => dismissDeviceNotice(broken)).not.toThrow();
  });

  it("the Reload button saves what was typed before the page goes, and still reloads without storage", () => {
    const store = memoryStore();
    let savedAtReload: string | undefined;
    reloadKeepingDraft(store, { nickname: "Salty Sam", code: "WXYZ" }, () => {
      savedAtReload = store.data.get(HOME_DRAFT_KEY);
    });
    expect(savedAtReload).toBe(JSON.stringify({ nickname: "Salty Sam", code: "WXYZ" }));
    expect(takeHomeDraft(store)).toEqual({ nickname: "Salty Sam", code: "WXYZ" });
    let reloads = 0;
    reloadKeepingDraft(null, { nickname: "Salty Sam", code: "" }, () => reloads++);
    expect(reloads).toBe(1);
  });
});

describe("device notice", () => {
  it("remembers 'continue anyway' for the tab", () => {
    const store = memoryStore();
    expect(deviceNoticeDismissed(store)).toBe(false);
    dismissDeviceNotice(store);
    expect(deviceNoticeDismissed(store)).toBe(true);
    expect(deviceNoticeDismissed(null)).toBe(false);
  });

  it("is due on a phone until waved through, never with a mouse (App's invite auto-join waits on it)", () => {
    const phone = device("(pointer: coarse)", "(any-pointer: coarse)");
    const store = memoryStore();
    expect(deviceNoticeDue(phone, store)).toBe(true);
    expect(deviceNoticeDue(phone, null)).toBe(true); // blocked storage: shown on every load
    dismissDeviceNotice(store);
    expect(deviceNoticeDue(phone, store)).toBe(false);
    expect(deviceNoticeDue(device("(pointer: fine)", "(any-pointer: fine)"), memoryStore())).toBe(false);
    expect(deviceNoticeDue(null, memoryStore())).toBe(false);
  });
});
