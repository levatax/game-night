// Top center, always on: ONE compact plate. "TUR 3/10" (+ a SON MASA ×2 tag), TUR POTU as a counting gold
// number with inline icons (×3 combo, ⚖️×1 lawyer for watchers, 🧿 curse), and a small 🐷 kumbara footer.
// Turn outcomes only recolor it (green banked / red lost); the words and the deltas belong to fx.slam and
// the 3D floats, so nothing here pops "+50$" or swaps its label.

import { ROYALE_MAX_ROUNDS } from "../../../../shared/constants";
import { money } from "../../app/ui";
import { Counter, LIVE_PHASES, type HudCtx } from "./ctx";
import { h, replay, setText, show, toggle } from "./dom";

export class TopPlate {
  readonly root: HTMLDivElement;
  private readonly round: HTMLSpanElement;
  private readonly finalTag: HTMLSpanElement;
  private readonly potBox: HTMLDivElement;
  private readonly valueEl: HTMLSpanElement;
  private readonly pot: Counter;
  private readonly combo: HTMLSpanElement;
  private readonly lawyer: HTMLSpanElement;
  private readonly curse: HTMLSpanElement;
  private readonly pig: HTMLSpanElement;
  private readonly kumbara: Counter;
  private turnKey = "";
  private lastFlips = 0;
  private potOn = false;

  constructor(parent: HTMLElement) {
    this.root = h("div", "ks-hud-plate", parent);
    const row = h("div", "ks-hud-plate__row", this.root);
    const left = h("div", "ks-hud-plate__round", row);
    this.round = h("span", "ks-hud-plate__roundnum", left, "TUR 1/1");
    this.finalTag = h("span", "ks-hud-plate__final", left, "SON MASA ×2");
    this.finalTag.title = "Son tur: kartlar, cezalar ve bahisler ×2";

    this.potBox = h("div", "ks-hud-plate__pot", row);
    h("span", "ks-hud-plate__label", this.potBox, "TUR POTU");
    this.valueEl = h("span", "ks-hud-plate__value", this.potBox);
    this.pot = new Counter(this.valueEl, (n) => money(n), 6, 45);
    const icons = h("span", "ks-hud-plate__icons", this.potBox);
    this.combo = h("span", "ks-hud-plate__icon ks-hud-plate__icon--combo", icons);
    this.combo.title = "Bu turda çevrilen kart";
    this.lawyer = h("span", "ks-hud-plate__icon ks-hud-plate__icon--lawyer", icons);
    this.lawyer.title = "Avukat: ilk baskını iptal eder";
    this.curse = h("span", "ks-hud-plate__icon ks-hud-plate__icon--curse", icons, "🧿");
    this.curse.title = "Lanetli: ilk para kartı 0$";

    const foot = h("div", "ks-hud-plate__foot", this.root);
    this.pig = h("span", "ks-hud-plate__pig", foot, "🐷");
    h("span", "ks-hud-plate__klabel", foot, "Kumbara");
    const kval = h("span", "ks-hud-plate__kval", foot);
    this.kumbara = new Counter(kval, (n) => money(n), 5, 50);
    foot.title = "Patronun Kumbarası: baskınlar ve kaybeden bahisler buraya akar";
  }

  /** A fresh match: numbers snap instead of counting from the old match. */
  reset(): void {
    this.turnKey = "";
    this.lastFlips = 0;
    this.pot.set(0, true);
    this.root.classList.remove("ks-hud-plate--lost", "ks-hud-plate--banked");
  }

  update(ctx: HudCtx, fresh: boolean): void {
    const s = ctx.state;
    const royale = s.settings.mode === "royale";
    const total = Math.max(1, royale ? s.totalRounds || ROYALE_MAX_ROUNDS : s.totalRounds);
    const round = Math.max(1, Math.min(total, s.round || 1));
    setText(this.round, `TUR ${round}/${total}`);
    show(this.finalTag, s.finalTable);
    toggle(this.root, "ks-hud-plate--final", s.finalTable);

    // kumbara footer
    const kd = this.kumbara.set(s.kumbara, fresh);
    if (kd > 0) replay(this.pig, "ks-hud-pop");

    // pot: only while a turn is on the table
    const potOn = LIVE_PHASES.has(ctx.phase) || ctx.phase === "result" || ctx.phase === "settle";
    if (potOn !== this.potOn) {
      this.potOn = potOn;
      show(this.potBox, potOn);
    }
    if (!potOn) return;

    const newTurn = ctx.turnKey !== this.turnKey;
    if (newTurn) {
      this.turnKey = ctx.turnKey;
      this.lastFlips = s.flips;
      this.root.classList.remove("ks-hud-plate--lost", "ks-hud-plate--banked");
    }
    const delta = this.pot.set(s.turnPot, newTurn || fresh);
    if (delta !== 0 && !ctx.turnOver) {
      const up = delta > 0;
      toggle(this.valueEl, up ? "ks-hud-plate__value--down" : "ks-hud-plate__value--up", false);
      replay(this.valueEl, up ? "ks-hud-plate__value--up" : "ks-hud-plate__value--down");
    }

    const flips = s.flips;
    show(this.combo, flips > 0);
    if (flips > 0) {
      setText(this.combo, `×${flips}`);
      toggle(this.combo, "ks-hud-plate__icon--hot", flips >= 4);
      if (flips > this.lastFlips) replay(this.combo, "ks-hud-pop");
    }
    this.lastFlips = flips;

    // the active player sees the lawyer as a chip on ÇEVİR; watchers see it here
    const lawyerHere = s.lawyers > 0 && !ctx.myTurn && !ctx.turnOver;
    show(this.lawyer, lawyerHere);
    if (lawyerHere) setText(this.lawyer, `⚖️×${s.lawyers}`);
    show(this.curse, s.curseArmed && !ctx.turnOver);

    toggle(this.root, "ks-hud-plate--lost", ctx.turnOver && ctx.raided);
    toggle(this.root, "ks-hud-plate--banked", ctx.turnOver && !ctx.raided);
    toggle(this.root, "ks-hud-plate--empty", s.turnPot <= 0 && flips === 0);
  }

  tick(dt: number): void {
    if (this.potOn) this.pot.tick(dt);
    this.kumbara.tick(dt);
  }
}
