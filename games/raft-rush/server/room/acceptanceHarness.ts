// Acceptance harness for Raft Rush (owner: devops): the real RaftWorld played headlessly, one match per call,
// with the numbers the staging gates need (outcome, launch second, downs, tick cost).
//
// This is deliberately separate from botBalance.test.ts: that file measures balance (win-rate bands); this one
// measures the four staging acceptance gates and server cost. Same world, same bot desk, no rule changes.

import { BOT_NAMES, BOT_ROLES, CHARACTER_IDS, TICK_RATE, timingsFor } from "../../shared/constants.js";
import { generateIsland } from "../../shared/island/generate.js";
import { mulberry32 } from "../../shared/island/noise.js";
import { clockAt, inputLocked, matchTicks, type ClockInfo } from "../../shared/rules/schedule.js";
import type { Difficulty } from "../../shared/types.js";
import { PlayerState, RaftState } from "../schema.js";
import { RaftWorld } from "../world/World.js";
import { BotDesk, type BotHost } from "./bots.js";

export interface AcceptanceRun {
  seed: number;
  attempt: number;
  biome: string;
  outcome: "launched" | "storm" | "wiped" | "timeout";
  /** Seconds of the playing clock when the match ended. */
  seconds: number;
  downs: number;
  stage: number;
  /** Simulated server tick cost of this match: total and worst single tick, in ms. */
  tickMs: number;
  maxTickMs: number;
}

export interface RunOptions {
  bots: number;
  difficulty?: Difficulty;
  fast?: boolean;
  idleHumans?: number;
  /** Re-seeds the match rngs so a second attempt on the same island is a different match. */
  attempt?: number;
}

export function runAcceptanceMatch(seed: number, opts: RunOptions): AcceptanceRun {
  const { bots, difficulty = "normal", fast = false, idleHumans = 0, attempt = 0 } = opts;
  const timings = timingsFor(fast);
  const state = new RaftState();
  const island = generateIsland(seed, "solo");
  const salt = Math.imul(attempt, 0x9e3779b1);
  const world = new RaftWorld(state, island, { fast, difficulty, rng: mulberry32((seed ^ 0x51ed) ^ salt) });
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
    rng: mulberry32((seed ^ 0xb075) ^ salt),
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

  const run: AcceptanceRun = {
    seed,
    attempt,
    biome: island.biome,
    outcome: "timeout",
    seconds: 0,
    downs: 0,
    stage: 0,
    tickMs: 0,
    maxTickMs: 0,
  };
  const limit = timings.landing + matchTicks(timings) + 60;
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
        run.outcome = "storm";
        break;
      }
    }
    desk.tick();
    const t0 = performance.now();
    const events = world.step({ locked: inputLocked(state.phase, state.phaseTicksLeft, timings), clock: state.phase === "playing" ? clock : null });
    const dt = performance.now() - t0;
    run.tickMs += dt;
    if (dt > run.maxTickMs) run.maxTickMs = dt;
    let done = false;
    for (const ev of events) {
      if (ev.type === "launchRequest") {
        run.outcome = "launched";
        done = true;
      } else if (ev.type === "teamWiped") {
        run.outcome = "wiped";
        done = true;
      } else if (ev.type === "playerDowned") run.downs++;
    }
    if (done) break;
  }
  run.seconds = Math.round(state.clockTicks / TICK_RATE);
  run.stage = state.teams[0]!.stage;
  return run;
}

/** Wilson score 95 % interval for a binomial proportion (wins / n). */
export function wilson(wins: number, n: number): { lo: number; hi: number; pct: number } {
  if (n === 0) return { lo: 0, hi: 100, pct: 0 };
  const z = 1.959963984540054;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z / d) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: 100 * Math.max(0, centre - half), hi: 100 * Math.min(1, centre + half), pct: 100 * p };
}

/**
 * Cluster-corrected interval: runs on one island share the island's layout, so they are not independent
 * observations. With `m` runs per island and an intra-cluster correlation rho, the variance of the mean grows by
 * the design effect 1 + (m - 1) * rho. At rho = 0.1 and m = 3 that is 1.2: ~17 % fewer effective runs.
 */
export function clusteredHalfWidth(halfWidth: number, m: number, rho = 0.1): number {
  return halfWidth * Math.sqrt(1 + (m - 1) * rho);
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
