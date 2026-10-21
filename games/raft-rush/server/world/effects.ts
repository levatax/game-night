// Instant team effects of treasure chests and messages in a bottle (game4.md §8, docs/ARCHITECTURE.md §2.8).
// Owner: server-world. The FishingSystem (server-world-life) picks the loot, emits `treasure` and calls these when
// the reel ends; RaftWorld exposes them as WorldContext.applyTreasure / applyBottle.

import { FUEL_CAN_TICKS, PIRATE_HAT_SCORE, SPYGLASS_TICKS } from "../../shared/constants.js";
import type { BottleEffect, TreasureId } from "../../shared/types.js";
import type { PlayerState } from "./context.js";
import type { WorldCore } from "./core.js";

export class EffectSystem {
  constructor(private readonly core: WorldCore) {}

  /**
   * Treasure for the finder's team: flare (the next night spawns no monsters), old sail (the mast stage completes
   * now, or as soon as the hull does), pirate hat (cosmetic + PIRATE_HAT_SCORE), spyglass (every resource on the
   * compass for SPYGLASS_TICKS), fuel can (+FUEL_CAN_TICKS fire, relights it).
   */
  applyTreasure(p: PlayerState, treasure: TreasureId): void {
    const core = this.core;
    const teamIdx = core.site(p.team).team;
    const team = core.team(teamIdx);
    switch (treasure) {
      case "flare":
        team.flare = true;
        break;
      case "old_sail":
        core.raft.applySail(teamIdx);
        break;
      case "pirate_hat":
        p.cosmetic = "pirate_hat";
        core.addScore(p, PIRATE_HAT_SCORE);
        break;
      case "spyglass":
        team.spyglassTicks = SPYGLASS_TICKS;
        break;
      case "fuel_can":
        core.addFireFuel(teamIdx, FUEL_CAN_TICKS, p.id, "fuelCan");
        break;
    }
  }

  /**
   * A message in a bottle: reveals the secret chest (if still hidden), else marks the spring on the compass,
   * else unlocks the coconut-ball recipe. Emits `bottle` with what it did.
   */
  applyBottle(p: PlayerState): BottleEffect {
    const core = this.core;
    const teamIdx = core.site(p.team).team;
    const team = core.team(teamIdx);
    let effect: BottleEffect;
    if (!team.secretRevealed && !team.secretOpened) {
      team.secretRevealed = true;
      effect = "secretChest";
    } else if (!team.springRevealed) {
      team.springRevealed = true;
      effect = "spring";
    } else {
      team.ballRecipe = true;
      effect = "recipe";
    }
    core.emit({ type: "bottle", tick: core.tick(), playerId: p.id, team: teamIdx, effect });
    return effect;
  }
}
