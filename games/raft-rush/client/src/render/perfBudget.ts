// Per-frame render budget (game4.md §20): the acceptance gate is ≤ 60 draw calls and ≤ 250k triangles at the
// target settings. The debug readout (`?stats=1`), its console/`window.__raftPerf` mirror and the tests all read
// these numbers from here so the budget lives in one place. Owner: client-render.

export const RENDER_BUDGET = {
  drawCalls: 60,
  triangles: 250_000,
} as const;

export interface PerfCounters {
  calls: number;
  triangles: number;
}

export interface PerfReadout extends PerfCounters {
  overCalls: boolean;
  overTriangles: boolean;
  withinBudget: boolean;
}

/** Compare one rendered frame with the budget. */
export function readBudget(counters: PerfCounters): PerfReadout {
  const overCalls = counters.calls > RENDER_BUDGET.drawCalls;
  const overTriangles = counters.triangles > RENDER_BUDGET.triangles;
  return {
    calls: counters.calls,
    triangles: counters.triangles,
    overCalls,
    overTriangles,
    withinBudget: !overCalls && !overTriangles,
  };
}

/** "42 / 60 draw calls · 78,123 / 250,000 triangles" for logs and the overlay. */
export function formatBudget(counters: PerfCounters): string {
  const r = readBudget(counters);
  return `${r.calls} / ${RENDER_BUDGET.drawCalls} draw calls · ${r.triangles.toLocaleString("en-US")} / ${RENDER_BUDGET.triangles.toLocaleString("en-US")} triangles`;
}
