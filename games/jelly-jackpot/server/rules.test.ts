// Unit tests for the pure game rules (server/rules.ts). Run: npx vitest run games/jelly-jackpot/server/rules

import { describe, expect, it } from "vitest";
import {
  BAG_PIECES,
  BET_PAYOUT,
  BET_STAKE,
  CARD_BY_ID,
  CARDS,
  RARITIES,
  RARITY_ODDS,
  RARITY_ODDS_TWO_PLAYERS,
  REEL_LENGTH,
  REEL_WIN_INDEX,
  SABOTEUR_ESCAPE_BONUS,
  VOTE_CORRECT_REWARD,
  TOPPLE_PENALTY,
  survivePayout,
  topplePenalty,
} from "../shared/constants.js";
import type { CardId, PieceType, Rarity } from "../shared/constants.js";
import {
  PieceBag,
  buildReel,
  createRng,
  describeRig,
  legalBetAmount,
  placementDelta,
  rarityOf,
  resolveVote,
  rollCard,
  rollCursed,
  settleBets,
  shuffle,
  standings,
} from "./rules.js";

const N = 100_000;

function rarityShares(players: number, seed: number): Record<Rarity, number> {
  const rng = createRng(seed);
  const counts: Record<Rarity, number> = { common: 0, uncommon: 0, rare: 0, legendary: 0, cursed: 0 };
  for (let i = 0; i < N; i++) counts[rarityOf(rollCard(rng, players))]++;
  for (const r of RARITIES) counts[r] = (counts[r] / N) * 100;
  return counts;
}

describe("createRng", () => {
  it("is deterministic per seed and in [0, 1)", () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const xs = Array.from({ length: 1000 }, () => a());
    const ys = Array.from({ length: 1000 }, () => b());
    expect(xs).toEqual(ys);
    expect(xs.some((x, i) => x !== Array.from({ length: 1000 }, () => c())[i])).toBe(true);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("has a roughly uniform mean", () => {
    const rng = createRng(7);
    let sum = 0;
    for (let i = 0; i < N; i++) sum += rng();
    expect(sum / N).toBeCloseTo(0.5, 2);
  });
});

describe("rollCard", () => {
  it("matches RARITY_ODDS over 100k rolls", () => {
    const shares = rarityShares(4, 1234);
    RARITIES.forEach((r, i) => expect(Math.abs(shares[r] - RARITY_ODDS[i]!)).toBeLessThan(0.7));
  });

  it("uses RARITY_ODDS_TWO_PLAYERS with 2 players", () => {
    const shares = rarityShares(2, 99);
    RARITIES.forEach((r, i) => expect(Math.abs(shares[r] - RARITY_ODDS_TWO_PLAYERS[i]!)).toBeLessThan(0.7));
    expect(shares.cursed).toBeGreaterThan(4);
    expect(shares.cursed).toBeLessThan(6);
  });

  it("rolls exactly the active CARDS (every one, never a retired card)", () => {
    const rng = createRng(5);
    const seen = new Set<CardId>();
    for (let i = 0; i < N; i++) seen.add(rollCard(rng, 3));
    expect([...seen].sort()).toEqual(CARDS.map((c) => c.id).sort());
    expect(seen.has("insurance")).toBe(false);
  });

  it("rollCursed always gives an active cursed card and covers all of them", () => {
    const rng = createRng(11);
    const cursed = CARDS.filter((c) => c.rarity === "cursed").map((c) => c.id);
    expect(cursed).toEqual(["bowlingBall"]);
    const seen = new Set<CardId>();
    for (let i = 0; i < 2000; i++) {
      const c = rollCursed(rng);
      expect(rarityOf(c)).toBe("cursed");
      seen.add(c);
    }
    expect([...seen].sort()).toEqual(cursed.sort());
  });
});

describe("buildReel", () => {
  it("has the right length with the winner at REEL_WIN_INDEX", () => {
    const rng = createRng(3);
    for (const win of Object.keys(CARD_BY_ID) as CardId[]) {
      const strip = buildReel(rng, win, 4);
      expect(strip).toHaveLength(REEL_LENGTH);
      expect(strip[REEL_WIN_INDEX]).toBe(win);
      for (const c of strip) expect(CARD_BY_ID[c]).toBeDefined();
    }
  });

  it("sometimes teases a Legendary right next to a non-Legendary winner", () => {
    const rng = createRng(8);
    let teased = 0;
    const trials = 2000;
    for (let i = 0; i < trials; i++) {
      const s = buildReel(rng, "plain", 4);
      if (rarityOf(s[REEL_WIN_INDEX - 1]!) === "legendary" || rarityOf(s[REEL_WIN_INDEX + 1]!) === "legendary") teased++;
    }
    // Teaser chance + natural legendary neighbours, but never every time.
    expect(teased / trials).toBeGreaterThan(0.3);
    expect(teased / trials).toBeLessThan(0.6);
  });
});

describe("shuffle", () => {
  it("returns a permutation without touching the input", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffle(createRng(1), input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...out].sort((a, b) => a - b)).toEqual(input);
  });
});

describe("PieceBag", () => {
  it("deals every bag piece before any repeat, bag after bag", () => {
    const bag = new PieceBag(createRng(2024));
    for (let round = 0; round < 10; round++) {
      const seen = new Set<PieceType>();
      for (let i = 0; i < BAG_PIECES.length; i++) seen.add(bag.next());
      expect(seen.size).toBe(BAG_PIECES.length);
    }
  });

  it("peek predicts next, including across a bag boundary", () => {
    const bag = new PieceBag(createRng(9));
    for (let i = 0; i < 100; i++) {
      const p = bag.peek();
      expect(bag.peek()).toBe(p);
      expect(bag.next()).toBe(p);
    }
  });

  it("never deals the same piece twice in a row", () => {
    const bag = new PieceBag(createRng(77));
    let prev = bag.next();
    for (let i = 0; i < 2000; i++) {
      const p = bag.next();
      expect(p).not.toBe(prev);
      prev = p;
    }
  });

  it("never deals card-only pieces", () => {
    const bag = new PieceBag(createRng(4));
    for (let i = 0; i < 200; i++) expect(BAG_PIECES).toContain(bag.next());
  });
});

describe("placementDelta", () => {
  it("pays the survive formula on stand", () => {
    expect(placementDelta("stand", 0, 1, 50, false)).toBe(10);
    expect(placementDelta("stand", 87, 2, 50, false)).toBe(survivePayout(87, 2));
    expect(placementDelta("stand", 87, 2, 50, false)).toBe(36);
    expect(placementDelta("stand", 30, 1.5, 0, true)).toBe(20);
  });

  it("charges the flat penalty on topple, whatever the multiplier", () => {
    expect(TOPPLE_PENALTY).toBe(5);
    for (const m of [1, 1.5, 2, 3, 5]) {
      expect(topplePenalty(m)).toBe(TOPPLE_PENALTY);
      expect(placementDelta("fall", 50, m, 100, false)).toBe(-TOPPLE_PENALTY);
    }
  });

  it("never takes coins below 0", () => {
    expect(placementDelta("fall", 50, 4, 3, false)).toBe(-3);
    expect(placementDelta("fall", 50, 4, 0, false) === 0).toBe(true);
    for (const coins of [0, 1, 5, 15, 39, 40, 41]) expect(coins + placementDelta("fall", 10, 4, coins, false)).toBeGreaterThanOrEqual(0);
  });

  it("insurance makes a topple free", () => {
    expect(placementDelta("fall", 50, 5, 100, true) === 0).toBe(true);
  });
});

describe("bets", () => {
  it("settles wins and losses with BET_PAYOUT math and drops 0 bets", () => {
    const res = settleBets(
      [
        { playerId: "a", side: "fall", amount: BET_STAKE },
        { playerId: "b", side: "stand", amount: BET_STAKE },
        { playerId: "c", side: "stand", amount: 0 },
      ],
      "fall",
    );
    expect(res).toEqual([
      { playerId: "a", side: "fall", amount: BET_STAKE, won: true, delta: BET_STAKE * (BET_PAYOUT - 1) },
      { playerId: "b", side: "stand", amount: BET_STAKE, won: false, delta: -BET_STAKE },
    ]);
    expect(settleBets([], "stand")).toEqual([]);
  });

  it("clamps to the largest legal affordable amount", () => {
    expect(BET_STAKE).toBe(10);
    expect(legalBetAmount(10, 100)).toBe(10);
    expect(legalBetAmount(10, 10)).toBe(10);
    expect(legalBetAmount(10, 9)).toBe(0);
    expect(legalBetAmount(9, 100)).toBe(0);
    expect(legalBetAmount(25, 100)).toBe(10);
    expect(legalBetAmount(999, 100)).toBe(10);
    expect(legalBetAmount(-5, 100)).toBe(0);
    expect(legalBetAmount(Number.NaN, 100)).toBe(0);
  });
});

describe("resolveVote", () => {
  it("catches the Saboteur on a strict majority and rewards correct voters", () => {
    const votes = new Map([
      ["a", "s"],
      ["b", "s"],
      ["c", "a"],
      ["s", "c"],
    ]);
    const out = resolveVote(votes, "s", 45);
    expect(out.majorityId).toBe("s");
    expect(out.caught).toBe(true);
    const rewarded = out.adjustments.filter((a) => a.delta > 0);
    expect(rewarded.map((a) => a.playerId).sort()).toEqual(["a", "b"]);
    for (const a of rewarded) expect(a.delta).toBe(VOTE_CORRECT_REWARD);
    expect(out.adjustments.filter((a) => a.playerId === "s").every((a) => a.delta === 0)).toBe(true);
    for (const a of out.adjustments) expect(a.reason.length).toBeGreaterThan(0);
  });

  it("lets the Saboteur escape on a wrong majority", () => {
    const out = resolveVote(new Map([["a", "b"], ["b", "a"], ["s", "b"]]), "s", 30);
    expect(out.majorityId).toBe("b");
    expect(out.caught).toBe(false);
    expect(out.adjustments).toEqual([{ playerId: "s", delta: 30 + SABOTEUR_ESCAPE_BONUS, reason: expect.any(String), key: "saboteurEscaped" }]);
  });

  it("treats a tie as not caught, even if the Saboteur is in the tie", () => {
    const out = resolveVote(new Map([["a", "s"], ["b", "s"], ["s", "a"], ["c", "a"]]), "s", 10);
    expect(out.majorityId).toBe("");
    expect(out.caught).toBe(false);
    expect(out.adjustments[0]!.delta).toBe(10 + SABOTEUR_ESCAPE_BONUS);
  });

  it("handles no votes and no Saboteur", () => {
    const none = resolveVote(new Map(), "s", 0);
    expect(none.majorityId).toBe("");
    expect(none.caught).toBe(false);
    expect(none.adjustments[0]!.delta).toBe(SABOTEUR_ESCAPE_BONUS);
    const noSab = resolveVote(new Map([["a", "b"]]), "", 0);
    expect(noSab).toEqual({ majorityId: "b", caught: false, adjustments: [] });
  });
});

describe("standings", () => {
  it("sorts by coins desc then survived desc, stable otherwise", () => {
    const ids = standings([
      { id: "a", coins: 100, survived: 2 },
      { id: "b", coins: 150, survived: 1 },
      { id: "c", coins: 100, survived: 5 },
      { id: "d", coins: 100, survived: 2 },
    ]);
    expect(ids).toEqual(["b", "c", "a", "d"]);
  });
});

describe("describeRig", () => {
  it("matches the design doc highlight format", () => {
    const s = describeRig({ round: 3, victimId: "x", card: "bowlingBall", outcome: "fall" }, "Deniz");
    expect(s).toContain("Rigged: Deniz's turn, round 3 → Bowling Ball 🎳");
    expect(s).toContain("FELL");
  });

  it("handles survivors, names ending in s, and blank names", () => {
    const s = describeRig({ round: 1, victimId: "x", card: "windStorm", outcome: "stand" }, "Chris");
    expect(s).toContain("Chris' turn");
    expect(s).toContain("SURVIVED");
    expect(describeRig({ round: 2, victimId: "x", card: "tiedHands", outcome: "fall" }, "  ")).toContain("Somebody's turn");
  });
});
