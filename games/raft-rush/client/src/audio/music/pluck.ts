// Karplus-Strong plucked strings (the ukulele). Computed in JS into cached AudioBuffers: a DelayNode feedback
// loop can't go below one 128-sample render quantum, which caps a live KS loop at ~340 Hz, and the ukulele lives
// at 260–880 Hz. Owner: client-fx-audio. Copied from games/bonk-brawl/client/src/audio/music/pluck.ts.

import { midiToFreq } from "../synth/dsp";

export interface Pluck {
  buffer: AudioBuffer;
  /** Playback rate that corrects the integer loop length to the exact pitch. */
  rate: number;
}

const PLUCK_SECONDS = 1.4;
/** Time for the fundamental to decay 60 dB: short and woody, like nylon on a small body. */
const T60 = 1.1;
/** Where along the string it is plucked (fraction of its length): shapes the harmonic mix. */
const PLUCK_POSITION = 0.15;
/** One-pole smoothing of the excitation noise: lower = softer fingertip pluck. */
const EXCITATION_SOFTNESS = 0.5;
/** Noise on top of the triangular pluck shape (attack "chiff"). */
const NOISE_AMOUNT = 0.35;
const PEAK = 0.7;

const cache = new WeakMap<BaseAudioContext, Map<number, Pluck>>();

export function getPluck(ctx: BaseAudioContext, midi: number): Pluck {
  let byNote = cache.get(ctx);
  if (!byNote) {
    byNote = new Map();
    cache.set(ctx, byNote);
  }
  const hit = byNote.get(midi);
  if (hit) return hit;
  const { data, rate } = renderPluck(ctx.sampleRate, midiToFreq(midi));
  const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buffer.copyToChannel(data, 0);
  const pluck = { buffer, rate };
  byNote.set(midi, pluck);
  return pluck;
}

/** Classic KS: y[n] = g · ½(y[n−N] + y[n−N−1]); loop delay N + ½ samples. */
function renderPluck(sampleRate: number, freq: number): { data: Float32Array<ArrayBuffer>; rate: number } {
  const n = Math.max(2, Math.floor(sampleRate / freq - 0.5));
  const loopFreq = sampleRate / (n + 0.5);
  const ring = excitation(n);
  const g = Math.pow(0.001, 1 / (T60 * loopFreq));
  const out = new Float32Array(Math.floor(sampleRate * PLUCK_SECONDS));
  let idx = 0;
  let prev = 0;
  for (let i = 0; i < out.length; i++) {
    const a = ring[idx]!;
    out[i] = a;
    ring[idx] = g * 0.5 * (a + prev);
    prev = a;
    idx = idx + 1 === n ? 0 : idx + 1;
  }
  shapeEdges(out, sampleRate);
  normalize(out, PEAK);
  return { data: out, rate: freq / loopFreq };
}

/**
 * Initial string shape: a triangle peaked at the pluck point (harmonics fall off as 1/k², so the
 * fundamental always leads, consistently from note to note) plus a little softened noise for the
 * fingertip's attack. Pure-noise excitation would give every note a random harmonic balance.
 */
function excitation(n: number): Float32Array {
  const ring = new Float32Array(n);
  const p = PLUCK_POSITION;
  let lp = 0;
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const shape = x < p ? x / p : (1 - x) / (1 - p);
    lp += EXCITATION_SOFTNESS * (Math.random() * 2 - 1 - lp);
    ring[i] = shape + NOISE_AMOUNT * lp;
    mean += ring[i];
  }
  mean /= n;
  for (let i = 0; i < n; i++) ring[i] -= mean;
  return ring;
}

/** 1 ms fade-in (no click) and a 40 ms fade-out at the buffer end. */
function shapeEdges(data: Float32Array, sampleRate: number): void {
  const fadeIn = Math.min(data.length, Math.floor(sampleRate * 0.001));
  for (let i = 0; i < fadeIn; i++) data[i] *= i / fadeIn;
  const fadeOut = Math.min(data.length, Math.floor(sampleRate * 0.04));
  for (let i = 0; i < fadeOut; i++) data[data.length - 1 - i] *= i / fadeOut;
}

function normalize(data: Float32Array, target: number): void {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak <= 0) return;
  const k = target / peak;
  for (let i = 0; i < data.length; i++) data[i] *= k;
}
