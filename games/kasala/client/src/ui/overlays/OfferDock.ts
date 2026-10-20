// Loan offers (§9) docked at the right edge, off the felt, so the deck and the active player's cards stay
// visible. The offer stays public (everyone sees it, "VERME!"), but only the recipient gets a real card with
// Kabul / Reddet (and the K / R keys, which also work while the mouse is locked in first person). The sender
// and everyone else get a one-line, click-through chip. Only the recipient's buttons take pointer events.

import { LOAN_OFFER_SEC } from "../../../../shared/constants";
import type { KasalaStateView, OfferView } from "../../../../shared/protocol";
import { fromName, money, toName, type UiSound } from "../../app/ui";
import { btn, h, kbd, setText, typing, vals, who } from "./dom";

export interface OfferCallbacks {
  onRespond(offerId: string, accept: boolean): void;
  sound(kind: UiSound): void;
  /** False while a modal / the match end owns the keyboard. */
  keysAllowed(): boolean;
}

interface Entry {
  root: HTMLElement;
  clock: HTMLElement;
  bar: HTMLElement;
  buttons: HTMLButtonElement[];
  frac: number;
}

/** Recipient cards at once (a third one waits its turn), and chips for everyone else's offers. */
const MAX_CARDS = 2;
const MAX_CHIPS = 3;

export class OfferDock {
  readonly el = h("div", "ks-ov-offers");
  private readonly cb: OfferCallbacks;
  private entries = new Map<string, Entry>();
  private key = "";
  private myId = "";
  /** Offers addressed to me, oldest first: K / R answer the first one still unanswered. */
  private mine: string[] = [];
  private answered = new Set<string>();

  constructor(parent: HTMLElement, cb: OfferCallbacks) {
    this.cb = cb;
    this.el.setAttribute("aria-label", "Borç teklifleri");
    this.el.setAttribute("aria-live", "polite");
    parent.appendChild(this.el);
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  clear(): void {
    if (!this.entries.size && !this.key) return;
    this.el.replaceChildren();
    this.entries.clear();
    this.mine = [];
    this.answered.clear();
    this.key = "";
  }

  render(s: KasalaStateView | null, myId: string): void {
    if (!s || !s.offers.size || s.phase === "lobby" || s.phase === "matchEnd") {
      this.clear();
      return;
    }
    if (myId !== this.myId) {
      this.myId = myId;
      this.clear();
    }
    const all = vals(s.offers);
    const cards = all.filter((o) => o.toId === myId).slice(0, MAX_CARDS);
    const chips = all.filter((o) => o.toId !== myId).slice(-MAX_CHIPS);
    const shown = [...cards, ...chips];
    const key = shown.map((o) => `${o.id}:${o.fromId}:${o.toId}:${o.kind}:${o.amount}:${o.ratePct}`).join("|");
    if (key !== this.key) {
      this.key = key;
      const next = new Map<string, Entry>();
      for (const o of shown) next.set(o.id, this.entries.get(o.id) ?? (o.toId === myId ? this.card(s, o) : this.chip(s, o, myId)));
      for (const [id, e] of this.entries) if (!next.has(id)) e.root.remove();
      // Keep surviving nodes in place (re-inserting would replay their entry animation).
      let i = 0;
      for (const e of next.values()) {
        const at = this.el.children[i] ?? null;
        if (at !== e.root) this.el.insertBefore(e.root, at);
        i++;
      }
      this.entries = next;
      for (const id of [...this.answered]) if (!next.has(id)) this.answered.delete(id);
      this.mine = cards.map((o) => o.id);
    }
    for (const o of shown) {
      const e = this.entries.get(o.id);
      if (!e) continue;
      const left = Math.max(0, o.timeLeft);
      setText(e.clock, `${Math.ceil(left)} sn`);
      const frac = Math.min(1, left / LOAN_OFFER_SEC);
      if (Math.abs(frac - e.frac) > 0.004) {
        e.frac = frac;
        e.bar.style.transform = `scaleX(${frac.toFixed(3)})`;
      }
    }
  }

  // ------------------------------------------------------------------ internals
  private onKey(e: KeyboardEvent): void {
    if (e.code !== "KeyK" && e.code !== "KeyR") return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
    const id = this.mine.find((x) => !this.answered.has(x));
    if (!id || !this.cb.keysAllowed()) return;
    e.preventDefault();
    this.answer(id, e.code === "KeyK");
  }

  private answer(id: string, accept: boolean): void {
    if (this.answered.has(id)) return;
    this.answered.add(id);
    const e = this.entries.get(id);
    if (e) {
      for (const b of e.buttons) b.disabled = true;
      e.root.dataset.answered = accept ? "yes" : "no";
    }
    this.cb.onRespond(id, accept);
    this.cb.sound(accept ? "chip" : "deny");
  }

  private timer(root: HTMLElement): { bar: HTMLElement } {
    const track = h("div", "ks-ov-offer__track");
    const bar = h("div", "ks-ov-offer__bar");
    track.setAttribute("aria-hidden", "true");
    track.appendChild(bar);
    root.appendChild(track);
    return { bar };
  }

  /** The recipient's card: who, how much, the rate, a draining bar and the two answers. */
  private card(s: KasalaStateView, o: OfferView): Entry {
    const root = h("article", "ks-ov-offer");
    root.setAttribute("role", "alertdialog");
    root.setAttribute("aria-label", o.kind === "offer" ? "Borç teklifi" : "Borç isteği");
    const head = h("header", "ks-ov-offer__head");
    const clock = h("span", "ks-ov-offer__clock");
    head.append(h("strong", "ks-ov-offer__kind", o.kind === "offer" ? "💼 Borç teklifi" : "🤝 Borç isteği"), clock);
    const from = who(s, o.fromId);
    const text = h("p", "ks-ov-offer__text");
    text.append(h("strong", "", from), document.createTextNode(o.kind === "offer" ? " sana " : " senden "), h("b", "ks-ov-money", money(o.amount)), document.createTextNode(o.kind === "offer" ? " borç veriyor." : " borç istiyor."));
    const terms = h(
      "p",
      "ks-ov-offer__terms",
      o.kind === "offer" ? `Tur faizi %${o.ratePct}: borcun her tam turda büyür.` : `Tur faizi %${o.ratePct}: alacağın her tam turda büyür.`,
    );
    root.append(head, text, terms);
    const { bar } = this.timer(root);
    const actions = h("div", "ks-ov-offer__actions");
    const yes = btn("Kabul ", () => this.answer(o.id, true), "green");
    yes.appendChild(kbd("K"));
    const no = btn("Reddet ", () => this.answer(o.id, false), "red");
    no.appendChild(kbd("R"));
    actions.append(yes, no);
    root.appendChild(actions);
    return { root, clock, bar, buttons: [yes, no], frac: 1 };
  }

  /** Everyone else: a click-through line. The sender sees their own pending offer, the rest shout "VERME!". */
  private chip(s: KasalaStateView, o: OfferView, myId: string): Entry {
    const root = h("div", "ks-ov-offer-chip");
    const from = who(s, o.fromId), to = who(s, o.toId);
    const line = h("span", "ks-ov-offer-chip__text");
    const rate = ` · %${o.ratePct}`;
    if (o.fromId === myId) {
      root.classList.add("ks-ov-offer-chip--mine");
      line.append(
        document.createTextNode(o.kind === "offer" ? "💼 Teklifin: " : "🤝 İsteğin: "),
        h("strong", "", o.kind === "offer" ? toName(to) : fromName(to)),
        document.createTextNode(" "),
        h("b", "ks-ov-money", money(o.amount)),
        document.createTextNode(rate),
      );
      root.append(line, h("small", "ks-ov-offer-chip__hint", "B: vazgeç"));
    } else {
      line.append(document.createTextNode(o.kind === "offer" ? "💼 " : "🤝 "), h("strong", "", from));
      if (o.kind === "offer") line.append(document.createTextNode(" → "), h("strong", "", toName(to)), document.createTextNode(" "));
      else line.append(document.createTextNode(", "), h("strong", "", fromName(to)), document.createTextNode(" "));
      line.append(h("b", "ks-ov-money", money(o.amount)), document.createTextNode(o.kind === "offer" ? rate : ` istiyor${rate}`));
      root.append(line, h("em", "ks-ov-offer-chip__shout", "VERME!"));
    }
    const clock = h("span", "ks-ov-offer__clock");
    root.appendChild(clock);
    const { bar } = this.timer(root);
    return { root, clock, bar, buttons: [], frac: 1 };
  }
}
