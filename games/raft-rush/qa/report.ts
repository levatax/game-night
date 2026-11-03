// One-page summary for a batch of runs (and the death heatmap cells). Owner: qa.
//
// The summary always reports the cohorts separately (expert / novice / idle / bot) when the CSV carries a `skill`
// column, because a pooled win rate hides exactly the difference the pilot policy exists to measure.
// Targets printed next to each figure are the ones the acceptance brief names; they are labels, not a verdict.

import type { RunRow } from "./telemetry.js";

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const f1 = (n: number | null, unit = ""): string => (n === null ? "—" : `${n.toFixed(1)}${unit}`);

const pct = (a: number, b: number): string => (b === 0 ? "—" : `${((100 * a) / b).toFixed(1)} %`);

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
  /** Commit the harness measured (filled by batch.ts from git rev-parse HEAD). */
  sha?: string;
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

interface CohortStats {
  key: string;
  rows: ReadonlyArray<RunRow>;
  n: number;
  wins: number;
  timeouts: number;
  ready: number[];
  depart: number[];
  bossRows: ReadonlyArray<RunRow>;
  bossSpawned: number;
  deliveredTotal: number;
  botDeliveredTotal: number;
  drops: number;
  fumbles: number;
}

function cohort(key: string, rows: ReadonlyArray<RunRow>): CohortStats {
  const ready = rows.map((r) => r.raft_ready_s).filter((x): x is number => x !== null);
  const depart = rows.map((r) => r.departure_s).filter((x): x is number => x !== null);
  const bossRows = rows.filter((r) => r.match_seconds >= 450);
  return {
    key,
    rows,
    n: rows.length,
    wins: rows.filter((r) => r.outcome === "win").length,
    timeouts: rows.filter((r) => r.outcome === "timeout").length,
    ready,
    depart,
    bossRows,
    bossSpawned: bossRows.filter((r) => r.boss_spawn === 1).length,
    deliveredTotal: rows.reduce((a, r) => a + r.delivered_total, 0),
    botDeliveredTotal: rows.reduce((a, r) => a + r.delivered_total * r.bot_delivery_share, 0),
    drops: rows.reduce((a, r) => a + (r.pilot_drops ?? 0), 0),
    fumbles: rows.reduce((a, r) => a + (r.pilot_fumbles ?? 0), 0),
  };
}

function cohortLine(c: CohortStats): string {
  const depMedian = median(c.depart);
  const readyMedian = median(c.ready);
  const boss = c.bossRows.length ? `${c.bossSpawned}/${c.bossRows.length}` : "0/0 (no run reached 450 s)";
  const share = c.deliveredTotal > 0 ? pct(c.botDeliveredTotal, c.deliveredTotal) : "—";
  return (
    `| ${c.key} | ${c.n} | **${pct(c.wins, c.n)}** (${c.wins}/${c.n}) | ${f1(depMedian, " s")} | ` +
    `${f1(readyMedian, " s")} | ${c.depart.length}/${c.n} | ${c.ready.length}/${c.n} | ${boss} | ${share} | ` +
    `${c.drops} / ${c.fumbles} |`
  );
}

export function summarize(rows: ReadonlyArray<RunRow>, meta: SummaryMeta): string {
  const n = rows.length;
  const wins = rows.filter((r) => r.outcome === "win").length;
  const outcomes = histogram(rows.map((r) => r.outcome));
  const reasons = histogram(rows.map((r) => r.end_reason));
  const causes = histogram(rows.filter((r) => r.death_cause !== "none").map((r) => r.death_cause));
  const secs = rows.map((r) => r.match_seconds);
  const fish = rows.map((r) => r.time_to_first_fish).filter((x): x is number => x !== null);
  const early = rows.filter((r) => r.raft_ready_s !== null && r.raft_ready_s < 440).length;
  const heat = heatmapRows(rows);
  const line = "| value | n | share |\n|---|---:|---:|";
  const hist = (h: Array<[string, number, number]>) =>
    h.map(([k, c, p]) => `| ${k} | ${c} | ${p.toFixed(0)} % |`).join("\n");

  const groups: string[] = [...new Set(rows.map((r) => r.skill ?? "bot"))];
  const cohorts = groups.map((g) => cohort(g, rows.filter((r) => (r.skill ?? "bot") === g)));
  const skillCohorts = cohorts.filter((c) => c.key === "expert" || c.key === "novice");
  const idle = cohorts.find((c) => c.key === "idle");

  const belowFloor = skillCohorts.filter((c) => c.n > 0 && (100 * c.wins) / c.n < 15);
  const winCheck =
    skillCohorts.length === 0
      ? "_no skill cohort in this CSV_"
      : belowFloor.length
        ? `FAIL — ${belowFloor.map((c) => `${c.key} ${pct(c.wins, c.n)}`).join(", ")} < 15 %`
        : `PASS — ${skillCohorts.map((c) => `${c.key} ${pct(c.wins, c.n)}`).join(", ")} ≥ 15 %`;

  const idleCheck = !idle
    ? "_no idle cohort in this CSV_"
    : idle.wins === 0 && idle.depart.length === 0
      ? `PASS — 0/${idle.n} wins, 0/${idle.n} departures (no "escaped" screen)`
      : `FAIL — ${idle.wins}/${idle.n} wins, ${idle.depart.length}/${idle.n} departures`;

  const deliveryShare =
    rows.reduce((a, r) => a + r.delivered_total, 0) > 0
      ? (100 * rows.reduce((a, r) => a + r.delivered_total * r.bot_delivery_share, 0)) /
        rows.reduce((a, r) => a + r.delivered_total, 0)
      : null;

  return [
    `# Raft Rush — run batch summary`,
    ``,
    `- **commit: \`${meta.sha ?? "unknown"}\`**`,
    `- generated: ${meta.generatedAt}`,
    `- scenario: ${meta.scenario}`,
    `- runs: ${meta.runs} (seeds ${meta.seeds[0]} … ${meta.seeds[1]}, step 7919)`,
    `- timers: ${meta.fast ? "FAST (RAFT_TEST smoke)" : "normal (real match timings)"}`,
    `- wall time: ${(meta.durationMs / 1000).toFixed(1)} s`,
    `- win floor (each skill cohort ≥ 15 %): ${winCheck}`,
    `- idle cohort never wins / never departs: ${idleCheck}`,
    ``,
    `## Headline`,
    ``,
    `- **win rate (all rows): ${pct(wins, n)}** (${wins}/${n})`,
    `- median match: **${f1(median(secs), " s")}** (mean ${f1(mean(secs), " s")}; min ${Math.min(...secs)} / max ${Math.max(...secs)})`,
    `- early raft ready (< 440 s): **${early}**`,
    `- median time to first fish: ${f1(median(fish), " s")} (${fish.length} runs caught one)`,
    `- fire went out: ${rows.reduce((a, r) => a + r.fire_out_count, 0)} times over ${n} runs (avg ${f1(mean(rows.map((r) => r.fire_out_count)) ?? 0)})`,
    `- bot delivery share (all rows): ${deliveryShare === null ? "—" : `${deliveryShare.toFixed(1)} %`} (target ≤ 25 %)`,
    ``,
    `## Cohorts`,
    ``,
    `| cohort | runs | win % | departure median | raft_ready median | departures | ready | boss spawn (≥ 450 s) | bot delivery share | pilot drops / fumbles |`,
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`,
    ...cohorts.map(cohortLine),
    ``,
    `_departure median target 440–460 s; raft_ready is the separate "stage 3 in the water" clock, not a departure. ` +
      `Boss spawn only counts runs whose match reached 450 s._`,
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
