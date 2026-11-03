// LOCAL DIAGNOSTIC ONLY — NOT AN ACCEPTANCE DECISION. Owner: qa.
//
// qa:gate never plays a match. It reads one CSV written by qa:runs (the single measurement engine) and prints
// descriptive numbers: cohort sizes, outcomes, raft timing spread, boss_spawn coverage. It produces no PASS /
// FAIL verdict and no acceptance table; the beta band decision is made only by scripts/raft-acceptance.mjs over
// the same qa:runs CSV.
//
//   npm run qa:runs -- --runs 120 --label expert --out qa/out
//   npm run qa:gate                       (newest runs-*.csv in qa/out)
//   npm run qa:gate -- --csv qa/out/runs-expert-20261103-032300.csv

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");

interface Row {
  [k: string]: string;
}

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? "") : fallback;
}

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows
    .filter((r) => r.some((v) => v.length > 0))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function latestCsv(): string {
  if (!fs.existsSync(OUT)) return "";
  const files = fs
    .readdirSync(OUT)
    .filter((f) => /^runs-.*\.csv$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0] ? path.join(OUT, files[0].f) : "";
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const f1 = (n: number | null, unit = ""): string => (n === null ? "—" : `${n.toFixed(1)}${unit}`);

function histogram(rows: Row[], col: string): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r[col] ?? "", (counts.get(r[col] ?? "") ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k || "—"} ${n}`)
    .join(" · ");
}

function describe(name: string, rows: Row[]): void {
  if (rows.length === 0) return;
  const wins = rows.filter((r) => r.outcome === "win").length;
  const ready = rows.map((r) => num(r.raft_ready_s)).filter((x): x is number => x !== null);
  const depart = rows.map((r) => num(r.departure_s)).filter((x): x is number => x !== null);
  const secs = rows.map((r) => num(r.match_seconds) ?? 0);
  const bossRows = rows.filter((r) => r.boss_spawn !== undefined);
  const inScope = bossRows.filter((r) => (num(r.match_seconds) ?? 0) >= 450);
  const bossOn = inScope.filter((r) => num(r.boss_spawn) === 1).length;
  const bossCoverage =
    bossRows.length === 0
      ? "boss_spawn column ABSENT (old CSV)"
      : `boss_spawn ${bossOn}/${inScope.length} in scope (${bossRows.length - inScope.length} ended before 450 s)`;
  process.stdout.write(
    [
      `\n## ${name}`,
      `- rows ${rows.length} · win ${wins} (${((100 * wins) / rows.length).toFixed(0)} %) · match s min/med/max ${Math.min(...secs)} / ${f1(median(secs))} / ${Math.max(...secs)}`,
      `- end_reason: ${histogram(rows, "end_reason")}`,
      `- raft_ready_s (${ready.length}/${rows.length}): min/med/max ${f1(ready.length ? Math.min(...ready) : null)} / ${f1(median(ready))} / ${f1(ready.length ? Math.max(...ready) : null)}`,
      `- departure_s (${depart.length}/${rows.length}): min/med/max ${f1(depart.length ? Math.min(...depart) : null)} / ${f1(median(depart))} / ${f1(depart.length ? Math.max(...depart) : null)}`,
      `- ${bossCoverage}`,
      `- death causes: ${histogram(rows, "death_cause")}`,
    ].join("\n") + "\n",
  );
}

function main(): void {
  const requested = arg("csv");
  const csvPath = requested ? path.resolve(requested) : latestCsv();
  if (!csvPath || !fs.existsSync(csvPath)) {
    process.stdout.write(
      `qa:gate — LOCAL DIAGNOSTIC. No qa:runs CSV found${requested ? ` at ${requested}` : ` in ${OUT}`}.\n` +
        `Run npm run qa:runs first, or pass --csv <file>. This tool never plays matches.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const header = Object.keys(rows[0] ?? {});
  process.stdout.write(
    `qa:gate — LOCAL DIAGNOSTIC over ${path.relative(process.cwd(), csvPath)}; NOT an acceptance decision.\n` +
      `Acceptance = scripts/raft-acceptance.mjs over this same qa:runs CSV. Columns: ${header.join(",")}\n`,
  );
  if (rows.length === 0) {
    process.stdout.write(`CSV has no data rows.\n`);
    process.exitCode = 1;
    return;
  }
  describe("all rows", rows);
  for (const [kind, subset] of [
    ["experts (no idle humans)", rows.filter((r) => (num(r.humans) ?? 0) === 0)],
    ["novices (idle humans)", rows.filter((r) => (num(r.humans) ?? 0) > 0)],
  ] as Array<[string, Row[]]>) {
    describe(kind, subset);
  }
  process.stdout.write(`\nNot an acceptance verdict. Use the CSV gate for the beta band decision.\n`);
}

main();
