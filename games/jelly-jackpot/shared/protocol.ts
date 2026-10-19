// Jelly Jackpot network protocol: phases, synced state shapes and messages. FROZEN CONTRACT.
// server/schema.ts implements the *View interfaces field-for-field (checked at compile time there).
// The client reads room.state through these interfaces only.

import type { CardId, EmoteId, PieceType, Rarity } from "./constants.js";

export { ROOM_NAME } from "./constants.js";

// ---------------------------------------------------------------------- phases
/**
 * lobby       → host presses Start (≥ MIN_PLAYERS connected, everyone ready)
 * roleReveal  → ROLE_REVEAL_SEC, each client got a private ROLE message
 * spinning    → spinStage "idle" (wait for SPIN or SPIN_IDLE_SEC) → "rolling" (SPIN_START broadcast;
 *               rig window RIG_WINDOW_SEC; then SPIN_RESULT) → "landed" (until SPIN_SEC + CARD_READ_SEC after SPIN_START)
 * placing     → turn timer; active player hovers (HOVER) and drops (DROP); others BET
 * settling    → server physics until asleep or SETTLE_MAX_SEC
 * result      → RESULT_SEC; RESULT + BETS broadcast at entry. Then next turn (spinning) / next round / voting
 * voting      → VOTE_SEC (skipped straight to reveal when there is no Saboteur)
 * reveal      → REVEAL_SEC; REVEAL broadcast at entry
 * matchEnd    → podium; REMATCH (host) → lobby with coins reset
 */
export type Phase = "lobby" | "roleReveal" | "spinning" | "placing" | "settling" | "result" | "voting" | "reveal" | "matchEnd";
export type SpinStage = "idle" | "rolling" | "landed";
export type Role = "baker" | "saboteur";
export type BetSide = "stand" | "fall";

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
  survived: number;
  topples: number;
  /** ×10 to stay an integer: 15 = ×1.5 */
  bestMultiplierX10: number;
  betProfit: number;
}

export interface PlayerView {
  id: string;
  nickname: string;
  /** 0..5, index into PLAYER_COLORS. Unique per room. */
  color: number;
  /** Seat around the table, 0..5 (join order, compacted). */
  seat: number;
  ready: boolean;
  connected: boolean;
  /** Joined mid-match: watches until the next match. */
  spectator: boolean;
  coins: number;
  /** Has placed a (hidden) side bet this turn. Side/amount stay secret until BETS. */
  hasBet: boolean;
  /** Has voted during the accusation vote. */
  voted: boolean;
  /** Final standing (1 = winner), 0 until matchEnd. */
  place: number;
  stats: StatsView;
}

export interface SettingsView {
  /** 0 = auto (autoRounds). */
  rounds: number;
  /** One of TURN_TIMER_OPTIONS. */
  turnTimer: number;
  saboteur: boolean;
  sideBets: boolean;
}

/** A physics piece on the tower, in the stand-LOCAL frame. */
export interface PieceView {
  id: string;
  type: PieceType;
  ownerId: string;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  scale: number;
  /** Card that modified this piece when it was dropped ("" = none), e.g. "jellyMode", "glueGun", "butterFingers". Visual only. */
  card: string;
  asleep: boolean;
}

/** The active player's hovering piece (relayed from HOVER). Stand-local frame. */
export interface HoverView {
  active: boolean;
  type: PieceType;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  scale: number;
}

export interface CardView {
  /** "" until SPIN_RESULT for this turn. */
  id: string;
  rarity: string;
  multiplier: number;
}

export interface JellyStateView {
  phase: Phase;
  code: string;
  hostId: string;
  settings: SettingsView;
  players: MapLike<PlayerView>;
  turnOrder: ArrayLike2<string>;
  /** 1-based. */
  round: number;
  totalRounds: number;
  /** 0-based turn within the round. */
  turnInRound: number;
  turnsPerRound: number;
  activeId: string;
  /** Seconds left in the current phase timer (0 when untimed). */
  timeLeft: number;
  /** The timer's starting value, for rings/bars. */
  timeTotal: number;
  spinStage: SpinStage;
  card: CardView;
  /** Piece the active player holds now ("" outside placing). */
  currentPiece: string;
  /** The piece after it (bag preview). */
  nextPiece: string;
  /** Pieces still to place this turn (Double Decker = 2). */
  piecesLeft: number;
  hover: HoverView;
  pieces: MapLike<PieceView>;
  /** Visual stand angle in radians (server integrates STAND_SPEED / Spin Cycle). */
  standAngle: number;
  /** deg/s, for audio hum pitch. */
  standSpeed: number;
  /** Tower height above the cake top, in cm. */
  towerHeightCm: number;
  /** Coins the active player wins if the tower stands (already × multiplier). */
  payoutPreview: number;
  /** Wind Storm: force direction (stand-local xz, unit) and strength 0..1 (0 = calm). */
  windX: number;
  windZ: number;
  wind: number;
  /** Earthquake shaking right now. */
  quake: boolean;
  /** Gravity scale right now (1 or MOON_GRAVITY_SCALE). */
  gravityScale: number;
}

// -------------------------------------------------------------- client → server
export const MSG = {
  // client → server
  READY: "ready",
  COLOR: "color",
  SETTINGS: "settings",
  START: "start",
  SPIN: "spin",
  HOVER: "hover",
  DROP: "drop",
  RIG: "rig",
  BET: "bet",
  VOTE: "vote",
  EMOTE: "emote",
  REMATCH: "rematch",
  // server → client
  WELCOME: "welcome",
  ROLE: "role",
  RIG_STATUS: "rigStatus",
  SPIN_START: "spinStart",
  SPIN_RESULT: "spinResult",
  DROPPED: "dropped",
  IMPACT: "impact",
  HICCUP: "hiccup",
  TOPPLE: "topple",
  RESULT: "result",
  BETS: "bets",
  VOTES: "votes",
  REVEAL: "reveal",
  EMOTED: "emoted",
  NOTICE: "notice",
} as const;

export interface CreateOptions {
  nickname: string;
}
export interface JoinOptions {
  nickname: string;
}
export interface ReadyMsg {
  ready: boolean;
}
export interface ColorMsg {
  color: number;
}
/** Host only, lobby only. Any subset. */
export type SettingsMsg = Partial<SettingsView>;
export type StartMsg = Record<string, never>;
/** Active player, phase spinning + spinStage idle. */
export type SpinMsg = Record<string, never>;
/** A pose in the stand-local frame. The server clamps it into the legal hover volume. */
export interface Pose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}
/** Active player, phase placing, ~HOVER_SEND_HZ. */
export type HoverMsg = Pose;
/** Active player, phase placing. Pose is clamped like HOVER. */
export type DropMsg = Pose;
/** Saboteur only, once per round, during someone else's spin (stage idle or rolling before SPIN_RESULT). */
export type RigMsg = Record<string, never>;
/** Not the active player, phase spinning/placing (before the drop), settings.sideBets. Re-sending replaces the bet. amount 0 = cancel. */
export interface BetMsg {
  side: BetSide;
  amount: number;
}
/** Phase voting. suspectId must be another player in the match. Re-sending changes the vote. */
export interface VoteMsg {
  suspectId: string;
}
export interface EmoteMsg {
  emote: EmoteId;
}
export type RematchMsg = Record<string, never>;

// -------------------------------------------------------------- server → client
export interface WelcomeMsg {
  you: string;
  code: string;
}
/** Private, sent at roleReveal entry (and again on reconnect). */
export interface RoleMsg {
  role: Role;
}
/** Private to the Saboteur. available = can rig this round; used = already rigged this round. */
export interface RigStatusMsg {
  available: boolean;
  used: boolean;
  /** Set when replying to a RIG: whether it was accepted, and why not. */
  accepted?: boolean;
  reason?: string;
  /** Translation key for `reason` (client i18n "server" section). */
  reasonKey?: string;
}
/** Broadcast when the reel starts. Clients start a fast blur scroll with no known target. */
export interface SpinStartMsg {
  playerId: string;
  /** Milliseconds until the card lands (SPIN_SEC * 1000). */
  durationMs: number;
}
/** Broadcast after the rig window. The reel decelerates so `strip[winIndex]` stops under the marker exactly `landInMs` from now. */
export interface SpinResultMsg {
  playerId: string;
  card: CardId;
  rarity: Rarity;
  multiplier: number;
  /** REEL_LENGTH card ids; strip[REEL_WIN_INDEX] === card. */
  strip: CardId[];
  winIndex: number;
  landInMs: number;
}
export interface DroppedMsg {
  playerId: string;
  pieceId: string;
  type: PieceType;
  /** Pieces still to place this turn after this drop. */
  piecesLeft: number;
}
/** A notable contact during settling (for funny per-piece sounds). Throttled server side. */
export interface ImpactMsg {
  pieceId: string;
  type: PieceType;
  /** Relative contact speed m/s. */
  speed: number;
  x: number;
  y: number;
  z: number;
}
/** Hiccups card: the server made the hover piece hop (client plays *hic*). */
export interface HiccupMsg {
  playerId: string;
}
/** The tower fell: first piece crossed TOPPLE_Y. Sent the moment it happens (freeze frame + TIMBER!). */
export interface ToppleMsg {
  playerId: string;
  pieceId: string;
  x: number;
  y: number;
  z: number;
}
export interface ResultMsg {
  playerId: string;
  outcome: BetSide;
  /** Coin change for the active player (negative on topple, 0 with Insurance). */
  delta: number;
  card: CardId;
  multiplier: number;
  heightCm: number;
  insured: boolean;
  /** True when the tower is cleared and a fresh cake slides in. */
  reset: boolean;
}
export interface BetResult {
  playerId: string;
  side: BetSide;
  amount: number;
  won: boolean;
  /** +amount*(BET_PAYOUT-1) on a win (net), -amount on a loss. */
  delta: number;
}
export interface BetsMsg {
  bets: BetResult[];
}
export interface VotesMsg {
  votes: { voterId: string; suspectId: string }[];
  /** Most-voted id, "" on a tie / no votes. */
  majorityId: string;
}
export interface RigRecord {
  round: number;
  victimId: string;
  card: CardId;
  outcome: BetSide;
}
export interface CoinAdjustment {
  playerId: string;
  delta: number;
  /** English text (fallback). */
  reason: string;
  /** Translation key (client i18n "server" section). */
  key?: string;
}
export interface RevealMsg {
  /** "" when there was no Saboteur this match. */
  saboteurId: string;
  rigs: RigRecord[];
  /** Hidden bonus the Saboteur earned (before the vote outcome). */
  hiddenBonus: number;
  caught: boolean;
  adjustments: CoinAdjustment[];
}
export interface EmotedMsg {
  playerId: string;
  emote: EmoteId;
}
export interface NoticeMsg {
  /** English text (fallback). */
  text: string;
  /** Translation key (client i18n "server" section) + its params, so clients can show it in their language. */
  key?: string;
  params?: Record<string, string | number>;
}

export const JOIN_ERROR = {
  FULL: 4401,
  BAD_NAME: 4402,
} as const;
