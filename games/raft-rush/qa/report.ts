// One-page summary for a batch of runs (and the death heatmap cells). Owner: qa.

import type { RunRow } from "./telemetry.js";

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const f1 = (n: number | null, unit = ""): string => (n === null ? "—" : `${n.toFixed(1)}${unit}`);

function histogram<T extends string>(xs: T[]): Array<[T, number, number]> {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => [k, n, (100 * n) / Math.max(1, xs.length)] as [T, number, number]);
}

export interface SummaryMeta {
  generatedAt: string;
  scenario: string;
  runs: number;
  seeds: [number, number];
  fast: boolean;
  durationMs: number;
}

/** Death coordinates aggregated into 5 m cells: "x,z,count,cause" rows. */
export function heatmapRows(rows: ReadonlyArray<RunRow>, cell = 5): Array<{ x: number; y: number; count: number; causes: string }> {
  const cells = new Map<string, { x: number; y: number; count: number; causes: Map<string, number> }>();
  for (const r of rows) {
    if (r.death_x === null || r.death_y === null) continue;
    const cx = Math.round(r.death_x / cell) * cell;
    const cy = Math.round(r.death_y / cell) * cell;
    const key = `${cx},${cy}`;
    const c = cells.get(key) ?? { x: cx, y: cy, count: 0, causes: new Map<string, number>() };
    c.count++;
    c.causes.set(r.death_cause, (c.causes.get(r.death_cause) ?? 0) + 1);
    cells.set(key, c);
  }
  return [...cells.values()]
    .sort((a, b) => b.count - a.count)
    .map((c) => ({
      x: c.x,
      y: c.y,
      count: c.count,
      causes: [...c.causes.entries()].map(([k, n]) => `${k}:${n}`).join("|"),
    }));
}

export function summarize(rows: ReadonlyArray<RunRow>, meta: SummaryMeta): string {
  const n = rows.length;
  const wins = rows.filter((r) => r.outcome === "win").length;
  const outcomes = histogram(rows.map((r) => r.outcome));
  const reasons = histogram(rows.map((r) => r.end_reason));
  const causes = histogram(rows.filter((r) => r.death_cause !== "none").map((r) => r.death_cause));
  const secs = rows.map((r) => r.match_seconds);
  const fish = rows.map((r) => r.time_to_first_fish).filter((x): x is number => x !== null);
  const ready = rows.map((r) => r.raft_ready_s).filter((x): x is number => x !== null);
  const depart = rows.map((r) => r.departure_s).filter((x): x is number => x !== null);
  const early = rows.filter((r) => r.raft_ready_s !== null && r.raft_ready_s < 440).length;
  const earlyDepart = rows.filter((r) => r.departure_s !== null && r.departure_s < 470).length;
  const heat = heatmapRows(rows);
  const line = "| value | n | share |\n|---|---:|---:|";
  const hist = (h: Array<[string, number, number]>) =>
    h.map(([k, c, p]) => `| ${k} | ${c} | ${p.toFixed(0)} % |`).join("\n");

  const winPct = (100 * wins) / Math.max(1, n);
  return [
    `# Raft Rush — run batch summary`,
    ``,
    `- generated: ${meta.generatedAt}`,
    `- scenario: ${meta.scenario}`,
    `- runs: ${meta.runs} (seeds ${meta.seeds[0]} … ${meta.seeds[1]}, step 7919)`,
    `- timers: ${meta.fast ? "FAST (RAFT_TEST smoke)" : "normal (real match timings)"}`,
    `- wall time: ${(meta.durationMs / 1000).toFixed(1)} s`,
    ``,
    `## Headline`,
    ``,
    `- **win rate: ${winPct.toFixed(1)} %** (${wins}/${n})`,
    `- median match: **${f1(median(secs), " s")}** (mean ${f1(mean(secs), " s")}; min ${Math.min(...secs)} / max ${Math.max(...secs)})`,
    `- raft ready (stage 3): median **${f1(median(ready), " s")}** (${ready.length}/${n} runs; target 440–460 s)`,
    `- departure (raft left): median **${f1(median(depart), " s")}** (${depart.length}/${n} runs; target 470–495 s)`,
    `- early raft ready (< 440 s): **${early}**; early departure (< 470 s): **${earlyDepart}**`,
    `- median time to first fish: ${f1(median(fish), " s")} (${fish.length} runs caught one)`,
    `- fire went out: ${rows.reduce((a, r) => a + r.fire_out_count, 0)} times over ${n} runs (avg ${f1(mean(rows.map((r) => r.fire_out_count)) ?? 0)})`,
    `- bot delivery share: mean ${(100 * (mean(rows.map((r) => r.bot_delivery_share)) ?? 0)).toFixed(0)} %`,
    ``,
    `## Outcome`,
    ``,
    line,
    hist(outcomes as Array<[string, number, number]>),
    ``,
    `## End reason`,
    ``,
    line,
    hist(reasons as Array<[string, number, number]>),
    ``,
    `## Focal death cause`,
    ``,
    line,
    hist(causes as Array<[string, number, number]>),
    ``,
    `## Death heatmap (5 m cells, top 10)`,
    ``,
    `| x | y (z) | deaths | causes |`,
    `|---:|---:|---:|---|`,
    ...heat.slice(0, 10).map((c) => `| ${c.x} | ${c.y} | ${c.count} | ${c.causes} |`),
    ``,
    `_death_x / death_y are world x / z of the focal player's first down; death_height is world y._`,
    ``,
  ].join("\n");
}
