// Collision cylinders ("cover") for players, projectiles and monsters. Owner: sim.
//
// Static cover comes from the island (tree / palm trunks, rocks, the wreck, the camp chest); dynamic cover from
// placed structures (fences = a row of small circles along FENCE_LENGTH, collectors, huts). Bushes, the campfire,
// the raft, planted torches, krakens and canoes don't collide.
//
// Index: a uniform spatial hash with COVER_BUCKET (2 m) buckets laid over the island grid. Every circle is
// registered in each bucket its bounding square touches, so a query only visits the buckets of its own square
// (1–4 for a player) and never misses a circle. Circles and queries outside the grid clamp to the edge buckets
// (clamping is monotonic, so overlapping squares still share a bucket). The static layer is built once; the
// dynamic layer is rebuilt by setStructures() (sorted by structure id, so the result does not depend on the
// iteration order of the state map).
//
// Determinism: query() returns circles in insertion order (static circles first, in island order: nodes, then
// per site wreck, chest; then dynamic circles), no matter which buckets they were found in. stepPlayer's
// push-out order therefore matches on the server and in client prediction.
//
// Allocation: query() allocates nothing when `out` is long enough (it grows `out` otherwise); the internal
// scratch buffers only grow.

import { FENCE_LENGTH } from "../constants.js";
import { heightAt } from "../island/heightfield.js";
import type { IslandDef } from "../island/types.js";
import type { StructureKind } from "../types.js";

export type CoverKind = "tree" | "palm" | "rock" | "wreck" | "chest" | "fence" | "collector" | "hut";

/** A vertical cylinder from `bottom` to `top` (world y). */
export interface CoverCircle {
  x: number;
  z: number;
  r: number;
  bottom: number;
  top: number;
  kind: CoverKind;
  /** Node index for tree / palm / rock, else -1. */
  node: number;
  /** Structure id for placed structures, else "". */
  id: string;
}

export interface CoverQuery {
  /**
   * Write every circle whose footprint is within `radius` of (x, z) (i.e. distance between centers < r + radius)
   * into `out` starting at index 0 (out may be longer: use the returned count). Never allocates when `out` is
   * long enough (grow it if not).
   */
  query(x: number, z: number, radius: number, out: CoverCircle[]): number;
}

/** Placed structures as the cover index needs them (StructureView satisfies it). */
export interface CoverStructure {
  id: string;
  kind: StructureKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export const WRECK_RADIUS = 1.8;
export const WRECK_HEIGHT = 2.6;
export const CHEST_RADIUS = 0.55;
export const CHEST_HEIGHT_M = 0.8;
export const FENCE_POST_RADIUS = 0.32;
/** Fence posts stand this tall above the structure's y (a jump clears them). */
export const FENCE_HEIGHT = 1.2;
export const COLLECTOR_RADIUS = 0.45;
export const COLLECTOR_HEIGHT = 1;
export const HUT_RADIUS = 1.9;
export const HUT_HEIGHT = 2.6;
/** Every collider reaches this far below its base (so slopes and the shallows never open a gap underneath). */
export const COVER_BURY = 1;
/** Wrecks sit deeper in the sand. */
export const WRECK_BURY = 2;
/** Spatial hash bucket edge (meters). */
export const COVER_BUCKET = 2;

/** Trunks hide their tops inside the crown: projectiles only collide with their sides (see sphereCircleContact). */
export function isTrunk(c: CoverCircle): boolean {
  return c.kind === "tree" || c.kind === "palm";
}

/** The vertical span [bottom, top] of `c` overlaps [y0, y1]. */
export function overlapsY(c: CoverCircle, y0: number, y1: number): boolean {
  return c.bottom < y1 && c.top > y0;
}

/** Sphere-vs-cylinder contact: unit normal out of the cylinder toward the sphere center and the penetration. */
export interface CoverContact {
  nx: number;
  ny: number;
  nz: number;
  depth: number;
}

const EPS = 1e-9;

/**
 * Sphere (center x, y, z, `radius`) vs the solid cylinder `c` (sides, top and bottom faces). Writes the contact
 * into `out` and returns true when they overlap. A center inside the cylinder leaves through the nearer of the
 * side and the top face. Trunks (isTrunk) are side-only: their top face is inside the crown, so a sphere above
 * the trunk top never touches it and a center inside always leaves sideways.
 */
export function sphereCircleContact(c: CoverCircle, x: number, y: number, z: number, radius: number, out: CoverContact): boolean {
  const sideOnly = isTrunk(c);
  const dx = x - c.x;
  const dz = z - c.z;
  const rh = Math.sqrt(dx * dx + dz * dz);
  if (rh <= c.r && y >= c.bottom && y <= c.top) {
    const side = c.r - rh;
    const top = c.top - y;
    if (!sideOnly && top <= side) return setContact(out, 0, 1, 0, top + radius);
    if (rh > EPS) return setContact(out, dx / rh, 0, dz / rh, side + radius);
    return setContact(out, 1, 0, 0, side + radius);
  }
  if (sideOnly && (y > c.top || y < c.bottom)) return false;
  // Closest point on the cylinder surface.
  const k = rh > c.r ? c.r / rh : 1;
  const ex = dx - dx * k;
  const ez = dz - dz * k;
  const ey = y - (y < c.bottom ? c.bottom : y > c.top ? c.top : y);
  const d2 = ex * ex + ey * ey + ez * ez;
  if (d2 >= radius * radius || d2 <= EPS * EPS) return false;
  const d = Math.sqrt(d2);
  return setContact(out, ex / d, ey / d, ez / d, radius - d);
}

function setContact(out: CoverContact, nx: number, ny: number, nz: number, depth: number): true {
  out.nx = nx;
  out.ny = ny;
  out.nz = nz;
  out.depth = depth;
  return true;
}

/* ============================================================ spatial hash */

/** Bucket grid shared by both layers. */
interface BucketGrid {
  originX: number;
  originZ: number;
  cols: number;
  rows: number;
}

/** Query scratch: matching circle indices of one layer (sorted before they are written out). */
let hits = new Int32Array(32);

/**
 * One layer of circles in a CSR bucket table: bucket b holds items[start[b] .. start[b + 1]) in ascending
 * circle-index order (circles are registered in insertion order).
 */
class CoverLayer {
  circles: CoverCircle[] = [];
  private start: Int32Array = new Int32Array(1);
  private items: Int32Array = new Int32Array(0);
  /** Last query serial that visited each circle (dedupes circles registered in several buckets). */
  private seen: Uint32Array = new Uint32Array(0);
  private serial = 0;

  constructor(private readonly grid: BucketGrid) {}

  /** Replace the layer's circles and rebuild the bucket table. */
  build(circles: CoverCircle[]): void {
    this.circles = circles;
    const g = this.grid;
    const buckets = g.cols * g.rows;
    if (this.start.length !== buckets + 1) this.start = new Int32Array(buckets + 1);
    else this.start.fill(0);
    if (this.seen.length < circles.length) this.seen = new Uint32Array(Math.max(circles.length, this.seen.length * 2));
    else this.seen.fill(0);
    this.serial = 0;
    const start = this.start;
    // Pass 1: count registrations per bucket (shifted by one for the prefix sum).
    let total = 0;
    for (const c of circles) {
      const c0 = this.col(c.x - c.r);
      const c1 = this.col(c.x + c.r);
      const r0 = this.row(c.z - c.r);
      const r1 = this.row(c.z + c.r);
      for (let r = r0; r <= r1; r++) for (let k = c0; k <= c1; k++) start[r * g.cols + k + 1]!++;
      total += (c1 - c0 + 1) * (r1 - r0 + 1);
    }
    for (let b = 0; b < buckets; b++) start[b + 1]! += start[b]!;
    if (this.items.length < total) this.items = new Int32Array(total);
    // Pass 2: fill, with a per-bucket write cursor (rebuild time only, never per query).
    const cursor = new Int32Array(buckets);
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i]!;
      const c0 = this.col(c.x - c.r);
      const c1 = this.col(c.x + c.r);
      const r0 = this.row(c.z - c.r);
      const r1 = this.row(c.z + c.r);
      for (let r = r0; r <= r1; r++) {
        for (let k = c0; k <= c1; k++) {
          const b = r * g.cols + k;
          this.items[start[b]! + cursor[b]!] = i;
          cursor[b]!++;
        }
      }
    }
  }

  /** Append the matching circles (insertion order) to out[n..]; returns the new count. */
  query(x: number, z: number, radius: number, out: CoverCircle[], n: number): number {
    const circles = this.circles;
    if (circles.length === 0) return n;
    const g = this.grid;
    const c0 = this.col(x - radius);
    const c1 = this.col(x + radius);
    const r0 = this.row(z - radius);
    const r1 = this.row(z + radius);
    const single = c0 === c1 && r0 === r1;
    let serial = ++this.serial;
    if (serial >= 0xffffffff) {
      this.seen.fill(0);
      this.serial = serial = 1;
    }
    let count = 0;
    for (let r = r0; r <= r1; r++) {
      for (let k = c0; k <= c1; k++) {
        const b = r * g.cols + k;
        const end = this.start[b + 1]!;
        for (let j = this.start[b]!; j < end; j++) {
          const i = this.items[j]!;
          if (!single) {
            if (this.seen[i] === serial) continue;
            this.seen[i] = serial;
          }
          const c = circles[i]!;
          const dx = c.x - x;
          const dz = c.z - z;
          const rr = c.r + radius;
          if (dx * dx + dz * dz < rr * rr) {
            if (count >= hits.length) {
              const grown = new Int32Array(hits.length * 2);
              grown.set(hits);
              hits = grown;
            }
            hits[count++] = i;
          }
        }
      }
    }
    // One bucket is already in ascending order; several buckets interleave: insertion sort (counts are tiny).
    if (!single) {
      for (let a = 1; a < count; a++) {
        const v = hits[a]!;
        let p = a - 1;
        while (p >= 0 && hits[p]! > v) {
          hits[p + 1] = hits[p]!;
          p--;
        }
        hits[p + 1] = v;
      }
    }
    for (let a = 0; a < count; a++) out[n++] = circles[hits[a]!]!;
    return n;
  }

  private col(x: number): number {
    const k = Math.floor((x - this.grid.originX) / COVER_BUCKET);
    return k < 0 ? 0 : k >= this.grid.cols ? this.grid.cols - 1 : k;
  }

  private row(z: number): number {
    const k = Math.floor((z - this.grid.originZ) / COVER_BUCKET);
    return k < 0 ? 0 : k >= this.grid.rows ? this.grid.rows - 1 : k;
  }
}

/* ============================================================== the index */

/**
 * The collision index for one island: static cover from the IslandDef plus a dynamic layer of placed
 * structures. Server (RaftWorld) and client (prediction) each build one from the same IslandDef and feed it the
 * same structures, so stepPlayer / stepProjectile see identical colliders.
 */
export class CoverIndex implements CoverQuery {
  private readonly grid: BucketGrid;
  private readonly staticLayer: CoverLayer;
  private readonly dynamicLayer: CoverLayer;

  constructor(island: IslandDef) {
    const hf = island.grid;
    const width = (hf.cols - 1) * hf.cell;
    const depth = (hf.rows - 1) * hf.cell;
    this.grid = {
      originX: hf.originX,
      originZ: hf.originZ,
      cols: Math.max(1, Math.ceil(width / COVER_BUCKET)),
      rows: Math.max(1, Math.ceil(depth / COVER_BUCKET)),
    };
    this.staticLayer = new CoverLayer(this.grid);
    this.dynamicLayer = new CoverLayer(this.grid);
    this.staticLayer.build(staticCircles(island));
    this.dynamicLayer.build([]);
  }

  /** Replace the dynamic part with these structures (call when state.structures changes). */
  setStructures(structures: Iterable<CoverStructure>): void {
    const list: CoverStructure[] = [];
    for (const s of structures) {
      if (s.kind === "fence" || s.kind === "collector" || s.kind === "hut") list.push(s);
    }
    // Structure ids are "s<n>": order by numeric suffix (length first), whatever order the map iterates in.
    list.sort((a, b) => (a.id.length !== b.id.length ? a.id.length - b.id.length : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const circles: CoverCircle[] = [];
    for (const s of list) structureCircles(s, circles);
    this.dynamicLayer.build(circles);
  }

  query(x: number, z: number, radius: number, out: CoverCircle[]): number {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(radius >= 0)) return 0;
    const n = this.staticLayer.query(x, z, radius, out, 0);
    return this.dynamicLayer.query(x, z, radius, out, n);
  }

  /** Every circle (static then dynamic), for debug drawing and bots. */
  all(): CoverCircle[] {
    return [...this.staticLayer.circles, ...this.dynamicLayer.circles];
  }

  /** Number of static / dynamic circles. */
  get staticCount(): number {
    return this.staticLayer.circles.length;
  }

  get dynamicCount(): number {
    return this.dynamicLayer.circles.length;
  }
}

/** Island colliders in insertion order: nodes (index order), then per site the wreck and the chest. */
function staticCircles(island: IslandDef): CoverCircle[] {
  const out: CoverCircle[] = [];
  for (const n of island.nodes) {
    if (n.radius <= 0 || n.kind === "bush") continue;
    out.push({ x: n.x, z: n.z, r: n.radius, bottom: n.y - COVER_BURY, top: n.y + n.height, kind: n.kind, node: n.i, id: "" });
  }
  for (const s of island.sites) {
    const wy = heightAt(island.grid, s.wreck.x, s.wreck.z);
    out.push({ x: s.wreck.x, z: s.wreck.z, r: WRECK_RADIUS, bottom: wy - WRECK_BURY, top: wy + WRECK_HEIGHT, kind: "wreck", node: -1, id: "" });
    const cy = heightAt(island.grid, s.chest.x, s.chest.z);
    out.push({ x: s.chest.x, z: s.chest.z, r: CHEST_RADIUS, bottom: cy - COVER_BURY, top: cy + CHEST_HEIGHT_M, kind: "chest", node: -1, id: "" });
  }
  return out;
}

/** Colliders of one placed structure (nothing for torches, krakens and canoes). */
function structureCircles(s: CoverStructure, out: CoverCircle[]): void {
  if (s.kind === "fence") {
    // Three posts along the fence's local x axis (yaw 0 faces -Z, so the fence spans world x at yaw 0).
    // Fence yaw is snapped to multiples of π/4 by the server; a table (not cos/sin) keeps this bit-exact.
    const [ax, az] = fenceAxis(s.yaw);
    for (let k = -1; k <= 1; k++) {
      const off = (k * FENCE_LENGTH) / 3;
      out.push({ x: s.x + ax * off, z: s.z + az * off, r: FENCE_POST_RADIUS, bottom: s.y - COVER_BURY, top: s.y + FENCE_HEIGHT, kind: "fence", node: -1, id: s.id });
    }
  } else if (s.kind === "collector") {
    out.push({ x: s.x, z: s.z, r: COLLECTOR_RADIUS, bottom: s.y - COVER_BURY, top: s.y + COLLECTOR_HEIGHT, kind: "collector", node: -1, id: s.id });
  } else if (s.kind === "hut") {
    out.push({ x: s.x, z: s.z, r: HUT_RADIUS, bottom: s.y - COVER_BURY, top: s.y + HUT_HEIGHT, kind: "hut", node: -1, id: s.id });
  }
}

const H = Math.SQRT1_2;
/** Unit right-vectors for yaw = k·π/4, k = 0..7 (right = (cos yaw, −sin yaw)). */
const FENCE_AXES: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [H, -H],
  [0, -1],
  [-H, -H],
  [-1, 0],
  [-H, H],
  [0, 1],
  [H, H],
];

/** Snap a yaw to the nearest multiple of π/4 (what the server stores for fences). */
export function snapYaw8(yaw: number): number {
  const k = ((Math.round(yaw / (Math.PI / 4)) % 8) + 8) % 8;
  return k * (Math.PI / 4) - (k > 4 ? 2 * Math.PI : 0);
}

/** Right axis of a fence with this (snapped) yaw, from a table (deterministic). */
export function fenceAxis(yaw: number): readonly [number, number] {
  const k = ((Math.round(yaw / (Math.PI / 4)) % 8) + 8) % 8;
  return FENCE_AXES[k]!;
}

export function buildCover(island: IslandDef): CoverIndex {
  return new CoverIndex(island);
}
