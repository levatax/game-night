// Items, recipes and loot tables for Raft Rush. FROZEN CONTRACT (see docs/ARCHITECTURE.md).
// Data plus tiny pure helpers (complete). Display names are translated on the client (`items.<kind>`,
// `recipes.<id>`); the English `name` fields are fallbacks for server text and tests.

import { CHEAP_ASSEMBLY_SEC, RAFT_REQ_SLOTS, RAFT_STAGES, TICK_RATE } from "./constants.js";
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
  /** Counts toward the raft's provisions stage (cooked food / water barrels; RAFT_STAGES[5]). */
  provision: "food" | "water" | null;
  /** Heavy cargo (log, barrel): slows the carrier unless escorted; one at a time. */
  heavy: boolean;
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
  heavy: false,
} as const;

export const ITEMS: Readonly<Record<ItemKind, ItemDef>> = {
  wood: { ...base, kind: "wood", name: "Wood", icon: "🪵", category: "material", stack: 5, throwable: true, radius: 0.2, restitution: 0.2 },
  rope: { ...base, kind: "rope", name: "Rope", icon: "🧵", category: "material", stack: 5, radius: 0.16, restitution: 0.15 },
  /** Flies flat, doesn't bounce (§11). */
  stone: { ...base, kind: "stone", name: "Stone", icon: "🪨", category: "material", stack: 3, throwable: true, damage: 1, radius: 0.15, gravityScale: 0.8, restitution: 0.1, maxBounces: 0 },
  /** Food + water + ammo; bounces twice; knocks coconuts off palms it hits (§11). */
  coconut: { ...base, kind: "coconut", name: "Coconut", icon: "🥥", category: "food", stack: 3, throwable: true, damage: 1, radius: 0.2, restitution: 0.55, maxBounces: 2, food: 20, water: 20 },
  /** Thrown fish = bait (§10). */
  fish_raw: { ...base, kind: "fish_raw", name: "Raw fish", icon: "🐟", category: "food", stack: 3, throwable: true, radius: 0.2, restitution: 0.2, food: 20 },
  fish_cooked: { ...base, kind: "fish_cooked", name: "Cooked fish", icon: "🍢", category: "food", stack: 3, radius: 0.2, food: 45, provision: "food" },
  crab_raw: { ...base, kind: "crab_raw", name: "Raw crab", icon: "🦀", category: "food", stack: 2, radius: 0.25, food: 10, provision: null },
  crab_cooked: { ...base, kind: "crab_cooked", name: "Cooked crab", icon: "🍤", category: "food", stack: 2, radius: 0.25, food: 50, provision: "food" },
  fish_golden: { ...base, kind: "fish_golden", name: "Golden fish", icon: "🐠", category: "food", stack: 1, radius: 0.22, food: 100, water: 50, provision: "food" },
  water: { ...base, kind: "water", name: "Water gourd", icon: "💧", category: "water", stack: 3, radius: 0.2, water: 50 },
  /** Sticks where it lands; E picks it back up; longest range (§11). */
  spear: { ...base, kind: "spear", name: "Spear", icon: "🔱", category: "tool", stack: 1, throwable: true, damage: 2, radius: 0.14, gravityScale: 0.85, restitution: 0.1, maxBounces: 0, sticks: true },
  rod: { ...base, kind: "rod", name: "Fishing rod", icon: "🎣", category: "tool", stack: 1, radius: 0.2 },
  /** LMB swings it (scares crabs); Q plants it (fixed light); burns TORCH_BURN_TICKS while active. */
  torch: { ...base, kind: "torch", name: "Torch", icon: "🔥", category: "tool", stack: 1, radius: 0.18, lightRadius: 4 },
  axe: { ...base, kind: "axe", name: "Axe", icon: "🪓", category: "tool", stack: 1, radius: 0.2 },
  /** The Plank (kind kept from the old raft part): 3 sawn from a log at the workbench; deck, rudder, repairs. */
  raft_part: { ...base, kind: "raft_part", name: "Plank", icon: "🛶", category: "material", stack: 5, throwable: true, radius: 0.35, restitution: 0.1, maxBounces: 1 },
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
  /** Heavy: the last unit of a tree felled with an axe drops one at its foot. Keel, mast, planks. */
  log: { ...base, kind: "log", name: "Log", icon: "🪵", category: "material", stack: 1, radius: 0.35, restitution: 0.1, maxBounces: 1, heavy: true },
  /** Woven from rope at the workbench (or 2 from the old-sail treasure). */
  cloth: { ...base, kind: "cloth", name: "Sailcloth", icon: "🧶", category: "material", stack: 3, radius: 0.16, restitution: 0.15 },
  /** Salvaged from the wreck with a hammer, or fished up. */
  scrap: { ...base, kind: "scrap", name: "Scrap metal", icon: "🔩", category: "material", stack: 3, radius: 0.15, restitution: 0.1, maxBounces: 0 },
  /** Forged at the anvil. */
  nails: { ...base, kind: "nails", name: "Nails", icon: "📌", category: "material", stack: 6, radius: 0.1, restitution: 0.1, maxBounces: 0 },
  /** Heavy: a water barrel for the provisions stage. */
  barrel: { ...base, kind: "barrel", name: "Water barrel", icon: "🛢️", category: "raft", stack: 1, radius: 0.35, restitution: 0.1, maxBounces: 1, provision: "water", heavy: true },
  /** Captain Crab's drop, needed for the rudder. Never lost: it goes back to the team chest. */
  compass: { ...base, kind: "compass", name: "Compass", icon: "🧭", category: "raft", stack: 1, radius: 0.15, restitution: 0.2 },
  /** Assembles the raft at full speed, repairs it, salvages the wreck (any slot). */
  hammer: { ...base, kind: "hammer", name: "Hammer", icon: "🔨", category: "tool", stack: 1, radius: 0.2 },
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
export function isHeavy(kind: InvKind): boolean {
  return kind !== "" && ITEMS[kind].heavy;
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
  /**
   * "fuel": campfire +FIRE_WOOD_FUEL_TICKS; "team": cooked kraken feeds everyone; "bench": raises team.benchTier
   * to `tier` (the workbench / the anvil).
   */
  effect: "item" | "fuel" | "team" | "bench";
  /** Needs team.ballRecipe (unlocked by a bottle). */
  locked: boolean;
  /** Ada Savaşı only. */
  duelOnly: boolean;
  /** Camp bench tier it needs (team.benchTier ≥ bench): 0 the bare campfire, 1 the workbench, 2 the anvil. */
  bench: 0 | 1 | 2;
  /** Craftable from this day on (1 = always). */
  minDay: number;
  /** effect "bench": the tier it builds (0 otherwise). */
  tier: number;
}

const recipe = (r: Omit<RecipeDef, "outCount" | "effect" | "locked" | "duelOnly" | "bench" | "minDay" | "tier"> & Partial<RecipeDef>): RecipeDef => ({
  outCount: 1,
  effect: "item",
  locked: false,
  duelOnly: false,
  bench: 0,
  minDay: 1,
  tier: 0,
  ...r,
});

/** Campfire workbench (§7, Long Tide §4.3), in panel order. */
export const RECIPES: Readonly<Record<RecipeId, RecipeDef>> = {
  fuel: recipe({ id: "fuel", name: "Feed the fire", cost: { wood: 1 }, out: null, effect: "fuel" }),
  bench_1: recipe({ id: "bench_1", name: "Build workbench", cost: { wood: 6, rope: 2, stone: 2 }, out: null, effect: "bench", tier: 1 }),
  axe: recipe({ id: "axe", name: "Axe", cost: { wood: 1, stone: 2, rope: 1 }, out: "axe" }),
  hammer: recipe({ id: "hammer", name: "Hammer", cost: { wood: 2, stone: 2, rope: 1 }, out: "hammer", bench: 1 }),
  raft_part: recipe({ id: "raft_part", name: "Saw planks", cost: { log: 1 }, out: "raft_part", outCount: 3, bench: 1 }),
  cloth: recipe({ id: "cloth", name: "Weave sailcloth", cost: { rope: 3 }, out: "cloth", bench: 1 }),
  barrel: recipe({ id: "barrel", name: "Fill water barrel", cost: { raft_part: 2, rope: 1, water: 2 }, out: "barrel", bench: 1 }),
  bench_2: recipe({ id: "bench_2", name: "Build anvil", cost: { raft_part: 3, stone: 4, scrap: 2 }, out: null, effect: "bench", tier: 2, bench: 1, minDay: 3 }),
  nails: recipe({ id: "nails", name: "Forge nails", cost: { scrap: 1, stone: 1 }, out: "nails", outCount: 3, bench: 2 }),
  spear: recipe({ id: "spear", name: "Spear", cost: { wood: 1, stone: 1 }, out: "spear" }),
  rod: recipe({ id: "rod", name: "Fishing rod", cost: { wood: 2, rope: 1 }, out: "rod" }),
  torch: recipe({ id: "torch", name: "Torch", cost: { wood: 1, rope: 1 }, out: "torch" }),
  collector: recipe({ id: "collector", name: "Water collector", cost: { raft_part: 1, rope: 1 }, out: "collector", bench: 1 }),
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

/** Cooking recipes (Şef: CharacterDef.cookOut cooked per raw). */
export function isCookRecipe(id: RecipeId): boolean {
  return id === "cook_fish" || id === "cook_crab";
}

/** A processed craft (MVP_POINTS.craftProcessed): anything that needs a bench, and the benches themselves. */
export function isProcessedRecipe(r: RecipeDef): boolean {
  return r.bench > 0 || r.effect === "bench";
}

/* ============================================================ raft cost */

/** Clamp a seat count to the raft table's 2..6. */
export function raftSeatsClamp(seats: number): number {
  return Math.max(2, Math.min(6, Math.round(seats)));
}

/**
 * Units each requirement slot of raft stage `stage` needs (length RAFT_REQ_SLOTS, 0 for unused slots and for the
 * launch stage): RAFT_STAGES[stage].req[i].bySeats for `seats` (clamped 2..6) × `costMult` (the difficulty
 * raftCostMult) rounded up, never below 1; a 1 stays 1 (one mast log, one compass). `cheap` (RAFT_TEST fast) = 1.
 */
export function raftStageNeeds(stage: number, seats: number, costMult = 1, cheap = false): number[] {
  const out: number[] = [];
  for (let i = 0; i < RAFT_REQ_SLOTS; i++) out.push(0);
  const def = RAFT_STAGES[stage];
  if (!def) return out;
  const s = raftSeatsClamp(seats);
  def.req.forEach((r, i) => {
    const base = r.bySeats[s - 2] ?? r.bySeats[r.bySeats.length - 1]!;
    out[i] = cheap ? 1 : base <= 1 ? base : Math.max(1, Math.ceil(base * costMult - 1e-9));
  });
  return out;
}

/** Assembly work (work ticks) raft stage `stage` needs: assemblySec × TICK_RATE (cheap: CHEAP_ASSEMBLY_SEC). 0 past the last stage. */
export function raftAssemblyTicks(stage: number, cheap = false): number {
  const def = RAFT_STAGES[stage];
  if (!def) return 0;
  return Math.round((cheap ? CHEAP_ASSEMBLY_SEC : def.assemblySec) * TICK_RATE);
}

/* ============================================================ fish loot */

export interface LootEntry<T extends string> {
  id: T;
  weight: number;
}

/** §8 base weights (sum 96; Long Tide: boot 10 → 4, scrap 6). Biome multipliers in BIOMES[b].loot; the server shuffles per match seed. */
export const FISH_LOOT: ReadonlyArray<LootEntry<FishLoot>> = [
  { id: "fish", weight: 45 },
  { id: "crab", weight: 12 },
  { id: "boot", weight: 4 },
  { id: "scrap", weight: 6 },
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
  scrap: "scrap",
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
