// Acceptance gate: runs the five acceptance criteria and prints one verdict table. Owner: qa. No game code.
//
//   npm run qa:gate
//   npm run qa:gate -- --no-client      (server-side criteria only; client ones are then UNVERIFIED)
//
// AT1 and AT2 run in-process on the real RaftWorld + BotDesk (fast, deterministic). AT3–AT5 come from
// qa/client-probe.mjs, which drives the real browser client; if that cannot run here they are UNVERIFIED,
// never PASS.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runOne, seedAt, type Scenario } from "./match.js";
import type { RunRow } from "./telemetry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

interface Check {
  id: string;
  title: string;
  verdict: "PASS" | "FAIL" | "UNVERIFIED";
  measured: string;
  detail: string[];
}

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? "") : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUNS = Math.max(1, Number(arg("runs", "20")));
const SEED_BASE = Number(arg("seed-base", "1000"));
const OUT = path.resolve(arg("out", path.join(HERE, "out")));
const NO_CLIENT = flag("no-client");

function play(scenario: Scenario, runs: number): RunRow[] {
  const rows: RunRow[] = [];
  for (let i = 0; i < runs; i++) rows.push(runOne(seedAt(SEED_BASE, i), scenario, i, "gate").row);
  return rows;
}

function checkIdle(): Check {
  const rows = play({ bots: 2, idleHumans: 1, difficulty: "normal", fast: false }, RUNS);
  const wins = rows.filter((r) => r.outcome === "win");
  const launched = rows.filter((r) => r.end_reason === "launched");
  return {
    id: "AT1",
    title: `Idle human + 2 bots never win (${RUNS} runs)`,
    verdict: wins.length === 0 ? "PASS" : "FAIL",
    measured: `${wins.length}/${rows.length} wins (need 0); ${launched.length} launched`,
    detail: wins.slice(0, 5).map((r) => `seed ${r.seed}: won at ${r.match_seconds} s, human boarded=${r.focal_boarded}, points=${r.focal_points}, washed=${r.focal_washed}`),
  };
}

function checkBotTiming(): Check {
  const rows = play({ bots: 3, idleHumans: 0, difficulty: "normal", fast: false }, RUNS);
  const wins = rows.filter((r) => r.outcome === "win");
  const nonWin = rows.filter((r) => r.outcome !== "win");
  const ready = rows.map((r) => r.raft_ready_s).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const depart = rows.map((r) => r.departure_s).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const med = (xs: number[]): number => (xs.length ? xs[Math.floor(xs.length / 2)]! : 0);
  const earlyReady = ready.filter((s) => s < 440);
  const readyLate = ready.filter((s) => s > 460);
  const departEarly = depart.filter((s) => s < 470);
  const departLate = depart.filter((s) => s > 495);
  const missing = rows.filter((r) => r.raft_ready_s === null).length;
  const pass =
    nonWin.length === 0 &&
    missing === 0 &&
    earlyReady.length === 0 &&
    readyLate.length === 0 &&
    departEarly.length === 0 &&
    departLate.length === 0 &&
    ready.length === rows.length &&
    depart.length === rows.length;
  return {
    id: "AT2",
    title: `Bot-only: raft ready 440–460 s, departure 470–495 s, 0 early ready (<440) (${RUNS} runs)`,
    verdict: pass ? "PASS" : "FAIL",
    measured: ready.length
      ? `ready min/median/max ${ready[0]} / ${med(ready)} / ${ready[ready.length - 1]} s; ${earlyReady.length} early (<440), ${readyLate.length} late (>460); ` +
        `departure min/median/max ${depart[0] ?? "—"} / ${med(depart)} / ${depart[depart.length - 1] ?? "—"} s; ${departEarly.length} early (<470), ${departLate.length} late (>495); ${nonWin.length} non-launch`
      : `no raft-ready data; ${nonWin.length} non-launch runs`,
    detail: rows
      .filter((r) => r.outcome !== "win" || (r.raft_ready_s ?? 0) < 440 || (r.raft_ready_s ?? 0) > 460 || (r.departure_s ?? 0) < 470 || (r.departure_s ?? 0) > 495)
      .slice(0, 6)
      .map((r) => `seed ${r.seed}: ready ${r.raft_ready_s ?? "—"} s, departure ${r.departure_s ?? "—"} s, ${r.outcome} (${r.end_reason})`),
  };
}

interface ProbeJson {
  onboarding?: {
    ok: boolean;
    error: string | null;
    stormClock: { hud: string; banner: string; diffSeconds: number | null } | null;
    modal: { dialogs: string[]; device: boolean; tips: number } | null;
    choices: Array<{ type: string; t: number }>;
    firstInputS: number | null;
    firstChoiceS: number | null;
    choices60: number;
  } | null;
  compass?: {
    ok: boolean;
    error: string | null;
    viewports: Array<{
      width: number;
      height: number;
      ok: boolean;
      error: string | null;
      night2: boolean;
      maxOverlapPairs: number;
      maxOverlaps: string[];
      maxMarks: number;
      maxCrabMarks: number;
    }>;
  } | null;
  error: string | null;
}

function runProbe(): ProbeJson | null {
  const probeOut = path.join(OUT, `probe-${STAMP}.json`);
  try {
    execFileSync(process.execPath, [path.join(HERE, "client-probe.mjs"), "--json", "--out", probeOut], {
      cwd: REPO,
      env: { ...process.env, NODE_ENV: "development" },
      encoding: "utf8",
      timeout: 12 * 60 * 1000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    /* the probe writes its error into the file when it can */
  }
  try {
    return JSON.parse(fs.readFileSync(probeOut, "utf8")) as ProbeJson;
  } catch {
    return null;
  }
}

function checkOnboarding(probe: ProbeJson | null): Check {
  const p = probe?.onboarding;
  if (!p) return { id: "AT3", title: "First choice ≤20 s, ≥3 choices in 60 s, no modal tutorial", verdict: "UNVERIFIED", measured: "client probe unavailable", detail: [probe?.error ?? "no probe result"] };
  const modal = p.modal;
  const noModal = !!modal && modal.dialogs.length === 0 && modal.tips === 0;
  const pass = p.ok && p.firstChoiceS !== null && p.firstChoiceS <= 20 && p.choices60 >= 3 && noModal;
  return {
    id: "AT3",
    title: "First choice ≤20 s, ≥3 choices in 60 s, no modal tutorial",
    verdict: pass ? "PASS" : "FAIL",
    measured: p.ok
      ? `first choice ${p.firstChoiceS ?? "—"} s; ${p.choices60} choices ≤60 s (${p.choices.map((c) => `${c.type}@${c.t}s`).join(", ")}); modal tutorial ${noModal ? "none" : "present"}`
      : `probe failed: ${p.error}`,
    detail: [
      `first input ${p.firstInputS ?? "—"} s`,
      `modal: dialogs=${JSON.stringify(modal?.dialogs ?? [])} device=${modal?.device ?? "?"} tips=${modal?.tips ?? "?"}`,
      ...p.choices.map((c) => `choice ${c.type} at ${c.t} s`),
    ],
  };
}

function checkCompass(probe: ProbeJson | null): Check {
  const p = probe?.compass;
  const title = "Night-2 compass at 1280×800 and 1920×1080: 10 marks, 0 overlapping pairs";
  if (!p) return { id: "AT4", title, verdict: "UNVERIFIED", measured: "client probe unavailable", detail: [probe?.error ?? "no probe result"] };
  const vps = p.viewports ?? [];
  if (!p.ok || vps.length === 0) return { id: "AT4", title, verdict: "UNVERIFIED", measured: `probe failed: ${p.error}`, detail: [] };
  const bad = vps.filter((v) => !v.ok || !v.night2 || v.maxOverlapPairs > 0 || v.maxMarks < 10);
  const pass = bad.length === 0;
  return {
    id: "AT4",
    title,
    verdict: pass ? "PASS" : "FAIL",
    measured: vps
      .map((v) => `${v.width}×${v.height}: ${v.maxOverlapPairs} pair(s), ${v.maxMarks} marks (${v.maxCrabMarks} crab)`)
      .join("; "),
    detail: vps.flatMap((v) => [
      `${v.width}×${v.height}: night2=${v.night2}, ${v.maxOverlapPairs} overlapping pair(s)`,
      ...v.maxOverlaps.slice(0, 6).map((o) => `  ${v.width}×${v.height} overlap: ${o}`),
    ]),
  };
}

function checkStormClock(probe: ProbeJson | null): Check {
  const c = probe?.onboarding?.stormClock;
  if (!c) return { id: "AT5", title: "Storm clock: HUD and banner agree (0 s)", verdict: "UNVERIFIED", measured: "clock pair not captured", detail: [probe?.onboarding?.error ?? probe?.error ?? "no probe result"] };
  const pass = c.diffSeconds === 0;
  return {
    id: "AT5",
    title: "Storm clock: HUD and banner agree (0 s)",
    verdict: pass ? "PASS" : "FAIL",
    measured: `HUD "${c.hud}" vs banner "${c.banner}" → ${c.diffSeconds ?? "?"} s`,
    detail: [],
  };
}

function main(): void {
  const started = Date.now();
  const checks: Check[] = [checkIdle(), checkBotTiming()];
  let probe: ProbeJson | null = null;
  if (!NO_CLIENT) probe = runProbe();
  checks.push(checkOnboarding(probe), checkCompass(probe), checkStormClock(probe));

  const lines: string[] = [
    `# Raft Rush — acceptance gate`,
    ``,
    `- generated: ${new Date().toISOString()}`,
    `- runs per scenario: ${RUNS} (seeds ${seedAt(SEED_BASE, 0)} … ${seedAt(SEED_BASE, RUNS - 1)})`,
    `- client probe: ${NO_CLIENT ? "skipped (--no-client)" : probe?.error ? `error: ${probe.error}` : "ran"}`,
    ``,
    `| # | criterion | verdict | measured |`,
    `|---|---|---|---|`,
    ...checks.map((c) => `| ${c.id} | ${c.title} | **${c.verdict}** | ${c.measured.replaceAll("|", "\\|")} |`),
    ``,
  ];
  for (const c of checks) {
    if (c.detail.length === 0) continue;
    lines.push(`## ${c.id} — ${c.title}`, ...c.detail.map((d) => `- ${d}`), ``);
  }
  lines.push(`_Totals: ${checks.filter((c) => c.verdict === "PASS").length} pass · ${checks.filter((c) => c.verdict === "FAIL").length} fail · ${checks.filter((c) => c.verdict === "UNVERIFIED").length} unverified._`, ``);

  fs.mkdirSync(OUT, { recursive: true });
  const md = path.join(OUT, `gate-${STAMP}.md`);
  const json = path.join(OUT, `gate-${STAMP}.json`);
  fs.writeFileSync(md, lines.join("\n"));
  fs.writeFileSync(json, JSON.stringify({ checks, probe }, null, 2) + "\n");

  for (const c of checks) process.stdout.write(`${c.id} ${c.verdict.padEnd(10)} ${c.measured}  — ${c.title}\n`);
  process.stdout.write(`\n${checks.filter((c) => c.verdict === "PASS").length}/${checks.length} pass · ${checks.filter((c) => c.verdict === "FAIL").length} fail · ${checks.filter((c) => c.verdict === "UNVERIFIED").length} unverified in ${((Date.now() - started) / 1000).toFixed(0)} s\n${md}\n`);
}

main();
