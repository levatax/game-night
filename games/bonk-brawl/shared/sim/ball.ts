// Deterministic ball physics. Owner: sim.
// Server: authoritative balls in GameWorld. Client: dead-reckoning of server balls and predicted
// throws in BallSync, plus the arc preview. Same determinism rules as stepPlayer.
// stepBallInto() allocates nothing (module scratch is written and read within one call).

import {
  BALL_DEATH_KEEP,
  BALL_DEATH_RESTITUTION,
  BALL_KILL_Y,
  BALL_MAX_SPEED,
  BALL_MIN_BOUNCE_VY,
  BALL_RADIUS,
  BALL_RESTITUTION_COVER,
  BALL_REST_SPEED,
  BALL_REST_TICKS,
  BALL_ROLL_DRAG,
  BOOMERANG_MAX_RETURN_TICKS,
  BOOMERANG_RETURN_SPEED,
  BOOMERANG_RETURN_TICKS,
  CURVE_ACCEL,
  CURVE_MAX_TICKS,
  FLOOR_Y,
  GRAVITY,
} from "../constants.js";
import type { BallSimFields } from "../types.js";
import type { BallContext } from "./context.js";
import { isFloorAt, sphereCoverContactInto, type Contact } from "./geometry.js";
import type { Vec3 } from "./math.js";
import { substepCount } from "./throw.js";

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

/** Reset a result object for reuse (stepBallInto does this itself). */
export function resetBallResult(out: StepBallResult): StepBallResult {
  out.bounced = false;
  out.impactSpeed = 0;
  out.bounceSurface = -1;
  out.becameDead = false;
  out.becameNeutral = false;
  out.startedReturning = false;
  out.lost = false;
  return out;
}

/** A cover contact whose normal points this far up counts as a supporting top face. */
const SUPPORT_NORMAL_Y = 0.7;
const EPS = 1e-9;

const contact: Contact = { nx: 0, ny: 0, nz: 0, depth: 0, coverIndex: -1 };
/** Per-tick contact summary (module scratch). */
const touch = { support: false };

/**
 * Advance one ball by one tick. Mutates `b`, returns what happened (a fresh result object).
 * Same as stepBallInto() with a new result.
 *
 *  0. state "held": return empty result, change nothing (the server pins held balls to the hand).
 *  1. Live/dead: ageTicks = min(65535, ageTicks + 1).
 *  2. Forces:
 *     - Boomerang (kind "boomerang", state live): if !returning and ageTicks >= BOOMERANG_RETURN_TICKS
 *       → returning = true, startedReturning. While returning: if ctx.returnTarget, velocity =
 *       normalize(target - pos) * BOOMERANG_RETURN_SPEED and NO gravity (no curve either); if
 *       returnTarget is null or ageTicks > BOOMERANG_RETURN_TICKS + BOOMERANG_MAX_RETURN_TICKS →
 *       state "dead", returning = false, becameDead (gravity resumes; startedReturning is not
 *       reported when the return gives up on the tick it would start).
 *       (Auto-catch by the owner is done by the server.)
 *     - Curveball (curve && live && ctx.steer && ageTicks < CURVE_MAX_TICKS): light HORIZONTAL
 *       steering toward the thrower's current aim yaw: the part of (steerXZ * |vXZ| - vXZ) that is
 *       perpendicular to vXZ, clamped to CURVE_ACCEL * dt, is added to the horizontal velocity,
 *       which is then renormalized to its previous speed. Gravity still applies, so a curveball
 *       keeps its arc (aim and timing still matter) and bends left/right as the crosshair drifts.
 *     - Gravity: vy += GRAVITY * dt for everything except a homing boomerang.
 *     - Clamp |v| to BALL_MAX_SPEED.
 *  3. Integrate pos += v * dt (vertical uses the average of vy before/after gravity, so free
 *     flight follows the exact parabola that sampleTrajectory draws), in substepCount(|v|·dt,
 *     radius) equal sub-steps so the ball never moves more than its radius between collision
 *     checks (no tunneling through thin cover like candles). Each sub-step runs 4 and 5.
 *  4. Cover: sphereCoverContact → push out by depth along the normal. Moving into the surface:
 *     a "hard" contact (speed into the surface > BALL_MIN_BOUNCE_VY, or any contact of a LIVE
 *     ball) reflects the normal component with BALL_RESTITUTION_COVER and keeps tangential ×
 *     arena.friction.ballBounceFriction → bounced; a soft contact just removes the normal
 *     component (rolling on a top face / sliding along a side, no bounce event).
 *     The KILLING bounce (state live, kind not boomerang) instead keeps tangential ×
 *     BALL_DEATH_KEEP and normal × BALL_DEATH_RESTITUTION (floor and cover), so a missed throw
 *     drops dead near where it landed instead of skidding off the island.
 *  5. Floor: if isFloorAt(x, z) and y - radius < 0 and the center was above the floor plane
 *     before this sub-step (i.e. it did not already drop below the island through a hole / past
 *     the edge) → y = radius; impact = the sub-step's mid-tick downward speed; hard contact
 *     (impact > BALL_MIN_BOUNCE_VY, or live): vy = impact * arena.friction.ballRestitution,
 *     horizontal × ballBounceFriction (killing bounce: see 4), bounced; else vy = 0 (rolling).
 *     A ball whose center is below y = 0 never gets floor support again.
 *     (A live ball therefore always dies on its first touch of any surface.)
 *  6. On any bounce: bounces++ (cap 255). Then, once per tick: live non-boomerang → state "dead",
 *     becameDead. Live boomerang not yet returning → returning = true, startedReturning (still
 *     live). Live boomerang already returning → state "dead", returning = false, becameDead.
 *     bounceSurface/impactSpeed report the hardest bounce of the tick.
 *  7. Rolling on the floor/cover top (vy == 0 and supported): decelerate horizontal speed by
 *     (arena.friction.ballRollDecel + BALL_ROLL_DRAG · speed) * dt (speed before the decel). If speed < BALL_REST_SPEED → restTicks++ (cap 255) else
 *     restTicks = 0 (also 0 whenever unsupported). Dead && restTicks >= BALL_REST_TICKS → state
 *     "neutral", v = 0, kind "normal" (bonus balls keep kind "bonus" so the server can remove
 *     them), radius = BALL_RADIUS (a resting mega ball sinks by the radius difference so it stays
 *     on its surface), curve = false, returning = false, ageTicks = 0, becameNeutral.
 *     Neutral balls also settle (horizontal v → 0 once resting) but never change state.
 *  8. lost = y < BALL_KILL_Y.
 *
 * Ball-vs-player contact is NOT handled here (the server world does hits/catches/deflects).
 * Ball-vs-ball collisions don't exist.
 */
export function stepBall(b: BallSim, ctx: BallContext): StepBallResult {
  return stepBallInto(b, ctx, emptyBallResult());
}

/** Allocation-free stepBall(): resets and fills `out`, returns it. Exactly the same simulation. */
export function stepBallInto(b: BallSim, ctx: BallContext, out: StepBallResult): StepBallResult {
  resetBallResult(out);
  if (b.state === "held") return out;
  if (b.state === "live" || b.state === "dead") b.ageTicks = Math.min(65535, b.ageTicks + 1);

  const gravity = applyForces(b, ctx, out);
  const vyStart = b.vy;
  if (gravity) b.vy += GRAVITY * ctx.dt;
  clampSpeed(b);

  const vyMove = gravity ? (vyStart + b.vy) * 0.5 : b.vy;
  const supported = move(b, ctx, vyMove, out);
  if (out.bounced && b.state === "live") resolveBounceState(b, out);
  settle(b, ctx, supported, out);
  out.lost = b.y < BALL_KILL_Y;
  return out;
}

/* ================================================================= forces */

/** Applies boomerang/curve steering; returns whether gravity applies this tick. */
function applyForces(b: BallSim, ctx: BallContext, out: StepBallResult): boolean {
  if (b.state !== "live") return true;
  if (b.kind === "boomerang") {
    if (!b.returning && b.ageTicks >= BOOMERANG_RETURN_TICKS) {
      b.returning = true;
      out.startedReturning = true;
    }
    if (b.returning) return !homeBoomerang(b, ctx.returnTarget, out);
  }
  if (b.curve && ctx.steer && b.ageTicks < CURVE_MAX_TICKS) steerCurve(b, ctx.steer, CURVE_ACCEL * ctx.dt);
  return true;
}

/** Fly straight at the owner's chest. Returns false (and kills the ball) when the return gives up. */
function homeBoomerang(b: BallSim, target: Vec3 | null, out: StepBallResult): boolean {
  if (!target || b.ageTicks > BOOMERANG_RETURN_TICKS + BOOMERANG_MAX_RETURN_TICKS) {
    b.state = "dead";
    b.returning = false;
    out.becameDead = true;
    out.startedReturning = false;
    return false;
  }
  const dx = target.x - b.x;
  const dy = target.y - b.y;
  const dz = target.z - b.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const k = d > EPS ? BOOMERANG_RETURN_SPEED / d : 0;
  b.vx = dx * k;
  b.vy = dy * k;
  b.vz = dz * k;
  return true;
}

function steerCurve(b: BallSim, steer: Vec3, maxDelta: number): void {
  const speed = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
  const steerLen = Math.sqrt(steer.x * steer.x + steer.z * steer.z);
  if (speed < EPS || steerLen < EPS) return;
  const ux = b.vx / speed;
  const uz = b.vz / speed;
  let dx = (steer.x / steerLen) * speed - b.vx;
  let dz = (steer.z / steerLen) * speed - b.vz;
  const along = dx * ux + dz * uz;
  dx -= along * ux;
  dz -= along * uz;
  const lateral = Math.sqrt(dx * dx + dz * dz);
  if (lateral < EPS) return;
  if (lateral > maxDelta) {
    dx *= maxDelta / lateral;
    dz *= maxDelta / lateral;
  }
  const nx = b.vx + dx;
  const nz = b.vz + dz;
  const k = speed / Math.sqrt(nx * nx + nz * nz);
  b.vx = nx * k;
  b.vz = nz * k;
}

function clampSpeed(b: BallSim): void {
  const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  if (speed <= BALL_MAX_SPEED) return;
  const k = BALL_MAX_SPEED / speed;
  b.vx *= k;
  b.vy *= k;
  b.vz *= k;
}

/* ============================================================== movement */

/** Integrate with collision sub-steps. Returns true when the ball ends the tick resting on a surface. */
function move(b: BallSim, ctx: BallContext, vyMove: number, out: StepBallResult): boolean {
  const dt = ctx.dt;
  const speed = Math.sqrt(b.vx * b.vx + vyMove * vyMove + b.vz * b.vz);
  const n = substepCount(speed * dt, b.radius);
  const h = dt / n;
  let my = vyMove;
  touch.support = false;
  for (let i = 0; i < n; i++) {
    const yStart = b.y;
    b.x += b.vx * h;
    b.y += my * h;
    b.z += b.vz * h;
    if (collideCover(b, ctx, out)) my = b.vy;
    if (collideFloor(b, ctx, yStart, my, out)) my = b.vy;
  }
  return touch.support && b.vy === 0;
}

/**
 * This bounce turns a live ball dead (boomerangs turn around instead). Within one tick only the
 * first contact is the killing one: b.state flips to "dead" after move(), so a second contact in a
 * later sub-step of the same tick (corner) also counts as killing — harmless, it only damps more.
 */
function isKillingBounce(b: BallSim): boolean {
  return b.state === "live" && b.kind !== "boomerang";
}

function isHard(b: BallSim, impact: number): boolean {
  return impact > BALL_MIN_BOUNCE_VY || b.state === "live";
}

function registerBounce(b: BallSim, out: StepBallResult, impact: number, surface: number): void {
  b.bounces = Math.min(255, b.bounces + 1);
  if (!out.bounced || impact > out.impactSpeed) {
    out.impactSpeed = impact;
    out.bounceSurface = surface;
  }
  out.bounced = true;
}

/** Push the ball out of cover and bounce/slide. Returns true when the velocity changed. */
function collideCover(b: BallSim, ctx: BallContext, out: StepBallResult): boolean {
  if (!sphereCoverContactInto(ctx.arena, b, b.radius, contact)) return false;
  const { nx, ny, nz, depth } = contact;
  b.x += nx * depth;
  b.y += ny * depth;
  b.z += nz * depth;
  const vn = b.vx * nx + b.vy * ny + b.vz * nz;
  if (vn < 0) {
    const impact = -vn;
    if (isHard(b, impact)) {
      const killing = isKillingBounce(b);
      const fr = killing ? BALL_DEATH_KEEP : ctx.arena.friction.ballBounceFriction;
      const tx = b.vx - vn * nx;
      const ty = b.vy - vn * ny;
      const tz = b.vz - vn * nz;
      const bounce = impact * (killing ? BALL_DEATH_RESTITUTION : BALL_RESTITUTION_COVER);
      b.vx = tx * fr + nx * bounce;
      b.vy = ty * fr + ny * bounce;
      b.vz = tz * fr + nz * bounce;
      registerBounce(b, out, impact, contact.coverIndex);
    } else {
      b.vx -= vn * nx;
      b.vy -= vn * ny;
      b.vz -= vn * nz;
    }
  }
  if (ny >= SUPPORT_NORMAL_Y) touch.support = true;
  return vn < 0;
}

/**
 * Floor support where solid (see step 5). Returns true when the velocity changed.
 * The impact speed is the sub-step's integration velocity `my` (the mid-tick vertical speed),
 * not the end-of-tick b.vy: using b.vy would add up to a full tick of gravity to every bounce,
 * so small bounces would never die out and a dropped ball would hop forever.
 */
function collideFloor(b: BallSim, ctx: BallContext, yStart: number, my: number, out: StepBallResult): boolean {
  if (!(yStart > FLOOR_Y) || b.y - b.radius >= FLOOR_Y || !isFloorAt(ctx, b.x, b.z)) return false;
  b.y = FLOOR_Y + b.radius;
  touch.support = true;
  if (my >= 0) {
    if (b.vy >= 0) return false;
    b.vy = 0;
    return true;
  }
  const impact = -my;
  if (isHard(b, impact)) {
    const killing = isKillingBounce(b);
    const fr = killing ? BALL_DEATH_KEEP : ctx.arena.friction.ballBounceFriction;
    b.vy = impact * (killing ? BALL_DEATH_RESTITUTION : ctx.arena.friction.ballRestitution);
    b.vx *= fr;
    b.vz *= fr;
    registerBounce(b, out, impact, -1);
  } else {
    b.vy = 0;
  }
  return true;
}

/* ================================================================= state */

function resolveBounceState(b: BallSim, out: StepBallResult): void {
  if (b.kind === "boomerang" && !b.returning) {
    b.returning = true;
    out.startedReturning = true;
    return;
  }
  b.state = "dead";
  b.returning = false;
  out.becameDead = true;
}

function settle(b: BallSim, ctx: BallContext, supported: boolean, out: StepBallResult): void {
  if (!supported) {
    b.restTicks = 0;
    return;
  }
  let speed = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
  const decel = (ctx.arena.friction.ballRollDecel + BALL_ROLL_DRAG * speed) * ctx.dt;
  if (speed <= decel) {
    b.vx = 0;
    b.vz = 0;
    speed = 0;
  } else {
    const k = (speed - decel) / speed;
    b.vx *= k;
    b.vz *= k;
    speed -= decel;
  }
  b.restTicks = speed < BALL_REST_SPEED ? Math.min(255, b.restTicks + 1) : 0;
  if (b.restTicks < BALL_REST_TICKS) return;
  if (b.state === "dead") {
    becomeNeutral(b, out);
  } else if (b.state === "neutral") {
    b.vx = 0;
    b.vz = 0;
  }
}

function becomeNeutral(b: BallSim, out: StepBallResult): void {
  b.state = "neutral";
  b.vx = 0;
  b.vy = 0;
  b.vz = 0;
  if (b.kind !== "bonus") b.kind = "normal";
  if (b.radius !== BALL_RADIUS) {
    b.y -= b.radius - BALL_RADIUS;
    b.radius = BALL_RADIUS;
  }
  b.curve = false;
  b.returning = false;
  b.ageTicks = 0;
  out.becameNeutral = true;
}
