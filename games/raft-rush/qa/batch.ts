// Batch runner: plays N matches on the real RaftWorld + BotDesk and writes CSV + JSON + a one-page summary.
// Owner: qa. No game logic is changed.
//
//   npm run qa:runs -- --runs 120
//   npm run qa:runs -- --runs 30 --idle 1 --bots 2 --label idle-smoke
//   npm run qa:runs -- --runs 6 --fast            (RAFT_TEST timers, flow smoke only)
//
// The room's phase loop is reproduced exactly like server/room/botBalance.test.ts; match_seconds are simulated
// match seconds, so 120 real-timing runs take ~2 minutes here instead of ~16 hours of wall clock.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Difficulty } from "../shared/types.js";
import { runOne, seedAt, type Scenario } from "./match.js";
import { heatmapRows, summarize } from "./report.js";
import { toCsv, toJson, type RunRow } from "./telemetry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

interface Args {
  runs: number;
  bots: number;
  idle: number;
  difficulty: Difficulty;
  fast: boolean;
  seedBase: number;
  out: string;
  quiet: boolean;
  label: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    runs: 120,
    bots: 3,
    idle: 0,
    difficulty: "normal",
    fast: false,
    seedBase: 1000,
    out: path.join(HERE, "out"),
    quiet: false,
    label: "batch",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = argv[i + 1];
    switch (k) {
      case "--runs":
        a.runs = Math.max(1, Number(v));
        i++;
        break;
      case "--bots":
        a.bots = Math.max(0, Number(v));
        i++;
        break;
      case "--idle":
        a.idle = Math.max(0, Number(v));
        i++;
        break;
      case "--difficulty":
        a.difficulty = String(v) as Difficulty;
        i++;
        break;
      case "--fast":
        a.fast = true;
        break;
      case "--seed-base":
        a.seedBase = Number(v);
        i++;
        break;
      case "--out":
        a.out = path.resolve(String(v));
        i++;
        break;
      case "--quiet":
        a.quiet = true;
        break;
      case "--label":
        a.label = String(v);
        i++;
        break;
      default:
        if (k.startsWith("--")) throw new Error(`unknown argument ${k}`);
    }
  }
  if (!Number.isFinite(a.runs) || !Number.isFinite(a.bots) || !Number.isFinite(a.idle) || !Number.isFinite(a.seedBase)) {
    throw new Error("--runs / --bots / --idle / --seed-base must be numbers");
  }
  if (["vacation", "normal", "nightmare"].indexOf(a.difficulty) < 0) throw new Error(`unknown difficulty ${a.difficulty}`);
  return a;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const scenario: Scenario = {
    bots: args.bots,
    idleHumans: args.idle,
    difficulty: args.difficulty,
    fast: args.fast,
  };
  const started = Date.now();
  const rows: RunRow[] = [];
  const tag = `${args.label}-${STAMP}`;
  process.stdout.write(
    `qa:runs — ${args.runs} runs · ${args.bots} bots + ${args.idle} idle humans · ${args.difficulty} · ` +
      `${args.fast ? "fast" : "normal"} timers · seeds from ${args.seedBase} step 7919\n`,
  );
  for (let i = 0; i < args.runs; i++) {
    const seed = seedAt(args.seedBase, i);
    const { row } = runOne(seed, scenario, i, tag);
    rows.push(row);
    if (!args.quiet && (i === 0 || (i + 1) % 10 === 0 || i === args.runs - 1)) {
      process.stdout.write(
        `  [${String(i + 1).padStart(3)}/${args.runs}] seed ${seed} ${row.outcome.padEnd(7)} ` +
          `${String(row.match_seconds).padStart(3)} s · ready ${row.raft_ready_s ?? "—"} s · depart ${row.departure_s ?? "—"} s · stage ${row.stage} · ${row.end_reason} · deaths ${row.team_downed}\n`,
      );
    }
  }
  const durationMs = Date.now() - started;
  const meta = {
    generatedAt: new Date().toISOString(),
    scenario:
      `${args.difficulty}, ${args.bots} bots + ${args.idle} idle humans, ` + (args.fast ? "fast timers" : "normal timings"),
    runs: rows.length,
    seeds: [seedAt(args.seedBase, 0), seedAt(args.seedBase, rows.length - 1)] as [number, number],
    fast: args.fast,
    durationMs,
  };

  fs.mkdirSync(args.out, { recursive: true });
  const csvPath = path.join(args.out, `runs-${tag}.csv`);
  const jsonPath = path.join(args.out, `runs-${tag}.json`);
  const mdPath = path.join(args.out, `summary-${tag}.md`);
  const heatPath = path.join(args.out, `heatmap-${tag}.csv`);
  const heat = heatmapRows(rows);

  fs.writeFileSync(csvPath, toCsv(rows));
  fs.writeFileSync(jsonPath, toJson(rows, meta));
  fs.writeFileSync(mdPath, summarize(rows, meta));
  fs.writeFileSync(
    heatPath,
    "x,y,deaths,causes\n" + heat.map((c) => `${c.x},${c.y},${c.count},"${c.causes}"`).join("\n") + "\n",
  );

  const wins = rows.filter((r) => r.outcome === "win").length;
  process.stdout.write(
    `\n${wins}/${rows.length} wins (${((100 * wins) / rows.length).toFixed(1)} %) in ${(durationMs / 1000).toFixed(1)} s\n` +
      `CSV   ${csvPath}\nJSON  ${jsonPath}\nMD    ${mdPath}\nHEAT  ${heatPath}\n`,
  );
}

main();
