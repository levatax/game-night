// Test-only create options for KasalaRoom. Owner: server.
// Only honored with process.env.KASALA_TEST === "1" (server/KasalaRoom.test.ts), so a real client can never seed
// the rng or stack the deck. `seed` needs the test env; the rest also needs { fast: true }.

import { CARD_BY_ID, WHEEL_SLICE_BY_ID } from "../../shared/constants.js";
import type { CardId, WheelSliceId } from "../../shared/constants.js";

export interface TestKnobs {
  /** Fixed rng seed (re-derived per match). */
  seed: number | null;
  /** Forced flip results, consumed in order (then the seeded rng takes over). */
  cards: CardId[];
  /** Forced wheel slices, consumed in order. */
  wheel: WheelSliceId[];
  /** Starting kasa override. */
  startKasa: number | null;
  /** Total rounds override (both modes). */
  rounds: number | null;
}

export const NO_KNOBS: TestKnobs = { seed: null, cards: [], wheel: [], startKasa: null, rounds: null };

function intIn(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

export function readKnobs(opts: Record<string, unknown>, testEnv: boolean, fast: boolean): TestKnobs {
  if (!testEnv) return { ...NO_KNOBS, cards: [], wheel: [] };
  const seed = typeof opts.seed === "number" && Number.isFinite(opts.seed) ? Math.floor(Math.abs(opts.seed)) >>> 0 : null;
  if (!fast) return { ...NO_KNOBS, seed, cards: [], wheel: [] };
  const cards = Array.isArray(opts.cards) ? opts.cards.filter((c): c is CardId => typeof c === "string" && c in CARD_BY_ID) : [];
  const wheel = Array.isArray(opts.wheel) ? opts.wheel.filter((w): w is WheelSliceId => typeof w === "string" && w in WHEEL_SLICE_BY_ID) : [];
  return { seed, cards, wheel, startKasa: intIn(opts.startKasa, 0, 100_000), rounds: intIn(opts.rounds, 1, 30) };
}
