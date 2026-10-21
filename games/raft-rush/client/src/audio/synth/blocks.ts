// Reusable cartoon sound building blocks (thumps, boings, bells, filtered noise bursts, formant buzz). Owner:
// client-fx-audio. Copied from games/bonk-brawl/client/src/audio/synth/blocks.ts; island additions at the end
// (droplet, crackle, chirp, knock, squelch). Each block schedules into a Synth; times are offsets from the voice
// start.

import { rand, type CurvePoint, type NoiseColor, type Synth } from "./dsp";

/** Low sine "thump" whose pitch drops from f0 to f1. */
export function thump(s: Synth, at: number, f0: number, f1: number, dur: number, level: number): void {
  const g = s.gain(0);
  const o = s.osc("sine", f0, at, at + dur + 0.02, g);
  s.freq(o.frequency, [
    [at, f0],
    [at + dur, f1, "exp"],
  ]);
  s.perc(g.gain, at, level, 0.004, dur);
}

export interface NoiseBurstOptions {
  type?: BiquadFilterType;
  /** Filter frequency sweep start → end. */
  from: number;
  to?: number;
  q?: number;
  color?: NoiseColor;
  attack?: number;
}

/** Filtered noise burst with a frequency sweep and a percussive envelope. */
export function noiseBurst(s: Synth, at: number, dur: number, level: number, o: NoiseBurstOptions): BiquadFilterNode {
  const g = s.gain(0);
  const f = s.filter(o.type ?? "bandpass", o.from, o.q ?? 1, g);
  s.noise(o.color ?? "white", at, at + dur + 0.02, f);
  s.freq(f.frequency, [
    [at, o.from],
    [at + dur, o.to ?? o.from, "exp"],
  ]);
  s.perc(g.gain, at, level, o.attack ?? 0.004, dur);
  return f;
}

export interface BoingOptions {
  wave?: OscillatorType;
  /** Wobble (spring) rate in Hz and starting depth in Hz; the depth decays to 0 over the sound. */
  wobbleHz: number;
  wobbleDepth: number;
  /** Fraction of `dur` the pitch glide from f0 to f1 takes. */
  glide?: number;
}

/** Springy cartoon "boing": a gliding tone with a decaying frequency wobble. */
export function boing(s: Synth, at: number, f0: number, f1: number, dur: number, level: number, o: BoingOptions): OscillatorNode {
  const g = s.gain(0);
  const osc = s.osc(o.wave ?? "triangle", f0, at, at + dur + 0.02, g);
  s.freq(osc.frequency, [
    [at, f0],
    [at + dur * (o.glide ?? 0.6), f1, "exp"],
  ]);
  s.lfo(o.wobbleHz, o.wobbleDepth * s.rate, osc.frequency, at, at + dur, [
    [at, o.wobbleDepth * s.rate],
    [at + dur, 0.5, "exp"],
  ]);
  s.perc(g.gain, at, level, 0.005, dur);
  return osc;
}

/** [frequency ratio, relative gain, relative decay] */
export type Partial = readonly [number, number, number];

export const BELL_PARTIALS: ReadonlyArray<Partial> = [
  [1, 1, 1],
  [2.0, 0.35, 0.55],
  [3.01, 0.16, 0.35],
  [4.17, 0.09, 0.22],
];

export const WOOD_PARTIALS: ReadonlyArray<Partial> = [
  [1, 1, 1],
  [2.53, 0.45, 0.55],
  [4.2, 0.18, 0.3],
];

/** Additive struck tone (bells, wood blocks, xylophone-ish plinks). */
export function struck(s: Synth, at: number, freq: number, dur: number, level: number, partials: ReadonlyArray<Partial> = BELL_PARTIALS): void {
  for (const [ratio, gain, decay] of partials) {
    const g = s.gain(0);
    s.osc("sine", freq * ratio, at, at + dur * decay + 0.02, g);
    s.perc(g.gain, at, level * gain, 0.002, dur * decay);
  }
}

/** Short tone with an exponential pitch glide (blips, bloops, clicks). */
export function blip(s: Synth, at: number, f0: number, f1: number, dur: number, level: number, wave: OscillatorType = "sine"): OscillatorNode {
  const g = s.gain(0);
  const o = s.osc(wave, f0, at, at + dur + 0.02, g);
  s.freq(o.frequency, [
    [at, f0],
    [at + dur * 0.6, f1, "exp"],
  ]);
  s.perc(g.gain, at, level, 0.003, dur);
  return o;
}

/** Tiny click transient that gives impacts their attack. */
export function click(s: Synth, at: number, level: number, freq = 3000): void {
  noiseBurst(s, at, 0.012, level, { type: "bandpass", from: freq, q: 1.2 });
}

/** Scatter of tiny noise grains (debris, feathers, sparkles). */
export function grains(s: Synth, from: number, to: number, count: number, level: number, fMin: number, fMax: number, color: NoiseColor = "white"): void {
  for (let i = 0; i < count; i++) {
    const at = rand(from, to);
    const fade = 1 - (at - from) / Math.max(0.001, to - from) * 0.6;
    const f = rand(fMin, fMax);
    noiseBurst(s, at, rand(0.015, 0.05), level * rand(0.5, 1) * fade, { type: "bandpass", from: f, to: f * 0.8, q: 2.5, color });
  }
}

/** [center Hz, Q, gain] of one vocal-tract-ish resonance. */
export type Formant = readonly [number, number, number];

/** Buzzy formant chain (kazoo, horns, sirens): soft-clip shaper → parallel band-passes → dest. Returns the input. */
export function formantChain(s: Synth, drive: number, formants: ReadonlyArray<Formant>, dest: AudioNode): AudioNode {
  const fan = s.ctx.createGain();
  for (const [freq, q, gain] of formants) fan.connect(s.filter("bandpass", freq, q, s.gain(gain, dest)));
  return s.shaper(drive, fan);
}

/** Vibrato in cents on an oscillator's detune param, fading in after `delay`. */
export function vibrato(s: Synth, o: OscillatorNode, at: number, dur: number, rateHz: number, cents: number, delay = 0): void {
  const points: CurvePoint[] = delay > 0
    ? [[at, 0], [at + delay, 0], [at + delay + 0.12, cents]]
    : [[at, cents]];
  s.lfo(rateHz, cents, o.detune, at, at + dur, points);
}

/* ------------------------------------------------------------------ island additions */

/** Water "plink": a sine whose pitch jumps up fast (a drop hitting water), with a tiny noise tick. */
export function droplet(s: Synth, at: number, freq: number, level: number): void {
  const g = s.gain(0);
  const o = s.osc("sine", freq, at, at + 0.09, g);
  s.freq(o.frequency, [
    [at, freq],
    [at + 0.05, freq * 2.2, "exp"],
  ]);
  s.perc(g.gain, at, level, 0.002, 0.06);
  noiseBurst(s, at, 0.01, level * 0.25, { type: "highpass", from: 5000, q: 0.7 });
}

/** One campfire pop: a very short bright click with a dull body. */
export function crackle(s: Synth, at: number, level: number): void {
  noiseBurst(s, at, rand(0.006, 0.016), level, { type: "bandpass", from: rand(1800, 4200), q: rand(0.8, 2.5) });
  if (Math.random() < 0.4) noiseBurst(s, at, 0.03, level * 0.4, { type: "lowpass", from: 700, to: 300, color: "pink" });
}

/** Bird / cricket chirp: a fast pitch sweep with an amplitude flutter. */
export function chirp(s: Synth, at: number, f0: number, f1: number, dur: number, level: number, flutterHz = 0): void {
  const g = s.gain(0);
  const dest = flutterHz > 0 ? s.tremolo(flutterHz, 0.9, at, at + dur + 0.02, g) : g;
  const o = s.osc("sine", f0, at, at + dur + 0.02, dest);
  s.freq(o.frequency, [
    [at, f0],
    [at + dur, f1, "exp"],
  ]);
  s.perc(g.gain, at, level, Math.min(0.01, dur * 0.2), dur);
}

/** Hollow wood knock (chopping, crates, hammering). */
export function knock(s: Synth, at: number, freq: number, level: number, dur = 0.1): void {
  struck(s, at, freq, dur, level, WOOD_PARTIALS);
  click(s, at, level * 0.6, freq * 3.2);
}

/** Wet squelch: a resonant lowpass sweeping over pink noise (tentacles, jellyfish, mud). */
export function squelch(s: Synth, at: number, dur: number, level: number, from = 300, to = 1800): void {
  const g = s.gain(0);
  const f = s.filter("lowpass", from, 9, g);
  s.noise("pink", at, at + dur + 0.02, f);
  s.freq(f.frequency, [
    [at, from],
    [at + dur * 0.5, to, "exp"],
    [at + dur, from * 0.8, "exp"],
  ]);
  s.perc(g.gain, at, level, 0.01, dur);
}

/** One "glug": a falling sine through a resonant band (drinking, a filling gourd). */
export function glug(s: Synth, at: number, freq: number, level: number): void {
  const g = s.gain(0);
  const band = s.filter("bandpass", freq * 1.6, 3, g);
  const o = s.osc("sine", freq * 1.5, at, at + 0.14, band);
  s.freq(o.frequency, [
    [at, freq * 1.5],
    [at + 0.1, freq * 0.7, "exp"],
  ]);
  s.perc(g.gain, at, level * 2.2, 0.006, 0.11);
  noiseBurst(s, at, 0.05, level * 0.3, { type: "bandpass", from: freq * 3, to: freq * 1.5, q: 2, color: "pink" });
}
