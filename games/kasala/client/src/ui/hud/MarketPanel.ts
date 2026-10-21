// The Pazar (phase market), bottom center, in two shapes:
// - shop (I can buy): one button per row card still on the table, in row order (keys 1–9): icon, name, its
//   value and its price ("💼 Çanta · 100$ · 50$'a al"), my secret pick ringed gold; PAS (0); how many buyers
//   have chosen; the countdown. A card I can't pay for is dimmed.
// - window (the seller, broke players, ghosts, spectators): the same cards without buttons. The seller sees
//   what each sale would bring them ("+50$ sana").
// The reveal is the 3D's (cards fly to the buyers, chips to the seller) and the feed's; the panel folds when
// the phase ends.

import { CARD_BY_ID, marketFee } from "../../../../shared/constants";
import type { RowCardView } from "../../../../shared/protocol";
import { money, ofName, type UiSound } from "../../app/ui";
import { Countdown, setBar, type HudCtx } from "./ctx";
import { h, replay, setAttr, setDisabled, setText, show, toggle, wireButton } from "./dom";

export interface MarketHandlers {
  /** A row card (flipNo) or 0 = pas. */
  onPick(flipNo: number): void;
  onUiSound(kind: UiSound): void;
}

interface Slot {
  flipNo: number;
  root: HTMLButtonElement;
  value: HTMLSpanElement;
  fee: HTMLSpanElement;
}

/** Row cards still on the table, in flip order. */
function onTable(ctx: HudCtx): RowCardView[] {
  const out: RowCardView[] = [];
  ctx.state.row.forEach((c) => {
    if (!c.ownerId) out.push(c);
  });
  return out;
}

export class MarketPanel {
  readonly root: HTMLDivElement;
  private readonly cb: MarketHandlers;
  private readonly title: HTMLSpanElement;
  private readonly secs: HTMLSpanElement;
  private readonly barFill: HTMLDivElement;
  private readonly bar = { v: -1 };
  private readonly grid: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly passBtn: HTMLButtonElement;
  private readonly timer = new Countdown();
  private slots: Slot[] = [];
  private slotKey = "";
  private open = false;
  private turnKey = "";
  /** My pick in this market: -1 none yet, 0 pas, else a flip number. Only I know it until the reveal. */
  private pick = -1;

  constructor(parent: HTMLElement, cb: MarketHandlers) {
    this.cb = cb;
    this.root = h("div", "ks-hud-tray ks-hud-shop", parent);
    const head = h("div", "ks-hud-tray__head", this.root);
    this.title = h("span", "ks-hud-tray__q", head);
    this.secs = h("span", "ks-hud-tray__secs", head);
    const bar = h("div", "ks-hud-tray__bar", this.root);
    this.barFill = h("div", "ks-hud-tray__fill", bar);
    this.grid = h("div", "ks-hud-shop__cards", this.root);
    const foot = h("div", "ks-hud-tray__foot", this.root);
    this.status = h("div", "ks-hud-tray__status", foot);
    this.passBtn = h("button", "ks-hud-tray__pass", foot);
    h("span", "ks-hud-tray__passkey", this.passBtn, "0");
    h("span", "", this.passBtn, "PAS");
    this.passBtn.title = "Bu pazarda alışveriş yok (0)";
    wireButton(this.passBtn, (k) => cb.onUiSound(k), () => cb.onPick(0));
  }

  /** Game sent my pick (0 = pas): ring it until the reveal. */
  picked(flipNo: number): void {
    this.pick = flipNo;
    for (const slot of this.slots) {
      const mine = slot.flipNo === flipNo;
      if (mine && !slot.root.classList.contains("ks-hud-box--mine")) replay(slot.root, "ks-hud-box--ok");
      toggle(slot.root, "ks-hud-box--mine", mine);
    }
    toggle(this.passBtn, "ks-hud-shop__pass--mine", flipNo === 0);
  }

  reset(): void {
    this.turnKey = "";
    this.pick = -1;
  }

  update(ctx: HudCtx): void {
    const s = ctx.state;
    if (ctx.turnKey !== this.turnKey) {
      this.turnKey = ctx.turnKey;
      this.pick = -1;
    }
    const open = ctx.phase === "market";
    if (open && !this.open) {
      replay(this.root, "ks-hud-enter");
      this.bar.v = -1;
    }
    this.open = open;
    show(this.root, open);
    if (!open) {
      this.timer.sync(0, 1, false);
      return;
    }

    const cards = onTable(ctx);
    const me = ctx.me;
    const seller = ctx.myTurn;
    const shopper = !seller && ctx.participant && !!me && !me.ghost && cards.some((c) => marketFee(c.value) <= me.kasa);
    const owner = ctx.active ? ofName(ctx.active.nickname) : "Masanın";
    setText(this.title, seller ? "🛒 PAZAR: rakipler vitrinine bakıyor" : shopper ? `🛒 PAZAR: ${owner} vitrininden bir kart seç` : `🛒 PAZAR: ${owner} vitrini`);
    this.timer.sync(s.timeLeft, s.timeTotal, !s.busy && s.timeTotal > 0 && s.timeLeft > 0);
    toggle(this.root, "ks-hud-tray--final", s.finalTable);
    toggle(this.root, "ks-hud-shop--window", !shopper);

    this.layout(cards);
    for (const slot of this.slots) {
      const card = cards.find((c) => c.flipNo === slot.flipNo);
      if (!card) continue;
      const fee = marketFee(card.value);
      setText(slot.value, money(card.value));
      setText(slot.fee, seller ? `${money(fee, true)} sana` : `${money(fee)}'a al`);
      const afford = !!me && fee <= me.kasa;
      setDisabled(slot.root, !shopper || !afford);
      toggle(slot.root, "ks-hud-shop__card--short", shopper && !afford);
      toggle(slot.root, "ks-hud-box--mine", shopper && this.pick === slot.flipNo);
    }
    show(this.passBtn, shopper);
    toggle(this.passBtn, "ks-hud-shop__pass--mine", this.pick === 0);

    // who still has to choose (the server keeps the choices secret, only that they chose)
    const buyers = ctx.order.filter((p) => p.id !== s.activeId && !p.ghost && cards.some((c) => marketFee(c.value) <= p.kasa));
    const done = buyers.filter((p) => s.marketDone.indexOf(p.id) >= 0).length;
    const count = buyers.length ? ` · ${done}/${buyers.length} seçti` : "";
    let status: string;
    let tone = "";
    if (s.busy) status = "Kartlar sahiplerine gidiyor…";
    else if (seller) status = `Satılan her kart için ücret senin. Kalanlar kumbaraya${count}`;
    else if (!shopper) status = `Bu pazarda alacak paran yok${count}`;
    else if (this.pick > 0) {
      const card = cards.find((c) => c.flipNo === this.pick);
      status = `Seçimin: ${card ? CARD_BY_ID[card.id].name : "?"} (gizli). Aynı kartı isteyen olursa kasası az olan alır${count}`;
      tone = "mine";
    } else if (this.pick === 0) status = `Pas geçtin${count}`;
    else status = `Aynı kartı başkası da isterse kasası az olan alır${count}`;
    setText(this.status, status);
    setAttr(this.status, "data-tone", tone);
  }

  tick(dt: number): void {
    if (!this.open) return;
    this.timer.tick(dt);
    setBar(this.barFill, this.timer.frac, this.bar);
    setText(this.secs, this.timer.running ? String(this.timer.secs) : "");
    toggle(this.root, "ks-hud-tray--low", this.timer.running && this.timer.left <= 3);
  }

  /** One button per card on sale; rebuilt only when the set of cards changes. */
  private layout(cards: RowCardView[]): void {
    const key = cards.map((c) => `${c.flipNo}:${c.id}`).join("|");
    if (key === this.slotKey) return;
    this.slotKey = key;
    this.grid.replaceChildren();
    this.slots = cards.map((card, i) => {
      const def = CARD_BY_ID[card.id];
      const root = h("button", "ks-hud-box ks-hud-shop__card", this.grid);
      root.dataset.rarity = def.rarity;
      h("span", "ks-hud-box__key", root, i < 9 ? String(i + 1) : "");
      h("span", "ks-hud-shop__icon", root, def.icon);
      h("span", "ks-hud-shop__name", root, def.name);
      const value = h("span", "ks-hud-shop__value", root);
      const fee = h("span", "ks-hud-shop__fee", root);
      root.title = `${def.name}: ${money(card.value)} değerinde, ${money(marketFee(card.value))} öde (${i + 1})`;
      wireButton(root, (k) => this.cb.onUiSound(k), () => this.cb.onPick(card.flipNo), "chip");
      return { flipNo: card.flipNo, root, value, fee };
    });
    setAttr(this.grid, "data-n", String(cards.length));
  }
}
