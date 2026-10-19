// Context objects passed into the deterministic shared sim. Owner: sim (contract written by architect).

import type { ArenaDef } from "../maps.js";
import type { CharacterId } from "../types.js";
import type { Vec3 } from "./math.js";

/** What the floor/cover queries need: arena geometry + current ring states. */
export interface FloorQuery {
  arena: ArenaDef;
  /** state.rings: RingState per ring (0 solid, 1 shaking = still solid, 2 fallen). */
  rings: ArrayLike<number>;
}

/** Context for stepPlayer(). Build one per call (or reuse and mutate). */
export interface SimContext extends FloorQuery {
  /** Character of the player being stepped (selects ability behavior). */
  character: CharacterId;
  /**
   * Integration step in seconds. Always DT for normal play and client prediction. The server
   * passes DT * ROUND_END_SLOWMO_SCALE during the round-end slow-mo (inputs are ignored then).
   * Timers always tick by exactly 1 per call regardless of dt.
   */
  dt: number;
  /**
   * Input locked (countdown, round-end slow-mo): stepPlayer applies look (yaw/pitch) but treats
   * move input as zero and all buttons as released (a running charge is cancelled, not thrown).
   * Physics, timers and collisions continue.
   * Server: locked = phase is not "playing"/"suddenDeath". Client prediction uses the same rule
   * from the latest state.phase.
   */
  locked: boolean;
}

/** Context for stepBall(). */
export interface BallContext extends FloorQuery {
  dt: number;
  /**
   * Curveball steering: unit direction of the thrower's CURRENT aim (dirFromYawPitch of the
   * owner's yaw/pitch), or null. Only used when ball.curve && state === "live" && ageTicks < CURVE_MAX_TICKS.
   */
  steer: Vec3 | null;
  /**
   * Boomerang return target: the owner's chest position (feet + CHEST_HEIGHT), or null if the
   * owner is gone/eliminated (then a returning boomerang just turns dead and falls).
   */
  returnTarget: Vec3 | null;
}
