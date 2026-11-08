// Motion cues for animation / FX, read from player sim fields. Owner: sim.
// Pure and allocation-free (fills a caller-owned object). Not used by the simulation itself.

import { JUMP_APEX_HANG_VY } from "../constants.js";
import type { PlayerSimFields } from "../types.js";

export interface MotionCues {
  /** Stunned and airborne (launched by a knockback). */
  tumbling: boolean;
  /** Stunned and sliding on the ground faster than 1 m/s. */
  knockSliding: boolean;
  /** Grounded turn skid (sim field `skid`). */
  skidding: boolean;
  /** Rising in a held jump (above the apex hang). */
  jumpRising: boolean;
  /** Held jump inside the apex hang (|vy| ≤ JUMP_APEX_HANG_VY). */
  apexHang: boolean;
  /** Airborne, not stunned, falling faster than the hang speed. */
  fastFalling: boolean;
  /** Horizontal speed (m/s). */
  speed: number;
}

export function createMotionCues(): MotionCues {
  return {
    tumbling: false,
    knockSliding: false,
    skidding: false,
    jumpRising: false,
    apexHang: false,
    fastFalling: false,
    speed: 0,
  };
}

/** Fill `out` from a player's sim fields (predicted or interpolated) and return it. */
export function readMotionCues(p: PlayerSimFields, out: MotionCues): MotionCues {
  const speed = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  const stun = p.stunTicks > 0;
  out.tumbling = stun && !p.grounded;
  out.knockSliding = stun && p.grounded && speed > 1;
  out.skidding = p.skid;
  out.jumpRising = p.jumping && p.vy > JUMP_APEX_HANG_VY;
  out.apexHang = p.jumping && Math.abs(p.vy) <= JUMP_APEX_HANG_VY;
  out.fastFalling = !p.grounded && !stun && p.vy < -JUMP_APEX_HANG_VY;
  out.speed = speed;
  return out;
}
