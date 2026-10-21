// Throw math tests: speeds, toss, coconut ball, trajectories vs stepProjectile, ballistic aiming. Owner: sim.

import { describe, expect, it } from "vitest";
import {
  CHARGE_FULL_TICKS,
  COCONUT_BALL_COUNT,
  COCONUT_BALL_SPREAD,
  DT,
  EYE_HEIGHT,
  HAND_FORWARD,
  HAND_RIGHT,
  THROW_PITCH_BIAS,
  THROW_SPEED_MAX,
  THROW_SPEED_MIN,
  TOSS_PITCH,
  TOSS_SPEED,
  WATER_Y,
} from "../constants.js";
import { ITEMS } from "../items.js";
import type { ItemKind } from "../types.js";
import { pitchFromDir, vec3, yawFromDir, type Vec3 } from "./math.js";
import { stepProjectile, type ProjectileSim } from "./projectile.js";
import { flatIsland, makeProjectileContext, NO_COVER, poolIsland, POOL, projectile, slopeIsland } from "./testkit.js";
import {
  aimDirection,
  aimThrowAt,
  ballisticPoint,
  chargeForSpeed,
  computeThrowVelocities,
  computeThrowVelocity,
  computeTossVelocity,
  flightTime,
  minLaunchSpeed,
  projectileKindForThrow,
  sampleTrajectory,
  sampleTrajectoryInto,
  solveBallistic,
  throwOrigin,
  throwSpeed,
} from "./throw.js";

const flat = flatIsland(1, [], 96);
const flatCtx = makeProjectileContext(flat, NO_COVER);

function len(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

/** Launch `kind` from `origin` with `v`; tick until the first contact (bounce / loose / stuck / sank). */
function firstContact(kind: ItemKind, origin: Vec3, v: Vec3, ctx = flatCtx): { tick: number; b: ProjectileSim; path: Vec3[] } {
  const b = projectile(kind, { ...origin, vx: v.x, vy: v.y, vz: v.z, state: "live" });
  const path: Vec3[] = [vec3(origin.x, origin.y, origin.z)];
  for (let tick = 1; tick <= 200; tick++) {
    const r = stepProjectile(b, ctx);
    path.push(vec3(b.x, b.y, b.z));
    if (r.bounced || r.becameLoose || r.stuck || r.sank) return { tick, b, path };
  }
  return { tick: -1, b, path };
}

/** Closest distance from `p` to the polyline. */
function distToPath(path: Vec3[], p: Vec3): number {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const l2 = dx * dx + dy * dy + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y, a.z + dz * t - p.z));
  }
  return best;
}

describe("speeds and directions", () => {
  it("maps charge to 12..34 m/s and back", () => {
    expect(throwSpeed(0)).toBe(THROW_SPEED_MIN);
    expect(throwSpeed(1)).toBe(THROW_SPEED_MAX);
    expect(throwSpeed(2)).toBe(THROW_SPEED_MAX);
    expect(throwSpeed(-1)).toBe(THROW_SPEED_MIN);
    expect(throwSpeed(0.5)).toBe(23);
    for (const c of [0, 0.25, 0.5, 1]) expect(chargeForSpeed(throwSpeed(c))).toBeCloseTo(c, 12);
    expect(chargeForSpeed(100)).toBe(1);
  });

  it("releases along the aim raised by THROW_PITCH_BIAS at the charge speed", () => {
    for (const [charge, speed] of [
      [1, 34],
      [0, 12],
      [1 / CHARGE_FULL_TICKS, throwSpeed(1 / CHARGE_FULL_TICKS)],
    ] as const) {
      const v = computeThrowVelocity(charge, 0.7, 0.2);
      expect(len(v)).toBeCloseTo(speed, 9);
      expect(yawFromDir(v.x, v.z)).toBeCloseTo(0.7, 9);
      expect(pitchFromDir(v)).toBeCloseTo(0.2 + THROW_PITCH_BIAS, 9);
    }
    // Straight up stays well defined (release pitch clamped, the yaw survives).
    const up = computeThrowVelocity(1, 1.2, 2);
    expect(yawFromDir(up.x, up.z)).toBeCloseTo(1.2, 9);
  });

  it("tosses at TOSS_SPEED with TOSS_PITCH", () => {
    const v = computeTossVelocity(-0.4, 0.1);
    expect(len(v)).toBeCloseTo(TOSS_SPEED, 9);
    expect(yawFromDir(v.x, v.z)).toBeCloseTo(-0.4, 9);
    expect(pitchFromDir(v)).toBeCloseTo(0.1 + TOSS_PITCH, 9);
    expect(computeThrowVelocities({ kind: "coconut_ball", charge: 1, toss: true, yaw: -0.4, pitch: 0.1 })).toEqual([v]);
  });

  it("splits a coconut ball into three coconuts: center, −spread, +spread", () => {
    const vs = computeThrowVelocities({ kind: "coconut_ball", charge: 1, toss: false, yaw: 0.3, pitch: 0.1 });
    expect(vs).toHaveLength(COCONUT_BALL_COUNT);
    expect(yawFromDir(vs[0]!.x, vs[0]!.z)).toBeCloseTo(0.3, 9);
    expect(yawFromDir(vs[1]!.x, vs[1]!.z)).toBeCloseTo(0.3 - COCONUT_BALL_SPREAD, 9);
    expect(yawFromDir(vs[2]!.x, vs[2]!.z)).toBeCloseTo(0.3 + COCONUT_BALL_SPREAD, 9);
    for (const v of vs) expect(len(v)).toBeCloseTo(THROW_SPEED_MAX, 9);
    expect(projectileKindForThrow("coconut_ball")).toBe("coconut");
    expect(projectileKindForThrow("spear")).toBe("spear");
    expect(computeThrowVelocities({ kind: "spear", charge: 0.5, toss: false, yaw: 0, pitch: 0 })).toEqual([computeThrowVelocity(0.5, 0, 0)]);
  });

  it("throws from just below the eye, forward and to the right", () => {
    const hand = throwOrigin({ x: 1, y: 2, z: 3, yaw: 0 });
    expect(hand.x).toBeCloseTo(1 + HAND_RIGHT, 12);
    expect(hand.y).toBeCloseTo(2 + EYE_HEIGHT - 0.15, 12);
    expect(hand.z).toBeCloseTo(3 - HAND_FORWARD, 12);
    const o = throwOrigin({ x: 0, y: 0, z: 0, yaw: Math.PI / 2 }); // facing −x, right = −z
    expect(o.x).toBeCloseTo(-HAND_FORWARD, 12);
    expect(o.z).toBeCloseTo(-HAND_RIGHT, 12);
    expect(aimDirection(0, 0)).toEqual({ x: -0, y: 0, z: -1 });
  });
});

describe("trajectories match stepProjectile", () => {
  it("flightTime ends at the simulated first ground contact", () => {
    for (const kind of ["coconut", "stone", "spear", "fish_raw"] as ItemKind[]) {
      for (const pitch of [-0.1, 0.2, 0.6]) {
        const origin = throwOrigin({ x: 0, y: 1, z: 30, yaw: 0 });
        const v = computeThrowVelocity(1, 0, pitch);
        const t = flightTime(flatCtx, origin, v, kind);
        const hit = firstContact(kind, origin, v);
        expect(hit.tick).toBeGreaterThan(0);
        // The sim touches within the tick that contains t.
        expect(Math.abs(hit.tick * DT - t)).toBeLessThanOrEqual(DT + 1e-9);
        const end = ballisticPoint(origin, v, t, ITEMS[kind].gravityScale);
        expect(end.y - ITEMS[kind].radius).toBeCloseTo(1, 3);
        expect(Math.hypot(hit.b.x - end.x, hit.b.z - end.z)).toBeLessThan(THROW_SPEED_MAX * DT);
      }
    }
  });

  it("ends at the water surface over the sea and on slopes where they rise", () => {
    const pool = poolIsland();
    const q = makeProjectileContext(pool, NO_COVER);
    const origin = vec3(POOL.rampEndX + 1, 3, 0);
    const v = vec3(2, 2, 0);
    const t = flightTime(q, origin, v, "coconut");
    expect(ballisticPoint(origin, v, t, 1).y - ITEMS.coconut.radius).toBeCloseTo(WATER_Y, 3);

    const slope = slopeIsland(0.5, 0);
    const sq = makeProjectileContext(slope, NO_COVER);
    const so = vec3(-4, 2, 0);
    const sv = vec3(8, 4, 0);
    const st = flightTime(sq, so, sv, "stone");
    const hit = firstContact("stone", so, sv, sq);
    expect(Math.abs(hit.tick * DT - st)).toBeLessThanOrEqual(DT + 1e-9);
  });

  it("samples evenly in time from the origin over `fraction` of the flight", () => {
    const origin = throwOrigin({ x: 0, y: 1, z: 30, yaw: 0 });
    const v = computeThrowVelocity(1, 0, 0.3);
    const t = flightTime(flatCtx, origin, v, "coconut");
    const pts = sampleTrajectory(flatCtx, origin, v, { kind: "coconut", maxPoints: 32, fraction: 0.7 });
    expect(pts).toHaveLength(32);
    expect(pts[0]).toEqual(origin);
    const last = ballisticPoint(origin, v, t * 0.7, 1);
    expect(pts[31]!.x).toBeCloseTo(last.x, 9);
    expect(pts[31]!.y).toBeCloseTo(last.y, 9);
    expect(pts[31]!.z).toBeCloseTo(last.z, 9);

    const reuse = [vec3(), vec3(), vec3()];
    const first = reuse[0];
    const again = sampleTrajectoryInto(flatCtx, origin, v, { kind: "coconut", maxPoints: 2, fraction: 1 }, reuse);
    expect(again).toBe(reuse);
    expect(again).toHaveLength(2);
    expect(again[0]).toBe(first);
    expect(sampleTrajectory(flatCtx, origin, v, { kind: "coconut", maxPoints: 1, fraction: 1 })).toHaveLength(1);
    // Nothing to hit within maxSec: the whole window.
    expect(flightTime(flatCtx, vec3(0, 500, 0), vec3(0, 0, 0), "coconut", 2)).toBe(2);
  });
});

describe("ballistic aiming", () => {
  it("solveBallistic + stepProjectile land within 1 m at 10 / 20 / 30 m", () => {
    for (const kind of ["coconut", "stone", "spear"] as ItemKind[]) {
      for (const d of [10, 20, 30]) {
        const origin = vec3(0, 2.4, 40);
        const target = vec3(0, 1.5, 40 - d); // a crab-sized target on the ground (flat island at 1 m)
        const sol = solveBallistic(origin, target, THROW_SPEED_MAX, ITEMS[kind].gravityScale);
        expect(sol).not.toBeNull();
        const v = computeThrowVelocity(1, sol!.yaw, sol!.pitch);
        const hit = firstContact(kind, origin, v);
        expect(distToPath(hit.path, target)).toBeLessThan(1);
        expect(sol!.time).toBeGreaterThan(d / THROW_SPEED_MAX);
      }
    }
  });

  it("aimThrowAt accounts for the hand offset from the feet", () => {
    for (const d of [10, 20, 30]) {
      const feet = { x: 3, y: 1, z: 40 };
      const target = vec3(-5, 1.4, 40 - d);
      const aim = aimThrowAt(feet, target, throwSpeed(0.8), "coconut_ball");
      expect(aim).not.toBeNull();
      expect(aim!.charge).toBeCloseTo(0.8, 12);
      const origin = throwOrigin({ ...feet, yaw: aim!.yaw });
      expect(aim!.origin.x).toBeCloseTo(origin.x, 9);
      const v = computeThrowVelocity(aim!.charge, aim!.yaw, aim!.pitch);
      expect(distToPath(firstContact("coconut", origin, v).path, target)).toBeLessThan(0.5);
    }
  });

  it("reports out-of-range targets and the minimum launch speed", () => {
    const origin = vec3(0, 2, 0);
    const far = vec3(0, 1, -80);
    expect(solveBallistic(origin, far, THROW_SPEED_MAX, 1)).toBeNull();
    expect(aimThrowAt({ x: 0, y: 0.5, z: 0 }, far, THROW_SPEED_MAX, "coconut")).toBeNull();
    expect(solveBallistic(origin, origin, THROW_SPEED_MAX, 1)).toBeNull();
    const target = vec3(4, 3, -18);
    const vmin = minLaunchSpeed(origin, target, 1);
    expect(solveBallistic(origin, target, vmin * 1.001, 1)).not.toBeNull();
    expect(solveBallistic(origin, target, vmin * 0.99, 1)).toBeNull();
    // Max range on flat ground at full charge ≈ 58 m (§21).
    expect(minLaunchSpeed(vec3(0, 0, 0), vec3(0, 0, -57.8), 1)).toBeLessThanOrEqual(THROW_SPEED_MAX + 1e-9);
  });
});
