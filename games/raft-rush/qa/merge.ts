// Merge sharded qa:runs CSVs into one cohort CSV + summary. Owner: qa.
//
// The 150-run skill batch is split across processes (one shard per CPU) because a single process plays ~19
// simulated seconds per wall second. Every shard writes the same header and the same commit, so the merged file is
// the authoritative CSV; the shards are deleted afterwards by the caller.
//
//   npx tsx games/raft-rush/qa/merge.ts --out games/raft-rush/qa/out --label skills-<stamp> shard1.csv shard2.csv …

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { summarize } from "./report.js";
import { COLUMNS, toCsv, type RunRow } from "./telemetry.js";

function parseCsv(text: string): string[][] {
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
  return rows.filter((r) => r.some((v) => v.length > 0));
}

const NUMERIC = new Set<string>([
  "seed",
  "match_seconds",
  "run_index",
  "players",
  "bot_count",
  "death_x",
  "death_y",
  "fire_out_count",
  "wood_to_fire",
  "time_to_first_fish",
  "first_input_s",
  "first_meaningful_choice_s",
  "bot_delivery_share",
  "downed_count",
  "revive_count",
  "raft_ready_s",
  "departure_s",
  "humans",
  "seconds_left",
  "team_score",
  "stage",
  "fire_fuel_end",
  "delivered_total",
  "team_downed",
  "team_revived",
  "focal_downed",
  "focal_washed",
  "focal_boarded",
  "focal_points",
  "death_height",
  "boss_spawn",
  "pilot_drops",
  "pilot_fumbles",
]);

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function main(): void {
  const out = path.resolve(arg("out", path.join(import.meta.dirname, "out")));
  const label = arg("label", "skills-merged");
  const onlySkill = arg("skill", "");
  const valueFlags = new Set(["--out", "--label", "--skill"]);
  const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && valueFlags.has(all[i - 1]!)));
  if (!files.length) throw new Error("usage: merge.ts --out <dir> --label <name> <csv> [csv …]");

  let head: string[] | null = null;
  const rows: RunRow[] = [];
  for (const file of files) {
    const table = parseCsv(fs.readFileSync(file, "utf8"));
    const h = table.shift() ?? [];
    if (!head) head = h;
    else if (h.join(",") !== head.join(",")) throw new Error(`${file}: header differs from ${files[0]}`);
    for (const r of table) {
      const obj: Record<string, unknown> = {};
      head.forEach((col, i) => {
        const v = r[i] ?? "";
        obj[col] = v === "" ? null : NUMERIC.has(col) ? Number(v) : v;
      });
      rows.push(obj as unknown as RunRow);
    }
  }
  const kept = onlySkill ? rows.filter((r) => r.skill === onlySkill) : rows;
  rows.length = 0;
  rows.push(...kept);
  if (!rows.length) throw new Error(`no rows for skill ${onlySkill}`);
  const seeds = new Set(rows.map((r) => r.seed));
  if (seeds.size !== rows.length) throw new Error(`duplicate seeds: ${rows.length - seeds.size}`);
  const order: Record<string, number> = { expert: 0, novice: 1, idle: 2, bot: 3 };
  rows.sort((a, b) => (order[a.skill] ?? 9) - (order[b.skill] ?? 9) || a.seed - b.seed);

  const sha = (() => {
    try {
      return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  })();
  const meta = {
    generatedAt: new Date().toISOString(),
    sha,
    scenario: "merged shards: expert + novice pilot cohorts, normal timers",
    runs: rows.length,
    seeds: [Math.min(...rows.map((r) => r.seed)), Math.max(...rows.map((r) => r.seed))] as [number, number],
    fast: false,
    durationMs: 0,
  };

  fs.mkdirSync(out, { recursive: true });
  const csvPath = path.join(out, `runs-${label}.csv`);
  const mdPath = path.join(out, `summary-${label}.md`);
  fs.writeFileSync(csvPath, toCsv(rows));
  fs.writeFileSync(mdPath, summarize(rows, meta));
  process.stdout.write(`${rows.length} rows · ${seeds.size} unique seeds · ${sha}\nCSV ${csvPath}\nMD  ${mdPath}\n`);
  const missing = COLUMNS.filter((c) => !head!.includes(c));
  if (missing.length) throw new Error(`merged CSV misses columns: ${missing.join(", ")}`);
}

main();
