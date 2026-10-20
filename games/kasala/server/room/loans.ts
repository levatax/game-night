// Loans & loan sharking (game3.md §9) for KasalaRoom: pending offers / requests, debts, interest, Taşlık cuts
// and match-end collection. Owner: server. Writes straight into state.offers / state.debts and player kasas;
// everything room-specific (who may deal, broadcasting, announcer, saving a broke player) goes through LoanHost.

import { LOAN_MIN, LOAN_RATES } from "../../shared/constants.js";
import type { AnnouncerEvent } from "../../shared/announcer.js";
import type { LoanKind, LoanMsg, MatchEndMsg, NoticeMsg, RoundEndMsg } from "../../shared/protocol.js";
import { applyInterest, collectDebts, cutByLender, loanLimit, taslikCut } from "../rules.js";
import { DebtState, OfferState, type KasalaState, type PlayerState } from "../schema.js";
import { say } from "./text.js";

export interface LoanHost {
  readonly state: KasalaState;
  /** May this player lend / borrow right now (loans on, in-match phase, a match player who isn't a ghost)? */
  canDeal(id: string): boolean;
  isConnected(id: string): boolean;
  broadcastLoan(msg: LoanMsg): void;
  announce(event: AnnouncerEvent, playerId: string): void;
  notify(playerId: string, notice: NoticeMsg): void;
  /** Money moved from one player to another through a loan or a repayment (Taşlık / Son Şans checks). */
  moneyMoved(fromId: string, toId: string): void;
}

/** Sanity cap for amounts coming from clients. */
const MAX_AMOUNT = 10_000_000;

function obj(m: unknown): Record<string, unknown> | null {
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
}

function seqOf(id: string): number {
  const n = Number.parseInt(id.slice(1), 10);
  return Number.isFinite(n) ? n : 0;
}

export class LoanDesk {
  private offerSeq = 0;
  private debtSeq = 0;
  /** Exact seconds left per pending offer; OfferState.timeLeft only shows whole seconds (cheap patches). */
  private left = new Map<string, number>();

  constructor(
    private host: LoanHost,
    private offerSec: number,
  ) {}

  private get state(): KasalaState {
    return this.host.state;
  }

  private player(id: string): PlayerState | undefined {
    return this.state.players.get(id);
  }

  // ----------------------------------------------------------------- messages
  /**
   * LOAN_PROPOSE. One pending outgoing offer per player: a new one replaces the old one. Returns true when an
   * offer went out (or an identical one had its clock restarted).
   */
  propose(fromId: string, raw: unknown): boolean {
    const s = this.state;
    const m = obj(raw);
    if (!m || !s.settings.loans) return false;
    const { toId, kind, amount, ratePct } = m;
    if (typeof toId !== "string" || toId === fromId || (kind !== "offer" && kind !== "request")) return false;
    if (typeof amount !== "number" || !Number.isFinite(amount) || typeof ratePct !== "number") return false;
    if (!(LOAN_RATES as readonly number[]).includes(ratePct)) return false;
    const amt = Math.floor(amount);
    if (amt < LOAN_MIN || amt > MAX_AMOUNT) return false;
    const from = this.player(fromId);
    const to = this.player(toId);
    if (!from || !to) return false;
    if (!this.host.canDeal(fromId) || !this.host.canDeal(toId)) return this.refuse(fromId, say.loanNotAllowed());
    if (!this.host.isConnected(toId)) return this.refuse(fromId, say.loanOffline(to.nickname));
    if (kind === "offer") {
      const limit = loanLimit(from.kasa);
      if (amt > limit) return this.refuse(fromId, say.loanLimit(limit));
    }
    for (const o of [...s.offers.values()]) {
      if (o.fromId !== fromId) continue;
      // The same offer again (a held key, a double click): just restart its clock, no cancel + proposed pair.
      if (o.toId === toId && o.kind === kind && o.amount === amt && o.ratePct === ratePct) {
        this.left.set(o.id, this.offerSec);
        o.timeLeft = Math.ceil(this.offerSec);
        return true;
      }
      this.closeOffer(o, "canceled");
    }

    const o = new OfferState();
    o.id = `o${++this.offerSeq}`;
    o.fromId = fromId;
    o.toId = toId;
    o.kind = kind as LoanKind;
    o.amount = amt;
    o.ratePct = ratePct;
    o.timeLeft = Math.ceil(this.offerSec);
    this.left.set(o.id, this.offerSec);
    s.offers.set(o.id, o);
    this.host.broadcastLoan(this.offerMsg(o, "proposed"));
    return true;
  }

  /** LOAN_RESPOND, only by the offer's toId. */
  respond(id: string, raw: unknown): void {
    const m = obj(raw);
    if (!m || typeof m.offerId !== "string" || typeof m.accept !== "boolean") return;
    const o = this.state.offers.get(m.offerId);
    if (!o || o.toId !== id) return;
    if (!m.accept) {
      this.closeOffer(o, "declined");
      this.host.announce("loanDeclined", o.toId);
      return;
    }
    const lenderId = o.kind === "offer" ? o.fromId : o.toId;
    const borrowerId = o.kind === "offer" ? o.toId : o.fromId;
    const lender = this.player(lenderId);
    const borrower = this.player(borrowerId);
    if (!lender || !borrower || !this.host.canDeal(lenderId) || !this.host.canDeal(borrowerId)) {
      this.host.notify(id, say.loanNotAllowed());
      this.closeOffer(o, "declined");
      return;
    }
    const limit = loanLimit(lender.kasa);
    if (o.amount > limit) {
      const notice = say.loanLimitOther(lender.nickname, limit);
      this.host.notify(o.fromId, notice);
      this.host.notify(o.toId, notice);
      this.closeOffer(o, "declined");
      return;
    }
    this.state.offers.delete(o.id);
    this.left.delete(o.id);
    lender.kasa -= o.amount;
    borrower.kasa += o.amount;
    lender.stats.lent += o.amount;
    borrower.stats.borrowed += o.amount;
    const d = new DebtState();
    d.id = `d${++this.debtSeq}`;
    d.lenderId = lenderId;
    d.borrowerId = borrowerId;
    d.principal = o.amount;
    d.ratePct = o.ratePct;
    d.owed = o.amount;
    this.state.debts.set(d.id, d);
    this.host.broadcastLoan({ ...this.offerMsg(o, "accepted"), debtId: d.id });
    this.host.announce("loanAccepted", borrowerId);
    this.host.moneyMoved(lenderId, borrowerId);
  }

  /** LOAN_CANCEL, only by the offer's fromId. */
  cancel(id: string, raw: unknown): void {
    const m = obj(raw);
    if (!m || typeof m.offerId !== "string") return;
    const o = this.state.offers.get(m.offerId);
    if (o && o.fromId === id) this.closeOffer(o, "canceled");
  }

  /** LOAN_REPAY, borrower only: min(amount, owed, kasa) goes to the lender. Returns true when money moved. */
  repay(id: string, raw: unknown): boolean {
    const m = obj(raw);
    if (!m || typeof m.debtId !== "string" || typeof m.amount !== "number" || !Number.isFinite(m.amount)) return false;
    const d = this.state.debts.get(m.debtId);
    if (!d || d.borrowerId !== id) return false;
    const borrower = this.player(d.borrowerId);
    if (!borrower) return false;
    const pay = Math.min(Math.floor(m.amount), d.owed, Math.max(0, borrower.kasa));
    if (pay <= 0) {
      if (m.amount > 0 && borrower.kasa <= 0) this.host.notify(id, say.repayBroke());
      return false;
    }
    borrower.kasa -= pay;
    const lender = this.player(d.lenderId);
    if (lender) lender.kasa += pay;
    d.owed -= pay;
    const paidOff = d.owed <= 0;
    if (paidOff) this.state.debts.delete(d.id);
    this.host.broadcastLoan(this.debtMsg(d, paidOff ? "paidOff" : "repaid", pay));
    if (paidOff) this.host.announce("loanRepaid", d.borrowerId);
    this.host.moneyMoved(d.borrowerId, d.lenderId);
    return true;
  }

  // -------------------------------------------------------------------- upkeep
  /** Count offers down; expired ones are removed (LOAN "expired"). The synced timeLeft changes once a second. */
  tick(dt: number): void {
    for (const o of [...this.state.offers.values()]) {
      const left = Math.max(0, (this.left.get(o.id) ?? o.timeLeft) - dt);
      this.left.set(o.id, left);
      if (left <= 0) {
        this.closeOffer(o, "expired");
        continue;
      }
      const shown = Math.ceil(left);
      if (o.timeLeft !== shown) o.timeLeft = shown;
    }
  }

  /** Remove every pending offer from / to a player (left for good, eliminated). */
  dropOffersOf(playerId: string): void {
    for (const o of [...this.state.offers.values()]) if (o.fromId === playerId || o.toId === playerId) this.closeOffer(o, "canceled");
  }

  /** Silently drop every pending offer (match end). */
  clearOffers(): void {
    this.state.offers.clear();
    this.left.clear();
  }

  /** Silently drop offers and debts (match start / rematch). */
  clearAll(): void {
    this.state.offers.clear();
    this.left.clear();
    this.state.debts.clear();
    this.offerSeq = 0;
    this.debtSeq = 0;
  }

  totalOwed(borrowerId: string): number {
    let sum = 0;
    this.state.debts.forEach((d) => {
      if (d.borrowerId === borrowerId) sum += Math.max(0, d.owed);
    });
    return sum;
  }

  /** Debts in creation order. */
  ordered(): DebtState[] {
    return [...this.state.debts.values()].sort((a, b) => seqOf(a.id) - seqOf(b.id));
  }

  /** Battle Royale elimination: debts owed TO a player thrown in the river are written off. Returns how many. */
  forgiveDebtsTo(lenderId: string): number {
    let n = 0;
    for (const d of this.ordered()) {
      if (d.lenderId !== lenderId) continue;
      this.state.debts.delete(d.id);
      n++;
    }
    return n;
  }

  /** Round end: every debt grows by its rate (debts of `frozen` borrowers, e.g. ghosts, don't). */
  interest(frozen: (borrowerId: string) => boolean = () => false): RoundEndMsg["interest"] {
    const out: RoundEndMsg["interest"] = [];
    for (const d of this.ordered()) {
      if (frozen(d.borrowerId)) continue;
      const before = d.owed;
      const after = applyInterest(before, d.ratePct);
      d.owed = after;
      out.push({ debtId: d.id, before, after });
    }
    return out;
  }

  /**
   * Taşlık KASALA: the cut of `pot` pays the borrower's creditors (largest debt first). Lenders are credited,
   * debts reduced, paid-off debts removed (LOAN "paidOff"). Returns the per-lender cut and what the borrower keeps.
   */
  applyTaslikCut(borrowerId: string, pot: number): { cut: { lenderId: string; amount: number }[]; kept: number } {
    const mine = this.ordered().filter((d) => d.borrowerId === borrowerId);
    const r = taslikCut(pot, mine);
    for (const p of r.payments) {
      const d = this.state.debts.get(p.debtId);
      if (!d) continue;
      const lender = this.player(d.lenderId);
      if (lender) lender.kasa += p.amount;
      d.owed -= p.amount;
      if (d.owed <= 0) {
        this.state.debts.delete(d.id);
        this.host.broadcastLoan(this.debtMsg(d, "paidOff", p.amount));
      }
    }
    return { cut: cutByLender(r.payments), kept: r.kept };
  }

  /**
   * Match end: every debt is collected from the borrower's kasa, the rest wiped (Kara Liste). Applies the
   * kasas, sets karaListe, clears the debts. Returns the collections and the wiped total per borrower.
   */
  collect(): { collections: MatchEndMsg["collections"]; wiped: Map<string, number> } {
    const s = this.state;
    const debts = this.ordered();
    const kasas: Record<string, number> = {};
    s.players.forEach((p) => (kasas[p.id] = p.kasa));
    const r = collectDebts(debts, kasas);
    for (const [id, kasa] of Object.entries(r.kasas)) {
      const p = this.player(id);
      if (p) p.kasa = kasa;
    }
    for (const id of r.karaListe) {
      const p = this.player(id);
      if (p) p.karaListe = true;
    }
    const wiped = new Map<string, number>();
    for (const c of r.collections) if (c.wiped > 0) wiped.set(c.borrowerId, (wiped.get(c.borrowerId) ?? 0) + c.wiped);
    s.debts.clear();
    s.offers.clear();
    this.left.clear();
    return { collections: r.collections, wiped };
  }

  // ------------------------------------------------------------------- helpers
  private refuse(playerId: string, notice: NoticeMsg): false {
    this.host.notify(playerId, notice);
    return false;
  }

  private closeOffer(o: OfferState, event: "declined" | "expired" | "canceled"): void {
    this.state.offers.delete(o.id);
    this.left.delete(o.id);
    this.host.broadcastLoan(this.offerMsg(o, event));
  }

  private offerMsg(o: OfferState, event: LoanMsg["event"]): LoanMsg {
    return { event, fromId: o.fromId, toId: o.toId, kind: o.kind, amount: o.amount, ratePct: o.ratePct, debtId: "" };
  }

  private debtMsg(d: DebtState, event: "repaid" | "paidOff", amount: number): LoanMsg {
    return { event, fromId: d.borrowerId, toId: d.lenderId, kind: "offer", amount, ratePct: d.ratePct, debtId: d.id };
  }
}
