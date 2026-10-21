// Fishing loot (game4.md §8): the per-match table (FISH_LOOT × biome multipliers, each weight jittered ±20% from
// the match seed — same seed → same table, but the cast order depends on player timing so outcomes still differ),
// bad-luck protection, the "What did I get?" reel strips (Jelly Jackpot buildReel style, with a near-miss tease)
// and the treasure-chest table. Owner: server-world-life. Pure functions: the rng is passed in, nothing global,
// unit-tested in loot.test.ts.

import { BIOMES, FISH_PITY } from "../../shared/constants.js";
import { mulberry32, subSeed } from "../../shared/island/noise.js";
import { FISH_JUNK, FISH_LOOT, TREASURE_LOOT, fishLootFor, pickWeighted, type LootEntry } from "../../shared/items.js";
import type { Biome, FishLoot, TreasureId } from "../../shared/types.js";

export type Rng = () => number;

/** Each weight is multiplied by a seed-derived factor in [1 − LOOT_JITTER, 1 + LOOT_JITTER]. */
export const LOOT_JITTER = 0.2;
/** Salt for the table's sub-seed (independent of the island generator's streams). */
const LOOT_SALT = 0x10a7;

/** Fish reel strip: FISH_REEL_LENGTH icons, the catch sits at FISH_REEL_STOP (the client scrolls to it). */
export const FISH_REEL_LENGTH = 32;
export const FISH_REEL_STOP = 26;
/** Treasure reel strip. */
export const TREASURE_REEL_LENGTH = 24;
export const TREASURE_REEL_STOP = 19;
/** Chance a non-shiny catch gets a shiny one parked right next to it on the strip ("SO CLOSE!"). */
export const REEL_TEASE_CHANCE = 0.35;
/** What the tease parks next to the winner. */
const SHINY: ReadonlyArray<FishLoot> = ["golden", "treasure", "kraken"];

/** Pity re-rolls exclude junk and the self-exploding puffer ("at least a fish"). */
export const PITY_EXCLUDE: ReadonlySet<FishLoot> = new Set<FishLoot>([...FISH_JUNK, "puffer"]);

/** This match's fishing table: biome multipliers, then a ±LOOT_JITTER factor per entry from the seed. */
export function fishLootTable(seed: number, biome: Biome): LootEntry<FishLoot>[] {
  const rng = mulberry32(subSeed(seed >>> 0, LOOT_SALT));
  return fishLootFor(BIOMES[biome].loot).map((e) => ({ id: e.id, weight: e.weight * (1 - LOOT_JITTER + 2 * LOOT_JITTER * rng()) }));
}

/** The base table (no biome, no jitter): used before the first match starts. */
export function baseFishLootTable(): LootEntry<FishLoot>[] {
  return FISH_LOOT.map((e) => ({ id: e.id, weight: e.weight }));
}

/** Normalized probabilities of a table (legend, tests). */
export function lootChances<T extends string>(table: ReadonlyArray<LootEntry<T>>): Record<T, number> {
  let total = 0;
  for (const e of table) total += e.weight;
  const out = {} as Record<T, number>;
  for (const e of table) out[e.id] = total > 0 ? e.weight / total : 0;
  return out;
}

/** Boot / jellyfish (FISH_JUNK). */
export function isJunk(loot: FishLoot): boolean {
  return FISH_JUNK.includes(loot);
}

/** The table bad-luck protection rolls from (no junk, no puffer). */
export function pityTable(table: ReadonlyArray<LootEntry<FishLoot>>): LootEntry<FishLoot>[] {
  return table.filter((e) => !PITY_EXCLUDE.has(e.id) && e.weight > 0);
}

export interface FishRoll {
  loot: FishLoot;
  /** Bad-luck protection decided this catch. */
  pity: boolean;
}

/**
 * Roll one catch. `junkStreak` = junk catches in a row so far for this fisher; at FISH_PITY the catch comes from
 * pityTable (guaranteed at least a fish).
 */
export function rollFish(table: ReadonlyArray<LootEntry<FishLoot>>, rng: Rng, junkStreak: number): FishRoll {
  if (junkStreak >= FISH_PITY) {
    const safe = pityTable(table);
    if (safe.length > 0) return { loot: pickWeighted(safe, rng()), pity: true };
  }
  return { loot: pickWeighted(table, rng()), pity: false };
}

/** Junk streak after a catch. */
export function nextJunkStreak(streak: number, loot: FishLoot): number {
  return isJunk(loot) ? streak + 1 : 0;
}

export interface Reel<T extends string> {
  reel: T[];
  stopIndex: number;
}

/** Fish reel: weighted like the table, reel[stopIndex] === loot, sometimes a shiny tease next to it. */
export function fishReel(rng: Rng, table: ReadonlyArray<LootEntry<FishLoot>>, loot: FishLoot): Reel<FishLoot> {
  const reel: FishLoot[] = [];
  for (let i = 0; i < FISH_REEL_LENGTH; i++) reel.push(pickWeighted(table, rng()));
  reel[FISH_REEL_STOP] = loot;
  if (!SHINY.includes(loot) && rng() < REEL_TEASE_CHANCE) {
    const side = rng() < 0.65 ? 1 : -1;
    reel[FISH_REEL_STOP + side] = SHINY[Math.min(SHINY.length - 1, Math.floor(rng() * SHINY.length))]!;
  }
  return { reel, stopIndex: FISH_REEL_STOP };
}

/** One treasure (TREASURE_LOOT weights) skipping `exclude` (all excluded → plain roll). */
export function rollTreasure(rng: Rng, exclude?: ReadonlySet<TreasureId>): TreasureId {
  const pool = exclude && exclude.size > 0 ? TREASURE_LOOT.filter((e) => !exclude.has(e.id)) : TREASURE_LOOT;
  return pickWeighted(pool.length > 0 ? pool : TREASURE_LOOT, rng());
}

/** Treasure reel strip: reel[stopIndex] === treasure, no two neighbours equal (it reads as spinning). */
export function treasureReel(rng: Rng, treasure: TreasureId): Reel<TreasureId> {
  const reel: TreasureId[] = [];
  for (let i = 0; i < TREASURE_REEL_LENGTH; i++) {
    let t = pickWeighted(TREASURE_LOOT, rng());
    if (i > 0 && t === reel[i - 1]) t = TREASURE_LOOT[(TREASURE_LOOT.findIndex((e) => e.id === t) + 1) % TREASURE_LOOT.length]!.id;
    reel.push(t);
  }
  reel[TREASURE_REEL_STOP] = treasure;
  // Keep the neighbours of the winner different from it so the stop is unambiguous.
  for (const k of [TREASURE_REEL_STOP - 1, TREASURE_REEL_STOP + 1]) {
    if (reel[k] === treasure) reel[k] = TREASURE_LOOT[(TREASURE_LOOT.findIndex((e) => e.id === treasure) + 2) % TREASURE_LOOT.length]!.id;
  }
  return { reel, stopIndex: TREASURE_REEL_STOP };
}
