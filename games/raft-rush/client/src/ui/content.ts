// Display data for game content (icons, rarities, colors) shared by the HUD, panels and reels. Owner: client-ui.
// Pure lookups over the frozen tables in shared/: no DOM, no state.

import { CHARACTERS, EMOTES, PALETTE } from "../../../shared/constants";
import { ITEMS, FISH_LOOT_ITEM } from "../../../shared/items";
import type { CharacterId, EmoteId, FishLoot, InvKind, MarkerKind, TreasureId } from "../../../shared/types";

/** Reel rarity tiers (junk → mythic): drive card colors, rays and quips. */
export type Rarity = "junk" | "common" | "uncommon" | "rare" | "epic" | "legendary" | "mythic";

export const RARITY_COLORS: Readonly<Record<Rarity, string>> = {
  junk: "#A8A29E",
  common: "#8ED1FC",
  uncommon: "#7CCB6B",
  rare: "#3FA7F5",
  epic: "#A86CF0",
  legendary: "#FFD166",
  mythic: "#FF4D3A",
};

/** Higher = shinier (tease detection: a shinier neighbor next to the winner). */
export const RARITY_RANK: Readonly<Record<Rarity, number>> = { junk: 0, common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, mythic: 6 };

export const LOOT_RARITY: Readonly<Record<FishLoot, Rarity>> = {
  boot: "junk",
  jellyfish: "junk",
  fish: "common",
  crab: "common",
  puffer: "uncommon",
  bottle: "rare",
  treasure: "epic",
  golden: "legendary",
  kraken: "mythic",
};

export const TREASURE_RARITY: Readonly<Record<TreasureId, Rarity>> = {
  pirate_hat: "rare",
  spyglass: "rare",
  fuel_can: "rare",
  flare: "epic",
  old_sail: "legendary",
};

const LOOT_EMOJI: Readonly<Record<FishLoot, string>> = {
  fish: "🐟",
  crab: "🦀",
  boot: "🥾",
  jellyfish: "🪼",
  puffer: "🐡",
  bottle: "🍾",
  treasure: "🧰",
  golden: "🐠",
  kraken: "🦑",
};

export const TREASURE_ICON: Readonly<Record<TreasureId, string>> = {
  flare: "🎇",
  old_sail: "⛵",
  pirate_hat: "🏴‍☠️",
  spyglass: "🔭",
  fuel_can: "🛢️",
};

export function lootIcon(id: FishLoot): string {
  const item = FISH_LOOT_ITEM[id];
  return item ? ITEMS[item].icon : LOOT_EMOJI[id];
}

/** HUD emoji for an inventory kind (and berries, which are eaten on the spot). */
export function itemIcon(kind: InvKind | "berry"): string {
  if (kind === "") return "";
  if (kind === "berry") return "🫐";
  return ITEMS[kind].icon;
}

export const MARKER_ICON: Readonly<Record<MarkerKind, string>> = { here: "📍", help: "🆘", need: "🙏", danger: "⚠️" };
export const MARKER_COLOR: Readonly<Record<MarkerKind, string>> = { here: "#3FA7F5", help: "#FF5A5F", need: "#FFD166", danger: "#FF4D3A" };

export function emoteIcon(id: EmoteId): string {
  return EMOTES[id].icon;
}

/** Outfit color of a tourist (portrait backgrounds, tourist cards). */
export function characterColor(id: CharacterId): string {
  return CHARACTERS[id].colors.outfit;
}
export function characterAccent(id: CharacterId): string {
  return CHARACTERS[id].colors.accent;
}

/** Bar colors (icons always sit next to them, §17). */
export const BAR_COLORS = {
  hp: "#FF5A5F",
  hunger: "#A8D86E",
  thirst: PALETTE.sea,
  warmth: PALETTE.fire,
} as const;

export const BIOME_ICON = { tropic: "🌴", rocky: "🪨", swamp: "🐸", volcanic: "🌋" } as const;
export const WEATHER_ICON = { clear: "☀️", rain: "🌧️", fog: "🌫️", heatwave: "🥵", fullmoon: "🌕" } as const;
export const DIFFICULTY_ICON = { vacation: "🏖️", normal: "🏝️", nightmare: "🌋" } as const;

export type PingLevel = "good" | "ok" | "bad";

/** Connection quality bucket for a round-trip time in ms. */
export function pingLevel(ms: number): PingLevel {
  if (ms < 90) return "good";
  if (ms < 160) return "ok";
  return "bad";
}
