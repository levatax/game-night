// Gibberish tourist voices (§14, §18): formant synthesis, one timbre per tourist. A sawtooth + square "glottis"
// with a pitch contour and vibrato runs through 3 parallel band-pass formant filters whose centres glide between
// vowels. Base pitch is CHARACTERS[id].voiceHz; the profile adds formant shift (head size), buzz (nasality),
// wobble and talking speed — the Captain barks orders, the Influencer up-speaks, Uncle wobbles, the Chef is
// nasal, the Kid squeaks. Owner: client-fx-audio. Adapted from games/jelly-jackpot/client/src/audio/sfx/voices.ts
// (speak, formant table, word shapes) onto the Synth builder of synth/dsp.ts.

import { CHARACTERS } from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";
import type { VoiceKind } from "./Sfx";
import type { Synth } from "./synth/dsp";

export type Vowel = "a" | "e" | "i" | "o" | "u" | "m" | "n";

/** Formant centres (Hz) and relative amplitudes, roughly adult values. */
const FORMANTS: Readonly<Record<Vowel, { f: readonly [number, number, number]; amp: readonly [number, number, number] }>> = {
  a: { f: [800, 1200, 2700], amp: [1, 0.55, 0.25] },
  e: { f: [450, 1900, 2600], amp: [1, 0.45, 0.3] },
  i: { f: [300, 2300, 3000], amp: [1, 0.35, 0.25] },
  o: { f: [480, 820, 2600], amp: [1, 0.6, 0.15] },
  u: { f: [330, 700, 2450], amp: [1, 0.35, 0.1] },
  m: { f: [260, 1100, 2300], amp: [0.6, 0.05, 0.03] },
  n: { f: [280, 1700, 2600], amp: [0.6, 0.08, 0.05] },
};

/** One syllable chunk. Pitch multipliers are relative to the speaker's base pitch. */
export interface Seg {
  v: Vowel;
  d: number;
  p0: number;
  p1: number;
  /** Voiced loudness 0..1. */
  amp?: number;
  /** Breath noise through the formants 0..1 ("h", gasps). */
  breath?: number;
  /** Unvoiced hiss along the segment ("sss", "ff"). */
  hiss?: number;
}

export interface Speaker {
  pitch: number;
  formant: number;
  vibRate: number;
  vibDepth: number;
  /** 0..1: how much square (nasal / buzzy) is mixed with the saw. */
  buzz: number;
}

/** Per-tourist voice personality on top of CHARACTERS[id].voiceHz (pure table, unit-tested). */
export interface VoiceProfile {
  formant: number;
  vibRate: number;
  vibDepth: number;
  buzz: number;
  /** Talking speed (segment duration multiplier, < 1 = faster). */
  tempo: number;
  /** Phrase-final pitch bend (> 1 = up-speak, < 1 = falling, "orders"). */
  inflection: number;
}

export const VOICE_PROFILES: Readonly<Record<CharacterId, VoiceProfile>> = {
  kaptan: { formant: 0.95, vibRate: 5, vibDepth: 0.02, buzz: 0.35, tempo: 0.95, inflection: 0.82 },
  fenomen: { formant: 1.2, vibRate: 7, vibDepth: 0.03, buzz: 0.15, tempo: 0.85, inflection: 1.25 },
  amca: { formant: 0.88, vibRate: 4.2, vibDepth: 0.06, buzz: 0.3, tempo: 1.2, inflection: 0.95 },
  gelin: { formant: 1.15, vibRate: 6, vibDepth: 0.025, buzz: 0.1, tempo: 1, inflection: 1.12 },
  sef: { formant: 1.0, vibRate: 6.5, vibDepth: 0.035, buzz: 0.7, tempo: 0.9, inflection: 1.05 },
  cocuk: { formant: 1.32, vibRate: 9, vibDepth: 0.04, buzz: 0.2, tempo: 0.8, inflection: 1.18 },
};

/** Gain of a tourist line into the voice bus (tuned with the offline probe in dev/audio.html). */
export const VOICE_LEVEL = 0.75;

export function speakerFor(character: CharacterId): Speaker {
  const p = VOICE_PROFILES[character];
  return { pitch: CHARACTERS[character].voiceHz, formant: p.formant, vibRate: p.vibRate, vibDepth: p.vibDepth, buzz: p.buzz };
}

const vary = (amt: number, rnd: () => number = Math.random): number => 1 + (rnd() * 2 - 1) * amt;

/**
 * Render segments with one speaker into `s` starting `at` seconds into the voice. Returns the total duration.
 * `trill` adds an amplitude flutter (Hz) for "brrr" shivers.
 */
export function speak(s: Synth, at: number, sp: Speaker, segs: ReadonlyArray<Seg>, pitchMul = 1, dest: AudioNode = s.out, trill = 0): number {
  const total = segs.reduce((acc, x) => acc + x.d, 0);
  const t0 = s.t + at;
  const end = at + total + 0.06;
  const base = sp.pitch * pitchMul;

  // Glottal source: saw + square (buzz), summed, then enveloped as "voiced" (voicedOut fans out to the formants;
  // a trill flutters its gain for "brrr").
  const voicedOut = s.ctx.createGain();
  voicedOut.gain.value = trill > 0 ? 0.6 : 1;
  const voiced = s.gain(0.0001, voicedOut);
  const saw = s.osc("sawtooth", base, at, end, voiced);
  const sq = s.osc("square", base * 1.003, at, end, s.gain(sp.buzz * 0.6, voiced));
  for (const o of [saw, sq]) s.lfo(sp.vibRate * vary(0.1), base * sp.vibDepth * s.rate, o.frequency, at, end);
  if (trill > 0) s.lfo(trill, 0.45, voicedOut.gain, at, end);

  // Breath noise through the same formants.
  const breathOut = s.ctx.createGain();
  const breath = s.gain(0.0001, breathOut);
  s.noise("white", at, end, breath);

  // Formant bank.
  const bank: Array<{ bp: BiquadFilterNode; amp: GainNode }> = [];
  for (let k = 0; k < 3; k++) {
    const amp = s.gain(0, dest);
    const bp = s.filter("bandpass", 500, 8, amp);
    voicedOut.connect(bp);
    breathOut.connect(bp);
    bank.push({ bp, amp });
  }
  // A touch of dry low-passed source keeps the fundamental present (formant band-passes are thin).
  voicedOut.connect(s.gain(0.12, s.filter("lowpass", 900, 0.7, dest)));

  // Hiss path for "sss".
  const hiss = s.gain(0.0001, dest);
  s.noise("white", at, end, s.filter("highpass", 4500, 0.9, hiss));

  let tt = t0;
  for (const seg of segs) {
    const F = FORMANTS[seg.v];
    const glideT = Math.min(0.06, seg.d * 0.4);
    for (let k = 0; k < 3; k++) {
      const f = F.f[k]! * sp.formant;
      const band = bank[k]!;
      if (tt === t0) {
        band.bp.frequency.setValueAtTime(f, t0);
        band.amp.gain.setValueAtTime(F.amp[k]! * 3.2, t0);
      }
      band.bp.frequency.linearRampToValueAtTime(f, tt + glideT);
      band.bp.Q.setValueAtTime(f / (60 + k * 40), tt);
      // Band-passes lose energy, so formant gains are boosted.
      band.amp.gain.linearRampToValueAtTime(F.amp[k]! * 3.2, tt + glideT);
    }
    for (const o of [saw, sq]) {
      o.frequency.setValueAtTime(Math.max(30, base * seg.p0 * s.rate), tt);
      o.frequency.exponentialRampToValueAtTime(Math.max(30, base * seg.p1 * s.rate), tt + seg.d);
    }
    const a = seg.amp ?? 1;
    voiced.gain.linearRampToValueAtTime(a * 0.5, tt + Math.min(0.03, seg.d * 0.3));
    voiced.gain.setValueAtTime(a * 0.5, tt + seg.d * 0.75);
    voiced.gain.linearRampToValueAtTime(a * 0.25, tt + seg.d);
    const br = seg.breath ?? 0;
    breath.gain.linearRampToValueAtTime(br * 0.5, tt + 0.02);
    breath.gain.linearRampToValueAtTime(br * 0.2, tt + seg.d);
    const hs = seg.hiss ?? 0;
    hiss.gain.linearRampToValueAtTime(hs * 0.35, tt + seg.d * 0.3);
    hiss.gain.linearRampToValueAtTime(hs * 0.2, tt + seg.d * 0.9);
    hiss.gain.linearRampToValueAtTime(0.0001, tt + seg.d);
    tt += seg.d;
  }
  voiced.gain.linearRampToValueAtTime(0.0001, tt + 0.04);
  breath.gain.linearRampToValueAtTime(0.0001, tt + 0.04);
  return total;
}

const GIBBERISH_VOWELS: readonly Vowel[] = ["a", "e", "i", "o", "u", "a", "o"];

/** Random 3–5 syllable chatter with a contour ending on `inflection` ("bla-bla-blaa?"). */
function gibberish(rnd: () => number, inflection: number, syllables = 3 + Math.floor(rnd() * 3)): Seg[] {
  const out: Seg[] = [];
  let p = 1 + (rnd() - 0.5) * 0.2;
  for (let i = 0; i < syllables; i++) {
    const last = i === syllables - 1;
    const v = GIBBERISH_VOWELS[Math.floor(rnd() * GIBBERISH_VOWELS.length)]!;
    const next = last ? p * inflection : p * (1 + (rnd() - 0.5) * 0.3);
    // A consonant-ish onset: a short nasal or a breathy attack.
    out.push(rnd() < 0.5 ? { v: rnd() < 0.5 ? "m" : "n", d: 0.035, p0: p, p1: p, amp: 0.5 } : { v, d: 0.025, p0: p, p1: p, amp: 0.1, breath: 0.7 });
    out.push({ v, d: last ? 0.2 : 0.07 + rnd() * 0.06, p0: p, p1: next });
    p = next;
  }
  return out;
}

/** The tourist vocabulary per VoiceKind (segments, before the speaker's tempo). Exported for tests. */
export const WORDS: Readonly<Record<VoiceKind, (rnd: () => number, inflection: number) => Seg[]>> = {
  // "Ow!" — sharp, high, dropping.
  hurt: () => [
    { v: "a", d: 0.04, p0: 1.5, p1: 1.9, amp: 0.3, breath: 0.6 },
    { v: "o", d: 0.12, p0: 1.9, p1: 1.4 },
    { v: "u", d: 0.1, p0: 1.4, p1: 1.0, amp: 0.6 },
  ],
  // "Hup!" — a short effort grunt.
  throw: (rnd) => [
    { v: "u", d: 0.03, p0: 1.1, p1: 1.1, amp: 0.1, breath: 0.9 },
    { v: rnd() < 0.5 ? "a" : "u", d: 0.09, p0: 1.15, p1: 1.35 },
  ],
  // "Nom nom nom".
  eat: (rnd) => {
    const out: Seg[] = [];
    const n = 2 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) {
      out.push({ v: "n", d: 0.05, p0: 1.05, p1: 1.05, amp: 0.6 });
      out.push({ v: "o", d: 0.08, p0: 1.1, p1: 1.0 });
      out.push({ v: "m", d: 0.07, p0: 1.0, p1: 0.95, amp: 0.7 });
    }
    return out;
  },
  // "AAAAAH!" — a wobbly rising scream.
  panic: () => [
    { v: "a", d: 0.05, p0: 1.4, p1: 1.6, amp: 0.3, breath: 0.8 },
    { v: "a", d: 0.45, p0: 1.6, p1: 2.2 },
    { v: "a", d: 0.25, p0: 2.2, p1: 1.7, amp: 0.7 },
  ],
  // "Ha-ha-ha!"
  laugh: (rnd) => {
    const out: Seg[] = [];
    const n = 3 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) {
      const p = 1.45 - i * 0.12;
      out.push({ v: "a", d: 0.035, p0: p, p1: p, amp: 0.05, breath: 0.9 });
      out.push({ v: "a", d: 0.1, p0: p * 1.05, p1: p * 0.92 });
      out.push({ v: "a", d: 0.04, p0: p, p1: p, amp: 0.02 });
    }
    return out;
  },
  // "İmdaaat!" — a long call for help.
  help: () => [
    { v: "i", d: 0.08, p0: 1.3, p1: 1.4 },
    { v: "m", d: 0.06, p0: 1.4, p1: 1.4, amp: 0.6 },
    { v: "a", d: 0.38, p0: 1.5, p1: 1.9 },
    { v: "a", d: 0.12, p0: 1.9, p1: 1.6, amp: 0.4, breath: 0.4 },
  ],
  // "Yes!" / "Evet!"
  yes: () => [
    { v: "i", d: 0.08, p0: 1.0, p1: 1.1 },
    { v: "e", d: 0.2, p0: 1.1, p1: 1.55 },
    { v: "e", d: 0.25, p0: 1.55, p1: 1.4, amp: 0.05, hiss: 1 },
  ],
  // "Wooo-hoo!"
  cheer: () => [
    { v: "u", d: 0.12, p0: 1.0, p1: 1.4 },
    { v: "o", d: 0.3, p0: 1.4, p1: 1.7 },
    { v: "u", d: 0.04, p0: 1.4, p1: 1.4, amp: 0.1, breath: 0.9 },
    { v: "u", d: 0.28, p0: 1.6, p1: 2.0 },
  ],
  // Emotes / pings: a little gibberish sentence in the tourist's own melody.
  emote: (rnd, inflection) => gibberish(rnd, inflection),
  // "Oh noooo…"
  downed: () => [
    { v: "o", d: 0.12, p0: 1.3, p1: 1.4 },
    { v: "n", d: 0.06, p0: 1.3, p1: 1.35, amp: 0.7 },
    { v: "o", d: 0.12, p0: 1.4, p1: 1.25 },
    { v: "u", d: 0.5, p0: 1.25, p1: 0.62 },
  ],
  // "Phew! Ooh!" — relief.
  revived: () => [
    { v: "u", d: 0.12, p0: 1.0, p1: 0.95, amp: 0.1, breath: 1, hiss: 0.4 },
    { v: "o", d: 0.08, p0: 1.1, p1: 1.3 },
    { v: "u", d: 0.22, p0: 1.3, p1: 1.55 },
  ],
  // "Brrrrr" (trilled by speakWord).
  shiver: () => [
    { v: "u", d: 0.06, p0: 1.0, p1: 1.0, amp: 0.4, breath: 0.6 },
    { v: "u", d: 0.5, p0: 1.0, p1: 0.92 },
  ],
};

/** Total duration (s) of a word's segments for a character (tests / scheduling). */
export function wordDuration(segs: ReadonlyArray<Seg>, character: CharacterId): number {
  return segs.reduce((acc, x) => acc + x.d, 0) * VOICE_PROFILES[character].tempo;
}

/**
 * Per-line loudness calibration (offline probe in dev/audio.html): every line lands around −6 dBFS through
 * VOICE_LEVEL, a panic scream a little louder, the frequent throw grunt a little softer.
 */
export const KIND_GAIN: Readonly<Record<VoiceKind, number>> = {
  hurt: 1.57,
  throw: 1,
  eat: 1,
  panic: 1.57,
  laugh: 1.6,
  help: 0.94,
  yes: 1.23,
  cheer: 0.72,
  emote: 1.11,
  downed: 1,
  revived: 0.73,
  shiver: 1.11,
};

/** One tourist line into `s` (the engine's voice spawn). Returns its duration (s). */
export function speakWord(s: Synth, character: CharacterId, kind: VoiceKind, rnd: () => number = Math.random): number {
  const profile = VOICE_PROFILES[character];
  const segs = WORDS[kind](rnd, profile.inflection).map((seg) => ({ ...seg, d: seg.d * profile.tempo }));
  const pitch = kind === "panic" || kind === "cheer" ? vary(0.08, rnd) : vary(0.05, rnd);
  return speak(s, 0, speakerFor(character), segs, pitch, s.gain(KIND_GAIN[kind]), kind === "shiver" ? 24 : 0);
}

const CROWD: readonly CharacterId[] = ["kaptan", "fenomen", "amca", "gelin", "sef", "cocuk"];

/** The whole tour group cheering "yaaay" (win). */
export function crowdCheer(s: Synth, at: number, level = 0.3): void {
  const g = s.gain(level);
  for (const id of CROWD) {
    const sp = { ...speakerFor(id), vibDepth: 0.04 };
    const dt = at + Math.random() * 0.25;
    speak(s, dt, sp, [
      { v: "e", d: 0.08, p0: 1.1, p1: 1.4, amp: 0.8 },
      { v: "a", d: 0.5 + Math.random() * 0.4, p0: 1.5, p1: 1.25 * vary(0.1) },
      { v: "i", d: 0.15, p0: 1.25, p1: 1.0, amp: 0.6 },
    ], vary(0.04), g);
  }
}

/** The tour group's disappointed "awww" (lose). */
export function crowdAww(s: Synth, at: number, level = 0.3): void {
  const g = s.gain(level);
  for (const id of CROWD) {
    const sp = { ...speakerFor(id), vibDepth: 0.05 };
    const dt = at + Math.random() * 0.15;
    speak(s, dt, sp, [
      { v: "a", d: 0.25, p0: 1.3, p1: 1.4 * vary(0.05) },
      { v: "o", d: 0.6, p0: 1.4, p1: 0.75 },
      { v: "u", d: 0.3, p0: 0.75, p1: 0.6, amp: 0.5 },
    ], vary(0.04), g);
  }
}
