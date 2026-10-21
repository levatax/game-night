// Throw aiming for helper bots (§19 "aimAt: closed-form ballistic + personality noise", §21 aim noise).
// Owner: server-bots.
//
// aimAt() picks the smallest charge (whole charge ticks, because that is what holding LMB produces) whose low
// arc stays flatter than PREFERRED_MAX_ANGLE, solves the launch pitch in closed form (shared solveBallistic),
// then corrects that pitch with a few secant steps against the real shared stepProjectile integrated in an
// "open sky" context (no terrain, no cover), so whatever integration scheme the sim uses, the bot's throw
// passes through the target. Personality noise (BOT_AIM_NOISE_DEG) is applied last. Pure apart from `rng`.
// `high: true` solves the lob (the high root) for targets behind trees and rocks; shotClear() tells whether a
// throw's path is free of terrain, cover cylinders and teammates (the motor tries flat → lob → sidestep).

import { CHARGE_FULL_TICKS, DT, GRAVITY, PITCH_LIMIT, THROW_PITCH_BIAS, TOSS_PITCH, TOSS_SPEED } from "../../shared/constants.js";
import { createHeightfield, heightAt } from "../../shared/island/heightfield.js";
import { ITEMS } from "../../shared/items.js";
import type { ProjectileContext, WorldQuery } from "../../shared/sim/context.js";
import type { CoverCircle } from "../../shared/sim/cover.js";
import { clamp, yawFromDir, type Vec3 } from "../../shared/sim/math.js";
import { createProjectileSim, emptyProjectileResult, stepProjectileInto } from "../../shared/sim/projectile.js";
import { ballisticPoint, computeThrowVelocity, computeTossVelocity, solveBallistic, throwOrigin, throwSpeed } from "../../shared/sim/throw.js";
import type { ItemKind, ProjectileState } from "../../shared/types.js";

/** Flattest acceptable launch angle when picking the charge (radians above horizontal). */
export const PREFERRED_MAX_ANGLE = 0.32;
/** Pitch error tolerated by the refinement (meters of height at the target distance). */
const REFINE_TOLERANCE = 0.03;
const DEG = Math.PI / 180;

export interface AimSolution {
  /** InputCmd yaw / pitch at release (THROW_PITCH_BIAS / TOSS_PITCH already accounted for). */
  yaw: number;
  pitch: number;
  /** Charge fraction at release and the charge ticks (LMB held ticks) that produce it. */
  charge: number;
  chargeTicks: number;
  /** Flight time to the target (s). */
  time: number;
}

export interface AimOptions {
  /** Use exactly this charge (rounded to whole charge ticks) instead of picking one. */
  charge?: number;
  /** Lob: the high root of the ballistic solution (over trees and rocks), with the slowest charge that reaches. */
  high?: boolean;
  /** Q toss (fixed TOSS_SPEED, + TOSS_PITCH) instead of a charged throw. */
  toss?: boolean;
  /** Skip the stepProjectile refinement (closed form only). */
  refine?: boolean;
}

/* ---------------------------------------------------------------- open sky */

const SKY_LIFT = 400;
const SKY: ProjectileContext = {
  terrain: createHeightfield(2, 2, 1e5, -5e4, -5e4),
  cover: { query: () => 0 },
  bounds: { minX: -1e9, maxX: 1e9, minZ: -1e9, maxZ: 1e9 },
  dt: DT,
};
const skyResult = emptyProjectileResult();

/** Height (and time) where the real projectile sim crosses horizontal distance `d` from `origin`, or null. */
function heightAtDistance(origin: Vec3, vel: Vec3, kind: ItemKind, d: number): { y: number; t: number } | null {
  const b = createProjectileSim(kind);
  b.x = origin.x;
  b.y = origin.y + SKY_LIFT;
  b.z = origin.z;
  b.vx = vel.x;
  b.vy = vel.y;
  b.vz = vel.z;
  b.state = "live";
  let prevD = 0;
  let prevY = b.y;
  for (let i = 0; i < 360; i++) {
    stepProjectileInto(b, SKY, skyResult);
    const hd = Math.hypot(b.x - origin.x, b.z - origin.z);
    if (hd >= d) {
      const f = hd > prevD ? (d - prevD) / (hd - prevD) : 1;
      return { y: prevY + (b.y - prevY) * f - SKY_LIFT, t: (i + f) * DT };
    }
    const st = b.state as ProjectileState;
    if (skyResult.sank || st === "rest" || st === "stuck" || hd <= prevD - 1e-6) return null;
    prevD = hd;
    prevY = b.y;
  }
  return null;
}

/* ------------------------------------------------------------------ solving */

function release(toss: boolean, charge: number, yaw: number, pitch: number): Vec3 {
  return toss ? computeTossVelocity(yaw, pitch) : computeThrowVelocity(charge, yaw, pitch);
}

/** The high-arc root of the ballistic solution (same conventions as solveBallistic). */
function solveHigh(origin: Vec3, target: Vec3, speed: number, gScale: number): { pitch: number; yaw: number; time: number } | null {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const dy = target.y - origin.y;
  const d = Math.sqrt(dx * dx + dz * dz);
  const g = -GRAVITY * gScale;
  const v2 = speed * speed;
  const disc = v2 * v2 - g * (g * d * d + 2 * dy * v2);
  if (disc < 0 || d < 1e-6) return null;
  const angle = Math.atan((v2 + Math.sqrt(disc)) / (g * d));
  return { pitch: angle - THROW_PITCH_BIAS, yaw: Math.atan2(-dx, -dz), time: d / (speed * Math.cos(angle)) };
}

/** Closed-form pitch for a given speed (InputCmd pitch: the release bias removed), or null when out of reach. */
function closedForm(origin: Vec3, target: Vec3, speed: number, gScale: number, toss: boolean, high = false): { yaw: number; pitch: number; time: number } | null {
  const sol = high ? solveHigh(origin, target, speed, gScale) : solveBallistic(origin, target, speed, gScale);
  if (!sol) return null;
  // solveBallistic removes THROW_PITCH_BIAS; a toss adds TOSS_PITCH instead.
  return { yaw: sol.yaw, pitch: toss ? sol.pitch + THROW_PITCH_BIAS - TOSS_PITCH : sol.pitch, time: sol.time };
}

/** Pick the charge ticks for a throw: the first whole tick count with a flat enough low arc (a lob: the first that reaches at all). */
function pickChargeTicks(origin: Vec3, target: Vec3, gScale: number, high = false): number | null {
  if (high) {
    for (let k = 1; k <= CHARGE_FULL_TICKS; k++) if (solveHigh(origin, target, throwSpeed(k / CHARGE_FULL_TICKS), gScale)) return k;
    return null;
  }
  let bestK: number | null = null;
  let bestAngle = Infinity;
  for (let k = 1; k <= CHARGE_FULL_TICKS; k++) {
    const sol = solveBallistic(origin, target, throwSpeed(k / CHARGE_FULL_TICKS), gScale);
    if (!sol) continue;
    const angle = sol.pitch + THROW_PITCH_BIAS;
    if (angle <= PREFERRED_MAX_ANGLE) return k;
    if (angle < bestAngle) {
      bestAngle = angle;
      bestK = k;
    }
  }
  return bestK;
}

/** Noise-free aim at a fixed point (see aimAt). */
export function solveAim(origin: Vec3, target: Vec3, kind: ItemKind, opts: AimOptions = {}): AimSolution | null {
  const gScale = ITEMS[kind].gravityScale;
  const toss = !!opts.toss;
  let k = 0;
  if (!toss) {
    const fixed =
      opts.charge !== undefined ? clamp(Math.round(opts.charge * CHARGE_FULL_TICKS), 1, CHARGE_FULL_TICKS) : pickChargeTicks(origin, target, gScale, !!opts.high);
    if (fixed === null) return null;
    k = fixed;
  }
  const charge = toss ? 0 : k / CHARGE_FULL_TICKS;
  const speed = toss ? TOSS_SPEED : throwSpeed(charge);
  const cf = closedForm(origin, target, speed, gScale, toss, !!opts.high && !toss);
  if (!cf) return null;
  const out: AimSolution = { yaw: cf.yaw, pitch: cf.pitch, charge, chargeTicks: k, time: cf.time };
  const d = Math.hypot(target.x - origin.x, target.z - origin.z);
  if (opts.refine === false || d < 0.5) return out;

  // Secant steps on the pitch against the real projectile integration.
  const err = (pitch: number): { e: number; t: number } | null => {
    const hit = heightAtDistance(origin, release(toss, charge, cf.yaw, pitch), kind, d);
    return hit ? { e: hit.y - target.y, t: hit.t } : null;
  };
  let p0 = cf.pitch;
  let r0 = err(p0);
  if (!r0) return out;
  let best = { p: p0, e: r0.e, t: r0.t };
  if (Math.abs(r0.e) > REFINE_TOLERANCE) {
    let p1 = p0 + (r0.e > 0 ? -0.01 : 0.01);
    let r1 = err(p1);
    for (let iter = 0; iter < 6 && r1; iter++) {
      if (Math.abs(r1.e) < Math.abs(best.e)) best = { p: p1, e: r1.e, t: r1.t };
      if (Math.abs(r1.e) <= REFINE_TOLERANCE) break;
      const denom = r1.e - r0.e;
      if (Math.abs(denom) < 1e-9) break;
      const p2 = clamp(p1 - (r1.e * (p1 - p0)) / denom, -PITCH_LIMIT, PITCH_LIMIT);
      p0 = p1;
      r0 = r1;
      p1 = p2;
      r1 = err(p1);
    }
  }
  out.pitch = clamp(best.p, -PITCH_LIMIT, PITCH_LIMIT);
  out.time = best.t;
  return out;
}

/** Roughly normal noise with σ ≈ 1 (sum of three uniforms). */
function gaussish(rng: () => number): number {
  return (rng() + rng() + rng() - 1.5) * 2;
}

/** Add personality noise (σ = noiseDeg degrees on yaw, 60% of that on pitch). */
export function applyAimNoise(aim: AimSolution, noiseDeg: number, rng: () => number): AimSolution {
  if (noiseDeg <= 0) return aim;
  return {
    ...aim,
    yaw: aim.yaw + gaussish(rng) * noiseDeg * DEG,
    pitch: clamp(aim.pitch + gaussish(rng) * noiseDeg * 0.6 * DEG, -PITCH_LIMIT, PITCH_LIMIT),
  };
}

/**
 * Aim a throw of `kind` from `origin` (the hand, throwOrigin()) at `target`: InputCmd yaw / pitch, the charge
 * (and charge ticks to hold LMB), the flight time, with ±noiseDeg personality noise. Null when out of range.
 */
export function aimAt(origin: Vec3, target: Vec3, kind: ItemKind, noiseDeg: number, rng: () => number, opts: AimOptions = {}): AimSolution | null {
  const aim = solveAim(origin, target, kind, opts);
  return aim ? applyAimNoise(aim, noiseDeg, rng) : null;
}

/**
 * Aim from a standing player at a (possibly moving) target: the hand position depends on the yaw, and a moving
 * target is led by its velocity × flight time, so both are iterated a few times. Noise is applied once at the end.
 */
export function aimFromPlayer(
  p: { x: number; y: number; z: number },
  target: Vec3,
  vel: { x: number; z: number } | null,
  kind: ItemKind,
  noiseDeg: number,
  rng: () => number,
  opts: AimOptions = {},
): AimSolution | null {
  let yaw = yawFromDir(target.x - p.x, target.z - p.z);
  let aim: AimSolution | null = null;
  const point = { x: target.x, y: target.y, z: target.z };
  for (let iter = 0; iter < 3; iter++) {
    const origin = throwOrigin({ x: p.x, y: p.y, z: p.z, yaw });
    const t = aim ? aim.time : 0;
    point.x = target.x + (vel ? vel.x * t : 0);
    point.z = target.z + (vel ? vel.z * t : 0);
    const next = solveAim(origin, point, kind, aim ? { ...opts, charge: opts.toss ? undefined : aim.charge } : opts);
    if (!next) return null;
    aim = next;
    yaw = aim.yaw;
  }
  return aim ? applyAimNoise(aim, noiseDeg, rng) : null;
}

/* ------------------------------------------------------------ line of fire */

/** A vertical capsule-ish obstacle (a teammate) a throw must not pass through. */
export interface ShotObstacle {
  x: number;
  y: number;
  z: number;
  r: number;
  h: number;
}

const shotBuf: CoverCircle[] = [];
const shotPoint: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Does the gravity-only path from `origin` with `vel` reach `target` (stopping `targetR` short of it) without
 * touching the terrain, a cover cylinder (trunks, rocks, the wreck…) or one of `obstacles`? Sampled at 60 Hz;
 * the first 0.4 m (the thrower's own hand) are skipped.
 */
export function shotClear(q: WorldQuery, origin: Vec3, vel: Vec3, kind: ItemKind, target: Vec3, targetR: number, obstacles: ReadonlyArray<ShotObstacle>): boolean {
  const g = ITEMS[kind].gravityScale;
  const r = ITEMS[kind].radius;
  const d = Math.hypot(target.x - origin.x, target.z - origin.z);
  const hv = Math.hypot(vel.x, vel.z);
  if (hv < 1e-6) return true;
  const tEnd = Math.max(0, (d - targetR - r) / hv);
  for (let t = 1 / 60; t < tEnd; t += 1 / 60) {
    if (hv * t < 0.4) continue;
    const p = ballisticPoint(origin, vel, t, g, shotPoint);
    if (p.y - r <= heightAt(q.terrain, p.x, p.z)) return false;
    const n = q.cover.query(p.x, p.z, r, shotBuf);
    for (let i = 0; i < n; i++) {
      const c = shotBuf[i]!;
      if (p.y + r >= c.bottom && p.y - r <= c.top) return false;
    }
    for (const o of obstacles) {
      if (Math.hypot(p.x - o.x, p.z - o.z) < o.r + r && p.y + r >= o.y && p.y - r <= o.y + o.h) return false;
    }
  }
  return true;
}

/** Release velocity of an aim (charged throw or toss). */
export function aimVelocity(aim: AimSolution, toss = false): Vec3 {
  return release(toss, aim.charge, aim.yaw, aim.pitch);
}
