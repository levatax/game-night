// Client settings with defaults, validation and localStorage persistence. Complete.
// The Overlays settings panel edits through settings.set(); consumers listen with settings.onChange.

import { SETTINGS_STORAGE_KEY } from "../../../shared/constants";
import { Emitter } from "../util/Emitter";

export type Quality = "low" | "medium" | "high";

export interface Settings {
  /** Orbit sensitivity multiplier 0.2..3. */
  cameraSensitivity: number;
  invertOrbit: boolean;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  quality: Quality;
  /** Tones down Cursed / Legendary flashes, screen shake and strobing lights. */
  reducedFlashing: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  cameraSensitivity: 1,
  invertOrbit: false,
  masterVolume: 0.8,
  musicVolume: 0.6,
  sfxVolume: 0.9,
  quality: "high",
  reducedFlashing: false,
};

const clamp = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

function sanitize(raw: Partial<Settings>): Settings {
  const d = DEFAULT_SETTINGS;
  return {
    cameraSensitivity: clamp(raw.cameraSensitivity, 0.2, 3, d.cameraSensitivity),
    invertOrbit: typeof raw.invertOrbit === "boolean" ? raw.invertOrbit : d.invertOrbit,
    masterVolume: clamp(raw.masterVolume, 0, 1, d.masterVolume),
    musicVolume: clamp(raw.musicVolume, 0, 1, d.musicVolume),
    sfxVolume: clamp(raw.sfxVolume, 0, 1, d.sfxVolume),
    quality: raw.quality === "low" || raw.quality === "medium" || raw.quality === "high" ? raw.quality : d.quality,
    reducedFlashing: typeof raw.reducedFlashing === "boolean" ? raw.reducedFlashing : d.reducedFlashing,
  };
}

class SettingsStore {
  private value: Settings;
  private emitter = new Emitter<{ change: Settings }>();

  constructor() {
    let stored: Partial<Settings> = {};
    try {
      stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}");
    } catch {
      stored = {};
    }
    this.value = sanitize(stored);
  }

  get(): Settings {
    return this.value;
  }

  set(patch: Partial<Settings>): void {
    this.value = sanitize({ ...this.value, ...patch });
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.value));
    } catch {
      /* private mode */
    }
    this.emitter.emit("change", this.value);
  }

  onChange(fn: (s: Settings) => void): () => void {
    return this.emitter.on("change", fn);
  }
}

export const settings = new SettingsStore();
