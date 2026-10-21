// Settings validation, reducedFlashing following the OS until the player sets it, and reset(). Owner: client-app.
// Run: npx vitest run games/raft-rush/client/src/app

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_STORAGE_KEY } from "../../../shared/constants";
import { DEFAULT_SETTINGS, HUD_SCALE_MAX, HUD_SCALE_MIN, prefersReducedMotion, sanitizeSettings, SettingsStore } from "./settings";

/** In-memory localStorage (a fresh one, or `data` again: a reload) + a matchMedia that answers prefers-reduced-motion. */
function stubBrowser(reduce: boolean, stored?: Record<string, unknown>, data = new Map<string, string>()): Map<string, string> {
  if (stored) data.set(SETTINGS_STORAGE_KEY, JSON.stringify(stored));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("prefers-reduced-motion: reduce"), media: q }));
  return data;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sanitizeSettings: the accessibility fields", () => {
  it("fills defaults for saves from before they existed", () => {
    const s = sanitizeSettings({ quality: "high", nickname: "Mercan" });
    expect(s).toMatchObject({ quality: "high", nickname: "Mercan", hudScale: 1, keyPreset: "standard", mouseLock: true, autoQuality: true });
  });

  it("clamps the HUD size and rejects junk presets / flags", () => {
    expect(sanitizeSettings({ hudScale: 9 }).hudScale).toBe(HUD_SCALE_MAX);
    expect(sanitizeSettings({ hudScale: 0.1 }).hudScale).toBe(HUD_SCALE_MIN);
    expect(sanitizeSettings({ hudScale: Number.NaN }).hudScale).toBe(1);
    expect(sanitizeSettings({ keyPreset: "dvorak" }).keyPreset).toBe("standard");
    expect(sanitizeSettings({ keyPreset: "leftHanded" }).keyPreset).toBe("leftHanded");
    expect(sanitizeSettings({ mouseLock: "no", autoQuality: 0 })).toMatchObject({ mouseLock: true, autoQuality: true });
  });
});

describe("reduced motion from the OS", () => {
  it("prefersReducedMotion is false without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("follows the OS on every boot until the player sets it", () => {
    const data = stubBrowser(true);
    const store = new SettingsStore();
    expect(store.get().reducedFlashing).toBe(true);
    store.set({ nickname: "Deniz" }); // saving something else is not a choice
    expect(JSON.parse(data.get(SETTINGS_STORAGE_KEY)!)).toMatchObject({ nickname: "Deniz", reducedFlashingChosen: false });
    stubBrowser(false, undefined, data); // the OS preference changed since
    expect(new SettingsStore().get()).toMatchObject({ reducedFlashing: false, nickname: "Deniz" });
  });

  it("a save from before the marker that says off (the old default) follows the OS; one that says on keeps it", () => {
    stubBrowser(true, { ...DEFAULT_SETTINGS, reducedFlashing: false });
    expect(new SettingsStore().get().reducedFlashing).toBe(true);
    stubBrowser(false, { ...DEFAULT_SETTINGS, reducedFlashing: true });
    expect(new SettingsStore().get().reducedFlashing).toBe(true);
  });

  it("never overrides a choice made in the menu, either way", () => {
    const data = stubBrowser(true);
    new SettingsStore().set({ reducedFlashing: false });
    expect(JSON.parse(data.get(SETTINGS_STORAGE_KEY)!)).toMatchObject({ reducedFlashing: false, reducedFlashingChosen: true });
    stubBrowser(true, undefined, data);
    expect(new SettingsStore().get().reducedFlashing).toBe(false);
    const on = stubBrowser(false);
    new SettingsStore().set({ reducedFlashing: true });
    stubBrowser(false, undefined, on);
    expect(new SettingsStore().get().reducedFlashing).toBe(true);
  });

  it("stays off when the OS doesn't ask", () => {
    stubBrowser(false);
    expect(new SettingsStore().get().reducedFlashing).toBe(false);
  });
});

describe("SettingsStore.reset", () => {
  it("keeps who you are, the tips seen and the key preset; reduced flashing goes back to the OS", () => {
    stubBrowser(true);
    const store = new SettingsStore();
    store.set({
      nickname: "Mercan",
      lastCharacter: DEFAULT_SETTINGS.lastCharacter,
      seenTips: ["move"],
      keyPreset: "leftHanded",
      hudScale: 1.3,
      mouseLock: false,
      autoQuality: false,
      quality: "high",
      reducedFlashing: false,
    });
    store.reset();
    expect(store.get()).toMatchObject({
      nickname: "Mercan",
      seenTips: ["move"],
      keyPreset: "leftHanded",
      hudScale: 1,
      mouseLock: true,
      autoQuality: true,
      quality: DEFAULT_SETTINGS.quality,
      reducedFlashing: true,
    });
  });

  it("makes reduced flashing follow the OS again, even when nothing else changes", () => {
    const data = stubBrowser(true);
    const store = new SettingsStore();
    store.set({ reducedFlashing: false });
    store.set({ reducedFlashing: true }); // chosen, and the same as the OS
    store.reset();
    expect(JSON.parse(data.get(SETTINGS_STORAGE_KEY)!)).toMatchObject({ reducedFlashing: true, reducedFlashingChosen: false });
    stubBrowser(false, undefined, data);
    expect(new SettingsStore().get().reducedFlashing).toBe(false);
  });
});
