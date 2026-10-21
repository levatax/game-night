// Random streams of a RaftRoom (ARCHITECTURE §4.2). Owner: server-room.
//
// Per match: a gameplay rng (RaftWorld: loot, weather, spawns, starter items) and a SEPARATE bot rng (BotDesk:
// think delays, picks, aim noise), both mulberry32 streams, so bot decisions never shift loot. They derive from
// RAFT_TEST's testSeed (deterministic tests) or a crypto-random seed. Lobby preview seeds and notice variants use
// their own streams too. Never Math.random.

import { randomBytes } from "node:crypto";
import { hash2, mulberry32, subSeed } from "../../shared/island/noise.js";

export type Rng = () => number;

/** Random lobby preview seeds are short (easy to read out and type back: "4471"). Hosts may type any uint32. */
export const PREVIEW_SEED_MAX = 99_999;

/** A crypto-random uint32. */
export function randomSeed(): number {
  return randomBytes(4).readUInt32LE(0) >>> 0;
}

/** Seed for stream `salt` of match / preview number `n`: from the test seed, or crypto-random. */
function streamSeed(testSeed: number | null, n: number, salt: number): number {
  return testSeed === null ? randomSeed() : hash2(n, salt, testSeed);
}

export interface MatchRngs {
  /** Seed both streams came from (logged with errors). */
  seed: number;
  gameplay: Rng;
  bot: Rng;
}

/** The two independent streams of match number `matchNo` (1, 2, …). */
export function matchRngs(testSeed: number | null, matchNo: number): MatchRngs {
  const seed = streamSeed(testSeed, matchNo, 0x6d61);
  return { seed, gameplay: mulberry32(subSeed(seed, 1)), bot: mulberry32(subSeed(seed, 2)) };
}

/** A random lobby preview seed in 1..PREVIEW_SEED_MAX (never 0: 0 means "random" in the settings). */
export function previewSeed(testSeed: number | null, previewNo: number): number {
  return (streamSeed(testSeed, previewNo, 0x7076) % PREVIEW_SEED_MAX) + 1;
}

/** The room's cosmetic stream (notice variants). */
export function textRng(testSeed: number | null): Rng {
  return mulberry32(streamSeed(testSeed, 0, 0x7478));
}
