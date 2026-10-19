// Deterministic ball physics. Owner: sim.
// Server: authoritative balls in GameWorld. Client: dead-reckoning of server balls and predicted
// throws in BallSync, plus the arc preview. Same determinism rules as stepPlayer.

import { BALL_RADIUS } from "../constants.js";
import type { BallSimFields } from "../types.js";
import type { BallContext } from "./context.js";

export type BallSim = BallSimFields;

export const BALL_SIM_KEYS = [
  "x",
  "y",
  "z",
  "vx",
  "vy",
  "vz",
  "state",
  "kind",
  "radius",
  "ageTicks",
  "restTicks",
  "bounces",
  "curve",
  "returning",
] as const satisfies ReadonlyArray<keyof BallSimFields>;

type MissingBallKeys = Exclude<keyof BallSimFields, (typeof BALL_SIM_KEYS)[number]>;
const _allBallKeys: [MissingBallKeys] extends [never] ? true : MissingBallKeys = true;
void _allBallKeys;

export function createBallSim(): BallSim {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    state: "neutral",
    kind: "normal",
    radius: BALL_RADIUS,
    ageTicks: 0,
    restTicks: 0,
    bounces: 0,
    curve: false,
    returning: false,
  };
}

/** Copy every BallSim field from src to dst. Returns dst. */
export function copyBallSim<T extends BallSimFields>(src: BallSimFields, dst: T): T {
  const out = dst as unknown as Record<string, unknown>;
  const from = src as unknown as Record<string, unknown>;
  for (const key of BALL_SIM_KEYS) out[key] = from[key];
  return dst;
}

export interface StepBallResult {
  /** Bounced off the floor or cover this tick. */
  bounced: boolean;
  /** Speed into the surface at the bounce (for squash + SFX volume). */
  impactSpeed: number;
  /** -1 floor, else index into arena.cover. */
  bounceSurface: number;
  /** Was live, now dead (first bounce). */
  becameDead: boolean;
  /** Was dead, now neutral (came to rest). */
  becameNeutral: boolean;
  /** Boomerang switched to its return phase this tick. */
  startedReturning: boolean;
  /** Center dropped below BALL_KILL_Y: the server removes it (ballLost) and schedules a respawn. */
  lost: boolean;
}

export function emptyBallResult(): StepBallResult {
  return {
    bounced: false,
    impactSpeed: 0,
    bounceSurface: -1,
    becameDead: false,
    becameNeutral: false,
    startedReturning: false,
    lost: false,
  };
}

/**
 * Advance one ball by one tick. Mutates `b`, returns what happened.
 *
 *  0. state "held": return empty result, change nothing (the server pins held balls to the hand).
 *  1. Live/dead: ageTicks = min(65535, ageTicks + 1).
 *  2. Forces:
 *     - Boomerang (kind "boomerang", state live): if !returning and ageTicks >= BOOMERANG_RETURN_TICKS
 *       → returning = true, startedReturning. While returning: if ctx.returnTarget, velocity =
 *       normalize(target - pos) * BOOMERANG_RETURN_SPEED and NO gravity; if returnTarget is null
 *       or ageTicks > BOOMERANG_RETURN_TICKS + BOOMERANG_MAX_RETURN_TICKS → state "dead",
 *       returning = false (gravity resumes). (Auto-catch by the owner is done by the server.)
 *     - Curveball (curve && live && ctx.steer && ageTicks < CURVE_MAX_TICKS): steer the velocity
 *       toward ctx.steer: lateral component of (steer * |v| - v), clamped to CURVE_ACCEL * dt,
 *       added to v (speed preserved, renormalize to the previous speed).
 *     - Otherwise gravity: vy += GRAVITY * dt.
 *     - Clamp |v| to BALL_MAX_SPEED.
 *  3. Integrate pos += v * dt (substep into 2 halves when |v|·dt > radius to avoid tunneling
 *     through thin cover like candles).
 *  4. Cover: sphereCoverContact → push out by depth along the normal; reflect the normal component
 *     with BALL_RESTITUTION_COVER, keep tangential × arena.friction.ballBounceFriction. bounced.
 *  5. Floor: if isFloorAt(x, z) and y - radius < 0 and the center was above the floor plane
 *     BEFORE this tick's integration (yBefore > 0, i.e. it did not already drop below the island
 *     through a hole / past the edge) → y = radius; if -vy > BALL_MIN_BOUNCE_VY:
 *     vy = -vy * BALL_RESTITUTION_FLOOR, tangential × ballBounceFriction, bounced; else vy = 0
 *     (rolling). A ball whose center is below y = 0 never gets floor support again.
 *  6. On any bounce: bounces++ (cap 255). Live non-boomerang → state "dead", becameDead.
 *     Live boomerang not yet returning → returning = true, startedReturning (still live).
 *     Live boomerang already returning → state "dead", returning = false, becameDead.
 *  7. Rolling on the floor/cover top (vy == 0 and supported): decelerate horizontal speed by
 *     arena.friction.ballRollDecel * dt. If speed < BALL_REST_SPEED → restTicks++ (cap 255) else
 *     restTicks = 0. Dead && restTicks >= BALL_REST_TICKS → state "neutral", v = 0,
 *     kind "normal" (bonus balls keep kind "bonus" so the server can remove them),
 *     radius = BALL_RADIUS, curve = false, returning = false, ageTicks = 0, becameNeutral.
 *     Neutral balls also settle (v → 0) but never change state.
 *  8. lost = y < BALL_KILL_Y.
 *
 * Ball-vs-player contact is NOT handled here (the server world does hits/catches/deflects).
 * Ball-vs-ball collisions don't exist.
 */
export function stepBall(b: BallSim, ctx: BallContext): StepBallResult {
  // TODO(sim): placeholder does plain ballistic motion with a flat floor.
  if (b.state === "held") return emptyBallResult();
  b.vy += -20 * ctx.dt;
  b.x += b.vx * ctx.dt;
  b.y += b.vy * ctx.dt;
  b.z += b.vz * ctx.dt;
  if (b.y < b.radius) {
    b.y = b.radius;
    b.vy = 0;
    b.vx *= 0.9;
    b.vz *= 0.9;
  }
  return emptyBallResult();
}
