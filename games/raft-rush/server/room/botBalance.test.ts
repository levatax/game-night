// Balance harness (game4.md §20 "Dengeleme harness'i"): bot-only matches on the real RaftWorld, the room's
// phase flow reproduced in a loop (landing → playing day/dusk/night × 3 → launch | storm), printing the outcome
// per seed and a summary line (process.stdout, so a plain `vitest run` shows it). Skipped by default; run it with
//   RAFT_BALANCE=1 npx vitest run games/raft-rush/server/room/botBalance.test.ts
// Knobs: RAFT_BALANCE_SEEDS (count, default 6), RAFT_BALANCE_BOTS (3), RAFT_BALANCE_IDLE_HUMANS (0: humans who
// never move, e.g. 1 with 2 bots = the worst-case solo match), RAFT_BALANCE_DIFFICULTY (normal),
// RAFT_BALANCE_FAST=1 for the RAFT_TEST timers (4 s days, ×20 bars, a one-of-everything raft: a smoke run of
// the whole match flow, ~0.15 s a match; default: the real 8-minute timings, ~0.7 s a match),
// RAFT_BALANCE_TRACE=1 to print every bot's goal changes, RAFT_BALANCE_SEED=<n> to start at a given seed.
//
// RAFT_BALANCE_BAND=lo-hi (win %, e.g. 55-75) turns the report into an assertion. The band belongs to ONE
// scenario, the target: Normal difficulty, the default team of 3 bots, no idle humans, the real timings. That
// is the nearest the harness gets to what game4.md §20 asks of Normal (55–75 % for a human team over the real
// match): bots play the humans' part; idle humans would measure the bots carrying a passenger instead; and the
// fast timers change the rules so much that the bots lose every match there. A band given for any other
// scenario (another difficulty / team, RAFT_BALANCE_FAST=1) fails the run instead of passing silently; seed
// count, start seed and trace don't matter. No band agreed yet → report only (bots win ~all Normal matches today).
// Owner: server-bots.

import { describe, expect, it } from "vitest";
import { BOT_NAMES, BOT_ROLES, CHARACTER_IDS, TICK_RATE, timingsFor } from "../../shared/constants.js";
import { generateIsland } from "../../shared/island/generate.js";
import { mulberry32 } from "../../shared/island/noise.js";
import { clockAt, inputLocked, matchTicks, type ClockInfo } from "../../shared/rules/schedule.js";
import type { Difficulty } from "../../shared/types.js";
import { PlayerState, RaftState } from "../schema.js";
import { RaftWorld } from "../world/World.js";
import { BotDesk, type BotHost } from "./bots.js";

/** Harness output: straight to stdout (vitest swallows console.* without --disableConsoleIntercept). */
function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface MatchReport {
  seed: number;
  biome: string;
  outcome: "launched" | "storm" | "wiped" | "timeout";
  /** Seconds of the day clock used (playing phase). */
  seconds: number;
  stage: number;
  raft: string;
  delivered: number;
  downs: number;
  kills: number;
  fish: number;
  crafted: number;
  spawns: number;
  hurt: number;
  gnawed: number;
  throws: number;
  hits: number;
  /** Captain Crab: nights he came, damage he took, the night he went down (0 = never). */
  bossSpawns: number;
  bossHurt: number;
  bossDownDay: number;
  /** Raft stages lost to raft hp 0. */
  stagesLost: number;
  rejects: Record<string, number>;
  goals: Record<string, number>;
}

function runMatch(seed: number, bots: number, difficulty: Difficulty, fast: boolean, idleHumans = 0, bossHelpDay = 0): MatchReport {
  const timings = timingsFor(fast);
  const state = new RaftState();
  const island = generateIsland(seed, "solo");
  const world = new RaftWorld(state, island, { fast, difficulty, rng: mulberry32(seed ^ 0x51ed) });
  state.fast = fast;
  state.difficulty = difficulty;
  state.settings.difficulty = difficulty;
  const ids: string[] = [];
  for (let k = 0; k < bots; k++) {
    const p = new PlayerState();
    p.id = `bot-${k + 1}`;
    p.nickname = BOT_NAMES[k % BOT_NAMES.length]!;
    p.character = CHARACTER_IDS[k % CHARACTER_IDS.length]!;
    p.bot = true;
    p.botRole = BOT_ROLES[k % BOT_ROLES.length]!;
    p.seat = k;
    p.ready = true;
    state.players.set(p.id, p);
    ids.push(p.id);
  }
  // Humans who joined and then never touched the keyboard (the worst-case solo partner).
  for (let k = 0; k < idleHumans; k++) {
    const p = new PlayerState();
    p.id = `human-${k + 1}`;
    p.nickname = `Human ${k + 1}`;
    p.character = CHARACTER_IDS[(bots + k) % CHARACTER_IDS.length]!;
    p.seat = bots + k;
    p.ready = true;
    state.players.set(p.id, p);
    ids.push(p.id);
  }
  const host: BotHost = {
    state,
    world,
    rng: mulberry32(seed ^ 0xb075),
    queueInput: (id, cmd) => world.queueInput(id, cmd),
    craft: (id, recipe) => world.craft(id, recipe),
    chest: (id, msg) => world.chest(id, msg),
    emote: () => true,
    marker: () => true,
  };
  const desk = new BotDesk(host);
  for (let k = 0; k < bots; k++) desk.add(ids[k]!, BOT_ROLES[k % BOT_ROLES.length]!);
  world.startMatch(ids, Math.max(2, ids.length));
  desk.reset();
  state.phase = "landing";
  state.phaseTicksLeft = timings.landing;
  state.clockTicks = 0;
  state.day = 1;
  state.dayPhase = "day";

  const report: MatchReport = { seed, biome: island.biome, outcome: "timeout", seconds: 0, stage: 0, raft: "", delivered: 0, downs: 0, kills: 0, fish: 0, crafted: 0, spawns: 0, hurt: 0, gnawed: 0, throws: 0, hits: 0, bossSpawns: 0, bossHurt: 0, bossDownDay: 0, stagesLost: 0, rejects: {}, goals: {} };
  const limit = timings.landing + matchTicks(timings) + 60;
  const trace = !!process.env.RAFT_BALANCE_TRACE;
  const lastGoal = new Map<string, string>();
  for (let t = 0; t < limit; t++) {
    state.tick++;
    let clock: ClockInfo | null = null;
    if (state.phase === "landing") {
      if (state.phaseTicksLeft > 0) state.phaseTicksLeft--;
      if (state.phaseTicksLeft === 0) {
        state.phase = "playing";
        state.clockTicks = 0;
        clock = clockAt(0, timings);
      }
    } else {
      state.clockTicks++;
      clock = clockAt(state.clockTicks, timings);
      state.day = clock.day;
      state.dayPhase = clock.dayPhase;
      state.phaseTicksLeft = clock.phaseLeft;
      if (clock.over) {
        report.outcome = "storm";
        break;
      }
    }
    // RAFT_BALANCE_BOSS_HELP=<day>: the human's "bit of help" — Captain Crab is down by the dawn of that day and his
    // compass is in the chest (what a human with a spear does; the bots alone rarely manage it).
    if (bossHelpDay > 0 && clock && clock.day >= bossHelpDay && !state.teams[0]!.bossDown) {
      state.teams[0]!.bossDown = true;
      state.monsters.forEach((m) => {
        if (m.kind === "boss") state.monsters.delete(m.id);
      });
      if (state.teams[0]!.stage <= 4) world.returnToChest(0, "compass", 1);
      if (!report.bossDownDay) report.bossDownDay = clock.day;
    }
    desk.tick();
    if (trace && clock && (state.tick % (TICK_RATE * 10) === 0 || clock.phaseElapsed === 0)) {
      const tm = state.teams[0]!;
      out(`  == ${(state.clockTicks / TICK_RATE).toFixed(1).padStart(6)}s day ${clock.day} ${clock.dayPhase} fire ${Math.round(tm.fireFuel / TICK_RATE)}s stage ${tm.stage} have ${[...tm.raftHave].join("/")}/${[...tm.raftNeed].join("/")} work ${tm.raftWork}/${tm.raftWorkNeed} hp ${tm.raftHp} bench ${tm.benchTier} scrap ${tm.wreckScrap} boss ${tm.bossDown} monsters ${state.monsters.size}${[...state.monsters.values()].filter((m) => m.kind === "boss").map((m) => ` BOSS(${m.mode} ${m.targetId} hp${m.hp} raft ${Math.hypot(m.x - island.sites[0]!.raft.x, m.z - island.sites[0]!.raft.z).toFixed(0)}m)`).join("")} chest ${[...tm.chest.entries()].filter(([, n]) => n > 0).map(([k, n]) => `${k}${n}`).join(" ")}`);
    }
    for (const id of ids.slice(0, bots)) {
      const key = desk.goalOf(id);
      const g = key.split(":")[0] || "-";
      report.goals[g] = (report.goals[g] ?? 0) + 1;
      if (trace && key !== lastGoal.get(id)) {
        lastGoal.set(id, key);
        const failed = desk.failureOf(id);
        if (failed) out(`  ${(state.clockTicks / TICK_RATE).toFixed(1).padStart(6)}s FAILED ${id} ${failed}`);
        const p = state.players.get(id)!;
        out(`  ${(state.clockTicks / TICK_RATE).toFixed(1).padStart(6)}s ${state.dayPhase.padEnd(5)} ${id} ${p.botRole.padEnd(7)} ${key || "-"}  hp ${p.hp} hu ${p.hunger} th ${p.thirst} wa ${p.warmth} inv ${p.inv0}${p.cnt0} ${p.inv1}${p.cnt1} ${p.inv2}${p.cnt2} ${p.inv3}${p.cnt3}`);
      }
    }
    const events = world.step({ locked: inputLocked(state.phase, state.phaseTicksLeft, timings), clock: state.phase === "playing" ? clock : null });
    let done = false;
    for (const ev of events) {
      if (ev.type === "launchRequest") {
        report.outcome = "launched";
        done = true;
      } else if (ev.type === "teamWiped") {
        report.outcome = "wiped";
        done = true;
      } else if (ev.type === "reject") {
        const key = `${ev.action}:${ev.reason}`;
        report.rejects[key] = (report.rejects[key] ?? 0) + 1;
      } else if (ev.type === "playerDowned") report.downs++;
      else if (ev.type === "monsterDie" && !ev.fled) {
        report.kills++;
        if (ev.kind === "boss" && !report.bossDownDay) report.bossDownDay = state.day;
      }
      else if (ev.type === "fishResult") report.fish++;
      else if (ev.type === "crafted") report.crafted++;
      else if (ev.type === "monsterSpawn") {
        report.spawns++;
        if (ev.kind === "boss") report.bossSpawns++;
      } else if (ev.type === "monsterHurt" && ev.kind === "boss") report.bossHurt += ev.damage;
      else if (ev.type === "raftStage" && ev.lost) report.stagesLost++;
      else if (ev.type === "playerHurt") report.hurt += ev.amount;
      else if (ev.type === "raftDamage") report.gnawed += ev.amount;
      else if (ev.type === "throw" && !ev.toss) {
        report.throws++;
        if (trace) {
          const p = state.players.get(ev.ownerId)!;
          let near = "";
          let best = Infinity;
          state.monsters.forEach((m) => {
            const d = Math.hypot(m.x - p.x, m.z - p.z);
            if (d < best) {
              best = d;
              near = `${m.kind}/${m.mode} d=${d.toFixed(1)} y=${m.y.toFixed(2)} tgt=${m.targetId}`;
            }
          });
          out(`  ${(state.clockTicks / TICK_RATE).toFixed(1).padStart(6)}s THROW ${ev.ownerId} ${ev.kind} charge ${ev.charge.toFixed(2)} → ${near}`);
        }
      }
      else if (ev.type === "hit") {
        if (ev.targetType === "monster") report.hits++;
        if (trace) out(`  ${(state.clockTicks / TICK_RATE).toFixed(1).padStart(6)}s HIT ${ev.throwerId} ${ev.kind} → ${ev.targetType} ${ev.targetId}`);
      }
    }
    if (done) break;
  }
  const team = state.teams[0]!;
  report.seconds = Math.round(state.clockTicks / TICK_RATE);
  report.stage = team.stage;
  report.raft = `stage ${team.stage} have ${[...team.raftHave].join("/")} need ${[...team.raftNeed].join("/")} work ${team.raftWork}/${team.raftWorkNeed} hp ${team.raftHp} bench ${team.benchTier} fire ${Math.round(team.fireFuel / TICK_RATE)}s`;
  state.players.forEach((p) => (report.delivered += p.stats.delivered));
  return report;
}

/** Who plays, how hard, on which timers. */
interface Scenario {
  difficulty: Difficulty;
  bots: number;
  idle: number;
  fast: boolean;
}

/** The scenario RAFT_BALANCE_BAND is defined for (see the header). */
const TARGET: Readonly<Scenario> = { difficulty: "normal", bots: 3, idle: 0, fast: false };

function isTarget(s: Scenario): boolean {
  return s.difficulty === TARGET.difficulty && s.bots === TARGET.bots && s.idle === TARGET.idle && s.fast === TARGET.fast;
}

function scenarioName(s: Scenario): string {
  return `${s.difficulty}, ${s.bots} bots + ${s.idle} idle humans, ${s.fast ? "fast" : "normal"} timings`;
}

/** RAFT_BALANCE_BAND "lo-hi" (win %, 0 ≤ lo ≤ hi ≤ 100); null when unset. */
function parseBand(raw: string | undefined): { lo: number; hi: number } | null {
  if (raw === undefined || raw.trim() === "") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(raw);
  const lo = m ? Number(m[1]) : NaN;
  const hi = m ? Number(m[2]) : NaN;
  if (!(lo >= 0 && lo <= hi && hi <= 100)) throw new Error(`RAFT_BALANCE_BAND must be "lo-hi" in win % (e.g. 55-75), got "${raw}"`);
  return { lo, hi };
}

const env = process.env;
const enabled = !!env.RAFT_BALANCE;
const seeds = Number(env.RAFT_BALANCE_SEEDS ?? 6);
const bossHelp = Number(env.RAFT_BALANCE_BOSS_HELP ?? 0);
const scenario: Scenario = {
  difficulty: (env.RAFT_BALANCE_DIFFICULTY ?? "normal") as Difficulty,
  bots: Number(env.RAFT_BALANCE_BOTS ?? 3),
  idle: Number(env.RAFT_BALANCE_IDLE_HUMANS ?? 0),
  fast: !!env.RAFT_BALANCE_FAST && env.RAFT_BALANCE_FAST !== "0",
};
/** Generous per-match budget (a loaded CI runner can be several times slower than the ~0.7 s / ~0.15 s here). */
const timeoutMs = 30_000 + seeds * (scenario.fast ? 2_000 : 10_000);

describe("bot balance harness", () => {
  it.skipIf(!enabled)("plays bot-only matches, prints the outcome and holds the target scenario to RAFT_BALANCE_BAND", { timeout: timeoutMs }, () => {
    const band = parseBand(env.RAFT_BALANCE_BAND);
    if (band && !isTarget(scenario)) {
      throw new Error(`RAFT_BALANCE_BAND is the win band of the target scenario (${scenarioName(TARGET)}); this run is ${scenarioName(scenario)}`);
    }
    const { bots, difficulty, fast, idle } = scenario;
    const started = performance.now();
    const reports: MatchReport[] = [];
    for (let i = 0; i < seeds; i++) {
      const seed = env.RAFT_BALANCE_SEED ? Number(env.RAFT_BALANCE_SEED) + i : 1000 + i * 7919;
      const r = runMatch(seed, bots, difficulty, fast, idle, bossHelp);
      reports.push(r);
      const top = Object.entries(r.goals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, n]) => `${k} ${Math.round((100 * n) / Math.max(1, r.seconds * TICK_RATE * bots))}%`)
        .join(", ");
      const rej = Object.entries(r.rejects)
        .map(([k, n]) => `${k}×${n}`)
        .join(" ");
      out(
        `seed ${r.seed} ${r.biome.padEnd(8)} ${r.outcome.padEnd(8)} t=${r.seconds}s stage ${r.stage} | ${r.raft} | delivered ${r.delivered} downs ${r.downs} kills ${r.kills} fish ${r.fish} crafted ${r.crafted} | spawns ${r.spawns} throws ${r.throws} hits ${r.hits} hurt ${r.hurt} gnawed ${r.gnawed} lost ${r.stagesLost} | boss ${r.bossSpawns}× hurt ${r.bossHurt} down ${r.bossDownDay ? `day ${r.bossDownDay}` : "-"}\n   goals: ${top}\n   rejects: ${rej || "-"}`,
      );
    }
    const wins = reports.filter((r) => r.outcome === "launched").length;
    const pct = (100 * wins) / Math.max(1, reports.length);
    const secs = (performance.now() - started) / 1000;
    const verdict = band ? `band ${band.lo}–${band.hi} %` : "no band: report only";
    out(`${wins}/${reports.length} launched = ${pct.toFixed(0)} % (${scenarioName(scenario)}) in ${secs.toFixed(1)} s; ${verdict}`);
    expect(reports.length).toBe(seeds);
    if (band) {
      expect(pct, `win % of the target scenario (${scenarioName(TARGET)})`).toBeGreaterThanOrEqual(band.lo);
      expect(pct, `win % of the target scenario (${scenarioName(TARGET)})`).toBeLessThanOrEqual(band.hi);
    }
  });

  it("reads the band and knows its target scenario", () => {
    expect(parseBand(undefined)).toBeNull();
    expect(parseBand("")).toBeNull();
    expect(parseBand("55-75")).toEqual({ lo: 55, hi: 75 });
    expect(parseBand(" 0 - 100 ")).toEqual({ lo: 0, hi: 100 });
    for (const bad of ["75-55", "55", "55-175", "a-b", "-5-10"]) expect(() => parseBand(bad), bad).toThrow(/RAFT_BALANCE_BAND/);
    expect(isTarget({ ...TARGET })).toBe(true);
    expect(isTarget({ ...TARGET, fast: true })).toBe(false);
    expect(isTarget({ ...TARGET, idle: 1, bots: 2 })).toBe(false);
    expect(isTarget({ ...TARGET, difficulty: "nightmare" })).toBe(false);
  });
});
