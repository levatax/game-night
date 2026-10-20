// Phase durations for a room (normal or BONK_TEST fast timers) and countdown math.

import {
  BALL_RESPAWN_TICKS,
  COUNTDOWN_TICKS,
  FAST_TIMINGS,
  MATCH_END_LOBBY_TICKS,
  MATCH_END_MIN_TICKS,
  POWERUP_FIRST_TICKS,
  POWERUP_INTERVAL_TICKS,
  POWERUP_WARNING_TICKS,
  RING_DROP_INTERVAL_TICKS,
  RING_SHAKE_TICKS,
  ROUND_END_CARD_TICKS,
  ROUND_END_SLOWMO_TICKS,
  ROUND_TICKS,
  TICK_RATE,
  secToTicks,
} from "../../shared/constants.js";

/**
 * Stalemate guard (not in game1.md): once the last droppable ring has fallen in sudden death, the
 * round ends this long afterwards; the alive player with the most hearts wins it.
 */
export const STALEMATE_TICKS = secToTicks(30);

/** Every room timer, in ticks. */
export interface RoomTimings {
  countdownTicks: number;
  roundTicks: number;
  ringDropIntervalTicks: number;
  ringShakeTicks: number;
  roundEndSlowmoTicks: number;
  roundEndCardTicks: number;
  powerUpFirstTicks: number;
  powerUpIntervalTicks: number;
  powerUpWarningTicks: number;
  ballRespawnTicks: number;
  matchEndLobbyTicks: number;
  matchEndMinTicks: number;
  stalemateTicks: number;
}

export const NORMAL_TIMINGS: Readonly<RoomTimings> = {
  countdownTicks: COUNTDOWN_TICKS,
  roundTicks: ROUND_TICKS,
  ringDropIntervalTicks: RING_DROP_INTERVAL_TICKS,
  ringShakeTicks: RING_SHAKE_TICKS,
  roundEndSlowmoTicks: ROUND_END_SLOWMO_TICKS,
  roundEndCardTicks: ROUND_END_CARD_TICKS,
  powerUpFirstTicks: POWERUP_FIRST_TICKS,
  powerUpIntervalTicks: POWERUP_INTERVAL_TICKS,
  powerUpWarningTicks: POWERUP_WARNING_TICKS,
  ballRespawnTicks: BALL_RESPAWN_TICKS,
  matchEndLobbyTicks: MATCH_END_LOBBY_TICKS,
  matchEndMinTicks: MATCH_END_MIN_TICKS,
  stalemateTicks: STALEMATE_TICKS,
};

/** Bot-test timers: FAST_TIMINGS plus shortened room-only timers (podium, stalemate). */
export const FAST_ROOM_TIMINGS: Readonly<RoomTimings> = {
  ...NORMAL_TIMINGS,
  countdownTicks: FAST_TIMINGS.COUNTDOWN_TICKS,
  roundTicks: FAST_TIMINGS.ROUND_TICKS,
  ringDropIntervalTicks: FAST_TIMINGS.RING_DROP_INTERVAL_TICKS,
  ringShakeTicks: FAST_TIMINGS.RING_SHAKE_TICKS,
  roundEndSlowmoTicks: FAST_TIMINGS.ROUND_END_SLOWMO_TICKS,
  roundEndCardTicks: FAST_TIMINGS.ROUND_END_CARD_TICKS,
  powerUpFirstTicks: FAST_TIMINGS.POWERUP_FIRST_TICKS,
  powerUpIntervalTicks: FAST_TIMINGS.POWERUP_INTERVAL_TICKS,
  matchEndLobbyTicks: secToTicks(10),
  matchEndMinTicks: secToTicks(0.5),
  stalemateTicks: secToTicks(3),
};

/** Fast timers only when the create option asks for them AND the server runs with BONK_TEST=1. */
export function wantsFastTimers(requested: unknown, env: string | undefined = process.env.BONK_TEST): boolean {
  return requested === true && env === "1";
}

export function roomTimings(fast: boolean): Readonly<RoomTimings> {
  return fast ? FAST_ROOM_TIMINGS : NORMAL_TIMINGS;
}

/** Countdown number shown for `ticksLeft` (3, 2, 1 … per whole second; 0 = go). */
export function countdownNumber(ticksLeft: number): number {
  return Math.max(0, Math.ceil(ticksLeft / TICK_RATE));
}
