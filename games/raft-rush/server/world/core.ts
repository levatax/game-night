// Internal wiring of RaftWorld (server-world "core"). Owner: server-world.
//
// RaftWorld implements WorldCore: the public WorldContext the life systems use (server/world/context.ts) plus
// the rule systems of this folder, so each system can reach its siblings without importing World.ts at runtime
// (type-only imports, no cycles). Every system is a small class holding a WorldCore:
//   bag (inventory ops + item timers) · projectiles · nodes (gathering, palms, regrow) · structures ·
//   raft (delivery, assembly, raft hp, boarding, push-off) · camp (spring charges, wreck salvage) · survival (bars, fire, downed / washed / respawn) ·
//   crafting (recipes, the camp chest) · effects (treasures, bottles) · actions (stepPlayer results)
// plus the life systems monsters / fishing / weather (server-world-life).

import type { RejectEvent } from "../../shared/protocol.js";
import type { ClockInfo } from "../../shared/rules/schedule.js";
import type { InteractKind } from "../../shared/types.js";
import type { ActionSystem } from "./actions.js";
import type { Bag } from "./bag.js";
import type { CampSystem } from "./camp.js";
import type { PlayerState, WorldContext } from "./context.js";
import type { CraftSystem } from "./crafting.js";
import type { EffectSystem } from "./effects.js";
import type { FishingSystem } from "./fishing.js";
import type { MonsterSystem } from "./monsters.js";
import type { NodeSystem } from "./nodes.js";
import type { ProjectileSystem } from "./projectiles.js";
import type { RaftSystem } from "./raft.js";
import type { RuntimeStore } from "./runtime.js";
import type { StructureSystem } from "./structures.js";
import type { SurvivalSystem } from "./survival.js";
import type { WeatherSystem } from "./weather.js";

export interface WorldCore extends WorldContext {
  readonly runtime: RuntimeStore;
  readonly bag: Bag;
  readonly projectiles: ProjectileSystem;
  readonly nodes: NodeSystem;
  readonly structures: StructureSystem;
  readonly raft: RaftSystem;
  readonly camp: CampSystem;
  readonly survival: SurvivalSystem;
  readonly crafting: CraftSystem;
  readonly effects: EffectSystem;
  readonly actions: ActionSystem;
  readonly monsters: MonsterSystem;
  readonly fishing: FishingSystem;
  readonly weather: WeatherSystem;
  /** Day clock of the step in progress (null during the landing and the cinematics). */
  readonly dayClock: ClockInfo | null;
  /** Team participants (alive or washed, not spectators). */
  participants(team?: number): PlayerState[];
  /** Emit a `reject` hint for a player. */
  reject(p: PlayerState, action: RejectAction, reason: string, interact?: InteractKind): void;
  /** The light rings changed mid-tick (fire lit / out, torch planted / burnt out): recompute on the next lights(). */
  lightsChanged(): void;
}

/** RejectEvent.action. */
export type RejectAction = RejectEvent["action"];
