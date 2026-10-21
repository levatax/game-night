// Automatic quality choice (idea from games/kasala/client/src/scene/Stage.ts "auto"): while settings.autoQuality
// is on (the menu's "Auto", the default), a device-based guess picks the tier at every boot (like KASALA's auto
// ladder, a step down lasts one page session: a throttled evening doesn't stick) and a watchdog over the first
// seconds of every stint on the game screen steps it down when the frame rate can't keep up. Picking a fixed tier
// in the menu turns it off (the menu sends { quality, autoQuality: false }); picking "Auto" (again) re-guesses
// from the device and re-arms it. Within a tier the renderer's FrameGovernor adapts the resolution. Owner: client-app.

import { SETTINGS_STORAGE_KEY } from "../../../shared/constants";
import type { Quality, SettingsStore } from "./settings";

/** Pre-"Auto" builds ran the watchdog once per browser and left this marker when it was done. */
const MARKER_KEY = "raft-rush.autoQuality.v1";
/** Watch this many in-match frames (after a warm-up) before deciding. */
const WARMUP_FRAMES = 90;
const SAMPLE_FRAMES = 360;
/** Median frame time above this (ms) steps one tier down (≈ 36 fps). */
const SLOW_FRAME_MS = 28;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Device-based first guess: low for small / weak machines, medium otherwise (high is opt-in). */
export function guessQuality(nav: { hardwareConcurrency?: number; deviceMemory?: number; userAgent?: string } = typeof navigator !== "undefined" ? navigator : {}): Quality {
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory ?? 8;
  const mobile = /Mobi|Android|iPhone|iPad/i.test(nav.userAgent ?? "");
  if (mobile || cores <= 2 || memory <= 2) return "low";
  if (cores <= 4 && memory <= 4) return "low";
  return "medium";
}

/**
 * Saved settings from before the "Auto" choice existed: the one-shot watchdog has already settled the tier (or the
 * player picked one), so keep it fixed instead of letting a new watchdog second-guess it.
 */
function settledBeforeAuto(): boolean {
  if (read(MARKER_KEY) === null) return false;
  try {
    const raw: unknown = JSON.parse(read(SETTINGS_STORAGE_KEY) ?? "null");
    return !!raw && typeof raw === "object" && !("autoQuality" in raw);
  } catch {
    return false;
  }
}

export class AutoQuality {
  private frames = 0;
  private readonly samples: number[] = [];
  private lastMs = 0;
  /** This stint on the game screen has been judged (one decision per stint). */
  private decided = false;
  /** Our own changes are not a player's pick. */
  private stepping = false;
  /** Called after a step down (the app shows a toast). */
  onStepDown: ((q: Quality) => void) | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly guess: () => Quality = guessQuality,
  ) {
    const firstBoot = read(SETTINGS_STORAGE_KEY) === null;
    if (!firstBoot && settledBeforeAuto()) settings.set({ autoQuality: false });
    else if (settings.get().autoQuality) this.apply({ quality: this.guess() });
    settings.onChange((next, changed) => {
      if (this.stepping) return;
      if (changed.includes("autoQuality") && next.autoQuality) {
        // "Auto" picked (or reset): start again from the device guess.
        this.apply({ quality: this.guess() });
        this.restart();
      } else if (changed.includes("quality") && next.autoQuality) {
        // A tier set while on Auto (reset to defaults, a dev harness): the watchdog judges it afresh. The menu
        // sends autoQuality: false with every fixed tier, so this is never a player's pick.
        this.restart();
      }
    });
  }

  /** True while the watchdog may still change the tier. */
  get active(): boolean {
    return this.settings.get().autoQuality;
  }

  /** "Auto" picked while it already is on (the menu): start again from the device guess, like a fresh boot. */
  reguess(): void {
    if (!this.active) return;
    this.apply({ quality: this.guess() });
    this.restart();
  }

  /** Per in-match frame (rAF timestamp). */
  frame(nowMs: number): void {
    if (!this.active || this.decided) return;
    const dt = this.lastMs > 0 ? nowMs - this.lastMs : 0;
    this.lastMs = nowMs;
    if (dt <= 0 || dt > 250) return; // tab switches / stalls are not representative
    if (++this.frames <= WARMUP_FRAMES) return;
    this.samples.push(dt);
    if (this.samples.length < SAMPLE_FRAMES) return;
    this.decided = true;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const q = this.settings.get().quality;
    if (median > SLOW_FRAME_MS && q !== "low") {
      const next: Quality = q === "high" ? "medium" : "low";
      this.apply({ quality: next });
      this.onStepDown?.(next);
    }
  }

  /** Frames outside a match don't count (menus are cheap); the next stint in a match is judged afresh. */
  pause(): void {
    this.lastMs = 0;
    if (this.decided || this.frames > 0) this.restart();
  }

  private restart(): void {
    this.decided = false;
    this.frames = 0;
    this.samples.length = 0;
    this.lastMs = 0;
  }

  private apply(patch: { quality?: Quality; autoQuality?: boolean }): void {
    this.stepping = true;
    try {
      this.settings.set(patch);
    } finally {
      this.stepping = false;
    }
  }
}
