// Snapshot interpolation for monsters (crabs, puffers, the boss, monkeys, Şükrü the gull). Owner: client-net.
// Same model as Interpolation.ts (remote players): buffered by state.tick, rendered INTERP_DELAY_MS + RTT/2
// behind the server's present, extrapolated at most MAX_EXTRAPOLATION_MS. MonsterView carries no velocity, so
// velocity / speed come from the difference of consecutive snapshots.

import { MAX_EXTRAPOLATION_MS, TICK_RATE } from "../../../shared/constants";
import { lerp, lerpAngle } from "../../../shared/sim/math";
import type { MapView, MonsterView } from "../../../shared/types";
import type { MonsterFrame } from "./types";

/** About one second of snapshots per monster. */
const HISTORY_TICKS = TICK_RATE;
/** A jump larger than this (and faster than TELEPORT_DIST_PER_TICK) is a respawn / despawn reuse, not movement. */
const TELEPORT_DIST = 4;
/** Kraken flings and knockback stay well below this (m per tick). */
const TELEPORT_DIST_PER_TICK = 1.2;
const MAX_EXTRAPOLATION_TICKS = (MAX_EXTRAPOLATION_MS / 1000) * TICK_RATE;
/** Snapshots further apart than this don't give a usable velocity for extrapolation. */
const MAX_VELOCITY_GAP_TICKS = 10;

interface MonsterSnapshot {
  tick: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  view: MonsterFrame;
}

/** One monster's snapshots, oldest first, recycled (no per-patch allocation once warm). */
class MonsterBuffer {
  readonly items: MonsterSnapshot[] = [];
  private readonly spare: MonsterSnapshot[] = [];

  get newest(): MonsterSnapshot | undefined {
    return this.items[this.items.length - 1];
  }

  add(tick: number, m: MonsterView): void {
    const snap = this.spare.pop() ?? { tick: 0, x: 0, y: 0, z: 0, yaw: 0, view: emptyMonsterFrame(m.id) };
    snap.tick = tick;
    snap.x = m.x;
    snap.y = m.y;
    snap.z = m.z;
    snap.yaw = m.yaw;
    copyMonsterView(m, snap.view);
    this.items.push(snap);
  }

  trim(minTick: number): void {
    let drop = 0;
    while (drop < this.items.length - 2 && this.items[drop]!.tick < minTick) drop++;
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
 * Monster snapshot interpolation.
 * - onServerState(monsters, tick): snapshot every monster at the patch tick; buffers of monsters that left the
 *   state are dropped (their frames too).
 * - sample(id, renderTick, out): a (≤ t) and b (> t): x/y/z lerp, yaw lerpAngle, speed = horizontal distance
 *   a→b per second; discrete fields (kind, hp, mode, modeTicks, targetId, carry) from `a`. Past the newest
 *   snapshot: extrapolate with the velocity of the last two snapshots for at most MAX_EXTRAPOLATION_MS. Before
 *   the oldest: hold the oldest.
 * - frames(renderTick): every tracked monster, in state order, as reused MonsterFrame objects.
 */
export class MonsterSync {
  private readonly buffers = new Map<string, MonsterBuffer>();
  private readonly framesById = new Map<string, MonsterFrame>();
  private readonly order: string[] = [];
  private readonly list: MonsterFrame[] = [];
  private readonly seen = new Set<string>();

  /** Record every monster of a decoded patch at `tick` and forget the ones that are gone. */
  onServerState(monsters: MapView<MonsterView>, tick: number): void {
    const seen = this.seen;
    seen.clear();
    this.order.length = 0;
    monsters.forEach((m, id) => {
      seen.add(id);
      this.order.push(id);
      this.push(id, tick, m);
    });
    for (const id of this.buffers.keys()) {
      if (!seen.has(id)) this.remove(id);
    }
  }

  /** Record one snapshot (copied). Ignores ticks <= the newest stored tick for that id. */
  push(id: string, tick: number, m: MonsterView): void {
    let buf = this.buffers.get(id);
    if (!buf) {
      buf = new MonsterBuffer();
      this.buffers.set(id, buf);
      if (!this.order.includes(id)) this.order.push(id);
    }
    const newest = buf.newest;
    if (newest) {
      if (tick <= newest.tick) return;
      if (isTeleport(newest, tick, m)) buf.clear();
    }
    buf.add(tick, m);
    buf.trim(tick - HISTORY_TICKS);
  }

  /** Sample at fractional server tick `renderTick` into `out`. Returns false if the monster is unknown. */
  sample(id: string, renderTick: number, out: MonsterFrame): boolean {
    const items = this.buffers.get(id)?.items;
    if (!items || items.length === 0) return false;
    const oldest = items[0]!;
    if (renderTick <= oldest.tick) {
      writeSnapshot(oldest, out);
      out.speed = items.length > 1 ? horizontalSpeed(oldest, items[1]!) : 0;
      return true;
    }
    const newest = items[items.length - 1]!;
    if (renderTick >= newest.tick) {
      writeSnapshot(newest, out);
      const prev = items.length > 1 ? items[items.length - 2]! : null;
      if (prev && newest.tick - prev.tick <= MAX_VELOCITY_GAP_TICKS) {
        const span = newest.tick - prev.tick;
        const ahead = Math.min(renderTick - newest.tick, MAX_EXTRAPOLATION_TICKS) / span;
        out.x += (newest.x - prev.x) * ahead;
        out.y += (newest.y - prev.y) * ahead;
        out.z += (newest.z - prev.z) * ahead;
        out.speed = horizontalSpeed(prev, newest);
      } else {
        out.speed = 0;
      }
      return true;
    }
    const i = indexAtOrBefore(items, renderTick);
    const a = items[i]!;
    const b = items[i + 1]!;
    const t = (renderTick - a.tick) / (b.tick - a.tick);
    writeSnapshot(a, out);
    out.x = lerp(a.x, b.x, t);
    out.y = lerp(a.y, b.y, t);
    out.z = lerp(a.z, b.z, t);
    out.yaw = lerpAngle(a.yaw, b.yaw, t);
    out.speed = horizontalSpeed(a, b);
    return true;
  }

  /** Every tracked monster sampled at `renderTick` (reused objects: valid until the next call). */
  frames(renderTick: number): MonsterFrame[] {
    const out = this.list;
    out.length = 0;
    for (const id of this.order) {
      let frame = this.framesById.get(id);
      if (!frame) {
        frame = emptyMonsterFrame(id);
        this.framesById.set(id, frame);
      }
      if (this.sample(id, renderTick, frame)) out.push(frame);
    }
    return out;
  }

  /** Newest snapshot tick for a monster (null if none). */
  newestTick(id: string): number | null {
    return this.buffers.get(id)?.newest?.tick ?? null;
  }

  get size(): number {
    return this.buffers.size;
  }

  remove(id: string): void {
    this.buffers.delete(id);
    this.framesById.delete(id);
    const at = this.order.indexOf(id);
    if (at >= 0) this.order.splice(at, 1);
  }

  clear(): void {
    this.buffers.clear();
    this.framesById.clear();
    this.order.length = 0;
    this.list.length = 0;
  }
}

/** A blank frame (crab at the origin) for a monster id. */
export function emptyMonsterFrame(id: string): MonsterFrame {
  return { id, kind: "crab", x: 0, y: 0, z: 0, yaw: 0, hp: 0, mode: "emerge", modeTicks: 0, targetId: "", carry: "", speed: 0 };
}

function copyMonsterView(m: MonsterView, out: MonsterFrame): void {
  out.id = m.id;
  out.kind = m.kind;
  out.x = m.x;
  out.y = m.y;
  out.z = m.z;
  out.yaw = m.yaw;
  out.hp = m.hp;
  out.mode = m.mode;
  out.modeTicks = m.modeTicks;
  out.targetId = m.targetId;
  out.carry = m.carry;
  out.speed = 0;
}

function writeSnapshot(s: MonsterSnapshot, out: MonsterFrame): void {
  const v = s.view;
  out.id = v.id;
  out.kind = v.kind;
  out.x = s.x;
  out.y = s.y;
  out.z = s.z;
  out.yaw = s.yaw;
  out.hp = v.hp;
  out.mode = v.mode;
  out.modeTicks = v.modeTicks;
  out.targetId = v.targetId;
  out.carry = v.carry;
}

function horizontalSpeed(a: MonsterSnapshot, b: MonsterSnapshot): number {
  const ticks = b.tick - a.tick;
  if (ticks <= 0) return 0;
  return (Math.hypot(b.x - a.x, b.z - a.z) * TICK_RATE) / ticks;
}

function isTeleport(prev: MonsterSnapshot, tick: number, next: MonsterView): boolean {
  const limit = Math.max(TELEPORT_DIST, (tick - prev.tick) * TELEPORT_DIST_PER_TICK);
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const dz = next.z - prev.z;
  return dx * dx + dy * dy + dz * dz > limit * limit;
}

function indexAtOrBefore(items: readonly MonsterSnapshot[], t: number): number {
  let lo = 0;
  let hi = items.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (items[mid]!.tick <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}
