// Bottom left, small: "💰 Kasan 200$ · 2." (my money, counting, with my own "+45$" popping inside the chip so
// it is never unattributed) and a "?" that pins the help panel. Ghosts read "👻 Hayaletsin · 1/3", spectators
// "👀 Seyircisin". Above it, only while I owe or am owed, one debt chip: "📒 Borcun 120$ · %10" (⛓ when
// Taşlık), click / B → loan menu. Everything else about money lives on the 3D nameplates and the Tab board.

import { GHOST_WINS_TO_RETURN } from "../../../../shared/constants";
import { money, type UiSound } from "../../app/ui";
import { Counter, type HudCtx } from "./ctx";
import { h, replay, setAttr, setText, show, toggle, wireButton } from "./dom";

export interface MyChipsHandlers {
  onLoanMenu(): void;
  onHelp(): void;
  onUiSound(kind: UiSound): void;
}

const MAX_POPS = 2;

export class MyChips {
  readonly root: HTMLDivElement;
  private readonly debt: HTMLButtonElement;
  private readonly debtText: HTMLSpanElement;
  private readonly kasa: HTMLDivElement;
  private readonly icon: HTMLSpanElement;
  private readonly label: HTMLSpanElement;
  private readonly value: HTMLSpanElement;
  private readonly counter: Counter;
  private readonly alt: HTMLSpanElement;
  private readonly place: HTMLSpanElement;
  private readonly pops: HTMLSpanElement;
  private owe = -1;
  private kind: "" | "me" | "ghost" | "spect" = "";

  constructor(parent: HTMLElement, cb: MyChipsHandlers) {
    this.root = h("div", "ks-hud-mine", parent);
    const sound = (k: UiSound) => cb.onUiSound(k);

    this.debt = h("button", "ks-hud-debtchip", this.root);
    this.debtText = h("span", "ks-hud-debtchip__text", this.debt);
    h("span", "ks-hud-debtchip__key", this.debt, "B");
    wireButton(this.debt, sound, () => cb.onLoanMenu(), "open");

    this.kasa = h("div", "ks-hud-kasa", this.root);
    this.icon = h("span", "ks-hud-kasa__icon", this.kasa, "💰");
    this.label = h("span", "ks-hud-kasa__label", this.kasa, "Kasan");
    this.value = h("span", "ks-hud-kasa__val", this.kasa);
    this.counter = new Counter(this.value, (n) => money(n), 6, 60);
    this.alt = h("span", "ks-hud-kasa__alt", this.kasa);
    this.place = h("span", "ks-hud-kasa__place", this.kasa);
    this.pops = h("span", "ks-hud-kasa__pops", this.kasa);
    const help = h("button", "ks-hud-kasa__help", this.kasa, "?");
    help.title = "Tuşlar ve son olaylar (H basılı tut)";
    help.setAttribute("aria-label", "Yardım");
    wireButton(help, sound, () => cb.onHelp());
  }

  update(ctx: HudCtx, fresh: boolean): void {
    const s = ctx.state;
    const me = ctx.me;
    const kind = ctx.spectator || !me ? "spect" : me.ghost ? "ghost" : "me";
    if (kind !== this.kind) {
      this.kind = kind;
      this.kasa.dataset.kind = kind;
    }

    // kasa / ghost / spectator chip
    if (kind === "spect") {
      setText(this.icon, "👀");
      setText(this.label, "Seyircisin");
      setText(this.alt, "sonraki maçta masadasın");
    } else if (kind === "ghost" && me) {
      setText(this.icon, "👻");
      setText(this.label, "Hayaletsin");
      setText(this.alt, me.ghostReturned ? "artık sadece bahis" : `doğru tahmin ${me.ghostWins}/${GHOST_WINS_TO_RETURN}`);
      setAttr(this.kasa, "title", me.ghostReturned ? "Nehirden bir kez döndün." : `${GHOST_WINS_TO_RETURN} doğru bahis tahmini → masaya dönersin`);
    } else if (me) {
      setText(this.icon, "💰");
      setText(this.label, "Kasan");
      const delta = this.counter.set(me.kasa, fresh);
      if (delta !== 0) this.pop(delta);
      let rank = 1;
      let alive = 0;
      for (const p of ctx.order) {
        if (p.ghost) continue;
        alive++;
        if (p.id !== me.id && p.kasa > me.kasa) rank++;
      }
      setText(this.place, alive > 1 ? (rank === 1 ? "👑" : `${rank}.`) : "");
      setAttr(this.kasa, "title", alive > 1 ? `Sıralama: ${rank}/${alive}` : "");
    }
    show(this.value, kind === "me");
    show(this.place, kind === "me" && this.place.textContent !== "");
    show(this.alt, kind !== "me");

    // debt chip: only when I owe or am owed
    let owe = 0;
    let lend = 0;
    let rate = 0;
    if (me && s.settings.loans) {
      s.debts.forEach((d) => {
        if (d.owed <= 0) return;
        if (d.borrowerId === me.id) {
          owe += d.owed;
          rate = Math.max(rate, d.ratePct);
        } else if (d.lenderId === me.id) lend += d.owed;
      });
    }
    const on = owe > 0 || lend > 0;
    show(this.debt, on);
    if (on) {
      let text: string;
      if (owe > 0 && lend > 0) text = `📒 Borcun ${money(owe)} · Alacağın ${money(lend)}`;
      else if (owe > 0) text = `${me?.taslik ? "⛓ Taşlık · " : "📒 "}Borcun ${money(owe)} · %${rate}`;
      else text = `📒 Alacağın ${money(lend)}`;
      setText(this.debtText, text);
      toggle(this.debt, "ks-hud-debtchip--owe", owe > 0);
      toggle(this.debt, "ks-hud-debtchip--taslik", !!me?.taslik);
      setAttr(this.debt, "title", owe > 0 ? `Tur faizi %${rate} · borç menüsü (B)` : "Borç menüsü (B)");
    }
    if (!fresh && this.owe >= 0 && owe > this.owe) replay(this.debt, "ks-hud-debtchip--grow");
    this.owe = owe;
  }

  tick(dt: number): void {
    if (this.kind === "me") this.counter.tick(dt);
  }

  private pop(delta: number): void {
    const up = delta > 0;
    const pop = h("span", `ks-hud-kasa__pop ${up ? "ks-hud-kasa__pop--up" : "ks-hud-kasa__pop--down"}`, this.pops, money(delta, true));
    pop.addEventListener("animationend", () => pop.remove(), { once: true });
    window.setTimeout(() => pop.remove(), 2000);
    while (this.pops.childElementCount > MAX_POPS) this.pops.firstElementChild?.remove();
    toggle(this.kasa, up ? "ks-hud-kasa--down" : "ks-hud-kasa--up", false);
    replay(this.kasa, up ? "ks-hud-kasa--up" : "ks-hud-kasa--down");
  }
}
