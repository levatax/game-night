// Table sounds: card flip "fışşş", dealing, rarity bells, the cash register, coins, clay chips, chips cracking
// into ash, the wheel's peg flapper and final clunk, the kumbara's glass smash + coin cascade, bill riffling.

import { BELL, Group, Kit, TINK, blip, env, glide, noiseHit, rand, strike } from "./kit";
import { choir } from "./voices";

export type Recipe = (k: Kit, t: number, vol: number, p: number) => void;

const COIN: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1, 1],
  [2.32, 0.55, 0.5],
];

/** One coin landing on a pile. */
function coin(g: Group, t: number, p: number, peak: number): void {
  strike(g, t, rand(2500, 4300) * p, COIN, peak, rand(0.07, 0.16));
}

/** One clay chip clack. */
function chip(g: Group, t: number, p: number, peak: number): void {
  noiseHit(g, "white", t, "bandpass", rand(3000, 4200) * p, 4, peak, 0.018, 0.0005);
  blip(g, "sine", t, [[0, rand(1900, 2500) * p]], peak * 0.35, 0.03, 0.0008);
}

/** A run of coins tumbling into a heap over `len` seconds, density thinning out. */
function cascade(g: Group, t: number, p: number, n: number, len: number, peak: number): void {
  for (let i = 0; i < n; i++) {
    const x = Math.pow(Math.random(), 1.6);
    coin(g, t + x * len, p, peak * (1 - x * 0.6) * rand(0.6, 1));
  }
}

export const CASINO: Record<
  | "flip"
  | "deal"
  | "bellCommon"
  | "bellUncommon"
  | "bellRare"
  | "bellLegendary"
  | "choir"
  | "kaching"
  | "coins"
  | "chips"
  | "chipCrack"
  | "wheelStop"
  | "glassBreak"
  | "countMoney",
  Recipe
> = {
  // "Fışşş": an airy noise sweep with paper flutter, ending in a little card snap.
  flip(k, t, vol, p) {
    const g = k.group(t, 0.6, vol * 0.55);
    if (!g) return;
    const v = g.vca();
    const flutter = g.gain(1, v);
    g.lfo("triangle", rand(24, 30), 0.45, flutter.gain, t, t + 0.45);
    const bp = g.filter("bandpass", 1000, 0.9, flutter);
    g.noise("white", t, t + 0.5, bp);
    glide(bp.frequency, t, [[0, 900 * p], [0.3, 6500 * p], [0.42, 4200 * p]]);
    env(v.gain, t, 0.09, 0.75, 0.24, 0.07);
    const ts = t + 0.36;
    noiseHit(g, "white", ts, "highpass", 2600, 0.8, 0.45, 0.03, 0.001);
    blip(g, "triangle", ts, [[0, 430 * p], [0.04, 170 * p]], 0.32, 0.05, 0.001);
  },

  // Dealer slides a card across the felt: "fft" + soft tap.
  deal(k, t, vol, p) {
    const g = k.group(t, 0.35, vol * 0.6);
    if (!g) return;
    const f = noiseHit(g, "pink", t, "bandpass", 2200 * p, 0.9, 0.6, 0.1, 0.02);
    glide(f.frequency, t, [[0, 2600 * p], [0.12, 1100 * p]]);
    const tt = t + 0.11;
    noiseHit(g, "brown", tt, "lowpass", 900, 1, 0.55, 0.05, 0.002);
    blip(g, "sine", tt, [[0, 210 * p], [0.05, 95 * p]], 0.3, 0.06, 0.002);
  },

  // Bronze: one soft, warm ding.
  bellCommon(k, t, vol, p) {
    const g = k.group(t, 1.0, vol * 0.3);
    if (!g) return;
    strike(g, t, 880 * p, BELL, 0.5, 0.8);
    blip(g, "triangle", t, [[0, 440 * p]], 0.12, 0.35, 0.003);
  },

  // Silver: a bright ding-ding.
  bellUncommon(k, t, vol, p) {
    const g = k.group(t, 1.3, vol * 0.32);
    if (!g) return;
    g.send(0.15);
    strike(g, t, 1175 * p, BELL, 0.45, 0.9);
    strike(g, t + 0.09, 1568 * p, BELL, 0.5, 1.1);
  },

  // Gold: a rising three-bell arpeggio and a sprinkle of sparkles.
  bellRare(k, t, vol, p) {
    const g = k.group(t, 1.8, vol * 0.34);
    if (!g) return;
    g.send(0.3);
    [1047, 1319, 1568].forEach((f, i) => strike(g, t + i * 0.07, f * p, BELL, 0.42, 1.2));
    strike(g, t + 0.21, 2093 * p, BELL, 0.3, 1.4);
    for (let i = 0; i < 8; i++) {
      const st = t + 0.25 + i * 0.045 + rand(0, 0.02);
      blip(g, "sine", st, [[0, rand(4200, 6800) * p]], rand(0.05, 0.1), 0.12, 0.001);
    }
  },

  // Legendary purple: a fast glittering arpeggio, shimmering tremolo cloud and a little heavenly choir.
  bellLegendary(k, t, vol, p) {
    const g = k.group(t, 2.6, vol * 0.36);
    if (!g) return;
    g.send(0.4);
    const arp = [698, 880, 1047, 1397, 1760, 2093, 2794];
    arp.forEach((f, i) => strike(g, t + i * 0.05, f * p, BELL, 0.38, 1.1 + i * 0.08));
    // Shimmer: detuned high sines under a fast tremolo.
    const sv = g.vca();
    const trem = g.gain(0.6, sv);
    g.lfo("sine", 11, 0.4, trem.gain, t, t + 2.2);
    for (const f of [2793, 2801, 3520, 3529]) g.osc("sine", f * p, t + 0.3, t + 2.2, g.gain(0.25, trem));
    env(sv.gain, t + 0.3, 0.25, 0.22, 1.4, 0.2);
    choir(k, t + 0.12, vol * 0.8, p, 1.6);
  },

  choir(k, t, vol, p) {
    choir(k, t, vol, p, 1.5);
  },

  // Cash register: lever ratchet, drawer "KA", bell "CHING", coins in the tray.
  kaching(k, t, vol, p) {
    const g = k.group(t, 1.5, vol * 0.5);
    if (!g) return;
    g.send(0.12);
    for (let i = 0; i < 5; i++) noiseHit(g, "white", t + i * 0.016, "bandpass", 3300 * p, 3, 0.32, 0.012, 0.0005);
    const ta = t + 0.09;
    noiseHit(g, "white", ta, "bandpass", 1100, 1.3, 0.85, 0.06);
    blip(g, "sine", ta, [[0, 170], [0.07, 60]], 0.6, 0.1);
    const tc = ta + 0.07;
    [2400, 3610, 4850, 6200].forEach((f, i) => {
      const v = g.vca();
      const trem = g.gain(1, v);
      g.lfo("sine", 14, 0.18, trem.gain, tc, tc + 1.1);
      g.osc("sine", f * p, tc, tc + 1.15, trem);
      env(v.gain, tc, 0.002, 0.26 / (1 + i * 0.4), 0.95 / (1 + i * 0.3));
    });
    cascade(g, tc + 0.12, p, 7, 0.45, 0.14);
  },

  // A handful of coins pouring onto a pile.
  coins(k, t, vol, p) {
    const g = k.group(t, 1.0, vol * 0.42);
    if (!g) return;
    cascade(g, t, p, 13, 0.6, 0.28);
    noiseHit(g, "white", t, "highpass", 5000, 0.7, 0.12, 0.35, 0.02);
  },

  // A stack of clay chips: clack-clack-clk-clk.
  chips(k, t, vol, p) {
    const g = k.group(t, 0.5, vol * 0.85);
    if (!g) return;
    const n = 4 + Math.floor(Math.random() * 3);
    let tt = t;
    for (let i = 0; i < n; i++) {
      chip(g, tt, p, 0.55 * (1 - i * 0.1));
      tt += rand(0.035, 0.07) * (1 - i * 0.08);
    }
  },

  // A dead bet: the chip cracks, crumbles, and puffs into ash.
  chipCrack(k, t, vol, p) {
    const g = k.group(t, 1.0, vol * 0.5);
    if (!g) return;
    const sh = g.shaper();
    const v = g.vca(sh);
    g.noise("white", t, t + 0.08, g.filter("highpass", 1500, 0.8, v));
    env(v.gain, t, 0.0006, 0.9, 0.04);
    blip(g, "sawtooth", t, [[0, 900 * p], [0.05, 190 * p]], 0.25, 0.06, 0.0006);
    chip(g, t + 0.005, p * 0.8, 0.5);
    for (let i = 0; i < 10; i++) {
      const ct = t + 0.06 + Math.pow(Math.random(), 1.3) * 0.45;
      noiseHit(g, "brown", ct, "bandpass", rand(500, 1700) * p, 3, rand(0.2, 0.45), rand(0.01, 0.03), 0.0008);
    }
    const ash = noiseHit(g, "pink", t + 0.25, "lowpass", 900, 0.8, 0.35, 0.45, 0.1);
    glide(ash.frequency, t + 0.25, [[0, 1400], [0.5, 300]]);
  },

  // The wheel lands: heavy clunk, metal latch, two settling ticks.
  wheelStop(k, t, vol, p) {
    const g = k.group(t, 1.2, vol * 0.6);
    if (!g) return;
    g.send(0.2);
    blip(g, "sine", t, [[0, 150 * p], [0.18, 48 * p]], 0.95, 0.3, 0.002);
    noiseHit(g, "brown", t, "lowpass", 650, 1, 0.8, 0.14, 0.002);
    strike(g, t + 0.004, 1250 * p, TINK, 0.4, 0.3);
    noiseHit(g, "white", t + 0.18, "bandpass", 2800, 3, 0.25, 0.02, 0.0006);
    noiseHit(g, "white", t + 0.36, "bandpass", 2500, 3, 0.14, 0.02, 0.0006);
  },

  // KUMBARA PATLADI: glass smash, shards tinkling, then a long coin avalanche.
  glassBreak(k, t, vol, p) {
    const g = k.group(t, 2.4, vol * 0.55);
    if (!g) return;
    g.send(0.25);
    noiseHit(g, "white", t, "highpass", 3000, 0.7, 1.0, 0.09, 0.0008);
    noiseHit(g, "white", t, "bandpass", 6500, 1.2, 0.6, 0.25, 0.001);
    blip(g, "sine", t, [[0, 140], [0.1, 55]], 0.7, 0.14, 0.001);
    for (let i = 0; i < 14; i++) {
      const st = t + 0.01 + Math.pow(Math.random(), 1.8) * 0.65;
      strike(g, st, rand(2200, 6800) * p, COIN, rand(0.12, 0.3), rand(0.04, 0.12));
    }
    for (const f of [3150, 4430, 5210]) {
      const v = g.vca();
      g.osc("sine", f * p * rand(0.98, 1.02), t, t + 0.9, v);
      env(v.gain, t, 0.002, 0.06, 0.8);
    }
    cascade(g, t + 0.12, p, 20, 1.3, 0.24);
  },

  // Licks a finger ("tlk"), riffles the bills, tosses the wad.
  countMoney(k, t, vol, p) {
    const g = k.group(t, 1.2, vol * 0.85);
    if (!g) return;
    blip(g, "sine", t, [[0, 1300 * p], [0.025, 600 * p]], 0.28, 0.025, 0.001);
    noiseHit(g, "white", t, "bandpass", 2500, 2, 0.15, 0.015, 0.0008);
    let tt = t + 0.12;
    for (let i = 0; i < 11; i++) {
      noiseHit(g, "white", tt, "bandpass", rand(3500, 5200) * p, 1.5, rand(0.35, 0.55), 0.022, 0.001);
      noiseHit(g, "pink", tt + 0.004, "bandpass", 1400 * p, 1.2, 0.18, 0.03, 0.002);
      tt += 0.062 - i * 0.0028;
    }
    const tw = tt + 0.08;
    const f = noiseHit(g, "pink", tw, "bandpass", 2000, 0.9, 0.7, 0.18, 0.03);
    glide(f.frequency, tw, [[0, 2600 * p], [0.2, 700 * p]]);
  },
};

/** Wheel flapper hitting a peg; speed 0..1 — pitch and volume follow it, slow ticks get a woody body. */
export function wheelPeg(k: Kit, t: number, speed: number, vol: number): void {
  const s = Math.min(1, Math.max(0, speed));
  const g = k.group(t, 0.12, vol * (0.38 + 0.32 * s));
  if (!g) return;
  const f = (1250 + s * 1150) * rand(0.97, 1.03);
  noiseHit(g, "white", t, "bandpass", f * 2.2, 3, 0.6, 0.012, 0.0005);
  blip(g, "triangle", t, [[0, f], [0.03, f * 0.72]], 0.5, 0.035, 0.0008);
  blip(g, "sine", t, [[0, 330 + s * 200], [0.04, 200 + s * 120]], 0.3 * (1.2 - s), 0.05, 0.001);
}
