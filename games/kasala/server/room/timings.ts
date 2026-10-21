// Phase timings for KasalaRoom. Owner: server.
// NORMAL mirrors shared/constants.ts; FAST is for the e2e test (options.fast && KASALA_TEST=1) so whole
// matches run in seconds. Every value is in seconds.

import {
  ATTACK_ANIM_SEC,
  BET_WINDOW_FIRST_ROUND_SEC,
  BET_WINDOW_SEC,
  BOT_THINK_MAX_SEC,
  BOT_THINK_MIN_SEC,
  CASH_RESULT_BIG_SEC,
  CASH_RESULT_SEC,
  ELIMINATION_SEC,
  EMOTE_COOLDOWN_SEC,
  EMPTY_ROOM_DISPOSE_SEC,
  FLIP_ANIM_SEC,
  INTRO_SEC,
  LAST_CHANCE_SEC,
  LAWYER_ANIM_SEC,
  LOAN_OFFER_SEC,
  MARKET_REVEAL_SEC,
  MARKET_SEC,
  RAID_RESULT_SEC,
  RAID_RESULT_SHORT_SEC,
  RECONNECT_GRACE_SEC,
  ROUND_SUMMARY_SEC,
  SETTLE_SEC,
  TARGET_SEC,
  TIME_LOW_SEC,
  TURN_INTRO_SEC,
  WHEEL_ASCEND_SEC,
  WHEEL_DESCEND_SEC,
  WHEEL_HOLD_SEC,
  WHEEL_SPIN_MAX_SEC,
  WHEEL_SPIN_MIN_SEC,
} from "../../shared/constants.js";

export interface Timings {
  intro: number;
  /** Turn start with side bets open. */
  betWindow: number;
  /** The same in round 1 (new players read the boxes). */
  betWindowFirst: number;
  /** Once every eligible bettor has bet or passed, the bet window closes this long after the last answer. */
  betCloseGrace: number;
  /** Turn start without bets. */
  turnIntro: number;
  /** Decision timer; null = settings.decisionSec. */
  decision: number | null;
  /** Time to flip the first card of a turn; null = max(settings.decisionSec, FIRST_CARD_SEC). */
  firstCard: number | null;
  /** "Karar ver!" line when this much decision time is left. */
  timeLow: number;
  flipAnim: number;
  target: number;
  /** An attack card with exactly one legal target resolves on its own this long after the card landed. */
  autoTarget: number;
  attackAnim: number;
  lawyerAnim: number;
  wheelDescend: number;
  wheelSpinMin: number;
  wheelSpinMax: number;
  wheelHold: number;
  wheelAscend: number;
  /** Result phase after KASALA: small pot / pot ≥ BIG_CASH. */
  cashResult: number;
  cashResultBig: number;
  /** Result phase after a raid: full door sequence / quick at-the-seat raid. */
  raidResult: number;
  raidResultShort: number;
  /** Result phase of a skipped (disconnected) turn. */
  skipResult: number;
  /** Pazar: secret picks, then the reveal animation (busy). */
  market: number;
  marketReveal: number;
  /** Once every buyer chose, the market closes this long after the last answer. */
  marketCloseGrace: number;
  settle: number;
  /** Pause after ROUND_END (not after the last round) while clients show the round summary. */
  roundSummary: number;
  lastChance: number;
  /** Son Şans when only one player could lend (2-player Battle Royale endgame). */
  lastChanceOneLender: number;
  /** Son Şans when nobody can lend the minimum: just long enough for Cemil Abi's line. */
  lastChanceNoLender: number;
  elimination: number;
  loanOffer: number;
  emoteCooldown: number;
  reconnectGrace: number;
  emptyDispose: number;
  /** Per-player rate limit for LOAN_PROPOSE / LOAN_REPAY. */
  loanCooldown: number;
  /** Bots wait a random time in this range before each action. */
  botThinkMin: number;
  botThinkMax: number;
  /** Scales the server-driven match-end announcer sequence (titles, podium). */
  matchEndScale: number;
}

export const NORMAL_TIMINGS: Timings = {
  intro: INTRO_SEC,
  betWindow: BET_WINDOW_SEC,
  betWindowFirst: BET_WINDOW_FIRST_ROUND_SEC,
  betCloseGrace: 0.8,
  turnIntro: TURN_INTRO_SEC,
  decision: null,
  firstCard: null,
  timeLow: TIME_LOW_SEC,
  flipAnim: FLIP_ANIM_SEC,
  target: TARGET_SEC,
  autoTarget: 0.8,
  attackAnim: ATTACK_ANIM_SEC,
  lawyerAnim: LAWYER_ANIM_SEC,
  wheelDescend: WHEEL_DESCEND_SEC,
  wheelSpinMin: WHEEL_SPIN_MIN_SEC,
  wheelSpinMax: WHEEL_SPIN_MAX_SEC,
  wheelHold: WHEEL_HOLD_SEC,
  wheelAscend: WHEEL_ASCEND_SEC,
  cashResult: CASH_RESULT_SEC,
  cashResultBig: CASH_RESULT_BIG_SEC,
  raidResult: RAID_RESULT_SEC,
  raidResultShort: RAID_RESULT_SHORT_SEC,
  skipResult: 1.4,
  market: MARKET_SEC,
  marketReveal: MARKET_REVEAL_SEC,
  marketCloseGrace: 0.8,
  settle: SETTLE_SEC,
  roundSummary: ROUND_SUMMARY_SEC,
  lastChance: LAST_CHANCE_SEC,
  lastChanceOneLender: 8,
  lastChanceNoLender: 3,
  elimination: ELIMINATION_SEC,
  loanOffer: LOAN_OFFER_SEC,
  emoteCooldown: EMOTE_COOLDOWN_SEC,
  reconnectGrace: RECONNECT_GRACE_SEC,
  emptyDispose: EMPTY_ROOM_DISPOSE_SEC,
  loanCooldown: 2,
  botThinkMin: BOT_THINK_MIN_SEC,
  botThinkMax: BOT_THINK_MAX_SEC,
  matchEndScale: 1,
};

/** Every lock is ≥ 3 ticks so each CARD is visible in its own patch before the next effect lands. */
export const FAST_TIMINGS: Timings = {
  intro: 0.2,
  betWindow: 0.35,
  betWindowFirst: 0.8,
  betCloseGrace: 0.05,
  turnIntro: 0.15,
  decision: 1,
  firstCard: 1,
  timeLow: 0.5,
  flipAnim: 0.15,
  target: 0.4,
  autoTarget: 0.1,
  attackAnim: 0.15,
  lawyerAnim: 0.15,
  wheelDescend: 0.1,
  wheelSpinMin: 0.15,
  wheelSpinMax: 0.25,
  wheelHold: 0.15,
  wheelAscend: 0.15,
  cashResult: 0.15,
  cashResultBig: 0.2,
  raidResult: 0.2,
  raidResultShort: 0.15,
  skipResult: 0.15,
  market: 0.4,
  marketReveal: 0.15,
  marketCloseGrace: 0.05,
  settle: 0.15,
  roundSummary: 0.15,
  lastChance: 1.2,
  lastChanceOneLender: 0.8,
  lastChanceNoLender: 0.2,
  elimination: 0.2,
  loanOffer: 1.5,
  emoteCooldown: EMOTE_COOLDOWN_SEC,
  reconnectGrace: 1.5,
  emptyDispose: 2,
  loanCooldown: 0.2,
  botThinkMin: 0.03,
  botThinkMax: 0.1,
  matchEndScale: 0.05,
};
