// Items, recipes and loot tables for Raft Rush. FROZEN CONTRACT (see docs/ARCHITECTURE.md).
// Data plus tiny pure helpers (complete). Display names are translated on the client (`items.<kind>`,
// `recipes.<id>`); the English `name` fields are fallbacks for server text and tests.

import { RAFT_COSTS } from "./constants.js";
import type { FishLoot, InvKind, ItemKind, RecipeId, StructureKind, TreasureId } from "./types.js";

/* ================================================================ items */

export type ItemCategory = "material" | "food" | "water" | "tool" | "raft" | "placeable" | "loot";

export interface ItemDef {
  kind: ItemKind;
  name: string;
  /** HUD emoji fallback (the client may draw its own icon). */
  icon: string;
  category: ItemCategory;
  /** Max units per inventory slot (§7: wood 5, stone 3, rope 5, coconuts 3, tools 1). */
  stack: number;
  /** LMB hold charges and throws it. Non-throwables do a "use" on LMB press instead. */
  throwable: boolean;
  /** Damage to monsters (and to enemy players in duel). Coop players take knockback only. */
  damage: number;
  /** Knockback multiplier on a hit. */
  knock: number;
  /** Projectile collision radius. */
  radius: number;
  gravityScale: number;
  /** Ground bounce restitution. */
  restitution: number;
  /** Bounces before it just rolls (coconut: 2). */
  maxBounces: number;
  /** Becomes `stuck` on terrain / trunk impact (spear). */
  sticks: boolean;
  /** Hunger / thirst restored when eaten or drunk with F (0 = not consumable). */
  food: number;
  water: number;
  /** Counts toward the raft's provision stage. */
  provision: "food" | "water" | null;
  /** LMB "use" places this structure in front of the player (fence, collector, kraken). */
  places: StructureKind | null;
  /** Light radius while it is the active item (lit torch). */
  lightRadius: number;
}

const base = {
  throwable: false,
  damage: 0,
  knock: 1,
  radius: 0.18,
  gravityScale: 1,
  restitution: 0.35,
  maxBounces: 3,
  sticks: false,
  food: 0,
  water: 0,
  provision: null,
  places: null,
  lightRadius: 0,
} as const;

export const ITEMS: Readonly<Record<ItemKind, ItemDef>> = {
  wood: { ...base, kind: "wood", name: "Wood", icon: "🪵", category: "material", stack: 5, throwable: true, radius: 0.2, restitution: 0.2 },
  rope: { ...base, kind: "rope", name: "Rope", icon: "🧵", category: "material", stack: 5, radius: 0.16, restitution: 0.15 },
  /** Flies flat, doesn't bounce (§11). */
  stone: { ...base, kind: "stone", name: "Stone", icon: "🪨", category: "material", stack: 3, throwable: true, damage: 1, radius: 0.15, gravityScale: 0.8, restitution: 0.1, maxBounces: 0 },
  /** Food + water + ammo; bounces twice; knocks coconuts off palms it hits (§11). */
  coconut: { ...base, kind: "coconut", name: "Coconut", icon: "🥥", category: "food", stack: 3, throwable: true, damage: 1, radius: 0.2, restitution: 0.55, maxBounces: 2, food: 25, water: 25, provision: "food" },
  /** Thrown fish = bait (§10). */
  fish_raw: { ...base, kind: "fish_raw", name: "Raw fish", icon: "🐟", category: "food", stack: 3, throwable: true, radius: 0.2, restitution: 0.2, food: 20, provision: "food" },
  fish_cooked: { ...base, kind: "fish_cooked", name: "Cooked fish", icon: "🍢", category: "food", stack: 3, radius: 0.2, food: 45, provision: "food" },
  crab_raw: { ...base, kind: "crab_raw", name: "Raw crab", icon: "🦀", category: "food", stack: 2, radius: 0.25, food: 10, provision: null },
  crab_cooked: { ...base, kind: "crab_cooked", name: "Cooked crab", icon: "🍤", category: "food", stack: 2, radius: 0.25, food: 50, provision: "food" },
  fish_golden: { ...base, kind: "fish_golden", name: "Golden fish", icon: "🐠", category: "food", stack: 1, radius: 0.22, food: 100, water: 50, provision: "food" },
  water: { ...base, kind: "water", name: "Water gourd", icon: "💧", category: "water", stack: 3, radius: 0.2, water: 50, provision: "water" },
  /** Sticks where it lands; E picks it back up; longest range (§11). */
  spear: { ...base, kind: "spear", name: "Spear", icon: "🔱", category: "tool", stack: 1, throwable: true, damage: 2, radius: 0.14, gravityScale: 0.85, restitution: 0.1, maxBounces: 0, sticks: true },
  rod: { ...base, kind: "rod", name: "Fishing rod", icon: "🎣", category: "tool", stack: 1, radius: 0.2 },
  /** LMB swings it (scares crabs); Q plants it (fixed light); burns TORCH_BURN_TICKS while active. */
  torch: { ...base, kind: "torch", name: "Torch", icon: "🔥", category: "tool", stack: 1, radius: 0.18, lightRadius: 4 },
  axe: { ...base, kind: "axe", name: "Axe", icon: "🪓", category: "tool", stack: 1, radius: 0.2 },
  /** Carry to the raft (1 slot) and press E: counts RAFT_PART_WOOD wood. */
  raft_part: { ...base, kind: "raft_part", name: "Raft part", icon: "🛶", category: "raft", stack: 1, throwable: true, radius: 0.35, restitution: 0.1, maxBounces: 1 },
  fence: { ...base, kind: "fence", name: "Fence", icon: "🚧", category: "placeable", stack: 2, radius: 0.3, places: "fence" },
  collector: { ...base, kind: "collector", name: "Water collector", icon: "🪣", category: "placeable", stack: 1, radius: 0.3, places: "collector" },
  /** Legendary recipe (bottle): splits into 3 coconuts on release (triple shot). */
  coconut_ball: { ...base, kind: "coconut_ball", name: "Coconut cluster", icon: "🥥", category: "loot", stack: 1, throwable: true, damage: 1, radius: 0.24, restitution: 0.5, maxBounces: 2 },
  /** Junk: 1 damage, double knockback, comic bonk. Wearable cosmetic (cosmetic "boot"). */
  boot: { ...base, kind: "boot", name: "Old boot", icon: "🥾", category: "loot", stack: 1, throwable: true, damage: 1, knock: 2, radius: 0.2, restitution: 0.3 },
  /** Hurts while active (−3 hp/s); thrown into a torch / the fire: +60 s fuel. */
  jellyfish: { ...base, kind: "jellyfish", name: "Jellyfish", icon: "🪼", category: "loot", stack: 1, throwable: true, radius: 0.2, restitution: 0.05, maxBounces: 0 },
  /** Thrown: explodes on impact (3 m, 2 damage, flips crabs, knocks players back). Explodes in hand after 5 s! */
  puffer: { ...base, kind: "puffer", name: "Pufferfish", icon: "🐡", category: "loot", stack: 1, throwable: true, damage: 2, radius: 0.22, restitution: 0.4 },
  /** Place it (LMB): thrashes for 10 s flinging monsters. Or cook it: +30 hunger for the whole team. */
  kraken: { ...base, kind: "kraken", name: "Kraken tentacle", icon: "🦑", category: "loot", stack: 1, radius: 0.3, places: "kraken" },
};

export const ITEM_KINDS = Object.keys(ITEMS) as ItemKind[];

export function isItemKind(k: unknown): k is ItemKind {
  return typeof k === "string" && Object.prototype.hasOwnProperty.call(ITEMS, k);
}
export function itemDef(kind: ItemKind): ItemDef {
  return ITEMS[kind];
}
export function stackLimit(kind: ItemKind): number {
  return ITEMS[kind].stack;
}
export function isThrowable(kind: InvKind): boolean {
  return kind !== "" && ITEMS[kind].throwable;
}
export function isConsumable(kind: InvKind): boolean {
  return kind !== "" && (ITEMS[kind].food > 0 || ITEMS[kind].water > 0);
}
export function isCooked(kind: InvKind): boolean {
  return kind === "fish_cooked" || kind === "crab_cooked";
}

/* ============================================================== recipes */

export interface RecipeDef {
  id: RecipeId;
  name: string;
  /** Ingredients, taken from the crafter's inventory first, then from the team chest. */
  cost: Partial<Record<ItemKind, number>>;
  /** Item produced (into the inventory, or dropped at the crafter's feet when full). null for fuel / team effects. */
  out: ItemKind | null;
  outCount: number;
  /** "fuel": campfire +FIRE_WOOD_FUEL_TICKS; "team": cooked kraken feeds everyone. */
  effect: "item" | "fuel" | "team";
  /** Needs team.ballRecipe (unlocked by a bottle). */
  locked: boolean;
  /** Ada Savaşı only. */
  duelOnly: boolean;
}

const recipe = (r: Omit<RecipeDef, "outCount" | "effect" | "locked" | "duelOnly"> & Partial<RecipeDef>): RecipeDef => ({
  outCount: 1,
  effect: "item",
  locked: false,
  duelOnly: false,
  ...r,
});

/** Campfire workbench (§7), in panel order. */
export const RECIPES: Readonly<Record<RecipeId, RecipeDef>> = {
  fuel: recipe({ id: "fuel", name: "Feed the fire", cost: { wood: 1 }, out: null, effect: "fuel" }),
  raft_part: recipe({ id: "raft_part", name: "Raft part", cost: { wood: 3 }, out: "raft_part" }),
  spear: recipe({ id: "spear", name: "Spear", cost: { wood: 1, stone: 1 }, out: "spear" }),
  rod: recipe({ id: "rod", name: "Fishing rod", cost: { wood: 2, rope: 1 }, out: "rod" }),
  torch: recipe({ id: "torch", name: "Torch", cost: { wood: 1, rope: 1 }, out: "torch" }),
  axe: recipe({ id: "axe", name: "Axe", cost: { wood: 1, stone: 1, rope: 1 }, out: "axe" }),
  collector: recipe({ id: "collector", name: "Water collector", cost: { wood: 2, rope: 1 }, out: "collector" }),
  fence: recipe({ id: "fence", name: "Fence", cost: { wood: 2 }, out: "fence" }),
  cook_fish: recipe({ id: "cook_fish", name: "Cook fish", cost: { fish_raw: 1 }, out: "fish_cooked" }),
  cook_crab: recipe({ id: "cook_crab", name: "Cook crab", cost: { crab_raw: 1 }, out: "crab_cooked" }),
  cook_kraken: recipe({ id: "cook_kraken", name: "Cook kraken (team feast)", cost: { kraken: 1 }, out: null, effect: "team" }),
  coconut_ball: recipe({ id: "coconut_ball", name: "Coconut cluster", cost: { coconut: 3 }, out: "coconut_ball", locked: true }),
  hut: recipe({ id: "hut", name: "Hut", cost: { wood: 6, rope: 2 }, out: null, duelOnly: true }),
  canoe: recipe({ id: "canoe", name: "Canoe", cost: { wood: 4, rope: 2 }, out: null, duelOnly: true }),
};

export const RECIPE_IDS = Object.keys(RECIPES) as RecipeId[];

export function isRecipeId(id: unknown): id is RecipeId {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(RECIPES, id);
}

/* ============================================================ raft cost */

export interface RaftCost {
  hullWood: number;
  mastWood: number;
  mastRope: number;
  food: number;
  water: number;
}

/** Requirements for `seats` players (clamped 2..6). `cheap` (RAFT_TEST fast) = 1 of everything. */
export function raftCost(seats: number, cheap = false): RaftCost {
  if (cheap) return { hullWood: 1, mastWood: 1, mastRope: 1, food: 1, water: 1 };
  const s = Math.max(2, Math.min(6, Math.round(seats)));
  return { ...RAFT_COSTS[s]! };
}

/* ============================================================ fish loot */

export interface LootEntry<T extends string> {
  id: T;
  weight: number;
}

/** §8 base weights (sum 96). Biome multipliers in BIOMES[b].loot; the server shuffles per match seed. */
export const FISH_LOOT: ReadonlyArray<LootEntry<FishLoot>> = [
  { id: "fish", weight: 45 },
  { id: "crab", weight: 12 },
  { id: "boot", weight: 10 },
  { id: "jellyfish", weight: 8 },
  { id: "puffer", weight: 6 },
  { id: "bottle", weight: 6 },
  { id: "treasure", weight: 5 },
  { id: "golden", weight: 3 },
  { id: "kraken", weight: 1 },
];

/** Junk for bad-luck protection (FISH_PITY in a row → next catch is at least a fish). */
export const FISH_JUNK: ReadonlyArray<FishLoot> = ["boot", "jellyfish"];

/** Item granted for a catch (null = an instant effect: bottle / treasure). */
export const FISH_LOOT_ITEM: Readonly<Record<FishLoot, ItemKind | null>> = {
  fish: "fish_raw",
  crab: "crab_raw",
  boot: "boot",
  jellyfish: "jellyfish",
  puffer: "puffer",
  bottle: null,
  treasure: null,
  golden: "fish_golden",
  kraken: "kraken",
};

export const TREASURE_LOOT: ReadonlyArray<LootEntry<TreasureId>> = [
  { id: "flare", weight: 1 },
  { id: "old_sail", weight: 1 },
  { id: "pirate_hat", weight: 1 },
  { id: "spyglass", weight: 1 },
  { id: "fuel_can", weight: 1 },
];

/** Base fish-loot weights with the biome's multipliers applied (before the per-match shuffle). */
export function fishLootFor(biomeLoot: Partial<Record<FishLoot, number>>): LootEntry<FishLoot>[] {
  return FISH_LOOT.map((e) => ({ id: e.id, weight: e.weight * (biomeLoot[e.id] ?? 1) }));
}

/** Pick from weighted entries with r in [0, 1). */
export function pickWeighted<T extends string>(entries: ReadonlyArray<LootEntry<T>>, r: number): T {
  let total = 0;
  for (const e of entries) total += e.weight;
  let x = r * total;
  for (const e of entries) {
    x -= e.weight;
    if (x < 0) return e.id;
  }
  return entries[entries.length - 1]!.id;
}
