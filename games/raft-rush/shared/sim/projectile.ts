// Deterministic projectile (thrown / tossed / dropped item) physics. Owner: sim.
// Runs on the server (authoritative) and in the client's ProjectileSync (dead-reckoning + predicted throws).
//
// Lifecycle (types.ts ProjectileState): live → (first ground bounce or cover hit) loose → (slow on the ground
// for PROJECTILE_REST_TICKS) rest. Items with ITEMS[kind].sticks (spear) become `stuck` on terrain / trunk
// impact instead of bouncing. `rest` and `stuck` don't move. Sinking: when the center drops below
// WATER_Y − radius over water terrain the step reports `sank` (the server removes it with a splash).
// Ground reflection uses normalAt (bounce off slopes), restitution / maxBounces per item, rolling decel on the
// ground, PROJECTILE_MAX_SPEED clamp, sub-steps so a 34 m/s projectile never tunnels through a trunk.
//
// Free flight integrates the exact gravity parabola (vertical uses the average of vy before / after gravity), so
// throw.ts ballisticPoint / sampleTrajectory / solveBallistic predict exactly where an unobstructed projectile is
// at every tick boundary. stepProjectileInto() allocates nothing (module scratch is written and read within one
// call, never retained).

import {
  GRAVITY,
  PROJECTILE_BOUNCE_FRICTION,
  PROJECTILE_MAX_SPEED,
  PROJECTILE_MIN_BOUNCE_VY,
  PROJECTILE_REST_SPEED,
  PROJECTILE_REST_TICKS,
  PROJECTILE_ROLL_DECEL,
  WATER_Y,
} from "../constants.js";
import { heightAt, normalAt } from "../island/heightfield.js";
import { ITEMS, type ItemDef } from "../items.js";
import type { ItemKind, ProjectileSimFields, Vec3Like } from "../types.js";
import type { ProjectileContext } from "./context.js";
import { sphereCircleContact, type CoverCircle, type CoverContact } from "./cover.js";

export type ProjectileSim = ProjectileSimFields;

export const PROJECTILE_SIM_KEYS = [
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
] as const satisfies ReadonlyArray<keyof ProjectileSimFields>;

type MissingKeys = Exclude<keyof ProjectileSimFields, (typeof PROJECTILE_SIM_KEYS)[number]>;
const _allKeys: [MissingKeys] extends [never] ? true : MissingKeys = true;
void _allKeys;

/** A resting projectile of `kind` at the origin. */
export function createProjectileSim(kind: ItemKind): ProjectileSim {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, state: "rest", kind, radius: ITEMS[kind].radius, ageTicks: 0, restTicks: 0, bounces: 0 };
}

export function copyProjectileSim<T extends ProjectileSimFields>(src: ProjectileSimFields, dst: T): T {
  const out = dst as unknown as Record<string, unknown>;
  const from = src as unknown as Record<string, unknown>;
  for (const key of PROJECTILE_SIM_KEYS) out[key] = from[key];
  return dst;
}

export interface StepProjectileResult {
  /** Bounced off the ground this tick (impact speed in bounceSpeed). */
  bounced: boolean;
  bounceSpeed: number;
  /** Turned live → loose this tick (first bounce or cover contact). */
  becameLoose: boolean;
  /** Turned loose → rest this tick. */
  cameToRest: boolean;
  /** Turned live → stuck this tick (sticky items). */
  stuck: boolean;
  /** Below the water surface: the server removes it (splash). */
  sank: boolean;
  /** First cover circle touched this tick (trunk, rock, fence…), or null. */
  hitCover: CoverCircle | null;
}

export function emptyProjectileResult(): StepProjectileResult {
  return { bounced: false, bounceSpeed: 0, becameLoose: false, cameToRest: false, stuck: false, sank: false, hitCover: null };
}

export function resetProjectileResult(out: StepProjectileResult): StepProjectileResult {
  out.bounced = false;
  out.bounceSpeed = 0;
  out.becameLoose = false;
  out.cameToRest = false;
  out.stuck = false;
  out.sank = false;
  out.hitCover = null;
  return out;
}

/* ============================================================ tuning (local) */

/** Collision sub-steps never move a projectile further than this (nor further than its radius). */
export const PROJECTILE_SUBSTEP = 0.15;
const MAX_SUBSTEPS = 16;
/** A contact whose normal points this far up is ground-like (terrain, or a cover top face): bounces, rolling, rest. */
export const SUPPORT_NORMAL_Y = 0.7;
/** Tangential velocity kept on a hard landing that doesn't bounce (bounces used up, or a non-bouncing item). */
export const SKID_FRICTION = 0.5;
/** Items less bouncy than this slide instead of rolling: rolling decel × SLIDE_DECEL_MULT. */
export const ROLL_MIN_RESTITUTION = 0.3;
export const SLIDE_DECEL_MULT = 3;
/** Speed (along the bounce) a reflected projectile keeps leaving the bounds of the world. */
const BOUNDS_RESTITUTION = 0.5;
const COUNTER_MAX = 65535;
const REST_TICKS_MAX = 255;

/** Sub-step count for moving `distance` with a projectile of `radius` (≥ 1, capped). */
export function projectileSubsteps(distance: number, radius: number): number {
  const len = Math.max(0.05, Math.min(PROJECTILE_SUBSTEP, radius));
  if (!(distance > len)) return 1;
  return Math.min(MAX_SUBSTEPS, Math.ceil(distance / len));
}

/** Cover a spear sticks into: anything wooden (rocks just deflect it). */
export function sticksInto(c: CoverCircle): boolean {
  return c.kind !== "rock";
}

/* ================================================================ scratch */

const coverHits: CoverCircle[] = [];
const contact: CoverContact = { nx: 0, ny: 0, nz: 0, depth: 0 };
const best: CoverContact = { nx: 0, ny: 0, nz: 0, depth: 0 };
const nrm: Vec3Like = { x: 0, y: 1, z: 0 };
/** Velocity used for this sub-step's integration (vy = the tick's average vertical speed until a contact). */
const vel = { x: 0, y: 0, z: 0 };
/** Per-tick contact summary. */
const touch = { supported: false };

/* ================================================================== step */

/** Advance one tick (ctx.dt). Returns a fresh result. */
export function stepProjectile(b: ProjectileSim, ctx: ProjectileContext): StepProjectileResult {
  return stepProjectileInto(b, ctx, emptyProjectileResult());
}

/**
 * Advance one tick writing into `out` (reset first).
 *
 *  0. `rest` / `stuck`: nothing changes.
 *  1. ageTicks++ (saturating). Gravity × ITEMS[kind].gravityScale; |v| clamped to PROJECTILE_MAX_SPEED.
 *  2. Integrate with the average vertical speed of the tick (exact parabola) in projectileSubsteps() equal
 *     sub-steps, so no sub-step is longer than min(radius, PROJECTILE_SUBSTEP) and a 34 m/s throw can't skip
 *     a 0.3 m trunk. Each sub-step:
 *     a. World bounds: reflect at the edge (× 0.5).
 *     b. Sinking: over water terrain, a center below WATER_Y − radius (or one the seabed would hold below it)
 *        → sank, stop.
 *     c. Cover: the deepest contact among the circles near it (sphereCircleContact; trunks are side-only)
 *        pushes it out along the contact normal; hitCover = the first circle touched this tick. A live spear
 *        sticks into anything but rocks (stuck, stop). Ground-like contacts (top faces) behave like the ground
 *        (d); side contacts make a live projectile loose and reflect it (restitution, tangential ×
 *        PROJECTILE_BOUNCE_FRICTION) when hard (live, or faster than PROJECTILE_MIN_BOUNCE_VY into it), else
 *        just remove the velocity into it.
 *     d. Ground: center below terrain + radius → lifted to it. Moving into the surface (normalAt): a live
 *        spear sticks (stuck, stop); a live projectile turns loose; impact > PROJECTILE_MIN_BOUNCE_VY with
 *        bounces < maxBounces → reflect off the slope (restitution, tangential × PROJECTILE_BOUNCE_FRICTION),
 *        bounces++, bounced (bounceSpeed = hardest impact); a hard impact without a bounce left skids
 *        (tangential × SKID_FRICTION); a soft one rolls on (normal component of the velocity removed, with the
 *        tick's full gravity so slopes roll things downhill).
 *  3. Supported this tick without bouncing away: rolling decel on the speed (PROJECTILE_ROLL_DECEL, × slide
 *     mult for flat items), restTicks counts ticks below PROJECTILE_REST_SPEED; loose with restTicks ≥
 *     PROJECTILE_REST_TICKS → rest (v = 0), cameToRest. Unsupported: restTicks = 0.
 *
 * Projectile-vs-player / monster contact is NOT handled here (the server world does hits and catches).
 */
export function stepProjectileInto(b: ProjectileSim, ctx: ProjectileContext, out: StepProjectileResult): StepProjectileResult {
  resetProjectileResult(out);
  if (b.state === "rest" || b.state === "stuck") return out;
  if (b.ageTicks < COUNTER_MAX) b.ageTicks++;
  const def = ITEMS[b.kind];
  const dt = ctx.dt;

  const vyStart = b.vy;
  b.vy += GRAVITY * def.gravityScale * dt;
  clampSpeed(b);
  vel.x = b.vx;
  vel.y = (vyStart + b.vy) * 0.5;
  vel.z = b.vz;
  touch.supported = false;

  const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
  const n = projectileSubsteps(speed * dt, b.radius);
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    b.x += vel.x * h;
    b.y += vel.y * h;
    b.z += vel.z * h;
    reflectAtBounds(b, ctx);
    if (sinks(b, ctx)) {
      out.sank = true;
      return out;
    }
    if (collideCover(b, ctx, def, out)) return out;
    if (collideGround(b, ctx, def, out)) return out;
  }
  settle(b, def, dt, out);
  return out;
}

/* ================================================================= forces */

function clampSpeed(b: ProjectileSim): void {
  const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  if (sp <= PROJECTILE_MAX_SPEED) return;
  const k = PROJECTILE_MAX_SPEED / sp;
  b.vx *= k;
  b.vy *= k;
  b.vz *= k;
}

function reflectAtBounds(b: ProjectileSim, ctx: ProjectileContext): void {
  const bounds = ctx.bounds;
  if (b.x < bounds.minX) {
    b.x = bounds.minX;
    if (vel.x < 0) vel.x = b.vx = -vel.x * BOUNDS_RESTITUTION;
  } else if (b.x > bounds.maxX) {
    b.x = bounds.maxX;
    if (vel.x > 0) vel.x = b.vx = -vel.x * BOUNDS_RESTITUTION;
  }
  if (b.z < bounds.minZ) {
    b.z = bounds.minZ;
    if (vel.z < 0) vel.z = b.vz = -vel.z * BOUNDS_RESTITUTION;
  } else if (b.z > bounds.maxZ) {
    b.z = bounds.maxZ;
    if (vel.z > 0) vel.z = b.vz = -vel.z * BOUNDS_RESTITUTION;
  }
}

/** Over water terrain and fully under the surface (or would come to rest there). */
function sinks(b: ProjectileSim, ctx: ProjectileContext): boolean {
  const ground = heightAt(ctx.terrain, b.x, b.z);
  if (ground >= WATER_Y) return false;
  const held = ground + b.radius;
  const y = b.y > held ? b.y : held;
  return y < WATER_Y - b.radius;
}

/* ============================================================== contacts */

/** Deepest cover contact near the projectile into `best`; returns the circle or null. */
function deepestCover(b: ProjectileSim, ctx: ProjectileContext): CoverCircle | null {
  const n = ctx.cover.query(b.x, b.z, b.radius, coverHits);
  let found: CoverCircle | null = null;
  for (let i = 0; i < n; i++) {
    const c = coverHits[i]!;
    if (!sphereCircleContact(c, b.x, b.y, b.z, b.radius, contact)) continue;
    if (found === null || contact.depth > best.depth) {
      found = c;
      best.nx = contact.nx;
      best.ny = contact.ny;
      best.nz = contact.nz;
      best.depth = contact.depth;
    }
  }
  return found;
}

/** Cover contact of one sub-step. Returns true when the projectile stuck (the step stops). */
function collideCover(b: ProjectileSim, ctx: ProjectileContext, def: ItemDef, out: StepProjectileResult): boolean {
  const c = deepestCover(b, ctx);
  if (c === null) return false;
  const { nx, ny, nz, depth } = best;
  b.x += nx * depth;
  b.y += ny * depth;
  b.z += nz * depth;
  if (out.hitCover === null) out.hitCover = c;
  if (def.sticks && b.state === "live" && sticksInto(c)) {
    stick(b, out);
    return true;
  }
  if (ny >= SUPPORT_NORMAL_Y) {
    respondGround(b, def, nx, ny, nz, out);
    return false;
  }
  const wasLive = b.state === "live";
  makeLoose(b, out);
  const vn = vel.x * nx + vel.y * ny + vel.z * nz;
  if (vn < 0) {
    const impact = -vn;
    if (wasLive || impact > PROJECTILE_MIN_BOUNCE_VY) {
      const bounce = impact * def.restitution;
      vel.x = (vel.x - vn * nx) * PROJECTILE_BOUNCE_FRICTION + nx * bounce;
      vel.y = (vel.y - vn * ny) * PROJECTILE_BOUNCE_FRICTION + ny * bounce;
      vel.z = (vel.z - vn * nz) * PROJECTILE_BOUNCE_FRICTION + nz * bounce;
    } else {
      vel.x -= vn * nx;
      vel.y -= vn * ny;
      vel.z -= vn * nz;
    }
    storeVelocity(b);
  }
  return false;
}

/** Terrain contact of one sub-step. Returns true when the projectile stuck (the step stops). */
function collideGround(b: ProjectileSim, ctx: ProjectileContext, def: ItemDef, out: StepProjectileResult): boolean {
  const ground = heightAt(ctx.terrain, b.x, b.z);
  if (b.y - b.radius >= ground) return false;
  b.y = ground + b.radius;
  normalAt(ctx.terrain, b.x, b.z, nrm);
  if (def.sticks && b.state === "live" && vel.x * nrm.x + vel.y * nrm.y + vel.z * nrm.z < 0) {
    stick(b, out);
    return true;
  }
  respondGround(b, def, nrm.x, nrm.y, nrm.z, out);
  return false;
}

/** Ground-like contact (terrain or a cover top) with unit normal n: bounce, skid or roll. */
function respondGround(b: ProjectileSim, def: ItemDef, nx: number, ny: number, nz: number, out: StepProjectileResult): void {
  makeLoose(b, out);
  const vn = vel.x * nx + vel.y * ny + vel.z * nz;
  if (vn >= 0) {
    // Resting contact or already leaving the surface.
    if (vn < PROJECTILE_MIN_BOUNCE_VY) touch.supported = true;
    return;
  }
  const impact = -vn;
  if (impact > PROJECTILE_MIN_BOUNCE_VY) {
    const tx = vel.x - vn * nx;
    const ty = vel.y - vn * ny;
    const tz = vel.z - vn * nz;
    if (b.bounces < def.maxBounces) {
      const up = impact * def.restitution;
      vel.x = tx * PROJECTILE_BOUNCE_FRICTION + nx * up;
      vel.y = ty * PROJECTILE_BOUNCE_FRICTION + ny * up;
      vel.z = tz * PROJECTILE_BOUNCE_FRICTION + nz * up;
      b.bounces++;
      out.bounced = true;
      if (impact > out.bounceSpeed) out.bounceSpeed = impact;
    } else {
      vel.x = tx * SKID_FRICTION;
      vel.y = ty * SKID_FRICTION;
      vel.z = tz * SKID_FRICTION;
      touch.supported = true;
    }
  } else {
    // Rolling / sliding contact: project the real velocity (the full tick of gravity, not the integration
    // average) onto the surface, so slopes pull with g·sinθ against the rolling decel.
    const bn = b.vx * nx + b.vy * ny + b.vz * nz;
    const k = bn < 0 ? bn : 0;
    vel.x = b.vx - k * nx;
    vel.y = b.vy - k * ny;
    vel.z = b.vz - k * nz;
    touch.supported = true;
  }
  storeVelocity(b);
}

function makeLoose(b: ProjectileSim, out: StepProjectileResult): void {
  if (b.state !== "live") return;
  b.state = "loose";
  out.becameLoose = true;
}

function stick(b: ProjectileSim, out: StepProjectileResult): void {
  b.state = "stuck";
  b.vx = 0;
  b.vy = 0;
  b.vz = 0;
  b.restTicks = 0;
  out.stuck = true;
}

/** After a contact the sub-step velocity becomes the real velocity (gravity's half-tick is already in vy). */
function storeVelocity(b: ProjectileSim): void {
  b.vx = vel.x;
  b.vy = vel.y;
  b.vz = vel.z;
}

/* ================================================================= rest */

function settle(b: ProjectileSim, def: ItemDef, dt: number, out: StepProjectileResult): void {
  if (!touch.supported) {
    b.restTicks = 0;
    return;
  }
  const decel = PROJECTILE_ROLL_DECEL * (def.restitution < ROLL_MIN_RESTITUTION ? SLIDE_DECEL_MULT : 1) * dt;
  let sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  if (sp <= decel) {
    b.vx = 0;
    b.vy = 0;
    b.vz = 0;
    sp = 0;
  } else {
    const k = (sp - decel) / sp;
    b.vx *= k;
    b.vy *= k;
    b.vz *= k;
    sp -= decel;
  }
  b.restTicks = sp < PROJECTILE_REST_SPEED ? Math.min(REST_TICKS_MAX, b.restTicks + 1) : 0;
  if (b.state === "loose" && b.restTicks >= PROJECTILE_REST_TICKS) {
    b.state = "rest";
    b.vx = 0;
    b.vy = 0;
    b.vz = 0;
    out.cameToRest = true;
  }
}
