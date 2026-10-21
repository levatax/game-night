// Top-left teammate chips: mini portrait in the seat color, name, a tiny health bar and one state badge
// (DOWN pulses so a revive is never missed, ASHORE, ABOARD, AWAY while reconnecting; bots get a 🤖).
// Owner: client-ui.

import { t } from "../../i18n";
import { clamp01, el, setText, setVar, svg, toggleClass } from "../dom";
import { portraitSvg } from "../icons";
import type { TeammateModel } from "../models";

interface MateView {
  root: HTMLElement;
  name: HTMLElement;
  fill: HTMLElement;
  badge: HTMLElement;
  sig: string;
  hp: number;
  state: string;
}

function stateOf(m: TeammateModel): "down" | "washed" | "aboard" | "away" | "" {
  if (m.washed) return "washed";
  if (m.downed) return "down";
  if (m.boarded) return "aboard";
  if (!m.connected && !m.bot) return "away";
  return "";
}

export class Teammates {
  readonly el = el("ul", "rr-mates");
  private readonly views = new Map<string, MateView>();
  private order = "";

  update(mates: readonly TeammateModel[]): void {
    const order = mates.map((m) => m.id).join("|");
    if (order !== this.order) {
      this.order = order;
      const keep = new Set(mates.map((m) => m.id));
      for (const [id, v] of this.views) {
        if (!keep.has(id)) {
          v.root.remove();
          this.views.delete(id);
        }
      }
      for (const m of mates) {
        let v = this.views.get(m.id);
        if (!v) v = this.create(m);
        this.el.append(v.root);
      }
    }
    for (const m of mates) {
      const v = this.views.get(m.id);
      if (v) this.render(v, m);
    }
  }

  private create(m: TeammateModel): MateView {
    const name = el("span", "rr-mate__name");
    const fill = el("span", "rr-mate__fill");
    const badge = el("span", "rr-mate__badge");
    const root = el("li", "rr-mate", el("span", "rr-mate__face"), el("span", "rr-mate__body", name, el("span", "rr-mate__hp", fill)), badge);
    const v: MateView = { root, name, fill, badge, sig: "", hp: -1, state: "?" };
    this.views.set(m.id, v);
    return v;
  }

  private render(v: MateView, m: TeammateModel): void {
    const sig = `${m.nickname}|${m.character}|${m.color}|${m.bot}`;
    if (sig !== v.sig) {
      v.sig = sig;
      setText(v.name, m.bot ? `🤖 ${m.nickname}` : m.nickname);
      v.root.title = m.nickname;
      setVar(v.root, "--slot", m.color);
      const face = v.root.querySelector(".rr-mate__face");
      face?.replaceChildren(svg(portraitSvg(m.character)));
    }
    const hp = Math.round(clamp01(m.hp) * 100);
    if (hp !== v.hp) {
      v.hp = hp;
      setVar(v.fill, "--v", `${hp}%`);
      toggleClass(v.root, "is-hurt", hp < 30);
    }
    const state = stateOf(m);
    if (state !== v.state) {
      v.state = state;
      v.root.dataset.state = state;
      setText(v.badge, state ? t(`hud.mate_${state}`) : "");
      v.badge.hidden = state === "";
    }
  }
}
