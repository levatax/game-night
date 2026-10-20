// Unit tests for the pure KASALA! rules (server/rules.ts). Run: npx vitest run games/kasala/server/rules

import { describe, expect, it } from "vitest";
import {
  BET_BOXES,
  BOT_NAMES,
  CARD_BY_ID,
  CHIP_AMOUNTS,
  CARDS,
  GHOST_RETURN_KASA,
  GHOST_WINS_TO_RETURN,
  RAID_MAX_CHANCE,
  WHEEL_SLICES,
  boxAlive,
  boxWins,
  raidChance,
} from "../shared/constants.js";
import type { BetBox, CardId, WheelSliceId } from "../shared/constants.js";
import {
  BOT_MAX_FLIPS,
  BOT_PERSONALITY_BY_INDEX,
  MAX_WHEEL_SPINS,
  applyInterest,
  applyWheel,
  betPayout,
  betsLineEvent,
  botAcceptsLoan,
  botBet,
  botBetBox,
  botHeckle,
  botRepayAmount,
  botRescueLoan,
  botRescueRequest,
  botShouldFlip,
  botTarget,
  cardGainEV,
  collectDebts,
  createRng,
  cutByLender,
  ghostAfterWin,
  haracAmount,
  haracTuruPayments,
  isEarlyCash,
  isTaslik,
  loanLimit,
  moneyValue,
  nextInOrder,
  raidBribe,
  randomTarget,
  rollCard,
  rollFlip,
  rollWheel,
  settleBets,
  shameTitles,
  shuffle,
  shuffleKasas,
  sirenAfter,
  standings,
  taslikCut,
  type BotFlipInput,
  type BotPersonality,
  type PendingBet,
  type TitleInput,
} from "./rules.js";

const pct = (x: number) => Math.round(x * 100);

describe("createRng", () => {
  it("is deterministic per seed and stays in [0, 1)", () => {
    const a = createRng(7);
    const b = createRng(7);
    const c = createRng(8);
    const xs = Array.from({ length: 2000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 2000 }, () => b()));
    expect(xs).not.toEqual(Array.from({ length: 2000 }, () => c()));
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.47);
    expect(mean).toBeLessThan(0.53);
  });

  it("shuffle is a permutation", () => {
    const rng = createRng(3);
    const items = [1, 2, 3, 4, 5, 6];
    for (let i = 0; i < 50; i++) expect(shuffle(rng, items).sort()).toEqual(items);
  });
});

describe("§5 siren", () => {
  it("matches the raid chance table per card (8, 15, 22, 29, 36, 43, 50%) and the survival column", () => {
    const chances = [8, 15, 22, 29, 36, 43, 50];
    const survive = [92, 78, 61, 43, 28, 16, 8];
    let alive = 1;
    for (let card = 1; card <= 7; card++) {
      const level = card - 1;
      expect(pct(raidChance(level))).toBe(chances[card - 1]);
      alive *= 1 - raidChance(level);
      expect(pct(alive)).toBe(survive[card - 1]);
    }
  });

  it("caps at 95% and adds the Battle Royale floor", () => {
    expect(raidChance(50)).toBe(RAID_MAX_CHANCE);
    expect(pct(raidChance(0, 0.04))).toBe(12);
    expect(raidChance(-3)).toBeCloseTo(0.08);
  });

  it("rises by one per flip; Rüşvet Zarfı drops it by two (floored at 0)", () => {
    expect(sirenAfter(0, "tomar")).toBe(1);
    expect(sirenAfter(4, "baskin")).toBe(5);
    expect(sirenAfter(0, "rusvet")).toBe(0);
    expect(sirenAfter(1, "rusvet")).toBe(0);
    expect(sirenAfter(3, "rusvet")).toBe(2);
    // Tuzak start (level 2) → first card 22%.
    expect(pct(raidChance(2))).toBe(22);
  });

  it("rolls a raid with the siren probability", () => {
    const rng = createRng(11);
    expect(Array.from({ length: 500 }, () => rollFlip(rng, 0)).includes("baskin")).toBe(false);
    expect(Array.from({ length: 200 }, () => rollFlip(rng, 1)).every((c) => c === "baskin")).toBe(true);
    for (const level of [0, 3, 6]) {
      const p = raidChance(level);
      let raids = 0;
      const n = 40_000;
      for (let i = 0; i < n; i++) if (rollFlip(rng, p) === "baskin") raids++;
      expect(Math.abs(raids / n - p)).toBeLessThan(0.01);
    }
  });
});

describe("§6 cards", () => {
  it("weights sum to 100 and the distribution follows them", () => {
    const drawable = CARDS.filter((c) => c.weight > 0);
    expect(drawable.reduce((s, c) => s + c.weight, 0)).toBe(100);
    const rng = createRng(2024);
    const n = 200_000;
    const counts = new Map<CardId, number>();
    for (let i = 0; i < n; i++) {
      const id = rollCard(rng);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(counts.has("baskin")).toBe(false);
    for (const c of drawable) {
      const share = ((counts.get(c.id) ?? 0) / n) * 100;
      expect(Math.abs(share - c.weight)).toBeLessThan(Math.max(0.35, c.weight * 0.05));
    }
  });

  it("money values: SON MASA doubles, Lanet zeroes, other cards add nothing", () => {
    expect(moneyValue("bozukluk", false)).toBe(10);
    expect(moneyValue("tomar", false)).toBe(25);
    expect(moneyValue("canta", true)).toBe(100);
    expect(moneyValue("kulce", true)).toBe(200);
    expect(moneyValue("kulce", false, true)).toBe(0);
    expect(moneyValue("aklama", false)).toBe(0);
    expect(moneyValue("baskin", true)).toBe(0);
  });

  it("raid bribe: classic 10% (×2 at SON MASA), royale round × 20$, never more than the kasa", () => {
    expect(raidBribe("classic", 345, 3, false)).toBe(34);
    expect(raidBribe("classic", 345, 3, true)).toBe(69);
    expect(raidBribe("classic", 9, 1, false)).toBe(0);
    expect(raidBribe("classic", 0, 1, true)).toBe(0);
    expect(raidBribe("royale", 150, 1, false)).toBe(20);
    expect(raidBribe("royale", 150, 5, false)).toBe(100);
    expect(raidBribe("royale", 30, 3, false)).toBe(30);
    expect(raidBribe("royale", 0, 3, false)).toBe(0);
  });

  it("Haraç takes 20% (floored), Haraç Turu 10$ or whatever is left", () => {
    expect(haracAmount(200)).toBe(40);
    expect(haracAmount(57)).toBe(11);
    expect(haracAmount(0)).toBe(0);
    expect(
      haracTuruPayments([
        { id: "a", kasa: 200 },
        { id: "b", kasa: 4 },
        { id: "c", kasa: 0 },
      ]),
    ).toEqual([
      { playerId: "a", amount: 10 },
      { playerId: "b", amount: 4 },
      { playerId: "c", amount: 0 },
    ]);
  });

  it("Tuzak hits the next eligible player in turn order; random targets come from the candidates", () => {
    const order = ["a", "b", "c", "d"];
    expect(nextInOrder(order, "b", () => true)).toBe("c");
    expect(nextInOrder(order, "d", () => true)).toBe("a");
    expect(nextInOrder(order, "a", (id) => id !== "b")).toBe("c");
    expect(nextInOrder(order, "a", () => false)).toBe("");
    expect(nextInOrder(["a", "b"], "a", () => true)).toBe("b");
    const rng = createRng(5);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(randomTarget(rng, ["x", "y", "z"]));
    expect([...seen].sort()).toEqual(["x", "y", "z"]);
    expect(randomTarget(rng, [])).toBe("");
  });
});

describe("§7 wheel", () => {
  it("rolls slices by weight; BİR DAHA! can be excluded", () => {
    expect(WHEEL_SLICES.reduce((s, w) => s + w.weight, 0)).toBe(100);
    const rng = createRng(77);
    const n = 100_000;
    const counts = new Map<WheelSliceId, number>();
    for (let i = 0; i < n; i++) {
      const id = rollWheel(rng);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const s of WHEEL_SLICES) expect(Math.abs(((counts.get(s.id) ?? 0) / n) * 100 - s.weight)).toBeLessThan(0.8);
    for (let i = 0; i < 2000; i++) expect(rollWheel(rng, false)).not.toBe("birDaha");
    expect(MAX_WHEEL_SPINS).toBeGreaterThanOrEqual(2);
  });

  const base = { activeId: "a", order: ["a", "b", "c"], kasas: { a: 120, b: 35, c: 0 }, kumbara: 340, pot: 75 };

  it("applies every slice as §7 says", () => {
    const rng = createRng(1);
    const kumbara = applyWheel(rng, { ...base, slice: "kumbara" });
    expect(kumbara.kasas.a).toBe(460);
    expect(kumbara.kumbara).toBe(0);
    expect(kumbara.kumbaraDelta).toBe(-340);
    expect(kumbara.deltas).toEqual([{ playerId: "a", delta: 340 }]);

    const x10 = applyWheel(rng, { ...base, slice: "x10" });
    expect(x10.pot).toBe(750);
    expect(x10.deltas).toEqual([]);

    const gift = applyWheel(rng, { ...base, slice: "herkese100" });
    expect(gift.kasas).toEqual({ a: 220, b: 135, c: 100 });

    const pay = applyWheel(rng, { ...base, slice: "herkeseOde" });
    expect(pay.kasas).toEqual({ a: 20, b: 85, c: 50 });
    const poor = applyWheel(rng, { ...base, kasas: { a: 70, b: 0, c: 0 }, slice: "herkeseOde" });
    expect(poor.kasas).toEqual({ a: 0, b: 50, c: 20 });

    const raid = applyWheel(rng, { ...base, slice: "topluBaskin" });
    expect(raid.kasas).toEqual({ a: 108, b: 32, c: 0 });
    expect(raid.kumbara).toBe(355);
    expect(raid.kumbaraDelta).toBe(15);

    expect(applyWheel(rng, { ...base, slice: "avukat" }).lawyer).toBe(true);
    expect(applyWheel(rng, { ...base, slice: "birDaha" }).again).toBe(true);

    const mix = applyWheel(rng, { ...base, slice: "karistir" });
    expect(Object.values(mix.kasas).sort((x, y) => x - y)).toEqual([0, 35, 120]);
    expect(mix.kasas).not.toEqual(base.kasas);
  });

  it("never makes a kasa, the kumbara or the pot negative", () => {
    const rng = createRng(99);
    const slices = WHEEL_SLICES.map((s) => s.id);
    for (let i = 0; i < 5000; i++) {
      const n = 2 + Math.floor(rng() * 5);
      const order = Array.from({ length: n }, (_, k) => `p${k}`);
      const kasas: Record<string, number> = {};
      for (const id of order) kasas[id] = rng() < 0.3 ? 0 : Math.floor(rng() * 600);
      const slice = slices[Math.floor(rng() * slices.length)]!;
      const out = applyWheel(rng, {
        slice,
        activeId: order[Math.floor(rng() * n)]!,
        order,
        kasas,
        kumbara: Math.floor(rng() * 500),
        pot: Math.floor(rng() * 300),
      });
      for (const id of order) expect(out.kasas[id]).toBeGreaterThanOrEqual(0);
      expect(out.kumbara).toBeGreaterThanOrEqual(0);
      expect(out.pot).toBeGreaterThanOrEqual(0);
      for (const d of out.deltas) expect(out.kasas[d.playerId]! - d.delta).toBe(kasas[d.playerId]);
    }
  });

  it("KASALARI KARIŞTIR moves at least one kasa when they differ", () => {
    const rng = createRng(4);
    for (let i = 0; i < 300; i++) {
      const values = [10, 20, 30, 40].slice(0, 2 + (i % 3));
      const out = shuffleKasas(rng, values);
      expect(out.slice().sort((a, b) => a - b)).toEqual(values);
      expect(out).not.toEqual(values);
    }
    expect(shuffleKasas(rng, [5])).toEqual([5]);
  });
});

describe("§8 side bets", () => {
  it("box outcomes", () => {
    const raidAt = (raidFlip: number) => ({ raided: true, raidFlip });
    const cashed = { raided: false, raidFlip: 0 };
    const table: [BetBox, number | null, boolean][] = [
      ["b12", 1, true],
      ["b12", 2, true],
      ["b12", 3, false],
      ["b34", 3, true],
      ["b34", 4, true],
      ["b34", 2, false],
      ["b34", 5, false],
      ["b5p", 5, true],
      ["b5p", 9, true],
      ["b5p", 4, false],
      ["cash", null, true],
      ["cash", 1, false],
      ["b12", null, false],
      ["b5p", null, false],
    ];
    for (const [box, flip, wins] of table) expect(boxWins(box, flip === null ? cashed : raidAt(flip))).toBe(wins);
    expect(boxAlive("b12", 1)).toBe(true);
    expect(boxAlive("b12", 2)).toBe(false);
    expect(boxAlive("b34", 4)).toBe(false);
    expect(boxAlive("b5p", 12)).toBe(true);
  });

  it("payouts: ×4 / ×4 / ×10 / ×1.5 (floored), doubled at SON MASA", () => {
    expect(betPayout("b12", 25, false)).toBe(100);
    expect(betPayout("b34", 10, false)).toBe(40);
    expect(betPayout("b5p", 50, false)).toBe(500);
    expect(betPayout("cash", 10, false)).toBe(15);
    expect(betPayout("cash", 25, false)).toBe(37);
    expect(betPayout("cash", 50, true)).toBe(150);
    expect(betPayout("b5p", 10, true)).toBe(200);
  });

  it("settles winners, the house cut and the kumbara share; ghosts move no money", () => {
    const bets: PendingBet[] = [
      { playerId: "a", box: "b34", amount: 25, ghost: false },
      { playerId: "b", box: "cash", amount: 50, ghost: false },
      { playerId: "c", box: "b12", amount: 10, ghost: false },
      { playerId: "d", box: "b5p", amount: 25, ghost: false },
      { playerId: "g", box: "b34", amount: 10, ghost: true },
      { playerId: "h", box: "cash", amount: 10, ghost: true },
    ];
    const r = settleBets(bets, { raided: true, raidFlip: 3 }, false);
    const by = Object.fromEntries(r.results.map((x) => [x.playerId, x]));
    expect(by.a).toMatchObject({ won: true, delta: 100 });
    expect(by.b).toMatchObject({ won: false, delta: 0 });
    expect(by.c).toMatchObject({ won: false, delta: 0 });
    expect(by.d).toMatchObject({ won: false, delta: 0 });
    expect(by.g).toMatchObject({ won: true, delta: 0, ghost: true });
    expect(by.h).toMatchObject({ won: false, delta: 0, ghost: true });
    // Losing real stakes 50 + 10 + 25 = 85: 10% (8) to the active player, 77 to the kumbara.
    expect(r.houseCut).toBe(8);
    expect(r.toKumbara).toBe(77);

    const final = settleBets(bets, { raided: false, raidFlip: 0 }, true);
    expect(final.results.find((x) => x.playerId === "b")!.delta).toBe(150);
    expect(final.houseCut + final.toKumbara).toBe(25 + 10 + 25);
    expect(final.houseCut).toBe(6);
    expect(settleBets([{ playerId: "z", box: "cash", amount: 0, ghost: false }], { raided: false, raidFlip: 0 }, false).results).toEqual([]);
  });

  it("picks the settlement line", () => {
    const mk = (box: BetBox, won: boolean) => ({ playerId: "x", box, amount: 10, won, delta: 0, ghost: false });
    expect(betsLineEvent([mk("b12", true), mk("b34", false), mk("b12", true)])).toBe("betsRaidersWon");
    expect(betsLineEvent([mk("cash", false), mk("cash", false), mk("b5p", false)])).toBe("betsCashLost");
    expect(betsLineEvent([mk("cash", true), mk("b12", false)])).toBe("betsSettled");
    expect(betsLineEvent([])).toBe("betsSettled");
  });

  it("box odds and returns are in the §8 ballpark (simulated, stopping at 2–6 cards)", () => {
    const rng = createRng(8080);
    const n = 120_000;
    const wins: Record<BetBox, number> = { b12: 0, b34: 0, b5p: 0, cash: 0 };
    for (let i = 0; i < n; i++) {
      const stop = 2 + Math.floor(rng() * 5);
      let level = 0;
      let lawyers = 0;
      let flips = 0;
      let raidFlip = 0;
      while (flips < stop) {
        const card = rollFlip(rng, raidChance(level));
        flips++;
        level = sirenAfter(level, card);
        if (card === "avukat") lawyers++;
        if (card === "baskin") {
          if (lawyers > 0) lawyers--;
          else {
            raidFlip = flips;
            break;
          }
        }
      }
      for (const b of BET_BOXES) if (boxWins(b.id, { raided: raidFlip > 0, raidFlip })) wins[b.id]++;
    }
    const p = (box: BetBox) => wins[box] / n;
    expect(p("b12")).toBeGreaterThan(0.17);
    expect(p("b12")).toBeLessThan(0.25);
    expect(p("b34")).toBeGreaterThan(0.17);
    expect(p("b34")).toBeLessThan(0.25);
    expect(p("b5p")).toBeGreaterThan(0.05);
    expect(p("b5p")).toBeLessThan(0.11);
    expect(p("cash")).toBeGreaterThan(0.45);
    expect(p("cash")).toBeLessThan(0.58);
    for (const b of BET_BOXES) {
      const ev = p(b.id) * b.payout;
      expect(ev).toBeGreaterThan(0.55);
      expect(ev).toBeLessThan(1);
    }
  });

  it("ghosts come back after 3 correct predictions, once per match", () => {
    let wins = 0;
    let back = false;
    for (let i = 1; i <= GHOST_WINS_TO_RETURN; i++) {
      const g = ghostAfterWin(wins, false);
      wins = g.ghostWins;
      back = g.returns;
    }
    expect(wins).toBe(GHOST_WINS_TO_RETURN);
    expect(back).toBe(true);
    expect(ghostAfterWin(1, false).returns).toBe(false);
    expect(ghostAfterWin(GHOST_WINS_TO_RETURN - 1, true).returns).toBe(false);
    expect(GHOST_RETURN_KASA).toBe(50);
  });
});

describe("§9 loans", () => {
  it("limit is half the kasa", () => {
    expect(loanLimit(200)).toBe(100);
    expect(loanLimit(75)).toBe(37);
    expect(loanLimit(0)).toBe(0);
  });

  it("interest rounds up per full round without float drift", () => {
    expect(applyInterest(100, 10)).toBe(110);
    expect(applyInterest(100, 20)).toBe(120);
    expect(applyInterest(100, 30)).toBe(130);
    expect(applyInterest(40, 20)).toBe(48);
    expect(applyInterest(7, 10)).toBe(8);
    expect(applyInterest(55, 30)).toBe(72);
    expect(applyInterest(0, 30)).toBe(0);
    // §3: "Bana 100$ ver" at 20% → three rounds later it's ~170$.
    let owed = 100;
    for (let r = 0; r < 3; r++) owed = applyInterest(owed, 20);
    expect(owed).toBe(173);
  });

  it("Taşlık = total debt above the kasa", () => {
    expect(isTaslik(100, 101)).toBe(true);
    expect(isTaslik(100, 100)).toBe(false);
    expect(isTaslik(0, 0)).toBe(false);
    expect(isTaslik(0, 10)).toBe(true);
  });

  it("Taşlık cut pays half the pot to creditors, largest debt first", () => {
    const debts = [
      { id: "d1", lenderId: "x", borrowerId: "me", owed: 30 },
      { id: "d2", lenderId: "y", borrowerId: "me", owed: 50 },
      { id: "d3", lenderId: "x", borrowerId: "me", owed: 15 },
    ];
    const small = taslikCut(100, debts);
    expect(small.payments).toEqual([{ debtId: "d2", lenderId: "y", amount: 50 }]);
    expect(small.kept).toBe(50);

    const big = taslikCut(250, debts);
    expect(big.payments).toEqual([
      { debtId: "d2", lenderId: "y", amount: 50 },
      { debtId: "d1", lenderId: "x", amount: 30 },
      { debtId: "d3", lenderId: "x", amount: 15 },
    ]);
    expect(big.kept).toBe(155);
    expect(cutByLender(big.payments)).toEqual([
      { lenderId: "y", amount: 50 },
      { lenderId: "x", amount: 45 },
    ]);
    expect(taslikCut(75, [{ id: "d1", lenderId: "x", borrowerId: "me", owed: 100 }])).toEqual({
      payments: [{ debtId: "d1", lenderId: "x", amount: 37 }],
      kept: 38,
    });
    expect(taslikCut(0, debts)).toEqual({ payments: [], kept: 0 });
  });

  it("match-end collection pays what it can, wipes the rest and blacklists", () => {
    const r = collectDebts(
      [
        { id: "d1", lenderId: "a", borrowerId: "b", owed: 80 },
        { id: "d2", lenderId: "b", borrowerId: "c", owed: 60 },
        { id: "d3", lenderId: "a", borrowerId: "c", owed: 50 },
      ],
      { a: 10, b: 30, c: 70 },
    );
    expect(r.collections).toEqual([
      { debtId: "d1", lenderId: "a", borrowerId: "b", paid: 30, wiped: 50 },
      { debtId: "d2", lenderId: "b", borrowerId: "c", paid: 60, wiped: 0 },
      { debtId: "d3", lenderId: "a", borrowerId: "c", paid: 10, wiped: 40 },
    ]);
    expect(r.kasas).toEqual({ a: 50, b: 60, c: 0 });
    expect(r.karaListe).toEqual(["b", "c"]);
    for (const v of Object.values(r.kasas)) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe("§10 / §16 standings and titles", () => {
  it("classic: kasa desc, ties → fewer raids, then seat", () => {
    const st = standings("classic", [
      { id: "a", kasa: 300, raids: 2, seat: 0, ghost: false, elimIndex: 0 },
      { id: "b", kasa: 300, raids: 1, seat: 1, ghost: false, elimIndex: 0 },
      { id: "c", kasa: 500, raids: 4, seat: 2, ghost: false, elimIndex: 0 },
      { id: "d", kasa: 300, raids: 1, seat: 3, ghost: false, elimIndex: 0 },
    ]);
    expect(st.map((x) => x.playerId)).toEqual(["c", "b", "d", "a"]);
    expect(st.map((x) => x.place)).toEqual([1, 2, 3, 4]);
  });

  it("royale: survivors by kasa, then ghosts latest-eliminated first", () => {
    const st = standings("royale", [
      { id: "a", kasa: 0, raids: 3, seat: 0, ghost: true, elimIndex: 1 },
      { id: "b", kasa: 40, raids: 1, seat: 1, ghost: false, elimIndex: 0 },
      { id: "c", kasa: 0, raids: 2, seat: 2, ghost: true, elimIndex: 2 },
      { id: "d", kasa: 90, raids: 0, seat: 3, ghost: false, elimIndex: 3 },
    ]);
    expect(st.map((x) => x.playerId)).toEqual(["d", "b", "c", "a"]);
  });

  const stats = (o: Partial<TitleInput["stats"]>): TitleInput["stats"] => ({
    raids: 0,
    borrowed: 0,
    earlyCashes: 0,
    betProfit: 0,
    betsWon: 0,
    betsLost: 0,
    maxFlips: 0,
    ...o,
  });

  it("titles are only given when earned, in TITLES order", () => {
    expect(
      shameTitles([
        { id: "a", place: 1, stats: stats({ maxFlips: 3, betProfit: -20, betsLost: 1 }), karaListe: false, wiped: 0 },
        { id: "b", place: 2, stats: stats({}), karaListe: false, wiped: 0 },
      ]),
    ).toEqual([]);

    const titles = shameTitles([
      { id: "a", place: 1, stats: stats({ raids: 2, borrowed: 100, earlyCashes: 1, betProfit: 40, betsWon: 2, maxFlips: 7 }), karaListe: false, wiped: 0 },
      { id: "b", place: 3, stats: stats({ raids: 2, earlyCashes: 3, betProfit: -60, betsLost: 3, maxFlips: 4 }), karaListe: true, wiped: 25 },
      { id: "c", place: 2, stats: stats({ raids: 1, borrowed: 150, betProfit: -80, betsWon: 1, betsLost: 2, maxFlips: 2 }), karaListe: true, wiped: 70 },
    ]);
    expect(titles).toEqual([
      { title: "bombaMiknatisi", playerId: "b", value: 2 }, // tie on raids → the worse place
      { title: "borcKrali", playerId: "c", value: 150 },
      { title: "korkak", playerId: "b", value: 3 },
      { title: "korBahisci", playerId: "c", value: -80 },
      { title: "karaListe", playerId: "c", value: 70 },
      { title: "gozuKara", playerId: "a", value: 7 },
    ]);
  });

  it("early cash = a voluntary KASALA after 1–2 cards (a 0-card KASALA isn't one: it is refused)", () => {
    expect(isEarlyCash(0, false)).toBe(false);
    expect(isEarlyCash(1, false)).toBe(true);
    expect(isEarlyCash(2, false)).toBe(true);
    expect(isEarlyCash(3, false)).toBe(false);
    expect(isEarlyCash(1, true)).toBe(false);
  });
});

describe("card table sanity", () => {
  it("every card id resolves and only the raid is undrawable", () => {
    for (const c of CARDS) expect(CARD_BY_ID[c.id]).toBe(c);
    expect(CARDS.filter((c) => c.weight === 0).map((c) => c.id)).toEqual(["baskin"]);
  });
});

describe("bots", () => {
  const base: BotFlipInput = {
    personality: "dengeli",
    flips: 1,
    pot: 20,
    raidChance: raidChance(1),
    bribe: 20,
    lawyers: 0,
    finalTable: false,
    behindBy: 0,
    raidStakeShare: 0,
  };
  /** Cards a bot turns on a steady table (every card +20$, no raid) before it stops, at mid jitter. */
  const stopAfter = (personality: BotPersonality, extra: Partial<BotFlipInput> = {}): number => {
    let flips = 0;
    let pot = 0;
    while (botShouldFlip({ ...base, ...extra, personality, flips, pot, raidChance: raidChance(flips) }, 0.5)) {
      flips++;
      pot += 20;
      if (flips > 20) break;
    }
    return flips;
  };

  it("always flips the first card and never past BOT_MAX_FLIPS", () => {
    for (const personality of ["korkak", "dengeli", "gozuKara"] as const) {
      expect(botShouldFlip({ ...base, personality, flips: 0, pot: 0, raidChance: 0.95 }, 0)).toBe(true);
      expect(botShouldFlip({ ...base, personality, flips: BOT_MAX_FLIPS, raidChance: 0, lawyers: 3 }, 0.99)).toBe(false);
    }
  });

  it("stop rule: korkak stops first, gözü kara last, all within a sane range", () => {
    const k = stopAfter("korkak");
    const d = stopAfter("dengeli");
    const g = stopAfter("gozuKara");
    expect(k).toBeLessThan(d);
    expect(d).toBeLessThan(g);
    expect(k).toBeGreaterThanOrEqual(1);
    expect(g).toBeLessThanOrEqual(7);
  });

  it("weighs the expected gain against pot + bribe", () => {
    expect(cardGainEV(0, false)).toBe(20);
    expect(cardGainEV(100, true)).toBe(48);
    // A fat pot at a hot siren: cash. A lawyer makes the next card free: flip.
    const hot = { ...base, flips: 4, pot: 200, raidChance: 0.36 };
    expect(botShouldFlip(hot, 0.99)).toBe(false);
    expect(botShouldFlip({ ...hot, lawyers: 1 }, 0)).toBe(true);
    // Trailing the leader at SON MASA pushes harder; a table betting on a raid makes it stop earlier.
    expect(stopAfter("dengeli", { behindBy: 300, finalTable: true })).toBeGreaterThan(stopAfter("dengeli"));
    expect(stopAfter("gozuKara", { raidStakeShare: 1 })).toBeLessThanOrEqual(stopAfter("gozuKara"));
  });

  it("bets: ghosts always use their free chip, real chips stay within 15% of the kasa", () => {
    const rng = createRng(5);
    for (let i = 0; i < 500; i++) {
      const ghost = botBet(rng, { personality: "korkak", kasa: 0, ghost: true, royale: true, avgFlips: null });
      expect(ghost).not.toBeNull();
      const real = botBet(rng, { personality: "gozuKara", kasa: 200, ghost: false, royale: false, avgFlips: 3 });
      if (real) {
        expect((CHIP_AMOUNTS as readonly number[]).includes(real.amount)).toBe(true);
        expect(real.amount).toBeLessThanOrEqual(30);
      }
      expect(botBet(rng, { personality: "gozuKara", kasa: 50, ghost: false, royale: true, avgFlips: 3 })).toBeNull();
      expect(botBet(rng, { personality: "dengeli", kasa: 40, ghost: false, royale: false, avgFlips: 3 })).toBeNull();
    }
  });

  it("bet boxes follow the active player's habits", () => {
    const rng = createRng(11);
    const count = (avg: number) => {
      const c: Record<BetBox, number> = { b12: 0, b34: 0, b5p: 0, cash: 0 };
      for (let i = 0; i < 4000; i++) c[botBetBox(rng, "dengeli", avg)]++;
      return c;
    };
    const timid = count(1.5);
    const bold = count(5);
    expect(timid.cash).toBeGreaterThan(timid.b34);
    expect(bold.b34 + bold.b5p).toBeGreaterThan(bold.cash);
    expect(bold.b5p).toBeGreaterThan(timid.b5p);
  });

  it("targets: the richest for Haraç / Takas, Lanet mostly the leader", () => {
    const cands = [
      { id: "next", kasa: 120 },
      { id: "rich", kasa: 400 },
      { id: "poor", kasa: 10 },
    ];
    const rng = createRng(2);
    expect(botTarget(rng, "harac", cands)).toBe("rich");
    expect(botTarget(rng, "takas", cands)).toBe("rich");
    const lanet = Array.from({ length: 400 }, () => botTarget(rng, "lanet", cands));
    expect(lanet.filter((x) => x === "rich").length).toBeGreaterThan(200);
    expect(lanet.every((x) => x === "rich" || x === "next")).toBe(true);
    expect(botTarget(rng, "harac", [])).toBe("");
  });

  it("loans: lends small at a fair rate, never to a Taşlık, takes rescue money when broke", () => {
    const ask = { kind: "request" as const, amount: 40, ratePct: 20, myKasa: 200, otherTaslik: false, meBroke: false, otherBroke: false };
    expect(botAcceptsLoan(ask, 0.9)).toBe(true);
    expect(botAcceptsLoan({ ...ask, ratePct: 10 }, 0)).toBe(false);
    expect(botAcceptsLoan({ ...ask, amount: 80 }, 0)).toBe(false);
    expect(botAcceptsLoan({ ...ask, otherTaslik: true }, 0)).toBe(false);
    expect(botAcceptsLoan({ ...ask, ratePct: 10, otherBroke: true }, 0.1)).toBe(true);
    const offer = { ...ask, kind: "offer" as const, ratePct: 30 };
    expect(botAcceptsLoan({ ...offer, myKasa: 0, meBroke: true }, 0.99)).toBe(true);
    expect(botAcceptsLoan(offer, 0)).toBe(false);
    expect(botAcceptsLoan({ ...offer, myKasa: 40, ratePct: 10 }, 0)).toBe(true);
    expect(botRepayAmount(300, 100)).toBe(100);
    expect(botRepayAmount(150, 100)).toBe(0);
  });

  it("Son Şans: rescue loans stay within the lending limit; a broke bot asks the richest", () => {
    const rng = createRng(9);
    let lent = 0;
    for (let i = 0; i < 400; i++) {
      const r = botRescueLoan(rng, 200, 4);
      if (!r) continue;
      lent++;
      expect(r.amount).toBeGreaterThanOrEqual(10);
      expect(r.amount).toBeLessThanOrEqual(100);
      expect(r.ratePct).toBe(30);
    }
    expect(lent).toBeGreaterThan(120);
    expect(lent).toBeLessThan(280);
    expect(botRescueLoan(rng, 15, 4)).toBeNull();
    expect(botRescueRequest([{ id: "a", kasa: 80 }, { id: "b", kasa: 300 }, { id: "c", kasa: 5 }])).toEqual({ toId: "b", amount: 30, ratePct: 30 });
    expect(botRescueRequest([{ id: "c", kasa: 15 }])).toBeNull();
  });

  it("heckles match the bet: Kasalar wants a KASALA, a live raid box wants another card", () => {
    expect(botHeckle("cash", 3)).toBe("cash");
    expect(botHeckle("b5p", 3)).toBe("flip");
    expect(botHeckle("b12", 1)).toBe("flip");
    expect(botHeckle("b12", 2)).toBeNull();
  });

  it("every bot name has a personality and fits the nickname limit", () => {
    expect(BOT_PERSONALITY_BY_INDEX.length).toBeGreaterThanOrEqual(BOT_NAMES.length);
    expect(new Set(BOT_PERSONALITY_BY_INDEX.slice(0, 3)).size).toBe(3);
    for (const n of BOT_NAMES) expect(Array.from(n).length).toBeLessThanOrEqual(14);
  });
});
