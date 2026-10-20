// HUD top right: mini scoreboard (color dot, name, points, crown). Rows slide when ranks change.
// Owner: client-ui.

import { el, play, setText, svg } from "../dom";
import { ICON_CROWN } from "../icons";
import type { ScoreRow } from "../models";

interface RowView {
  li: HTMLLIElement;
  name: HTMLElement;
  points: HTMLElement;
  emoji: HTMLElement;
  signature: string;
  pointsValue: number;
  index: number;
}

function rowSignature(r: ScoreRow): string {
  return `${r.nickname}|${r.emoji}|${r.color}|${r.hasCrown}|${r.isYou}|${r.alive}|${r.connected}`;
}

export class MiniScoreboard {
  readonly el = el("ol", "mini-board");
  private readonly rows = new Map<string, RowView>();

  constructor() {
    this.el.setAttribute("aria-label", "Scores");
  }

  update(rows: readonly ScoreRow[]): void {
    const seen = new Set<string>();
    rows.forEach((r, index) => {
      seen.add(r.id);
      const view = this.rows.get(r.id) ?? this.create(r.id);
      this.render(view, r, index);
    });
    for (const [id, view] of this.rows) {
      if (seen.has(id)) continue;
      view.li.remove();
      this.rows.delete(id);
    }
    this.el.style.setProperty("--rows", String(rows.length));
  }

  private create(id: string): RowView {
    const li = el("li", "mini-row");
    const emoji = el("span", "mini-row__emoji");
    const name = el("span", "mini-row__name");
    const points = el("span", "mini-row__points");
    li.append(el("i", "color-dot"), emoji, name, el("span", "mini-row__crown", svg(ICON_CROWN)), el("span", "mini-row__out", "OUT"), points);
    this.el.append(li);
    const view: RowView = { li, name, points, emoji, signature: "", pointsValue: Number.NaN, index: -1 };
    this.rows.set(id, view);
    return view;
  }

  private render(view: RowView, r: ScoreRow, index: number): void {
    const signature = rowSignature(r);
    if (signature !== view.signature) {
      view.signature = signature;
      view.li.style.setProperty("--slot", r.color);
      view.li.classList.toggle("is-you", r.isYou);
      view.li.classList.toggle("has-crown", r.hasCrown);
      view.li.classList.toggle("is-out", !r.alive);
      view.li.classList.toggle("is-away", !r.connected);
      setText(view.emoji, r.emoji);
      setText(view.name, r.nickname);
    }
    if (r.points !== view.pointsValue) {
      const gained = Number.isFinite(view.pointsValue) && r.points > view.pointsValue;
      view.pointsValue = r.points;
      setText(view.points, String(r.points));
      if (gained) play(view.points, [{ transform: "scale(1.7)", color: "#FFCF33" }, { transform: "scale(1)" }], { duration: 450, easing: "ease-out" });
    }
    if (index !== view.index) {
      view.index = index;
      view.li.style.transform = `translateY(calc(${index} * var(--mini-row-h)))`;
    }
  }
}
