// Nicknames and the silly NOTICE lines JellyRoom sends. Owner: server-room.

import { NICKNAME_MAX } from "../../shared/constants.js";
import type { NoticeMsg } from "../../shared/protocol.js";
import type { Rng } from "../rules.js";

/** Trim, strip control chars, collapse spaces, cut to NICKNAME_MAX. "" when nothing usable is left. */
export function cleanNickname(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g, "").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, NICKNAME_MAX).join("").trim();
}

/** Make `name` unique among `taken` by appending " 2", " 3"… (still within NICKNAME_MAX). */
export function uniqueNickname(name: string, taken: Set<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let n = 2; n < 100; n++) {
    const suffix = ` ${n}`;
    const base = Array.from(name).slice(0, NICKNAME_MAX - suffix.length).join("").trimEnd();
    const candidate = base + suffix;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

/**
 * English lines, keyed exactly like client/src/i18n/strings/server.ts (`en`), with {param} placeholders.
 * Random variants are numbered: joined1…joined4. Clients translate t(`server.${key}`, params).
 */
export const NOTICE_EN = {
  joined1: "🧑‍🍳 {n} waddled into the kitchen!",
  joined2: "🥄 {n} has entered the kitchen. Hide the good spatulas.",
  joined3: "🍰 {n} smells cake and shows up. Classic.",
  joined4: "🐔 {n} arrived with a rubber chicken. Nobody asked why.",
  spectating1: "🍿 {n} grabbed a stool and is watching the chaos.",
  spectating2: "👀 {n} is spectating. Next match they bake!",
  left1: "🚪 {n} dropped their spatula and left.",
  left2: "💨 {n} ran out of the kitchen screaming.",
  left3: "🥧 {n} has left the building (pie still warm).",
  reconnecting: "📡 {n} tripped over the power cord… reconnecting.",
  reconnected: "🔌 {n} plugged back in!",
  host: "👑 {n} is the head chef now.",
  fledTurn: "🏃 {n} fled mid-turn. Their piece goes back in the bag.",
  autoDrop: "⏰ Time's up! {n}'s piece slips out of their butter-soft fingers.",
  tooFew: "😢 Not enough chefs left in the kitchen. Straight to the podium!",
  saboteurFled: "🕵️ Someone left for good… the vote is off, but secrets will still be spilled.",
  cantStartFew: "🙅 Can't start yet: need at least {min} chefs (a tower needs an audience).",
  cantStartLazyOne: "🙅 Can't start yet: {names} is still tying their apron.",
  cantStartLazyMany: "🙅 Can't start yet: {names} are still tying their apron.",
  notReady: "🍳 Kitchen is still warming up, try again in a sec.",
  rematch: "🔁 Fresh cake! Back to the lobby.",
} as const;
export type NoticeKey = keyof typeof NOTICE_EN;

type Params = Record<string, string | number>;

function fill(raw: string, params: Params): string {
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** Build a NOTICE payload: English text + key + params. */
export function notice(key: NoticeKey, params: Params = {}): NoticeMsg {
  return { text: fill(NOTICE_EN[key], params), key, ...(Object.keys(params).length ? { params } : {}) };
}

/** Pick a random numbered variant: base "joined" with 4 variants → "joined1".."joined4". */
function variant(rng: Rng, base: string, count: number): NoticeKey {
  return `${base}${(Math.floor(rng() * count) % count) + 1}` as NoticeKey;
}

export const say = {
  joined: (rng: Rng, n: string) => notice(variant(rng, "joined", 4), { n }),
  spectating: (rng: Rng, n: string) => notice(variant(rng, "spectating", 2), { n }),
  left: (rng: Rng, n: string) => notice(variant(rng, "left", 3), { n }),
  reconnecting: (n: string) => notice("reconnecting", { n }),
  reconnected: (n: string) => notice("reconnected", { n }),
  host: (n: string) => notice("host", { n }),
  fledTurn: (n: string) => notice("fledTurn", { n }),
  autoDrop: (n: string) => notice("autoDrop", { n }),
  tooFew: () => notice("tooFew"),
  saboteurFled: () => notice("saboteurFled"),
  cantStartFew: (min: number) => notice("cantStartFew", { min }),
  cantStartLazy: (names: string[]) =>
    notice(names.length === 1 ? "cantStartLazyOne" : "cantStartLazyMany", { names: names.join(", ") }),
  notReady: () => notice("notReady"),
  rematch: () => notice("rematch"),
};

/** RIG_STATUS rejection reasons (English), keyed like the client "server" section. */
export const RIG_REASON_EN = {
  rigNotSaboteur: "You're a Baker! Bakers bake, they don't rig. 🧁",
  rigAlreadyUsed: "Already rigged this round. Greedy little devil. 😈",
  rigNotSpinning: "Only while someone's case is spinning!",
  rigOwnCase: "Rigging your own case? Bold. Also not allowed.",
} as const;
export type RigReasonKey = keyof typeof RIG_REASON_EN;
