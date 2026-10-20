// KASALA! network protocol: phases, synced state shapes and messages. FROZEN CONTRACT.
// server/schema.ts implements the *View interfaces field-for-field (checked at compile time there).
// The client reads room.state through these interfaces only. Nothing here is secret: bets, debts and
// loan offers are public by design (§17). Unflipped cards don't exist until the server rolls them.

import type {
  Animal,
  BetBox,
  CardId,
  EmoteId,
  RaidAnim,
  Rarity,
  TitleId,
  WheelSliceId,
} from "./constants.js";

export { ROOM_NAME } from "./constants.js";

// ---------------------------------------------------------------------- phases
/**
 * lobby       → host presses Start (≥ MIN_PLAYERS connected, everyone ready). Players pick animal + color.
 * intro       → INTRO_SEC; kasas/kumbara set, ANNOUNCER matchStart. Then the first turn.
 * betting     → turn start (TURN_START broadcast). BET_WINDOW_SEC when someone can bet, else TURN_INTRO_SEC.
 *               Non-active players BET; the active player watches the bets come in. A disconnected active
 *               player is skipped here (CASHED with skipped = true, no bets).
 * flipping    → decision timer (settings.decisionSec). Active player: FLIP or CASH. After each FLIP the server
 *               broadcasts CARD and sets busy = true for FLIP_ANIM_SEC, then restarts the timer. Timer end →
 *               automatic CASH. A raid card (not cancelled by a lawyer) → result. A "pick" attack card →
 *               targeting. The wheel card → wheel.
 * targeting   → TARGET_SEC; the active player sends TARGET (click a character), else a random target. Then
 *               ATTACK broadcast, busy for ATTACK_ANIM_SEC, back to flipping.
 * wheel       → WHEEL_START (descend + spin), WHEEL_RESULT exactly when it lands, hold WHEEL_HOLD_SEC; "BİR DAHA!"
 *               spins again (descendMs 0). Then WHEEL_ASCEND_SEC (busy) and back to flipping.
 * result      → CASHED (CASH_RESULT_SEC) or RAIDED (RAID_RESULT_SEC) broadcast at entry.
 * settle      → SETTLE_SEC; BETS_SETTLED at entry (skipped when nobody bet). Then the next turn, or ROUND_END
 *               (interest, Battle Royale floor) when the full round is over, or lastChance / matchEnd.
 * lastChance  → Battle Royale: state.lastChanceId has 0$; LAST_CHANCE_SEC for someone to lend them money.
 *               Saved (kasa > 0 through an accepted loan) → SAVED, continue. Else → elimination.
 * elimination → ELIMINATION_SEC cement-shoes scene (ELIMINATED broadcast at entry); the player becomes a ghost.
 * matchEnd    → MATCH_END broadcast at entry (debt collection, shame titles, standings). REMATCH (host) → lobby.
 */
export type Phase =
  | "lobby"
  | "intro"
  | "betting"
  | "flipping"
  | "targeting"
  | "wheel"
  | "result"
  | "settle"
  | "lastChance"
  | "elimination"
  | "matchEnd";
export type Mode = "classic" | "royale";
/** offer: fromId lends to toId · request: fromId asks toId to lend to them. The other side must accept. */
export type LoanKind = "offer" | "request";

// ----------------------------------------------------------------- state views
/** Read-only view of a Colyseus MapSchema (iterate with forEach / values()). */
export interface MapLike<T> {
  readonly size: number;
  get(key: string): T | undefined;
  has(key: string): boolean;
  forEach(cb: (value: T, key: string) => void): void;
  values(): IterableIterator<T>;
  keys(): IterableIterator<string>;
}
/** Read-only view of a Colyseus ArraySchema. */
export interface ArrayLike2<T> {
  readonly length: number;
  [i: number]: T;
  forEach(cb: (value: T, i: number) => void): void;
  indexOf(v: T): number;
  map<U>(cb: (value: T, i: number) => U): U[];
}

export interface StatsView {
  /** Raids suffered (lawyer-cancelled ones don't count). */
  raids: number;
  /** Successful KASALAs (incl. automatic ones with a pot > 0). */
  cashes: number;
  /** KASALAs with at most EARLY_CASH_FLIPS cards ("En Büyük Korkak"). */
  earlyCashes: number;
  /** Biggest pot banked with one KASALA. */
  biggestCash: number;
  /** Net side-bet result ($, real money only, ghosts excluded). */
  betProfit: number;
  betsWon: number;
  betsLost: number;
  /** Most cards flipped in a single turn ("Gözü Kara"). */
  maxFlips: number;
  /** Total principal lent / borrowed this match. */
  lent: number;
  borrowed: number;
}

export interface PlayerView {
  id: string;
  nickname: string;
  animal: Animal;
  /** 0..5, index into PLAYER_COLORS. Unique per room. */
  color: number;
  /** Seat around the table, 0..5 (join order, compacted). */
  seat: number;
  ready: boolean;
  connected: boolean;
  /** Joined mid-match: watches until the next match. */
  spectator: boolean;
  /**
   * Server-controlled player: added by the host in the lobby (ADD_BOT) or took over the seat of a match player
   * who left for good. Bots are always connected and ready, never host.
   */
  bot: boolean;
  /** Money in the safe. Never negative. */
  kasa: number;
  /** Battle Royale: thrown in the river. Takes no turns, bets with free ghost chips. */
  ghost: boolean;
  /** Correct ghost predictions so far (GHOST_WINS_TO_RETURN → back at the table). */
  ghostWins: number;
  /** Already came back from the river once this match. */
  ghostReturned: boolean;
  /** Lanet: the first money card in this player's next turn pays 0$ (cleared at the end of that turn). */
  cursed: boolean;
  /** Tuzak: this player's next turn starts at siren level TRAP_LEVEL. */
  trapped: boolean;
  /** Wheel "BEDAVA AVUKAT": one lawyer waiting for this player's next turn. */
  lawyerNext: boolean;
  /** Total debt > kasa (§9). Half of every KASALA goes to the creditors. */
  taslik: boolean;
  /** Couldn't pay a debt at match end. */
  karaListe: boolean;
  /** Final standing (1 = winner), 0 until matchEnd. */
  place: number;
  stats: StatsView;
}

export interface SettingsView {
  mode: Mode;
  /** Classic: each player's number of turns, 0 = auto (classicRounds). Ignored in Battle Royale. One of TURN_OPTIONS. */
  turns: number;
  /** One of DECISION_SEC_OPTIONS. */
  decisionSec: number;
  /** Loans & loan sharking on/off. */
  loans: boolean;
  /** Spectator side bets on/off. */
  sideBets: boolean;
}

/** A side bet. Keyed by playerId in state.bets (one per player per turn). Public. */
export interface BetView {
  playerId: string;
  box: BetBox;
  amount: number;
  /** Free ghost chip (Battle Royale): no money moves, a win counts toward ghostWins. */
  ghost: boolean;
}

export interface DebtView {
  id: string;
  lenderId: string;
  borrowerId: string;
  principal: number;
  /** Interest per completed full round, one of LOAN_RATES. */
  ratePct: number;
  /** What the borrower owes now (principal + interest − repayments). */
  owed: number;
}

/** A pending loan offer / request, shown to everyone as a pop-up (§9). */
export interface OfferView {
  id: string;
  fromId: string;
  toId: string;
  kind: LoanKind;
  amount: number;
  ratePct: number;
  /** Seconds until it expires (LOAN_OFFER_SEC). */
  timeLeft: number;
}

/** The last flipped card of the current turn. */
export interface CardView {
  /** 1-based flip number in this turn, 0 = no card yet. */
  flipNo: number;
  id: CardId | "";
  rarity: Rarity | "";
  /** What it did to the turn pot ($, after curse / SON MASA). */
  value: number;
  /** Target of an attack card ("" = none / not chosen yet). */
  targetId: string;
}

export interface KasalaStateView {
  phase: Phase;
  code: string;
  hostId: string;
  settings: SettingsView;
  players: MapLike<PlayerView>;
  /** Match participants in seat order (turn order, clockwise). Ghosts stay in it but are skipped. */
  turnOrder: ArrayLike2<string>;
  /** Full round, 1-based (0 in the lobby). */
  round: number;
  /** Classic: total rounds. Battle Royale: ROYALE_MAX_ROUNDS. */
  totalRounds: number;
  /** 0-based turn within the round. */
  turnInRound: number;
  /** Turns in this round (players still in the game when the round started). */
  turnsPerRound: number;
  activeId: string;
  /**
   * Seconds left in the current phase timer (0 when untimed). Quantized to TIMER_QUANTUM_SEC so patches stay
   * cheap: clients count down smoothly on their own between patches.
   */
  timeLeft: number;
  /** The timer's starting value, for rings/bars. */
  timeTotal: number;
  /** An animation lock is running (card flip, attack, lawyer, wheel ascend): the active player's input is ignored. */
  busy: boolean;
  /** Siren level of this turn (0 at turn start, TRAP_LEVEL when trapped). */
  sirenLevel: number;
  /** Chance (0..1) that the NEXT card is a raid. The HUD prints it: "Sonraki kart: %29 BASKIN". */
  raidChance: number;
  /** Battle Royale siren floor bonus (0..1) added to raidChance. */
  floorBonus: number;
  /** Money collected this turn (goes to the kasa on KASALA, to the kumbara on a raid). */
  turnPot: number;
  /** Cards flipped this turn. */
  flips: number;
  /** Lawyers protecting the active player this turn (each cancels one raid). */
  lawyers: number;
  /** The active player is cursed this turn and no money card has eaten the curse yet. */
  curseArmed: boolean;
  /** Patronun Kumbarası. */
  kumbara: number;
  /** Classic SON MASA: everything ×FINAL_TABLE_MULT this round. */
  finalTable: boolean;
  /** Bets are locked (first card flipped). */
  betsLocked: boolean;
  lastCard: CardView;
  /** During targeting: the attack card waiting for a target. */
  pendingCard: CardId | "";
  /** During wheel: the slice that landed ("" while spinning). */
  wheelSlice: WheelSliceId | "";
  /** During lastChance / elimination: the broke player. */
  lastChanceId: string;
  /** This turn's side bets, keyed by playerId. */
  bets: MapLike<BetView>;
  /** Open debts, keyed by DebtView.id. */
  debts: MapLike<DebtView>;
  /** Pending loan offers / requests, keyed by OfferView.id. */
  offers: MapLike<OfferView>;
}

// -------------------------------------------------------------------- messages
export const MSG = {
  // client → server
  READY: "ready",
  ANIMAL: "animal",
  COLOR: "color",
  SETTINGS: "settings",
  START: "start",
  FLIP: "flip",
  CASH: "cash",
  TARGET: "target",
  BET: "bet",
  LOAN_PROPOSE: "loanPropose",
  LOAN_RESPOND: "loanRespond",
  LOAN_CANCEL: "loanCancel",
  LOAN_REPAY: "loanRepay",
  EMOTE: "emote",
  TAUNT: "taunt",
  REMATCH: "rematch",
  /** Host only, lobby only: seat a bot in the first free seat. */
  ADD_BOT: "addBot",
  /** Host only, lobby only: remove a bot (RemoveBotMsg). */
  REMOVE_BOT: "removeBot",
  // server → client
  WELCOME: "welcome",
  TURN_START: "turnStart",
  CARD: "card",
  ATTACK: "attack",
  WHEEL_START: "wheelStart",
  WHEEL_RESULT: "wheelResult",
  CASHED: "cashed",
  RAIDED: "raided",
  BETS_SETTLED: "betsSettled",
  LOAN: "loan",
  TASLIK: "taslik",
  ROUND_END: "roundEnd",
  LAST_CHANCE: "lastChance",
  SAVED: "saved",
  ELIMINATED: "eliminated",
  GHOST_RETURN: "ghostReturn",
  MATCH_END: "matchEnd",
  EMOTED: "emoted",
  TAUNTED: "taunted",
  ANNOUNCER: "announcer",
  NOTICE: "notice",
} as const;

// -------------------------------------------------------------- client → server
export interface CreateOptions {
  nickname: string;
}
export interface JoinOptions {
  nickname: string;
}
export type AddBotMsg = Record<string, never>;
export interface RemoveBotMsg {
  id: string;
}
export interface ReadyMsg {
  ready: boolean;
}
/** Lobby only. Must be free (animals and colors are unique per room). */
export interface AnimalMsg {
  animal: Animal;
}
export interface ColorMsg {
  color: number;
}
/** Host only, lobby only. Any subset; invalid values are ignored. */
export type SettingsMsg = Partial<SettingsView>;
export type StartMsg = Record<string, never>;
/** Active player, phase flipping, not busy. */
export type FlipMsg = Record<string, never>;
/** Active player, phase flipping, not busy. KASALA! */
export type CashMsg = Record<string, never>;
/** Active player, phase targeting. Another player still in the game (not a ghost, not yourself). */
export interface TargetMsg {
  targetId: string;
}
/**
 * Not the active player, phase betting, settings.sideBets. Re-sending replaces the bet (the old stake is
 * refunded first). amount 0 = cancel, or PAS when there is no bet yet (box ignored). amount is one of
 * CHIP_AMOUNTS and ≤ kasa; ghosts always bet GHOST_CHIP. The bet window closes early once every eligible
 * bettor has bet or passed.
 */
export interface BetMsg {
  box: BetBox;
  amount: number;
}
/**
 * settings.loans, any in-match phase. One pending outgoing offer per player. amount ≥ LOAN_MIN, ratePct one of
 * LOAN_RATES. The lender's limit (LOAN_MAX_PCT of their kasa) is checked again on accept.
 */
export interface LoanProposeMsg {
  toId: string;
  kind: LoanKind;
  amount: number;
  ratePct: number;
}
/** Only the offer's toId can respond. */
export interface LoanRespondMsg {
  offerId: string;
  accept: boolean;
}
/** Only the offer's fromId can cancel. */
export interface LoanCancelMsg {
  offerId: string;
}
/** Borrower only. amount is clamped to min(owed, kasa). */
export interface LoanRepayMsg {
  debtId: string;
  amount: number;
}
export interface EmoteMsg {
  emote: EmoteId;
}
/** index into TAUNTS. */
export interface TauntMsg {
  index: number;
}
export type RematchMsg = Record<string, never>;

// -------------------------------------------------------------- server → client
export interface WelcomeMsg {
  you: string;
  code: string;
}
export interface TurnStartMsg {
  playerId: string;
  round: number;
  turnInRound: number;
  sirenLevel: number;
  /** Started at TRAP_LEVEL because of a Tuzak. */
  trapped: boolean;
  /** Lanet is armed for this turn. */
  cursed: boolean;
  /** Lawyers at turn start (wheel "BEDAVA AVUKAT" from an earlier turn). */
  lawyers: number;
  finalTable: boolean;
  /** Side bets are open this turn. */
  betsOpen: boolean;
}
/** Broadcast the moment a card is flipped (clients animate it during FLIP_ANIM_SEC). */
export interface CardMsg {
  playerId: string;
  /** 1-based flip number in this turn. */
  flipNo: number;
  card: CardId;
  rarity: Rarity;
  /** Change to the turn pot ($): money value (0 when the curse hit), the ×2 gain for aklama, 0 otherwise. */
  value: number;
  /** Turn pot after this card. */
  pot: number;
  /** Siren level and next-card raid chance after this card. */
  sirenLevel: number;
  raidChance: number;
  /** A money card that paid 0$ because of a Lanet. */
  curseHit: boolean;
  /** A raid card cancelled by a lawyer (the turn goes on). */
  saved: boolean;
  /** The card waits for TARGET (a "pick" attack card). */
  needsTarget: boolean;
}
/** An attack card took effect (immediately for haracTuru / tuzak, after targeting for harac / lanet / takas). */
export interface AttackMsg {
  card: CardId;
  fromId: string;
  /** "" for haracTuru. */
  targetId: string;
  /** harac: amount taken · takas: the flipper's kasa change · haracTuru: total collected · else 0. */
  amount: number;
  /** haracTuru: who paid what. */
  payers: { playerId: string; amount: number }[];
  /** Turn pot after the attack. */
  pot: number;
  /** The target was chosen randomly because the timer ran out. */
  random: boolean;
}
export interface WheelStartMsg {
  playerId: string;
  /** Decided before the wheel moves (§7). */
  slice: WheelSliceId;
  /** 1 for the first spin, 2+ after "BİR DAHA!". */
  spin: number;
  /** Time to lower the wheel (0 when it is already down). */
  descendMs: number;
  /** Spin time after it is down; the slice lands under the pointer exactly at descendMs + spinMs. */
  spinMs: number;
  /** Full extra rotations for the visual (4..7). */
  turns: number;
}
/** Sent the moment the wheel lands, with the effect already applied. */
export interface WheelResultMsg {
  playerId: string;
  slice: WheelSliceId;
  /** Kasa changes per player ($). */
  deltas: { playerId: string; delta: number }[];
  /** Kumbara change ($). */
  kumbaraDelta: number;
  /** Turn pot after the effect. */
  pot: number;
  /** Another spin follows. */
  again: boolean;
}
export interface CashedMsg {
  playerId: string;
  /** The pot banked. */
  pot: number;
  flips: number;
  /** What actually reached the kasa (pot minus the Taşlık cut). */
  kept: number;
  /** Taşlık: half of the pot paid straight to creditors (reduces the debt). */
  taslikCut: { lenderId: string; amount: number }[];
  /** The decision timer ran out. */
  auto: boolean;
  /** Skipped because the player was disconnected at turn start (0 cards). */
  skipped: boolean;
  /** Length of the result phase that follows (seconds): clients size the celebration to it. */
  resultSec: number;
}
export interface RaidedMsg {
  playerId: string;
  /** Flip number of the raid card. */
  flipNo: number;
  /** Turn pot that went to the kumbara. */
  potLost: number;
  /** Bribe taken from the kasa (also to the kumbara). */
  bribe: number;
  /** Penalty animation, same on every client. */
  anim: RaidAnim;
  /**
   * Length of the result phase that follows (seconds). Short raids (small loss, early card) get a quick
   * at-the-seat version; big / late raids and a player's first raid get the full door sequence.
   */
  resultSec: number;
  /** true = full door sequence (door kick, Komiser Rıfat, camera to the door); false = quick at-the-seat raid. */
  long: boolean;
}
export interface BetResult {
  playerId: string;
  box: BetBox;
  amount: number;
  won: boolean;
  /** Net kasa change on top of the stake already paid: gross winnings on a win, 0 on a loss. Ghosts: 0. */
  delta: number;
  ghost: boolean;
}
export interface BetsSettledMsg {
  activeId: string;
  raided: boolean;
  raidFlip: number;
  results: BetResult[];
  /** HOUSE_CUT_PCT of the losing real-money stakes, paid to the active player. */
  houseCut: number;
  /** The rest of the losing stakes, to the kumbara. */
  toKumbara: number;
}
export type LoanEvent = "proposed" | "accepted" | "declined" | "expired" | "canceled" | "repaid" | "paidOff";
export interface LoanMsg {
  event: LoanEvent;
  /** proposed/accepted/declined/expired/canceled: the offer's from/to/kind. repaid/paidOff: borrower → lender. */
  fromId: string;
  toId: string;
  kind: LoanKind;
  amount: number;
  ratePct: number;
  /** accepted / repaid / paidOff: the debt. */
  debtId: string;
}
export interface TaslikMsg {
  playerId: string;
  on: boolean;
}
export interface RoundEndMsg {
  /** The round that just ended. */
  round: number;
  interest: { debtId: string; before: number; after: number }[];
  /** Battle Royale floor bonus from now on. */
  floorBonus: number;
  /** The next round is the Classic SON MASA. */
  finalTableNext: boolean;
}
export interface LastChanceMsg {
  playerId: string;
}
export interface SavedMsg {
  playerId: string;
  lenderId: string;
}
export interface EliminatedMsg {
  playerId: string;
  /** Players still in the game after this one. */
  remaining: number;
}
export interface GhostReturnMsg {
  playerId: string;
  kasa: number;
}
export interface MatchEndMsg {
  mode: Mode;
  /** Unpaid debts collected at the end: paid to the lender, the rest wiped (borrower → Kara Liste). */
  collections: { debtId: string; lenderId: string; borrowerId: string; paid: number; wiped: number }[];
  /** Shame titles, in reveal order (each at most once, only when earned). */
  titles: { title: TitleId; playerId: string; value: number }[];
  /** Everyone who played, best first. */
  standings: { playerId: string; place: number; kasa: number }[];
  winnerId: string;
}
export interface EmotedMsg {
  playerId: string;
  emote: EmoteId;
}
export interface TauntedMsg {
  playerId: string;
  index: number;
}
/** Server-picked announcer line (shared/announcer.ts), so every client plays the same variation. */
export interface AnnouncerMsg {
  id: string;
  /** The player the line is about ("" = nobody); names are shown on screen, never spoken. */
  playerId: string;
}
/** Short Turkish text toast (errors, "Hostluk X'e geçti", …). */
export interface NoticeMsg {
  text: string;
}

export const JOIN_ERROR = {
  FULL: 4401,
  BAD_NAME: 4402,
} as const;
