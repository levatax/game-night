// The "Auto" quality watchdog (app/quality.ts). Owner: client-app.
// Run: npx vitest run games/raft-rush/client/src/app

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_STORAGE_KEY } from "../../../shared/constants";
import { AutoQuality, guessQuality } from "./quality";
import { DEFAULT_SETTINGS, SettingsStore } from "./settings";

const MARKER_KEY = "raft-rush.autoQuality.v1";
let data: Map<string, string>;

beforeEach(() => {
  data = new Map();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One in-match stint: warm-up + the sample window at `ms` per frame. */
function stint(q: AutoQuality, ms: number, frames = 460): void {
  for (let i = 1; i <= frames; i++) q.frame(1000 + i * ms);
}

describe("AutoQuality", () => {
  it("first boot on Auto: the device guess, then a slow stint steps one tier down", () => {
    const store = new SettingsStore();
    const auto = new AutoQuality(store, () => "medium");
    const stepped = vi.fn();
    auto.onStepDown = stepped;
    expect(store.get()).toMatchObject({ quality: "medium", autoQuality: true });
    stint(auto, 40);
    expect(store.get()).toMatchObject({ quality: "low", autoQuality: true });
    expect(stepped).toHaveBeenCalledWith("low");
  });

  it("a fast stint keeps the tier; one decision per stint, the next stint (after a pause) judges again", () => {
    const store = new SettingsStore();
    store.set({ quality: "high" });
    const auto = new AutoQuality(store, () => "high");
    stint(auto, 16);
    expect(store.get().quality).toBe("high");
    stint(auto, 40); // same stint: already decided
    expect(store.get().quality).toBe("high");
    auto.pause();
    stint(auto, 40);
    expect(store.get().quality).toBe("medium");
  });

  it("a fixed tier from the menu turns Auto off and the watchdog leaves it alone", () => {
    const store = new SettingsStore();
    const auto = new AutoQuality(store, () => "medium");
    store.set({ quality: "high", autoQuality: false });
    stint(auto, 40);
    expect(store.get()).toMatchObject({ quality: "high", autoQuality: false });
    expect(auto.active).toBe(false);
  });

  it("picking Auto again re-guesses from the device and re-arms the watchdog", () => {
    const store = new SettingsStore();
    const auto = new AutoQuality(store, () => "medium");
    store.set({ quality: "high", autoQuality: false });
    store.set({ autoQuality: true });
    expect(store.get()).toMatchObject({ quality: "medium", autoQuality: true });
    stint(auto, 40);
    expect(store.get().quality).toBe("low");
  });

  it("every boot on Auto starts from the device guess again: a step down lasts one page session", () => {
    data.set(SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, quality: "low", autoQuality: true }));
    const store = new SettingsStore();
    new AutoQuality(store, () => "medium");
    expect(store.get()).toMatchObject({ quality: "medium", autoQuality: true });
    data.set(SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, quality: "low", autoQuality: false }));
    const fixed = new SettingsStore();
    new AutoQuality(fixed, () => "medium");
    expect(fixed.get().quality).toBe("low"); // a fixed tier stays
  });

  it("reguess() (Auto clicked while on): back to the device guess and judged afresh; nothing on a fixed tier", () => {
    const store = new SettingsStore();
    const auto = new AutoQuality(store, () => "medium");
    stint(auto, 40);
    expect(store.get().quality).toBe("low");
    auto.reguess();
    expect(store.get().quality).toBe("medium");
    stint(auto, 40);
    expect(store.get().quality).toBe("low");
    store.set({ quality: "high", autoQuality: false });
    auto.reguess();
    expect(store.get()).toMatchObject({ quality: "high", autoQuality: false });
  });

  it("saves from before Auto whose one-shot watchdog already ran keep their tier fixed", () => {
    const { autoQuality: _drop, ...old } = { ...DEFAULT_SETTINGS, quality: "high" as const };
    data.set(SETTINGS_STORAGE_KEY, JSON.stringify(old));
    data.set(MARKER_KEY, "done");
    const store = new SettingsStore();
    const auto = new AutoQuality(store, () => "low");
    expect(store.get()).toMatchObject({ quality: "high", autoQuality: false });
    stint(auto, 40);
    expect(store.get().quality).toBe("high");
  });

  it("guessQuality: low for small or mobile devices, medium otherwise", () => {
    expect(guessQuality({ hardwareConcurrency: 8, deviceMemory: 8, userAgent: "Mac" })).toBe("medium");
    expect(guessQuality({ hardwareConcurrency: 2 })).toBe("low");
    expect(guessQuality({ hardwareConcurrency: 8, userAgent: "iPhone" })).toBe("low");
  });
});
