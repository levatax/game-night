// Pins how far each knockback carries a player, so physics tuning can't drift silently.
// A player at the island center (no cover) is launched toward −Z and stepped until it rests:
// "passive" = no input at all; "hold" = holding back (DI against the flight, then braking) until
// stopped. "out" = fell off the island. Distances in metres, ±0.05 m. Hearts = hearts after the hit
// (the hearts-tension multiplier, game1.md knockback table). If a change here is intended, update
// the table in the same change.
import { describe, expect, it } from "vitest";
import {
  HEADBUTT_KNOCK_H,
  HEADBUTT_KNOCK_UP,
  KNOCKBACK_H,
  KNOCKBACK_UP,
  RING_OUT_Y,
  SHOCKWAVE_KNOCK_H,
  SHOCKWAVE_KNOCK_UP,
} from "../constants.js";
import type { MapId } from "../types.js";
import { vec3 } from "./math.js";
import { stepPlayer } from "./player.js";
import { cmd, openArena, simCtx, spawnPlayer } from "./testkit.js";
import { heartsKnockMultiplier, knockStunTicks, knockbackMultiplier, launchVelocity } from "./throw.js";

type Kind = "base" | "full" | "mega" | "headbutt" | "shock";
type Result = number | "out";

function launchOf(kind: Kind, hearts: number): [number, number, number] {
  const hm = heartsKnockMultiplier(hearts);
  switch (kind) {
    case "base":
      return [KNOCKBACK_H, KNOCKBACK_UP, knockbackMultiplier(0, "normal") * hm];
    case "full":
      return [KNOCKBACK_H, KNOCKBACK_UP, knockbackMultiplier(1, "normal") * hm];
    case "mega":
      return [KNOCKBACK_H, KNOCKBACK_UP, knockbackMultiplier(1, "mega") * hm];
    case "headbutt":
      return [HEADBUTT_KNOCK_H, HEADBUTT_KNOCK_UP, hm];
    case "shock":
      return [SHOCKWAVE_KNOCK_H, SHOCKWAVE_KNOCK_UP, hm];
  }
}

function knockDistance(map: MapId, kind: Kind, hearts: number, hold: boolean): Result {
  const ctx = simCtx("quacky", openArena(map));
  const p = spawnPlayer(0, 0, 0); // yaw 0: forward is −Z, so moveZ −1 pushes back toward +Z
  const [h, up, mult] = launchOf(kind, hearts);
  const v = launchVelocity(0, -1, h, up, mult, vec3());
  p.vx = v.x;
  p.vy = v.y;
  p.vz = v.z;
  p.grounded = false;
  p.stunTicks = knockStunTicks(v);
  let max = 0;
  for (let t = 0; t < 600; t++) {
    const back = hold && (p.stunTicks > 0 || p.vz < -1e-3);
    stepPlayer(p, cmd({ seq: t + 1, moveZ: back ? -1 : 0 }), ctx);
    max = Math.max(max, -p.z);
    if (p.y < RING_OUT_Y) return "out";
    if (p.stunTicks === 0 && p.grounded && Math.hypot(p.vx, p.vz) < 1e-3) break;
  }
  return max;
}

/** [kind, hearts after, passive, hold] per map. */
const TABLE: Record<MapId, Array<[Kind, number, Result, Result]>> = {
  picnic: [
    ["base", 3, 2.64, 2.04],
    ["full", 3, 6.13, 4.43],
    ["mega", 3, "out", 13.92],
    ["headbutt", 3, 7.79, 6.0],
    ["shock", 3, 4.28, 3.35],
    ["base", 2, 3.33, 2.56],
    ["full", 2, 7.52, 5.47],
    ["mega", 2, "out", 14.11],
    ["headbutt", 2, 9.52, 7.32],
    ["shock", 2, 5.61, 4.25],
    ["base", 1, 4.32, 3.34],
    ["full", 1, 9.7, 7.09],
    ["mega", 1, "out", 14.11],
    ["headbutt", 1, 12.07, 9.43],
    ["shock", 1, 7.43, 5.6],
  ],
  bath: [
    ["base", 3, 3.86, 2.23],
    ["full", 3, 7.17, 4.43],
    ["mega", 3, "out", 14.49],
    ["headbutt", 3, 9.55, 6.02],
    ["shock", 3, 6.37, 3.66],
    ["base", 2, 4.81, 2.78],
    ["full", 2, 8.76, 5.47],
    ["mega", 2, "out", "out"],
    ["headbutt", 2, 11.57, 7.33],
    ["shock", 2, 6.81, 4.25],
    ["base", 1, 6.24, 3.6],
    ["full", 1, 11.23, 7.09],
    ["mega", 1, "out", "out"],
    ["headbutt", 1, "out", 9.47],
    ["shock", 1, 8.89, 5.6],
  ],
  cake: [
    ["base", 3, 2.52, 1.97],
    ["full", 3, 6.1, 4.43],
    ["mega", 3, "out", 13.9],
    ["headbutt", 3, 7.73, 6.0],
    ["shock", 3, 4.12, 3.28],
    ["base", 2, 3.21, 2.5],
    ["full", 2, 7.47, 5.47],
    ["mega", 2, "out", "out"],
    ["headbutt", 2, 9.45, 7.32],
    ["shock", 2, 5.57, 4.25],
    ["base", 1, 4.17, 3.27],
    ["full", 1, 9.64, 7.09],
    ["mega", 1, "out", "out"],
    ["headbutt", 1, 11.98, 9.43],
    ["shock", 1, 7.38, 5.6],
  ],
};

function expectResult(actual: Result, expected: Result): void {
  if (expected === "out") expect(actual).toBe("out");
  else {
    expect(typeof actual).toBe("number");
    expect(actual as number).toBeCloseTo(expected, 1);
  }
}

describe("knockback distances (pinned)", () => {
  for (const map of Object.keys(TABLE) as MapId[]) {
    for (const [kind, hearts, passive, hold] of TABLE[map]) {
      it(`${map}: ${kind} at ${hearts} hearts → passive ${passive}, hold-back ${hold}`, () => {
        expectResult(knockDistance(map, kind, hearts, false), passive);
        expectResult(knockDistance(map, kind, hearts, true), hold);
      });
    }
  }

  it("holding back always shortens a knock (DI + braking matter)", () => {
    for (const map of Object.keys(TABLE) as MapId[]) {
      for (const [kind, hearts] of TABLE[map]) {
        const passive = knockDistance(map, kind, hearts, false);
        const hold = knockDistance(map, kind, hearts, true);
        if (hold === "out") expect(passive).toBe("out");
        else if (passive !== "out") expect(hold).toBeLessThan(passive);
      }
    }
  });
});
