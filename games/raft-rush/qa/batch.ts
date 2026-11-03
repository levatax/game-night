// Batch runner: plays N matches on the real RaftWorld + BotDesk and writes CSV + JSON + a one-page summary.
// Owner: qa. No game logic is changed.
//
//   npm run qa:runs -- --expert 90 --novice 60 --label skills
//   npm run qa:runs -- --runs 30 --idle 1 --bots 2 --label idle-smoke
//   npm run qa:runs -- --runs 6 --fast            (RAFT_TEST timers, flow smoke only)
//
// --expert / --novice play the focal human seat with the deterministic pilot policy in qa/humanPilot.ts (90 + 60
// in one CSV, one distinct seed per run). Without them the old --runs path is unchanged (focal is the first bot,
// or an idle human when --idle > 0).
//
// The room's phase loop is reproduced exactly like server/room/botBalance.test.ts; match_seconds are simulated
// match seconds, so 150 real-timing runs take a few minutes here instead of days of wall clock.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Difficulty } from "../shared/types.js";
import { runOne, seedAt, type Scenario } from "./match.js";
import type { PilotSkill } from "./humanPilot.js";
import { heatmapRows, summarize } from "./report.js";
import { toCsv, toJson, type RunRow } from "./telemetry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHA = (() => {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

interface Args {
  runs: number;
  bots: number;
  idle: number;
  expert: number;
  novice: number;
  difficulty: Difficulty;
  fast: boolean;
  seedBase: number;
  out: string;
  quiet: boolean;
  label: string;
  shard: number;
  shards: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    runs: 120,
    bots: 3,
    idle: 0,
    expert: 0,
    novice: 0,
    difficulty: "normal",
    fast: false,
    seedBase: 1000,
    out: path.join(HERE, "out"),
    quiet: false,
    label: "batch",
    shard: 0,
    shards: 1,
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
      case "--expert":
        a.expert = Math.max(0, Number(v));
        i++;
        break;
      case "--novice":
        a.novice = Math.max(0, Number(v));
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
      case "--shard":
        a.shard = Math.max(0, Number(v));
        i++;
        break;
      case "--shards":
        a.shards = Math.max(1, Number(v));
        i++;
        break;
      default:
        if (k.startsWith("--")) throw new Error(`unknown argument ${k}`);
    }
  }
  if (!Number.isFinite(a.runs) || !Number.isFinite(a.bots) || !Number.isFinite(a.idle) || !Number.isFinite(a.seedBase)) {
    throw new Error("--runs / --bots / --idle / --seed-base must be numbers");
  }
  if (!Number.isFinite(a.expert) || !Number.isFinite(a.novice)) throw new Error("--expert / --novice must be numbers");
  if (["vacation", "normal", "nightmare"].indexOf(a.difficulty) < 0) throw new Error(`unknown difficulty ${a.difficulty}`);
  return a;
}

interface PlannedRun {
  seed: number;
  skill: PilotSkill | null;
  scenario: Scenario;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const skillMode = args.expert + args.novice > 0;
  if (skillMode && args.idle > 0) throw new Error("--expert/--novice cannot be combined with --idle");
  if (args.shard >= args.shards) throw new Error("--shard must be < --shards");
  const total = skillMode ? args.expert + args.novice : args.runs;
  const bots = skillMode ? args.bots : args.bots;
  const base: Scenario = {
    bots,
    idleHumans: skillMode ? 0 : args.idle,
    difficulty: args.difficulty,
    fast: args.fast,
  };

  const plan: PlannedRun[] = [];
  for (let i = 0; i < total; i++) {
    if (i % args.shards !== args.shard) continue;
    const skill: PilotSkill | null = skillMode ? (i < args.expert ? "expert" : "novice") : null;
    plan.push({ seed: seedAt(args.seedBase, i), skill, scenario: { ...base, pilot: skill ?? undefined } });
  }

  const started = Date.now();
  const rows: RunRow[] = [];
  const tag = `${args.label}-${STAMP}`;
  const scenarioText = skillMode
    ? `${args.difficulty}, ${bots} bots + 1 human with a skill policy (${args.expert} expert + ${args.novice} novice), ` +
      `${args.fast ? "fast" : "normal"} timers`
    : `${args.difficulty}, ${args.bots} bots + ${args.idle} idle humans, ` + (args.fast ? "fast" : "normal timings");
  process.stdout.write(
    `qa:runs — ${total} runs · ${scenarioText} · seeds from ${args.seedBase} step 7919\n`,
  );
  for (let i = 0; i < plan.length; i++) {
    const { seed, skill, scenario } = plan[i]!;
    const group = skill ?? (args.idle > 0 ? "idle" : "bot");
    const idx = i % Math.max(1, skill === "expert" ? args.expert : skill === "novice" ? args.novice : total);
    const { row } = runOne(seed, scenario, idx, `${tag}-${group}`);
    rows.push(row);
    if (!args.quiet && (i === 0 || (i + 1) % 10 === 0 || i === plan.length - 1)) {
      process.stdout.write(
        `  [${String(i + 1).padStart(3)}/${total}] ${group.padEnd(6)} seed ${seed} ${row.outcome.padEnd(7)} ` +
          `${String(row.match_seconds).padStart(3)} s · ready ${row.raft_ready_s ?? "—"} s · depart ${row.departure_s ?? "—"} s · ` +
          `stage ${row.stage} · ${row.end_reason} · deaths ${row.team_downed}\n`,
      );
    }
  }
  const durationMs = Date.now() - started;
  const meta = {
    generatedAt: new Date().toISOString(),
    sha: SHA,
    scenario: scenarioText,
    runs: rows.length,
    seeds: [seedAt(args.seedBase, 0), seedAt(args.seedBase, rows.length - 1)] as [number, number],
    fast: args.fast,
    durationMs,
    cohorts: skillMode ? { expert: args.expert, novice: args.novice } : { [args.idle > 0 ? "idle" : "bot"]: total },
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

  // Skill cohorts get their own files too, so scripts/raft-acceptance.mjs can read them by cohort.
  if (skillMode) {
    for (const skill of ["expert", "novice"] as PilotSkill[]) {
      const subset = rows.filter((r) => r.skill === skill);
      if (!subset.length) continue;
      const subMeta = { ...meta, scenario: `${meta.scenario} — ${skill} cohort only`, runs: subset.length };
      fs.writeFileSync(path.join(args.out, `runs-${skill}-${tag}.csv`), toCsv(subset));
      fs.writeFileSync(path.join(args.out, `summary-${skill}-${tag}.md`), summarize(subset, subMeta));
    }
  }

  const wins = rows.filter((r) => r.outcome === "win").length;
  process.stdout.write(
    `\n${wins}/${rows.length} wins (${((100 * wins) / rows.length).toFixed(1)} %) in ${(durationMs / 1000).toFixed(1)} s\n` +
      `CSV   ${csvPath}\nJSON  ${jsonPath}\nMD    ${mdPath}\nHEAT  ${heatPath}\n`,
  );
}

main();
