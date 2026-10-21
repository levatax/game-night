// Plain data the helper-bot brain reasons about (§12, §19 "Botlar"). Owner: server-bots.
//
// botSense.ts builds a BotView from the room state once per think; botBrain.ts chooseGoal(view) turns it into
// a Goal; botMotor.ts executes the Goal one InputCmd at a time. Keeping the view a plain snapshot (no schema
// classes) lets the decision functions be pure and lets tests hand-write synthetic views.

import type { RaftCost } from "../../shared/items.js";
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

export interface BotTeam {
  stage: RaftStage;
  seats: number;
  cost: RaftCost;
  hullWood: number;
  mastWood: number;
  mastRope: number;
  food: number;
  water: number;
  fireFuel: number;
  chest: Partial<Record<ItemKind, number>>;
  launchTicksLeft: number;
  sail: boolean;
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
    default:
      return g.kind;
  }
}
