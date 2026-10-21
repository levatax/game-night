// Pure end-of-match scoring for RaftRoom (game4.md §21, ARCHITECTURE §2.6). Owner: server-room.
//
// RaftWorld keeps each player's MVP points (player.score, MVP_POINTS) and stats during the match; at matchEnd
// the room ranks them, hands out the honor / shame titles and computes the team score:
//   standings: score desc → delivered desc → lower seat (every place unique)
//   titles (at most one holder each, ties → the better place; shame "tourist" → the worse place):
//     mvp           place 1 with score > 0
//     crabSlayer    most kills (≥ 1)            "Yengeç Katili"
//     fishLord      most fish caught (≥ 1)      "Balıkçı Reis"
//     porter        most delivered (≥ 1)        "Hamal"
//     hero          most revives (≥ 1)          "Kahraman"
//     tourist       least gathered (≥ 2 players and somebody gathered more)  "Turist"
//     victim        most downs (≥ 1)            "Kurban"
//     coconutAddict most eaten (≥ 1; ties → more coconuts)  "Hindistan Cevizi Bağımlısı"
//   team score: Σ the team's MVP points, plus on a launch LAUNCH_BONUS + LAUNCH_BONUS_PER_SEC × whole seconds
//   that were left before the storm (an early launch scores higher). Clamped to the uint16 schema field.

import { LAUNCH_BONUS, LAUNCH_BONUS_PER_SEC, TICK_RATE, TITLE_IDS } from "../../shared/constants.js";
import type { StandingEntry } from "../../shared/protocol.js";
import type { StatsView, TitleId } from "../../shared/types.js";

/** team.score is a uint16. */
export const MAX_TEAM_SCORE = 0xffff;

/** One match participant as scoring sees it (copied out of PlayerState). */
export interface ScoreInput {
  id: string;
  seat: number;
  team: number;
  /** MVP points (player.score). */
  score: number;
  stats: StatsView;
  /** Sailed away on the raft. */
  aboard: boolean;
}

export interface MatchResult {
  /** Sorted by place. */
  standings: StandingEntry[];
  /** Place 1 when they scored anything, else "". */
  mvpId: string;
  /** Indexed by team. */
  teamScores: number[];
}

/** Order: score, then delivered (both descending), then the lower seat. */
export function compareStanding(a: ScoreInput, b: ScoreInput): number {
  return b.score - a.score || b.stats.delivered - a.stats.delivered || a.seat - b.seat;
}

/** Copy of a stats object (the schema instance must not leak into a message). */
export function copyStats(s: StatsView): StatsView {
  return {
    gathered: s.gathered,
    delivered: s.delivered,
    hits: s.hits,
    kills: s.kills,
    revives: s.revives,
    fish: s.fish,
    eaten: s.eaten,
    coconuts: s.coconuts,
    downs: s.downs,
    crafted: s.crafted,
    raids: s.raids,
  };
}

/** The best-ranked holder of the highest `value` (≥ min), or null. `ranked` is in place order. */
function topBy(ranked: readonly ScoreInput[], value: (p: ScoreInput) => number, min: number): ScoreInput | null {
  let best: ScoreInput | null = null;
  let bestValue = min - 1;
  for (const p of ranked) {
    const v = value(p);
    if (v > bestValue) {
      best = p;
      bestValue = v;
    }
  }
  return best && bestValue >= min ? best : null;
}

/**
 * Titles per player id (in TITLE_IDS order). `ranked` must already be in place order (rankPlayers).
 * A player may hold several titles; some titles may go to nobody.
 */
export function awardTitles(ranked: readonly ScoreInput[]): Map<string, TitleId[]> {
  const won = new Map<string, Set<TitleId>>();
  const give = (p: ScoreInput | null, title: TitleId) => {
    if (!p) return;
    const set = won.get(p.id) ?? new Set<TitleId>();
    set.add(title);
    won.set(p.id, set);
  };

  const first = ranked[0];
  if (first && first.score > 0) give(first, "mvp");
  give(topBy(ranked, (p) => p.stats.kills, 1), "crabSlayer");
  give(topBy(ranked, (p) => p.stats.fish, 1), "fishLord");
  give(topBy(ranked, (p) => p.stats.delivered, 1), "porter");
  give(topBy(ranked, (p) => p.stats.revives, 1), "hero");
  give(topBy(ranked, (p) => p.stats.downs, 1), "victim");
  // Eaten first, coconuts break ties (scaled so they never outweigh one more meal).
  give(topBy(ranked, (p) => p.stats.eaten * 1000 + Math.min(999, p.stats.coconuts), 1000), "coconutAddict");

  if (ranked.length >= 2) {
    let most = -Infinity;
    for (const p of ranked) most = Math.max(most, p.stats.gathered);
    // Shame title: the least gathered, ties → the worse place (walk the ranking backwards).
    let tourist: ScoreInput | null = null;
    for (let i = ranked.length - 1; i >= 0; i--) {
      const p = ranked[i]!;
      if (!tourist || p.stats.gathered < tourist.stats.gathered) tourist = p;
    }
    if (tourist && tourist.stats.gathered < most) give(tourist, "tourist");
  }

  const out = new Map<string, TitleId[]>();
  for (const p of ranked) {
    const set = won.get(p.id);
    out.set(p.id, set ? TITLE_IDS.filter((t) => set.has(t)) : []);
  }
  return out;
}

/** Participants in place order. */
export function rankPlayers(players: readonly ScoreInput[]): ScoreInput[] {
  return [...players].sort(compareStanding);
}

/** Final standings with places 1..n and titles. */
export function rankStandings(players: readonly ScoreInput[]): StandingEntry[] {
  const ranked = rankPlayers(players);
  const titles = awardTitles(ranked);
  return ranked.map((p, i) => ({
    id: p.id,
    place: i + 1,
    score: p.score,
    team: p.team,
    titles: titles.get(p.id) ?? [],
    stats: copyStats(p.stats),
    aboard: p.aboard,
  }));
}

/** Launch bonus for `ticksLeft` ticks that were left before the storm (0 when the team didn't launch). */
export function launchBonus(launched: boolean, ticksLeft: number): number {
  if (!launched) return 0;
  return LAUNCH_BONUS + LAUNCH_BONUS_PER_SEC * Math.floor(Math.max(0, ticksLeft) / TICK_RATE);
}

/** Σ MVP points of the team + the launch bonus, clamped to the schema field. */
export function teamScore(players: readonly ScoreInput[], team: number, launched: boolean, ticksLeft: number): number {
  let sum = 0;
  for (const p of players) if (p.team === team) sum += Math.max(0, p.score);
  sum += launchBonus(launched, ticksLeft);
  return Math.max(0, Math.min(MAX_TEAM_SCORE, Math.round(sum)));
}

/**
 * Score a finished match. `teams` = number of teams (coop 1); `winnerTeam` -1 = the storm won; `ticksLeft` =
 * ticks that were left before the storm at the launch (ignored on a loss).
 */
export function scoreMatch(players: readonly ScoreInput[], teams: number, winnerTeam: number, ticksLeft: number): MatchResult {
  const standings = rankStandings(players);
  const first = standings[0];
  const teamScores: number[] = [];
  for (let t = 0; t < Math.max(1, teams); t++) teamScores.push(teamScore(players, t, winnerTeam === t, ticksLeft));
  return { standings, mvpId: first && first.score > 0 ? first.id : "", teamScores };
}
