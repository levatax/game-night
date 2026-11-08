// Network protocol for Bonk Brawl. FROZEN CONTRACT (see docs/ARCHITECTURE.md).
//
// Client → server: small command messages (ClientMessages).
// Server → client: one-shot messages (ServerMessages). Gameplay events are messages, NOT state;
// they drive VFX/SFX/kill feed. Every gameplay event carries `tick` (server tick it happened on).
// The server may include an extra `type` field equal to the message name; clients must ignore it.

import type {
  AbilityId,
  BallKind,
  CharacterId,
  EmoteId,
  HeldPowerUp,
  KoCause,
  MapId,
  PowerUpType,
  SettingsView,
  Vec3Like,
} from "./types.js";

/** Colyseus room name registered by server/index.ts. */
export const ROOM_NAME = "bonk_brawl";

/** Every message type name. Client→server and server→client share one namespace. */
export const MSG = {
  // ---------------------------------------------------------- client → server
  INPUT: "input",
  READY: "ready",
  CHARACTER: "character",
  SETTINGS: "settings",
  START: "start",
  /** Client sends EmoteMsg; server broadcasts EmoteEvent under the same name. */
  EMOTE: "emote",
  REMATCH: "rematch",
  PONG: "pong",

  // ------------------------------------------------- server → client (meta)
  PING: "ping",
  WELCOME: "welcome",
  NOTICE: "notice",

  // ------------------------------------------- server → client (round flow)
  ROUND_START: "roundStart",
  COUNTDOWN: "countdown",
  SUDDEN_DEATH: "suddenDeath",
  ROUND_WIN: "roundWin",
  MATCH_END: "matchEnd",

  // --------------------------------------------- server → client (gameplay)
  THROW: "throw",
  PICKUP: "pickup",
  HIT: "hit",
  CATCH: "catch",
  WHIFF: "whiff",
  DEFLECT: "deflect",
  RING_OUT: "ringOut",
  KO: "ko",
  ABILITY: "ability",
  SHOCKWAVE: "shockwave",
  HEADBUTT: "headbutt",
  BALL_SPAWN: "ballSpawn",
  BOOMERANG_RETURN: "boomerangReturn",
  POWERUP_WARNING: "powerUpWarning",
  POWERUP_SPAWN: "powerUpSpawn",
  POWERUP_PICKUP: "powerUpPickup",
  RING_SHAKE: "ringShake",
  RING_DROP: "ringDrop",
  BUMP: "bump",
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

/* =========================================================== input buttons */

/**
 * InputCmd.buttons bitmask.
 * THROW and JUMP_HELD are LEVEL bits (set every tick the button is held).
 * CATCH, JUMP, ROLL, ABILITY are EDGE bits: set only in the input of the tick the key went down.
 * JUMP_HELD (jump key still down) drives the variable jump height: releasing it early cuts the jump.
 */
export const BTN = {
  THROW: 1,
  CATCH: 2,
  JUMP: 4,
  ROLL: 8,
  ABILITY: 16,
  JUMP_HELD: 32,
} as const;

/** All edge-triggered bits (cleared when the server repeats a missing input). */
export const EDGE_BUTTONS = BTN.CATCH | BTN.JUMP | BTN.ROLL | BTN.ABILITY;

export function hasButton(buttons: number, bit: number): boolean {
  return (buttons & bit) !== 0;
}

/* ================================================== client → server payloads */

/** Sent once per sim tick (30 Hz) while the local player is alive in countdown/playing/suddenDeath. */
export interface InputCmd {
  /** Monotonic per connection, starts at 1. Server echoes the last consumed seq in player.lastSeq. */
  seq: number;
  /** Camera-relative move: x = strafe right, z = forward. Each in [-1, 1]; server clamps length to 1. */
  moveX: number;
  moveZ: number;
  /** Look yaw/pitch in radians (yaw 0 faces -Z, positive pitch looks up, pitch clamped ±PITCH_LIMIT). */
  yaw: number;
  pitch: number;
  /** BTN bitmask. */
  buttons: number;
}

/** client.create(ROOM_NAME, CreateOptions). */
export interface CreateOptions {
  nickname: string;
  character: CharacterId;
  /** Test-only shortened timers; honored only when process.env.BONK_TEST === "1". */
  fast?: boolean;
}

/** client.joinById(code, JoinOptions). */
export interface JoinOptions {
  nickname: string;
  character: CharacterId;
}

export interface ReadyMsg {
  ready: boolean;
}

/** Lobby only. Duplicate characters are allowed (colors come from slots). */
export interface CharacterMsg {
  character: CharacterId;
}

/** Host only, lobby only. Partial update; invalid fields are ignored. */
export type SettingsMsg = Partial<SettingsView>;

/** Host only. Starts the match when ≥ MIN_PLAYERS_TO_START non-spectators are present and all are ready. */
export type StartMsg = Record<string, never>;

export interface EmoteMsg {
  emote: EmoteId;
}

/**
 * Only during matchEnd (after MATCH_END_MIN_TICKS). Any player may send it: the room returns to the
 * lobby (characters kept, everyone un-readied); then the sender's ready flag is set to `ready`.
 * Podium "Rematch" sends { ready: true }, "Back to lobby" sends { ready: false }.
 */
export interface RematchMsg {
  ready: boolean;
}

/** Reply to PingMsg immediately with the same t. */
export interface PongMsg {
  t: number;
}

export interface ClientMessages {
  input: InputCmd;
  ready: ReadyMsg;
  character: CharacterMsg;
  settings: SettingsMsg;
  start: StartMsg;
  emote: EmoteMsg;
  rematch: RematchMsg;
  pong: PongMsg;
}

/* ============================================== server → client: meta */

/** Every PING_INTERVAL_MS. `t` is the server's Date.now(); `tick` its current sim tick (clock sync). */
export interface PingMsg {
  t: number;
  tick: number;
}

/** Sent to a client right after it joins (or reconnects). */
export interface WelcomeMsg {
  /** 4-letter room code (=== roomId). */
  code: string;
  sessionId: string;
  tick: number;
  tickRate: number;
  /** Server is running shortened test timers. */
  fast: boolean;
  /** True when this join was a reconnection. */
  reconnected: boolean;
}

export type NoticeKind =
  | "joined"
  | "left"
  | "reconnecting"
  | "reconnected"
  | "dropped"
  | "hostChanged"
  | "cantStart"
  | "spectating"
  | "rematch"
  | "info";

/** Toast-worthy room notices. `text` is ready-to-show English. */
export interface NoticeMsg {
  kind: NoticeKind;
  /** Player concerned, if any. */
  playerId?: string;
  text: string;
}

/* ======================================== server → client: round flow */

/** Phase entered countdown for `round`: players are placed at spawns, balls are about to drop. */
export interface RoundStartEvent {
  tick: number;
  round: number;
  totalRounds: number;
  mapId: MapId;
  /** sessionIds playing this round (alive at start). */
  participants: string[];
}

/** n = 3, 2, 1 during countdown (one per second), then 0 = "BONK!" (fight starts). */
export interface CountdownEvent {
  tick: number;
  round: number;
  n: number;
}

/** 60 s are up: rings start crumbling and an extra ball drops. */
export interface SuddenDeathEvent {
  tick: number;
  round: number;
}

export interface RoundWinEvent {
  tick: number;
  round: number;
  /** "" = draw (everyone left was eliminated on the same tick). */
  winnerId: string;
  /** Last player eliminated and where (for the KO camera cut); "" / null if none. */
  finalVictimId: string;
  finalPos: Vec3Like | null;
  /** Points earned this round per sessionId (incl. the +3 win bonus). */
  roundPoints: Record<string, number>;
  /** Next round number, or 0 if the match is over. */
  nextRound: number;
}

export interface StandingEntry {
  id: string;
  /** 1..4; ties broken by round wins, then catches, then earlier slot. */
  place: number;
  points: number;
  roundWins: number;
  catches: number;
}

export interface MatchEndEvent {
  tick: number;
  winnerId: string;
  /** Sorted by place. */
  standings: StandingEntry[];
}

/* ========================================== server → client: gameplay */

export interface ThrowEvent {
  tick: number;
  ownerId: string;
  character: CharacterId;
  /** InputCmd.seq that released the throw (match predicted balls by ownerId + throwSeq + throwIndex). */
  throwSeq: number;
  /** One id (or 3 for Triple Shot: index 0 center, 1 left, 2 right), aligned with `velocities`. */
  ballIds: string[];
  /** Charge fraction 0..1. */
  charge: number;
  kind: BallKind;
  /** Power-up consumed by this throw ("" none). */
  powerUp: HeldPowerUp;
  curve: boolean;
  origin: Vec3Like;
  velocities: Vec3Like[];
}

export interface PickupEvent {
  tick: number;
  playerId: string;
  ballId: string;
  pos: Vec3Like;
}

export interface HitEvent {
  tick: number;
  ballId: string;
  throwerId: string;
  targetId: string;
  /** Contact point. */
  pos: Vec3Like;
  /** Knockback velocity applied to the target. */
  knockback: Vec3Like;
  /** |knockback| (m/s, ≤ KNOCK_MAX_SPEED): impact intensity for hit-stop / shake. */
  launchSpeed: number;
  charge: number;
  kind: BallKind;
  /** Target hearts after the hit (0 → a KoEvent follows on the same tick). */
  heartsLeft: number;
  /** charge >= FULL_CHARGE_THRESHOLD. */
  fullCharge: boolean;
}

export interface CatchEvent {
  tick: number;
  ballId: string;
  catcherId: string;
  throwerId: string;
  /** Ball position at the catch. */
  pos: Vec3Like;
  /** Thrower hearts after losing one (0 → a KoEvent with cause "caught" follows). */
  throwerHeartsLeft: number;
  /** Rewind ticks used by lag compensation (debug/telemetry). */
  rewindTicks: number;
  /** false if the catcher's hands were full: the ball dropped as neutral at their feet. */
  kept: boolean;
}

/** Catch window expired without a catch. */
export interface WhiffEvent {
  tick: number;
  playerId: string;
  pos: Vec3Like;
}

/**
 * A live ball bounced off a player harmlessly (ball is now dead): Mochi's Belly Bounce, or a
 * sibling ball of a throw that player just caught (Triple Shot side balls). Clients pick the
 * Mochi feedback when the player is Mochi with the ability active, else a small "boing".
 */
export interface DeflectEvent {
  tick: number;
  ballId: string;
  playerId: string;
  pos: Vec3Like;
}

/** Player fell below RING_OUT_Y. Exactly one of RingOutEvent / KoEvent is sent per elimination. */
export interface RingOutEvent {
  tick: number;
  playerId: string;
  /** Last hitter/knocker within RING_OUT_CREDIT_TICKS ("" = fell on their own). Earns POINTS.ringOut. */
  creditId: string;
  /** Last grounded position (where they fell from). */
  pos: Vec3Like;
}

/** Player eliminated by losing all hearts (or by a disconnect timeout). */
export interface KoEvent {
  tick: number;
  playerId: string;
  /** Who dealt the final heart ("" for disconnect). */
  byId: string;
  cause: KoCause;
  pos: Vec3Like;
}

export interface EmoteEvent {
  tick: number;
  playerId: string;
  emote: EmoteId;
}

export interface AbilityEvent {
  tick: number;
  playerId: string;
  character: CharacterId;
  ability: AbilityId;
  pos: Vec3Like;
  /** Unit direction of dash/lunge/slide, or aim direction for armed abilities. */
  dir: Vec3Like;
}

/** Hopsworth's Ground Pound landed. */
export interface ShockwaveEvent {
  tick: number;
  playerId: string;
  pos: Vec3Like;
  radius: number;
  /** Players knocked back. */
  affected: string[];
  /** Launch velocity of each affected player, aligned with `affected`. */
  knockbacks: Vec3Like[];
}

/** Gruff's Headbutt connected. */
export interface HeadbuttEvent {
  tick: number;
  attackerId: string;
  targetId: string;
  pos: Vec3Like;
  knockback: Vec3Like;
  /** |knockback| (m/s). */
  launchSpeed: number;
}

/**
 * A stunned (tumbling) body crashed into another player and passed on momentum (server only, no
 * points). Ring-out credit flows to whoever launched the tumbling body.
 */
export interface BumpEvent {
  tick: number;
  /** The tumbling / faster body. */
  playerId: string;
  /** The body it crashed into. */
  targetId: string;
  /** Contact midpoint at chest height. */
  pos: Vec3Like;
  /** Normal impulse per unit mass exchanged (m/s). */
  impulse: number;
}

/** A ball starts dropping from the sky (round start, respawn, sudden-death extra). */
export interface BallSpawnEvent {
  tick: number;
  ballId: string;
  pos: Vec3Like;
}

/** A boomerang ball turned around (or was auto-caught back by its owner when `caught`). */
export interface BoomerangReturnEvent {
  tick: number;
  ballId: string;
  ownerId: string;
  pos: Vec3Like;
  caught: boolean;
}

export interface PowerUpWarningEvent {
  tick: number;
  id: string;
  type: PowerUpType;
  pedestal: number;
  pos: Vec3Like;
}

export interface PowerUpSpawnEvent {
  tick: number;
  id: string;
  type: PowerUpType;
  pedestal: number;
  pos: Vec3Like;
}

export interface PowerUpPickupEvent {
  tick: number;
  id: string;
  playerId: string;
  type: PowerUpType;
  pos: Vec3Like;
}

/** Ring starts shaking (RING_SHAKE_TICKS before it drops). */
export interface RingShakeEvent {
  tick: number;
  ring: number;
}

export interface RingDropEvent {
  tick: number;
  ring: number;
}

/* ================================================= server → client map */

/** Every server → client message, keyed by MSG name. */
export interface ServerMessages {
  ping: PingMsg;
  welcome: WelcomeMsg;
  notice: NoticeMsg;
  roundStart: RoundStartEvent;
  countdown: CountdownEvent;
  suddenDeath: SuddenDeathEvent;
  roundWin: RoundWinEvent;
  matchEnd: MatchEndEvent;
  throw: ThrowEvent;
  pickup: PickupEvent;
  hit: HitEvent;
  catch: CatchEvent;
  whiff: WhiffEvent;
  deflect: DeflectEvent;
  ringOut: RingOutEvent;
  ko: KoEvent;
  emote: EmoteEvent;
  ability: AbilityEvent;
  shockwave: ShockwaveEvent;
  headbutt: HeadbuttEvent;
  ballSpawn: BallSpawnEvent;
  boomerangReturn: BoomerangReturnEvent;
  powerUpWarning: PowerUpWarningEvent;
  powerUpSpawn: PowerUpSpawnEvent;
  powerUpPickup: PowerUpPickupEvent;
  ringShake: RingShakeEvent;
  ringDrop: RingDropEvent;
  bump: BumpEvent;
}

export type ServerMessageType = keyof ServerMessages;

/** Server → client gameplay events produced by the world simulation (subset of ServerMessages). */
export type WorldEventType =
  | "throw"
  | "pickup"
  | "hit"
  | "catch"
  | "whiff"
  | "deflect"
  | "ringOut"
  | "ko"
  | "ability"
  | "shockwave"
  | "headbutt"
  | "ballSpawn"
  | "boomerangReturn"
  | "powerUpWarning"
  | "powerUpSpawn"
  | "powerUpPickup"
  | "ringShake"
  | "ringDrop"
  | "bump";

/* ================================================================ errors */

/**
 * Join/create rejection codes (server throws ServerError(code, message) in onAuth/onJoin;
 * colyseus.js rejects with MatchMakeError having this `code`). Colyseus' own codes (e.g. room
 * not found 4212, room full/locked) are mapped by the client to the same user messages.
 */
export const JOIN_ERROR = {
  ROOM_FULL: 4401,
  BAD_NICKNAME: 4402,
  BAD_CHARACTER: 4403,
  NOT_FOUND: 4404,
} as const;

export const JOIN_ERROR_TEXT: Readonly<Record<number, string>> = {
  [JOIN_ERROR.ROOM_FULL]: "Room full",
  [JOIN_ERROR.BAD_NICKNAME]: "Pick a nickname (1–16 characters)",
  [JOIN_ERROR.BAD_CHARACTER]: "Unknown character",
  [JOIN_ERROR.NOT_FOUND]: "No room with that code",
};
