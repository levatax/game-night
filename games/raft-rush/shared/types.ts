// Shared plain types for Raft Rush. FROZEN CONTRACT (see docs/ARCHITECTURE.md).
//
// The *View interfaces mirror server/schema.ts field-for-field so the client can type `room.state`
// without importing decorator classes. server/schema.ts has compile-time checks that the schema
// classes stay assignable to these views.
//
// Types only, no runtime code (runtime constants live in constants.ts and items.ts).

/* ------------------------------------------------------------------ unions */

/**
 * Room phase. Flow: lobby → landing → playing → (launch | storm) → matchEnd → lobby.
 * - landing: everyone wakes up on the beach next to the wreck (input locked for LANDING_LOCK_SEC,
 *   then free; bars don't drain, no monsters; the day clock starts with `playing`).
 * - playing: 3 × (day, dusk, night) driven by `clockTicks` (see shared/rules/schedule.ts).
 * - launch: the raft sails away (win), a short cinematic, then matchEnd.
 * - storm: night 3 ended without a launch (lose), a short cinematic, then matchEnd.
 */
export type Phase = "lobby" | "landing" | "playing" | "launch" | "storm" | "matchEnd";

export type DayPhase = "day" | "dusk" | "night";

/** Weather of the current day (one per day, starts at mid-day; "clear" = none). */
export type Weather = "clear" | "rain" | "fog" | "heatwave" | "fullmoon";

/** Daytime mini-event (one per day, random). */
export type DayEventKind = "gull" | "monkeys" | "waveGift";

/** Lobby mode. "duel" (Ada Savaşı) is reserved: the M1–M5 server only accepts "coop". */
export type GameMode = "coop" | "duel";
/** World layout: one island (coop) or two islands with a strait (duel). */
export type Layout = "solo" | "duel";
export type Difficulty = "vacation" | "normal" | "nightmare";
export type Biome = "tropic" | "rocky" | "swamp" | "volcanic";

/** The six "Ship Tourists" (Gemi Turistleri). ASCII ids; display names are translated on the client. */
export type CharacterId = "kaptan" | "fenomen" | "amca" | "gelin" | "sef" | "cocuk";
/** Helper-bot personality (§12): porter, fisher, guard, cook. */
export type BotRole = "hamal" | "balikci" | "bekci" | "asci";

/** Every inventory / projectile item. See shared/items.ts ITEMS. */
export type ItemKind =
  | "wood"
  | "rope"
  | "stone"
  | "coconut"
  | "fish_raw"
  | "fish_cooked"
  | "crab_raw"
  | "crab_cooked"
  | "fish_golden"
  | "water"
  | "spear"
  | "rod"
  | "torch"
  | "axe"
  | "raft_part"
  | "fence"
  | "collector"
  | "coconut_ball"
  | "boot"
  | "jellyfish"
  | "puffer"
  | "kraken";
/** An inventory slot's kind; "" = empty slot. */
export type InvKind = ItemKind | "";

/** Outcome of a successful fishing catch (§8). Mapped to items/effects by the server. */
export type FishLoot = "fish" | "crab" | "boot" | "jellyfish" | "puffer" | "bottle" | "treasure" | "golden" | "kraken";
/** Treasure-chest reel outcome (§8). All apply instantly to the finder's team. */
export type TreasureId = "flare" | "old_sail" | "pirate_hat" | "spyglass" | "fuel_can";
/** What a message in a bottle did. */
export type BottleEffect = "secretChest" | "spring" | "recipe";

export type NodeKind = "tree" | "palm" | "rock" | "bush";
/** Bushes yield rope (vines), berries (eaten instantly) or nothing (decor). */
export type BushYield = "rope" | "berry" | "none";

/**
 * Projectile lifecycle (shared/sim/projectile.ts):
 * live (thrown, harmful until its first bounce or hit) → loose (bouncing/rolling, harmless) →
 * rest (on the ground: a pickup) ; spears that hit terrain or a trunk become `stuck` (a pickup).
 * A projectile that sinks below the water surface is removed (splash event).
 */
export type ProjectileState = "live" | "loose" | "rest" | "stuck";

/** crab / puffer (rolling spiky ball) / boss (Kaptan Yengeç) at night; monkey (steals from the chest) and gull (Şükrü, steals a fish) by day. */
export type MonsterKind = "crab" | "puffer" | "boss" | "monkey" | "gull";
/**
 * emerge: climbing out of the surf (harmless, 1.5 s) · hunt: walking to its target · bite: attack
 * wind-up / cooldown at a target · flipped: crab on its back (8 s helpless; E collects it) ·
 * flee: dawn, back to the sea · stunned: hit by a torch swing / knockback · lured: running to bait ·
 * steal: monkey/gull grabbing an item · carry: monkey/gull escaping with `carry`.
 */
export type MonsterMode = "emerge" | "hunt" | "bite" | "flipped" | "flee" | "stunned" | "lured" | "steal" | "carry";

/** Player-placed structures. Campfire, chest and raft are per-team fixed sites (TeamView), not structures. */
export type StructureKind = "fence" | "torch" | "collector" | "kraken" | "hut" | "canoe";

export type RecipeId =
  | "spear"
  | "rod"
  | "torch"
  | "axe"
  | "collector"
  | "fence"
  | "raft_part"
  | "cook_fish"
  | "cook_crab"
  | "cook_kraken"
  | "fuel"
  | "coconut_ball"
  | "hut"
  | "canoe";

/** 0 hull, 1 mast + sail, 2 provisions, 3 ready to board. */
export type RaftStage = 0 | 1 | 2 | 3;

export type EmoteId = "clap" | "panic" | "dance" | "tired" | "shush" | "selfie";
/** Ping wheel (V / middle click): "Over here!", "Help!", "Need this", "Danger!". */
export type MarkerKind = "here" | "help" | "need" | "danger";

/** Why a player lost hp (feed lines, death screen). */
export type HurtCause =
  | "crab"
  | "puffer"
  | "boss"
  | "hunger"
  | "thirst"
  | "cold"
  | "drown"
  | "jellyfish"
  | "blast"
  | "friendly";

export type WinReason = "" | "launched" | "storm" | "abandoned";

/** End-of-match honor / shame titles (§21). */
export type TitleId =
  | "mvp"
  | "crabSlayer"
  | "fishLord"
  | "porter"
  | "hero"
  | "tourist"
  | "victim"
  | "coconutAddict";

/**
 * What E would do right now (shared/rules/interact.ts resolveInteraction). The client shows the prompt
 * and opens panels for `craft` / `chest`; the server executes the rest on INTERACT_PRESS (tap) or
 * via a channel while INTERACT is held (`hold: true`).
 */
export type InteractKind =
  | "revive"
  | "collectCrab"
  | "pickup"
  | "board"
  | "deliver"
  | "craft"
  | "chest"
  | "spring"
  | "collector"
  | "secretChest"
  | "gather";

/** Plain vector used in messages and the shared sim (never a THREE.Vector3). */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/* ------------------------------------------------------- sim field shapes */

/**
 * Every player field the deterministic shared sim (`stepPlayer`) reads or writes. They live in the
 * schema (PlayerState) so clients can reconcile prediction from them.
 *
 * Integer tick timers run at 30 Hz. `*Ticks` count DOWN to 0, except `airTicks`, `chargeTicks`,
 * `channelTicks` and `swimTicks`, which count UP (saturating).
 *
 * READ-ONLY for the sim (written only by the server world, copied into the client's prediction on every
 * patch): inv0..inv3, hp, hunger, thirst, warmth, alive, downed, boarded, channel (set), channelTarget (set).
 */
export interface PlayerSimFields {
  /** Feet position (bottom of capsule), meters. */
  x: number;
  y: number;
  z: number;
  /** Velocity, m/s. */
  vx: number;
  vy: number;
  vz: number;
  /** Radians. Yaw 0 faces -Z; wrapped to (-PI, PI]. Pitch clamped to ±PITCH_LIMIT, positive looks up. */
  yaw: number;
  pitch: number;
  /** Standing on terrain / a cover top / the seabed this tick. */
  grounded: boolean;
  /** Ticks since last grounded (saturates at 255). Coyote-time jumps. */
  airTicks: number;
  /** Hit stun: no move control (look still works) while > 0. */
  stunTicks: number;
  /** Ticks LMB has been held with a throwable in the active slot (0 = not charging). Caps at CHARGE_FULL_TICKS. */
  chargeTicks: number;
  /** Recovery after a throw, toss or use swing; no new charge / use / toss while > 0. */
  throwTicks: number;
  /** Remaining catch-window ticks (> 0 = catch pose). */
  catchTicks: number;
  catchCooldown: number;
  /**
   * Channel (hold-E action) kind, CHANNEL.* in constants.ts. The SERVER sets it (and channelTarget) when an
   * INTERACT_PRESS resolves to a hold interaction; the sim freezes horizontal movement and counts
   * channelTicks up while it is non-zero and INTERACT is held, and clears channel/channelTicks/channelTarget
   * the first tick INTERACT is not held. The server completes the action when channelTicks reaches the
   * required ticks (channelTicksFor in shared/rules/interact.ts).
   */
  channel: number;
  channelTicks: number;
  /** Node index (gather) or the downed player's seat (revive); -1 when no channel. */
  channelTarget: number;
  /** Feet more than SWIM_DEPTH below the water surface: swimming (slow, no jump, floats). */
  swimming: boolean;
  /** Consecutive ticks swimming (saturates at 65535). Drowning starts after DROWN_TICKS. */
  swimTicks: number;
  /** SPRINT held while moving on land (and not charging/downed). Hunger drains faster. */
  sprinting: boolean;
  /** Selected inventory slot 0..3 (predicted from SLOT1–4 / SLOT_NEXT / SLOT_PREV edges). */
  activeSlot: number;
  /** Inventory slot kinds ("" = empty). Read-only for the sim; heldKind(p) = inv[activeSlot]. */
  inv0: InvKind;
  inv1: InvKind;
  inv2: InvKind;
  inv3: InvKind;
  /** Survival bars 0..100 (read-only for the sim: zero bars slow movement). */
  hp: number;
  hunger: number;
  thirst: number;
  warmth: number;
  /** In the match and not washed ashore. Players with alive=false are not stepped. */
  alive: boolean;
  /** hp reached 0: crawls slowly, can't act, waits DOWNED_TICKS for a revive. */
  downed: boolean;
  /** On the raft (frozen in place, look only). */
  boarded: boolean;
}

/** Every projectile field the deterministic shared sim (`stepProjectile`) reads or writes. */
export interface ProjectileSimFields {
  /** Center, meters. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  state: ProjectileState;
  kind: ItemKind;
  /** Collision radius (ITEMS[kind].radius). */
  radius: number;
  /** Ticks since thrown/spawned (saturates at 65535). */
  ageTicks: number;
  /** Consecutive ticks below PROJECTILE_REST_SPEED on the ground (loose → rest at PROJECTILE_REST_TICKS). */
  restTicks: number;
  /** Ground bounces since thrown. */
  bounces: number;
}

/* --------------------------------------------- schema mirrors (state views) */

/**
 * Read-only map shape that both a server MapSchema and the client-decoded MapSchema satisfy
 * (TS's ReadonlyMap is not used because its iterator type requires Symbol.dispose).
 */
export interface MapView<V> {
  readonly size: number;
  get(key: string): V | undefined;
  has(key: string): boolean;
  forEach(callback: (value: V, key: string) => void): void;
  keys(): IterableIterator<string>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[string, V]>;
  [Symbol.iterator](): IterableIterator<[string, V]>;
}

/** Read-only array shape that both a server ArraySchema and the client-decoded ArraySchema satisfy. */
export interface ArrayView<V> {
  readonly length: number;
  readonly [index: number]: V;
  forEach(callback: (value: V, index: number) => void): void;
  [Symbol.iterator](): IterableIterator<V>;
}

export interface StatsView {
  /** Resource units gathered (wood, rope, stone, coconuts, berries). */
  gathered: number;
  /** Item units delivered to the raft (a raft part counts as its wood). */
  delivered: number;
  /** Projectile hits on monsters. */
  hits: number;
  /** Monsters killed or flipped. */
  kills: number;
  revives: number;
  /** Fishing catches (any loot). */
  fish: number;
  /** Food items eaten (coconuts included). */
  eaten: number;
  coconuts: number;
  /** Times downed. */
  downs: number;
  crafted: number;
  /** Duel only: raids on the enemy camp. */
  raids: number;
}

export interface SettingsView {
  mode: GameMode;
  difficulty: Difficulty;
  /** Island seed (uint32). 0 = a random seed is rolled at each match start. */
  seed: number;
}

export interface PlayerView extends PlayerSimFields {
  /** sessionId for humans, "bot-<n>" for bots (also the key in state.players). */
  id: string;
  nickname: string;
  character: CharacterId;
  /** 0..5, picks the player color. Lowest free seat on join, kept for the room lifetime. */
  seat: number;
  /** 0 in coop; 0 / 1 in duel. */
  team: number;
  bot: boolean;
  /** Bot personality ("" for humans; a human seat a bot drives while reconnecting keeps ""). */
  botRole: BotRole | "";
  ready: boolean;
  /** False while inside the reconnect grace window (a bot drives the seat meanwhile). */
  connected: boolean;
  /** Joined while a match was running: watches until the match ends. */
  spectator: boolean;
  /** Round-trip time in ms (EMA). 0 for bots. */
  ping: number;
  /** Last input seq consumed by the server (prediction ack). */
  lastSeq: number;
  /** Inventory counts for inv0..inv3 (0 when empty). */
  cnt0: number;
  cnt1: number;
  cnt2: number;
  cnt3: number;
  /** Ticks left before a downed player washes ashore (0 when not downed). */
  downedTicks: number;
  /** The match's one free second wind is still available (the first down gets up alone). */
  secondWind?: boolean;
  /** Why hp last hit 0 ("" until the first down): the readable line on the death screen. */
  downCause?: string;
  /** Washed ashore ("Dalgalar seni kıyıya attı"): alive=false, inventory lost, respawns at the next dawn. */
  washed: boolean;
  /** 0 none, 1 line cast (waiting), 2 bite (click now!), 3 reeling (result pending). FISH_STATE.* */
  fishState: number;
  /** Fish spot index being fished, -1 none. */
  fishSpot: number;
  /** Puffer fuse ticks left while a puffer is in the inventory (0 = no puffer). */
  fuseTicks: number;
  /** Burn left of the active torch (counts down only while a torch is the active item). */
  torchTicks: number;
  /** Worn cosmetic: "" | "pirate_hat" | "boot". */
  cosmetic: string;
  /** Caught a golden fish: sparkly nameplate. */
  golden: boolean;
  /** MVP points this match (MVP_POINTS). */
  score: number;
  stats: StatsView;
}

export interface ProjectileView extends ProjectileSimFields {
  /** Key in state.projectiles, e.g. "p12". */
  id: string;
  /** Thrower id ("" for spawned items such as fallen coconuts or wave gifts). */
  ownerId: string;
  /** Input seq of the throw that released it (matches the client's predicted projectile); 0 if not thrown. */
  throwSeq: number;
  /** Thrower's team (-1 for neutral spawns). */
  team: number;
  /** Charge 0..1 of the throw (0 for tosses and spawns). */
  charge: number;
  /** Fish bait: ticks left attracting crabs (BAIT_TICKS after it lands). */
  baitTicks: number;
}

export interface MonsterView {
  /** Key in state.monsters, e.g. "m3". */
  id: string;
  kind: MonsterKind;
  /** Feet position. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  mode: MonsterMode;
  /** Ticks left in the current mode (flipped / stunned / emerge / lured); 0 when open-ended. */
  modeTicks: number;
  /** Player id, projectile id, "raft", "chest", structure id, or "". */
  targetId: string;
  /** Team camp it was sent at (-1 = neutral). */
  team: number;
  /** Item a monkey / gull is carrying away ("" none). */
  carry: InvKind;
}

export interface StructureView {
  /** Key in state.structures, e.g. "s4". */
  id: string;
  kind: StructureKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  team: number;
  ownerId: string;
  hp: number;
  /** Ticks left for lifetimed structures (planted torch burn, kraken thrashing); 0 = permanent. */
  life: number;
  /** Collector: water uses stored (0..COLLECTOR_USES). */
  uses: number;
}

export interface TeamView {
  /** 0 or 1. */
  index: number;
  /** Seats the raft is sized for (players incl. bots at match start, clamped 2..6). */
  seats: number;
  stage: RaftStage;
  /** Delivered toward the current requirements (RAFT_COSTS[seats]). Hull gnawing lowers hullWood. */
  hullWood: number;
  mastWood: number;
  mastRope: number;
  food: number;
  water: number;
  /** Campfire fuel ticks left (0 = out: no warmth, no light, no crafting). */
  fireFuel: number;
  /** Shared camp chest: item kind → count. */
  chest: MapView<number>;
  /** A flare was found: the next night spawns no monsters. */
  flare: boolean;
  /** Old sail found before the hull was finished: the mast stage completes as soon as the hull does. */
  sail: boolean;
  /** A bottle revealed the secret chest; `secretOpened` once looted. */
  secretRevealed: boolean;
  secretOpened: boolean;
  /** A bottle marked the spring on the compass. */
  springRevealed: boolean;
  /** Coconut-ball recipe unlocked by a bottle. */
  ballRecipe: boolean;
  /** Spyglass: every resource shows on the compass while > 0. */
  spyglassTicks: number;
  /** Duel: hut hp (0 = none / destroyed). */
  hutHp: number;
  /** Team score (computed at matchEnd; MVP points summed + launch bonus). */
  score: number;
}

export interface RaftStateView {
  phase: Phase;
  /** Server simulation tick counter (increments every 1/30 s for the room lifetime). */
  tick: number;
  /** Ticks until the current phase (landing / launch / storm / matchEnd auto-lobby) ends; in playing: until the current day phase ends. */
  phaseTicksLeft: number;
  /** Ticks since `playing` began (frozen outside playing). Drives the day clock (schedule.ts clockAt). */
  clockTicks: number;
  /** 1..3 in a match, 0 in the lobby. */
  day: number;
  dayPhase: DayPhase;
  weather: Weather;
  /** Seed of the island being played (or of the lobby preview). */
  seed: number;
  layout: Layout;
  biome: Biome;
  /** Server runs shortened test timers (RAFT_TEST=1 + create option fast). */
  fast: boolean;
  difficulty: Difficulty;
  hostId: string;
  settings: SettingsView;
  players: MapView<PlayerView>;
  projectiles: MapView<ProjectileView>;
  monsters: MapView<MonsterView>;
  structures: MapView<StructureView>;
  /** Remaining amount per resource node, indexed like IslandDef.nodes. */
  nodes: ArrayView<number>;
  teams: ArrayView<TeamView>;
  /** Boarding countdown ticks left once someone boarded a ready raft (0 = not counting). */
  launchTicksLeft: number;
  /** Set at matchEnd: winning team (-1 = nobody, the storm won). */
  winnerTeam: number;
  winReason: WinReason;
}
