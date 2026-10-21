// Unit tests for the pure lobby rules (join checks, nicknames, seats, host, settings, payload parsing) plus the rng,
// test-knob, timing and ping helpers. Owner: server-room.
import { describe, expect, it } from "vitest";
import {
  BOT_NAMES,
  BOT_ROLES,
  CHARACTER_IDS,
  EMPTY_ROOM_DISPOSE_SEC,
  MAX_PLAYERS,
  NICKNAME_MAX,
  RECONNECT_GRACE_SEC,
  TICK_RATE,
} from "../../shared/constants.js";
import { BTN, JOIN_ERROR, PROTOCOL_VERSION } from "../../shared/protocol.js";
import {
  botIdentity,
  checkJoinOptions,
  FALLBACK_NICKNAMES,
  fallbackNickname,
  firstFreeCharacter,
  lowestFreeSeat,
  MAX_MARKS_PER_BASE,
  nextHost,
  nicknameKey,
  parseSettingsPatch,
  raftSeats,
  readChest,
  readInput,
  readMarker,
  sanitizeNickname,
  uniqueNickname,
} from "./lobby.js";
import { previewSeed, matchRngs, PREVIEW_SEED_MAX } from "./rng.js";
import { NO_KNOBS, readKnobs, testFlagWarning } from "./testing.js";
import { nextRttEma, rttSample } from "./ping.js";
import { ACTION_BURST, ACTION_COOLDOWN_TICKS, NEVER_JOINED_DISPOSE_SEC, roomTimings } from "./timings.js";

describe("join options", () => {
  it("accepts a clean nickname / character, rejects wrong types with JOIN_ERROR codes", () => {
    expect(checkJoinOptions({ nickname: "  Ayşe\t ", character: "gelin" })).toEqual({ ok: true, nickname: "Ayşe", character: "gelin" });
    expect(checkJoinOptions({})).toEqual({ ok: true, nickname: "", character: null });
    expect(checkJoinOptions(null)).toEqual({ ok: true, nickname: "", character: null });
    expect(checkJoinOptions({ nickname: 42 })).toMatchObject({ ok: false, code: JOIN_ERROR.BAD_NICKNAME });
    expect(checkJoinOptions({ nickname: "x", character: "pirate" })).toMatchObject({ ok: false, code: JOIN_ERROR.BAD_CHARACTER });
  });

  it("rejects another PROTOCOL_VERSION with OUTDATED (checked first); a missing one is a pre-versioning client", () => {
    expect(checkJoinOptions({ nickname: "Ada", protocol: PROTOCOL_VERSION })).toEqual({ ok: true, nickname: "Ada", character: null });
    expect(checkJoinOptions({ nickname: "Ada", protocol: null })).toMatchObject({ ok: true });
    for (const protocol of [PROTOCOL_VERSION + 1, 0, "1", true, {}]) {
      expect(checkJoinOptions({ nickname: "Ada", protocol }), String(protocol)).toMatchObject({ ok: false, code: JOIN_ERROR.OUTDATED });
    }
    expect(checkJoinOptions({ nickname: 42, protocol: 99 })).toMatchObject({ ok: false, code: JOIN_ERROR.OUTDATED });
  });

  it("sanitizes and de-duplicates nicknames (Turkish-aware)", () => {
    expect(sanitizeNickname("a​b   c\n")).toBe("ab c");
    expect(Array.from(sanitizeNickname("🦀".repeat(40)))).toHaveLength(NICKNAME_MAX);
    expect(uniqueNickname("İsmail", ["ismail"])).toBe("İsmail 2");
    expect(uniqueNickname("Ian", ["IAN", "ian 2"])).toBe("Ian 3");
    expect(uniqueNickname("x".repeat(NICKNAME_MAX), ["x".repeat(NICKNAME_MAX)])).toHaveLength(NICKNAME_MAX);
    expect(fallbackNickname(0)).toBe(FALLBACK_NICKNAMES[0]);
    expect(fallbackNickname(MAX_PLAYERS - 1)).toBe(FALLBACK_NICKNAMES[MAX_PLAYERS - 1]);
  });

  it(`keeps at most ${MAX_MARKS_PER_BASE} combining marks per character (Zalgo collapses, real names stay)`, () => {
    const zalgo = "Z\u0336\u0334\u0335\u0337\u0338a\u0300\u0301\u0302\u0303\u0304\u20DD\u20DD\u0489lgo";
    expect(sanitizeNickname(zalgo)).toBe("Z\u0336\u0334a\u0300\u0301lgo");
    expect(sanitizeNickname("x" + "\u0489".repeat(40))).toBe("x\u0489\u0489"); // enclosing marks count too
    expect(sanitizeNickname("\u0301\u0301Ali")).toBe("Ali"); // marks with no letter in front
    expect(sanitizeNickname("a\u200B\u0301\u200B\u0301\u200B\u0301")).toBe("a\u0301\u0301"); // invisible separators don't reset the count
    const kept = [
      "Şükrü",
      "Çağla",
      "Şükrü Çağla".normalize("NFD"), // one mark per letter
      "Nguyễn Việt".normalize("NFD"), // ễ / ệ decomposed: two marks each
      "กี้ Thai",
      "👨‍👩‍👧 Ali",
      "🏳️‍🌈 Rainbow",
      "👩🏽‍💻 dev",
      "1️⃣ Keycap",
      "🏴󠁧󠁢󠁥󠁮󠁧󠁿 Eng",
      "🇹🇷 Ayşe",
    ];
    for (const name of kept) expect(sanitizeNickname(name), name).toBe(name);
  });

  it("drops stray joiners and the joiner left dangling by the length cap", () => {
    expect(sanitizeNickname("a\u200D")).toBe("a");
    expect(sanitizeNickname("\u200Db\u200Dc")).toBe("bc");
    const families = "👨‍👩‍👧‍👦".repeat(4);
    const capped = sanitizeNickname(families);
    expect(Array.from(capped).length).toBeLessThanOrEqual(NICKNAME_MAX);
    expect(capped.endsWith("\u200D")).toBe(false);
    expect(capped.startsWith("👨‍👩‍👧‍👦👨‍👩‍👧‍👦")).toBe(true);
  });

  it("composed and decomposed spellings are the same name", () => {
    expect(nicknameKey("Şükrü".normalize("NFD"))).toBe(nicknameKey("ŞÜKRÜ"));
    expect(uniqueNickname("Çağla".normalize("NFD"), ["çağla"])).toBe(`${"Çağla".normalize("NFD")} 2`);
  });
});

describe("seats, characters, host", () => {
  it("lowest free seat and the first unused character", () => {
    expect(lowestFreeSeat([0, 2])).toBe(1);
    expect(lowestFreeSeat(Array.from({ length: MAX_PLAYERS }, (_, i) => i))).toBe(-1);
    expect(firstFreeCharacter(["kaptan", "fenomen"])).toBe("amca");
    expect(firstFreeCharacter(CHARACTER_IDS)).toBe("kaptan");
    expect(raftSeats(1)).toBe(2);
    expect(raftSeats(9)).toBe(MAX_PLAYERS);
  });

  it("host goes to the earliest connected human, never a bot, preferring non-spectators", () => {
    const list = [
      { id: "old", connected: true, bot: false, spectator: false },
      { id: "spec", connected: true, bot: false, spectator: true },
      { id: "bot-1", connected: true, bot: true, spectator: false },
      { id: "away", connected: false, bot: false, spectator: false },
      { id: "late", connected: true, bot: false, spectator: false },
    ];
    expect(nextHost(list, "old")).toBe("late");
    expect(nextHost(list.slice(0, 4), "old")).toBe("spec");
    expect(nextHost(list.slice(2, 4), "old")).toBe("");
  });

  it("bot identities: free BOT_NAMES entry and its role (leavers' roles: room/bots.ts roleForCharacter)", () => {
    expect(botIdentity([], 0)).toEqual({ nickname: BOT_NAMES[0], role: BOT_ROLES[0] });
    expect(botIdentity([BOT_NAMES[0]!.toUpperCase(), "Someone"], 1)).toEqual({ nickname: BOT_NAMES[1], role: BOT_ROLES[1] });
    const all = botIdentity(BOT_NAMES, 5);
    expect(all.nickname).toBe(`${BOT_NAMES[0]} 2`);
  });
});

describe("settings & payloads", () => {
  it("settings: coop / difficulty / seed; duel is flagged, junk ignored", () => {
    expect(parseSettingsPatch({ mode: "coop", difficulty: "nightmare", seed: 4471 })).toEqual({
      patch: { mode: "coop", difficulty: "nightmare", seed: 4471 },
      duelRejected: false,
    });
    expect(parseSettingsPatch({ mode: "duel" })).toEqual({ patch: {}, duelRejected: true });
    expect(parseSettingsPatch({ difficulty: "easy", seed: -1 })).toEqual({ patch: {}, duelRejected: false });
    expect(parseSettingsPatch({ seed: "9023" }).patch.seed).toBe(9023);
    expect(parseSettingsPatch({ seed: 2 ** 32 }).patch.seed).toBeUndefined();
    expect(parseSettingsPatch({ seed: 1.5 }).patch.seed).toBeUndefined();
    expect(parseSettingsPatch("x")).toEqual({ patch: {}, duelRejected: false });
  });

  it("inputs: types checked, axes and pitch clamped, unknown buttons masked", () => {
    expect(readInput({ seq: 3, moveX: 5, moveZ: -0.5, yaw: 1, pitch: 9, buttons: BTN.JUMP | (1 << 20) })).toEqual({
      seq: 3,
      moveX: 1,
      moveZ: -0.5,
      yaw: 1,
      pitch: 1.5,
      buttons: BTN.JUMP,
    });
    for (const bad of [null, 7, { seq: "1" }, { seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 }, { seq: 1, moveX: NaN, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 }]) {
      expect(readInput(bad)).toBeNull();
    }
  });

  it("chest ops and markers", () => {
    expect(readChest({ op: "put" })).toEqual({ op: "put" });
    expect(readChest({ op: "take", kind: "wood", count: 2 })).toEqual({ op: "take", kind: "wood", count: 2 });
    expect(readChest({ op: "take" })).toBeNull();
    expect(readChest({ op: "steal" })).toBeNull();
    expect(readChest({ op: "put", count: -1 })).toBeNull();
    // put's optional pocket: an integer 0..3; anything else makes the message malformed; take / putAll drop it.
    expect(readChest({ op: "put", slot: 2, kind: "wood", count: 1 })).toEqual({ op: "put", slot: 2, kind: "wood", count: 1 });
    expect(readChest({ op: "put", slot: 0 })).toEqual({ op: "put", slot: 0 });
    expect(readChest({ op: "put", slot: null })).toEqual({ op: "put" });
    for (const slot of [-1, 4, 1.5, "2", Number.NaN, Infinity]) expect(readChest({ op: "put", slot })).toBeNull();
    expect(readChest({ op: "take", kind: "rope", slot: 1 })).toEqual({ op: "take", kind: "rope" });
    expect(readChest({ op: "putAll", slot: 3 })).toEqual({ op: "putAll" });
    expect(readChest({ op: "putAll", slot: 9 })).toBeNull();
    const bounds = { minX: -40, maxX: 40, minZ: -40, maxZ: 40 };
    const m = readMarker({ kind: "need", pos: { x: 500, y: 1.5, z: 0 }, need: "rope" }, { x: 0, y: 1.5, z: 0 }, bounds);
    expect(m).toEqual({ kind: "need", pos: { x: 40, y: 1.5, z: 0 }, need: "rope" });
    expect(readMarker({ kind: "here", pos: { x: 1, y: 0, z: 2 }, need: "rope" }, { x: 0, y: 0, z: 0 }, bounds)?.need).toBe("");
    expect(readMarker({ kind: "nope", pos: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, bounds)).toBeNull();
  });
});

describe("rng, test knobs, ping", () => {
  it("seeded streams are deterministic and independent; preview seeds are short and never 0", () => {
    const a = matchRngs(7, 1);
    const b = matchRngs(7, 1);
    expect([a.gameplay(), a.gameplay()]).toEqual([b.gameplay(), b.gameplay()]);
    expect(a.bot()).not.toBe(matchRngs(7, 1).gameplay());
    expect(matchRngs(7, 2).seed).not.toBe(a.seed);
    for (let i = 1; i < 200; i++) {
      const s = previewSeed(3, i);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(PREVIEW_SEED_MAX);
    }
    expect(previewSeed(3, 5)).toBe(previewSeed(3, 5));
  });

  it("test knobs only with RAFT_TEST=1, never with NODE_ENV=production", () => {
    const all = { fast: true, testSeed: 5, warp: 4, manualClock: true };
    expect(readKnobs(all, {})).toEqual(NO_KNOBS);
    expect(readKnobs(all, { RAFT_TEST: "true" })).toEqual(NO_KNOBS);
    expect(readKnobs(all, { RAFT_TEST: "1", NODE_ENV: "production" })).toEqual(NO_KNOBS);
    expect(readKnobs({ ...all, warp: 40 }, { RAFT_TEST: "1" })).toEqual({ fast: true, testSeed: 5, warp: 8, manualClock: true });
    const dev = { RAFT_TEST: "1", NODE_ENV: "development" };
    expect(readKnobs({ testSeed: 5, warp: 4 }, dev)).toEqual({ fast: false, testSeed: 5, warp: 1, manualClock: false });
  });

  it("RAFT_TEST at startup: an error in production, a warning outside a test runner, silence in tests", () => {
    expect(testFlagWarning({})).toBeNull();
    expect(testFlagWarning({ RAFT_TEST: "1", NODE_ENV: "production" })).toMatchObject({ level: "error" });
    expect(testFlagWarning({ RAFT_TEST: "1", NODE_ENV: "production", VITEST: "true" })).toMatchObject({ level: "error" });
    expect(testFlagWarning({ RAFT_TEST: "1" })).toMatchObject({ level: "warn" });
    expect(testFlagWarning({ RAFT_TEST: "1", NODE_ENV: "development" })).toMatchObject({ level: "warn" });
    expect(testFlagWarning({ RAFT_TEST: "1", VITEST: "true" })).toBeNull();
    expect(testFlagWarning({ RAFT_TEST: "1", NODE_ENV: "test" })).toBeNull();
  });

  it("room timers: grace below the empty-room dispose, never-joined rooms go first, 1 s preview, craft / chest budget", () => {
    expect(RECONNECT_GRACE_SEC).toBeLessThan(EMPTY_ROOM_DISPOSE_SEC);
    for (const fast of [false, true]) {
      const t = roomTimings(fast);
      expect(t).toMatchObject({
        reconnectGraceSec: RECONNECT_GRACE_SEC,
        emptyDisposeSec: EMPTY_ROOM_DISPOSE_SEC,
        neverJoinedSec: NEVER_JOINED_DISPOSE_SEC,
      });
      expect(t.neverJoinedSec).toBeLessThan(t.emptyDisposeSec);
      expect(t.previewCooldownTicks).toBe(TICK_RATE);
      expect(t.actionCooldownTicks).toBe(ACTION_COOLDOWN_TICKS);
      expect(t.actionBurst).toBe(ACTION_BURST);
    }
  });

  it("RTT samples and EMA", () => {
    expect(rttSample({ t: 1000 }, 1080)).toBe(80);
    expect(rttSample({ t: 2000 }, 1000)).toBeNull();
    expect(rttSample({ t: "x" }, 1000)).toBeNull();
    expect(nextRttEma(undefined, 80)).toBe(80);
    expect(nextRttEma(80, 120)).toBe(90);
  });
});
