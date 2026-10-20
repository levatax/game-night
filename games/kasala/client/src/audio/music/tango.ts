// SON MASA tango (§10, §15): F minor, 116 bpm, straight eighths. Bass + piano stabs on the 3-3-2 and
// "marcato en cuatro" rhythms, bandoneon pads that swell into the downbeat (arrastre), an improvised
// bandoneon melody in harmonic minor, body knocks, the violin "chicharra" scrape and dramatic breaks with a
// chromatic run into the next section. Thins out with tension like the band.

import type { Inst } from "./inst";
import { type Gen, LONE_HAT, type LayerOut, hum, tensionMix } from "./layer";
import { type Chord, type PNote, type Section, TANGO, TANGO_NEXT, bassNear, closeVoicing, improvise, weightedPick } from "./theory";

type Pattern = "332" | "marcato" | "break";
const HITS: Record<Pattern, number[]> = {
  "332": [0, 3, 6],
  marcato: [0, 2, 4, 6],
  break: [0],
};
/** F harmonic minor. */
const F_HARMONIC = [5, 7, 8, 10, 0, 1, 4];

export class TangoGen implements Gen {
  readonly spb = 60 / 116;
  private secIdx = 0;
  private sec: Section;
  private upcomingIdx: number;
  private upcoming: Section;
  private barInSec = 0;
  private k = 0;
  private pattern: Pattern = "332";
  private lastBass = 41;
  private lead: { notes: PNote[]; startK: number } | null = null;
  private lastLead = 72;

  constructor(
    private readonly inst: Inst,
    private readonly out: LayerOut,
  ) {
    this.sec = TANGO[0];
    this.upcomingIdx = weightedPick(TANGO_NEXT[0]);
    this.upcoming = TANGO[this.upcomingIdx];
  }

  dispose(): void {}

  beat(t: number, tension: number): void {
    const bib = this.k % 4;
    if (bib === 0) this.startBar();
    const ch = this.sec[this.barInSec][0];
    const next = this.barInSec < 7 ? this.sec[this.barInSec + 1][0] : this.upcoming[0][0];
    const mix = tensionMix(tension);
    const { inst, out, spb } = this;
    const at = (e: number): number => t + (e % 2) * (spb / 2);

    if (mix.bass === "walk") {
      for (const e of HITS[this.pattern]) {
        if (e < bib * 2 || e > bib * 2 + 1) continue;
        const accent = e === 0 || (this.pattern === "marcato" && e === 4);
        const n = e === 3 || e === 4 ? bassNear(ch.pc + 7, this.lastBass) : bassNear(ch.pc, this.lastBass);
        this.lastBass = n;
        const time = at(e) + hum();
        inst.bass(time, n, accent ? 0.44 : 0.32, spb * (this.pattern === "break" ? 1.2 : 0.4), out.bus);
        if (mix.comp > 0.01) {
          const notes = closeVoicing(ch, 55);
          notes.forEach((m) => inst.piano(time, m, accent ? 0.3 : 0.18, (accent ? 0.5 : 0.34) * mix.comp, out.mel));
        }
        if (mix.drums > 0.01 && accent) inst.knock(time, 0.12 * mix.drums, out.bus);
      }
    } else if (mix.bass === "two") {
      if (bib % 2 === 0) {
        const n = bib === 0 ? bassNear(ch.pc, this.lastBass) : bassNear(ch.pc + 7, this.lastBass);
        this.lastBass = n;
        inst.bass(t, n, 0.36, spb * 1.6, out.bus);
      }
    } else {
      const root = bassNear(ch.pc, 36);
      inst.bass(t, bib % 2 === 0 ? root : root + 1, 0.36, spb * 0.5, out.bus);
      inst.bass(t + spb / 2, bib % 2 === 0 ? root : root + 1, 0.2, spb * 0.3, out.bus);
    }

    // Bandoneon pad: on odd bars it swells into the next downbeat (arrastre).
    if (bib === 0 && mix.comp > 0.01 && this.pattern !== "break") {
      const swell = this.barInSec % 2 === 1;
      const notes = closeVoicing(ch, 60).slice(1);
      notes.forEach((m) => inst.bandoneon(t, m, spb * 4 - 0.02, (swell ? 0.75 : 0.5) * mix.comp, out.mel, swell));
    }

    // Violin chicharra on the "and" of 4, every other bar.
    if (bib === 3 && this.barInSec % 2 === 1 && mix.drums > 0.01 && this.pattern !== "break") {
      inst.chicharra(t + spb / 2, 0.22, 0.05 * mix.drums, out.bus);
    }

    // Lead melody.
    if (mix.lead > 0.01) {
      if (this.pattern === "break" && bib >= 2) {
        // Sixteenth-note chromatic run up into the next chord's root.
        const target = 65 + ((next.pc - 65 + 120) % 12) + 12;
        for (let i = 0; i < 4; i++) {
          const idx = (bib - 2) * 4 + i;
          inst.bandoneon(t + (i * spb) / 4, target - 8 + idx, spb / 4 - 0.01, 0.9 * mix.lead, out.mel);
        }
      } else if (this.lead) {
        const j = this.k - this.lead.startK;
        for (const [e, m, l] of this.lead.notes) {
          if (e < j * 2 || e > j * 2 + 1) continue;
          const accent = e % 4 === 0;
          inst.bandoneon(at(e), m, l * (spb / 2) * (l >= 2 ? 0.92 : 0.7), (accent ? 1 : 0.8) * mix.lead, out.mel);
          this.lastLead = m;
        }
      }
    }

    // The lone hi-hat when tense.
    if (tension >= LONE_HAT && bib % 2 === 1 && mix.hat > 0.01) inst.hat(t, 0.055 * mix.hat, out.bus);

    this.k++;
  }

  private startBar(): void {
    if (this.k > 0) this.barInSec++;
    if (this.barInSec >= 8) {
      this.barInSec = 0;
      this.secIdx = this.upcomingIdx;
      this.sec = this.upcoming;
      this.upcomingIdx = weightedPick(TANGO_NEXT[this.secIdx]);
      this.upcoming = TANGO[this.upcomingIdx];
    }
    this.pattern = this.barInSec === 7 && Math.random() < 0.6 ? "break" : this.barInSec % 2 === 0 ? "332" : Math.random() < 0.6 ? "marcato" : "332";
    if (this.barInSec % 2 === 0) {
      this.lead = null;
      if (Math.random() < 0.6) {
        const bars = [this.sec[this.barInSec][0], (this.sec[this.barInSec + 1] ?? this.upcoming[0])[0]];
        const chordAt = (e: number): Chord => bars[Math.min(1, Math.floor(e / 8))];
        this.lead = { notes: improvise(chordAt, this.lastLead, 65, 86, F_HARMONIC).notes, startK: this.k };
      }
    }
  }
}
