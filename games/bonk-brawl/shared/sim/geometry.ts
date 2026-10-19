// Floor rings + cover geometry queries. Owner: sim.
// Pure, deterministic, allocation-light. No THREE, no DOM. Used by stepPlayer/stepBall, the
// server world (hits, pickups), the client camera (raycastWorld) and the arc preview.
//
// Floor model: the island top is y = 0. A point (x, z) has floor iff ringIndexAt() >= 0 and that
// ring's state is not RING_FALLEN. Cover pieces are solid prisms from y = 0 to y = height
// (cylinders, or boxes rotated by `rotation` around Y with the yaw convention). Cover never falls.

import type { ArenaDef, CoverDef } from "../maps.js";
import type { FloorQuery } from "./context.js";
import type { Vec3 } from "./math.js";

/** Contact result for sphere-vs-cover / sphere-vs-floor. */
export interface Contact {
  /** Unit surface normal pointing out of the obstacle toward the sphere center. */
  nx: number;
  ny: number;
  nz: number;
  /** Penetration depth (> 0 when overlapping). */
  depth: number;
  /** Which cover piece (index into arena.cover), or -1 for the floor. */
  coverIndex: number;
}

/**
 * Ring index containing (x, z): smallest i with shapeDistance(shape, x, z) <= ringRadii[i].
 * Returns -1 beyond the island edge (> last radius).
 */
export function ringIndexAt(arena: ArenaDef, x: number, z: number): number {
  void arena;
  void x;
  void z;
  return 0; // TODO(sim)
}

/**
 * True if (x, z) is over solid (or shaking) floor: ringIndexAt >= 0 and rings[i] !== RING_FALLEN.
 * A missing entry (rings shorter than ringRadii, e.g. an empty lobby state) counts as solid.
 */
export function isFloorAt(q: FloorQuery, x: number, z: number): boolean {
  void q;
  void x;
  void z;
  return true; // TODO(sim)
}

/**
 * Highest cover top under a circle of `radius` at (x, z): max(height) over cover whose footprint
 * overlaps the circle, or -Infinity if none.
 */
export function coverTopAt(arena: ArenaDef, x: number, z: number, radius: number): number {
  void arena;
  void x;
  void z;
  void radius;
  return -Infinity; // TODO(sim)
}

/**
 * Supporting surface height for a body of `radius` whose feet are at `feetY`:
 * - floor: 0 if isFloorAt(q, x, z) (center point only; the floor has no edge overhang) AND
 *   0 <= feetY + STEP_HEIGHT, else -Infinity. (Once you have dropped below the island top you
 *   can never snap back up onto it, e.g. after being knocked back under the slab or a ring falls.)
 * - cover: coverTopAt(...) but only if that top <= feetY + STEP_HEIGHT (you can't snap up a tall wall)
 * Returns the max of those, or -Infinity (falling into the void).
 * Players use radius = PLAYER_RADIUS * 0.6 for standing on cover (slight overhang allowed).
 * stepPlayer passes feetY = max(y before integration, y after) so a fast fall (up to
 * MAX_FALL_SPEED·dt = 1 m per tick) still lands on a cover top it passed through this tick.
 */
export function groundHeightAt(q: FloorQuery, x: number, z: number, radius: number, feetY: number): number {
  void q;
  void x;
  void z;
  void radius;
  void feetY;
  return 0; // TODO(sim)
}

/**
 * Push a vertical capsule (feet at pos, given radius/height) horizontally out of every cover
 * piece it overlaps whose top is above pos.y + STEP_HEIGHT and whose bottom (0) is below
 * pos.y + height. Mutates pos.x/pos.z. If `vel` is given, removes the velocity component
 * going into the surface (slide along walls). Returns true if any push happened.
 * Cylinders: radial push. Boxes: push along the axis of least penetration in the box frame
 * (rounded corners: treat the capsule as a circle vs. the box's closest point).
 */
export function resolveCoverCollision(arena: ArenaDef, pos: Vec3, radius: number, height: number, vel?: Vec3): boolean {
  void arena;
  void pos;
  void radius;
  void height;
  void vel;
  return false; // TODO(sim)
}

/**
 * Sphere vs the nearest overlapping cover piece (3D: sides AND top face). Returns the deepest
 * contact or null. Used by stepBall for cover bounces.
 */
export function sphereCoverContact(arena: ArenaDef, center: Vec3, radius: number): Contact | null {
  void arena;
  void center;
  void radius;
  return null; // TODO(sim)
}

/**
 * Sphere vs vertical capsule overlap. Capsule = segment from (feet + capRadius) to
 * (feet + capHeight - capRadius) on the Y axis through (capFeet.x, capFeet.z), radius capRadius.
 * True if distance(sphere center, segment) <= sphereRadius + capRadius.
 * Used for ball hits (capHeight = PLAYER_HEIGHT, or SLIDE_HEIGHT while Pip belly-slides).
 */
export function sphereCapsuleOverlap(
  center: Vec3,
  sphereRadius: number,
  capFeet: Vec3,
  capRadius: number,
  capHeight: number,
): boolean {
  void center;
  void sphereRadius;
  void capFeet;
  void capRadius;
  void capHeight;
  return false; // TODO(sim)
}

/**
 * Ray vs all cover prisms (sides and tops) and the floor plane y = 0 where solid.
 * Returns the distance along unit `dir` to the first hit, or maxDist if nothing is hit.
 * Used by the client CameraRig (pull the camera in front of cover) and the arc preview.
 */
export function raycastWorld(q: FloorQuery, origin: Vec3, dir: Vec3, maxDist: number): number {
  void q;
  void origin;
  void dir;
  return maxDist; // TODO(sim)
}

/** Footprint test: is (x, z) inside cover piece `c` grown by `radius`? */
export function pointInCover(c: CoverDef, x: number, z: number, radius: number): boolean {
  void c;
  void x;
  void z;
  void radius;
  return false; // TODO(sim)
}
