// Walkability checks, a coarse nav grid and BFS fallback paths for helper bots (§19 "Botlar"). Owner: server-bots.
//
// The rules mirror what stepPlayer enforces (docs/ARCHITECTURE.md §5.1) with small safety margins: a rise of
// more than STEP_MAX per 0.25 m sub-step is a cliff, rising terrain with normal.y < MAX_WALK_NORMAL_Y is a wall,
// water deeper than the swim depth is avoided (bots wade the shallows, they don't swim), and cover cylinders
// (trunks, rocks, the wreck, the chest, fences) block within the player radius.
//
// NavGrid: NAV_CELL (2 m) cells over the island bounds. A cell is walkable when one of a few sample points inside
// it passes the rules above; that point is the cell's waypoint. Edges between neighbouring cells (8-way, no
// corner cutting) are checked lazily with segmentClear() and cached. findPath() runs a breadth-first search,
// falls back to the reachable cell closest to the goal, and string-pulls the result. Grids are cached per
// IslandDef (static cover only: placed fences are left to the local steering).

import { EYE_HEIGHT, FISH_CAST_RANGE, MAX_WALK_NORMAL_Y, PLAYER_RADIUS, STEP_MAX, SWIM_DEPTH, WATER_Y } from "../../shared/constants.js";
import { heightAt, normalAt } from "../../shared/island/heightfield.js";
import type { IslandDef, XZ } from "../../shared/island/types.js";
import type { WorldQuery } from "../../shared/sim/context.js";
import type { CoverCircle } from "../../shared/sim/cover.js";
import type { Vec3Like } from "../../shared/types.js";

/** Nav grid cell size (meters), §19. */
export const NAV_CELL = 2;
/** Water shallower than this is wadeable (the feet stay above the swim depth). */
export const WADE_DEPTH = SWIM_DEPTH - 0.05;
/** Segment sampling step = stepPlayer's sub-step. */
export const SAMPLE_STEP = 0.25;
/** Player radius plus a little air (bots shouldn't scrape trunks). */
export const CLEARANCE = PLAYER_RADIUS + 0.08;
/** Rise per sample treated as a cliff. */
export const CLIFF_RISE = STEP_MAX - 0.08;
/** Rising terrain steeper than this is a wall. */
export const WALL_NORMAL_Y = MAX_WALK_NORMAL_Y + 0.03;

const scratchNormal: Vec3Like = { x: 0, y: 1, z: 0 };
const circles: CoverCircle[] = [];

/** 8 neighbour offsets: 4 orthogonal, then 4 diagonal. */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Sample offsets inside a cell (fractions of the cell size) tried in order for the waypoint. */
const CELL_SAMPLES: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.3, 0],
  [-0.3, 0],
  [0, 0.3],
  [0, -0.3],
  [0.3, 0.3],
  [-0.3, 0.3],
  [0.3, -0.3],
  [-0.3, -0.3],
];

function inBounds(q: WorldQuery, x: number, z: number): boolean {
  const b = q.bounds;
  return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

function hitsCircle(list: CoverCircle[], n: number, x: number, z: number, clearance: number): boolean {
  for (let k = 0; k < n; k++) {
    const c = list[k]!;
    const dx = x - c.x;
    const dz = z - c.z;
    const rr = c.r + clearance;
    if (dx * dx + dz * dz < rr * rr) return true;
  }
  return false;
}

/** Terrain at (x, z) a player can stand or wade on (inside the bounds, not deep water, not a wall). Cover ignored. */
export function groundWalkable(q: WorldQuery, x: number, z: number): boolean {
  if (!inBounds(q, x, z)) return false;
  const h = heightAt(q.terrain, x, z);
  if (WATER_Y - h > WADE_DEPTH) return false;
  return normalAt(q.terrain, x, z, scratchNormal).y >= MAX_WALK_NORMAL_Y;
}

/** groundWalkable and clear of cover by `clearance`. */
export function pointWalkable(q: WorldQuery, x: number, z: number, clearance = CLEARANCE): boolean {
  if (!groundWalkable(q, x, z)) return false;
  const n = q.cover.query(x, z, clearance, circles);
  return !hitsCircle(circles, n, x, z, clearance);
}

/**
 * A player could walk the straight segment a → b: every 0.25 m sample is inside the bounds, not deep water,
 * not a cliff step or a rising wall, and clear of cover by `clearance`. The start point itself is not tested.
 */
export function segmentClear(q: WorldQuery, ax: number, az: number, bx: number, bz: number, clearance = CLEARANCE): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-6) return true;
  const n = Math.max(1, Math.ceil(len / SAMPLE_STEP));
  const step = len / n;
  const count = q.cover.query((ax + bx) * 0.5, (az + bz) * 0.5, len * 0.5 + clearance, circles);
  let prev = heightAt(q.terrain, ax, az);
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const x = ax + dx * t;
    const z = az + dz * t;
    if (!inBounds(q, x, z)) return false;
    const h = heightAt(q.terrain, x, z);
    const rise = h - prev;
    if (rise > (CLIFF_RISE * step) / SAMPLE_STEP) return false;
    if (rise > 0.01 && normalAt(q.terrain, x, z, scratchNormal).y < WALL_NORMAL_Y) return false;
    if (WATER_Y - h > WADE_DEPTH) return false;
    if (hitsCircle(circles, count, x, z, clearance)) return false;
    prev = h;
  }
  return true;
}

/** Coarse walkability grid with lazily checked edges (see the file header). */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly originX: number;
  readonly originZ: number;
  /** 1 = walkable. */
  readonly walk: Uint8Array;
  /** Waypoint (a walkable sample) per cell. */
  readonly wx: Float32Array;
  readonly wz: Float32Array;
  /** Edge cache per cell × 8 directions: 0 unknown, 1 open, 2 blocked. */
  private readonly edges: Uint8Array;

  constructor(
    readonly q: WorldQuery,
    readonly cell = NAV_CELL,
  ) {
    const b = q.bounds;
    this.cols = Math.max(1, Math.floor((b.maxX - b.minX) / cell));
    this.rows = Math.max(1, Math.floor((b.maxZ - b.minZ) / cell));
    this.originX = b.minX;
    this.originZ = b.minZ;
    const n = this.cols * this.rows;
    this.walk = new Uint8Array(n);
    this.wx = new Float32Array(n);
    this.wz = new Float32Array(n);
    this.edges = new Uint8Array(n * 8);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        const cx = this.originX + (c + 0.5) * cell;
        const cz = this.originZ + (r + 0.5) * cell;
        const count = q.cover.query(cx, cz, cell * 0.75 + CLEARANCE, circles);
        for (const [ox, oz] of CELL_SAMPLES) {
          const x = cx + ox * cell;
          const z = cz + oz * cell;
          if (!groundWalkable(q, x, z) || hitsCircle(circles, count, x, z, CLEARANCE)) continue;
          this.walk[i] = 1;
          this.wx[i] = x;
          this.wz[i] = z;
          break;
        }
      }
    }
  }

  /** Cell index containing (x, z), or -1 outside the grid. */
  cellOf(x: number, z: number): number {
    const c = Math.floor((x - this.originX) / this.cell);
    const r = Math.floor((z - this.originZ) / this.cell);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  /** Nearest walkable cell to (x, z) within `maxRing` rings, -1 when none. */
  nearestWalkable(x: number, z: number, maxRing = 4): number {
    const c0 = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.originX) / this.cell)));
    const r0 = Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.originZ) / this.cell)));
    let best = -1;
    let bestD = Infinity;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let r = r0 - ring; r <= r0 + ring; r++) {
        for (let c = c0 - ring; c <= c0 + ring; c++) {
          if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== ring) continue;
          if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
          const i = r * this.cols + c;
          if (!this.walk[i]) continue;
          const dx = this.wx[i]! - x;
          const dz = this.wz[i]! - z;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Neighbour of cell `i` in direction `d` (0..7), -1 outside. */
  neighbor(i: number, d: number): number {
    const [dc, dr] = DIRS[d]!;
    const c = (i % this.cols) + dc;
    const r = Math.floor(i / this.cols) + dr;
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  /** Can a player walk from cell `i` to its neighbour in direction `d`? (Cached.) */
  edgeOpen(i: number, d: number): boolean {
    const k = i * 8 + d;
    const known = this.edges[k]!;
    if (known !== 0) return known === 1;
    const j = this.neighbor(i, d);
    let open = j >= 0 && this.walk[i] === 1 && this.walk[j] === 1;
    if (open && d >= 4) {
      // No corner cutting: both orthogonal cells must be walkable.
      const [dc, dr] = DIRS[d]!;
      const a = this.neighbor(i, dc > 0 ? 0 : 1);
      const b = this.neighbor(i, dr > 0 ? 2 : 3);
      open = a >= 0 && b >= 0 && this.walk[a] === 1 && this.walk[b] === 1;
    }
    if (open) open = segmentClear(this.q, this.wx[i]!, this.wz[i]!, this.wx[j]!, this.wz[j]!);
    // Cached for this direction only: a cliff can be walked down but not up.
    this.edges[k] = open ? 1 : 2;
    return open;
  }

  /** Coarse check: every cell along the segment is walkable (cheap pre-test before a BFS). */
  lineWalkable(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    const n = Math.max(1, Math.ceil(len / (this.cell * 0.5)));
    for (let k = 1; k < n; k++) {
      const i = this.cellOf(ax + (dx * k) / n, az + (dz * k) / n);
      if (i < 0 || !this.walk[i]) return false;
    }
    return true;
  }

  /**
   * Breadth-first path from `from` to `to` as string-pulled waypoints (the last one is `to` itself when it can
   * be reached). When `to` is unreachable the path ends at the reachable cell closest to it. Null when the
   * start has no walkable cell nearby.
   */
  findPath(from: XZ, to: XZ): XZ[] | null {
    const start = this.nearestWalkable(from.x, from.z);
    const goal = this.nearestWalkable(to.x, to.z, 6);
    if (start < 0) return null;
    const n = this.cols * this.rows;
    const prev = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    prev[start] = start;
    let best = start;
    let bestD = Infinity;
    while (head < tail) {
      const i = queue[head++]!;
      const dx = this.wx[i]! - to.x;
      const dz = this.wz[i]! - to.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
      if (i === goal) break;
      for (let dir = 0; dir < 8; dir++) {
        const j = this.neighbor(i, dir);
        if (j < 0 || prev[j] !== -1 || !this.walk[j]) continue;
        if (!this.edgeOpen(i, dir)) continue;
        prev[j] = i;
        queue[tail++] = j;
      }
    }
    const end = goal >= 0 && prev[goal] !== -1 ? goal : best;
    const cells: number[] = [];
    for (let i = end; i !== start; i = prev[i]!) cells.push(i);
    cells.reverse();
    const pts: XZ[] = cells.map((i) => ({ x: this.wx[i]!, z: this.wz[i]! }));
    if (end === goal) {
      const last = pts.length ? pts[pts.length - 1]! : { x: this.wx[start]!, z: this.wz[start]! };
      if (segmentClear(this.q, last.x, last.z, to.x, to.z)) pts.push({ x: to.x, z: to.z });
    }
    if (!pts.length) pts.push({ x: this.wx[start]!, z: this.wz[start]! });
    return smoothPath(this.q, from, pts);
  }
}

/** Greedy string pulling: from each point jump to the farthest of the next few waypoints in a straight clear line. */
export function smoothPath(q: WorldQuery, from: XZ, pts: XZ[]): XZ[] {
  const out: XZ[] = [];
  let px = from.x;
  let pz = from.z;
  let i = 0;
  while (i < pts.length) {
    let k = Math.min(pts.length - 1, i + 10);
    while (k > i && !segmentClear(q, px, pz, pts[k]!.x, pts[k]!.z)) k--;
    out.push(pts[k]!);
    px = pts[k]!.x;
    pz = pts[k]!.z;
    i = k + 1;
  }
  return out;
}

/* ------------------------------------------------------------------ caches */

const navCache = new WeakMap<IslandDef, NavGrid>();
const standCache = new WeakMap<IslandDef, (XZ | null)[]>();

/** The (cached) nav grid of an island. */
export function navFor(island: IslandDef, q: WorldQuery): NavGrid {
  let nav = navCache.get(island);
  if (!nav) {
    nav = new NavGrid(q);
    navCache.set(island, nav);
  }
  return nav;
}

/**
 * Where to stand on the shore to cast at a fish spot: the closest walkable, cover-free land point (scanning 16
 * directions outward from the spot) whose eye is within FISH_CAST_RANGE − 2 m of the spot. Null when none.
 */
export function fishStandFor(q: WorldQuery, spot: XZ): XZ | null {
  let best: XZ | null = null;
  let bestD = Infinity;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    for (let t = 1; t <= FISH_CAST_RANGE; t += 0.5) {
      const x = spot.x + ux * t;
      const z = spot.z + uz * t;
      if (!inBounds(q, x, z)) break;
      if (heightAt(q.terrain, x, z) < WATER_Y + 0.05) continue;
      // First dry point on this ray: step a little inland so the bot isn't standing in the surf.
      for (const extra of [0.8, 0.4, 0]) {
        const sx = x + ux * extra;
        const sz = z + uz * extra;
        if (!pointWalkable(q, sx, sz)) continue;
        const eyeY = heightAt(q.terrain, sx, sz) + EYE_HEIGHT;
        const d = Math.sqrt((sx - spot.x) ** 2 + (sz - spot.z) ** 2 + (eyeY - WATER_Y) ** 2);
        if (d > FISH_CAST_RANGE - 2) continue;
        if (d < bestD) {
          bestD = d;
          best = { x: sx, z: sz };
        }
        break;
      }
      break;
    }
  }
  return best;
}

/** Fish-spot stand points of an island (cached), index-aligned with island.fishSpots. */
export function fishStandsFor(island: IslandDef, q: WorldQuery): (XZ | null)[] {
  let stands = standCache.get(island);
  if (!stands) {
    stands = island.fishSpots.map((f) => fishStandFor(q, f));
    standCache.set(island, stands);
  }
  return stands;
}

/** Nearest walkable point to (x, z) on a small spiral (for stand points next to sites). */
export function nearestStandable(q: WorldQuery, x: number, z: number, maxR = 3): XZ {
  if (pointWalkable(q, x, z)) return { x, z };
  for (let r = 0.5; r <= maxR; r += 0.5) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const sx = x + Math.cos(a) * r;
      const sz = z + Math.sin(a) * r;
      if (pointWalkable(q, sx, sz)) return { x: sx, z: sz };
    }
  }
  return { x, z };
}
