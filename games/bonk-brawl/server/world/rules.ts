// Pure combat math used by GameWorld: catch test, knockback vectors, carry limits.
// No state, no side effects; every function is unit-testable on its own.

import {
  CATCH_FORWARD_OFFSET,
  CATCH_RANGE,
  CHEST_HEIGHT,
  KNOCKBACK_H,
  KNOCKBACK_UP,
  MAX_HELD_BALLS,
  MAX_HELD_BALLS_TRIPLE,
} from "../../shared/constants.js";
import { knockbackMultiplier } from "../../shared/sim/throw.js";
import type { BallKind, HeldPowerUp, Vec3Like } from "../../shared/types.js";

/** Shockwave only reaches players whose feet are within this height of the slam. */
export const SHOCKWAVE_MAX_DY = 1.5;
/** Upward speed given to a ball that bounced off a player (deflect / hit), so it pops visibly. */
export const PLAYER_BOUNCE_POP_VY = 3;
/** Speed kept by a ball that hit a player (reflected and halved). */
export const PLAYER_BOUNCE_KEEP = 0.5;
/** Below this length a horizontal direction is treated as zero. */
const EPS = 1e-6;

interface Facing {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Balls a player may carry: 2 with a Triple Shot held, else 1. */
export function maxHeldBalls(p: { powerUp: HeldPowerUp }): number {
  return p.powerUp === "triple" ? MAX_HELD_BALLS_TRIPLE : MAX_HELD_BALLS;
}

/**
 * Catch test for one ball position against a player's current pose. Returns the distance from
 * the catch center (chest + forward · CATCH_FORWARD_OFFSET) when the ball is within
 * CATCH_RANGE + ballRadius of it AND in the front half-space (dot(ball − chest, forward) > 0);
 * otherwise -1.
 */
export function catchDistance(p: Facing, ball: Vec3Like, ballRadius: number): number {
  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  const chestY = p.y + CHEST_HEIGHT;
  const front = (ball.x - p.x) * fx + (ball.z - p.z) * fz;
  if (!(front > 0)) return -1;
  const dx = ball.x - (p.x + fx * CATCH_FORWARD_OFFSET);
  const dy = ball.y - chestY;
  const dz = ball.z - (p.z + fz * CATCH_FORWARD_OFFSET);
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return d <= CATCH_RANGE + ballRadius ? d : -1;
}

/**
 * Unit horizontal direction of (x, z); falls back to (fx, fz) (normalized) and finally to +Z when
 * both are degenerate. Writes into `out` and returns it.
 */
export function horizontalDir(x: number, z: number, fx: number, fz: number, out: { x: number; z: number }): { x: number; z: number } {
  let len = Math.sqrt(x * x + z * z);
  if (len < EPS) {
    x = fx;
    z = fz;
    len = Math.sqrt(x * x + z * z);
  }
  if (len < EPS) {
    out.x = 0;
    out.z = 1;
    return out;
  }
  out.x = x / len;
  out.z = z / len;
  return out;
}

/**
 * Knockback velocity of a live-ball hit: the ball's horizontal travel direction × KNOCKBACK_H plus
 * KNOCKBACK_UP, all × knockbackMultiplier(charge, kind). A ball falling straight down pushes the
 * target away from the ball instead.
 */
export function ballHitKnockback(
  ball: { x: number; z: number; vx: number; vz: number; charge: number; kind: BallKind },
  target: { x: number; z: number },
): Vec3Like {
  const dir = horizontalDir(ball.vx, ball.vz, target.x - ball.x, target.z - ball.z, { x: 0, z: 0 });
  const mult = knockbackMultiplier(ball.charge, ball.kind);
  return { x: dir.x * KNOCKBACK_H * mult, y: KNOCKBACK_UP * mult, z: dir.z * KNOCKBACK_H * mult };
}

/** Knockback pushing `target` horizontally away from `from` (shockwave), or along `fallback` when stacked. */
export function radialKnockback(
  from: { x: number; z: number },
  target: { x: number; z: number },
  fallback: { x: number; z: number },
  horizontal: number,
  up: number,
): Vec3Like {
  const dir = horizontalDir(target.x - from.x, target.z - from.z, fallback.x, fallback.z, { x: 0, z: 0 });
  return { x: dir.x * horizontal, y: up, z: dir.z * horizontal };
}

/** Ring-out credit: the last hitter/knocker if the knock happened within `windowTicks`, else "". */
export function ringOutCredit(victimId: string, lastHitBy: string, lastHitTick: number, tick: number, windowTicks: number): string {
  if (!lastHitBy || lastHitBy === victimId) return "";
  return tick - lastHitTick <= windowTicks ? lastHitBy : "";
}
