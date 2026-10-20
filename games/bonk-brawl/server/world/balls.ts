// Ball state transitions applied by GameWorld (schema entities mutated in place).

import { BALL_RADIUS, MEGA_BALL_RADIUS } from "../../shared/constants.js";
import type { BallKind, Vec3Like } from "../../shared/types.js";
import type { BallEntity } from "../schema.js";
import { horizontalDir, PLAYER_BOUNCE_KEEP, PLAYER_BOUNCE_POP_VY } from "./rules.js";

/** Numeric part of a ball id ("b12" → 12) for stable "lowest id first" ordering. */
export function ballIdNumber(id: string): number {
  const n = Number.parseInt(id.slice(1), 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** Plain ball: kind normal, normal radius, no owner/holder/throw data, timers and flags cleared. */
function resetToPlain(b: BallEntity): void {
  b.kind = "normal";
  b.radius = BALL_RADIUS;
  b.ownerId = "";
  b.holderId = "";
  b.throwSeq = 0;
  b.throwIndex = 0;
  b.charge = 0;
  b.ageTicks = 0;
  b.restTicks = 0;
  b.bounces = 0;
  b.curve = false;
  b.returning = false;
}

function setMotion(b: BallEntity, pos: Vec3Like, vx: number, vy: number, vz: number): void {
  b.x = pos.x;
  b.y = pos.y;
  b.z = pos.z;
  b.vx = vx;
  b.vy = vy;
  b.vz = vz;
}

/** In someone's hand: a plain "held" ball pinned at `hand` (pickups, catches, boomerang returns). */
export function makeHeld(b: BallEntity, holderId: string, hand: Vec3Like): void {
  resetToPlain(b);
  b.state = "held";
  b.holderId = holderId;
  setMotion(b, hand, 0, 0, 0);
}

/** A loose plain ball (neutral or dead) at `pos` with the given velocity. */
export function makeLoose(b: BallEntity, state: "neutral" | "dead", pos: Vec3Like, vx = 0, vy = 0, vz = 0): void {
  resetToPlain(b);
  b.state = state;
  setMotion(b, pos, vx, vy, vz);
}

export interface LaunchSpec {
  ownerId: string;
  throwSeq: number;
  throwIndex: number;
  kind: BallKind;
  charge: number;
  curve: boolean;
  origin: Vec3Like;
  velocity: Vec3Like;
}

/** Turn a ball into a freshly thrown live ball. */
export function launch(b: BallEntity, spec: LaunchSpec): void {
  resetToPlain(b);
  b.state = "live";
  b.kind = spec.kind;
  b.radius = spec.kind === "mega" ? MEGA_BALL_RADIUS : BALL_RADIUS;
  b.ownerId = spec.ownerId;
  b.throwSeq = spec.throwSeq;
  b.throwIndex = spec.throwIndex;
  b.charge = spec.charge;
  b.curve = spec.curve;
  setMotion(b, spec.origin, spec.velocity.x, spec.velocity.y, spec.velocity.z);
}

/** Hit a player: the ball turns dead, bouncing back with its velocity reflected and halved. */
export function bounceOffTarget(b: BallEntity): void {
  b.state = "dead";
  b.returning = false;
  b.vx = -b.vx * PLAYER_BOUNCE_KEEP;
  b.vz = -b.vz * PLAYER_BOUNCE_KEEP;
  b.vy = Math.abs(b.vy) * PLAYER_BOUNCE_KEEP + PLAYER_BOUNCE_POP_VY;
}

/**
 * Deflected harmlessly (Belly Bounce, sibling of a caught throw): dead, flying horizontally away
 * from the player at `speed` with a small pop.
 */
export function deflectAway(b: BallEntity, from: { x: number; z: number }, speed: number): void {
  const dir = horizontalDir(b.x - from.x, b.z - from.z, -b.vx, -b.vz, { x: 0, z: 0 });
  b.state = "dead";
  b.returning = false;
  b.vx = dir.x * speed;
  b.vz = dir.z * speed;
  b.vy = Math.max(b.vy, 0) * PLAYER_BOUNCE_KEEP + PLAYER_BOUNCE_POP_VY;
}
