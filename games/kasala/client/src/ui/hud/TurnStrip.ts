// Masa view only (hidden in first person, where the faces at the table say it): a slim row of animal tokens
// in turn order under the top plate. The active one is enlarged with a gold ring (one pop when the turn
// changes, no endless bounce, no name pill), mine has a cream ring, finished players this round get a ✓,
// ghosts fade with 👻, disconnected ones go grey. Tiny flags: 🪤 trapped, 🧿 cursed, ⚖️ lawyer, ⛓ Taşlık.

import type { PlayerView } from "../../../../shared/protocol";
import { playerColor } from "../../app/ui";
import type { HudCtx } from "./ctx";
import { animalIcon, h, replay, setText, setVar, show, toggle } from "./dom";

interface Token {
  root: HTMLDivElement;
  face: HTMLSpanElement;
  flags: HTMLSpanElement;
}

export class TurnStrip {
  readonly root: HTMLDivElement;
  private readonly tokens = new Map<string, Token>();
  private orderKey = "";
  private activeKey = "";

  constructor(parent: HTMLElement) {
    this.root = h("div", "ks-hud-strip", parent);
  }

  update(ctx: HudCtx): void {
    const s = ctx.state;
    this.syncTokens(ctx.order, ctx.myId);
    const done = this.finishedThisRound(ctx);
    const playing = ctx.inTurn || ctx.phase === "lastChance" || ctx.phase === "elimination";
    const activeKey = playing ? `${ctx.turnKey}:${s.activeId}` : "";
    const changed = activeKey !== this.activeKey;
    this.activeKey = activeKey;
    for (const p of ctx.order) {
      const t = this.tokens.get(p.id);
      if (!t) continue;
      const active = playing && p.id === s.activeId;
      toggle(t.root, "ks-hud-tok--active", active);
      if (active && changed) replay(t.root, "ks-hud-pop");
      toggle(t.root, "ks-hud-tok--done", playing && !active && done.has(p.id));
      toggle(t.root, "ks-hud-tok--ghost", p.ghost);
      toggle(t.root, "ks-hud-tok--off", !p.connected);
      toggle(t.root, "ks-hud-tok--broke", ctx.phase === "lastChance" && s.lastChanceId === p.id);
      setVar(t.root, "--pc", playerColor(p.color));
      setText(t.face, p.ghost ? "👻" : animalIcon(p.animal));
      let flags = "";
      if (p.trapped) flags += "🪤";
      if (p.cursed) flags += "🧿";
      if (p.lawyerNext) flags += "⚖️";
      if (p.taslik) flags += "⛓";
      if (!p.connected) flags += "🔌";
      setText(t.flags, flags);
      show(t.flags, flags !== "");
      const title = `${p.nickname}${p.bot ? " 🤖" : ""}${p.id === ctx.myId ? " (sen)" : ""}`;
      if (t.root.title !== title) t.root.title = title;
    }
  }

  private syncTokens(order: PlayerView[], myId: string): void {
    const key = order.map((p) => p.id).join("|") + "#" + myId;
    if (key === this.orderKey) return;
    this.orderKey = key;
    const keep = new Set(order.map((p) => p.id));
    for (const [id, t] of this.tokens) {
      if (!keep.has(id)) {
        t.root.remove();
        this.tokens.delete(id);
      }
    }
    for (const p of order) {
      let t = this.tokens.get(p.id);
      if (!t) {
        const root = h("div", "ks-hud-tok");
        const face = h("span", "ks-hud-tok__face", root);
        const flags = h("span", "ks-hud-tok__flags", root);
        t = { root, face, flags };
        this.tokens.set(p.id, t);
      }
      toggle(t.root, "ks-hud-tok--me", p.id === myId);
      this.root.appendChild(t.root); // re-append in order (moves existing nodes)
    }
  }

  /**
   * Who already played this round: the server hands turns to the next non-ghost player in turn order, so the
   * `turnInRound` non-ghost players right before the active one (cyclically) have had their turn.
   */
  private finishedThisRound(ctx: HudCtx): Set<string> {
    const out = new Set<string>();
    const order = ctx.order;
    const s = ctx.state;
    const idx = order.findIndex((p) => p.id === s.activeId);
    if (idx < 0) return out;
    let need = Math.max(0, s.turnInRound);
    const n = order.length;
    for (let k = 1; k < n && need > 0; k++) {
      const p = order[(idx - k + n) % n];
      if (p.ghost) continue;
      out.add(p.id);
      need--;
    }
    return out;
  }
}
