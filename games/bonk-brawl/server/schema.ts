// Colyseus schema v3 state for Bonk Brawl. FROZEN CONTRACT (see docs/ARCHITECTURE.md).
//
// Mirrors shared/types.ts *View interfaces field-for-field (checked at compile time at the bottom).
// Decorators are only allowed in server/. Schema classes have a 64-field limit each.
// Numeric types: positions/velocities float32, tick timers uint8/uint16, seq/tick uint32.

import { ArraySchema, MapSchema, Schema, type } from "@colyseus/schema";
import { BALL_RADIUS, DEFAULT_CHARACTER, DEFAULT_MAP, DEFAULT_ROUNDS, MAX_HEARTS } from "../shared/constants.js";
import type {
  BallKind,
  BallState,
  BallView,
  BonkStateView,
  CharacterId,
  HeldPowerUp,
  MapChoice,
  MapId,
  Phase,
  PlayerSimFields,
  PlayerView,
  PowerUpPhase,
  PowerUpType,
  PowerUpView,
  SettingsView,
  StatsView,
} from "../shared/types.js";

export class StatsState extends Schema implements StatsView {
  @type("uint16") throws = 0;
  @type("uint16") hits = 0;
  @type("uint16") catches = 0;
  @type("uint16") ringOuts = 0;
  @type("uint16") kos = 0;
  @type("uint16") roundWins = 0;
}

export class SettingsState extends Schema implements SettingsView {
  @type("string") map: MapChoice = DEFAULT_MAP;
  @type("uint8") rounds = DEFAULT_ROUNDS;
  @type("boolean") powerUps = true;
}

export class PlayerState extends Schema implements PlayerView {
  // ------------------------------------------------------------- identity / lobby
  @type("string") id = "";
  @type("string") nickname = "";
  @type("string") character: CharacterId = DEFAULT_CHARACTER;
  @type("uint8") slot = 0;
  @type("boolean") ready = false;
  @type("boolean") connected = true;
  @type("boolean") spectator = false;
  @type("uint16") ping = 0;

  // -------------------------------------------------------------------- scoring
  @type("uint8") hearts = MAX_HEARTS;
  @type("uint16") points = 0;
  @type("uint8") roundPoints = 0;
  @type("uint8") place = 0;
  @type("uint32") lastSeq = 0;
  @type(StatsState) stats = new StatsState();

  // ------------------------------------------------- sim fields (PlayerSimFields)
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") z = 0;
  @type("float32") vx = 0;
  @type("float32") vy = 0;
  @type("float32") vz = 0;
  @type("float32") yaw = 0;
  @type("float32") pitch = 0;
  @type("boolean") grounded = true;
  @type("uint8") airTicks = 0;
  @type("uint8") rollTicks = 0;
  @type("uint8") rollCooldown = 0;
  @type("uint8") stunTicks = 0;
  @type("uint8") hurtTicks = 0;
  @type("uint8") catchTicks = 0;
  @type("uint8") catchCooldown = 0;
  @type("uint8") whiffTicks = 0;
  @type("uint8") chargeTicks = 0;
  @type("uint8") throwTicks = 0;
  @type("uint8") abilityTicks = 0;
  @type("uint8") abilityPhase = 0;
  @type("uint16") abilityCooldown = 0;
  @type("uint16") zoomiesTicks = 0;
  @type("boolean") curveArmed = false;
  @type("string") powerUp: HeldPowerUp = "";
  @type("uint8") heldCount = 0;
  @type("float32") dirX = 0;
  @type("float32") dirZ = -1;
  @type("boolean") alive = false;
  @type("boolean") jumping = false;
  @type("boolean") skid = false;
  @type("uint8") knockBounces = 0;
}

export class BallEntity extends Schema implements BallView {
  @type("string") id = "";
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") z = 0;
  @type("float32") vx = 0;
  @type("float32") vy = 0;
  @type("float32") vz = 0;
  @type("string") state: BallState = "neutral";
  @type("string") kind: BallKind = "normal";
  @type("float32") radius = BALL_RADIUS;
  @type("string") ownerId = "";
  @type("string") holderId = "";
  @type("uint32") throwSeq = 0;
  @type("uint8") throwIndex = 0;
  @type("float32") charge = 0;
  @type("uint16") ageTicks = 0;
  @type("uint8") restTicks = 0;
  @type("uint8") bounces = 0;
  @type("boolean") curve = false;
  @type("boolean") returning = false;
}

export class PowerUpEntity extends Schema implements PowerUpView {
  @type("string") id = "";
  @type("string") type: PowerUpType = "mega";
  @type("uint8") pedestal = 0;
  @type("string") phase: PowerUpPhase = "warning";
  @type("float32") x = 0;
  @type("float32") z = 0;
}

export class BonkState extends Schema implements BonkStateView {
  @type("string") phase: Phase = "lobby";
  @type("uint8") round = 0;
  @type("uint8") totalRounds = DEFAULT_ROUNDS;
  @type("uint16") phaseTicksLeft = 0;
  @type("uint32") tick = 0;
  @type("string") mapId: MapId = DEFAULT_MAP;
  @type("string") hostId = "";
  @type("string") crownId = "";
  @type("string") roundWinnerId = "";
  @type("string") matchWinnerId = "";
  @type(SettingsState) settings = new SettingsState();
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: BallEntity }) balls = new MapSchema<BallEntity>();
  @type({ map: PowerUpEntity }) powerUps = new MapSchema<PowerUpEntity>();
  @type(["uint8"]) rings = new ArraySchema<number>();
}

/* ------------------------------------------------- compile-time contract checks */

type DataKeys<T> = Extract<{ [K in keyof T]: T[K] extends (...args: never[]) => unknown ? never : K }[keyof T], string>;
type Exact<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : { extra: Exclude<A, B>; missing: Exclude<B, A> };

// Schema classes must not declare fields that the shared views lack (and vice versa).
const _statsExact: Exact<DataKeys<StatsState>, keyof StatsView> = true;
const _settingsExact: Exact<DataKeys<SettingsState>, keyof SettingsView> = true;
const _playerExact: Exact<DataKeys<PlayerState>, keyof PlayerView> = true;
const _ballExact: Exact<DataKeys<BallEntity>, keyof BallView> = true;
const _powerUpExact: Exact<DataKeys<PowerUpEntity>, keyof PowerUpView> = true;
const _stateExact: Exact<DataKeys<BonkState>, keyof BonkStateView> = true;
// Schema must be assignable to the plain views and to the sim shape (copyPlayerSim both ways).
const _stateView: BonkStateView = null as unknown as BonkState;
const _playerSim: PlayerSimFields = null as unknown as PlayerState;
void [_statsExact, _settingsExact, _playerExact, _ballExact, _powerUpExact, _stateExact, _stateView, _playerSim];
