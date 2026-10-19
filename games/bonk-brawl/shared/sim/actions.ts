// Continuous animation state from sim fields. Owner: sim (written by architect, complete).
// Used by client-characters (Animator) and anything else that needs "what is this player doing".

import type { CharacterId, PlayerAction, PlayerSimFields } from "../types.js";

/** Horizontal speed above which a grounded player counts as running. */
export const RUN_SPEED_THRESHOLD = 0.6;

/**
 * Priority: ghost (not alive) > stunned > roll > ability (movement/visible abilities only:
 * flap dash, ground pound, belly slide, headbutt, belly bounce) > whiff > catch > charge >
 * jump/fall (airborne, by vy sign) > run > idle.
 * Whiskers' armed curveball is not an action (it's a glow on the held ball / HUD state).
 */
export function derivePlayerAction(p: PlayerSimFields, character: CharacterId): PlayerAction {
  void character;
  if (!p.alive) return "ghost";
  if (p.stunTicks > 0) return "stunned";
  if (p.rollTicks > 0) return "roll";
  if (p.abilityTicks > 0) return "ability";
  if (p.whiffTicks > 0) return "whiff";
  if (p.catchTicks > 0) return "catch";
  if (p.chargeTicks > 0) return "charge";
  if (!p.grounded) return p.vy > 0 ? "jump" : "fall";
  if (Math.hypot(p.vx, p.vz) > RUN_SPEED_THRESHOLD) return "run";
  return "idle";
}
