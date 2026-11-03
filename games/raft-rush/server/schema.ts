// Colyseus schema v3 state for Raft Rush. FROZEN CONTRACT (see docs/ARCHITECTURE.md).
//
// Mirrors shared/types.ts *View interfaces field-for-field (checked at compile time at the bottom).
// Decorators are only allowed in server/. Schema classes have a 64-field limit each (PlayerState: 61).
// Numeric types: positions/velocities float32, bars/small counters uint8, tick timers uint16, seq/tick uint32.
// Collections are mutated in place (clear()/push/set), never reassigned, so decoded client references stay valid.

import { ArraySchema, MapSchema, Schema, type } from "@colyseus/schema";
import { DEFAULT_CHARACTER, DEFAULT_DIFFICULTY, MAX_HP } from "../shared/constants.js";
import type {
  Biome,
  BotRole,
  CharacterId,
  DayPhase,
  Difficulty,
  GameMode,
  InvKind,
  ItemKind,
  Layout,
  MonsterKind,
  MonsterMode,
  MonsterView,
  Phase,
  PlayerSimFields,
  PlayerView,
  ProjectileSimFields,
  ProjectileState,
  ProjectileView,
  RaftStage,
  RaftStateView,
  SettingsView,
  StatsView,
  StructureKind,
  StructureView,
  TeamView,
  Weather,
  WinReason,
} from "../shared/types.js";

export class StatsState extends Schema implements StatsView {
  @type("uint16") gathered = 0;
  @type("uint16") delivered = 0;
  @type("uint16") hits = 0;
  @type("uint16") kills = 0;
  @type("uint16") revives = 0;
  @type("uint16") fish = 0;
  @type("uint16") eaten = 0;
  @type("uint16") coconuts = 0;
  @type("uint16") downs = 0;
  @type("uint16") crafted = 0;
  @type("uint16") raids = 0;
}

export class SettingsState extends Schema implements SettingsView {
  @type("string") mode: GameMode = "coop";
  @type("string") difficulty: Difficulty = DEFAULT_DIFFICULTY;
  @type("uint32") seed = 0;
}

export class PlayerState extends Schema implements PlayerView {
  // ------------------------------------------------------------- identity / lobby (12)
  @type("string") id = "";
  @type("string") nickname = "";
  @type("string") character: CharacterId = DEFAULT_CHARACTER;
  @type("uint8") seat = 0;
  @type("uint8") team = 0;
  @type("boolean") bot = false;
  @type("string") botRole: BotRole | "" = "";
  @type("boolean") ready = false;
  @type("boolean") connected = true;
  @type("boolean") spectator = false;
  @type("uint16") ping = 0;
  @type("uint32") lastSeq = 0;

  // ------------------------------------------------- sim fields (PlayerSimFields, 33)
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
  @type("uint8") stunTicks = 0;
  @type("uint8") chargeTicks = 0;
  @type("uint8") throwTicks = 0;
  @type("uint8") catchTicks = 0;
  @type("uint8") catchCooldown = 0;
  @type("uint8") channel = 0;
  @type("uint16") channelTicks = 0;
  @type("int16") channelTarget = -1;
  @type("boolean") swimming = false;
  @type("uint16") swimTicks = 0;
  @type("boolean") sprinting = false;
  @type("uint8") activeSlot = 0;
  @type("string") inv0: InvKind = "";
  @type("string") inv1: InvKind = "";
  @type("string") inv2: InvKind = "";
  @type("string") inv3: InvKind = "";
  @type("uint8") hp = MAX_HP;
  @type("uint8") hunger = 100;
  @type("uint8") thirst = 100;
  @type("uint8") warmth = 100;
  @type("boolean") alive = false;
  @type("boolean") downed = false;
  @type("boolean") boarded = false;

  // ------------------------------------------------------------ inventory counts (4)
  @type("uint8") cnt0 = 0;
  @type("uint8") cnt1 = 0;
  @type("uint8") cnt2 = 0;
  @type("uint8") cnt3 = 0;

  // ------------------------------------------------------------------ status (11)
  @type("uint16") downedTicks = 0;
  /** The match's one free second wind is still available (first down gets up alone). */
  @type("boolean") secondWind = true;
  /** Why hp last hit 0 ("" until the first down): the one-line reason on the death screen. */
  @type("string") downCause = "";
  @type("boolean") washed = false;
  @type("uint8") fishState = 0;
  @type("int8") fishSpot = -1;
  @type("uint16") fuseTicks = 0;
  @type("uint16") torchTicks = 0;
  @type("string") cosmetic = "";
  @type("boolean") golden = false;
  @type("uint16") score = 0;
  @type(StatsState) stats = new StatsState();
}

export class ProjectileEntity extends Schema implements ProjectileView {
  @type("string") id = "";
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") z = 0;
  @type("float32") vx = 0;
  @type("float32") vy = 0;
  @type("float32") vz = 0;
  @type("string") state: ProjectileState = "rest";
  @type("string") kind: ItemKind = "coconut";
  @type("float32") radius = 0.2;
  @type("uint16") ageTicks = 0;
  @type("uint8") restTicks = 0;
  @type("uint8") bounces = 0;
  @type("string") ownerId = "";
  @type("uint32") throwSeq = 0;
  @type("int8") team = -1;
  @type("float32") charge = 0;
  @type("uint16") baitTicks = 0;
}

export class MonsterState extends Schema implements MonsterView {
  @type("string") id = "";
  @type("string") kind: MonsterKind = "crab";
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") z = 0;
  @type("float32") yaw = 0;
  @type("uint8") hp = 1;
  @type("string") mode: MonsterMode = "emerge";
  @type("uint16") modeTicks = 0;
  @type("string") targetId = "";
  @type("int8") team = -1;
  @type("string") carry: InvKind = "";
}

export class StructureState extends Schema implements StructureView {
  @type("string") id = "";
  @type("string") kind: StructureKind = "fence";
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") z = 0;
  @type("float32") yaw = 0;
  @type("int8") team = 0;
  @type("string") ownerId = "";
  @type("uint8") hp = 1;
  @type("uint16") life = 0;
  @type("uint8") uses = 0;
}

export class TeamState extends Schema implements TeamView {
  @type("uint8") index = 0;
  @type("uint8") seats = 2;
  @type("uint8") stage: RaftStage = 0;
  @type("uint8") hullWood = 0;
  @type("uint8") mastWood = 0;
  @type("uint8") mastRope = 0;
  @type("uint8") food = 0;
  @type("uint8") water = 0;
  @type("uint16") fireFuel = 0;
  @type({ map: "uint16" }) chest = new MapSchema<number>();
  @type("boolean") flare = false;
  @type("boolean") sail = false;
  @type("boolean") secretRevealed = false;
  @type("boolean") secretOpened = false;
  @type("boolean") springRevealed = false;
  @type("boolean") ballRecipe = false;
  @type("uint16") spyglassTicks = 0;
  @type("uint8") hutHp = 0;
  @type("uint16") score = 0;
}

export class RaftState extends Schema implements RaftStateView {
  @type("string") phase: Phase = "lobby";
  @type("uint32") tick = 0;
  @type("uint16") phaseTicksLeft = 0;
  @type("uint32") clockTicks = 0;
  @type("uint8") day = 0;
  @type("string") dayPhase: DayPhase = "day";
  @type("string") weather: Weather = "clear";
  @type("uint32") seed = 0;
  @type("string") layout: Layout = "solo";
  @type("string") biome: Biome = "tropic";
  @type("boolean") fast = false;
  @type("string") difficulty: Difficulty = DEFAULT_DIFFICULTY;
  @type("string") hostId = "";
  @type(SettingsState) settings = new SettingsState();
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: ProjectileEntity }) projectiles = new MapSchema<ProjectileEntity>();
  @type({ map: MonsterState }) monsters = new MapSchema<MonsterState>();
  @type({ map: StructureState }) structures = new MapSchema<StructureState>();
  @type(["uint8"]) nodes = new ArraySchema<number>();
  @type([TeamState]) teams = new ArraySchema<TeamState>();
  @type("uint16") launchTicksLeft = 0;
  @type("int8") winnerTeam = -1;
  @type("string") winReason: WinReason = "";
}

/* ------------------------------------------------- compile-time contract checks */

type DataKeys<T> = Extract<{ [K in keyof T]: T[K] extends (...args: never[]) => unknown ? never : K }[keyof T], string>;
type Exact<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : { extra: Exclude<A, B>; missing: Exclude<B, A> };

// Schema classes must not declare fields that the shared views lack (and vice versa).
const _statsExact: Exact<DataKeys<StatsState>, keyof StatsView> = true;
const _settingsExact: Exact<DataKeys<SettingsState>, keyof SettingsView> = true;
const _playerExact: Exact<DataKeys<PlayerState>, keyof PlayerView> = true;
const _projectileExact: Exact<DataKeys<ProjectileEntity>, keyof ProjectileView> = true;
const _monsterExact: Exact<DataKeys<MonsterState>, keyof MonsterView> = true;
const _structureExact: Exact<DataKeys<StructureState>, keyof StructureView> = true;
const _teamExact: Exact<DataKeys<TeamState>, keyof TeamView> = true;
const _stateExact: Exact<DataKeys<RaftState>, keyof RaftStateView> = true;
// Schema must be assignable to the plain views and to the sim shapes (copy*Sim both ways).
const _stateView: RaftStateView = null as unknown as RaftState;
const _playerSim: PlayerSimFields = null as unknown as PlayerState;
const _projectileSim: ProjectileSimFields = null as unknown as ProjectileEntity;
void [
  _statsExact,
  _settingsExact,
  _playerExact,
  _projectileExact,
  _monsterExact,
  _structureExact,
  _teamExact,
  _stateExact,
  _stateView,
  _playerSim,
  _projectileSim,
];
