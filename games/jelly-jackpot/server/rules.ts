// Pure game rules: RNG, case rolls, reel strips, piece bag, scoring, bets, vote resolution.
// Owner: server-rules. SIGNATURES ARE THE CONTRACT; fill in the bodies. No Colyseus, no Rapier,
// no Date/Math.random inside (take an Rng) so everything is unit-testable (server/rules.test.ts).

import {
  BAG_PIECES,
  BET_AMOUNTS,
  BET_PAYOUT,
  CARD_BY_ID,
  CARDS,
  RARITIES,
  RARITY_ODDS,
  RARITY_ODDS_TWO_PLAYERS,
  REEL_LENGTH,
  REEL_WIN_INDEX,
  SABOTEUR_ESCAPE_BONUS,
  VOTE_CORRECT_REWARD,
  survivePayout,
  topplePenalty,
} from "../shared/constants.js";
import type { CardId, PieceType, Rarity } from "../shared/constants.js";
import type { BetResult, BetSide, CoinAdjustment, RigRecord } from "../shared/protocol.js";

export type Rng = () => number;

/** Chance that a non-Legendary winner gets a Legendary parked right next to it on the reel ("SO CLOSE!"). */
export const TEASER_CHANCE = 0.35;

// Card ids grouped by rarity, built once from the frozen card table.
const CARDS_BY_RARITY: Record<Rarity, CardId[]> = {
  common: [],
  uncommon: [],
  rare: [],
  legendary: [],
  cursed: [],
};
for (const c of CARDS) CARDS_BY_RARITY[c.rarity].push(c.id);

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
function randInt(rng: Rng, n: number): number {
  return Math.min(n - 1, Math.floor(rng() * n));
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[randInt(rng, items.length)]!;
}

/** Weighted rarity roll (percent table, index matches RARITIES). */
function rollRarity(rng: Rng, players: number): Rarity {
  const odds = players === 2 ? RARITY_ODDS_TWO_PLAYERS : RARITY_ODDS;
  const total = odds.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < RARITIES.length; i++) {
    r -= odds[i]!;
    if (r < 0) return RARITIES[i]!;
  }
  return RARITIES[RARITIES.length - 1]!;
}

/** Pick a rarity with RARITY_ODDS (or RARITY_ODDS_TWO_PLAYERS when players === 2), then a uniformly random card of it. */
export function rollCard(rng: Rng, players: number): CardId {
  return pick(rng, CARDS_BY_RARITY[rollRarity(rng, players)]);
}

/** A random Cursed card (the Saboteur's rig). */
export function rollCursed(rng: Rng): CardId {
  return pick(rng, CARDS_BY_RARITY.cursed);
}

/** REEL_LENGTH cards for the reel animation, weighted like rollCard, with strip[REEL_WIN_INDEX] === win. Put a teasing Legendary right next to the winner sometimes. */
export function buildReel(rng: Rng, win: CardId, players: number): CardId[] {
  const strip: CardId[] = [];
  for (let i = 0; i < REEL_LENGTH; i++) strip.push(rollCard(rng, players));
  strip[REEL_WIN_INDEX] = win;
  // The near-miss: a shiny Legendary one slot past (or before) the winner. Pure heartbreak.
  if (rarityOf(win) !== "legendary" && rng() < TEASER_CHANCE) {
    const side = rng() < 0.65 ? 1 : -1;
    const idx = REEL_WIN_INDEX + side;
    if (idx >= 0 && idx < REEL_LENGTH) strip[idx] = pick(rng, CARDS_BY_RARITY.legendary);
  }
  return strip;
}

export function rarityOf(card: CardId): Rarity {
  const def = CARD_BY_ID[card];
  if (!def) throw new Error(`Unknown card: ${card}`);
  return def.rarity;
}

/** Shuffled bag: every BAG_PIECES entry once before any repeats. */
export class PieceBag {
  private readonly rng: Rng;
  private queue: PieceType[] = [];
  private last: PieceType | null = null;

  constructor(rng: Rng) {
    this.rng = rng;
    this.refill();
  }

  /** Take the next piece. */
  next(): PieceType {
    if (this.queue.length === 0) this.refill();
    const piece = this.queue.shift()!;
    this.last = piece;
    if (this.queue.length === 0) this.refill();
    return piece;
  }

  /** Look at the piece next() will return, without taking it. */
  peek(): PieceType {
    if (this.queue.length === 0) this.refill();
    return this.queue[0]!;
  }

  // New shuffled bag; avoid the same piece twice in a row across the bag boundary.
  private refill(): void {
    const bag = shuffle(this.rng, BAG_PIECES);
    if (this.last !== null && bag[0] === this.last && bag.length > 1) {
      const j = 1 + randInt(this.rng, bag.length - 1);
      [bag[0], bag[j]] = [bag[j]!, bag[0]!];
    }
    this.queue.push(...bag);
  }
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

/** Coin change for the active player. Topple can't take coins below 0 (pass current coins). Insurance → 0 on topple. */
export function placementDelta(outcome: BetSide, heightCm: number, multiplier: number, coins: number, insured: boolean): number {
  if (outcome === "stand") return survivePayout(Math.max(0, heightCm), multiplier);
  if (insured) return 0;
  return -Math.min(Math.max(0, coins), topplePenalty(multiplier));
}

export interface PendingBet {
  playerId: string;
  side: BetSide;
  amount: number;
}

/** Settle side bets (amount 0 entries are dropped). A win nets +amount*(BET_PAYOUT-1); a loss -amount. */
export function settleBets(bets: PendingBet[], outcome: BetSide): BetResult[] {
  return bets
    .filter((b) => b.amount > 0)
    .map((b) => {
      const won = b.side === outcome;
      return { playerId: b.playerId, side: b.side, amount: b.amount, won, delta: won ? b.amount * (BET_PAYOUT - 1) : -b.amount };
    });
}

/** Clamp a bet to a legal BET_AMOUNTS value the player can afford (largest affordable ≤ requested), or 0. */
export function legalBetAmount(requested: number, coins: number): number {
  if (!Number.isFinite(requested) || !Number.isFinite(coins)) return 0;
  let best = 0;
  for (const a of BET_AMOUNTS) if (a <= requested && a <= coins && a > best) best = a;
  return best;
}

export interface VoteOutcome {
  /** Most-voted id, "" on a tie or no votes. */
  majorityId: string;
  caught: boolean;
  adjustments: CoinAdjustment[];
}

/** English adjustment reasons, keyed like client/src/i18n/strings/server.ts. caught1..4 rotate among voters. */
export const ADJUST_EN = {
  caught1: "Sniffed out the Saboteur 🕵️",
  caught2: "Smelled the burnt cake 👃",
  caught3: "Detective Pâtissier 🔎",
  caught4: "Pointed the spatula of justice 🍳",
  saboteurCaught: "Caught red-handed! Bonus confiscated 🚔",
  saboteurEscaped: "Got away with it! Muahaha 😈",
} as const;
const CAUGHT_KEYS = ["caught1", "caught2", "caught3", "caught4"] as const;

/**
 * Resolve the accusation vote. votes: voterId → suspectId. If majorityId === saboteurId (strict
 * plurality, ties = not caught): every voter who picked the Saboteur gets +VOTE_CORRECT_REWARD, the
 * Saboteur gets nothing extra (hidden bonus forfeited). Otherwise the Saboteur gets hiddenBonus +
 * SABOTEUR_ESCAPE_BONUS. Adjustment reasons are short funny strings for the reveal screen.
 */
export function resolveVote(votes: Map<string, string>, saboteurId: string, hiddenBonus: number): VoteOutcome {
  const tally = new Map<string, number>();
  for (const suspect of votes.values()) {
    if (!suspect) continue;
    tally.set(suspect, (tally.get(suspect) ?? 0) + 1);
  }
  let majorityId = "";
  let best = 0;
  let tied = false;
  for (const [id, n] of tally) {
    if (n > best) {
      best = n;
      majorityId = id;
      tied = false;
    } else if (n === best) {
      tied = true;
    }
  }
  if (tied) majorityId = "";

  // No Saboteur this match: nothing to win or lose.
  if (!saboteurId) return { majorityId, caught: false, adjustments: [] };

  const caught = majorityId !== "" && majorityId === saboteurId;
  const adjustments: CoinAdjustment[] = [];
  if (caught) {
    let k = 0;
    for (const [voterId, suspect] of votes) {
      if (suspect !== saboteurId || voterId === saboteurId) continue;
      const key = CAUGHT_KEYS[k++ % CAUGHT_KEYS.length]!;
      adjustments.push({ playerId: voterId, delta: VOTE_CORRECT_REWARD, reason: ADJUST_EN[key], key });
    }
    if (hiddenBonus > 0) adjustments.push({ playerId: saboteurId, delta: 0, reason: ADJUST_EN.saboteurCaught, key: "saboteurCaught" });
  } else {
    const delta = Math.max(0, hiddenBonus) + SABOTEUR_ESCAPE_BONUS;
    adjustments.push({ playerId: saboteurId, delta, reason: ADJUST_EN.saboteurEscaped, key: "saboteurEscaped" });
  }
  return { majorityId, caught, adjustments };
}

/** Final standings: coins desc, then stats.survived desc. Returns ids in order. */
export function standings(players: { id: string; coins: number; survived: number }[]): string[] {
  return players
    .map((p, i) => ({ ...p, i }))
    .sort((a, b) => b.coins - a.coins || b.survived - a.survived || a.i - b.i)
    .map((p) => p.id);
}

/** Human-readable highlight for the reveal list, e.g. "Rigged: Deniz's turn, round 3 → Bowling Ball 🎳 (FELL)". */
export function describeRig(rig: RigRecord, nickname: string): string {
  const card = CARD_BY_ID[rig.card];
  const cardText = card ? `${card.name} ${card.emoji}` : rig.card;
  const who = nickname.trim() || "Somebody";
  const possessive = /s$/i.test(who) ? `${who}'` : `${who}'s`;
  const result = rig.outcome === "fall" ? "FELL 💥" : "SURVIVED?! 😤";
  return `Rigged: ${possessive} turn, round ${rig.round} → ${cardText} (${result})`;
}
