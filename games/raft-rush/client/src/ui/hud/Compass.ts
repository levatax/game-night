// Top compass strip (§17): a 180° tape that scrolls with the local yaw, cardinal letters, and the marks the app
// sends (camp, raft, spring, secret chest, pings, teammates, resources, danger, cave) with their distance.
// Owner: client-ui. Marks behind you are pinned to the nearest edge with an arrow so "where's the raft?" always
// has an answer. Yaw / bearing convention (shared/sim/math.ts): 0 faces -Z, positive turns LEFT, so a mark at
// relative angle +a sits a/(π/2) half-widths left of the center.

import { t } from "../../i18n";
import { el, setText, setVar, toggleClass, wrapAngle } from "../dom";
import type { CompassMark } from "../models";

/** Half of the visible arc (radians). */
const HALF_FOV = Math.PI / 2;
/** Tick spacing on the tape (radians). */
const TICK = Math.PI / 12;

const CARDINALS: ReadonlyArray<{ key: string; bearing: number; major: boolean }> = [
  { key: "hud.compassN", bearing: 0, major: true },
  { key: "hud.compassW", bearing: Math.PI / 2, major: true },
  { key: "hud.compassS", bearing: Math.PI, major: true },
  { key: "hud.compassE", bearing: -Math.PI / 2, major: true },
  { key: "", bearing: Math.PI / 4, major: false },
  { key: "", bearing: (3 * Math.PI) / 4, major: false },
  { key: "", bearing: -Math.PI / 4, major: false },
  { key: "", bearing: (-3 * Math.PI) / 4, major: false },
];

interface MarkView {
  root: HTMLElement;
  icon: HTMLElement;
  /** "Bahri · 9 m" chip under the strip (the strip hugs the top of the screen, so nothing goes above it). */
  dist: HTMLElement;
  sig: string;
  distText: string;
}

/** Horizontal offset (fraction of the half width, + = right) of a bearing seen from `yaw`, and whether it's visible. */
function offsetOf(bearing: number, yaw: number): { x: number; inView: boolean } {
  const rel = wrapAngle(bearing - yaw);
  return { x: -rel / HALF_FOV, inView: Math.abs(rel) <= HALF_FOV };
}

export class Compass {
  readonly el = el("div", "rr-compass");
  private readonly tape = el("div", "rr-compass__tape");
  private readonly cardinalEls: HTMLElement[] = [];
  private readonly marksLayer = el("div", "rr-compass__marks");
  private readonly pool: MarkView[] = [];
  private lastYaw = Number.NaN;

  constructor() {
    for (const c of CARDINALS) {
      const node = el("span", c.major ? "rr-compass__card is-major" : "rr-compass__card", c.key ? t(c.key) : "·");
      if (c.key === "hud.compassN") node.classList.add("is-north");
      this.cardinalEls.push(node);
      this.tape.append(node);
    }
    this.el.append(this.tape, this.marksLayer, el("span", "rr-compass__needle"));
    this.el.setAttribute("aria-hidden", "true");
  }

  update(yaw: number, marks: readonly CompassMark[]): void {
    if (yaw !== this.lastYaw) {
      this.lastYaw = yaw;
      // Tick tape: one background tile per TICK, shifted by the yaw (positive yaw moves the world right).
      const shift = ((yaw / TICK) % 1) * 100;
      setVar(this.tape, "--shift", `${shift.toFixed(2)}`);
      CARDINALS.forEach((c, i) => {
        const node = this.cardinalEls[i]!;
        const { x, inView } = offsetOf(c.bearing, yaw);
        toggleClass(node, "is-out", !inView);
        if (inView) setVar(node, "--x", x.toFixed(4));
      });
    }
    this.renderMarks(yaw, marks);
  }

  private renderMarks(yaw: number, marks: readonly CompassMark[]): void {
    while (this.pool.length < marks.length) {
      const icon = el("span", "rr-cmark__icon");
      const dist = el("span", "rr-cmark__dist");
      const root = el("div", "rr-cmark", el("span", "rr-cmark__pin", icon), dist);
      this.pool.push({ root, icon, dist, sig: "", distText: "" });
      this.marksLayer.append(root);
    }
    for (let i = 0; i < this.pool.length; i++) {
      const v = this.pool[i]!;
      const m = marks[i];
      if (!m) {
        if (!v.root.hidden) v.root.hidden = true;
        continue;
      }
      if (v.root.hidden) v.root.hidden = false;
      const sig = `${m.kind}|${m.icon}|${m.color}|${m.label}`;
      if (sig !== v.sig) {
        v.sig = sig;
        v.root.className = `rr-cmark rr-cmark--${m.kind}`;
        setText(v.icon, m.icon);
        setVar(v.root, "--mark", m.color || "#FFF4DC");
      }
      const d = Math.max(0, Math.round(m.dist));
      const meters = d >= 1 ? t("hud.meters", { d }) : "";
      const distText = m.label ? (meters ? `${m.label} · ${meters}` : m.label) : meters;
      if (distText !== v.distText) {
        v.distText = distText;
        setText(v.dist, distText);
      }
      const { x, inView } = offsetOf(m.bearing, yaw);
      const clamped = inView ? x : x > 0 ? 1 : -1;
      toggleClass(v.root, "is-edge", !inView);
      toggleClass(v.root, "is-left", !inView && clamped < 0);
      toggleClass(v.root, "is-near", d < 6);
      setVar(v.root, "--x", clamped.toFixed(4));
    }
  }
}
