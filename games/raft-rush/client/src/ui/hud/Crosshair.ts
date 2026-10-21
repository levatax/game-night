// Center crosshair (§11, §17): a dot by default, open brackets while a throwable is in hand, a soft ring when
// something interactable is in view, hidden in menus / cinematics. Owner: client-ui.

import { el, setHidden } from "../dom";
import type { HudModel } from "../models";

export class Crosshair {
  readonly el = el("div", "rr-cross", el("span", "rr-cross__dot"), el("span", "rr-cross__ring"), el("span", "rr-cross__brackets", el("i"), el("i")));
  private style: HudModel["crosshair"] | "" = "";

  update(style: HudModel["crosshair"]): void {
    if (style === this.style) return;
    this.style = style;
    this.el.dataset.style = style;
    setHidden(this.el, style === "hidden");
  }
}
