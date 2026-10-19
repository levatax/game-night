// One-shot cartoon foley for every named Sfx: UI blips, coins, slide whistle, splats, pies, kazoo toots,
// rimshots, TIMBER!, record scratches, buzzers… Each recipe gets the Kit, a start time, volume and pitch.

import type { Sfx } from "../AudioEngine";
import { Group, Kit, env, glide, rand } from "./kit";
import { crowdCheer, crowdOoh, devilCackle, hiccup } from "./voices";

type Recipe = (k: Kit, t: number, vol: number, p: number) => void;

/** Kazoo note: buzzy saw through nasal formants with a wobbly vibrato. */
export function kazoo(g: Group, t: number, f: number, dur: number, amp = 0.35, bendTo?: number): void {
  const v = g.vca();
  const f1 = g.filter("peaking", 1100, 3, v);
  f1.gain.value = 12;
  const f2 = g.filter("peaking", 2600, 4, f1);
  f2.gain.value = 9;
  const lp = g.filter("lowpass", 4200, 0.7, f2);
  const sh = g.shaper(lp);
  const o = g.osc("sawtooth", f, t, t + dur + 0.05, sh);
  if (bendTo) glide(o.frequency, t, [[0, f], [dur * 0.4, f], [dur, bendTo]]);
  g.lfo("sine", 6.5, f * 0.025, o.frequency, t + 0.06, t + dur + 0.05);
  // The paper-membrane buzz: noise amplitude-modulated at the note rate.
  const bz = g.gain(0, lp);
  g.noise("white", t, t + dur, bz);
  const am = g.gain(0.05, null);
  am.connect(bz.gain);
  o.connect(am);
  env(v.gain, t, 0.02, amp, 0.08, Math.max(0, dur - 0.1));
}

/** Little helper: a one-off oscillator with a gain envelope. */
function blip(g: Group, type: OscillatorType, t: number, pts: Array<[number, number]>, peak: number, d: number, a = 0.003, dest: AudioNode = g.out): void {
  const v = g.vca(dest);
  const o = g.osc(type, pts[0][1], t, t + a + d + 0.05, v);
  glide(o.frequency, t, pts);
  env(v.gain, t, a, peak, d);
}

function noiseHit(g: Group, kind: "white" | "pink" | "brown", t: number, type: BiquadFilterType, f: number, Q: number, peak: number, d: number, a = 0.002): BiquadFilterNode {
  const v = g.vca();
  const fl = g.filter(type, f, Q, v);
  g.noise(kind, t, t + a + d + 0.05, fl);
  env(v.gain, t, a, peak, d);
  return fl;
}

function crash(g: Group, t: number, peak: number, d: number): void {
  noiseHit(g, "white", t, "highpass", 5000, 0.7, peak, d);
  noiseHit(g, "white", t, "bandpass", 8000, 1, peak * 0.5, d * 0.6);
}

export const FOLEY: Record<Sfx, Recipe> = {
  click(k, t, vol, p) {
    const g = k.group(t, 0.08, vol * 0.35);
    if (g) blip(g, "square", t, [[0, 1300 * p], [0.03, 850 * p]], 0.4, 0.035);
  },

  hover(k, t, vol, p) {
    const g = k.group(t, 0.06, vol * 0.15);
    if (g) blip(g, "sine", t, [[0, 1700 * p], [0.02, 2100 * p]], 0.4, 0.025);
  },

  cardFlip(k, t, vol, p) {
    const g = k.group(t, 0.2, vol * 0.4);
    if (!g) return;
    const f = noiseHit(g, "white", t, "bandpass", 2000, 1.2, 0.6, 0.07, 0.02);
    glide(f.frequency, t, [[0, 1200 * p], [0.08, 5000 * p]]);
    blip(g, "sine", t + 0.07, [[0, 500 * p], [0.03, 1300 * p]], 0.4, 0.05);
  },

  pop(k, t, vol, p) {
    const g = k.group(t, 0.15, vol * 0.5);
    if (!g) return;
    blip(g, "sine", t, [[0, 380 * p], [0.025, 1250 * p]], 0.55, 0.06, 0.002);
    noiseHit(g, "white", t, "bandpass", 1800, 2, 0.4, 0.015, 0.001);
  },

  coin(k, t, vol, p) {
    const g = k.group(t, 0.45, vol * 0.5);
    if (!g) return;
    blip(g, "square", t, [[0, 988 * p]], 0.3, 0.06, 0.002);
    const v = g.vca();
    g.osc("square", 1319 * p, t + 0.07, t + 0.45, v);
    env(v.gain, t + 0.07, 0.002, 0.3, 0.32);
  },

  kaching(k, t, vol, p) {
    const g = k.group(t, 1.3, vol * 0.45);
    if (!g) return;
    // "KA": drawer slam.
    noiseHit(g, "white", t, "bandpass", 1200, 1.4, 0.8, 0.05);
    blip(g, "sine", t, [[0, 180], [0.06, 70]], 0.5, 0.08);
    // "CHING": a bright bell.
    const tc = t + 0.09;
    [2400, 3610, 4850, 6200].forEach((f, i) => {
      const v = g.vca();
      g.osc("sine", f * p, tc, tc + 1.1, v);
      env(v.gain, tc, 0.002, 0.25 / (1 + i * 0.4), 0.95 / (1 + i * 0.3));
    });
    // Coins tumbling into the tray.
    for (let i = 0; i < 7; i++) {
      const ct = tc + 0.1 + rand(0, 0.45);
      blip(g, "sine", ct, [[0, rand(3000, 5200) * p]], rand(0.06, 0.12), 0.08, 0.001);
    }
  },

  // Topple: the classic falling slide whistle, with a little up-flick first.
  slideWhistle(k, t, vol, p) {
    const dur = 1.25;
    const g = k.group(t, dur + 0.2, vol * 0.4);
    if (!g) return;
    const v = g.vca();
    const o = g.osc("sine", 900 * p, t, t + dur + 0.1, v);
    glide(o.frequency, t, [[0, 1100 * p], [0.12, 1900 * p], [dur, 260 * p]]);
    g.lfo("sine", 5.5, 25, o.frequency, t + 0.2, t + dur);
    const o2 = g.osc("triangle", 1800 * p, t, t + dur + 0.1, g.gain(0.08, v));
    glide(o2.frequency, t, [[0, 2200 * p], [0.12, 3800 * p], [dur, 520 * p]]);
    env(v.gain, t, 0.04, 0.55, 0.15, dur - 0.15);
    // Breath through the pipe.
    const bv = g.vca();
    const bp = g.filter("bandpass", 1900, 3, bv);
    glide(bp.frequency, t, [[0, 1900 * p], [0.12, 2600 * p], [dur, 500 * p]]);
    g.noise("white", t, t + dur, bp);
    env(bv.gain, t, 0.05, 0.15, 0.2, dur - 0.2);
  },

  // Cake SPLAT: a wet low splodge with flying droplets.
  splat(k, t, vol, p) {
    const g = k.group(t, 0.9, vol * 0.65);
    if (!g) return;
    const f = noiseHit(g, "brown", t, "lowpass", 1400, 3, 1.0, 0.25, 0.004);
    glide(f.frequency, t, [[0, 2200 * p], [0.25, 300]]);
    noiseHit(g, "white", t, "bandpass", 900 * p, 2.5, 0.6, 0.12);
    blip(g, "sine", t, [[0, 110 * p], [0.15, 38]], 0.8, 0.2);
    for (let i = 0; i < 6; i++) {
      const dt = t + 0.1 + rand(0, 0.5);
      const f0 = rand(600, 1400) * p;
      blip(g, "sine", dt, [[0, f0], [0.05, f0 * 0.45]], rand(0.08, 0.18), 0.05, 0.002);
    }
  },

  // Cream pie to the face: THWACK + creamy splorch + a little face-drip.
  pie(k, t, vol, p) {
    const g = k.group(t, 1.2, vol * 0.42);
    if (!g) return;
    noiseHit(g, "white", t, "highpass", 2500, 1, 0.9, 0.025, 0.0008);
    noiseHit(g, "white", t, "bandpass", 1100 * p, 1.8, 0.8, 0.09, 0.002);
    blip(g, "sine", t, [[0, 160 * p], [0.1, 55]], 0.9, 0.14, 0.001);
    const cream = noiseHit(g, "pink", t + 0.03, "lowpass", 1800, 5, 0.7, 0.4, 0.02);
    glide(cream.frequency, t + 0.03, [[0, 2400 * p], [0.45, 250 * p]]);
    // Slow drip "blooop".
    const dt = t + 0.55;
    blip(g, "sine", dt, [[0, 700 * p], [0.18, 260 * p]], 0.22, 0.2, 0.01);
  },

  // Party popper bang, paper confetti rustle, and a kazoo "toot-toot-TOOOT!".
  partyPopper(k, t, vol, p) {
    const g = k.group(t, 1.6, vol * 0.5);
    if (!g) return;
    noiseHit(g, "white", t, "bandpass", 1500, 0.8, 1.0, 0.07, 0.001);
    blip(g, "sine", t, [[0, 200], [0.05, 60]], 0.6, 0.08, 0.001);
    noiseHit(g, "white", t + 0.03, "highpass", 6000, 0.5, 0.15, 0.6, 0.05);
    const b = 523 * p;
    kazoo(g, t + 0.18, b, 0.1);
    kazoo(g, t + 0.32, b, 0.1);
    kazoo(g, t + 0.46, b * 1.5, 0.55, 0.42, b * 1.62);
  },

  // Ba-dum-TSSS.
  rimshot(k, t, vol, p) {
    const g = k.group(t, 1.2, vol * 0.55);
    if (!g) return;
    blip(g, "sine", t, [[0, 210 * p], [0.12, 130 * p]], 0.7, 0.15, 0.002);
    noiseHit(g, "white", t, "bandpass", 2000, 1, 0.25, 0.05);
    blip(g, "sine", t + 0.16, [[0, 150 * p], [0.12, 90 * p]], 0.75, 0.18, 0.002);
    const ts = t + 0.36;
    noiseHit(g, "white", ts, "bandpass", 2500, 2, 0.6, 0.04, 0.001);
    blip(g, "triangle", ts, [[0, 330], [0.05, 260]], 0.4, 0.06, 0.001);
    crash(g, ts, 0.45, 0.8);
  },

  // TIMBER!: a long, groaning wood creak, then a big crash with clattering bits.
  timber(k, t, vol, p) {
    const g = k.group(t, 2.2, vol * 0.6);
    if (!g) return;
    const cv = g.vca();
    const bp = g.filter("bandpass", 700, 9, cv);
    const sh = g.shaper(bp);
    const o = g.osc("sawtooth", 55, t, t + 1.0, sh);
    glide(o.frequency, t, [[0, 48 * p], [0.3, 70 * p], [0.5, 52 * p], [0.9, 95 * p]]);
    g.lfo("square", 23, 12, o.frequency, t, t + 1.0);
    glide(bp.frequency, t, [[0, 500], [0.9, 1100]]);
    env(cv.gain, t, 0.15, 0.6, 0.15, 0.65);
    const tc = t + 0.95;
    noiseHit(g, "brown", tc, "lowpass", 900, 1, 1.0, 0.6, 0.003);
    noiseHit(g, "white", tc, "bandpass", 1500, 0.8, 0.6, 0.3, 0.002);
    blip(g, "sine", tc, [[0, 90], [0.3, 35]], 0.9, 0.35, 0.002);
    for (let i = 0; i < 7; i++) {
      const bt = tc + 0.08 + rand(0, 0.7);
      const f0 = rand(350, 900) * p;
      blip(g, "triangle", bt, [[0, f0], [0.06, f0 * 0.65]], rand(0.15, 0.35), 0.1, 0.001);
    }
  },

  ooh(k, t, vol) {
    crowdOoh(k, t, vol);
  },

  cheer(k, t, vol) {
    crowdCheer(k, t, vol);
  },

  // Vinyl scratch: a wiggly forward-back-forward pitch sweep of crunchy noise + saw.
  recordScratch(k, t, vol, p) {
    const g = k.group(t, 0.6, vol * 0.9);
    if (!g) return;
    const v = g.vca();
    const bp = g.filter("bandpass", 1500, 2.5, v);
    const sh = g.shaper(bp);
    const pts: Array<[number, number]> = [[0, 300], [0.08, 2600], [0.16, 500], [0.26, 3200], [0.42, 180]];
    glide(bp.frequency, t, pts.map(([a, b]) => [a, b * p] as [number, number]));
    g.noise("white", t, t + 0.45, sh);
    const o = g.osc("sawtooth", 200, t, t + 0.45, g.gain(0.25, sh));
    glide(o.frequency, t, pts.map(([a, b]) => [a, (b / 6) * p] as [number, number]));
    env(v.gain, t, 0.01, 0.7, 0.12, 0.3);
  },

  hic(k, t, vol) {
    hiccup(k, t, vol);
  },

  // Earthquake: deep brown-noise rumble with a shaky tremolo and rattling crockery.
  rumble(k, t, vol, p) {
    const dur = 1.8;
    const g = k.group(t, dur + 0.2, vol * 0.4);
    if (!g) return;
    const v = g.vca();
    const trem = g.gain(1, v);
    g.lfo("sine", 7, 0.45, trem.gain, t, t + dur);
    g.noise("brown", t, t + dur, g.filter("lowpass", 160 * p, 1.5, trem));
    g.osc("sine", 34 * p, t, t + dur, g.gain(0.6, trem));
    env(v.gain, t, 0.25, 0.9, 0.7, dur - 0.95);
    for (let i = 0; i < 9; i++) {
      const rt = t + rand(0.2, dur - 0.3);
      blip(g, "sine", rt, [[0, rand(2200, 3800)]], rand(0.03, 0.07), 0.08, 0.001);
    }
  },

  cackle(k, t, vol) {
    devilCackle(k, t, vol);
  },

  // Timer tick (last seconds): a dry woodblock "tock".
  tick(k, t, vol, p) {
    const g = k.group(t, 0.1, vol * 0.4);
    if (!g) return;
    blip(g, "sine", t, [[0, 1800 * p], [0.02, 1500 * p]], 0.5, 0.03, 0.001);
    noiseHit(g, "white", t, "bandpass", 3500, 3, 0.3, 0.01, 0.0005);
  },

  // Piece drop: an airy "fwoosh".
  whoosh(k, t, vol, p) {
    const g = k.group(t, 0.55, vol * 1.2);
    if (!g) return;
    const f = noiseHit(g, "pink", t, "bandpass", 600, 1.2, 1.4, 0.25, 0.15);
    glide(f.frequency, t, [[0, 300 * p], [0.18, 2200 * p], [0.45, 500 * p]]);
  },

  // Game-show "DING!": a bright bell.
  ding(k, t, vol, p) {
    const g = k.group(t, 1.5, vol * 0.45);
    if (!g) return;
    [1318, 2637 * 1.002, 3950, 5280].forEach((f, i) => {
      const v = g.vca();
      g.osc("sine", f * p, t, t + 1.4, v);
      env(v.gain, t, 0.002, 0.35 / (1 + i * 0.8), 1.2 / (1 + i * 0.4));
    });
  },

  // Wrong-answer buzzer: "BZZZZT".
  buzzer(k, t, vol, p) {
    const g = k.group(t, 0.75, vol * 0.3);
    if (!g) return;
    const v = g.vca();
    const lp = g.filter("lowpass", 1400, 1, v);
    g.osc("sawtooth", 110 * p, t, t + 0.65, lp);
    g.osc("square", 116.5 * p, t, t + 0.65, g.gain(0.6, lp));
    env(v.gain, t, 0.01, 0.6, 0.06, 0.55);
  },

  // Small sad "wah-waaah" on a kazoo (the big sad trombone is a Music stinger).
  lose(k, t, vol, p) {
    const g = k.group(t, 1.0, vol * 0.45);
    if (!g) return;
    kazoo(g, t, 330 * p, 0.25, 0.3, 311 * p);
    kazoo(g, t + 0.3, 294 * p, 0.6, 0.3, 240 * p);
  },
};
