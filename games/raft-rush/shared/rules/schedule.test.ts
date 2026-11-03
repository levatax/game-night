import { describe, expect, it } from "vitest";

import { DIFFICULTIES, MONSTERS, NIGHT_BASE_CRABS, NORMAL_TIMINGS, WARN_LEADS_SEC, nightWave, secToTicks, threatMult } from "../constants.js";
import { clockAt, warningStage } from "./schedule.js";

describe("threat curve (v4 §4.1)", () => {
  it("is linear 1 + 0.30 × (seats − 2), capped at 2.20 at 6 seats", () => {
    expect(threatMult(2)).toBeCloseTo(1.0);
    expect(threatMult(3)).toBeCloseTo(1.3);
    expect(threatMult(4)).toBeCloseTo(1.6);
    expect(threatMult(5)).toBeCloseTo(1.9);
    expect(threatMult(6)).toBeCloseTo(2.2);
    expect(threatMult(7)).toBe(2.2);
    expect(threatMult(1)).toBe(1.0);
  });

  it("gives the spec crab table: 2p 5/8/10, 3p 7/11/13, 4p 8/13/16, 5p 10/16/19, 6p 11/18/22", () => {
    const table: Record<number, number[]> = {
      2: [5, 8, 10],
      3: [7, 11, 13],
      4: [8, 13, 16],
      5: [10, 16, 19],
      6: [11, 18, 22],
    };
    for (const [seats, perNight] of Object.entries(table)) {
      for (let night = 1; night <= 3; night++) {
        expect(nightWave(night, Number(seats)).crabs, `${seats}p night ${night}`).toBe(perNight[night - 1]);
      }
    }
    expect(NIGHT_BASE_CRABS).toEqual([5, 8, 10]);
  });

  it("never scales HP: monster HP is a constant per kind, independent of seats", () => {
    expect(MONSTERS.crab.hp).toBe(2);
    expect(MONSTERS.puffer.hp).toBe(1);
    expect(MONSTERS.boss.hp).toBe(12);
    const wave = nightWave(3, 6);
    expect(Object.keys(wave).sort()).toEqual(["boss", "crabs", "puffers"]);
    expect(DIFFICULTIES.nightmare.monsters).toBe(1.5);
  });
});

describe("warning ladder (v4 §3)", () => {
  const t = NORMAL_TIMINGS;
  const at = (sec: number) => clockAt(secToTicks(sec), t);
  const night1 = 95 + 10;
  const night2 = 155 + 95 + 10;
  const storm = 3 * 155;

  it("uses leads of exactly 30 / 20 / 15 s, none below the 12 s floor", () => {
    expect(WARN_LEADS_SEC).toEqual([30, 20, 15]);
    for (const lead of WARN_LEADS_SEC) expect(lead).toBeGreaterThanOrEqual(12);
  });

  it("fires 30 s before night 1, 20 s before night 2 and 15 s before the storm", () => {
    expect(warningStage(at(night1 - 31), t)).toBe(-1);
    expect(warningStage(at(night1 - 30), t)).toBe(0);

    expect(warningStage(at(night2 - 21), t)).toBe(-1);
    expect(warningStage(at(night2 - 20), t)).toBe(1);

    expect(warningStage(at(storm - 16), t)).toBe(-1);
    expect(warningStage(at(storm - 15), t)).toBe(2);
  });
});
