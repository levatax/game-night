// Connection, room, typed messaging, and the facade over prediction/interpolation/balls.
// Owner: client-net.

import { Client, type Room } from "colyseus.js";
import {
  DEFAULT_MAP,
  DT,
  INTERP_DELAY_MS,
  PITCH_LIMIT,
  RECONNECT_GRACE_SEC,
  RECONNECT_STORAGE_KEY,
  TICK_MS,
} from "../../../shared/constants";
import { getArena } from "../../../shared/maps";
import {
  MSG,
  ROOM_NAME,
  type ClientMessages,
  type CreateOptions,
  type InputCmd,
  type JoinOptions,
  type PingMsg,
  type ServerMessageType,
  type SettingsMsg,
  type WelcomeMsg,
} from "../../../shared/protocol";
import type { FloorQuery, SimContext } from "../../../shared/sim/context";
import { clamp, vec3, wrapAngle } from "../../../shared/sim/math";
import { copyPlayerSim, createPlayerSim, type StepPlayerResult, type ThrowRequest } from "../../../shared/sim/player";
import { aimDirection, ballKindForPowerUp, chestPosition, computeThrowVelocities, throwOrigin } from "../../../shared/sim/throw";
import type { BonkStateView, CharacterId, EmoteId, Phase, PlayerSimFields, PlayerView } from "../../../shared/types";
import { Emitter } from "../util/Emitter";
import { BallSync, type OwnerResolver } from "./BallSync";
import { Clock } from "./Clock";
import { MESSAGES, isFinalClose, isRoomGone, toNetError } from "./errors";
import { Interpolation } from "./Interpolation";
import { LocalHandoff } from "./LocalHandoff";
import { Prediction } from "./Prediction";
import type { BallFrame, NetError, NetEventMap, NetStatus, PlayerFrame } from "./types";

export interface NetOptions {
  /** WebSocket endpoint. Default: same origin, `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`. */
  endpoint?: string;
}

type BonkRoom = Room<BonkStateView>;
type OwnerInfo = NonNullable<ReturnType<OwnerResolver>>;

/** Every server → client message; the check below fails to compile if one is missing. */
const SERVER_MESSAGES = [
  MSG.PING,
  MSG.WELCOME,
  MSG.NOTICE,
  MSG.ROUND_START,
  MSG.COUNTDOWN,
  MSG.SUDDEN_DEATH,
  MSG.ROUND_WIN,
  MSG.MATCH_END,
  MSG.THROW,
  MSG.PICKUP,
  MSG.HIT,
  MSG.CATCH,
  MSG.WHIFF,
  MSG.DEFLECT,
  MSG.RING_OUT,
  MSG.KO,
  MSG.EMOTE,
  MSG.ABILITY,
  MSG.SHOCKWAVE,
  MSG.HEADBUTT,
  MSG.BALL_SPAWN,
  MSG.BOOMERANG_RETURN,
  MSG.POWERUP_WARNING,
  MSG.POWERUP_SPAWN,
  MSG.POWERUP_PICKUP,
  MSG.RING_SHAKE,
  MSG.RING_DROP,
  MSG.BUMP,
] as const satisfies ReadonlyArray<ServerMessageType>;
type MissingServerMessages = Exclude<ServerMessageType, (typeof SERVER_MESSAGES)[number]>;
const _allServerMessages: [MissingServerMessages] extends [never] ? true : MissingServerMessages = true;
void _allServerMessages;

/** Phases in which an alive participant's own movement is predicted (and inputs are sent). */
const PREDICTED_PHASES: ReadonlySet<Phase> = new Set<Phase>(["countdown", "playing", "suddenDeath"]);
/** The room's full state must arrive this soon after the join handshake. */
const FIRST_STATE_TIMEOUT_MS = 8000;
/** A page reload races the server noticing the old socket closed: retry the token this long. */
const RELOAD_RECONNECT_WINDOW_MS = 4000;
const RELOAD_RETRY_MS = 400;
/** Backoff between automatic reconnect attempts after a drop (last value repeats). */
const RECONNECT_BACKOFF_MS: ReadonlyArray<number> = [250, 500, 1000, 1500, 2000, 3000];
/** Don't hang on a dead socket while leaving. */
const LEAVE_TIMEOUT_MS = 1500;

interface PendingJoin {
  room: BonkRoom;
  reconnected: boolean;
  resolve: () => void;
  reject: (err: NetError) => void;
}

interface OwnerCacheEntry {
  stamp: number;
  valid: boolean;
  info: OwnerInfo;
}

/**
 * Net is the ONLY module that touches colyseus.js. Everything else uses this API.
 *
 * Connection:
 * - createRoom / joinRoom: client.create(ROOM_NAME, opts) / client.joinById(code, opts). Store
 *   room.reconnectionToken in sessionStorage[RECONNECT_STORAGE_KEY] (try/catch). Reject with a
 *   NetError: JOIN_ERROR codes map 1:1; Colyseus 4212 with "locked" in the message → roomFull,
 *   other 4212 → notFound; network failure → serverDown.
 * - tryReconnect: client.reconnect(token) if a token is stored (page reload during a match).
 * - On unexpected close (room.onLeave with code != 1000/4000): emit `reconnecting` and retry
 *   client.reconnect(token) with backoff for up to RECONNECT_GRACE_SEC, then emit `disconnected`.
 * - Every server message is re-emitted on `events` under its MSG name with its typed payload.
 *   On PING: reply PONG { t } immediately and feed the clock (tick, now, own player's ping).
 * - getStateCallbacks / onStateChange: emit `state` after each patch, `phase` on phase changes
 *   (also once right after connecting, with previous = "lobby"), `playerAdded` / `playerRemoved`;
 *   push EVERY player's snapshot (local included) into Interpolation (keyed by state.tick);
 *   reconcile Prediction with the local player; feed BallSync (with an OwnerResolver built from
 *   the rendered players: predicted local, interpolated remotes).
 *
 * Prediction lifecycle: Prediction.reset(me) whenever the local player becomes alive in a round
 * (phase → countdown, or reconnect mid-round); stop() when not alive or phase is lobby/matchEnd.
 * SimContext for prediction = { arena: getArena(state.mapId), rings: state.rings,
 * character: me.character, dt: DT, locked: phase !== "playing" && phase !== "suddenDeath" }.
 *
 * Input seq: the caller's InputCmd.seq must be strictly increasing for the lifetime of the page
 * (GameController keeps one counter and never resets it, across rounds, matches and reconnects).
 * The server forgets the last seq on join/reconnect (world.clearInputs), so a reloaded page may
 * restart at 1.
 *
 * Implementation notes:
 * - Lifecycle events come from diffing each decoded patch in onStateChange (players added /
 *   removed, phase), so they are emitted in one fixed order after all net-side processing:
 *   (`connected`), `playerAdded`/`playerRemoved`, `phase`, `state`. `connected` waits for the
 *   first full state, so listeners can always read `state` / `me`.
 * - Prediction stops in roundEnd too: the server's round-end slow-mo steps with a scaled dt and
 *   ignores inputs, so the local player is interpolated like everyone else then (LocalHandoff
 *   blends from the last predicted position so it doesn't snap back along its path).
 * - The input lock for a fresh prediction during the countdown is estimated from the server
 *   clock (an input that reaches the server after "go" moves), so the first step at "BONK!" is
 *   not lost to latency; replays keep that decision (see Prediction).
 * - A predicted fall below the island keeps being predicted until the server confirms the
 *   ring-out (!alive), so the body doesn't jump back to its lagging interpolated position.
 * - While reconnecting, `state` keeps the last decoded state (frozen) and `sessionId`/`code` stay
 *   set; nothing is sent.
 */
export class Net {
  readonly events = new Emitter<NetEventMap>();
  readonly clock = new Clock();

  private readonly endpoint: string | undefined;
  private client: Client | null = null;
  private room: BonkRoom | null = null;
  private statusValue: NetStatus = "idle";
  /** Bumped by every new connection attempt / leave: stale async work checks it and bails. */
  private generation = 0;
  private joining: PendingJoin | null = null;
  private stateRef: BonkStateView | null = null;
  private sessionIdValue = "";
  private codeValue = "";
  private lastPhase: Phase | null = null;
  private readonly knownPlayers = new Set<string>();
  private readonly seenPlayers = new Set<string>();

  private readonly prediction = new Prediction();
  private readonly interpolation = new Interpolation();
  private readonly ballSync = new BallSync();

  private readonly floor: FloorQuery = { arena: getArena(DEFAULT_MAP), rings: [] };
  private simCtx: SimContext | null = null;
  /** performance.now() of the current render frame (or patch), for render-time sampling. */
  private nowMs = 0;
  /** Real time not yet applied to the prediction smoothing decay. */
  private decayDt = 0;

  private readonly localFrame: PlayerFrame = emptyPlayerFrame("", true);
  private readonly handoff = new LocalHandoff();
  private readonly remoteFrames = new Map<string, PlayerFrame>();
  private readonly remoteList: PlayerFrame[] = [];

  private ownerStamp = 0;
  private readonly ownerCache = new Map<string, OwnerCacheEntry>();
  private readonly ownerScratch = createPlayerSim();
  private readonly owners: OwnerResolver = (id) => this.resolveOwner(id);

  constructor(opts: NetOptions = {}) {
    this.endpoint = opts.endpoint;
  }

  get status(): NetStatus {
    return this.statusValue;
  }

  /** Own sessionId ("" when not connected). */
  get sessionId(): string {
    return this.sessionIdValue;
  }

  /** Room code ("" when not connected). */
  get code(): string {
    return this.codeValue;
  }

  /** Live decoded state (read-only!) or null. */
  get state(): BonkStateView | null {
    return this.stateRef;
  }

  /** Own PlayerView from state, or null. */
  get me(): PlayerView | null {
    if (!this.stateRef || !this.sessionIdValue) return null;
    return this.stateRef.players.get(this.sessionIdValue) ?? null;
  }

  get isHost(): boolean {
    return !!this.stateRef && this.sessionIdValue !== "" && this.stateRef.hostId === this.sessionIdValue;
  }

  /** True while the controller should sample and send inputs (alive participant in countdown/playing/suddenDeath). */
  get wantsInput(): boolean {
    const phase = this.stateRef?.phase;
    return this.statusValue === "connected" && this.prediction.active && phase !== undefined && PREDICTED_PHASES.has(phase);
  }

  /** Latest predicted local sim (HUD: charge, cooldowns, heldCount, powerUp...), or null if not predicting. */
  get localSim(): Readonly<PlayerSimFields> | null {
    return this.prediction.active ? this.prediction.current : null;
  }

  createRoom(opts: CreateOptions): Promise<void> {
    return this.open((client) => client.create<BonkStateView>(ROOM_NAME, opts));
  }

  joinRoom(code: string, opts: JoinOptions): Promise<void> {
    const roomId = code.trim().toUpperCase();
    return this.open((client) => client.joinById<BonkStateView>(roomId, opts));
  }

  /** Resolves true if a stored reconnection token rejoined a room. Never rejects. */
  async tryReconnect(): Promise<boolean> {
    const token = readToken();
    if (!token || this.inSession()) return false;
    const gen = ++this.generation;
    this.statusValue = "connecting";
    const deadline = performance.now() + RELOAD_RECONNECT_WINDOW_MS;
    for (;;) {
      try {
        const client = this.getClient();
        const room = await client.reconnect<BonkStateView>(token);
        if (gen !== this.generation) {
          void leaveQuietly(room, true);
          return false;
        }
        await this.adopt(room, true);
        return true;
      } catch (err) {
        if (gen !== this.generation) return false;
        if (isRoomGone(err) || performance.now() + RELOAD_RETRY_MS > deadline) break;
        await delay(RELOAD_RETRY_MS);
        if (gen !== this.generation) return false;
      }
    }
    clearToken();
    this.teardown();
    this.statusValue = "idle";
    return false;
  }

  /** Consented leave; clears the stored token; emits `disconnected` { error: null }. */
  async leave(): Promise<void> {
    const room = this.room;
    const wasInSession = this.inSession();
    this.generation++;
    clearToken();
    this.teardown();
    this.statusValue = "disconnected";
    if (wasInSession) this.events.emit("disconnected", { error: null });
    if (room) await leaveQuietly(room, true);
  }

  sendReady(ready: boolean): void {
    this.send(MSG.READY, { ready });
  }

  sendCharacter(character: CharacterId): void {
    this.send(MSG.CHARACTER, { character });
  }

  sendSettings(patch: SettingsMsg): void {
    this.send(MSG.SETTINGS, patch);
  }

  sendStart(): void {
    this.send(MSG.START, {});
  }

  sendEmote(emote: EmoteId): void {
    this.send(MSG.EMOTE, { emote });
  }

  sendRematch(ready: boolean): void {
    this.send(MSG.REMATCH, { ready });
  }

  /**
   * Send one 30 Hz input and predict it. Returns the first-prediction StepPlayerResult, or null
   * when not predicting (then the input isn't sent either). On result.throw: spawns predicted
   * balls in BallSync (computeThrowVelocities) and emits `localThrow`; always emits `localStep`.
   */
  sendInput(cmd: InputCmd): StepPlayerResult | null {
    const state = this.stateRef;
    const me = this.me;
    if (this.statusValue !== "connected" || !state || !me || !this.prediction.active) return null;
    this.send(MSG.INPUT, cmd);
    const now = performance.now();
    const result = this.prediction.predict(cmd, this.simContext(state, me, this.predictedLock(state, now)));
    if (result.throw) {
      this.spawnPredictedThrow(cmd.seq, result.throw);
      this.events.emit("localThrow", { seq: cmd.seq, result: result.throw });
    }
    this.events.emit("localStep", { seq: cmd.seq, result });
    return result;
  }

  /** Per render frame: advance BallSync, smoothing and the clock. */
  update(nowMs: number, dtSec: number): void {
    this.nowMs = nowMs;
    const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;
    this.decayDt += dt;
    this.ownerStamp++;
    if (this.stateRef && dt > 0) this.ballSync.update(dt, this.floor, this.owners);
  }

  /**
   * Local player frame (predicted, interpolated by `alpha` = fixed-step accumulator fraction).
   * yaw/pitch are overridden with `look` (the Input's current values) for zero-latency aiming.
   * When not predicting (round-end slow-mo, ghost, spectator, matchEnd) returns the local player
   * snapshot-interpolated exactly like a remote player (smooth, server yaw/pitch), falling back to
   * the raw server state when no snapshot exists yet; null if absent.
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
    fillPlayerMeta(frame, me);
    return frame;
  }

  /**
   * Every other player in state.players (alive or not; spectators included — Characters hides
   * them), snapshot-interpolated at the Interpolation render tick (~RTT/2 + INTERP_DELAY_MS behind
   * the server's present).
   */
  getRemotePlayers(nowMs: number): PlayerFrame[] {
    const out = this.remoteList;
    out.length = 0;
    const state = this.stateRef;
    if (!state) return out;
    const tick = this.renderTick(nowMs);
    state.players.forEach((view, id) => {
      if (id === this.sessionIdValue) return;
      let frame = this.remoteFrames.get(id);
      if (!frame) {
        frame = emptyPlayerFrame(id, false);
        this.remoteFrames.set(id, frame);
      }
      if (!this.interpolation.sample(id, tick, frame)) copyPlayerSim(view, frame);
      fillPlayerMeta(frame, view);
      out.push(frame);
    });
    return out;
  }

  /** Every ball to render this frame (dead-reckoned server balls + predicted throws). */
  getBalls(): BallFrame[] {
    const held = this.prediction.active ? this.prediction.current.heldCount : Number.POSITIVE_INFINITY;
    return this.ballSync.getFrames(this.sessionIdValue, held);
  }

  dispose(): void {
    const room = this.room;
    this.generation++;
    this.teardown();
    this.statusValue = "disconnected";
    // Not a consented leave: the stored token survives, so a reload can still rejoin.
    if (room) void leaveQuietly(room, false);
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

  private async open(request: (client: Client) => Promise<BonkRoom>): Promise<void> {
    if (this.inSession()) throw { kind: "unknown", message: MESSAGES.busy } satisfies NetError;
    const gen = ++this.generation;
    const previous = this.statusValue;
    this.statusValue = "connecting";
    try {
      const room = await request(this.getClient());
      if (gen !== this.generation) {
        void leaveQuietly(room, true);
        throw { kind: "unknown", message: MESSAGES.unknown } satisfies NetError;
      }
      await this.adopt(room, false);
    } catch (err) {
      if (gen === this.generation) {
        this.teardown();
        this.statusValue = previous === "disconnected" ? "disconnected" : "idle";
      }
      throw toNetError(err);
    }
  }

  /** Bind a joined room and wait for its first full state (onPatch completes the join). */
  private adopt(room: BonkRoom, reconnected: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.joining?.room === room) this.failJoin({ kind: "serverDown", message: MESSAGES.serverDown });
      }, FIRST_STATE_TIMEOUT_MS);
      this.joining = {
        room,
        reconnected,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.bindRoom(room);
    });
  }

  private failJoin(err: NetError): void {
    const join = this.joining;
    if (!join) return;
    this.joining = null;
    if (this.room === join.room) this.room = null;
    void leaveQuietly(join.room, true);
    join.reject(err);
  }

  private bindRoom(room: BonkRoom): void {
    this.room = room;
    this.sessionIdValue = room.sessionId;
    this.codeValue = room.roomId;
    this.ballSync.setLocalId(room.sessionId);
    this.bindMessage(room, MSG.PING, (msg) => this.onPing(msg));
    this.bindMessage(room, MSG.WELCOME, (msg) => this.onWelcome(msg));
    for (const type of SERVER_MESSAGES) {
      if (type !== MSG.PING && type !== MSG.WELCOME) this.bindMessage(room, type);
    }
    room.onStateChange((state) => {
      if (room === this.room) this.onPatch(state);
    });
    room.onLeave((code) => {
      if (room === this.room) this.onRoomClosed(code);
    });
  }

  /** Re-emit a server message on `events`, after optional net-side handling. */
  private bindMessage<K extends ServerMessageType>(
    room: BonkRoom,
    type: K,
    before?: (payload: NetEventMap[K]) => void,
  ): void {
    room.onMessage<NetEventMap[K]>(type, (payload) => {
      if (room !== this.room) return;
      before?.(payload);
      this.events.emit(type, payload);
    });
  }

  private onPing(msg: PingMsg): void {
    this.send(MSG.PONG, { t: msg.t });
    if (Number.isFinite(msg.tick)) this.clock.sample(msg.tick, performance.now(), this.me?.ping ?? 0);
  }

  private onWelcome(msg: WelcomeMsg): void {
    if (Number.isFinite(msg.tick)) this.clock.sample(msg.tick, performance.now(), this.me?.ping ?? 0);
  }

  /** The socket closed (server side, network, or after our own leave, which detaches first). */
  private onRoomClosed(code: number): void {
    const join = this.joining;
    if (join && join.room === this.room) {
      this.failJoin({ kind: "serverDown", message: MESSAGES.serverDown });
      return;
    }
    this.room = null;
    this.prediction.stop();
    const token = readToken();
    if (isFinalClose(code) || !token) {
      const error: NetError = isFinalClose(code)
        ? { kind: "kicked", message: code === 1000 ? MESSAGES.kicked : MESSAGES.roomClosed }
        : { kind: "serverDown", message: MESSAGES.lostConnection };
      this.finish(error);
      return;
    }
    this.statusValue = "reconnecting";
    void this.reconnectLoop(++this.generation, token);
  }

  /** Retry the stored token with backoff for up to RECONNECT_GRACE_SEC (TECH_BRIEF §4). */
  private async reconnectLoop(gen: number, token: string): Promise<void> {
    const deadline = performance.now() + RECONNECT_GRACE_SEC * 1000;
    let error: NetError = { kind: "serverDown", message: MESSAGES.lostConnection };
    for (let attempt = 1; gen === this.generation && performance.now() < deadline; attempt++) {
      this.events.emit("reconnecting", { attempt });
      try {
        const room = await this.getClient().reconnect<BonkStateView>(token);
        if (gen !== this.generation) {
          void leaveQuietly(room, true);
          return;
        }
        await this.adopt(room, true);
        return;
      } catch (err) {
        if (gen !== this.generation) return;
        if (isRoomGone(err)) {
          error = { kind: "notFound", message: MESSAGES.roomClosed };
          break;
        }
      }
      const wait = RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)];
      await delay(Math.max(0, Math.min(wait, deadline - performance.now())));
    }
    if (gen === this.generation) this.finish(error);
  }

  /** Gone for good: forget the room and tell the app. */
  private finish(error: NetError): void {
    clearToken();
    this.teardown();
    this.statusValue = "disconnected";
    this.events.emit("disconnected", { error });
  }

  private teardown(): void {
    if (this.joining) {
      const join = this.joining;
      this.joining = null;
      join.reject({ kind: "unknown", message: MESSAGES.unknown });
    }
    this.room = null;
    this.stateRef = null;
    this.sessionIdValue = "";
    this.codeValue = "";
    this.lastPhase = null;
    this.knownPlayers.clear();
    this.prediction.stop();
    this.handoff.reset();
    this.interpolation.clear();
    this.ballSync.clear();
    this.clock.reset();
    this.remoteFrames.clear();
    this.ownerCache.clear();
  }

  private send<K extends keyof ClientMessages>(type: K, message: ClientMessages[K]): void {
    const room = this.room;
    if (!room || !room.connection?.isOpen) return;
    try {
      room.send(type, message);
    } catch (err) {
      console.warn(`[net] couldn't send "${type}"`, err);
    }
  }

  /* =============================================================== state */

  private onPatch(state: BonkStateView): void {
    const now = performance.now();
    this.nowMs = now;
    const join = this.joining && this.joining.room === this.room ? this.joining : null;
    if (join) this.resetForNewState();
    this.stateRef = state;
    const me = state.players.get(this.sessionIdValue) ?? null;
    this.clock.sample(state.tick, now, me?.ping ?? 0);
    this.floor.arena = getArena(state.mapId);
    this.floor.rings = state.rings;

    const added: PlayerView[] = [];
    const removed: string[] = [];
    this.syncPlayers(state, added, removed);
    this.syncPrediction(state, me);
    this.ownerStamp++;
    this.ballSync.onServerState(state.balls, state.tick, this.clock.serverTickAt(now), this.floor, this.owners);

    const previous = this.lastPhase;
    this.lastPhase = state.phase;
    if (join) this.completeJoin(join);
    for (const player of added) this.events.emit("playerAdded", player);
    for (const id of removed) this.events.emit("playerRemoved", { id });
    if (join) this.events.emit("phase", { phase: state.phase, previous: "lobby" });
    else if (previous !== null && previous !== state.phase) this.events.emit("phase", { phase: state.phase, previous });
    this.events.emit("state", state);
    join?.resolve();
  }

  /** A (re)joined room has a new decoded state and maybe a long gap: drop time-based caches. */
  private resetForNewState(): void {
    this.clock.reset();
    this.interpolation.clear();
    this.ballSync.clear();
    this.ballSync.setLocalId(this.sessionIdValue);
    this.prediction.stop();
    this.handoff.reset();
    this.ownerCache.clear();
  }

  private completeJoin(join: PendingJoin): void {
    this.joining = null;
    this.statusValue = "connected";
    storeToken(join.room.reconnectionToken);
    this.events.emit("connected", { code: this.codeValue, sessionId: this.sessionIdValue, reconnected: join.reconnected });
  }

  /** Snapshot every player into Interpolation and collect roster changes. */
  private syncPlayers(state: BonkStateView, added: PlayerView[], removed: string[]): void {
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
      this.ownerCache.delete(id);
      removed.push(id);
    }
  }

  private syncPrediction(state: BonkStateView, me: PlayerView | null): void {
    const predict = me !== null && me.alive && !me.spectator && PREDICTED_PHASES.has(state.phase);
    if (!predict) {
      if (this.prediction.active) this.prediction.stop();
      return;
    }
    if (!this.prediction.active) {
      this.prediction.reset(me);
      return;
    }
    this.prediction.reconcile(me, this.simContext(state, me, !isUnlockedPhase(state.phase)));
  }

  private simContext(state: BonkStateView, me: PlayerView, locked: boolean): SimContext {
    const ctx = (this.simCtx ??= { arena: this.floor.arena, rings: state.rings, character: me.character, dt: DT, locked });
    ctx.arena = getArena(state.mapId);
    ctx.rings = state.rings;
    ctx.character = me.character;
    ctx.dt = DT;
    ctx.locked = locked;
    return ctx;
  }

  /**
   * Lock for an input predicted now: during the countdown, an input that reaches the server
   * (≈ RTT/2 from the server's present) on or after the "go" tick is not locked there.
   */
  private predictedLock(state: BonkStateView, nowMs: number): boolean {
    if (isUnlockedPhase(state.phase)) return false;
    if (state.phase !== "countdown" || !this.clock.synced) return true;
    const goTick = state.tick + state.phaseTicksLeft;
    const arrivalTick = this.clock.serverTickAt(nowMs) + this.clock.rttMs / 2 / TICK_MS;
    return arrivalTick < goTick;
  }

  private spawnPredictedThrow(seq: number, t: ThrowRequest): void {
    const velocities = computeThrowVelocities(t.charge, t.yaw, t.pitch, t.powerUp);
    const origin = vec3(t.origin.x, t.origin.y, t.origin.z);
    this.ballSync.addPredictedThrow(this.sessionIdValue, seq, origin, velocities, ballKindForPowerUp(t.powerUp), t.charge, t.curve);
  }

  /* ======================================================= render helpers */

  /** Interpolation render tick: the server's present minus one-way latency and the buffer. */
  private renderTick(nowMs: number): number {
    return this.clock.serverTickAt(nowMs) - (this.clock.rttMs / 2 + INTERP_DELAY_MS) / TICK_MS;
  }

  /** Aim / chest / hand of the owner as rendered this frame (cached per frame). */
  private resolveOwner(id: string): OwnerInfo | null {
    let entry = this.ownerCache.get(id);
    if (entry && entry.stamp === this.ownerStamp) return entry.valid ? entry.info : null;
    if (!entry) {
      entry = { stamp: 0, valid: false, info: { aim: vec3(), chest: vec3(), hand: vec3(), alive: false } };
      this.ownerCache.set(id, entry);
    }
    entry.stamp = this.ownerStamp;
    const sim = this.ownerSim(id);
    entry.valid = sim !== null;
    if (!sim) return null;
    const info = entry.info;
    aimDirection(sim.yaw, sim.pitch, info.aim);
    chestPosition(sim, info.chest);
    throwOrigin(sim, info.hand);
    info.alive = sim.alive;
    return info;
  }

  private ownerSim(id: string): PlayerSimFields | null {
    if (id === this.sessionIdValue && this.prediction.active) return this.prediction.current;
    if (this.interpolation.sample(id, this.renderTick(this.nowMs), this.ownerScratch)) return this.ownerScratch;
    return this.stateRef?.players.get(id) ?? null;
  }
}

function isUnlockedPhase(phase: Phase): boolean {
  return phase === "playing" || phase === "suddenDeath";
}

function defaultEndpoint(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

function emptyPlayerFrame(id: string, isLocal: boolean): PlayerFrame {
  return {
    ...createPlayerSim(),
    id,
    isLocal,
    character: "quacky",
    slot: 0,
    nickname: "",
    hearts: 0,
    connected: true,
    spectator: false,
  };
}

function fillPlayerMeta(frame: PlayerFrame, view: PlayerView): void {
  frame.id = view.id;
  frame.character = view.character;
  frame.slot = view.slot;
  frame.nickname = view.nickname;
  frame.hearts = view.hearts;
  frame.connected = view.connected;
  frame.spectator = view.spectator;
}

/** Leave without throwing or hanging; never writes to an already-closed socket. */
async function leaveQuietly(room: BonkRoom, consented: boolean): Promise<void> {
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

function readToken(): string | null {
  try {
    return sessionStorage.getItem(RECONNECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string): void {
  if (!token) return;
  try {
    sessionStorage.setItem(RECONNECT_STORAGE_KEY, token);
  } catch {
    // Private mode / blocked storage: reload-reconnect is a convenience only.
  }
}

function clearToken(): void {
  try {
    sessionStorage.removeItem(RECONNECT_STORAGE_KEY);
  } catch {
    // See storeToken.
  }
}
