// Piece impact foley, one recipe per ImpactSound. `s` is impact strength 0..1 (from speed), `p` a pitch
// multiplier (already randomised a bit by the caller). Harder hits are louder, brighter and a little lower.

import type { ImpactSound } from "../../../../shared/constants";
import { Group, env, glide, rand } from "./kit";

type Recipe = (g: Group, t: number, s: number, p: number) => void;

/** Approximate tail length per sound (for node cleanup). */
export const IMPACT_DUR: Record<ImpactSound, number> = {
  squeak: 0.45, clank: 0.7, blorp: 0.45, slap: 0.3, crack: 0.3, thud: 0.3, boing: 0.75, clink: 0.6, squish: 0.35, bonk: 0.3,
};

export const IMPACTS: Record<ImpactSound, Recipe> = {
  // Rubber chicken: a strangled, pitch-bent "EEEeeuk" through a nasal bandpass, with a flutter.
  squeak(g, t, s, p) {
    const dur = 0.18 + s * 0.22;
    const v = g.vca();
    const nasal = g.filter("bandpass", 1600 * p, 3, v);
    const pk = g.filter("peaking", 3000 * p, 2, nasal);
    pk.gain.value = 8;
    const sh = g.shaper(pk);
    const f0 = 520 * p;
    for (const [type, mul] of [["square", 1], ["sawtooth", 1.007]] as const) {
      const o = g.osc(type, f0, t, t + dur + 0.05, sh);
      glide(o.frequency, t, [[0, f0 * mul], [0.04, f0 * 2.4 * mul], [dur * 0.6, f0 * 2.0 * mul], [dur, f0 * 1.2 * mul]]);
      g.lfo("sine", 28, f0 * 0.12, o.frequency, t, t + dur + 0.05);
    }
    env(v.gain, t, 0.012, 0.75, dur * 0.5, dur * 0.45);
  },

  // Toaster: inharmonic metallic partials with staggered decays, plus a sharp click.
  clank(g, t, s, p) {
    const base = 310 * p * (1 - s * 0.15);
    const partials = [1, 2.76, 5.4, 8.93, 13.3];
    partials.forEach((m, i) => {
      const v = g.vca();
      g.osc(i % 2 ? "triangle" : "sine", base * m * rand(0.99, 1.01), t, t + 0.7, v);
      env(v.gain, t, 0.002, 0.28 / (1 + i * 0.6), 0.6 / (1 + i * 0.5));
    });
    const c = g.vca();
    g.noise("white", t, t + 0.04, g.filter("highpass", 3000, 1, c));
    env(c.gain, t, 0.001, 0.4 * (0.5 + s), 0.03);
  },

  // Jelly: low sine with a fast downward bend and a jiggly wobble.
  blorp(g, t, s, p) {
    const v = g.vca();
    const f = 300 * p;
    const o = g.osc("sine", f, t, t + 0.45, v);
    glide(o.frequency, t, [[0, f], [0.05, f * 1.3], [0.32, f * 0.28]]);
    g.lfo("sine", 15, f * 0.18, o.frequency, t, t + 0.45);
    const v2 = g.vca();
    const o2 = g.osc("triangle", f * 0.5, t, t + 0.35, v2);
    glide(o2.frequency, t, [[0, f * 0.5], [0.28, f * 0.18]]);
    env(v.gain, t, 0.01, 0.55, 0.32, 0.05);
    env(v2.gain, t, 0.01, 0.25 * (0.5 + s), 0.25);
  },

  // Wet fish: a noise burst through a resonant lowpass sweeping down, plus a meaty thump.
  slap(g, t, s, p) {
    const v = g.vca();
    const lp = g.filter("lowpass", 3500 * p, 7, v);
    glide(lp.frequency, t, [[0, 3500 * p], [0.12, 350 * p]]);
    g.noise("white", t, t + 0.25, lp);
    env(v.gain, t, 0.002, 0.7, 0.16);
    const th = g.vca();
    const o = g.osc("sine", 140 * p, t, t + 0.2, th);
    glide(o.frequency, t, [[0, 140 * p], [0.12, 55 * p]]);
    env(th.gain, t, 0.002, 0.45 * (0.4 + s), 0.12);
  },

  // Egg: sharp shell click then a crunchy crackle of tiny bursts.
  crack(g, t, s, p) {
    const c = g.vca();
    g.noise("white", t, t + 0.02, g.filter("highpass", 2500 * p, 1, c));
    env(c.gain, t, 0.0005, 0.8, 0.012);
    const bp = g.filter("bandpass", 3200 * p, 1.5);
    const n = 5 + Math.floor(s * 6);
    for (let i = 0; i < n; i++) {
      const ct = t + 0.008 + rand(0, 0.12);
      const v = g.vca(bp);
      g.noise("white", ct, ct + 0.02, v);
      env(v.gain, ct, 0.0005, rand(0.5, 1.1), rand(0.008, 0.02));
    }
    // Gooey yolk drip after.
    const y = g.vca();
    const o = g.osc("sine", 700 * p, t + 0.12, t + 0.25, y);
    glide(o.frequency, t + 0.12, [[0, 900 * p], [0.08, 300 * p]]);
    env(y.gain, t + 0.12, 0.005, 0.15, 0.07);
  },

  // Generic heavy thud.
  thud(g, t, s, p) {
    const v = g.vca();
    const o = g.osc("sine", 120 * p, t, t + 0.3, v);
    glide(o.frequency, t, [[0, 130 * p], [0.18, 42 * p]]);
    env(v.gain, t, 0.002, 0.8, 0.22);
    const n = g.vca();
    g.noise("brown", t, t + 0.12, g.filter("lowpass", 600, 1, n));
    env(n.gain, t, 0.002, 0.6 * (0.5 + s), 0.08);
  },

  // Spring: "BOOOiiinggg" with a wide, slowing vibrato and a pitch drop.
  boing(g, t, s, p) {
    const dur = 0.5 + s * 0.2;
    const v = g.vca();
    const f = 220 * p;
    const o = g.osc("triangle", f, t, t + dur + 0.05, v);
    glide(o.frequency, t, [[0, f * 0.7], [0.03, f * 1.6], [dur, f * 0.75]]);
    const l = g.lfo("sine", 22, f * 0.35, o.frequency, t, t + dur + 0.05);
    glide(l.osc.frequency, t, [[0, 26], [dur, 9]]);
    l.depth.gain.setValueAtTime(f * 0.35, t);
    l.depth.gain.linearRampToValueAtTime(f * 0.08, t + dur);
    const tw = g.vca();
    g.osc("sine", f * 2.01, t, t + dur, tw);
    env(v.gain, t, 0.005, 0.5, dur * 0.85, 0.05);
    env(tw.gain, t, 0.005, 0.1, dur * 0.5);
  },

  // Glass / ceramic: high bright partials, "tink".
  clink(g, t, s, p) {
    [2100, 3170, 4890, 6650].forEach((f, i) => {
      const v = g.vca();
      g.osc("sine", f * p * rand(0.995, 1.005), t, t + 0.6, v);
      env(v.gain, t, 0.001, (0.22 / (1 + i * 0.5)) * (0.6 + s * 0.4), 0.5 / (1 + i * 0.4));
    });
    const c = g.vca();
    g.noise("white", t, t + 0.01, g.filter("highpass", 6000, 1, c));
    env(c.gain, t, 0.0005, 0.3, 0.006);
  },

  // Soft squish: filtered noise sweep up + a pitch blip.
  squish(g, t, s, p) {
    const v = g.vca();
    const bp = g.filter("bandpass", 400 * p, 4, v);
    glide(bp.frequency, t, [[0, 350 * p], [0.18, 1700 * p]]);
    g.noise("pink", t, t + 0.25, bp);
    env(v.gain, t, 0.02, 2.0, 0.15, 0.03);
    const b = g.vca();
    const o = g.osc("sine", 260 * p, t, t + 0.2, b);
    glide(o.frequency, t, [[0, 240 * p], [0.12, 620 * p]]);
    env(b.gain, t + 0.02, 0.01, 0.3 * (0.5 + s), 0.1);
  },

  // Cartoon bonk: hollow woodblock with a quick pitch drop.
  bonk(g, t, s, p) {
    const v = g.vca();
    const bp = g.filter("bandpass", 900 * p, 3, v);
    const o = g.osc("triangle", 640 * p, t, t + 0.25, bp);
    glide(o.frequency, t, [[0, 700 * p], [0.08, 420 * p]]);
    const o2 = g.osc("sine", 1350 * p, t, t + 0.1, bp);
    glide(o2.frequency, t, [[0, 1400 * p], [0.06, 1000 * p]]);
    env(v.gain, t, 0.001, 1.1 * (0.6 + s * 0.4), 0.16);
    const c = g.vca();
    g.noise("white", t, t + 0.015, g.filter("bandpass", 2500, 1.5, c));
    env(c.gain, t, 0.0005, 0.35, 0.01);
  },
};
