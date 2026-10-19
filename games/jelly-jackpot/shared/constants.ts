// Jelly Jackpot balance numbers, card table and piece table. FROZEN CONTRACT (see docs/ARCHITECTURE.md).
// Shared by the server (rules, physics) and the client (visuals, UI). Units: meters, seconds, coins.
// Change values here, never re-declare them in a module.

export const GAME_ID = "jelly-jackpot";
export const ROOM_NAME = "jelly_jackpot";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const NICKNAME_MAX = 14;
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 4;

// ------------------------------------------------------------------------- timing
export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;
/** Colyseus patch rate (state sync incl. piece transforms + hover pose). */
export const PATCH_INTERVAL_MS = 50;
/** Client → server hover pose rate. */
export const HOVER_SEND_HZ = 15;

export const ROLE_REVEAL_SEC = 5;
/** Waiting for the active player to press Space before an auto spin. */
export const SPIN_IDLE_SEC = 2;
/** Total reel time from SPIN_START to the card landing. */
export const SPIN_SEC = 3;
/** The server holds the result this long after SPIN_START so the Saboteur can rig (then SPIN_RESULT). */
export const RIG_WINDOW_SEC = 1.2;
/** Short beat after the reel lands, before placement starts (lets people read the card). */
export const CARD_READ_SEC = 1.2;
export const TURN_TIMER_OPTIONS = [8, 10, 15] as const;
export const DEFAULT_TURN_TIMER = 10;
export const SPEED_ROUND_TIMER = 5;
export const SETTLE_MAX_SEC = 4;
export const RESULT_SEC = 3;
export const VOTE_SEC = 20;
export const REVEAL_SEC = 9;
export const RECONNECT_GRACE_SEC = 30;
export const EMPTY_ROOM_DISPOSE_SEC = 60;

// ------------------------------------------------------------------------ economy
export const START_COINS = 100;
export const SURVIVE_BASE = 10;
/** +1 coin per this many cm of tower height. */
export const SURVIVE_CM_PER_COIN = 10;
export const TOPPLE_PENALTY = 10;
export const BET_AMOUNTS = [0, 10, 25, 50] as const;
export const BET_PAYOUT = 2;
export const SABOTEUR_TOPPLE_BONUS = 30;
export const VOTE_CORRECT_REWARD = 40;
export const SABOTEUR_ESCAPE_BONUS = 60;
/** Saboteur needs at least this many players. */
export const SABOTEUR_MIN_PLAYERS = 3;

export const ROUND_OPTIONS = [0, 4, 5, 6, 7, 8, 9, 10] as const; // 0 = auto
export function autoRounds(players: number): number {
  return players <= 4 ? 8 : players === 5 ? 7 : 6;
}
export function turnsPerRound(players: number): number {
  return Math.max(players, 4);
}
export function survivePayout(heightCm: number, multiplier: number): number {
  return Math.round((SURVIVE_BASE + Math.floor(heightCm / SURVIVE_CM_PER_COIN)) * multiplier);
}
export function topplePenalty(multiplier: number): number {
  return Math.round(TOPPLE_PENALTY * multiplier);
}

// -------------------------------------------------------------------- world / physics
/** Table top is y = 0. Everything is in the cake stand's LOCAL frame (the stand rotation is visual only). */
export const TABLE_RADIUS = 1.1;
export const STAND_PLATE_Y = 0.22;
export const STAND_PLATE_RADIUS = 0.48;
export const CAKE_RADIUS = 0.35;
export const CAKE_HEIGHT = 0.2;
export const CAKE_TOP_Y = STAND_PLATE_Y + CAKE_HEIGHT; // 0.42
/** A piece whose center drops below this y has toppled (fell off the stand rim). */
export const TOPPLE_Y = STAND_PLATE_Y + 0.02;
/** Hover pose must stay within this radius of the stand axis (xz). */
export const HOVER_RADIUS = 0.42;
/** Lowest point of the hovering piece must be at least this far above the tower top. */
export const MIN_DROP_GAP = 0.1;
export const GRAVITY = -9.81;
export const MOON_GRAVITY_SCALE = 0.4;
export const STAND_SPEED_DEG = 6;
export const SPIN_CYCLE_SPEED_DEG = 18;
export const SLEEP_LIN = 0.05;
export const SLEEP_ANG = 0.1;
export const SLEEP_HOLD_SEC = 0.5;
export const SLOWMO_FIRST_SEC = 1;
export const SLOWMO_SCALE = 0.7;
export const EARTHQUAKE_SEC = 1;
export const WIND_FORCE = 0.6; // N per kg, roughly
/** Server only emits IMPACT messages for contacts above this relative speed (m/s). */
export const IMPACT_MIN_SPEED = 0.6;

// -------------------------------------------------------------------------- colors
export const PLAYER_COLORS = ["#FF5A5F", "#3FA7FF", "#7BE07B", "#FFC23F", "#B07CFF", "#FF8BD1"] as const;
export const PALETTE = {
  frosting: "#FFB7D5",
  frostingShadow: "#E58AB0",
  sponge: "#F6D59A",
  tablecloth: "#FF5A5F",
  tableclothCheck: "#FFFFFF",
  wall: "#2D2A44",
  lamp: "#FFD9A0",
  coin: "#FFCF33",
  ink: "#2D2A32",
} as const;

// --------------------------------------------------------------------------- cards
export type Rarity = "common" | "uncommon" | "rare" | "legendary" | "cursed";
export const RARITIES: Rarity[] = ["common", "uncommon", "rare", "legendary", "cursed"];
export const RARITY_COLORS: Record<Rarity, string> = {
  common: "#4B8BFF",
  uncommon: "#8847FF",
  rare: "#D32CE6",
  legendary: "#FFD700",
  cursed: "#EB4B4B",
};
/** Percent odds per rarity (index matches RARITIES). */
export const RARITY_ODDS = [55, 25, 12, 5, 3];
export const RARITY_ODDS_TWO_PLAYERS = [52, 25, 12, 5, 6];

export type CardId =
  | "plain"
  | "butterFingers"
  | "speedRound"
  | "mirrorHands"
  | "heavySnack"
  | "moonGravity"
  | "jellyMode"
  | "chonk"
  | "spinCycle"
  | "fog"
  | "blindfold"
  | "doubleDecker"
  | "earthquake"
  | "hiccups"
  | "goldenCherry"
  | "glueGun"
  | "insurance"
  | "bowlingBall"
  | "upsideDown"
  | "windStorm"
  | "tiedHands";

export interface CardDef {
  id: CardId;
  name: string;
  emoji: string;
  rarity: Rarity;
  multiplier: number;
  text: string;
}

export const CARDS: CardDef[] = [
  { id: "plain", name: "Plain Turn", emoji: "🍰", rarity: "common", multiplier: 1, text: "Nothing special. Boring. Safe." },
  { id: "butterFingers", name: "Butter Fingers", emoji: "🧈", rarity: "common", multiplier: 1.5, text: "Your piece has almost no friction." },
  { id: "speedRound", name: "Speed Round", emoji: "⏱️", rarity: "common", multiplier: 1.5, text: "Only 5 seconds to place!" },
  { id: "mirrorHands", name: "Mirror Hands", emoji: "🪞", rarity: "common", multiplier: 1.5, text: "Left is right. Right is left." },
  { id: "heavySnack", name: "Heavy Snack", emoji: "🏋️", rarity: "common", multiplier: 1.5, text: "Your piece weighs 3× as much." },
  { id: "moonGravity", name: "Moon Gravity", emoji: "🌙", rarity: "uncommon", multiplier: 2, text: "Gravity ×0.4. Everything floats." },
  { id: "jellyMode", name: "Jelly Mode", emoji: "🍮", rarity: "uncommon", multiplier: 2, text: "Your piece turns into bouncy jelly." },
  { id: "chonk", name: "Chonk", emoji: "🐘", rarity: "uncommon", multiplier: 2, text: "Your piece is 1.6× bigger." },
  { id: "spinCycle", name: "Spin Cycle", emoji: "🌀", rarity: "uncommon", multiplier: 2, text: "The cake stand spins 3× faster." },
  { id: "fog", name: "Fog", emoji: "🌫️", rarity: "uncommon", multiplier: 2, text: "Kitchen steam clouds your view." },
  { id: "blindfold", name: "Blindfold", emoji: "🙈", rarity: "rare", multiplier: 3, text: "Lights out after 2 s. Drop from memory!" },
  { id: "doubleDecker", name: "Double Decker", emoji: "🍔", rarity: "rare", multiplier: 3, text: "Place 2 pieces, same timer." },
  { id: "earthquake", name: "Earthquake", emoji: "🫨", rarity: "rare", multiplier: 3, text: "The table shakes after your drop." },
  { id: "hiccups", name: "Hiccups", emoji: "😵", rarity: "rare", multiplier: 3, text: "Your piece randomly hops. *hic*" },
  { id: "goldenCherry", name: "Golden Cherry", emoji: "🍒", rarity: "legendary", multiplier: 5, text: "A tiny golden cherry. Easy money!" },
  { id: "glueGun", name: "Glue Gun", emoji: "🔫", rarity: "legendary", multiplier: 5, text: "Your piece sticks to the first thing it touches." },
  { id: "insurance", name: "Insurance", emoji: "📜", rarity: "legendary", multiplier: 5, text: "Topple and you lose nothing." },
  { id: "bowlingBall", name: "Bowling Ball", emoji: "🎳", rarity: "cursed", multiplier: 4, text: "Your piece is a heavy bowling ball." },
  { id: "upsideDown", name: "Upside Down", emoji: "🙃", rarity: "cursed", multiplier: 4, text: "Your camera is flipped." },
  { id: "windStorm", name: "Wind Storm", emoji: "🌪️", rarity: "cursed", multiplier: 4, text: "A gusty fan blows across the tower." },
  { id: "tiedHands", name: "Tied Hands", emoji: "🪢", rarity: "cursed", multiplier: 4, text: "No rotating. It swings on a string." },
];
export const CARD_BY_ID: Record<CardId, CardDef> = Object.fromEntries(CARDS.map((c) => [c.id, c])) as Record<CardId, CardDef>;
export const REEL_LENGTH = 48;
/** Index in the reel strip where the winning card sits (the client scrolls to it). */
export const REEL_WIN_INDEX = 40;

// -------------------------------------------------------------------------- pieces
export type PieceType =
  | "jelly"
  | "chicken"
  | "fish"
  | "toaster"
  | "donut"
  | "banana"
  | "teapot"
  | "cheese"
  | "spatula"
  | "egg"
  | "pancakes"
  | "watermelon"
  | "croissant"
  | "soap"
  | "cupcake"
  | "pan"
  // card overrides, never dealt from the bag
  | "bowlingBall"
  | "goldenCherry";

/** Collider primitives in the piece's local frame (center of mass ≈ origin). Rapier semantics: half extents / half heights; cylinder & cone axis = local Y. */
export type ColliderDef =
  | { kind: "box"; hx: number; hy: number; hz: number; pos?: [number, number, number]; rot?: [number, number, number, number] }
  | { kind: "ball"; r: number; pos?: [number, number, number] }
  | { kind: "capsule"; halfHeight: number; r: number; pos?: [number, number, number]; rot?: [number, number, number, number] }
  | { kind: "cylinder"; halfHeight: number; r: number; pos?: [number, number, number]; rot?: [number, number, number, number] }
  | { kind: "cone"; halfHeight: number; r: number; pos?: [number, number, number]; rot?: [number, number, number, number] };

export type ImpactSound = "squeak" | "clank" | "blorp" | "slap" | "crack" | "thud" | "boing" | "clink" | "squish" | "bonk";

export interface PieceDef {
  type: PieceType;
  name: string;
  emoji: string;
  /** kg */
  mass: number;
  friction: number;
  restitution: number;
  colliders: ColliderDef[];
  /** Approximate bounding radius (m), used for hover height + UI. */
  radius: number;
  sound: ImpactSound;
  /** Main + accent colors for the client mesh. */
  colors: [string, string];
  /** Shown in the "Next up" panel. */
  quip: string;
}

// 90° about Z (cylinder/capsule axis Y → X) as a quaternion [x, y, z, w].
const Z90: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
const X90: [number, number, number, number] = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

export const PIECES: Record<PieceType, PieceDef> = {
  jelly: {
    type: "jelly", name: "Jelly", emoji: "🍮", mass: 0.35, friction: 0.9, restitution: 0.55,
    colliders: [{ kind: "cylinder", halfHeight: 0.04, r: 0.075, pos: [0, -0.02, 0] }, { kind: "ball", r: 0.06, pos: [0, 0.02, 0] }],
    radius: 0.09, sound: "blorp", colors: ["#7BE07B", "#C9FFC9"], quip: "Wobbles like your confidence.",
  },
  chicken: {
    type: "chicken", name: "Rubber Chicken", emoji: "🐔", mass: 0.12, friction: 0.7, restitution: 0.4,
    colliders: [{ kind: "capsule", halfHeight: 0.09, r: 0.035, rot: Z90 }, { kind: "ball", r: 0.04, pos: [0.13, 0.03, 0] }],
    radius: 0.17, sound: "squeak", colors: ["#FFE14D", "#FF8A3D"], quip: "BAWK. Squeaks on impact.",
  },
  fish: {
    type: "fish", name: "Fish", emoji: "🐟", mass: 0.3, friction: 0.25, restitution: 0.15,
    colliders: [{ kind: "capsule", halfHeight: 0.08, r: 0.04, rot: Z90 }, { kind: "box", hx: 0.03, hy: 0.045, hz: 0.01, pos: [-0.14, 0, 0] }],
    radius: 0.17, sound: "slap", colors: ["#7FC8FF", "#3A7BD5"], quip: "Slippery. Smells. Probably fine.",
  },
  toaster: {
    type: "toaster", name: "Toaster", emoji: "🍞", mass: 1.2, friction: 0.7, restitution: 0.05,
    colliders: [{ kind: "box", hx: 0.1, hy: 0.075, hz: 0.06 }],
    radius: 0.14, sound: "clank", colors: ["#C9D1D9", "#6B7280"], quip: "A great base. Ding!",
  },
  donut: {
    type: "donut", name: "Donut", emoji: "🍩", mass: 0.08, friction: 0.6, restitution: 0.3,
    colliders: [{ kind: "cylinder", halfHeight: 0.025, r: 0.08 }],
    radius: 0.08, sound: "squish", colors: ["#E8A65A", "#FF8BD1"], quip: "Rolls if dropped on edge.",
  },
  banana: {
    type: "banana", name: "Banana", emoji: "🍌", mass: 0.12, friction: 0.5, restitution: 0.2,
    colliders: [
      { kind: "capsule", halfHeight: 0.05, r: 0.025, pos: [-0.06, 0.02, 0], rot: [0, 0, 0.819, 0.574] },
      { kind: "capsule", halfHeight: 0.05, r: 0.025, pos: [0.06, 0.02, 0], rot: [0, 0, -0.819, 0.574] },
    ],
    radius: 0.13, sound: "squish", colors: ["#FFE135", "#6B4F1D"], quip: "Rocks back and forth. Peel-fect.",
  },
  teapot: {
    type: "teapot", name: "Teapot", emoji: "🫖", mass: 0.6, friction: 0.6, restitution: 0.1,
    colliders: [
      { kind: "ball", r: 0.08 },
      { kind: "capsule", halfHeight: 0.035, r: 0.015, pos: [0.1, 0.02, 0], rot: [0, 0, -0.5, 0.866] },
      { kind: "box", hx: 0.015, hy: 0.04, hz: 0.01, pos: [-0.095, 0.01, 0] },
    ],
    radius: 0.14, sound: "clink", colors: ["#FFFFFF", "#3FA7FF"], quip: "The spout catches on things.",
  },
  cheese: {
    type: "cheese", name: "Cheese Wedge", emoji: "🧀", mass: 0.4, friction: 0.95, restitution: 0.05,
    colliders: [{ kind: "box", hx: 0.09, hy: 0.04, hz: 0.06 }],
    radius: 0.12, sound: "thud", colors: ["#FFCF33", "#E8A010"], quip: "Grippy. Good for leveling.",
  },
  spatula: {
    type: "spatula", name: "Spatula", emoji: "🍳", mass: 0.1, friction: 0.6, restitution: 0.1,
    colliders: [{ kind: "box", hx: 0.06, hy: 0.006, hz: 0.045, pos: [0.08, 0, 0] }, { kind: "box", hx: 0.08, hy: 0.008, hz: 0.012, pos: [-0.06, 0, 0] }],
    radius: 0.15, sound: "clank", colors: ["#FF5A5F", "#2D2A32"], quip: "Bridges gaps. Flips burgers.",
  },
  egg: {
    type: "egg", name: "Egg", emoji: "🥚", mass: 0.06, friction: 0.4, restitution: 0.25,
    colliders: [{ kind: "capsule", halfHeight: 0.015, r: 0.035 }],
    radius: 0.05, sound: "crack", colors: ["#FFF6E5", "#FFD08A"], quip: "Fragile. Rolls. Judges you.",
  },
  pancakes: {
    type: "pancakes", name: "Pancake Stack", emoji: "🥞", mass: 0.45, friction: 0.5, restitution: 0.05,
    colliders: [{ kind: "cylinder", halfHeight: 0.04, r: 0.09 }],
    radius: 0.1, sound: "squish", colors: ["#E8A65A", "#8B4513"], quip: "Syrup sold separately.",
  },
  watermelon: {
    type: "watermelon", name: "Watermelon", emoji: "🍉", mass: 1.5, friction: 0.5, restitution: 0.2,
    colliders: [{ kind: "ball", r: 0.11 }],
    radius: 0.11, sound: "thud", colors: ["#2E9E4F", "#FF5A5F"], quip: "Round. Heavy. Very dangerous.",
  },
  croissant: {
    type: "croissant", name: "Croissant", emoji: "🥐", mass: 0.08, friction: 0.8, restitution: 0.1,
    colliders: [{ kind: "capsule", halfHeight: 0.06, r: 0.04, rot: Z90 }, { kind: "box", hx: 0.06, hy: 0.02, hz: 0.04, pos: [0, -0.02, 0] }],
    radius: 0.11, sound: "squish", colors: ["#E8A65A", "#B5651D"], quip: "Weirdly stable. Très bien.",
  },
  soap: {
    type: "soap", name: "Soap Bar", emoji: "🧼", mass: 0.12, friction: 0.03, restitution: 0.1,
    colliders: [{ kind: "box", hx: 0.06, hy: 0.022, hz: 0.04 }],
    radius: 0.075, sound: "slap", colors: ["#B9F3FF", "#FFFFFF"], quip: "Almost no friction. Good luck.",
  },
  cupcake: {
    type: "cupcake", name: "Cupcake", emoji: "🧁", mass: 0.1, friction: 0.8, restitution: 0.1,
    colliders: [{ kind: "cone", halfHeight: 0.04, r: 0.055, rot: [1, 0, 0, 0], pos: [0, -0.01, 0] }, { kind: "cylinder", halfHeight: 0.015, r: 0.055, pos: [0, 0.035, 0] }],
    radius: 0.07, sound: "squish", colors: ["#FFB7D5", "#B07CFF"], quip: "Flat top. Stack on me.",
  },
  pan: {
    type: "pan", name: "Frying Pan", emoji: "🍳", mass: 1.0, friction: 0.6, restitution: 0.05,
    colliders: [{ kind: "cylinder", halfHeight: 0.012, r: 0.1 }, { kind: "box", hx: 0.07, hy: 0.01, hz: 0.012, pos: [0.17, 0.005, 0] }],
    radius: 0.24, sound: "bonk", colors: ["#3A3A46", "#8B5A2B"], quip: "Wide platform. Off-center weight.",
  },
  bowlingBall: {
    type: "bowlingBall", name: "Bowling Ball", emoji: "🎳", mass: 5, friction: 0.4, restitution: 0.05,
    colliders: [{ kind: "ball", r: 0.1 }],
    radius: 0.1, sound: "bonk", colors: ["#2D2A44", "#FF5A5F"], quip: "STRIKE. (the tower)",
  },
  goldenCherry: {
    type: "goldenCherry", name: "Golden Cherry", emoji: "🍒", mass: 0.02, friction: 0.9, restitution: 0.1,
    colliders: [{ kind: "ball", r: 0.022 }],
    radius: 0.03, sound: "clink", colors: ["#FFD700", "#FFF3A0"], quip: "Shiny. Tiny. Money.",
  },
};
export const BAG_PIECES: PieceType[] = [
  "jelly", "chicken", "fish", "toaster", "donut", "banana", "teapot", "cheese",
  "spatula", "egg", "pancakes", "watermelon", "croissant", "soap", "cupcake", "pan",
];
export const CHONK_SCALE = 1.6;
export const HEAVY_SNACK_MASS = 3;
export const BUTTER_FRICTION = 0.02;
export const JELLY_RESTITUTION = 0.85;

/** Unused helper kept for collider authoring readability. */
export const ROT = { Z90, X90 };

// --------------------------------------------------------------------------- misc
export type EmoteId = "cheer" | "gasp" | "point" | "laugh";
export const EMOTES: EmoteId[] = ["cheer", "gasp", "point", "laugh"];
export const SETTINGS_STORAGE_KEY = "jelly-jackpot:settings";
export const NICKNAME_STORAGE_KEY = "jelly-jackpot:nickname";
export const RECONNECT_STORAGE_KEY = "jelly-jackpot:reconnect";
