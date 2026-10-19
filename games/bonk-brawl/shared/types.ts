// Shared plain types for Bonk Brawl. FROZEN CONTRACT (see docs/ARCHITECTURE.md).
//
// The *View interfaces mirror server/schema.ts field-for-field so the client can type
// `room.state` without importing decorator classes. server/schema.ts contains compile-time
// checks that the schema classes stay assignable to these views.
//
// Types only, no runtime code (runtime constants live in constants.ts).

/* ------------------------------------------------------------------ unions */

/** Room phase. Flow: lobby → countdown → playing → suddenDeath → roundEnd → (countdown | matchEnd) → lobby. */
export type Phase = "lobby" | "countdown" | "playing" | "suddenDeath" | "roundEnd" | "matchEnd";

export type MapId = "picnic" | "bath" | "cake";
/** Host setting: a fixed map or a random one (re-rolled every round, never the same map twice in a row). */
export type MapChoice = MapId | "random";

export type CharacterId = "quacky" | "hopsworth" | "mochi" | "whiskers" | "pip" | "gruff";
export type AbilityId = "flapDash" | "groundPound" | "bellyBounce" | "curveball" | "bellySlide" | "headbutt";
export type AnimalKind = "duck" | "frog" | "bear" | "cat" | "penguin" | "goat";

export type PowerUpType = "mega" | "triple" | "boomerang" | "zoomies";
/**
 * Power-up stored on a player and applied to their NEXT throw. "" = none.
 * Zoomies is never stored here: it applies instantly as `zoomiesTicks`.
 */
export type HeldPowerUp = "" | "mega" | "triple" | "boomerang";
/** A pedestal power-up first shimmers ("warning", 2 s, not pickable) then is "ready". */
export type PowerUpPhase = "warning" | "ready";

/**
 * Ball lifecycle. game1.md's three states plus "held" (in someone's hand).
 * neutral → (auto pickup) held → (throw) live → (first bounce on floor/cover, or a hit) dead → (at rest) neutral.
 */
export type BallState = "neutral" | "held" | "live" | "dead";
/** normal; mega (Mega Ball power-up, radius 0.5, 2× knockback); boomerang; bonus (the 2 extra Triple Shot balls, removed when they come to rest). */
export type BallKind = "normal" | "mega" | "boomerang" | "bonus";

/** Ring floor state, stored as uint8 in `state.rings`. 0 solid, 1 shaking (still solid), 2 fallen. */
export type RingState = 0 | 1 | 2;

export type EmoteId = "honk" | "wave" | "dance";

/** Why a player was knocked out by hearts/other (ring-outs use the separate ringOut event). */
export type KoCause = "hits" | "caught" | "disconnect";

/**
 * Continuous animation state derived from sim fields (see shared/sim/actions.ts derivePlayerAction).
 * One-shot animations (throw, hit-react, catch success, emote, victory, land) are event-triggered instead.
 */
export type PlayerAction =
  | "idle"
  | "run"
  | "jump"
  | "fall"
  | "charge"
  | "catch"
  | "whiff"
  | "roll"
  | "stunned"
  | "ability"
  | "ghost";

/** Player slot 0..3 = P1..P4 (color index into PLAYER_COLORS). */
export type SlotIndex = 0 | 1 | 2 | 3;

/** Plain vector used in messages and the shared sim (never a THREE.Vector3). */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/* ------------------------------------------------------- sim field shapes */

/**
 * Every player field the deterministic shared sim (`stepPlayer`) reads or writes.
 * Lives in the schema (PlayerState) so clients can reconcile prediction from it.
 * All `*Ticks` / `*Cooldown` are integer tick counts at 30 Hz that count DOWN to 0
 * (except `airTicks` and `chargeTicks`, which count UP).
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
  /** Standing on floor or cover this tick. */
  grounded: boolean;
  /** Ticks since last grounded (saturates at 255). Used for coyote-time jumps. */
  airTicks: number;
  /** Remaining dodge-roll ticks (>0 = rolling). I-frames: see hasRollIFrames() in shared/sim/player.ts. */
  rollTicks: number;
  rollCooldown: number;
  /** Knockback stun: no control while > 0. */
  stunTicks: number;
  /** Post-hit mercy invulnerability (and damage flash) while > 0. */
  hurtTicks: number;
  /** Remaining catch-window ticks (>0 = catch pose active). Expiring to 0 without a catch starts a whiff. */
  catchTicks: number;
  catchCooldown: number;
  /** Whiff recovery: no throw/catch/roll/ability and slowed movement while > 0. */
  whiffTicks: number;
  /** Ticks the throw button has been held while holding a ball (0 = not charging). Caps at CHARGE_FULL_TICKS. */
  chargeTicks: number;
  /** Short throw-recovery after a release; can't start a new charge while > 0. */
  throwTicks: number;
  /** Remaining ticks of the active ability (>0 = ability running). Meaning depends on character. */
  abilityTicks: number;
  /** Sub-phase of multi-phase abilities. Ground Pound: 1 rising, 2 slamming. 0 otherwise. */
  abilityPhase: number;
  abilityCooldown: number;
  /** Zoomies power-up remaining ticks (+40% move speed). */
  zoomiesTicks: number;
  /** Whiskers' Curveball armed: the next throw is a curveball. */
  curveArmed: boolean;
  /** Power-up applied to the next throw. */
  powerUp: HeldPowerUp;
  /** Balls in hand (0..MAX_HELD_BALLS, or MAX_HELD_BALLS_TRIPLE with Triple Shot held). */
  heldCount: number;
  /** Unit horizontal direction locked at the start of a roll / flap dash / headbutt / belly slide. */
  dirX: number;
  dirZ: number;
  /** In the current round and not knocked out. Dead players are not stepped. */
  alive: boolean;
}

/** Every ball field the deterministic shared sim (`stepBall`) reads or writes. */
export interface BallSimFields {
  /** Center position, meters. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  state: BallState;
  kind: BallKind;
  /** BALL_RADIUS or MEGA_BALL_RADIUS. */
  radius: number;
  /** Ticks since the ball was thrown (live/dead); 0 while neutral/held. Saturates at 65535. */
  ageTicks: number;
  /** Consecutive ticks resting on a surface below BALL_REST_SPEED (dead → neutral at BALL_REST_TICKS). */
  restTicks: number;
  /** Bounces since thrown. */
  bounces: number;
  /** Curveball: steered toward the thrower's aim while live. */
  curve: boolean;
  /** Boomerang return phase: flies straight back to the owner without gravity. */
  returning: boolean;
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

export interface StatsView {
  /** Balls thrown (a Triple Shot counts 3), so accuracy = hits / throws stays ≤ 100%. */
  throws: number;
  /** Live-ball hits dealt. */
  hits: number;
  /** Live balls caught. */
  catches: number;
  /** Opponents rung out with credit. */
  ringOuts: number;
  /** Opponents knocked out (hearts) with credit. */
  kos: number;
  roundWins: number;
}

export interface SettingsView {
  map: MapChoice;
  /** 3, 5 or 7. */
  rounds: number;
  powerUps: boolean;
}

export interface PlayerView extends PlayerSimFields {
  /** sessionId (also the key in state.players). */
  id: string;
  nickname: string;
  character: CharacterId;
  /** 0..3, P1..P4, picks the player color. Lowest free slot on join, kept for the room lifetime. */
  slot: number;
  /** Lobby ready flag. */
  ready: boolean;
  /** False while inside the 20 s reconnect grace window. */
  connected: boolean;
  /** Joined while a match was running: watches with the ghost camera until the match ends. */
  spectator: boolean;
  /** Round-trip time in ms (EMA), shown on the scoreboard. */
  ping: number;
  /** 0..3 in a round. */
  hearts: number;
  /** Match points (reset on rematch / match start). */
  points: number;
  /** Points earned in the current round (round-end card). Reset at round start. */
  roundPoints: number;
  /** Final placement 1..4 at matchEnd, 0 otherwise. */
  place: number;
  /** Last input seq consumed by the server (prediction ack). */
  lastSeq: number;
  stats: StatsView;
}

export interface BallView extends BallSimFields {
  /** Key in state.balls, e.g. "b12". */
  id: string;
  /** Thrower sessionId for live/dead balls ("" for neutral/never thrown). */
  ownerId: string;
  /** Holder sessionId while state === "held", else "". */
  holderId: string;
  /** Input seq of the throw that released this ball (matches the client's predicted ball). 0 if never thrown. */
  throwSeq: number;
  /** 0 = center ball; 1/2 = Triple Shot side balls (left/right). */
  throwIndex: number;
  /** Charge 0..1 of the throw (glow intensity, knockback scaling). */
  charge: number;
}

export interface PowerUpView {
  id: string;
  type: PowerUpType;
  /** Index into arena.pedestals. */
  pedestal: number;
  phase: PowerUpPhase;
  /** Pedestal position (copied for convenience). */
  x: number;
  z: number;
}

export interface BonkStateView {
  phase: Phase;
  /** Current round, 1-based (0 in lobby). */
  round: number;
  /** Rounds in this match (settings.rounds frozen at match start). */
  totalRounds: number;
  /**
   * Ticks until the current phase (or sub-step) ends:
   * countdown → until "go"; playing → until sudden death; suddenDeath → until the next ring drop
   * (0 when nothing left to drop); roundEnd → until next round / match end; matchEnd → until auto-return to lobby.
   */
  phaseTicksLeft: number;
  /** Server simulation tick counter (increments every 1/30 s for the room lifetime). */
  tick: number;
  /** Arena currently loaded (the resolved map, never "random"). */
  mapId: MapId;
  hostId: string;
  /** Current point leader wearing the gold crown ("" when no unique leader with > 0 points). */
  crownId: string;
  /** Winner of the last finished round ("" for a draw or before any round ends). */
  roundWinnerId: string;
  /** Set at matchEnd. */
  matchWinnerId: string;
  settings: SettingsView;
  players: MapView<PlayerView>;
  balls: MapView<BallView>;
  powerUps: MapView<PowerUpView>;
  /** One entry per arena ring (index 0 = innermost), values are RingState. */
  rings: ReadonlyArray<number>;
}
