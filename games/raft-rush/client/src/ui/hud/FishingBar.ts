// Fishing timing bar (§8): "Waiting for a bite…" with a bobbing float while the line is out, a big red
// "CLICK NOW!" with a draining window bar the moment the bobber dips, "Reeling in…" while the reel result is on
// its way. Owner: client-ui.

import { t } from "../../i18n";
import { clamp01, el, replay, setText, setVar } from "../dom";
import type { HudModel } from "../models";

export class FishingBar {
  readonly el = el("div", "rr-fish");
  private readonly bobber = el("span", "rr-fish__bobber", el("i"));
  private readonly text = el("span", "rr-fish__text");
  private readonly fill = el("span", "rr-fish__fill");
  private state: "cast" | "bite" | "reel" | "" = "";
  private frac = -1;

  constructor() {
    this.el.append(el("div", "rr-fish__row", this.bobber, this.text), el("span", "rr-fish__window", this.fill));
    this.el.hidden = true;
  }

  update(f: HudModel["fishing"]): void {
    const state = f?.state ?? "";
    if (state !== this.state) {
      this.state = state;
      this.el.hidden = state === "";
      if (state === "") return;
      this.el.dataset.state = state;
      setText(this.text, t(state === "bite" ? "hud.fishBite" : state === "reel" ? "hud.fishReel" : "hud.fishWait"));
      if (state === "bite") replay(this.el, "is-bite-in");
    }
    if (!f) return;
    const frac = f.state === "bite" ? Math.round(clamp01(f.windowFrac) * 100) / 100 : 0;
    if (frac !== this.frac) {
      this.frac = frac;
      setVar(this.fill, "--v", `${(frac * 100).toFixed(0)}%`);
    }
  }
}
