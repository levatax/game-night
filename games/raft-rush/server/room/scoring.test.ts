// Unit tests for the end-of-match scoring (standings, titles, MVP, team score). Owner: server-room.
import { describe, expect, it } from "vitest";
import { LAUNCH_BONUS, LEFT_BEHIND_PENALTY, LOSS_STAGE_BONUS, WIN_BOSS_BONUS, WIN_RAFT_HP_BONUS, WIN_SURVIVOR_BONUS } from "../../shared/constants.js";
import type { StatsView } from "../../shared/types.js";
import { awardTitles, outcomeBonus, rankPlayers, rankStandings, scoreMatch, teamScore, type ScoreInput, type TeamOutcome } from "./scoring.js";

const zero: StatsView = { gathered: 0, delivered: 0, hits: 0, kills: 0, revives: 0, fish: 0, eaten: 0, coconuts: 0, downs: 0, crafted: 0, raids: 0 };
const player = (id: string, seat: number, score: number, stats: Partial<StatsView> = {}, aboard = false): ScoreInput => ({
  id,
  seat,
  team: 0,
  score,
  stats: { ...zero, ...stats },
  aboard,
});

describe("standings", () => {
  it("rank by score, then delivered, then the lower seat; places are unique", () => {
    const st = rankStandings([
      player("a", 0, 10, { delivered: 1 }),
      player("b", 1, 30),
      player("c", 2, 10, { delivered: 4 }),
      player("d", 3, 10, { delivered: 1 }),
    ]);
    expect(st.map((s) => s.id)).toEqual(["b", "c", "a", "d"]);
    expect(st.map((s) => s.place)).toEqual([1, 2, 3, 4]);
  });

  it("stats are copied, not shared", () => {
    const p = player("a", 0, 5, { gathered: 3 });
    const [entry] = rankStandings([p]);
    p.stats.gathered = 99;
    expect(entry!.stats.gathered).toBe(3);
  });
});

describe("titles", () => {
  it("hands every honor title to the best holder and the shame titles to the worst", () => {
    const ranked = rankPlayers([
      player("mvp", 0, 80, { gathered: 30, delivered: 12, kills: 1 }),
      player("fisher", 1, 40, { gathered: 10, fish: 6, eaten: 2, coconuts: 2 }),
      player("medic", 2, 30, { gathered: 8, revives: 2, downs: 1, eaten: 2, coconuts: 5 }),
      player("lazy", 3, 5, { gathered: 1, downs: 3, kills: 4 }),
    ]);
    const t = awardTitles(ranked);
    expect(t.get("mvp")).toEqual(["mvp", "porter"]);
    expect(t.get("fisher")).toEqual(["fishLord"]);
    expect(t.get("medic")).toEqual(["hero", "coconutAddict"]);
    expect(t.get("lazy")).toEqual(["crabSlayer", "tourist", "victim"]);
  });

  it("ties go to the better place (honor) / the worse place (tourist)", () => {
    const ranked = rankPlayers([player("a", 0, 20, { kills: 2, gathered: 1 }), player("b", 1, 10, { kills: 2, gathered: 1 }), player("c", 2, 5, { gathered: 4 })]);
    const t = awardTitles(ranked);
    expect(t.get("a")).toContain("crabSlayer");
    expect(t.get("b")).not.toContain("crabSlayer");
    expect(t.get("b")).toContain("tourist");
  });

  it("no titles for nothing: zero stats, a lone player can't be the tourist, no MVP without points", () => {
    const t = awardTitles(rankPlayers([player("solo", 0, 0)]));
    expect(t.get("solo")).toEqual([]);
    const even = awardTitles(rankPlayers([player("a", 0, 3, { gathered: 2 }), player("b", 1, 1, { gathered: 2 })]));
    expect([...even.values()].flat()).not.toContain("tourist");
  });
});

describe("team score", () => {
  const outcome = (o: Partial<TeamOutcome> = {}): TeamOutcome => ({ survivorsAboard: 0, leftBehind: 0, raftHp: 0, bossDown: false, stagesAssembled: 0, ...o });

  it("sums MVP points; a win adds survivors, raft hp and the boss, minus the living left behind; no bonus for speed", () => {
    const ps = [player("a", 0, 40), player("b", 1, 25)];
    expect(teamScore(ps, 0, false)).toBe(65);
    const won = outcome({ survivorsAboard: 2, raftHp: 60, bossDown: true, leftBehind: 1 });
    const bonus = LAUNCH_BONUS + 2 * WIN_SURVIVOR_BONUS + 60 * WIN_RAFT_HP_BONUS + WIN_BOSS_BONUS - LEFT_BEHIND_PENALTY;
    expect(outcomeBonus(true, won)).toBe(bonus);
    expect(teamScore(ps, 0, true, won)).toBe(65 + bonus);
    // A loss pays only for the stages assembled.
    expect(outcomeBonus(false, outcome({ stagesAssembled: 3, raftHp: 80, bossDown: true }))).toBe(3 * LOSS_STAGE_BONUS);
    // Never below 0.
    expect(teamScore([player("a", 0, 0)], 0, true, outcome({ leftBehind: 9 }))).toBe(0);
  });

  it("scoreMatch: standings, MVP and one score per team from the outcomes", () => {
    const res = scoreMatch([player("a", 0, 12, {}, true), player("b", 1, 30, {}, true)], 1, 0, [outcome({ survivorsAboard: 2, raftHp: 50 })]);
    expect(res.mvpId).toBe("b");
    expect(res.standings.map((s) => s.place)).toEqual([1, 2]);
    expect(res.standings.every((s) => s.aboard)).toBe(true);
    expect(res.teamScores).toEqual([42 + LAUNCH_BONUS + 2 * WIN_SURVIVOR_BONUS + 50 * WIN_RAFT_HP_BONUS]);
    const lost = scoreMatch([player("a", 0, 0)], 1, -1, [outcome({ stagesAssembled: 2 })]);
    expect(lost).toMatchObject({ mvpId: "", teamScores: [2 * LOSS_STAGE_BONUS] });
  });
});
