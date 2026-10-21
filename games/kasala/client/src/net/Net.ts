// Connection + typed messaging. Owner: client-net-game. PUBLIC API IS THE CONTRACT.
// Net is the ONLY module that imports colyseus.js. Everything else uses this API.
//
// - Endpoint: same origin, `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`.
// - create(): client.create(ROOM_NAME, opts); join(code): client.joinById(code.toUpperCase(), opts).
//   room.reconnectionToken lives in sessionStorage[RECONNECT_STORAGE_KEY]; tryReconnect() uses it after a page
//   reload. Errors become NetError codes ("notFound" | "full" | "serverDown" | "unknown") with Turkish messages.
// - Unexpected close: emit "reconnecting", retry client.reconnect(token) with backoff for up to
//   RECONNECT_GRACE_SEC, then emit "disconnected".
// - Every server message (MSG.WELCOME … MSG.NOTICE) is re-emitted on `events` under the same name with its
//   typed payload. "state" after every patch (room.onStateChange), "phase" when state.phase changes.

import { Client, type Room } from "colyseus.js";
import { CODE_LENGTH, RECONNECT_GRACE_SEC, RECONNECT_STORAGE_KEY, ROOM_NAME } from "../../../shared/constants";
import type { Animal, BetBox, EmoteId } from "../../../shared/constants";
import { JOIN_ERROR, MSG } from "../../../shared/protocol";
import type {
  AddBotMsg,
  AnnouncerMsg,
  AttackMsg,
  BetsSettledMsg,
  CardMsg,
  CashedMsg,
  EliminatedMsg,
  EmotedMsg,
  GhostReturnMsg,
  KasalaStateView,
  LastChanceMsg,
  LoanKind,
  LoanMsg,
  MarketResultMsg,
  MatchEndMsg,
  NoticeMsg,
  Phase,
  RaidedMsg,
  RemoveBotMsg,
  RoundEndMsg,
  SavedMsg,
  SettingsMsg,
  TauntedMsg,
  TaslikMsg,
  TurnStartMsg,
  WelcomeMsg,
  WheelResultMsg,
  WheelStartMsg,
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
  state: KasalaStateView;
  phase: { phase: Phase; prev: Phase | null };
  welcome: WelcomeMsg;
  turnStart: TurnStartMsg;
  card: CardMsg;
  attack: AttackMsg;
  wheelStart: WheelStartMsg;
  wheelResult: WheelResultMsg;
  cashed: CashedMsg;
  raided: RaidedMsg;
  betsSettled: BetsSettledMsg;
  marketResult: MarketResultMsg;
  loan: LoanMsg;
  taslik: TaslikMsg;
  roundEnd: RoundEndMsg;
  lastChance: LastChanceMsg;
  saved: SavedMsg;
  eliminated: EliminatedMsg;
  ghostReturn: GhostReturnMsg;
  matchEnd: MatchEndMsg;
  emoted: EmotedMsg;
  taunted: TauntedMsg;
  announcer: AnnouncerMsg;
  notice: NoticeMsg;
  reconnecting: void;
  reconnected: void;
  disconnected: void;
}

type KasalaRoom = Room<KasalaStateView>;

/** Server → client message names, re-emitted 1:1 on `events`. */
const RELAYED = [
  MSG.WELCOME,
  MSG.TURN_START,
  MSG.CARD,
  MSG.ATTACK,
  MSG.WHEEL_START,
  MSG.WHEEL_RESULT,
  MSG.CASHED,
  MSG.RAIDED,
  MSG.BETS_SETTLED,
  MSG.MARKET_RESULT,
  MSG.LOAN,
  MSG.TASLIK,
  MSG.ROUND_END,
  MSG.LAST_CHANCE,
  MSG.SAVED,
  MSG.ELIMINATED,
  MSG.GHOST_RETURN,
  MSG.MATCH_END,
  MSG.EMOTED,
  MSG.TAUNTED,
  MSG.ANNOUNCER,
  MSG.NOTICE,
] as const satisfies readonly (keyof NetEvents)[];

/** Close codes that mean "you are gone for good, don't try to reconnect". */
const CONSENTED_CLOSE = 4000;
const FINAL_CLOSE_CODES = new Set<number>([1000, CONSENTED_CLOSE, JOIN_ERROR.FULL, JOIN_ERROR.BAD_NAME]);
/** Colyseus matchmaker codes. */
const MATCHMAKE_INVALID_ROOM_ID = 4212;
const MATCHMAKE_EXPIRED = 4214;

const BACKOFF_MS = [400, 800, 1500, 2500, 4000];

export const NET_TEXT = {
  notFound: "Böyle bir masa yok. Kodu bir daha kontrol et.",
  full: "Masa dolu. Altı gangster zaten fazla.",
  serverDown: "Sunucuya bağlanılamadı. Pavyonun kapısı kilitli.",
  badName: "Bu takma ad olmaz. Başka bir tane dene.",
  noCode: "Önce masa kodunu yaz.",
  cancelled: "İptal edildi.",
  unknown: "Bir şeyler ters gitti. Bir daha dene.",
} as const;

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
/** Turns whatever colyseus.js threw into a NetError with a Turkish message. */
export function toNetError(err: unknown): NetError {
  if (err instanceof NetError) return err;
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "number" ? e.code : undefined;
  const msg = typeof e?.message === "string" ? e.message : "";

  if (code === JOIN_ERROR.FULL || /\b(locked|full)\b/i.test(msg)) return new NetError("full", NET_TEXT.full);
  if (code === JOIN_ERROR.BAD_NAME) return new NetError("unknown", NET_TEXT.badName);
  if (code === MATCHMAKE_INVALID_ROOM_ID || code === MATCHMAKE_EXPIRED || /not found/i.test(msg)) {
    return new NetError("notFound", NET_TEXT.notFound);
  }
  // No numeric code (fetch failure, ProgressEvent, TypeError) or an HTTP 5xx → the server is unreachable.
  if (code === undefined || code === 0 || (code >= 500 && code < 600) || err instanceof TypeError) {
    return new NetError("serverDown", NET_TEXT.serverDown);
  }
  return new NetError("unknown", NET_TEXT.unknown);
}

function endpoint(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------------------- Net
export class Net {
  readonly events = new Emitter<NetEvents>();

  private client: Client | null = null;
  private room: KasalaRoom | null = null;
  /** True while the websocket of `room` is open (false during the reconnect loop). */
  private live = false;
  private lastPhase: Phase | null = null;
  /** Code from WELCOME (arrives before the first state patch). */
  private welcomeCode = "";
  /** Bumped on every leave / new room so stale reconnect loops and callbacks stop. */
  private generation = 0;

  /** My session id ("" when not in a room). */
  get myId(): string {
    return this.room?.sessionId ?? "";
  }

  /** Current room state (null when not in a room or before the first patch). */
  get state(): KasalaStateView | null {
    if (!this.room) return null;
    const s = this.room.state as KasalaStateView | undefined;
    return s && (s as Partial<KasalaStateView>).phase !== undefined ? s : null;
  }

  get connected(): boolean {
    return this.live && this.room !== null;
  }

  /** Room code ("" when not in a room). */
  get code(): string {
    if (!this.room) return "";
    return this.state?.code || this.welcomeCode || this.room.roomId || "";
  }

  /** Create a room. Resolves with the 4-letter code. */
  async create(nickname: string): Promise<string> {
    this.dropRoom();
    const gen = this.generation;
    let room: KasalaRoom;
    try {
      room = await this.getClient().create<KasalaStateView>(ROOM_NAME, { nickname });
    } catch (err) {
      throw toNetError(err);
    }
    if (gen !== this.generation) {
      void room.leave(true).catch(() => undefined);
      throw new NetError("unknown", NET_TEXT.cancelled);
    }
    this.attach(room);
    return this.code;
  }

  /** Join by code. Resolves with the code. */
  async join(code: string, nickname: string): Promise<string> {
    const clean = code.trim().toUpperCase();
    if (!clean) throw new NetError("notFound", NET_TEXT.noCode);
    if (clean.length !== CODE_LENGTH || !/^[A-Z]+$/.test(clean)) throw new NetError("notFound", NET_TEXT.notFound);
    this.dropRoom();
    const gen = this.generation;
    let room: KasalaRoom;
    try {
      room = await this.getClient().joinById<KasalaStateView>(clean, { nickname });
    } catch (err) {
      throw toNetError(err);
    }
    if (gen !== this.generation) {
      void room.leave(true).catch(() => undefined);
      throw new NetError("unknown", NET_TEXT.cancelled);
    }
    this.attach(room);
    return this.code || clean;
  }

  /** After a page reload: rejoin with the stored reconnection token. Resolves true on success. */
  async tryReconnect(): Promise<boolean> {
    if (this.room) return true;
    const token = loadToken();
    if (!token) return false;
    const gen = this.generation;
    try {
      const room = await this.getClient().reconnect<KasalaStateView>(token);
      if (gen !== this.generation) {
        void room.leave(true).catch(() => undefined);
        return false;
      }
      this.attach(room);
      return true;
    } catch {
      clearToken();
      return false;
    }
  }

  /** Leave the room for good (consented). */
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

  // ---- client → server (no-ops when not connected)
  ready(ready: boolean): void {
    this.send(MSG.READY, { ready });
  }
  animal(animal: Animal): void {
    this.send(MSG.ANIMAL, { animal });
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
  flip(): void {
    this.send(MSG.FLIP, {});
  }
  cash(): void {
    this.send(MSG.CASH, {});
  }
  target(targetId: string): void {
    this.send(MSG.TARGET, { targetId });
  }
  /** amount 0 = take my bet back, or PAS when I have no bet yet (the box is ignored then). */
  bet(box: BetBox, amount: number): void {
    this.send(MSG.BET, { box, amount });
  }
  /** Pazar: a row card (flipNo), or 0 = pas. */
  market(flipNo: number): void {
    this.send(MSG.MARKET, { flipNo });
  }
  propose(toId: string, kind: LoanKind, amount: number, ratePct: number): void {
    this.send(MSG.LOAN_PROPOSE, { toId, kind, amount, ratePct });
  }
  respond(offerId: string, accept: boolean): void {
    this.send(MSG.LOAN_RESPOND, { offerId, accept });
  }
  cancelOffer(offerId: string): void {
    this.send(MSG.LOAN_CANCEL, { offerId });
  }
  repay(debtId: string, amount: number): void {
    this.send(MSG.LOAN_REPAY, { debtId, amount });
  }
  emote(emote: EmoteId): void {
    this.send(MSG.EMOTE, { emote });
  }
  taunt(index: number): void {
    this.send(MSG.TAUNT, { index });
  }
  rematch(): void {
    this.send(MSG.REMATCH, {});
  }
  /** Host, lobby: seat a bot in the first free seat. */
  addBot(): void {
    this.send(MSG.ADD_BOT, {} satisfies AddBotMsg);
  }
  /** Host, lobby: remove that bot. */
  removeBot(id: string): void {
    if (!id) return;
    this.send(MSG.REMOVE_BOT, { id } satisfies RemoveBotMsg);
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

  /** Forget the current room locally (no network). Stops any reconnect loop. */
  private dropRoom(): void {
    this.generation++;
    if (this.room) this.room.removeAllListeners();
    this.room = null;
    this.live = false;
    this.lastPhase = null;
    this.welcomeCode = "";
  }

  private emitState(state: KasalaStateView): void {
    if ((state as Partial<KasalaStateView>).phase === undefined) return; // not decoded yet
    const phase = state.phase;
    if (phase !== this.lastPhase) {
      const prev = this.lastPhase;
      this.lastPhase = phase;
      this.events.emit("phase", { phase, prev });
    }
    this.events.emit("state", state);
  }

  /** Wire a freshly joined/reconnected room. Keeps lastPhase so a reconnect only emits real phase changes. */
  private attach(room: KasalaRoom): void {
    const gen = this.generation;
    if (this.room && this.room !== room) this.room.removeAllListeners();
    this.room = room;
    this.live = true;
    if (room.reconnectionToken) saveToken(room.reconnectionToken);

    for (const name of RELAYED) {
      room.onMessage(name, (payload: NetEvents[typeof name]) => {
        if (gen !== this.generation || this.room !== room) return;
        if (name === MSG.WELCOME) {
          const code = (payload as WelcomeMsg | undefined)?.code;
          if (typeof code === "string") this.welcomeCode = code;
        }
        (this.events.emit as (k: keyof NetEvents, p: unknown) => void)(name, payload);
      });
    }

    room.onStateChange((state) => {
      if (gen !== this.generation || this.room !== room) return;
      this.emitState(state);
    });

    room.onError((code, message) => {
      console.warn(`[net] room error (${code}) ${message ?? ""}`);
    });

    room.onLeave((code) => {
      if (gen !== this.generation || this.room !== room) return; // we left / replaced it on purpose
      this.live = false;
      if (FINAL_CLOSE_CODES.has(code)) {
        clearToken();
        this.dropRoom();
        this.events.emit("disconnected", undefined);
        return;
      }
      void this.reconnectLoop(room.reconnectionToken || loadToken() || "", gen);
    });

    // A state may already be decoded by the time we attach (join resolves after the first full state).
    if (room.state) this.emitState(room.state);
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
        const room = await this.getClient().reconnect<KasalaStateView>(token);
        if (gen !== this.generation) {
          void room.leave(true).catch(() => undefined);
          return;
        }
        // Same logical session: keep lastPhase, rewire on the new Room object.
        this.attach(room);
        this.events.emit("reconnected", undefined);
        return;
      } catch (err) {
        // Room gone or token expired: no point hammering the server.
        if (toNetError(err).code === "notFound") break;
      }
    }
    if (gen !== this.generation) return;
    clearToken();
    this.dropRoom();
    this.events.emit("disconnected", undefined);
  }
}
