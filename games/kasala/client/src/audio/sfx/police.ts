// Raid sounds (§11, §14): the police two-tone siren, Komiser Rıfat kicking the door in, handcuffs, the sack
// over the head, an empty wallet full of moths (and a fly), the mugshot flash, the river splash, the
// "Kara Liste" stamp and the lawyer's papers.

import { Group, Kit, TINK, blip, env, glide, noiseHit, rand, strike } from "./kit";
import { mmph } from "./voices";
import type { Recipe } from "./casino";

/** Step a frequency param through notes, holding each and sliding briefly between them. */
function steps(param: AudioParam, t: number, pts: ReadonlyArray<readonly [number, number]>, slide = 0.03): void {
  param.setValueAtTime(pts[0][1], t + pts[0][0]);
  for (let i = 1; i < pts.length; i++) {
    const at = t + pts[i][0];
    param.setValueAtTime(pts[i - 1][1], at);
    param.linearRampToValueAtTime(pts[i][1], at + slide);
  }
}

/** Little metal part hit (handcuff ratchet teeth, chain links). */
function metal(g: Group, t: number, f: number, peak: number, d: number): void {
  strike(g, t, f, TINK, peak, d);
  noiseHit(g, "white", t, "bandpass", f * 1.6, 2.5, peak * 0.5, 0.01, 0.0005);
}

export const POLICE: Record<"siren" | "doorBreak" | "cuffs" | "sack" | "moths" | "cameraFlash" | "splash" | "stamp" | "paper", Recipe> = {
  // Police two-tone: a wail up into "dee-daa dee-daa", through a crunchy megaphone horn.
  siren(k, t, vol, p) {
    const D = 1.9;
    const g = k.group(t, D + 0.2, vol * 0.15);
    if (!g) return;
    g.send(0.2);
    const v = g.vca();
    const lp = g.filter("lowpass", 2600, 0.8, v);
    const pk = g.filter("peaking", 1150, 2, lp);
    pk.gain.value = 7;
    const sh = g.shaper(pk);
    const hi = 880 * p;
    const lo = 660 * p;
    const pts: Array<[number, number]> = [[0, 360 * p], [0.3, hi]];
    for (let i = 0; i < 5; i++) pts.push([0.3 + (i + 1) * 0.28, i % 2 === 0 ? lo : hi]);
    const o1 = g.osc("square", 360 * p, t, t + D, sh);
    const o2 = g.osc("sawtooth", 360 * p, t, t + D, g.gain(0.6, sh));
    o2.detune.value = 9;
    for (const o of [o1, o2]) {
      o.frequency.setValueAtTime(360 * p, t);
      o.frequency.exponentialRampToValueAtTime(hi, t + 0.3);
      steps(o.frequency, t, pts.slice(1), 0.035);
      o.frequency.linearRampToValueAtTime(lo * 0.85, t + D);
    }
    g.lfo("sine", 7, 7, o1.frequency, t, t + D);
    env(v.gain, t, 0.06, 0.7, 0.3, D - 0.36);
  },

  // Boot meets door: deep impact, wood crack, splinters, the door slamming the wall, hinges rattling.
  doorBreak(k, t, vol, p) {
    const g = k.group(t, 1.3, vol * 0.75);
    if (!g) return;
    g.send(0.25);
    blip(g, "sine", t, [[0, 95 * p], [0.3, 36 * p]], 1.0, 0.36, 0.002);
    noiseHit(g, "brown", t, "lowpass", 420, 1, 0.95, 0.26, 0.002);
    const sh = g.shaper();
    const cv = g.vca(sh);
    g.noise("white", t + 0.008, t + 0.2, g.filter("bandpass", 1800 * p, 0.8, cv));
    env(cv.gain, t + 0.008, 0.001, 0.9, 0.12);
    blip(g, "sawtooth", t + 0.008, [[0, 700 * p], [0.08, 120 * p]], 0.3, 0.1, 0.001);
    for (let i = 0; i < 8; i++) {
      const st = t + 0.04 + Math.pow(Math.random(), 1.4) * 0.45;
      const f0 = rand(500, 1400) * p;
      blip(g, "triangle", st, [[0, f0], [0.05, f0 * 0.6]], rand(0.12, 0.28), 0.06, 0.001);
    }
    const ts = t + 0.32;
    blip(g, "sine", ts, [[0, 115 * p], [0.2, 45 * p]], 0.7, 0.25, 0.002);
    noiseHit(g, "brown", ts, "bandpass", 300, 2, 0.75, 0.15, 0.002);
    metal(g, ts + 0.03, 1900 * p, 0.25, 0.18);
    metal(g, ts + 0.11, 2300 * p, 0.15, 0.12);
  },

  // Handcuffs: a quick ratchet "çık-çık-çık" then CLACK, a chain jingle, and the second wrist.
  cuffs(k, t, vol, p) {
    const g = k.group(t, 1.3, vol * 0.5);
    if (!g) return;
    const ratchet = (t0: number, n: number, peak: number): number => {
      let tt = t0;
      for (let i = 0; i < n; i++) {
        metal(g, tt, rand(2600, 3100) * p, peak, 0.04);
        tt += 0.05 - i * 0.004;
      }
      metal(g, tt + 0.02, 1750 * p, peak * 1.8, 0.25);
      noiseHit(g, "white", tt + 0.02, "bandpass", 2200, 1.5, peak * 1.2, 0.03, 0.0005);
      return tt + 0.02;
    };
    const end = ratchet(t, 6, 0.28);
    for (let i = 0; i < 5; i++) metal(g, end + 0.05 + rand(0, 0.28), rand(3200, 5200) * p, 0.1, 0.08);
    ratchet(end + 0.4, 4, 0.22);
  },

  // A burlap sack over the head: rustle, cloth "fwump", muffled protest, a blind bump into the table.
  sack(k, t, vol, p) {
    const g = k.group(t, 1.4, vol * 0.55);
    if (!g) return;
    const fw = noiseHit(g, "pink", t, "lowpass", 2000, 0.9, 0.8, 0.22, 0.01);
    glide(fw.frequency, t, [[0, 2400], [0.25, 280]]);
    for (let i = 0; i < 7; i++) {
      const rt = t + 0.05 + rand(0, 0.85);
      noiseHit(g, "white", rt, "bandpass", rand(900, 1700), 0.8, rand(0.18, 0.32), rand(0.05, 0.12), 0.02);
    }
    mmph(g, t + 0.32, p);
    const tb = t + 1.0;
    noiseHit(g, "brown", tb, "lowpass", 500, 1, 0.8, 0.12, 0.002);
    blip(g, "sine", tb, [[0, 150], [0.08, 70]], 0.6, 0.12, 0.002);
    for (let i = 0; i < 3; i++) noiseHit(g, "white", tb + 0.05 + i * 0.05, "bandpass", 3600, 4, 0.2, 0.015, 0.0005);
  },

  // Empty wallet: leather creak, moths fluttering out, a lazy fly buzzing past.
  moths(k, t, vol, p) {
    const g = k.group(t, 2.2, vol * 0.75);
    if (!g) return;
    // Leather creak.
    const cv = g.vca();
    const cbp = g.filter("bandpass", 900, 8, cv);
    const co = g.osc("sawtooth", 70, t, t + 0.3, cbp);
    g.lfo("square", 31, 14, co.frequency, t, t + 0.3);
    env(cv.gain, t, 0.03, 0.5, 0.12, 0.12);
    // Three moths: wing-beat AM on wandering bands of noise.
    for (let i = 0; i < 3; i++) {
      const mt = t + 0.25 + i * 0.18;
      const len = rand(0.7, 1.0);
      const v = g.vca();
      const am = g.gain(0.5, v);
      g.lfo("square", rand(17, 25), 0.5, am.gain, mt, mt + len);
      const bp = g.filter("bandpass", rand(700, 1300) * p, 2, am);
      g.lfo("sine", rand(1.2, 2.2), 260, bp.frequency, mt, mt + len);
      g.noise("white", mt, mt + len, bp);
      env(v.gain, mt, 0.12, 0.45, 0.3, len - 0.42);
    }
    // The fly: buzzy saw wandering around, swelling past.
    const ft = t + 0.55;
    const fl = 1.3;
    const fv = g.vca();
    const fbp = g.filter("bandpass", 650, 1.5, fv);
    const fo = g.osc("sawtooth", 190 * p, ft, ft + fl, fbp);
    g.lfo("sine", 3.1, 22, fo.frequency, ft, ft + fl);
    g.lfo("sine", 7.3, 9, fo.frequency, ft, ft + fl);
    fv.gain.setValueAtTime(0.0001, ft);
    fv.gain.linearRampToValueAtTime(0.32, ft + fl * 0.45);
    fv.gain.linearRampToValueAtTime(0.0001, ft + fl);
  },

  // Mugshot flash: capacitor whine, POP, shutter "ka-chk", fizzle.
  cameraFlash(k, t, vol, p) {
    const g = k.group(t, 0.9, vol * 0.5);
    if (!g) return;
    blip(g, "sine", t, [[0, 2200 * p], [0.11, 8200 * p]], 0.08, 0.04, 0.09);
    const tp = t + 0.11;
    noiseHit(g, "white", tp, "bandpass", 2400, 0.6, 1.0, 0.06, 0.0005);
    blip(g, "sine", tp, [[0, 170], [0.07, 60]], 0.6, 0.09, 0.001);
    noiseHit(g, "white", tp + 0.05, "bandpass", 3800, 4, 0.35, 0.015, 0.0005);
    noiseHit(g, "white", tp + 0.085, "bandpass", 2900, 4, 0.3, 0.02, 0.0005);
    noiseHit(g, "white", tp + 0.02, "highpass", 6000, 0.7, 0.14, 0.4, 0.01);
  },

  // Cement shoes into the river: plop, splash, droplets, a few sad bubbles.
  splash(k, t, vol, p) {
    const g = k.group(t, 1.9, vol * 0.6);
    if (!g) return;
    g.send(0.15);
    blip(g, "sine", t, [[0, 540 * p], [0.12, 85 * p]], 0.8, 0.14, 0.002);
    const sw = noiseHit(g, "white", t + 0.01, "lowpass", 6000, 0.8, 0.9, 0.5, 0.005);
    glide(sw.frequency, t + 0.01, [[0, 6500], [0.55, 600]]);
    noiseHit(g, "pink", t + 0.01, "bandpass", 900, 1.2, 0.6, 0.35, 0.004);
    for (let i = 0; i < 8; i++) {
      const dt = t + 0.18 + rand(0, 0.7);
      const f0 = rand(800, 1900) * p;
      blip(g, "sine", dt, [[0, f0], [0.04, f0 * 1.7]], rand(0.08, 0.18), 0.045, 0.002);
    }
    for (let i = 0; i < 6; i++) {
      const bt = t + 1.0 + i * 0.1 + rand(0, 0.05);
      const f0 = rand(300, 600) * p;
      blip(g, "sine", bt, [[0, f0], [0.06, f0 * 1.9]], 0.1 * (1 - i * 0.12), 0.06, 0.004);
    }
  },

  // Rubber stamp: a light tap, then KA-THUNK with a paper slap and an inky squish.
  stamp(k, t, vol, p) {
    const g = k.group(t, 0.6, vol * 0.7);
    if (!g) return;
    noiseHit(g, "brown", t, "lowpass", 900, 1, 0.3, 0.03, 0.001);
    const tm = t + 0.08;
    blip(g, "sine", tm, [[0, 230 * p], [0.12, 75 * p]], 0.95, 0.14, 0.001);
    noiseHit(g, "brown", tm, "lowpass", 1300, 1, 0.8, 0.06, 0.001);
    noiseHit(g, "white", tm, "highpass", 2200, 0.8, 0.45, 0.035, 0.0005);
    noiseHit(g, "pink", tm + 0.02, "bandpass", 700, 3, 0.25, 0.1, 0.005);
  },

  // The lawyer's papers: rustle, page flaps, a confident slap on the table.
  paper(k, t, vol, p) {
    const g = k.group(t, 0.8, vol * 0.5);
    if (!g) return;
    for (let i = 0; i < 4; i++) {
      const rt = t + i * 0.09 + rand(0, 0.03);
      const v = g.vca();
      const am = g.gain(0.6, v);
      g.lfo("square", rand(30, 45), 0.4, am.gain, rt, rt + 0.16);
      g.noise("white", rt, rt + 0.16, g.filter("bandpass", rand(2500, 5000) * p, 0.7, am));
      env(v.gain, rt, 0.015, rand(0.3, 0.45), 0.1);
    }
    const tf = t + 0.38;
    const f = noiseHit(g, "pink", tf, "bandpass", 1500, 1, 0.5, 0.1, 0.02);
    glide(f.frequency, tf, [[0, 900 * p], [0.12, 2200 * p]]);
    const tsl = t + 0.52;
    noiseHit(g, "white", tsl, "highpass", 1800, 0.7, 0.7, 0.04, 0.0008);
    blip(g, "sine", tsl, [[0, 190], [0.06, 90]], 0.35, 0.07, 0.001);
  },
};
