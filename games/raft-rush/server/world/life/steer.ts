// Monster locomotion on the island heightfield. Owner: server-world-life.
//
// walk(): one tick of ground movement toward a goal point —
//   1. steering: a forward probe (PROBE_DIST + radius, sampled at half and full length) checks bounds, depth
//      (no deep water), grade (CLIMB_GRADE), cover (trunks / rocks / wreck / chest / collectors — fences only when
//      the walker doesn't push into them) and, for night monsters, light rings (PROBE_LIGHT_PAD); blocked →
//      sweep ±30/60/90/135°, preferred side first (hysteresis memory in the brain); all blocked → stand;
//      stuck detector → a random detour for DETOUR_TICKS;
//   2. integrate own motion + knockback + separation push;
//   3. hard constraints in order: bounds, terrain (depth / grade, axis slide), cover push-out (fence contact is
//      reported), and last the light rule (util.lightMoveOk: never one step deeper into a ring; tangent slide,
//      else stay). The light rule is checked last, so nothing (push-out, knockback, separation) can carry a
//      night monster into a light ring.
// fly(): gulls — straight 3D flight, bounds only.

import { DT } from "../../../shared/constants.js";
import type { CoverCircle } from "../../../shared/sim/cover.js";
import { lerpAngle, yawFromDir } from "../../../shared/sim/math.js";
import type { MonsterState } from "../context.js";
import type { MonsterBrain } from "./brain.js";
import type { LifeEnv } from "./env.js";
import {
  CLIMB_GRADE,
  DETOUR_TICKS,
  KNOCK_DECAY,
  LIGHT_PAD,
  PROBE_DIST,
  PROBE_LIGHT_PAD,
  STEER_HYSTERESIS_TICKS,
  STUCK_EPS,
  STUCK_TICKS,
  SWEEP_DEG,
  TURN_RATE,
} from "./tuning.js";
import { d2, dist2, inRings, lightMoveOk, ringAt } from "./util.js";

export interface WalkSpec {
  radius: number;
  height: number;
  /** m/s for this tick (already multiplied by modes / light slow). */
  speed: number;
  /** Night monsters never enter light rings (the boss passes false and is slowed instead). */
  avoidLight: boolean;
  /** Lowest terrain the walker steps onto. */
  minY: number;
  /** Fences are walked into, not around (crabs gnaw, puffers snag, the boss smashes). */
  pushFences: boolean;
  /** Only campfire rings count for avoidLight (a raft-bound crab walks through torch light, Long Tide §3.3). */
  fireOnly?: boolean;
}

export interface WalkResult {
  /** Distance actually moved this tick. */
  moved: number;
  /** Within `arrive` of the goal. */
  arrived: boolean;
  /** Fence post touched this tick (only with pushFences). */
  fence: CoverCircle | null;
}

/** A fence post closer than this (gap between the circles) counts as touched. */
const FENCE_TOUCH = 0.08;

const SWEEP: ReadonlyArray<{ c: number; s: number; deg: number }> = SWEEP_DEG.map((deg) => ({
  deg,
  c: Math.cos((deg * Math.PI) / 180),
  s: Math.sin((deg * Math.PI) / 180),
}));

/** One tick of ground movement toward (gx, gz). Mutates m (x, y, z, yaw) and the brain's steering memory. */
export function walk(env: LifeEnv, m: MonsterState, b: MonsterBrain, spec: WalkSpec, gx: number, gz: number, arrive: number): WalkResult {
  if (!spec.fireOnly || !spec.avoidLight) return walkIn(env, m, b, spec, gx, gz, arrive);
  // Torch rings don't count for this walker: steer against the campfire rings only.
  const rings = env.rings;
  env.rings = env.fireRings;
  try {
    return walkIn(env, m, b, spec, gx, gz, arrive);
  } finally {
    env.rings = rings;
  }
}

function walkIn(env: LifeEnv, m: MonsterState, b: MonsterBrain, spec: WalkSpec, gx: number, gz: number, arrive: number): WalkResult {
  const ox = m.x;
  const oz = m.z;
  const toGoal = dist2(ox, oz, gx, gz);
  const arrived = toGoal <= arrive;
  let ux = 0;
  let uz = 0;
  if (!arrived && spec.speed > 0) {
    const dir = chooseDirection(env, m, b, spec, (gx - ox) / toGoal, (gz - oz) / toGoal, Math.min(PROBE_DIST + spec.radius, toGoal + spec.radius));
    if (dir) {
      ux = dir.x;
      uz = dir.z;
    }
  }
  const own = arrived ? 0 : Math.min(spec.speed * DT, Math.max(0, toGoal - arrive * 0.5));
  let nx = ox + ux * own + b.kvx * DT + b.px;
  let nz = oz + uz * own + b.kvz * DT + b.pz;
  b.kvx *= KNOCK_DECAY;
  b.kvz *= KNOCK_DECAY;
  if (Math.abs(b.kvx) < 0.05) b.kvx = 0;
  if (Math.abs(b.kvz) < 0.05) b.kvz = 0;
  b.px = 0;
  b.pz = 0;

  // Bounds.
  const bd = env.ctx.island.bounds;
  nx = Math.max(bd.minX, Math.min(bd.maxX, nx));
  nz = Math.max(bd.minZ, Math.min(bd.maxZ, nz));

  // Terrain: depth and grade (slide along one axis when the diagonal is refused).
  if (!terrainOk(env, spec, ox, oz, nx, nz)) {
    if (terrainOk(env, spec, ox, oz, nx, oz)) nz = oz;
    else if (terrainOk(env, spec, ox, oz, ox, nz)) nx = ox;
    else {
      nx = ox;
      nz = oz;
    }
  }

  // Cover push-out (two passes resolve corners between neighbouring circles).
  for (let pass = 0; pass < 2; pass++) {
    const circles = env.cover(nx, nz, spec.radius);
    let pushed = false;
    for (const c of circles) {
      if (c.top < m.y || c.bottom > m.y + spec.height) continue;
      const rr = c.r + spec.radius;
      const dd = d2(nx, nz, c.x, c.z);
      if (dd >= rr * rr) continue;
      // Push out along center → point (or center → old position when the point sits on the center).
      let ex = nx - c.x;
      let ez = nz - c.z;
      if (ex * ex + ez * ez < 1e-12) {
        ex = ox - c.x;
        ez = oz - c.z;
      }
      let el = Math.hypot(ex, ez);
      if (el < 1e-6) {
        ex = 1;
        ez = 0;
        el = 1;
      }
      nx = c.x + (ex / el) * (rr + 1e-3);
      nz = c.z + (ez / el) * (rr + 1e-3);
      pushed = true;
    }
    if (!pushed) break;
  }

  // Light rule last.
  if (spec.avoidLight && !lightMoveOk(env.rings, ox, oz, nx, nz, LIGHT_PAD)) {
    const slid = tangentSlide(env, ox, oz, nx, nz);
    if (slid && lightMoveOk(env.rings, ox, oz, slid.x, slid.z, LIGHT_PAD) && terrainOk(env, spec, ox, oz, slid.x, slid.z)) {
      nx = slid.x;
      nz = slid.z;
    } else {
      nx = ox;
      nz = oz;
    }
  }

  // Fence contact (touching counts, so a walker standing still while gnawing keeps reporting it).
  let fence: CoverCircle | null = null;
  if (spec.pushFences) {
    let best = Infinity;
    for (const c of env.cover(nx, nz, spec.radius + FENCE_TOUCH)) {
      if (c.kind !== "fence" || c.top < m.y || c.bottom > m.y + spec.height) continue;
      const gap = dist2(nx, nz, c.x, c.z) - c.r - spec.radius;
      if (gap < FENCE_TOUCH && gap < best) {
        best = gap;
        fence = c;
      }
    }
  }

  const moved = dist2(ox, oz, nx, nz);
  m.x = nx;
  m.z = nz;
  m.y = env.ground(nx, nz);
  if (own > 0 && (ux !== 0 || uz !== 0)) m.yaw = lerpAngle(m.yaw, yawFromDir(ux, uz), TURN_RATE);
  else if (!arrived && toGoal > 1e-3) m.yaw = lerpAngle(m.yaw, yawFromDir(gx - ox, gz - oz), TURN_RATE * 0.5);

  // Stuck detector → random detour.
  if (!arrived && spec.speed > 0 && moved < STUCK_EPS && b.kvx === 0 && b.kvz === 0) {
    if (++b.stuck >= STUCK_TICKS) {
      const a = env.ctx.rng() * Math.PI * 2;
      b.dx = Math.cos(a);
      b.dz = Math.sin(a);
      b.detour = DETOUR_TICKS;
      b.stuck = 0;
    }
  } else b.stuck = 0;
  if (b.sideTicks > 0) b.sideTicks--;
  return { moved, arrived, fence };
}

/** Face (tx, tz) without moving (biting, gnawing, waiting at a ring edge). */
export function face(m: MonsterState, tx: number, tz: number): void {
  const dx = tx - m.x;
  const dz = tz - m.z;
  if (dx * dx + dz * dz > 1e-6) m.yaw = lerpAngle(m.yaw, yawFromDir(dx, dz), TURN_RATE);
}

/** Gulls: straight flight toward (gx, gy, gz) at `speed`; returns true on arrival (horizontal + vertical). */
export function fly(env: LifeEnv, m: MonsterState, gx: number, gy: number, gz: number, speed: number): boolean {
  const dx = gx - m.x;
  const dy = gy - m.y;
  const dz = gz - m.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const step = speed * DT;
  if (d <= step) {
    m.x = gx;
    m.y = gy;
    m.z = gz;
  } else {
    m.x += (dx / d) * step;
    m.y += (dy / d) * step;
    m.z += (dz / d) * step;
  }
  const bd = env.ctx.island.bounds;
  m.x = Math.max(bd.minX, Math.min(bd.maxX, m.x));
  m.z = Math.max(bd.minZ, Math.min(bd.maxZ, m.z));
  if (dx * dx + dz * dz > 1e-6) m.yaw = lerpAngle(m.yaw, yawFromDir(dx, dz), TURN_RATE);
  return d <= step + 1e-6;
}

/* ------------------------------------------------------------- internals */

function chooseDirection(env: LifeEnv, m: MonsterState, b: MonsterBrain, spec: WalkSpec, ux: number, uz: number, len: number): { x: number; z: number } | null {
  if (b.detour > 0) {
    b.detour--;
    if (probeClear(env, m, spec, b.dx, b.dz, len)) return { x: b.dx, z: b.dz };
    b.detour = 0;
  }
  for (const a of SWEEP) {
    for (const sign of a.deg === 0 ? [1] : [b.side, -b.side]) {
      const s = a.s * sign;
      const vx = ux * a.c - uz * s;
      const vz = ux * s + uz * a.c;
      if (!probeClear(env, m, spec, vx, vz, len)) continue;
      // Remember the side we turned to: the next ticks try it first (no left/right flicker).
      if (a.deg !== 0) {
        b.side = sign;
        b.sideTicks = STEER_HYSTERESIS_TICKS;
      } else if (b.sideTicks === 0) b.side = b.phase % 2 === 0 ? 1 : -1;
      return { x: vx, z: vz };
    }
  }
  return null;
}

function probeClear(env: LifeEnv, m: MonsterState, spec: WalkSpec, ux: number, uz: number, len: number): boolean {
  const escaping = spec.avoidLight && ringAt(env.rings, m.x, m.z) !== null;
  const h0 = env.ground(m.x, m.z);
  const bd = env.ctx.island.bounds;
  for (const f of [0.5, 1]) {
    const run = len * f;
    const px = m.x + ux * run;
    const pz = m.z + uz * run;
    if (px < bd.minX || px > bd.maxX || pz < bd.minZ || pz > bd.maxZ) return false;
    const h = env.ground(px, pz);
    if (h < spec.minY && h < h0) return false;
    if ((h - h0) / Math.max(run, 1e-3) > CLIMB_GRADE) return false;
    for (const c of env.cover(px, pz, spec.radius * 0.9)) {
      if (c.top < m.y || c.bottom > m.y + spec.height) continue;
      if (c.kind === "fence" && spec.pushFences) continue;
      return false;
    }
    if (spec.avoidLight && !escaping && inRings(env.rings, px, pz, PROBE_LIGHT_PAD)) return false;
  }
  return true;
}

function terrainOk(env: LifeEnv, spec: WalkSpec, ox: number, oz: number, nx: number, nz: number): boolean {
  if (nx === ox && nz === oz) return true;
  const h0 = env.ground(ox, oz);
  const h1 = env.ground(nx, nz);
  if (h1 < spec.minY && h1 < h0) return false;
  const run = dist2(ox, oz, nx, nz);
  return run < 1e-6 || (h1 - h0) / run <= CLIMB_GRADE;
}

/** Drop the inward component of the move relative to the ring the new point would enter. */
function tangentSlide(env: LifeEnv, ox: number, oz: number, nx: number, nz: number): { x: number; z: number } | null {
  let ring = null;
  let best = Infinity;
  for (const r of env.rings) {
    const d = dist2(nx, nz, r.x, r.z) - r.r;
    if (d < best) {
      best = d;
      ring = r;
    }
  }
  if (!ring) return null;
  const ex = ox - ring.x;
  const ez = oz - ring.z;
  const el = Math.hypot(ex, ez);
  if (el < 1e-6) return null;
  const nxu = ex / el;
  const nzu = ez / el;
  const mx = nx - ox;
  const mz = nz - oz;
  const inward = mx * nxu + mz * nzu;
  if (inward >= 0) return null;
  return { x: ox + mx - inward * nxu, z: oz + mz - inward * nzu };
}
