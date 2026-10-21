// Tiny i18n: t("section.key", { name }) with {param} interpolation, English fallback. Owner: architect (complete).
//
// Strings live in ./strings/<section>.ts, one file per area, each exporting
//   export const en = { key: "Text with {name}" };
//   export const tr: Record<keyof typeof en, string> = { key: "{name} ile metin" };
// (the Record type makes the compiler insist every English key has a Turkish one — §1: every string in both).
// Keys are namespaced by section: t("menu.createRoom"). Missing keys fall back to English, then to the key.
//
// Section owners: server.ts → server-room (must mirror server/room/text.ts, test-enforced); feed.ts, banner.ts,
// prompt.ts → client-app (it composes those lines); every other section → client-ui.
//
// The language is read once at boot from settings; setLanguage() saves it and reloads the page (the room is
// rejoined automatically through the reconnect token), so no module needs to re-render live.

import { settings, type Lang } from "../app/settings";
import type {
  Biome,
  BottleEffect,
  CharacterId,
  Difficulty,
  FishLoot,
  InvKind,
  RecipeId,
  TitleId,
  TreasureId,
  Weather,
} from "../../../shared/types";
import * as banner from "./strings/banner";
import * as characters from "./strings/characters";
import * as coach from "./strings/coach";
import * as feed from "./strings/feed";
import * as hud from "./strings/hud";
import * as items from "./strings/items";
import * as menu from "./strings/menu";
import * as overlays from "./strings/overlays";
import * as panels from "./strings/panels";
import * as prompt from "./strings/prompt";
import * as reject from "./strings/reject";
import * as server from "./strings/server";

type Dict = Record<string, string>;
const SECTIONS: Record<string, { en: Dict; tr: Dict }> = {
  banner,
  characters,
  coach,
  feed,
  hud,
  items,
  menu,
  overlays,
  panels,
  prompt,
  reject,
  server,
};

export type Params = Record<string, string | number>;

export const LANGS: { id: Lang; label: string; flag: string }[] = [
  { id: "en", label: "English", flag: "🇬🇧" },
  { id: "tr", label: "Türkçe", flag: "🇹🇷" },
];

let current: Lang = settings.get().language;
try {
  document.documentElement.lang = current;
} catch {
  /* no DOM (tests) */
}

export function lang(): Lang {
  return current;
}

/** Locale for Intl / toLocaleString. */
export function locale(): string {
  return current === "tr" ? "tr-TR" : "en-US";
}

/** Translate "section.key". Params replace {name} placeholders. */
export function t(key: string, params?: Params): string {
  const dot = key.indexOf(".");
  const section = SECTIONS[key.slice(0, dot)];
  const k = key.slice(dot + 1);
  const raw = section?.[current]?.[k] ?? section?.en?.[k] ?? key;
  return params ? interpolate(raw, params) : raw;
}

/** True when a key exists (in English). */
export function has(key: string): boolean {
  const dot = key.indexOf(".");
  return SECTIONS[key.slice(0, dot)]?.en?.[key.slice(dot + 1)] !== undefined;
}

export function interpolate(raw: string, params: Params): string {
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Locale-aware upper case (Turkish dotted İ). */
export function upper(s: string): string {
  return s.toLocaleUpperCase(locale());
}

/** mm:ss for a seconds count (never negative). */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* Content names. Keys: items.<kind>, items.recipe_<id>, items.loot_<id>, items.treasure_<id>, items.bottle_<effect>,
   items.biome_<id>, items.weather_<id>, items.difficulty_<id>, characters.<id>, overlays.title_<id>. */

export function itemName(kind: InvKind | "berry"): string {
  return kind === "" ? "" : t(`items.${kind}`);
}
export function recipeName(id: RecipeId): string {
  return t(`items.recipe_${id}`);
}
export function lootName(id: FishLoot): string {
  return t(`items.loot_${id}`);
}
export function treasureName(id: TreasureId): string {
  return t(`items.treasure_${id}`);
}
export function bottleText(effect: BottleEffect): string {
  return t(`items.bottle_${effect}`);
}
export function biomeName(id: Biome): string {
  return t(`items.biome_${id}`);
}
export function weatherName(id: Weather): string {
  return t(`items.weather_${id}`);
}
export function difficultyName(id: Difficulty): string {
  return t(`items.difficulty_${id}`);
}
export function characterName(id: CharacterId): string {
  return t(`characters.${id}`);
}
export function titleName(id: TitleId): string {
  return t(`overlays.title_${id}`);
}

/** Save + reload (the page rejoins the room via the reconnect token). */
export function setLanguage(next: Lang): void {
  if (next === current) return;
  settings.set({ language: next });
  location.reload();
}
