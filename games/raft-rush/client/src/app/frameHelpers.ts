// Small, allocation-light helpers for the per-frame game loop: what the crosshair points at (terrain / water,
// fish spots, palms), the sea proximity, pooled light lists, the ping board, the phase hint and the "ride the
// raft" offset during the launch cinematic. Owner: client-app.

import {
  FISH_CAST_RANGE,
  FISH_SPOT_RADIUS,
  INTERACT_CONE_COS,
  MARKER_TICKS,
  PALM_HIT_RANGE,
  TICK_MS,
  WATER_Y,
} from "../../../shared/constants";
import { heightAt, raycastTerrain } from "../../../shared/island/heightfield";
import type { IslandDef, NodeDef, XZ } from "../../../shared/island/types";
import type { MarkerEvent } from "../../../shared/protocol";
import type { ArrayView, ItemKind, MarkerKind, Phase, Vec3Like } from "../../../shared/types";
import type { LightSource } from "../render/types";

/* ============================================================ aiming */

/** Crosshair rays stop at this distance (MarkerMsg.pos is clamped to 60 m). */
export const AIM_MAX_DIST = 60;

/**
 * Where a ray from `eye` along the unit `dir` first meets the terrain or the sea surface (within maxDist), into
 * `out`. Returns false (and the far point) when nothing is hit.
 */
export function crosshairHit(island: IslandDef, eye: Vec3Like, dir: Vec3Like, out: Vec3Like, maxDist = AIM_MAX_DIST): boolean {
  let t = raycastTerrain(island.grid, eye, dir, maxDist);
  if (dir.y < -1e-4 && eye.y > WATER_Y) {
    const tw = (WATER_Y - eye.y) / dir.y;
    if (tw <= maxDist && (t < 0 || tw < t)) t = tw;
  }
  const hit = t >= 0;
  const d = hit ? t : maxDist;
  out.x = eye.x + dir.x * d;
  out.y = hit ? eye.y + dir.y * d : Math.max(WATER_Y, heightAt(island.grid, eye.x + dir.x * d, eye.z + dir.z * d));
  out.z = eye.z + dir.z * d;
  return hit;
}

/**
 * The fish spot a rod cast would target from `eye` looking along `dir` (mirror of the server's aimedSpot): the
 * water hit within FISH_SPOT_RADIUS of a spot center, or the look ray passing over it; -1 when none.
 */
export function aimedFishSpot(island: IslandDef, eye: Vec3Like, dir: Vec3Like): number {
  let waterX = 0;
  let waterZ = 0;
  let water = false;
  if (dir.y < -1e-4 && eye.y > WATER_Y) {
    const t = (WATER_Y - eye.y) / dir.y;
    waterX = eye.x + dir.x * t;
    waterZ = eye.z + dir.z * t;
    water = true;
  }
  let best = -1;
  let bestScore = Infinity;
  for (const spot of island.fishSpots) {
    const vx = spot.x - eye.x;
    const vy = WATER_Y - eye.y;
    const vz = spot.z - eye.z;
    const len2 = vx * vx + vy * vy + vz * vz;
    if (len2 > FISH_CAST_RANGE * FISH_CAST_RANGE) continue;
    let score = Infinity;
    if (water) {
      const hd = Math.hypot(waterX - spot.x, waterZ - spot.z);
      if (hd <= FISH_SPOT_RADIUS) score = hd * 0.5;
    }
    const t = vx * dir.x + vy * dir.y + vz * dir.z;
    if (t > 0) {
      const perp = Math.sqrt(Math.max(0, len2 - t * t));
      if (perp <= FISH_SPOT_RADIUS && perp < score) score = perp;
    }
    if (score < bestScore) {
      bestScore = score;
      best = spot.i;
    }
  }
  return best;
}

/** The palm a LMB "use" would shake from (x, z) facing `yaw` (mirror of the server's palmInReach), or null. */
export function palmInReach(island: IslandDef, x: number, z: number, yaw: number): NodeDef | null {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  let best: NodeDef | null = null;
  let bestCos = -2;
  for (const n of island.nodes) {
    if (n.kind !== "palm") continue;
    const dx = n.x - x;
    const dz = n.z - z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > PALM_HIT_RANGE + n.radius) continue;
    const cos = d > 1e-6 ? (dx * fx + dz * fz) / d : 1;
    if (d > n.radius + 0.6 && cos < INTERACT_CONE_COS) continue;
    if (cos > bestCos) {
      best = n;
      bestCos = cos;
    }
  }
  return best;
}

/* ============================================================ the sea */

/** The sea ambience reaches full volume this close to the waterline (and fades out by SEA_FAR). */
const SEA_NEAR = 4;
const SEA_FAR = 26;

/** Distance (m) from (x, z) to the nearest shore cell of the sites (Infinity without any). */
export function shoreDistance(island: IslandDef, x: number, z: number): number {
  let best = Infinity;
  for (const site of island.sites) {
    for (const c of site.shore) {
      const d = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z);
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/** The nearest shore cell of the sites (at the sea surface) into `out`; false when the island has none. */
export function nearestShore(island: IslandDef, x: number, z: number, out: Vec3Like): boolean {
  let best = Infinity;
  for (const site of island.sites) {
    for (const c of site.shore) {
      const d = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z);
      if (d < best) {
        best = d;
        out.x = c.x;
        out.z = c.z;
      }
    }
  }
  out.y = WATER_Y;
  return Number.isFinite(best);
}

/** 0..1 sea proximity for the wave ambience: 1 at / in the water, 0 deep inland. */
export function seaProximity(island: IslandDef, x: number, z: number, y: number): number {
  if (y < WATER_Y + 0.2 || heightAt(island.grid, x, z) < WATER_Y) return 1;
  const d = shoreDistance(island, x, z);
  if (!Number.isFinite(d)) return 0.4;
  if (d <= SEA_NEAR) return 1;
  return Math.max(0, 1 - (d - SEA_NEAR) / (SEA_FAR - SEA_NEAR));
}

/* ============================================================ lights */

/** A reusable LightSource list (entries pooled, rebuilt every frame). */
export class LightBuffer {
  readonly list: LightSource[] = [];
  private readonly pool: LightSource[] = [];

  reset(): void {
    this.list.length = 0;
  }

  add(x: number, y: number, z: number, radius: number, intensity: number): void {
    const i = this.list.length;
    let l = this.pool[i];
    if (!l) {
      l = { x: 0, y: 0, z: 0, radius: 0, intensity: 0 };
      this.pool[i] = l;
    }
    l.x = x;
    l.y = y;
    l.z = z;
    l.radius = radius;
    l.intensity = intensity;
    this.list.push(l);
  }
}

/* ============================================================ pings */

export interface PingMark {
  playerId: string;
  kind: MarkerKind;
  pos: Vec3Like;
  need: ItemKind | "";
  /** Frame-clock ms when it disappears. */
  expiresAt: number;
}

/** Active ping-wheel markers (one per player, MARKER_TICKS each) for the compass. */
export class PingBoard {
  private readonly marks = new Map<string, PingMark>();
  private readonly out: PingMark[] = [];

  add(ev: MarkerEvent, nowMs: number): void {
    this.marks.set(ev.playerId, {
      playerId: ev.playerId,
      kind: ev.kind,
      pos: { x: ev.pos.x, y: ev.pos.y, z: ev.pos.z },
      need: ev.need ?? "",
      expiresAt: nowMs + MARKER_TICKS * TICK_MS,
    });
  }

  /** Live marks at `nowMs` (expired ones are dropped). The array is reused. */
  active(nowMs: number): ReadonlyArray<PingMark> {
    this.out.length = 0;
    for (const [id, m] of this.marks) {
      if (m.expiresAt <= nowMs) this.marks.delete(id);
      else this.out.push(m);
    }
    return this.out;
  }

  clear(): void {
    this.marks.clear();
    this.out.length = 0;
  }
}

/* ============================================================ phase hint */

/**
 * Flow messages (matchStart, raftLaunch, storm, matchEnd) arrive before the patch carrying the phase change. A
 * state that's not yet in the announced phase and not newer than the message is treated as being in it, so the
 * screens and cameras never flicker back for a frame.
 */
export class PhaseTracker {
  private hint: { phase: Phase; tick: number } | null = null;

  announce(phase: Phase, tick: number): void {
    this.hint = { phase, tick };
  }

  effective(state: { phase: Phase; tick: number }): Phase {
    const h = this.hint;
    if (!h) return state.phase;
    if (state.phase === h.phase || state.tick > h.tick) {
      this.hint = null;
      return state.phase;
    }
    return h.phase;
  }

  clear(): void {
    this.hint = null;
  }
}

/* ============================================================ raft ride */

export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * During the launch cinematic the renderer sails the raft away while the server keeps the boarded players on
 * their seats. RaftRide carries a seat position along: rest pose (before the launch) → current pose.
 */
export class RaftRide {
  private readonly rest: Pose = { x: 0, y: 0, z: 0, yaw: 0 };
  private readonly now: Pose = { x: 0, y: 0, z: 0, yaw: 0 };
  private hasRest = false;
  private moving = false;

  /** Every frame outside the launch: remember where the raft sits. */
  setRest(p: Pose): void {
    copyPose(this.rest, p);
    this.hasRest = true;
    this.moving = false;
  }

  /** Every launch frame: the raft's current pose. */
  setCurrent(p: Pose): void {
    if (!this.hasRest) this.setRest(p);
    copyPose(this.now, p);
    this.moving = true;
  }

  get active(): boolean {
    return this.moving;
  }

  /** Move a point that sat on the resting raft to where it is on the sailing raft (in place). */
  carry(p: { x: number; y: number; z: number; yaw?: number }): void {
    if (!this.moving) return;
    const dyaw = this.now.yaw - this.rest.yaw;
    const c = Math.cos(dyaw);
    const s = Math.sin(dyaw);
    const rx = p.x - this.rest.x;
    const rz = p.z - this.rest.z;
    // Same rotation sense as yaw (positive turns left): x' = x·c + z·s, z' = −x·s + z·c.
    p.x = this.now.x + rx * c + rz * s;
    p.z = this.now.z - rx * s + rz * c;
    p.y += this.now.y - this.rest.y;
    if (p.yaw !== undefined) p.yaw += dyaw;
  }

  reset(): void {
    this.hasRest = false;
    this.moving = false;
  }
}

function copyPose(dst: Pose, src: Pose): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.yaw = src.yaw;
}

/* ============================================================ misc */

/** Smoothstep ease 0..1. */
export function ease(t: number): number {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
}

/** Horizontal distance. */
export function dist2(a: XZ, x: number, z: number): number {
  return Math.hypot(a.x - x, a.z - z);
}

/** Remaining amount of node `i` (initial amount when the state doesn't carry it yet). */
export function nodeAmount(island: IslandDef, nodes: ArrayView<number> | null, i: number): number {
  const v = nodes && i < nodes.length ? nodes[i] : undefined;
  return v ?? island.nodes[i]?.amount ?? 0;
}
