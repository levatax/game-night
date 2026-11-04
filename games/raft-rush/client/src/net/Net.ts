// Networking facade: Colyseus connection, reconnect, clock sync, own-player prediction, remote / monster
// interpolation, projectile dead-reckoning, island generation from the welcome seed. Owner: client-net.
// The only client module that imports colyseus.js. Signatures by the architect; keep them.
//
// Adapted from games/bonk-brawl/client/src/net/Net.ts. Helpers in this folder: Clock.ts (server tick + match
// clock), Prediction.ts, Interpolation.ts (players), MonsterSync.ts, LocalHandoff.ts, ProjectileSync.ts (match
// predicted throws by ownerId + throwSeq + index; coconut balls predict 3), islandCache.ts (generateIsland cache,
// hash check, CoverIndex + structures), errors.ts (NetError → menu.err* keys), reconnectToken.ts.
// Prediction ctx = { terrain: island.grid, cover (static + state.structures), bounds, character, dt: DT,
// locked: inputLocked(phase, phaseTicksLeft, timings) }.
// Reconnect: RECONNECT_STORAGE_KEY holds { roomId, token } (sessionStorage); tryReconnect() at boot. While an
// automatic reconnect runs, the world is frozen at the last patch (no clock / interpolation / projectile
// extrapolation). Protocol: create / join send PROTOCOL_VERSION; a (re)join completes only after its welcome, and
// a welcome from another version ends "outdated".

import { Client, type Room } from "colyseus.js";
import {
  DEFAULT_CHARACTER,
  DT,
  INTERP_DELAY_MS,
  PITCH_LIMIT,
  RECONNECT_GRACE_SEC,
  TICK_MS,
  timingsFor,
  type Timings,
} from "../../../shared/constants";
import type { IslandDef } from "../../../shared/island/types";
import {
  MSG,
  PROTOCOL_VERSION,
  ROOM_NAME,
  type ClientMessages,
  type CreateOptions,
  type InputCmd,
  type JoinOptions,
  type MatchStartEvent,
  type PingMsg,
  type ServerMessageType,
  type ThrowEvent,
  type WelcomeMsg,
} from "../../../shared/protocol";
import { inputLocked, matchTicks, simulatedPhase } from "../../../shared/rules/schedule";
import type { SimContext } from "../../../shared/sim/context";
import type { CoverIndex } from "../../../shared/sim/cover";
import { clamp, vec3, wrapAngle, type Vec3 } from "../../../shared/sim/math";
import { copyPlayerSim, createPlayerSim, type StepPlayerResult, type ThrowRequest } from "../../../shared/sim/player";
import { computeThrowVelocities, projectileKindForThrow, throwOrigin } from "../../../shared/sim/throw";
import type { Phase, PlayerSimFields, PlayerView, RaftStateView } from "../../../shared/types";
import { Emitter } from "../util/Emitter";
import { Clock, MatchClock } from "./Clock";
import { finalCloseError, isFinalClose, isOutdated, isRoomGone, netError, toNetError } from "./errors";
import { Interpolation } from "./Interpolation";
import { IslandSync, type IslandChange } from "./islandCache";
import { LocalHandoff } from "./LocalHandoff";
import { MonsterSync } from "./MonsterSync";
import { Prediction } from "./Prediction";
import { ProjectileSync, type HandResolver } from "./ProjectileSync";
import { clearTicket, readTicket, storeTicket } from "./reconnectToken";
import type { MonsterFrame, NetError, NetEventMap, NetStatus, PlayerFrame, ProjectileFrame } from "./types";

export interface NetOptions {
  /** ws(s) endpoint; defaults to the page's own origin (the hub serves Colyseus there). */
  endpoint?: string;
}

type RaftRoom = Room<RaftStateView>;

/** Every server → client message; the check below fails to compile if one is missing. */
const SERVER_MESSAGES = [
  MSG.PING,
  MSG.WELCOME,
  MSG.NOTICE,
  MSG.MATCH_START,
  MSG.DAY_PHASE,
  MSG.WEATHER,
  MSG.DAY_EVENT,
  MSG.STORM_WARNING,
  MSG.RAFT_READY,
  MSG.BOARD,
  MSG.RAFT_LAUNCH,
  MSG.STORM,
  MSG.MATCH_END,
  MSG.THROW,
  MSG.HIT,
  MSG.SPLASH,
  MSG.STICK,
  MSG.PICKUP,
  MSG.CATCH,
  MSG.GATHER,
  MSG.PALM_SHAKE,
  MSG.USE,
  MSG.EAT,
  MSG.CRAFTED,
  MSG.FIRE_FUEL,
  MSG.CHEST_CHANGED,
  MSG.DELIVER,
  MSG.RAFT_DAMAGE,
  MSG.RAFT_STAGE,
  MSG.RAFT_REPAIR,
  MSG.STRUCTURE_PLACED,
  MSG.STRUCTURE_HIT,
  MSG.STRUCTURE_DESTROYED,
  MSG.MONSTER_SPAWN,
  MSG.MONSTER_HURT,
  MSG.MONSTER_FLIP,
  MSG.MONSTER_DIE,
  MSG.MONSTER_ATTACK,
  MSG.STEAL,
  MSG.PLAYER_HURT,
  MSG.PLAYER_DOWNED,
  MSG.PLAYER_REVIVED,
  MSG.PLAYER_WASHED,
  MSG.PLAYER_RESPAWN,
  MSG.LOW_BAR,
  MSG.BLAST,
  MSG.FISH_CAST,
  MSG.FISH_BITE,
  MSG.FISH_RESULT,
  MSG.FISH_MISS,
  MSG.TREASURE,
  MSG.BOTTLE,
  MSG.REJECT,
  MSG.MARKER,
  MSG.EMOTE,
] as const satisfies ReadonlyArray<ServerMessageType>;
type MissingServerMessages = Exclude<ServerMessageType, (typeof SERVER_MESSAGES)[number]>;
const _allServerMessages: [MissingServerMessages] extends [never] ? true : MissingServerMessages = true;
void _allServerMessages;

/** Messages Net handles itself before re-emitting them. */
const HANDLED_MESSAGES: ReadonlySet<ServerMessageType> = new Set<ServerMessageType>([
  MSG.PING,
  MSG.WELCOME,
  MSG.MATCH_START,
  MSG.THROW,
]);

/** The room's full state must arrive this soon after the join handshake. */
const FIRST_STATE_TIMEOUT_MS = 8000;
/**
 * Colyseus sends a (re)join's full state first and the welcome right behind it (messages queued during the join
 * flush after the state). Without a welcome this soon after the state (a seat gone while reconnecting), the join
 * completes anyway.
 */
const WELCOME_WAIT_MS = 1500;
/** A page reload races the server noticing the old socket closed: retry the token this long. */
const RELOAD_RECONNECT_WINDOW_MS = 4000;
const RELOAD_RETRY_MS = 400;
/** Backoff between automatic reconnect attempts after a drop (last value repeats). */
const RECONNECT_BACKOFF_MS: ReadonlyArray<number> = [250, 500, 1000, 1500, 2000, 3000];
/** Don't hang on a dead socket while leaving. */
const LEAVE_TIMEOUT_MS = 1500;

interface PendingJoin {
  room: RaftRoom;
  reconnected: boolean;
  /** A welcome with our protocol arrived (or WELCOME_WAIT_MS passed): the first state may complete the join. */
  welcomed: boolean;
  /** The first state, held until `welcomed`. */
  held: RaftStateView | null;
  welcomeTimer: ReturnType<typeof setTimeout> | null;
  resolve: () => void;
  reject: (err: NetError) => void;
}

/**
 * Net is the ONLY module that touches colyseus.js. Everything else uses this API.
 *
 * Connection:
 * - createRoom / joinRoom: client.create(ROOM_NAME, opts) / client.joinById(CODE, opts), both with `protocol:
 *   PROTOCOL_VERSION` added; resolve once the first full state and the welcome arrived (`connected` emitted).
 *   Reject with a NetError (errors.ts: JOIN_ERROR codes map 1:1, OUTDATED → outdated; Colyseus 4212 "locked" →
 *   roomFull, other 4212 → notFound; network failure → serverDown); message = i18n key.
 * - The welcome is part of every (re)join: Colyseus delivers the first state before it, so that state is held
 *   until the welcome (or WELCOME_WAIT_MS without one). A WelcomeMsg whose `protocol` differs from PROTOCOL_VERSION
 *   (a deploy since this page loaded): leave at once and fail the join / reconnect (never `connected` first), or
 *   end a running session, with NetError `outdated` (the home screen offers a reload).
 * - The reconnect ticket { roomId, token } lives in sessionStorage[RECONNECT_STORAGE_KEY]. tryReconnect() (boot:
 *   page reload, language switch) retries it for a few seconds while the server notices the old socket closed.
 * - Unexpected close (any code but 4000; 1000 too, proxies send it): status `reconnecting`, `reconnecting
 *   { attempt }` per attempt, client.reconnect(token) with backoff for up to RECONNECT_GRACE_SEC, then
 *   `disconnected { error }`. While reconnecting, `state` keeps the last decoded state (frozen), `sessionId` /
 *   `code` stay set, nothing is sent and wantsInput is false, and the world holds still: serverTickAt /
 *   clockTicksAt / the interpolation render tick stop where the drop found them (never past the newest patch, so
 *   nobody is extrapolated and no countdown runs on), projectiles aren't dead-reckoned and every frame reports
 *   speed 0 (no walking on the spot).
 * - Every server message is re-emitted on `events` under its MSG name with its typed payload. PING: reply PONG
 *   { t } at once and feed the clock. WELCOME / MATCH_START: island (below). THROW: ProjectileSync learns which
 *   projectile id is which index of the throw.
 *
 * State (room.onStateChange, every patch), in this order: clock sample (state.tick, own ping) → island follows
 * state.seed / state.layout → cover sync with state.structures → match clock → players (Interpolation snapshot
 * for everyone, roster diff) → prediction reconcile → ProjectileSync → MonsterSync; then events
 * (`connected` on the first patch of a join, once its welcome came), `island` (pending), `playerAdded` /
 * `playerRemoved`, `phase` (also once right after connecting, with previous = "lobby"), `state`.
 *
 * Island (game4.md §19): on welcome, on matchStart and on any change of state.seed / state.layout, the island is
 * generated locally (cached by seed + layout) and compared with the welcome's gridHash / defHash; `island
 * { seed, layout, mismatch }` is emitted when the shown island (or its mismatch flag) changes, and once per
 * connection. The CoverIndex's dynamic layer is rebuilt whenever state.structures changes (fences, collectors and
 * huts collide in the prediction exactly as on the server).
 *
 * Prediction: active while the local player is an alive (not washed), non-spectator participant in a simulated
 * phase (landing / playing / launch / storm) — that is `wantsInput`. Prediction.reset(me) when it becomes
 * active; reconcile on every patch; stop otherwise (the local player is then interpolated like a remote one and
 * LocalHandoff blends from the last predicted position). The lock of an input predicted now is estimated from
 * the server clock during the landing wake-up (an input that reaches the server after the unlock tick moves), so
 * the first step after the wake-up isn't lost to latency.
 *
 * Input seq: the caller's InputCmd.seq must be strictly increasing for the lifetime of the page (one counter in
 * GameController, never reset across matches and reconnects). A reloaded page restarts at 1 while the seat's
 * lastSeq may still hold the old page's (or the reconnect bot's) value: a lastSeq above anything this page sent
 * acknowledges nothing (the server must forget the seat's input queue on (re)join, like Bonk's clearInputs).
 */
export class Net {
  readonly events = new Emitter<NetEventMap>();
  /** Server time estimate (exposed for debugging / tests; read-only use). */
  readonly clock = new Clock();

  private readonly endpoint: string | undefined;
  private client: Client | null = null;
  private room: RaftRoom | null = null;
  private statusValue: NetStatus = "idle";
  /** Bumped by every new connection attempt / leave: stale async work checks it and bails. */
  private generation = 0;
  private joining: PendingJoin | null = null;
  private stateRef: RaftStateView | null = null;
  private sessionIdValue = "";
  private codeValue = "";
  private lastPhase: Phase | null = null;
  private welcomeFast = false;
  private readonly knownPlayers = new Set<string>();
  private readonly seenPlayers = new Set<string>();

  private readonly prediction = new Prediction();
  private readonly interpolation = new Interpolation();
  private readonly projectileSync = new ProjectileSync();
  private readonly monsterSync = new MonsterSync();
  private readonly islandSync = new IslandSync();
  private readonly matchClock = new MatchClock();
  private pendingIsland: IslandChange | null = null;

  private simCtx: SimContext | null = null;
  /** Highest InputCmd.seq this page has sent (never reset: the seq counter lives for the page lifetime). */
  private maxSentSeq = 0;
  /** performance.now() of the current render frame (or patch), for render-time sampling. */
  private nowMs = 0;
  /** While reconnecting: the server tick the world is held at (null = live, the Clock answers). */
  private frozenTick: number | null = null;
  /** Real time not yet applied to the prediction smoothing decay. */
  private decayDt = 0;

  private readonly localFrame: PlayerFrame = emptyPlayerFrame("", true);
  private readonly handoff = new LocalHandoff();
  private readonly remoteFrames = new Map<string, PlayerFrame>();
  private readonly remoteList: PlayerFrame[] = [];

  private readonly handSim = createPlayerSim();
  private readonly handPos = vec3();
  private readonly hands: HandResolver = (id) => this.handOf(id);

  constructor(opts: NetOptions = {}) {
    this.endpoint = opts.endpoint;
  }

  get status(): NetStatus {
    return this.statusValue;
  }
  get sessionId(): string {
    return this.sessionIdValue;
  }
  /** 4-letter room code ("" when not connected). */
  get code(): string {
    return this.codeValue;
  }
  /** Live decoded room state (null when not connected). Never mutate it. */
  get state(): RaftStateView | null {
    return this.stateRef;
  }
  get me(): PlayerView | null {
    if (!this.stateRef || !this.sessionIdValue) return null;
    return this.stateRef.players.get(this.sessionIdValue) ?? null;
  }
  get isHost(): boolean {
    return !!this.stateRef && this.sessionIdValue !== "" && this.stateRef.hostId === this.sessionIdValue;
  }
  /** Island generated locally from the server's seed / layout (null before the first welcome). */
  get island(): IslandDef | null {
    return this.islandSync.island;
  }
  /** Collision index for the island + current state.structures (kept in sync on structure add/remove). */
  get cover(): CoverIndex | null {
    return this.islandSync.cover;
  }
  get timings(): Readonly<Timings> {
    return timingsFor(this.stateRef?.fast ?? this.welcomeFast);
  }
  /** Local player is an alive participant in a simulated phase: the app should send one InputCmd per tick. */
  get wantsInput(): boolean {
    const phase = this.stateRef?.phase;
    return this.statusValue === "connected" && this.prediction.active && phase !== undefined && simulatedPhase(phase);
  }
  /** Latest predicted sim state of the local player (null when not predicting). */
  get localSim(): Readonly<PlayerSimFields> | null {
    return this.prediction.active ? this.prediction.current : null;
  }
  /** Smoothed RTT (ms). */
  get rttMs(): number {
    return this.clock.rttMs;
  }

  createRoom(opts: CreateOptions): Promise<void> {
    const options: CreateOptions = { ...opts, protocol: PROTOCOL_VERSION };
    return this.open((client) => client.create<RaftStateView>(ROOM_NAME, options));
  }
  joinRoom(code: string, opts: JoinOptions): Promise<void> {
    const roomId = code.trim().toUpperCase();
    const options: JoinOptions = { ...opts, protocol: PROTOCOL_VERSION };
    return this.open((client) => client.joinById<RaftStateView>(roomId, options));
  }
  /** Rejoin the room stored in sessionStorage (page reload / language switch). Resolves false when there is none. */
  async tryReconnect(): Promise<boolean> {
    const ticket = readTicket();
    if (!ticket || this.inSession()) return false;
    const gen = ++this.generation;
    this.statusValue = "connecting";
    const deadline = performance.now() + RELOAD_RECONNECT_WINDOW_MS;
    for (;;) {
      try {
        const room = await this.getClient().reconnect<RaftStateView>(ticket.token);
        if (gen !== this.generation) {
          void leaveQuietly(room, true);
          return false;
        }
        await this.adopt(room, true);
        return true;
      } catch (err) {
        if (gen !== this.generation) return false;
        if (isRoomGone(err) || isOutdated(err) || performance.now() + RELOAD_RETRY_MS > deadline) break;
        await delay(RELOAD_RETRY_MS);
        if (gen !== this.generation) return false;
      }
    }
    clearTicket();
    this.teardown();
    this.statusValue = "idle";
    return false;
  }
  /** Consented leave; clears the stored ticket; emits `disconnected { error: null }`. */
  async leave(): Promise<void> {
    const room = this.room;
    const wasInSession = this.inSession();
    this.generation++;
    clearTicket();
    this.teardown();
    this.statusValue = "disconnected";
    if (wasInSession) this.events.emit("disconnected", { error: null });
    if (room) await leaveQuietly(room, true);
  }

  /** Send any client → server message except input (lobby, craft, chest, marker, emote, rematch…). */
  send<K extends Exclude<keyof ClientMessages, "input" | "pong">>(type: K, msg: ClientMessages[K]): void {
    this.sendRaw(type, msg);
  }

  /**
   * Send one InputCmd and predict it (stepPlayer on the local sim). Returns the prediction's StepPlayerResult
   * (first prediction only), or null when not predicting. Emits localThrow / localStep for instant feedback.
   */
  sendInput(cmd: InputCmd): StepPlayerResult | null {
    const state = this.stateRef;
    const me = this.me;
    if (this.statusValue !== "connected" || !state || !me || !this.prediction.active) return null;
    const ctx = this.simContext(me, this.predictedLock(state, performance.now()));
    if (!ctx) return null;
    this.sendRaw(MSG.INPUT, cmd);
    if (cmd.seq > this.maxSentSeq) this.maxSentSeq = cmd.seq;
    const result = attempt("predict", () => this.prediction.predict(cmd, ctx));
    if (!result) return null;
    if (result.throw) {
      const release = result.throw;
      guarded("throw", () => this.spawnPredictedThrow(cmd.seq, release));
      this.events.emit("localThrow", { seq: cmd.seq, result: release });
    }
    this.events.emit("localStep", { seq: cmd.seq, result });
    return result;
  }

  /** Per frame: clock, smoothing decay, projectile dead-reckoning. */
  update(nowMs: number, dtSec: number): void {
    this.nowMs = nowMs;
    const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;
    this.decayDt += dt;
    const world = this.islandSync.world;
    // Reconnecting: projectiles stay where the last patch left them.
    if (this.stateRef && world && dt > 0 && this.frozenTick === null) this.projectileSync.update(dt, world);
  }

  /** Server tick estimate (fractional) right now (held while reconnecting). */
  serverTickAt(nowMs: number): number {
    return this.presentTick(nowMs);
  }
  /** state.clockTicks advanced smoothly by the clock (fractional), for the sky / HUD clock (held while reconnecting). */
  clockTicksAt(nowMs: number): number {
    if (!this.stateRef) return 0;
    return this.matchClock.at(this.presentTick(nowMs), matchTicks(this.timings));
  }

  /**
   * Local player for rendering: predicted + interpolated with `alpha` (0..1 between ticks), look from Input.
   * When not predicting (lobby, washed ashore, spectating, match end) the local player is snapshot-interpolated
   * exactly like a remote one (server yaw / pitch), falling back to the raw server state; null if absent.
   */
  getLocalPlayer(alpha: number, look: { yaw: number; pitch: number }): PlayerFrame | null {
    const me = this.me;
    if (!me) return null;
    const frame = this.localFrame;
    const decay = this.decayDt;
    this.decayDt = 0;
    if (this.prediction.active) {
      this.prediction.getRenderSim(alpha, decay, frame);
      if (Number.isFinite(look.yaw)) frame.yaw = wrapAngle(look.yaw);
      if (Number.isFinite(look.pitch)) frame.pitch = clamp(look.pitch, -PITCH_LIMIT, PITCH_LIMIT);
      this.handoff.predicted(frame);
    } else {
      if (!this.interpolation.sample(me.id, this.renderTick(this.nowMs), frame)) copyPlayerSim(me, frame);
      this.handoff.interpolated(frame, decay);
    }
    fillPlayerMeta(frame, me, true);
    if (this.frozenTick !== null) frame.speed = 0;
    return frame;
  }
  /** Every other player (not spectators), interpolated. */
  getRemotePlayers(nowMs: number): PlayerFrame[] {
    const out = this.remoteList;
    out.length = 0;
    const state = this.stateRef;
    if (!state) return out;
    const tick = this.renderTick(nowMs);
    state.players.forEach((view, id) => {
      if (id === this.sessionIdValue || view.spectator) return;
      let frame = this.remoteFrames.get(id);
      if (!frame) {
        frame = emptyPlayerFrame(id, false);
        this.remoteFrames.set(id, frame);
      }
      if (!this.interpolation.sample(id, tick, frame)) copyPlayerSim(view, frame);
      fillPlayerMeta(frame, view, false);
      if (this.frozenTick !== null) frame.speed = 0;
      out.push(frame);
    });
    return out;
  }
  /** Every projectile to draw this frame: dead-reckoned server projectiles + predicted own throws. */
  getProjectiles(): ProjectileFrame[] {
    return this.projectileSync.getFrames();
  }
  /** Every monster, snapshot-interpolated like remote players. */
  getMonsters(nowMs: number): MonsterFrame[] {
    if (!this.stateRef) return [];
    const frames = this.monsterSync.frames(this.renderTick(nowMs));
    if (this.frozenTick !== null) for (const m of frames) m.speed = 0;
    return frames;
  }

  dispose(): void {
    const room = this.room;
    this.generation++;
    this.teardown();
    this.statusValue = "disconnected";
    // Not a consented leave: the stored ticket survives, so a reload can still rejoin.
    if (room) void leaveQuietly(room, false);
    this.islandSync.clear();
    this.events.clear();
  }

  /* ========================================================== connection */

  private inSession(): boolean {
    const s = this.statusValue;
    return s === "connecting" || s === "connected" || s === "reconnecting";
  }

  private getClient(): Client {
    if (!this.client) this.client = new Client(this.endpoint ?? defaultEndpoint());
    return this.client;
  }

  private async open(request: (client: Client) => Promise<RaftRoom>): Promise<void> {
    if (this.inSession()) throw netError("unknown");
    const gen = ++this.generation;
    const previous = this.statusValue;
    this.statusValue = "connecting";
    try {
      const room = await request(this.getClient());
      if (gen !== this.generation) {
        void leaveQuietly(room, true);
        throw netError("unknown");
      }
      await this.adopt(room, false);
    } catch (err) {
      if (gen === this.generation) {
        this.teardown();
        this.statusValue = previous === "disconnected" ? "disconnected" : "idle";
      }
      const error = toNetError(err);
      if (error.kind === "unknown") console.warn("[net] couldn't join the room", err);
      throw error;
    }
  }

  /** Bind a joined room and wait for its first full state and welcome (onPatch completes the join). */
  private adopt(room: RaftRoom, reconnected: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.joining?.room === room) this.failJoin(netError("serverDown"));
      }, FIRST_STATE_TIMEOUT_MS);
      const join: PendingJoin = {
        room,
        reconnected,
        welcomed: false,
        held: null,
        welcomeTimer: null,
        resolve: () => {
          clearTimeout(timer);
          if (join.welcomeTimer !== null) clearTimeout(join.welcomeTimer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          if (join.welcomeTimer !== null) clearTimeout(join.welcomeTimer);
          reject(err);
        },
      };
      this.joining = join;
      this.bindRoom(room);
    });
  }

  /** The pending join of the bound room, if any. */
  private pendingJoin(): PendingJoin | null {
    return this.joining && this.joining.room === this.room ? this.joining : null;
  }

  /** The first state came before the welcome (Colyseus order): keep it until welcomeJoin(). */
  private holdForWelcome(join: PendingJoin, state: RaftStateView): void {
    join.held = state;
    join.welcomeTimer ??= setTimeout(() => {
      if (this.pendingJoin() === join) this.welcomeJoin(join);
    }, WELCOME_WAIT_MS);
  }

  /** The protocol checked out (or the welcome is overdue): a held first state completes the join now. */
  private welcomeJoin(join: PendingJoin): void {
    join.welcomed = true;
    const held = join.held;
    join.held = null;
    if (held) this.onPatch(held);
  }

  private failJoin(err: NetError): void {
    const join = this.joining;
    if (!join) return;
    this.joining = null;
    if (this.room === join.room) this.room = null;
    void leaveQuietly(join.room, true);
    join.reject(err);
  }

  private bindRoom(room: RaftRoom): void {
    this.room = room;
    this.sessionIdValue = room.sessionId;
    this.codeValue = room.roomId;
    this.projectileSync.setLocalId(room.sessionId);
    this.islandSync.newSession();
    this.pendingIsland = null;
    this.bindMessage(room, MSG.PING, (msg) => this.onPing(msg));
    this.bindMessage(room, MSG.WELCOME, (msg) => this.onWelcome(msg));
    this.bindMessage(room, MSG.MATCH_START, (msg) => this.onMatchStart(msg));
    this.bindMessage(room, MSG.THROW, (msg) => this.onThrow(msg));
    for (const type of SERVER_MESSAGES) {
      if (!HANDLED_MESSAGES.has(type)) this.bindMessage(room, type);
    }
    room.onStateChange((state) => {
      if (room === this.room) this.onPatch(state);
    });
    room.onLeave((code) => {
      if (room === this.room) this.onRoomClosed(code);
    });
  }

  /** Re-emit a server message on `events`, after optional net-side handling. */
  private bindMessage<K extends ServerMessageType>(room: RaftRoom, type: K, before?: (payload: NetEventMap[K]) => void): void {
    room.onMessage<NetEventMap[K]>(type, (payload) => {
      if (room !== this.room) return;
      try {
        before?.(payload);
      } catch (err) {
        console.error(`[net] handling "${type}" failed`, err);
      }
      // The net-side handling may have left the room (an outdated welcome): don't re-emit what it refused.
      if (room !== this.room) return;
      this.events.emit(type, payload);
    });
  }

  private onPing(msg: PingMsg): void {
    this.sendRaw(MSG.PONG, { t: msg.t });
    if (Number.isFinite(msg.tick)) this.clock.sample(msg.tick, performance.now(), this.me?.ping ?? 0);
  }

  private onWelcome(msg: WelcomeMsg): void {
    // A server from before versioning sends no protocol: accepted, like the server accepts option-less clients.
    if (typeof msg.protocol === "number" && msg.protocol !== PROTOCOL_VERSION) {
      this.refuseOutdated();
      return;
    }
    if (Number.isFinite(msg.tick)) this.clock.sample(msg.tick, performance.now(), this.me?.ping ?? 0);
    this.welcomeFast = !!msg.fast;
    this.announceIsland(this.islandSync.welcome(msg));
    const join = this.pendingJoin();
    if (join) this.welcomeJoin(join);
  }

  private onMatchStart(msg: MatchStartEvent): void {
    this.matchClock.reset();
    this.announceIsland(this.islandSync.matchStart(msg.seed, msg.layout));
  }

  private onThrow(msg: ThrowEvent): void {
    if (Array.isArray(msg.projectileIds)) this.projectileSync.noteThrow(msg);
  }

  /** Emit `island` now, or after `connected` while a join is still waiting for its first state. */
  private announceIsland(change: IslandChange | null): void {
    if (!change) return;
    if (this.statusValue === "connected" && !this.joining) this.events.emit("island", change);
    else this.pendingIsland = change;
  }

  /** The socket closed (server side, network, or after our own leave, which detaches first). */
  private onRoomClosed(code: number): void {
    const join = this.joining;
    if (join && join.room === this.room) {
      this.failJoin(netError("serverDown"));
      return;
    }
    this.room = null;
    this.prediction.stop();
    const ticket = readTicket();
    if (isFinalClose(code) || !ticket) {
      this.finish(isFinalClose(code) ? finalCloseError(code) : netError("serverDown"));
      return;
    }
    this.statusValue = "reconnecting";
    this.freeze(performance.now());
    void this.reconnectLoop(++this.generation, ticket.token);
  }

  /**
   * The room dropped: hold the world at the last truth until the reconnect settles. The server-time estimate stops
   * where it was, but never later than what the newest patch can show (render tick ≤ its tick, so remote players
   * and monsters aren't extrapolated): the match clock, the sky and every countdown derived from it stop too.
   */
  private freeze(nowMs: number): void {
    let tick = this.clock.serverTickAt(nowMs);
    const state = this.stateRef;
    if (state) tick = Math.min(tick, state.tick + (this.clock.rttMs / 2 + INTERP_DELAY_MS) / TICK_MS);
    this.frozenTick = tick;
  }

  /** The server's present tick for render-time work: the Clock, or the tick the world is frozen at. */
  private presentTick(nowMs: number): number {
    return this.frozenTick ?? this.clock.serverTickAt(nowMs);
  }

  /** The server runs another PROTOCOL_VERSION: leave, and fail the pending join or end the session ("outdated"). */
  private refuseOutdated(): void {
    const error = netError("outdated");
    const join = this.joining;
    if (join && join.room === this.room) {
      this.failJoin(error);
      return;
    }
    const room = this.room;
    this.generation++;
    this.finish(error);
    if (room) void leaveQuietly(room, true);
  }

  /** Retry the stored token with backoff for up to RECONNECT_GRACE_SEC. */
  private async reconnectLoop(gen: number, token: string): Promise<void> {
    const deadline = performance.now() + RECONNECT_GRACE_SEC * 1000;
    let error: NetError = netError("serverDown");
    for (let attempt = 1; gen === this.generation && performance.now() < deadline; attempt++) {
      this.events.emit("reconnecting", { attempt });
      try {
        const room = await this.getClient().reconnect<RaftStateView>(token);
        if (gen !== this.generation) {
          void leaveQuietly(room, true);
          return;
        }
        await this.adopt(room, true);
        return;
      } catch (err) {
        if (gen !== this.generation) return;
        if (isRoomGone(err)) {
          error = netError("notFound");
          break;
        }
        if (isOutdated(err)) {
          error = netError("outdated");
          break;
        }
      }
      const wait = RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)]!;
      await delay(Math.max(0, Math.min(wait, deadline - performance.now())));
    }
    if (gen === this.generation) this.finish(error);
  }

  /** Gone for good: forget the room and tell the app. */
  private finish(error: NetError): void {
    clearTicket();
    this.teardown();
    this.statusValue = "disconnected";
    this.events.emit("disconnected", { error });
  }

  private teardown(): void {
    if (this.joining) {
      const join = this.joining;
      this.joining = null;
      join.reject(netError("unknown"));
    }
    this.room = null;
    this.stateRef = null;
    this.sessionIdValue = "";
    this.codeValue = "";
    this.lastPhase = null;
    this.pendingIsland = null;
    this.frozenTick = null;
    this.knownPlayers.clear();
    this.prediction.stop();
    this.handoff.reset();
    this.interpolation.clear();
    this.projectileSync.clear();
    this.monsterSync.clear();
    this.matchClock.reset();
    this.clock.reset();
    this.remoteFrames.clear();
    this.islandSync.newSession();
  }

  private sendRaw<K extends keyof ClientMessages>(type: K, message: ClientMessages[K]): void {
    const room = this.room;
    if (!room || !room.connection?.isOpen) return;
    try {
      room.send(type, message);
    } catch (err) {
      console.warn(`[net] couldn't send "${type}"`, err);
    }
  }

  /* =============================================================== state */

  private onPatch(state: RaftStateView): void {
    const join = this.pendingJoin();
    if (join && !join.welcomed) {
      this.holdForWelcome(join, state);
      return;
    }
    const now = performance.now();
    this.nowMs = now;
    if (join) this.resetForNewState();
    this.stateRef = state;
    const me = state.players.get(this.sessionIdValue) ?? null;
    this.clock.sample(state.tick, now, me?.ping ?? 0);

    const previous = this.lastPhase;
    this.lastPhase = state.phase;
    if (previous !== null && previous !== state.phase && (state.phase === "landing" || state.phase === "lobby")) {
      this.matchClock.reset();
    }
    this.matchClock.onPatch(state.clockTicks, state.tick, state.phase === "playing");

    const added: PlayerView[] = [];
    const removed: string[] = [];
    // A failing step (island generator, sim) must not stall the join or the lifecycle events below.
    guarded("island", () => {
      const islandChange = this.islandSync.onState(state.seed, state.layout);
      if (islandChange) this.pendingIsland = islandChange;
      this.islandSync.syncStructures(state.structures);
    });
    guarded("players", () => this.syncPlayers(state, added, removed));
    guarded("prediction", () => this.syncPrediction(state, me));
    guarded("projectiles", () => {
      const world = this.islandSync.world;
      if (world) this.projectileSync.onServerState(state.projectiles, state.tick, this.clock.serverTickAt(now), world, this.hands);
    });
    guarded("monsters", () => this.monsterSync.onServerState(state.monsters, state.tick));

    if (join) this.completeJoin(join);
    const island = this.pendingIsland;
    this.pendingIsland = null;
    if (island) this.events.emit("island", island);
    for (const player of added) this.events.emit("playerAdded", player);
    for (const id of removed) this.events.emit("playerRemoved", { id });
    if (join) this.events.emit("phase", { phase: state.phase, previous: "lobby" });
    else if (previous !== null && previous !== state.phase) this.events.emit("phase", { phase: state.phase, previous });
    this.events.emit("state", state);
    join?.resolve();
  }

  /** A (re)joined room has a new decoded state and maybe a long gap: drop time-based caches. */
  private resetForNewState(): void {
    this.frozenTick = null;
    this.clock.reset();
    this.interpolation.clear();
    this.projectileSync.clear();
    this.projectileSync.setLocalId(this.sessionIdValue);
    this.monsterSync.clear();
    this.matchClock.reset();
    this.prediction.stop();
    this.handoff.reset();
    // knownPlayers survives a reconnect so the roster diff reports exactly who joined / left meanwhile.
    this.lastPhase = null;
  }

  private completeJoin(join: PendingJoin): void {
    this.joining = null;
    this.statusValue = "connected";
    storeTicket({ roomId: join.room.roomId, token: join.room.reconnectionToken });
    this.events.emit("connected", { code: this.codeValue, sessionId: this.sessionIdValue, reconnected: join.reconnected });
  }

  /** Snapshot every player into Interpolation and collect roster changes. */
  private syncPlayers(state: RaftStateView, added: PlayerView[], removed: string[]): void {
    const seen = this.seenPlayers;
    seen.clear();
    state.players.forEach((player, id) => {
      seen.add(id);
      this.interpolation.push(id, state.tick, player);
      if (!this.knownPlayers.has(id)) {
        this.knownPlayers.add(id);
        added.push(player);
      }
    });
    for (const id of this.knownPlayers) {
      if (seen.has(id)) continue;
      this.knownPlayers.delete(id);
      this.interpolation.remove(id);
      this.remoteFrames.delete(id);
      removed.push(id);
    }
  }

  private syncPrediction(state: RaftStateView, me: PlayerView | null): void {
    const predict =
      me !== null && me.alive && !me.washed && !me.spectator && simulatedPhase(state.phase) && this.islandSync.world !== null;
    if (!predict) {
      if (this.prediction.active) this.prediction.stop();
      return;
    }
    if (!this.prediction.active) {
      this.prediction.reset(me);
      return;
    }
    const ctx = this.simContext(me, inputLocked(state.phase, state.phaseTicksLeft, this.timings));
    // A lastSeq above anything this page sent is a previous page's (reload) or a bot's (reconnect window): none
    // of our inputs is acknowledged yet.
    const ackedSeq = me.lastSeq > this.maxSentSeq ? 0 : me.lastSeq;
    if (ctx) this.prediction.reconcile(me, ctx, { trustPredictedLock: state.phase === "landing", ackedSeq });
  }

  /** The reused prediction context for the local player (null without an island). */
  private simContext(me: PlayerView, locked: boolean): SimContext | null {
    const world = this.islandSync.world;
    if (!world) return null;
    const ctx = (this.simCtx ??= { terrain: world.terrain, cover: world.cover, bounds: world.bounds, character: me.character, dt: DT, locked });
    ctx.terrain = world.terrain;
    ctx.cover = world.cover;
    ctx.bounds = world.bounds;
    ctx.character = me.character;
    ctx.dt = DT;
    ctx.locked = locked;
    return ctx;
  }

  /**
   * Lock for an input predicted now. During the landing wake-up an input that reaches the server (≈ RTT/2 from the
   * server's present) on or after the unlock tick is not locked there; every other phase uses inputLocked().
   */
  private predictedLock(state: RaftStateView, nowMs: number): boolean {
    const t = this.timings;
    if (state.phase !== "landing" || !this.clock.synced) return inputLocked(state.phase, state.phaseTicksLeft, t);
    const unlockTick = state.tick + state.phaseTicksLeft - (t.landing - t.landingLock);
    const arrivalTick = this.clock.serverTickAt(nowMs) + this.clock.rttMs / 2 / TICK_MS;
    return arrivalTick < unlockTick;
  }

  private spawnPredictedThrow(seq: number, t: ThrowRequest): void {
    // Q with a torch plants it (a structure), it doesn't fly.
    if (t.toss && t.kind === "torch") return;
    const velocities = computeThrowVelocities(t);
    const origin = vec3(t.origin.x, t.origin.y, t.origin.z);
    this.projectileSync.addPredictedThrow(this.sessionIdValue, seq, origin, velocities, projectileKindForThrow(t.kind), t.charge);
  }

  /* ======================================================= render helpers */

  /** Interpolation render tick: the server's present minus one-way latency and the buffer (held while reconnecting). */
  private renderTick(nowMs: number): number {
    return this.presentTick(nowMs) - (this.clock.rttMs / 2 + INTERP_DELAY_MS) / TICK_MS;
  }

  /** Hand (throwOrigin) of a player as rendered this frame: predicted local player, interpolated remotes. */
  private handOf(id: string): Vec3 | null {
    let sim: PlayerSimFields | null = null;
    if (id === this.sessionIdValue && this.prediction.active) sim = this.prediction.current;
    else if (this.interpolation.sample(id, this.renderTick(this.nowMs), this.handSim)) sim = this.handSim;
    else sim = this.stateRef?.players.get(id) ?? null;
    return sim ? throwOrigin(sim, this.handPos) : null;
  }
}

/** Last console report per guarded step (a broken step would otherwise log 20–30 times a second). */
const lastGuardLog = new Map<string, number>();
const GUARD_LOG_INTERVAL_MS = 2000;

/** Run one step; on a throw, log (rate-limited per step) and return null so networking carries on. */
function attempt<T>(step: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    const now = Date.now();
    if (now - (lastGuardLog.get(step) ?? 0) > GUARD_LOG_INTERVAL_MS) {
      lastGuardLog.set(step, now);
      console.error(`[net] ${step} failed`, err);
    }
    return null;
  }
}

/** attempt() for steps without a result. */
function guarded(step: string, fn: () => void): void {
  attempt(step, fn);
}

function defaultEndpoint(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

/** A blank render frame (fresh sim state, default tourist). */
export function emptyPlayerFrame(id: string, isLocal: boolean): PlayerFrame {
  return {
    ...createPlayerSim(),
    id,
    isLocal,
    character: DEFAULT_CHARACTER,
    seat: 0,
    team: 0,
    nickname: "",
    bot: false,
    connected: true,
    spectator: false,
    washed: false,
    cnt0: 0,
    cnt1: 0,
    cnt2: 0,
    cnt3: 0,
    fishState: 0,
    fishSpot: -1,
    fuseTicks: 0,
    torchTicks: 0,
    cosmetic: "",
    golden: false,
    speed: 0,
  };
}

/** Copy the non-sim fields a renderer needs from the decoded player, and derive the horizontal speed. */
export function fillPlayerMeta(frame: PlayerFrame, view: PlayerView, isLocal: boolean): void {
  frame.id = view.id;
  frame.isLocal = isLocal;
  frame.character = view.character;
  frame.seat = view.seat;
  frame.team = view.team;
  frame.nickname = view.nickname;
  frame.bot = view.bot;
  frame.connected = view.connected;
  frame.spectator = view.spectator;
  frame.washed = view.washed;
  frame.cnt0 = view.cnt0;
  frame.cnt1 = view.cnt1;
  frame.cnt2 = view.cnt2;
  frame.cnt3 = view.cnt3;
  frame.fishState = view.fishState;
  frame.fishSpot = view.fishSpot;
  frame.fuseTicks = view.fuseTicks;
  frame.torchTicks = view.torchTicks;
  frame.cosmetic = view.cosmetic;
  frame.golden = view.golden;
  frame.speed = Math.hypot(frame.vx, frame.vz);
}

/** Leave without throwing or hanging; never writes to an already-closed socket. */
async function leaveQuietly(room: RaftRoom, consented: boolean): Promise<void> {
  try {
    if (!room.connection?.isOpen) {
      room.removeAllListeners();
      return;
    }
    await Promise.race([room.leave(consented), delay(LEAVE_TIMEOUT_MS)]);
  } catch {
    // The socket is going away anyway.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
