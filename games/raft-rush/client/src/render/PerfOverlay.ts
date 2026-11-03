// Debug render readout (`?stats=1`, or `?stats=1&quality=high` for a fixed tier): draw calls and triangles for
// the frame just drawn, with the peak since load, against the §20 acceptance budget (perfBudget.ts). The same
// numbers are mirrored to `window.__raftPerf` so an acceptance run can read them without a screenshot.
// Owner: client-render.

import { formatBudget, readBudget, RENDER_BUDGET, type PerfCounters } from "./perfBudget";

export interface PerfSnapshot extends PerfCounters {
  peakCalls: number;
  peakTriangles: number;
  overCalls: boolean;
  overTriangles: boolean;
  withinBudget: boolean;
  quality: string;
  frames: number;
  at: number;
}

/** Repaint at most this often (ms); sampling still happens every frame. */
const PAINT_MS = 250;

export class PerfOverlay {
  private readonly box: HTMLDivElement;
  private readonly calls: HTMLSpanElement;
  private readonly triangles: HTMLSpanElement;
  private readonly peak: HTMLDivElement;
  private frames = 0;
  private peakCalls = 0;
  private peakTriangles = 0;
  private lastPaint = -Infinity;
  private snapshot: PerfSnapshot;

  constructor(container: HTMLElement, quality: string) {
    this.box = document.createElement("div");
    this.box.id = "raft-perf";
    this.box.setAttribute("role", "status");
    this.box.setAttribute("aria-live", "off");
    this.box.style.cssText =
      "position:fixed;top:8px;right:8px;z-index:2147483647;pointer-events:none;padding:6px 8px;border-radius:8px;" +
      "background:rgba(20,18,24,.78);color:#F4EFE6;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;" +
      "white-space:pre;text-align:right;box-shadow:0 2px 8px rgba(0,0,0,.35)";
    this.calls = document.createElement("span");
    this.triangles = document.createElement("span");
    this.peak = document.createElement("div");
    this.peak.style.cssText = "opacity:.72;font-size:11px";
    const line1 = document.createElement("div");
    const line2 = document.createElement("div");
    line1.append(this.calls);
    line2.append(this.triangles);
    this.box.append(line1, line2, this.peak);
    container.append(this.box);
    this.snapshot = {
      calls: 0,
      triangles: 0,
      peakCalls: 0,
      peakTriangles: 0,
      overCalls: false,
      overTriangles: false,
      withinBudget: true,
      quality,
      frames: 0,
      at: 0,
    };
    this.paint();
  }

  /** One rendered frame; called right after the draw so three's counters describe it. */
  sample(counters: PerfCounters, quality: string, nowMs = performance.now()): void {
    this.frames++;
    const r = readBudget(counters);
    this.peakCalls = Math.max(this.peakCalls, r.calls);
    this.peakTriangles = Math.max(this.peakTriangles, r.triangles);
    this.snapshot = {
      ...r,
      peakCalls: this.peakCalls,
      peakTriangles: this.peakTriangles,
      quality,
      frames: this.frames,
      at: Math.round(nowMs),
    };
    (window as unknown as { __raftPerf?: PerfSnapshot }).__raftPerf = this.snapshot;
    if (nowMs - this.lastPaint >= PAINT_MS) {
      this.lastPaint = nowMs;
      this.paint();
    }
  }

  private paint(): void {
    const s = this.snapshot;
    this.calls.textContent = `draw calls ${s.calls} / ${RENDER_BUDGET.drawCalls}`;
    this.calls.style.color = s.overCalls ? "#FF8A80" : "#B8F5C8";
    this.triangles.textContent = `triangles ${s.triangles.toLocaleString("en-US")} / ${RENDER_BUDGET.triangles.toLocaleString("en-US")}`;
    this.triangles.style.color = s.overTriangles ? "#FF8A80" : "#B8F5C8";
    this.peak.textContent = `peak ${s.peakCalls} / ${s.peakTriangles.toLocaleString("en-US")} · ${s.quality}${s.withinBudget ? "" : " · OVER BUDGET"}`;
    this.box.title = formatBudget(s);
  }
}
