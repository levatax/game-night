// Adaptive resolution inside the chosen quality tier (adapted from the "auto" ladder in
// games/kasala/client/src/scene/Stage.ts): 1 s windows of frame deltas; two slow windows (mean > 1.2× the
// refresh goal) step the pixel-ratio scale down, five fast ones (< 1.05×) step it back up, and a step down soon
// after a step up blocks further step-ups for 30 s, 60 s, … (no thrashing). Only the canvas resolution changes —
// never a shader — so it is invisible apart from sharpness. Owner: client-render.

const LADDER = [0.6, 0.72, 0.85, 1] as const;

export class FrameGovernor {
  /** Current multiplier on the tier's pixel ratio. */
  scale = 1;
  /** Called when `scale` changes (Renderer resizes the canvas). */
  onChange: (() => void) | null = null;

  private level = LADDER.length - 1;
  private readonly win = new Float32Array(240);
  private n = 0;
  private sum = 0;
  private last = 0;
  private slow = 0;
  private fast = 0;
  private settleUntil = 0;
  private lastUpAt = -Infinity;
  private upBlockedUntil = 0;
  private upBackoff = 30000;

  /** Reset after a quality change / island load (those frames are not representative). */
  reset(now: number): void {
    this.level = LADDER.length - 1;
    this.scale = 1;
    this.n = 0;
    this.sum = 0;
    this.slow = 0;
    this.fast = 0;
    this.settleUntil = now + 2500;
  }

  /** Call once per rendered frame with performance.now(). */
  frame(now: number): void {
    const last = this.last;
    this.last = now;
    if (last === 0) return;
    const d = now - last;
    if (d > 250 || (typeof document !== "undefined" && document.hidden)) {
      this.n = 0;
      this.sum = 0;
      return;
    }
    if (now < this.settleUntil) return;
    this.win[this.n++] = d;
    this.sum += d;
    if (this.sum < 1000 && this.n < this.win.length) return;
    const n = this.n;
    const mean = this.sum / n;
    const sorted = this.win.subarray(0, n).sort();
    const refresh = Math.min(20, Math.max(4, sorted[Math.floor(n * 0.1)] ?? 16.7));
    this.n = 0;
    this.sum = 0;
    const goal = Math.max(refresh, 1000 / 61);
    if (mean > goal * 1.2) {
      this.fast = 0;
      if (++this.slow >= 2) this.step(-1, now);
    } else if (mean < goal * 1.05) {
      this.slow = 0;
      if (++this.fast >= 5) this.step(1, now);
    } else {
      this.slow = 0;
      this.fast = 0;
    }
  }

  private step(dir: -1 | 1, now: number): void {
    this.slow = 0;
    this.fast = 0;
    const next = Math.max(0, Math.min(LADDER.length - 1, this.level + dir));
    if (next === this.level) return;
    if (dir > 0 && now < this.upBlockedUntil) return;
    if (dir < 0 && now - this.lastUpAt < 20000) {
      this.upBlockedUntil = now + this.upBackoff;
      this.upBackoff = Math.min(300000, this.upBackoff * 2);
    }
    if (dir > 0) this.lastUpAt = now;
    this.level = next;
    this.scale = LADDER[next]!;
    this.settleUntil = now + 2000;
    this.onChange?.();
  }
}
