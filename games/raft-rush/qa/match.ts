// One match run on the real RaftWorld + BotDesk, with the room's phase loop reproduced (the same approach as
// server/room/botBalance.test.ts). Owner: qa. This file adds measurement only; it does not change game logic.
//
// Use it from qa/batch.ts and qa/gate.ts. A run is fully deterministic for (seed, scenario).

import {
  BOT_NAMES,
  BOT_ROLES,
  CHARACTER_IDS,
  LAUNCH_BONUS,
  LAUNCH_BONUS_PER_SEC,
  TICK_RATE,
  timingsFor,
} from "../shared/constants.js";
import { generateIsland } from "../shared/island/generate.js";
import { mulberry32 } from "../shared/island/noise.js";
import { clockAt, inputLocked, matchTicks, type ClockInfo } from "../shared/rules/schedule.js";
import type { Difficulty } from "../shared/types.js";
import { PlayerState, RaftState } from "../server/schema.js";
import { RaftWorld } from "../server/world/World.js";
import { BotDesk, type BotHost } from "../server/room/bots.js";
import type { RunRow } from "./telemetry.js";

export interface Scenario {
  bots: number;
  idleHumans: number;
  difficulty: Difficulty;
  /** fast = RAFT_TEST timers (smoke only; never for the timing gate). */
  fast: boolean;
}

export interface RunResult {
  row: RunRow;
  /** Diagnostics that are not part of the CSV schema. */
  debug: {
    outcome: string;
    rejects: Record<string, number>;
    goals: Record<string, number>;
    spawned: number;
    kills: number;
    crafted: number;
    throws: number;
  };
}

const STARVE_CAUSES = new Set(["hunger", "thirst", "cold"]);

function groupEndReason(outcome: string, downs: Array<{ cause: string }>): RunRow["end_reason"] {
  if (outcome === "launched") return "launched";
  if (outcome === "storm") return "storm";
  if (outcome === "timeout") return "timeout";
  const causes = downs.map((d) => d.cause);
  if (causes.includes("boss")) return "boss";
  const counts = new Map<string, number>();
  for (const c of causes) counts.set(c, (counts.get(c) ?? 0) + 1);
  const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  return STARVE_CAUSES.has(modal) ? "starve" : "death";
}

/** Play one match; returns the telemetry row (one row per run). */
export function runOne(seed: number, scenario: Scenario, runIndex = 0, runIdPrefix = "run"): RunResult {
  const { bots, idleHumans, difficulty, fast } = scenario;
  const timings = timingsFor(fast);
  const state = new RaftState();
  const island = generateIsland(seed, "solo");
  const world = new RaftWorld(state, island, { fast, difficulty, rng: mulberry32(seed ^ 0x51ed) });
  state.fast = fast;
  state.difficulty = difficulty;
  state.settings.difficulty = difficulty;

  const ids: string[] = [];
  const botIds = new Set<string>();
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
    botIds.add(p.id);
  }
  // Humans who joined and never touched the keyboard (the worst-case solo partner).
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
  const focalId = idleHumans > 0 ? "human-1" : ids[0]!;
  const focalIsHuman = idleHumans > 0;

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

  let outcome = "timeout";
  let playingStart = -1;
  let secondsLeft: number | null = null;
  let focalFirstDown: { cause: string; x: number; y: number; z: number } | null = null;
  const allDowns: Array<{ id: string; cause: string; t: number }> = [];
  let focalRevives = 0;
  let teamRevived = 0;
  let fireOut = 0;
  let woodToFire = 0;
  let firstFishTick: number | null = null;
  let botDelivered = 0;
  let totalDelivered = 0;
  let focalBoardLeft: boolean | null = null;
  let raftReadyTick: number | null = null;
  let departureTick: number | null = null;
  const rejects: Record<string, number> = {};
  const goals: Record<string, number> = {};
  let spawned = 0;
  let bossSpawned = false;
  let kills = 0;
  let crafted = 0;
  let throws = 0;

  const limit = timings.landing + matchTicks(timings) + 60;
  for (let t = 0; t < limit; t++) {
    state.tick++;
    let clock: ClockInfo | null = null;
    if (state.phase === "landing") {
      if (state.phaseTicksLeft > 0) state.phaseTicksLeft--;
      if (state.phaseTicksLeft === 0) {
        state.phase = "playing";
        state.clockTicks = 0;
        playingStart = state.tick;
        clock = clockAt(0, timings);
      }
    } else {
      state.clockTicks++;
      clock = clockAt(state.clockTicks, timings);
      state.day = clock.day;
      state.dayPhase = clock.dayPhase;
      state.phaseTicksLeft = clock.phaseLeft;
      if (clock.over) {
        outcome = "storm";
        break;
      }
    }
    desk.tick();
    for (let k = 0; k < bots; k++) {
      const key = desk.goalOf(ids[k]!);
      const g = key.split(":")[0] || "-";
      goals[g] = (goals[g] ?? 0) + 1;
    }

    const events = world.step({
      locked: inputLocked(state.phase, state.phaseTicksLeft, timings),
      clock: state.phase === "playing" ? clock : null,
    });

    let done = false;
    for (const ev of events) {
      switch (ev.type) {
        case "launchRequest": {
          outcome = "launched";
          secondsLeft = Math.max(0, Math.round((matchTicks(timings) - state.clockTicks) / TICK_RATE));
          focalBoardLeft = ev.left.includes(focalId);
          if (departureTick === null) departureTick = state.tick;
          done = true;
          break;
        }
        case "raftReady":
          if (raftReadyTick === null) raftReadyTick = state.tick;
          break;
        case "teamWiped":
          outcome = "wiped";
          done = true;
          break;
        case "reject":
          rejects[`${ev.action}:${ev.reason}`] = (rejects[`${ev.action}:${ev.reason}`] ?? 0) + 1;
          break;
        case "playerDowned": {
          const rel = playingStart >= 0 ? (state.tick - playingStart) / TICK_RATE : 0;
          allDowns.push({ id: ev.playerId, cause: ev.cause, t: rel });
          if (ev.playerId === focalId && !focalFirstDown) {
            focalFirstDown = { cause: ev.cause, x: ev.pos.x, y: ev.pos.y, z: ev.pos.z };
          }
          break;
        }
        case "playerRevived":
          teamRevived++;
          if (ev.playerId === focalId) focalRevives++;
          break;
        case "fireFuel":
          if (ev.source === "out") fireOut++;
          else if ((ev.source === "wood" || ev.source === "throw") && ev.added > 0) woodToFire++;
          break;
        case "fishResult":
          if (firstFishTick === null) firstFishTick = state.tick;
          break;
        case "deliver": {
          totalDelivered += ev.items.reduce((a, it) => a + it.count, 0);
          if (botIds.has(ev.playerId)) botDelivered += ev.items.reduce((a, it) => a + it.count, 0);
          break;
        }
        case "crafted":
          crafted++;
          break;
        case "monsterSpawn":
          spawned++;
          if (ev.kind === "boss") bossSpawned = true;
          break;
        case "monsterDie":
          if (!ev.fled) kills++;
          break;
        case "throw":
          if (!ev.toss) throws++;
          break;
        default:
          break;
      }
    }
    // A stage can reach 3 through a path that emitted no raftReady (e.g. sail + hull in one refresh).
    if (raftReadyTick === null && state.teams[0]?.stage === 3) raftReadyTick = state.tick;
    if (done) break;
  }

  const team = state.teams[0]!;
  const focal = state.players.get(focalId)!;
  let teamDowns = 0;
  state.players.forEach((p) => (teamDowns += p.stats.downs));
  const seconds = Math.round(state.clockTicks / TICK_RATE);
  let playerScore = 0;
  state.players.forEach((p) => (playerScore += p.score));
  const teamScore =
    outcome === "launched" && secondsLeft !== null
      ? playerScore + LAUNCH_BONUS + LAUNCH_BONUS_PER_SEC * secondsLeft
      : null;

  const row: RunRow = {
    run_id: `${runIdPrefix}-${String(runIndex + 1).padStart(3, "0")}`,
    seed,
    match_seconds: seconds,
    player_id: focalId,
    run_index: runIndex,
    players: ids.length,
    bot_count: bots,
    outcome:
      outcome === "launched" ? "win" : outcome === "wiped" ? "wipe" : outcome === "storm" ? "loss" : "timeout",
    end_reason: groupEndReason(outcome, allDowns),
    death_cause: focalFirstDown?.cause ?? "none",
    death_x: focalFirstDown ? round2(focalFirstDown.x) : null,
    death_y: focalFirstDown ? round2(focalFirstDown.z) : null,
    fire_out_count: fireOut,
    wood_to_fire: woodToFire,
    time_to_first_fish: firstFishTick !== null && playingStart >= 0 ? round1((firstFishTick - playingStart) / TICK_RATE) : null,
    first_input_s: null,
    first_meaningful_choice_s: null,
    bot_delivery_share: totalDelivered > 0 ? round3(botDelivered / totalDelivered) : 0,
    downed_count: teamDowns,
    revive_count: teamRevived,
    raft_ready_s: playingStart >= 0 && raftReadyTick !== null ? round1((raftReadyTick - playingStart) / TICK_RATE) : null,
    departure_s: playingStart >= 0 && departureTick !== null ? round1((departureTick - playingStart) / TICK_RATE) : null,
    biome: island.biome,
    difficulty,
    humans: idleHumans,
    player_kind: focalIsHuman ? "human" : "bot",
    seconds_left: secondsLeft,
    team_score: teamScore,
    stage: team.stage,
    fire_fuel_end: Math.round(team.fireFuel / TICK_RATE),
    delivered_total: totalDelivered,
    team_downed: teamDowns,
    team_revived: teamRevived,
    focal_downed: focal.stats.downs,
    focal_washed: focal.washed ? 1 : 0,
    focal_boarded: outcome === "launched" ? (focalBoardLeft ? 0 : 1) : 0,
    focal_points: focal.score,
    death_height: focalFirstDown ? round2(focalFirstDown.y) : null,
    first_choice_source: "",
    boss_spawn: bossSpawned ? 1 : 0,
  };

  return {
    row,
    debug: { outcome, rejects, goals, spawned, kills, crafted, throws },
  };
}

export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Default seed sequence (same spacing as the established balance harness). */
export function seedAt(base: number, i: number): number {
  return base + i * 7919;
}
