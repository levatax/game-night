// Snapshot interpolation for remote players. Owner: client-net.

import { MAX_EXTRAPOLATION_MS, TICK_RATE } from "../../../shared/constants";
import { lerp, lerpAngle } from "../../../shared/sim/math";
import { copyPlayerSim, createPlayerSim, type PlayerSim } from "../../../shared/sim/player";
import type { PlayerSimFields } from "../../../shared/types";

/** Keep about one second of snapshots per player. */
const HISTORY_TICKS = TICK_RATE;
/** Snapshots further apart than this are a teleport (round reset), not movement. */
const TELEPORT_DIST = 4;
/** Faster than anything legal (≈ 1 m per tick at max fall speed): scales the teleport test over gaps. */
const TELEPORT_DIST_PER_TICK = 1.2;
const MAX_EXTRAPOLATION_TICKS = (MAX_EXTRAPOLATION_MS / 1000) * TICK_RATE;

interface Snapshot {
  tick: number;
  sim: PlayerSim;
}

/** One player's snapshots, oldest first, with recycled entries (no per-patch allocation). */
class SnapshotBuffer {
  readonly items: Snapshot[] = [];
  private readonly spare: Snapshot[] = [];

  get newest(): Snapshot | undefined {
    return this.items[this.items.length - 1];
  }

  add(tick: number, sim: PlayerSimFields): void {
    const snap = this.spare.pop() ?? { tick: 0, sim: createPlayerSim() };
    snap.tick = tick;
    copyPlayerSim(sim, snap.sim);
    this.items.push(snap);
  }

  /** Drop snapshots older than `minTick`, always keeping the newest two. */
  trim(minTick: number): void {
    let drop = 0;
    while (drop < this.items.length - 2 && this.items[drop].tick < minTick) drop++;
    this.release(drop);
  }

  clear(): void {
    this.release(this.items.length);
  }

  private release(count: number): void {
    if (count <= 0) return;
    for (const snap of this.items.splice(0, count)) this.spare.push(snap);
  }
}

/**
 * Per-player snapshot buffers keyed by server tick (state.tick of the patch they came from).
 * Render time = clock.serverTickAt(now) - (clock.rttMs / 2 + INTERP_DELAY_MS) / TICK_MS.
 * (serverTickAt is the server's PRESENT; the newest snapshot is ~RTT/2 old on arrival, so the
 * extra RTT/2 keeps a real ~100 ms ≈ 2-patch buffer behind the newest snapshot.)
 * Used for remote players and for the local player whenever it is not being predicted.
 * sample(): find snapshots a (≤ t) and b (> t); positions/velocities lerp, yaw/pitch lerpAngle,
 * every discrete field (timers, flags, powerUp, heldCount...) from `a`. Past the newest snapshot:
 * extrapolate positions with velocity for at most MAX_EXTRAPOLATION_MS, then hold. Before the
 * oldest: use the oldest. Keep about 1 s of snapshots per player.
 * Teleports: when `alive` flips false → true (round reset) or two consecutive snapshots are more
 * than 4 m apart (faster than anything legal: ≤ 1.5 m per 50 ms patch), drop the older snapshots
 * so the player appears at the new spot instead of sliding across the island. Ghosts (alive =
 * false) are never extrapolated.
 */
export class Interpolation {
  private readonly buffers = new Map<string, SnapshotBuffer>();

  /** Record a snapshot (copied). Ignores ticks <= the newest stored tick for that id. */
  push(id: string, tick: number, sim: PlayerSimFields): void {
    let buf = this.buffers.get(id);
    if (!buf) {
      buf = new SnapshotBuffer();
      this.buffers.set(id, buf);
    }
    const newest = buf.newest;
    if (newest) {
      if (tick <= newest.tick) return;
      if (isTeleport(newest, tick, sim)) buf.clear();
    }
    buf.add(tick, sim);
    buf.trim(tick - HISTORY_TICKS);
  }

  /** Sample at fractional server tick `renderTick` into `out`. Returns false if no snapshot exists. */
  sample(id: string, renderTick: number, out: PlayerSimFields): boolean {
    const items = this.buffers.get(id)?.items;
    if (!items || items.length === 0) return false;
    const oldest = items[0];
    if (renderTick <= oldest.tick) {
      copyPlayerSim(oldest.sim, out);
      return true;
    }
    const newest = items[items.length - 1];
    if (renderTick >= newest.tick) {
      extrapolate(newest, renderTick, out);
      return true;
    }
    const i = indexAtOrBefore(items, renderTick);
    const a = items[i];
    const b = items[i + 1];
    blend(a.sim, b.sim, (renderTick - a.tick) / (b.tick - a.tick), out);
    return true;
  }

  /** Newest snapshot tick for a player (null if none). */
  newestTick(id: string): number | null {
    return this.buffers.get(id)?.newest?.tick ?? null;
  }

  remove(id: string): void {
    this.buffers.delete(id);
  }

  clear(): void {
    this.buffers.clear();
  }
}

function isTeleport(prev: Snapshot, tick: number, next: PlayerSimFields): boolean {
  if (!prev.sim.alive && next.alive) return true;
  const limit = Math.max(TELEPORT_DIST, (tick - prev.tick) * TELEPORT_DIST_PER_TICK);
  const dx = next.x - prev.sim.x;
  const dy = next.y - prev.sim.y;
  const dz = next.z - prev.sim.z;
  return dx * dx + dy * dy + dz * dz > limit * limit;
}

/** Last index whose tick is <= t (binary search; callers guarantee items[0].tick < t < newest). */
function indexAtOrBefore(items: readonly Snapshot[], t: number): number {
  let lo = 0;
  let hi = items.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (items[mid].tick <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Continuous fields lerp (angles along the shortest arc); every discrete field comes from `a`. */
export function blend(a: PlayerSimFields, b: PlayerSimFields, t: number, out: PlayerSimFields): PlayerSimFields {
  copyPlayerSim(a, out);
  out.x = lerp(a.x, b.x, t);
  out.y = lerp(a.y, b.y, t);
  out.z = lerp(a.z, b.z, t);
  out.vx = lerp(a.vx, b.vx, t);
  out.vy = lerp(a.vy, b.vy, t);
  out.vz = lerp(a.vz, b.vz, t);
  out.yaw = lerpAngle(a.yaw, b.yaw, t);
  out.pitch = lerpAngle(a.pitch, b.pitch, t);
  return out;
}

/** Newest snapshot moved along its velocity for at most MAX_EXTRAPOLATION_MS (ghosts hold still). */
function extrapolate(newest: Snapshot, renderTick: number, out: PlayerSimFields): void {
  copyPlayerSim(newest.sim, out);
  if (!newest.sim.alive) return;
  const sec = Math.min(renderTick - newest.tick, MAX_EXTRAPOLATION_TICKS) / TICK_RATE;
  out.x += newest.sim.vx * sec;
  out.y += newest.sim.vy * sec;
  out.z += newest.sim.vz * sec;
}
