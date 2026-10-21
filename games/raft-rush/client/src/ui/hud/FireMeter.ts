// Campfire fuel flame (§7, §12, §17): a flame that shrinks with the fuel, a fuel bar and the seconds left.
// Low (< FIRE_LOW_FRACTION) → it flickers orange-red ("LOW"); out → a grey puff of smoke and "OUT!".
// Owner: client-ui.

import { clockText, t } from "../../i18n";
import { clamp01, el, setHidden, setText, setVar, svg, toggleClass } from "../dom";
import { ICON_FLAME } from "../icons";
import type { HudModel } from "../models";

export class FireMeter {
  readonly el = el("div", "rr-fire");
  private readonly flame = el("span", "rr-fire__flame", svg(ICON_FLAME));
  private readonly fill = el("span", "rr-fire__fill");
  private readonly time = el("span", "rr-fire__time");
  private readonly tag = el("span", "rr-fire__tag");
  private frac = -1;
  private sec = -1;
  private state = "";

  constructor() {
    this.el.append(
      el("span", "rr-fire__icon", this.flame, el("span", "rr-fire__smoke", "💨")),
      el("div", "rr-fire__body", el("div", "rr-fire__row", el("span", "rr-fire__title", t("hud.fireTitle")), this.tag), el("span", "rr-fire__track", this.fill)),
      this.time,
    );
    this.el.title = t("hud.fireTitle");
  }

  update(fire: HudModel["fire"]): void {
    const frac = Math.round(clamp01(fire.frac) * 200) / 200;
    if (frac !== this.frac) {
      this.frac = frac;
      setVar(this.fill, "--v", `${(frac * 100).toFixed(1)}%`);
      setVar(this.flame, "--s", (0.55 + 0.45 * Math.sqrt(frac)).toFixed(3));
    }
    const sec = fire.lit ? Math.max(0, Math.ceil(fire.secLeft)) : 0;
    if (sec !== this.sec) {
      this.sec = sec;
      setText(this.time, fire.lit ? clockText(sec) : "");
    }
    const state = !fire.lit ? "out" : fire.low ? "low" : "ok";
    if (state !== this.state) {
      this.state = state;
      this.el.dataset.state = state;
      toggleClass(this.el, "is-out", state === "out");
      toggleClass(this.el, "is-low", state === "low");
      setText(this.tag, state === "out" ? t("hud.fireOut") : state === "low" ? t("hud.fireLow") : "");
      setHidden(this.tag, state === "ok");
    }
  }
}
