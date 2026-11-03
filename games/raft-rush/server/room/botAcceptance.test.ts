// Raft Rush staging acceptance gates (owner: devops). Runs the real RaftWorld headlessly, no rule changes.
//
//   RAFT_ACCEPT=1 npx vitest run games/raft-rush/server/room/botAcceptance.test.ts --disableConsoleIntercept
//
// Knobs: RAFT_ACCEPT_RUNS (default 120 matches), RAFT_ACCEPT_ISLANDS (default 40 islands: 3 attempts each),
// RAFT_ACCEPT_NOVICE_RUNS (default 20). Set RAFT_ACCEPT_BAND=0 to report without failing on the win-rate gate.
//
// Gates (fail → CI red):
//   A  novice: 2 bots + 1 human who never moves, 20 runs → 0 launches.
//   B  bot-only: launch median in 440–460 s, zero early launches (< 440 s).
//   C  storm clock: the HUD countdown and the warning banner print the same second.
//   D  no tutorial mode, first meaningful choice (the "move" tip) inside 20 s of the match.
// Reported, not gated: win % with Wilson 95 % CI and the ICC=0.1 cluster correction, per-tick server cost,
// process RSS. Draw calls / triangles come from scripts/measure-render-budget.ts; FPS needs a real GPU.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DAYS, TICK_RATE, timingsFor } from "../../shared/constants.js";
import { secondsLeft } from "../room/timings.js";
import { median, runAcceptanceMatch, wilson, clusteredHalfWidth } from "./acceptanceHarness.js";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

const env = process.env;
const enabled = !!env.RAFT_ACCEPT;
const runCount = Number(env.RAFT_ACCEPT_RUNS ?? 120);
const islandCount = Number(env.RAFT_ACCEPT_ISLANDS ?? 40);
const noviceRuns = Number(env.RAFT_ACCEPT_NOVICE_RUNS ?? 20);
const checkBand = env.RAFT_ACCEPT_BAND !== "0";
/** Optional parallel split for a long nightly run: shard i of n. */
const shard = Number(env.RAFT_ACCEPT_SHARD ?? 0);
const shards = Math.max(1, Number(env.RAFT_ACCEPT_SHARDS ?? 1));

/** Island seeds for the clustered design: `attempts` runs per island. */
function design(runs: number, islands: number): Array<{ seed: number; attempt: number }> {
  const perIsland = Math.max(1, Math.ceil(runs / islands));
  const out: Array<{ seed: number; attempt: number }> = [];
  for (let i = 0; out.length < runs; i++) {
    const seed = 1000 + i * 7919;
    for (let a = 0; a < perIsland && out.length < runs; a++) out.push({ seed, attempt: a });
  }
  return out;
}

function rssMb(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

describe("raft rush staging acceptance", () => {
  it.skipIf(!enabled || shard !== 0)("A: an idle player with two bots does not win", { timeout: 120_000 }, () => {
    const runs = Array.from({ length: noviceRuns }, (_, i) => runAcceptanceMatch(2000 + i * 104729, { bots: 2, idleHumans: 1, attempt: i % 3 }));
    const wins = runs.filter((r) => r.outcome === "launched");
    const ci = wilson(wins.length, runs.length);
    out(
      `A novice (2 bots + 1 idle human): ${wins.length}/${runs.length} launched = ${ci.pct.toFixed(0)} % ` +
        `(Wilson 95 % ${ci.lo.toFixed(0)}–${ci.hi.toFixed(0)} %); launch times ${runs.map((r) => (r.outcome === "launched" ? r.seconds : "-")).join(",")}`,
    );
    if (checkBand) expect(wins.length, "idle player + 2 bots must never launch").toBe(0);
  });

  it.skipIf(!enabled)("B: bot-only launch lands in 440–460 s with no early landing", { timeout: 900_000 }, () => {
    const plan = design(runCount, islandCount).filter((_, i) => i % shards === shard);
    const started = performance.now();
    const runs = plan.map(({ seed, attempt }) => runAcceptanceMatch(seed, { bots: 3, attempt }));
    const secs = (performance.now() - started) / 1000;
    const launched = runs.filter((r) => r.outcome === "launched");
    const early = launched.filter((r) => r.seconds < 440);
    const late = launched.filter((r) => r.seconds > 460);
    const wins = launched.length;
    const ci = wilson(wins, runs.length);
    const half = (ci.hi - ci.lo) / 2;
    const clusterHalf = clusteredHalfWidth(half, Math.ceil(runCount / islandCount), 0.1);
    const effectiveN = runs.length / (1 + (Math.ceil(runCount / islandCount) - 1) * 0.1);
    const byBiome = new Map<string, { wins: number; n: number }>();
    for (const r of runs) {
      const b = byBiome.get(r.biome) ?? { wins: 0, n: 0 };
      b.n++;
      if (r.outcome === "launched") b.wins++;
      byBiome.set(r.biome, b);
    }
    const tickTotal = runs.reduce((s, r) => s + r.tickMs, 0);
    const tickMax = Math.max(...runs.map((r) => r.maxTickMs));
    out(`B matches: ${runs.length} runs on ${islandCount} islands × ${Math.ceil(runCount / islandCount)} attempts in ${secs.toFixed(1)} s`);
    out(
      `B launch: ${wins}/${runs.length} launched = ${ci.pct.toFixed(1)} % (Wilson 95 % ${ci.lo.toFixed(1)}–${ci.hi.toFixed(1)} %); ` +
        `ICC 0.1 cluster-corrected ±${clusterHalf.toFixed(1)} → ${Math.max(0, ci.pct - clusterHalf).toFixed(1)}–${Math.min(100, ci.pct + clusterHalf).toFixed(1)} %; effective n ≈ ${effectiveN.toFixed(0)}`,
    );
    out(
      `B launch median ${median(launched.map((r) => r.seconds))} s; early (<440 s) ${early.length}; late (>460 s) ${late.length}; ` +
        `outcomes ${JSON.stringify(runs.reduce<Record<string, number>>((m, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {}))}`,
    );
    out(`B by biome: ${[...byBiome].map(([b, v]) => `${b} ${v.wins}/${v.n}`).join(", ")}`);
    const ticks = runs.reduce((s, r) => s + r.seconds * TICK_RATE, 0);
    out(`B server cost: mean tick ${(tickTotal / Math.max(1, ticks)).toFixed(3)} ms`);
    out(`B tick: total ${(tickTotal / 1000).toFixed(1)} s, worst single tick ${tickMax.toFixed(2)} ms; RSS ${rssMb().toFixed(0)} MB after the batch`);
    if (checkBand) {
      expect(early.length, "early launches (< 440 s)").toBe(0);
      expect(median(launched.map((r) => r.seconds)), "launch median (s)").toBeGreaterThanOrEqual(440);
      expect(median(launched.map((r) => r.seconds)), "launch median (s)").toBeLessThanOrEqual(460);
    }
  });

  it("C: the storm clock and the storm banner print the same second", () => {
    const timings = timingsFor(false);
    let mismatches = 0;
    for (let ticks = 0; ticks <= timings.night + 60; ticks++) {
      const banner = secondsLeft(ticks); // server → banner param {sec}
      const hud = Math.max(0, Math.ceil(ticks / TICK_RATE)); // DayClock: ceil of the same tick count
      if (banner !== hud) mismatches++;
    }
    out(`C storm clock vs banner: ${mismatches} differing ticks in ${timings.night + 61} (0 expected)`);
    expect(mismatches).toBe(0);
  });

  it("D: there is no tutorial mode and the first choice window is ≤ 20 s", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const coach = readFileSync(join(here, "../../client/src/app/coach.ts"), "utf8");
    const moveDelay = Number(/MOVE_TIP_DELAY_MS\s*=\s*(\d+)/.exec(coach)?.[1] ?? NaN);
    const landing = timingsFor(false).landing / TICK_RATE;
    const firstChoice = landing + moveDelay / 1000;
    const tutorial = /tutorial|onboarding/i.test(coach);
    out(`D landing ${landing.toFixed(1)} s + move tip ${moveDelay} ms → first meaningful choice at ${firstChoice.toFixed(1)} s; tutorial=false; days=${DAYS}`);
    expect(tutorial).toBe(false);
    expect(firstChoice).toBeLessThanOrEqual(20);
  });
});
