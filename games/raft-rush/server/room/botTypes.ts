// Plain data the helper-bot brain reasons about (§12, §19 "Botlar"). Owner: server-bots.
//
// botSense.ts builds a BotView from the room state once per think; botBrain.ts chooseGoal(view) turns it into
// a Goal; botMotor.ts executes the Goal one InputCmd at a time. Keeping the view a plain snapshot (no schema
// classes) lets the decision functions be pure and lets tests hand-write synthetic views.

import type { XZ } from "../../shared/island/types.js";
import type {
  BotRole,
  BushYield,
  CharacterId,
  DayPhase,
  InvKind,
  ItemKind,
  MonsterKind,
  MonsterMode,
  NodeKind,
  Phase,
  ProjectileState,
  RaftStage,
  RecipeId,
  Weather,
} from "../../shared/types.js";

/* ================================================================ goals */

/**
 * One decision of a bot. The motor (botMotor.ts) turns it into inputs until it is done, fails, or the next
 * think replaces it. Goals carry ids / indices, never positions that go stale (the motor re-reads the state).
 */
export type Goal =
  /** Nothing to do (input locked, aboard, cinematics): stand still and look around. */
  | { kind: "idle" }
  /** Downed: crawl toward the nearest teammate who can revive us. */
  | { kind: "crawl"; to: XZ }
  /** Low hp with a monster close: run to `to` (a light ring or away from the threat). */
  | { kind: "flee"; to: XZ; from: string }
  /** A puffer is fusing in the inventory: throw it at `monsterId` (or far from everyone when ""). */
  | { kind: "throwAway"; slot: number; monsterId: string }
  /** Hold E on a downed teammate. */
  | { kind: "revive"; playerId: string }
  /** Raft ready: walk to it and press E. */
  | { kind: "board" }
  /** Eat / drink the item in `slot` (F). */
  | { kind: "eat"; slot: number }
  /** Charge and throw the item in `slot` at a monster (`push`: may leave the light to get in range). */
  | { kind: "attack"; monsterId: string; slot: number; push?: boolean }
  /** Stand at the campfire (warmth, hp regen). */
  | { kind: "warm" }
  /** E at the spring `uses` times (fills gourds; drinks when the inventory is full). */
  | { kind: "spring"; uses: number }
  /** Craft `recipe` `count` times at the campfire (relights it first when it is out). */
  | { kind: "craft"; recipe: RecipeId; count: number }
  /** Take items from the camp chest. */
  | { kind: "chestTake"; items: { kind: ItemKind; count: number }[] }
  /** Put these units into the camp chest. */
  | { kind: "chestPut"; items: { kind: ItemKind; count: number }[] }
  /** E at the raft: deliver what the current stage needs. */
  | { kind: "deliver" }
  /** Hold E at the raft (CHANNEL.BUILD) while the current stage's materials are in and it isn't assembled yet. */
  | { kind: "assemble" }
  /** E at the raft with a hammer: spend a plank (or 2 wood) on raft hp, again while it is low. */
  | { kind: "repair" }
  /** Hold E at the wreck with a hammer (CHANNEL.SALVAGE) for scrap. */
  | { kind: "salvage" }
  /** Chop a tree to the last unit with an axe (it falls and drops a log), then pick the log up. */
  | { kind: "fell"; node: number }
  /** Walk beside teammate `playerId` while they carry heavy cargo (within ESCORT_RADIUS: they walk faster). */
  | { kind: "escort"; playerId: string }
  /** Plant the torch in `slot` at the raft (Q). */
  | { kind: "plantTorch"; slot: number }
  /** Hold E on a tree / rock / bush until it is empty or the inventory is full. */
  | { kind: "gather"; node: number }
  /** LMB a palm so its coconuts fall. */
  | { kind: "shake"; node: number }
  /** E on a ground item. */
  | { kind: "pickup"; projectileId: string }
  /** E on a flipped crab. */
  | { kind: "collectCrab"; monsterId: string }
  /** Cast and reel at a fish spot. */
  | { kind: "fish"; spot: number }
  /** Q-toss the item in `slot` to a teammate. */
  | { kind: "pass"; playerId: string; slot: number }
  /** Throw the item in `slot` (jellyfish) into the campfire for fuel. */
  | { kind: "burn"; slot: number }
  /** Night watch at the raft (inside its torch ring). */
  | { kind: "guard"; at: XZ }
  /** Hang around the camp. */
  | { kind: "camp"; at: XZ }
  /** Stay close to teammate `playerId` (a reconnect stand-in in the dark with the fire out). */
  | { kind: "follow"; playerId: string }
  /** Raft ready, waiting next to it for the humans. */
  | { kind: "wait"; at: XZ };

export type GoalKind = Goal["kind"];

/* ================================================================ view */

export interface BotSlot {
  kind: InvKind;
  count: number;
}

/** The bot itself. */
export interface BotSelf {
  id: string;
  seat: number;
  team: number;
  character: CharacterId;
  role: BotRole;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  hunger: number;
  thirst: number;
  warmth: number;
  downed: boolean;
  boarded: boolean;
  swimming: boolean;
  slots: BotSlot[];
  activeSlot: number;
  fishState: number;
  fuseTicks: number;
  torchTicks: number;
}

/** A teammate (human or bot). */
export interface BotMate {
  id: string;
  seat: number;
  x: number;
  z: number;
  /** Role when a bot drives the seat ("" for a connected human or a reconnect stand-in: no team duties). */
  role: BotRole | "";
  /** Driven by the desk (a bot, or a human seat while it reconnects). */
  driven: boolean;
  /** A connected human. */
  human: boolean;
  alive: boolean;
  downed: boolean;
  downedTicks: number;
  washed: boolean;
  boarded: boolean;
  hp: number;
  hunger: number;
  thirst: number;
  slots: BotSlot[];
}

export interface BotMonster {
  id: string;
  kind: MonsterKind;
  x: number;
  y: number;
  z: number;
  mode: MonsterMode;
  hp: number;
  /** Estimated ground velocity (m/s) from the desk's tracking (0 when unknown). */
  vx: number;
  vz: number;
  targetId: string;
  carry: InvKind;
}

export interface BotGroundItem {
  id: string;
  kind: ItemKind;
  x: number;
  y: number;
  z: number;
  state: ProjectileState;
  ownerId: string;
  baitTicks: number;
}

/** A resource node that still has something to give. */
export interface BotNode {
  i: number;
  kind: NodeKind;
  yield: BushYield;
  x: number;
  z: number;
  amount: number;
  radius: number;
}

/** A fish spot plus where to stand on the shore to cast at it. */
export interface BotFishSpot {
  i: number;
  x: number;
  z: number;
  standX: number;
  standZ: number;
}

export interface BotSite {
  center: XZ;
  wreck: XZ;
  campfire: XZ;
  chest: XZ;
  raft: XZ & { yaw: number };
  spring: XZ;
}

/** One requirement row of a raft stage (RAFT_STAGES[stage].req[i]) with the team's progress. */
export interface BotRaftRow {
  /** Primary kind (prompt / icon). */
  item: ItemKind;
  /** Kinds that fill the row. */
  kinds: ReadonlyArray<ItemKind>;
  have: number;
  need: number;
}

export interface BotTeam {
  /** RAFT_STAGES index; RAFT_LAUNCH_STAGE = every stage assembled (board). */
  stage: RaftStage;
  seats: number;
  /** Requirement rows of the current stage (empty once finished). */
  rows: BotRaftRow[];
  /** The current stage accepts materials today (stageDayLock). */
  stageOpen: boolean;
  /** Rows of the next stage (have 0: what to prestock into the chest); empty past the last stage. */
  nextRows: BotRaftRow[];
  /** Assembly work done / needed on the current stage. */
  raftWork: number;
  raftWorkNeed: number;
  raftHp: number;
  /** The finished raft may be boarded now (launch window open and raft hp ≥ RAFT_HP_BOARD, or the push-off counting). */
  canBoard: boolean;
  benchTier: number;
  wreckScrap: number;
  springCharges: number;
  bossDown: boolean;
  fireFuel: number;
  chest: Partial<Record<ItemKind, number>>;
  launchTicksLeft: number;
}

export interface BotClock {
  phase: Phase;
  /** stepPlayer would ignore move / buttons (landing wake-up, cinematics). */
  locked: boolean;
  day: number;
  dayPhase: DayPhase;
  /** Ticks left / total in the current day phase. */
  phaseLeft: number;
  phaseLength: number;
  /** Ticks until the storm (end of the last night). */
  stormLeft: number;
  /** Days in the match (Timings.days). */
  days: number;
  /** Phase lengths in ticks. */
  dayTicks: number;
  duskTicks: number;
  nightTicks: number;
  weather: Weather;
  /** Warmth drops at night on this island (volcanic ground stays warm). */
  nightChill: boolean;
}

export interface BotLight {
  x: number;
  z: number;
  r: number;
  kind: "fire" | "torch" | "planted";
}

/** What other bots are already busy with (so two bots don't chase the same tree or coconut). */
export interface BotClaims {
  nodes: ReadonlySet<number>;
  items: ReadonlySet<string>;
  crabs: ReadonlySet<string>;
  spots: ReadonlySet<number>;
}

export interface BotView {
  self: BotSelf;
  /** Teammates, the bot itself excluded. */
  mates: BotMate[];
  monsters: BotMonster[];
  items: BotGroundItem[];
  nodes: BotNode[];
  fishSpots: BotFishSpot[];
  site: BotSite;
  team: BotTeam;
  clock: BotClock;
  lights: BotLight[];
  /** Planted torches (structures) with the ticks they still burn. */
  torches: { x: number; z: number; life: number }[];
  claims: BotClaims;
  /** Goal keys that failed recently (goalKey()). */
  blocked: (key: string) => boolean;
  /** The goal being executed (stickiness), null when the bot just started or finished. */
  current: Goal | null;
  /** One random draw in [0, 1) for tie-breaks (keeps chooseGoal pure). */
  roll: number;
}

/** Stable identity of a goal: same key = same plan (the motor keeps its progress). */
export function goalKey(g: Goal): string {
  switch (g.kind) {
    case "revive":
      return `revive:${g.playerId}`;
    case "attack":
      return `attack:${g.monsterId}`;
    case "throwAway":
      return `throwAway:${g.monsterId}`;
    case "eat":
      return `eat:${g.slot}`;
    case "spring":
      return "spring";
    case "craft":
      return `craft:${g.recipe}`;
    case "chestTake":
      return `chestTake:${g.items.map((i) => i.kind).join(",")}`;
    case "chestPut":
      return `chestPut:${g.items.map((i) => i.kind).join(",")}`;
    case "plantTorch":
      return "plantTorch";
    case "gather":
      return `gather:${g.node}`;
    case "shake":
      return `shake:${g.node}`;
    case "pickup":
      return `pickup:${g.projectileId}`;
    case "collectCrab":
      return `collectCrab:${g.monsterId}`;
    case "fish":
      return `fish:${g.spot}`;
    case "pass":
      return `pass:${g.playerId}`;
    case "burn":
      return "burn";
    case "flee":
      return `flee:${g.from}`;
    case "follow":
      return `follow:${g.playerId}`;
    case "fell":
      return `fell:${g.node}`;
    case "escort":
      return `escort:${g.playerId}`;
    default:
      return g.kind;
  }
}
