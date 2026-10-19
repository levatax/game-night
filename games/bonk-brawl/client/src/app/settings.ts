// Client settings with defaults, validation and localStorage persistence.
// Owner: client-app (written by the architect, complete). The UI edits settings only through
// `settings.set(...)`; every consumer (Input, CameraRig, AudioEngine, Renderer) listens via onChange.

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

export interface Settings {
  /** Mouse look multiplier, 0.1..3 (1 = 0.0022 rad per pixel). */
  mouseSensitivity: number;
  invertY: boolean;
  /** Base vertical FOV in degrees, CAMERA_FOV_MIN..CAMERA_FOV_MAX. */
  fov: number;
  /** 0..1 each. */
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  /** low: no shadows, no post-FX, pixel ratio 1. medium: shadows (1024), no bloom, FXAA. high: shadows (2048), bloom + FXAA, pixel ratio ≤ 2. */
  quality: Quality;
  /** Full-charge arc preview (skill helper). */
  showArcPreview: boolean;
  /** Last nickname typed on the home screen. */
  nickname: string;
  /** Last character picked in the lobby. */
  lastCharacter: CharacterId;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  mouseSensitivity: 1,
  invertY: false,
  fov: CAMERA_FOV,
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.9,
  quality: "medium",
  showArcPreview: true,
  nickname: "",
  lastCharacter: DEFAULT_CHARACTER,
};

/** Radians of yaw/pitch per mouse pixel at sensitivity 1. */
export const MOUSE_RADIANS_PER_PIXEL = 0.0022;

const QUALITIES: ReadonlyArray<Quality> = ["low", "medium", "high"];

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Coerce arbitrary (possibly corrupted) data into valid Settings. */
export function sanitizeSettings(raw: Partial<Record<keyof Settings, unknown>>): Settings {
  const d = DEFAULT_SETTINGS;
  return {
    mouseSensitivity: clampNum(raw.mouseSensitivity, 0.1, 3, d.mouseSensitivity),
    invertY: typeof raw.invertY === "boolean" ? raw.invertY : d.invertY,
    fov: clampNum(raw.fov, CAMERA_FOV_MIN, CAMERA_FOV_MAX, d.fov),
    masterVolume: clampNum(raw.masterVolume, 0, 1, d.masterVolume),
    musicVolume: clampNum(raw.musicVolume, 0, 1, d.musicVolume),
    sfxVolume: clampNum(raw.sfxVolume, 0, 1, d.sfxVolume),
    quality: QUALITIES.includes(raw.quality as Quality) ? (raw.quality as Quality) : d.quality,
    showArcPreview: typeof raw.showArcPreview === "boolean" ? raw.showArcPreview : d.showArcPreview,
    nickname: typeof raw.nickname === "string" ? raw.nickname.slice(0, NICKNAME_MAX) : d.nickname,
    lastCharacter: CHARACTER_IDS.includes(raw.lastCharacter as CharacterId)
      ? (raw.lastCharacter as CharacterId)
      : d.lastCharacter,
  };
}

export type SettingsListener = (next: Readonly<Settings>, changed: ReadonlyArray<keyof Settings>) => void;

export class SettingsStore {
  private value: Settings;
  private listeners = new Set<SettingsListener>();

  constructor(private readonly storageKey = SETTINGS_STORAGE_KEY) {
    this.value = sanitizeSettings(this.load());
  }

  get(): Readonly<Settings> {
    return this.value;
  }

  /**
   * Merge, validate, persist, and notify listeners with the keys that actually changed.
   * Keys whose value is undefined are ignored (they don't reset the setting); invalid values are
   * clamped/replaced by sanitizeSettings.
   */
  set(patch: Partial<Settings>): void {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = sanitizeSettings({ ...this.value, ...defined });
    const changed = (Object.keys(next) as (keyof Settings)[]).filter((k) => next[k] !== this.value[k]);
    if (changed.length === 0) return;
    this.value = next;
    this.save();
    for (const fn of [...this.listeners]) {
      try {
        fn(this.value, changed);
      } catch (err) {
        console.error("[settings] listener threw", err);
      }
    }
  }

  reset(): void {
    this.set({ ...DEFAULT_SETTINGS, nickname: this.value.nickname, lastCharacter: this.value.lastCharacter });
  }

  /** Subscribe to changes. Returns an unsubscribe function. Not called immediately. */
  onChange(fn: SettingsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private load(): Partial<Record<keyof Settings, unknown>> {
    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Partial<Record<keyof Settings, unknown>>) : {};
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(this.value));
    } catch {
      // Private mode / blocked storage: settings still work for this session.
    }
  }
}

/** The app-wide settings singleton. */
export const settings = new SettingsStore();
