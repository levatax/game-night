// Connection + typed messaging. Owner: client-net. PUBLIC API IS THE CONTRACT; fill in the bodies.
// Net is the ONLY module that imports colyseus.js. Everything else uses this API.
//
// - Endpoint: same origin, `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`.
// - create(): client.create(ROOM_NAME, opts); join(code): client.joinById(code.toUpperCase(), opts).
//   Store room.reconnectionToken in sessionStorage[RECONNECT_STORAGE_KEY] (try/catch); tryReconnect()
//   uses it after a page reload. Map errors to NetError codes ("notFound" | "full" | "serverDown" | "unknown").
// - Unexpected close: emit "reconnecting", retry client.reconnect(token) with backoff for up to
//   RECONNECT_GRACE_SEC, then emit "disconnected".
// - Every server message (MSG.WELCOME … MSG.NOTICE) is re-emitted on `events` under the same name with its
//   typed payload (see NetEvents). Also emit "state" after every patch (room.onStateChange) and "phase"
//   when state.phase changes (with the previous phase).
// - hover(): throttle to HOVER_SEND_HZ internally (drop extra calls, always send the latest pose on the
//   next slot).

import { Client, type Room } from "colyseus.js";
import { HOVER_SEND_HZ, RECONNECT_GRACE_SEC, RECONNECT_STORAGE_KEY, ROOM_NAME } from "../../../shared/constants";
import type { EmoteId } from "../../../shared/constants";
import { JOIN_ERROR, MSG } from "../../../shared/protocol";
import type {
  BetSide,
  BetsMsg,
  DroppedMsg,
  EmotedMsg,
  HiccupMsg,
  ImpactMsg,
  JellyStateView,
  NoticeMsg,
  Phase,
  Pose,
  ResultMsg,
  RevealMsg,
  RigStatusMsg,
  RoleMsg,
  SettingsMsg,
  SpinResultMsg,
  SpinStartMsg,
  ToppleMsg,
  VotesMsg,
  WelcomeMsg,
} from "../../../shared/protocol";
import { Emitter } from "../util/Emitter";

export type NetErrorCode = "notFound" | "full" | "serverDown" | "unknown";
export class NetError extends Error {
  constructor(
    public code: NetErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface NetEvents {
  state: JellyStateView;
  phase: { phase: Phase; prev: Phase | null };
  welcome: WelcomeMsg;
  role: RoleMsg;
  rigStatus: RigStatusMsg;
  spinStart: SpinStartMsg;
  spinResult: SpinResultMsg;
  dropped: DroppedMsg;
  impact: ImpactMsg;
  hiccup: HiccupMsg;
  topple: ToppleMsg;
  result: ResultMsg;
  bets: BetsMsg;
  votes: VotesMsg;
  reveal: RevealMsg;
  emoted: EmotedMsg;
  notice: NoticeMsg;
  reconnecting: void;
  reconnected: void;
  disconnected: void;
}

type JellyRoom = Room<JellyStateView>;

/** Server → client message names, re-emitted 1:1 on `events`. */
const RELAYED = [
  MSG.WELCOME,
  MSG.ROLE,
  MSG.RIG_STATUS,
  MSG.SPIN_START,
  MSG.SPIN_RESULT,
  MSG.DROPPED,
  MSG.IMPACT,
  MSG.HICCUP,
  MSG.TOPPLE,
  MSG.RESULT,
  MSG.BETS,
  MSG.VOTES,
  MSG.REVEAL,
  MSG.EMOTED,
  MSG.NOTICE,
] as const satisfies readonly (keyof NetEvents)[];

/** Close codes that mean "you are gone for good, don't try to reconnect". */
const CONSENTED_CLOSE = 4000;
const FINAL_CLOSE_CODES = new Set<number>([1000, CONSENTED_CLOSE, JOIN_ERROR.FULL, JOIN_ERROR.BAD_NAME]);
/** Colyseus matchmaker codes. */
const MATCHMAKE_INVALID_ROOM_ID = 4212;
const MATCHMAKE_EXPIRED = 4214;

const HOVER_INTERVAL_MS = 1000 / HOVER_SEND_HZ;
const BACKOFF_MS = [400, 800, 1500, 2500, 4000];

// ---------------------------------------------------------------- token storage
function loadToken(): string | null {
  try {
    return sessionStorage.getItem(RECONNECT_STORAGE_KEY);
  } catch {
    return null;
  }
}
function saveToken(token: string): void {
  try {
    sessionStorage.setItem(RECONNECT_STORAGE_KEY, token);
  } catch {
    /* private mode / blocked storage: reload-rejoin just won't work */
  }
}
function clearToken(): void {
  try {
    sessionStorage.removeItem(RECONNECT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// ----------------------------------------------------------------- error mapping
/** Turns whatever colyseus.js threw into a NetError with a silly-but-helpful message. */
export function toNetError(err: unknown): NetError {
  if (err instanceof NetError) return err;
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "number" ? e.code : undefined;
  const msg = typeof e?.message === "string" ? e.message : "";

  if (code === JOIN_ERROR.FULL || /\b(locked|full)\b/i.test(msg)) {
    return new NetError("full", "That kitchen is full. Six chefs is already too many cooks!");
  }
  if (code === MATCHMAKE_INVALID_ROOM_ID || code === MATCHMAKE_EXPIRED || /not found/i.test(msg)) {
    return new NetError("notFound", "No kitchen with that code. Did you type it with oven mitts on?");
  }
  if (code === JOIN_ERROR.BAD_NAME) {
    return new NetError("unknown", "The head chef rejected that nickname. Try another one!");
  }
  // No numeric code (fetch/XHR failure, ProgressEvent, TypeError) or an HTTP 5xx → the server is unreachable.
  if (code === undefined || code === 0 || (code >= 500 && code < 600) || err instanceof TypeError) {
    return new NetError("serverDown", "Can't reach the kitchen. The oven might be unplugged.");
  }
  return new NetError("unknown", msg || `Something burned (error ${code}).`);
}

function endpoint(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------------------- Net
export class Net {
  readonly events = new Emitter<NetEvents>();

  private client: Client | null = null;
  private room: JellyRoom | null = null;
  /** True while the websocket of `room` is open (false during the reconnect loop). */
  private live = false;
  private lastPhase: Phase | null = null;
  /** Bumped on every leave/new room so stale reconnect loops and callbacks stop. */
  private generation = 0;

  // hover throttle
  private lastHoverAt = -Infinity;
  private pendingHover: Pose | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;

  /** Latest synced state, or null when not in a room. */
  get state(): JellyStateView | null {
    return this.room ? ((this.room.state as JellyStateView | undefined) ?? null) : null;
  }
  /** Own session id ("" when not connected). */
  get myId(): string {
    return this.room?.sessionId ?? "";
  }
  /** Room code ("" when not connected). */
  get code(): string {
    if (!this.room) return "";
    return this.state?.code || this.room.roomId || "";
  }
  get connected(): boolean {
    return this.live && this.room !== null;
  }

  /** Create a room, resolves with its code. */
  async create(nickname: string): Promise<string> {
    this.dropRoom();
    const gen = this.generation;
    let room: JellyRoom;
    try {
      room = await this.getClient().create<JellyStateView>(ROOM_NAME, { nickname });
    } catch (err) {
      throw toNetError(err);
    }
    if (gen !== this.generation) {
      void room.leave(true);
      throw new NetError("unknown", "Cancelled.");
    }
    this.attach(room);
    return this.code;
  }

  async join(code: string, nickname: string): Promise<void> {
    const clean = code.trim().toUpperCase();
    if (!clean) throw new NetError("notFound", "Type a room code first. The kitchen needs an address!");
    this.dropRoom();
    const gen = this.generation;
    let room: JellyRoom;
    try {
      room = await this.getClient().joinById<JellyStateView>(clean, { nickname });
    } catch (err) {
      throw toNetError(err);
    }
    if (gen !== this.generation) {
      void room.leave(true);
      throw new NetError("unknown", "Cancelled.");
    }
    this.attach(room);
  }

  /** Rejoin after a page reload if a token is stored. Resolves false when there is nothing to rejoin. */
  async tryReconnect(): Promise<boolean> {
    if (this.room) return true;
    const token = loadToken();
    if (!token) return false;
    const gen = this.generation;
    try {
      const room = await this.getClient().reconnect<JellyStateView>(token);
      if (gen !== this.generation) {
        void room.leave(true);
        return false;
      }
      this.attach(room);
      return true;
    } catch {
      clearToken();
      return false;
    }
  }

  leave(): void {
    clearToken();
    const room = this.room;
    this.dropRoom();
    if (room) {
      try {
        void room.leave(true).catch(() => undefined);
      } catch {
        /* socket already closed */
      }
    }
  }

  ready(ready: boolean): void {
    this.send(MSG.READY, { ready });
  }
  color(color: number): void {
    this.send(MSG.COLOR, { color });
  }
  settings(patch: SettingsMsg): void {
    this.send(MSG.SETTINGS, patch);
  }
  start(): void {
    this.send(MSG.START, {});
  }
  spin(): void {
    this.send(MSG.SPIN, {});
  }
  /** Throttled to HOVER_SEND_HZ. */
  hover(pose: Pose): void {
    this.pendingHover = { ...pose };
    const now = performance.now();
    const wait = this.lastHoverAt + HOVER_INTERVAL_MS - now;
    if (wait <= 0) {
      this.flushHover();
    } else if (this.hoverTimer === null) {
      this.hoverTimer = setTimeout(() => {
        this.hoverTimer = null;
        this.flushHover();
      }, wait);
    }
  }
  drop(pose: Pose): void {
    this.cancelHover();
    this.send(MSG.DROP, { ...pose });
  }
  rig(): void {
    this.send(MSG.RIG, {});
  }
  bet(side: BetSide, amount: number): void {
    this.send(MSG.BET, { side, amount });
  }
  vote(suspectId: string): void {
    this.send(MSG.VOTE, { suspectId });
  }
  emote(emote: EmoteId): void {
    this.send(MSG.EMOTE, { emote });
  }
  rematch(): void {
    this.send(MSG.REMATCH, {});
  }

  // ------------------------------------------------------------------- internals
  private getClient(): Client {
    this.client ??= new Client(endpoint());
    return this.client;
  }

  private send(type: string, payload: object): void {
    if (!this.room || !this.live) return;
    try {
      this.room.send(type, payload);
    } catch (err) {
      console.warn(`[net] send "${type}" failed`, err);
    }
  }

  private flushHover(): void {
    const pose = this.pendingHover;
    if (!pose) return;
    this.pendingHover = null;
    this.lastHoverAt = performance.now();
    this.send(MSG.HOVER, pose);
  }

  private cancelHover(): void {
    if (this.hoverTimer !== null) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.pendingHover = null;
  }

  /** Forget the current room locally (no network). Stops any reconnect loop. */
  private dropRoom(): void {
    this.generation++;
    this.cancelHover();
    if (this.room) this.room.removeAllListeners();
    this.room = null;
    this.live = false;
    this.lastPhase = null;
  }

  /** Wire a freshly joined/reconnected room. Keeps lastPhase so a reconnect only emits real phase changes. */
  private attach(room: JellyRoom): void {
    const gen = this.generation;
    this.room = room;
    this.live = true;
    if (room.reconnectionToken) saveToken(room.reconnectionToken);

    for (const name of RELAYED) {
      room.onMessage(name, (payload: NetEvents[typeof name]) => {
        if (gen !== this.generation || this.room !== room) return;
        (this.events.emit as (k: keyof NetEvents, p: unknown) => void)(name, payload);
      });
    }

    room.onStateChange((state) => {
      if (gen !== this.generation || this.room !== room) return;
      const phase = state.phase;
      if (phase !== this.lastPhase) {
        const prev = this.lastPhase;
        this.lastPhase = phase;
        this.events.emit("phase", { phase, prev });
      }
      this.events.emit("state", state);
    });

    room.onError((code, message) => {
      console.warn(`[net] room error (${code}) ${message ?? ""}`);
    });

    room.onLeave((code) => {
      if (gen !== this.generation || this.room !== room) return; // we left / replaced it on purpose
      this.live = false;
      this.cancelHover();
      if (FINAL_CLOSE_CODES.has(code)) {
        clearToken();
        this.dropRoom();
        this.events.emit("disconnected", undefined);
        return;
      }
      void this.reconnectLoop(room.reconnectionToken || loadToken() || "", gen);
    });

    // A state may already be decoded by the time we attach (join resolves after the first full state).
    if (room.state && (room.state as Partial<JellyStateView>).phase !== undefined) {
      const state = room.state;
      if (state.phase !== this.lastPhase) {
        const prev = this.lastPhase;
        this.lastPhase = state.phase;
        this.events.emit("phase", { phase: state.phase, prev });
      }
      this.events.emit("state", state);
    }
  }

  /** Retry client.reconnect with backoff for up to RECONNECT_GRACE_SEC; the stale state stays readable meanwhile. */
  private async reconnectLoop(token: string, gen: number): Promise<void> {
    this.events.emit("reconnecting", undefined);
    const deadline = performance.now() + RECONNECT_GRACE_SEC * 1000;
    let attempt = 0;
    while (token && gen === this.generation && performance.now() < deadline) {
      await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
      attempt++;
      if (gen !== this.generation) return;
      try {
        const room = await this.getClient().reconnect<JellyStateView>(token);
        if (gen !== this.generation) {
          void room.leave(true);
          return;
        }
        // Same logical session: keep lastPhase, bump nothing, rewire on the new Room object.
        this.attach(room);
        this.events.emit("reconnected", undefined);
        return;
      } catch (err) {
        const e = toNetError(err);
        // Room gone or token expired: no point hammering the server.
        if (e.code === "notFound") break;
      }
    }
    if (gen !== this.generation) return;
    clearToken();
    this.dropRoom();
    this.events.emit("disconnected", undefined);
  }
}
