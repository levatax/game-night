// On-demand help, bottom left: the key legend (clickable where a mouse helps) and, while H is held, the last
// six feed lines. Shown automatically only during my first turn of a match ("keys"), otherwise only while H is
// held or the "?" on my kasa chip pinned it ("full").

import type { UiSound } from "../../app/ui";
import type { FeedEntry } from "./Feed";
import { h, show, toggle, wireButton } from "./dom";

export type LegendMode = "off" | "keys" | "full";

export interface LegendHandlers {
  onEmotePicker(): void;
  onTauntPicker(): void;
  onLoanMenu(): void;
  onScoreboard(): void;
  onSettings(): void;
  onView(): void;
  onUiSound(kind: UiSound): void;
}

export class Legend {
  readonly root: HTMLDivElement;
  private readonly loanRow: HTMLElement;
  private readonly histBox: HTMLDivElement;
  private readonly histList: HTMLDivElement;
  private readonly histEmpty: HTMLDivElement;
  private mode: LegendMode = "off";
  private histVersion = -1;

  constructor(parent: HTMLElement, cb: LegendHandlers) {
    this.root = h("div", "ks-hud-legend", parent);
    const sound = (k: UiSound) => cb.onUiSound(k);
    const grid = h("div", "ks-hud-legend__keys", this.root);

    // Short labels so two columns fit a ~140px column at 1280×800; the tooltip has the long form.
    const row = (keys: string[], label: string, title: string, action?: () => void): HTMLElement => {
      const node = action ? h("button", "ks-hud-legend__row ks-hud-legend__row--btn", grid) : h("div", "ks-hud-legend__row", grid);
      const kk = h("span", "ks-hud-legend__kbds", node);
      for (const k of keys) h("kbd", "ks-hud-legend__kbd", kk, k);
      h("span", "ks-hud-legend__label", node, label);
      node.title = title;
      if (action && node instanceof HTMLButtonElement) {
        node.setAttribute("aria-label", `${keys.join(" ")}: ${title}`);
        wireButton(node, sound, action);
      }
      return node;
    };
    row(["Space"], "ÇEVİR", "Kart çevir");
    row(["Enter"], "KASALA!", "Turu kasala, potu kasana at");
    row(["1–4"], "Bahis kutusu", "Bahis kutusuna fiş koy");
    row(["Q", "W", "E"], "Fiş seç", "Fiş seç: 10$ / 25$ / 50$");
    row(["0"], "Bahis yok", "Bu tur bahis yok (PAS)");
    row(["Z", "X"], "Bağır", "Z: «ÇEVİR!» · X: «KASALA!» diye bağır");
    row(["T"], "Emote", "Emote seç", () => cb.onEmotePicker());
    row(["Y"], "Laf at", "Laf sok", () => cb.onTauntPicker());
    this.loanRow = row(["B"], "Borç", "Borç masası", () => cb.onLoanMenu());
    this.loanRow.classList.add("ks-hud-legend__row--loan");
    row(["Tab"], "Skor tablosu", "Kasa tablosu", () => cb.onScoreboard());
    row(["V"], "Kamera", "Kamera: göz / masa", () => cb.onView());
    row(["Esc"], "Menü", "Ayarlar ve menü", () => cb.onSettings());
    h("div", "ks-hud-legend__hint", this.root, "H'yi basılı tut: bu yardım + son olaylar");

    this.histBox = h("div", "ks-hud-legend__hist", this.root);
    h("div", "ks-hud-legend__title", this.histBox, "SON OLAYLAR");
    this.histList = h("div", "ks-hud-legend__list", this.histBox);
    this.histEmpty = h("div", "ks-hud-legend__empty", this.histBox, "Henüz bir şey olmadı.");
  }

  setLoans(on: boolean): void {
    show(this.loanRow, on);
  }

  render(mode: LegendMode, history: readonly FeedEntry[], version: number): void {
    if (mode !== this.mode) {
      if (this.mode === "off") this.root.classList.add("ks-hud-enter");
      this.mode = mode;
      show(this.root, mode !== "off");
      toggle(this.root, "ks-hud-legend--full", mode === "full");
      show(this.histBox, mode === "full");
      if (mode === "off") this.root.classList.remove("ks-hud-enter");
    }
    if (mode !== "full" || version === this.histVersion) return;
    this.histVersion = version;
    this.histList.replaceChildren();
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i];
      const line = h("div", "ks-hud-legend__line", this.histList);
      if (e.icon) h("span", "ks-hud-legend__icon", line, e.icon);
      const body = h("span", "ks-hud-legend__text", line);
      body.innerHTML = e.html; // pre-escaped by Game (same HTML the feed showed)
    }
    show(this.histEmpty, history.length === 0);
  }
}
