// Nicknames and the silly NOTICE lines JellyRoom sends. Owner: server-room.

import { NICKNAME_MAX } from "../../shared/constants.js";
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

function pick(rng: Rng, lines: string[]): string {
  return lines[Math.floor(rng() * lines.length) % lines.length]!;
}

export const say = {
  joined: (rng: Rng, n: string) =>
    pick(rng, [
      `🧑‍🍳 ${n} waddled into the kitchen!`,
      `🥄 ${n} has entered the kitchen. Hide the good spatulas.`,
      `🍰 ${n} smells cake and shows up. Classic.`,
      `🐔 ${n} arrived with a rubber chicken. Nobody asked why.`,
    ]),
  spectating: (rng: Rng, n: string) =>
    pick(rng, [`🍿 ${n} grabbed a stool and is watching the chaos.`, `👀 ${n} is spectating. Next match they bake!`]),
  left: (rng: Rng, n: string) =>
    pick(rng, [
      `🚪 ${n} dropped their spatula and left.`,
      `💨 ${n} ran out of the kitchen screaming.`,
      `🥧 ${n} has left the building (pie still warm).`,
    ]),
  reconnecting: (n: string) => `📡 ${n} tripped over the power cord… reconnecting.`,
  reconnected: (n: string) => `🔌 ${n} plugged back in!`,
  host: (n: string) => `👑 ${n} is the head chef now.`,
  fledTurn: (n: string) => `🏃 ${n} fled mid-turn. Their piece goes back in the bag.`,
  autoDrop: (n: string) => `⏰ Time's up! ${n}'s piece slips out of their butter-soft fingers.`,
  tooFew: () => `😢 Not enough chefs left in the kitchen. Straight to the podium!`,
  saboteurFled: () => `🕵️ Someone left for good… the vote is off, but secrets will still be spilled.`,
  cantStart: (why: string) => `🙅 Can't start yet: ${why}`,
  notReady: () => `🍳 Kitchen is still warming up, try again in a sec.`,
  rematch: () => `🔁 Fresh cake! Back to the lobby.`,
};
