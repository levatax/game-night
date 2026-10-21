// "The waves washed you ashore" death screen (§4, §14): seaweed dangling from the top, a goofy line, what you
// lost, and either "you'll wake up at the wreck at dawn · 0:42" or, on night 3, "no dawn is coming".
// Owner: client-ui.

import { clockText, t } from "../../i18n";
import { el, pickVariant, setText, toggleClass } from "../dom";
import type { HudModel } from "../models";

const SEAWEED = `
<svg viewBox="0 0 400 120" preserveAspectRatio="none" class="rr-washed__weed" aria-hidden="true">
  <g fill="#3E8E52" stroke="#2D2A32" stroke-width="4" stroke-linejoin="round">
    <path d="M20 0c10 30-14 46 0 78 8 18-6 30 4 42 10-16 4-26-2-40-10-24 14-40 6-80Z"/>
    <path d="M96 0c-6 22 12 34 2 56-6 14 4 22 0 34 12-10 10-22 6-32-6-18 10-32 4-58Z" fill="#5FB36A"/>
    <path d="M190 0c12 26-10 40 2 64 6 12-2 24 4 34 8-12 4-22 0-32-8-20 12-40 6-66Z"/>
    <path d="M300 0c-8 30 14 44 0 72-6 14 6 24 2 38 12-12 8-26 4-38-8-22 12-38 6-72Z" fill="#5FB36A"/>
    <path d="M372 0c8 18-8 30 2 50 6 12-2 18 2 28 8-8 6-18 2-26-6-16 8-30 4-52Z"/>
  </g>
</svg>`;

export class WashedScreen {
  readonly el = el("div", "rr-washed");
  private readonly joke = el("p", "rr-washed__joke");
  private readonly respawn = el("p", "rr-washed__respawn");
  private active = false;
  private willRespawn: boolean | null = null;
  private sec = -1;
  private jokeSeed = 0;

  constructor() {
    const tpl = document.createElement("template");
    tpl.innerHTML = SEAWEED.trim();
    const weed = tpl.content.firstElementChild;
    const card = el(
      "div",
      "rr-washed__card",
      el("span", "rr-washed__emoji", "🌊"),
      el("h2", "rr-washed__title", t("hud.washTitle")),
      this.joke,
      el("p", "rr-washed__lost", t("hud.washLost")),
      this.respawn,
    );
    if (weed) this.el.append(weed);
    this.el.append(card, el("span", "rr-washed__crab", "🦀"), el("span", "rr-washed__ball", "🏐"));
    this.el.hidden = true;
    this.el.setAttribute("role", "status");
  }

  update(w: HudModel["washed"]): void {
    if (!w) {
      if (this.active) {
        this.active = false;
        this.el.hidden = true;
      }
      return;
    }
    if (!this.active) {
      this.active = true;
      this.el.hidden = false;
      this.willRespawn = null;
      this.sec = -1;
      this.jokeSeed++;
      setText(this.joke, pickVariant(t("hud.washJokes"), Math.floor(performance.now() / 997) + this.jokeSeed));
    }
    const sec = w.willRespawn ? Math.max(0, Math.ceil(w.secToDawn)) : -1;
    if (w.willRespawn === this.willRespawn && sec === this.sec) return;
    this.willRespawn = w.willRespawn;
    this.sec = sec;
    toggleClass(this.el, "is-final", !w.willRespawn);
    setText(this.respawn, w.willRespawn ? t("hud.washRespawn", { t: clockText(sec) }) : t("hud.washNoDawn"));
  }
}
