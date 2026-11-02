// Island ambience (§18): the always-on beds — waves by the shore, gulls and wind by day, crickets at night, rain,
// the storm — and the dusk drum circle whose tempo rises with the monster count. A pure function turns the
// AmbienceFrame + music mood into per-bed levels (unit-tested); the mixer runs one loop voice per audible bed
// (synth/loops.ts), glides its level, starts it when it becomes audible and stops it after a quiet spell.
// Beds the app is already playing explicitly (AudioEngine.loop with the same name) are muted here so nothing
// doubles. Owner: client-fx-audio.

import type { AmbienceFrame } from "./AudioEngine";
import type { LoopName, MusicMood } from "./Sfx";
import { LOOP_LEVEL, createLoop, type LoopFactory, type LoopVoice } from "./synth/loops";
import { clamp01, safeDisconnect } from "./synth/dsp";

export type BedName = "waves" | "wind" | "gulls" | "crickets" | "rain" | "storm" | "drums";
export const BED_NAMES: ReadonlyArray<BedName> = ["waves", "wind", "gulls", "crickets", "rain", "storm", "drums"];

export interface BedLevel {
  /** 0..1 gain of the bed. */
  level: number;
  /** 0..1 loop parameter (intensity / density / drum tempo). */
  param: number;
}

/** Monsters alive → drum loop param (76 + 74·p BPM): 0 monsters ≈ 84 BPM, 14+ ≈ 150 BPM. */
export function drumParamForMonsters(monsters: number): number {
  const m = Number.isFinite(monsters) ? Math.max(0, monsters) : 0;
  return clamp01(0.11 + m * 0.064);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Moods during which the jungle drums play. */
const DRUM_LEVEL: Partial<Record<MusicMood, number>> = { dusk: 0.7, night: 0.75, boss: 0.9, storm: 0.45 };

/** Per-bed levels for an ambience frame (pure). */
export function ambienceLevels(a: AmbienceFrame, mood: MusicMood): Record<BedName, BedLevel> {
  const day = clamp01(a.daylight);
  const night = 1 - day;
  const sea = clamp01(a.sea);
  const storm = clamp01(a.storm);
  const rainy = a.weather === "rain";
  const fog = a.weather === "fog";
  const crowd = clamp01(a.monsters / 12);
  const under = a.underwater ? 0.5 : 1;
  const levels: Record<BedName, BedLevel> = {
    waves: { level: (0.2 + 0.8 * sea) * (1 + 0.3 * storm), param: clamp01(0.25 + 0.5 * sea + 0.5 * storm) },
    wind: { level: 0.15 + 0.2 * day + (rainy ? 0.2 : 0) + (fog ? 0.08 : 0) + 0.6 * storm, param: clamp01(0.2 + (rainy ? 0.3 : 0) + 0.8 * storm) },
    gulls: { level: rainy || storm > 0.3 ? 0 : smoothstep(0.35, 0.8, day) * (0.4 + 0.6 * sea) * (fog ? 0.5 : 1), param: clamp01(0.3 + 0.5 * sea) },
    crickets: {
      level: (1 - smoothstep(0.15, 0.45, day)) * (rainy ? 0.2 : 1) * (1 - 0.6 * crowd) * (1 - storm),
      param: clamp01(0.4 + 0.6 * night),
    },
    rain: { level: rainy ? 0.8 : 0, param: clamp01(0.55 + 0.45 * storm) },
    storm: { level: storm, param: storm },
    drums: { level: DRUM_LEVEL[mood] ?? 0, param: drumParamForMonsters(a.monsters) },
  };
  for (const name of BED_NAMES) levels[name].level = clamp01(levels[name].level) * under;
  return levels;
}

/** A bed stays running this long after going silent (so a flicker doesn't restart it). */
const STOP_AFTER_SEC = 2.5;
const LEVEL_TAU = 0.6;
const AUDIBLE = 0.01;

interface Bed {
  name: BedName;
  gain: GainNode;
  voice: LoopVoice | null;
  target: number;
  param: number;
  quietFor: number;
}

export class AmbienceMixer {
  private readonly beds: Bed[];
  private frame: AmbienceFrame = { daylight: 1, weather: "clear", sea: 0.3, monsters: 0, storm: 0, underwater: false };
  private mood: MusicMood = "off";
  private suppressed: ReadonlySet<LoopName> = new Set();
  private enabled = true;

  constructor(
    private readonly ctx: BaseAudioContext,
    out: AudioNode,
    private readonly makeLoop: LoopFactory = createLoop,
    private readonly sampleReady: ((name: LoopName) => boolean) | null = null,
  ) {
    this.beds = BED_NAMES.map((name) => {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(out);
      return { name, gain, voice: null, target: 0, param: 0, quietFor: STOP_AFTER_SEC };
    });
  }

  set(frame: AmbienceFrame, mood: MusicMood, suppressed: ReadonlySet<LoopName>): void {
    this.frame = frame;
    this.mood = mood;
    this.suppressed = suppressed;
  }

  /** Silence everything (menus before a match). */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  get activeBeds(): number {
    return this.beds.reduce((n, b) => n + (b.voice ? 1 : 0), 0);
  }

  /** Current targets (dev harness meters). */
  get levels(): Record<BedName, BedLevel> {
    return ambienceLevels(this.frame, this.mood);
  }

  /** Glide levels, start / stop bed voices, schedule their events up to `horizon`. */
  update(dt: number, horizon: number): void {
    const now = this.ctx.currentTime;
    const levels = ambienceLevels(this.frame, this.mood);
    for (const bed of this.beds) {
      const l = levels[bed.name];
      const target = this.enabled && !this.suppressed.has(bed.name) ? l.level * LOOP_LEVEL[bed.name] : 0;
      if (Math.abs(target - bed.target) > 0.002) {
        bed.gain.gain.cancelScheduledValues(now);
        bed.gain.gain.setTargetAtTime(target, now, LEVEL_TAU);
        bed.target = target;
      }
      bed.param = l.param;
      if (target > AUDIBLE) {
        bed.quietFor = 0;
        // A synth bed that started before the generated loop decoded is replaced in place once it is ready.
        if (bed.voice && bed.voice.kind !== "sample" && this.sampleReady?.(bed.name)) {
          const old = bed.voice;
          bed.voice = null;
          old.stop(now, 0.25);
        }
        if (!bed.voice) bed.voice = this.makeLoop(this.ctx, bed.name, bed.gain, now + 0.02, l.param);
      } else {
        bed.quietFor += dt;
        if (bed.voice && bed.quietFor > STOP_AFTER_SEC) {
          const voice = bed.voice;
          bed.voice = null;
          voice.stop(now, 0.3);
        }
      }
      if (bed.voice) {
        bed.voice.setParam(l.param, now);
        bed.voice.tick(now, horizon);
      }
    }
  }

  /** Schedule bed events only (the background ticker, between frames). */
  tick(horizon: number): void {
    const now = this.ctx.currentTime;
    for (const bed of this.beds) bed.voice?.tick(now, horizon);
  }

  dispose(): void {
    const now = this.ctx.currentTime;
    for (const bed of this.beds) {
      bed.voice?.stop(now, 0.05);
      bed.voice = null;
      safeDisconnect(bed.gain);
    }
  }
}
