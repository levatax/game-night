// Throw charge ring around the crosshair (§11): fills yellow → orange over CHARGE_FULL_TICKS, "MAX!" pulses at a
// full charge (the dotted arc preview itself is 3D, drawn by fx). Owner: client-ui.

import { FULL_CHARGE_THRESHOLD } from "../../../../shared/constants";
import { t } from "../../i18n";
import { clamp01, el, setHidden, setVar, svgEl, toggleClass } from "../dom";

const R = 26;
const C = 2 * Math.PI * R;

export class ChargeBar {
  readonly el = el("div", "rr-charge");
  private readonly arc: SVGCircleElement;
  private readonly max = el("span", "rr-charge__max", t("hud.chargeMax"));
  private value = -1;

  constructor() {
    const s = svgEl("svg", { viewBox: "0 0 64 64", class: "rr-charge__svg", "aria-hidden": "true" });
    svgEl("circle", { cx: 32, cy: 32, r: R, class: "rr-charge__track" }, s);
    this.arc = svgEl("circle", { cx: 32, cy: 32, r: R, class: "rr-charge__arc", "stroke-dasharray": C.toFixed(2), "stroke-dashoffset": C.toFixed(2) }, s);
    this.el.append(s, this.max);
    this.el.hidden = true;
    this.max.hidden = true;
  }

  update(charge: number): void {
    const v = Math.round(clamp01(charge) * 100) / 100;
    if (v === this.value) return;
    this.value = v;
    setHidden(this.el, v <= 0);
    if (v <= 0) return;
    this.arc.setAttribute("stroke-dashoffset", (C * (1 - v)).toFixed(2));
    setVar(this.el, "--c", String(v));
    const full = v >= FULL_CHARGE_THRESHOLD;
    toggleClass(this.el, "is-full", full);
    setHidden(this.max, !full);
  }
}
