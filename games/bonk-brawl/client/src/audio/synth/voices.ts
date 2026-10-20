// Procedural animal voices: a buzzy source through formant filters, with per-animal presets
// (quack, ribbit, grumble, meow, squawk, bleat) and per-moment variants (hit, throw, emote, ...).

import type { CharacterDef } from "../../../../shared/constants";
import type { VoiceKind } from "../Sfx";
import type { Formant } from "./blocks";
import { applyCurve, rand, type CurvePoint, type Synth } from "./dsp";

export type VoicePresetId = CharacterDef["voice"];

interface VoicePreset {
  wave: OscillatorType;
  /** Base fundamental in Hz. */
  pitch: number;
  /** Formants at the start of each syllable; `formantsEnd` morphs toward another vowel. */
  formants: ReadonlyArray<Formant>;
  formantsEnd?: ReadonlyArray<Formant>;
  /** Amplitude roughness (croak / rasp): rate Hz, depth 0..1. */
  rough: readonly [number, number];
  /** Pitch vibrato: rate Hz, depth cents. */
  vibrato: readonly [number, number];
  /** Breath/rasp noise level relative to the voice. */
  noise: number;
  /** Soft-clip drive for buzz. */
  drive: number;
  /** Base syllable length (s) and how many syllables the call has by itself ("rib-bit" = 2). */
  syllable: number;
  syllables: number;
  /** Pitch contour within a syllable: [start, peak, end] multipliers. */
  contour: readonly [number, number, number];
  level: number;
}

interface VoiceVariant {
  pitch: number;
  length: number;
  syllables: number;
  /** Multiplies the preset contour: <1 at the end falls (sad/hurt), >1 rises (happy). */
  contour: readonly [number, number, number];
  level: number;
}

const PRESETS: Readonly<Record<VoicePresetId, VoicePreset>> = {
  quack: {
    wave: "square",
    pitch: 330,
    formants: [
      [950, 5, 1.5],
      [1750, 6, 0.9],
      [3000, 8, 0.4],
    ],
    rough: [68, 0.6],
    vibrato: [0, 0],
    noise: 0.15,
    drive: 3,
    syllable: 0.17,
    syllables: 1,
    contour: [1.15, 1.0, 0.72],
    level: 0.85,
  },
  ribbit: {
    wave: "sawtooth",
    pitch: 115,
    formants: [
      [520, 5, 1.8],
      [1250, 6, 0.8],
    ],
    rough: [34, 0.95],
    vibrato: [0, 0],
    noise: 0.12,
    drive: 2.5,
    syllable: 0.11,
    syllables: 2,
    contour: [1.0, 1.06, 0.88],
    level: 1.4,
  },
  grumble: {
    wave: "sawtooth",
    pitch: 88,
    formants: [
      [430, 4, 1.8],
      [780, 5, 0.9],
      [2500, 6, 0.15],
    ],
    rough: [23, 0.7],
    vibrato: [5, 30],
    noise: 0.1,
    drive: 2,
    syllable: 0.32,
    syllables: 1,
    contour: [0.9, 1.1, 0.85],
    level: 1.08,
  },
  meow: {
    wave: "sawtooth",
    pitch: 560,
    formants: [
      [420, 5, 1.2],
      [2300, 8, 0.9],
      [3200, 9, 0.3],
    ],
    formantsEnd: [
      [720, 5, 1.4],
      [1100, 6, 0.9],
      [2600, 8, 0.2],
    ],
    rough: [0, 0],
    vibrato: [6, 25],
    noise: 0.05,
    drive: 1.5,
    syllable: 0.42,
    syllables: 1,
    contour: [0.85, 1.25, 0.75],
    level: 0.5,
  },
  squawk: {
    wave: "sawtooth",
    pitch: 600,
    formants: [
      [1250, 3, 1.4],
      [2450, 5, 0.8],
    ],
    rough: [88, 0.8],
    vibrato: [0, 0],
    noise: 0.3,
    drive: 5,
    syllable: 0.14,
    syllables: 1,
    contour: [1.2, 1.05, 0.8],
    level: 0.65,
  },
  bleat: {
    wave: "sawtooth",
    pitch: 330,
    formants: [
      [620, 5, 1.5],
      [1800, 7, 0.8],
      [2600, 8, 0.35],
    ],
    rough: [9, 0.8],
    vibrato: [9, 55],
    noise: 0.08,
    drive: 2,
    syllable: 0.45,
    syllables: 1,
    contour: [1.0, 1.06, 0.9],
    level: 0.67,
  },
};

const VARIANTS: Readonly<Record<VoiceKind, VoiceVariant>> = {
  hit: { pitch: 1.25, length: 0.7, syllables: 1, contour: [1.2, 1.0, 0.65], level: 1 },
  throw: { pitch: 1.0, length: 0.55, syllables: 1, contour: [0.92, 1.1, 1.0], level: 0.7 },
  emote: { pitch: 1.05, length: 0.9, syllables: 3, contour: [1, 1.08, 0.97], level: 0.9 },
  ko: { pitch: 0.95, length: 1.8, syllables: 1, contour: [1.15, 1.0, 0.55], level: 1 },
  win: { pitch: 1.12, length: 0.85, syllables: 2, contour: [0.95, 1.12, 1.2], level: 1 },
  catch: { pitch: 1.15, length: 0.75, syllables: 2, contour: [1, 1.2, 1.12], level: 0.9 },
};

/** Melodic steps for multi-syllable calls (multipliers), cycling. */
const SYLLABLE_STEPS = [1, 1.12, 0.94, 1.06];

/** Gain of a character voice before PlayOptions.volume: just under the impacts it accompanies. */
export const VOICE_LEVEL = 0.75;

export const VOICE_PRESET_IDS = Object.keys(PRESETS) as VoicePresetId[];
export const VOICE_KINDS = Object.keys(VARIANTS) as VoiceKind[];

/** Schedule one animal call into `s`. Returns its length in seconds. */
export function synthVoice(s: Synth, presetId: VoicePresetId, kind: VoiceKind): number {
  const preset = PRESETS[presetId];
  const variant = VARIANTS[kind];
  const count = variant.syllables + preset.syllables - 1;
  const sylLen = preset.syllable * variant.length;
  const gap = sylLen * 0.35;
  const total = count * sylLen + (count - 1) * gap;
  const base = preset.pitch * variant.pitch * s.rate * rand(0.97, 1.03);

  const env = s.gain(0);
  const sum = s.gain(1, env);
  const bands = buildFormants(s, preset, sum, count, sylLen, gap);
  const rough = preset.rough[1] > 0 ? s.tremolo(preset.rough[0], preset.rough[1], 0, total + 0.05, bands) : bands;
  const shaper = s.shaper(preset.drive, rough);

  const o = s.osc(preset.wave, base, 0, total + 0.05, shaper);
  if (preset.vibrato[1] > 0) s.lfo(preset.vibrato[0], preset.vibrato[1], o.detune, 0, total + 0.05);

  const amp: CurvePoint[] = [[0, 0]];
  for (let i = 0; i < count; i++) {
    const t0 = i * (sylLen + gap);
    const step = SYLLABLE_STEPS[i % SYLLABLE_STEPS.length] * (i === count - 1 && kind === "ko" ? 0.9 : 1);
    const f = base * step;
    applySyllablePitch(o.frequency, s.t + t0, sylLen, f, preset.contour, variant.contour);
    const peak = preset.level * variant.level;
    if (i > 0) amp.push([t0, 0, "set"]);
    amp.push([t0 + 0.012, peak], [t0 + sylLen * 0.7, peak * 0.8], [t0 + sylLen, 0.001, "exp"]);
  }
  s.curve(env.gain, amp);

  if (preset.noise > 0) {
    const breath = s.filter("bandpass", preset.formants[0][0] * 1.4, 1.2, s.gain(preset.noise * 2, env));
    s.noise("white", 0, total + 0.05, breath);
  }
  return total;
}

function applySyllablePitch(
  param: AudioParam,
  t: number,
  len: number,
  f: number,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): void {
  applyCurve(param, t, [
    [0, f * a[0] * b[0]],
    [len * 0.3, f * a[1] * b[1], "exp"],
    [len, f * a[2] * b[2], "exp"],
  ]);
}

/** Parallel formant band-passes into `dest`; morphing ones sweep per syllable. Returns their shared input. */
function buildFormants(s: Synth, preset: VoicePreset, dest: AudioNode, count: number, sylLen: number, gap: number): AudioNode {
  const fan = s.ctx.createGain();
  preset.formants.forEach(([freq, q, gain], idx) => {
    const band = s.filter("bandpass", freq, q, s.gain(gain, dest));
    fan.connect(band);
    const end = preset.formantsEnd?.[idx];
    if (!end) return;
    const points: CurvePoint[] = [];
    for (let i = 0; i < count; i++) {
      const t0 = i * (sylLen + gap);
      points.push([t0, freq, "set"], [t0 + sylLen * 0.85, end[0], "exp"]);
    }
    s.curve(band.frequency, points);
  });
  return fan;
}
