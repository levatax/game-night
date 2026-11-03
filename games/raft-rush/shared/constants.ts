// Raft Rush balance numbers and tuning. FROZEN CONTRACT (see docs/ARCHITECTURE.md).
//
// Seconds are authored as *_SEC and converted to integer ticks (*_TICKS) with secToTicks().
// Every gameplay timer inside the simulation is an integer tick count (30 Hz) so replays are exact.
// Distances in meters, speeds in m/s, angles in radians unless the name says DEG. Numbers come from
// game4.md §21 unless a comment says otherwise. Item / recipe / loot tables live in items.ts.

import type {
  Biome,
  BotRole,
  CharacterId,
  DayEventKind,
  Difficulty,
  EmoteId,
  FishLoot,
  MarkerKind,
  TitleId,
  Weather,
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

export const GAME_ID = "raft-rush";

/* ================================================================ world */

/** Gravity for players and projectiles (m/s², negative = down). */
export const GRAVITY = -20;
/** Terminal fall speed (positive magnitude). */
export const MAX_FALL_SPEED = 30;
/** Sea surface height. Terrain below it is water. */
export const WATER_Y = 0;
/** Heightfield vertex spacing (meters). */
export const CELL_SIZE = 1;
/** Heightfield vertex counts. Solo: 96 m × 96 m centered on the origin; duel: 192 m × 128 m (two islands + strait). */
export const SOLO_GRID = { cols: 97, rows: 97 } as const;
export const DUEL_GRID = { cols: 193, rows: 129 } as const;
/** Players can't walk/swim closer than this to the heightfield edge (invisible wall in the open sea). */
export const WORLD_EDGE_MARGIN = 6;
/** Ocean floor height far from the island. */
export const SEA_FLOOR_Y = -4;
/** Solo island: ~60 m across (radius before the coastline noise). Duel islands use the same radius. */
export const ISLAND_RADIUS = 30;
/** Highest terrain point, meters above the sea. */
export const PEAK_MIN = 8;
export const PEAK_MAX = 10;
/** Terrain below this (and above the water) is sand / beach. Render + placement. */
export const BEACH_MAX_Y = 0.6;
/** Duel: open water between the two coastlines. */
export const STRAIT_MIN = 26;
export const STRAIT_MAX = 30;
/** Placement corridor guarantee: camp↔wreck↔raft↔shore paths keep this much clearance (no nodes). */
export const CORRIDOR_WIDTH = 2;
/** Camp (campfire) distance from the wreck. */
export const CAMP_FROM_WRECK_MIN = 8;
export const CAMP_FROM_WRECK_MAX = 12;
/** Chest sits this far from the campfire (toward the wreck side). */
export const CHEST_FROM_FIRE = 2.2;
/** Fish spots per island (rocky biome adds more, see BIOMES). */
export const FISH_SPOTS_MIN = 4;
export const FISH_SPOTS_MAX = 6;

/* ========================================================== player body */

export const PLAYER_RADIUS = 0.42;
/** Kolluklu Çocuk's smaller capsule. */
export const PLAYER_RADIUS_SMALL = 0.34;
export const PLAYER_HEIGHT = 1.7;
/** Camera eye height above the feet. */
export const EYE_HEIGHT = 1.55;
/** Downed players crawl: camera at this height. */
export const DOWNED_EYE_HEIGHT = 0.45;
/** Chest height above the feet (catch sphere center). */
export const CHEST_HEIGHT = 1.2;
/** Throw origin = eye + HAND_FORWARD forward + HAND_RIGHT right (§19). */
export const HAND_FORWARD = 0.3;
export const HAND_RIGHT = 0.25;
/** Max terrain rise per sub-step the player walks onto; higher = cliff (the step is rejected, slide along the contour). */
export const STEP_MAX = 0.5;
/** Terrain steeper than ~56° (normal.y below this) is a wall. */
export const MAX_WALK_NORMAL_Y = 0.56;
/** Players push each other apart so capsules don't overlap (world). */
export const PLAYER_SEPARATION = PLAYER_RADIUS * 2;

/* ============================================================= movement */

export const WALK_SPEED = 4.6;
export const SPRINT_SPEED = 7;
/** Speed multipliers (they stack multiplicatively). */
export const CHARGE_MOVE_MULT = 0.6;
/** Hunger or thirst at 0. */
export const STARVING_MOVE_MULT = 0.7;
/** Warmth at 0 (shivering). */
export const FREEZING_MOVE_MULT = 0.6;
export const DOWNED_MOVE_MULT = 0.25;
export const SWIM_SPEED_MULT = 0.5;
export const GROUND_ACCEL = 50;
export const GROUND_DECEL = 40;
/** Fraction of ground accel available in the air. */
export const AIR_CONTROL = 0.4;
export const WATER_ACCEL = 14;
export const JUMP_HEIGHT = 1.1;
/** sqrt(2·g·h) ≈ 6.63 m/s. */
export const JUMP_VELOCITY = Math.sqrt(2 * -GRAVITY * JUMP_HEIGHT);
export const COYOTE_TICKS = secToTicks(0.1);
/** Pitch clamp (±), §19. */
export const PITCH_LIMIT = 1.5;
/** Swimming when the feet are more than this below the water surface (§19: feetY < WATER_Y − 0.6). */
export const SWIM_DEPTH = 0.6;
/** Over deep water a swimmer floats with the feet this far below the surface. */
export const SWIM_FLOAT_DEPTH = 1.1;
/** Buoyancy pull toward the float depth (m/s² per meter of offset) and vertical damping. */
export const SWIM_BUOYANCY = 18;
export const SWIM_DAMPING = 6;
/** Drowning starts after this long in the water: DROWN_DAMAGE_PER_SEC hp. */
export const DROWN_TICKS = secToTicks(20);
export const DROWN_DAMAGE_PER_SEC = 10;

/* ======================================================= charge & throw */

/** 0.6 s to full charge (§11). */
export const CHARGE_FULL_TICKS = secToTicks(0.6);
export const THROW_SPEED_MIN = 12;
/** Full charge: 34 m/s with GRAVITY −20 → max range ≈ 58 m (§21). */
export const THROW_SPEED_MAX = 34;
/** Added to aim pitch for the release direction (crosshair shots arc onto mid-range targets). */
export const THROW_PITCH_BIAS = 0.05;
export const THROW_RECOVER_TICKS = secToTicks(0.25);
/** Recovery after a LMB "use" with a non-throwable (palm hit, rod cast, torch swing, place). */
export const USE_RECOVER_TICKS = secToTicks(0.4);
/** Q toss / pass: fixed speed and extra pitch, any item, one unit. */
export const TOSS_SPEED = 9;
export const TOSS_PITCH = 0.3;
export const FULL_CHARGE_THRESHOLD = 0.999;
/** Arc preview (dotted) only after this charge fraction (§11). */
export const ARC_PREVIEW_MIN_CHARGE = 0.5;
export const ARC_PREVIEW_MAX_POINTS = 32;
/** Preview covers this fraction of the flight time to the first impact. */
export const ARC_PREVIEW_FRACTION = 0.7;
/** coconut_ball splits into this many coconuts at release, ±spread. */
export const COCONUT_BALL_COUNT = 3;
export const COCONUT_BALL_SPREAD = (12 * Math.PI) / 180;

/* ======================================================== hits & damage */

/** Player hit by a live projectile (any source): stunned 0.3 s (§11). */
export const HIT_STUN_TICKS = secToTicks(0.3);
/** Knockback on a projectile hit: horizontal along the projectile travel + up, × ITEMS[kind].knock. */
export const KNOCKBACK_H = 5;
export const KNOCKBACK_UP = 3;
/** Friendly fire in coop: no damage, knockback × this ("for the laughs"). */
export const FRIENDLY_KNOCK_MULT = 0.8;
/** Puffer (kirpi balığı) blast: thrown → explodes on impact; held → explodes PUFFER_FUSE_TICKS after you got it. */
export const PUFFER_BLAST_RADIUS = 3;
export const PUFFER_BLAST_DAMAGE = 2;
/** Damage to the holder when it explodes in hand (and to players in the radius in duel). */
export const PUFFER_SELF_DAMAGE = 25;
export const PUFFER_KNOCK_H = 9;
export const PUFFER_KNOCK_UP = 5;
export const PUFFER_FUSE_TICKS = secToTicks(5);
/** Jellyfish as the active item: −3 hp/s ("AAAH"). */
export const JELLYFISH_DAMAGE_PER_SEC = 3;
/** Torch swing (LMB with a lit torch): crabs within range flee for 1 s. */
export const TORCH_SWING_RANGE = 2;
export const TORCH_SWING_SCARE_TICKS = secToTicks(1);
/** Kraken tentacle (placed): thrashes for this long, flinging monsters within the radius. */
export const KRAKEN_TICKS = secToTicks(10);
export const KRAKEN_RADIUS = 4;
export const KRAKEN_HIT_INTERVAL_TICKS = secToTicks(1);
/** Cooked kraken: every teammate +30 hunger. */
export const KRAKEN_TEAM_FOOD = 30;

/* ============================================================== catches */

export const CATCH_WINDOW_TICKS = secToTicks(0.3);
export const CATCH_COOLDOWN_TICKS = secToTicks(0.8);
/** Catch sphere: center chest + forward·CATCH_FORWARD, radius CATCH_RANGE (+ projectile radius). */
export const CATCH_RANGE = 1.4;
export const CATCH_FORWARD = 0.5;

/* =========================================================== projectiles */

export const MAX_PROJECTILES = 48;
export const PROJECTILE_MAX_SPEED = 45;
/** Below this speed on the ground for PROJECTILE_REST_TICKS → rest. */
export const PROJECTILE_REST_SPEED = 0.5;
export const PROJECTILE_REST_TICKS = 6;
/** Rolling deceleration on the ground (m/s²). */
export const PROJECTILE_ROLL_DECEL = 6;
/** Tangential velocity kept on a bounce. */
export const PROJECTILE_BOUNCE_FRICTION = 0.8;
/** Vertical speed below which a bounce becomes a roll. */
export const PROJECTILE_MIN_BOUNCE_VY = 1.2;
/** Resting ground items despawn after this (oldest first when over MAX_PROJECTILES). */
export const GROUND_ITEM_DESPAWN_TICKS = secToTicks(150);
/** Pickup range for ground items (E). */
export const PICKUP_RANGE = 2.2;
/** A fish on the ground is bait: attracts crabs within BAIT_RADIUS for BAIT_TICKS (boss: BOSS_BAIT_TICKS). */
export const BAIT_TICKS = secToTicks(8);
export const BAIT_RADIUS = 15;
/** Thrown wood / jellyfish landing this close to a lit campfire or torch is burned as fuel. */
export const FUEL_CATCH_RADIUS = 1.4;
/** Fallen coconut spawn: drops from this height above the ground under the crown. */
export const COCONUT_DROP_HEIGHT = 5;

/* ======================================================== survival bars */

export const BAR_MAX = 100;
export const MAX_HP = 100;
/** Per minute of game time (× difficulty BAR_MULT). */
export const HUNGER_PER_MIN = 25;
export const THIRST_PER_MIN = 33;
export const SPRINT_HUNGER_MULT = 1.5;
export const HEATWAVE_THIRST_MULT = 2;
/** Warmth drops at night, in rain and in water when farther than FIRE_WARM_RADIUS from a lit fire. */
export const WARMTH_LOSS_PER_SEC = 2;
/** Holding a lit torch slows the loss to this. */
export const TORCH_WARMTH_LOSS_PER_SEC = 1;
export const WARMTH_GAIN_FIRE_PER_SEC = 5;
export const FIRE_WARM_RADIUS = 3;
/** Every empty bar costs this much hp per second. */
export const EMPTY_BAR_DAMAGE_PER_SEC = 2;
/** Standing near a lit campfire heals (the only passive heal). */
export const FIRE_HEAL_PER_SEC = 3;
/** Eating any food heals this much. */
export const EAT_HEAL = 10;
/** Bars below this fraction flash on the HUD and trigger one feed line. */
export const LOW_BAR_FRACTION = 0.3;
/** Bars after washing ashore and respawning at dawn. */
export const RESPAWN_BARS = 60;
export const RESPAWN_HP = 60;
/** Berry bushes are eaten on the spot. */
export const BERRY_FOOD = 15;
export const SPRING_WATER = 50;
export const COLLECTOR_WATER = 40;
export const COLLECTOR_USES = 3;
/** Rain fills a collector by one use every this many ticks. */
export const COLLECTOR_FILL_TICKS = secToTicks(10);
/** Shelter from rain (warmth / rain effects): inside the cave radius or a hut. */
export const SHELTER_RADIUS = 3.5;
/** Heat wave: thirst ×1 instead of ×2 when standing under a tree crown (within this of a tree/palm). */
export const SHADE_RADIUS = 2.5;

/* ============================================================ gathering */

/** Hold-E channel kinds (PlayerSimFields.channel). */
export const CHANNEL = { NONE: 0, GATHER: 1, REVIVE: 2 } as const;
/** Hold times for one unit (§21). */
export const GATHER_SEC = { wood: 2.5, woodAxe: 1, rope: 1.5, stone: 2, berry: 1 } as const;
/** Initial amount per node kind (§6). Bushes with yield "none" have 0. */
export const NODE_AMOUNT = { tree: 3, palm: 2, rock: 2, bush: 2 } as const;
/** Palms regrow their coconuts (to full) this long after being emptied. */
export const PALM_REGROW_TICKS = secToTicks(60);
/** Berry bushes regrow (rope bushes don't). */
export const BERRY_REGROW_TICKS = secToTicks(90);
/** Base node counts for a solo island, × BIOMES[b].counts (§9). */
export const BASE_NODE_COUNTS = { tree: 120, palm: 30, rock: 60, bush: 80 } as const;
/** Node collider radii / heights (trunks and boulders; bushes don't collide). */
export const TREE_TRUNK_RADIUS = 0.35;
export const PALM_TRUNK_RADIUS = 0.3;
export const ROCK_RADIUS_MIN = 0.55;
export const ROCK_RADIUS_MAX = 1.0;
/** E reach and view cone for interactions (horizontal cos). */
export const INTERACT_RANGE = 2.4;
export const INTERACT_CONE_COS = 0.5;
/** LMB on a palm within this range shakes a coconut loose (axe: all of them). */
export const PALM_HIT_RANGE = 2.6;
/** A thrown coconut / stone hitting a palm trunk also drops one. */
export const PALM_THROW_DROPS = 1;

/* ============================================== campfire, light & stations */

/** The campfire starts with 60 s of fuel; wood +30 s; cap FIRE_FUEL_MAX (§7, cap: interpretation). */
export const FIRE_START_FUEL_TICKS = secToTicks(60);
export const FIRE_WOOD_FUEL_TICKS = secToTicks(30);
export const FIRE_FUEL_MAX_TICKS = secToTicks(180);
export const FUEL_CAN_TICKS = secToTicks(120);
export const JELLYFISH_FUEL_TICKS = secToTicks(60);
/** Rain drains the fire this many times faster (interpretation of "ateş söner": goes out quickly, can be fed). */
export const RAIN_FIRE_DRAIN_MULT = 3;
/** Banner for everyone when the fire drops below this fraction of FIRE_START_FUEL_TICKS. */
export const FIRE_LOW_FRACTION = 0.2;
/** Monsters never enter these light rings (boss excepted: it only slows down). */
export const FIRE_LIGHT_RADIUS = 5;
export const TORCH_LIGHT_RADIUS = 4;
export const TORCH_BURN_TICKS = secToTicks(90);
/** Ranges from the site centers (server allows +0.5 m slack for latency). */
export const CRAFT_RANGE = 3.5;
export const CHEST_RANGE = 3;
export const RAFT_RANGE = 4.5;
export const SPRING_RANGE = 2.6;
export const COLLECTOR_RANGE = 2.2;
export const SECRET_CHEST_RANGE = 2.4;
export const REVIVE_RANGE = 2.2;
/** Placeables appear this far in front of the player. */
export const PLACE_DISTANCE = 1.8;
export const FENCE_HP = 4;
export const FENCE_LENGTH = 2.2;
export const COLLECTOR_HP = 3;
export const MAX_STRUCTURES = 24;

/* ================================================================== raft */

/** Requirements by seat count (§7 table). Index with raftCost(seats) in items.ts. */
export const RAFT_COSTS: Readonly<Record<number, { hullWood: number; mastWood: number; mastRope: number; food: number; water: number }>> = {
  2: { hullWood: 10, mastWood: 4, mastRope: 4, food: 2, water: 2 },
  3: { hullWood: 13, mastWood: 4, mastRope: 5, food: 3, water: 3 },
  4: { hullWood: 16, mastWood: 4, mastRope: 6, food: 4, water: 4 },
  5: { hullWood: 20, mastWood: 4, mastRope: 7, food: 5, water: 5 },
  6: { hullWood: 24, mastWood: 4, mastRope: 8, food: 6, water: 6 },
};
/** The wreck counts as one free raft part toward the hull (§6). */
export const WRECK_HULL_WOOD = 3;
/** A raft part counts as this much wood (Kaptan's count +1). */
export const RAFT_PART_WOOD = 3;
/** Crabs gnaw 1 hull wood per this many ticks when nobody guards the raft (§7). */
export const RAFT_GNAW_TICKS = secToTicks(4);
export const RAFT_GUARD_RADIUS = 6;
/** Once the first player boards a ready raft, the rest have this long; then it leaves anyway. */
export const LAUNCH_WAIT_TICKS = secToTicks(20);

/* ======================================================= downed & revive */

export const DOWNED_TICKS = secToTicks(10);
export const REVIVE_TICKS = secToTicks(3);
export const REVIVE_HP = 50;

/* ============================================================== fishing */

export const FISH_STATE = { NONE: 0, CAST: 1, BITE: 2, REEL: 3 } as const;
/** Max distance from the eye to a fish spot center you can cast at (looking at it). */
export const FISH_CAST_RANGE = 14;
/** A fish spot is a circle of foamy water. */
export const FISH_SPOT_RADIUS = 2.5;
export const FISH_WAIT_MIN_TICKS = secToTicks(2);
export const FISH_WAIT_MAX_TICKS = secToTicks(6);
/** Click window after the bobber dips (§8), plus a latency allowance (≤ 150 ms of the fisher's RTT/2). */
export const FISH_BITE_TICKS = secToTicks(0.6);
export const FISH_LAG_ALLOWANCE_MAX_TICKS = secToTicks(0.15);
/** The "what did I catch?" reel spins this long before the item lands in the inventory. */
export const FISH_REEL_TICKS = secToTicks(2.5);
/** Walking this far from the cast position reels the line in (cancel). */
export const FISH_CANCEL_DIST = 2;
/** Bad-luck protection: after this many junk catches (boot / jellyfish) in a row, the next is ≥ a fish. */
export const FISH_PITY = 4;
/** Treasure chests (fishing / secret chest) spin a second reel this long. */
export const TREASURE_REEL_TICKS = secToTicks(2.5);
/** Spyglass: all resources on the compass for 30 s. */
export const SPYGLASS_TICKS = secToTicks(30);
/** Pirate hat: +20 MVP points. */
export const PIRATE_HAT_SCORE = 20;

/* ============================================================== monsters */

export interface MonsterDef {
  hp: number;
  speed: number;
  damage: number;
  /** Ticks between bites while in contact. */
  biteCooldownTicks: number;
  radius: number;
  height: number;
  /** Knockback dealt on a bite / contact. */
  knockH: number;
  knockUp: number;
}

export const MONSTERS: Readonly<Record<"crab" | "puffer" | "boss" | "monkey" | "gull", MonsterDef>> = {
  /** Slow, armored; 2 damage flips it (8 s helpless, E collects a raw crab). */
  crab: { hp: 2, speed: 3, damage: 15, biteCooldownTicks: secToTicks(1.2), radius: 0.5, height: 0.6, knockH: 3, knockUp: 2 },
  /** Rolls fast, snags on fences; contact = 20 damage + knockback and it pops; 1 damage pops it. */
  puffer: { hp: 1, speed: 6.5, damage: 20, biteCooldownTicks: secToTicks(1), radius: 0.45, height: 0.9, knockH: 8, knockUp: 4 },
  /** Kaptan Yengeç: targets the raft, breaks fences, never flips, light only slows it. */
  boss: { hp: 12, speed: 2.6, damage: 35, biteCooldownTicks: secToTicks(1.6), radius: 1.1, height: 1.4, knockH: 7, knockUp: 4 },
  /** Daytime thieves. A coconut hit makes them drop what they carry. */
  monkey: { hp: 1, speed: 5, damage: 0, biteCooldownTicks: secToTicks(2), radius: 0.4, height: 0.9, knockH: 0, knockUp: 0 },
  gull: { hp: 1, speed: 7, damage: 0, biteCooldownTicks: secToTicks(2), radius: 0.4, height: 0.5, knockH: 0, knockUp: 0 },
};
export const CRAB_FLIP_TICKS = secToTicks(8);
export const MONSTER_EMERGE_TICKS = secToTicks(1.5);
/** Boss slowed to this inside light rings. */
export const BOSS_LIGHT_SLOW = 0.5;
export const BOSS_BAIT_TICKS = secToTicks(5);
/** Players within this of a monster become its target (priority 1). */
export const MONSTER_AGGRO_RADIUS = 10;
/** Crabs gnaw through a fence in 4 s; the boss smashes it at once. */
export const FENCE_GNAW_TICKS = secToTicks(4);
/** At most this many monsters alive; the rest of a night's wave queues. */
export const MONSTER_CAP = 16;
/** AI decisions every N ticks (movement every tick). */
export const MONSTER_THINK_TICKS = 5;
/** Night waves spawn spread over the first fraction of the night. */
export const MONSTER_SPAWN_WINDOW = 0.6;
/** Spawns prefer shore cells on the far side of the camp (weight ∝ distance^this). */
export const MONSTER_SPAWN_FAR_BIAS = 2;

/**
 * Per-player threat multiplier (v4 §4.1): linear, `min(2.2, 1 + 0.30 × (seats − 2))`, so 2p 1.00 /
 * 3p 1.30 / 4p 1.60 / 5p 1.90 / 6p 2.20. Enemy HP never scales; only the count of crabs does.
 */
export function threatMult(seats: number): number {
  return Math.min(2.2, 1 + 0.3 * (Math.max(2, seats) - 2));
}

/** Base crab counts at 2 seats, one per night. */
export const NIGHT_BASE_CRABS: ReadonlyArray<number> = [5, 8, 10];

/**
 * Monsters per night (§21): crabs, puffers, boss. `seats` = players incl. bots.
 * Crabs = ceil(base × threatMult(seats)); at 2 seats this is the old 5 / 8 / 10. Puffers and the boss
 * are fixed wave add-ons (2 / 3 puffers on nights 2 / 3, boss on night 3), not seat-scaled.
 */
export function nightWave(night: number, seats: number): { crabs: number; puffers: number; boss: number } {
  const base = NIGHT_BASE_CRABS[Math.min(Math.max(1, night), NIGHT_BASE_CRABS.length) - 1]!;
  const crabs = Math.max(1, Math.ceil(base * threatMult(seats)));
  if (night <= 1) return { crabs, puffers: 0, boss: 0 };
  if (night === 2) return { crabs, puffers: 2, boss: 0 };
  return { crabs, puffers: 3, boss: 1 };
}

/** Duel balancing hook (§13): night pressure on a camp. */
export function monsterPressure(base: number, playersAway: number, torches: number): number {
  return base * (1 + 0.25 * playersAway) * Math.max(0.25, 1 - 0.15 * torches);
}

/* ============================================================ difficulty */

export interface DifficultyDef {
  /** Monster counts ×. */
  monsters: number;
  /** Bar drain ×. */
  bars: number;
  /** The boss also comes on night 2. */
  bossNight2: boolean;
}

export const DIFFICULTIES: Readonly<Record<Difficulty, DifficultyDef>> = {
  vacation: { monsters: 0.6, bars: 0.7, bossNight2: false },
  normal: { monsters: 1, bars: 1, bossNight2: false },
  nightmare: { monsters: 1.5, bars: 1.3, bossNight2: true },
};
export const DIFFICULTY_IDS: ReadonlyArray<Difficulty> = ["vacation", "normal", "nightmare"];
export const DEFAULT_DIFFICULTY: Difficulty = "normal";

/* ================================================ day / night schedule */

export const LANDING_SEC = 10;
/** First seconds of the landing: input locked (wake-up camera). */
export const LANDING_LOCK_SEC = 3;
export const DAY_SEC = 95;
export const DUSK_SEC = 10;
export const NIGHT_SEC = 50;
export const DAYS = 3;
/** Lose cinematic after night 3 / win cinematic after the launch. */
export const STORM_SEC = 12;
export const LAUNCH_SEC = 8;
/** "FIRTINA!" warning this long before night 3 ends (banner + music). */
export const STORM_WARN_SEC = 30;
/**
 * Warning ladder (v4 §3): lead seconds before night 1, night 2 and the final storm. A pacing hypothesis,
 * not a readability finding; the floor is 12 s (measured p95 traverse + 3–5 s, provisional).
 */
export const WARN_LEADS_SEC: ReadonlyArray<number> = [30, 20, 15];
/** The raft only leaves this close to the end of night 3: no departure before the storm window (§7). */
export const DEPARTURE_GATE_TICKS = 150;
export const MATCH_END_LOBBY_SEC = 60;
/** Rematch is accepted after this long on the podium. */
export const MATCH_END_MIN_SEC = 3;

/** Phase lengths in ticks. `FAST_TIMINGS` replaces them when the server runs RAFT_TEST=1 with fast: true. */
export interface Timings {
  landing: number;
  landingLock: number;
  day: number;
  dusk: number;
  night: number;
  storm: number;
  launch: number;
  launchWait: number;
  matchEndLobby: number;
  matchEndMin: number;
  /** Bar drain multiplier on top of difficulty. */
  barMult: number;
  /** Raft costs collapse to 1 of everything. */
  cheapRaft: boolean;
}

export const NORMAL_TIMINGS: Readonly<Timings> = {
  landing: secToTicks(LANDING_SEC),
  landingLock: secToTicks(LANDING_LOCK_SEC),
  day: secToTicks(DAY_SEC),
  dusk: secToTicks(DUSK_SEC),
  night: secToTicks(NIGHT_SEC),
  storm: secToTicks(STORM_SEC),
  launch: secToTicks(LAUNCH_SEC),
  launchWait: LAUNCH_WAIT_TICKS,
  matchEndLobby: secToTicks(MATCH_END_LOBBY_SEC),
  matchEndMin: secToTicks(MATCH_END_MIN_SEC),
  barMult: 1,
  cheapRaft: false,
};

/** RAFT_TEST=1 + create option fast: day 4 s, bars ×20, raft costs 1 (§19). */
export const FAST_TIMINGS: Readonly<Timings> = {
  landing: secToTicks(1),
  landingLock: 0,
  day: secToTicks(4),
  dusk: secToTicks(1),
  night: secToTicks(3),
  storm: secToTicks(1),
  launch: secToTicks(1),
  launchWait: secToTicks(2),
  matchEndLobby: secToTicks(5),
  matchEndMin: 0,
  barMult: 20,
  cheapRaft: true,
};

export function timingsFor(fast: boolean): Readonly<Timings> {
  return fast ? FAST_TIMINGS : NORMAL_TIMINGS;
}

/* =============================================== weather & day events */

/** Day 1 may be clear; from day 2 on there is always a weather event (§9). */
export const DAY1_WEATHER_CHANCE = 0.35;
export const WEATHER_IDS: ReadonlyArray<Exclude<Weather, "clear">> = ["rain", "fog", "heatwave", "fullmoon"];
/** Weather starts at this fraction of the day and lasts until the next dawn. */
export const WEATHER_START_FRACTION = 0.5;
/** Fog: view distance. */
export const FOG_WEATHER_DISTANCE = 25;
/** Full moon: monsters ×1.5, but the night is almost as bright as day. */
export const FULLMOON_MONSTER_MULT = 1.5;
/** One random daytime mini-event per day at this fraction of the day. */
export const DAY_EVENT_FRACTION = 0.3;
export const DAY_EVENT_IDS: ReadonlyArray<DayEventKind> = ["gull", "monkeys", "waveGift"];
/** Şükrü the gull circles this many times before dropping the stolen fish. */
export const GULL_CIRCLES = 3;
export const GULL_CARRY_TICKS = secToTicks(9);

/* ======================================================= scoring & MVP */

/** MVP points (§21). */
export const MVP_POINTS = {
  gather: 1,
  deliver: 3,
  hit: 2,
  kill: 5,
  revive: 10,
  fish: 2,
  golden: 25,
  raid: 8,
  firstAboard: 5,
} as const;
/** Team score on a successful launch: bonus + per second left before the storm (early launch = higher). */
export const LAUNCH_BONUS = 500;
export const LAUNCH_BONUS_PER_SEC = 2;
export const TITLE_IDS: ReadonlyArray<TitleId> = [
  "mvp",
  "crabSlayer",
  "fishLord",
  "porter",
  "hero",
  "tourist",
  "victim",
  "coconutAddict",
];

/* ================================================================ room */

export const MAX_PLAYERS = 6;
export const MAX_BOTS = 5;
/** Starting with a single human and no bots auto-adds this many helpers. */
export const SOLO_AUTO_BOTS = 2;
export const MIN_PLAYERS_TO_START = 1;
export const RECONNECT_GRACE_SEC = 30;
export const EMPTY_ROOM_DISPOSE_SEC = 60;
export const NICKNAME_MIN = 1;
export const NICKNAME_MAX = 16;
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 4;
export const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
export const PING_INTERVAL_MS = 1000;
export const RTT_EMA_ALPHA = 0.25;
/** Max queued inputs per player; older ones are dropped (edge bits carried forward). */
export const INPUT_QUEUE_MAX = 4;
export const MARKER_COOLDOWN_TICKS = secToTicks(1);
/** Pings live this long on the compass / in 3D. */
export const MARKER_TICKS = secToTicks(8);
export const EMOTE_COOLDOWN_TICKS = secToTicks(1);
/** Bot think delay range (seconds), §21. */
export const BOT_THINK_MIN_SEC = 0.6;
export const BOT_THINK_MAX_SEC = 1.5;
/** Bot aim noise (degrees) by role. */
export const BOT_AIM_NOISE_DEG: Readonly<Record<BotRole, number>> = { hamal: 3, balikci: 2, bekci: 1, asci: 3 };
export const BOT_NAMES: ReadonlyArray<string> = ["Bahri", "Mercan", "Yakamoz", "Poyraz", "Lodos"];
export const BOT_ROLES: ReadonlyArray<BotRole> = ["hamal", "balikci", "bekci", "asci", "hamal"];
export const SEED_MAX = 0xffffffff;
export const RECONNECT_STORAGE_KEY = "raft-rush.reconnect";
export const SETTINGS_STORAGE_KEY = "raft-rush.settings.v1";

/* ========================================================= client / net */

export const INTERP_DELAY_MS = 100;
export const MAX_EXTRAPOLATION_MS = 100;
export const PREDICTION_SMOOTH_MS = 100;
export const PREDICTION_SNAP_DIST = 2;
export const PROJECTILE_SMOOTH_MS = 100;
export const PROJECTILE_SNAP_DIST = 3;
export const PREDICTED_PROJECTILE_TIMEOUT_MS = 600;
export const MAX_PENDING_INPUTS = 120;

/* ================================================================ camera */

export const CAMERA_FOV = 75;
/** Sprinting widens the FOV by this many degrees. */
export const CAMERA_FOV_SPRINT = 5;
export const CAMERA_FOV_MIN = 60;
export const CAMERA_FOV_MAX = 100;
/** Head-bob amplitude (m) and frequency (Hz) at walking speed; scales with speed. */
export const HEAD_BOB_AMPLITUDE = 0.045;
export const HEAD_BOB_HZ = 1.9;
/** Fog distance by time of day (§16) and in fog (weather / swamp). */
export const FOG_DAY = 160;
export const FOG_NIGHT = 45;

/* ============================================================ characters */

export interface CharacterDef {
  id: CharacterId;
  /** English display name (client translates `characters.<id>`). */
  name: string;
  /** Turkish name from game4.md. */
  nameTr: string;
  colors: { outfit: string; accent: string; skin: string; hair: string };
  /** Capsule radius. */
  radius: number;
  /** Extra swim speed multiplier (on top of SWIM_SPEED_MULT). */
  swimMult: number;
  /** Loses warmth in the water (Kolluklu Çocuk doesn't). */
  waterChill: boolean;
  /** Extra hunger from cooked food eaten (Şef). */
  cookedBonus: number;
  /** Extra hull/mast wood per raft part delivered (Kaptan). */
  raftPartBonus: number;
  /** Formant voice base pitch (Hz) for the gibberish voice. */
  voiceHz: number;
}

export const CHARACTER_IDS: ReadonlyArray<CharacterId> = ["kaptan", "fenomen", "amca", "gelin", "sef", "cocuk"];
export const DEFAULT_CHARACTER: CharacterId = "kaptan";

export const CHARACTERS: Readonly<Record<CharacterId, CharacterDef>> = {
  /** White uniform, cap, pipe. "The ship didn't sink, it anchored." Raft parts count +1 wood. */
  kaptan: {
    id: "kaptan",
    name: "The Captain",
    nameTr: "Kaptan",
    colors: { outfit: "#F7F7F2", accent: "#1F3A68", skin: "#F2C29B", hair: "#9A9A9A" },
    radius: PLAYER_RADIUS,
    swimMult: 1,
    waterChill: true,
    cookedBonus: 0,
    raftPartBonus: 1,
    voiceHz: 110,
  },
  /** Selfie stick, sunglasses, ring light. Selfie emote; monkeys go for her stick first. */
  fenomen: {
    id: "fenomen",
    name: "The Influencer",
    nameTr: "Fenomen",
    colors: { outfit: "#FF6FB5", accent: "#FFE14D", skin: "#E9B48F", hair: "#3B2418" },
    radius: PLAYER_RADIUS,
    swimMult: 1,
    waterChill: true,
    cookedBonus: 0,
    raftPartBonus: 0,
    voiceHz: 260,
  },
  /** Hawaiian shirt, transistor radio: the island's music plays from his radio. */
  amca: {
    id: "amca",
    name: "Retired Uncle",
    nameTr: "Emekli Amca",
    colors: { outfit: "#3FB7D9", accent: "#FF9A5A", skin: "#D9A07A", hair: "#E8E8E8" },
    radius: PLAYER_RADIUS,
    swimMult: 1,
    waterChill: true,
    cookedBonus: 0,
    raftPartBonus: 0,
    voiceHz: 95,
  },
  /** Veil + flippers + snorkel: the fastest swimmer. */
  gelin: {
    id: "gelin",
    name: "Honeymoon Bride",
    nameTr: "Balayı Gelini",
    colors: { outfit: "#FFFFFF", accent: "#7FD1C7", skin: "#F5CBA7", hair: "#C9853F" },
    radius: PLAYER_RADIUS,
    swimMult: 1.6,
    waterChill: true,
    cookedBonus: 0,
    raftPartBonus: 0,
    voiceHz: 240,
  },
  /** Apron and ladle: cooked food +5 hunger. */
  sef: {
    id: "sef",
    name: "The Chef",
    nameTr: "Şef",
    colors: { outfit: "#FFFFFF", accent: "#E5383B", skin: "#C98E6A", hair: "#2B2B2B" },
    radius: PLAYER_RADIUS,
    swimMult: 1,
    waterChill: true,
    cookedBonus: 5,
    raftPartBonus: 0,
    voiceHz: 130,
  },
  /** Inflatable armbands and a duck ring: no warmth loss in water, smallest hitbox. */
  cocuk: {
    id: "cocuk",
    name: "Floatie Kid",
    nameTr: "Kolluklu Çocuk",
    colors: { outfit: "#FFD166", accent: "#FF7A3D", skin: "#F0C29E", hair: "#6B4226" },
    radius: PLAYER_RADIUS_SMALL,
    swimMult: 1.15,
    waterChill: false,
    cookedBonus: 0,
    raftPartBonus: 0,
    voiceHz: 320,
  },
};

/* ================================================================ biomes */

export interface BiomeDef {
  id: Biome;
  /** × BASE_NODE_COUNTS. */
  counts: { tree: number; palm: number; rock: number; bush: number };
  /** Bush yield shares (the rest are decorative). */
  ropeShare: number;
  berryShare: number;
  crabMult: number;
  pufferMult: number;
  /** Permanent fog distance (m), 0 = none. */
  fog: number;
  /** Warmth drops at night (volcanic ground stays warm). */
  nightChill: boolean;
  /** Extra fish spots on top of FISH_SPOTS_MIN..MAX. */
  extraFishSpots: number;
  /** Fishing loot weight multipliers. */
  loot: Partial<Record<FishLoot, number>>;
  /** Terrain ruggedness 0..1 (rocky: cliffs). */
  rugged: number;
  /** Render palette (client). */
  colors: { sand: string; grass: string; forest: string; rock: string; sky: string; skyDusk: string; skyNight: string; sea: string };
}

export const BIOME_IDS: ReadonlyArray<Biome> = ["tropic", "rocky", "swamp", "volcanic"];

export const BIOMES: Readonly<Record<Biome, BiomeDef>> = {
  tropic: {
    id: "tropic",
    counts: { tree: 1, palm: 1.4, rock: 0.8, bush: 1 },
    ropeShare: 0.5,
    berryShare: 0.4,
    crabMult: 1,
    pufferMult: 1,
    fog: 0,
    nightChill: true,
    extraFishSpots: 0,
    loot: {},
    rugged: 0.25,
    colors: {
      sand: "#F4E4B0",
      grass: "#7CCB6B",
      forest: "#3E8E52",
      rock: "#9C968C",
      sky: "#7FD3F5",
      skyDusk: "#FF9A5A",
      skyNight: "#0B1A33",
      sea: "#3FB7D9",
    },
  },
  rocky: {
    id: "rocky",
    counts: { tree: 0.6, palm: 0.7, rock: 1.8, bush: 0.7 },
    ropeShare: 0.45,
    berryShare: 0.3,
    crabMult: 1,
    pufferMult: 1,
    fog: 0,
    nightChill: true,
    extraFishSpots: 2,
    loot: { treasure: 1.5 },
    rugged: 0.85,
    colors: {
      sand: "#E6D7A8",
      grass: "#8DB86A",
      forest: "#4C7D4A",
      rock: "#8A857E",
      sky: "#8CCBE8",
      skyDusk: "#F28C5B",
      skyNight: "#0D1830",
      sea: "#3AA6C9",
    },
  },
  swamp: {
    id: "swamp",
    counts: { tree: 1.1, palm: 0.6, rock: 0.6, bush: 1.5 },
    ropeShare: 0.5,
    berryShare: 0.45,
    crabMult: 1.5,
    pufferMult: 1,
    fog: 30,
    nightChill: true,
    extraFishSpots: 0,
    loot: { jellyfish: 2 },
    rugged: 0.15,
    colors: {
      sand: "#CFC28E",
      grass: "#6E9C55",
      forest: "#365F3C",
      rock: "#7C7B6E",
      sky: "#A9C2B5",
      skyDusk: "#D9905F",
      skyNight: "#0E1A24",
      sea: "#4E9A8E",
    },
  },
  volcanic: {
    id: "volcanic",
    counts: { tree: 0.6, palm: 0.8, rock: 1.6, bush: 0.8 },
    ropeShare: 0.5,
    berryShare: 0.35,
    crabMult: 1,
    pufferMult: 2,
    fog: 0,
    nightChill: false,
    extraFishSpots: 0,
    loot: {},
    rugged: 0.6,
    colors: {
      sand: "#BFA98A",
      grass: "#7FA35A",
      forest: "#3F6B3C",
      rock: "#4E4547",
      sky: "#FF8A6B",
      skyDusk: "#E0452E",
      skyNight: "#2A0B10",
      sea: "#3C8FB0",
    },
  },
};

/* ================================================================ colors */

/** Player colors by seat (P1..P6). */
export const PLAYER_COLORS: ReadonlyArray<string> = ["#FF5A5F", "#3FA7F5", "#5CC25B", "#FFC93C", "#A86CF0", "#FF8A3D"];

export function playerColor(seat: number): string {
  return PLAYER_COLORS[((seat % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length]!;
}

/** §16 palette. `hud` is game.json's accent. */
export const PALETTE = {
  sand: "#F4E4B0",
  grass: "#7CCB6B",
  forest: "#3E8E52",
  sea: "#3FB7D9",
  seaNight: "#102A4A",
  sunset: "#FF9A5A",
  fire: "#FFB347",
  crab: "#FF4D3A",
  hud: "#FFD166",
  ink: "#2D2A32",
  cream: "#FFF4DC",
} as const;

/* ================================================================ emotes & markers */

export const EMOTE_IDS: ReadonlyArray<EmoteId> = ["clap", "panic", "dance", "tired", "shush", "selfie"];
export const EMOTES: Readonly<Record<EmoteId, { icon: string; durationSec: number }>> = {
  clap: { icon: "👏", durationSec: 1.6 },
  panic: { icon: "😱", durationSec: 1.8 },
  dance: { icon: "💃", durationSec: 2.4 },
  tired: { icon: "😮‍💨", durationSec: 1.8 },
  shush: { icon: "🤫", durationSec: 1.4 },
  selfie: { icon: "🤳", durationSec: 2 },
};
export const MARKER_KINDS: ReadonlyArray<MarkerKind> = ["here", "help", "need", "danger"];
