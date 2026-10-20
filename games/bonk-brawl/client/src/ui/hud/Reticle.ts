// HUD center: crosshair that tightens while charging, with a curved charge meter under it.
// Owner: client-ui.

import { el, play, setVar, svg } from "../dom";
import type { HudModel } from "../models";

const SVG_NS = "http://www.w3.org/2000/svg";
/** A gentle smile under the crosshair; pathLength 100 makes the dash math a percentage. */
const ARC_PATH = "M14 12 Q80 52 146 12";

function arcSvg(): { root: SVGSVGElement; fill: SVGPathElement } {
  const root = svg(`<svg viewBox="0 0 160 46" class="charge-arc"></svg>`);
  const make = (cls: string) => {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", ARC_PATH);
    p.setAttribute("pathLength", "100");
    p.setAttribute("class", cls);
    root.append(p);
    return p;
  };
  make("charge-arc__outline");
  make("charge-arc__track");
  const fill = make("charge-arc__fill");
  make("charge-arc__shine");
  return { root, fill };
}

export class Reticle {
  readonly el = el("div", "reticle");

  private readonly cross = el("div", "crosshair", el("i", "crosshair__ring"), el("i", "crosshair__dot"));
  private readonly arc = arcSvg();
  private readonly max = el("span", "charge-max outlined", "MAX!");
  private charging: boolean | null = null;
  private full: boolean | null = null;
  private charge = "";

  constructor() {
    for (const side of ["t", "r", "b", "l"]) this.cross.append(el("i", `crosshair__tick crosshair__tick--${side}`));
    this.max.dataset.text = "MAX!";
    const meter = el("div", "charge", this.arc.root, this.max);
    this.el.append(this.cross, meter);
  }

  update(m: HudModel): void {
    setVar(this.el, "--player", m.color);
    setVar(this.el, "--spread", (Math.round(Math.max(0, Math.min(1, m.crosshairSpread)) * 100) / 100).toFixed(2));

    const charge = (Math.round(Math.max(0, Math.min(1, m.charge)) * 200) / 2).toFixed(1);
    if (charge !== this.charge) {
      this.charge = charge;
      this.arc.fill.style.strokeDashoffset = String(100 - Number(charge));
    }
    if (m.charging !== this.charging) {
      this.charging = m.charging;
      this.el.classList.toggle("is-charging", m.charging);
    }
    if (m.fullCharge !== this.full) {
      const became = this.full === false && m.fullCharge;
      this.full = m.fullCharge;
      this.el.classList.toggle("is-full", m.fullCharge);
      if (became) play(this.max, [{ transform: "scale(0.3) rotate(-12deg)" }, { transform: "scale(1.25) rotate(4deg)", offset: 0.6 }, { transform: "scale(1) rotate(-4deg)" }], { duration: 300, easing: "ease-out" });
    }
  }
}
