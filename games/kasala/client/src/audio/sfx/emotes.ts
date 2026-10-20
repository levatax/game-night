// Character sounds: emotes (§11: table punch, kiss, crying, cigar, counting money lives in casino.ts), the
// mumbles ("ooo!", "yok artık!", "hah!"), laughs and boos, and a one-shot heartbeat.

import { Group, Kit, TINK, blip, env, glide, noiseHit, rand, strike } from "./kit";
import { boo, cry, hah, kiss, laugh, ooh, yokArtik } from "./voices";
import type { Recipe } from "./casino";

/** Low "lub" thump with a triangle overtone so laptop speakers hear it. */
export function thump(g: Group, t: number, f: number, peak: number): void {
  const v = g.vca();
  const o = g.osc("sine", f * 1.7, t, t + 0.3, v);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.06);
  g.osc("triangle", f * 2, t, t + 0.3, g.gain(0.6, g.filter("lowpass", 260, 0.7, v)));
  env(v.gain, t, 0.005, peak, 0.22);
}

export const EMOTES: Record<"punchTable" | "cigar" | "heartbeat" | "ooh" | "yokArtik" | "hah" | "boo" | "laugh" | "kiss" | "cry", Recipe> = {
  // Fist on the table: BAM, wood knock, chips and cards jumping, a glass clinking.
  punchTable(k, t, vol, p) {
    const g = k.group(t, 1.0, vol * 0.75);
    if (!g) return;
    blip(g, "sine", t, [[0, 135 * p], [0.25, 42 * p]], 1.0, 0.3, 0.002);
    noiseHit(g, "brown", t, "bandpass", 260 * p, 2, 0.85, 0.15, 0.001);
    blip(g, "triangle", t, [[0, 185 * p], [0.2, 150 * p]], 0.3, 0.25, 0.002);
    for (let i = 0; i < 6; i++) {
      const ct = t + 0.11 + rand(0, 0.35);
      noiseHit(g, "white", ct, "bandpass", rand(3000, 4200), 4, rand(0.2, 0.4), 0.018, 0.0005);
    }
    strike(g, t + 0.14, 2700 * p, TINK, 0.12, 0.35);
  },

  // Zippo clink, flint scratch, flame "fwomp", crackling cigar, then smoke blown in your face.
  cigar(k, t, vol, p) {
    const g = k.group(t, 2.1, vol * 0.5);
    if (!g) return;
    strike(g, t, 2350 * p, TINK, 0.35, 0.2);
    noiseHit(g, "white", t + 0.18, "bandpass", 3600, 2, 0.5, 0.06, 0.002);
    const fl = noiseHit(g, "pink", t + 0.22, "lowpass", 700, 0.8, 0.55, 0.3, 0.05);
    glide(fl.frequency, t + 0.22, [[0, 400], [0.08, 1300], [0.35, 600]]);
    for (let i = 0; i < 14; i++) {
      const ct = t + 0.45 + rand(0, 0.7);
      noiseHit(g, "white", ct, "highpass", rand(3500, 6000), 1, rand(0.12, 0.3), 0.006, 0.0004);
    }
    noiseHit(g, "white", t + 0.45, "highpass", 5200, 0.7, 0.06, 0.55, 0.1);
    const te = t + 1.15;
    const ex = noiseHit(g, "pink", te, "bandpass", 900, 0.8, 0.55, 0.55, 0.22);
    glide(ex.frequency, te, [[0, 700 * p], [0.25, 1100 * p], [0.75, 600 * p]]);
  },

  // Lub-dub.
  heartbeat(k, t, vol, p) {
    const g = k.group(t, 0.6, vol * 0.85);
    if (!g) return;
    thump(g, t, 55 * p, 0.55);
    thump(g, t + 0.18, 52 * p, 0.38);
  },

  ooh(k, t, vol, p) {
    ooh(k, t, vol, p);
  },
  yokArtik(k, t, vol, p) {
    yokArtik(k, t, vol, p);
  },
  hah(k, t, vol, p) {
    hah(k, t, vol, p);
  },
  boo(k, t, vol, p) {
    boo(k, t, vol, p);
  },
  laugh(k, t, vol, p) {
    laugh(k, t, vol, p);
  },
  kiss(k, t, vol, p) {
    kiss(k, t, vol, p);
  },
  cry(k, t, vol, p) {
    cry(k, t, vol, p);
  },
};
