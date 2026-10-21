// Unit tests for the hub's manifest helpers and /healthz aggregation (server/games.ts). Run: npx vitest run server/games

import { describe, expect, it, vi } from "vitest";
import {
  errorReason,
  HEALTH_LOG_MIN_GAP_MS,
  HEALTH_LOG_REPEAT_MS,
  hubHealth,
  publicHealth,
  publicManifest,
  throttledHealthLog,
  type LoadedGame,
} from "./games.js";
import type { GameManifest, GameServerModule } from "./types.js";

const manifest = (extra: Partial<GameManifest> = {}): GameManifest => ({
  id: "test-game",
  title: "Test Game",
  tagline: "A test.",
  description: "A test game.",
  players: { min: 1, max: 4 },
  duration: "~1 min",
  input: "Keyboard + mouse",
  tags: [],
  accent: "#123456",
  status: "live",
  ...extra,
});
const loaded = (extra: Partial<GameManifest> = {}): LoadedGame => ({ manifest: manifest(extra), dir: "/games/test-game" });

const mod = (health?: GameServerModule["health"]): GameServerModule => ({ register() {}, ...(health ? { health } : {}) });

describe("publicManifest", () => {
  it("passes desktopOnly through, defaulting to false", () => {
    expect(publicManifest(loaded({ desktopOnly: true }), true).desktopOnly).toBe(true);
    expect(publicManifest(loaded(), true).desktopOnly).toBe(false);
  });

  it("keeps beta games playable and soon games not", () => {
    expect(publicManifest(loaded({ status: "beta" }), true)).toMatchObject({ status: "beta", playable: true });
    expect(publicManifest(loaded({ status: "soon" }), true).playable).toBe(false);
    expect(publicManifest(loaded({ status: "live" }), false).playable).toBe(false);
  });

  it("marks a built game whose server failed to register as down and not playable", () => {
    expect(publicManifest(loaded(), true, true)).toMatchObject({ serverDown: true, playable: false });
    expect(publicManifest(loaded(), true)).toMatchObject({ serverDown: false, playable: true });
  });
});

describe("hubHealth", () => {
  it("is ok with no modules, keeping the game count", () => {
    expect(hubHealth(3, new Map())).toEqual({ ok: true, games: 3, checks: {} });
  });

  it("skips modules without health() and passes the details of the others through", () => {
    const modules = new Map([
      ["quiet", mod()],
      ["raft", mod(() => ({ ok: true, rooms: 2, maxTickAgeMs: 33 }))],
    ]);
    expect(hubHealth(2, modules)).toEqual({ ok: true, games: 2, checks: { raft: { ok: true, rooms: 2, maxTickAgeMs: 33 } } });
  });

  it("is not ok when any game reports not ok", () => {
    const modules = new Map([
      ["fine", mod(() => ({ ok: true }))],
      ["stuck", mod(() => ({ ok: false, stalled: 1 }))],
    ]);
    const health = hubHealth(2, modules);
    expect(health.ok).toBe(false);
    expect(health.checks).toEqual({ fine: { ok: true }, stuck: { ok: false, stalled: 1 } });
  });

  it("publishes only counts and flags of a game's report: room codes and error texts stay off /healthz", () => {
    // Raft Rush's RoomHealth shape: `stalled` holds the stalled rooms' join codes.
    const raft = mod(() => ({ ok: false, rooms: 3, maxTickAgeMs: 6120, stalled: ["ABCD", "WXYZ"] }));
    const chatty = mod(() => ({ ok: true, error: "slow disk at /app/dist/games/x/server/index.js", byRoom: { ABCD: 1 } }));
    const health = hubHealth(2, new Map([["raft", raft], ["chatty", chatty]]));
    expect(health).toEqual({
      ok: false,
      games: 2,
      checks: { raft: { ok: false, rooms: 3, maxTickAgeMs: 6120, stalled: 2 }, chatty: { ok: true } },
    });
    expect(JSON.stringify(health)).not.toMatch(/ABCD|WXYZ|\/app|dist|index\.js/);
  });

  it("counts a throwing health() as not ok, logging the full error and showing only its class", () => {
    const thrown = new TypeError("Cannot read properties of undefined (reading 'tick') at /app/dist/games/raft-rush/server/index.js:12");
    const modules = new Map([
      [
        "broken",
        mod(() => {
          throw thrown;
        }),
      ],
      [
        "plain",
        mod(() => {
          throw new Error("tick loop gone in /app/dist/games/raft-rush/server/room/registry.js");
        }),
      ],
    ]);
    const log = vi.fn();
    expect(hubHealth(2, modules, new Map(), log)).toEqual({
      ok: false,
      games: 2,
      checks: { broken: { ok: false, error: "health() threw (TypeError)" }, plain: { ok: false, error: "health() threw" } },
    });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("broken", thrown);
  });

  it("polling a health() that always throws writes one log line, not one per request", () => {
    const sink = vi.fn();
    const logError = throttledHealthLog({ sink, now: () => 0 });
    const modules = new Map([
      [
        "broken",
        mod(() => {
          throw new TypeError("no tick");
        }),
      ],
    ]);
    for (let i = 0; i < 100; i++) expect(hubHealth(1, modules, new Map(), logError).ok).toBe(false);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith("[hub] broken health() threw:", expect.any(TypeError));
  });

  it("only accepts ok: true as healthy", () => {
    const sloppy = mod(() => ({ ok: "yes" }) as unknown as { ok: boolean });
    const empty = mod(() => undefined as unknown as { ok: boolean });
    const health = hubHealth(2, new Map([["sloppy", sloppy], ["empty", empty]]));
    expect(health.ok).toBe(false);
    expect(health.checks.sloppy?.ok).toBe(false);
    expect(health.checks.empty).toEqual({ ok: false, error: "health() returned no report" });
  });

  it("is not ok when a game's server failed to register, even with no health() anywhere", () => {
    const modules = new Map([
      ["quiet", mod()],
      ["raft", mod(() => ({ ok: true }))],
    ]);
    const notFound = Object.assign(new Error("Cannot find module '/app/dist/games/kasala/server/index.js'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const failed = new Map<string, unknown>([
      ["kasala", notFound],
      ["bonk", new SyntaxError("Unexpected token '<' in /app/dist/games/bonk/server/index.js")],
      ["jelly", new Error("register() blew up in /app/dist/games/jelly/server/index.js")],
      ["odd", "boom at /app/dist/games/odd/server/index.js"],
    ]);
    const health = hubHealth(6, modules, failed);
    expect(health).toEqual({
      ok: false,
      games: 6,
      checks: {
        kasala: { ok: false, error: "failed to register (ERR_MODULE_NOT_FOUND)" },
        bonk: { ok: false, error: "failed to register (SyntaxError)" },
        jelly: { ok: false, error: "failed to register" },
        odd: { ok: false, error: "failed to register" },
        raft: { ok: true },
      },
    });
    expect(JSON.stringify(health)).not.toMatch(/\/app|dist|index\.js/);
    expect(hubHealth(1, new Map(), new Map([["kasala", new Error("x")]])).ok).toBe(false);
  });
});

describe("publicHealth", () => {
  it("keeps ok: true only, finite numbers, booleans and array lengths", () => {
    expect(publicHealth({ ok: true, rooms: 2, busy: false, stalled: [], codes: ["ABCD"] })).toEqual({
      ok: true,
      rooms: 2,
      busy: false,
      stalled: 0,
      codes: 1,
    });
    expect(publicHealth({ ok: "yes", n: 1 })).toEqual({ ok: false, n: 1 });
    expect(publicHealth({ ok: false, nan: NaN, inf: Infinity, s: "x", o: { a: 1 }, z: null, u: undefined })).toEqual({
      ok: false,
    });
  });

  it("doesn't let a detail field touch the prototype or override ok", () => {
    const report = JSON.parse('{"ok": false, "__proto__": 7, "toString": [1, 2]}') as { ok: boolean };
    const out = publicHealth(report);
    expect(out.ok).toBe(false);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out).sort()).toEqual(["__proto__", "ok", "toString"]);
    expect(JSON.parse(JSON.stringify(out))).toMatchObject({ ok: false, toString: 2 });
  });
});

describe("throttledHealthLog", () => {
  const setup = () => {
    let t = 0;
    const sink = vi.fn();
    const log = throttledHealthLog({ sink, now: () => t });
    return { sink, log, at: (ms: number) => void (t = ms) };
  };

  it("repeats the same error only after the repeat time, saying how many it left out", () => {
    const { sink, log, at } = setup();
    log("raft", new TypeError("no tick"));
    at(HEALTH_LOG_REPEAT_MS - 1);
    log("raft", new TypeError("no tick"));
    log("raft", new TypeError("no tick"));
    expect(sink).toHaveBeenCalledTimes(1);
    at(HEALTH_LOG_REPEAT_MS);
    log("raft", new TypeError("no tick"));
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenLastCalledWith("[hub] raft health() threw (2 more since the last line, not logged):", expect.any(TypeError));
  });

  it("logs a different error after the minimum gap, not before, and keeps games apart", () => {
    const { sink, log, at } = setup();
    log("raft", new TypeError("a"));
    log("bonk", new TypeError("a"));
    expect(sink).toHaveBeenCalledTimes(2);
    at(HEALTH_LOG_MIN_GAP_MS - 1);
    log("raft", new RangeError("b"));
    expect(sink).toHaveBeenCalledTimes(2);
    at(HEALTH_LOG_MIN_GAP_MS);
    log("raft", new RangeError("b"));
    expect(sink).toHaveBeenCalledTimes(3);
    expect(sink).toHaveBeenLastCalledWith("[hub] raft health() threw (1 more since the last line, not logged):", expect.any(RangeError));
    // Thrown values that differ every time (a counter in the message) still get at most one line per gap.
    for (let i = 0; i < 50; i++) log("raft", `tick ${i}`);
    expect(sink).toHaveBeenCalledTimes(3);
  });

  it("survives a thrown value that can't be printed", () => {
    const { sink, log } = setup();
    const nasty = {
      get message(): string {
        throw new Error("getter");
      },
    };
    expect(() => log("raft", nasty)).not.toThrow();
    // Checked by identity: a deep compare would read the throwing getter itself.
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toBe("[hub] raft health() threw:");
    expect(sink.mock.calls[0]?.[1] === nasty).toBe(true);
  });
});

describe("errorReason", () => {
  it("picks a Node error code, else the error class, never the message", () => {
    expect(errorReason(Object.assign(new Error("/app/x.js"), { code: "ENOENT" }))).toBe("ENOENT");
    expect(errorReason(new RangeError("/app/x.js"))).toBe("RangeError");
    expect(errorReason(new Error("/app/x.js"))).toBeUndefined();
    expect(errorReason({ code: "ERR_INVALID_URL" })).toBe("ERR_INVALID_URL");
  });

  it("drops codes and names that aren't plain identifiers, and thrown non-objects", () => {
    expect(errorReason(Object.assign(new Error("x"), { code: "/app/dist/x.js" }))).toBeUndefined();
    expect(errorReason(Object.assign(new Error("x"), { code: 42 }))).toBeUndefined();
    const named = new Error("x");
    named.name = "Failed at /app/dist/x.js";
    expect(errorReason(named)).toBeUndefined();
    expect(errorReason(Object.assign(new TypeError("x"), { code: "not a code" }))).toBe("TypeError");
    for (const value of ["/app/dist/x.js", 7, null, undefined]) expect(errorReason(value)).toBeUndefined();
  });
});
