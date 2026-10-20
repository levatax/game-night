import { describe, expect, it } from "vitest";
import {
  BALL_RESPAWN_TICKS,
  COUNTDOWN_TICKS,
  FAST_TIMINGS,
  NICKNAME_MAX,
  POINTS,
  POWERUP_FIRST_TICKS,
  POWERUP_INTERVAL_TICKS,
  POWERUP_WARNING_TICKS,
  RING_DROP_INTERVAL_TICKS,
  RING_SHAKE_TICKS,
} from "../../shared/constants.js";
import { JOIN_ERROR } from "../../shared/protocol.js";
import type { PowerUpType, StatsView } from "../../shared/types.js";
import type { GameEvent } from "../world/events.js";
import {
  checkJoinOptions,
  fallbackNickname,
  firstFreeCharacter,
  lowestFreeSlot,
  nextHost,
  parseSettingsPatch,
  resolveMap,
  sanitizeNickname,
  uniqueNickname,
} from "./lobby.js";
import { nextRttEma, rttSample } from "./ping.js";
import { RoundSchedule, type ScheduledWorld } from "./schedule.js";
import { awardRoundWin, crownLeader, rankStandings, scoreEvent, stalemateWinner, type Scorable } from "./scoring.js";
import { countdownNumber, NORMAL_TIMINGS, roomTimings, STALEMATE_TICKS, wantsFastTimers } from "./timings.js";

const stats = (): StatsView => ({ throws: 0, hits: 0, catches: 0, ringOuts: 0, kos: 0, roundWins: 0 });
const scorable = (): Scorable => ({ points: 0, roundPoints: 0, stats: stats() });
const at = { x: 0, y: 0, z: 0 };

describe("scoring", () => {
  it("scores hits, catches, credited ring-outs, KOs and throws", () => {
    const players = new Map<string, Scorable>([
      ["a", scorable()],
      ["b", scorable()],
    ]);
    const find = (id: string) => players.get(id);
    const events: GameEvent[] = [
      { type: "throw", tick: 1, ownerId: "a", character: "quacky", throwSeq: 1, ballIds: ["b1", "b2", "b3"], charge: 0, kind: "normal", powerUp: "triple", curve: false, origin: at, velocities: [at, at, at] },
      { type: "hit", tick: 2, ballId: "b1", throwerId: "a", targetId: "b", pos: at, knockback: at, charge: 0, kind: "normal", heartsLeft: 2, fullCharge: false },
      { type: "catch", tick: 3, ballId: "b2", catcherId: "b", throwerId: "a", pos: at, throwerHeartsLeft: 2, rewindTicks: 0, kept: true },
      { type: "ringOut", tick: 4, playerId: "b", creditId: "a", pos: at },
      { type: "ringOut", tick: 5, playerId: "a", creditId: "", pos: at },
      { type: "ko", tick: 6, playerId: "b", byId: "a", cause: "hits", pos: at },
      { type: "ko", tick: 7, playerId: "a", byId: "", cause: "disconnect", pos: at },
      { type: "hit", tick: 8, ballId: "b1", throwerId: "gone", targetId: "b", pos: at, knockback: at, charge: 0, kind: "normal", heartsLeft: 1, fullCharge: false },
    ];
    for (const ev of events) scoreEvent(ev, find);
    const a = players.get("a");
    const b = players.get("b");
    expect(a?.points).toBe(POINTS.hit + POINTS.ringOut);
    expect(a?.roundPoints).toBe(POINTS.hit + POINTS.ringOut);
    expect(a?.stats).toMatchObject({ throws: 3, hits: 1, ringOuts: 1, kos: 1 });
    expect(b?.points).toBe(POINTS.catch);
    expect(b?.stats.catches).toBe(1);
  });

  it("round win is +3 and a round-win stat", () => {
    const p = scorable();
    awardRoundWin(p);
    expect(p.points).toBe(POINTS.roundWin);
    expect(p.stats.roundWins).toBe(1);
  });

  it("crowns only a unique leader with points", () => {
    expect(crownLeader([{ id: "a", points: 0 }, { id: "b", points: 0 }])).toBe("");
    expect(crownLeader([{ id: "a", points: 3 }, { id: "b", points: 5 }])).toBe("b");
    expect(crownLeader([{ id: "a", points: 5 }, { id: "b", points: 5 }, { id: "c", points: 1 }])).toBe("");
    expect(crownLeader([{ id: "a", points: 5 }, { id: "b", points: 5 }, { id: "c", points: 6 }])).toBe("c");
  });

  it("ranks by points, then round wins, then catches, then slot", () => {
    const row = (id: string, slot: number, points: number, roundWins: number, catches: number) => ({ id, slot, points, stats: { roundWins, catches } });
    const standings = rankStandings([row("d", 3, 9, 1, 0), row("a", 0, 12, 1, 0), row("c", 2, 9, 2, 0), row("b", 1, 9, 1, 3), row("e", 4, 9, 1, 3)]);
    expect(standings.map((s) => s.id)).toEqual(["a", "c", "b", "e", "d"]);
    expect(standings.map((s) => s.place)).toEqual([1, 2, 3, 4, 5]);
    expect(standings[1]).toEqual({ id: "c", place: 2, points: 9, roundWins: 2, catches: 0 });
  });

  it("stalemate: most hearts wins, a tie means no winner", () => {
    expect(stalemateWinner([{ id: "a", hearts: 1 }, { id: "b", hearts: 3 }])).toBe("b");
    expect(stalemateWinner([{ id: "a", hearts: 2 }, { id: "b", hearts: 2 }, { id: "c", hearts: 1 }])).toBe("");
    expect(stalemateWinner([])).toBe("");
  });
});

describe("lobby rules", () => {
  it("sanitizes nicknames", () => {
    expect(sanitizeNickname("  Bob \n the\tDuck  ")).toBe("Bob the Duck");
    expect(sanitizeNickname("A\u0000B​C")).toBe("ABC");
    expect(Array.from(sanitizeNickname("🦆".repeat(30)))).toHaveLength(NICKNAME_MAX);
    expect(sanitizeNickname("x".repeat(40))).toHaveLength(NICKNAME_MAX);
    expect(sanitizeNickname(" \u0007 ")).toBe("");
  });

  it("validates join options with fallbacks", () => {
    expect(checkJoinOptions({ nickname: " Ann ", character: "mochi" })).toEqual({ ok: true, nickname: "Ann", character: "mochi" });
    expect(checkJoinOptions({})).toEqual({ ok: true, nickname: "", character: null });
    expect(checkJoinOptions(undefined)).toEqual({ ok: true, nickname: "", character: null });
    expect(checkJoinOptions({ nickname: 42 })).toMatchObject({ ok: false, code: JOIN_ERROR.BAD_NICKNAME });
    expect(checkJoinOptions({ nickname: "Ann", character: "dragon" })).toMatchObject({ ok: false, code: JOIN_ERROR.BAD_CHARACTER });
    expect(fallbackNickname(2)).toBe("Player 3");
  });

  it("de-duplicates nicknames case-insensitively within the length cap", () => {
    expect(uniqueNickname("Ann", ["Bob"])).toBe("Ann");
    expect(uniqueNickname("Ann", ["ann"])).toBe("Ann 2");
    expect(uniqueNickname("Ann", ["Ann", "Ann 2"])).toBe("Ann 3");
    const long = "x".repeat(NICKNAME_MAX);
    const unique = uniqueNickname(long, [long]);
    expect(unique).toHaveLength(NICKNAME_MAX);
    expect(unique.endsWith(" 2")).toBe(true);
  });

  it("assigns the lowest free slot and a free character", () => {
    expect(lowestFreeSlot([])).toBe(0);
    expect(lowestFreeSlot([0, 2])).toBe(1);
    expect(lowestFreeSlot([0, 1, 2, 3])).toBe(4);
    expect(lowestFreeSlot([0, 1, 2, 3, 4, 5, 6, 7])).toBe(-1);
    expect(firstFreeCharacter(["quacky", "hopsworth"])).toBe("mochi");
  });

  it("migrates the host in join order, preferring connected players", () => {
    const connected = new Map([
      ["b", false],
      ["c", true],
      ["d", true],
    ]);
    expect(nextHost(["b", "c", "d"], (id) => connected.get(id))).toBe("c");
    expect(nextHost(["c", "d"], (id) => connected.get(id))).toBe("c");
    expect(nextHost(["b"], (id) => connected.get(id))).toBe("b");
    expect(nextHost([], () => true)).toBe("");
  });

  it("keeps only valid host settings fields", () => {
    expect(parseSettingsPatch({ map: "bath", rounds: 7, powerUps: false })).toEqual({ map: "bath", rounds: 7, powerUps: false });
    expect(parseSettingsPatch({ map: "random", rounds: 4, powerUps: "no" })).toEqual({ map: "random" });
    expect(parseSettingsPatch({ map: "moon" })).toEqual({});
    expect(parseSettingsPatch(null)).toEqual({});
  });

  it("random maps never repeat the previous map", () => {
    for (let i = 0; i < 20; i++) {
      const r = i / 20;
      expect(resolveMap("random", "picnic", () => r)).not.toBe("picnic");
      expect(resolveMap("random", "cake", () => r)).not.toBe("cake");
    }
    expect(resolveMap("bath", "bath", () => 0)).toBe("bath");
  });
});

describe("timings and ping", () => {
  it("counts down 3, 2, 1, 0 by whole seconds", () => {
    expect(countdownNumber(COUNTDOWN_TICKS)).toBe(3);
    expect(countdownNumber(61)).toBe(3);
    expect(countdownNumber(60)).toBe(2);
    expect(countdownNumber(31)).toBe(2);
    expect(countdownNumber(30)).toBe(1);
    expect(countdownNumber(1)).toBe(1);
    expect(countdownNumber(0)).toBe(0);
  });

  it("fast timers need both the create option and BONK_TEST=1", () => {
    expect(wantsFastTimers(true, "1")).toBe(true);
    expect(wantsFastTimers(true, "0")).toBe(false);
    expect(wantsFastTimers(true, "")).toBe(false);
    expect(wantsFastTimers("true", "1")).toBe(false);
    expect(wantsFastTimers(undefined, "1")).toBe(false);
    expect(roomTimings(true).roundTicks).toBe(FAST_TIMINGS.ROUND_TICKS);
    expect(roomTimings(false)).toBe(NORMAL_TIMINGS);
    expect(NORMAL_TIMINGS.stalemateTicks).toBe(STALEMATE_TICKS);
  });

  it("measures RTT with an EMA", () => {
    expect(rttSample({ t: 900 }, 1000)).toBe(100);
    expect(rttSample({ t: 1100 }, 1000)).toBeNull();
    expect(rttSample({ t: "x" }, 1000)).toBeNull();
    expect(rttSample(null, 1000)).toBeNull();
    expect(nextRttEma(undefined, 80)).toBe(80);
    expect(nextRttEma(80, 160)).toBe(100);
  });
});

/** Scheduler test double: records every call the scheduler makes. */
class FakeWorld implements ScheduledWorld {
  balls = 0;
  powerUps: string[] = [];
  rings = [0, 0, 0, 0, 0];
  spawns = 0;
  warnings: Array<{ pedestal: number; type: PowerUpType }> = [];
  activated: string[] = [];
  log: string[] = [];

  countBalls(): number {
    return this.balls;
  }
  spawnBall(): string {
    this.balls++;
    this.spawns++;
    return `b${this.balls}`;
  }
  powerUpCount(): number {
    return this.powerUps.length;
  }
  solidPedestals(): number[] {
    return this.rings[1] === 0 ? [0, 1, 2] : [];
  }
  spawnPowerUpWarning(pedestal: number, type: PowerUpType): string {
    const id = `p${this.warnings.length + 1}`;
    this.warnings.push({ pedestal, type });
    this.powerUps.push(id);
    return id;
  }
  activatePowerUp(id: string): void {
    this.activated.push(id);
  }
  outermostSolidRing(): number {
    for (let i = this.rings.length - 1; i >= 1; i--) if (this.rings[i] === 0) return i;
    return -1;
  }
  shakeRing(index: number): void {
    this.rings[index] = 1;
    this.log.push(`shake ${index}`);
  }
  dropRing(index: number): void {
    this.rings[index] = 2;
    this.log.push(`drop ${index}`);
  }
}

describe("round schedule", () => {
  const run = (s: RoundSchedule, w: FakeWorld, from: number, to: number) => {
    for (let t = from; t <= to; t++) s.update(t, w);
  };

  it("respawns a lost ball after 3 s, only while below target", () => {
    const s = new RoundSchedule(NORMAL_TIMINGS, () => 0);
    const w = new FakeWorld();
    s.startPlaying(0, 4, false);
    expect(s.target).toBe(3);
    w.balls = 2;
    s.onBallLost(10);
    run(s, w, 11, 10 + BALL_RESPAWN_TICKS - 1);
    expect(w.spawns).toBe(0);
    s.update(10 + BALL_RESPAWN_TICKS, w);
    expect(w.spawns).toBe(1);
    s.onBallLost(200);
    run(s, w, 201, 400);
    expect(w.spawns).toBe(1);
  });

  it("spawns power-ups first at 15 s then every 20 s, one at a time, with a 2 s warning", () => {
    const s = new RoundSchedule(NORMAL_TIMINGS, () => 0.99);
    const w = new FakeWorld();
    s.startPlaying(100, 2, true);
    run(s, w, 100, 100 + POWERUP_FIRST_TICKS - 1);
    expect(w.warnings).toHaveLength(0);
    s.update(100 + POWERUP_FIRST_TICKS, w);
    expect(w.warnings).toEqual([{ pedestal: 2, type: "zoomies" }]);
    run(s, w, 101 + POWERUP_FIRST_TICKS, 100 + POWERUP_FIRST_TICKS + POWERUP_WARNING_TICKS);
    expect(w.activated).toEqual(["p1"]);
    const second = 100 + POWERUP_FIRST_TICKS + POWERUP_INTERVAL_TICKS;
    run(s, w, 101 + POWERUP_FIRST_TICKS + POWERUP_WARNING_TICKS, second);
    expect(w.warnings).toHaveLength(1);
    w.powerUps = [];
    run(s, w, second + 1, second + POWERUP_INTERVAL_TICKS);
    expect(w.warnings).toHaveLength(2);
  });

  it("never spawns power-ups when they're off or no pedestal is on solid ground", () => {
    const off = new RoundSchedule(NORMAL_TIMINGS);
    const w = new FakeWorld();
    off.startPlaying(0, 2, false);
    run(off, w, 0, 3000);
    expect(w.warnings).toHaveLength(0);

    const on = new RoundSchedule(NORMAL_TIMINGS);
    w.rings[1] = 2;
    on.startPlaying(0, 2, true);
    run(on, w, 0, 3000);
    expect(w.warnings).toHaveLength(0);
  });

  it("sudden death: extra ball, outermost ring shakes at once and drops 0.8 s later, every 5 s", () => {
    const s = new RoundSchedule(NORMAL_TIMINGS);
    const w = new FakeWorld();
    s.startPlaying(0, 3, false);
    w.balls = 2;
    s.startSuddenDeath(1000, w);
    expect(s.target).toBe(3);
    expect(w.spawns).toBe(1);
    expect(w.log).toEqual(["shake 4"]);
    expect(s.ticksToNextDrop(1000, w)).toBe(RING_SHAKE_TICKS);
    run(s, w, 1001, 1000 + RING_SHAKE_TICKS);
    expect(w.log).toEqual(["shake 4", "drop 4"]);
    expect(s.ticksToNextDrop(1000 + RING_SHAKE_TICKS, w)).toBe(RING_DROP_INTERVAL_TICKS);
    run(s, w, 1001 + RING_SHAKE_TICKS, 1000 + RING_DROP_INTERVAL_TICKS);
    expect(w.log).toEqual(["shake 4", "drop 4", "shake 3"]);
    const lastDrop = 1000 + 3 * RING_DROP_INTERVAL_TICKS + RING_SHAKE_TICKS;
    run(s, w, 1001 + RING_DROP_INTERVAL_TICKS, lastDrop);
    expect(w.log.filter((l) => l.startsWith("drop"))).toEqual(["drop 4", "drop 3", "drop 2", "drop 1"]);
    expect(s.ticksToNextDrop(lastDrop, w)).toBe(0);
    expect(s.stalemateDue(lastDrop + STALEMATE_TICKS - 1)).toBe(false);
    run(s, w, lastDrop + 1, lastDrop + STALEMATE_TICKS);
    expect(s.stalemateDue(lastDrop + STALEMATE_TICKS)).toBe(true);
    expect(w.rings[0]).toBe(0);
  });

  it("clear() forgets every pending timer", () => {
    const s = new RoundSchedule(NORMAL_TIMINGS);
    const w = new FakeWorld();
    s.startPlaying(0, 2, true);
    s.onBallLost(0);
    s.clear();
    run(s, w, 0, 3000);
    expect(w.spawns).toBe(0);
    expect(w.warnings).toEqual([]);
    expect(s.stalemateDue(1e9)).toBe(false);
  });
});
