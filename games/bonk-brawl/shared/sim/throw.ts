// Aim + throw math shared by the server throw, the client predicted ball and the arc preview.
// Owner: sim. Deterministic.

import {
  CHEST_HEIGHT,
  HAND_FORWARD,
  HAND_RIGHT,
  KNOCKBACK_FULL_CHARGE_MULT,
  KNOCKBACK_MEGA_MULT,
  THROW_PITCH_BIAS,
  THROW_SPEED_MAX,
  THROW_SPEED_MIN,
} from "../constants.js";
import type { BallKind, HeldPowerUp } from "../types.js";
import type { FloorQuery } from "./context.js";
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

/**
 * Release velocity of the CENTER ball: direction = aim rotated up by THROW_PITCH_BIAS
 * (i.e. aimDirection(yaw, pitch + THROW_PITCH_BIAS) when given yaw/pitch), magnitude = throwSpeed(charge).
 * `aim` is the unit aim direction (aimDirection(yaw, pitch)); the bias is applied by recomputing
 * pitch from it. Power-ups don't change speed (mega/triple/boomerang change kind/count only).
 */
export function computeThrowVelocity(charge: number, aim: Vec3, powerUp: HeldPowerUp, out: Vec3 = vec3()): Vec3 {
  // TODO(sim): implement exactly as documented (bias + speed). Placeholder: no bias.
  void powerUp;
  const speed = throwSpeed(charge);
  out.x = aim.x * speed;
  out.y = aim.y * speed;
  out.z = aim.z * speed;
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
  // TODO(sim): add the triple spread.
  return [computeThrowVelocity(charge, aimDirection(yaw, pitch), powerUp)];
}

/**
 * Knockback multiplier of a hit: lerp(1, KNOCKBACK_FULL_CHARGE_MULT, charge) × (mega ? KNOCKBACK_MEGA_MULT : 1).
 */
export function knockbackMultiplier(charge: number, kind: BallKind): number {
  return lerp(1, KNOCKBACK_FULL_CHARGE_MULT, clamp(charge, 0, 1)) * (kind === "mega" ? KNOCKBACK_MEGA_MULT : 1);
}

export interface TrajectoryOptions {
  /** Ball radius (BALL_RADIUS or MEGA_BALL_RADIUS). */
  radius: number;
  /** Fraction of the full flight (until first floor/cover contact or 3 s) to return. ARC_PREVIEW_FRACTION for the HUD arc. */
  fraction: number;
  /** Max points returned (evenly spaced in time). ARC_PREVIEW_MAX_POINTS. */
  maxPoints: number;
}

/**
 * Sample the ballistic path from origin with velocity (gravity only, no bounces, no curve).
 * Simulates in DT steps until the first floor/cover contact (or 3 s / falling below BALL_KILL_Y),
 * then returns points covering the first `fraction` of that flight time, starting at origin.
 * Used by the full-charge arc preview (client-fx ArcPreview gets these points from client-app).
 */
export function sampleTrajectory(q: FloorQuery, origin: Vec3, velocity: Vec3, opts: TrajectoryOptions): Vec3[] {
  // TODO(sim): implement as documented.
  void q;
  void velocity;
  void opts;
  return [{ x: origin.x, y: origin.y, z: origin.z }];
}
