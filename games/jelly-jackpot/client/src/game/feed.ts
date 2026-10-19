// Feed line builders for the HUD feed (Hud.feed takes HTML). Owner: client-game.
// Every player-provided string (nicknames, server notices) goes through esc() before it touches HTML.

import { CARD_BY_ID, PLAYER_COLORS, type CardId } from "../../../shared/constants";
import type { BetResult, JellyStateView, NoticeMsg, ResultMsg, RevealMsg } from "../../../shared/protocol";
import { cardName, has, t, type Params } from "../i18n";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** HTML-escape any text. */
export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

/** Random variant of a numbered key: pickKey("game.timber", 4) → t("game.timber_3"). */
export function pickKey(base: string, count: number, params?: Params): string {
  return t(`${base}_${1 + Math.floor(Math.random() * count)}`, params);
}

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
  return state?.players.get(id)?.nickname || t("game.someone");
}

/** A player's name as bold HTML in their hat color (escaped). */
export function who(state: JellyStateView | null, id: string, myId = ""): string {
  const p = state?.players.get(id);
  const color = p ? PLAYER_COLORS[p.color] ?? "#fff" : "#fff";
  const name = id && id === myId ? t("game.you") : esc(p?.nickname || t("game.someone"));
  return `<b style="color:${color}">${name}</b>`;
}

/** "Moon Gravity ×2" in bold. */
export function cardHtml(card: CardId, mult: number): string {
  return `<b>${esc(cardName(card))} ${fmtMult(mult)}</b>`;
}

/** Neon sign text for a landed card. */
export function signText(card: CardId | string, mult: number): string {
  const def = CARD_BY_ID[card as CardId];
  return t("game.signCard", { emoji: def?.emoji ?? "🎰", card: cardName(card), mult: fmtMult(mult) });
}

// ------------------------------------------------------------------------- line builders
// Each returns [icon, html] for Hud.feed(html, icon).

export type FeedLine = [icon: string, html: string];

const isMe = (id: string, myId: string) => !!id && id === myId;

export function openedLine(state: JellyStateView | null, id: string, card: CardId, mult: number, myId: string): FeedLine {
  const def = CARD_BY_ID[card];
  const params = { name: who(state, id, myId), card: cardHtml(card, mult), emoji: def?.emoji ?? "" };
  return ["🎰", pickKey(isMe(id, myId) ? "game.openMe" : "game.open", 5, params)];
}

export function resultLine(state: JellyStateView | null, msg: ResultMsg, myId: string): FeedLine {
  const me = isMe(msg.playerId, myId);
  const name = who(state, msg.playerId, myId);
  const delta = fmtDelta(msg.delta);
  if (msg.outcome === "stand") {
    const quip = pickKey("game.standQuip", 5);
    return ["🏰", t(me ? "game.standMe" : "game.stand", { name, delta, cm: msg.heightCm, quip })];
  }
  if (msg.insured) return ["📜", t(me ? "game.insuredMe" : "game.insured", { name })];
  const quip = pickKey("game.fallQuip", 5);
  return ["💥", t(me ? "game.toppledMe" : "game.toppled", { name, delta, quip })];
}

/** "Bets: Sam 25 FALL ✅, Kai 10 STAND ❌" (null when nobody bet). */
export function betsLine(state: JellyStateView | null, bets: BetResult[], myId: string): FeedLine | null {
  const real = bets.filter((b) => b.amount > 0);
  if (!real.length) return null;
  const parts = real.map((b) =>
    t("game.betPart", { name: who(state, b.playerId, myId), amount: b.amount, side: t(`game.side_${b.side}`), mark: b.won ? "✅" : "❌" }),
  );
  return ["🎲", t("game.bets", { list: parts.join(", ") })];
}

export function revealLine(state: JellyStateView | null, msg: RevealMsg, myId: string): FeedLine {
  if (!msg.saboteurId) return ["🍀", t("game.noSaboteur")];
  const me = isMe(msg.saboteurId, myId);
  const key = `game.saboteur${me ? "Me" : ""}${msg.caught ? "Caught" : "Escaped"}`;
  return ["😈", t(key, { name: who(state, msg.saboteurId, myId) })];
}

/** Server text in my language when the key is known (string params escaped for HTML), else the English text. */
export function serverText(key: string | undefined, params: Params | undefined, fallback: string, html: boolean): string {
  if (key && has(`server.${key}`)) {
    const p: Params = {};
    for (const [k, v] of Object.entries(params ?? {})) p[k] = typeof v === "string" && html ? esc(v) : v;
    return t(`server.${key}`, p);
  }
  return html ? esc(fallback) : fallback;
}

export function noticeLine(msg: NoticeMsg): FeedLine {
  return ["📢", serverText(msg.key, msg.params, msg.text, true)];
}
