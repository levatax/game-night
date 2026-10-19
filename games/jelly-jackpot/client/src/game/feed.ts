// Feed line builders for the HUD feed (Hud.feed takes HTML). Owner: client-game.
// Every player-provided string (nicknames, server notices) goes through esc() before it touches HTML.

import { CARD_BY_ID, PLAYER_COLORS, type CardId } from "../../../shared/constants";
import type { BetResult, JellyStateView, ResultMsg, RevealMsg } from "../../../shared/protocol";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** HTML-escape any text. */
export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

/** Formats a multiplier: 1.5 → "×1.5", 2 → "×2". */
export function fmtMult(m: number): string {
  return `×${Number.isInteger(m) ? m : m.toFixed(1)}`;
}

/** Signed coin amount with a real minus sign: −20 / +34. */
export function fmtDelta(d: number): string {
  return d < 0 ? `−${Math.abs(d)}` : `+${d}`;
}

/** Plain nickname (unescaped) or a fallback. */
export function nickOf(state: JellyStateView | null, id: string): string {
  return state?.players.get(id)?.nickname || "Someone";
}

/** A player's name as bold HTML in their hat color (escaped). */
export function who(state: JellyStateView | null, id: string, myId = ""): string {
  const p = state?.players.get(id);
  const color = p ? PLAYER_COLORS[p.color] ?? "#fff" : "#fff";
  const name = id && id === myId ? "You" : esc(p?.nickname || "Someone");
  return `<b style="color:${color}">${name}</b>`;
}

/** "Moon Gravity ×2" in bold. */
export function cardHtml(card: CardId, mult: number): string {
  const def = CARD_BY_ID[card];
  return `<b>${esc(def ? def.name : card)} ${fmtMult(mult)}</b>`;
}

// ------------------------------------------------------------------------- line builders
// Each returns [icon, html] for Hud.feed(html, icon).

export type FeedLine = [icon: string, html: string];

const OPEN_VERBS = ["opened", "cracked open", "yanked the lever on", "unboxed", "gambled on"];

export function openedLine(state: JellyStateView | null, id: string, card: CardId, mult: number, myId: string): FeedLine {
  const def = CARD_BY_ID[card];
  return ["🎰", `${who(state, id, myId)} ${pick(OPEN_VERBS)} ${cardHtml(card, mult)} ${def?.emoji ?? ""}`];
}

const STAND_QUIPS = ["Structural genius!", "Gordon Ramsay weeps.", "Wobbly but proud.", "The jelly holds!", "Engineers hate this trick."];
const FALL_QUIPS = ["Nooo the cake!", "Frosting everywhere.", "Gravity: 1, Chef: 0.", "That's going on the blooper reel.", "Somebody get a mop."];

export function resultLine(state: JellyStateView | null, msg: ResultMsg, myId: string): FeedLine {
  const name = who(state, msg.playerId, myId);
  if (msg.outcome === "stand") {
    return ["🏰", `${name}'s tower STANDS! <b>${fmtDelta(msg.delta)}</b> 🪙 (${msg.heightCm} cm) <i>${pick(STAND_QUIPS)}</i>`];
  }
  if (msg.insured) return ["📜", `${name} TOPPLED it, but Insurance paid up! <b>±0</b>`];
  return ["💥", `${name} TOPPLED it (<b>${fmtDelta(msg.delta)}</b>) <i>${pick(FALL_QUIPS)}</i>`];
}

/** "Bets: Sam 25 FALL ✅, Kai 10 STAND ❌" (null when nobody bet). */
export function betsLine(state: JellyStateView | null, bets: BetResult[], myId: string): FeedLine | null {
  const real = bets.filter((b) => b.amount > 0);
  if (!real.length) return null;
  const parts = real.map((b) => `${who(state, b.playerId, myId)} ${b.amount} ${b.side.toUpperCase()} ${b.won ? "✅" : "❌"}`);
  return ["🎲", `Bets: ${parts.join(", ")}`];
}

export function revealLine(state: JellyStateView | null, msg: RevealMsg, myId: string): FeedLine {
  if (!msg.saboteurId) return ["🍀", "No Saboteur! It was just bad luck all along."];
  return ["😈", `${who(state, msg.saboteurId, myId)} was the Saboteur! ${msg.caught ? "CAUGHT 🚔" : "ESCAPED 🏃💨"}`];
}

export function noticeLine(text: string): FeedLine {
  return ["📢", esc(text)];
}
