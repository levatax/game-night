// Phase timings for JellyRoom. Owner: server-room.
// NORMAL mirrors shared/constants.ts; FAST is for the e2e test (options.fast && JELLY_TEST=1) so a full
// match runs in a few seconds. All values are seconds.

import {
  CARD_READ_SEC,
  EMPTY_ROOM_DISPOSE_SEC,
  RECONNECT_GRACE_SEC,
  RESULT_SEC,
  REVEAL_SEC,
  RIG_WINDOW_SEC,
  ROLE_REVEAL_SEC,
  SETTLE_MAX_SEC,
  SPEED_ROUND_TIMER,
  SPIN_IDLE_SEC,
  SPIN_SEC,
  VOTE_SEC,
} from "../../shared/constants.js";

export interface Timings {
  roleReveal: number;
  spinIdle: number;
  spin: number;
  rigWindow: number;
  cardRead: number;
  /** null = use settings.turnTimer. */
  turnTimer: number | null;
  speedRound: number;
  /** Never call a tower "asleep" before this much settle time (a fresh drop starts at rest). */
  settleMin: number;
  settleMax: number;
  /** Keep simulating this long after a topple so pieces visibly fly. */
  toppleLinger: number;
  result: number;
  vote: number;
  reveal: number;
  reconnectGrace: number;
  emptyDispose: number;
  /** Hiccups: seconds between hops (min..max) and hop length. */
  hiccupMin: number;
  hiccupMax: number;
  hiccupHop: number;
}

export const NORMAL_TIMINGS: Timings = {
  roleReveal: ROLE_REVEAL_SEC,
  spinIdle: SPIN_IDLE_SEC,
  spin: SPIN_SEC,
  rigWindow: RIG_WINDOW_SEC,
  cardRead: CARD_READ_SEC,
  turnTimer: null,
  speedRound: SPEED_ROUND_TIMER,
  settleMin: 0.5,
  settleMax: SETTLE_MAX_SEC,
  toppleLinger: 1,
  result: RESULT_SEC,
  vote: VOTE_SEC,
  reveal: REVEAL_SEC,
  reconnectGrace: RECONNECT_GRACE_SEC,
  emptyDispose: EMPTY_ROOM_DISPOSE_SEC,
  hiccupMin: 0.8,
  hiccupMax: 1.6,
  hiccupHop: 0.25,
};

export const FAST_TIMINGS: Timings = {
  roleReveal: 0.3,
  spinIdle: 0.2,
  spin: 0.6,
  rigWindow: 0.3,
  cardRead: 0.1,
  turnTimer: 0.6,
  speedRound: 0.4,
  settleMin: 0.2,
  settleMax: 1.2,
  toppleLinger: 0.3,
  result: 0.3,
  vote: 1.5,
  reveal: 0.4,
  reconnectGrace: 2,
  emptyDispose: 3,
  hiccupMin: 0.1,
  hiccupMax: 0.2,
  hiccupHop: 0.05,
};
