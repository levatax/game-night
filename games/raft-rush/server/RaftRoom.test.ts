// Real Colyseus protocol tests for RaftRoom: an in-process server on a random free port, colyseus.js clients,
// RAFT_TEST=1 via vi.stubEnv (fast timers, seeded rngs, and the manual clock for bot matches and timer tests: the
// room instance from matchMaker.getLocalRoomById is advanced by hand, so they don't wait on the wall clock; the
// hub smoke test still plays a warped real-time match). Owner: server-room.
// Run: npx vitest run games/raft-rush/server/RaftRoom.test.ts
//
// Covered: create / join validation / lobby settings / ready gating / start, welcome seed + gridHash + defHash
// matching generateIsland (and a fresh welcome on a lobby seed change and at the match start), an input moving the
// player, emote / marker rate limits, ping, garbage payloads, solo + SOLO_AUTO_BOTS reaching matchEnd with
// standings, rematch, reconnect within the grace window keeping seat / inventory / position (a stand-in bot
// meanwhile), a mid-match leaver's seat becoming a full bot (host migration, spectating late joiner, leaver removed
// in the next lobby), the full room and the bot limits, every notice key existing in
// client/src/i18n/strings/server.ts; and the hardening: outdated / bad creates and the live-room cap refused before
// a code is allocated, a failing island generator giving its code and slot back, never-joined and empty-room
// disposal (never during a reconnect grace, and a failed stand-in still getting its grace), the host staying with
// the migrated host, rejects reaching only their actor, the craft / chest action budget, message floods, the
// "abandoned" match end and the lifecycle log lines.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { matchMaker, Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client, type Room } from "colyseus.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { en as serverStrings } from "../client/src/i18n/strings/server";
import {
  BOT_NAMES,
  BOT_ROLES,
  CODE_PATTERN,
  EMOTE_COOLDOWN_TICKS,
  EMPTY_ROOM_DISPOSE_SEC,
  MAX_BOTS,
  MAX_PLAYERS,
  SOLO_AUTO_BOTS,
  TICK_MS,
  TICK_RATE,
} from "../shared/constants.js";
import { generateIsland } from "../shared/island/generate.js";
import { CLOSE_CODE, JOIN_ERROR, PROTOCOL_VERSION, ROOM_NAME, type InputCmd, type NoticeMsg, type ServerMessages } from "../shared/protocol.js";
import { yawFromDir } from "../shared/sim/math.js";
import type { PlayerView, RaftStateView } from "../shared/types.js";
import { getRoomCodes } from "./hub.js";
import { RaftRoom } from "./RaftRoom.js";
import { BotDesk, roleForCharacter } from "./room/bots.js";
import { MESSAGE_BURST, MessageBudget } from "./room/flood.js";
import { liveRoomCount } from "./room/registry.js";
import { fill } from "./room/text.js";
import { ACTION_BURST, ACTION_COOLDOWN_TICKS, NEVER_JOINED_DISPOSE_SEC } from "./room/timings.js";
import { RaftWorld } from "./world/World.js";

/** Arms one failure of the island generator (the room's onCreate must give its code and slot back). */
const islandFault = vi.hoisted(() => ({ fail: false }));
vi.mock("../shared/island/generate.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../shared/island/generate.js")>();
  return {
    ...real,
    generateIsland: (...args: Parameters<typeof real.generateIsland>) => {
      if (islandFault.fail) {
        islandFault.fail = false;
        throw new Error("test: island generator failure");
      }
      return real.generateIsland(...args);
    },
  };
});

type RaftClientRoom = Room<RaftStateView>;
type MessageType = keyof ServerMessages;

/** A connected test client plus every message it received. */
interface Peer {
  room: RaftClientRoom;
  inbox: Array<{ type: string; msg: unknown }>;
  seq: number;
}

const httpServer = http.createServer();
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }), greet: false });
let endpoint = "";
const peers: Peer[] = [];
/** Every notice any test client received (checked against the client strings at the end). */
const allNotices: NoticeMsg[] = [];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(label: string, probe: () => T | null | undefined | false, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(15);
  }
}

function adopt(room: RaftClientRoom): Peer {
  const peer: Peer = { room, inbox: [], seq: 0 };
  room.onMessage("*", (type, msg) => {
    peer.inbox.push({ type: String(type), msg });
    if (type === "notice") allNotices.push(msg as NoticeMsg);
  });
  peers.push(peer);
  return peer;
}

function all<K extends MessageType>(p: Peer, type: K, match?: (m: ServerMessages[K]) => boolean): ServerMessages[K][] {
  const out: ServerMessages[K][] = [];
  for (const entry of p.inbox) {
    if (entry.type !== type) continue;
    const msg = entry.msg as ServerMessages[K];
    if (!match || match(msg)) out.push(msg);
  }
  return out;
}

function received<K extends MessageType>(p: Peer, type: K, match?: (m: ServerMessages[K]) => boolean): ServerMessages[K] | undefined {
  return all(p, type, match)[0];
}

function waitMessage<K extends MessageType>(p: Peer, type: K, match?: (m: ServerMessages[K]) => boolean, timeoutMs = 15000): Promise<ServerMessages[K]> {
  return waitFor(`${type} message`, () => received(p, type, match), timeoutMs);
}

const noticeKeys = (p: Peer): string[] => all(p, "notice").map((n) => n.key);
const me = (p: Peer): PlayerView | undefined => p.room.state.players?.get(p.room.sessionId);
const seen = (viewer: Peer, id: string): PlayerView | undefined => viewer.room.state.players?.get(id);

async function create(options: Record<string, unknown>): Promise<Peer> {
  return adopt(await new Client(endpoint).create<RaftStateView>(ROOM_NAME, options));
}

async function join(code: string, options: Record<string, unknown>): Promise<Peer> {
  return adopt(await new Client(endpoint).joinById<RaftStateView>(code, options));
}

async function refusal(label: string, attempt: () => Promise<{ leave(): Promise<unknown> }>): Promise<{ code: number; message: string }> {
  try {
    const room = await attempt();
    await room.leave();
  } catch (err) {
    const e = err as { code?: number; message?: string };
    return { code: e.code ?? -1, message: e.message ?? "" };
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

const joinError = (code: string, options: Record<string, unknown>) => refusal("join", () => new Client(endpoint).joinById(code, options));
const createError = (options: Record<string, unknown>) => refusal("create", () => new Client(endpoint).create(ROOM_NAME, options));

/** The server-side room behind a code (undefined once it is disposed). */
function localRoom(code: string): RaftRoom | undefined {
  const room: unknown = matchMaker.getLocalRoomById(code);
  return room instanceof RaftRoom ? room : undefined;
}

/** Every message `p` sent so far has been handled: an emote round trip (EMOTE_COOLDOWN_TICKS of room time since its last). */
async function flushed(p: Peer): Promise<void> {
  const mine = () => all(p, "emote", (e) => e.playerId === p.room.sessionId).length;
  const before = mine();
  p.room.send("emote", { emote: "clap" });
  await waitFor("emote round trip", () => mine() > before);
}

/**
 * Manual-clock room: play the match in 0.5 s slices of room time (yielding to the sockets between slices) until
 * the podium — deterministic and as fast as the CPU allows, instead of a warped wall-clock wait.
 */
async function playToPodium(room: RaftRoom, maxSec = 120): Promise<void> {
  for (let slice = 0; slice < maxSec * 2 && room.state.phase !== "matchEnd"; slice++) {
    room.advance(500);
    await sleep(1);
  }
  expect(room.state.phase).toBe("matchEnd");
}

/** console.log lines (JSON room logs) of room `code` while the spy ran. */
function logLines(spy: { mock: { calls: unknown[][] } }, code: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const call of spy.mock.calls) {
    try {
      const line: unknown = JSON.parse(String(call[0]));
      if (typeof line === "object" && line !== null && (line as Record<string, unknown>).room === code) out.push(line as Record<string, unknown>);
    } catch {
      // not a room log line
    }
  }
  return out;
}

function sendInput(p: Peer, partial: Partial<InputCmd>): void {
  p.seq++;
  const cmd: InputCmd = { seq: p.seq, moveX: 0, moveZ: 0, yaw: me(p)?.yaw ?? 0, pitch: 0, buttons: 0, ...partial };
  p.room.send("input", cmd);
}

function inventory(p: PlayerView | undefined): string {
  if (!p) return "?";
  return [p.inv0, p.cnt0, p.inv1, p.cnt1, p.inv2, p.cnt2, p.inv3, p.cnt3].join(",");
}

async function leaveAll(list: Peer[]): Promise<void> {
  // A loaded host makes the close handshake slow: give it real time instead of the old 500 ms race, which could
  // leave a client behind and make the next test's room look occupied.
  await Promise.all(list.map((p) => (p.room.connection.isOpen ? Promise.race([p.room.leave(true).catch(() => undefined), sleep(10_000)]) : Promise.resolve())));
}

beforeAll(async () => {
  // The host shell may export NODE_ENV=production, and RaftRoom deliberately ignores every test knob (fast timers,
  // warp, manual clock) in production. Pin the worker to test so the suite behaves the same whatever the caller's
  // environment is; restore it in afterAll with unstubAllEnvs.
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("RAFT_TEST", "1");
  gameServer.define(ROOM_NAME, RaftRoom);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  endpoint = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await leaveAll(peers);
  await gameServer.gracefullyShutdown(false);
  vi.unstubAllEnvs();
}, 30_000);

describe("RaftRoom lobby → match", () => {
  it("validates joins, runs the lobby (settings, seed preview, ready gating) and starts a match players can walk in", async () => {
    // ----------------------------------------------------------------------- create
    const host = await create({ nickname: "  Ayşe\t", character: "kaptan", fast: true, testSeed: 11 });
    const code = host.room.roomId;
    expect(code).toMatch(CODE_PATTERN);
    const welcome = await waitMessage(host, "welcome");
    expect(welcome).toMatchObject({ code, sessionId: host.room.sessionId, fast: true, reconnected: false, tickRate: TICK_RATE, layout: "solo" });
    const preview = generateIsland(welcome.seed, welcome.layout);
    expect(welcome.gridHash).toBe(preview.gridHash);
    expect(welcome.defHash).toBe(preview.defHash);
    await waitFor("host state", () => me(host)?.nickname === "Ayşe" && host.room.state.hostId === host.room.sessionId);
    expect(host.room.state.seed).toBe(welcome.seed);
    expect(host.room.state.settings.seed).toBe(0);
    expect(host.room.state.phase).toBe("lobby");

    // -------------------------------------------------------------- join validation
    expect(await joinError(code, { nickname: "Zed", character: "pirate" })).toMatchObject({ code: JOIN_ERROR.BAD_CHARACTER });
    expect(await joinError(code, { nickname: 42 })).toMatchObject({ code: JOIN_ERROR.BAD_NICKNAME });

    const guest = await join(code, { nickname: "ayşe", character: "sef" });
    await waitFor("2 players", () => host.room.state.players.size === 2);
    expect(seen(host, guest.room.sessionId)).toMatchObject({ nickname: "ayşe 2", character: "sef", seat: 1, spectator: false, bot: false });
    await waitMessage(host, "notice", (n) => n.key.startsWith("joined") && n.params?.n === "ayşe 2");
    expect(received(guest, "notice", (n) => n.key.startsWith("joined"))).toBeUndefined();

    // garbage payloads never break the lobby (the guest also sends "start": not the host, so it's refused)
    for (const type of ["input", "ready", "character", "settings", "emote", "marker", "craft", "chest", "rematch", "pong", "addBot", "removeBot", "start", "nonsense"]) {
      for (const payload of [null, 7, "x", [], { seq: "1" }, { ready: "yes" }, { character: 5 }, { t: Number.NaN }, { seed: -4 }, { id: 3 }]) {
        guest.room.send(type, payload);
      }
    }

    // ------------------------------------------------------------------- settings
    guest.room.send("settings", { difficulty: "vacation" });
    await waitMessage(guest, "notice", (n) => n.key === "hostOnly");
    host.room.send("settings", { mode: "duel" });
    await waitMessage(host, "notice", (n) => n.key === "duelLocked");
    host.room.send("settings", { difficulty: "nightmare", seed: 4471 });
    const reWelcome = await waitMessage(guest, "welcome", (w) => w.seed === 4471);
    const island = generateIsland(4471, "solo");
    expect(reWelcome).toMatchObject({ gridHash: island.gridHash, defHash: island.defHash, reconnected: false, sessionId: guest.room.sessionId });
    await waitFor("settings synced", () => {
      const s = host.room.state;
      return s.settings.seed === 4471 && s.seed === 4471 && s.biome === island.biome && s.settings.difficulty === "nightmare" && s.difficulty === "nightmare";
    });
    expect(host.room.state.settings.mode).toBe("coop");
    expect(host.room.state.nodes.length).toBe(island.nodes.length);
    expect(host.room.state.phase).toBe("lobby");

    // ---------------------------------------------------------------- start gating
    host.room.send("start", {});
    const lazy = await waitMessage(host, "notice", (n) => n.key === "cantStartLazyOne");
    expect(lazy.params).toEqual({ names: "ayşe 2" });
    guest.room.send("ready", { ready: true });
    await waitFor("guest ready", () => seen(host, guest.room.sessionId)?.ready === true);
    guest.room.send("character", { character: "cocuk" });
    await waitFor("character", () => seen(host, guest.room.sessionId)?.character === "cocuk");

    // --------------------------------------------------------------------- match
    const welcomesBefore = all(guest, "welcome").length;
    host.room.send("start", {});
    const start = await waitMessage(guest, "matchStart");
    expect(start).toMatchObject({ seed: 4471, layout: "solo", biome: island.biome, seats: 2 });
    expect([...start.participants].sort()).toEqual([host.room.sessionId, guest.room.sessionId].sort());
    await waitFor("welcome resent", () => all(guest, "welcome").length > welcomesBefore);
    expect(all(guest, "welcome").at(-1)).toMatchObject({ seed: 4471, gridHash: island.gridHash });
    await waitFor("in the match", () => host.room.state.phase === "landing" || host.room.state.phase === "playing");
    await waitFor("alive", () => me(host)?.alive === true);
    expect(host.room.state.day).toBe(1);

    // an input moves the player (walking inland, toward the campfire: the corridor there is clear)
    const site = island.sites[0]!;
    const from = { x: me(host)!.x, z: me(host)!.z };
    const yaw = yawFromDir(site.campfire.x - from.x, site.campfire.z - from.z);
    for (let i = 0; i < 24; i++) {
      sendInput(host, { moveZ: 1, yaw });
      await sleep(1000 / TICK_RATE);
    }
    await waitFor("inputs acked", () => (me(host)?.lastSeq ?? 0) >= 12);
    const moved = Math.hypot(me(host)!.x - from.x, me(host)!.z - from.z);
    expect(moved).toBeGreaterThan(0.5);

    await waitMessage(host, "dayPhase", (d) => d.day === 1 && d.dayPhase === "day", 4000);

    // emotes and markers are rate-limited; the marker is clamped to 60 m
    guest.room.send("emote", { emote: "clap" });
    guest.room.send("emote", { emote: "dance" });
    await waitMessage(host, "emote", (e) => e.playerId === guest.room.sessionId);
    host.room.send("marker", { kind: "need", pos: { x: from.x + 500, y: 0, z: from.z }, need: "rope" });
    host.room.send("marker", { kind: "danger", pos: { x: from.x, y: 0, z: from.z } });
    const marker = await waitMessage(guest, "marker", (m) => m.playerId === host.room.sessionId);
    expect(marker).toMatchObject({ kind: "need", need: "rope" });
    const eye = me(host)!;
    expect(Math.hypot(marker.pos.x - eye.x, marker.pos.z - eye.z)).toBeLessThanOrEqual(60.5);
    await sleep(150);
    expect(all(host, "emote")).toHaveLength(1);
    expect(all(guest, "marker")).toHaveLength(1);

    // ping → pong → player.ping
    const ping = await waitMessage(host, "ping");
    expect(ping.tick).toBeGreaterThan(0);
    host.room.send("pong", { t: ping.t - 40 });
    await waitFor("ping measured", () => (me(host)?.ping ?? 0) >= 40);

    // garbage mid-match doesn't break anything either
    for (let i = 0; i < 10; i++) host.room.send("input", { seq: 1_000_000 + i, moveX: Number.POSITIVE_INFINITY, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 });
    host.room.send("craft", { recipe: "nuke" });
    host.room.send("chest", { op: "take" });
    await sleep(100);
    expect(["landing", "playing"]).toContain(host.room.state.phase);
    await leaveAll([host, guest]);
  }, 60_000);

  it(`a lone human gets ${SOLO_AUTO_BOTS} helper bots and the fast match reaches matchEnd with standings`, async () => {
    const host = await create({ nickname: "Deniz", character: "amca", fast: true, testSeed: 5, manualClock: true });
    const room = localRoom(host.room.roomId)!;
    await waitFor("host synced", () => me(host)?.nickname === "Deniz");
    host.room.send("start", {});
    const solo = await waitMessage(host, "notice", (n) => n.key === "soloBots");
    expect(solo.params).toEqual({ count: SOLO_AUTO_BOTS });
    const start = await waitMessage(host, "matchStart");
    expect(start.participants).toHaveLength(1 + SOLO_AUTO_BOTS);
    expect(start.seats).toBe(1 + SOLO_AUTO_BOTS);
    await waitFor("bots synced", () => host.room.state.players.size === 1 + SOLO_AUTO_BOTS);
    const bots = [...host.room.state.players.values()].filter((p) => p.bot).sort((a, b) => a.seat - b.seat);
    expect(bots.map((b) => b.nickname)).toEqual(BOT_NAMES.slice(0, SOLO_AUTO_BOTS));
    expect(bots.map((b) => b.botRole)).toEqual(BOT_ROLES.slice(0, SOLO_AUTO_BOTS));
    for (const b of bots) {
      expect(b.id).toMatch(/^bot-\d+$/);
      expect(b).toMatchObject({ ready: true, connected: true, spectator: false });
    }
    expect(new Set([...host.room.state.players.values()].map((p) => p.character)).size).toBe(1 + SOLO_AUTO_BOTS);

    await playToPodium(room);
    const end = await waitMessage(host, "matchEnd");
    expect(["storm", "launched"]).toContain(end.reason);
    expect(end.seed).toBe(start.seed);
    expect(end.standings.map((s) => s.place)).toEqual([1, 2, 3]);
    expect(end.standings.map((s) => s.id).sort()).toEqual([...start.participants].sort());
    expect(end.teamScores).toHaveLength(1);
    expect(end.teamScores[0]).toBeGreaterThanOrEqual(0);
    if (end.reason === "storm") {
      expect(end.winnerTeam).toBe(-1);
      expect(end.ticksLeft).toBe(0);
      expect(received(host, "storm")).toBeDefined();
    } else {
      expect(end.winnerTeam).toBe(0);
      expect(received(host, "raftLaunch")).toBeDefined();
    }
    // the day clock ran: day 1 dusk and night were announced
    expect(received(host, "dayPhase", (d) => d.day === 1 && d.dayPhase === "dusk")).toBeDefined();
    expect(received(host, "dayPhase", (d) => d.day === 1 && d.dayPhase === "night")).toBeDefined();
    if (end.reason === "storm" && received(host, "dayPhase", (d) => d.day === 3 && d.dayPhase === "night")) {
      expect(received(host, "stormWarning")?.secondsLeft).toBeGreaterThan(0);
    }
    await waitFor("podium", () => host.room.state.phase === "matchEnd" && host.room.state.winReason === end.reason);

    host.room.send("rematch", { ready: true });
    await waitFor("back in the lobby", () => host.room.state.phase === "lobby");
    await waitMessage(host, "notice", (n) => n.key === "rematch");
    expect(me(host)).toMatchObject({ ready: true, spectator: false, alive: false });
    expect([...host.room.state.players.values()].filter((p) => p.bot && p.ready)).toHaveLength(SOLO_AUTO_BOTS);
    expect(host.room.state.day).toBe(0);
    await leaveAll([host]);
  }, 60_000);
});

describe("RaftRoom seats", () => {
  it("reconnecting within the grace window keeps the seat, inventory and position", async () => {
    // Normal timers: the landing's first 3 s lock every input, so the stand-in bot can't move or use anything.
    const host = await create({ nickname: "Kaptan", character: "kaptan", testSeed: 9 });
    const guest = await join(host.room.roomId, { nickname: "Gelin", character: "gelin" });
    await waitFor("2 players", () => host.room.state.players.size === 2);
    guest.room.send("ready", { ready: true });
    await waitFor("ready", () => seen(host, guest.room.sessionId)?.ready === true);
    host.room.send("start", {});
    await waitMessage(guest, "matchStart");
    const id = guest.room.sessionId;
    await waitFor("landed", () => host.room.state.phase === "landing" && seen(host, id)?.alive === true);
    await sleep(150);
    const before = seen(host, id)!;
    const snapshot = { seat: before.seat, inv: inventory(before), x: before.x, z: before.z };

    const token = guest.room.reconnectionToken;
    const add = vi.spyOn(BotDesk.prototype, "add");
    guest.room.connection.close(); // not consented: the seat is held, a stand-in bot drives it
    await waitFor("dropped", () => seen(host, id)?.connected === false);
    await waitMessage(host, "notice", (n) => n.key === "reconnecting" && n.params?.n === "Gelin");
    expect(seen(host, id)?.bot).toBe(false);
    expect(add).toHaveBeenCalledWith(id, roleForCharacter("gelin"), { standIn: true });
    add.mockRestore();

    const back = adopt(await new Client(endpoint).reconnect<RaftStateView>(token));
    expect(back.room.sessionId).toBe(id);
    const w = await waitMessage(back, "welcome", (m) => m.reconnected);
    expect(w).toMatchObject({ sessionId: id, seed: host.room.state.seed });
    await waitFor("reconnected", () => seen(host, id)?.connected === true);
    await waitMessage(host, "notice", (n) => n.key === "reconnected");
    const after = seen(host, id)!;
    expect(after.seat).toBe(snapshot.seat);
    expect(inventory(after)).toBe(snapshot.inv);
    expect(Math.hypot(after.x - snapshot.x, after.z - snapshot.z)).toBeLessThan(0.5);
    expect(after).toMatchObject({ bot: false, botRole: "", alive: true, spectator: false });
    expect(host.room.state.players.size).toBe(2);
    await leaveAll([host, back]);
  }, 60_000);

  it("a mid-match leaver's seat becomes a bot, the host moves on, late joiners spectate", async () => {
    const host = await create({ nickname: "Kaan", character: "fenomen", fast: true, testSeed: 4, manualClock: true });
    const code = host.room.roomId;
    const room = localRoom(code)!;
    const guest = await join(code, { nickname: "Lale", character: "cocuk" });
    await waitFor("2 players", () => host.room.state.players.size === 2);
    guest.room.send("ready", { ready: true });
    await waitFor("ready", () => seen(host, guest.room.sessionId)?.ready === true);
    host.room.send("start", {});
    await waitMessage(guest, "matchStart");

    const late = await join(code, { nickname: "Geç Kalan", character: "amca" });
    await waitMessage(late, "notice", (n) => n.key === "spectatingYou");
    await waitFor("spectator", () => me(late)?.spectator === true);
    expect(me(late)?.alive).toBe(false);
    await waitMessage(guest, "notice", (n) => n.key.startsWith("spectating") && n.params?.n === "Geç Kalan");
    expect(received(late, "welcome")?.seed).toBe(guest.room.state.seed);

    const hostId = host.room.sessionId;
    const add = vi.spyOn(BotDesk.prototype, "add");
    await host.room.leave(true); // for good, mid-match
    await waitFor("taken over", () => seen(guest, hostId)?.bot === true);
    expect(seen(guest, hostId)).toMatchObject({ nickname: "Kaan", seat: 0, connected: true, botRole: roleForCharacter("fenomen") });
    // a full bot (not a stand-in) plays the leaver's seat
    expect(add.mock.calls.filter((c) => c[0] === hostId)).toEqual([[hostId, roleForCharacter("fenomen")]]);
    add.mockRestore();
    await waitMessage(guest, "notice", (n) => n.key === "tookOver" && n.params?.n === "Kaan");
    await waitFor("host migrated", () => guest.room.state.hostId === guest.room.sessionId);
    await waitMessage(late, "notice", (n) => n.key === "host" && n.params?.n === "Lale");

    await playToPodium(room);
    const end = await waitMessage(guest, "matchEnd");
    expect(end.standings.map((s) => s.id)).toContain(hostId);
    expect(end.standings).toHaveLength(2);
    late.room.send("rematch", { ready: false }); // any player may send it
    await waitFor("lobby", () => guest.room.state.phase === "lobby");
    await waitMessage(guest, "notice", (n) => n.key === "backToLobby" && n.params?.n === "Geç Kalan");
    expect(guest.room.state.players.has(hostId)).toBe(false);
    expect(me(late)?.spectator).toBe(false);
    expect(guest.room.state.players.size).toBe(2);
    await leaveAll([guest, late]);
  }, 60_000);

  it("rejects joins into a full room and caps the helper bots", async () => {
    const host = await create({ nickname: "Rehber", fast: true, testSeed: 2 });
    const code = host.room.roomId;
    await waitFor("host synced", () => me(host)?.character === "kaptan");
    for (let i = 0; i < MAX_BOTS; i++) host.room.send("addBot", {});
    await waitFor("bots", () => host.room.state.players.size === MAX_PLAYERS);
    host.room.send("addBot", {});
    await waitMessage(host, "notice", (n) => n.key === "tooManyBots");
    expect(host.room.state.players.size).toBe(MAX_PLAYERS);
    expect(all(host, "notice", (n) => n.key === "botAdded")).toHaveLength(MAX_BOTS);
    const bots = [...host.room.state.players.values()].filter((p) => p.bot).sort((a, b) => a.seat - b.seat);
    expect(bots.map((b) => b.nickname)).toEqual([...BOT_NAMES]);
    expect(bots.map((b) => b.botRole)).toEqual([...BOT_ROLES]);
    expect(new Set([...host.room.state.players.values()].map((p) => p.character)).size).toBe(MAX_PLAYERS);

    expect(await joinError(code, { nickname: "Late", character: "sef" })).toMatchObject({ code: JOIN_ERROR.ROOM_FULL });

    const removed = bots[0]!;
    host.room.send("removeBot", { id: removed.id });
    await waitMessage(host, "notice", (n) => n.key === "botRemoved" && n.params?.n === removed.nickname);
    await waitFor("seat freed", () => host.room.state.players.size === MAX_PLAYERS - 1);
    const guest = await join(code, { nickname: "Bahri", character: "sef" });
    await waitFor("guest seated", () => seen(host, guest.room.sessionId)?.seat === removed.seat);
    expect(seen(host, guest.room.sessionId)?.nickname).toBe("Bahri");
    guest.room.send("addBot", {});
    await waitMessage(guest, "notice", (n) => n.key === "hostOnly");
    host.room.send("addBot", {});
    await waitMessage(host, "notice", (n) => n.key === "beachFull" || n.key === "tooManyBots");
    await leaveAll([host, guest]);
  }, 60_000);
});

describe("RaftRoom lifecycle", () => {
  it("refuses outdated and bad creates, and creates past the live-room cap, before a code is allocated", async () => {
    const codes = getRoomCodes();
    const allocate = vi.spyOn(codes, "allocate");
    try {
      expect(await createError({ nickname: "Old", protocol: PROTOCOL_VERSION + 1 })).toMatchObject({ code: JOIN_ERROR.OUTDATED });
      expect(await createError({ nickname: 42 })).toMatchObject({ code: JOIN_ERROR.BAD_NICKNAME });
      expect(allocate).not.toHaveBeenCalled();

      const host = await create({ nickname: "Neu", protocol: PROTOCOL_VERSION, fast: true, testSeed: 3 });
      expect(allocate).toHaveBeenCalledTimes(1);
      expect(await joinError(host.room.roomId, { nickname: "Old", protocol: 0 })).toMatchObject({ code: JOIN_ERROR.OUTDATED });
      await waitFor("host synced", () => me(host)?.nickname === "Neu");

      // this test's own room is live, so a cap of 1 is full whatever the other tests left behind
      const before = liveRoomCount();
      vi.stubEnv("RAFT_MAX_ROOMS", "1");
      allocate.mockClear();
      const busy = await createError({ nickname: "Late", fast: true });
      expect(busy).toMatchObject({ code: JOIN_ERROR.SERVER_BUSY, message: "Server busy, try again in a minute" });
      expect(allocate).not.toHaveBeenCalled();
      expect(liveRoomCount()).toBeLessThanOrEqual(before);
      vi.stubEnv("RAFT_MAX_ROOMS", "");
      const next = await create({ nickname: "Room", fast: true });
      expect(next.room.roomId).toMatch(CODE_PATTERN);
      await leaveAll([host, next]);
    } finally {
      vi.stubEnv("RAFT_MAX_ROOMS", "");
      allocate.mockRestore();
    }
  }, 60_000);

  it("a create whose island generation throws gives its code and its live-room slot back", async () => {
    const codes = getRoomCodes();
    const allocate = vi.spyOn(codes, "allocate");
    const release = vi.spyOn(codes, "release");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined); // Colyseus prints the failure
    try {
      const before = liveRoomCount();
      islandFault.fail = true;
      const err = await createError({ nickname: "Unlucky", fast: true });
      expect(err.message).toContain("island generator failure");
      expect(allocate).toHaveBeenCalledTimes(1);
      const code = allocate.mock.results[0]!.value as string;
      expect(release).toHaveBeenCalledWith(code);
      expect(codes.lookup(code)).toBeUndefined();
      expect(liveRoomCount()).toBeLessThanOrEqual(before);
      expect(localRoom(code)).toBeUndefined();
    } finally {
      islandFault.fail = false;
      quiet.mockRestore();
      allocate.mockRestore();
      release.mockRestore();
    }
  });

  it("a room nobody joins disposes after the never-joined timer; a stall drops sim time with one warning (manual clock)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("RAFT_LOG", "1");
    try {
      const created = await matchMaker.createRoom(ROOM_NAME, { nickname: "Ghost", fast: true, testSeed: 1, manualClock: true });
      const code = created.roomId;
      const room = localRoom(code)!;
      expect(room).toBeDefined();
      expect(getRoomCodes().lookup(code)).toBeDefined();
      const live = liveRoomCount();

      room.advance(3000, true); // one 3 s simulation callback: 4 ticks run, the rest is dropped
      room.advance(3000, true);
      const dropped = logLines(warn, code).filter((l) => l.event === "simDropped");
      expect(dropped).toHaveLength(1); // the second stall is folded into the next line
      expect(Number(dropped[0]!.droppedMs)).toBeGreaterThan(2800);
      expect(room.state.tick).toBe(8);

      room.advance((NEVER_JOINED_DISPOSE_SEC - 6.5) * 1000);
      expect(localRoom(code)).toBe(room);
      room.advance(1000);
      await waitFor("never-joined room disposed", () => !localRoom(code));
      expect(getRoomCodes().lookup(code)).toBeUndefined();
      expect(liveRoomCount()).toBe(live - 1);
      expect(logLines(log, code).map((l) => l.event)).toEqual(["create", "dispose"]);
      expect(logLines(log, code).at(-1)).toMatchObject({ joined: false, matches: 0 });
      expect(logLines(warn, code).filter((l) => l.event === "simDropped")).toHaveLength(2); // the held one is flushed at dispose
    } finally {
      vi.stubEnv("RAFT_LOG", "");
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("an empty room disposes emptyDisposeSec after the last human left, never while one is inside the reconnect grace", async () => {
    const host = await create({ nickname: "Ada", fast: true, testSeed: 8, manualClock: true });
    const code = host.room.roomId;
    const room = localRoom(code)!;
    const guest = await join(code, { nickname: "Bora" });
    const guestId = guest.room.sessionId;
    await waitFor("2 players", () => host.room.state.players.size === 2);

    const token = guest.room.reconnectionToken;
    guest.room.connection.close(); // a drop: the 30 s grace runs in real time
    await waitFor("guest dropped", () => seen(host, guestId)?.connected === false);
    await host.room.leave(true);
    await waitFor("no client left", () => room.clients.length === 0);
    room.advance((EMPTY_ROOM_DISPOSE_SEC + 5) * 1000);
    expect(localRoom(code)).toBe(room); // Bora is still inside the grace

    const back = adopt(await new Client(endpoint).reconnect<RaftStateView>(token));
    await waitMessage(back, "welcome", (w) => w.reconnected);
    await waitFor("Bora hosts (nobody else is here)", () => back.room.state.hostId === guestId);
    await back.room.leave(true);
    await waitFor("empty again", () => room.clients.length === 0);
    room.advance((EMPTY_ROOM_DISPOSE_SEC - 1) * 1000);
    expect(localRoom(code)).toBe(room);
    room.advance(2000);
    await waitFor("empty room disposed", () => !localRoom(code));
    expect(getRoomCodes().lookup(code)).toBeUndefined();
  }, 60_000);

  it("a drop whose stand-in bot fails still gets its reconnect grace, and the emptied room still disposes (manual clock)", async () => {
    const host = await create({ nickname: "Ilgaz", fast: true, testSeed: 14, manualClock: true });
    const code = host.room.roomId;
    const room = localRoom(code)!;
    const guest = await join(code, { nickname: "Jale", character: "sef" });
    const guestId = guest.room.sessionId;
    await waitFor("2 players", () => host.room.state.players.size === 2);
    guest.room.send("ready", { ready: true });
    await waitFor("ready", () => seen(host, guestId)?.ready === true);
    host.room.send("start", {});
    await waitMessage(guest, "matchStart");

    const add = vi.spyOn(BotDesk.prototype, "add").mockImplementationOnce(() => {
      throw new Error("test: stand-in failure");
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let back: Peer;
    try {
      const token = guest.room.reconnectionToken;
      guest.room.connection.close();
      await waitFor("dropped", () => seen(host, guestId)?.connected === false);
      await waitFor("stand-in tried", () => add.mock.calls.length > 0);
      expect(add).toHaveBeenCalledWith(guestId, roleForCharacter("sef"), { standIn: true });
      expect(quiet).toHaveBeenCalledWith(expect.stringContaining("dropPlayer failed"), expect.any(Error));
      back = adopt(await new Client(endpoint).reconnect<RaftStateView>(token)); // the grace runs all the same
      await waitMessage(back, "welcome", (w) => w.reconnected);
      await waitFor("reconnected", () => seen(host, guestId)?.connected === true);
    } finally {
      add.mockRestore();
      quiet.mockRestore();
    }

    // everyone leaves for good: bots finish the match, and nothing is left waiting to keep the room alive
    await leaveAll([host, back]);
    await waitFor("no client left", () => room.clients.length === 0);
    room.advance((EMPTY_ROOM_DISPOSE_SEC + 1) * 1000);
    await waitFor("empty room disposed", () => !localRoom(code));
  }, 60_000);

  it("a graceful server shutdown closes every client with CLOSE_CODE.SERVER_RESTART and gives the code back", async () => {
    const host = await create({ nickname: "Gül", fast: true, testSeed: 9 });
    const code = host.room.roomId;
    const guest = await join(code, { nickname: "Hakan" });
    await waitFor("2 players", () => host.room.state.players.size === 2);
    const closes: number[] = [];
    for (const p of [host, guest]) p.room.onLeave((closeCode) => closes.push(closeCode));

    localRoom(code)!.onBeforeShutdown();
    await waitFor("both closed", () => closes.length === 2);
    expect(closes).toEqual([CLOSE_CODE.SERVER_RESTART, CLOSE_CODE.SERVER_RESTART]);
    await waitFor("room disposed", () => !localRoom(code));
    expect(getRoomCodes().lookup(code)).toBeUndefined();
  }, 60_000);

  it("every human leaving mid-match ends it as abandoned; one log line per lifecycle transition", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("RAFT_LOG", "1");
    try {
      const host = await create({ nickname: "Ece", character: "sef", fast: true, testSeed: 6 });
      const code = host.room.roomId;
      await waitFor("host synced", () => me(host)?.nickname === "Ece");
      host.room.send("start", {});
      await waitMessage(host, "matchStart");
      const watcher = await join(code, { nickname: "Fikret" });
      await waitFor("spectating", () => me(watcher)?.spectator === true);

      await host.room.leave(true);
      const end = await waitMessage(watcher, "matchEnd");
      expect(end).toMatchObject({ reason: "abandoned", winnerTeam: -1, ticksLeft: 0 });
      expect(end.standings).toHaveLength(1 + SOLO_AUTO_BOTS);
      await waitFor("podium", () => watcher.room.state.phase === "matchEnd" && watcher.room.state.winReason === "abandoned");

      const lines = logLines(log, code);
      const events = lines.map((l) => String(l.event));
      for (const e of ["create", "firstJoin", "matchStart", "matchEnd"]) expect(events.filter((x) => x === e), e).toHaveLength(1);
      expect(events.indexOf("create")).toBeLessThan(events.indexOf("firstJoin"));
      expect(events.indexOf("firstJoin")).toBeLessThan(events.indexOf("matchStart"));
      expect(events.indexOf("matchStart")).toBeLessThan(events.indexOf("matchEnd"));
      expect(lines.find((l) => l.event === "matchStart")).toMatchObject({ humans: 1, bots: SOLO_AUTO_BOTS });
      expect(lines.find((l) => l.event === "matchEnd")).toMatchObject({ reason: "abandoned", winnerTeam: -1 });
      const phases = lines.filter((l) => l.event === "phase").map((l) => `${String(l.from)}>${String(l.to)}`);
      expect(phases[0]).toBe("lobby>landing");
      expect(phases.at(-1)).toMatch(/>matchEnd$/);
      await leaveAll([watcher]);
    } finally {
      vi.stubEnv("RAFT_LOG", "");
      log.mockRestore();
    }
  }, 60_000);
});

describe("RaftRoom host & message hardening", () => {
  it("the host stays with the migrated host when the old one comes back; it returns only to an empty chair", async () => {
    const a = await create({ nickname: "Anıl", fast: true, testSeed: 12 });
    const code = a.room.roomId;
    const aId = a.room.sessionId;
    const b = await join(code, { nickname: "Berk" });
    const bId = b.room.sessionId;
    await waitFor("2 players", () => a.room.state.players.size === 2);

    const token = a.room.reconnectionToken;
    a.room.connection.close();
    await waitFor("Berk hosts", () => b.room.state.hostId === bId);
    await waitMessage(b, "notice", (n) => n.key === "host" && n.params?.n === "Berk");
    b.room.send("settings", { difficulty: "nightmare" });
    await waitFor("Berk's settings", () => b.room.state.settings.difficulty === "nightmare");

    const back = adopt(await new Client(endpoint).reconnect<RaftStateView>(token));
    await waitMessage(back, "welcome", (w) => w.reconnected);
    await waitMessage(b, "notice", (n) => n.key === "reconnected" && n.params?.n === "Anıl");
    expect(b.room.state.hostId).toBe(bId);
    back.room.send("settings", { difficulty: "vacation" });
    await waitMessage(back, "notice", (n) => n.key === "hostOnly");
    expect(b.room.state.settings.difficulty).toBe("nightmare");
    expect(all(b, "notice", (n) => n.key === "host")).toHaveLength(1);

    // Berk leaves for good: the chair is empty, Anıl gets it
    await b.room.leave(true);
    await waitFor("Anıl hosts again", () => back.room.state.hostId === aId);
    await waitMessage(back, "notice", (n) => n.key === "host" && n.params?.n === "Anıl");
    await leaveAll([back]);
  }, 60_000);

  it("a world reject reaches only its actor; a human's craft / chest messages spend a per-kind action budget (manual clock)", async () => {
    const host = await create({ nickname: "Cem", character: "kaptan", fast: true, testSeed: 21, manualClock: true });
    const code = host.room.roomId;
    const room = localRoom(code)!;
    const guest = await join(code, { nickname: "Dila", character: "gelin" });
    const hostId = host.room.sessionId;
    const guestId = guest.room.sessionId;
    await waitFor("2 players", () => host.room.state.players.size === 2);
    guest.room.send("ready", { ready: true });
    await waitFor("ready", () => seen(host, guestId)?.ready === true);
    host.room.send("start", {});
    await waitMessage(host, "matchStart");
    await waitFor("alive", () => me(host)?.alive === true && me(guest)?.alive === true);
    const rejects = (p: Peer) => all(p, "reject");
    // Exact counts: what reached the world per player, and every message the room took in (its flood budget sees
    // each one first), so "sent N, handled N" is a barrier that spends no room time.
    const craft = vi.spyOn(RaftWorld.prototype, "craft");
    const chest = vi.spyOn(RaftWorld.prototype, "chest");
    const intake = vi.spyOn(MessageBudget.prototype, "take");
    const calls = (spy: { mock: { calls: unknown[][] } }, id: string) => spy.mock.calls.filter((c) => c[0] === id).length;
    async function burst(p: Peer, n: number, type: "craft" | "chest", msg: Record<string, unknown>): Promise<void> {
      const target = calls(intake, p.room.sessionId) + n;
      for (let i = 0; i < n; i++) p.room.send(type, msg);
      await waitFor(`${n} ${type} handled`, () => calls(intake, p.room.sessionId) >= target);
    }
    try {
      // one tick, 10 crafts ("hut" is duel-only: "locked" in co-op): the burst reaches the world, the rest doesn't
      await burst(host, 10, "craft", { recipe: "hut" });
      expect(calls(craft, hostId)).toBe(ACTION_BURST);
      room.advance(TICK_MS); // the next tick sends the world's events (the world may fold identical rejects)
      await waitFor("host's reject", () => rejects(host).length > 0);
      await flushed(host);
      await flushed(guest);
      expect(rejects(host).length).toBeLessThanOrEqual(ACTION_BURST);
      for (const r of rejects(host)) expect(r).toMatchObject({ type: "reject", playerId: hostId, action: "craft", reason: "locked" });
      expect(rejects(guest)).toHaveLength(0);

      // spent: nothing more until the next refill, then one per actionCooldownTicks (on later ticks too)
      room.advance((ACTION_COOLDOWN_TICKS - 2) * TICK_MS);
      await burst(host, 3, "craft", { recipe: "hut" });
      expect(calls(craft, hostId)).toBe(ACTION_BURST);
      room.advance(TICK_MS);
      await burst(host, 3, "craft", { recipe: "hut" });
      expect(calls(craft, hostId)).toBe(ACTION_BURST + 1);

      // chest is its own budget, per player: the host's spent crafts don't touch the guest's chest
      await burst(guest, 6, "chest", { op: "take", kind: "wood" });
      expect(calls(chest, guestId)).toBe(ACTION_BURST);

      // idle long enough and the whole burst is back
      room.advance(ACTION_BURST * ACTION_COOLDOWN_TICKS * TICK_MS);
      await burst(host, 10, "craft", { recipe: "hut" });
      expect(calls(craft, hostId)).toBe(2 * ACTION_BURST + 1);

      room.advance(EMOTE_COOLDOWN_TICKS * TICK_MS); // sends the rejects; the emote round trips may run again
      await flushed(host);
      await flushed(guest);
      expect(rejects(host).length).toBeLessThanOrEqual(2 * ACTION_BURST + 1);
      expect(rejects(host).every((r) => r.playerId === hostId && r.action === "craft")).toBe(true);
      expect(rejects(guest).length).toBeGreaterThan(0);
      expect(rejects(guest).length).toBeLessThanOrEqual(ACTION_BURST);
      expect(rejects(guest).every((r) => r.playerId === guestId && r.action === "chest")).toBe(true);
    } finally {
      craft.mockRestore();
      chest.mockRestore();
      intake.mockRestore();
    }
    await leaveAll([host, guest]);
  }, 60_000);

  it("a client flooding messages is cut off at its budget; everyone else (and the flooder, a second later) is served", async () => {
    const host = await create({ nickname: "Gül", fast: true, testSeed: 13 });
    const code = host.room.roomId;
    const flooder = await join(code, { nickname: "Hasan" });
    await waitFor("2 players", () => host.room.state.players.size === 2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const intake = vi.spyOn(MessageBudget.prototype, "take"); // calls through; records ok/drop/firstDrop per client
    vi.stubEnv("RAFT_LOG", "1");
    try {
      // Every non-host "start" costs a validation and earns a hostOnly notice — until the budget runs out. Enough
      // messages that even a slow (loaded) sender outruns the 120/s refill: to admit them all would take ~24 s.
      const id = flooder.room.sessionId;
      const sent = 12 * MESSAGE_BURST;
      for (let i = 0; i < sent; i++) flooder.room.send("start", {});
      await waitFor("every flood message reached the room", () => intake.mock.calls.filter((c) => c[0] === id).length >= sent);
      const verdicts = intake.mock.calls.flatMap((c, i) => (c[0] === id ? [intake.mock.results[i]!.value as "ok" | "drop" | "firstDrop"] : []));
      const admitted = verdicts.filter((v) => v === "ok").length;
      const firstDrops = verdicts.filter((v) => v === "firstDrop").length;
      expect(admitted).toBeGreaterThanOrEqual(MESSAGE_BURST);
      expect(admitted).toBeLessThan(sent); // the budget really cut the flood off
      expect(firstDrops).toBeGreaterThanOrEqual(1);

      // Each admitted message is served exactly once; nothing dropped reaches the room.
      await waitFor("every admitted message served", () => all(flooder, "notice", (n) => n.key === "hostOnly").length >= admitted);
      const served = all(flooder, "notice", (n) => n.key === "hostOnly").length;
      expect(served).toBe(admitted);
      // One flood log line per firstDrop verdict (rate-limited to one per DROP_LOG_MS), all for this client.
      const floodLogs = logLines(warn, code).filter((l) => l.event === "flood" && l.client === id);
      expect(floodLogs).toHaveLength(firstDrops);

      host.room.send("settings", { difficulty: "vacation" });
      await waitFor("host still served", () => host.room.state.settings.difficulty === "vacation");

      await sleep(1000);
      flooder.room.send("addBot", {});
      await waitFor("served again", () => all(flooder, "notice", (n) => n.key === "hostOnly").length > served);
    } finally {
      vi.stubEnv("RAFT_LOG", "");
      intake.mockRestore();
      warn.mockRestore();
    }
    await leaveAll([host, flooder]);
  }, 60_000);
});

describe("RaftRoom notices", () => {
  /**
   * A self-contained tour that makes the room emit one of every notice this file checks. It owns its rooms and
   * clients, so the notice contract is exercised even when this test runs alone (`-t`) or an earlier test failed.
   */
  async function noticeTour(): Promise<Peer[]> {
    const tour: Peer[] = [];

    // Solo start (soloBots), then the lobby bot limit and its notices.
    const solo = await create({ nickname: "Tur Solo", fast: true, testSeed: 91, manualClock: true });
    tour.push(solo);
    solo.room.send("start", {});
    await waitMessage(solo, "notice", (n) => n.key === "soloBots");
    await leaveAll([solo]);

    const bots = await create({ nickname: "Tur Bot", fast: true, testSeed: 92, manualClock: true });
    tour.push(bots);
    bots.room.send("addBot", {});
    await waitMessage(bots, "notice", (n) => n.key === "botAdded");
    await waitFor("tour bot seated", () => [...bots.room.state.players.values()].some((p) => p.bot));
    const botId = [...bots.room.state.players.values()].find((p) => p.bot)!.id;
    bots.room.send("removeBot", { id: botId });
    await waitMessage(bots, "notice", (n) => n.key === "botRemoved");
    for (let i = 0; i < MAX_BOTS; i++) bots.room.send("addBot", {});
    await waitFor("tour bots full", () => [...bots.room.state.players.values()].filter((p) => p.bot).length === MAX_BOTS);
    bots.room.send("addBot", {});
    await waitMessage(bots, "notice", (n) => n.key === "tooManyBots");
    await leaveAll([bots]);

    // Two humans: host-only / duel / lazy-start notices, then a match with a spectator and a takeover.
    const host = await create({ nickname: "Tur Host", character: "kaptan", fast: true, testSeed: 93, manualClock: true });
    const code = host.room.roomId;
    const room = localRoom(code)!;
    tour.push(host);
    const guest = await join(code, { nickname: "Tur Guest", character: "sef" });
    tour.push(guest);
    await waitFor("tour pair", () => host.room.state.players.size === 2);

    guest.room.send("settings", { difficulty: "vacation" });
    await waitMessage(guest, "notice", (n) => n.key === "hostOnly");
    host.room.send("settings", { mode: "duel" });
    await waitMessage(host, "notice", (n) => n.key === "duelLocked");
    host.room.send("start", {});
    await waitMessage(host, "notice", (n) => n.key === "cantStartLazyOne");

    guest.room.send("ready", { ready: true });
    await waitFor("tour ready", () => seen(host, guest.room.sessionId)?.ready === true);
    host.room.send("start", {});
    await waitMessage(guest, "matchStart");

    const late = await join(code, { nickname: "Tur Late", character: "amca" });
    tour.push(late);
    await waitMessage(late, "notice", (n) => n.key === "spectatingYou");

    const hostId = host.room.sessionId;
    const guestId = guest.room.sessionId;
    await host.room.leave(true);
    await waitMessage(guest, "notice", (n) => n.key === "tookOver" && n.params?.n === "Tur Host");
    await waitFor("tour takeover synced", () => seen(guest, hostId)?.bot === true);
    await waitMessage(guest, "notice", (n) => n.key === "host" && n.params?.n === "Tur Guest");
    await waitFor("tour host moved", () => guest.room.state.hostId === guestId);

    const token = guest.room.reconnectionToken;
    guest.room.connection.close();
    await waitMessage(late, "notice", (n) => n.key === "reconnecting" && n.params?.n === "Tur Guest");
    const back = adopt(await new Client(endpoint).reconnect<RaftStateView>(token));
    tour.push(back);
    await waitMessage(late, "notice", (n) => n.key === "reconnected" && n.params?.n === "Tur Guest");

    await playToPodium(room);
    back.room.send("rematch", { ready: true });
    await waitMessage(back, "notice", (n) => n.key === "rematch");
    await leaveAll([late, back]);
    return tour;
  }

  it("every notice carries a key of client/src/i18n/strings/server.ts and its filled English line", async () => {
    const tour = await noticeTour();
    const received = [...allNotices, ...tour.flatMap((p) => all(p, "notice"))];
    expect(received.length).toBeGreaterThan(10);
    const keys = new Set<string>();
    for (const n of received) {
      expect(serverStrings, n.key).toHaveProperty(n.key);
      const line = serverStrings[n.key as keyof typeof serverStrings];
      expect(n.text).toBe(fill(line, n.params ?? {}));
      keys.add(n.key);
    }
    for (const k of ["hostOnly", "duelLocked", "cantStartLazyOne", "soloBots", "reconnecting", "reconnected", "tookOver", "host", "spectatingYou", "rematch", "botAdded", "botRemoved", "tooManyBots"]) {
      expect(keys.has(k), k).toBe(true);
    }
  }, 60_000);

  it("notice keys of every client actually received are known (sanity on the inbox helper)", async () => {
    const host = await create({ nickname: "Tur Kontrol", fast: true, testSeed: 94, manualClock: true });
    const guest = await join(host.room.roomId, { nickname: "Tur Konuk", character: "sef" });
    await waitMessage(host, "notice", (n) => n.key.startsWith("joined"));
    for (const p of [host, guest]) for (const k of noticeKeys(p)) expect(Object.keys(serverStrings)).toContain(k);
    await leaveAll([host, guest]);
  }, 60_000);
});
