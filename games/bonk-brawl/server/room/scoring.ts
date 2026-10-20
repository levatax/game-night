// Pure scoring rules: points per event, crown, standings with tiebreaks, stalemate winner.

import { POINTS } from "../../shared/constants.js";
import type { StandingEntry } from "../../shared/protocol.js";
import type { StatsView } from "../../shared/types.js";
import type { GameEvent } from "../world/events.js";

/** schema field caps */
const MAX_POINTS = 0xffff;
const MAX_ROUND_POINTS = 0xff;
const MAX_STAT = 0xffff;

/** The scoring fields of a player (PlayerState satisfies it). */
export interface Scorable {
  points: number;
  roundPoints: number;
  stats: StatsView;
}

export function awardPoints(p: Scorable, amount: number): void {
  p.points = Math.min(MAX_POINTS, p.points + amount);
  p.roundPoints = Math.min(MAX_ROUND_POINTS, p.roundPoints + amount);
}

function bumpStat(p: Scorable, key: keyof StatsView, by = 1): void {
  p.stats[key] = Math.min(MAX_STAT, p.stats[key] + by);
}

/**
 * Apply one world event's scoring: throw → throws += balls; hit → thrower +1 / hits; catch →
 * catcher +2 / catches; ringOut with credit → +2 / ringOuts; ko by someone else → kos.
 * Unknown players (already left) are skipped.
 */
export function scoreEvent(ev: GameEvent, find: (id: string) => Scorable | undefined): void {
  switch (ev.type) {
    case "throw": {
      const p = find(ev.ownerId);
      if (p) bumpStat(p, "throws", ev.ballIds.length);
      return;
    }
    case "hit": {
      const p = ev.throwerId !== ev.targetId ? find(ev.throwerId) : undefined;
      if (!p) return;
      awardPoints(p, POINTS.hit);
      bumpStat(p, "hits");
      return;
    }
    case "catch": {
      const p = find(ev.catcherId);
      if (!p) return;
      awardPoints(p, POINTS.catch);
      bumpStat(p, "catches");
      return;
    }
    case "ringOut": {
      const p = ev.creditId && ev.creditId !== ev.playerId ? find(ev.creditId) : undefined;
      if (!p) return;
      awardPoints(p, POINTS.ringOut);
      bumpStat(p, "ringOuts");
      return;
    }
    case "ko": {
      const p = ev.byId && ev.byId !== ev.playerId ? find(ev.byId) : undefined;
      if (p) bumpStat(p, "kos");
      return;
    }
    default:
      return;
  }
}

/** Round win: +3 and a round win stat. */
export function awardRoundWin(p: Scorable): void {
  awardPoints(p, POINTS.roundWin);
  bumpStat(p, "roundWins");
}

/** The unique player with the most points (> 0), else "". */
export function crownLeader(players: Iterable<{ id: string; points: number }>): string {
  let leader = "";
  let best = 0;
  let tied = false;
  for (const p of players) {
    if (p.points > best) {
      leader = p.id;
      best = p.points;
      tied = false;
    } else if (p.points === best && best > 0) {
      tied = true;
    }
  }
  return tied ? "" : leader;
}

export interface StandingInput {
  id: string;
  slot: number;
  points: number;
  stats: Pick<StatsView, "roundWins" | "catches">;
}

/** Order: points, then round wins, then catches (all descending), then the lower slot. */
export function compareStanding(a: StandingInput, b: StandingInput): number {
  return (
    b.points - a.points ||
    b.stats.roundWins - a.stats.roundWins ||
    b.stats.catches - a.stats.catches ||
    a.slot - b.slot
  );
}

/** Final standings with places 1..n (ties fully broken, so every place is unique). */
export function rankStandings(players: readonly StandingInput[]): StandingEntry[] {
  return [...players].sort(compareStanding).map((p, i) => ({
    id: p.id,
    place: i + 1,
    points: p.points,
    roundWins: p.stats.roundWins,
    catches: p.stats.catches,
  }));
}

/** Stalemate: the alive player with the most hearts wins; a tie for the most → "" (no winner). */
export function stalemateWinner(alive: ReadonlyArray<{ id: string; hearts: number }>): string {
  let winner = "";
  let best = -1;
  let tied = false;
  for (const p of alive) {
    if (p.hearts > best) {
      winner = p.id;
      best = p.hearts;
      tied = false;
    } else if (p.hearts === best) {
      tied = true;
    }
  }
  return tied ? "" : winner;
}
