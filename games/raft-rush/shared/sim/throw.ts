// Aim + throw math shared by the server throw, the client's predicted projectile, the arc preview and bots.
// Owner: sim. Deterministic.
//
// Consistency with stepProjectile (projectile.ts): free flight there integrates the exact gravity parabola
// (average vertical speed per tick, gravity × ITEMS[kind].gravityScale), so ballisticPoint(origin, v, k·DT) IS
// the simulated center after k ticks until the first contact, and flightTime / sampleTrajectory end where the
// simulated projectile first touches the terrain (contact = center within `radius` of the surface, the same
// test stepProjectile uses). The PROJECTILE_MAX_SPEED clamp (45 m/s) never engages for a throw on the island:
// a full 34 m/s throw would have to fall > 20 m to reach it. Cover is ignored here (preview / bot estimate).

import {
  COCONUT_BALL_COUNT,
  COCONUT_BALL_SPREAD,
  DT,
  EYE_HEIGHT,
  GRAVITY,
  HAND_FORWARD,
  HAND_RIGHT,
  THROW_PITCH_BIAS,
  THROW_SPEED_MAX,
  THROW_SPEED_MIN,
  TOSS_PITCH,
  TOSS_SPEED,
  WATER_Y,
} from "../constants.js";
import { heightAt } from "../island/heightfield.js";
import { ITEMS } from "../items.js";
import type { ItemKind } from "../types.js";
import type { WorldQuery } from "./context.js";
import { clamp, dirFromYawPitch, lerp, vec3, type Vec3 } from "./math.js";

/** Release pitch (aim pitch + bias) is clamped to ± this (straight up / down would lose the yaw). */
export const RELEASE_PITCH_LIMIT = 1.55;
/** Throw origin height above the feet: just below the eye (§19). */
export const HAND_HEIGHT = EYE_HEIGHT - 0.15;
/** Longest flight flightTime / sampleTrajectory look ahead by default (seconds). */
export const TRAJECTORY_MAX_SEC = 3;

/** Aim direction (unit): (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)). */
export function aimDirection(yaw: number, pitch: number, out: Vec3 = vec3()): Vec3 {
  return dirFromYawPitch(yaw, pitch, out);
}

/**
 * Throw origin: feet + (EYE_HEIGHT − 0.15) up + HAND_FORWARD along forward(yaw) + HAND_RIGHT along right(yaw)
 * (horizontal frame; pitch does not move the hand), §19 (hand just below the eye).
 */
export function throwOrigin(p: { x: number; y: number; z: number; yaw: number }, out: Vec3 = vec3()): Vec3 {
  const s = Math.sin(p.yaw);
  const c = Math.cos(p.yaw);
  out.x = p.x - s * HAND_FORWARD + c * HAND_RIGHT;
  out.y = p.y + HAND_HEIGHT;
  out.z = p.z - c * HAND_FORWARD - s * HAND_RIGHT;
  return out;
}

/** lerp(THROW_SPEED_MIN, THROW_SPEED_MAX, clamp(charge, 0, 1)). */
export function throwSpeed(charge: number): number {
  return lerp(THROW_SPEED_MIN, THROW_SPEED_MAX, clamp(charge, 0, 1));
}

/** Inverse of throwSpeed: the charge fraction (clamped to [0, 1]) that releases at `speed`. */
export function chargeForSpeed(speed: number): number {
  return clamp((speed - THROW_SPEED_MIN) / (THROW_SPEED_MAX - THROW_SPEED_MIN), 0, 1);
}

/** Release velocity of a charged throw: aimDirection(yaw, pitch + THROW_PITCH_BIAS) × throwSpeed(charge). */
export function computeThrowVelocity(charge: number, yaw: number, pitch: number, out: Vec3 = vec3()): Vec3 {
  const speed = throwSpeed(charge);
  dirFromYawPitch(yaw, clamp(pitch + THROW_PITCH_BIAS, -RELEASE_PITCH_LIMIT, RELEASE_PITCH_LIMIT), out);
  out.x *= speed;
  out.y *= speed;
  out.z *= speed;
  return out;
}

/** Q toss / pass: aimDirection(yaw, pitch + TOSS_PITCH) × TOSS_SPEED. */
export function computeTossVelocity(yaw: number, pitch: number, out: Vec3 = vec3()): Vec3 {
  dirFromYawPitch(yaw, clamp(pitch + TOSS_PITCH, -RELEASE_PITCH_LIMIT, RELEASE_PITCH_LIMIT), out);
  out.x *= TOSS_SPEED;
  out.y *= TOSS_SPEED;
  out.z *= TOSS_SPEED;
  return out;
}

/**
 * Every projectile a release spawns, index-aligned with ThrowEvent.velocities: one, or COCONUT_BALL_COUNT
 * coconuts for a coconut_ball (center, then −spread, +spread around the yaw).
 */
export function computeThrowVelocities(req: { kind: ItemKind; charge: number; toss: boolean; yaw: number; pitch: number }): Vec3[] {
  if (req.toss) return [computeTossVelocity(req.yaw, req.pitch)];
  if (req.kind === "coconut_ball") {
    const out: Vec3[] = [];
    for (let i = 0; i < COCONUT_BALL_COUNT; i++) {
      const off = i === 0 ? 0 : i === 1 ? -COCONUT_BALL_SPREAD : COCONUT_BALL_SPREAD;
      out.push(computeThrowVelocity(req.charge, req.yaw + off, req.pitch));
    }
    return out;
  }
  return [computeThrowVelocity(req.charge, req.yaw, req.pitch)];
}

/** Kind of the projectiles a release spawns (a coconut ball releases plain coconuts). */
export function projectileKindForThrow(kind: ItemKind): ItemKind {
  return kind === "coconut_ball" ? "coconut" : kind;
}

/** Position on the gravity-only parabola after t seconds (gravityScale of the item). */
export function ballisticPoint(origin: Vec3, velocity: Vec3, t: number, gravityScale: number, out: Vec3 = vec3()): Vec3 {
  out.x = origin.x + velocity.x * t;
  out.y = origin.y + velocity.y * t + 0.5 * GRAVITY * gravityScale * t * t;
  out.z = origin.z + velocity.z * t;
  return out;
}

export interface TrajectoryOptions {
  kind: ItemKind;
  /** Max points returned (≥ 2 for a line). */
  maxPoints: number;
  /** Fraction (0..1] of the flight time up to the first terrain / water contact to cover. */
  fraction: number;
  /** Give up after this many seconds (default 3). */
  maxSec?: number;
}

const probe: Vec3 = vec3();

/** The center at `p` touches the terrain or the water surface (within `radius`). */
function touchesSurface(q: WorldQuery, p: Vec3, radius: number): boolean {
  const ground = heightAt(q.terrain, p.x, p.z);
  return p.y - radius <= (ground > WATER_Y ? ground : WATER_Y);
}

/**
 * Flight time until the first terrain contact (or crossing below the water surface) along the gravity-only
 * parabola, sampled at DT/2. Cover is ignored (preview / bot estimate only).
 * The crossing is refined by bisection inside the first sample that touches, so the result is the contact
 * time to well under a millisecond (not the next DT/2 sample). Returns maxSec when nothing is hit.
 */
export function flightTime(q: WorldQuery, origin: Vec3, velocity: Vec3, kind: ItemKind, maxSec = TRAJECTORY_MAX_SEC): number {
  const g = ITEMS[kind].gravityScale;
  const r = ITEMS[kind].radius;
  const h = DT / 2;
  const steps = Math.floor(maxSec / h + 1e-9);
  for (let k = 1; k <= steps; k++) {
    const t = k * h;
    ballisticPoint(origin, velocity, t, g, probe);
    if (!touchesSurface(q, probe, r)) continue;
    let lo = t - h;
    let hi = t;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) * 0.5;
      ballisticPoint(origin, velocity, mid, g, probe);
      if (touchesSurface(q, probe, r)) hi = mid;
      else lo = mid;
    }
    return hi;
  }
  return maxSec;
}

/** Points on the parabola covering `fraction` of the flight time, evenly spaced in time (arc preview). */
export function sampleTrajectory(q: WorldQuery, origin: Vec3, velocity: Vec3, opts: TrajectoryOptions): Vec3[] {
  return sampleTrajectoryInto(q, origin, velocity, opts, []);
}

/** Allocation-light sampleTrajectory(): reuses `out`'s point objects, sets out.length. */
export function sampleTrajectoryInto(q: WorldQuery, origin: Vec3, velocity: Vec3, opts: TrajectoryOptions, out: Vec3[]): Vec3[] {
  const span = flightTime(q, origin, velocity, opts.kind, opts.maxSec ?? TRAJECTORY_MAX_SEC) * clamp(opts.fraction, 0, 1);
  const wanted = Math.floor(opts.maxPoints);
  const count = span > 0 && wanted >= 2 ? wanted : 1;
  const g = ITEMS[opts.kind].gravityScale;
  for (let i = 0; i < count; i++) {
    const point = out[i] ?? (out[i] = vec3());
    const t = count === 1 ? 0 : (span * i) / (count - 1);
    ballisticPoint(origin, velocity, t, g, point);
  }
  out.length = count;
  return out;
}

/**
 * Closed-form launch pitch to hit `target` from `origin` at `speed` (low arc), for bots. Returns the aim pitch
 * to put in InputCmd (THROW_PITCH_BIAS already subtracted) and the flight time, or null when out of range.
 */
export function solveBallistic(
  origin: Vec3,
  target: Vec3,
  speed: number,
  gravityScale: number,
): { pitch: number; yaw: number; time: number } | null {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const dy = target.y - origin.y;
  const d = Math.sqrt(dx * dx + dz * dz);
  const g = -GRAVITY * gravityScale;
  const v2 = speed * speed;
  const disc = v2 * v2 - g * (g * d * d + 2 * dy * v2);
  if (disc < 0 || d < 1e-6) return null;
  const angle = Math.atan((v2 - Math.sqrt(disc)) / (g * d));
  const yaw = Math.atan2(-dx, -dz);
  const time = d / (speed * Math.cos(angle));
  return { pitch: angle - THROW_PITCH_BIAS, yaw, time };
}

/**
 * Slowest launch speed that reaches `target` from `origin` at all (the 45°-ish optimal arc):
 * v² = g·(dy + √(d² + dy²)). Bots compare it with THROW_SPEED_MIN..MAX to pick a charge.
 */
export function minLaunchSpeed(origin: Vec3, target: Vec3, gravityScale: number): number {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const dy = target.y - origin.y;
  const g = -GRAVITY * gravityScale;
  return Math.sqrt(g * (dy + Math.sqrt(dx * dx + dz * dz + dy * dy)));
}

const aimFeet = { x: 0, y: 0, z: 0, yaw: 0 };
const aimOrigin: Vec3 = vec3();

/**
 * Aim a player standing with the feet at `feet` so that a release at `speed` (low arc) hits `target`:
 * solveBallistic from the real throwOrigin, iterated because the hand offset (HAND_RIGHT) depends on the yaw.
 * `kind` picks the gravity scale. Returns the InputCmd yaw / pitch, the charge for `speed`, the origin used and
 * the flight time, or null when out of range.
 */
export function aimThrowAt(
  feet: { x: number; y: number; z: number },
  target: Vec3,
  speed: number,
  kind: ItemKind,
): { yaw: number; pitch: number; charge: number; time: number; origin: Vec3 } | null {
  const g = ITEMS[projectileKindForThrow(kind)].gravityScale;
  aimFeet.x = feet.x;
  aimFeet.y = feet.y;
  aimFeet.z = feet.z;
  aimFeet.yaw = Math.atan2(-(target.x - feet.x), -(target.z - feet.z));
  let sol: { pitch: number; yaw: number; time: number } | null = null;
  for (let i = 0; i < 3; i++) {
    throwOrigin(aimFeet, aimOrigin);
    sol = solveBallistic(aimOrigin, target, speed, g);
    if (sol === null) return null;
    aimFeet.yaw = sol.yaw;
  }
  throwOrigin(aimFeet, aimOrigin);
  return { yaw: sol!.yaw, pitch: sol!.pitch, charge: chargeForSpeed(speed), time: sol!.time, origin: vec3(aimOrigin.x, aimOrigin.y, aimOrigin.z) };
}
