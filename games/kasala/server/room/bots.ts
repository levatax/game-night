// Server-side bots for KasalaRoom ("🤖 Bot ekle" in the lobby, and the seat of a match player who left for
// good). Owner: server. A BotDesk drives every bot seat through the room's own id-based actions (the exact
// validation a human's message goes through) after a human-like think delay. The decisions themselves are
// pure functions in server/rules.ts (bot*, unit-tested); this file only decides WHEN to act and gathers the
// inputs. Every random pick uses the room's separate bot rng, so bots never shift card / wheel outcomes and
// seeded tests stay deterministic. Time is the desk's own clock (sum of ticks), never Date.now.

import { BOT_NAMES, HECKLE_CASH_TAUNT, HECKLE_FLIP_TAUNT, LOAN_MIN } from "../../shared/constants.js";
import type { BetBox, CardId, EmoteId } from "../../shared/constants.js";
import type { BetResult, LoanProposeMsg } from "../../shared/protocol.js";
import {
  BOT_PERSONALITY_BY_INDEX,
  botAcceptsLoan,
  botBet,
  botHeckle,
  botMarketChoice,
  botRepayAmount,
  botRescueLoan,
  botRescueRequest,
  botShouldFlip,
  botTarget,
  loanLimit,
  pick,
  type BotPersonality,
} from "../rules.js";
import type { KasalaState, PlayerState } from "../schema.js";

/** What the desk may see and do in the room. Every action is validated by the room like a human message. */
export interface BotHost {
  readonly state: KasalaState;
  /** The room's bot rng (re-seeded per match). */
  rng(): number;
  /** Think delay range (seconds). */
  think(): { min: number; max: number };
  /** Seconds left on the phase timer (Infinity when untimed). */
  timeLeft(): number;
  /** The "time low" line plays when this much decision time is left: bots decide before it. */
  timeLowSec(): number;
  /** Increases at every turn start (plan keys). */
  turnSerial(): number;
  flip(id: string): boolean;
  cash(id: string): boolean;
  target(id: string, targetId: string): boolean;
  /** amount 0 = PAS (no bet yet). */
  bet(id: string, box: BetBox, amount: number): boolean;
  /** Can this player bet in the current bet window? */
  canBet(id: string): boolean;
  /** Already bet or passed this turn. */
  betDecided(id: string): boolean;
  /** A Pazar buyer right now (market phase, not locked). */
  canShop(id: string): boolean;
  /** Already chose (or passed) in this market. */
  shopped(id: string): boolean;
  /** Row cards on sale. */
  marketCards(): { flipNo: number; value: number }[];
  /** Kasas of the other buyers in this market. */
  marketRivals(id: string): number[];
  /** flipNo 0 = pas. */
  market(id: string, flipNo: number): boolean;
  /** Legal attack targets (turn order). */
  targetCandidates(): string[];
  /** Bribe a raid would cost this player right now. */
  bribeFor(id: string): number;
  /** May lend / borrow right now (loans on, loan phase, a match player who isn't a ghost). */
  canDeal(id: string): boolean;
  loanPropose(id: string, msg: LoanProposeMsg): void;
  loanRespond(id: string, offerId: string, accept: boolean): void;
  loanRepay(id: string, debtId: string, amount: number): void;
  emote(id: string, emote: EmoteId): boolean;
  taunt(id: string, index: number): boolean;
}

/** One pending decision of a bot: made once per key, `due` seconds into the desk clock. */
interface Plan {
  key: string;
  due: number;
  done: boolean;
}

interface Need {
  key: string;
  act: () => void;
  /** Extra hesitation on top of the think time (drama on a hot siren). */
  extra?: number;
  /** Act no later than this many seconds from now. */
  latest?: number;
}

interface Seat {
  id: string;
  personality: BotPersonality;
  /** Turn actions: bet / flip / cash / target. */
  main: Plan;
  /** Loans: answer offers, Son Şans, repayments. */
  loan: Plan;
}

/** Cards per finished turn remembered per player (bet box picks). */
const HISTORY = 6;

/** Personality of a lobby bot by its name (takeover bots play "dengeli"). */
export function personalityFor(nickname: string): BotPersonality {
  const i = (BOT_NAMES as readonly string[]).indexOf(nickname);
  return i >= 0 ? (BOT_PERSONALITY_BY_INDEX[i % BOT_PERSONALITY_BY_INDEX.length] ?? "dengeli") : "dengeli";
}

export class BotDesk {
  private seats = new Map<string, Seat>();
  private clock = 0;
  private history = new Map<string, number[]>();
  private later: { at: number; id: string; run: () => void }[] = [];
  /** Last bot heckle / emote (desk clock): bots never chatter over each other. */
  private lastChatter = -Infinity;
  /** `${turn}:${id}`: heckled already this turn. */
  private heckled = new Set<string>();

  constructor(private host: BotHost) {}

  get size(): number {
    return this.seats.size;
  }

  has(id: string): boolean {
    return this.seats.has(id);
  }

  add(id: string, personality: BotPersonality): void {
    this.seats.set(id, { id, personality, main: { key: "", due: 0, done: false }, loan: { key: "", due: 0, done: false } });
  }

  remove(id: string): void {
    this.seats.delete(id);
    this.later = this.later.filter((l) => l.id !== id);
  }

  /** Match start: forget the last match (personalities stay). */
  resetMatch(): void {
    this.history.clear();
    this.later = [];
    this.heckled.clear();
    this.lastChatter = -Infinity;
    for (const seat of this.seats.values()) {
      seat.main = { key: "", due: 0, done: false };
      seat.loan = { key: "", due: 0, done: false };
    }
  }

  tick(dt: number): void {
    this.clock += dt;
    if (this.later.length) {
      const due = this.later.filter((l) => l.at <= this.clock);
      if (due.length) {
        this.later = this.later.filter((l) => l.at > this.clock);
        for (const l of due) if (this.seats.has(l.id)) l.run();
      }
    }
    for (const seat of [...this.seats.values()]) {
      if (!this.seats.has(seat.id)) continue;
      this.drive(seat.main, this.mainNeed(seat));
      if (this.seats.has(seat.id)) this.drive(seat.loan, this.loanNeed(seat));
    }
  }

  // ------------------------------------------------------------------- events
  /** A turn ended after `flips` cards (CASHED / RAIDED): remembered for bet picks. */
  noteTurnEnd(playerId: string, flips: number): void {
    if (flips <= 0) return;
    const list = this.history.get(playerId) ?? [];
    list.push(flips);
    if (list.length > HISTORY) list.shift();
    this.history.set(playerId, list);
  }

  /**
   * A card was flipped on a human's turn and the turn goes on (the room never calls this for a raid, wheel or
   * attack card): one bot watcher with a bet may heckle (each at most once per turn, never two bots at once). Bots
   * leave each other alone: heckles are there to put pressure on people. The heckle is dropped when anything
   * happened in between (another card, a phase change), so it never lands over a later raid card.
   */
  onCard(activeId: string, flips: number): void {
    const s = this.host.state;
    const active = s.players.get(activeId);
    if (flips < 2 || !active || active.bot) return;
    const turn = this.host.turnSerial();
    const loud: { id: string; kind: "flip" | "cash" }[] = [];
    for (const seat of this.seats.values()) {
      const bet = s.bets.get(seat.id);
      if (seat.id === activeId || !bet || this.heckled.has(`${turn}:${seat.id}`)) continue;
      const kind = botHeckle(bet.box, flips);
      if (kind) loud.push({ id: seat.id, kind });
    }
    if (!loud.length || this.host.rng() >= 0.35) return;
    const { id, kind } = pick(this.host.rng, loud);
    this.heckled.add(`${turn}:${id}`);
    this.soon(id, () => {
      const st = this.host.state;
      if (st.phase !== "flipping" || st.activeId !== activeId || this.host.turnSerial() !== turn || st.flips !== flips) return;
      if (this.chatterOk()) this.host.taunt(id, kind === "flip" ? HECKLE_FLIP_TAUNT : HECKLE_CASH_TAUNT);
    });
  }

  onCashed(playerId: string, pot: number): void {
    if (!this.seats.has(playerId) || pot < 100 || this.host.rng() >= 0.4) return;
    const emote = pick<EmoteId>(this.host.rng, ["puro", "paraSay"]);
    this.soon(playerId, () => this.chatterOk() && this.host.emote(playerId, emote));
  }

  onRaided(playerId: string): void {
    if (!this.seats.has(playerId) || this.host.rng() >= 0.4) return;
    this.soon(playerId, () => this.chatterOk() && this.host.emote(playerId, "agla"));
  }

  /** A bot that won a fat side bet sometimes shows it off. */
  onSettled(results: readonly BetResult[]): void {
    for (const r of results) {
      if (!this.seats.has(r.playerId) || r.ghost || !r.won || r.delta < 40 || this.host.rng() >= 0.3) continue;
      const emote = pick<EmoteId>(this.host.rng, ["yumruk", "allahAllah"]);
      this.soon(r.playerId, () => this.chatterOk() && this.host.emote(r.playerId, emote));
      return;
    }
  }

  // --------------------------------------------------------------- scheduling
  private drive(plan: Plan, need: Need | null): void {
    if (!need) {
      plan.key = "";
      return;
    }
    if (plan.key !== need.key) {
      plan.key = need.key;
      plan.done = false;
      plan.due = this.clock + this.delay(need);
      return;
    }
    if (plan.done || this.clock < plan.due) return;
    plan.done = true;
    need.act();
  }

  private delay(need: Need): number {
    const { min, max } = this.host.think();
    let sec = min + (max - min) * this.host.rng() + (need.extra ?? 0);
    if (need.latest !== undefined) sec = Math.min(sec, Math.max(min * 0.25, need.latest));
    return Math.max(0, sec);
  }

  private soon(id: string, run: () => void): void {
    const { min, max } = this.host.think();
    this.later.push({ at: this.clock + min * 0.75 + (max - min) * 0.6 * this.host.rng(), id, run });
  }

  private chatterOk(): boolean {
    const gap = Math.max(1, this.host.think().max * 2.5);
    if (this.clock - this.lastChatter < gap) return false;
    this.lastChatter = this.clock;
    return true;
  }

  // ------------------------------------------------------------- turn actions
  private mainNeed(seat: Seat): Need | null {
    const h = this.host;
    const s = h.state;
    const id = seat.id;
    if (!s.players.has(id)) return null;
    const turn = h.turnSerial();
    switch (s.phase) {
      case "betting":
        if (id === s.activeId || !h.canBet(id) || h.betDecided(id)) return null;
        return { key: `bet:${turn}`, latest: h.timeLeft() * 0.7, act: () => this.placeBet(seat) };
      case "flipping": {
        if (id !== s.activeId || s.busy) return null;
        const hot = s.flips > 0 && s.raidChance >= 0.3;
        const { min, max } = h.think();
        return {
          key: `flip:${turn}:${s.flips}`,
          extra: hot ? (max - min) * 0.5 * h.rng() : 0,
          latest: h.timeLeft() - h.timeLowSec() - 0.3,
          act: () => this.decideFlip(seat),
        };
      }
      case "market":
        if (!h.canShop(id) || h.shopped(id)) return null;
        return { key: `market:${turn}`, latest: h.timeLeft() * 0.7, act: () => this.shop(seat) };
      case "targeting": {
        if (id !== s.activeId) return null;
        // A single legal target resolves on its own (KasalaRoom), no pick needed.
        if (h.targetCandidates().length <= 1) return null;
        return { key: `target:${turn}:${s.flips}`, latest: h.timeLeft() - 0.4, act: () => this.pickTarget(seat) };
      }
      default:
        return null;
    }
  }

  private shop(seat: Seat): void {
    const h = this.host;
    const me = h.state.players.get(seat.id);
    if (!me || !h.canShop(seat.id)) return;
    const choice = botMarketChoice(h.rng, {
      personality: seat.personality,
      kasa: me.kasa,
      cards: h.marketCards(),
      rivals: h.marketRivals(seat.id),
    });
    h.market(seat.id, choice);
  }

  private placeBet(seat: Seat): void {
    const s = this.host.state;
    const me = s.players.get(seat.id);
    if (!me) return;
    const choice = botBet(this.host.rng, {
      personality: seat.personality,
      kasa: me.kasa,
      ghost: me.ghost,
      royale: s.settings.mode === "royale",
      avgFlips: this.avgFlips(s.activeId),
    });
    this.host.bet(seat.id, choice?.box ?? "cash", choice?.amount ?? 0);
  }

  private decideFlip(seat: Seat): void {
    const h = this.host;
    const s = h.state;
    const me = s.players.get(seat.id);
    if (!me) return;
    let leader = -Infinity;
    for (const p of this.inGame()) if (p.id !== me.id) leader = Math.max(leader, p.kasa);
    let staked = 0;
    let onRaid = 0;
    s.bets.forEach((b) => {
      if (b.ghost) return;
      staked += b.amount;
      if (b.box !== "cash") onRaid += b.amount;
    });
    const flip = botShouldFlip(
      {
        personality: seat.personality,
        flips: s.flips,
        pot: s.turnPot,
        raidChance: s.raidChance,
        bribe: h.bribeFor(me.id),
        lawyers: s.lawyers,
        finalTable: s.finalTable,
        behindBy: Number.isFinite(leader) ? leader - me.kasa : 0,
        raidStakeShare: staked > 0 ? onRaid / staked : 0,
      },
      h.rng(),
    );
    if (flip) h.flip(me.id);
    else h.cash(me.id);
  }

  private pickTarget(seat: Seat): void {
    const s = this.host.state;
    const cands = this.host.targetCandidates();
    if (!cands.length || !s.pendingCard) return;
    // Rotate to "next after me" so index 0 is the player whose turn comes first.
    const order = [...s.turnOrder];
    const at = order.indexOf(seat.id);
    const ranked = cands
      .map((id) => ({ id, kasa: s.players.get(id)?.kasa ?? 0, k: (order.indexOf(id) - at + order.length) % Math.max(1, order.length) }))
      .sort((a, b) => a.k - b.k);
    const targetId = botTarget(this.host.rng, s.pendingCard as CardId, ranked);
    if (targetId) this.host.target(seat.id, targetId);
  }

  // -------------------------------------------------------------------- loans
  private loanNeed(seat: Seat): Need | null {
    const h = this.host;
    const s = h.state;
    const id = seat.id;
    if (!h.canDeal(id)) return null;
    for (const o of s.offers.values()) {
      if (o.toId === id) return { key: `answer:${o.id}`, latest: o.timeLeft - 0.5, act: () => this.answer(seat, o.id) };
    }
    const turn = h.turnSerial();
    if (s.phase === "lastChance" && s.lastChanceId) {
      const tag = `${turn}:${s.round}:${s.lastChanceId}`;
      if (s.lastChanceId === id) return { key: `beg:${tag}`, act: () => this.beg(seat) };
      return { key: `rescue:${tag}`, act: () => this.rescue(seat, s.lastChanceId) };
    }
    if (s.phase === "betting") {
      const me = s.players.get(id);
      if (!me) return null;
      for (const d of s.debts.values()) {
        if (d.borrowerId !== id) continue;
        const amount = botRepayAmount(me.kasa, d.owed);
        if (amount > 0) return { key: `repay:${d.id}:${turn}`, act: () => h.loanRepay(id, d.id, amount) };
      }
    }
    return null;
  }

  private answer(seat: Seat, offerId: string): void {
    const s = this.host.state;
    const o = s.offers.get(offerId);
    const me = s.players.get(seat.id);
    if (!o || !me || o.toId !== seat.id) return;
    const other = s.players.get(o.fromId);
    const broke = s.phase === "lastChance" ? s.lastChanceId : "";
    const accept = botAcceptsLoan(
      {
        kind: o.kind,
        amount: o.amount,
        ratePct: o.ratePct,
        myKasa: me.kasa,
        otherTaslik: !!other?.taslik,
        meBroke: broke === seat.id,
        otherBroke: broke !== "" && broke === o.fromId,
      },
      this.host.rng(),
    );
    this.host.loanRespond(seat.id, offerId, accept);
  }

  /** Son Şans, the bot is broke: ask the richest player who can lend. */
  private beg(seat: Seat): void {
    const lenders = this.inGame()
      .filter((p) => p.id !== seat.id && p.connected && this.host.canDeal(p.id) && loanLimit(p.kasa) >= LOAN_MIN)
      .map((p) => ({ id: p.id, kasa: p.kasa }));
    const ask = botRescueRequest(lenders);
    if (ask) this.host.loanPropose(seat.id, { toId: ask.toId, kind: "request", amount: ask.amount, ratePct: ask.ratePct });
  }

  /** Son Şans, someone else is broke: sometimes throw them a rope. */
  private rescue(seat: Seat, brokeId: string): void {
    const s = this.host.state;
    const me = s.players.get(seat.id);
    if (!me || brokeId === seat.id || !s.players.get(brokeId)?.connected) return;
    const lend = botRescueLoan(this.host.rng, me.kasa, this.inGame().length);
    if (lend) this.host.loanPropose(seat.id, { toId: brokeId, kind: "offer", amount: lend.amount, ratePct: lend.ratePct });
  }

  // ------------------------------------------------------------------ helpers
  private avgFlips(playerId: string): number | null {
    const list = this.history.get(playerId);
    if (!list || !list.length) return null;
    return list.reduce((a, b) => a + b, 0) / list.length;
  }

  private inGame(): PlayerState[] {
    const s = this.host.state;
    return [...s.turnOrder].map((id) => s.players.get(id)).filter((p): p is PlayerState => !!p && !p.ghost && !p.spectator);
  }
}
