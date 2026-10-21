// FrameGovernor: adaptive resolution steps down on slow frames, back up on fast ones, with back-off. Owner:
// client-render.

import { describe, expect, it } from "vitest";
import { FrameGovernor } from "./FrameGovernor";

/** Feed `sec` seconds of frames `ms` apart starting at `t0`; returns the end time. */
function feed(g: FrameGovernor, t0: number, ms: number, sec: number): number {
  let t = t0;
  const end = t0 + sec * 1000;
  while (t < end) {
    t += ms;
    g.frame(t);
  }
  return t;
}

describe("FrameGovernor", () => {
  it("keeps full resolution at 60 fps", () => {
    const g = new FrameGovernor();
    g.reset(0);
    feed(g, 0, 16.7, 20);
    expect(g.scale).toBe(1);
  });

  it("steps down after two slow windows and notifies", () => {
    const g = new FrameGovernor();
    let changes = 0;
    g.onChange = () => changes++;
    g.reset(0);
    // 60 Hz display, GPU-bound at 33 ms after the settle period.
    let t = feed(g, 0, 16.7, 3);
    t = feed(g, t, 33, 3);
    expect(g.scale).toBeLessThan(1);
    expect(changes).toBeGreaterThan(0);
    const low = g.scale;
    feed(g, t, 33, 12);
    expect(g.scale).toBeLessThanOrEqual(low);
  });

  it("steps back up after sustained fast frames", () => {
    const g = new FrameGovernor();
    g.reset(0);
    let t = feed(g, 0, 16.7, 3);
    t = feed(g, t, 40, 4);
    const low = g.scale;
    expect(low).toBeLessThan(1);
    feed(g, t, 16.6, 30);
    expect(g.scale).toBeGreaterThan(low);
  });

  it("ignores stalls (tab switches) instead of counting them as slow", () => {
    const g = new FrameGovernor();
    g.reset(0);
    let t = feed(g, 0, 16.7, 3);
    for (let i = 0; i < 20; i++) {
      t += 900;
      g.frame(t);
    }
    expect(g.scale).toBe(1);
  });
});
