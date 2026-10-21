// Context objects passed into the deterministic shared sim. Owner: sim (contract written by the architect).

import type { Heightfield } from "../island/types.js";
import type { CharacterId } from "../types.js";
import type { CoverQuery } from "./cover.js";

/** What terrain / collision queries need. */
export interface WorldQuery {
  terrain: Heightfield;
  /** Static colliders (trunks, rocks, wreck, chest) + placed structures (fences, collectors, huts). */
  cover: CoverQuery;
  /** Walkable / swimmable rectangle (IslandDef.bounds): positions are clamped inside it. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** Context for stepPlayer(). Build one per call (or reuse and mutate). */
export interface SimContext extends WorldQuery {
  /** Character of the player being stepped (capsule radius, swim speed). */
  character: CharacterId;
  /** Integration step in seconds. Always DT for normal play and client prediction. Timers tick 1 per call. */
  dt: number;
  /**
   * Input locked (landing wake-up, launch / storm cinematics): stepPlayer applies look (yaw/pitch) but treats
   * move input as zero and all buttons as released (a running charge is cancelled, not thrown; channels clear).
   * Physics and collisions continue. Server and client prediction derive it from the same state (phase +
   * phaseTicksLeft, see shared/rules/schedule.ts inputLocked()).
   */
  locked: boolean;
}

/** Context for stepProjectile(). */
export interface ProjectileContext extends WorldQuery {
  dt: number;
}
