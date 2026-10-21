// The live RaftRooms of this process: the room cap and the health report. Owner: server-room.
//
// Every RaftRoom claims a slot in onCreate BEFORE it allocates a room code or generates an island (no free slot →
// the create fails with JOIN_ERROR.SERVER_BUSY) and releases it exactly once, in onDispose or when onCreate fails.
// The slot carries the time of the room's last completed fixed tick, so health() can tell a stalled room (its
// simulation interval stopped, or every tick throws) from a merely quiet one. Times are monotonic ms
// (performance.now(): RaftRoom and server/index.ts health()), so a wall-clock step can't fake or hide a stall.
//
// Default cap (measured 2026-10-21 on an Apple-silicon Mac, Node 25): a 6-bot match at normal timings costs
// ~0.06 ms per fixed tick (world step + bot desk; p99 0.2 ms), i.e. ~0.2% of a core at 30 Hz before the 20 Hz
// patches, and a lobby room holds ~0.25 MB (island + state + world) and ~5 ms of island generation per seed
// change. 64 rooms (= 384 seats, far beyond what this hub serves) stay within ~20% of one core and ~20 MB even
// with every room in a full match, leaving the process to the other games, and a scripted create loop can't grow
// past it (rooms nobody joins dispose after neverJoinedSec, emptied ones after emptyDisposeSec: room/timings.ts).
// RAFT_MAX_ROOMS overrides it.
//
// Trade-off: the cap is per process, not per client. It bounds what a create loop can cost, but a script that keeps
// creating (~7 creates/s that never connect, or one create + join + leave per second: emptied rooms live 60 s) can
// hold every slot, and then every real create gets SERVER_BUSY until it stops. Closing that needs a per-client
// create throttle in front of matchmaking (the hub's /matchmake route, with a trusted-proxy rule for the client
// IP: Colyseus takes it from x-real-ip / x-forwarded-for first); the room itself never sees who asked for it.

/** Live RaftRooms per process unless RAFT_MAX_ROOMS says otherwise. */
export const DEFAULT_MAX_ROOMS = 64;
/** A live room whose last fixed tick is older than this is reported as stalled (health ok = false). */
export const STALL_MS = 5000;

/** The cap from `env` (process.env.RAFT_MAX_ROOMS): a positive integer, else DEFAULT_MAX_ROOMS. */
export function maxRooms(env: string | undefined = process.env.RAFT_MAX_ROOMS): number {
  const n = env !== undefined && /^\s*\d+\s*$/.test(env) ? Number(env) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_ROOMS;
}

/** One live room's entry. */
export interface RoomSlot {
  /** The room code once allocated ("" before), for the health report and logs. */
  code: string;
  /** Monotonic time (ms) the slot was claimed. */
  readonly createdAt: number;
  /** Monotonic time (ms) of the room's last completed fixed tick (createdAt until the first one). */
  lastTickAt: number;
  /** A RAFT_TEST manual-clock room: it only ticks when a test advances it, so it never counts as stalled. */
  manual: boolean;
  /** Free the slot (idempotent: only the first call counts). */
  release(): void;
}

const live = new Set<RoomSlot>();

/** A slot for a new room, or null when `limit` rooms are already live. */
export function claimRoomSlot(nowMs: number, limit: number = maxRooms()): RoomSlot | null {
  if (live.size >= limit) return null;
  const slot: RoomSlot = {
    code: "",
    createdAt: nowMs,
    lastTickAt: nowMs,
    manual: false,
    release: () => {
      live.delete(slot);
    },
  };
  live.add(slot);
  return slot;
}

/** Number of live rooms (claimed, not yet released). */
export function liveRoomCount(): number {
  return live.size;
}

/**
 * What games/raft-rush/server/index.ts health() reports (the hub's /healthz). A type alias, not an interface, so it
 * fits the hub's `{ ok: boolean; [k: string]: unknown }`.
 */
export type RoomHealth = {
  /** False when any live room is stalled. */
  ok: boolean;
  rooms: number;
  /** Age of the stalest live room's last fixed tick (0 without rooms). */
  maxTickAgeMs: number;
  /** Codes of the stalled rooms. */
  stalled: string[];
};

/** Health of every live room at monotonic `nowMs`: stalled = the last fixed tick is older than `stallMs`. */
export function roomHealth(nowMs: number, stallMs: number = STALL_MS): RoomHealth {
  let maxTickAgeMs = 0;
  const stalled: string[] = [];
  for (const slot of live) {
    if (slot.manual) continue;
    const age = Math.max(0, nowMs - slot.lastTickAt);
    if (age > maxTickAgeMs) maxTickAgeMs = age;
    if (age > stallMs) stalled.push(slot.code || "(creating)");
  }
  return { ok: stalled.length === 0, rooms: live.size, maxTickAgeMs: Math.round(maxTickAgeMs), stalled };
}

/**
 * The stalled codes of `report` not logged yet. /healthz only shows how many rooms stalled (codes are join codes), so
 * server/index.ts health() logs one "stalled" line per new stall; a room that recovers and stalls again is new
 * again. `reported` is updated in place.
 */
export function freshStalls(report: RoomHealth, reported: Set<string>): string[] {
  for (const code of reported) if (!report.stalled.includes(code)) reported.delete(code);
  const fresh = report.stalled.filter((code) => !reported.has(code));
  for (const code of fresh) reported.add(code);
  return fresh;
}
