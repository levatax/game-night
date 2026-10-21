// Net facade tests against a fake colyseus.js (no server): join flow and event order, island + mismatch, ping,
// prediction lifecycle / wantsInput, predicted throws (coconut ball, torch plant), remote players / monsters,
// the match clock, error mapping, the welcome handshake + protocol version check (state first, then the welcome,
// as Colyseus sends them), automatic reconnection (1000 included) with the world frozen meanwhile, and final
// closes. Owner: client-net.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERP_DELAY_MS, RECONNECT_STORAGE_KEY, TICK_MS, timingsFor } from "../../../shared/constants";
import { BTN, MSG, PROTOCOL_VERSION } from "../../../shared/protocol";
import type { MonsterView, PlayerView, ProjectileView, RaftStateView, StructureView } from "../../../shared/types";
import { cmd, monsterView, playerView, spawnPlayer, testIsland } from "./testkit";

/* ---------------------------------------------------------------- fakes */

const fake = vi.hoisted(() => {
  type Handler = (payload: unknown) => void;
  class FakeRoom {
    readonly sent: { type: string; msg: unknown }[] = [];
    readonly connection = { isOpen: true };
    private readonly handlers = new Map<string, Handler>();
    private stateCb: ((s: unknown) => void) | null = null;
    private leaveCb: ((code: number) => void) | null = null;
    constructor(
      public sessionId: string,
      public roomId: string,
      public reconnectionToken: string,
    ) {}
    onMessage(type: string, cb: Handler): void {
      this.handlers.set(type, cb);
    }
    onStateChange(cb: (s: unknown) => void): void {
      this.stateCb = cb;
    }
    onLeave(cb: (code: number) => void): void {
      this.leaveCb = cb;
    }
    send(type: string, msg: unknown): void {
      this.sent.push({ type, msg });
    }
    async leave(): Promise<number> {
      this.connection.isOpen = false;
      this.leaveCb?.(4000);
      return 4000;
    }
    removeAllListeners(): void {
      this.handlers.clear();
    }
    /* test helpers */
    message(type: string, payload: unknown): void {
      this.handlers.get(type)?.(payload);
    }
    patch(state: unknown): void {
      this.stateCb?.(state);
    }
    drop(code: number): void {
      this.connection.isOpen = false;
      this.leaveCb?.(code);
    }
    sentOf(type: string): unknown[] {
      return this.sent.filter((s) => s.type === type).map((s) => s.msg);
    }
  }
  const hub = {
    rooms: [] as FakeRoom[],
    /** Next result of create / joinById / reconnect (a room, or an error to reject with). */
    next: [] as (FakeRoom | Error)[],
    calls: [] as { method: string; arg: unknown }[],
  };
  const take = async (method: string, arg: unknown): Promise<FakeRoom> => {
    hub.calls.push({ method, arg });
    const n = hub.next.shift();
    if (!n) throw Object.assign(new Error("no room scripted"), { code: 4212 });
    if (n instanceof Error) throw n;
    hub.rooms.push(n);
    return n;
  };
  class Client {
    constructor(public endpoint: string) {}
    create(name: string, opts: unknown): Promise<FakeRoom> {
      return take("create", { name, opts });
    }
    joinById(id: string, opts: unknown): Promise<FakeRoom> {
      return take("joinById", { id, opts });
    }
    reconnect(token: string): Promise<FakeRoom> {
      return take("reconnect", token);
    }
  }
  return { FakeRoom, Client, hub };
});

vi.mock("colyseus.js", () => ({ Client: fake.Client }));
// A flat hand-made island for every seed, so movement / throws don't depend on the procedural generator (Net only
// reaches generateIsland, through islandCache.ts).
vi.mock("../../../shared/island/generate", async () => {
  const kit = await import("./testkit");
  return { generateIsland: (seed: number, layout: "solo" | "duel" = "solo") => ({ ...kit.testIsland({ seed }), seed, layout }) };
});

const { Net } = await import("./Net");
type NetT = InstanceType<typeof Net>;
type FakeRoomT = InstanceType<typeof fake.FakeRoom>;

/* --------------------------------------------------------------- helpers */

interface TestState extends RaftStateView {
  players: Map<string, PlayerView>;
  projectiles: Map<string, ProjectileView>;
  monsters: Map<string, MonsterView>;
  structures: Map<string, StructureView>;
}

function makeState(over: Partial<RaftStateView> = {}): TestState {
  return {
    phase: "lobby",
    tick: 100,
    phaseTicksLeft: 0,
    clockTicks: 0,
    day: 0,
    dayPhase: "day",
    weather: "clear",
    seed: 7,
    layout: "solo",
    biome: "tropic",
    fast: false,
    difficulty: "normal",
    hostId: "me",
    settings: { mode: "coop", difficulty: "normal", seed: 0 },
    players: new Map(),
    projectiles: new Map(),
    monsters: new Map(),
    structures: new Map(),
    nodes: [],
    teams: [],
    launchTicksLeft: 0,
    winnerTeam: -1,
    winReason: "",
    ...over,
  } as TestState;
}

function addPlayer(state: TestState, id: string, fields: Partial<PlayerView> = {}, alive = false): PlayerView {
  const sim = spawnPlayer(0, 0, 0);
  sim.alive = alive;
  const p = playerView(sim, 0, { id, nickname: id, ...fields });
  state.players.set(id, p);
  return p;
}

const island7 = testIsland({ seed: 7 });
function welcomeMsg(over: Partial<{ seed: number; gridHash: number; defHash: number; tick: number; protocol: number }> = {}) {
  return {
    protocol: over.protocol ?? PROTOCOL_VERSION,
    code: "ABCD",
    sessionId: "me",
    tick: over.tick ?? 100,
    tickRate: 30,
    fast: false,
    reconnected: false,
    seed: over.seed ?? 7,
    layout: "solo" as const,
    gridHash: over.gridHash ?? island7.gridHash,
    defHash: over.defHash ?? island7.defHash,
  };
}

/** Record every event in order (name + payload). */
function record(net: NetT): { name: string; payload: unknown }[] {
  const log: { name: string; payload: unknown }[] = [];
  for (const name of ["connected", "island", "playerAdded", "playerRemoved", "phase", "state", "reconnecting", "disconnected", "welcome", "throw"] as const) {
    net.events.on(name, (payload: unknown) => log.push({ name, payload }));
  }
  return log;
}

/** A (re)join lands in the real server's order: Colyseus sends the full state, then the welcome queued meanwhile. */
function land(room: FakeRoomT, state: unknown, welcome: object = welcomeMsg()): void {
  room.patch(state);
  room.message(MSG.WELCOME, welcome);
}

/** Create a room as "me" and land it (first patch, then the welcome); returns the fake room and the state. */
async function connect(net: NetT, state = makeState()): Promise<{ room: FakeRoomT; state: TestState }> {
  const room = new fake.FakeRoom("me", "ABCD", "ABCD:tok");
  fake.hub.next.push(room);
  const done = net.createRoom({ nickname: "Me", character: "kaptan" });
  await vi.waitFor(() => expect(fake.hub.rooms).toContain(room));
  if (!state.players.has("me")) addPlayer(state, "me");
  land(room, state);
  await done;
  return { room, state };
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

beforeEach(() => {
  fake.hub.rooms.length = 0;
  fake.hub.next.length = 0;
  fake.hub.calls.length = 0;
  vi.stubGlobal("sessionStorage", memoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ----------------------------------------------------------------- tests */

describe("Net join flow", () => {
  it("resolves on the first state and emits connected → island → playerAdded → phase → state", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    const { state } = await connect(net);
    expect(net.status).toBe("connected");
    expect(net.code).toBe("ABCD");
    expect(net.sessionId).toBe("me");
    expect(net.state).toBe(state);
    expect(net.me?.id).toBe("me");
    expect(net.isHost).toBe(true);
    expect(net.island?.seed).toBe(7);
    expect(net.cover).not.toBeNull();
    const order = log.map((e) => e.name).filter((n) => n !== "welcome");
    expect(order).toEqual(["connected", "island", "playerAdded", "phase", "state"]);
    expect(log.find((e) => e.name === "island")?.payload).toEqual({ seed: 7, layout: "solo", mismatch: false });
    expect(log.find((e) => e.name === "phase")?.payload).toEqual({ phase: "lobby", previous: "lobby" });
    expect(JSON.parse(sessionStorage.getItem(RECONNECT_STORAGE_KEY)!)).toEqual({ roomId: "ABCD", token: "ABCD:tok" });
    net.dispose();
  });

  it("flags an island mismatch from the welcome's hashes", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { room } = await connect(net);
    room.message(MSG.WELCOME, welcomeMsg({ seed: 9, gridHash: 1 }));
    expect(log.filter((e) => e.name === "island").map((e) => e.payload)).toEqual([
      { seed: 7, layout: "solo", mismatch: false },
      { seed: 9, layout: "solo", mismatch: true },
    ]);
    expect(net.island?.seed).toBe(9);
    warn.mockRestore();
    net.dispose();
  });

  it("follows state.seed changes in the lobby", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    const { room, state } = await connect(net);
    state.seed = 4471;
    state.tick++;
    room.patch(state);
    expect(net.island?.seed).toBe(4471);
    expect(log.filter((e) => e.name === "island").length).toBe(2);
    net.dispose();
  });

  it("answers pings at once and re-emits server messages", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const { room } = await connect(net);
    const notices: unknown[] = [];
    net.events.on("notice", (n) => notices.push(n));
    room.message(MSG.PING, { t: 12345, tick: 130 });
    expect(room.sentOf(MSG.PONG)).toEqual([{ t: 12345 }]);
    room.message(MSG.NOTICE, { key: "hostLeft", text: "Host left" });
    expect(notices).toEqual([{ key: "hostLeft", text: "Host left" }]);
    net.send(MSG.READY, { ready: true });
    expect(room.sentOf(MSG.READY)).toEqual([{ ready: true }]);
    net.dispose();
  });

  it("maps join failures to NetErrors with menu.err* keys", async () => {
    const net = new Net({ endpoint: "ws://test" });
    fake.hub.next.push(Object.assign(new Error('room "ZZZZ" not found'), { code: 4212 }));
    await expect(net.joinRoom("zzzz", { nickname: "Me", character: "kaptan" })).rejects.toEqual({ kind: "notFound", message: "menu.errNotFound" });
    expect(fake.hub.calls[0]).toEqual({ method: "joinById", arg: { id: "ZZZZ", opts: { nickname: "Me", character: "kaptan", protocol: PROTOCOL_VERSION } } });
    expect(net.status).toBe("idle");
    fake.hub.next.push(Object.assign(new Error("Room full"), { code: 4401 }));
    await expect(net.joinRoom("ABCD", { nickname: "Me", character: "kaptan" })).rejects.toEqual({ kind: "roomFull", message: "menu.errRoomFull" });
    fake.hub.next.push(Object.assign(new Error("The game was updated, reload the page"), { code: 4406 }));
    await expect(net.joinRoom("ABCD", { nickname: "Me", character: "kaptan" })).rejects.toEqual({ kind: "outdated", message: "menu.errOutdated" });
    net.dispose();
  });
});

describe("Net protocol version", () => {
  it("sends PROTOCOL_VERSION with create (and join, above)", async () => {
    const net = new Net({ endpoint: "ws://test" });
    await connect(net);
    expect(fake.hub.calls[0]).toEqual({ method: "create", arg: { name: "raft_rush", opts: { nickname: "Me", character: "kaptan", protocol: PROTOCOL_VERSION } } });
    net.dispose();
  });

  it("holds the first state until the welcome; without one the join completes after a short wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    const room = new fake.FakeRoom("me", "ABCD", "ABCD:tok");
    fake.hub.next.push(room);
    const done = net.createRoom({ nickname: "Me", character: "kaptan" });
    await vi.waitFor(() => expect(fake.hub.rooms).toContain(room));
    const state = makeState();
    addPlayer(state, "me");
    room.patch(state);
    room.patch(state);
    expect(net.status).toBe("connecting");
    expect(net.state).toBeNull();
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(net.status).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toBeUndefined();
    expect(net.status).toBe("connected");
    expect(log.map((e) => e.name)).toEqual(["connected", "island", "playerAdded", "phase", "state"]);
    net.dispose();
  });

  it("fails the join outdated and leaves when the welcome after the first state carries another version", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    const room = new fake.FakeRoom("me", "ABCD", "ABCD:tok");
    fake.hub.next.push(room);
    const done = net.createRoom({ nickname: "Me", character: "kaptan" });
    await vi.waitFor(() => expect(fake.hub.rooms).toContain(room));
    const state = makeState();
    addPlayer(state, "me");
    land(room, state, welcomeMsg({ protocol: PROTOCOL_VERSION + 1 }));
    await expect(done).rejects.toEqual({ kind: "outdated", message: "menu.errOutdated" });
    expect(room.connection.isOpen).toBe(false);
    expect(net.status).toBe("idle");
    expect(log).toEqual([]); // never `connected`, and the refused welcome isn't re-emitted
    expect(sessionStorage.getItem(RECONNECT_STORAGE_KEY)).toBeNull();
    net.dispose();
  });

  it("accepts a welcome without a protocol field (a server from before versioning)", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const room = new fake.FakeRoom("me", "ABCD", "ABCD:tok");
    fake.hub.next.push(room);
    const done = net.createRoom({ nickname: "Me", character: "kaptan" });
    await vi.waitFor(() => expect(fake.hub.rooms).toContain(room));
    const { protocol: _drop, ...legacy } = welcomeMsg();
    void _drop;
    const state = makeState();
    addPlayer(state, "me");
    land(room, state, legacy);
    await expect(done).resolves.toBeUndefined();
    expect(net.status).toBe("connected");
    net.dispose();
  });

  it("a welcome ahead of the first state works too", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const room = new fake.FakeRoom("me", "ABCD", "ABCD:tok");
    fake.hub.next.push(room);
    const done = net.createRoom({ nickname: "Me", character: "kaptan" });
    await vi.waitFor(() => expect(fake.hub.rooms).toContain(room));
    room.message(MSG.WELCOME, welcomeMsg());
    const state = makeState();
    addPlayer(state, "me");
    room.patch(state);
    await expect(done).resolves.toBeUndefined();
    expect(net.status).toBe("connected");
    net.dispose();
  });

  it("ends a running session outdated when a later welcome disagrees", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    const { room } = await connect(net);
    room.message(MSG.WELCOME, welcomeMsg({ protocol: PROTOCOL_VERSION + 1 }));
    expect(net.status).toBe("disconnected");
    expect(log.at(-1)).toEqual({ name: "disconnected", payload: { error: { kind: "outdated", message: "menu.errOutdated" } } });
    expect(room.connection.isOpen).toBe(false);
    expect(sessionStorage.getItem(RECONNECT_STORAGE_KEY)).toBeNull();
    expect(fake.hub.calls.filter((c) => c.method === "reconnect")).toHaveLength(0);
  });

  it("stops reconnecting at an outdated welcome, never reporting the reconnect as landed", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    const { room, state } = await connect(net);
    const again = new fake.FakeRoom("me", "ABCD", "ABCD:tok2");
    fake.hub.next.push(again);
    room.drop(1006);
    await vi.waitFor(() => expect(fake.hub.rooms).toContain(again));
    const before = log.length;
    land(again, state, welcomeMsg({ protocol: PROTOCOL_VERSION + 1 }));
    await vi.waitFor(() => expect(net.status).toBe("disconnected"));
    expect(log.slice(before)).toEqual([{ name: "disconnected", payload: { error: { kind: "outdated", message: "menu.errOutdated" } } }]);
    expect(again.connection.isOpen).toBe(false);
    expect(fake.hub.calls.filter((c) => c.method === "reconnect")).toHaveLength(1);
  });

  it("tryReconnect() gives up at once on an outdated welcome", async () => {
    sessionStorage.setItem(RECONNECT_STORAGE_KEY, JSON.stringify({ roomId: "ABCD", token: "ABCD:old" }));
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    const room = new fake.FakeRoom("me", "ABCD", "ABCD:new");
    fake.hub.next.push(room);
    const pending = net.tryReconnect();
    await vi.waitFor(() => expect(fake.hub.rooms).toContain(room));
    const state = makeState();
    addPlayer(state, "me");
    land(room, state, welcomeMsg({ protocol: PROTOCOL_VERSION + 1 }));
    await expect(pending).resolves.toBe(false);
    expect(log).toEqual([]);
    expect(fake.hub.calls).toHaveLength(1);
    expect(net.status).toBe("idle");
    expect(sessionStorage.getItem(RECONNECT_STORAGE_KEY)).toBeNull();
  });
});

describe("Net prediction", () => {
  it("predicts only while the local player is an alive participant of a simulated phase", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const { room, state } = await connect(net);
    expect(net.wantsInput).toBe(false);
    expect(net.sendInput(cmd({ seq: 1, moveZ: 1 }))).toBeNull();
    expect(room.sentOf(MSG.INPUT)).toHaveLength(0);

    // Landing past the wake-up lock: alive and predicted.
    const t = timingsFor(false);
    state.phase = "landing";
    state.phaseTicksLeft = t.landing - t.landingLock - 1;
    const me = state.players.get("me")!;
    me.alive = true;
    state.tick++;
    room.patch(state);
    expect(net.wantsInput).toBe(true);
    expect(net.localSim).not.toBeNull();
    const z0 = net.localSim!.z;
    for (let seq = 1; seq <= 10; seq++) net.sendInput(cmd({ seq, moveZ: 1 }));
    expect(room.sentOf(MSG.INPUT)).toHaveLength(10);
    expect(net.localSim!.z).toBeLessThan(z0); // forward is -Z
    const frame = net.getLocalPlayer(1, { yaw: 0.5, pitch: 0.1 });
    expect(frame).toMatchObject({ id: "me", isLocal: true, yaw: 0.5, pitch: 0.1, character: "kaptan" });
    expect(frame!.speed).toBeGreaterThan(0);

    // Washed ashore: prediction stops.
    me.alive = false;
    me.washed = true;
    state.tick++;
    room.patch(state);
    expect(net.wantsInput).toBe(false);
    expect(net.localSim).toBeNull();
    expect(net.getLocalPlayer(0, { yaw: 0, pitch: 0 })?.washed).toBe(true);
    net.dispose();
  });

  it("doesn't treat a reloaded page's inputs as acknowledged by the seat's old lastSeq", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const state = makeState({ phase: "playing" });
    addPlayer(state, "me", { lastSeq: 9000 }, true);
    const { room } = await connect(net, state);
    for (let seq = 1; seq <= 6; seq++) net.sendInput(cmd({ seq, moveZ: 1 }));
    const predicted = net.localSim!.z;
    state.tick++;
    room.patch(state);
    // Without the guard every pending input would be dropped and the player would snap back to z = 0.
    expect(net.localSim!.z).toBeCloseTo(predicted, 9);
    expect(predicted).toBeLessThan(0);
    net.dispose();
  });

  it("spawns predicted projectiles for throws (3 for a coconut ball) and none for a planted torch", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const throws: unknown[] = [];
    net.events.on("localThrow", (e) => throws.push(e));
    const state = makeState({ phase: "playing" });
    addPlayer(state, "me", { inv0: "coconut_ball", cnt0: 1, inv1: "torch", cnt1: 1 }, true);
    const { room } = await connect(net, state);
    expect(net.wantsInput).toBe(true);
    let seq = 1;
    for (let i = 0; i < 12; i++) net.sendInput(cmd({ seq: seq++, buttons: BTN.THROW, pitch: 0.3 }));
    net.sendInput(cmd({ seq: seq++, pitch: 0.3 }));
    expect(throws).toHaveLength(1);
    const predicted = net.getProjectiles().filter((p) => p.predicted);
    expect(predicted.map((p) => p.kind)).toEqual(["coconut", "coconut", "coconut"]);
    expect(predicted.every((p) => p.ownerId === "me")).toBe(true);

    // The server's coconuts take the predictions over (ThrowEvent first, then the patch).
    const throwSeq = 13;
    const ids = ["p1", "p2", "p3"];
    room.message(MSG.THROW, { tick: 101, ownerId: "me", throwSeq, projectileIds: ids, kind: "coconut_ball", charge: 1, toss: false, origin: { x: 0, y: 2.4, z: 0 }, velocities: [] });
    ids.forEach((id, i) => {
      const f = predicted[i]!;
      state.projectiles.set(id, { id, x: f.x, y: f.y, z: f.z, vx: f.vx, vy: f.vy, vz: f.vz, state: "live", kind: "coconut", radius: 0.2, ageTicks: 1, restTicks: 0, bounces: 0, ownerId: "me", throwSeq, team: 0, charge: 1, baitTicks: 0 });
    });
    state.tick++;
    room.patch(state);
    expect(net.getProjectiles().map((p) => p.id)).toEqual(ids);

    // Recover, switch to the torch, Q: planted (a structure on the server), no flying torch.
    for (let i = 0; i < 10; i++) net.sendInput(cmd({ seq: seq++ }));
    net.sendInput(cmd({ seq: seq++, buttons: BTN.SLOT2 }));
    net.sendInput(cmd({ seq: seq++, buttons: BTN.DROP }));
    expect(throws).toHaveLength(2);
    expect(net.getProjectiles().filter((p) => p.predicted)).toHaveLength(0);
    net.dispose();
  });

  it("estimates the landing unlock from the server clock", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const t = timingsFor(false);
    // Still locked for 60 ticks: an input sent now is predicted locked (no movement).
    const state = makeState({ phase: "landing", phaseTicksLeft: t.landing - t.landingLock + 60 });
    addPlayer(state, "me", {}, true);
    await connect(net, state);
    const z0 = net.localSim!.z;
    for (let seq = 1; seq <= 5; seq++) net.sendInput(cmd({ seq, moveZ: 1 }));
    expect(net.localSim!.z).toBe(z0);
    net.dispose();
  });

  it("predicts inputs that will reach the server after the wake-up unlock as unlocked", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const t = timingsFor(false);
    // The lock ends 1 tick after this patch; with a 200 ms RTT an input sent now arrives ~3 ticks later.
    const state = makeState({ phase: "landing", phaseTicksLeft: t.landing - t.landingLock + 1 });
    addPlayer(state, "me", { ping: 200 }, true);
    const { room } = await connect(net, state);
    const z0 = net.localSim!.z;
    for (let seq = 1; seq <= 5; seq++) net.sendInput(cmd({ seq, moveZ: 1 }));
    const moved = net.localSim!.z;
    expect(moved).toBeLessThan(z0);
    // A patch from before the unlock replays them with the lock they were predicted with.
    state.tick++;
    room.patch(state);
    expect(net.localSim!.z).toBeCloseTo(moved, 9);
    net.dispose();
  });
});

describe("Net remote players, monsters and clocks", () => {
  it("interpolates other players (spectators excluded) and monsters", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const state = makeState({ phase: "playing" });
    addPlayer(state, "me", {}, true);
    addPlayer(state, "bob", { seat: 1, bot: true }, true);
    addPlayer(state, "spec", { spectator: true });
    state.monsters.set("m1", monsterView({ id: "m1", kind: "boss", x: 3, z: 3 }));
    await connect(net, state);
    const now = performance.now();
    net.update(now, 0.016);
    expect(net.getRemotePlayers(now).map((p) => [p.id, p.isLocal, p.seat, p.bot])).toEqual([["bob", false, 1, true]]);
    expect(net.getMonsters(now).map((m) => [m.id, m.kind, m.x])).toEqual([["m1", "boss", 3]]);
    net.dispose();
  });

  it("advances clockTicks smoothly while playing and freezes it otherwise", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const net = new Net({ endpoint: "ws://test" });
    const state = makeState({ phase: "playing", clockTicks: 300, tick: 1000 });
    addPlayer(state, "me", {}, true);
    const { room } = await connect(net, state);
    const start = net.clockTicksAt(performance.now());
    expect(start).toBeGreaterThanOrEqual(300);
    vi.advanceTimersByTime(TICK_MS * 6);
    expect(net.clockTicksAt(performance.now())).toBeCloseTo(start + 6, 3);
    expect(net.serverTickAt(performance.now())).toBeGreaterThan(1000);
    state.phase = "launch";
    state.tick += 6;
    state.clockTicks = 306;
    room.patch(state);
    vi.advanceTimersByTime(TICK_MS * 6);
    expect(net.clockTicksAt(performance.now())).toBeCloseTo(306, 3);
    net.dispose();
  });
});

describe("Net reconnection", () => {
  it("reconnects automatically after an unexpected close and keeps the roster", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    const { room, state } = await connect(net);
    const again = new fake.FakeRoom("me", "ABCD", "ABCD:tok2");
    fake.hub.next.push(again);
    room.drop(1006);
    expect(net.status).toBe("reconnecting");
    expect(net.state).toBe(state);
    await vi.waitFor(() => expect(fake.hub.rooms).toContain(again));
    expect(fake.hub.calls.at(-1)).toEqual({ method: "reconnect", arg: "ABCD:tok" });
    state.tick += 30;
    land(again, state);
    await vi.waitFor(() => expect(net.status).toBe("connected"));
    const names = log.map((e) => e.name);
    expect(names).toContain("reconnecting");
    expect(log.filter((e) => e.name === "connected").at(-1)?.payload).toEqual({ code: "ABCD", sessionId: "me", reconnected: true });
    // Same players: no duplicate playerAdded after the reconnect.
    expect(log.filter((e) => e.name === "playerAdded")).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(RECONNECT_STORAGE_KEY)!).token).toBe("ABCD:tok2");
    net.dispose();
  });

  it("gives up when the room is gone", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    const { room } = await connect(net);
    fake.hub.next.push(Object.assign(new Error('room "ABCD" has been disposed.'), { code: 4212 }));
    room.drop(1006);
    await vi.waitFor(() => expect(net.status).toBe("disconnected"));
    expect(log.at(-1)).toEqual({ name: "disconnected", payload: { error: { kind: "notFound", message: "menu.errNotFound" } } });
    expect(sessionStorage.getItem(RECONNECT_STORAGE_KEY)).toBeNull();
    expect(net.state).toBeNull();
  });

  it("treats a consented server close as final (kicked)", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    const { room } = await connect(net);
    room.drop(4000);
    expect(net.status).toBe("disconnected");
    expect(log.at(-1)).toEqual({ name: "disconnected", payload: { error: { kind: "kicked", message: "menu.errKicked" } } });
    expect(fake.hub.calls.filter((c) => c.method === "reconnect")).toHaveLength(0);
  });

  it("treats a server-restart close (CLOSE_CODE.SERVER_RESTART) as final with its own message", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    const { room } = await connect(net);
    room.drop(4002);
    expect(net.status).toBe("disconnected");
    expect(log.at(-1)).toEqual({ name: "disconnected", payload: { error: { kind: "serverRestart", message: "menu.errServerRestart" } } });
    expect(fake.hub.calls.filter((c) => c.method === "reconnect")).toHaveLength(0);
    expect(sessionStorage.getItem(RECONNECT_STORAGE_KEY)).toBeNull();
  });

  it("retries a normal (1000) close like a network drop: a proxy restart is not a kick", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    const { room, state } = await connect(net);
    const again = new fake.FakeRoom("me", "ABCD", "ABCD:tok2");
    fake.hub.next.push(again);
    room.drop(1000);
    expect(net.status).toBe("reconnecting");
    await vi.waitFor(() => expect(fake.hub.rooms).toContain(again));
    expect(fake.hub.calls.at(-1)).toEqual({ method: "reconnect", arg: "ABCD:tok" });
    state.tick += 30;
    land(again, state);
    await vi.waitFor(() => expect(net.status).toBe("connected"));
    expect(log.some((e) => e.name === "disconnected")).toBe(false);
    net.dispose();
  });

  it("ends a 1000 close with serverDown when the ticket keeps failing for the whole grace", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    const { room } = await connect(net);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    for (let i = 0; i < 60; i++) fake.hub.next.push(new TypeError("Failed to fetch"));
    room.drop(1000);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(net.status).toBe("disconnected");
    expect(fake.hub.calls.filter((c) => c.method === "reconnect").length).toBeGreaterThan(2);
    expect(log.at(-1)).toEqual({ name: "disconnected", payload: { error: { kind: "serverDown", message: "menu.errServerDown" } } });
    expect(log.filter((e) => e.name === "reconnecting").map((e) => (e.payload as { attempt: number }).attempt).slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("freezes the world while reconnecting: clock, countdown ticks, remotes, monsters and projectiles hold still", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const net = new Net({ endpoint: "ws://test" });
    const state = makeState({ phase: "playing", clockTicks: 300, tick: 1000 });
    addPlayer(state, "me", {}, true);
    const bob = addPlayer(state, "bob", { seat: 1, vx: 3 }, true);
    state.monsters.set("m1", monsterView({ id: "m1", x: 0, z: 5 }));
    const { room } = await connect(net, state);
    // A few patches of bob and the crab walking +X, then a live coconut in the air.
    for (let i = 1; i <= 4; i++) {
      vi.advanceTimersByTime(TICK_MS * 2);
      state.tick += 2;
      bob.x += 0.2;
      state.monsters.get("m1")!.x += 0.2;
      room.patch(state);
    }
    state.projectiles.set("c1", { id: "c1", x: 0, y: 5, z: 0, vx: 4, vy: 0, vz: 0, state: "live", kind: "coconut", radius: 0.2, ageTicks: 3, restTicks: 0, bounces: 0, ownerId: "bob", throwSeq: 1, team: 0, charge: 1, baitTicks: 0 });
    state.tick += 1;
    room.patch(state);
    const again = new fake.FakeRoom("me", "ABCD", "ABCD:tok2"); // reconnects, but its first state never comes
    fake.hub.next.push(again);
    room.drop(1006);
    expect(net.status).toBe("reconnecting");

    const read = () => {
      const now = performance.now();
      net.update(now, 0.25);
      const bobFrame = net.getRemotePlayers(now).find((p) => p.id === "bob")!;
      const crab = net.getMonsters(now)[0]!;
      const coconut = net.getProjectiles().find((p) => p.id === "c1")!;
      return { tick: net.serverTickAt(now), clock: net.clockTicksAt(now), bobX: bobFrame.x, bobSpeed: bobFrame.speed, crabX: crab.x, crabSpeed: crab.speed, coconutX: coconut.x };
    };
    const atDrop = read();
    await vi.waitFor(() => expect(fake.hub.rooms).toContain(again));
    vi.advanceTimersByTime(5000);
    const later = read();
    expect(net.status).toBe("reconnecting");
    expect(later).toEqual(atDrop);
    expect(later.bobSpeed).toBe(0);
    expect(later.crabSpeed).toBe(0);
    // Never past the newest patch: nobody is extrapolated.
    expect(later.tick).toBeLessThanOrEqual(state.tick + INTERP_DELAY_MS / TICK_MS + 1e-9);
    expect(later.bobX).toBeLessThanOrEqual(bob.x + 1e-9);
    net.dispose();
  });

  it("a stalled feed before the drop doesn't leave the frozen world extrapolated", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const net = new Net({ endpoint: "ws://test" });
    const state = makeState({ phase: "playing", clockTicks: 300, tick: 1000 });
    addPlayer(state, "me", {}, true);
    const bob = addPlayer(state, "bob", { seat: 1, vx: 6 }, true);
    const { room } = await connect(net, state);
    vi.advanceTimersByTime(TICK_MS * 2);
    state.tick += 2;
    bob.x += 0.4;
    room.patch(state);
    // The socket goes silent for 2 s before the close is noticed.
    vi.advanceTimersByTime(2000);
    room.drop(1006);
    const now = performance.now();
    expect(net.serverTickAt(now)).toBeCloseTo(state.tick + INTERP_DELAY_MS / TICK_MS, 6);
    expect(net.getRemotePlayers(now).find((p) => p.id === "bob")!.x).toBeCloseTo(bob.x, 6);
    expect(net.clockTicksAt(now)).toBeLessThanOrEqual(300 + 15);
    net.dispose();
  });

  it("the clock runs again once the reconnect lands", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const net = new Net({ endpoint: "ws://test" });
    const state = makeState({ phase: "playing", clockTicks: 300, tick: 1000 });
    addPlayer(state, "me", {}, true);
    const { room } = await connect(net, state);
    const again = new fake.FakeRoom("me", "ABCD", "ABCD:tok2");
    fake.hub.next.push(again);
    room.drop(1006);
    const frozen = net.clockTicksAt(performance.now());
    await vi.waitFor(() => expect(fake.hub.rooms).toContain(again));
    vi.advanceTimersByTime(3000);
    expect(net.clockTicksAt(performance.now())).toBe(frozen);
    state.tick += 90;
    state.clockTicks += 90;
    land(again, state);
    await vi.waitFor(() => expect(net.status).toBe("connected"));
    const back = net.clockTicksAt(performance.now());
    expect(back).toBeGreaterThanOrEqual(390);
    vi.advanceTimersByTime(TICK_MS * 6);
    expect(net.clockTicksAt(performance.now())).toBeCloseTo(back + 6, 3);
    net.dispose();
  });

  it("leave() is consented: no reconnect, ticket cleared, disconnected with no error", async () => {
    const net = new Net({ endpoint: "ws://test" });
    const log = record(net);
    await connect(net);
    await net.leave();
    expect(net.status).toBe("disconnected");
    expect(log.at(-1)).toEqual({ name: "disconnected", payload: { error: null } });
    expect(sessionStorage.getItem(RECONNECT_STORAGE_KEY)).toBeNull();
    expect(fake.hub.calls.filter((c) => c.method === "reconnect")).toHaveLength(0);
  });

  it("tryReconnect() rejoins the stored room after a reload", async () => {
    sessionStorage.setItem(RECONNECT_STORAGE_KEY, JSON.stringify({ roomId: "ABCD", token: "ABCD:old" }));
    const net = new Net({ endpoint: "ws://test" });
    const room = new fake.FakeRoom("me", "ABCD", "ABCD:new");
    fake.hub.next.push(room);
    const pending = net.tryReconnect();
    await vi.waitFor(() => expect(fake.hub.rooms).toContain(room));
    const state = makeState();
    addPlayer(state, "me");
    land(room, state);
    await expect(pending).resolves.toBe(true);
    expect(fake.hub.calls[0]).toEqual({ method: "reconnect", arg: "ABCD:old" });
    expect(net.status).toBe("connected");
    net.dispose();
  });

  it("tryReconnect() resolves false without a ticket", async () => {
    const net = new Net({ endpoint: "ws://test" });
    await expect(net.tryReconnect()).resolves.toBe(false);
    expect(net.status).toBe("idle");
  });
});
