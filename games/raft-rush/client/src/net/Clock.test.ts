// Clock (server tick estimate) and MatchClock (smoothed clockTicks) tests. Owner: client-net.
// Clock cases copied from games/bonk-brawl/client/src/net/Clock.test.ts.

import { describe, expect, it } from "vitest";
import { TICK_MS } from "../../../shared/constants";
import { Clock, MAX_CLOCK_LEAD_TICKS, MatchClock } from "./Clock";

describe("Clock", () => {
  it("is unsynced and at tick 0 before the first sample", () => {
    const clock = new Clock();
    expect(clock.synced).toBe(false);
    expect(clock.serverTickAt(1234)).toBe(0);
  });

  it("anchors the first sample half an RTT ahead and runs at real time", () => {
    const clock = new Clock();
    clock.sample(100, 1000, 100);
    expect(clock.synced).toBe(true);
    expect(clock.rttMs).toBe(100);
    expect(clock.serverTickAt(1000)).toBeCloseTo(100 + 50 / TICK_MS);
    expect(clock.serverTickAt(2000)).toBeCloseTo(100 + 50 / TICK_MS + 30);
    expect(clock.serverTimeMs(1000)).toBeCloseTo((100 + 50 / TICK_MS) * TICK_MS);
  });

  it("keeps the previous RTT when the server has not measured one yet", () => {
    const clock = new Clock();
    clock.sample(10, 0, 80);
    clock.sample(13, 100, 0);
    expect(clock.rttMs).toBe(80);
  });

  it("never goes backwards for a late sample; it slews instead", () => {
    const clock = new Clock();
    clock.sample(100, 0, 0);
    const before = clock.serverTickAt(500);
    // A sample that arrived 3 ticks late.
    clock.sample(100 + 15 - 3, 500, 0);
    let prev = before;
    for (let t = 500; t <= 3000; t += 16) {
      const tick = clock.serverTickAt(t);
      expect(tick).toBeGreaterThanOrEqual(prev);
      prev = tick;
    }
  });

  it("converges to consistently-ahead samples within about a second", () => {
    const clock = new Clock();
    clock.sample(0, 0, 0);
    // The real server is 3 ticks ahead of the first estimate.
    for (let t = 50; t <= 2000; t += 50) clock.sample(t / TICK_MS + 3, t, 0);
    expect(clock.serverTickAt(2000)).toBeCloseTo(2000 / TICK_MS + 3, 0);
  });

  it("snaps when the error exceeds 10 ticks", () => {
    const clock = new Clock();
    clock.sample(0, 0, 0);
    clock.sample(500, 100, 0);
    expect(clock.serverTickAt(100)).toBeCloseTo(500);
  });

  it("holds instead of jumping back on a large backward snap", () => {
    const clock = new Clock();
    clock.sample(1000, 0, 0);
    const high = clock.serverTickAt(100);
    clock.sample(900, 100, 0);
    expect(clock.serverTickAt(100)).toBe(high);
    expect(clock.serverTickAt(200)).toBe(high);
    // Once the estimate passes the held value it moves again.
    expect(clock.serverTickAt(100 + (high - 900 + 1) * TICK_MS)).toBeGreaterThan(high);
  });

  it("stops slewing when samples stop (no drift while the tab is hidden)", () => {
    const clock = new Clock();
    clock.sample(0, 0, 0);
    clock.sample(50 / TICK_MS + 5, 50, 0);
    const a = clock.serverTickAt(10_000);
    const b = clock.serverTickAt(20_000);
    expect(b - a).toBeCloseTo(10_000 / TICK_MS, 5);
  });

  it("resets to unsynced", () => {
    const clock = new Clock();
    clock.sample(10, 0, 50);
    clock.reset();
    expect(clock.synced).toBe(false);
    expect(clock.rttMs).toBe(0);
    expect(clock.serverTickAt(100)).toBe(0);
  });
});

describe("MatchClock", () => {
  it("advances clockTicks with the server clock between patches while playing", () => {
    const mc = new MatchClock();
    mc.onPatch(300, 1000, true);
    expect(mc.at(1000, 10_000)).toBe(300);
    expect(mc.at(1002.5, 10_000)).toBeCloseTo(302.5);
  });

  it("is frozen outside playing", () => {
    const mc = new MatchClock();
    mc.onPatch(450, 2000, false);
    expect(mc.at(2010, 10_000)).toBe(450);
  });

  it("runs at most MAX_CLOCK_LEAD_TICKS ahead of a stalled feed and never past the storm", () => {
    const mc = new MatchClock();
    mc.onPatch(100, 500, true);
    expect(mc.at(600, 10_000)).toBe(100 + MAX_CLOCK_LEAD_TICKS);
    mc.onPatch(9_995, 700, true);
    expect(mc.at(710, 10_000)).toBe(10_000);
  });

  it("holds small backward corrections, follows a new match's reset", () => {
    const mc = new MatchClock();
    mc.onPatch(100, 500, true);
    const ahead = mc.at(504, 10_000);
    expect(ahead).toBeCloseTo(104);
    // The next patch says the clock was a little behind our estimate: hold, don't jump back.
    mc.onPatch(102, 502, true);
    expect(mc.at(502, 10_000)).toBeCloseTo(104);
    expect(mc.at(505, 10_000)).toBeCloseTo(105);
    // A new match starts from 0.
    mc.onPatch(0, 9000, false);
    expect(mc.at(9001, 10_000)).toBe(0);
  });

  it("reset() forgets the held value", () => {
    const mc = new MatchClock();
    mc.onPatch(20, 100, true);
    mc.at(110, 10_000);
    mc.reset();
    mc.onPatch(5, 200, false);
    expect(mc.at(201, 10_000)).toBe(5);
  });
});
