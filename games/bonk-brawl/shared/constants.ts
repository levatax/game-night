// Bonk Brawl balance numbers and tuning. FROZEN CONTRACT (see docs/ARCHITECTURE.md).
//
// Seconds are authored as *_SEC and converted to integer ticks (*_TICKS) with secToTicks().
// Every gameplay timer inside the simulation is an integer tick count (30 Hz) so replays are exact.
// Distances in meters, speeds in m/s, angles in radians unless the name says DEG.

import type {
  AbilityId,
  AnimalKind,
  CharacterId,
  EmoteId,
  MapId,
  PowerUpType,
  RingState,
} from "./types.js";

/* ============================================================ time & ticks */

export const TICK_RATE = 30;
/** Fixed simulation step in seconds (server and client prediction). */
export const DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;
/** State patch rate: 20 Hz. */
export const PATCH_RATE_HZ = 20;
export const PATCH_INTERVAL_MS = 1000 / PATCH_RATE_HZ;
/** Client input rate: one `input` message per sim tick. */
export const INPUT_RATE_HZ = TICK_RATE;

/** Seconds → integer ticks (rounded to nearest). secToTicks(0.25) === 8. */
export function secToTicks(sec: number): number {
  return Math.round(sec * TICK_RATE);
}
/** Ticks → seconds. */
export function ticksToSec(ticks: number): number {
  return ticks / TICK_RATE;
}

/* ================================================================ world */

/** Gravity for players and balls (m/s², negative = down). */
export const GRAVITY = -20;
/** Feet (or ball center) below this y = ring-out / ball lost. */
export const RING_OUT_Y = -6;
export const BALL_KILL_Y = -6;
/** Terminal fall speed (positive magnitude). */
export const MAX_FALL_SPEED = 30;
/** Island floor top surface is y = 0. Visual slab thickness under it. */
export const FLOOR_Y = 0;
export const FLOOR_THICKNESS = 1.2;

/* ========================================================== player body */

export const PLAYER_RADIUS = 0.45;
export const PLAYER_HEIGHT = 1.4;
/** Chest height above feet (catch sphere center height, throw origin height). */
export const CHEST_HEIGHT = 1.0;
/** Throw origin offset from feet: chest height, 0.5 forward, 0.35 right. */
export const HAND_FORWARD = 0.5;
export const HAND_RIGHT = 0.35;
/** Capsule height while Pip belly-slides (balls above this pass over). */
export const SLIDE_HEIGHT = 0.7;
/** Max ledge height a player walks onto without jumping. */
export const STEP_HEIGHT = 0.3;
/** Players push each other apart so capsules don't overlap (world). */
export const PLAYER_SEPARATION = PLAYER_RADIUS * 2;

/* ============================================================= movement */

export const MOVE_SPEED = 6;
/** Move speed multiplier while charging a throw (6 → 3.6 m/s). */
export const CHARGE_MOVE_MULT = 0.6;
/** Move speed multiplier during whiff recovery. */
export const WHIFF_MOVE_MULT = 0.35;
/** Default ground acceleration toward wish velocity (m/s²); arenas may override via FrictionProfile. */
export const GROUND_ACCEL = 60;
/** Default ground deceleration with no input (m/s²). */
export const GROUND_DECEL = 45;
/** Fraction of ground accel available in the air. */
export const AIR_CONTROL = 0.45;
/** Deceleration while stunned and grounded (sliding to a stop after knockback). */
export const STUN_GROUND_DECEL = 18;
export const JUMP_HEIGHT = 1.2;
/** sqrt(2·g·h) ≈ 6.93 m/s. */
export const JUMP_VELOCITY = Math.sqrt(2 * -GRAVITY * JUMP_HEIGHT);
/** A jump still works this many ticks after walking off a ledge. */
export const COYOTE_TICKS = secToTicks(0.1);
/** Pitch clamp (±). */
export const PITCH_LIMIT = 1.2;

/* =========================================================== dodge roll */

export const ROLL_DISTANCE = 4;
export const ROLL_TICKS = secToTicks(0.3);
/** ROLL_DISTANCE / roll duration ≈ 13.3 m/s. */
export const ROLL_SPEED = ROLL_DISTANCE / (ROLL_TICKS * DT);
/** First 0.2 s of the roll are invulnerable. */
export const ROLL_IFRAME_TICKS = secToTicks(0.2);
/** Counted from roll start. */
export const ROLL_COOLDOWN_TICKS = secToTicks(1.5);

/* ======================================================= charge & throw */

export const CHARGE_FULL_TICKS = secToTicks(1.0);
/** Quick tap → 16 m/s, full charge → 34 m/s (linear in charge fraction). */
export const THROW_SPEED_MIN = 16;
export const THROW_SPEED_MAX = 34;
/** Added to aim pitch for the release direction so a straight crosshair shot arcs onto mid-range targets. */
export const THROW_PITCH_BIAS = 0.06;
/** Recovery after releasing a throw before a new charge can start. */
export const THROW_RECOVER_TICKS = secToTicks(0.25);
/** charge >= this counts as "full charge" for feedback (glow, arc preview, sound). */
export const FULL_CHARGE_THRESHOLD = 0.999;
/** Arc preview shows only the first 25% of the flight time, only at full charge. */
export const ARC_PREVIEW_FRACTION = 0.25;
export const ARC_PREVIEW_MAX_POINTS = 24;

/* ======================================================== hits & damage */

export const MAX_HEARTS = 3;
export const HIT_DAMAGE = 1;
/** Knockback on a live-ball hit: 6 m/s horizontal (along ball travel) + 4 m/s up. */
export const KNOCKBACK_H = 6;
export const KNOCKBACK_UP = 4;
/** Knockback multiplier lerps 1 → 1.5 with charge fraction. */
export const KNOCKBACK_FULL_CHARGE_MULT = 1.5;
/** Mega Ball multiplies knockback by 2 (stacks with charge multiplier). */
export const KNOCKBACK_MEGA_MULT = 2;
/** Control lock after any knockback (ball hit, shockwave, headbutt). */
export const KNOCKBACK_STUN_TICKS = secToTicks(0.45);
/** Mercy invulnerability after taking a hit (prevents Triple Shot multi-hits). */
export const HURT_INVULN_TICKS = secToTicks(0.5);
/** A live ball never damages its own thrower (boomerang returns are auto-caught instead). */
export const OWNER_IMMUNE = true;

/* ============================================================== catches */

/** 0.25 s → 8 ticks. */
export const CATCH_WINDOW_TICKS = secToTicks(0.25);
/** Counted from the catch press. */
export const CATCH_COOLDOWN_TICKS = secToTicks(1.0);
/** Window expired without a catch → 0.6 s whiff recovery. */
export const WHIFF_TICKS = secToTicks(0.6);
/** Catch sphere radius, centered CATCH_FORWARD_OFFSET in front of the chest. */
export const CATCH_RANGE = 1.2;
export const CATCH_FORWARD_OFFSET = 0.5;
/** Client-side cosmetic slow-mo for the catcher. */
export const CATCH_SLOWMO_SCALE = 0.3;
export const CATCH_SLOWMO_MS = 150;
/** Client-side cosmetic hit-stop. */
export const HIT_STOP_MS = 60;

/* ===================================================== lag compensation */

export const LAG_COMP_MAX_MS = 150;
/** Max rewind = 150 ms → 5 ticks (rounded half-RTT, capped). */
export const LAG_COMP_MAX_TICKS = 5;
/** Ball position history kept per ball. */
export const BALL_HISTORY_TICKS = 10;
/** Per-player server input queue cap: older inputs are dropped beyond this. */
export const INPUT_QUEUE_MAX = 4;
/** Ping cadence and RTT smoothing. */
export const PING_INTERVAL_MS = 1000;
export const RTT_EMA_ALPHA = 0.25;

/** Rewind ticks for a given RTT: round((rtt/2) / TICK_MS), clamped to [0, LAG_COMP_MAX_TICKS]. */
export function rewindTicksForRtt(rttMs: number): number {
  const t = Math.round(rttMs / 2 / TICK_MS);
  return Math.max(0, Math.min(LAG_COMP_MAX_TICKS, t));
}

/* ================================================================ balls */

export const BALL_RADIUS = 0.25;
export const MEGA_BALL_RADIUS = 0.5;
/** Normal-velocity restitution on floor / cover bounces. */
export const BALL_RESTITUTION_FLOOR = 0.55;
export const BALL_RESTITUTION_COVER = 0.6;
/** Tangential velocity kept on a bounce (default; arenas may override). */
export const BALL_BOUNCE_FRICTION = 0.85;
/** Rolling deceleration on the floor (m/s², default; arenas may override). */
export const BALL_ROLL_DECEL = 4;
/** Below this speed while touching a surface counts as resting. */
export const BALL_REST_SPEED = 0.6;
/** Resting this many consecutive ticks turns a dead ball neutral. */
export const BALL_REST_TICKS = 6;
/** Vertical bounce speed below which the ball stops bouncing and rolls. */
export const BALL_MIN_BOUNCE_VY = 1.2;
export const BALL_MAX_SPEED = 45;
/** Balls drop from this height at round start / respawn. */
export const BALL_SPAWN_HEIGHT = 12;
/** A ball that falls off the island is replaced at the center after 3 s. */
export const BALL_RESPAWN_TICKS = secToTicks(3);
/** Auto pickup: horizontal distance from player axis to ball center. */
export const PICKUP_RADIUS = 0.85;
/** Auto pickup: ball center must be between feet-0.3 and feet+PICKUP_MAX_HEIGHT. */
export const PICKUP_MAX_HEIGHT = 1.6;
export const MAX_HELD_BALLS = 1;
/** With a Triple Shot power-up held, a player may carry 2 balls. */
export const MAX_HELD_BALLS_TRIPLE = 2;
/** Balls in arena = max(BALLS_MIN, players − 1) (+ SUDDEN_DEATH_EXTRA_BALLS during sudden death). */
export const BALLS_MIN = 2;
export const SUDDEN_DEATH_EXTRA_BALLS = 1;
/** Random ball drops: tries per spawn before falling back to the arena's ballDrop center. */
export const BALL_SPAWN_ATTEMPTS = 40;
/** Random ball drops stay this far inside the edge of the remaining solid floor. */
export const BALL_SPAWN_EDGE_MARGIN = 1.2;
/** Random ball drops prefer this much room from other loose balls. */
export const BALL_SPAWN_SPACING = 2;

export function ballsForPlayers(players: number, suddenDeath: boolean): number {
  return Math.max(BALLS_MIN, players - 1) + (suddenDeath ? SUDDEN_DEATH_EXTRA_BALLS : 0);
}

/* =========================================================== power-ups */

export const POWERUP_FIRST_TICKS = secToTicks(15);
export const POWERUP_INTERVAL_TICKS = secToTicks(20);
export const POWERUP_WARNING_TICKS = secToTicks(2);
/** Walk-into pickup radius (horizontal, from pedestal center). */
export const POWERUP_PICKUP_RADIUS = 1.0;
/** Height of the hovering pickup above the pedestal top. */
export const PEDESTAL_HEIGHT = 0.35;
export const POWERUP_HOVER_Y = 1.0;
export const ZOOMIES_TICKS = secToTicks(6);
export const ZOOMIES_MULT = 1.4;
export const TRIPLE_BALLS = 3;
/** Angle between adjacent Triple Shot balls (yaw offsets −15°, 0, +15°). */
export const TRIPLE_SPREAD_DEG = 15;
export const TRIPLE_SPREAD_RAD = (TRIPLE_SPREAD_DEG * Math.PI) / 180;
/** Boomerang: starts returning 1.2 s after release (or at its first bounce, whichever first). */
export const BOOMERANG_RETURN_TICKS = secToTicks(1.2);
export const BOOMERANG_RETURN_SPEED = 20;
/** Returning boomerang within this distance of the owner's chest is auto-caught (no points). */
export const BOOMERANG_CATCH_RADIUS = 1.0;
/** Returning boomerang gives up (becomes dead, gravity resumes) after this long. */
export const BOOMERANG_MAX_RETURN_TICKS = secToTicks(2.5);

/* ============================================================ abilities */

// Quacky: Flap Dash (5 m dash in move direction or camera forward, usable mid-air, no gravity while dashing).
export const FLAP_DASH_DISTANCE = 5;
export const FLAP_DASH_TICKS = secToTicks(0.2);
export const FLAP_DASH_SPEED = FLAP_DASH_DISTANCE / (FLAP_DASH_TICKS * DT);
/** Upward velocity set when the dash ends (a little hop). */
export const FLAP_DASH_END_VY = 2;
/** Horizontal speed kept after the dash ends. */
export const FLAP_DASH_END_SPEED = 7;

// Hopsworth: Ground Pound (leap, then slam; shockwave on landing, no damage).
export const GROUND_POUND_LEAP_VY = 9;
/** Max rise time before slamming (also slams as soon as vy <= 0). */
export const GROUND_POUND_RISE_TICKS = secToTicks(0.35);
export const GROUND_POUND_SLAM_VY = -26;
/** Safety cap on the whole ability. */
export const GROUND_POUND_MAX_TICKS = secToTicks(2);
export const SHOCKWAVE_RADIUS = 3;
export const SHOCKWAVE_KNOCK_H = 9;
export const SHOCKWAVE_KNOCK_UP = 5;

// Mochi: Belly Bounce (1.5 s; live balls that hit Mochi bounce off harmlessly and become dead).
export const BELLY_BOUNCE_TICKS = secToTicks(1.5);
export const BELLY_BOUNCE_DEFLECT_SPEED = 8;

// Whiskers: Curveball (next throw steers toward the crosshair during flight).
/** Max lateral steering acceleration toward the thrower's current aim ray. */
export const CURVE_ACCEL = 28;
/** Steering only applies for this long after release. */
export const CURVE_MAX_TICKS = secToTicks(1.5);

// Pip: Belly Slide (2 s fast low slide, ducks head-height balls).
export const BELLY_SLIDE_TICKS = secToTicks(2);
export const BELLY_SLIDE_SPEED = 10;
/** Slide direction turns toward camera yaw at this rate (rad/s). */
export const BELLY_SLIDE_TURN_RATE = 2.5;

// Gruff: Headbutt (3 m lunge; hitting a player = big knockback, no damage; lunge ends on hit).
export const HEADBUTT_DISTANCE = 3;
export const HEADBUTT_TICKS = secToTicks(0.25);
export const HEADBUTT_SPEED = HEADBUTT_DISTANCE / (HEADBUTT_TICKS * DT);
/** Hit check: target capsule within this distance in front of Gruff's chest. */
export const HEADBUTT_HIT_RANGE = 1.1;
export const HEADBUTT_KNOCK_H = 14;
export const HEADBUTT_KNOCK_UP = 6;

/* ========================================================== round flow */

export const COUNTDOWN_TICKS = secToTicks(3);
export const ROUND_TICKS = secToTicks(60);
/** Sudden death: drop the outermost solid ring every 5 s, after a 0.8 s shake. */
export const RING_DROP_INTERVAL_TICKS = secToTicks(5);
export const RING_SHAKE_TICKS = secToTicks(0.8);
/** Server-side slow-mo when a round is decided: 1 s at 0.3× (inputs ignored). */
export const ROUND_END_SLOWMO_TICKS = secToTicks(1);
export const ROUND_END_SLOWMO_SCALE = 0.3;
/** Round-end card duration after the slow-mo. */
export const ROUND_END_CARD_TICKS = secToTicks(3);
/** matchEnd returns to the lobby automatically after this long. */
export const MATCH_END_LOBBY_TICKS = secToTicks(45);
/** Rematch button only works after the podium has been up this long. */
export const MATCH_END_MIN_TICKS = secToTicks(3);
export const RECONNECT_GRACE_SEC = 20;
export const EMPTY_ROOM_DISPOSE_SEC = 60;
/** Ring-out credit goes to whoever last hit/knocked the victim within 3 s. */
export const RING_OUT_CREDIT_TICKS = secToTicks(3);
/** Emote spam guard (server). */
export const EMOTE_COOLDOWN_TICKS = secToTicks(1);

export const ROUND_OPTIONS: ReadonlyArray<number> = [3, 5, 7];
export const DEFAULT_ROUNDS = 5;

/**
 * Shortened timers for headless bot tests. Only honored when create options contain
 * `fast: true` AND process.env.BONK_TEST === "1".
 */
export const FAST_TIMINGS = {
  COUNTDOWN_TICKS: secToTicks(0.5),
  ROUND_TICKS: secToTicks(8),
  RING_DROP_INTERVAL_TICKS: secToTicks(1),
  RING_SHAKE_TICKS: secToTicks(0.3),
  ROUND_END_SLOWMO_TICKS: secToTicks(0.3),
  ROUND_END_CARD_TICKS: secToTicks(0.5),
  POWERUP_FIRST_TICKS: secToTicks(2),
  POWERUP_INTERVAL_TICKS: secToTicks(3),
} as const;

/* ============================================================== scoring */

export const POINTS = {
  hit: 1,
  catch: 2,
  ringOut: 2,
  roundWin: 3,
} as const;

/* ================================================================ rings */

export const RING_SOLID: RingState = 0;
export const RING_SHAKING: RingState = 1;
export const RING_FALLEN: RingState = 2;

/* =============================================================== camera */

/** Over-the-shoulder offset from the player's feet, in the camera yaw frame. */
export const CAMERA_OFFSET_RIGHT = 0.6;
export const CAMERA_OFFSET_UP = 1.6;
export const CAMERA_OFFSET_BACK = 4.5;
export const CAMERA_FOV = 70;
/** FOV while charging (scaled relative to the user's FOV setting: fov × 62/70). */
export const CAMERA_FOV_CHARGE = 62;
export const CAMERA_FOV_MIN = 60;
export const CAMERA_FOV_MAX = 100;
/** Camera sphere radius for cover collision. */
export const CAMERA_COLLISION_RADIUS = 0.25;
/** Spectator ghost camera free-fly speed and bounds. */
export const GHOST_CAMERA_SPEED = 9;
export const GHOST_CAMERA_MIN_Y = 2;
export const GHOST_CAMERA_MAX_Y = 18;
/** Final-KO camera cut duration. */
export const KO_CUT_SEC = 1;

/* ============================================================ client net */

/** Remote players are rendered this far in the past (snapshot interpolation). */
export const INTERP_DELAY_MS = 100;
/** Max extrapolation when snapshots run dry. */
export const MAX_EXTRAPOLATION_MS = 100;
/** Prediction error smoothing time constant and snap threshold. */
export const PREDICTION_SMOOTH_MS = 100;
export const PREDICTION_SNAP_DIST = 2;
/** Ball snapshot blending and snap threshold. */
export const BALL_SMOOTH_MS = 100;
export const BALL_SNAP_DIST = 3;
/** Predicted ball with no matching server ball after this long fades out. */
export const PREDICTED_BALL_TIMEOUT_MS = 600;
/** Pending (unacked) input buffer cap on the client. */
export const MAX_PENDING_INPUTS = 120;

/* ======================================================= room & players */

export const MAX_PLAYERS = 8;
export const MIN_PLAYERS_TO_START = 2;
export const NICKNAME_MIN = 1;
export const NICKNAME_MAX = 16;
/** Same alphabet as the hub (no I/O, no digits). */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 4;
export const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
/** sessionStorage key for the Colyseus reconnection token. */
export const RECONNECT_STORAGE_KEY = "bonk-brawl.reconnect";
/** localStorage key for client settings. */
export const SETTINGS_STORAGE_KEY = "bonk-brawl.settings.v1";

/* =============================================================== colors */

/** Player colors by slot: P1 red, P2 blue, P3 green, P4 yellow, P5 purple, P6 orange, P7 pink, P8 teal. */
export const PLAYER_COLORS: ReadonlyArray<string> = [
  "#FF5A5F",
  "#3FA7FF",
  "#7BE07B",
  "#FFC23F",
  "#B07CFF",
  "#FF8A3D",
  "#FF7EC8",
  "#3FD9C8",
];
export const PLAYER_COLOR_NAMES: ReadonlyArray<string> = ["Red", "Blue", "Green", "Yellow", "Purple", "Orange", "Pink", "Teal"];

export const PALETTE = {
  grass: "#7BD389",
  grassShadow: "#4FA36B",
  skyTop: "#6EC6FF",
  skyBottom: "#D6F1FF",
  cloud: "#FFFFFF",
  cloudShadow: "#CFE3F2",
  wood: "#C68B59",
  woodDark: "#8D5B3A",
  frosting: "#FFB7D5",
  bathTile: "#F4F7FA",
  bathGrout: "#C9D4DE",
  neutralBall: "#FFF4DC",
  uiYellow: "#FFCF33",
  uiRed: "#FF5A5F",
  ink: "#2D2A32",
  crownGold: "#FFD23F",
  white: "#FFFFFF",
} as const;

export function playerColor(slot: number): string {
  return PLAYER_COLORS[((slot % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length];
}

/* =========================================================== characters */

export interface CharacterColors {
  /** Main body color. */
  body: string;
  /** Belly / face patch / secondary color. */
  secondary: string;
  /** Beak, nose, horns, feet... */
  accent: string;
  /** Accessory (hat, bow tie, scarf, bell collar). */
  accessory: string;
  /** Eye whites / pupils. */
  eye: string;
}

export interface CharacterDef {
  id: CharacterId;
  name: string;
  animal: AnimalKind;
  /** Kill feed / scoreboard icon. */
  emoji: string;
  /** One line shown in the character carousel. */
  description: string;
  /** Short look description for the renderer. */
  look: string;
  ability: {
    id: AbilityId;
    name: string;
    description: string;
    /** HUD ability icon (emoji). */
    icon: string;
    cooldownTicks: number;
    /** Active duration in ticks (0 for instant/armed abilities). */
    durationTicks: number;
  };
  colors: CharacterColors;
  /** Voice SFX flavor (procedural synth preset name). */
  voice: "quack" | "ribbit" | "grumble" | "meow" | "squawk" | "bleat";
}

export const CHARACTER_IDS: ReadonlyArray<CharacterId> = ["quacky", "hopsworth", "mochi", "whiskers", "pip", "gruff"];
export const DEFAULT_CHARACTER: CharacterId = "quacky";

export const CHARACTERS: Readonly<Record<CharacterId, CharacterDef>> = {
  quacky: {
    id: "quacky",
    name: "Quacky",
    animal: "duck",
    emoji: "🦆",
    description: "A plucky duck who never stays grounded for long.",
    look: "Yellow duck, orange beak and feet, tiny white sailor hat with a blue band",
    ability: {
      id: "flapDash",
      name: "Flap Dash",
      description: "Quick 5 m dash in any direction, even mid-air.",
      icon: "🪶",
      cooldownTicks: secToTicks(6),
      durationTicks: FLAP_DASH_TICKS,
    },
    colors: { body: "#FFD84A", secondary: "#FFF1A8", accent: "#FF9A2E", accessory: "#FFFFFF", eye: "#2D2A32" },
    voice: "quack",
  },
  hopsworth: {
    id: "hopsworth",
    name: "Hopsworth",
    animal: "frog",
    emoji: "🐸",
    description: "A dapper frog with a bow tie and a heavy landing.",
    look: "Green frog, pale belly, huge eyes on top of the head, red bow tie",
    ability: {
      id: "groundPound",
      name: "Ground Pound",
      description: "Leap, then slam down. The shockwave knocks nearby players back (no damage).",
      icon: "💥",
      cooldownTicks: secToTicks(9),
      durationTicks: GROUND_POUND_MAX_TICKS,
    },
    colors: { body: "#6CC24A", secondary: "#C9EFA0", accent: "#3E8E2F", accessory: "#E8384F", eye: "#2D2A32" },
    voice: "ribbit",
  },
  mochi: {
    id: "mochi",
    name: "Mochi",
    animal: "bear",
    emoji: "🐻",
    description: "A round, sleepy bear. Balls just bounce off that belly.",
    look: "Round brown bear, tan muzzle and belly, pink cheeks, small round ears",
    ability: {
      id: "bellyBounce",
      name: "Belly Bounce",
      description: "For 1.5 s, balls that hit you bounce off harmlessly.",
      icon: "🫧",
      cooldownTicks: secToTicks(12),
      durationTicks: BELLY_BOUNCE_TICKS,
    },
    colors: { body: "#A8714A", secondary: "#E9C9A0", accent: "#FF9EB5", accessory: "#FF9EB5", eye: "#2D2A32" },
    voice: "grumble",
  },
  whiskers: {
    id: "whiskers",
    name: "Whiskers",
    animal: "cat",
    emoji: "🐱",
    description: "A smug tabby whose throws never fly quite straight.",
    look: "Grey tabby with darker stripes, smug half-lidded eyes, red collar with a gold bell",
    ability: {
      id: "curveball",
      name: "Curveball",
      description: "Your next throw curves toward wherever your crosshair drifts.",
      icon: "🌀",
      cooldownTicks: secToTicks(10),
      durationTicks: 0,
    },
    colors: { body: "#9DA3AE", secondary: "#E6E8EC", accent: "#6B717C", accessory: "#E8384F", eye: "#7BC043" },
    voice: "meow",
  },
  pip: {
    id: "pip",
    name: "Pip",
    animal: "penguin",
    emoji: "🐧",
    description: "A speedy penguin in a red scarf. Slides under trouble.",
    look: "Black and white penguin, orange beak and feet, long red scarf",
    ability: {
      id: "bellySlide",
      name: "Belly Slide",
      description: "2 s fast, low slide. Head-height balls fly right over you.",
      icon: "🛷",
      cooldownTicks: secToTicks(8),
      durationTicks: BELLY_SLIDE_TICKS,
    },
    colors: { body: "#2F3440", secondary: "#FFFFFF", accent: "#FF9A2E", accessory: "#E8384F", eye: "#2D2A32" },
    voice: "squawk",
  },
  gruff: {
    id: "gruff",
    name: "Gruff",
    animal: "goat",
    emoji: "🐐",
    description: "A stubborn goat with curly horns. Great for ring-outs.",
    look: "White goat, curly tan horns, little beard, brass bell on a collar",
    ability: {
      id: "headbutt",
      name: "Headbutt",
      description: "Short 3 m lunge. Hitting a player sends them flying (no damage).",
      icon: "🐏",
      cooldownTicks: secToTicks(9),
      durationTicks: HEADBUTT_TICKS,
    },
    colors: { body: "#F4F1EA", secondary: "#E0D6C2", accent: "#C9A46A", accessory: "#D4A72C", eye: "#2D2A32" },
    voice: "bleat",
  },
};

/* ======================================================= power-up defs */

export interface PowerUpDef {
  type: PowerUpType;
  name: string;
  description: string;
  /** HUD / kill feed icon. */
  icon: string;
  /** Main color for the pickup model and HUD badge. */
  color: string;
  /** true: applies to your next throw (stored in player.powerUp). false: applies instantly (zoomies). */
  onNextThrow: boolean;
}

export const POWERUP_TYPES: ReadonlyArray<PowerUpType> = ["mega", "triple", "boomerang", "zoomies"];

export const POWERUPS: Readonly<Record<PowerUpType, PowerUpDef>> = {
  mega: {
    type: "mega",
    name: "Mega Ball",
    description: "Next throw is a giant ball with double knockback.",
    icon: "🔴",
    color: "#FF4D4D",
    onNextThrow: true,
  },
  triple: {
    type: "triple",
    name: "Triple Shot",
    description: "Next throw fires 3 balls in a spread. Carry up to 2 balls.",
    icon: "🎱",
    color: "#8E6CFF",
    onNextThrow: true,
  },
  boomerang: {
    type: "boomerang",
    name: "Boomerang",
    description: "Next throw comes back to you if it misses.",
    icon: "🍌",
    color: "#FFE14D",
    onNextThrow: true,
  },
  zoomies: {
    type: "zoomies",
    name: "Zoomies",
    description: "+40% move speed for 6 seconds.",
    icon: "👟",
    color: "#3FD6C6",
    onNextThrow: false,
  },
};

/* ============================================================== emotes */

export const EMOTE_IDS: ReadonlyArray<EmoteId> = ["honk", "wave", "dance"];
export const EMOTES: Readonly<Record<EmoteId, { name: string; icon: string; durationSec: number }>> = {
  honk: { name: "Honk", icon: "📯", durationSec: 0.8 },
  wave: { name: "Wave", icon: "👋", durationSec: 1.2 },
  dance: { name: "Dance", icon: "💃", durationSec: 2.0 },
};

/* ================================================================ maps */

export const MAP_IDS: ReadonlyArray<MapId> = ["picnic", "bath", "cake"];
export const DEFAULT_MAP: MapId = "picnic";
