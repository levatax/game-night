// Small helpers shared by the life systems: rng picks over the world's gameplay rng, light-ring geometry,
// plain-vector copies for event payloads. Owner: server-world-life. Pure (rng passed in), no allocation in the
// ring checks (they run per monster per tick).

import type { Vec3Like } from "../../../shared/types.js";
import type { LightRing } from "../context.js";

export type Rng = () => number;

/** Uniform integer in [lo, hi] (inclusive). */
export function randInt(rng: Rng, lo: number, hi: number): number {
  if (hi <= lo) return lo;
  return Math.min(hi, lo + Math.floor(rng() * (hi - lo + 1)));
}

/** Uniform pick (undefined for an empty list). */
export function pick<T>(rng: Rng, items: ReadonlyArray<T>): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}

/** Weighted pick by `weight(item)`; falls back to the last item on rounding. */
export function pickBy<T>(rng: Rng, items: ReadonlyArray<T>, weight: (item: T) => number): T | undefined {
  let total = 0;
  for (const it of items) total += Math.max(0, weight(it));
  if (items.length === 0) return undefined;
  if (total <= 0) return pick(rng, items);
  let x = rng() * total;
  for (const it of items) {
    x -= Math.max(0, weight(it));
    if (x < 0) return it;
  }
  return items[items.length - 1];
}

/** Plain {x, y, z} copy (event payloads must not alias schema objects). */
export function vec(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

export function posOf(e: { x: number; y: number; z: number }): Vec3Like {
  return { x: e.x, y: e.y, z: e.z };
}

/** Horizontal distance squared. */
export function d2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  return Math.sqrt(d2(ax, az, bx, bz));
}

/** (x, z) is closer than r + pad to any ring center. */
export function inRings(rings: ReadonlyArray<LightRing>, x: number, z: number, pad = 0): boolean {
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i]!;
    const rr = r.r + pad;
    if (d2(x, z, r.x, r.z) < rr * rr) return true;
  }
  return false;
}

/** First ring containing (x, z) (true radius), or null. */
export function ringAt(rings: ReadonlyArray<LightRing>, x: number, z: number): LightRing | null {
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i]!;
    if (d2(x, z, r.x, r.z) < r.r * r.r) return r;
  }
  return null;
}

/**
 * The light rule for a walker moving (ox, oz) → (nx, nz) (game4.md §10 "ışık halkasına girmezler"):
 * - outside every true ring: no ring's padded penetration may grow (so it can slide along an edge or back off,
 *   but never get one millimeter deeper — it never enters a ring);
 * - already inside a ring (a torch was lit next to it): the total penetration must not grow (it escapes).
 */
export function lightMoveOk(rings: ReadonlyArray<LightRing>, ox: number, oz: number, nx: number, nz: number, pad: number): boolean {
  let insideTrue = false;
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i]!;
    if (d2(ox, oz, r.x, r.z) < r.r * r.r) {
      insideTrue = true;
      break;
    }
  }
  if (insideTrue) return penetration(rings, nx, nz, pad) <= penetration(rings, ox, oz, pad) + 1e-9;
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i]!;
    const lim = r.r + pad;
    const pOld = Math.max(0, lim - dist2(ox, oz, r.x, r.z));
    const pNew = Math.max(0, lim - dist2(nx, nz, r.x, r.z));
    if (pNew > pOld + 1e-9) return false;
  }
  return true;
}

/** Σ max(0, r + pad − distance) over the rings. */
export function penetration(rings: ReadonlyArray<LightRing>, x: number, z: number, pad: number): number {
  let p = 0;
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i]!;
    const d = dist2(x, z, r.x, r.z);
    if (d < r.r + pad) p += r.r + pad - d;
  }
  return p;
}
