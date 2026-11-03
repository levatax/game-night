// Network protocol for Raft Rush. FROZEN CONTRACT (see docs/ARCHITECTURE.md).
//
// Client → server: small command messages (ClientMessages).
// Server → client: one-shot messages (ServerMessages). Gameplay events are messages, NOT state; they drive
// VFX / SFX / feed lines. Every gameplay event carries `tick` (the server tick it happened on). The server
// may include an extra `type` field equal to the message name; clients must ignore it.

import type {
  BottleEffect,
  CharacterId,
  DayEventKind,
  DayPhase,
  EmoteId,
  FishLoot,
  HurtCause,
  InteractKind,
  ItemKind,
  Layout,
  Biome,
  MarkerKind,
  MonsterKind,
  RaftStage,
  RecipeId,
  SettingsView,
  StatsView,
  StructureKind,
  TitleId,
  TreasureId,
  Vec3Like,
  Weather,
  WinReason,
} from "./types.js";

/** Colyseus room name registered by server/index.ts. */
export const ROOM_NAME = "raft_rush";

/**
 * Wire protocol version. Bump it whenever a message or schema field changes incompatibly. The client sends it in
 * Create/JoinOptions (a mismatch is rejected with JOIN_ERROR.OUTDATED) and the server echoes it in WelcomeMsg, so a
 * stale cached client after a deploy is told to refresh instead of failing at random.
 */
export const PROTOCOL_VERSION = 1;

/** Every message type name. Client→server and server→client share one namespace. */
export const MSG = {
  // ---------------------------------------------------------- client → server
  INPUT: "input",
  READY: "ready",
  CHARACTER: "character",
  SETTINGS: "settings",
  START: "start",
  ADD_BOT: "addBot",
  REMOVE_BOT: "removeBot",
  REMATCH: "rematch",
  PONG: "pong",
  CRAFT: "craft",
  CHEST: "chest",
  /** Client sends MarkerMsg; server broadcasts MarkerEvent under the same name. */
  MARKER: "marker",
  /** Client sends EmoteMsg; server broadcasts EmoteEvent under the same name. */
  EMOTE: "emote",

  // ------------------------------------------------- server → client (meta)
  PING: "ping",
  WELCOME: "welcome",
  NOTICE: "notice",

  // ------------------------------------------- server → client (match flow)
  MATCH_START: "matchStart",
  DAY_PHASE: "dayPhase",
  WEATHER: "weather",
  DAY_EVENT: "dayEvent",
  STORM_WARNING: "stormWarning",
  RAFT_READY: "raftReady",
  BOARD: "board",
  RAFT_LAUNCH: "raftLaunch",
  STORM: "storm",
  MATCH_END: "matchEnd",

  // --------------------------------------------- server → client (gameplay)
  THROW: "throw",
  HIT: "hit",
  SPLASH: "splash",
  STICK: "stick",
  PICKUP: "pickup",
  CATCH: "catch",
  GATHER: "gather",
  PALM_SHAKE: "palmShake",
  USE: "use",
  EAT: "eat",
  CRAFTED: "crafted",
  FIRE_FUEL: "fireFuel",
  CHEST_CHANGED: "chestChanged",
  DELIVER: "deliver",
  RAFT_DAMAGE: "raftDamage",
  STRUCTURE_PLACED: "structurePlaced",
  STRUCTURE_HIT: "structureHit",
  STRUCTURE_DESTROYED: "structureDestroyed",
  MONSTER_SPAWN: "monsterSpawn",
  MONSTER_HURT: "monsterHurt",
  MONSTER_FLIP: "monsterFlip",
  MONSTER_DIE: "monsterDie",
  MONSTER_ATTACK: "monsterAttack",
  STEAL: "steal",
  PLAYER_HURT: "playerHurt",
  PLAYER_DOWNED: "playerDowned",
  PLAYER_REVIVED: "playerRevived",
  PLAYER_WASHED: "playerWashed",
  PLAYER_RESPAWN: "playerRespawn",
  LOW_BAR: "lowBar",
  BLAST: "blast",
  FISH_CAST: "fishCast",
  FISH_BITE: "fishBite",
  FISH_RESULT: "fishResult",
  FISH_MISS: "fishMiss",
  TREASURE: "treasure",
  BOTTLE: "bottle",
  REJECT: "reject",
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

/* =========================================================== input buttons */

/**
 * InputCmd.buttons bitmask.
 * LEVEL bits (set every tick the key is held): THROW (LMB), INTERACT (E), SPRINT (Shift).
 * EDGE bits (set only in the input of the tick the key went down; the client latches them until the next
 * sample so a sub-tick tap is never lost): USE_PRESS (LMB down), CATCH (RMB), JUMP, INTERACT_PRESS (E down),
 * DROP (Q), EAT (F), SLOT1–4, SLOT_NEXT / SLOT_PREV (wheel).
 */
export const BTN = {
  THROW: 1,
  USE_PRESS: 2,
  CATCH: 4,
  JUMP: 8,
  INTERACT: 16,
  INTERACT_PRESS: 32,
  SPRINT: 64,
  DROP: 128,
  EAT: 256,
  SLOT1: 512,
  SLOT2: 1024,
  SLOT3: 2048,
  SLOT4: 4096,
  SLOT_NEXT: 8192,
  SLOT_PREV: 16384,
} as const;

/** Every bit the server accepts. */
export const BUTTON_MASK = 0x7fff;
/** All edge-triggered bits (cleared when the server repeats a missing input). */
export const EDGE_BUTTONS =
  BTN.USE_PRESS |
  BTN.CATCH |
  BTN.JUMP |
  BTN.INTERACT_PRESS |
  BTN.DROP |
  BTN.EAT |
  BTN.SLOT1 |
  BTN.SLOT2 |
  BTN.SLOT3 |
  BTN.SLOT4 |
  BTN.SLOT_NEXT |
  BTN.SLOT_PREV;

export function hasButton(buttons: number, bit: number): boolean {
  return (buttons & bit) !== 0;
}

/* ================================================== client → server payloads */

/** Sent once per sim tick (30 Hz) while the local player is an alive participant in landing / playing. */
export interface InputCmd {
  /** Strictly increasing per page lifetime, starts at 1. Server echoes the last consumed seq in player.lastSeq. */
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
  /** Test-only shortened timers; honored only when process.env.RAFT_TEST === "1". */
  fast?: boolean;
  /** Test-only rng seed for loot / bots / weather (RAFT_TEST=1 only). */
  testSeed?: number;
  /** The client's PROTOCOL_VERSION (absent = a client from before versioning: accepted). */
  protocol?: number;
}

/** client.joinById(code, JoinOptions). */
export interface JoinOptions {
  nickname: string;
  character: CharacterId;
  /** The client's PROTOCOL_VERSION (absent = a client from before versioning: accepted). */
  protocol?: number;
}

export interface ReadyMsg {
  ready: boolean;
}

/** Lobby only. Duplicate characters are allowed (colors come from seats). */
export interface CharacterMsg {
  character: CharacterId;
}

/** Host only, lobby only. Partial update; invalid fields are ignored. mode "duel" is rejected for now. */
export type SettingsMsg = Partial<SettingsView>;

/** Host only. Starts when every human is ready. A lone human with no bots gets SOLO_AUTO_BOTS helpers. */
export type StartMsg = Record<string, never>;

/** Host only, lobby only: add a helper bot (next free seat, next name/role). */
export type AddBotMsg = Record<string, never>;
export interface RemoveBotMsg {
  id: string;
}

/**
 * Only during matchEnd (after Timings.matchEndMin). Any player may send it: the room returns to the lobby
 * (characters kept, everyone un-readied); then the sender's ready flag is set to `ready`.
 */
export interface RematchMsg {
  ready: boolean;
}

/** Reply to PingMsg immediately with the same t. */
export interface PongMsg {
  t: number;
}

/** Craft at the team campfire (within CRAFT_RANGE, fire lit). Result: CraftedEvent or RejectEvent. */
export interface CraftMsg {
  recipe: RecipeId;
}

/**
 * Camp chest (within CHEST_RANGE). put: from the active slot, or pocket `slot` when given (`count` units, default
 * all); take: `kind` into the inventory (`count`, default as many as fit); putAll: every material / food / water
 * item in the inventory.
 */
export interface ChestMsg {
  op: "put" | "take" | "putAll";
  kind?: ItemKind;
  count?: number;
  /**
   * put only: the pocket to put from, 0..SLOTS-1 (shared/rules/inventory.ts); absent = the active slot. With a
   * slot, a `kind` must be what that pocket holds when the message arrives (else reject "empty"), so a put never
   * takes something else from a pocket that changed on the way.
   */
  slot?: number;
}

/** Ping wheel. `pos` is where the crosshair ray hit (clamped to 60 m). `need` for kind "need" (what you looked at). */
export interface MarkerMsg {
  kind: MarkerKind;
  pos: Vec3Like;
  need?: ItemKind | "";
}

export interface EmoteMsg {
  emote: EmoteId;
}

export interface ClientMessages {
  input: InputCmd;
  ready: ReadyMsg;
  character: CharacterMsg;
  settings: SettingsMsg;
  start: StartMsg;
  addBot: AddBotMsg;
  removeBot: RemoveBotMsg;
  rematch: RematchMsg;
  pong: PongMsg;
  craft: CraftMsg;
  chest: ChestMsg;
  marker: MarkerMsg;
  emote: EmoteMsg;
}

/* ============================================== server → client: meta */

/** Every PING_INTERVAL_MS. `t` is the server's Date.now(); `tick` its current sim tick (clock sync). */
export interface PingMsg {
  t: number;
  tick: number;
}

/** Sent to a client right after it joins (or reconnects), and again to everyone at each match start. */
export interface WelcomeMsg {
  /** 4-letter room code (=== roomId). */
  code: string;
  sessionId: string;
  tick: number;
  tickRate: number;
  fast: boolean;
  reconnected: boolean;
  /** Island currently loaded (lobby preview or the match island). */
  seed: number;
  layout: Layout;
  /** FNV-1a of the heightfield Float32Array bytes; the client compares with its own generateIsland(). */
  gridHash: number;
  /** Hash of node / site / fish-spot placement (see shared/island/generate.ts defHash). */
  defHash: number;
  /** The server's PROTOCOL_VERSION (the client shows "refresh" on a mismatch). */
  protocol: number;
}

/**
 * Toast / feed-worthy room notices. `key` indexes client/src/i18n/strings/server.ts (`server.<key>`), `params`
 * fill its {placeholders}. `text` is the ready-to-show English line (fallback).
 */
export interface NoticeMsg {
  key: string;
  params?: Record<string, string | number>;
  text: string;
}

/* ======================================== server → client: match flow */

/** landing began: everyone is placed at the wreck. */
export interface MatchStartEvent {
  tick: number;
  seed: number;
  layout: Layout;
  biome: Biome;
  /** Player ids in the match (bots included). */
  participants: string[];
  /** Raft seats (sizes the raft costs). */
  seats: number;
}

/** Day phase changed (also sent at playing start with day 1 / "day"). */
export interface DayPhaseEvent {
  tick: number;
  day: number;
  dayPhase: DayPhase;
}

export interface WeatherEvent {
  tick: number;
  day: number;
  weather: Weather;
}

/** A daytime mini-event started (gull / monkeys spawn as monsters, waveGift spawns item projectiles). */
export interface DayEventEvent {
  tick: number;
  kind: DayEventKind;
  pos: Vec3Like;
  /** Victim for the gull ("" otherwise). */
  playerId: string;
}

/** One step of the warning ladder (v4 §3): 30 s before night 1, 20 s before night 2, 15 s before the storm. */
export interface StormWarningEvent {
  tick: number;
  secondsLeft: number;
  /** 1 / 2 = a night is coming; 3 = the final storm. */
  night: number;
}

export interface RaftReadyEvent {
  tick: number;
  team: number;
}

export interface BoardEvent {
  tick: number;
  playerId: string;
  team: number;
  /** Boarding countdown started by this boarding (LAUNCH_WAIT_TICKS), 0 if everyone is aboard now. */
  launchTicksLeft: number;
}

export interface RaftLaunchEvent {
  tick: number;
  team: number;
  aboard: string[];
  /** Left on the beach ("Wilson finale"). */
  left: string[];
}

/** Night 3 ended without a launch. */
export interface StormEvent {
  tick: number;
}

export interface StandingEntry {
  id: string;
  /** 1..n by MVP score (ties: delivered, then lower seat). */
  place: number;
  score: number;
  team: number;
  titles: TitleId[];
  stats: StatsView;
  aboard: boolean;
}

export interface MatchEndEvent {
  tick: number;
  /** Winning team, -1 = the storm won. */
  winnerTeam: number;
  reason: WinReason;
  /** Ticks that were left before the storm at the launch (0 on a loss). */
  ticksLeft: number;
  teamScores: number[];
  mvpId: string;
  /** Sorted by place. */
  standings: StandingEntry[];
  seed: number;
  biome: Biome;
}

/* ========================================== server → client: gameplay */

export interface ThrowEvent {
  tick: number;
  ownerId: string;
  /** InputCmd.seq that released it (match predicted projectiles by ownerId + throwSeq + index). */
  throwSeq: number;
  /** One id per projectile (3 for a coconut ball), aligned with `velocities`. */
  projectileIds: string[];
  kind: ItemKind;
  /** Charge fraction 0..1 (0 for a toss). */
  charge: number;
  /** Q toss / pass (fixed speed). */
  toss: boolean;
  origin: Vec3Like;
  velocities: Vec3Like[];
}

export type HitTargetType = "player" | "monster" | "structure" | "palm" | "tree" | "rock";

/** A live projectile hit something (it becomes loose / stuck / explodes on the same tick). */
export interface HitEvent {
  tick: number;
  projectileId: string;
  kind: ItemKind;
  throwerId: string;
  targetType: HitTargetType;
  /** Player / monster / structure id, or the node index as a string. */
  targetId: string;
  pos: Vec3Like;
  /** Damage applied (0 for friendly fire / bait / nodes). */
  damage: number;
  knockback: Vec3Like;
  charge: number;
}

/** A projectile sank (removed). Fallen-into-the-sea coconuts are not respawned (palms regrow). */
export interface SplashEvent {
  tick: number;
  projectileId: string;
  kind: ItemKind;
  pos: Vec3Like;
}

/** A spear stuck into terrain, a trunk or a monster. */
export interface StickEvent {
  tick: number;
  projectileId: string;
  pos: Vec3Like;
}

/** Item into an inventory: from the ground (E), a flipped crab, the spring, a collector, a catch… */
export interface PickupEvent {
  tick: number;
  playerId: string;
  kind: ItemKind;
  count: number;
  pos: Vec3Like;
  /** Ground projectile picked up ("" otherwise). */
  projectileId: string;
  source: "ground" | "crab" | "spring" | "chest" | "craft" | "fish" | "treasure" | "catch";
}

/** Right-click caught an in-flight projectile (it went to the inventory, or bounced off when full). */
export interface CatchEvent {
  tick: number;
  playerId: string;
  projectileId: string;
  kind: ItemKind;
  throwerId: string;
  pos: Vec3Like;
  kept: boolean;
}

/** A gather channel completed one unit. Berries are eaten on the spot (`eaten`). */
export interface GatherEvent {
  tick: number;
  playerId: string;
  node: number;
  kind: ItemKind | "berry";
  count: number;
  /** Node is now empty (tree → stump, rock → pebbles, palm bare). */
  depleted: boolean;
  /** Didn't fit in the inventory: dropped as a ground item. */
  dropped: boolean;
  eaten: boolean;
  pos: Vec3Like;
}

/** LMB on a palm (or a throw hit it): coconuts fell (spawned as projectiles `projectileIds`). */
export interface PalmShakeEvent {
  tick: number;
  playerId: string;
  node: number;
  projectileIds: string[];
  pos: Vec3Like;
}

/** Other LMB "uses" for feedback: rod cast is FishCastEvent, placing is StructurePlacedEvent. */
export interface UseEvent {
  tick: number;
  playerId: string;
  what: "torchSwing" | "whiffPalm" | "punch";
  pos: Vec3Like;
}

export interface EatEvent {
  tick: number;
  playerId: string;
  kind: ItemKind | "berry" | "spring" | "collector";
  hunger: number;
  thirst: number;
  pos: Vec3Like;
}

export interface CraftedEvent {
  tick: number;
  playerId: string;
  recipe: RecipeId;
  /** Item produced (null for fuel / team effects). */
  item: ItemKind | null;
  /** Didn't fit: dropped at the crafter's feet. */
  dropped: boolean;
  pos: Vec3Like;
}

export interface FireFuelEvent {
  tick: number;
  team: number;
  /** "" = burned out / rain, otherwise who fed it. */
  playerId: string;
  /** Ticks added (negative when rain douses it). */
  added: number;
  fuel: number;
  source: "wood" | "throw" | "jellyfish" | "fuelCan" | "out" | "relit";
}

export interface ChestChangedEvent {
  tick: number;
  team: number;
  /** "" for monkeys. */
  playerId: string;
  op: "put" | "take" | "steal" | "return";
  items: { kind: ItemKind; count: number }[];
}

export interface DeliverEvent {
  tick: number;
  playerId: string;
  team: number;
  /** Stage the items went to. */
  stage: RaftStage;
  items: { kind: ItemKind; count: number }[];
  /** Stage after delivery (> stage when it completed). */
  newStage: RaftStage;
}

export interface RaftDamageEvent {
  tick: number;
  team: number;
  /** Hull wood lost. */
  amount: number;
  byMonsterId: string;
  pos: Vec3Like;
  hullWood: number;
}

export interface StructurePlacedEvent {
  tick: number;
  id: string;
  kind: StructureKind;
  playerId: string;
  pos: Vec3Like;
  yaw: number;
}

export interface StructureHitEvent {
  tick: number;
  id: string;
  kind: StructureKind;
  hp: number;
  byId: string;
  pos: Vec3Like;
}

export interface StructureDestroyedEvent {
  tick: number;
  id: string;
  kind: StructureKind;
  /** "" when it burned out / expired. */
  byId: string;
  pos: Vec3Like;
}

export interface MonsterSpawnEvent {
  tick: number;
  id: string;
  kind: MonsterKind;
  pos: Vec3Like;
  /** Night the wave belongs to (0 = daytime visitor). */
  night: number;
}

export interface MonsterHurtEvent {
  tick: number;
  id: string;
  kind: MonsterKind;
  hp: number;
  damage: number;
  byId: string;
  pos: Vec3Like;
}

export interface MonsterFlipEvent {
  tick: number;
  id: string;
  /** true = flipped onto its back; false = it got back up. */
  flipped: boolean;
  byId: string;
  pos: Vec3Like;
}

/** Killed (hp 0 / puffer popped / crab collected) or fled at dawn (`fled`). */
export interface MonsterDieEvent {
  tick: number;
  id: string;
  kind: MonsterKind;
  byId: string;
  pos: Vec3Like;
  fled: boolean;
  /** A crab collected with E becomes a raw crab (pickup follows). */
  collected: boolean;
}

export interface MonsterAttackEvent {
  tick: number;
  id: string;
  kind: MonsterKind;
  targetType: "player" | "raft" | "structure" | "chest";
  targetId: string;
  damage: number;
  pos: Vec3Like;
}

/** A gull grabbed a fish from a player / a monkey grabbed something from the chest; `dropped` when it let go. */
export interface StealEvent {
  tick: number;
  monsterId: string;
  kind: MonsterKind;
  item: ItemKind;
  /** Victim player id or "chest". */
  fromId: string;
  dropped: boolean;
  pos: Vec3Like;
}

export interface PlayerHurtEvent {
  tick: number;
  playerId: string;
  amount: number;
  hp: number;
  cause: HurtCause;
  /** Monster / player id, "" for bars. */
  byId: string;
  pos: Vec3Like;
}

export interface PlayerDownedEvent {
  tick: number;
  playerId: string;
  cause: HurtCause;
  pos: Vec3Like;
}

export interface PlayerRevivedEvent {
  tick: number;
  playerId: string;
  byId: string;
  pos: Vec3Like;
}

/** "Dalgalar seni kıyıya attı": the downed timer ran out. Respawns at the next dawn (never after night 3 began). */
export interface PlayerWashedEvent {
  tick: number;
  playerId: string;
  pos: Vec3Like;
  /** False when it's night 3: no dawn is coming. */
  willRespawn: boolean;
}

export interface PlayerRespawnEvent {
  tick: number;
  playerId: string;
  pos: Vec3Like;
}

/** A bar of this player fell below LOW_BAR_FRACTION (one feed line, once per dip). */
export interface LowBarEvent {
  tick: number;
  playerId: string;
  bar: "hunger" | "thirst" | "warmth" | "hp";
}

/** Puffer explosion (thrown or in hand). */
export interface BlastEvent {
  tick: number;
  pos: Vec3Like;
  radius: number;
  /** Whoever threw / held it. */
  byId: string;
  inHand: boolean;
  monsters: string[];
  players: string[];
}

export interface FishCastEvent {
  tick: number;
  playerId: string;
  spot: number;
  /** Bobber position on the water. */
  pos: Vec3Like;
}

/** The bobber dipped: the fisher has `windowTicks` to click. */
export interface FishBiteEvent {
  tick: number;
  playerId: string;
  spot: number;
  windowTicks: number;
}

/**
 * Caught! `reel` is the strip of loot icons the "What did I get?" reel spins past (server-chosen), stopping at
 * reel[stopIndex] === loot. The item lands in the inventory FISH_REEL_TICKS later (PickupEvent source "fish").
 */
export interface FishResultEvent {
  tick: number;
  playerId: string;
  spot: number;
  loot: FishLoot;
  reel: FishLoot[];
  stopIndex: number;
  /** Bad-luck protection kicked in. */
  pity: boolean;
}

export interface FishMissEvent {
  tick: number;
  playerId: string;
  spot: number;
  reason: "late" | "early" | "moved" | "cancel";
}

/** Treasure chest reel (from fishing or the secret chest). Applies to the team when the reel ends. */
export interface TreasureEvent {
  tick: number;
  playerId: string;
  team: number;
  treasure: TreasureId;
  reel: TreasureId[];
  stopIndex: number;
  source: "fish" | "secretChest" | "waveGift";
}

export interface BottleEvent {
  tick: number;
  playerId: string;
  team: number;
  effect: BottleEffect;
}

/** An action the server refused (for a short HUD hint), e.g. crafting without ingredients. */
export interface RejectEvent {
  tick: number;
  playerId: string;
  action: "craft" | "chest" | "deliver" | "board" | "interact" | "eat" | "place" | "fish";
  /** i18n key under `reject.` on the client, e.g. "missing", "fireOut", "full", "tooFar", "wrongStage". */
  reason: string;
  interact?: InteractKind;
}

export interface MarkerEvent {
  tick: number;
  playerId: string;
  kind: MarkerKind;
  pos: Vec3Like;
  need: ItemKind | "";
}

export interface EmoteEvent {
  tick: number;
  playerId: string;
  emote: EmoteId;
}

/* ================================================= server → client map */

/** Every server → client message, keyed by MSG name. */
export interface ServerMessages {
  ping: PingMsg;
  welcome: WelcomeMsg;
  notice: NoticeMsg;
  matchStart: MatchStartEvent;
  dayPhase: DayPhaseEvent;
  weather: WeatherEvent;
  dayEvent: DayEventEvent;
  stormWarning: StormWarningEvent;
  raftReady: RaftReadyEvent;
  board: BoardEvent;
  raftLaunch: RaftLaunchEvent;
  storm: StormEvent;
  matchEnd: MatchEndEvent;
  throw: ThrowEvent;
  hit: HitEvent;
  splash: SplashEvent;
  stick: StickEvent;
  pickup: PickupEvent;
  catch: CatchEvent;
  gather: GatherEvent;
  palmShake: PalmShakeEvent;
  use: UseEvent;
  eat: EatEvent;
  crafted: CraftedEvent;
  fireFuel: FireFuelEvent;
  chestChanged: ChestChangedEvent;
  deliver: DeliverEvent;
  raftDamage: RaftDamageEvent;
  structurePlaced: StructurePlacedEvent;
  structureHit: StructureHitEvent;
  structureDestroyed: StructureDestroyedEvent;
  monsterSpawn: MonsterSpawnEvent;
  monsterHurt: MonsterHurtEvent;
  monsterFlip: MonsterFlipEvent;
  monsterDie: MonsterDieEvent;
  monsterAttack: MonsterAttackEvent;
  steal: StealEvent;
  playerHurt: PlayerHurtEvent;
  playerDowned: PlayerDownedEvent;
  playerRevived: PlayerRevivedEvent;
  playerWashed: PlayerWashedEvent;
  playerRespawn: PlayerRespawnEvent;
  lowBar: LowBarEvent;
  blast: BlastEvent;
  fishCast: FishCastEvent;
  fishBite: FishBiteEvent;
  fishResult: FishResultEvent;
  fishMiss: FishMissEvent;
  treasure: TreasureEvent;
  bottle: BottleEvent;
  reject: RejectEvent;
  marker: MarkerEvent;
  emote: EmoteEvent;
}

export type ServerMessageType = keyof ServerMessages;

/**
 * Server → client gameplay events produced by the world simulation (subset of ServerMessages). The room
 * produces the rest (meta, match flow, marker, emote).
 */
export type WorldEventType =
  | "weather"
  | "dayEvent"
  | "raftReady"
  | "board"
  | "throw"
  | "hit"
  | "splash"
  | "stick"
  | "pickup"
  | "catch"
  | "gather"
  | "palmShake"
  | "use"
  | "eat"
  | "crafted"
  | "fireFuel"
  | "chestChanged"
  | "deliver"
  | "raftDamage"
  | "structurePlaced"
  | "structureHit"
  | "structureDestroyed"
  | "monsterSpawn"
  | "monsterHurt"
  | "monsterFlip"
  | "monsterDie"
  | "monsterAttack"
  | "steal"
  | "playerHurt"
  | "playerDowned"
  | "playerRevived"
  | "playerWashed"
  | "playerRespawn"
  | "lowBar"
  | "blast"
  | "fishCast"
  | "fishBite"
  | "fishResult"
  | "fishMiss"
  | "treasure"
  | "bottle"
  | "reject";

/* ================================================================ errors */

/**
 * WebSocket close codes the room sends on purpose (besides Colyseus' 4000 = consented). SERVER_RESTART: the server
 * process is shutting down gracefully (deploy / restart) and every room goes with it — final for the client, which
 * says so instead of "you were sent back to the cruise ship".
 */
export const CLOSE_CODE = {
  SERVER_RESTART: 4002,
} as const;

/**
 * Join/create rejection codes (server throws ServerError(code, message) in onAuth/onJoin; colyseus.js rejects
 * with MatchMakeError having this `code`). Colyseus' own codes (room not found 4212, full/locked) are mapped by
 * the client to the same user messages.
 */
export const JOIN_ERROR = {
  ROOM_FULL: 4401,
  BAD_NICKNAME: 4402,
  BAD_CHARACTER: 4403,
  NOT_FOUND: 4404,
  /** The server is at its live-room cap (create) — try again in a minute. */
  SERVER_BUSY: 4405,
  /** Create/JoinOptions.protocol differs from the server's PROTOCOL_VERSION — reload the page. */
  OUTDATED: 4406,
} as const;

export const JOIN_ERROR_TEXT: Readonly<Record<number, string>> = {
  [JOIN_ERROR.ROOM_FULL]: "Room full",
  [JOIN_ERROR.BAD_NICKNAME]: "Pick a nickname (1–16 characters)",
  [JOIN_ERROR.BAD_CHARACTER]: "Unknown character",
  [JOIN_ERROR.NOT_FOUND]: "No room with that code",
  [JOIN_ERROR.SERVER_BUSY]: "Server busy, try again in a minute",
  [JOIN_ERROR.OUTDATED]: "The game was updated, reload the page",
};
