// End-to-end smoke test through the hub entry: a real Colyseus server in-process (random free port) with only
// Raft Rush registered via server/index.ts register(), driven by a colyseus.js client from Node; server/index.ts
// health() reports the live room. Owner: server-room. Run: npx vitest run games/raft-rush/test/room-smoke.test.ts

import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client, type Room } from "colyseus.js";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRoomCodeRegistry } from "../../../server/roomCodes.js";
import type { GameManifest } from "../../../server/types.js";
import { BOT_NAMES, CODE_PATTERN, GAME_ID } from "../shared/constants.js";
import { generateIsland } from "../shared/island/generate.js";
import { ROOM_NAME, type ServerMessages } from "../shared/protocol.js";
import type { RaftStateView } from "../shared/types.js";
import { health, register } from "../server/index.js";
import { STALL_MS } from "../server/room/registry.js";

const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = JSON.parse(readFileSync(path.join(GAME_DIR, "game.json"), "utf8")) as GameManifest;

const codes = createRoomCodeRegistry();
const httpServer = http.createServer();
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }), greet: false });
let endpoint = "";
const rooms: Room<RaftStateView>[] = [];
const inbox: Array<{ type: string; msg: unknown }> = [];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(label: string, probe: () => T | null | undefined | false, timeoutMs = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(15);
  }
}
function received<K extends keyof ServerMessages>(type: K): ServerMessages[K] | undefined {
  return inbox.find((m) => m.type === type)?.msg as ServerMessages[K] | undefined;
}

beforeAll(async () => {
  // Fast timers / warp are honored only with RAFT_TEST=1 (stubbed, so it can't leak into other test files).
  vi.stubEnv("RAFT_TEST", "1");
  register({ gameId: GAME_ID, gameDir: GAME_DIR, gameServer, app: express(), codes, manifest: MANIFEST });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  endpoint = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await Promise.all(rooms.filter((r) => r.connection.isOpen).map((r) => Promise.race([r.leave(true).catch(() => undefined), sleep(500)])));
  await gameServer.gracefullyShutdown(false);
  vi.unstubAllEnvs();
}, 15_000);

describe("Raft Rush through the hub", () => {
  it("registers raft_rush, allocates a hub code and plays a bot-assisted fast match to the podium and back", async () => {
    expect(MANIFEST.rooms).toContain(ROOM_NAME);
    const room = await new Client(endpoint).create<RaftStateView>(ROOM_NAME, { nickname: "Smoke", character: "sef", fast: true, testSeed: 1, warp: 4 });
    rooms.push(room);
    room.onMessage("*", (type, msg) => inbox.push({ type: String(type), msg }));
    expect(room.roomId).toMatch(CODE_PATTERN);
    expect(codes.lookup(room.roomId)).toEqual({ gameId: GAME_ID });
    expect(health()).toMatchObject({ ok: true, rooms: 1, stalled: [] });

    const welcome = await waitFor("welcome", () => received("welcome"));
    expect(welcome.gridHash).toBe(generateIsland(welcome.seed, welcome.layout).gridHash);
    await waitFor("state", () => room.state.players?.size === 1);

    room.send("addBot", {});
    await waitFor("bot", () => room.state.players.size === 2);
    expect([...room.state.players.values()].find((p) => p.bot)?.nickname).toBe(BOT_NAMES[0]);

    room.send("start", {});
    const start = await waitFor("matchStart", () => received("matchStart"));
    expect(start.participants).toHaveLength(2);
    const end = await waitFor("matchEnd", () => received("matchEnd"), 30_000);
    expect(end.standings).toHaveLength(2);
    expect(["storm", "launched"]).toContain(end.reason);

    room.send("rematch", { ready: false });
    await waitFor("lobby", () => room.state.phase === "lobby");
    expect(room.state.players.size).toBe(2);

    const h = health();
    expect(h).toMatchObject({ ok: true, rooms: 1, stalled: [] });
    expect(h.maxTickAgeMs).toBeLessThan(STALL_MS);
  }, 45_000);
});
