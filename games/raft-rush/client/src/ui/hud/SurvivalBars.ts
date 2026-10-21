// Bottom-left survival bars (§5, §17): health, hunger, thirst, warmth. Owner: client-ui.
// Each bar has its icon right next to its color (never color alone). Below LOW_BAR_FRACTION a bar flashes; with
// reducedFlashing it gets a steady red outline and a "!" badge instead.

import { t } from "../../i18n";
import { BAR_COLORS } from "../content";
import { clamp01, el, setAttr, setVar, svg, toggleClass } from "../dom";
import { ICON_FLAME, ICON_HEART, ICON_HUNGER, ICON_THIRST } from "../icons";
import type { HudModel } from "../models";

type BarId = "hp" | "hunger" | "thirst" | "warmth";

const BARS: ReadonlyArray<{ id: BarId; icon: string }> = [
  { id: "hp", icon: ICON_HEART },
  { id: "hunger", icon: ICON_HUNGER },
  { id: "thirst", icon: ICON_THIRST },
  { id: "warmth", icon: ICON_FLAME },
];

interface BarView {
  row: HTMLElement;
  fill: HTMLElement;
  value: number;
  low: boolean;
}

export class SurvivalBars {
  readonly el = el("div", "rr-bars");
  private readonly views = new Map<BarId, BarView>();

  constructor() {
    for (const b of BARS) {
      const fill = el("span", "rr-bar__fill");
      const track = el("span", "rr-bar__track", fill, el("span", "rr-bar__shine"));
      const row = el("div", `rr-bar rr-bar--${b.id}`, el("span", "rr-bar__icon", svg(b.icon)), track, el("span", "rr-bar__alert", "!"));
      row.setAttribute("role", "meter");
      row.setAttribute("aria-label", t(`hud.bar_${b.id}`));
      row.setAttribute("aria-valuemin", "0");
      row.setAttribute("aria-valuemax", "100");
      row.style.setProperty("--bar-color", BAR_COLORS[b.id]);
      this.views.set(b.id, { row, fill, value: -1, low: false });
      this.el.append(row);
    }
  }

  update(m: HudModel): void {
    this.set("hp", m.hp, m.low.hp);
    this.set("hunger", m.hunger, m.low.hunger);
    this.set("thirst", m.thirst, m.low.thirst);
    this.set("warmth", m.warmth, m.low.warmth);
  }

  private set(id: BarId, raw: number, low: boolean): void {
    const v = this.views.get(id);
    if (!v) return;
    const value = Math.round(clamp01(raw) * 100);
    if (value !== v.value) {
      v.value = value;
      setVar(v.fill, "--v", `${value}%`);
      setAttr(v.row, "aria-valuenow", String(value));
      toggleClass(v.row, "is-empty", value <= 0);
    }
    if (low !== v.low) {
      v.low = low;
      toggleClass(v.row, "is-low", low);
    }
  }
}
