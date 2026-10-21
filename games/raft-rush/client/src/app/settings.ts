// Client settings with defaults, validation and localStorage persistence.
// Owner: client-app (written by the architect, complete). The UI edits settings only through
// `settings.set(...)`; every consumer (Input, FpCamera, AudioEngine, Renderer, i18n) listens via onChange.
// reducedFlashing follows the OS "reduce motion" preference on every boot until the player flips it in the menu;
// from then on their choice wins (never overridden). The save records which it is (REDUCED_CHOSEN_KEY).

import {
  CAMERA_FOV,
  CAMERA_FOV_MAX,
  CAMERA_FOV_MIN,
  CHARACTER_IDS,
  DEFAULT_CHARACTER,
  NICKNAME_MAX,
  SETTINGS_STORAGE_KEY,
} from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";

export type Quality = "low" | "medium" | "high";
export type Lang = "en" | "tr";
/** Keyboard layout of the gameplay keys (input/bindings.ts): WASD, or IJKL + right-hand actions for a mouse in the left hand. */
export type KeyPreset = "standard" | "leftHanded";

/** HUD size multiplier range (scales the --u unit of the HUD and the panels). */
export const HUD_SCALE_MIN = 0.75;
export const HUD_SCALE_MAX = 1.5;

export interface Settings {
  /** Mouse look multiplier, 0.1..3 (1 = MOUSE_RADIANS_PER_PIXEL rad per pixel). */
  mouseSensitivity: number;
  invertY: boolean;
  /** Base vertical FOV in degrees, CAMERA_FOV_MIN..CAMERA_FOV_MAX. */
  fov: number;
  /** Camera head-bob while walking. */
  headBob: boolean;
  /** 0..1 each. */
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  /** Quick mute (M key / corner button): silences everything without touching the sliders. */
  muted: boolean;
  /** low: no shadows, half flora instances, pixel ratio 1. medium: shadows 1024, FXAA. high: shadows 2048, ratio ≤ 2. */
  quality: Quality;
  /** Dotted arc preview after half charge (§11). */
  showArcPreview: boolean;
  /**
   * Tones down flashing low-bar icons, lightning, screen shake and UI motion (§17 accessibility). Follows the OS
   * prefers-reduced-motion until the player sets it.
   */
  reducedFlashing: boolean;
  /** UI language. Defaults to Turkish when the browser prefers it. */
  language: Lang;
  /** Last nickname typed on the home screen. */
  nickname: string;
  /** Last character picked in the lobby. */
  lastCharacter: CharacterId;
  /** Coach tips already shown (first-match hints, §17). */
  seenTips: string[];
  /** HUD / panel size multiplier, HUD_SCALE_MIN..HUD_SCALE_MAX. */
  hudScale: number;
  /** Gameplay key layout (input/bindings.ts presets). */
  keyPreset: KeyPreset;
  /** Lock the mouse while playing; off = drag-look (hold a button and drag to look), e.g. on a trackpad. */
  mouseLock: boolean;
  /** "Auto" quality: app/quality.ts picks the tier from the device and steps it down when frames are slow. */
  autoQuality: boolean;
}

/** The OS / browser asks for reduced motion (false where matchMedia is missing, e.g. tests). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function browserLang(): Lang {
  try {
    return (navigator.languages?.[0] ?? navigator.language ?? "").toLowerCase().startsWith("tr") ? "tr" : "en";
  } catch {
    return "en";
  }
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  mouseSensitivity: 1,
  invertY: false,
  fov: CAMERA_FOV,
  headBob: true,
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.9,
  muted: false,
  quality: "medium",
  showArcPreview: true,
  reducedFlashing: false,
  language: browserLang(),
  nickname: "",
  lastCharacter: DEFAULT_CHARACTER,
  seenTips: [],
  hudScale: 1,
  keyPreset: "standard",
  mouseLock: true,
  autoQuality: true,
};

/** Radians of yaw/pitch per mouse pixel at sensitivity 1. */
export const MOUSE_RADIANS_PER_PIXEL = 0.0022;

/**
 * Saved next to the settings: true once the player changed reducedFlashing themselves. Saves without it come from
 * before it existed, when the toggle defaulted off: there only "on" was a choice.
 */
const REDUCED_CHOSEN_KEY = "reducedFlashingChosen";

const QUALITIES: ReadonlyArray<Quality> = ["low", "medium", "high"];
const KEY_PRESETS: ReadonlyArray<KeyPreset> = ["standard", "leftHanded"];

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** Coerce arbitrary (possibly corrupted) data into valid Settings. */
export function sanitizeSettings(raw: Partial<Record<keyof Settings, unknown>>): Settings {
  const d = DEFAULT_SETTINGS;
  return {
    mouseSensitivity: clampNum(raw.mouseSensitivity, 0.1, 3, d.mouseSensitivity),
    invertY: bool(raw.invertY, d.invertY),
    fov: clampNum(raw.fov, CAMERA_FOV_MIN, CAMERA_FOV_MAX, d.fov),
    headBob: bool(raw.headBob, d.headBob),
    masterVolume: clampNum(raw.masterVolume, 0, 1, d.masterVolume),
    musicVolume: clampNum(raw.musicVolume, 0, 1, d.musicVolume),
    sfxVolume: clampNum(raw.sfxVolume, 0, 1, d.sfxVolume),
    muted: bool(raw.muted, d.muted),
    quality: QUALITIES.includes(raw.quality as Quality) ? (raw.quality as Quality) : d.quality,
    showArcPreview: bool(raw.showArcPreview, d.showArcPreview),
    reducedFlashing: bool(raw.reducedFlashing, d.reducedFlashing),
    language: raw.language === "en" || raw.language === "tr" ? raw.language : d.language,
    nickname: typeof raw.nickname === "string" ? raw.nickname.slice(0, NICKNAME_MAX) : d.nickname,
    lastCharacter: CHARACTER_IDS.includes(raw.lastCharacter as CharacterId) ? (raw.lastCharacter as CharacterId) : d.lastCharacter,
    seenTips: Array.isArray(raw.seenTips) ? raw.seenTips.filter((t): t is string => typeof t === "string").slice(0, 64) : [],
    hudScale: clampNum(raw.hudScale, HUD_SCALE_MIN, HUD_SCALE_MAX, d.hudScale),
    keyPreset: KEY_PRESETS.includes(raw.keyPreset as KeyPreset) ? (raw.keyPreset as KeyPreset) : d.keyPreset,
    mouseLock: bool(raw.mouseLock, d.mouseLock),
    autoQuality: bool(raw.autoQuality, d.autoQuality),
  };
}

export type SettingsListener = (next: Readonly<Settings>, changed: ReadonlyArray<keyof Settings>) => void;

export class SettingsStore {
  private value: Settings;
  private listeners = new Set<SettingsListener>();
  /** The player set reducedFlashing themselves; until then it follows the OS (re-read on every boot). */
  private reducedChosen: boolean;

  constructor(private readonly storageKey = SETTINGS_STORAGE_KEY) {
    const stored = this.load();
    this.value = sanitizeSettings(stored);
    const marker = stored[REDUCED_CHOSEN_KEY];
    this.reducedChosen = typeof marker === "boolean" ? marker : this.value.reducedFlashing;
    if (!this.reducedChosen) this.value = { ...this.value, reducedFlashing: prefersReducedMotion() };
  }

  get(): Readonly<Settings> {
    return this.value;
  }

  /**
   * Merge, validate, persist, and notify listeners with the keys that actually changed. Keys whose value is
   * undefined are ignored; invalid values are clamped/replaced by sanitizeSettings. Changing reducedFlashing makes
   * it the player's choice (no longer following the OS).
   */
  set(patch: Partial<Settings>): void {
    this.commit(patch, null);
  }

  /**
   * Back to the defaults, except who you are (nickname, character, language), the tips already seen and the key
   * preset (a left-handed player must not lose their keys mid-match); reduced flashing follows the OS preference
   * again rather than going to "off".
   */
  reset(): void {
    const v = this.value;
    this.commit({
      ...DEFAULT_SETTINGS,
      nickname: v.nickname,
      lastCharacter: v.lastCharacter,
      language: v.language,
      seenTips: v.seenTips,
      keyPreset: v.keyPreset,
      reducedFlashing: prefersReducedMotion(),
    }, false);
  }

  /** Subscribe to changes. Returns an unsubscribe function. Not called immediately. */
  onChange(fn: SettingsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** set() / reset(): `reducedChosen` null = chosen once reducedFlashing changes, else exactly that. */
  private commit(patch: Partial<Settings>, reducedChosen: boolean | null): void {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = sanitizeSettings({ ...this.value, ...defined });
    const changed = (Object.keys(next) as (keyof Settings)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(this.value[k]));
    const chosen = reducedChosen ?? (this.reducedChosen || changed.includes("reducedFlashing"));
    if (changed.length === 0 && chosen === this.reducedChosen) return;
    this.value = next;
    this.reducedChosen = chosen;
    this.save();
    if (changed.length === 0) return;
    for (const fn of [...this.listeners]) {
      try {
        fn(this.value, changed);
      } catch (err) {
        console.error("[settings] listener threw", err);
      }
    }
  }

  private load(): Partial<Record<string, unknown>> {
    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Partial<Record<string, unknown>>) : {};
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify({ ...this.value, [REDUCED_CHOSEN_KEY]: this.reducedChosen }));
    } catch {
      // Private mode / blocked storage: settings still work for this session.
    }
  }
}

/** The app-wide settings singleton. */
export const settings = new SettingsStore();
