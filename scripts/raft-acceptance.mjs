#!/usr/bin/env node
// Reads the CSVs written by `npm run qa:runs` (QA's single measurement engine) and holds the beta acceptance
// gate. It never plays a match and never invents a number: every figure below comes from the same CSV the CI
// run uploads as an artifact. Owner: devops.
//
//   node scripts/raft-acceptance.mjs --expert qa/out/runs-expert-*.csv --novice qa/out/runs-novice-*.csv
//   node scripts/raft-acceptance.mjs --expert ... --report-only
//
// Exit 0 = every check passed (or --report-only); 1 = at least one FAIL. A missing column is a FAIL (schema
// drift), except boss_spawn: today's QA schema has no boss column, so that check is UNVERIFIED, printed loudly.
// boss_spawn is only checked on runs that reach the boss window (match_seconds >= 450): a run that ended earlier
// by launch, wipe or storm is correctly boss_spawn=0 and is reported as out of scope, never as a FAIL.
import fs from "node:fs";

function parseArgs(argv) {
  const a = { expert: "", novice: "", reportOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--expert") a.expert = argv[++i] ?? "";
    else if (k === "--novice") a.novice = argv[++i] ?? "";
    else if (k === "--report-only") a.reportOnly = true;
    else if (k.startsWith("--")) throw new Error(`unknown argument ${k}`);
  }
  if (!a.expert) throw new Error("--expert <csv> is required");
  return a;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
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
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}

function resolveFile(file, label) {
  if (!/[*?]/.test(file)) return file;
  const dir = fs.existsSync(file.slice(0, file.lastIndexOf("/"))) ? file.slice(0, file.lastIndexOf("/")) : ".";
  const base = file.slice(file.lastIndexOf("/") + 1);
  const rx = new RegExp("^" + base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => rx.test(n));
  } catch (e) {
    throw new Error(`${label}: cannot list ${dir}: ${e.message}`);
  }
  if (names.length === 0) throw new Error(`${label}: no CSV matches ${file}`);
  const full = names.map((n) => `${dir}/${n}`);
  full.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (full.length > 1) process.stderr.write(`${label}: ${full.length} files match ${file}; using newest ${full[0]}\n`);
  return full[0];
}

function readRuns(file, label) {
  let text;
  try {
    text = fs.readFileSync(resolveFile(file, label), "utf8");
  } catch (e) {
    throw new Error(`${label}: cannot read ${file}: ${e.message}`);
  }
  const table = parseCsv(text);
  if (table.length < 2) throw new Error(`${label}: ${file} has no data rows`);
  const head = table[0].map((h) => h.trim());
  const need = ["seed", "outcome", "raft_ready_s", "departure_s", "match_seconds"];
  const missing = need.filter((c) => !head.includes(c));
  if (missing.length) throw new Error(`${label}: ${file} is missing column(s) ${missing.join(", ")}`);
  const idx = Object.fromEntries(head.map((h, i) => [h, i]));
  const num = (v) => {
    if (v === undefined || v === null || String(v).trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return table.slice(1).map((r) => ({
    seed: num(r[idx.seed]),
    outcome: (r[idx.outcome] ?? "").trim(),
    raft_ready_s: num(r[idx.raft_ready_s]),
    departure_s: num(r[idx.departure_s]),
    match_seconds: num(r[idx.match_seconds]),
    boss_spawn: idx.boss_spawn === undefined ? undefined : num(r[idx.boss_spawn]),
  }));
}

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const r1 = (n) => (n === null ? "—" : (Math.round(n * 10) / 10).toString());
const pct = (a, b) => (b === 0 ? "—" : ((100 * a) / b).toFixed(1));

function stats(rows) {
  const wins = rows.filter((r) => r.outcome === "win").length;
  const ready = rows.map((r) => r.raft_ready_s).filter((x) => x !== null);
  const depart = rows.map((r) => r.departure_s).filter((x) => x !== null);
  const boss = rows.map((r) => r.boss_spawn).filter((x) => x !== undefined && x !== null);
  const bossScoped = rows.filter((r) => r.boss_spawn !== undefined && r.boss_spawn !== null && (r.match_seconds ?? 0) >= 450);
  return {
    n: rows.length,
    wins,
    winPct: (100 * wins) / Math.max(1, rows.length),
    readyMedian: median(ready),
    departMedian: median(depart),
    readyMissing: rows.length - ready.length,
    departMissing: rows.length - depart.length,
    earlyReady: ready.filter((s) => s < 440).length,
    lateReady: ready.filter((s) => s > 460).length,
    earlyDepart: depart.filter((s) => s < 470).length,
    lateDepart: depart.filter((s) => s > 495).length,
    bossSpawned: boss.length ? bossScoped.filter((r) => r.boss_spawn > 0).length : null,
    bossScope: bossScoped.length,
    bossExcluded: boss.length - bossScoped.length,
    bossRows: boss.length,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const expert = stats(readRuns(args.expert, "expert"));
  const novice = args.novice ? stats(readRuns(args.novice, "novice")) : null;

  const checks = [];
  const add = (id, title, verdict, measured) => checks.push({ id, title, verdict, measured });
  const band = (v, lo, hi) => v !== null && v >= lo && v <= hi;

  const timingOk = [expert, novice].filter(Boolean).every((s) => s.readyMissing === 0 && s.departMissing === 0);
  add("AT0", "CSV rows and timing columns", timingOk ? "PASS" : "FAIL",
    [expert, novice].filter(Boolean)
      .map((s) => `${s.n} rows; missing raft_ready_s ${s.readyMissing}, departure_s ${s.departMissing}`)
      .join(" · "));
  add("AT1", "Expert raft ready (stage 3) median 440–460 s", band(expert.readyMedian, 440, 460) ? "PASS" : "FAIL",
    `median ${r1(expert.readyMedian)} s; ${expert.earlyReady} < 440, ${expert.lateReady} > 460`);
  add("AT2", "Expert departure (raft left) median 470–495 s", band(expert.departMedian, 470, 495) ? "PASS" : "FAIL",
    `median ${r1(expert.departMedian)} s; ${expert.earlyDepart} < 470, ${expert.lateDepart} > 495`);
  add("AT3", "Expert win 55–75 %", band(expert.winPct, 55, 75) ? "PASS" : "FAIL",
    `${pct(expert.wins, expert.n)} % (${expert.wins}/${expert.n})`);
  if (novice) {
    add("AT4", "Idle-human cohort never wins (0 wins)", novice.wins === 0 ? "PASS" : "FAIL",
      `${novice.wins}/${novice.n} wins; launched ${pct(novice.wins, novice.n)} %; raft ready median ${r1(novice.readyMedian)} s`);
  }
  const bossStats = [expert, novice].filter(Boolean).filter((s) => s.bossRows > 0);
  if (bossStats.length) {
    const all = bossStats.every((s) => s.bossScope > 0 && s.bossSpawned === s.bossScope);
    add("AT5", "Boss spawn 100 % on runs reaching 450 s", all ? "PASS" : "FAIL",
      bossStats.map((s) => `${s.bossSpawned}/${s.bossScope} in scope; ${s.bossExcluded} ended before 450 s (out of scope)`).join(" · "));
  } else {
    add("AT5", "Boss spawn 100 % on runs reaching 450 s", "UNVERIFIED", "QA CSV has no boss_spawn column yet");
  }

  const failed = checks.filter((c) => c.verdict === "FAIL");
  const lines = [
    "## Raft Rush acceptance gate (QA qa:runs CSV)",
    "",
    "| # | check | verdict | measured |",
    "|---|---|---|---|",
    ...checks.map((c) => `| ${c.id} | ${c.title} | **${c.verdict}** | ${c.measured} |`),
    "",
    "### Two separate clock columns",
    "",
    "| cohort | runs | raft_ready_s median | departure_s median | ready early/late | depart early/late | win % |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...(novice ? [expert, novice] : [expert]).map((s, i) =>
      `| ${i === 0 ? "expert" : "novice"} | ${s.n} | ${r1(s.readyMedian)} s | ${r1(s.departMedian)} s | ${s.earlyReady}/${s.lateReady} | ${s.earlyDepart}/${s.lateDepart} | ${pct(s.wins, s.n)} |`),
    "",
    "_raft_ready_s = stage 3 complete and the raft is in the water; departure_s = the raft actually left. " +
      "They are reported separately: ready 440–460 s is not a departure._",
    "",
  ];
  for (const l of lines) process.stdout.write(l + "\n");

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, lines.join("\n") + "\n");

  if (args.reportOnly) {
    process.stdout.write(`\nREPORT ONLY: ${failed.length} failing check(s) not enforced\n`);
    return;
  }
  process.stdout.write(`\nGATE ${failed.length === 0 ? "PASS" : "FAIL"} (${checks.length - failed.length}/${checks.length})\n`);
  if (failed.length) process.exitCode = 1;
}

main();
