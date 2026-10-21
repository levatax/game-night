// Test-only create options for RaftRoom. Owner: server-room.
// Only honored when the server runs with process.env.RAFT_TEST === "1" (server/RaftRoom.test.ts) and NOT with
// NODE_ENV=production, so a real client can never shorten the timers, seed the rngs or warp the sim (register()
// in server/index.ts complains loudly when the flag is set in production, see testFlagWarning):
// - fast: true        → FAST_TIMINGS (day 4 s, bars ×20, raft costs 1) — CreateOptions.fast
// - testSeed: n       → every rng (preview seeds, gameplay, bots, notice variants) derives from n — CreateOptions.testSeed
// - warp: k           → with fast, the room simulates k ticks per 1/30 s of real time (1..8); bot-only matches in
//                       tests finish k× sooner. Humans' 30 Hz inputs would starve, so only bot tests use it.
// - manualClock: true → the room runs no simulation interval: room time (fixed ticks and the room's own dispose
//                       timers) only moves when a test calls RaftRoom.advance(ms) on the instance
//                       (matchMaker.getLocalRoomById). Messages, patches and pings still flow in real time.

import { readField } from "./lobby.js";

export interface TestKnobs {
  /** FAST_TIMINGS. */
  fast: boolean;
  /** Seed for every room rng; null = crypto-random per match. */
  testSeed: number | null;
  /** Simulated ticks per real tick (1 = real time). */
  warp: number;
  /** Room time only moves through RaftRoom.advance (deterministic room tests). */
  manualClock: boolean;
}

export const NO_KNOBS: Readonly<TestKnobs> = { fast: false, testSeed: null, warp: 1, manualClock: false };

export const MAX_WARP = 8;

/** The environment variables that decide whether the knobs are honored. */
export interface KnobEnv {
  RAFT_TEST?: string;
  NODE_ENV?: string;
  /** Set by vitest in its workers. */
  VITEST?: string;
}

/** Read the knobs from the create options (`env` defaults to process.env): NO_KNOBS unless a non-production RAFT_TEST=1. */
export function readKnobs(options: unknown, env: KnobEnv = process.env): TestKnobs {
  if (env.RAFT_TEST !== "1" || env.NODE_ENV === "production") return { ...NO_KNOBS };
  const fast = readField(options, "fast") === true;
  const rawSeed = readField(options, "testSeed");
  const testSeed = typeof rawSeed === "number" && Number.isFinite(rawSeed) ? Math.floor(Math.abs(rawSeed)) >>> 0 : null;
  const rawWarp = readField(options, "warp");
  const warp = fast && typeof rawWarp === "number" && Number.isInteger(rawWarp) ? Math.max(1, Math.min(MAX_WARP, rawWarp)) : 1;
  const manualClock = readField(options, "manualClock") === true;
  return { fast, testSeed, warp, manualClock };
}

/**
 * What register() should say about RAFT_TEST at startup: an error when it is set in production (ignored there,
 * but somebody deployed it), a warning when it is set outside a test runner (any client may then shorten timers,
 * seed the rngs and warp the sim), else nothing.
 */
export function testFlagWarning(env: KnobEnv = process.env): { level: "error" | "warn"; message: string } | null {
  if (env.RAFT_TEST !== "1") return null;
  if (env.NODE_ENV === "production") {
    return {
      level: "error",
      message: "[raft-rush] RAFT_TEST=1 is set with NODE_ENV=production: IGNORED (test knobs stay off). Remove it from the deployment.",
    };
  }
  if (env.VITEST !== undefined || env.NODE_ENV === "test") return null;
  return {
    level: "warn",
    message: "[raft-rush] RAFT_TEST=1: any client may request fast timers, a fixed testSeed, warp and a manual clock. Never expose this server.",
  };
}
