// End-to-end smoke test: a real Colyseus server in-process (random free port) with only Bonk Brawl
// registered through its hub entry, driven by colyseus.js clients from Node.
// Run: BONK_TEST=1 npx vitest run games/bonk-brawl/test/room-smoke.test.ts

import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client, type Room } from "colyseus.js";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRoomCodeRegistry } from "../../../server/roomCodes.js";
import type { GameManifest } from "../../../server/types.js";
import { CODE_PATTERN, FAST_TIMINGS, MAX_PLAYERS } from "../shared/constants.js";
import { BTN, JOIN_ERROR, ROOM_NAME, type InputCmd, type ServerMessages } from "../shared/protocol.js";
import type { BonkStateView, PlayerView } from "../shared/types.js";
import { GAME_ID } from "../server/hub.js";
import { register } from "../server/index.js";

// Fast timers are honored only with BONK_TEST=1 (set here too so the file also runs on its own).
process.env.BONK_TEST = "1";

const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST: GameManifest = {
  id: GAME_ID,
  title: "Bonk Brawl",
  tagline: "test",
  description: "test",
  players: { min: 2, max: 4 },
  duration: "~5 min",
  input: "Keyboard + mouse",
  tags: [],
  accent: "#FF5A5F",
  status: "live",
  rooms: [ROOM_NAME],
};

type BonkRoom = Room<BonkStateView>;
type MessageType = keyof ServerMessages;

/** A connected client plus every message it received. */
interface Player {
  room: BonkRoom;
  inbox: Array<{ type: string; msg: unknown }>;
  seq: number;
}

const codes = createRoomCodeRegistry();
const httpServer = http.createServer();
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }), gracefullyShutdown: false, greet: false });
let endpoint = "";
const connected: Player[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(label: string, probe: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(15);
  }
}

function adopt(room: BonkRoom): Player {
  const player: Player = { room, inbox: [], seq: 0 };
  room.onMessage("*", (type, msg) => player.inbox.push({ type: String(type), msg }));
  connected.push(player);
  return player;
}

function received<K extends MessageType>(p: Player, type: K, match?: (m: ServerMessages[K]) => boolean): ServerMessages[K] | undefined {
  for (const entry of p.inbox) {
    if (entry.type !== type) continue;
    const msg = entry.msg as ServerMessages[K];
    if (!match || match(msg)) return msg;
  }
  return undefined;
}

function waitMessage<K extends MessageType>(p: Player, type: K, match?: (m: ServerMessages[K]) => boolean): Promise<ServerMessages[K]> {
  return waitFor(`${type} message`, () => received(p, type, match));
}

function me(p: Player): PlayerView | undefined {
  return p.room.state.players?.get(p.room.sessionId);
}

async function create(options: Record<string, unknown>): Promise<Player> {
  return adopt(await new Client(endpoint).create<BonkStateView>(ROOM_NAME, options));
}

async function join(code: string, options: Record<string, unknown>): Promise<Player> {
  return adopt(await new Client(endpoint).joinById<BonkStateView>(code, options));
}

async function joinError(code: string, options: Record<string, unknown>): Promise<{ code: number; message: string }> {
  try {
    const room = await new Client(endpoint).joinById(code, options);
    await room.leave();
  } catch (err) {
    const e = err as { code?: number; message?: string };
    return { code: e.code ?? -1, message: e.message ?? "" };
  }
  throw new Error("join unexpectedly succeeded");
}

function sendInput(p: Player, partial: Partial<InputCmd>): void {
  p.seq++;
  const cmd: InputCmd = { seq: p.seq, moveX: 0, moveZ: 0, yaw: me(p)?.yaw ?? 0, pitch: 0, buttons: 0, ...partial };
  p.room.send("input", cmd);
}

beforeAll(async () => {
  register({ gameId: GAME_ID, gameDir: GAME_DIR, gameServer, app: express(), codes, manifest: MANIFEST });
  await gameServer.listen(0);
  endpoint = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  const open = connected.filter((p) => p.room.connection.isOpen);
  await Promise.all(open.map((p) => Promise.race([p.room.leave().catch(() => undefined), sleep(500)])));
  await gameServer.gracefullyShutdown(false);
}, 15_000);

describe("BonkRoom smoke test", () => {
  it("runs create → join by code → full room → lobby → countdown → playing → round end", async () => {
    // ------------------------------------------------------------------ create
    const alice = await create({ nickname: "  Alice\t", character: "quacky", fast: true });
    const code = alice.room.roomId;
    expect(code).toMatch(CODE_PATTERN);
    expect(codes.lookup(code)).toEqual({ gameId: GAME_ID });
    const welcome = await waitMessage(alice, "welcome");
    expect(welcome).toMatchObject({ code, sessionId: alice.room.sessionId, fast: true, reconnected: false, tickRate: 30 });
    await waitFor("host state", () => me(alice)?.nickname === "Alice" && alice.room.state.hostId === alice.room.sessionId);

    // ------------------------------------------------------- join validation
    expect(await joinError(code, { nickname: "Zed", character: "dragon" })).toMatchObject({ code: JOIN_ERROR.BAD_CHARACTER });
    expect(await joinError(code, { nickname: 42, character: "pip" })).toMatchObject({ code: JOIN_ERROR.BAD_NICKNAME });

    // ------------------------------------------------------------- join by id
    const bob = await join(code, { nickname: "Bob", character: "mochi" });
    const carol = await join(code, { nickname: "", character: undefined });
    const dave = await join(code, { nickname: "alice", character: "quacky" });
    await waitFor("4 players", () => alice.room.state.players.size === 4);
    const byId = (p: Player) => alice.room.state.players.get(p.room.sessionId);
    expect([alice, bob, carol, dave].map((p) => byId(p)?.slot)).toEqual([0, 1, 2, 3]);
    expect(byId(carol)).toMatchObject({ nickname: "Player 3", character: "hopsworth" });
    expect(byId(dave)).toMatchObject({ nickname: "alice 2", character: "quacky" });
    await waitMessage(alice, "notice", (n) => n.kind === "joined" && n.playerId === dave.room.sessionId);

    // -------------------------------------------------------------- room full
    const extras: Player[] = [];
    for (const nickname of ["Erin", "Finn", "Gus", "Hana"]) extras.push(await join(code, { nickname, character: "pip" }));
    await waitFor(`${MAX_PLAYERS} players`, () => alice.room.state.players.size === MAX_PLAYERS);
    expect(extras.map((p) => byId(p)?.slot)).toEqual([4, 5, 6, 7]);
    const full = await joinError(code, { nickname: "Eve", character: "pip" });
    expect(full.code === JOIN_ERROR.ROOM_FULL || (full.code === 4212 && /locked/.test(full.message))).toBe(true);

    for (const p of extras) await p.room.leave();
    await dave.room.leave();
    await waitFor("dave gone", () => alice.room.state.players.size === 3);

    // ------------------------------------------------------------------ lobby
    bob.room.send("character", { character: "pip" });
    bob.room.send("settings", { rounds: 3 });
    alice.room.send("settings", { rounds: 3, map: "bath", powerUps: false });
    await waitFor("settings", () => alice.room.state.settings.rounds === 3 && alice.room.state.mapId === "bath");
    await waitFor("character", () => byId(bob)?.character === "pip");
    expect(alice.room.state.settings.powerUps).toBe(false);

    alice.room.send("start", {});
    const cantStart = await waitMessage(alice, "notice", (n) => n.kind === "cantStart");
    expect(cantStart.text).toMatch(/ready/);

    for (const p of [alice, bob, carol]) p.room.send("ready", { ready: true });
    await waitFor("all ready", () => [alice, bob, carol].every((p) => byId(p)?.ready));
    bob.room.send("start", {});
    await sleep(100);
    expect(alice.room.state.phase).toBe("lobby");

    // ------------------------------------------------------- countdown → play
    alice.room.send("start", {});
    const roundStart = await waitMessage(bob, "roundStart");
    expect(roundStart).toMatchObject({ round: 1, totalRounds: 3, mapId: "bath" });
    expect([...roundStart.participants].sort()).toEqual([alice, bob, carol].map((p) => p.room.sessionId).sort());
    await waitMessage(bob, "countdown", (c) => c.n > 0);
    const goTick = await waitFor("countdown state", () => {
      const s = alice.room.state;
      return s.phase === "countdown" && s.phaseTicksLeft > 0 ? s.tick + s.phaseTicksLeft : 0;
    });
    await waitFor("balls dropped", () => alice.room.state.balls.size === 2);
    await waitFor("playing", () => alice.room.state.phase === "playing", 3000);
    expect(received(bob, "countdown", (c) => c.n === 0)?.tick).toBe(goTick);
    expect(alice.room.state.phaseTicksLeft).toBeGreaterThan(FAST_TIMINGS.ROUND_TICKS - 60);
    expect(me(alice)?.alive).toBe(true);

    // --------------------------------------------------------- inputs & acks
    const start = { x: me(alice)?.x ?? 0, z: me(alice)?.z ?? 0 };
    for (let i = 0; i < 20; i++) {
      sendInput(alice, { moveZ: 1 });
      await sleep(1000 / 30);
    }
    await waitFor("input acked", () => (me(alice)?.lastSeq ?? 0) >= 15);
    const moved = Math.hypot((me(alice)?.x ?? 0) - start.x, (me(alice)?.z ?? 0) - start.z);
    expect(moved).toBeGreaterThan(1);
    sendInput(alice, { buttons: BTN.CATCH });
    await waitMessage(bob, "whiff", (w) => w.playerId === alice.room.sessionId);

    carol.room.send("emote", { emote: "honk" });
    carol.room.send("emote", { emote: "honk" });
    await waitMessage(alice, "emote", (e) => e.playerId === carol.room.sessionId);
    await sleep(100);
    expect(alice.inbox.filter((m) => m.type === "emote")).toHaveLength(1);

    const ping = await waitMessage(alice, "ping");
    alice.room.send("pong", { t: ping.t });
    await waitFor("ping measured", () => (me(alice)?.ping ?? 0) >= 0 && received(alice, "ping") !== undefined);

    // ------------------------------------- leaving decides the round & match
    await alice.room.leave();
    const ko = await waitMessage(bob, "ko", (k) => k.cause === "disconnect");
    expect(ko.playerId).toBe(alice.room.sessionId);
    await waitFor("host migrated", () => bob.room.state.hostId === bob.room.sessionId);
    expect(received(bob, "notice", (n) => n.kind === "hostChanged")).toBeDefined();

    await carol.room.leave();
    const win = await waitMessage(bob, "roundWin");
    expect(win).toMatchObject({ round: 1, winnerId: bob.room.sessionId, nextRound: 0 });
    expect(win.roundPoints[bob.room.sessionId]).toBeGreaterThanOrEqual(3);
    const end = await waitMessage(bob, "matchEnd");
    expect(end.winnerId).toBe(bob.room.sessionId);
    expect(end.standings.map((s) => s.place)).toEqual([1]);
    await waitFor("podium", () => bob.room.state.phase === "matchEnd" && me(bob)?.place === 1);

    // ---------------------------------------------------------------- rematch
    await sleep(600);
    bob.room.send("rematch", { ready: true });
    await waitFor("back in lobby", () => bob.room.state.phase === "lobby");
    expect(me(bob)).toMatchObject({ ready: true, spectator: false, alive: false, character: "pip" });
    expect(bob.room.state.balls.size).toBe(0);
  }, 30_000);

  it("late joiners spectate until the lobby, and malformed messages never break the room", async () => {
    const host = await create({ nickname: "Host", character: "gruff", fast: true });
    const guest = await join(host.room.roomId, { nickname: "Guest", character: "whiskers" });
    for (const p of [host, guest]) p.room.send("ready", { ready: true });
    await waitFor("ready", () => host.room.state.players.size === 2 && [...host.room.state.players.values()].every((p) => p.ready));

    // Garbage payloads of every message type ("start" only from the non-host: any start from the
    // host is a valid start, since StartMsg carries no data).
    for (const p of [host, guest]) {
      const types = ["input", "ready", "character", "settings", "emote", "rematch", "pong", "nonsense"];
      for (const type of p === guest ? [...types, "start"] : types) {
        for (const payload of [null, 7, "x", [], { seq: "1" }, { ready: "yes" }, { character: 5 }, { t: Number.NaN }]) {
          p.room.send(type, payload);
        }
      }
    }
    await sleep(100);
    expect(host.room.state.phase).toBe("lobby");

    host.room.send("start", {});
    await waitFor("countdown", () => host.room.state.phase === "countdown" || host.room.state.phase === "playing");
    const late = await join(host.room.roomId, { nickname: "Late", character: "pip" });
    await waitMessage(late, "notice", (n) => n.kind === "spectating");
    await waitFor("late spectator", () => me(late)?.spectator === true);
    expect(me(late)?.alive).toBe(false);
    for (let i = 0; i < 10; i++) sendInput(guest, { seq: 1_000_000 + i, moveX: Number.POSITIVE_INFINITY });
    await sleep(100);
    expect(["countdown", "playing"]).toContain(host.room.state.phase);

    await guest.room.leave();
    await waitFor("match over", () => host.room.state.phase === "matchEnd", 5000);
    await sleep(600);
    late.room.send("rematch", { ready: false });
    await waitFor("lobby", () => host.room.state.phase === "lobby");
    expect(me(late)?.spectator).toBe(false);
  }, 30_000);
});
