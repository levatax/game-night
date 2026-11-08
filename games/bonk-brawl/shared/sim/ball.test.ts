import { describe, expect, it } from "vitest";
import {
  BALL_DEATH_KEEP,
  BALL_DEATH_RESTITUTION,
  BALL_MAX_SPEED,
  BALL_RADIUS,
  BALL_RESTITUTION_FLOOR,
  BALL_ROLL_DRAG,
  BALL_REST_TICKS,
  BALL_SPAWN_HEIGHT,
  BOOMERANG_MAX_RETURN_TICKS,
  BOOMERANG_RETURN_SPEED,
  BOOMERANG_RETURN_TICKS,
  CURVE_ACCEL,
  CURVE_MAX_TICKS,
  DT,
  MEGA_BALL_RADIUS,
} from "../constants.js";
import { getArena, type CoverCylinder } from "../maps.js";
import {
  copyBallSim,
  createBallSim,
  emptyBallResult,
  stepBall,
  stepBallInto,
  type BallSim,
  type StepBallResult,
} from "./ball.js";
import type { BallContext } from "./context.js";
import { aimDirection, ballisticPoint, computeThrowVelocity } from "./throw.js";
import { vec3, type Vec3 } from "./math.js";
import { ball, ballCtx, lcg, openArena } from "./testkit.js";

function run(b: BallSim, ctx: BallContext, ticks: number): StepBallResult[] {
  const results: StepBallResult[] = [];
  for (let i = 0; i < ticks; i++) results.push(stepBall(b, ctx));
  return results;
}

function runUntil(b: BallSim, ctx: BallContext, maxTicks: number, done: (r: StepBallResult) => boolean): number {
  for (let i = 0; i < maxTicks; i++) {
    if (done(stepBall(b, ctx))) return i;
  }
  return -1;
}

function speed(b: BallSim): number {
  return Math.hypot(b.vx, b.vy, b.vz);
}

describe("held and copy", () => {
  it("never moves a held ball", () => {
    const b = ball({ state: "held", x: 1, y: 2, z: 3, vx: 5 });
    const before = { ...b };
    expect(stepBall(b, ballCtx())).toEqual(emptyBallResult());
    expect(b).toEqual(before);
  });

  it("copies every field and reuses result objects", () => {
    const src = ball({ x: 1, state: "live", kind: "mega", radius: MEGA_BALL_RADIUS, curve: true });
    expect(copyBallSim(src, createBallSim())).toEqual(src);
    const out = emptyBallResult();
    expect(stepBallInto(src, ballCtx(), out)).toBe(out);
  });
});

describe("flight", () => {
  it("follows the exact gravity parabola until it touches something", () => {
    const origin = vec3(0, 3, 0);
    const v = vec3(4, 6, -10);
    const b = ball({ ...origin, vx: v.x, vy: v.y, vz: v.z, state: "live" });
    const ctx = ballCtx();
    for (let k = 1; k <= 20; k++) {
      stepBall(b, ctx);
      const expected = ballisticPoint(origin, v, k * DT);
      expect(b.x).toBeCloseTo(expected.x, 9);
      expect(b.y).toBeCloseTo(expected.y, 9);
      expect(b.z).toBeCloseTo(expected.z, 9);
      expect(b.ageTicks).toBe(k);
    }
  });

  it("clamps absurd speeds", () => {
    const b = ball({ y: 5, vx: 100, state: "dead" });
    stepBall(b, ballCtx());
    expect(speed(b)).toBeLessThanOrEqual(BALL_MAX_SPEED + 1e-9);
  });
});

describe("bounces and states", () => {
  it("turns a live ball dead on its first floor bounce", () => {
    const b = ball({ y: 2, vx: 3, state: "live" });
    const ctx = ballCtx();
    const results = run(b, ctx, 20);
    const first = results.findIndex((r) => r.bounced);
    expect(first).toBeGreaterThan(10); // 1.75 m drop ≈ 0.42 s
    expect(first).toBeLessThan(15);
    const r = results[first];
    expect(r.becameDead).toBe(true);
    expect(r.bounceSurface).toBe(-1);
    expect(r.impactSpeed).toBeCloseTo(Math.sqrt(2 * 20 * 1.75), 0);
    expect(results.filter((x) => x.becameDead)).toHaveLength(1);
    expect(b.state).toBe("dead");
    expect(b.bounces).toBeGreaterThanOrEqual(1);
  });

  it("bounces with floor restitution and friction", () => {
    // A DEAD ball: the arena's ballRestitution / ballBounceFriction (Picnic 0.55 / 0.75).
    const b = ball({ y: 0.5, vx: 4, vy: -10, state: "dead" });
    const r = stepBall(b, ballCtx());
    expect(r.bounced).toBe(true);
    expect(b.vy).toBeGreaterThan(0);
    expect(b.vy).toBeCloseTo(r.impactSpeed * getArena("picnic").friction.ballRestitution, 9);
    expect(b.vy).toBeCloseTo(r.impactSpeed * BALL_RESTITUTION_FLOOR, 9);
    expect(b.vx).toBeCloseTo(4 * getArena("picnic").friction.ballBounceFriction, 9);
    expect(b.vx).toBeCloseTo(4 * 0.75, 9);
    expect(b.y).toBeGreaterThanOrEqual(BALL_RADIUS);
  });

  it("damps the killing bounce of a live ball (BALL_DEATH_KEEP / BALL_DEATH_RESTITUTION)", () => {
    const b = ball({ y: 0.5, vx: 3, vy: -10, state: "live" });
    const r = stepBall(b, ballCtx());
    expect(r.bounced).toBe(true);
    expect(r.becameDead).toBe(true);
    expect(b.vy).toBeCloseTo(r.impactSpeed * BALL_DEATH_RESTITUTION, 9);
    expect(b.vx).toBeCloseTo(3 * BALL_DEATH_KEEP, 9);
    // A boomerang turning around is not a killing bounce.
    const boom = ball({ y: 0.5, vx: 3, vy: -10, state: "live", kind: "boomerang" });
    stepBall(boom, ballCtx());
    expect(boom.vx).toBeCloseTo(3 * getArena("picnic").friction.ballBounceFriction, 9);
  });

  it("uses each map's floor restitution for later bounces", () => {
    for (const id of ["picnic", "bath", "cake"] as const) {
      const b = ball({ y: 0.5, vy: -10, state: "dead" });
      const r = stepBall(b, ballCtx(openArena(id)));
      expect(b.vy).toBeCloseTo(r.impactSpeed * getArena(id).friction.ballRestitution, 9);
    }
  });

  it("rolls with linear drag on top of the map's roll decel", () => {
    const b = ball({ y: BALL_RADIUS, vx: 5, state: "dead" });
    stepBall(b, ballCtx());
    // (ballRollDecel 3 + BALL_ROLL_DRAG 1.1 · 5) · dt
    expect(b.vx).toBeCloseTo(5 - (3 + BALL_ROLL_DRAG * 5) * DT, 9);
  });

  it("keeps a tap thrown flat from the center on the island (Picnic)", () => {
    const origin = vec3(0.35, 1, -0.5);
    const v = computeThrowVelocity(0, aimDirection(0, 0), "");
    const b = ball({ x: origin.x, y: origin.y, z: origin.z, vx: v.x, vy: v.y, vz: v.z, state: "live" });
    const ctx = ballCtx();
    const tick = runUntil(b, ctx, 300, (r) => r.becameNeutral || r.lost);
    expect(tick).toBeGreaterThan(0);
    expect(b.state).toBe("neutral");
    expect(Math.abs(b.z)).toBeLessThan(13);
  });

  it("brings a dead ball to rest and turns it neutral", () => {
    const b = ball({ y: 2, vx: 3, state: "live" });
    const ctx = ballCtx();
    const tick = runUntil(b, ctx, 300, (r) => r.becameNeutral);
    expect(tick).toBeGreaterThan(0);
    expect(tick).toBeLessThan(120);
    expect(b).toMatchObject({ state: "neutral", kind: "normal", vx: 0, vy: 0, vz: 0, ageTicks: 0, y: BALL_RADIUS });
    expect(b.restTicks).toBeGreaterThanOrEqual(BALL_REST_TICKS);

    // Resting stays put exactly.
    const x = b.x;
    run(b, ctx, 100);
    expect(b.y).toBe(BALL_RADIUS);
    expect(b.x).toBe(x);
    expect(b.state).toBe("neutral");
  });

  it("drops spawned neutral balls from the sky without changing their state", () => {
    const b = ball({ y: BALL_SPAWN_HEIGHT, state: "neutral" });
    const results = run(b, ballCtx(), 150);
    expect(results.filter((r) => r.bounced).length).toBeGreaterThan(2);
    expect(results.some((r) => r.becameDead || r.becameNeutral)).toBe(false);
    expect(b).toMatchObject({ state: "neutral", y: BALL_RADIUS, vx: 0, vy: 0, vz: 0 });
  });

  it("keeps the bonus kind at rest so the server can remove it", () => {
    const b = ball({ y: BALL_RADIUS, state: "dead", kind: "bonus" });
    expect(runUntil(b, ballCtx(), 20, (r) => r.becameNeutral)).toBe(BALL_REST_TICKS - 1);
    expect(b.kind).toBe("bonus");
  });

  it("uses the mega radius on the floor, then shrinks back when neutral", () => {
    const b = ball({ y: 3, vx: 1, state: "dead", kind: "mega", radius: MEGA_BALL_RADIUS });
    const ctx = ballCtx();
    let lowest = Infinity;
    for (let i = 0; i < 200 && b.state === "dead"; i++) {
      stepBall(b, ctx);
      if (b.state === "dead") lowest = Math.min(lowest, b.y);
    }
    expect(lowest).toBeCloseTo(MEGA_BALL_RADIUS, 9);
    expect(b).toMatchObject({ state: "neutral", kind: "normal", radius: BALL_RADIUS, y: BALL_RADIUS });
  });
});

describe("cover", () => {
  const picnic = getArena("picnic");
  const basket = picnic.cover[2] as CoverCylinder;

  it("bounces live balls off cover sides and kills them", () => {
    const b = ball({ x: basket.x, y: 0.5, z: 0, vz: -20, state: "live" });
    const ctx = ballCtx(picnic);
    let first: StepBallResult | null = null;
    const hit = runUntil(b, ctx, 8, (r) => ((first = r), r.bounced));
    expect(hit).toBeGreaterThanOrEqual(2);
    expect(first).toMatchObject({ bounceSurface: 2, becameDead: true });
    expect(first!.impactSpeed).toBeGreaterThan(19);
    expect(b.state).toBe("dead");
    // The killing bounce reflects with BALL_DEATH_RESTITUTION (0.4, was the cover's 0.6):
    // a miss drops dead near the cover instead of flying back across the island.
    expect(b.vz).toBeCloseTo(20 * BALL_DEATH_RESTITUTION, 9);
    expect(b.z).toBeGreaterThan(basket.z + basket.radius);
  });

  it("lets a ball land, roll and rest on a cover top", () => {
    const b = ball({ x: basket.x, y: 3, z: basket.z, state: "dead" });
    const ctx = ballCtx(picnic);
    const results = run(b, ctx, 120);
    expect(results.find((r) => r.bounced)?.bounceSurface).toBe(2);
    expect(b.state).toBe("neutral");
    expect(b.y).toBeCloseTo(basket.height + BALL_RADIUS, 9);
  });

  it("doesn't tunnel through thin candles at full throw speed", () => {
    const cake = getArena("cake");
    const candle = cake.cover[0] as CoverCylinder;
    // Off-center: the chord through the contact zone (0.7 m) is shorter than one tick of travel (1.13 m).
    const b = ball({ x: candle.x + 0.45, y: 1, z: candle.z + 3, vz: -34, state: "live" });
    const results = run(b, ballCtx(cake), 8);
    const hit = results.find((r) => r.bounced);
    expect(hit?.bounceSurface).toBe(0);
    // A glancing hit on the +x side deflects the ball toward +x and slows it; it doesn't pass through.
    expect(b.vx).toBeGreaterThan(0);
    expect(Math.abs(b.vz)).toBeLessThan(34);
  });
});

describe("falling off", () => {
  it("reports lost once the ball falls below y = -6 past the edge", () => {
    const b = ball({ x: 14.9, y: 1, vx: 5, state: "dead" });
    const results = run(b, ballCtx(), 60);
    const lost = results.findIndex((r) => r.lost);
    expect(lost).toBeGreaterThan(15);
    expect(lost).toBeLessThan(40);
  });

  it("falls through fallen rings and never regains floor from below", () => {
    const arena = openArena();
    const rolling = ball({ x: 13.5, y: BALL_RADIUS, state: "neutral" });
    expect(run(rolling, ballCtx(arena, [0, 0, 0, 0, 2]), 40).some((r) => r.lost)).toBe(true);

    const under = ball({ y: -0.1, vy: 0, state: "dead" });
    const results = run(under, ballCtx(arena), 40);
    expect(results.some((r) => r.bounced)).toBe(false);
    expect(results.some((r) => r.lost)).toBe(true);
    expect(under.y).toBeLessThan(-6);
  });
});

describe("curveball", () => {
  const steerLeft = aimDirection(0.5, 0);

  it("steers horizontally toward the thrower's aim, keeping speed and the gravity arc", () => {
    const curved = ball({ y: 2, vy: 10, vz: -20, state: "live", curve: true });
    const straight = ball({ y: 2, vy: 10, vz: -20, state: "live" });
    const ctx = { ...ballCtx(), steer: steerLeft };
    stepBall(curved, ctx);
    stepBall(straight, ctx);
    expect(Math.hypot(curved.vx, curved.vz)).toBeCloseTo(20, 9);
    expect(curved.vx).toBeLessThan(0);
    expect(curved.vy).toBe(straight.vy);
    // One tick of steering is bounded by CURVE_ACCEL·dt.
    expect(Math.hypot(curved.vx - straight.vx, curved.vz - straight.vz)).toBeLessThanOrEqual(CURVE_ACCEL * DT + 1e-9);

    for (let i = 0; i < 20; i++) stepBall(curved, ctx);
    const heading = Math.atan2(-curved.vx, -curved.vz);
    expect(heading).toBeCloseTo(0.5, 6);
  });

  it("only steers live curve balls during the first 1.5 s with a steer direction", () => {
    const ctx = { ...ballCtx(), steer: steerLeft };
    const late = ball({ y: 3, vz: -20, state: "live", curve: true, ageTicks: CURVE_MAX_TICKS - 1 });
    stepBall(late, ctx);
    expect(late.vx).toBe(0);

    const noSteer = ball({ y: 3, vz: -20, state: "live", curve: true });
    stepBall(noSteer, ballCtx());
    expect(noSteer.vx).toBe(0);

    const dead = ball({ y: 3, vz: -20, state: "dead", curve: true });
    stepBall(dead, ctx);
    expect(dead.vx).toBe(0);
  });
});

describe("boomerang", () => {
  const owner: Vec3 = vec3(0, 1, 0);

  function boomerang(fields: Partial<BallSim>): BallSim {
    return ball({ x: 0.35, y: 1, z: -0.5, state: "live", kind: "boomerang", ...fields });
  }

  it("starts returning on its first bounce and flies home without gravity", () => {
    const b = boomerang({ vz: -10 });
    const ctx = { ...ballCtx(), returnTarget: owner };
    const results = run(b, ctx, 15);
    const bounce = results.findIndex((r) => r.bounced);
    expect(bounce).toBeGreaterThan(5);
    expect(results[bounce]).toMatchObject({ startedReturning: true, becameDead: false });
    expect(b.state).toBe("live");
    expect(b.returning).toBe(true);
    expect(speed(b)).toBeCloseTo(BOOMERANG_RETURN_SPEED, 9);
    const toOwner = Math.hypot(owner.x - b.x, owner.y - b.y, owner.z - b.z);
    const dir = { x: (owner.x - b.x) / toOwner, y: (owner.y - b.y) / toOwner, z: (owner.z - b.z) / toOwner };
    stepBall(b, ctx);
    expect(b.vx * dir.x + b.vy * dir.y + b.vz * dir.z).toBeCloseTo(BOOMERANG_RETURN_SPEED, 6);
  });

  it("returns after 1.2 s in the air and closes in on the owner", () => {
    const b = boomerang({ vy: 12, vz: -10 });
    const ctx = { ...ballCtx(), returnTarget: owner };
    const results = run(b, ctx, BOOMERANG_RETURN_TICKS);
    expect(results.findIndex((r) => r.startedReturning)).toBe(BOOMERANG_RETURN_TICKS - 1);
    expect(results.some((r) => r.bounced)).toBe(false);
    let distance = Infinity;
    for (let i = 0; i < 60; i++) {
      stepBall(b, ctx);
      const d = Math.hypot(owner.x - b.x, owner.y - b.y, owner.z - b.z);
      if (d < 1) break; // the server auto-catches here
      expect(d).toBeLessThan(distance);
      distance = d;
    }
    expect(Math.hypot(owner.x - b.x, owner.y - b.y, owner.z - b.z)).toBeLessThan(1);
  });

  it("turns dead when the owner is gone, after giving up, or on a second bounce", () => {
    const orphan = boomerang({ y: 3, returning: true, ageTicks: 40 });
    const r1 = stepBall(orphan, ballCtx());
    expect(r1.becameDead).toBe(true);
    expect(orphan).toMatchObject({ state: "dead", returning: false });

    const tired = boomerang({ y: 3, returning: true, ageTicks: BOOMERANG_RETURN_TICKS + BOOMERANG_MAX_RETURN_TICKS });
    expect(stepBall(tired, { ...ballCtx(), returnTarget: vec3(0, 1, 30) }).becameDead).toBe(true);

    const homing = boomerang({ y: 0.4, returning: true, ageTicks: 40 });
    const r3 = stepBall(homing, { ...ballCtx(), returnTarget: vec3(0, -5, -1) });
    expect(r3).toMatchObject({ bounced: true, becameDead: true, startedReturning: false });
  });
});

describe("determinism", () => {
  it("replays bit-identically from the same state", () => {
    const cake = getArena("cake");
    const rand = lcg(7);
    for (let n = 0; n < 40; n++) {
      const start = ball({
        x: (rand() - 0.5) * 10,
        y: 1 + rand() * 3,
        z: (rand() - 0.5) * 10,
        vx: (rand() - 0.5) * 60,
        vy: (rand() - 0.3) * 20,
        vz: (rand() - 0.5) * 60,
        state: "live",
        kind: rand() < 0.3 ? "boomerang" : "normal",
        curve: rand() < 0.5,
      });
      const steer = aimDirection(rand() * 6, 0);
      const target = vec3(0, 1, 0);
      const ctx: BallContext = { arena: cake, rings: [0, 0, 0, 1, 2], dt: DT, steer, returnTarget: target };
      const a = { ...start };
      const b = { ...start };
      const ra = run(a, ctx, 200);
      // Interleave other balls so module scratch can't leak between calls.
      const other = ball({ y: 5, vx: 9, state: "live" });
      const rb: StepBallResult[] = [];
      for (let i = 0; i < 200; i++) {
        stepBall(other, { ...ctx, steer: null });
        rb.push(stepBall(b, ctx));
      }
      expect(b).toStrictEqual(a);
      expect(rb).toStrictEqual(ra);
    }
  });
});
