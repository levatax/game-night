// UI and stage cues: clicks, hovers, pops, deny, panel open/close, the countdown tick, time-up buzzer,
// a snare drumroll, a crash cymbal and the whoosh (takas, flying chips).

import { blip, env, glide, noiseHit, rand } from "./kit";
import type { Recipe } from "./casino";

export const UI: Record<"click" | "hover" | "pop" | "deny" | "open" | "close" | "tick" | "timeout" | "drumroll" | "cymbal" | "whoosh", Recipe> = {
  // A short woody click.
  click(k, t, vol, p) {
    const g = k.group(t, 0.08, vol * 0.35);
    if (!g) return;
    blip(g, "triangle", t, [[0, 1500 * p], [0.03, 900 * p]], 0.5, 0.03, 0.001);
    noiseHit(g, "white", t, "bandpass", 3500, 3, 0.25, 0.008, 0.0005);
  },

  hover(k, t, vol, p) {
    const g = k.group(t, 0.06, vol * 0.13);
    if (g) blip(g, "sine", t, [[0, 1700 * p], [0.02, 2100 * p]], 0.4, 0.025);
  },

  pop(k, t, vol, p) {
    const g = k.group(t, 0.15, vol * 0.45);
    if (!g) return;
    blip(g, "sine", t, [[0, 380 * p], [0.025, 1250 * p]], 0.55, 0.06, 0.002);
    noiseHit(g, "white", t, "bandpass", 1800, 2, 0.35, 0.015, 0.001);
  },

  // "Bonk-bonk": not allowed.
  deny(k, t, vol, p) {
    const g = k.group(t, 0.35, vol * 0.3);
    if (!g) return;
    const lp = g.filter("lowpass", 1000, 1);
    blip(g, "square", t, [[0, 233 * p]], 0.45, 0.08, 0.003, lp);
    blip(g, "square", t + 0.11, [[0, 175 * p]], 0.45, 0.12, 0.003, lp);
  },

  // Panel open: two rising vibes notes over a soft air swell.
  open(k, t, vol, p) {
    const g = k.group(t, 0.5, vol * 0.3);
    if (!g) return;
    blip(g, "sine", t, [[0, 659 * p]], 0.4, 0.22, 0.003);
    blip(g, "sine", t + 0.07, [[0, 988 * p]], 0.4, 0.3, 0.003);
    const f = noiseHit(g, "pink", t, "bandpass", 900, 1, 0.25, 0.12, 0.06);
    glide(f.frequency, t, [[0, 600], [0.18, 2200]]);
  },

  // Panel close: the same, falling.
  close(k, t, vol, p) {
    const g = k.group(t, 0.45, vol * 0.26);
    if (!g) return;
    blip(g, "sine", t, [[0, 988 * p]], 0.35, 0.16, 0.003);
    blip(g, "sine", t + 0.06, [[0, 659 * p]], 0.35, 0.22, 0.003);
    const f = noiseHit(g, "pink", t, "bandpass", 1500, 1, 0.2, 0.1, 0.04);
    glide(f.frequency, t, [[0, 2000], [0.15, 600]]);
  },

  // Countdown: a dry woodblock "tock".
  tick(k, t, vol, p) {
    const g = k.group(t, 0.1, vol * 0.42);
    if (!g) return;
    blip(g, "sine", t, [[0, 1800 * p], [0.02, 1500 * p]], 0.5, 0.03, 0.001);
    noiseHit(g, "white", t, "bandpass", 3500, 3, 0.3, 0.01, 0.0005);
  },

  // Time's up: a cheesy game-show "BZZZT" and a little bell (auto KASALA).
  timeout(k, t, vol, p) {
    const g = k.group(t, 0.9, vol * 0.32);
    if (!g) return;
    const v = g.vca();
    const lp = g.filter("lowpass", 1300, 1, v);
    g.osc("sawtooth", 98 * p, t, t + 0.42, lp);
    g.osc("square", 104 * p, t, t + 0.42, g.gain(0.6, lp));
    env(v.gain, t, 0.01, 0.6, 0.06, 0.32);
    const tb = t + 0.45;
    blip(g, "sine", tb, [[0, 1568 * p]], 0.3, 0.4, 0.002);
    blip(g, "sine", tb, [[0, 3136 * p]], 0.1, 0.2, 0.002);
  },

  // Snare roll crescendo with a final hit: one noise source chopped by a fast LFO (cheap).
  drumroll(k, t, vol, p) {
    const D = 1.4;
    const g = k.group(t, D + 0.4, vol * 0.5);
    if (!g) return;
    const v = g.vca();
    const chop = g.gain(0.5, v);
    g.lfo("sawtooth", 24 * p, -0.5, chop.gain, t, t + D);
    g.noise("white", t, t + D, g.filter("bandpass", 2100, 0.8, chop));
    g.osc("triangle", 185 * p, t, t + D, g.gain(0.18, chop));
    v.gain.setValueAtTime(0.0001, t);
    v.gain.linearRampToValueAtTime(0.18, t + 0.05);
    v.gain.exponentialRampToValueAtTime(0.75, t + D);
    v.gain.linearRampToValueAtTime(0.0001, t + D + 0.02);
    const th = t + D;
    noiseHit(g, "white", th, "bandpass", 2000, 0.8, 0.9, 0.16, 0.001);
    blip(g, "sine", th, [[0, 130], [0.12, 50]], 0.8, 0.16, 0.002);
  },

  // Crash cymbal: bright noise wash over a metallic square cluster.
  cymbal(k, t, vol, p) {
    const g = k.group(t, 2.3, vol * 0.4);
    if (!g) return;
    g.send(0.25);
    noiseHit(g, "white", t, "highpass", 5000 * p, 0.7, 0.75, 1.9, 0.003);
    noiseHit(g, "white", t, "bandpass", 8000 * p, 1, 0.4, 1.1, 0.002);
    const mv = g.vca();
    const hp = g.filter("highpass", 7000, 0.7, mv);
    for (const f of [296, 457, 541, 803]) g.osc("square", f * p * rand(0.99, 1.01), t, t + 1.4, hp);
    env(mv.gain, t, 0.002, 0.18, 1.2);
  },

  // Air "fwoosh".
  whoosh(k, t, vol, p) {
    const g = k.group(t, 0.6, vol * 1.1);
    if (!g) return;
    const f = noiseHit(g, "pink", t, "bandpass", 600, 1.2, 1.3, 0.25, 0.15);
    glide(f.frequency, t, [[0, 300 * p], [0.18, 2300 * p], [0.45, 500 * p]]);
  },
};
