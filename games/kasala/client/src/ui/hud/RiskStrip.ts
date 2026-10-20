// The risk, right where the decision is made (between ÇEVİR and KASALA!, §5): 12 segments green → orange → red,
// "Sonraki kart %29 BASKIN" and what a raid would cost right now ("Baskında −68$" = pot + bribe; a lawyer
// cancels it). Tags: 🪤 the turn started trapped, 🚓 Battle Royale siren floor. Replaces the old siren lamp
// panel: the 3D wall siren, the red room light and the vignette carry the mood, this carries the number.

import { SIREN_SEGMENTS } from "../../../../shared/constants";
import { money, pct } from "../../app/ui";
import { litSegments, raidCost, segColor, tierColor, tierOf, type HudCtx } from "./ctx";
import { h, replay, setAttr, setText, setVar, show, toggle } from "./dom";

export class RiskStrip {
  readonly root: HTMLDivElement;
  private readonly segs: HTMLSpanElement[] = [];
  private readonly pctEl: HTMLSpanElement;
  private readonly cost: HTMLSpanElement;
  private readonly trapTag: HTMLSpanElement;
  private readonly floorTag: HTMLSpanElement;
  private lit = 0;
  private shownLit = 0;
  private litClock = 0;
  private pctKey = "";

  constructor(parent: HTMLElement) {
    this.root = h("div", "ks-hud-risk", parent);
    const segs = h("div", "ks-hud-risk__segs", this.root);
    segs.setAttribute("aria-hidden", "true");
    for (let i = 0; i < SIREN_SEGMENTS; i++) {
      const seg = h("span", "ks-hud-risk__seg", segs);
      seg.style.setProperty("--seg", segColor(i));
      this.segs.push(seg);
    }
    const line = h("div", "ks-hud-risk__line", this.root);
    h("span", "ks-hud-risk__next", line, "Sonraki kart");
    this.pctEl = h("span", "ks-hud-risk__pct", line, "%8");
    h("span", "ks-hud-risk__word", line, "BASKIN");
    const foot = h("div", "ks-hud-risk__foot", this.root);
    this.cost = h("span", "ks-hud-risk__cost", foot);
    this.trapTag = h("span", "ks-hud-risk__tag ks-hud-risk__tag--trap", foot, "🪤");
    this.trapTag.title = "Tuzak: siren 2. seviyeden başladı";
    this.floorTag = h("span", "ks-hud-risk__tag", foot);
  }

  update(ctx: HudCtx): void {
    const s = ctx.state;
    const chance = s.raidChance;
    this.lit = litSegments(chance);
    const tier = tierOf(chance);
    setVar(this.root, "--tier", tierColor(chance));
    toggle(this.root, "ks-hud-risk--mid", tier >= 1);
    toggle(this.root, "ks-hud-risk--crit", tier >= 2);

    const text = pct(chance);
    setText(this.pctEl, text);
    if (text !== this.pctKey && this.pctKey !== "") replay(this.pctEl, "ks-hud-pop");
    this.pctKey = text;

    if (s.lawyers > 0) {
      setText(this.cost, "⚖️ Avukat kurtarır");
      setAttr(this.cost, "title", "Baskın gelirse avukatın onu iptal eder");
      toggle(this.cost, "ks-hud-risk__cost--safe", true);
    } else {
      const { pot, bribe } = raidCost(s, ctx.active);
      setText(this.cost, `Baskında ${money(-(pot + bribe), true)}`);
      setAttr(this.cost, "title", `Pot ${money(pot)} kumbaraya + rüşvet ${money(bribe)} kasadan`);
      toggle(this.cost, "ks-hud-risk__cost--safe", false);
    }

    show(this.trapTag, s.flips === 0 && s.sirenLevel > 0);
    const floor = s.settings.mode === "royale" ? s.floorBonus : 0;
    show(this.floorTag, floor > 0.0001);
    if (floor > 0.0001) {
      setText(this.floorTag, `🚓 +${pct(floor)}`);
      setAttr(this.floorTag, "title", `Battle Royale: siren tabanı +${pct(floor)}`);
    }
  }

  /** Light / drop one segment at a time so a jump reads as a quick climb. */
  tick(dt: number): void {
    if (this.shownLit === this.lit) return;
    this.litClock -= dt;
    if (this.litClock > 0) return;
    this.litClock = this.lit > this.shownLit ? 0.06 : 0.03;
    if (this.lit > this.shownLit) {
      this.segs[this.shownLit].classList.add("ks-hud-risk__seg--on");
      this.shownLit++;
    } else {
      this.shownLit--;
      this.segs[this.shownLit].classList.remove("ks-hud-risk__seg--on");
    }
  }
}
