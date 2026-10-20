// Floor rings + cover geometry queries. Owner: sim.
// Pure, deterministic, allocation-light. No THREE, no DOM. Used by stepPlayer/stepBall, the
// server world (hits, pickups), the client camera (raycastWorld) and the arc preview.
//
// Floor model: the island top is y = 0. A point (x, z) has floor iff ringIndexAt() >= 0 and that
// ring's state is not RING_FALLEN. Cover pieces are solid prisms from y = 0 to y = height
// (cylinders, or boxes rotated by `rotation` around Y with the yaw convention). Cover never falls.
//
// Box frames: a box's local +X maps to world right(rotation) = (cos r, 0, -sin r) and local +Z to
// (sin r, 0, cos r), i.e. world = rotateY(local, rotation), the same as THREE's `rotation.y = r`.

import { FLOOR_Y, RING_FALLEN, STEP_HEIGHT } from "../constants.js";
import { shapeDistance, type ArenaDef, type CoverBox, type CoverCylinder, type CoverDef } from "../maps.js";
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

/** Below this length a direction is treated as zero (fallback normals kick in). */
const EPS = 1e-9;

/* ================================================================== rings */

/**
 * Ring index containing (x, z): smallest i with shapeDistance(shape, x, z) <= ringRadii[i].
 * Returns -1 beyond the island edge (> last radius).
 */
export function ringIndexAt(arena: ArenaDef, x: number, z: number): number {
  const d = shapeDistance(arena.shape, x, z);
  const radii = arena.ringRadii;
  for (let i = 0; i < radii.length; i++) {
    if (d <= radii[i]) return i;
  }
  return -1;
}

/**
 * True if (x, z) is over solid (or shaking) floor: ringIndexAt >= 0 and rings[i] !== RING_FALLEN.
 * A missing entry (rings shorter than ringRadii, e.g. an empty lobby state) counts as solid.
 */
export function isFloorAt(q: FloorQuery, x: number, z: number): boolean {
  const ring = ringIndexAt(q.arena, x, z);
  if (ring < 0) return false;
  return ring >= q.rings.length || q.rings[ring] !== RING_FALLEN;
}

/* ============================================================ footprints */

/** Footprint test: is (x, z) inside cover piece `c` grown by `radius`? */
export function pointInCover(c: CoverDef, x: number, z: number, radius: number): boolean {
  if (c.shape === "cylinder") {
    const dx = x - c.x;
    const dz = z - c.z;
    const r = c.radius + radius;
    return dx * dx + dz * dz <= r * r;
  }
  const cs = Math.cos(c.rotation);
  const sn = Math.sin(c.rotation);
  const dx = x - c.x;
  const dz = z - c.z;
  const ex = Math.abs(dx * cs - dz * sn) - c.halfX;
  const ez = Math.abs(dx * sn + dz * cs) - c.halfZ;
  const ox = ex > 0 ? ex : 0;
  const oz = ez > 0 ? ez : 0;
  return ox * ox + oz * oz <= radius * radius;
}

/**
 * Highest cover top under a circle of `radius` at (x, z): max(height) over cover whose footprint
 * overlaps the circle, or -Infinity if none.
 */
export function coverTopAt(arena: ArenaDef, x: number, z: number, radius: number): number {
  let top = -Infinity;
  const cover = arena.cover;
  for (let i = 0; i < cover.length; i++) {
    const c = cover[i];
    if (c.height > top && pointInCover(c, x, z, radius)) top = c.height;
  }
  return top;
}

/**
 * Supporting surface height for a body of `radius` whose feet are at `feetY`:
 * - floor: 0 if isFloorAt(q, x, z) (center point only; the floor has no edge overhang) AND
 *   0 <= feetY + STEP_HEIGHT, else -Infinity. (Once you have dropped below the island top you
 *   can never snap back up onto it, e.g. after being knocked back under the slab or a ring falls.)
 * - cover: the highest overlapping cover top that is <= feetY + STEP_HEIGHT (you can't snap up a
 *   tall wall; a taller overlapping piece doesn't hide a lower one you can stand on).
 * Returns the max of those, or -Infinity (falling into the void).
 * Players use radius = PLAYER_RADIUS * 0.6 for standing on cover (slight overhang allowed).
 * stepPlayer passes feetY = max(y before integration, y after) so a fast fall (up to
 * MAX_FALL_SPEED·dt = 1 m per tick) still lands on a cover top it passed through this tick.
 */
export function groundHeightAt(q: FloorQuery, x: number, z: number, radius: number, feetY: number): number {
  const reach = feetY + STEP_HEIGHT;
  let best = reach >= FLOOR_Y && isFloorAt(q, x, z) ? FLOOR_Y : -Infinity;
  const cover = q.arena.cover;
  for (let i = 0; i < cover.length; i++) {
    const c = cover[i];
    if (c.height > best && c.height <= reach && pointInCover(c, x, z, radius)) best = c.height;
  }
  return best;
}

/* ===================================================== capsule vs cover */

/** Horizontal push-out result (module scratch: written and read within one call, never retained). */
const push = { nx: 0, nz: 0, depth: 0 };

/** Circle (x, z, radius) vs cylinder footprint. Fills `push` and returns true when overlapping. */
function circleVsCylinder(c: CoverCylinder, x: number, z: number, radius: number): boolean {
  const dx = x - c.x;
  const dz = z - c.z;
  const minDist = c.radius + radius;
  const d2 = dx * dx + dz * dz;
  if (d2 >= minDist * minDist) return false;
  const d = Math.sqrt(d2);
  if (d > EPS) {
    push.nx = dx / d;
    push.nz = dz / d;
  } else {
    push.nx = 1;
    push.nz = 0;
  }
  push.depth = minDist - d;
  return true;
}

/** Circle (x, z, radius) vs rotated box footprint (rounded corners). Fills `push`. */
function circleVsBox(c: CoverBox, x: number, z: number, radius: number): boolean {
  const cs = Math.cos(c.rotation);
  const sn = Math.sin(c.rotation);
  const dx = x - c.x;
  const dz = z - c.z;
  const lx = dx * cs - dz * sn;
  const lz = dx * sn + dz * cs;
  const ax = Math.abs(lx);
  const az = Math.abs(lz);
  let nlx: number;
  let nlz: number;
  if (ax < c.halfX && az < c.halfZ) {
    // Center inside the box: leave along the axis of least penetration.
    const penX = c.halfX - ax;
    const penZ = c.halfZ - az;
    if (penX <= penZ) {
      nlx = lx >= 0 ? 1 : -1;
      nlz = 0;
      push.depth = penX + radius;
    } else {
      nlx = 0;
      nlz = lz >= 0 ? 1 : -1;
      push.depth = penZ + radius;
    }
  } else {
    const ex = lx - clampAbs(lx, c.halfX);
    const ez = lz - clampAbs(lz, c.halfZ);
    const d2 = ex * ex + ez * ez;
    if (d2 >= radius * radius) return false;
    const d = Math.sqrt(d2);
    if (d > EPS) {
      nlx = ex / d;
      nlz = ez / d;
    } else if (ax >= c.halfX) {
      nlx = lx >= 0 ? 1 : -1;
      nlz = 0;
    } else {
      nlx = 0;
      nlz = lz >= 0 ? 1 : -1;
    }
    push.depth = radius - d;
  }
  push.nx = nlx * cs + nlz * sn;
  push.nz = -nlx * sn + nlz * cs;
  return true;
}

function clampAbs(v: number, half: number): number {
  return v < -half ? -half : v > half ? half : v;
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
  let pushed = false;
  const cover = arena.cover;
  for (let i = 0; i < cover.length; i++) {
    const c = cover[i];
    if (c.height <= pos.y + STEP_HEIGHT || pos.y + height <= FLOOR_Y) continue;
    const hit = c.shape === "cylinder" ? circleVsCylinder(c, pos.x, pos.z, radius) : circleVsBox(c, pos.x, pos.z, radius);
    if (!hit) continue;
    pos.x += push.nx * push.depth;
    pos.z += push.nz * push.depth;
    if (vel) {
      const vn = vel.x * push.nx + vel.z * push.nz;
      if (vn < 0) {
        vel.x -= push.nx * vn;
        vel.z -= push.nz * vn;
      }
    }
    pushed = true;
  }
  return pushed;
}

/* ====================================================== sphere vs cover */

/** Per-piece candidate (module scratch, see `push`). */
const candidate: Contact = { nx: 0, ny: 0, nz: 0, depth: 0, coverIndex: -1 };

function setContact(out: Contact, nx: number, ny: number, nz: number, depth: number, coverIndex: number): true {
  out.nx = nx;
  out.ny = ny;
  out.nz = nz;
  out.depth = depth;
  out.coverIndex = coverIndex;
  return true;
}

function sphereVsCylinder(c: CoverCylinder, center: Vec3, radius: number, index: number, out: Contact): boolean {
  const dx = center.x - c.x;
  const dz = center.z - c.z;
  const rh = Math.sqrt(dx * dx + dz * dz);
  const y = center.y;
  if (rh <= c.radius && y >= FLOOR_Y && y <= c.height) {
    const side = c.radius - rh;
    const top = c.height - y;
    if (top <= side) return setContact(out, 0, 1, 0, top + radius, index);
    if (rh > EPS) return setContact(out, dx / rh, 0, dz / rh, side + radius, index);
    return setContact(out, 1, 0, 0, side + radius, index);
  }
  // Closest point on the prism surface.
  const k = rh > c.radius ? c.radius / rh : 1;
  const ex = dx - dx * k;
  const ez = dz - dz * k;
  const ey = y - (y < FLOOR_Y ? FLOOR_Y : y > c.height ? c.height : y);
  const d2 = ex * ex + ey * ey + ez * ez;
  if (d2 >= radius * radius || d2 <= EPS * EPS) return false;
  const d = Math.sqrt(d2);
  return setContact(out, ex / d, ey / d, ez / d, radius - d, index);
}

function sphereVsBox(c: CoverBox, center: Vec3, radius: number, index: number, out: Contact): boolean {
  const cs = Math.cos(c.rotation);
  const sn = Math.sin(c.rotation);
  const dx = center.x - c.x;
  const dz = center.z - c.z;
  const lx = dx * cs - dz * sn;
  const lz = dx * sn + dz * cs;
  const y = center.y;
  let nlx: number;
  let nly: number;
  let nlz: number;
  let depth: number;
  if (Math.abs(lx) <= c.halfX && Math.abs(lz) <= c.halfZ && y >= FLOOR_Y && y <= c.height) {
    const penX = c.halfX - Math.abs(lx);
    const penZ = c.halfZ - Math.abs(lz);
    const penTop = c.height - y;
    if (penTop <= penX && penTop <= penZ) {
      nlx = 0;
      nly = 1;
      nlz = 0;
      depth = penTop + radius;
    } else if (penX <= penZ) {
      nlx = lx >= 0 ? 1 : -1;
      nly = 0;
      nlz = 0;
      depth = penX + radius;
    } else {
      nlx = 0;
      nly = 0;
      nlz = lz >= 0 ? 1 : -1;
      depth = penZ + radius;
    }
  } else {
    const ex = lx - clampAbs(lx, c.halfX);
    const ez = lz - clampAbs(lz, c.halfZ);
    const ey = y - (y < FLOOR_Y ? FLOOR_Y : y > c.height ? c.height : y);
    const d2 = ex * ex + ey * ey + ez * ez;
    if (d2 >= radius * radius || d2 <= EPS * EPS) return false;
    const d = Math.sqrt(d2);
    nlx = ex / d;
    nly = ey / d;
    nlz = ez / d;
    depth = radius - d;
  }
  return setContact(out, nlx * cs + nlz * sn, nly, -nlx * sn + nlz * cs, depth, index);
}

/**
 * Allocation-free sphereCoverContact: writes the deepest contact into `out` and returns true,
 * or returns false (out untouched) when the sphere touches no cover.
 */
export function sphereCoverContactInto(arena: ArenaDef, center: Vec3, radius: number, out: Contact): boolean {
  let found = false;
  const cover = arena.cover;
  for (let i = 0; i < cover.length; i++) {
    const c = cover[i];
    const hit =
      c.shape === "cylinder"
        ? sphereVsCylinder(c, center, radius, i, candidate)
        : sphereVsBox(c, center, radius, i, candidate);
    if (hit && (!found || candidate.depth > out.depth)) {
      setContact(out, candidate.nx, candidate.ny, candidate.nz, candidate.depth, i);
      found = true;
    }
  }
  return found;
}

/**
 * Sphere vs the nearest overlapping cover piece (3D: sides AND top face). Returns the deepest
 * contact or null. Used by stepBall for cover bounces.
 */
export function sphereCoverContact(arena: ArenaDef, center: Vec3, radius: number): Contact | null {
  const out: Contact = { nx: 0, ny: 0, nz: 0, depth: 0, coverIndex: -1 };
  return sphereCoverContactInto(arena, center, radius, out) ? out : null;
}

/* ===================================================== sphere vs capsule */

/**
 * Sphere vs vertical capsule overlap. Capsule = segment from (feet + r) to (feet + capHeight - r)
 * on the Y axis through (capFeet.x, capFeet.z), radius r = min(capRadius, capHeight / 2).
 * True if distance(sphere center, segment) <= sphereRadius + r.
 * The radius only shrinks for capsules shorter than their diameter (Pip's SLIDE_HEIGHT 0.7 with
 * PLAYER_RADIUS 0.45): the hitbox then still ends at feet + capHeight, so head-height balls pass
 * over a belly slide instead of hitting an inflated sphere.
 * Used for ball hits (capHeight = PLAYER_HEIGHT, or SLIDE_HEIGHT while Pip belly-slides).
 */
export function sphereCapsuleOverlap(
  center: Vec3,
  sphereRadius: number,
  capFeet: Vec3,
  capRadius: number,
  capHeight: number,
): boolean {
  const r = Math.min(capRadius, capHeight * 0.5);
  const bottom = capFeet.y + r;
  const top = capFeet.y + capHeight - r;
  const cy = center.y < bottom ? bottom : center.y > top ? top : center.y;
  const dx = center.x - capFeet.x;
  const dy = center.y - cy;
  const dz = center.z - capFeet.z;
  const reach = sphereRadius + r;
  return dx * dx + dy * dy + dz * dz <= reach * reach;
}

/* ================================================================ raycast */

/** Ray-vs-prism entry interval (module scratch). */
const span = { enter: 0, exit: 0 };

/** t-interval where the ray is inside the slab [min, max] along one axis; false if never. */
function clipSlab(o: number, d: number, min: number, max: number): boolean {
  if (Math.abs(d) < EPS) return o >= min && o <= max;
  let t0 = (min - o) / d;
  let t1 = (max - o) / d;
  if (t0 > t1) {
    const t = t0;
    t0 = t1;
    t1 = t;
  }
  if (t0 > span.enter) span.enter = t0;
  if (t1 < span.exit) span.exit = t1;
  return span.enter <= span.exit;
}

/** Distance to the cylinder prism along the ray, or Infinity. 0 when the origin is inside. */
function rayVsCylinder(c: CoverCylinder, origin: Vec3, dir: Vec3): number {
  span.enter = -Infinity;
  span.exit = Infinity;
  if (!clipSlab(origin.y, dir.y, FLOOR_Y, c.height)) return Infinity;
  const ox = origin.x - c.x;
  const oz = origin.z - c.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  const cc = ox * ox + oz * oz - c.radius * c.radius;
  if (a < EPS) {
    if (cc > 0) return Infinity;
  } else {
    const b = ox * dir.x + oz * dir.z;
    const disc = b * b - a * cc;
    if (disc < 0) return Infinity;
    const root = Math.sqrt(disc);
    const t0 = (-b - root) / a;
    const t1 = (-b + root) / a;
    if (t0 > span.enter) span.enter = t0;
    if (t1 < span.exit) span.exit = t1;
  }
  return entryDistance();
}

/** Distance to the box prism along the ray, or Infinity. 0 when the origin is inside. */
function rayVsBox(c: CoverBox, origin: Vec3, dir: Vec3): number {
  span.enter = -Infinity;
  span.exit = Infinity;
  const cs = Math.cos(c.rotation);
  const sn = Math.sin(c.rotation);
  const ox = origin.x - c.x;
  const oz = origin.z - c.z;
  const lox = ox * cs - oz * sn;
  const loz = ox * sn + oz * cs;
  const ldx = dir.x * cs - dir.z * sn;
  const ldz = dir.x * sn + dir.z * cs;
  if (!clipSlab(origin.y, dir.y, FLOOR_Y, c.height)) return Infinity;
  if (!clipSlab(lox, ldx, -c.halfX, c.halfX)) return Infinity;
  if (!clipSlab(loz, ldz, -c.halfZ, c.halfZ)) return Infinity;
  return entryDistance();
}

function entryDistance(): number {
  if (span.enter > span.exit || span.exit < 0) return Infinity;
  return span.enter > 0 ? span.enter : 0;
}

/**
 * Ray vs all cover prisms (sides and tops) and the floor plane y = 0 where solid.
 * Returns the distance along unit `dir` to the first hit, or maxDist if nothing is hit.
 * An origin inside a cover prism returns 0. The floor is hit from above only (no slab sides),
 * and not where its ring has fallen.
 * Used by the client CameraRig (pull the camera in front of cover) and the arc preview.
 */
export function raycastWorld(q: FloorQuery, origin: Vec3, dir: Vec3, maxDist: number): number {
  let best = maxDist;
  if (dir.y < 0 && origin.y >= FLOOR_Y) {
    const t = (FLOOR_Y - origin.y) / dir.y;
    if (t < best && isFloorAt(q, origin.x + dir.x * t, origin.z + dir.z * t)) best = t;
  }
  const cover = q.arena.cover;
  for (let i = 0; i < cover.length; i++) {
    const c = cover[i];
    const t = c.shape === "cylinder" ? rayVsCylinder(c, origin, dir) : rayVsBox(c, origin, dir);
    if (t < best) best = t;
  }
  return best;
}
