// Patronun Çarkı (§7, §15): the jazz stops, a stage snare roll crescendos while the wheel spins, cymbal
// swells every two bars and timpani climb a step at a time. No harmony. After the spin it eases back to a
// simmering roll while the result is held.

import type { Inst } from "./inst";
import type { Gen, LayerOut } from "./layer";

const BUILD_SEC = 6.5;
const HOLD_AFTER_SEC = 9;

export class WheelGen implements Gen {
  readonly spb = 60 / 92;
  private k = 0;
  private t0: number | null = null;

  constructor(
    private readonly inst: Inst,
    private readonly out: LayerOut,
  ) {}

  dispose(): void {}

  private level(el: number): number {
    if (el < HOLD_AFTER_SEC) return 0.25 + 0.75 * Math.min(1, el / BUILD_SEC);
    return 0.6 + 0.12 * Math.sin(el * 1.3);
  }

  beat(t: number): void {
    if (this.t0 === null) this.t0 = t;
    const { inst, out, spb } = this;
    const el = t - this.t0;
    const a = this.level(el);
    const b = this.level(el + spb);
    const rate = 15 + 6 * Math.min(1, el / BUILD_SEC);
    inst.roll(t, spb, rate, a * 0.2, b * 0.2, out.bus);
    if (this.k % 8 === 0) inst.swell(t, spb * 8, 0.003, 0.03 * this.level(el + spb * 8), out.bus);
    if (this.k % 4 === 0) {
      const step = Math.min(4, Math.floor(this.k / 8));
      inst.timpani(t, [29, 31, 32, 34, 36][step], 0.26 * a + 0.08, 1.1, out.bus);
    } else if (this.k % 4 === 2) inst.timpani(t, 29, 0.12 * a, 0.7, out.bus);
    this.k++;
  }
}

/** "off": silent, but its beat clock still drives the heartbeat. */
export class SilentGen implements Gen {
  readonly spb = 60 / 92;
  beat(): void {}
  dispose(): void {}
}
