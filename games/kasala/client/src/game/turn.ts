// Turn logic on the client: who may do what right now (legal-action gating, valid attack targets) and
// small per-turn trackers. Owner: client-net-game. The server validates everything again; this only
// decides between "send it" and "deny sound + a short Turkish reason".

import { CHIP_AMOUNTS, GHOST_CHIP, marketFee, type BetBox } from "../../../shared/constants";
import type { KasalaStateView, Phase, PlayerView, RowCardView } from "../../../shared/protocol";

/** Phases of a running match (HUD visible). */
export const MATCH_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  "intro",
  "betting",
  "flipping",
  "targeting",
  "wheel",
  "result",
  "market",
  "settle",
  "lastChance",
  "elimination",
]);
/** Phases that belong to one player's turn (cards on the table, an active seat). */
export const TURN_PHASES: ReadonlySet<Phase> = new Set<Phase>(["betting", "flipping", "targeting", "wheel", "result", "market", "settle"]);
/** Phases where the siren matters (lamp, vignette, music tension). */
export const SIREN_PHASES: ReadonlySet<Phase> = new Set<Phase>(["betting", "flipping", "targeting"]);

export function me(state: KasalaStateView | null, myId: string): PlayerView | undefined {
  return myId ? state?.players.get(myId) : undefined;
}

/** In this match's turn order (not a spectator). */
export function isParticipant(state: KasalaStateView, id: string): boolean {
  const p = state.players.get(id);
  return !!p && !p.spectator && state.turnOrder.indexOf(id) >= 0;
}

/** Match participants in seat order. */
export function participants(state: KasalaStateView): PlayerView[] {
  const out: PlayerView[] = [];
  state.turnOrder.forEach((id) => {
    const p = state.players.get(id);
    if (p && !p.spectator) out.push(p);
  });
  return out;
}

export function turnKey(round: number, turnInRound: number, activeId: string): string {
  return `${round}:${turnInRound}:${activeId}`;
}

export function stateTurnKey(state: KasalaStateView): string {
  return TURN_PHASES.has(state.phase) && state.activeId ? turnKey(state.round, state.turnInRound, state.activeId) : "";
}

// ------------------------------------------------------------------- gating
export function isMyTurn(state: KasalaStateView | null, myId: string): boolean {
  return !!state && !!myId && state.activeId === myId && TURN_PHASES.has(state.phase);
}

export function canFlip(state: KasalaStateView | null, myId: string): boolean {
  return !!state && !!myId && state.phase === "flipping" && state.activeId === myId && !state.busy;
}

/** KASALA needs at least one card on the table (the first card is mandatory). */
export function canCash(state: KasalaStateView | null, myId: string): boolean {
  return canFlip(state, myId) && (state?.flips ?? 0) > 0;
}

/** My turn, but the bet window is still open: a flip pressed now is queued until flipping opens. */
export function flipWaitsForBets(state: KasalaStateView | null, myId: string): boolean {
  return !!state && !!myId && state.activeId === myId && state.phase === "betting";
}

/** Why I can't flip / cash right now (null = I can). "" = silently ignore (e.g. animation lock on my turn). */
export function flipBlockReason(state: KasalaStateView | null, myId: string): string | null {
  if (!state || !myId) return "";
  if (canFlip(state, myId)) return null;
  const p = me(state, myId);
  if (!p) return "";
  if (state.activeId === myId && TURN_PHASES.has(state.phase)) return "";
  if (!MATCH_PHASES.has(state.phase)) return "";
  if (p.spectator) return "Seyircisin: bir sonraki maçı bekle.";
  if (p.ghost) return "Hayaletler kart çeviremez.";
  return "Sıra sende değil.";
}

/** Why my KASALA is refused (null = send it). */
export function cashBlockReason(state: KasalaStateView | null, myId: string): string | null {
  if (canCash(state, myId)) return null;
  if (state && myId && state.activeId === myId && (state.phase === "betting" || state.phase === "flipping") && state.flips === 0) {
    return "Önce bir kart çevir!";
  }
  return flipBlockReason(state, myId);
}

/**
 * One-tap heckle ("ÇEVİR!" / "KASALA!") at the player whose turn it is: match participants (ghosts too) while
 * someone else is flipping.
 */
export function canHeckle(state: KasalaStateView | null, myId: string): boolean {
  if (!state || !myId || state.phase !== "flipping" || state.activeId === myId) return false;
  return isParticipant(state, myId);
}

/**
 * Side bets are open to this player at all: the table setting, or a Battle Royale ghost's free chip (its only
 * way back, §10; the server lets ghosts bet even with side bets off).
 */
export function sideBetsFor(state: KasalaStateView, p: PlayerView | undefined): boolean {
  return state.settings.sideBets || (!!p?.ghost && state.settings.mode === "royale");
}

/** Why my bet would be refused (null = OK). */
export function betBlockReason(state: KasalaStateView | null, myId: string, amount: number): string | null {
  if (!state || !myId) return "Masada değilsin.";
  const p = me(state, myId);
  if (!p) return "Masada değilsin.";
  if (!sideBetsFor(state, p)) return "Seyirci bahsi kapalı.";
  if (p.spectator) return "Seyirciler bahis oynayamaz.";
  if (state.activeId === myId && TURN_PHASES.has(state.phase)) return "Kendi turuna bahis yok!";
  if (state.phase !== "betting") return state.betsLocked || state.phase === "flipping" ? "Bahisler kilitlendi!" : "Bahisler kapalı.";
  if (state.betsLocked) return "Bahisler kilitlendi!";
  if (amount <= 0 || p.ghost) return null;
  const current = state.bets.get(myId);
  const refund = current && !current.ghost ? current.amount : 0;
  if (amount > p.kasa + refund) return "Kasan yetmiyor.";
  return null;
}

/** The chip that actually goes on the box (ghosts always use GHOST_CHIP). */
export function chipFor(p: PlayerView | undefined, chip: number): number {
  if (p?.ghost) return GHOST_CHIP;
  return (CHIP_AMOUNTS as readonly number[]).includes(chip) ? chip : CHIP_AMOUNTS[0];
}

/** My current bet on this turn (null when none). */
export function myBet(state: KasalaStateView | null, myId: string): { box: BetBox; amount: number } | null {
  const bet = myId ? state?.bets.get(myId) : undefined;
  return bet ? { box: bet.box, amount: bet.amount } : null;
}

/** Valid attack targets: other match players still in the game (not ghosts, not spectators). */
export function validTargets(state: KasalaStateView | null): string[] {
  if (!state) return [];
  const out: string[] = [];
  state.turnOrder.forEach((id) => {
    if (id === state.activeId) return;
    const p = state.players.get(id);
    if (p && !p.ghost && !p.spectator) out.push(id);
  });
  return out;
}

export function amTargeting(state: KasalaStateView | null, myId: string): boolean {
  return !!state && !!myId && state.phase === "targeting" && state.activeId === myId;
}

/** May I open the loan menu? (null = yes, else a reason). */
export function loanBlockReason(state: KasalaStateView | null, myId: string): string | null {
  if (!state) return "";
  if (!state.settings.loans) return "Borç sistemi bu masada kapalı.";
  if (!MATCH_PHASES.has(state.phase)) return state.phase === "lobby" ? "Borç, maç başlayınca açılır." : "";
  const p = me(state, myId);
  if (!p) return "";
  if (p.spectator) return "Seyirciler borç veremez.";
  return null;
}

// ------------------------------------------------------------------- pazar
/** Row cards still on the table (the Pazar's goods), in flip order. */
export function rowLeft(state: KasalaStateView | null): RowCardView[] {
  const out: RowCardView[] = [];
  state?.row.forEach((c) => {
    if (!c.ownerId) out.push(c);
  });
  return out;
}

/** I may shop in this Pazar: a match player still in the game, not the seller, with money for at least one card. */
export function canShop(state: KasalaStateView | null, myId: string): boolean {
  if (!state || !myId || state.phase !== "market" || state.activeId === myId) return false;
  const p = me(state, myId);
  if (!p || p.spectator || p.ghost || !isParticipant(state, myId)) return false;
  return rowLeft(state).some((c) => marketFee(c.value) <= p.kasa);
}

/** Why my Pazar pick is refused (null = send it). */
export function marketBlockReason(state: KasalaStateView | null, myId: string, flipNo: number): string | null {
  if (!state || !myId || state.phase !== "market") return "";
  if (state.activeId === myId) return "Kendi vitrininden alamazsın: rakipler alışverişte.";
  if (!canShop(state, myId)) return "Bu pazarda alacak paran yok.";
  if (state.busy) return "";
  if (flipNo === 0) return null;
  const card = rowLeft(state).find((c) => c.flipNo === flipNo);
  if (!card) return "";
  if (marketFee(card.value) > (me(state, myId)?.kasa ?? 0)) return "Kasan bu kartın fiyatına yetmiyor.";
  return null;
}

/** Players next in line after the active one (skipping ghosts), for the Tuzak icon. */
export function nextPlayerId(state: KasalaStateView): string {
  const n = state.turnOrder.length;
  const i = state.turnOrder.indexOf(state.activeId);
  if (n === 0 || i < 0) return "";
  for (let k = 1; k < n; k++) {
    const id = state.turnOrder[(i + k) % n];
    const p = state.players.get(id);
    if (p && !p.ghost && !p.spectator) return id;
  }
  return "";
}
