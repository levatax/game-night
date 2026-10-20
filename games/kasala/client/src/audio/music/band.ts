// The smoky lounge jazz band (§15): walking upright bass, brushes + ride, Rhodes/vibes comping and an
// improvising vibraphone, in F minor at ~92 bpm. Hand-written 8-bar sections are chained at random with
// tritone subs, comping rhythms and phrases are re-rolled every bar, so the tune never audibly loops.
// Styles: "lobby" (full band + lead), "lounge" (in-game: softer pads, rare fills, room for Cemil Abi),
// "swing" (victory: a brassy big-band shout chorus, then a brighter A♭-major swing).

import type { Inst } from "./inst";
import { type Gen, JAWS, LONE_HAT, type LayerOut, SWING, hum, tensionMix } from "./layer";
import {
  type Chord,
  type PNote,
  type Section,
  F_MINOR,
  JAZZ,
  JAZZ_NEXT,
  SWING as SWING_SECTIONS,
  SWING_NEXT,
  bassNear,
  improvise,
  pickOf,
  varySection,
  voiceLead,
  walk,
  weightedPick,
} from "./theory";

export type BandStyle = "lobby" | "lounge" | "swing";

/** Comping rhythms for one-chord bars: [eighth, length in eighths]. Eighth 7 anticipates the next bar. */
const COMP_ONE: Array<Array<[number, number]>> = [
  [[0, 3], [3, 1]],
  [[0, 6]],
  [[1, 1], [4, 2]],
  [[2, 1], [6, 1]],
  [[0, 2], [5, 2]],
  [[3, 2], [7, 2]],
];
/** Pad-ish rhythms the lounge style prefers. */
const COMP_PAD: Array<Array<[number, number]>> = [[[0, 7]], [[0, 3], [4, 3]], [[0, 5], [7, 2]]];
/** Two-chord bars. */
const COMP_TWO: Array<Array<[number, number]>> = [
  [[0, 3], [4, 3]],
  [[0, 2], [3, 1], [4, 2]],
  [[1, 2], [5, 2]],
  [[0, 1], [3, 1], [7, 2]],
];

const STING_BEATS = 8;

export class BandGen implements Gen {
  readonly spb: number;
  private style: BandStyle;
  private readonly sections: Section[];
  private readonly nextW: number[][];
  private secIdx: number;
  private sec: Section;
  private upcomingIdx: number;
  private upcoming: Section;
  private barInSec = 0;
  private k = 0;
  private newSection = false;
  private lastBass = 41;
  private voicing: number[] | null = null;
  private comp: Array<[number, number]> = [];
  private lead: { notes: PNote[]; startK: number } | null = null;
  private lastLead = 72;
  private lastRhythm: Array<[number, number]> | undefined;
  private sting: number;
  private stopCrackle: (() => void) | null = null;

  constructor(
    private readonly inst: Inst,
    private readonly out: LayerOut,
    style: BandStyle,
    t0: number,
  ) {
    this.style = style;
    const swing = style === "swing";
    this.spb = 60 / (swing ? 112 : 92);
    this.sections = swing ? SWING_SECTIONS : JAZZ;
    this.nextW = swing ? SWING_NEXT : JAZZ_NEXT;
    this.secIdx = swing ? 0 : Math.floor(Math.random() * this.sections.length);
    this.sec = varySection(this.sections[this.secIdx]);
    this.upcomingIdx = weightedPick(this.nextW[this.secIdx]);
    this.upcoming = varySection(this.sections[this.upcomingIdx]);
    this.sting = swing ? STING_BEATS : 0;
    if (!swing) this.stopCrackle = inst.crackleBed(t0, 0.05, out.bus);
  }

  /** Lobby ↔ lounge keep the song position (same layer, different arrangement). */
  setStyle(style: BandStyle): void {
    if (this.style === "swing") return;
    this.style = style;
  }

  dispose(): void {
    this.stopCrackle?.();
    this.stopCrackle = null;
  }

  beat(t: number, tension: number): void {
    if (this.sting > 0) {
      this.stingBeat(t, STING_BEATS - this.sting);
      this.sting--;
      return;
    }
    const bib = this.k % 4;
    if (bib === 0) this.startBar();
    const bar = this.sec[this.barInSec];
    const two = bar.length === 2;
    const ci = two && bib >= 2 ? 1 : 0;
    const ch = bar[ci];
    const nextBarChord = this.nextBarChord();
    const next = two && ci === 0 ? bar[1] : nextBarChord;
    const kIn = two ? bib % 2 : bib;
    const len = two ? 2 : 4;
    const mix = tensionMix(tension);
    const spb = this.spb;
    const sw = (e: number): number => (e % 2 === 1 ? t + spb * SWING : t);
    const { inst, out } = this;
    const lounge = this.style === "lounge";
    const soft = lounge ? 0.85 : 1;

    // ---- bass
    if (mix.bass === "walk") {
      const n = walk(ch, next, kIn, len, this.lastBass);
      this.lastBass = n;
      inst.bass(t + hum(), n, (kIn === 0 ? 0.36 : 0.3) * soft, spb * 0.92, out.bus);
      if (bib === 3 && Math.random() < 0.16) inst.bass(sw(1), n, 0.12 * soft, spb * 0.28, out.bus);
    } else if (mix.bass === "two") {
      if (bib % 2 === 0) {
        const n = bib === 0 ? bassNear(ch.pc, this.lastBass) : bassNear(ch.pc + 7, this.lastBass);
        this.lastBass = n;
        inst.bass(t, n, 0.34, spb * 1.8, out.bus);
      }
    } else {
      const root = bassNear(ch.pc, 36);
      const intensity = Math.min(1, Math.max(0, (tension - JAWS) / (1 - JAWS)));
      inst.bass(t, bib % 2 === 0 ? root : root + 1, 0.3 + 0.14 * intensity, spb * 0.5, out.bus);
      if (intensity > 0.6) inst.bass(t + spb / 2, bib % 2 === 0 ? root : root + 1, 0.18, spb * 0.3, out.bus);
    }

    // ---- comping
    if (mix.comp > 0.01) {
      for (const [e, l] of this.comp) {
        if (e < bib * 2 || e > bib * 2 + 1) continue;
        const chord = e === 7 ? nextBarChord : e >= 4 && two ? bar[1] : bar[0];
        this.voicing = voiceLead(chord, this.voicing);
        const at = sw(e) + hum();
        const durS = Math.max(0.25, l * (spb / 2) * 0.95 + 0.1);
        const vel = (lounge ? 0.06 : 0.072) * mix.comp;
        this.voicing.forEach((m, i) => inst.rhodes(at + i * 0.008, m, durS, vel, out.keys));
        if (this.style !== "lounge" && e === 0 && Math.random() < 0.3) {
          const top = this.voicing[this.voicing.length - 1];
          inst.vibe(at, top + 12, 1.2, 0.035 * mix.comp, out.vib);
        }
        if (this.style === "swing" && e % 2 === 1) this.voicing.forEach((m) => inst.vibe(at, m + 12, 0.5, 0.022 * mix.comp, out.vib));
      }
    }

    // ---- lead
    if (this.lead && mix.lead > 0.01) {
      const j = this.k - this.lead.startK;
      for (const [e, m, l] of this.lead.notes) {
        if (e < j * 2 || e > j * 2 + 1) continue;
        const at = (e % 2 === 1 ? t + spb * SWING : t) + hum();
        const longNote = l >= 3;
        const vel = (lounge ? 0.06 : 0.085) * mix.lead * (longNote ? 1.1 : 1) * (0.85 + Math.random() * 0.3);
        inst.vibe(at, m, Math.max(0.4, l * (spb / 2) + 0.35), vel, out.vib);
        if (this.style === "swing" && longNote) inst.vibe(at + 0.01, m - 12, 0.9, vel * 0.5, out.vib);
        this.lastLead = m;
      }
    }

    // ---- drums
    const d = mix.drums * soft;
    if (d > 0.01) {
      inst.brush(t, 0.032 * d, spb * 0.95, true, out.bus);
      if (bib % 2 === 1) inst.brush(t + hum(), 0.085 * d, 0.14, false, out.bus);
      inst.ride(t + hum(), (bib % 2 === 1 ? 0.045 : 0.034) * d * (this.style === "swing" ? 1.2 : 1), out.bus);
      if (bib % 2 === 1) inst.ride(sw(1), 0.024 * d, out.bus);
      inst.kick(t, (lounge ? 0.04 : 0.055) * d, out.bus);
      if (this.barInSec === 7 && bib === 3) {
        for (let i = 0; i < 3; i++) inst.brush(t + (i * spb) / 3, (0.06 + i * 0.02) * d, 0.1, false, out.bus);
        if (Math.random() < 0.5) inst.kick(sw(1), 0.1 * d, out.bus);
      }
      if (this.newSection && bib === 0) inst.crash(t, 0.028 * d, 1.5, out.bus);
    }
    // Foot hi-hat on 2 & 4 — the "lone hi-hat" once the band has thinned out.
    if (bib % 2 === 1 && mix.hat > 0.01) {
      const lone = tension >= LONE_HAT;
      inst.hat(t, (lone ? 0.06 : 0.032) * mix.hat, out.bus);
      if (lone && bib === 3 && Math.random() < 0.35) inst.hat(sw(1), 0.025 * mix.hat, out.bus);
    }

    this.newSection = false;
    this.k++;
  }

  private nextBarChord(): Chord {
    return this.barInSec < 7 ? this.sec[this.barInSec + 1][0] : this.upcoming[0][0];
  }

  private startBar(): void {
    if (this.k > 0) this.barInSec++;
    if (this.barInSec >= 8) {
      this.barInSec = 0;
      this.secIdx = this.upcomingIdx;
      this.sec = this.upcoming;
      this.upcomingIdx = weightedPick(this.nextW[this.secIdx]);
      this.upcoming = varySection(this.sections[this.upcomingIdx]);
      this.newSection = true;
    }
    const bar = this.sec[this.barInSec];
    if (bar.length === 2) this.comp = pickOf(COMP_TWO);
    else if (this.style === "lounge") this.comp = Math.random() < 0.7 ? pickOf(COMP_PAD) : pickOf(COMP_ONE);
    else this.comp = pickOf(COMP_ONE);

    // A new 2-bar lead slot?
    if (this.barInSec % 2 === 0) {
      const chance = this.style === "lobby" ? 0.62 : this.style === "swing" ? 0.78 : this.barInSec === 6 ? 0.3 : 0;
      this.lead = null;
      if (Math.random() < chance) {
        const bars = [this.sec[this.barInSec], this.sec[this.barInSec + 1] ?? this.upcoming[0]];
        const chordAt = (e: number): Chord => {
          const b = bars[Math.min(1, Math.floor(e / 8))];
          return b.length === 2 && e % 8 >= 4 ? b[1] : b[0];
        };
        const reuse = this.lastRhythm && Math.random() < 0.35 ? this.lastRhythm : undefined;
        const { notes, rhythm } = improvise(chordAt, this.lastLead, 65, 84, F_MINOR, reuse);
        this.lastRhythm = rhythm;
        this.lead = { notes, startK: this.k };
      }
    }
  }

  /** Victory shout chorus: "BAP … ba DAP, ba-da DAAAAH" with a snare fill, a crash and a brass fall-off. */
  private stingBeat(t: number, j: number): void {
    const { inst, out, spb } = this;
    const off = t + spb * SWING;
    const AB6 = [8, 0, 3, 5];
    const BBM7 = [10, 1, 5, 8];
    const EB7 = [3, 7, 10, 1];
    const AB69 = [8, 0, 3, 5, 10];
    const hit = (at: number, top: number, pcs: number[], dur: number, opts: { scoop?: boolean; fall?: boolean } = {}): void => {
      const notes = [top];
      let n = top - 1;
      while (notes.length < 4 && n > top - 14) {
        if (pcs.includes(((n % 12) + 12) % 12)) notes.push(n);
        n--;
      }
      notes.forEach((m, i) => inst.brass(at + i * 0.004, m, dur, i === 0 ? 1 : 0.8, out.mel, opts));
      inst.brass(at, notes[notes.length - 1] - 12, dur, 0.6, out.mel, opts);
    };
    switch (j) {
      case 0:
        hit(t, 72, AB6, 0.2, { scoop: true });
        inst.kick(t, 0.3, out.bus);
        inst.bass(t, 44, 0.4, 0.2, out.bus);
        inst.crash(t, 0.04, 0.8, out.bus);
        break;
      case 1:
        hit(off, 73, BBM7, 0.15);
        inst.snare(off, 0.12, out.bus);
        break;
      case 2:
        hit(t, 75, AB6, 0.2);
        inst.kick(t, 0.25, out.bus);
        inst.bass(t, 46, 0.36, 0.2, out.bus);
        break;
      case 3:
        hit(t, 77, BBM7, 0.15);
        hit(off, 79, EB7, 0.15);
        for (let i = 0; i < 3; i++) inst.snare(t + (i * spb) / 3, 0.08 + i * 0.03, out.bus);
        inst.bass(off, 39, 0.34, 0.15, out.bus);
        break;
      case 4:
        hit(t, 80, AB69, spb * 3.4, { scoop: true, fall: true });
        inst.kick(t, 0.38, out.bus);
        inst.crash(t, 0.09, 2.4, out.bus);
        inst.timpani(t, 32, 0.4, 1.6, out.bus);
        inst.bass(t, 32, 0.42, spb * 3, out.bus);
        [68, 72, 75, 77, 80].forEach((m) => inst.vibe(t, m + 12, 2.2, 0.03, out.vib));
        break;
      default:
        inst.hat(t, 0.04, out.bus);
        if (j === 7) inst.hat(off, 0.03, out.bus);
        break;
    }
  }
}
