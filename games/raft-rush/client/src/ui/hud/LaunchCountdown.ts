// Boarding countdown (§2.5 of ARCHITECTURE): once someone boards a ready raft the rest have LAUNCH_WAIT_TICKS.
// "BOARDING! · The raft leaves in 0:14 · 3/5 aboard" plus what to do: "Run to the raft and press E!" (the player's
// interact key) or "You're aboard! Waiting for the stragglers…". Owner: client-ui.

import { clockText, t } from "../../i18n";
import { keyParams, keysSignature } from "../controls";
import { el, replay, setText, toggleClass } from "../dom";
import type { HudModel } from "../models";

export class LaunchCountdown {
  readonly el = el("div", "rr-launch");
  private readonly time = el("span", "rr-launch__time");
  private readonly aboard = el("span", "rr-launch__aboard");
  private readonly hint = el("p", "rr-launch__hint");
  private sec = -1;
  private sig = "";
  private active = false;

  constructor() {
    this.el.append(el("div", "rr-launch__row", el("span", "rr-launch__title", `⛵ ${t("hud.launchTitle")}`), this.time, this.aboard), this.hint);
    this.el.hidden = true;
  }

  update(l: HudModel["launch"], boarded: boolean): void {
    if (!l) {
      if (this.active) {
        this.active = false;
        this.el.hidden = true;
      }
      return;
    }
    if (!this.active) {
      this.active = true;
      this.el.hidden = false;
      replay(this.el, "is-in");
    }
    const sec = Math.max(0, Math.ceil(l.secLeft));
    if (sec !== this.sec) {
      this.sec = sec;
      setText(this.time, t("hud.launchLeaves", { t: clockText(sec) }));
      toggleClass(this.el, "is-urgent", sec <= 5);
    }
    const sig = `${l.aboard}/${l.total}/${boarded}/${keysSignature()}`;
    if (sig !== this.sig) {
      this.sig = sig;
      setText(this.aboard, t("hud.launchAboard", { n: l.aboard, total: l.total }));
      setText(this.hint, t(boarded ? "hud.launchBoarded" : "hud.launchGo", keyParams()));
      toggleClass(this.el, "is-boarded", boarded);
    }
  }
}
