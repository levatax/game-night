// Local steering for helper bots (§19 "Botlar": 1.5 m probe, ±30/60/90/135° sweep, 10-tick hysteresis, stuck
// detector → jump + random direction, BFS fallback on the 2 m nav grid). Owner: server-bots.
//
// steer() is a pure function of the world query, the bot's position, the target and a small per-bot memory
// it updates in place (no allocation on the common path). It answers "which way do I walk this tick":
//   1. Arrived (within target.r) → stand still.
//   2. Escaping after a stuck detection → keep the escape heading (jump on its first tick).
//   3. Following a BFS path (planned when the straight line crosses unwalkable cells, after repeated stuck
//      detections or when the distance stops shrinking) → the current waypoint becomes the local goal.
//   4. Probe 1.5 m ahead toward the local goal; when blocked, sweep ±30/60/90/135° (preferring the side chosen
//      last time) and hold a deflection for 10 ticks so the bot doesn't jitter along walls.
// The output is a world-space direction plus the camera-relative move for facing that way; the motor may
// face elsewhere (aiming, looking at a node) and re-project the direction (moveFor()).

import { STEP_MAX, WATER_Y } from "../../shared/constants.js";
import { heightAt, normalAt } from "../../shared/island/heightfield.js";
import type { XZ } from "../../shared/island/types.js";
import type { WorldQuery } from "../../shared/sim/context.js";
import type { CoverCircle } from "../../shared/sim/cover.js";
import { yawFromDir } from "../../shared/sim/math.js";
import type { Vec3Like } from "../../shared/types.js";
import { CLEARANCE, CLIFF_RISE, SAMPLE_STEP, WADE_DEPTH, WALL_NORMAL_Y, segmentClear, type NavGrid } from "./botNav.js";

/** Forward probe length (meters), §19. */
export const PROBE_DIST = 1.5;
/** Sweep deflections (degrees), §19. */
export const SWEEP_DEG: ReadonlyArray<number> = [30, 60, 90, 135];
/** A chosen deflection is kept this many ticks while it stays clear, §19. */
export const HYSTERESIS_TICKS = 10;
/** No more than STUCK_MIN_MOVE of movement in this many ticks while trying to walk = stuck. */
export const STUCK_WINDOW_TICKS = 40;
export const STUCK_MIN_MOVE = 0.35;
/** Escape burst after a stuck detection (jump on the first tick). */
export const ESCAPE_TICKS = 14;
/** The distance to the target hasn't shrunk by NO_PROGRESS_GAIN in this many ticks (orbiting) → plan a path. */
export const NO_PROGRESS_TICKS = 150;
export const NO_PROGRESS_GAIN = 0.75;
/** Waypoint reached within this distance. */
export const WAYPOINT_RADIUS = 0.9;
/** The target moved this far: forget the hold / path / stuck counters. */
const RETARGET_DIST = 1.5;

/** Terrain + cover (+ the optional nav grid for BFS fallbacks). */
export interface SteerWorld extends WorldQuery {
  nav: NavGrid | null;
}

export interface SteerPos {
  x: number;
  z: number;
  /** Current facing (used when standing still). */
  yaw: number;
}

export interface SteerTarget {
  x: number;
  z: number;
  /** Stop within this distance. */
  r: number;
}

export interface SteerOutput {
  /** Camera-relative move for facing `yaw` (strafe right / forward). */
  moveX: number;
  moveZ: number;
  /** Facing along the chosen direction (or the current yaw when standing still). */
  yaw: number;
  jump: boolean;
  /** Chosen world direction (unit, 0 when standing still) and speed fraction 0..1. */
  dirX: number;
  dirZ: number;
  speed: number;
  arrived: boolean;
  /** Escaping after a stuck detection this tick. */
  stuck: boolean;
  /** Distance to the target. */
  dist: number;
}

/** Per-bot steering memory (mutated by steer()). */
export interface SteerMemory {
  /** Ticks seen (the memory's own clock). */
  ticks: number;
  targetX: number;
  targetZ: number;
  hasTarget: boolean;
  /** Held deflection (radians, relative to the direct heading) and ticks left. */
  holdAngle: number;
  holdTicks: number;
  /** Preferred sweep side (+1 left, -1 right). */
  side: number;
  /** Stuck detector: last position that counted as movement. */
  anchorX: number;
  anchorZ: number;
  anchorTick: number;
  escapeTicks: number;
  escapeX: number;
  escapeZ: number;
  stuckCount: number;
  /** Progress detector. */
  bestDist: number;
  bestTick: number;
  /** BFS path toward the current target (null = steer directly). */
  path: XZ[] | null;
  pathIndex: number;
  /** Ask for a path on the next call (set by the detectors). */
  wantPath: boolean;
}

export function newSteerMemory(): SteerMemory {
  return {
    ticks: 0,
    targetX: 0,
    targetZ: 0,
    hasTarget: false,
    holdAngle: 0,
    holdTicks: 0,
    side: 1,
    anchorX: 0,
    anchorZ: 0,
    anchorTick: 0,
    escapeTicks: 0,
    escapeX: 0,
    escapeZ: 0,
    stuckCount: 0,
    bestDist: Infinity,
    bestTick: 0,
    path: null,
    pathIndex: 0,
    wantPath: false,
  };
}

/** Forget the current target (a new goal starts). */
export function resetSteerMemory(m: SteerMemory): void {
  const side = m.side;
  Object.assign(m, newSteerMemory());
  m.side = side;
}

/** Camera-relative move that walks along world direction (dirX, dirZ) × speed while facing `yaw`. */
export function moveFor(dirX: number, dirZ: number, speed: number, yaw: number): { moveX: number; moveZ: number } {
  // forward = (-sin, -cos), right = (cos, -sin) (shared/sim/math.ts).
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return { moveX: (dirX * c - dirZ * s) * speed, moveZ: (-dirX * s - dirZ * c) * speed };
}

const local: CoverCircle[] = [];
const scratchNormal: Vec3Like = { x: 0, y: 1, z: 0 };

/** Fallback randomness when the caller passes none (deterministic). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const defaultRng = lcg(0x5eed);

/**
 * Is a straight walk of `dist` meters from (x, z) along the unit (dx, dz) free of cliffs, walls, deep water,
 * cover and the bounds? `circles[0..count)` are the cover circles around the start (one query per steer call).
 * Cover the bot already overlaps only blocks when the step goes deeper into it; deep water only when it gets
 * deeper than where the bot is (a swimmer may always head for the shallows).
 */
export function probeClear(
  q: WorldQuery,
  x: number,
  z: number,
  dx: number,
  dz: number,
  dist: number,
  circles: CoverCircle[],
  count: number,
): boolean {
  const b = q.bounds;
  const h0 = heightAt(q.terrain, x, z);
  const depth0 = WATER_Y - h0;
  let prev = h0;
  const n = Math.max(1, Math.ceil(dist / SAMPLE_STEP));
  const step = dist / n;
  for (let k = 1; k <= n; k++) {
    const t = k * step;
    const px = x + dx * t;
    const pz = z + dz * t;
    if (px < b.minX || px > b.maxX || pz < b.minZ || pz > b.maxZ) return false;
    const h = heightAt(q.terrain, px, pz);
    const rise = h - prev;
    if (rise > (CLIFF_RISE * step) / SAMPLE_STEP) return false;
    if (rise > 0.01 && normalAt(q.terrain, px, pz, scratchNormal).y < WALL_NORMAL_Y) return false;
    const depth = WATER_Y - h;
    if (depth > WADE_DEPTH && depth > depth0 + 0.05) return false;
    for (let c = 0; c < count; c++) {
      const cc = circles[c]!;
      const ox = px - cc.x;
      const oz = pz - cc.z;
      const rr = cc.r + CLEARANCE;
      const d2 = ox * ox + oz * oz;
      if (d2 >= rr * rr) continue;
      // Already inside this circle's clearance at the start: only block when moving closer.
      const sx = x - cc.x;
      const sz = z - cc.z;
      if (sx * sx + sz * sz < rr * rr && d2 >= sx * sx + sz * sz) continue;
      return false;
    }
    prev = h;
  }
  return true;
}

function rotate(dx: number, dz: number, angle: number): [number, number] {
  // Same sense as yaw: positive turns left (shared/sim/math.ts rotateY).
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [dx * c + dz * s, -dx * s + dz * c];
}

function retarget(m: SteerMemory, target: SteerTarget, x: number, z: number): void {
  if (!m.hasTarget) {
    // The stuck anchor is about OUR movement: a drifting target (a walking teammate) must not reset it.
    m.anchorX = x;
    m.anchorZ = z;
    m.anchorTick = m.ticks;
  }
  m.targetX = target.x;
  m.targetZ = target.z;
  m.hasTarget = true;
  m.holdTicks = 0;
  m.holdAngle = 0;
  m.stuckCount = 0;
  m.bestDist = Infinity;
  m.bestTick = m.ticks;
  m.path = null;
  m.pathIndex = 0;
  m.wantPath = false;
}

function planPath(world: SteerWorld, pos: SteerPos, target: SteerTarget, m: SteerMemory): void {
  m.wantPath = false;
  if (!world.nav) return;
  const path = world.nav.findPath(pos, target);
  m.path = path && path.length ? path : null;
  m.pathIndex = 0;
}

/**
 * Which way to walk this tick toward `target` (see the file header). Updates `mem` in place. `rng` picks the
 * escape heading after a stuck detection.
 */
export function steer(world: SteerWorld, pos: SteerPos, target: SteerTarget, mem: SteerMemory, rng: () => number = defaultRng): SteerOutput {
  mem.ticks++;
  const out: SteerOutput = { moveX: 0, moveZ: 0, yaw: pos.yaw, jump: false, dirX: 0, dirZ: 0, speed: 0, arrived: false, stuck: false, dist: 0 };
  if (!mem.hasTarget || Math.hypot(target.x - mem.targetX, target.z - mem.targetZ) > RETARGET_DIST) {
    retarget(mem, target, pos.x, pos.z);
    // A long walk whose straight line crosses unwalkable cells starts on a BFS path right away.
    if (world.nav && Math.hypot(target.x - pos.x, target.z - pos.z) > 6 && !world.nav.lineWalkable(pos.x, pos.z, target.x, target.z)) {
      mem.wantPath = true;
    }
  }
  const tdx = target.x - pos.x;
  const tdz = target.z - pos.z;
  const dist = Math.sqrt(tdx * tdx + tdz * tdz);
  out.dist = dist;
  if (dist <= target.r) {
    out.arrived = true;
    mem.anchorX = pos.x;
    mem.anchorZ = pos.z;
    mem.anchorTick = mem.ticks;
    mem.escapeTicks = 0;
    return out;
  }

  // ------------------------------------------------------------ detectors
  if (Math.hypot(pos.x - mem.anchorX, pos.z - mem.anchorZ) > STUCK_MIN_MOVE) {
    mem.anchorX = pos.x;
    mem.anchorZ = pos.z;
    mem.anchorTick = mem.ticks;
  } else if (mem.escapeTicks === 0 && mem.ticks - mem.anchorTick >= STUCK_WINDOW_TICKS) {
    mem.stuckCount++;
    mem.anchorTick = mem.ticks;
    mem.escapeTicks = ESCAPE_TICKS;
    const a = rng() * Math.PI * 2;
    mem.escapeX = Math.cos(a);
    mem.escapeZ = Math.sin(a);
    mem.holdTicks = 0;
    mem.side = -mem.side;
    if (mem.stuckCount >= 2) mem.wantPath = true;
    out.jump = true;
  }
  if (dist < mem.bestDist - NO_PROGRESS_GAIN) {
    mem.bestDist = dist;
    mem.bestTick = mem.ticks;
  } else if (mem.ticks - mem.bestTick >= NO_PROGRESS_TICKS) {
    mem.bestDist = dist;
    mem.bestTick = mem.ticks;
    mem.wantPath = true;
  }

  // --------------------------------------------------------------- escape
  if (mem.escapeTicks > 0) {
    mem.escapeTicks--;
    out.stuck = true;
    out.dirX = mem.escapeX;
    out.dirZ = mem.escapeZ;
    out.speed = 1;
    out.yaw = yawFromDir(out.dirX, out.dirZ);
    out.moveZ = 1;
    return out;
  }

  // ---------------------------------------------------------- local goal
  if (mem.wantPath) planPath(world, pos, target, mem);
  let gx = target.x;
  let gz = target.z;
  if (mem.path) {
    const path = mem.path;
    // Skip waypoints we reached or can already see past.
    while (mem.pathIndex < path.length) {
      const w = path[mem.pathIndex]!;
      if (Math.hypot(w.x - pos.x, w.z - pos.z) < WAYPOINT_RADIUS) {
        mem.pathIndex++;
        continue;
      }
      if ((mem.ticks & 7) === 0 && mem.pathIndex + 1 < path.length) {
        const nx = path[mem.pathIndex + 1]!;
        if (segmentClear(world, pos.x, pos.z, nx.x, nx.z)) {
          mem.pathIndex++;
          continue;
        }
      }
      break;
    }
    if (mem.pathIndex >= path.length) {
      mem.path = null;
    } else {
      gx = path[mem.pathIndex]!.x;
      gz = path[mem.pathIndex]!.z;
    }
  }
  let dx = gx - pos.x;
  let dz = gz - pos.z;
  const gl = Math.sqrt(dx * dx + dz * dz);
  if (gl < 1e-6) {
    dx = tdx / dist;
    dz = tdz / dist;
  } else {
    dx /= gl;
    dz /= gl;
  }

  // ---------------------------------------------------------------- sweep
  const probe = Math.min(PROBE_DIST, Math.max(0.5, (mem.path ? gl : dist) + 0.25));
  const count = world.cover.query(pos.x, pos.z, PROBE_DIST + CLEARANCE + 0.25, local);
  let chosen: number | null = null;
  if (mem.holdTicks > 0) {
    const [hx, hz] = rotate(dx, dz, mem.holdAngle);
    if (probeClear(world, pos.x, pos.z, hx, hz, probe, local, count)) {
      chosen = mem.holdAngle;
      mem.holdTicks--;
    } else {
      mem.holdTicks = 0;
    }
  }
  if (chosen === null) {
    if (probeClear(world, pos.x, pos.z, dx, dz, probe, local, count)) chosen = 0;
    else {
      // The whole preferred side first (30 → 135°), then the other: a bot following a wall keeps following it
      // (peeling away from it at 135° when the target bearing drifts into the wall) instead of flip-flopping.
      for (const sign of [mem.side, -mem.side]) {
        for (const deg of SWEEP_DEG) {
          const a = (deg * Math.PI) / 180;
          const [sx, sz] = rotate(dx, dz, a * sign);
          if (probeClear(world, pos.x, pos.z, sx, sz, PROBE_DIST, local, count)) {
            chosen = a * sign;
            break;
          }
        }
        if (chosen !== null) break;
      }
      if (chosen !== null) {
        mem.holdAngle = chosen;
        mem.holdTicks = HYSTERESIS_TICKS;
        mem.side = chosen > 0 ? 1 : -1;
      }
    }
  }
  let dirX: number;
  let dirZ: number;
  if (chosen === null) {
    // Boxed in: back off the way we came; the stuck detector takes over if that fails too.
    dirX = -dx;
    dirZ = -dz;
  } else {
    [dirX, dirZ] = rotate(dx, dz, chosen);
  }

  // Ease in near the target so the bot doesn't overshoot and circle.
  const speed = Math.min(1, Math.max(0.35, (dist - target.r) / 1.2 + 0.35));
  out.dirX = dirX;
  out.dirZ = dirZ;
  out.speed = speed;
  out.yaw = yawFromDir(dirX, dirZ);
  out.moveZ = speed;
  // Hop small ledges just below the cliff limit when a step ahead rises (cheap: one sample).
  const ahead = heightAt(world.terrain, pos.x + dirX * 0.5, pos.z + dirZ * 0.5) - heightAt(world.terrain, pos.x, pos.z);
  if (ahead > STEP_MAX * 0.8 && ahead < STEP_MAX * 2) out.jump = true;
  return out;
}
