// Harmony helpers for the procedural music: chord qualities, the hand-written 8-bar sections the band
// chains at random (so the tune never audibly loops), voice-led comping voicings, the walking-bass walker
// and the improvised vibes phrases.

export type Quality = "maj7" | "m7" | "7" | "7b9" | "m7b5" | "m6" | "6" | "mM7" | "m";

export interface Chord {
  /** Pitch class of the root, 0 = C. */
  pc: number;
  q: Quality;
}
/** One bar: one chord (4 beats) or two (2 + 2). */
export type Bar = Chord[];
export type Section = Bar[];

/** Chord tones above the root (root, 3rd, 5th, 7th-ish). */
export const TONES: Record<Quality, number[]> = {
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  "7": [0, 4, 7, 10],
  "7b9": [0, 4, 7, 10],
  m7b5: [0, 3, 6, 10],
  m6: [0, 3, 7, 9],
  "6": [0, 4, 7, 9],
  mM7: [0, 3, 7, 11],
  m: [0, 3, 7, 12],
};
/** Rootless 4-note comping sets (3rd, 5th/13th, 7th, 9th…); "m" keeps the root so line clichés move. */
const COMP: Record<Quality, number[]> = {
  maj7: [4, 7, 11, 14],
  m7: [3, 7, 10, 14],
  "7": [4, 9, 10, 14],
  "7b9": [4, 9, 10, 13],
  m7b5: [3, 6, 10, 17],
  m6: [3, 7, 9, 14],
  "6": [4, 7, 9, 14],
  mM7: [3, 7, 11, 14],
  m: [0, 3, 7, 14],
};

const PC: Record<string, number> = { C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const c = (name: string, q: Quality): Chord => ({ pc: PC[name], q });

export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const mod12 = (n: number): number => ((n % 12) + 12) % 12;
export const pickOf = <T>(arr: readonly T[]): T => arr[Math.min(arr.length - 1, Math.floor(Math.random() * arr.length))];

// ---- sections ------------------------------------------------------------------------------------------

/** Smoky F-minor lounge: ii–V–i spine, a relative-major bridge, a minor blues and the noir line cliché. */
export const JAZZ: Section[] = [
  [[c("F", "m7")], [c("F", "m7")], [c("Bb", "m7")], [c("Eb", "7")], [c("Ab", "maj7")], [c("Db", "maj7")], [c("G", "m7b5"), c("C", "7b9")], [c("F", "m7")]],
  [[c("Bb", "m7")], [c("Eb", "7")], [c("Ab", "maj7")], [c("Ab", "maj7")], [c("G", "m7b5")], [c("C", "7b9")], [c("F", "m6")], [c("F", "m6")]],
  [[c("F", "m7")], [c("Db", "maj7")], [c("G", "m7b5")], [c("C", "7b9")], [c("F", "m7")], [c("Bb", "m7"), c("Eb", "7")], [c("Ab", "maj7"), c("Db", "maj7")], [c("G", "m7b5"), c("C", "7b9")]],
  [[c("F", "m7")], [c("Bb", "m7")], [c("F", "m7")], [c("F", "7")], [c("Bb", "m7")], [c("Db", "7")], [c("F", "m7"), c("C", "7b9")], [c("F", "m7")]],
  [[c("F", "m")], [c("F", "mM7")], [c("F", "m7")], [c("F", "m6")], [c("Db", "maj7")], [c("Bb", "m7")], [c("G", "m7b5")], [c("C", "7b9")]],
];
/** Which section may follow which (weights). Index = JAZZ index. */
export const JAZZ_NEXT: number[][] = [
  [0, 3, 3, 2, 3],
  [3, 0, 2, 3, 2],
  [3, 2, 0, 2, 3],
  [2, 3, 3, 0, 2],
  [3, 3, 2, 2, 1],
];

/** Victory swing in A♭ major: I–VI7–ii–V and a IV–♭VII7 detour. */
export const SWING: Section[] = [
  [[c("Ab", "maj7")], [c("F", "7")], [c("Bb", "m7")], [c("Eb", "7")], [c("Ab", "maj7")], [c("F", "7")], [c("Bb", "m7"), c("Eb", "7")], [c("Ab", "6")]],
  [[c("Db", "maj7")], [c("Gb", "7")], [c("C", "m7")], [c("F", "7")], [c("Bb", "m7")], [c("Eb", "7")], [c("Ab", "6"), c("F", "7")], [c("Bb", "m7"), c("Eb", "7")]],
];
export const SWING_NEXT: number[][] = [
  [1, 2],
  [2, 1],
];

/** SON MASA tango in F minor: i–V, iv–i, and the Andalusian cadence. */
export const TANGO: Section[] = [
  [[c("F", "m")], [c("F", "m")], [c("C", "7")], [c("C", "7")], [c("C", "7")], [c("C", "7")], [c("F", "m")], [c("F", "m")]],
  [[c("Bb", "m")], [c("Bb", "m")], [c("F", "m")], [c("F", "m")], [c("Db", "7")], [c("C", "7")], [c("F", "m")], [c("C", "7")]],
  [[c("F", "m")], [c("Eb", "7")], [c("Db", "maj7")], [c("C", "7")], [c("F", "m")], [c("Eb", "7")], [c("Db", "7")], [c("C", "7")]],
];
export const TANGO_NEXT: number[][] = [
  [1, 3, 3],
  [3, 1, 3],
  [3, 3, 1],
];

export function weightedPick(weights: readonly number[]): number {
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/** Copy a section, sometimes swapping a dominant for its tritone substitute (G♭7 for C7…). */
export function varySection(s: Section, subChance = 0.22): Section {
  return s.map((bar) =>
    bar.map((ch) => (ch.q === "7b9" || ch.q === "7") && Math.random() < subChance ? { pc: mod12(ch.pc + 6), q: "7" as Quality } : ch),
  );
}

// ---- voicings ----------------------------------------------------------------------------------------

/** All inversions of a pitch-class set stacked upward inside [lo, hi]. */
function inversions(pcs: number[], lo: number, hi: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < pcs.length; i++) {
    const order = [...pcs.slice(i), ...pcs.slice(0, i)];
    let n = lo + mod12(order[0] - lo);
    const v = [n];
    for (let j = 1; j < order.length; j++) {
      n = n + 1 + mod12(order[j] - n - 1);
      v.push(n);
    }
    if (v[v.length - 1] <= hi) out.push(v);
    // Also try one octave up when it still fits.
    if (v[v.length - 1] + 12 <= hi) out.push(v.map((x) => x + 12));
  }
  return out;
}

/** Comping voicing that moves as little as possible from `prev`. */
export function voiceLead(ch: Chord, prev: number[] | null, lo = 53, hi = 76): number[] {
  const pcs = [...new Set(COMP[ch.q].map((i) => mod12(ch.pc + i)))];
  const cands = inversions(pcs, lo, hi);
  if (cands.length === 0) return pcs.map((p) => 60 + p);
  if (!prev || prev.length === 0) {
    // Start around the middle of the range.
    const mid = (lo + hi) / 2;
    return cands.reduce((best, v) => (Math.abs(avg(v) - mid) < Math.abs(avg(best) - mid) ? v : best));
  }
  let best = cands[0];
  let bestCost = Infinity;
  for (const v of cands) {
    let cost = 0;
    for (let j = 0; j < v.length; j++) cost += Math.abs(v[j] - (prev[j] ?? prev[prev.length - 1]));
    cost += Math.random() * 0.5;
    if (cost < bestCost) {
      bestCost = cost;
      best = v;
    }
  }
  return best;
}

const avg = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;

/** Root-position tango voicing (piano stabs / bandoneon), around MIDI 55–70. */
export function closeVoicing(ch: Chord, lo = 55): number[] {
  const root = lo + mod12(ch.pc - lo);
  const t = TONES[ch.q];
  return [root, ...t.slice(1).map((i) => root + i)];
}

// ---- bass --------------------------------------------------------------------------------------------

const BASS_LO = 31;
const BASS_HI = 50;

/** Put pitch class `pc` in the bass register nearest to `near`. */
export function bassNear(pc: number, near: number): number {
  let n = BASS_LO + mod12(pc - BASS_LO);
  let best = n;
  while (n <= BASS_HI) {
    if (Math.abs(n - near) < Math.abs(best - near)) best = n;
    n += 12;
  }
  return best;
}

/**
 * Walking bass note for beat `k` of a chord lasting `len` beats, heading to `next`. Root on the downbeat,
 * chord tones / scale steps in the middle, a chromatic or dominant approach into the next chord.
 */
export function walk(ch: Chord, next: Chord, k: number, len: number, last: number): number {
  if (k === 0) return bassNear(ch.pc, last);
  if (k === len - 1) {
    const target = bassNear(next.pc, last);
    const r = Math.random();
    if (r < 0.55) return target + (last > target ? 1 : -1);
    if (r < 0.8) return bassNear(next.pc + 7, last);
    return target + (last > target ? 2 : -2);
  }
  const t = TONES[ch.q];
  const opts = [t[1], t[2], 2, t[3] === 12 ? 10 : t[3]].map((i) => bassNear(ch.pc + i, last));
  // Prefer a note that actually moves, close to the last one.
  opts.sort((a, b) => Math.abs(a - last) - Math.abs(b - last) + (Math.random() - 0.5) * 3);
  const moved = opts.find((n) => n !== last);
  return Math.max(BASS_LO, Math.min(BASS_HI, moved ?? opts[0]));
}

// ---- improvised phrases --------------------------------------------------------------------------------

/** A phrase note: start eighth (from the phrase start), MIDI note, length in eighths. */
export type PNote = [number, number, number];

/** Rhythm templates over a 2-bar slot (16 eighths): [start eighth, length]. */
const RHYTHMS: Array<Array<[number, number]>> = [
  [[0, 1], [1, 1], [2, 1], [3, 3]],
  [[1, 1], [2, 1], [3, 1], [4, 2], [6, 2]],
  [[0, 2], [2, 1], [3, 1], [4, 1], [5, 1], [6, 2], [8, 4]],
  [[2, 1], [3, 1], [4, 1], [5, 3], [9, 1], [10, 1], [11, 3]],
  [[0, 3], [3, 1], [4, 4]],
  [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 3]],
  [[3, 1], [4, 2], [6, 1], [7, 1], [8, 2], [11, 1], [12, 3]],
  [[1, 2], [3, 1], [4, 1], [6, 2], [9, 1], [10, 1], [11, 1], [12, 3]],
];

/** Natural-minor scale of the key (F minor = A♭ major) as pitch classes. */
export const F_MINOR = [5, 7, 8, 10, 0, 1, 3];

/**
 * Improvise a phrase over a 2-bar slot. `chordAt(eighth)` gives the harmony, `start` the previous phrase's
 * last note (the line continues from there), notes stay within [lo, hi]. Strong beats and long notes land
 * on chord tones; the rest walks the key scale by small steps along an arch-shaped contour.
 */
export function improvise(chordAt: (e: number) => Chord, start: number, lo: number, hi: number, scale = F_MINOR, reuse?: Array<[number, number]>): { notes: PNote[]; rhythm: Array<[number, number]> } {
  const rhythm = reuse ?? pickOf(RHYTHMS);
  const notes: PNote[] = [];
  let cur = Math.max(lo + 4, Math.min(hi - 4, start));
  const peak = Math.floor(rhythm.length * (0.3 + Math.random() * 0.4));
  let dir = Math.random() < 0.6 ? 1 : -1;
  rhythm.forEach(([e, len], i) => {
    const ch = chordAt(e);
    const chordPcs = [...TONES[ch.q].map((x) => mod12(ch.pc + x)), mod12(ch.pc + (ch.q === "7b9" ? 1 : 2))];
    const strong = e % 2 === 0 || len >= 2 || i === rhythm.length - 1;
    const pool = strong ? chordPcs : [...new Set([...scale, ...chordPcs])];
    if (i === peak) dir = -1;
    else if (i < peak) dir = 1;
    const step = strong ? 1 + Math.floor(Math.random() * 4) : 1 + Math.floor(Math.random() * 2);
    const target = cur + dir * step;
    // Nearest pool note to the target, inside the range.
    let best = cur;
    let bestD = Infinity;
    for (let n = lo; n <= hi; n++) {
      if (!pool.includes(mod12(n))) continue;
      const d = Math.abs(n - target) + (n === cur ? 1.5 : 0);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    cur = best;
    notes.push([e, cur, len]);
  });
  return { notes, rhythm };
}
