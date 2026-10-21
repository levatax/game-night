// Pure rule math used by RaftWorld: bar drain rates, warmth, hit / catch geometry, knockback vectors.
// Owner: server-world. No state, no side effects; every function is unit-testable on its own.
// Numbers come from shared/constants.ts (game4.md §5, §11, §21); the few server-only tunings live here.

import {
  BAR_MAX,
  CATCH_FORWARD,
  CATCH_RANGE,
  CHEST_HEIGHT,
  DT,
  HEATWAVE_THIRST_MULT,
  HUNGER_PER_MIN,
  KNOCKBACK_H,
  KNOCKBACK_UP,
  LOW_BAR_FRACTION,
  SPRINT_HUNGER_MULT,
  THIRST_PER_MIN,
  TORCH_WARMTH_LOSS_PER_SEC,
  WARMTH_GAIN_FIRE_PER_SEC,
  WARMTH_LOSS_PER_SEC,
  type DifficultyDef,
} from "../../shared/constants.js";
import type { Vec3Like } from "../../shared/types.js";

/** Range checks on messages (craft / chest) allow this much latency slack (§4.4). */
export const RANGE_SLACK = 0.5;
/** A live projectile can't hit its own thrower during its first ticks (it spawns at the hand). */
export const OWNER_IMMUNE_TICKS = 6;
/** Nor be caught by its thrower right after the release. */
export const OWN_CATCH_IMMUNE_TICKS = 15;
/** Daytime sun slowly warms players who aren't cold (interpretation: §5 lists no other daytime refill). */
export const SUN_WARMTH_PER_SEC = 1;
/** A `lowBar` line re-arms once the bar is back above this fraction. */
export const LOW_BAR_REARM_FRACTION = LOW_BAR_FRACTION + 0.05;
/** Duel only: a player-thrown item's damage (monster hp units) × this = player hp. */
export const DUEL_PLAYER_DAMAGE_MULT = 10;
/** Kraken tentacle slam damage per KRAKEN_HIT_INTERVAL_TICKS (the slam flips crabs on its own). */
export const KRAKEN_SLAM_DAMAGE = 1;
/** A projectile that bounces off a body keeps this much of its speed and pops up. */
export const BODY_BOUNCE_KEEP = 0.5;
export const BODY_BOUNCE_POP_VY = 3;
/** Fence placement: posts may stand in the shallows down to this depth. */
export const PLACE_MAX_DEPTH = 0.25;
/** Placeables need gentle ground (normal.y). */
export const PLACE_MIN_NORMAL_Y = 0.8;
/** Raft deck height above the sand (boarded players stand on it). */
export const RAFT_DECK_Y = 0.35;
/** Raft seat offsets in the raft's frame (x right, z forward = toward the sea), boarding order. */
export const RAFT_SEATS: ReadonlyArray<readonly [number, number]> = [
  [-0.55, 0.7],
  [0.55, 0.7],
  [-0.55, -0.1],
  [0.55, -0.1],
  [-0.55, -0.9],
  [0.55, -0.9],
];

const EPS = 1e-6;

/* ================================================================ bars */

/** Hunger lost per tick (§5: 25/min × difficulty × fast multiplier; sprinting ×1.5). */
export function hungerDrainPerTick(diff: Pick<DifficultyDef, "bars">, barMult: number, sprinting: boolean): number {
  return (HUNGER_PER_MIN / 60) * DT * diff.bars * barMult * (sprinting ? SPRINT_HUNGER_MULT : 1);
}

/** Thirst lost per tick (§5: 33/min × difficulty × fast multiplier; heat wave ×2 unless in shade). */
export function thirstDrainPerTick(diff: Pick<DifficultyDef, "bars">, barMult: number, heatwave: boolean, shaded: boolean): number {
  return (THIRST_PER_MIN / 60) * DT * diff.bars * barMult * (heatwave && !shaded ? HEATWAVE_THIRST_MULT : 1);
}

/** Seconds a full bar lasts at a per-tick drain. */
export function secondsToEmpty(perTick: number): number {
  return perTick > 0 ? BAR_MAX / (perTick / DT) : Infinity;
}

export interface WarmthConditions {
  /** Within FIRE_WARM_RADIUS of a lit campfire. */
  nearFire: boolean;
  /** Night on a biome with nightChill. */
  nightChill: boolean;
  /** Raining and not sheltered (cave / hut). */
  rainChill: boolean;
  /** Swimming and the character loses warmth in water. */
  waterChill: boolean;
  /** Holding a lit torch (halves the loss). */
  litTorch: boolean;
  /** Daytime (the sun warms a little). */
  daylight: boolean;
}

/**
 * Warmth change per second (§5): +5 near a lit fire; −2 when cold (night / rain / water), −1 with a lit torch in
 * hand; otherwise +SUN_WARMTH_PER_SEC by day and 0 at dusk / on a warm night.
 */
export function warmthPerSec(c: WarmthConditions): number {
  if (c.nearFire) return WARMTH_GAIN_FIRE_PER_SEC;
  if (c.nightChill || c.rainChill || c.waterChill) return -(c.litTorch ? TORCH_WARMTH_LOSS_PER_SEC : WARMTH_LOSS_PER_SEC);
  return c.daylight ? SUN_WARMTH_PER_SEC : 0;
}

/* ============================================================ geometry */

/** Sphere (center c, radius r) vs a vertical capsule standing on `feet` with radius `pr` and height `ph`. */
export function sphereCapsuleOverlap(c: Vec3Like, r: number, feet: Vec3Like, pr: number, ph: number): boolean {
  const y0 = feet.y + pr;
  const y1 = feet.y + Math.max(pr, ph - pr);
  const cy = c.y < y0 ? y0 : c.y > y1 ? y1 : c.y;
  const dx = c.x - feet.x;
  const dy = c.y - cy;
  const dz = c.z - feet.z;
  const rr = r + pr;
  return dx * dx + dy * dy + dz * dz <= rr * rr;
}

/** Sphere vs a vertical cylinder standing on `base` (monsters). */
export function sphereCylinderOverlap(c: Vec3Like, r: number, base: Vec3Like, cr: number, ch: number): boolean {
  if (c.y + r < base.y || c.y - r > base.y + ch) return false;
  const dx = c.x - base.x;
  const dz = c.z - base.z;
  const rr = r + cr;
  return dx * dx + dz * dz <= rr * rr;
}

/** Unit horizontal direction of (x, z), falling back to (fx, fz), then +Z. */
export function horizontalDir(x: number, z: number, fx: number, fz: number, out: { x: number; z: number } = { x: 0, z: 0 }): { x: number; z: number } {
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
 * Knockback of a projectile hit (§11): along the projectile's horizontal travel × KNOCKBACK_H plus KNOCKBACK_UP,
 * all × the item's knock multiplier × `mult` (FRIENDLY_KNOCK_MULT in coop). A projectile falling straight down
 * pushes the target away from it.
 */
export function projectileKnockback(
  proj: { x: number; z: number; vx: number; vz: number },
  target: { x: number; z: number },
  knock: number,
  mult = 1,
): Vec3Like {
  const dir = horizontalDir(proj.vx, proj.vz, target.x - proj.x, target.z - proj.z);
  const k = knock * mult;
  return { x: dir.x * KNOCKBACK_H * k, y: KNOCKBACK_UP * k, z: dir.z * KNOCKBACK_H * k };
}

/** Knockback pushing `target` away from `from` (blasts), straight back along `fallback` when stacked. */
export function radialKnockback(
  from: { x: number; z: number },
  target: { x: number; z: number },
  fallback: { x: number; z: number },
  horizontal: number,
  up: number,
): Vec3Like {
  const dir = horizontalDir(target.x - from.x, target.z - from.z, fallback.x, fallback.z);
  return { x: dir.x * horizontal, y: up, z: dir.z * horizontal };
}

/**
 * Catch test (§11): distance from the catch center (chest + forward · CATCH_FORWARD) when the item is within
 * CATCH_RANGE + its radius of it AND in front of the player; otherwise -1.
 */
export function catchDistance(p: { x: number; y: number; z: number; yaw: number }, item: Vec3Like, radius: number): number {
  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  const front = (item.x - p.x) * fx + (item.z - p.z) * fz;
  if (!(front > 0)) return -1;
  const dx = item.x - (p.x + fx * CATCH_FORWARD);
  const dy = item.y - (p.y + CHEST_HEIGHT);
  const dz = item.z - (p.z + fz * CATCH_FORWARD);
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return d <= CATCH_RANGE + radius ? d : -1;
}

/** Squared horizontal distance. */
export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/** Horizontal distance. */
export function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.sqrt(dist2(ax, az, bx, bz));
}

/** A position snapshot (events never hold live schema references). */
export function posOf(o: Vec3Like): Vec3Like {
  return { x: o.x, y: o.y, z: o.z };
}

export function point(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}
