// Aim + throw math shared by the server throw, the client predicted ball and the arc preview.
// Owner: sim. Deterministic.

import {
  BALL_KILL_Y,
  CHEST_HEIGHT,
  DT,
  FLOOR_Y,
  GRAVITY,
  HAND_FORWARD,
  HAND_RIGHT,
  KNOCK_GETUP_TICKS,
  KNOCK_HEARTS_MULT,
  KNOCK_MAX_SPEED,
  KNOCK_STUN_MAX_TICKS,
  KNOCK_STUN_MIN_TICKS,
  KNOCKBACK_FULL_CHARGE_MULT,
  KNOCKBACK_MEGA_MULT,
  KNOCKBACK_STUN_TICKS,
  MAX_HEARTS,
  THROW_PITCH_BIAS,
  THROW_SPEED_MAX,
  THROW_SPEED_MIN,
  TRIPLE_SPREAD_RAD,
  TUMBLE_GRAVITY_MULT,
} from "../constants.js";
import type { BallKind, HeldPowerUp, Vec3Like } from "../types.js";
import type { FloorQuery } from "./context.js";
import { isFloorAt, sphereCoverContactInto, type Contact } from "./geometry.js";
import { clamp, dirFromYawPitch, lerp, vec3, type Vec3 } from "./math.js";

/** Aim direction (unit): (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)). */
export function aimDirection(yaw: number, pitch: number, out: Vec3 = vec3()): Vec3 {
  return dirFromYawPitch(yaw, pitch, out);
}

/** Chest point: feet + (0, CHEST_HEIGHT, 0). */
export function chestPosition(p: { x: number; y: number; z: number }, out: Vec3 = vec3()): Vec3 {
  out.x = p.x;
  out.y = p.y + CHEST_HEIGHT;
  out.z = p.z;
  return out;
}

/**
 * Hand / throw origin: feet + CHEST_HEIGHT up + HAND_FORWARD along forward(yaw) +
 * HAND_RIGHT along right(yaw). Horizontal frame only (pitch does not move the hand).
 */
export function throwOrigin(p: { x: number; y: number; z: number; yaw: number }, out: Vec3 = vec3()): Vec3 {
  const s = Math.sin(p.yaw);
  const c = Math.cos(p.yaw);
  out.x = p.x - s * HAND_FORWARD + c * HAND_RIGHT;
  out.y = p.y + CHEST_HEIGHT;
  out.z = p.z - c * HAND_FORWARD - s * HAND_RIGHT;
  return out;
}

/** Throw speed for a charge fraction: lerp(THROW_SPEED_MIN, THROW_SPEED_MAX, clamp(charge, 0, 1)). */
export function throwSpeed(charge: number): number {
  return lerp(THROW_SPEED_MIN, THROW_SPEED_MAX, clamp(charge, 0, 1));
}

/** Ball kind produced by a throw with this held power-up. */
export function ballKindForPowerUp(powerUp: HeldPowerUp): BallKind {
  return powerUp === "mega" ? "mega" : powerUp === "boomerang" ? "boomerang" : "normal";
}

const BIAS_COS = Math.cos(THROW_PITCH_BIAS);
const BIAS_SIN = Math.sin(THROW_PITCH_BIAS);

/**
 * Release velocity of the CENTER ball: direction = aim rotated up by THROW_PITCH_BIAS
 * (i.e. aimDirection(yaw, pitch + THROW_PITCH_BIAS) when given yaw/pitch), magnitude = throwSpeed(charge).
 * `aim` is the unit aim direction (aimDirection(yaw, pitch)); the bias rotates it inside its own
 * vertical plane (same result as recomputing pitch, without the trig round trip). A non-unit aim
 * is normalized first. Power-ups don't change speed (mega/triple/boomerang change kind/count only),
 * so `powerUp` is accepted for call-site symmetry and ignored.
 */
export function computeThrowVelocity(charge: number, aim: Vec3, powerUp: HeldPowerUp, out: Vec3 = vec3()): Vec3 {
  const speed = throwSpeed(charge);
  const h = Math.sqrt(aim.x * aim.x + aim.z * aim.z);
  const len = Math.sqrt(h * h + aim.y * aim.y);
  if (len < 1e-9) {
    out.x = 0;
    out.y = speed;
    out.z = 0;
    return out;
  }
  const h0 = h / len;
  const y0 = aim.y / len;
  const h1 = h0 * BIAS_COS - y0 * BIAS_SIN;
  const y1 = y0 * BIAS_COS + h0 * BIAS_SIN;
  const k = h > 1e-9 ? (h1 / h) * speed : 0;
  out.x = aim.x * k;
  out.y = y1 * speed;
  out.z = aim.z * k;
  return out;
}

/**
 * All release velocities for a throw: [center] normally; for Triple Shot
 * [center, left (yaw + TRIPLE_SPREAD_RAD), right (yaw - TRIPLE_SPREAD_RAD)] — index order matches
 * BallView.throwIndex 0/1/2. Each is computeThrowVelocity with the rotated aim.
 * Index 0 is the thrown ball (kind ballKindForPowerUp(powerUp)); indices 1/2 are new kind "bonus"
 * balls. All of them share the throw's ownerId, throwSeq, charge and curve flag (server and the
 * client's predicted throw alike).
 */
export function computeThrowVelocities(charge: number, yaw: number, pitch: number, powerUp: HeldPowerUp): Vec3[] {
  const center = computeThrowVelocity(charge, aimDirection(yaw, pitch), powerUp);
  if (powerUp !== "triple") return [center];
  const left = computeThrowVelocity(charge, aimDirection(yaw + TRIPLE_SPREAD_RAD, pitch), powerUp);
  const right = computeThrowVelocity(charge, aimDirection(yaw - TRIPLE_SPREAD_RAD, pitch), powerUp);
  return [center, left, right];
}

/**
 * Knockback multiplier of a hit: lerp(1, KNOCKBACK_FULL_CHARGE_MULT, charge) × (mega ? KNOCKBACK_MEGA_MULT : 1).
 */
export function knockbackMultiplier(charge: number, kind: BallKind): number {
  return lerp(1, KNOCKBACK_FULL_CHARGE_MULT, clamp(charge, 0, 1)) * (kind === "mega" ? KNOCKBACK_MEGA_MULT : 1);
}

/**
 * Hearts tension: KNOCK_HEARTS_MULT[clamp(MAX_HEARTS − heartsAfter, 0, 3)], where heartsAfter is
 * the target's hearts after this hit's damage (3 → ×1, 2 → ×1.12, 1 or 0 → ×1.3).
 */
export function heartsKnockMultiplier(heartsAfter: number): number {
  const lost = MAX_HEARTS - (Number.isFinite(heartsAfter) ? Math.round(heartsAfter) : MAX_HEARTS);
  const i = lost < 0 ? 0 : lost > KNOCK_HEARTS_MULT.length - 1 ? KNOCK_HEARTS_MULT.length - 1 : lost;
  return KNOCK_HEARTS_MULT[i];
}

/**
 * Launch velocity of a knockback: (dirX·h·mult, up·mult, dirZ·h·mult) with (dirX, dirZ) a unit
 * horizontal direction, its length clamped to KNOCK_MAX_SPEED (direction kept). Writes `out`.
 */
export function launchVelocity(dirX: number, dirZ: number, h: number, up: number, mult: number, out: Vec3): Vec3 {
  out.x = dirX * h * mult;
  out.y = up * mult;
  out.z = dirZ * h * mult;
  const len = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
  if (len > KNOCK_MAX_SPEED) {
    const k = KNOCK_MAX_SPEED / len;
    out.x *= k;
    out.y *= k;
    out.z *= k;
  }
  return out;
}

/**
 * Stun of a launch: the time a TUMBLE_GRAVITY_MULT arc takes to come back down to launch height
 * (2·vy / g) in ticks, plus KNOCK_GETUP_TICKS, clamped to
 * [max(KNOCK_STUN_MIN_TICKS, KNOCKBACK_STUN_TICKS), KNOCK_STUN_MAX_TICKS]. The stun covers the whole
 * flight (no mid-air control that erases the knockback), DI aside.
 */
export function knockStunTicks(launch: Vec3Like): number {
  const g = -GRAVITY * TUMBLE_GRAVITY_MULT;
  const flight = Math.ceil((2 * Math.max(0, launch.y)) / g / DT - 1e-9);
  const min = Math.max(KNOCK_STUN_MIN_TICKS, KNOCKBACK_STUN_TICKS);
  const ticks = flight + KNOCK_GETUP_TICKS;
  return ticks < min ? min : ticks > KNOCK_STUN_MAX_TICKS ? KNOCK_STUN_MAX_TICKS : ticks;
}

/* ============================================================ trajectory */

export interface TrajectoryOptions {
  /** Ball radius (BALL_RADIUS or MEGA_BALL_RADIUS). */
  radius: number;
  /** Fraction of the full flight (until first floor/cover contact or 3 s) to return. ARC_PREVIEW_FRACTION for the HUD arc. */
  fraction: number;
  /** Max points returned (evenly spaced in time). ARC_PREVIEW_MAX_POINTS. */
  maxPoints: number;
}

/** Longest flight sampleTrajectory looks ahead. */
export const TRAJECTORY_MAX_SEC = 3;
/** Collision sub-steps per DT are capped at this (fast balls vs thin candles). */
const MAX_SUBSTEPS = 8;

const probe: Vec3 = vec3();
const probeContact: Contact = { nx: 0, ny: 0, nz: 0, depth: 0, coverIndex: -1 };

/** Point at time t on the gravity-only path from origin with velocity (exact parabola). */
export function ballisticPoint(origin: Vec3, velocity: Vec3, t: number, out: Vec3 = vec3()): Vec3 {
  out.x = origin.x + velocity.x * t;
  out.y = origin.y + velocity.y * t + 0.5 * GRAVITY * t * t;
  out.z = origin.z + velocity.z * t;
  return out;
}

/** Collision sub-steps so a ball never moves more than its radius between checks. */
export function substepCount(distance: number, radius: number): number {
  if (!(distance > radius) || radius <= 0) return 1;
  return Math.min(MAX_SUBSTEPS, Math.ceil(distance / radius));
}

/**
 * Seconds until the gravity-only path first touches the floor (where solid) or cover, falls below
 * BALL_KILL_Y, or TRAJECTORY_MAX_SEC. The floor crossing is interpolated inside the step.
 */
export function flightTime(q: FloorQuery, origin: Vec3, velocity: Vec3, radius: number): number {
  const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z);
  const h = DT / substepCount(speed * DT, radius);
  const steps = Math.ceil(TRAJECTORY_MAX_SEC / h);
  let prevY = origin.y;
  for (let k = 1; k <= steps; k++) {
    const t = k * h;
    ballisticPoint(origin, velocity, t, probe);
    if (probe.y < BALL_KILL_Y) return t;
    if (sphereCoverContactInto(q.arena, probe, radius, probeContact)) return t;
    const floorY = FLOOR_Y + radius;
    if (prevY > FLOOR_Y && probe.y < floorY && isFloorAt(q, probe.x, probe.z)) {
      const frac = prevY > floorY ? (prevY - floorY) / (prevY - probe.y) : 0;
      return t - h + clamp(frac, 0, 1) * h;
    }
    prevY = probe.y;
  }
  return TRAJECTORY_MAX_SEC;
}

/**
 * Sample the ballistic path from origin with velocity (gravity only, no bounces, no curve).
 * Simulates until the first floor/cover contact (or 3 s / falling below BALL_KILL_Y), then returns
 * points covering the first `fraction` of that flight time, starting at origin. Points lie exactly
 * on the same parabola stepBall integrates, evenly spaced in time; `maxPoints` of them (at least
 * the origin alone when maxPoints < 2 or the flight is instant).
 * Used by the full-charge arc preview (client-fx ArcPreview gets these points from client-app).
 */
export function sampleTrajectory(q: FloorQuery, origin: Vec3, velocity: Vec3, opts: TrajectoryOptions): Vec3[] {
  return sampleTrajectoryInto(q, origin, velocity, opts, []);
}

/**
 * Allocation-light sampleTrajectory(): reuses the point objects already in `out` (adds missing
 * ones), sets out.length to the point count and returns `out`. Handy for a per-frame arc preview.
 */
export function sampleTrajectoryInto(
  q: FloorQuery,
  origin: Vec3,
  velocity: Vec3,
  opts: TrajectoryOptions,
  out: Vec3[],
): Vec3[] {
  const span = flightTime(q, origin, velocity, opts.radius) * clamp(opts.fraction, 0, 1);
  const wanted = Math.floor(opts.maxPoints);
  const count = span > 0 && wanted >= 2 ? wanted : 1;
  for (let i = 0; i < count; i++) {
    const point = out[i] ?? (out[i] = vec3());
    const t = count === 1 ? 0 : (span * i) / (count - 1);
    ballisticPoint(origin, velocity, t, point);
  }
  out.length = count;
  return out;
}
