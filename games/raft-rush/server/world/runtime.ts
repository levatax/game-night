// Server-only per-player data that is not synced (docs/ARCHITECTURE.md §4.3 step 6). Owner: server-world.
//
// Survival bars live here as floats (they drain by fractions of a point per tick); the schema gets the values
// rounded UP, so a bar shows 0 exactly when it is really empty (the shared sim's starving / freezing speed
// multipliers read the schema value). If anything else writes a bar in the schema, the next survival pass adopts
// it (see SurvivalSystem.adopt).

import { BAR_MAX, MAX_HP } from "../../shared/constants.js";
import type { PlayerState } from "../schema.js";

/** The four bars that raise a `lowBar` feed line once per dip. */
export type LowBarKind = "hunger" | "thirst" | "warmth" | "hp";

export interface PlayerRuntime {
  /** Float bars (0..BAR_MAX / MAX_HP). */
  hp: number;
  hunger: number;
  thirst: number;
  warmth: number;
  /** A `lowBar` line may fire for this bar (re-armed once the bar climbs back above the hysteresis level). */
  lowArmed: Record<LowBarKind, boolean>;
  /** Ticks since the last once-per-second hp damage pass (empty bars, drowning, jellyfish). */
  secTicks: number;
  /** The right-click catch window opened by the current press is still unused. */
  catchOpen: boolean;
  /** Revive channel target (player id), "" when none. */
  reviveTarget: string;
  /** Raft seat while boarded (-1 = none). */
  seat: number;
  /** This down is the match's free second wind: the player gets up alone when the timer runs out. */
  selfRevive: boolean;
}

/** Fresh runtime mirroring the schema bars of `p`. */
export function createRuntime(p: Pick<PlayerState, "hp" | "hunger" | "thirst" | "warmth">): PlayerRuntime {
  return {
    hp: clampBar(p.hp, MAX_HP),
    hunger: clampBar(p.hunger, BAR_MAX),
    thirst: clampBar(p.thirst, BAR_MAX),
    warmth: clampBar(p.warmth, BAR_MAX),
    lowArmed: { hunger: true, thirst: true, warmth: true, hp: true },
    secTicks: 0,
    catchOpen: false,
    reviveTarget: "",
    seat: -1,
    selfRevive: false,
  };
}

function clampBar(v: number, max: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : max;
}

/** Runtime records keyed by player id. */
export class RuntimeStore {
  private readonly byId = new Map<string, PlayerRuntime>();

  /** The record of `p` (created from its schema bars on first use). */
  of(p: PlayerState): PlayerRuntime {
    let rt = this.byId.get(p.id);
    if (!rt) {
      rt = createRuntime(p);
      this.byId.set(p.id, rt);
    }
    return rt;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Replace the record of `p` with a fresh one (match start, respawn). */
  reset(p: PlayerState): PlayerRuntime {
    const rt = createRuntime(p);
    this.byId.set(p.id, rt);
    return rt;
  }

  delete(id: string): void {
    this.byId.delete(id);
  }

  clear(): void {
    this.byId.clear();
  }
}
