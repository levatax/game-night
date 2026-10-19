// Gibberish chef voices: formant synthesis. A sawtooth + pulse-ish square "glottis" with a pitch contour and
// vibrato runs through 3 parallel bandpass formant filters whose centres glide between vowels. Each player
// (pitchSeed 0..5) gets their own base pitch, formant shift and wobble so every chef sounds uniquely silly.
// Also used for crowd "OOOOH", cheers, the devil cackle and *hic*.

import { Group, Kit, env, glide, rand, vary } from "./kit";

export type Vowel = "a" | "e" | "i" | "o" | "u" | "m" | "n";

/** Formant centres (Hz) and relative amplitudes, roughly adult values. */
const FORMANTS: Record<Vowel, { f: [number, number, number]; amp: [number, number, number] }> = {
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
  /** Unvoiced hiss after/along the segment ("sss"). */
  hiss?: number;
}

export interface Speaker {
  pitch: number;
  formant: number;
  vibRate: number;
  vibDepth: number;
  /** 0..1: how much square (nasal/buzzy) is mixed with the saw. */
  buzz: number;
}

/** Six distinct chef voices: squeaky, chipper, deep, nasal, helium, wobbly. */
const SPEAKERS: Speaker[] = [
  { pitch: 260, formant: 1.18, vibRate: 7, vibDepth: 0.03, buzz: 0.2 },
  { pitch: 190, formant: 1.08, vibRate: 5.5, vibDepth: 0.025, buzz: 0.35 },
  { pitch: 105, formant: 0.9, vibRate: 4.5, vibDepth: 0.04, buzz: 0.15 },
  { pitch: 165, formant: 1.02, vibRate: 6.5, vibDepth: 0.02, buzz: 0.75 },
  { pitch: 360, formant: 1.32, vibRate: 9, vibDepth: 0.035, buzz: 0.25 },
  { pitch: 135, formant: 0.96, vibRate: 11, vibDepth: 0.07, buzz: 0.4 },
];

export function speakerFor(seed: number): Speaker {
  const i = ((Math.floor(seed) % SPEAKERS.length) + SPEAKERS.length) % SPEAKERS.length;
  return SPEAKERS[Number.isFinite(i) ? i : 0];
}

/** Render a list of segments with one speaker, starting at t, into group g. Returns total duration. */
export function speak(g: Group, t: number, sp: Speaker, segs: Seg[], pitchMul = 1, dest: AudioNode = g.out): number {
  const total = segs.reduce((s, x) => s + x.d, 0);
  const t1 = t + total + 0.05;
  const base = sp.pitch * pitchMul;

  // Glottal source: saw + square (buzz), summed, then enveloped as "voiced".
  const voiced = g.vca(null);
  const saw = g.osc("sawtooth", base, t, t1, voiced);
  const sqGain = g.gain(sp.buzz * 0.6, voiced);
  const sq = g.osc("square", base * 1.003, t, t1, sqGain);
  for (const o of [saw, sq]) g.lfo("sine", sp.vibRate * vary(0.1), base * sp.vibDepth, o.frequency, t, t1);

  // Breath noise through the same formants.
  const breathSrcGain = g.vca(null);
  g.noise("white", t, t1, breathSrcGain);

  // Formant bank.
  const bank: Array<{ bp: BiquadFilterNode; amp: GainNode }> = [];
  for (let k = 0; k < 3; k++) {
    const amp = g.gain(0, dest);
    const bp = g.filter("bandpass", 500, 8, amp);
    voiced.connect(bp);
    breathSrcGain.connect(bp);
    bank.push({ bp, amp });
  }
  // A touch of dry low-passed source keeps the fundamental present (formant BPs are thin).
  const body = g.filter("lowpass", 900, 0.7, dest);
  const bodyGain = g.gain(0.12, body);
  voiced.connect(bodyGain);

  // Hiss path for "sss".
  const hissGain = g.vca(dest);
  const hissHp = g.filter("highpass", 4500, 0.9, hissGain);
  g.noise("white", t, t1, hissHp);

  let tt = t;
  voiced.gain.setValueAtTime(0.0001, t);
  breathSrcGain.gain.setValueAtTime(0.0001, t);
  hissGain.gain.setValueAtTime(0.0001, t);
  for (const s of segs) {
    const F = FORMANTS[s.v];
    const glideT = Math.min(0.06, s.d * 0.4);
    for (let k = 0; k < 3; k++) {
      const f = F.f[k] * sp.formant;
      if (tt === t) {
        bank[k].bp.frequency.setValueAtTime(f, t);
        bank[k].amp.gain.setValueAtTime(F.amp[k] * 3.2, t);
      }
      bank[k].bp.frequency.linearRampToValueAtTime(f, tt + glideT);
      bank[k].bp.Q.setValueAtTime(f / (60 + k * 40), tt);
      // Bandpass loses energy, so formant gains are boosted.
      bank[k].amp.gain.linearRampToValueAtTime(F.amp[k] * 3.2, tt + glideT);
    }
    for (const o of [saw, sq]) {
      o.frequency.setValueAtTime(Math.max(30, base * s.p0), tt);
      o.frequency.exponentialRampToValueAtTime(Math.max(30, base * s.p1), tt + s.d);
    }
    const a = s.amp ?? 1;
    voiced.gain.linearRampToValueAtTime(a * 0.5, tt + Math.min(0.03, s.d * 0.3));
    voiced.gain.setValueAtTime(a * 0.5, tt + s.d * 0.75);
    voiced.gain.linearRampToValueAtTime(a * 0.25, tt + s.d);
    const br = s.breath ?? 0;
    breathSrcGain.gain.linearRampToValueAtTime(br * 0.5, tt + 0.02);
    breathSrcGain.gain.linearRampToValueAtTime(br * 0.2, tt + s.d);
    const hs = s.hiss ?? 0;
    hissGain.gain.linearRampToValueAtTime(hs * 0.35, tt + s.d * 0.3);
    hissGain.gain.linearRampToValueAtTime(hs * 0.2, tt + s.d * 0.9);
    hissGain.gain.linearRampToValueAtTime(0.0001, tt + s.d);
    tt += s.d;
  }
  voiced.gain.linearRampToValueAtTime(0.0001, tt + 0.04);
  breathSrcGain.gain.linearRampToValueAtTime(0.0001, tt + 0.04);
  return total;
}

/** The chef vocabulary. Each returns segments for speak(). */
export const WORDS: Record<"ooh" | "noo" | "yes" | "haha" | "gasp" | "hmm", () => Seg[]> = {
  ooh: () => [
    { v: "u", d: 0.12, p0: 0.95, p1: 1.35 },
    { v: "o", d: 0.38, p0: 1.35, p1: 1.05 },
  ],
  noo: () => [
    { v: "n", d: 0.07, p0: 1.3, p1: 1.35, amp: 0.7 },
    { v: "o", d: 0.12, p0: 1.4, p1: 1.25 },
    { v: "u", d: 0.45, p0: 1.25, p1: 0.62 },
  ],
  yes: () => [
    { v: "i", d: 0.08, p0: 1.0, p1: 1.1 },
    { v: "e", d: 0.2, p0: 1.1, p1: 1.55 },
    { v: "e", d: 0.32, p0: 1.55, p1: 1.4, amp: 0.05, hiss: 1 },
  ],
  haha: () => {
    const out: Seg[] = [];
    const n = 3 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const p = 1.45 - i * 0.12;
      out.push({ v: "a", d: 0.035, p0: p, p1: p, amp: 0.05, breath: 0.9 });
      out.push({ v: "a", d: 0.1, p0: p * 1.05, p1: p * 0.92 });
      out.push({ v: "a", d: 0.04, p0: p, p1: p, amp: 0.02 });
    }
    return out;
  },
  gasp: () => [
    { v: "a", d: 0.06, p0: 1.8, p1: 2.1, amp: 0.15, breath: 1 },
    { v: "o", d: 0.22, p0: 2.1, p1: 2.5, amp: 0.25, breath: 0.8 },
  ],
  hmm: () => [
    { v: "m", d: 0.18, p0: 1.0, p1: 0.88, amp: 0.9 },
    { v: "m", d: 0.18, p0: 0.88, p1: 0.92, amp: 0.8 },
    { v: "m", d: 0.24, p0: 0.95, p1: 1.18, amp: 0.85 },
  ],
};

/** One chef word for a player. */
export function chefVoice(k: Kit, kind: keyof typeof WORDS, seed: number, vol: number): void {
  const segs = WORDS[kind]();
  const dur = segs.reduce((s, x) => s + x.d, 0);
  const t = k.now + 0.005;
  const g = k.group(t, dur + 0.2, vol * 0.55);
  if (!g) return;
  speak(g, t, speakerFor(seed), segs, vary(0.05));
}

/** Crowd "OOOOOH": a handful of detuned, staggered voices swooping up and down. */
export function crowdOoh(k: Kit, t: number, vol: number): void {
  const g = k.group(t, 1.8, vol * 0.32);
  if (!g) return;
  for (let i = 0; i < 6; i++) {
    const sp = { ...speakerFor(i), vibRate: rand(4, 7), vibDepth: 0.02 };
    const dt = rand(0, 0.12);
    speak(g, t + dt, sp, [
      { v: "u", d: 0.25, p0: 0.9, p1: 1.25 * vary(0.04) },
      { v: "o", d: 0.55, p0: 1.25, p1: 1.4 * vary(0.04) },
      { v: "o", d: 0.55, p0: 1.4, p1: 0.85, amp: 0.7 },
    ], vary(0.03));
  }
  // Murmur bed underneath.
  const bed = g.vca();
  const bp = g.filter("bandpass", 600, 1.2, bed);
  g.noise("pink", t, t + 1.5, bp);
  env(bed.gain, t, 0.3, 0.25, 1.0, 0.1);
}

/** Cheering crowd: a bunch of "yaaay"s, whistles and clap noise. */
export function crowdCheer(k: Kit, t: number, vol: number): void {
  const g = k.group(t, 2.2, vol * 0.3);
  if (!g) return;
  for (let i = 0; i < 6; i++) {
    const sp = { ...speakerFor(i), vibDepth: 0.04 };
    const dt = rand(0, 0.25);
    speak(g, t + dt, sp, [
      { v: "e", d: 0.08, p0: 1.1, p1: 1.4, amp: 0.8 },
      { v: "a", d: 0.5 + rand(0, 0.4), p0: 1.5, p1: 1.25 * vary(0.1) },
      { v: "i", d: 0.15, p0: 1.25, p1: 1.0, amp: 0.6 },
    ], vary(0.04));
  }
  // A cartoon wolf-whistle.
  const wv = g.vca();
  const w = g.osc("sine", 1400, t + 0.3, t + 1.1, wv);
  glide(w.frequency, t + 0.3, [[0, 1200], [0.18, 2600], [0.35, 1500], [0.55, 2900], [0.75, 1700]]);
  env(wv.gain, t + 0.3, 0.03, 0.18, 0.35, 0.35);
  // Claps: lots of tiny highpassed noise bursts.
  const clapHp = g.filter("bandpass", 1500, 0.8);
  for (let i = 0; i < 26; i++) {
    const ct = t + rand(0, 1.7);
    const c = g.vca(clapHp);
    g.noise("white", ct, ct + 0.05, c);
    env(c.gain, ct, 0.002, rand(0.25, 0.55), 0.035);
  }
}

/** Devil cackle: low, ring-modulated "mwa-ha-ha-haaa" descending. */
export function devilCackle(k: Kit, t: number, vol: number): void {
  const g = k.group(t, 1.8, vol * 0.5);
  if (!g) return;
  const sp: Speaker = { pitch: 95, formant: 0.85, vibRate: 6, vibDepth: 0.05, buzz: 0.6 };
  const segs: Seg[] = [
    { v: "m", d: 0.12, p0: 1.0, p1: 1.1 },
    { v: "a", d: 0.22, p0: 1.15, p1: 1.4 },
  ];
  for (let i = 0; i < 4; i++) {
    const p = 1.5 - i * 0.1;
    segs.push({ v: "a", d: 0.04, p0: p, p1: p, amp: 0.05, breath: 0.9 });
    segs.push({ v: "a", d: i === 3 ? 0.4 : 0.12, p0: p, p1: i === 3 ? p * 0.7 : p * 0.95 });
  }
  speak(g, t, sp, segs);
  // A second, octave-down layer through a ring modulator for that evil warble.
  const ring = g.gain(0);
  g.lfo("sine", 37, 0.8, ring.gain, t, t + 1.6);
  speak(g, t, { ...sp, pitch: sp.pitch * 0.5 }, segs, 1, ring);
}

/** "*hic*": a pinched little voiced squeak with a glottal click. */
export function hiccup(k: Kit, t: number, vol: number, seed = Math.floor(rand(0, 6))): void {
  const g = k.group(t, 0.35, vol * 0.6);
  if (!g) return;
  const sp = speakerFor(seed);
  speak(g, t + 0.01, sp, [
    { v: "i", d: 0.03, p0: 1.4, p1: 2.4, breath: 0.6, amp: 0.6 },
    { v: "i", d: 0.08, p0: 2.4, p1: 2.0 },
  ]);
  const c = g.vca();
  g.noise("white", t, t + 0.02, g.filter("bandpass", 2500, 2, c));
  env(c.gain, t, 0.001, 0.6, 0.015);
}
