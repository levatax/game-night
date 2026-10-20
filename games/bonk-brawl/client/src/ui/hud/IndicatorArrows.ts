// Off-screen incoming-ball arrows at the screen edge (data from fx/Indicators). Owner: client-ui.

import { el, svg } from "../dom";
import { ICON_ARROW, ICON_BALL } from "../icons";
import type { OffscreenIndicator } from "../models";

interface ArrowView {
  root: HTMLElement;
  color: string;
  urgent: boolean;
}

const URGENT_AT = 0.6;

export class IndicatorArrows {
  readonly el = el("div", "indicators");
  private readonly arrows = new Map<string, ArrowView>();
  private readonly seen = new Set<string>();

  update(list: readonly OffscreenIndicator[]): void {
    this.seen.clear();
    for (const ind of list) {
      this.seen.add(ind.id);
      const view = this.arrows.get(ind.id) ?? this.create(ind.id);
      this.place(view, ind);
    }
    for (const [id, view] of this.arrows) {
      if (this.seen.has(id)) continue;
      view.root.remove();
      this.arrows.delete(id);
    }
  }

  clear(): void {
    for (const view of this.arrows.values()) view.root.remove();
    this.arrows.clear();
  }

  private create(id: string): ArrowView {
    const root = el("div", "incoming", el("span", "incoming__arrow", svg(ICON_ARROW)), el("span", "incoming__ball", svg(ICON_BALL)));
    this.el.append(root);
    const view: ArrowView = { root, color: "", urgent: false };
    this.arrows.set(id, view);
    return view;
  }

  private place(view: ArrowView, ind: OffscreenIndicator): void {
    const urgency = Math.max(0, Math.min(1, ind.urgency));
    const scale = 0.75 + urgency * 0.55;
    view.root.style.transform = `translate3d(${ind.x.toFixed(1)}px, ${ind.y.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
    view.root.style.setProperty("--angle", `${ind.angle.toFixed(3)}rad`);
    if (ind.color !== view.color) {
      view.color = ind.color;
      view.root.style.setProperty("--pc", ind.color);
    }
    const urgent = urgency >= URGENT_AT;
    if (urgent !== view.urgent) {
      view.urgent = urgent;
      view.root.classList.toggle("is-urgent", urgent);
    }
  }
}
