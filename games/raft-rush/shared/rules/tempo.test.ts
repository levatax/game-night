import { describe, expect, it } from "vitest";
import { NORMAL_TIMINGS, TICK_RATE } from "../constants.js";
import { matchTicks } from "./schedule.js";
import { clockLabel, clockLabels, matchClock, matchLeftSec } from "./tempo.js";

describe("match tempo: one clock for the HUD and the DAY / storm banner", () => {
  it("the whole match is landing + 3 cycles = 495 s (8:15)", () => {
    const t = NORMAL_TIMINGS;
    expect(matchClock(t, 0, t.landing).totalSec).toBe(495);
    const labels = clockLabels(t, 0, t.landing);
    expect(labels).toEqual({ hud: "8:15", banner: "8:15" });
  });

  it("both labels are the same number in every phase, landing included", () => {
    const t = NORMAL_TIMINGS;
    const total = t.landing + matchTicks(t);
    for (const elapsed of [0, 1, Math.floor(total / 2), total - TICK_RATE]) {
      const landingLeft = Math.max(0, t.landing - elapsed);
      const clockTicks = Math.max(0, elapsed - t.landing);
      const { hud, banner } = clockLabels(t, clockTicks, landingLeft);
      expect(hud).toBe(banner);
      expect(hud).toBe(clockLabel(matchLeftSec(t, clockTicks, landingLeft)));
    }
  });

  it("the storm warning prints the same second the HUD counts down", () => {
    const t = NORMAL_TIMINGS;
    const warnLeft = 30 * TICK_RATE;
    const clockTicks = matchTicks(t) - warnLeft;
    expect(matchLeftSec(t, clockTicks, 0)).toBe(30);
  });
});
