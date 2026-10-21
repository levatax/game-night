// Pure KASALA! rules (game3.md §5–§10, §16, §19). Owner: server. No Colyseus, no Date / Math.random in
// here: everything takes an injected Rng so it is deterministic and unit-tested (server/rules.test.ts).
// KasalaRoom owns the state machine and calls these for every roll, payout and money split.

import {
  BET_BOX_BY_ID,
  BET_BOXES,
  BRIBE_ENVELOPE_DROP,
  CARD_BY_ID,
  CARDS,
  CHIP_AMOUNTS,
  EARLY_CASH_FLIPS,
  FINAL_TABLE_MULT,
  GHOST_CHIP,
  GHOST_WINS_TO_RETURN,
  HARAC_PCT,
  HARAC_TURU_FEE,
  HOUSE_CUT_PCT,
  LOAN_MAX_PCT,
  LOAN_MIN,
  RAID_BRIBE_PCT,
  ROYALE_BRIBE_PER_ROUND,
  TASLIK_CUT_PCT,
  TITLES,
  WHEEL_EVERYONE_GAIN,
  WHEEL_PAY_EACH,
  WHEEL_POT_MULT,
  WHEEL_RAID_PCT,
  WHEEL_SLICES,
  boxAlive,
  boxWins,
  marketFee,
} from "../shared/constants.js";
import type { BetBox, CardId, TitleId, TurnOutcome, WheelSliceId } from "../shared/constants.js";
import type { AnnouncerEvent } from "../shared/announcer.js";
import type { BetResult, LoanKind, MatchEndMsg, Mode, StatsView } from "../shared/protocol.js";

export type Rng = () => number;

/** Wheel spins in one go before "BİR DAHA!" is taken out of the pool (keeps the moment from looping forever). */
export const MAX_WHEEL_SPINS = 4;

// ------------------------------------------------------------------------ random
/** Seeded PRNG (mulberry32), returns [0, 1). */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [0, n). */
export function randInt(rng: Rng, n: number): number {
  if (n <= 1) return 0;
  return Math.min(n - 1, Math.floor(rng() * n));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[randInt(rng, items.length)]!;
}

/** Fisher–Yates copy. */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function weighted<T>(rng: Rng, items: readonly T[], weight: (t: T) => number): T {
  const total = items.reduce((s, it) => s + Math.max(0, weight(it)), 0);
  let r = rng() * total;
  for (const it of items) {
    r -= Math.max(0, weight(it));
    if (r < 0) return it;
  }
  return items[items.length - 1]!;
}

// -------------------------------------------------------------------------- cards
const DRAW_CARDS = CARDS.filter((c) => c.weight > 0);

/** A non-raid card by the §6 / §19 weights. */
export function rollCard(rng: Rng): CardId {
  return weighted(rng, DRAW_CARDS, (c) => c.weight).id;
}

/** One flip (§5): a raid with probability `chance`, otherwise a weighted card. */
export function rollFlip(rng: Rng, chance: number): CardId {
  if (rng() < chance) return "baskin";
  return rollCard(rng);
}

/** Siren level after flipping `card`: +1, Rüşvet Zarfı then −BRIBE_ENVELOPE_DROP (never below 0). */
export function sirenAfter(level: number, card: CardId): number {
  const next = Math.max(0, level) + 1;
  return card === "rusvet" ? Math.max(0, next - BRIBE_ENVELOPE_DROP) : next;
}

/** What a money card adds to the pot (SON MASA doubles it, a Lanet zeroes it). 0 for non-money cards. */
export function moneyValue(card: CardId, finalTable: boolean, cursed = false): number {
  const def = CARD_BY_ID[card];
  if (!def || def.kind !== "money" || cursed) return 0;
  return def.value * (finalTable ? FINAL_TABLE_MULT : 1);
}

/** Raid bribe (§6, §10): classic 10% of the kasa (×2 at SON MASA), Battle Royale round × 20$. Never more than the kasa. */
export function raidBribe(mode: Mode, kasa: number, round: number, finalTable: boolean): number {
  const k = Math.max(0, Math.floor(kasa));
  if (k <= 0) return 0;
  if (mode === "royale") return Math.min(k, Math.max(1, round) * ROYALE_BRIBE_PER_ROUND);
  return Math.min(k, Math.floor((k * Math.round(RAID_BRIBE_PCT * 100) * (finalTable ? FINAL_TABLE_MULT : 1)) / 100));
}

/** Haraç: share of the target's kasa that moves into the flipper's pot. */
export function haracAmount(kasa: number): number {
  return Math.max(0, Math.floor((Math.max(0, kasa) * Math.round(HARAC_PCT * 100)) / 100));
}

/** Haraç Turu: everyone else pays HARAC_TURU_FEE (as much as they have). */
export function haracTuruPayments(others: readonly { id: string; kasa: number }[]): { playerId: string; amount: number }[] {
  return others.map((o) => ({ playerId: o.id, amount: Math.max(0, Math.min(HARAC_TURU_FEE, Math.floor(o.kasa))) }));
}

// ------------------------------------------------------------------ vitrin & pazar
export interface RowCard {
  flipNo: number;
  value: number;
  /** "" while the card lies on the table. */
  ownerId: string;
}

/** Value of the row cards still on the table. */
export function rowValue(row: readonly RowCard[]): number {
  let n = 0;
  for (const c of row) if (!c.ownerId) n += Math.max(0, c.value);
  return n;
}

/** KASALA's picks: the `n` most valuable cards still on the table (ties → the earlier flip), as flip numbers. */
export function bestPicks(row: readonly RowCard[], n: number): number[] {
  return row
    .filter((c) => !c.ownerId && c.value > 0)
    .sort((a, b) => b.value - a.value || a.flipNo - b.flipNo)
    .slice(0, Math.max(0, n))
    .map((c) => c.flipNo);
}

export interface MarketBuyer {
  id: string;
  kasa: number;
  /** Flip number of the wanted row card, 0 = pas. */
  choice: number;
}

export interface MarketOutcome {
  sales: { buyerId: string; flipNo: number; value: number; fee: number }[];
  /** Cards several buyers wanted: who got it and who went home empty-handed. */
  clashes: { flipNo: number; winnerId: string; loserIds: string[] }[];
}

/**
 * The Pazar reveal. A card wanted by several buyers goes to the one with the smallest kasa (the catch-up rule);
 * on a tie, the one listed first (`buyers` is in turn order after the seller). A buyer who can't pay the fee
 * drops out. Cards nobody got stay unsold.
 */
export function resolveMarket(cards: readonly RowCard[], buyers: readonly MarketBuyer[]): MarketOutcome {
  const out: MarketOutcome = { sales: [], clashes: [] };
  for (const card of cards) {
    if (card.ownerId || card.value <= 0) continue;
    const fee = marketFee(card.value);
    const wants = buyers.filter((b) => b.choice === card.flipNo && b.kasa >= fee);
    if (!wants.length) continue;
    let winner = wants[0]!;
    for (const b of wants) if (b.kasa < winner.kasa) winner = b;
    out.sales.push({ buyerId: winner.id, flipNo: card.flipNo, value: card.value, fee });
    if (wants.length > 1) out.clashes.push({ flipNo: card.flipNo, winnerId: winner.id, loserIds: wants.filter((b) => b !== winner).map((b) => b.id) });
  }
  return out;
}

/** The first id after `activeId` in `order` (cyclic) that passes `eligible`; "" when nobody does. */
export function nextInOrder(order: readonly string[], activeId: string, eligible: (id: string) => boolean): string {
  const n = order.length;
  const at = order.indexOf(activeId);
  for (let k = 1; k <= n; k++) {
    const id = order[(Math.max(at, 0) + k) % n]!;
    if (id !== activeId && eligible(id)) return id;
  }
  return "";
}

/** A random attack target (targeting timeout). "" when there is no candidate. */
export function randomTarget(rng: Rng, candidates: readonly string[]): string {
  return candidates.length ? pick(rng, candidates) : "";
}

// -------------------------------------------------------------------------- wheel
/** A wheel slice by the §7 weights. Without `allowAgain` "BİR DAHA!" can't come up. */
export function rollWheel(rng: Rng, allowAgain = true): WheelSliceId {
  const pool = allowAgain ? WHEEL_SLICES : WHEEL_SLICES.filter((s) => s.id !== "birDaha");
  return weighted(rng, pool, (s) => s.weight).id;
}

/** KASALARI KARIŞTIR: a random permutation of `values` that moves at least one kasa when possible. */
export function shuffleKasas(rng: Rng, values: readonly number[]): number[] {
  if (values.length < 2) return values.slice();
  const idx = values.map((_, i) => i);
  let perm = shuffle(rng, idx);
  for (let tries = 0; tries < 16 && perm.every((v, i) => v === i); tries++) perm = shuffle(rng, idx);
  if (perm.every((v, i) => v === i)) perm = [...idx.slice(1), 0];
  return perm.map((i) => values[i]!);
}

export interface WheelInput {
  slice: WheelSliceId;
  activeId: string;
  /** Non-ghost match players in turn order (the active player included). */
  order: readonly string[];
  kasas: Readonly<Record<string, number>>;
  kumbara: number;
  pot: number;
}
export interface WheelOutcome {
  kasas: Record<string, number>;
  kumbara: number;
  pot: number;
  /** BEDAVA AVUKAT: +1 lawyer now and one for the next turn. */
  lawyer: boolean;
  /** BİR DAHA!: spin again. */
  again: boolean;
  /** Non-zero kasa changes, in `order`. */
  deltas: { playerId: string; delta: number }[];
  kumbaraDelta: number;
}

/** Apply a wheel slice (§7). Never makes a kasa, the kumbara or the pot negative. */
export function applyWheel(rng: Rng, input: WheelInput): WheelOutcome {
  const order = input.order.filter((id, i, a) => a.indexOf(id) === i);
  const kasas: Record<string, number> = {};
  for (const id of order) kasas[id] = Math.max(0, Math.floor(input.kasas[id] ?? 0));
  let kumbara = Math.max(0, Math.floor(input.kumbara));
  let pot = Math.max(0, Math.floor(input.pot));
  const active = input.activeId;
  let lawyer = false;
  let again = false;
  const has = (id: string) => id in kasas;

  switch (input.slice) {
    case "kumbara":
      if (has(active)) {
        kasas[active]! += kumbara;
        kumbara = 0;
      }
      break;
    case "x10":
      pot *= WHEEL_POT_MULT;
      break;
    case "herkese100":
      for (const id of order) kasas[id]! += WHEEL_EVERYONE_GAIN;
      break;
    case "karistir": {
      const mixed = shuffleKasas(rng, order.map((id) => kasas[id]!));
      order.forEach((id, i) => (kasas[id] = mixed[i]!));
      break;
    }
    case "herkeseOde": {
      if (!has(active)) break;
      const at = order.indexOf(active);
      for (let k = 1; k < order.length; k++) {
        const id = order[(at + k) % order.length]!;
        const pay = Math.min(WHEEL_PAY_EACH, kasas[active]!);
        if (pay <= 0) break;
        kasas[active]! -= pay;
        kasas[id]! += pay;
      }
      break;
    }
    case "avukat":
      lawyer = true;
      break;
    case "topluBaskin":
      for (const id of order) {
        const pay = Math.floor((kasas[id]! * Math.round(WHEEL_RAID_PCT * 100)) / 100);
        kasas[id]! -= pay;
        kumbara += pay;
      }
      break;
    case "birDaha":
      again = true;
      break;
  }

  const deltas: { playerId: string; delta: number }[] = [];
  for (const id of order) {
    const d = kasas[id]! - Math.max(0, Math.floor(input.kasas[id] ?? 0));
    if (d !== 0) deltas.push({ playerId: id, delta: d });
  }
  return { kasas, kumbara, pot, lawyer, again, deltas, kumbaraDelta: kumbara - Math.max(0, Math.floor(input.kumbara)) };
}

// --------------------------------------------------------------------------- bets
export interface PendingBet {
  playerId: string;
  box: BetBox;
  amount: number;
  ghost: boolean;
}
export interface BetSettlement {
  results: BetResult[];
  /** HOUSE_CUT_PCT of the losing real stakes, to the active player. */
  houseCut: number;
  /** The rest of the losing real stakes, to the kumbara. */
  toKumbara: number;
}

/** Gross payout of a winning real bet (stake included), SON MASA doubles it. */
export function betPayout(box: BetBox, amount: number, finalTable: boolean): number {
  const def = BET_BOX_BY_ID[box];
  if (!def || amount <= 0) return 0;
  return Math.floor((Math.floor(amount) * Math.round(def.payout * 100) * (finalTable ? FINAL_TABLE_MULT : 1)) / 100);
}

/** Settle side bets (§8). Stakes already left the kasas when the bets were placed. */
export function settleBets(bets: readonly PendingBet[], outcome: TurnOutcome, finalTable: boolean): BetSettlement {
  let lost = 0;
  const results: BetResult[] = [];
  for (const b of bets) {
    if (!(b.amount > 0)) continue;
    const won = boxWins(b.box, outcome);
    const delta = won && !b.ghost ? betPayout(b.box, b.amount, finalTable) : 0;
    if (!won && !b.ghost) lost += Math.floor(b.amount);
    results.push({ playerId: b.playerId, box: b.box, amount: b.amount, won, delta, ghost: b.ghost });
  }
  const houseCut = Math.floor((lost * Math.round(HOUSE_CUT_PCT * 100)) / 100);
  return { results, houseCut, toKumbara: lost - houseCut };
}

/** Which Cemil Abi line fits a settlement: most bettors won on raid boxes / most lost on "Kasalar" / generic. */
export function betsLineEvent(results: readonly BetResult[]): AnnouncerEvent {
  const n = results.length;
  if (n === 0) return "betsSettled";
  const raidersWon = results.filter((r) => r.box !== "cash" && r.won).length;
  const cashLost = results.filter((r) => r.box === "cash" && !r.won).length;
  if (raidersWon * 2 > n) return "betsRaidersWon";
  if (cashLost * 2 > n) return "betsCashLost";
  return "betsSettled";
}

/** A ghost's correct prediction: the new ghostWins and whether they come back to the table (once per match). */
export function ghostAfterWin(ghostWins: number, ghostReturned: boolean): { ghostWins: number; returns: boolean } {
  const wins = ghostWins + 1;
  return { ghostWins: wins, returns: !ghostReturned && wins >= GHOST_WINS_TO_RETURN };
}

// -------------------------------------------------------------------------- loans
/** The most a lender may lend right now. */
export function loanLimit(kasa: number): number {
  return Math.max(0, Math.floor((Math.max(0, kasa) * Math.round(LOAN_MAX_PCT * 100)) / 100));
}

/** Interest after one full round: ceil(owed × (1 + rate%)), in integer math (no float drift). */
export function applyInterest(owed: number, ratePct: number): number {
  const o = Math.max(0, Math.floor(owed));
  return Math.ceil((o * (100 + Math.max(0, Math.floor(ratePct)))) / 100);
}

/** §9 Taşlık: total debt larger than the kasa. */
export function isTaslik(kasa: number, totalOwed: number): boolean {
  return totalOwed > 0 && totalOwed > Math.max(0, kasa);
}

export interface DebtLike {
  id: string;
  lenderId: string;
  borrowerId: string;
  owed: number;
}

/**
 * Taşlık cut on a KASALA: TASLIK_CUT_PCT of the pot repays the borrower's debts, largest owed first (ties: in
 * the given order). Returns the payment per debt and what the borrower keeps.
 */
export function taslikCut(pot: number, debts: readonly DebtLike[]): { payments: { debtId: string; lenderId: string; amount: number }[]; kept: number } {
  const p = Math.max(0, Math.floor(pot));
  let left = Math.floor((p * Math.round(TASLIK_CUT_PCT * 100)) / 100);
  const sorted = debts.map((d, i) => ({ d, i })).sort((a, b) => b.d.owed - a.d.owed || a.i - b.i);
  const payments: { debtId: string; lenderId: string; amount: number }[] = [];
  for (const { d } of sorted) {
    if (left <= 0) break;
    const amount = Math.min(left, Math.max(0, Math.floor(d.owed)));
    if (amount <= 0) continue;
    payments.push({ debtId: d.id, lenderId: d.lenderId, amount });
    left -= amount;
  }
  const paid = payments.reduce((s, x) => s + x.amount, 0);
  return { payments, kept: p - paid };
}

/** Group payments by lender (CashedMsg.taslikCut), in first-seen order. */
export function cutByLender(payments: readonly { lenderId: string; amount: number }[]): { lenderId: string; amount: number }[] {
  const out: { lenderId: string; amount: number }[] = [];
  for (const p of payments) {
    const row = out.find((o) => o.lenderId === p.lenderId);
    if (row) row.amount += p.amount;
    else out.push({ lenderId: p.lenderId, amount: p.amount });
  }
  return out;
}

/**
 * Match-end debt collection (§9), in the given debt order: min(owed, borrower kasa) moves to the lender, the
 * rest is wiped and the borrower lands on the Kara Liste.
 */
export function collectDebts(
  debts: readonly DebtLike[],
  kasas: Readonly<Record<string, number>>,
): { collections: MatchEndMsg["collections"]; kasas: Record<string, number>; karaListe: string[] } {
  const k: Record<string, number> = {};
  for (const [id, v] of Object.entries(kasas)) k[id] = Math.max(0, Math.floor(v));
  const collections: MatchEndMsg["collections"] = [];
  const kara: string[] = [];
  for (const d of debts) {
    const owed = Math.max(0, Math.floor(d.owed));
    if (owed <= 0) continue;
    const have = k[d.borrowerId] ?? 0;
    const paid = Math.min(owed, have);
    k[d.borrowerId] = have - paid;
    k[d.lenderId] = (k[d.lenderId] ?? 0) + paid;
    const wiped = owed - paid;
    if (wiped > 0 && !kara.includes(d.borrowerId)) kara.push(d.borrowerId);
    collections.push({ debtId: d.id, lenderId: d.lenderId, borrowerId: d.borrowerId, paid, wiped });
  }
  return { collections, kasas: k, karaListe: kara };
}

// --------------------------------------------------------------------- standings
export interface StandingInput {
  id: string;
  kasa: number;
  raids: number;
  seat: number;
  /** Battle Royale: in the river at the end. */
  ghost: boolean;
  /** Battle Royale: when they were (last) eliminated, 1-based increasing; 0 = never. */
  elimIndex: number;
}

/**
 * Final standings. Classic: kasa desc, tie → fewer raids, then seat. Battle Royale: survivors the same way,
 * then ghosts by elimination order, latest first.
 */
export function standings(mode: Mode, players: readonly StandingInput[]): MatchEndMsg["standings"] {
  const byMoney = (a: StandingInput, b: StandingInput) => b.kasa - a.kasa || a.raids - b.raids || a.seat - b.seat;
  let order: StandingInput[];
  if (mode === "royale") {
    const alive = players.filter((p) => !p.ghost).sort(byMoney);
    const ghosts = players.filter((p) => p.ghost).sort((a, b) => b.elimIndex - a.elimIndex || a.seat - b.seat);
    order = [...alive, ...ghosts];
  } else {
    order = players.slice().sort(byMoney);
  }
  return order.map((p, i) => ({ playerId: p.id, place: i + 1, kasa: Math.max(0, Math.floor(p.kasa)) }));
}

export interface TitleInput {
  id: string;
  /** Final place (ties for a title go to the worse place). */
  place: number;
  stats: Pick<StatsView, "raids" | "borrowed" | "earlyCashes" | "betProfit" | "betsWon" | "betsLost" | "maxFlips">;
  karaListe: boolean;
  /** Debt wiped at match end (Kara Liste amount). */
  wiped: number;
}

/** Minimum maxFlips for "Gözü Kara". */
export const GOZU_KARA_MIN_FLIPS = 4;
/** Minimum real bets for "Kör Bahisçi". */
export const KOR_BAHISCI_MIN_BETS = 2;

/**
 * Shame titles (§16.6), in TITLES order, each at most once and only when earned. value: raids / borrowed $ /
 * early cashes / betProfit (negative $) / wiped $ / maxFlips.
 */
export function shameTitles(players: readonly TitleInput[]): MatchEndMsg["titles"] {
  const best = (score: (p: TitleInput) => number, eligible: (p: TitleInput) => boolean): TitleInput | null => {
    let top: TitleInput | null = null;
    for (const p of players) {
      if (!eligible(p)) continue;
      if (!top || score(p) > score(top) || (score(p) === score(top) && p.place > top.place)) top = p;
    }
    return top;
  };
  const rules: Record<TitleId, { score: (p: TitleInput) => number; eligible: (p: TitleInput) => boolean; value: (p: TitleInput) => number }> = {
    bombaMiknatisi: { score: (p) => p.stats.raids, eligible: (p) => p.stats.raids >= 1, value: (p) => p.stats.raids },
    borcKrali: { score: (p) => p.stats.borrowed, eligible: (p) => p.stats.borrowed >= 1, value: (p) => p.stats.borrowed },
    korkak: { score: (p) => p.stats.earlyCashes, eligible: (p) => p.stats.earlyCashes >= 1, value: (p) => p.stats.earlyCashes },
    korBahisci: {
      score: (p) => -p.stats.betProfit,
      eligible: (p) => p.stats.betProfit < 0 && p.stats.betsWon + p.stats.betsLost >= KOR_BAHISCI_MIN_BETS,
      value: (p) => p.stats.betProfit,
    },
    karaListe: { score: (p) => p.wiped, eligible: (p) => p.karaListe, value: (p) => p.wiped },
    gozuKara: { score: (p) => p.stats.maxFlips, eligible: (p) => p.stats.maxFlips >= GOZU_KARA_MIN_FLIPS, value: (p) => p.stats.maxFlips },
  };
  const out: MatchEndMsg["titles"] = [];
  for (const t of TITLES) {
    const r = rules[t.id];
    const who = best(r.score, r.eligible);
    if (who) out.push({ title: t.id, playerId: who.id, value: r.value(who) });
  }
  return out;
}

/** "En Büyük Korkak": a voluntary KASALA after 1..EARLY_CASH_FLIPS cards (a 0-card KASALA isn't allowed at all). */
export function isEarlyCash(flips: number, auto: boolean): boolean {
  return !auto && flips >= 1 && flips <= EARLY_CASH_FLIPS;
}

// --------------------------------------------------------------------------- bots
// Pure bot decisions (server/room/bots.ts schedules them). Every random pick takes the room's separate bot
// rng, so bots never shift card or wheel outcomes.

/** korkak cashes early, gözü kara pushes its luck, dengeli plays the odds. */
export type BotPersonality = "korkak" | "dengeli" | "gozuKara";
/** Lobby bots get their personality by BOT_NAMES index (the first three are all different). */
export const BOT_PERSONALITY_BY_INDEX: readonly BotPersonality[] = ["dengeli", "korkak", "gozuKara", "dengeli", "gozuKara", "korkak", "dengeli"];
/** Weight on the expected gain of one more card in the stop rule. */
export const BOT_NERVE: Record<BotPersonality, number> = { korkak: 0.6, dengeli: 1, gozuKara: 1.6 };
/** Chance to put a chip down when the bot can bet (otherwise PAS). */
export const BOT_BET_CHANCE: Record<BotPersonality, number> = { korkak: 0.55, dengeli: 0.7, gozuKara: 0.85 };
/** Never flip more than this many cards in one turn (lawyer streaks included). */
export const BOT_MAX_FLIPS = 10;
/** Most of the kasa a bot stakes on one side bet. */
export const BOT_BET_MAX_PCT = 0.15;
/** Battle Royale: no real-money side bets below this kasa (the chips are a lifeline). */
export const BOT_ROYALE_BET_MIN_KASA = 60;

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/** Expected pot gain of one more non-raid card: ≈ 20$ of money cards (×2 at SON MASA) plus the aklama share of the pot. */
export function cardGainEV(pot: number, finalTable: boolean): number {
  return 20 * (finalTable ? FINAL_TABLE_MULT : 1) + 0.08 * Math.max(0, pot);
}

export interface BotFlipInput {
  personality: BotPersonality;
  flips: number;
  pot: number;
  /** Chance that the next card is a raid. */
  raidChance: number;
  /** Bribe a raid would cost right now. */
  bribe: number;
  lawyers: number;
  finalTable: boolean;
  /** How far the bot trails the richest other player ($, ≤ 0 = leading). */
  behindBy: number;
  /** Share (0..1) of this turn's real-money stakes sitting on raid boxes. */
  raidStakeShare: number;
}

/**
 * Bot stop rule: flip while (1 − p) × EV(card) × nerve > p × (pot + bribe). The first card is mandatory, a lawyer
 * makes the next card free, trailing the leader (most at SON MASA) adds nerve and a table betting on a raid takes
 * some away (§3: "inadına ters oynar"). `jitter` in [0, 1) keeps bots from being predictable.
 */
export function botShouldFlip(v: BotFlipInput, jitter: number): boolean {
  if (v.flips <= 0) return true;
  if (v.flips >= BOT_MAX_FLIPS) return false;
  if (v.lawyers > 0) return true;
  let nerve = BOT_NERVE[v.personality] * (0.85 + 0.3 * clamp01(jitter));
  if (v.behindBy > 150) nerve *= v.finalTable ? 1.5 : 1.2;
  if (v.raidStakeShare > 0.5) nerve *= 0.85;
  const p = clamp01(v.raidChance);
  return (1 - p) * cardGainEV(v.pot, v.finalTable) * nerve > p * (Math.max(0, v.pot) + Math.max(0, v.bribe));
}

/** Side bet box from how many cards the active player usually turns (null = no history yet). */
export function botBetBox(rng: Rng, personality: BotPersonality, avgFlips: number | null): BetBox {
  const a = avgFlips ?? 3;
  const w: Record<BetBox, number> = {
    cash: a <= 2 ? 6 : a <= 3 ? 4 : 2,
    b12: a <= 2 ? 2 : 1.5,
    b34: a >= 3 ? 4 : 2,
    b5p: a >= 4.5 ? 2.5 : a >= 3.5 ? 1.2 : 0.5,
  };
  if (personality === "korkak") w.cash *= 1.4;
  if (personality === "gozuKara") {
    w.b5p *= 1.8;
    w.b12 *= 1.2;
  }
  return weighted(rng, BET_BOXES, (b) => w[b.id]).id;
}

export interface BotBetInput {
  personality: BotPersonality;
  kasa: number;
  ghost: boolean;
  royale: boolean;
  /** The active player's average cards per finished turn (null = none yet). */
  avgFlips: number | null;
}

/**
 * A bot's side bet, or null for PAS. Ghosts always play their free chip. Real chips: the biggest one within
 * BOT_BET_MAX_PCT of the kasa (sometimes one smaller); no bet when even the smallest chip is too much.
 */
export function botBet(rng: Rng, v: BotBetInput): { box: BetBox; amount: number } | null {
  const box = botBetBox(rng, v.personality, v.avgFlips);
  if (v.ghost) return { box, amount: GHOST_CHIP };
  if (v.royale && v.kasa < BOT_ROYALE_BET_MIN_KASA) return null;
  if (rng() >= BOT_BET_CHANCE[v.personality]) return null;
  const cap = Math.floor(Math.max(0, v.kasa) * BOT_BET_MAX_PCT);
  const chips = CHIP_AMOUNTS.filter((c) => c <= cap && c <= v.kasa);
  if (!chips.length) return null;
  let i = chips.length - 1;
  if (i > 0 && rng() < 0.4) i--;
  return { box, amount: chips[i]! };
}

/**
 * Attack target. `cands` are the legal targets in turn order starting after the bot. Haraç and Takas go for the
 * richest (for Takas that is also the smallest loss when nobody is richer); Lanet goes for the leader, sometimes
 * for the next player (the curse bites sooner).
 */
export function botTarget(rng: Rng, card: CardId, cands: readonly { id: string; kasa: number }[]): string {
  if (!cands.length) return "";
  let richest = cands[0]!;
  for (const c of cands) if (c.kasa > richest.kasa) richest = c;
  if (card === "lanet" && rng() < 0.3) return cands[0]!.id;
  return richest.id;
}

export interface BotMarketInput {
  personality: BotPersonality;
  kasa: number;
  /** Row cards still on the table. */
  cards: readonly { flipNo: number; value: number }[];
  /** Kasas of the other players who may buy. */
  rivals: readonly number[];
}

/** How often a bot with a poorer rival (who would win a clash) settles for the second-best card. */
const BOT_MARKET_DODGE: Record<BotPersonality, number> = { korkak: 0.6, dengeli: 0.35, gozuKara: 0 };

/**
 * A bot's Pazar pick (flip number, 0 = pas): the most valuable card worth more than its fee that it can pay
 * for. A poorer rival wins a clash, so a richer bot sometimes goes for the second best instead.
 */
export function botMarketChoice(rng: Rng, v: BotMarketInput): number {
  const ok = v.cards
    .filter((c) => c.value > marketFee(c.value) && marketFee(c.value) <= v.kasa)
    .sort((a, b) => b.value - a.value || a.flipNo - b.flipNo);
  if (!ok.length) return 0;
  const poorerRival = v.rivals.some((k) => k < v.kasa);
  if (ok.length > 1 && poorerRival && rng() < BOT_MARKET_DODGE[v.personality]) return ok[1]!.flipNo;
  return ok[0]!.flipNo;
}

export interface BotLoanInput {
  /** request: the other side wants to borrow from the bot · offer: the other side lends to the bot. */
  kind: LoanKind;
  amount: number;
  ratePct: number;
  myKasa: number;
  otherTaslik: boolean;
  /** The bot is the broke player in Son Şans. */
  meBroke: boolean;
  /** The other side is the broke player in Son Şans. */
  otherBroke: boolean;
}

/** Bot answer to an offer / request addressed to it. `roll` in [0, 1). */
export function botAcceptsLoan(v: BotLoanInput, roll: number): boolean {
  if (v.kind === "request") {
    if (v.amount > loanLimit(v.myKasa)) return false;
    if (v.otherBroke) return v.ratePct >= 10 && v.amount <= Math.floor(v.myKasa * 0.3) && roll < 0.6;
    return !v.otherTaslik && v.ratePct >= 20 && v.amount <= Math.floor(v.myKasa * 0.25);
  }
  if (v.meBroke) return true;
  return v.myKasa < 60 && v.ratePct <= 20;
}

/** Pay a debt off once the kasa is comfortably above it (more than twice the debt); otherwise keep the cash working. */
export function botRepayAmount(kasa: number, owed: number): number {
  return owed > 0 && kasa > 2 * owed ? owed : 0;
}

/**
 * Son Şans: lend the broke player a little at 30% for the drama, about half the time (rarely in a two-player
 * endgame, where lending only keeps the rival alive). null = stay out of it.
 */
export function botRescueLoan(rng: Rng, myKasa: number, playersLeft: number): { amount: number; ratePct: number } | null {
  const limit = loanLimit(myKasa);
  if (limit < LOAN_MIN) return null;
  if (rng() >= (playersLeft <= 2 ? 0.2 : 0.5)) return null;
  const amount = Math.min(limit, Math.max(LOAN_MIN, Math.min(30, Math.floor(myKasa * 0.15))));
  return { amount, ratePct: 30 };
}

/** Son Şans, the bot is broke: ask the richest possible lender for what their limit allows (≤ 30$) at 30%. */
export function botRescueRequest(lenders: readonly { id: string; kasa: number }[]): { toId: string; amount: number; ratePct: number } | null {
  let best: { id: string; kasa: number } | null = null;
  for (const l of lenders) if (loanLimit(l.kasa) >= LOAN_MIN && (!best || l.kasa > best.kasa)) best = l;
  if (!best) return null;
  return { toId: best.id, amount: Math.min(30, loanLimit(best.kasa)), ratePct: 30 };
}

/**
 * Heckle for a watcher with a bet (sent as TAUNT): "cash" (Kasala artık!) when they bet on Kasalar, "flip"
 * (Bir tane daha!) while their raid box can still win, null when it can't.
 */
export function botHeckle(box: BetBox, safeFlips: number): "flip" | "cash" | null {
  if (box === "cash") return "cash";
  return boxAlive(box, safeFlips) ? "flip" : null;
}
