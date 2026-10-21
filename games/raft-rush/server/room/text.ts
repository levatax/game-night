// The NOTICE lines RaftRoom sends (toasts in the lobby and in the match). Owner: server-room.
//
// Every notice is { key, params, text }: `key` indexes client/src/i18n/strings/server.ts (`server.<key>`), the
// client translates it with `params`; `text` is the filled English line (fallback, logs, tests). NOTICE_EN below
// and the client's `en` must stay identical (server/text.test.ts enforces it).
// Tone: goofy shipwrecked-tourist humor (game4.md §14). Names are never glued to suffixes, so the Turkish lines
// on the client can put {n} where vowel harmony doesn't matter.

import type { NoticeMsg } from "../../shared/protocol.js";

/**
 * English lines, keyed exactly like the client's `server` section, with {param} placeholders.
 * Random variants are numbered: joined1…joined4. Clients show t(`server.${key}`, params).
 */
export const NOTICE_EN = {
  joined1: "🏝️ {n} washed up on the beach!",
  joined2: "🧳 {n} arrived with three suitcases and zero sunscreen.",
  joined3: "🩴 {n} lost a flip-flop to the waves but made it ashore.",
  joined4: "📸 {n} is here and already taking selfies with a crab.",
  spectating1: "🍿 {n} is watching from the lifeboat. Next match they're stranded too!",
  spectating2: "🔭 {n} grabbed the binoculars and is spectating until this match ends.",
  spectatingYou: "⛱️ A match is already running: you're spectating until it ends. Next one, you're shipwrecked too!",
  left1: "🚣 {n} paddled away on an inflatable flamingo.",
  left2: "🧴 {n} swam back to the cruise ship for more sunscreen.",
  left3: "🦩 {n} left the island. The crabs send their regards.",
  reconnecting: "📡 {n} dropped their phone in the sea… reconnecting. A helper bot keeps their spot warm.",
  reconnected: "🔌 {n} dried their phone in a bag of rice and is back!",
  tookOver: "🤖 {n} swam off for good. A helper bot took over their seat (and their coconuts).",
  host: "🧢 {n} is the tour guide now (host).",
  botAdded: "🤖 Helper bot {n} washed ashore. Batteries mostly dry.",
  botRemoved: "🤖 {n} rowed back to the cruise ship.",
  soloBots: "🤖 Going solo? {count} helper bots washed up to lend a hand.",
  tooManyBots: "🙅 That's enough robots: at most {max} helper bots per island.",
  beachFull: "🙅 The beach is full: at most {max} castaways, bots included.",
  cantStartAway: "⏳ Waiting for {n} to fish their phone out of the sea (reconnecting).",
  cantStartLazyOne: "🙅 Can't sail yet: {names} is still putting on sunscreen.",
  cantStartLazyMany: "🙅 Can't sail yet: {names} are still putting on sunscreen.",
  duelLocked: "🏝️ Island Wars is still under construction (the builders are on a coffee break). Co-op only for now!",
  hostOnly: "🧢 Only the tour guide (host) can do that.",
  rematch: "🔁 {n} wants a rematch! Everyone back to the beach, a fresh island is on its way.",
  backToLobby: "🏖️ {n} headed back to the lobby.",
  lobbyAuto: "🏖️ Back to the lobby. New island, same sunburn.",
} as const;

export type NoticeKey = keyof typeof NOTICE_EN;

type Params = Record<string, string | number>;
/** Random stream for picking variants (the room's cosmetic rng). */
export type TextRng = () => number;

/** Replace {name} placeholders (unknown ones stay as written). */
export function fill(raw: string, params: Params): string {
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** Build a NOTICE payload: key + params + the filled English text. `params` is omitted when empty. */
export function notice(key: NoticeKey, params: Params = {}): NoticeMsg {
  const msg: NoticeMsg = { key, text: fill(NOTICE_EN[key], params) };
  if (Object.keys(params).length > 0) msg.params = params;
  return msg;
}

/** Pick a numbered variant: base "joined" with 4 variants → "joined1".."joined4". */
function variant(rng: TextRng, base: "joined" | "spectating" | "left", count: number): NoticeKey {
  const k = Math.min(count - 1, Math.max(0, Math.floor(rng() * count)));
  return `${base}${k + 1}` as NoticeKey;
}

/** Every notice the room sends, by situation. */
export const say = {
  joined: (rng: TextRng, n: string) => notice(variant(rng, "joined", 4), { n }),
  spectating: (rng: TextRng, n: string) => notice(variant(rng, "spectating", 2), { n }),
  spectatingYou: () => notice("spectatingYou"),
  left: (rng: TextRng, n: string) => notice(variant(rng, "left", 3), { n }),
  reconnecting: (n: string) => notice("reconnecting", { n }),
  reconnected: (n: string) => notice("reconnected", { n }),
  tookOver: (n: string) => notice("tookOver", { n }),
  host: (n: string) => notice("host", { n }),
  botAdded: (n: string) => notice("botAdded", { n }),
  botRemoved: (n: string) => notice("botRemoved", { n }),
  soloBots: (count: number) => notice("soloBots", { count }),
  tooManyBots: (max: number) => notice("tooManyBots", { max }),
  beachFull: (max: number) => notice("beachFull", { max }),
  cantStartAway: (n: string) => notice("cantStartAway", { n }),
  cantStartLazy: (names: string[]) =>
    notice(names.length === 1 ? "cantStartLazyOne" : "cantStartLazyMany", { names: names.join(", ") }),
  duelLocked: () => notice("duelLocked"),
  hostOnly: () => notice("hostOnly"),
  rematch: (n: string) => notice("rematch", { n }),
  backToLobby: (n: string) => notice("backToLobby", { n }),
  lobbyAuto: () => notice("lobbyAuto"),
};
