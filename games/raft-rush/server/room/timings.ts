// Every timer RaftRoom runs, in ticks / seconds: the match Timings (normal or RAFT_TEST fast) plus the
// room-only ones (reconnect grace, empty / never-joined room dispose, storm warning, preview regeneration, craft /
// chest message budget). Owner: server-room.

import {
  EMPTY_ROOM_DISPOSE_SEC,
  RECONNECT_GRACE_SEC,
  STORM_WARN_SEC,
  TICK_RATE,
  secToTicks,
  timingsFor,
  type Timings,
} from "../../shared/constants.js";

/**
 * A room nobody ever joined (a matchmaking create whose client never connects, e.g. a scripted create loop)
 * disposes this long after its creation. A real creator connects within milliseconds of its create (Colyseus
 * would hold the seat for 15 s).
 */
export const NEVER_JOINED_DISPOSE_SEC = 10;
/** Lobby seed changes regenerate the preview island at most once per second (island generation is the costly part). */
export const PREVIEW_COOLDOWN_SEC = 1;
/**
 * A human's craft / chest messages (each kind on its own): ACTION_BURST back to back, then one per
 * ACTION_COOLDOWN_TICKS (room/flood.ts ActionBudget). Each one costs a world validation and may cost a reject; the
 * burst keeps legit clicking whole (a double click, or "Take 1" clicked 8× a second for a second and a half).
 */
export const ACTION_COOLDOWN_TICKS = 5;
export const ACTION_BURST = 4;

// Startup assertion. The empty-room timer never disposes while a human is inside the reconnect grace (RaftRoom
// counts them), so this order is not needed for correctness any more; it still holds so a room whose last human
// dropped always outlives that human's grace window by design, and a retune that flips it is a conscious choice.
if (!(RECONNECT_GRACE_SEC < EMPTY_ROOM_DISPOSE_SEC)) {
  throw new Error(`RECONNECT_GRACE_SEC (${RECONNECT_GRACE_SEC}) must stay below EMPTY_ROOM_DISPOSE_SEC (${EMPTY_ROOM_DISPOSE_SEC})`);
}

export interface RoomTimings extends Timings {
  /** allowReconnection window (seconds). A bot drives the seat meanwhile. */
  reconnectGraceSec: number;
  /** The room disposes itself this long after the last client left (seconds), unless a human is in the grace. */
  emptyDisposeSec: number;
  /** A room nobody ever joined disposes this long after its creation (seconds). */
  neverJoinedSec: number;
  /** "FIRTINA!" warning: this many ticks before the last night ends (clamped to the night's length). */
  stormWarnTicks: number;
  /** Lobby seed changes regenerate the preview island at most once per this many ticks. */
  previewCooldownTicks: number;
  /** A human's craft / chest messages refill one per this many ticks (each kind); bots are not throttled. */
  actionCooldownTicks: number;
  /** …and this many may come back to back. */
  actionBurst: number;
}

/** Match timers for `fast` plus the room-only timers (the same in fast mode: tests reconnect right away). */
export function roomTimings(fast: boolean): Readonly<RoomTimings> {
  const t = timingsFor(fast);
  return {
    ...t,
    reconnectGraceSec: RECONNECT_GRACE_SEC,
    emptyDisposeSec: EMPTY_ROOM_DISPOSE_SEC,
    neverJoinedSec: NEVER_JOINED_DISPOSE_SEC,
    stormWarnTicks: Math.min(secToTicks(STORM_WARN_SEC), t.night),
    previewCooldownTicks: secToTicks(PREVIEW_COOLDOWN_SEC),
    actionCooldownTicks: ACTION_COOLDOWN_TICKS,
    actionBurst: ACTION_BURST,
  };
}

/** Whole seconds shown for a tick count (rounded up, never negative). */
export function secondsLeft(ticks: number): number {
  return Math.max(0, Math.ceil(ticks / TICK_RATE));
}
