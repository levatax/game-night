// Gangster mumbles and crowd noises by formant synthesis. A sawtooth + square "glottis" (plus a little noise
// rasp for the cigar-voiced ones) with a pitch contour and vibrato runs through 3 parallel bandpass formant
// filters whose centres glide between vowels. Six speakers (one per animal) so repeats vary.
// Words: "ooo!", "yok artık!", "hah!", the laugh, the crowd boo, crying + nose honk, "mwah", the muffled
// "mmph!" under a sack, and the heavenly "aaah" choir for rare cards.

import { Group, Kit, blip, env, noiseHit, pick, rand, vary } from "./kit";

export type Vowel = "a" | "e" | "i" | "o" | "u" | "I" | "m" | "n";

/** Formant centres (Hz) and relative amplitudes. "I" is Turkish ı. */
const FORMANTS: Record<Vowel, { f: [number, number, number]; amp: [number, number, number] }> = {
  a: { f: [800, 1200, 2700], amp: [1, 0.55, 0.25] },
  e: { f: [450, 1900, 2600], amp: [1, 0.45, 0.3] },
  i: { f: [300, 2300, 3000], amp: [1, 0.35, 0.25] },
  o: { f: [480, 820, 2600], amp: [1, 0.6, 0.15] },
  u: { f: [330, 700, 2450], amp: [1, 0.35, 0.1] },
  I: { f: [360, 1450, 2500], amp: [1, 0.45, 0.2] },
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
  /** Breath noise through the formants 0..1 ("h", gasps, sobs). */
  breath?: number;
  /** Unvoiced hiss along the segment ("sss"). */
  hiss?: number;
  /** Plosive burst at the start of the segment ("k", "t", "p") 0..1. */
  click?: number;
}

export interface Speaker {
  pitch: number;
  formant: number;
  vibRate: number;
  vibDepth: number;
  /** 0..1: how much square (nasal/buzzy) is mixed with the saw. */
  buzz: number;
  /** 0..1: cigar rasp (noise in the glottal source). */
  rasp: number;
}

/** Kedi, Köpek, Domuz, Fare, Kurbağa, Tavşan — all mafiosi. */
const SPEAKERS: Speaker[] = [
  { pitch: 175, formant: 1.1, vibRate: 6, vibDepth: 0.03, buzz: 0.3, rasp: 0.12 },
  { pitch: 108, formant: 0.92, vibRate: 5, vibDepth: 0.03, buzz: 0.45, rasp: 0.28 },
  { pitch: 128, formant: 0.95, vibRate: 7, vibDepth: 0.05, buzz: 0.75, rasp: 0.3 },
  { pitch: 290, formant: 1.3, vibRate: 9, vibDepth: 0.04, buzz: 0.25, rasp: 0.05 },
  { pitch: 92, formant: 0.86, vibRate: 12, vibDepth: 0.08, buzz: 0.6, rasp: 0.42 },
  { pitch: 225, formant: 1.2, vibRate: 7, vibDepth: 0.03, buzz: 0.2, rasp: 0.1 },
];

export function speakerFor(seed: number): Speaker {
  const n = SPEAKERS.length;
  const i = Number.isFinite(seed) ? ((Math.floor(seed) % n) + n) % n : 0;
  return SPEAKERS[i];
}

const randomSpeaker = (): Speaker => pick(SPEAKERS);

/** Render segments with one speaker starting at t into group g. Returns the total duration. */
export function speak(g: Group, t: number, sp: Speaker, segs: Seg[], pitchMul = 1, dest: AudioNode = g.out): number {
  const total = segs.reduce((s, x) => s + x.d, 0);
  const t1 = t + total + 0.06;
  const base = sp.pitch * pitchMul;

  // Glottal source: saw + square (buzz), then enveloped as "voiced".
  const voiced = g.vca(null);
  const saw = g.osc("sawtooth", base, t, t1, voiced);
  const sq = g.osc("square", base * 1.003, t, t1, g.gain(sp.buzz * 0.6, voiced));
  for (const o of [saw, sq]) g.lfo("sine", sp.vibRate * vary(0.1), base * sp.vibDepth, o.frequency, t, t1);
  if (sp.rasp > 0) {
    // Rasp: noise riding on the voiced envelope.
    const r = g.gain(sp.rasp * 0.5, voiced);
    g.noise("white", t, t1, g.filter("lowpass", 2400, 0.7, r));
  }

  // Breath noise through the same formants.
  const breath = g.vca(null);
  g.noise("white", t, t1, breath);

  const bank: Array<{ bp: BiquadFilterNode; amp: GainNode }> = [];
  for (let k = 0; k < 3; k++) {
    const amp = g.gain(0, dest);
    const bp = g.filter("bandpass", 500, 8, amp);
    voiced.connect(bp);
    breath.connect(bp);
    bank.push({ bp, amp });
  }
  // A touch of dry lowpassed source keeps the fundamental present (formant BPs are thin).
  voiced.connect(g.gain(0.12, g.filter("lowpass", 900, 0.7, dest)));

  const hissGain = g.vca(dest);
  g.noise("white", t, t1, g.filter("highpass", 4500, 0.9, hissGain));
  const clickBus = g.filter("bandpass", 3000, 1.2, dest);

  let tt = t;
  voiced.gain.setValueAtTime(0.0001, t);
  breath.gain.setValueAtTime(0.0001, t);
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
      bank[k].amp.gain.linearRampToValueAtTime(F.amp[k] * 3.2, tt + glideT);
    }
    for (const o of [saw, sq]) {
      o.frequency.setValueAtTime(Math.max(30, base * s.p0), tt);
      o.frequency.exponentialRampToValueAtTime(Math.max(30, base * s.p1), tt + s.d);
    }
    const a = s.amp ?? 1;
    voiced.gain.linearRampToValueAtTime(a * 0.5, tt + Math.min(0.03, s.d * 0.3));
    voiced.gain.setValueAtTime(a * 0.5, tt + s.d * 0.75);
    voiced.gain.linearRampToValueAtTime(a * 0.25 + 0.0001, tt + s.d);
    const br = s.breath ?? 0;
    breath.gain.linearRampToValueAtTime(br * 0.5 + 0.0001, tt + Math.min(0.02, s.d * 0.5));
    breath.gain.linearRampToValueAtTime(br * 0.2 + 0.0001, tt + s.d);
    const hs = s.hiss ?? 0;
    hissGain.gain.linearRampToValueAtTime(hs * 0.35 + 0.0001, tt + s.d * 0.3);
    hissGain.gain.linearRampToValueAtTime(hs * 0.2 + 0.0001, tt + s.d * 0.9);
    hissGain.gain.linearRampToValueAtTime(0.0001, tt + s.d);
    if (s.click) {
      const c = g.vca(clickBus);
      g.noise("white", tt, tt + 0.04, c);
      env(c.gain, tt, 0.001, s.click * 0.9, 0.025);
    }
    tt += s.d;
  }
  voiced.gain.linearRampToValueAtTime(0.0001, tt + 0.04);
  breath.gain.linearRampToValueAtTime(0.0001, tt + 0.04);
  return total;
}

const dur = (segs: Seg[]): number => segs.reduce((s, x) => s + x.d, 0);

// ---- single-character words ---------------------------------------------------------------------------

/** "Ooo!" — impressed, rising then sagging. */
export function ooh(k: Kit, t: number, vol: number, p: number): void {
  const segs: Seg[] = [
    { v: "u", d: 0.1, p0: 0.92, p1: 1.35 },
    { v: "o", d: 0.22, p0: 1.35, p1: 1.42 },
    { v: "o", d: 0.3, p0: 1.42, p1: 1.0, amp: 0.85 },
  ];
  const g = k.group(t, dur(segs) + 0.2, vol * 0.6);
  if (g) speak(g, t, randomSpeaker(), segs, p);
}

/** "Yok artık!" — incredulous: a high "YOK", a stop, then a long falling "artıııık". */
export function yokArtik(k: Kit, t: number, vol: number, p: number): void {
  const segs: Seg[] = [
    { v: "i", d: 0.05, p0: 1.3, p1: 1.4, amp: 0.7 },
    { v: "o", d: 0.15, p0: 1.45, p1: 1.62 },
    { v: "o", d: 0.05, p0: 1.6, p1: 1.6, amp: 0.02, click: 0.7 },
    { v: "a", d: 0.13, p0: 1.3, p1: 1.25 },
    { v: "e", d: 0.035, p0: 1.22, p1: 1.2, amp: 0.3 },
    { v: "I", d: 0.03, p0: 1.2, p1: 1.2, amp: 0.02, click: 0.8 },
    { v: "I", d: 0.32, p0: 1.28, p1: 0.82 },
    { v: "I", d: 0.04, p0: 0.8, p1: 0.8, amp: 0.02, click: 0.55 },
  ];
  const g = k.group(t, dur(segs) + 0.2, vol * 0.62);
  if (g) speak(g, t, randomSpeaker(), segs, p);
}

/** "Hah!" — one smug bark of a laugh. */
export function hah(k: Kit, t: number, vol: number, p: number): void {
  const segs: Seg[] = [
    { v: "a", d: 0.05, p0: 1.3, p1: 1.3, amp: 0.05, breath: 1 },
    { v: "a", d: 0.17, p0: 1.35, p1: 0.92 },
    { v: "a", d: 0.12, p0: 0.9, p1: 0.85, amp: 0.03, breath: 0.6 },
  ];
  const g = k.group(t, dur(segs) + 0.2, vol * 1.0);
  if (g) speak(g, t, randomSpeaker(), segs, p);
}

/** A hearty mob laugh "ha-ha-ha-haaa" from two goons, one a beat late. */
export function laugh(k: Kit, t: number, vol: number, p: number): void {
  const g = k.group(t, 1.6, vol * 0.5);
  if (!g) return;
  const a = randomSpeaker();
  let b = randomSpeaker();
  if (b === a) b = speakerFor(SPEAKERS.indexOf(a) + 2);
  const make = (n: number, start: number): Seg[] => {
    const out: Seg[] = [];
    for (let i = 0; i < n; i++) {
      const q = start - i * 0.07;
      out.push({ v: "a", d: 0.04, p0: q, p1: q, amp: 0.05, breath: 0.9 });
      out.push({ v: i === n - 1 ? "o" : "a", d: i === n - 1 ? 0.3 : 0.1, p0: q * 1.05, p1: i === n - 1 ? q * 0.75 : q * 0.93 });
      out.push({ v: "a", d: 0.04, p0: q, p1: q, amp: 0.02 });
    }
    return out;
  };
  speak(g, t, a, make(4 + Math.floor(Math.random() * 2), 1.4), p);
  speak(g, t + rand(0.12, 0.22), b, make(3, 1.25), p * 1.02, g.gain(0.6));
}

/** Crowd boo: a few low "buuuu"s sagging down plus a grumbling murmur bed. */
export function boo(k: Kit, t: number, vol: number, p: number): void {
  const g = k.group(t, 1.6, vol * 0.36);
  if (!g) return;
  for (let i = 0; i < 4; i++) {
    const sp = { ...speakerFor(i * 2 + 1), vibRate: rand(4, 6), vibDepth: 0.025 };
    const dt = rand(0, 0.14);
    speak(g, t + dt, sp, [
      { v: "u", d: 0.04, p0: 1.0, p1: 1.0, amp: 0.1, click: 0.4 },
      { v: "u", d: 0.5 + rand(0, 0.25), p0: 1.05, p1: 0.92 * vary(0.04) },
      { v: "u", d: 0.35, p0: 0.92, p1: 0.7, amp: 0.7 },
    ], p * vary(0.03));
  }
  const bed = g.vca();
  g.noise("pink", t, t + 1.3, g.filter("bandpass", 420, 1.4, bed));
  env(bed.gain, t, 0.2, 0.3, 0.8, 0.2);
}

/** "Waaah-hu-hu-huuu" then a big nose honk into the handkerchief. */
export function cry(k: Kit, t: number, vol: number, p: number): void {
  const g = k.group(t, 2.4, vol * 0.55);
  if (!g) return;
  const sp: Speaker = { ...randomSpeaker(), vibRate: 7.5, vibDepth: 0.07 };
  const segs: Seg[] = [
    { v: "u", d: 0.08, p0: 1.3, p1: 1.6 },
    { v: "a", d: 0.55, p0: 1.65, p1: 1.35 },
  ];
  for (let i = 0; i < 3; i++) {
    const q = 1.45 - i * 0.1;
    segs.push({ v: "u", d: 0.05, p0: q, p1: q, amp: 0.05, breath: 1 });
    segs.push({ v: "u", d: i === 2 ? 0.4 : 0.12, p0: q * 1.05, p1: i === 2 ? q * 0.7 : q * 0.9 });
  }
  const talk = speak(g, t, sp, segs, p);
  // Nose honk: buzzy saw through a nasal resonance, pitch wobbling.
  const th = t + talk + 0.12;
  const v = g.vca();
  const nasal = g.filter("bandpass", 950, 4, v);
  const o = g.osc("sawtooth", 210 * p, th, th + 0.5, g.shaper(nasal));
  o.frequency.setValueAtTime(230 * p, th);
  o.frequency.linearRampToValueAtTime(190 * p, th + 0.4);
  g.lfo("square", 22, 18, o.frequency, th, th + 0.5);
  env(v.gain, th, 0.02, 0.55, 0.12, 0.3);
  noiseHit(g, "pink", th, "bandpass", 1300, 2, 0.25, 0.4, 0.02);
}

/** "Mwah!" with a lip-smack pop. */
export function kiss(k: Kit, t: number, vol: number, p: number): void {
  const g = k.group(t, 0.8, vol * 0.55);
  if (!g) return;
  const sp = randomSpeaker();
  speak(g, t, sp, [
    { v: "m", d: 0.1, p0: 1.15, p1: 1.25, amp: 0.8 },
    { v: "u", d: 0.04, p0: 1.3, p1: 1.4, amp: 0.4 },
    { v: "a", d: 0.18, p0: 1.45, p1: 1.05 },
    { v: "a", d: 0.06, p0: 1.0, p1: 1.0, amp: 0.02, breath: 0.4 },
  ], p);
  // Smack: a wet click with a quick downward pop.
  const ts = t + 0.1;
  noiseHit(g, "white", ts, "bandpass", 2600, 1.5, 0.7, 0.02, 0.0008);
  blip(g, "sine", ts, [[0, 1500 * p], [0.04, 380 * p]], 0.45, 0.05, 0.001);
  // A sparkly little "ting" as the kiss flies off.
  blip(g, "sine", t + 0.42, [[0, 2640 * p], [0.25, 2700 * p]], 0.12, 0.3, 0.004);
}

/** Muffled "mmph! mm-mmh!" from under a sack. */
export function mmph(g: Group, t: number, p: number): void {
  const muffle = g.filter("lowpass", 520, 1.2);
  speak(g, t, randomSpeaker(), [
    { v: "m", d: 0.16, p0: 1.3, p1: 1.55 },
    { v: "m", d: 0.05, p0: 1.5, p1: 1.5, amp: 0.05, breath: 0.5 },
    { v: "m", d: 0.1, p0: 1.4, p1: 1.5 },
    { v: "m", d: 0.18, p0: 1.55, p1: 1.2 },
  ], p, muffle);
}

/** Heavenly "aaaah": a little choir on a bright major chord (rare+ card glow). */
export function choir(k: Kit, t: number, vol: number, p: number, len = 1.5): void {
  const g = k.group(t, len + 0.5, vol * 0.22);
  if (!g) return;
  g.send(0.5);
  // F major add9 over the minor-key music: a Picardy-third "hallelujah".
  const chord = [174.6, 220, 261.6, 349.2, 392, 440];
  chord.forEach((f, i) => {
    const sp: Speaker = { pitch: f, formant: i < 2 ? 0.95 : 1.15, vibRate: rand(4.5, 6), vibDepth: 0.012, buzz: 0.1, rasp: 0 };
    const dt = rand(0, 0.05);
    const out = g.vca();
    speak(g, t + dt, sp, [
      { v: "a", d: len * 0.55, p0: 1, p1: 1 },
      { v: "o", d: len * 0.35, p0: 1, p1: 1.0, amp: 0.8 },
    ], p, out);
    out.gain.setValueAtTime(0.0001, t);
    out.gain.linearRampToValueAtTime(1, t + 0.18);
    out.gain.setValueAtTime(1, t + len * 0.7);
    out.gain.linearRampToValueAtTime(0.0001, t + len + 0.05);
  });
}
