// Night waves (game4.md §10, §21): how many crabs / puffer balls / bosses come on a night, when each of them
// climbs out of the surf, and from which shore cell. Owner: server-world-life. Pure functions (rng passed in),
// unit-tested through monsters.test.ts.

import {
  FULLMOON_MONSTER_MULT,
  MONSTER_SPAWN_FAR_BIAS,
  MONSTER_SPAWN_WINDOW,
  nightWave,
  type BiomeDef,
  type DifficultyDef,
} from "../../../shared/constants.js";
import type { XZ } from "../../../shared/island/types.js";
import type { MonsterKind } from "../../../shared/types.js";
import { d2, pickBy, type Rng } from "./util.js";

export interface WaveInput {
  night: number;
  /** Players incl. bots the raft is sized for (team.seats). */
  seats: number;
  difficulty: Readonly<DifficultyDef>;
  biome: Readonly<BiomeDef>;
  /** Tonight is a full moon (state.weather "fullmoon"): ×FULLMOON_MONSTER_MULT. */
  fullMoon: boolean;
  /** A flare was found: no monsters tonight. */
  flare: boolean;
}

export interface WavePlan {
  crabs: number;
  puffers: number;
  boss: number;
  /** The flare skipped this night. */
  skipped: boolean;
}

/**
 * Monster counts for a night: nightWave(night, seats) × difficulty × biome (crabMult / pufferMult) × full moon,
 * rounded (never below 1 when the base wave has that kind). The boss is never multiplied; nightmare also sends
 * it on night 2. A flare skips the night entirely.
 */
export function planWave(i: WaveInput): WavePlan {
  if (i.flare) return { crabs: 0, puffers: 0, boss: 0, skipped: true };
  const base = nightWave(i.night, i.seats);
  const moon = i.fullMoon ? FULLMOON_MONSTER_MULT : 1;
  const scaled = (n: number, mult: number) => (n > 0 ? Math.max(1, Math.round(n * i.difficulty.monsters * mult * moon)) : 0);
  const boss = base.boss > 0 || (i.difficulty.bossNight2 && i.night === 2) ? 1 : 0;
  return { crabs: scaled(base.crabs, i.biome.crabMult), puffers: scaled(base.puffers, i.biome.pufferMult), boss, skipped: false };
}

export interface WaveSpawn {
  kind: MonsterKind;
  /** Ticks after the night started. */
  at: number;
}

/**
 * Spread a wave over the first MONSTER_SPAWN_WINDOW of the night: evenly spaced slots with a little jitter,
 * puffers shuffled in among the crabs, the boss at the middle of the window (its entrance gets a beat of its
 * own). Sorted by `at`.
 */
export function scheduleWave(plan: WavePlan, nightTicks: number, rng: Rng): WaveSpawn[] {
  const window = Math.max(1, Math.floor(nightTicks * MONSTER_SPAWN_WINDOW));
  const kinds: MonsterKind[] = [];
  for (let k = 0; k < plan.crabs; k++) kinds.push("crab");
  for (let k = 0; k < plan.puffers; k++) {
    // Insert each puffer at a random position (never first: the night opens with crabs).
    const at = kinds.length === 0 ? 0 : 1 + Math.floor(rng() * kinds.length);
    kinds.splice(Math.min(at, kinds.length), 0, "puffer");
  }
  const out: WaveSpawn[] = [];
  const n = kinds.length;
  const slot = n > 0 ? window / n : window;
  kinds.forEach((kind, k) => {
    const jitter = (rng() - 0.5) * slot * 0.6;
    out.push({ kind, at: Math.max(0, Math.min(window - 1, Math.round(k * slot + jitter))) });
  });
  if (plan.boss > 0) out.push({ kind: "boss", at: Math.floor(window / 2) });
  out.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * A shore cell to climb out of: weight ∝ distance-to-camp ^ MONSTER_SPAWN_FAR_BIAS (the far side of the camp is
 * likelier), re-rolled a few times when `bad(cell)` (inside a light ring, right next to a player).
 */
export function pickShoreCell(shore: ReadonlyArray<XZ>, camp: XZ, rng: Rng, bad: (c: XZ) => boolean): XZ | null {
  if (shore.length === 0) return null;
  const weight = (c: XZ) => Math.pow(Math.sqrt(d2(c.x, c.z, camp.x, camp.z)) + 1, MONSTER_SPAWN_FAR_BIAS);
  let cell: XZ | undefined;
  for (let tries = 0; tries < 6; tries++) {
    cell = pickBy(rng, shore, weight);
    if (cell && !bad(cell)) return cell;
  }
  const ok = shore.filter((c) => !bad(c));
  return (ok.length > 0 ? pickBy(rng, ok, weight) : cell) ?? null;
}
