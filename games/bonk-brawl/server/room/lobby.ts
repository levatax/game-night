// Pure lobby rules: join option validation, nicknames, slots, host migration, message parsing.
// Everything here takes untrusted client payloads as `unknown` and never throws.

import {
  CHARACTER_IDS,
  DEFAULT_CHARACTER,
  EMOTE_IDS,
  MAP_IDS,
  MAX_PLAYERS,
  NICKNAME_MAX,
  NICKNAME_MIN,
  ROUND_OPTIONS,
} from "../../shared/constants.js";
import { JOIN_ERROR, JOIN_ERROR_TEXT } from "../../shared/protocol.js";
import type { CharacterId, EmoteId, MapChoice, MapId, SettingsView } from "../../shared/types.js";

/** Control, format and line/paragraph separator characters never belong in a nickname. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === "string" && (CHARACTER_IDS as ReadonlyArray<string>).includes(value);
}

export function isEmoteId(value: unknown): value is EmoteId {
  return typeof value === "string" && (EMOTE_IDS as ReadonlyArray<string>).includes(value);
}

export function isMapChoice(value: unknown): value is MapChoice {
  return value === "random" || (typeof value === "string" && (MAP_IDS as ReadonlyArray<string>).includes(value));
}

/**
 * Clean a nickname: whitespace collapsed, invisible characters removed, trimmed, capped at
 * NICKNAME_MAX characters (code points, so emoji are never split). "" when nothing is left.
 */
export function sanitizeNickname(raw: string): string {
  const cleaned = raw.replace(/\s+/g, " ").replace(INVISIBLE, "").trim();
  return Array.from(cleaned).slice(0, NICKNAME_MAX).join("").trim();
}

/** Name used when a player joins without a usable nickname. */
export function fallbackNickname(slot: number): string {
  return `Player ${slot + 1}`;
}

/**
 * `name`, or `name 2`, `name 3`, … (shortened to fit NICKNAME_MAX) when another player already uses
 * it (case-insensitive).
 */
export function uniqueNickname(name: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const base = Array.from(name).slice(0, NICKNAME_MAX - suffix.length).join("").trimEnd();
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export type JoinCheck =
  | { ok: true; nickname: string; character: CharacterId | null }
  | { ok: false; code: number; message: string };

function reject(code: number): JoinCheck {
  return { ok: false, code, message: JOIN_ERROR_TEXT[code] ?? "Can't join" };
}

/**
 * Validate create/join options. A missing nickname (or one with nothing printable left) is
 * allowed: the room gives a fallback name (nickname ""). A non-string nickname is rejected
 * (BAD_NICKNAME). A missing character is allowed (character null: the room picks one); any other
 * value must be a CharacterId (else BAD_CHARACTER).
 */
export function checkJoinOptions(options: unknown): JoinCheck {
  const opts = typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  const rawName = opts.nickname;
  if (rawName !== undefined && rawName !== null && typeof rawName !== "string") return reject(JOIN_ERROR.BAD_NICKNAME);
  const nickname = typeof rawName === "string" ? sanitizeNickname(rawName) : "";
  if (nickname.length > 0 && Array.from(nickname).length < NICKNAME_MIN) return reject(JOIN_ERROR.BAD_NICKNAME);
  const rawCharacter = opts.character;
  if (rawCharacter === undefined || rawCharacter === null) return { ok: true, nickname, character: null };
  if (!isCharacterId(rawCharacter)) return reject(JOIN_ERROR.BAD_CHARACTER);
  return { ok: true, nickname, character: rawCharacter };
}

/** First character nobody in the room uses yet (variety for joiners who didn't pick one). */
export function firstFreeCharacter(used: Iterable<CharacterId>): CharacterId {
  const taken = new Set(used);
  return CHARACTER_IDS.find((c) => !taken.has(c)) ?? DEFAULT_CHARACTER;
}

/** Lowest slot 0..MAX_PLAYERS-1 not in `used`, or -1 when the room is full. */
export function lowestFreeSlot(used: Iterable<number>): number {
  const taken = new Set(used);
  for (let slot = 0; slot < MAX_PLAYERS; slot++) if (!taken.has(slot)) return slot;
  return -1;
}

/**
 * Next host in join order: the earliest-joined remaining player that is connected, else the
 * earliest-joined remaining one at all, else "".
 */
export function nextHost(joinOrder: readonly string[], isConnected: (id: string) => boolean | undefined): string {
  const connected = joinOrder.find((id) => isConnected(id) === true);
  return connected ?? joinOrder[0] ?? "";
}

/** The valid fields of a host settings patch (invalid or unknown fields are dropped). */
export function parseSettingsPatch(msg: unknown): Partial<SettingsView> {
  if (typeof msg !== "object" || msg === null) return {};
  const raw = msg as Record<string, unknown>;
  const patch: Partial<SettingsView> = {};
  if (isMapChoice(raw.map)) patch.map = raw.map;
  if (typeof raw.rounds === "number" && ROUND_OPTIONS.includes(raw.rounds)) patch.rounds = raw.rounds;
  if (typeof raw.powerUps === "boolean") patch.powerUps = raw.powerUps;
  return patch;
}

/** A boolean field of an untrusted message, or null when absent/invalid. */
export function readBoolean(msg: unknown, key: string): boolean | null {
  if (typeof msg !== "object" || msg === null) return null;
  const value = (msg as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}

/** A field of an untrusted message, or undefined. */
export function readField(msg: unknown, key: string): unknown {
  if (typeof msg !== "object" || msg === null) return undefined;
  return (msg as Record<string, unknown>)[key];
}

/** Map for a round: a fixed choice as is; "random" → any map except the previous one. */
export function resolveMap(choice: MapChoice, previous: MapId, random: () => number): MapId {
  if (choice !== "random") return choice;
  const options = MAP_IDS.filter((id) => id !== previous);
  return options[Math.min(options.length - 1, Math.floor(random() * options.length))];
}
