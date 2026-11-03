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
  /** "Name · 9 m", "9 m" and the chip actually shown (crowded marks drop the name, then the chip). */
  fullText: string;
  shortText: string;
  chip: "full" | "short" | "none";
  text: string;
  /** Stacked row (0 or 1): marks sharing a bearing take turns so chips never sit on top of each other. */
  row: number;
}

/** Rows used when marks share a bearing at night (edge-pinned marks all sit at x = ±1). */
const MAX_ROWS = 2;

/** Keep the compass readable: pings and danger first, then objectives, then teammates / resources. */
function markPriority(kind: CompassMark["kind"]): number {
  if (kind === "ping") return 0;
  if (kind === "danger") return 1;
  if (kind === "camp" || kind === "raft") return 2;
  if (kind === "player") return 3;
  return 4;
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
  private width = 0;
  private widthViewport = 0;

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
      this.pool.push({ root, icon, dist, sig: "", fullText: "", shortText: "", chip: "none", text: "", row: 0 });
      this.marksLayer.append(root);
    }
    const live: Array<{ v: MarkView; x: number; kind: CompassMark["kind"] }> = [];
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
      v.fullText = m.label ? (meters ? `${m.label} · ${meters}` : m.label) : meters;
      v.shortText = meters;
      const { x, inView } = offsetOf(m.bearing, yaw);
      const clamped = inView ? x : x > 0 ? 1 : -1;
      toggleClass(v.root, "is-edge", !inView);
      toggleClass(v.root, "is-left", !inView && clamped < 0);
      toggleClass(v.root, "is-near", d < 6);
      setVar(v.root, "--x", clamped.toFixed(4));
      live.push({ v, x: clamped, kind: m.kind });
    }
    this.stack(live, marks.length);
  }

  /**
   * Lay the marks out on up to MAX_ROWS rows and, inside a row, fan overlapping marks apart sideways. Crowded
   * bearings keep their icon; only pings / camp / raft keep a name chip, the rest fall back to distance or pin.
   */
  private stack(live: Array<{ v: MarkView; x: number; kind: CompassMark["kind"] }>, count: number): void {
    if (this.widthViewport !== window.innerWidth || this.width === 0) {
      this.widthViewport = window.innerWidth;
      this.width = this.el.clientWidth || 500;
    }
    const width = this.width;
    const half = width / 2;
    // 1 px at 1280x720, 1.5 px at 1920x1080: the compass is 500u wide (46vw on very wide windows).
    const unit = width / 500;
    const fontSize = Math.max(11, unit * 11);
    interface Item {
      e: (typeof live)[number];
      text: string;
      mode: MarkView["chip"];
      w: number;
      left: number;
      right: number;
      prio: number;
      idx: number;
    }
    const rows: Item[][] = Array.from({ length: MAX_ROWS }, () => []);
    const order = live.map((e, i) => ({ e, i })).sort((a, b) => markPriority(a.e.kind) - markPriority(b.e.kind) || a.i - b.i);
    for (const { e, i } of order) {
      const mode: MarkView["chip"] = e.kind === "ping" || e.kind === "camp" || e.kind === "raft" ? "full" : e.kind === "danger" ? "none" : "short";
      const text = mode === "full" ? e.v.fullText : mode === "short" ? e.v.shortText : "";
      const pin = (e.kind === "player" || e.kind === "resource" ? 18 : 24) * unit;
      const w = Math.max(pin, text ? text.length * fontSize * 0.72 + unit * 14 : 0);
      // Balance the two rows by content width so no row becomes the pile-up.
      const rowWidth = (r: Item[]): number => r.reduce((sum, it) => sum + it.w, 0);
      const row = rowWidth(rows[0]!) <= rowWidth(rows[1]!) ? 0 : 1;
      rows[row]!.push({ e, text, mode, w, left: e.x * half - w / 2, right: e.x * half + w / 2, prio: markPriority(e.kind), idx: i });
    }
    const placed = new Set<MarkView>();
    rows.forEach((items, row) => {
      // If even pins cannot fit, drop the lowest-priority marks until the row fits.
      while (items.reduce((sum, it) => sum + it.w, 0) > width) {
        let worst = 0;
        for (let i = 1; i < items.length; i++) {
          const a = items[i]!, b = items[worst]!;
          if (a.prio > b.prio || (a.prio === b.prio && a.idx > b.idx)) worst = i;
        }
        const [gone] = items.splice(worst, 1);
        if (gone) gone.e.v.root.hidden = true;
      }
      items.sort((a, b) => a.left - b.left || a.idx - b.idx);
      for (const it of items) it.left = Math.max(0, Math.min(width - it.w, it.left));
      for (let i = 1; i < items.length; i++) {
        const it = items[i]!, prev = items[i - 1]!;
        if (it.left < prev.left + prev.w) it.left = prev.left + prev.w;
      }
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]!;
        const maxLeft = i === items.length - 1 ? width - it.w : items[i + 1]!.left - it.w;
        if (it.left > maxLeft) it.left = maxLeft;
      }
      for (const it of items) {
        it.right = it.left + it.w;
        placed.add(it.e.v);
        if (it.e.v.root.hidden) it.e.v.root.hidden = false;
        const center = (it.left + it.right) / 2;
        setVar(it.e.v.root, "--x", ((center - half) / half).toFixed(4));
        if (it.e.v.row !== row) {
          it.e.v.row = row;
          setVar(it.e.v.root, "--row", String(row));
        }
        if (it.e.v.chip !== it.mode || it.e.v.text !== it.text) {
          it.e.v.chip = it.mode;
          it.e.v.text = it.text;
          setText(it.e.v.dist, it.text);
        }
      }
    });
    for (const e of live) if (!placed.has(e.v) && !e.v.root.hidden) e.v.root.hidden = true;
    // Pools can be longer than this frame's marks; hide the leftovers.
    for (let i = count; i < this.pool.length; i++) this.pool[i]!.root.hidden = true;
  }
}
