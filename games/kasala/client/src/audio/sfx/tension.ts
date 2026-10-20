// Turn-tension cues (§14, §20): the step that climbs with every safe card ("BOOM", "ta-BOOM", "ta-ta-BOOM" …
// a pitched drum, a string stab and a riser, one rung higher per card), the relief "fyuuu" after surviving a
// risky card, and the table's heckles: a few gangsters shouting "ÇEVİR!" / "KASALA!" by formant synthesis
// (no speech engine), with fists on the felt.

import { Group, Kit, blip, clamp01, env, glide, mtof, noiseHit, rand, strike, vary } from "./kit";
import { type Seg, speak, speakerFor } from "./voices";

/** Semitones above F for safe cards 1, 2, 3 …: up the F-minor scale, squeezing chromatically at the top. */
const LADDER = [0, 2, 3, 5, 7, 8, 10, 11, 12, 13];

/** Vibraphone-ish bar: fundamental plus a quiet, quick 4th partial. */
const VIBE: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1, 1],
  [4, 0.18, 0.25],
];

/**
 * One safe card: snare pickup strokes (one more per card, up to four), a pitched floor-tom hit on the
 * ladder, a pizzicato stab an octave and a fifth up, and from card 2 an airy riser that climbs after the hit.
 * Pitch, brightness, length and level all step up with `flips` (1 = first card of the turn).
 */
export function tensionStep(k: Kit, t: number, vol: number, flips: number): void {
  const n = Math.max(1, Math.min(LADDER.length, Math.round(flips)));
  const x = (n - 1) / (LADDER.length - 1);
  const semis = LADDER[n - 1];
  const g = k.group(t, 1.5, vol * (0.42 + 0.34 * x));
  if (!g) return;
  g.send(0.12 + 0.22 * x);

  // Pickup: "ta-ta-" on a tight snare, a little faster and louder the deeper the turn.
  const graces = Math.min(4, n - 1);
  const gap = 0.055 - 0.005 * graces;
  for (let i = 0; i < graces; i++) {
    const st = t + i * gap;
    noiseHit(g, "white", st, "bandpass", 2300, 0.9, 0.16 + 0.05 * i, 0.05, 0.001);
    blip(g, "triangle", st, [[0, 210], [0.04, 165]], 0.08 + 0.02 * i, 0.04, 0.001);
  }
  const th = t + graces * gap;

  // The hit: floor tom / timpani on the ladder (F2 up), with a felt thud under it.
  const f = mtof(41 + semis);
  blip(g, "sine", th, [[0, f * 1.6], [0.07, f]], 0.9, 0.45 + 0.3 * x, 0.002);
  blip(g, "triangle", th, [[0, f * 2.02], [0.1, f * 2]], 0.2, 0.22, 0.002, g.filter("lowpass", 650, 0.7));
  noiseHit(g, "brown", th, "lowpass", 380, 1, 0.45, 0.1, 0.002);

  // Pizzicato stab (F3 + C4 on the ladder): brighter as it climbs.
  const lp = g.filter("lowpass", 1300 + 2800 * x, 1.4);
  blip(g, "sawtooth", th, [[0, mtof(53 + semis)]], 0.3, 0.15 + 0.12 * x, 0.004, lp);
  blip(g, "sawtooth", th + 0.004, [[0, mtof(60 + semis)]], 0.18, 0.12 + 0.1 * x, 0.004, lp);

  if (n < 2) return;
  // Riser: a breathy swell that climbs after the hit and stops short — the next card is the payoff.
  const len = 0.3 + 0.06 * Math.min(6, n);
  const rv = g.vca();
  const bp = g.filter("bandpass", 600, 2.4, rv);
  g.noise("pink", th, th + len + 0.05, bp);
  glide(bp.frequency, th, [[0, 450 + 90 * semis], [len, 2200 + 260 * semis]]);
  rv.gain.setValueAtTime(0.0001, th);
  rv.gain.linearRampToValueAtTime(0.12 + 0.3 * x, th + len * 0.85);
  rv.gain.linearRampToValueAtTime(0.0001, th + len);
  if (n >= 4) {
    // Strings leaning in: a thin tremolo glissando on top.
    const sv = g.vca();
    const trem = g.gain(0.7, sv);
    g.lfo("sine", 9 + n, 0.3, trem.gain, th, th + len);
    const o = g.osc("sawtooth", mtof(65 + semis), th, th + len + 0.02, g.filter("lowpass", 2600, 0.8, trem));
    glide(o.frequency, th, [[0, mtof(65 + semis)], [len, mtof(70 + semis)]]);
    sv.gain.setValueAtTime(0.0001, th);
    sv.gain.linearRampToValueAtTime(0.05 + 0.08 * x, th + len * 0.8);
    sv.gain.linearRampToValueAtTime(0.0001, th + len);
  }
}

/**
 * Relief after surviving a risky card: one or two gangsters exhaling "fyuuu" and a warm F-major-add9 vibes
 * roll (a Picardy third over the F-minor tension). `relief` 0..1 = how scary the card was.
 */
export function phew(k: Kit, t: number, vol: number, relief: number): void {
  const r = clamp01(relief);
  const g = k.group(t, 1.7, vol * (0.5 + 0.35 * r));
  if (!g) return;
  g.send(0.3);
  const voices = r >= 0.4 ? 2 : 1;
  const first = Math.floor(Math.random() * 6);
  for (let i = 0; i < voices; i++) {
    const segs: Seg[] = [
      { v: "u", d: 0.08, p0: 1.0, p1: 1.0, amp: 0.02, hiss: 0.7, breath: 0.25 },
      { v: "i", d: 0.05, p0: 1.12, p1: 1.18, amp: 0.22, breath: 0.6 },
      { v: "u", d: 0.34 + 0.08 * r, p0: 1.18, p1: 0.76, amp: 0.28, breath: 0.9 },
      { v: "u", d: 0.12, p0: 0.76, p1: 0.7, amp: 0.03, breath: 0.4 },
    ];
    speak(g, t + i * rand(0.06, 0.13), speakerFor(first + i * 3), segs, vary(0.04), g.gain(i === 0 ? 1 : 0.55));
  }
  // F4 A4 C5 G5, rolled upwards.
  [65, 69, 72, 79].forEach((m, i) => strike(g, t + 0.1 + i * 0.065, mtof(m + 12), VIBE, 0.16 + 0.06 * r, 0.8 + 0.15 * i));
}

// ---- heckles --------------------------------------------------------------------------------------------

export type HeckleKind = "flip" | "cash";

/** "ÇEVİR!": a "ç" burst, a short "e", a buzzy "v" and a long, stressed "İİR" that cracks at the top. */
const CEVIR: Seg[] = [
  { v: "e", d: 0.06, p0: 1.45, p1: 1.45, amp: 0.03, click: 0.55, hiss: 1 },
  { v: "e", d: 0.1, p0: 1.45, p1: 1.55 },
  { v: "u", d: 0.045, p0: 1.55, p1: 1.6, amp: 0.3, hiss: 0.25 },
  { v: "i", d: 0.22, p0: 1.78, p1: 1.6 },
  { v: "I", d: 0.035, p0: 1.55, p1: 1.5, amp: 0.12, click: 0.3 },
  { v: "I", d: 0.08, p0: 1.45, p1: 1.15, amp: 0.35, breath: 0.5 },
];

/** "KASALA!": "ka-sa-LAA!", stress on the last syllable, falling away at the end. */
const KASALA: Seg[] = [
  { v: "a", d: 0.035, p0: 1.3, p1: 1.3, amp: 0.02, click: 0.85 },
  { v: "a", d: 0.09, p0: 1.35, p1: 1.42 },
  { v: "a", d: 0.065, p0: 1.42, p1: 1.42, amp: 0.03, hiss: 1 },
  { v: "a", d: 0.09, p0: 1.45, p1: 1.5 },
  { v: "e", d: 0.035, p0: 1.52, p1: 1.58, amp: 0.45 },
  { v: "a", d: 0.3, p0: 1.8, p1: 1.4 },
  { v: "a", d: 0.06, p0: 1.35, p1: 1.2, amp: 0.05, breath: 0.6 },
];

const segLen = (segs: Seg[]): number => segs.reduce((s, x) => s + x.d, 0);

/** Fist on the felt: a dull thud and the chips jumping. */
function fist(g: Group, t: number, peak: number): void {
  blip(g, "sine", t, [[0, 150], [0.12, 52]], peak, 0.16, 0.002);
  noiseHit(g, "brown", t, "lowpass", 600, 1, peak * 0.8, 0.08, 0.001);
  for (let i = 0; i < 2; i++) noiseHit(g, "white", t + 0.03 + rand(0, 0.08), "bandpass", rand(3000, 4200), 4, peak * 0.22, 0.015, 0.0005);
}

/**
 * The table heckling the active player: `size` (1..4) gangsters shout together, a hair apart, over a murmur.
 * "flip" = "ÇEVİR!" with two fists on the felt, "cash" = "KASALA!" with a palm slap on the last syllable.
 */
export function heckle(k: Kit, t: number, vol: number, kind: HeckleKind, size: number): void {
  const n = Math.max(1, Math.min(4, Math.round(size)));
  const segs = kind === "cash" ? KASALA : CEVIR;
  const len = segLen(segs);
  const g = k.group(t, len + 0.6, vol * (0.5 + 0.07 * n));
  if (!g) return;
  g.send(0.18);
  const first = Math.floor(Math.random() * 6);
  for (let i = 0; i < n; i++) {
    const sp = speakerFor(first + i * 2 + (i >= 3 ? 1 : 0));
    // Pull very high and very low voices toward a yelling register.
    const pm = Math.min(1.25, Math.max(0.8, 190 / sp.pitch)) * vary(0.04);
    speak(g, t + (i === 0 ? 0 : rand(0.015, 0.07)), sp, segs, pm, g.gain(i === 0 ? 0.9 : 0.5));
  }
  if (kind === "flip") {
    fist(g, t + 0.06, 0.55);
    fist(g, t + 0.2, 0.7);
  } else {
    const ts = t + len - 0.32;
    noiseHit(g, "white", ts, "bandpass", 1800, 0.8, 0.5, 0.05, 0.001);
    blip(g, "sine", ts, [[0, 230], [0.06, 120]], 0.35, 0.07, 0.001);
  }
  if (n >= 2) {
    const bed = g.vca();
    g.noise("pink", t, t + len + 0.25, g.filter("bandpass", 720, 1.1, bed));
    env(bed.gain, t, 0.08, 0.08 + 0.04 * n, len * 0.8, 0.1);
  }
}
