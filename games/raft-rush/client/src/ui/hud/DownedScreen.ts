// "You're down!" overlay (§4): a red-edged vignette (the renderer drops the camera and desaturates), a countdown
// ring until the waves take you, and a green ring + "A friend is pulling you up!" while someone holds E on you
// (the sub line names the player's interact key). Owner: client-ui.

import { t } from "../../i18n";
import { keyParams, keysSignature } from "../controls";
import { clamp01, el, setHidden, setText, svgEl, toggleClass } from "../dom";
import type { HudModel } from "../models";
import { DOWNED_TICKS, TICK_RATE } from "../../../../shared/constants";

const R = 44;
const C = 2 * Math.PI * R;
const DOWNED_SEC = DOWNED_TICKS / TICK_RATE;

export class DownedScreen {
  readonly el = el("div", "rr-downed");
  private readonly timerArc: SVGCircleElement;
  private readonly reviveArc: SVGCircleElement;
  private readonly secs = el("span", "rr-downed__secs");
  private readonly timerText = el("p", "rr-downed__timer");
  private readonly reviving = el("p", "rr-downed__reviving", t("hud.downReviving"));
  private readonly sub = el("p", "rr-downed__sub");
  /** keysSignature() the sub line was printed for. */
  private keysSig = "";
  private sec = -1;
  private revive = -1;
  private active = false;

  constructor() {
    const s = svgEl("svg", { viewBox: "0 0 100 100", class: "rr-downed__ring", "aria-hidden": "true" });
    svgEl("circle", { cx: 50, cy: 50, r: R, class: "rr-downed__ring-track" }, s);
    this.timerArc = svgEl("circle", { cx: 50, cy: 50, r: R, class: "rr-downed__ring-timer", "stroke-dasharray": C.toFixed(2) }, s);
    this.reviveArc = svgEl("circle", { cx: 50, cy: 50, r: R - 9, class: "rr-downed__ring-revive", "stroke-dasharray": (2 * Math.PI * (R - 9)).toFixed(2) }, s);
    const card = el(
      "div",
      "rr-downed__card",
      el("h2", "rr-downed__title", t("hud.downTitle")),
      el("div", "rr-downed__dial", s, this.secs),
      this.timerText,
      this.reviving,
      this.sub,
    );
    this.el.append(el("div", "rr-downed__vignette"), card);
    this.el.hidden = true;
    this.el.setAttribute("role", "status");
  }

  update(d: HudModel["downed"]): void {
    if (!d) {
      if (this.active) {
        this.active = false;
        this.el.hidden = true;
      }
      return;
    }
    if (!this.active) {
      this.active = true;
      this.el.hidden = false;
      this.sec = -1;
      this.revive = -1;
    }
    const keys = keysSignature();
    if (keys !== this.keysSig) {
      this.keysSig = keys;
      setText(this.sub, t("hud.downSub", keyParams()));
    }
    const sec = Math.max(0, Math.ceil(d.secLeft));
    if (sec !== this.sec) {
      this.sec = sec;
      setText(this.secs, String(sec));
      setText(this.timerText, t("hud.downTimer", { s: t("hud.seconds", { n: sec }) }));
      this.timerArc.setAttribute("stroke-dashoffset", (C * (1 - clamp01(d.secLeft / DOWNED_SEC))).toFixed(2));
      toggleClass(this.el, "is-urgent", sec <= 3);
    }
    const revive = Math.round(clamp01(d.revive) * 100) / 100;
    if (revive !== this.revive) {
      this.revive = revive;
      const rc = 2 * Math.PI * (R - 9);
      this.reviveArc.setAttribute("stroke-dashoffset", (rc * (1 - revive)).toFixed(2));
      setHidden(this.reviving, revive <= 0);
      toggleClass(this.el, "is-reviving", revive > 0);
    }
  }
}
