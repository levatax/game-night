// Pure lobby rules for RaftRoom. Owner: server-room.
//
// Join option validation (incl. the client's PROTOCOL_VERSION), nicknames, seats, characters, host migration, host
// settings, lobby helper-bot identities (names / roles; the character → role table for a bot driving a human's
// seat is room/bots.ts roleForCharacter), and the defensive parsing of every client message payload. Everything
// takes untrusted payloads as `unknown`, never throws, and returns null / {} / defaults for anything malformed.

import {
  BOT_NAMES,
  BOT_ROLES,
  CHARACTER_IDS,
  DEFAULT_CHARACTER,
  DIFFICULTY_IDS,
  EMOTE_IDS,
  MARKER_KINDS,
  MAX_PLAYERS,
  NICKNAME_MAX,
  NICKNAME_MIN,
  PITCH_LIMIT,
  SEED_MAX,
} from "../../shared/constants.js";
import { isItemKind, isRecipeId } from "../../shared/items.js";
import { BUTTON_MASK, JOIN_ERROR, JOIN_ERROR_TEXT, PROTOCOL_VERSION } from "../../shared/protocol.js";
import type { ChestMsg, InputCmd, MarkerMsg } from "../../shared/protocol.js";
import { SLOTS } from "../../shared/rules/inventory.js";
import type { BotRole, CharacterId, Difficulty, EmoteId, ItemKind, MarkerKind, RecipeId, SettingsView, Vec3Like } from "../../shared/types.js";

/**
 * Control, format and line/paragraph separator characters never belong in a nickname, except the joiners inside
 * an emoji sequence: a ZWJ between two pictographs (👨‍👩‍👧, 🏳️‍🌈, 👩🏽‍💻; group 1) and the tag run of a subdivision
 * flag (🏴 + tag letters + cancel tag; group 2). Everything else this matches is dropped.
 */
const INVISIBLE =
  /(\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?\u200D(?=\p{Extended_Pictographic}))|(\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Combining marks kept per base character. All of \p{M} counts (not only Mn): enclosing marks (Me, e.g. U+20DD /
 * U+0489) and spacing marks (Mc) stack into the same "Zalgo" towers, while real text needs at most two of any
 * kind on one letter: Vietnamese vowel + tone (ệ decomposed = e + U+0323 + U+0302), Thai vowel + tone, a
 * Devanagari vowel sign + nasal, an emoji keycap (1 + U+FE0F + U+20E3). Decomposed Turkish letters carry one (Ş, ğ, ü).
 */
export const MAX_MARKS_PER_BASE = 2;
/** A base character followed by more than MAX_MARKS_PER_BASE marks (group 1 = the base and the marks kept). */
const MARK_PILE = new RegExp(`(\\P{M}\\p{M}{${MAX_MARKS_PER_BASE}})\\p{M}+`, "gu");
/** Marks with no base character in front of them (at the very start). */
const LEADING_MARKS = /^\p{M}+/u;

function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, (_m: string, zwj: string | undefined, tags: string | undefined) => zwj ?? tags ?? "");
}

/* ============================================================ type guards */

export function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === "string" && (CHARACTER_IDS as ReadonlyArray<string>).includes(value);
}

export function isEmoteId(value: unknown): value is EmoteId {
  return typeof value === "string" && (EMOTE_IDS as ReadonlyArray<string>).includes(value);
}

export function isMarkerKind(value: unknown): value is MarkerKind {
  return typeof value === "string" && (MARKER_KINDS as ReadonlyArray<string>).includes(value);
}

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === "string" && (DIFFICULTY_IDS as ReadonlyArray<string>).includes(value);
}

/* ============================================================== nicknames */

/**
 * Clean a nickname: invisible characters removed (emoji sequence joiners kept), whitespace collapsed, trimmed, at
 * most MAX_MARKS_PER_BASE combining marks per character (no Zalgo towers over everyone's HUD; marks with nothing
 * in front dropped), capped at NICKNAME_MAX characters (code points, so a single emoji is never split; a ZWJ
 * sequence the cap cuts loses its dangling joiner). Text is kept as typed (no Unicode normalization: nicknameKey
 * compares composed forms). "" when nothing is left.
 */
export function sanitizeNickname(raw: string): string {
  const cleaned = stripInvisible(raw).replace(/\s+/g, " ").trim().replace(LEADING_MARKS, "").replace(MARK_PILE, "$1");
  return stripInvisible(Array.from(cleaned).slice(0, NICKNAME_MAX).join("")).trim();
}

/**
 * Names for players who join without a usable nickname. A nickname is shown as is to every client, so these are
 * beachy words that read the same in Turkish and English (uniqueNickname adds " 2" on a clash).
 */
export const FALLBACK_NICKNAMES: ReadonlyArray<string> = ["Mango", "Papaya", "Kiwi", "Coco", "Tiki", "Aloha"];

/** Name used when a player joins without a usable nickname (by seat: "Mango", "Papaya", …). */
export function fallbackNickname(seat: number): string {
  const n = FALLBACK_NICKNAMES.length;
  return FALLBACK_NICKNAMES[((seat % n) + n) % n] ?? "Mango";
}

/**
 * Case-insensitive comparison key that treats Turkish dotted / dotless i alike ("İsmail" = "ismail", "Ian" = "ıan")
 * and composed / decomposed letters alike (NFC: "Şükrü" typed either way is the same name).
 */
export function nicknameKey(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase("tr").replace(/\u0131/g, "i").replace(/i\u0307/g, "i");
}

/**
 * `name`, or `name 2`, `name 3`, … (shortened to fit NICKNAME_MAX) when another player already uses it
 * (case-insensitive, Turkish-aware).
 */
export function uniqueNickname(name: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, nicknameKey));
  if (!used.has(nicknameKey(name))) return name;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` ${n}`;
    const base = Array.from(name).slice(0, NICKNAME_MAX - suffix.length).join("").trimEnd();
    const candidate = `${base}${suffix}`;
    if (!used.has(nicknameKey(candidate))) return candidate;
  }
  return name;
}

/* ============================================================ join checks */

export type JoinCheck =
  | { ok: true; nickname: string; character: CharacterId | null }
  | { ok: false; code: number; message: string };

function rejectJoin(code: number): JoinCheck {
  return { ok: false, code, message: JOIN_ERROR_TEXT[code] ?? "Can't join" };
}

/**
 * Validate create / join options. A `protocol` other than PROTOCOL_VERSION → OUTDATED (checked first; absent =
 * a client from before versioning, accepted). A missing nickname (or one with nothing printable left) is allowed:
 * the room gives a fallback name (nickname ""). A non-string nickname → BAD_NICKNAME. A missing character is
 * allowed (character null: the room picks the first unused one); any other value must be a CharacterId
 * (BAD_CHARACTER).
 */
export function checkJoinOptions(options: unknown): JoinCheck {
  const opts = typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  const protocol = opts.protocol;
  if (protocol !== undefined && protocol !== null && protocol !== PROTOCOL_VERSION) return rejectJoin(JOIN_ERROR.OUTDATED);
  const rawName = opts.nickname;
  if (rawName !== undefined && rawName !== null && typeof rawName !== "string") return rejectJoin(JOIN_ERROR.BAD_NICKNAME);
  const nickname = typeof rawName === "string" ? sanitizeNickname(rawName) : "";
  if (nickname.length > 0 && Array.from(nickname).length < NICKNAME_MIN) return rejectJoin(JOIN_ERROR.BAD_NICKNAME);
  const rawCharacter = opts.character;
  if (rawCharacter === undefined || rawCharacter === null) return { ok: true, nickname, character: null };
  if (!isCharacterId(rawCharacter)) return rejectJoin(JOIN_ERROR.BAD_CHARACTER);
  return { ok: true, nickname, character: rawCharacter };
}

/** The ROOM_FULL rejection (MAX_PLAYERS seats, bots and spectators included). */
export function roomFullError(): { code: number; message: string } {
  return { code: JOIN_ERROR.ROOM_FULL, message: JOIN_ERROR_TEXT[JOIN_ERROR.ROOM_FULL] ?? "Room full" };
}

/* ======================================================= seats & characters */

/** First character nobody in the room uses yet (variety for joiners and bots), else the default. */
export function firstFreeCharacter(used: Iterable<CharacterId>): CharacterId {
  const taken = new Set(used);
  return CHARACTER_IDS.find((c) => !taken.has(c)) ?? DEFAULT_CHARACTER;
}

/** Lowest seat 0..MAX_PLAYERS-1 not in `used`, or -1 when the room is full. */
export function lowestFreeSeat(used: Iterable<number>): number {
  const taken = new Set(used);
  for (let seat = 0; seat < MAX_PLAYERS; seat++) if (!taken.has(seat)) return seat;
  return -1;
}

/** Raft seats for a match: players incl. bots, clamped to the RAFT_COSTS table (2..MAX_PLAYERS). */
export function raftSeats(participants: number): number {
  return Math.max(2, Math.min(MAX_PLAYERS, participants));
}

/* =================================================================== host */

export interface HostCandidate {
  id: string;
  connected: boolean;
  bot: boolean;
  spectator: boolean;
}

/**
 * Next host: the earliest-joined connected human other than `exceptId`, preferring non-spectators. "" when no
 * connected human is left (bots never host).
 */
export function nextHost(joinOrder: readonly HostCandidate[], exceptId: string): string {
  const humans = joinOrder.filter((p) => p.id !== exceptId && p.connected && !p.bot);
  return (humans.find((p) => !p.spectator) ?? humans[0])?.id ?? "";
}

/* =============================================================== settings */

export interface SettingsPatch {
  /** Valid fields to apply (mode is only ever "coop"). */
  patch: Partial<SettingsView>;
  /** The host asked for mode "duel" (Ada Savaşı is deferred): ignored with a notice. */
  duelRejected: boolean;
}

/** Parse a host settings patch: mode coop / duel (rejected), difficulty in DIFFICULTY_IDS, seed uint32 (0 = random). */
export function parseSettingsPatch(msg: unknown): SettingsPatch {
  const out: SettingsPatch = { patch: {}, duelRejected: false };
  if (typeof msg !== "object" || msg === null) return out;
  const raw = msg as Record<string, unknown>;
  if (raw.mode === "coop") out.patch.mode = "coop";
  else if (raw.mode === "duel") out.duelRejected = true;
  if (isDifficulty(raw.difficulty)) out.patch.difficulty = raw.difficulty;
  const seed = readSeed(raw.seed);
  if (seed !== null) out.patch.seed = seed;
  return out;
}

/** A seed field: an integer 0..SEED_MAX (a numeric string is accepted too), else null. */
export function readSeed(value: unknown): number | null {
  const n = typeof value === "string" && /^\s*\d{1,10}\s*$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > SEED_MAX) return null;
  return n >>> 0;
}

/* ================================================================== bots */

/** Lobby bot name: the first BOT_NAMES entry not taken (case-insensitive) and its index; else a numbered fallback. */
export function botIdentity(taken: Iterable<string>, botCount: number): { nickname: string; role: BotRole } {
  const names = Array.from(taken);
  const used = new Set(names.map(nicknameKey));
  const index = BOT_NAMES.findIndex((n) => !used.has(nicknameKey(n)));
  if (index >= 0) return { nickname: BOT_NAMES[index]!, role: botRoleAt(index) };
  return { nickname: uniqueNickname(BOT_NAMES[0] ?? "Bot", names), role: botRoleAt(botCount) };
}

/** BOT_ROLES by index (wrapping). */
export function botRoleAt(index: number): BotRole {
  const n = BOT_ROLES.length;
  return BOT_ROLES[((index % n) + n) % n] ?? "hamal";
}

/* ======================================================= message payloads */

/** A boolean field of an untrusted message, or null when absent / invalid. */
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

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clampNum(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * An InputCmd with sane types (the world clamps and validates again): seq a positive integer, move axes
 * clamped to [-1, 1], yaw / pitch finite (pitch clamped), buttons masked to BUTTON_MASK. Null when malformed.
 */
export function readInput(msg: unknown): InputCmd | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (!finite(m.seq) || !Number.isInteger(m.seq) || m.seq < 1 || m.seq > 0xffffffff) return null;
  if (!finite(m.moveX) || !finite(m.moveZ) || !finite(m.yaw) || !finite(m.pitch)) return null;
  if (!finite(m.buttons) || !Number.isInteger(m.buttons)) return null;
  return {
    seq: m.seq,
    moveX: clampNum(m.moveX, -1, 1),
    moveZ: clampNum(m.moveZ, -1, 1),
    yaw: m.yaw,
    pitch: clampNum(m.pitch, -PITCH_LIMIT, PITCH_LIMIT),
    buttons: m.buttons & BUTTON_MASK,
  };
}

/** CraftMsg.recipe, or null. */
export function readRecipe(msg: unknown): RecipeId | null {
  const recipe = readField(msg, "recipe");
  return isRecipeId(recipe) ? recipe : null;
}

/**
 * A ChestMsg with a valid op, optional item kind, optional positive integer count and (put only) optional pocket
 * `slot` 0..SLOTS-1; null when malformed. A `slot` on take / putAll is dropped.
 */
export function readChest(msg: unknown): ChestMsg | null {
  const op = readField(msg, "op");
  if (op !== "put" && op !== "take" && op !== "putAll") return null;
  const out: ChestMsg = { op };
  const kind = readField(msg, "kind");
  if (kind !== undefined && kind !== null) {
    if (!isItemKind(kind)) return null;
    out.kind = kind;
  }
  const count = readField(msg, "count");
  if (count !== undefined && count !== null) {
    if (!finite(count) || !Number.isInteger(count) || count < 1 || count > 999) return null;
    out.count = count;
  }
  const slot = readField(msg, "slot");
  if (slot !== undefined && slot !== null) {
    if (!finite(slot) || !Number.isInteger(slot) || slot < 0 || slot >= SLOTS) return null;
    if (op === "put") out.slot = slot;
  }
  if (op === "take" && out.kind === undefined) return null;
  return out;
}

/** Max distance of a ping from the pinging player (MarkerMsg doc: clamped to 60 m). */
export const MARKER_MAX_DIST = 60;

export interface MarkerBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * A MarkerMsg with a valid kind and a finite position, clamped to MARKER_MAX_DIST from `from` (the pinging
 * player's eye) and to the world bounds; `need` only for kind "need" (an ItemKind, else ""). Null when malformed.
 */
export function readMarker(msg: unknown, from: Vec3Like, bounds: MarkerBounds): (MarkerMsg & { need: ItemKind | "" }) | null {
  const kind = readField(msg, "kind");
  const pos = readField(msg, "pos");
  if (!isMarkerKind(kind) || typeof pos !== "object" || pos === null) return null;
  const p = pos as Record<string, unknown>;
  if (!finite(p.x) || !finite(p.y) || !finite(p.z)) return null;
  let dx = p.x - from.x;
  let dy = p.y - from.y;
  let dz = p.z - from.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d > MARKER_MAX_DIST) {
    const k = MARKER_MAX_DIST / d;
    dx *= k;
    dy *= k;
    dz *= k;
  }
  const rawNeed = readField(msg, "need");
  const need: ItemKind | "" = kind === "need" && isItemKind(rawNeed) ? rawNeed : "";
  return {
    kind,
    pos: {
      x: clampNum(from.x + dx, bounds.minX, bounds.maxX),
      y: clampNum(from.y + dy, -20, 40),
      z: clampNum(from.z + dz, bounds.minZ, bounds.maxZ),
    },
    need,
  };
}

/** EmoteMsg.emote, or null. */
export function readEmote(msg: unknown): EmoteId | null {
  const emote = readField(msg, "emote");
  return isEmoteId(emote) ? emote : null;
}
