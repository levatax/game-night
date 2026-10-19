// Tiny i18n: t("section.key", { name }) with {param} interpolation, English fallback. Complete.
//
// Strings live in ./strings/<section>.ts, one file per UI area, each exporting
//   export const en = { key: "Text with {name}" };
//   export const tr: Record<keyof typeof en, string> = { key: "{name} ile metin" };
// (the Record type makes the compiler insist every English key has a Turkish one).
// Keys are namespaced by section: t("menu.createRoom"). Missing keys fall back to English, then the key.
//
// The language is read once at boot from settings; setLanguage() saves it and reloads the page (the room
// is rejoined automatically through the reconnect token), so no module needs to re-render live.

import { settings, type Lang } from "../app/settings";
import type { CardId, PieceType } from "../../../shared/constants";
import { CARD_BY_ID, PIECES } from "../../../shared/constants";
import * as content from "./strings/content";
import * as game from "./strings/game";
import * as hud from "./strings/hud";
import * as menu from "./strings/menu";
import * as overlays from "./strings/overlays";
import * as reel from "./strings/reel";
import * as scene from "./strings/scene";
import * as server from "./strings/server";

type Dict = Record<string, string>;
const SECTIONS: Record<string, { en: Dict; tr: Dict }> = { content, game, hud, menu, overlays, reel, scene, server };

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

export function cardName(id: CardId | string): string {
  const k = `content.card_${id}_name`;
  return has(k) ? t(k) : (CARD_BY_ID[id as CardId]?.name ?? id);
}
export function cardText(id: CardId | string): string {
  const k = `content.card_${id}_text`;
  return has(k) ? t(k) : (CARD_BY_ID[id as CardId]?.text ?? "");
}
export function pieceName(type: PieceType | string): string {
  const k = `content.piece_${type}_name`;
  return has(k) ? t(k) : (PIECES[type as PieceType]?.name ?? type);
}
export function pieceQuip(type: PieceType | string): string {
  const k = `content.piece_${type}_quip`;
  return has(k) ? t(k) : (PIECES[type as PieceType]?.quip ?? "");
}
export function rarityName(r: string): string {
  return t(`content.rarity_${r}`);
}

/** Save + reload (the page rejoins the room via the reconnect token). */
export function setLanguage(next: Lang): void {
  if (next === current) return;
  settings.set({ language: next });
  location.reload();
}
