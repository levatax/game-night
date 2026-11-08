import { describe, expect, it } from "vitest";
import {
  KNOCK_MAX_SPEED,
  KNOCK_STUN_MAX_TICKS,
  KNOCK_STUN_MIN_TICKS,
  KNOCKBACK_H,
  KNOCKBACK_STUN_TICKS,
  KNOCKBACK_UP,
} from "../constants.js";
import { vec3 } from "./math.js";
import { heartsKnockMultiplier, knockStunTicks, launchVelocity } from "./throw.js";

describe("knockback helpers", () => {
  it("scales knockback with hearts lost (after this hit's damage)", () => {
    expect(heartsKnockMultiplier(3)).toBe(1);
    expect(heartsKnockMultiplier(2)).toBe(1.12);
    expect(heartsKnockMultiplier(1)).toBe(1.3);
    expect(heartsKnockMultiplier(0)).toBe(1.3);
    expect(heartsKnockMultiplier(5)).toBe(1);
    expect(heartsKnockMultiplier(-2)).toBe(1.3);
  });

  it("builds the launch velocity and caps it at KNOCK_MAX_SPEED keeping the direction", () => {
    const v = launchVelocity(0, -1, KNOCKBACK_H, KNOCKBACK_UP, 1.12, vec3());
    expect(v.x).toBe(0);
    expect(v.y).toBeCloseTo(KNOCKBACK_UP * 1.12, 12);
    expect(v.z).toBeCloseTo(-KNOCKBACK_H * 1.12, 12);
    const mega = launchVelocity(0.6, 0.8, KNOCKBACK_H, KNOCKBACK_UP, 1.5 * 2 * 1.3, vec3());
    expect(Math.hypot(mega.x, mega.y, mega.z)).toBeCloseTo(KNOCK_MAX_SPEED, 9);
    expect(mega.z / mega.x).toBeCloseTo(0.8 / 0.6, 9);
    expect(mega.y / Math.hypot(mega.x, mega.z)).toBeCloseTo(KNOCKBACK_UP / KNOCKBACK_H, 9);
  });

  it("stuns for the whole flight plus a get-up, clamped", () => {
    // 2 · 4.032 / 18 = 0.448 s → 14 ticks + 5.
    expect(knockStunTicks({ x: 0, y: KNOCKBACK_UP * 1.12, z: 0 })).toBe(19);
    expect(knockStunTicks({ x: 9, y: 0, z: 0 })).toBe(Math.max(KNOCK_STUN_MIN_TICKS, KNOCKBACK_STUN_TICKS));
    expect(knockStunTicks({ x: 0, y: -3, z: 0 })).toBe(Math.max(KNOCK_STUN_MIN_TICKS, KNOCKBACK_STUN_TICKS));
    expect(knockStunTicks({ x: 0, y: 20, z: 0 })).toBe(KNOCK_STUN_MAX_TICKS);
    expect(knockStunTicks({ x: 0, y: 3.6 * 1.5 * 1.12, z: 0 })).toBe(26);
  });
});
