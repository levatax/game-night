// Spectator side bets (§8), in two shapes:
// - tray (bottom center, only while I can bet): four big boxes with full labels ("1–2. kartta BASKIN" …
//   "KASALAR"), the payout, a rough chance for THIS turn ("≈%21", from the starting siren level) and what my
//   selected chip would win ("25$ → 100$"); everyone's chips on them (public by design); the chip picker
//   (Q/W/E), a PAS button (0) and the window's countdown. Ghosts bet a free GHOST_CHIP.
// - line (one row next to the watch pill, once the tray closes): my bet and its fate, live — "🎲 3–4. kartta
//   baskın · 25$ → 100$", "✗ yandı" the moment the box can no longer win, then the payout ("KAZANDIN +100$").
//   This line is the ONE place a bet result is told. The active player gets no bet UI (the act note counts the
//   bets against them); at the payout their house cut shows here ("Ev payı +3$").

import {
  BET_BOXES,
  BET_BOX_BY_ID,
  CHIP_AMOUNTS,
  FINAL_TABLE_MULT,
  GHOST_CHIP,
  boxAlive,
  boxWins,
  type BetBox,
  type TurnOutcome,
} from "../../../../shared/constants";
import type { BetView, BetsSettledMsg } from "../../../../shared/protocol";
import { money, pct, playerColor, type UiSound } from "../../app/ui";
import { uiCapturesKeys } from "../keyGate";
import { Countdown, boxOdds, setBar, type HudCtx } from "./ctx";
import { h, replay, setAttr, setDisabled, setText, setVar, show, toggle, trNum, typingInField, wireButton } from "./dom";

const CHIP_KEYS = ["Q", "W", "E"];

const BOX_TEXT: Record<BetBox, { l1: string; l2: string; short: string }> = {
  b12: { l1: "1–2. kartta", l2: "BASKIN", short: "1–2. kartta baskın" },
  b34: { l1: "3–4. kartta", l2: "BASKIN", short: "3–4. kartta baskın" },
  b5p: { l1: "5+ kartta", l2: "BASKIN", short: "5+ kartta baskın" },
  cash: { l1: "KASALAR", l2: "baskın yemeden", short: "Kasalar" },
};

export interface BetHandlers {
  onBet(box: BetBox, amount: number): void;
  onChip(amount: number): void;
  onPass(): void;
  onUiSound(kind: UiSound): void;
  /** Local state changed (PAS / chip): re-run the layout with the last patch. */
  onLocalChange(): void;
}

interface BoxEl {
  id: BetBox;
  root: HTMLButtonElement;
  pay: HTMLSpanElement;
  odds: HTMLSpanElement;
  win: HTMLSpanElement;
  chips: HTMLDivElement;
}

interface ChipEl {
  root: HTMLSpanElement;
  box: BetBox;
  amount: number;
  ghost: boolean;
}

interface MyBet {
  box: BetBox;
  amount: number;
  ghost: boolean;
}

export class BetPanel {
  readonly tray: HTMLDivElement;
  readonly line: HTMLDivElement;
  private readonly cb: BetHandlers;

  // tray
  private readonly question: HTMLSpanElement;
  private readonly secs: HTMLSpanElement;
  private readonly barFill: HTMLDivElement;
  private readonly bar = { v: -1 };
  private readonly boxes = new Map<BetBox, BoxEl>();
  private readonly chipRow: HTMLDivElement;
  private readonly chipBtns: HTMLButtonElement[] = [];
  private readonly ghostNote: HTMLDivElement;
  private readonly status: HTMLDivElement;
  readonly passBtn: HTMLButtonElement;
  private readonly chips = new Map<string, ChipEl>();
  private readonly timer = new Countdown();

  // line
  private readonly lineText: HTMLSpanElement;
  private readonly lineState: HTMLSpanElement;

  private ctx: HudCtx | null = null;
  private selected: number = CHIP_AMOUNTS[0];
  private open = false;
  private passed = false;
  /** Game reports every PAS it actually sends (markPassed), so the HUD never folds on its own. */
  private passWired = false;
  private turnKey = "";
  private settledKey = "";
  /** Outcome from BETS_SETTLED for this turn (authoritative; survives bets/lastCard being reset). */
  private settledOutcome: TurnOutcome | null = null;
  /** My bet this turn, kept after the server clears the bets at the payout. */
  private mine: MyBet | null = null;
  private shoutText = "";
  private shoutTone = "";
  private oddsKey = "";

  constructor(trayParent: HTMLElement, lineParent: HTMLElement, cb: BetHandlers) {
    this.cb = cb;
    const sound = (k: UiSound) => cb.onUiSound(k);

    // ---- tray
    this.tray = h("div", "ks-hud-tray", trayParent);
    const head = h("div", "ks-hud-tray__head", this.tray);
    this.question = h("span", "ks-hud-tray__q", head);
    this.secs = h("span", "ks-hud-tray__secs", head);
    const bar = h("div", "ks-hud-tray__bar", this.tray);
    this.barFill = h("div", "ks-hud-tray__fill", bar);

    const grid = h("div", "ks-hud-tray__boxes", this.tray);
    BET_BOXES.forEach((def, i) => {
      const t = BOX_TEXT[def.id];
      const root = h("button", "ks-hud-box", grid);
      root.dataset.box = def.id;
      h("span", "ks-hud-box__key", root, String(i + 1));
      h("span", "ks-hud-box__l1", root, t.l1);
      h("span", "ks-hud-box__l2", root, t.l2);
      const nums = h("span", "ks-hud-box__nums", root);
      const pay = h("span", "ks-hud-box__pay", nums);
      const odds = h("span", "ks-hud-box__odds", nums);
      odds.title = "Bu tur için kaba tahmin";
      const win = h("span", "ks-hud-box__win", root);
      const chips = h("div", "ks-hud-box__chips", root);
      root.title = `${def.desc} (${i + 1})`;
      wireButton(root, sound, () => this.clickBox(def.id), "chip");
      this.boxes.set(def.id, { id: def.id, root, pay, odds, win, chips });
    });

    const foot = h("div", "ks-hud-tray__foot", this.tray);
    this.chipRow = h("div", "ks-hud-tray__chips", foot);
    h("span", "ks-hud-tray__chiplabel", this.chipRow, "Fiş");
    CHIP_AMOUNTS.forEach((amount, i) => {
      const b = h("button", "ks-hud-pick", this.chipRow);
      h("span", "ks-hud-pick__key", b, CHIP_KEYS[i] ?? "");
      h("span", "ks-hud-pick__amt", b, String(amount));
      b.title = `${money(amount)} fiş (${CHIP_KEYS[i] ?? ""})`;
      wireButton(b, sound, () => this.pickChip(amount), "chip");
      this.chipBtns.push(b);
    });
    this.ghostNote = h("div", "ks-hud-tray__ghost", foot, `👻 Hayalet fişi: ${money(GHOST_CHIP)} bedava`);
    this.status = h("div", "ks-hud-tray__status", foot);
    this.passBtn = h("button", "ks-hud-tray__pass", foot);
    h("span", "ks-hud-tray__passkey", this.passBtn, "0");
    h("span", "", this.passBtn, "PAS");
    this.passBtn.title = "Bu tur bahis yok (0)";
    wireButton(this.passBtn, sound, () => this.pass());

    // ---- line
    this.line = h("div", "ks-hud-betline", lineParent);
    h("span", "ks-hud-betline__icon", this.line, "🎲");
    this.lineText = h("span", "ks-hud-betline__text", this.line);
    this.lineState = h("span", "ks-hud-betline__state", this.line);

    // Fallback until Game reports sent passes (Hud.betPassed → markPassed): fold the tray on 0 only when
    // Controls takes the key too (same filter: no typing, no modifiers, no key-owning window open).
    window.addEventListener("keydown", (e) => {
      if (this.passWired || (e.code !== "Digit0" && e.code !== "Numpad0") || e.repeat || !this.open) return;
      if (typingInField() || e.ctrlKey || e.metaKey || e.altKey || uiCapturesKeys()) return;
      if (this.ctx?.me && this.ctx.state.bets.get(this.ctx.me.id)) return; // 0 with a bet = take it back (Game)
      this.passed = true;
      this.cb.onLocalChange();
    });
  }

  /** Game sent my PAS: fold the tray for this turn. Once Game calls this, it alone decides (no key fallback). */
  markPassed(): void {
    this.passWired = true;
    if (this.passed) return;
    this.passed = true;
    this.cb.onLocalChange();
  }

  /** The tray owns the bottom center right now. */
  get trayOpen(): boolean {
    return this.open;
  }

  get selectedChip(): number {
    return this.selected;
  }

  setChip(amount: number): void {
    if (!(CHIP_AMOUNTS as readonly number[]).includes(amount)) return;
    this.selected = amount;
    if (this.ctx) this.update(this.ctx);
  }

  flash(box: BetBox, ok: boolean): void {
    const b = this.boxes.get(box);
    if (!b) return;
    b.root.classList.remove("ks-hud-box--ok", "ks-hud-box--deny");
    replay(b.root, ok ? "ks-hud-box--ok" : "ks-hud-box--deny");
  }

  reset(): void {
    this.turnKey = "";
    this.resetTurn();
  }

  update(ctx: HudCtx): void {
    this.ctx = ctx;
    const s = ctx.state;
    if (ctx.turnKey !== this.turnKey) {
      this.turnKey = ctx.turnKey;
      this.resetTurn();
    }
    const me = ctx.me;
    const live = me ? s.bets.get(me.id) : undefined;
    if (live && (live.amount > 0 || live.ghost)) {
      this.mine = { box: live.box, amount: live.amount, ghost: live.ghost };
      this.passed = false;
    } else if (ctx.phase === "betting" && !s.betsLocked) this.mine = null; // cancelled while still open

    const ghost = !!me?.ghost;
    const available = me ? me.kasa + (live && !live.ghost ? live.amount : 0) : 0;
    const canAfford = ghost || available >= CHIP_AMOUNTS[0] || !!live;
    const open = ctx.canBet && canAfford && !this.passed;
    if (open && !this.open) {
      replay(this.tray, "ks-hud-enter");
      this.bar.v = -1;
    }
    this.open = open;
    show(this.tray, open);
    if (open) this.updateTray(ctx, live, available, ghost);
    else this.timer.sync(0, 1, false);
    this.updateLine(ctx);
  }

  tick(dt: number): void {
    if (!this.open) return;
    this.timer.tick(dt);
    setBar(this.barFill, this.timer.frac, this.bar);
    setText(this.secs, this.timer.running ? String(this.timer.secs) : "");
    toggle(this.tray, "ks-hud-tray--low", this.timer.running && this.timer.left <= 2);
  }

  /** Payout moment: my line tells my result (or the active player's house cut). */
  settled(msg: BetsSettledMsg, myId: string): void {
    const key = `${this.turnKey}:settled`;
    if (key === this.settledKey) return;
    this.settledKey = key;
    this.settledOutcome = { raided: msg.raided, raidFlip: msg.raidFlip };
    const mine = msg.results.find((r) => r.playerId === myId);
    if (msg.activeId === myId && msg.houseCut > 0) this.shout(`Ev payı ${money(msg.houseCut, true)}`, "good");
    else if (mine) {
      if (mine.ghost) this.shout(mine.won ? "👻 DOĞRU TAHMİN!" : "👻 Tutmadı…", mine.won ? "good" : "bad");
      else if (mine.won) this.shout(`KAZANDIN ${money(mine.delta, true)}`, "good");
      else this.shout(`Fişlerin yandı ${money(-mine.amount, true)}`, "bad");
    }
    if (this.ctx) this.updateLine(this.ctx);
  }

  // ------------------------------------------------------------------ tray

  private updateTray(ctx: HudCtx, live: BetView | undefined, available: number, ghost: boolean): void {
    const s = ctx.state;
    const who = ctx.active?.nickname ?? "?";
    setText(this.question, `${who} kaçıncı kartta yanar?`);
    this.timer.sync(s.timeLeft, s.timeTotal, s.timeTotal > 0 && s.timeLeft > 0);
    toggle(this.tray, "ks-hud-tray--final", s.finalTable);

    const mult = s.finalTable ? FINAL_TABLE_MULT : 1;
    const oddsKey = `${s.sirenLevel}:${s.floorBonus}`;
    const odds = oddsKey !== this.oddsKey ? boxOdds(s.sirenLevel, s.floorBonus) : null;
    if (odds) this.oddsKey = oddsKey;
    const chip = ghost ? GHOST_CHIP : this.selected;
    for (const def of BET_BOXES) {
      const b = this.boxes.get(def.id)!;
      setText(b.pay, `×${trNum(def.payout * mult)}`);
      if (odds) setText(b.odds, `≈${pct(odds[def.id])}`);
      setText(b.win, ghost ? "👻 → ✓" : `${money(chip)} → ${money(Math.floor(chip * def.payout * mult))}`);
      toggle(b.root, "ks-hud-box--mine", live?.box === def.id);
      toggle(b.root, "ks-hud-box--short", !ghost && chip > available);
    }
    this.syncChips(ctx);

    show(this.chipRow, !ghost);
    show(this.ghostNote, ghost);
    CHIP_AMOUNTS.forEach((amount, i) => {
      const btn = this.chipBtns[i];
      setDisabled(btn, amount > available);
      toggle(btn, "ks-hud-pick--sel", amount === this.selected);
    });
    const hasBet = !!live && (live.amount > 0 || live.ghost);
    setDisabled(this.passBtn, hasBet);

    let text: string;
    let tone = "";
    if (hasBet && live) {
      const def = BET_BOX_BY_ID[live.box];
      const win = live.ghost ? "doğru tahmin" : money(Math.floor(live.amount * def.payout * mult));
      text = `Bahsin: ${live.ghost ? "👻" : money(live.amount)} → ${BOX_TEXT[live.box].short} · kazanırsa ${win} · aynı kutu: geri al`;
      tone = "mine";
    } else if (ghost) text = "Kutuya tıkla ya da 1–4 · istemezsen PAS (0)";
    else text = "Kutuya tıkla ya da 1–4 · fiş Q/W/E · istemezsen PAS (0)";
    setText(this.status, text);
    if (this.status.dataset.tone !== tone) this.status.dataset.tone = tone;
  }

  private syncChips(ctx: HudCtx): void {
    const s = ctx.state;
    const seen = new Set<string>();
    s.bets.forEach((bet: BetView, pid: string) => {
      if (!bet || (bet.amount <= 0 && !bet.ghost)) return;
      const box = this.boxes.get(bet.box);
      if (!box) return;
      seen.add(pid);
      const p = s.players.get(pid);
      let c = this.chips.get(pid);
      if (!c) {
        const root = h("span", "ks-hud-chip");
        c = { root, box: bet.box, amount: -1, ghost: bet.ghost };
        this.chips.set(pid, c);
        box.chips.appendChild(root);
        replay(root, "ks-hud-chip--drop");
      } else if (c.box !== bet.box) {
        c.box = bet.box;
        box.chips.appendChild(c.root);
        replay(c.root, "ks-hud-chip--drop");
      }
      if (c.amount !== bet.amount || c.ghost !== bet.ghost) {
        c.amount = bet.amount;
        c.ghost = bet.ghost;
        setText(c.root, bet.ghost ? "👻" : String(bet.amount));
        toggle(c.root, "ks-hud-chip--ghost", bet.ghost);
        toggle(c.root, "ks-hud-chip--big", !bet.ghost && bet.amount >= 50);
      }
      setVar(c.root, "--pc", playerColor(p?.color ?? 0));
      toggle(c.root, "ks-hud-chip--me", pid === ctx.myId);
      setAttr(c.root, "title", `${p?.nickname ?? "?"}: ${bet.ghost ? "hayalet fişi" : money(bet.amount)}`);
    });
    for (const [pid, c] of this.chips) {
      if (!seen.has(pid)) {
        c.root.remove();
        this.chips.delete(pid);
      }
    }
  }

  private clickBox(box: BetBox): void {
    const ctx = this.ctx;
    if (!ctx || !this.open || !ctx.me) {
      this.cb.onUiSound("deny");
      this.flash(box, false);
      return;
    }
    const me = ctx.me;
    const myBet = ctx.state.bets.get(me.id);
    if (me.ghost) {
      if (myBet && myBet.box === box) this.cb.onBet(box, 0);
      else this.cb.onBet(box, GHOST_CHIP);
      this.flash(box, true);
      return;
    }
    const amount = this.selected;
    if (myBet && myBet.box === box && myBet.amount === amount) {
      this.cb.onBet(box, 0); // same box, same chip: take it back
      this.flash(box, true);
      return;
    }
    const available = me.kasa + (myBet && !myBet.ghost ? myBet.amount : 0);
    if (amount > available) {
      this.cb.onUiSound("deny");
      this.flash(box, false);
      return;
    }
    this.cb.onBet(box, amount);
    this.flash(box, true);
  }

  private pickChip(amount: number): void {
    this.selected = amount;
    this.cb.onChip(amount);
    const ctx = this.ctx;
    if (ctx && this.open && ctx.me && !ctx.me.ghost) {
      // changing the chip re-places an existing bet with the new amount
      const myBet = ctx.state.bets.get(ctx.me.id);
      const available = ctx.me.kasa + (myBet && !myBet.ghost ? myBet.amount : 0);
      if (myBet && myBet.amount !== amount && amount <= available) this.cb.onBet(myBet.box, amount);
    }
    if (ctx) this.update(ctx);
  }

  private pass(): void {
    if (!this.open) return;
    if (this.passWired) {
      this.cb.onPass(); // Game sends it and calls markPassed (a refused PAS leaves the tray open)
      return;
    }
    this.passed = true;
    this.cb.onPass();
    this.cb.onLocalChange();
  }

  // ------------------------------------------------------------------ line

  private updateLine(ctx: HudCtx): void {
    let text = "";
    let state = "";
    let tone = "";
    if (this.shoutText) {
      text = this.mine ? BOX_TEXT[this.mine.box].short : "Bahisler";
      state = this.shoutText;
      tone = this.shoutTone;
    } else if (this.mine && !this.open && !ctx.myTurn && ctx.inTurn) {
      const m = this.mine;
      const def = BET_BOX_BY_ID[m.box];
      const mult = ctx.state.finalTable ? FINAL_TABLE_MULT : 1;
      const stake = m.ghost ? "👻" : money(m.amount);
      const win = m.ghost ? "✓" : money(Math.floor(m.amount * def.payout * mult));
      text = `${BOX_TEXT[m.box].short} · ${stake} → ${win}`;
      const outcome = this.settledOutcome ?? (ctx.turnOver ? { raided: ctx.raided, raidFlip: ctx.raidFlip } : null);
      if (outcome) {
        const won = boxWins(m.box, outcome);
        state = won ? "✓ tuttu" : "✗ yandı";
        tone = won ? "good" : "bad";
      } else if (!boxAlive(m.box, ctx.state.flips)) {
        state = "✗ yandı";
        tone = "bad";
      } else if (ctx.phase === "betting") state = "🔓";
      else state = "⏳";
    }
    const on = text !== "" && ctx.inTurn;
    show(this.line, on);
    if (!on) return;
    setText(this.lineText, text);
    setText(this.lineState, state);
    if (this.line.dataset.tone !== tone) this.line.dataset.tone = tone;
  }

  private shout(text: string, tone: "good" | "bad"): void {
    this.shoutText = text;
    this.shoutTone = tone;
    replay(this.line, "ks-hud-pop");
  }

  private resetTurn(): void {
    for (const c of this.chips.values()) c.root.remove();
    this.chips.clear();
    for (const b of this.boxes.values()) b.root.classList.remove("ks-hud-box--ok", "ks-hud-box--deny");
    this.settledKey = "";
    this.settledOutcome = null;
    this.mine = null;
    this.passed = false;
    this.shoutText = "";
    this.shoutTone = "";
    this.oddsKey = "";
  }
}
