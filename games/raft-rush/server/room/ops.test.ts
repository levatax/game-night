// Unit tests for the room's operational helpers: the live-room registry (cap + health), the structured log lines
// and their throttle, the per-client message budget, the per-player craft / chest action budget. Owner: server-room.
// Run: npx vitest run games/raft-rush/server/room/ops.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { GAME_ID } from "../../shared/constants.js";
import { ActionBudget, DROP_LOG_MS, MESSAGE_BURST, MESSAGE_RATE, MessageBudget } from "./flood.js";
import { LogThrottle, formatLine, logLine, loggingOn } from "./log.js";
import { claimRoomSlot, DEFAULT_MAX_ROOMS, freshStalls, liveRoomCount, maxRooms, roomHealth, STALL_MS, type RoomSlot } from "./registry.js";
import { ACTION_BURST, ACTION_COOLDOWN_TICKS } from "./timings.js";

describe("live-room registry", () => {
  const claimed: RoomSlot[] = [];
  afterEach(() => {
    for (const s of claimed.splice(0)) s.release();
  });

  it("RAFT_MAX_ROOMS overrides the cap (a positive integer, else the default)", () => {
    expect(maxRooms(undefined)).toBe(DEFAULT_MAX_ROOMS);
    expect(maxRooms("12")).toBe(12);
    for (const bad of ["0", "-3", "2.5", "lots", ""]) expect(maxRooms(bad), bad).toBe(DEFAULT_MAX_ROOMS);
  });

  it("caps the live rooms and frees a slot exactly once", () => {
    const base = liveRoomCount();
    const a = claimRoomSlot(0, base + 2)!;
    const b = claimRoomSlot(0, base + 2)!;
    claimed.push(a, b);
    expect(a && b).toBeTruthy();
    expect(claimRoomSlot(0, base + 2)).toBeNull();
    expect(liveRoomCount()).toBe(base + 2);
    a.release();
    a.release();
    expect(liveRoomCount()).toBe(base + 1);
    const c = claimRoomSlot(0, base + 2);
    expect(c).not.toBeNull();
    claimed.push(c!);
  });

  it("health: ok until a live room goes STALL_MS without a fixed tick; manual-clock rooms never stall", () => {
    const now = 1_000_000;
    const base = roomHealth(now);
    const fresh = claimRoomSlot(now - 100, Infinity)!;
    const stuck = claimRoomSlot(now - STALL_MS - 1, Infinity)!;
    const manual = claimRoomSlot(now - 60_000, Infinity)!;
    claimed.push(fresh, stuck, manual);
    fresh.code = "FRSH";
    stuck.code = "STUK";
    manual.code = "TEST";
    manual.manual = true;
    stuck.lastTickAt = now - 100;
    expect(roomHealth(now)).toMatchObject({ ok: base.ok, rooms: base.rooms + 3 });
    stuck.lastTickAt = now - STALL_MS - 250;
    const h = roomHealth(now);
    expect(h.ok).toBe(false);
    expect(h.stalled).toContain("STUK");
    expect(h.stalled).not.toContain("TEST");
    expect(h.maxTickAgeMs).toBeGreaterThanOrEqual(STALL_MS + 250);
    stuck.release();
    expect(roomHealth(now).stalled).not.toContain("STUK");
  });

  it("freshStalls names each stall once, and again after the room recovered", () => {
    const reported = new Set<string>();
    const report = (stalled: string[]) => ({ ok: stalled.length === 0, rooms: 3, maxTickAgeMs: 0, stalled });
    expect(freshStalls(report(["ABCD"]), reported)).toEqual(["ABCD"]);
    expect(freshStalls(report(["ABCD", "WXYZ"]), reported)).toEqual(["WXYZ"]);
    expect(freshStalls(report(["WXYZ"]), reported)).toEqual([]);
    expect(freshStalls(report(["ABCD", "WXYZ"]), reported)).toEqual(["ABCD"]);
    expect(freshStalls(report([]), reported)).toEqual([]);
    expect(reported.size).toBe(0);
  });
});

describe("structured logs", () => {
  it("one JSON line with ts / game / event that fields can't override", () => {
    const line = JSON.parse(formatLine("matchEnd", { room: "ABCD", reason: "storm", event: "fake", ts: "x" }, Date.UTC(2026, 9, 21, 12)));
    expect(line).toEqual({ room: "ABCD", reason: "storm", ts: "2026-10-21T12:00:00.000Z", game: GAME_ID, event: "matchEnd" });
  });

  it("quiet under RAFT_TEST=1 unless RAFT_LOG=1", () => {
    expect(loggingOn({})).toBe(true);
    expect(loggingOn({ RAFT_TEST: "1" })).toBe(false);
    expect(loggingOn({ RAFT_TEST: "1", RAFT_LOG: "1" })).toBe(true);
  });

  it("logLine writes to stdout (warnings to stderr) only while logging is on", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      vi.stubEnv("RAFT_TEST", "1");
      vi.stubEnv("RAFT_LOG", "");
      logLine("create", { room: "ABCD" });
      expect(log).not.toHaveBeenCalled();
      vi.stubEnv("RAFT_LOG", "1");
      logLine("create", { room: "ABCD" });
      logLine("flood", { room: "ABCD" }, "warn");
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ event: "create", room: "ABCD" });
      expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({ event: "flood" });
    } finally {
      vi.unstubAllEnvs();
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("LogThrottle lets the first one through, then one summary per period; flush hands over the rest", () => {
    const t = new LogThrottle(10_000);
    expect(t.note(40, 0)).toEqual({ count: 1, total: 40 });
    expect(t.note(10, 1000)).toBeNull();
    expect(t.note(15, 9000)).toBeNull();
    expect(t.note(5, 10_000)).toEqual({ count: 3, total: 30 });
    expect(t.flush()).toBeNull();
    expect(t.note(1, 12_000)).toBeNull();
    expect(t.flush()).toEqual({ count: 1, total: 1 });
    expect(t.flush()).toBeNull();
  });
});

describe("message budget", () => {
  it(`lets a ${MESSAGE_BURST}-message burst through, then ${MESSAGE_RATE}/s; one firstDrop per client per window`, () => {
    const b = new MessageBudget();
    const verdicts = Array.from({ length: MESSAGE_BURST + 50 }, () => b.take("a", 0));
    expect(verdicts.filter((v) => v === "ok")).toHaveLength(MESSAGE_BURST);
    expect(verdicts.filter((v) => v === "firstDrop")).toHaveLength(1);
    expect(b.take("b", 0)).toBe("ok"); // per client
    // half a second later: MESSAGE_RATE / 2 tokens are back
    let ok = 0;
    for (let i = 0; i < MESSAGE_RATE; i++) if (b.take("a", 500) === "ok") ok++;
    expect(ok).toBe(MESSAGE_RATE / 2);
    // still inside the window of the first drop: refilled tokens pass, the rest is dropped without a new log
    const inWindow = Array.from({ length: 100 }, () => b.take("a", 900));
    expect(inWindow.filter((v) => v === "ok")).toHaveLength((400 * MESSAGE_RATE) / 1000);
    expect(inWindow).not.toContain("firstDrop");
    // the next window logs again, once
    const later = Array.from({ length: 300 }, () => b.take("a", DROP_LOG_MS));
    expect(later.filter((v) => v === "firstDrop")).toHaveLength(1);
    expect(b.take("a", DROP_LOG_MS + 1)).toBe("drop");
  });

  it("legit traffic (30 Hz inputs + 1 Hz pongs + clicks) is never dropped", () => {
    const b = new MessageBudget();
    for (let ms = 0; ms < 60_000; ms += 1000 / 30) {
      expect(b.take("p", ms)).toBe("ok");
      if (Math.floor(ms) % 1000 < 34) expect(b.take("p", ms)).toBe("ok");
      if (Math.floor(ms) % 250 < 34) expect(b.take("p", ms)).toBe("ok");
    }
  });

  it("forget resets a client", () => {
    const b = new MessageBudget(10, 10);
    for (let i = 0; i < 10; i++) b.take("x", 0);
    expect(b.take("x", 0)).not.toBe("ok");
    b.forget("x");
    expect(b.take("x", 0)).toBe("ok");
  });

  it("a clock stepping back re-anchors the bucket instead of freezing it", () => {
    const b = new MessageBudget(10, 10);
    for (let i = 0; i < 10; i++) expect(b.take("x", 60_000)).toBe("ok");
    expect(b.take("x", 60_000)).toBe("firstDrop");
    expect(b.take("x", 0)).toBe("firstDrop"); // 60 s back: no refill, and the drop window starts over
    expect(b.take("x", 500)).toBe("ok"); // refills from the new anchor (not only once 60 000 comes round again)
    for (let i = 0; i < 4; i++) expect(b.take("x", 500)).toBe("ok");
    expect(b.take("x", 500)).toBe("drop");
  });
});

describe("action budget (craft / chest)", () => {
  it("a burst back to back, then one per `every` ticks", () => {
    const b = new ActionBudget(5, 4);
    expect(Array.from({ length: 10 }, () => b.take("p", 0)).filter(Boolean)).toHaveLength(4);
    expect(b.take("p", 4)).toBe(false);
    expect(b.take("p", 5)).toBe(true);
    expect(b.take("p", 6)).toBe(false);
    expect(b.take("p", 9)).toBe(false);
    expect(b.take("p", 10)).toBe(true);
    // idle: the whole burst is back, never more
    expect(Array.from({ length: 10 }, () => b.take("p", 1000)).filter(Boolean)).toHaveLength(4);
    // per player
    expect(b.take("q", 1000)).toBe(true);
  });

  it("a burst of 1 is a plain cooldown; spam every tick is held to burst + one per `every`", () => {
    const one = new ActionBudget(5, 1);
    expect([one.take("p", 0), one.take("p", 0), one.take("p", 4), one.take("p", 5), one.take("p", 9), one.take("p", 10)]).toEqual([true, false, false, true, false, true]);
    const b = new ActionBudget(5, 4);
    let served = 0;
    for (let tick = 0; tick < 300; tick++) if (b.take("spam", tick)) served++;
    expect(served).toBe(4 + 59); // the burst, then ticks 5, 10, … 295
  });

  it(`legit clicking is whole: "Take 1" 8× a second for 1.5 s (${ACTION_BURST} / ${ACTION_COOLDOWN_TICKS} ticks)`, () => {
    const b = new ActionBudget(ACTION_COOLDOWN_TICKS, ACTION_BURST);
    for (let i = 0; i <= 12; i++) expect(b.take("p", Math.floor(i * 3.75)), `click ${i}`).toBe(true);
  });

  it("forget / clear give the full budget back", () => {
    const b = new ActionBudget(5, 2);
    b.take("p", 0);
    b.take("p", 0);
    expect(b.take("p", 0)).toBe(false);
    b.forget("p");
    expect(b.take("p", 0)).toBe(true);
    b.take("p", 0);
    b.clear();
    expect(b.take("p", 0)).toBe(true);
  });
});
