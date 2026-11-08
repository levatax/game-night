import { describe, expect, it } from "vitest";
import { CHARACTER_IDS, DT, KNOCK_GETUP_TICKS } from "../../../shared/constants";
import type { CharacterId, PlayerAction } from "../../../shared/types";
import { createPose, POSE_KEYS, restPose } from "./pose";
import { createPuppetFrame } from "./puppet";
import {
  advanceGait,
  createMotionInfo,
  evaluateState,
  type FaceParts,
  stateExpression,
  Tumble,
  TUMBLE_NONE,
  type TumbleInput,
} from "./states";

const ACTIONS: PlayerAction[] = ["idle", "run", "jump", "fall", "charge", "catch", "whiff", "roll", "stunned", "ability", "ghost"];
const TAU = Math.PI * 2;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ABILITY: Record<CharacterId, "flapDash" | "groundPound" | "bellyBounce" | "curveball" | "bellySlide" | "headbutt"> = {
  quacky: "flapDash",
  hopsworth: "groundPound",
  mochi: "bellyBounce",
  whiskers: "curveball",
  pip: "bellySlide",
  gruff: "headbutt",
};

describe("states", () => {
  it("every action × character × random motion gives a finite, bounded pose and a face", () => {
    const r = rng(7);
    const ids = (CHARACTER_IDS as ReadonlyArray<CharacterId>) ?? (Object.keys(ABILITY) as CharacterId[]);
    const face: FaceParts = { eyes: null, mouth: null };
    const pose = createPose();
    for (const character of ids) {
      for (const action of ACTIONS) {
        for (let n = 0; n < 60; n++) {
          const frame = createPuppetFrame(character);
          frame.vx = (r() * 2 - 1) * 20;
          frame.vy = (r() * 2 - 1) * 20;
          frame.vz = (r() * 2 - 1) * 20;
          frame.pitch = (r() * 2 - 1) * 1.2;
          frame.grounded = r() < 0.5;
          frame.abilityPhase = r() < 0.5 ? 1 : 2;
          frame.curveArmed = r() < 0.3;
          frame.jumping = r() < 0.5;
          frame.stunTicks = Math.floor(r() * 36);
          const m = createMotionInfo(frame, character, ABILITY[character], r() * 100);
          m.t = r() * 3;
          m.time = r() * 100;
          m.speed = r() * 14;
          m.fwdSpeed = (r() * 2 - 1) * m.speed;
          m.rightSpeed = (r() * 2 - 1) * m.speed;
          m.speedNorm = m.speed / 6;
          m.accelFwd = (r() * 2 - 1) * 80;
          m.accelRight = (r() * 2 - 1) * 80;
          m.yawRate = (r() * 2 - 1) * 20;
          m.zoomies = r() < 0.3;
          advanceGait(m, r() * 0.1);
          m.skid = r();
          m.airU = r();
          m.apex = r();
          m.airSec = r() * 2;
          m.fallSec = r() * 2;
          m.jumpCut = r() < 0.5;
          m.charge = r();
          m.fullCharge = m.charge > 0.9;
          m.dirTurn = (r() * 2 - 1) * Math.PI;
          m.velTurn = (r() * 2 - 1) * Math.PI;
          m.tumbleMode = Math.floor(r() * 5);
          m.lying = r();
          m.launchStretch = r();
          m.look = (r() * 2 - 1) * 0.3;
          restPose(pose);
          evaluateState(action, pose, m);
          for (const key of POSE_KEYS) {
            const v = pose[key];
            expect(Number.isFinite(v), `${character} ${action} ${key}`).toBe(true);
            expect(Math.abs(v), `${character} ${action} ${key} = ${v}`).toBeLessThan(8);
          }
          expect(Math.abs(pose.lift)).toBeLessThan(1);
          expect(pose.crouch).toBeGreaterThan(-0.8);
          stateExpression(action, m, face);
        }
      }
    }
  });

  it("stride-locked cadence: cadence clamps and the stride amplitude grows above it", () => {
    const m = createMotionInfo(createPuppetFrame("quacky"), "quacky", "flapDash", 0);
    m.speed = 1.8; // 2 cycles/s at 0.9 m per cycle
    m.runPhase = 0;
    advanceGait(m, 0.5);
    expect(m.runPhase).toBeCloseTo(TAU * 2 * 0.5, 6);
    expect(m.strideAmp).toBeCloseTo(1, 6);
    m.speed = 6; // wants 6.7 cycles/s, max 4.5
    m.runPhase = 0;
    advanceGait(m, 0.1);
    expect(m.runPhase).toBeCloseTo(TAU * 4.5 * 0.1, 6);
    expect(m.strideAmp).toBeGreaterThan(1.4);
  });
});

/** Drive a Tumble through launch → flight → (bounce) → ground → stun end at a given frame rate. */
function runTumble(opts: {
  fps: number;
  vh: number;
  flightSec: number;
  groundStunTicks: number;
  bounceAt?: number;
  movingAfter?: boolean;
}): { landedMonotonic: boolean; uprightAfter: number; maxAngleRate: number } {
  const t = new Tumble();
  const dt = 1 / opts.fps;
  const input: TumbleInput = { stunned: true, grounded: false, stunTicks: 30, getUpTicks: KNOCK_GETUP_TICKS, speed: opts.vh };
  t.start(opts.vh, 0, 0.5, 1);
  let time = 0;
  let landed = false;
  let monotonic = true;
  let prev = t.angle;
  let maxRate = 0;
  // Flight.
  while (time < opts.flightSec) {
    time += dt;
    t.update(dt, input);
    maxRate = Math.max(maxRate, (t.angle - prev) / dt);
    prev = t.angle;
    if (opts.bounceAt !== undefined && Math.abs(time - opts.bounceAt) < dt / 2) t.bounce(opts.vh);
  }
  // Grounded while stunned: stun ticks run down at the 30 Hz sim rate.
  input.grounded = true;
  input.speed = 2;
  const groundSec = opts.groundStunTicks * DT;
  let g = 0;
  while (g < groundSec) {
    g += dt;
    input.stunTicks = Math.max(1, Math.ceil(opts.groundStunTicks - g / DT));
    t.update(dt, input);
    if (!landed) {
      landed = true;
      prev = t.angle;
    }
    // Finishing the get-up wraps the angle back to 0 (≡ TAU): not an unwind.
    if (t.mode !== TUMBLE_NONE && t.angle < prev - 1e-9) monotonic = false;
    prev = t.angle;
  }
  // Control returns.
  input.stunned = false;
  input.stunTicks = 0;
  input.speed = opts.movingAfter ? 4 : 0;
  let after = 0;
  let uprightAfter = Number.POSITIVE_INFINITY;
  while (after < 0.5) {
    after += dt;
    t.update(dt, input);
    const off = Math.abs(((((t.angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI);
    if (t.angle < prev - 1e-9 && t.mode !== TUMBLE_NONE) monotonic = false;
    prev = t.mode === TUMBLE_NONE ? prev : t.angle;
    if (off < 0.05 && uprightAfter === Number.POSITIVE_INFINITY && (t.mode === TUMBLE_NONE || off < 0.05)) uprightAfter = after;
  }
  expect(t.mode).toBe(TUMBLE_NONE);
  return { landedMonotonic: monotonic, uprightAfter, maxAngleRate: maxRate };
}

describe("Tumble", () => {
  it("never unwinds and is upright within 0.2 s after the stun ends", () => {
    for (const fps of [30, 60, 144]) {
      for (const vh of [3, 6, 9, 14, 20]) {
        for (const flightSec of [0.1, 0.25, 0.4, 0.55, 0.63, 0.8]) {
          for (const groundStunTicks of [0, 1, 3, 5, 8, 14]) {
            for (const movingAfter of [false, true]) {
              const res = runTumble({ fps, vh, flightSec, groundStunTicks, movingAfter });
              const label = `fps ${fps} vh ${vh} flight ${flightSec} ground ${groundStunTicks}`;
              expect(res.landedMonotonic, label).toBe(true);
              expect(res.uprightAfter, label).toBeLessThanOrEqual(0.2 + 1e-9);
            }
          }
        }
      }
    }
  });

  it("re-spins on a bounce and still settles forward", () => {
    const res = runTumble({ fps: 60, vh: 12, flightSec: 0.7, groundStunTicks: 6, bounceAt: 0.35 });
    expect(res.landedMonotonic).toBe(true);
    expect(res.uprightAfter).toBeLessThanOrEqual(0.2);
  });

  it("spins faster for stronger knocks (base ~11 rad/s, headbutt / mega capped at 22)", () => {
    const base = new Tumble();
    base.start(6, 0, 0.5, 1);
    expect(base.omega).toBeGreaterThan(10);
    expect(base.omega).toBeLessThan(12);
    const big = new Tumble();
    big.start(0, 14, 1, -1);
    expect(big.omega).toBe(22);
    expect(big.twistRate).toBeLessThan(0);
    const soft = new Tumble();
    soft.start(1, 0, 0.2, 1);
    expect(soft.omega).toBe(6);
    expect(soft.twistRate).toBe(0);
  });
});
