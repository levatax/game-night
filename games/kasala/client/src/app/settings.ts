// Client settings with defaults, validation and localStorage persistence. Complete.
// The Overlays settings panel (Esc) edits through settings.set(); consumers read settings.get() and listen
// with settings.onChange (audio volumes, quality, reduced flashing, subtitles, camera view).

import { SETTINGS_STORAGE_KEY } from "../../../shared/constants";
import { Emitter } from "../util/Emitter";

/** "auto" adapts the render resolution / shadows to the measured frame time. */
export type Quality = "auto" | "low" | "medium" | "high";
/** "fp": first person from your own chair (default while seated) · "masa": the classic camera over the table. */
export type ViewMode = "fp" | "masa";

export interface Settings {
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  /** Cemil Abi (§15 "Spiker"). */
  announcerVolume: number;
  /** Show announcer lines as subtitles. */
  subtitles: boolean;
  /** No mp3 recorded for a line → read it with the browser's Turkish speech voice (if one exists). */
  speechFallback: boolean;
  quality: Quality;
  /** §14 "Azaltılmış yanıp sönme": softens the siren pulse, flashes, strobes and screen shake. */
  reducedFlashing: boolean;
  /** Drag-look / right-drag orbit sensitivity multiplier 0.2..3. */
  cameraSensitivity: number;
  /** Camera view while seated in a match (V toggles). */
  view: ViewMode;
  /** First person: lock the mouse to the canvas (crosshair aim) on the first canvas click. */
  mouseLock: boolean;
  /** First-person vertical field of view in degrees, 50..75. */
  fov: number;
}

export const DEFAULT_SETTINGS: Settings = {
  masterVolume: 0.8,
  musicVolume: 0.55,
  sfxVolume: 0.9,
  announcerVolume: 1,
  subtitles: true,
  speechFallback: true,
  quality: "auto",
  reducedFlashing: false,
  cameraSensitivity: 1,
  view: "fp",
  mouseLock: false,
  fov: 58,
};

const clamp = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

function sanitize(raw: Partial<Settings>): Settings {
  const d = DEFAULT_SETTINGS;
  return {
    masterVolume: clamp(raw.masterVolume, 0, 1, d.masterVolume),
    musicVolume: clamp(raw.musicVolume, 0, 1, d.musicVolume),
    sfxVolume: clamp(raw.sfxVolume, 0, 1, d.sfxVolume),
    announcerVolume: clamp(raw.announcerVolume, 0, 1, d.announcerVolume),
    subtitles: bool(raw.subtitles, d.subtitles),
    speechFallback: bool(raw.speechFallback, d.speechFallback),
    quality:
      raw.quality === "auto" || raw.quality === "low" || raw.quality === "medium" || raw.quality === "high"
        ? raw.quality
        : d.quality,
    reducedFlashing: bool(raw.reducedFlashing, d.reducedFlashing),
    cameraSensitivity: clamp(raw.cameraSensitivity, 0.2, 3, d.cameraSensitivity),
    view: raw.view === "fp" || raw.view === "masa" ? raw.view : d.view,
    mouseLock: bool(raw.mouseLock, d.mouseLock),
    fov: clamp(raw.fov, 50, 75, d.fov),
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
