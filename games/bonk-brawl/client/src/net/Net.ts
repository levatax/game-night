// Connection, room, typed messaging, and the facade over prediction/interpolation/balls.
// Owner: client-net.

import type {
  CreateOptions,
  InputCmd,
  JoinOptions,
  SettingsMsg,
} from "../../../shared/protocol";
import type { StepPlayerResult } from "../../../shared/sim/player";
import type { BonkStateView, CharacterId, EmoteId, PlayerSimFields, PlayerView } from "../../../shared/types";
import { Emitter } from "../util/Emitter";
import { Clock } from "./Clock";
import type { BallFrame, NetEventMap, NetStatus, PlayerFrame } from "./types";

export interface NetOptions {
  /** WebSocket endpoint. Default: same origin, `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`. */
  endpoint?: string;
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
 */
export class Net {
  readonly events = new Emitter<NetEventMap>();
  readonly clock = new Clock();

  constructor(opts: NetOptions = {}) {
    void opts;
  }

  get status(): NetStatus {
    return "idle"; // TODO(client-net)
  }

  /** Own sessionId ("" when not connected). */
  get sessionId(): string {
    return "";
  }

  /** Room code ("" when not connected). */
  get code(): string {
    return "";
  }

  /** Live decoded state (read-only!) or null. */
  get state(): BonkStateView | null {
    return null;
  }

  /** Own PlayerView from state, or null. */
  get me(): PlayerView | null {
    return null;
  }

  get isHost(): boolean {
    return false;
  }

  /** True while the controller should sample and send inputs (alive participant in countdown/playing/suddenDeath). */
  get wantsInput(): boolean {
    return false;
  }

  /** Latest predicted local sim (HUD: charge, cooldowns, heldCount, powerUp...), or null if not predicting. */
  get localSim(): Readonly<PlayerSimFields> | null {
    return null;
  }

  createRoom(opts: CreateOptions): Promise<void> {
    void opts;
    return Promise.reject({ kind: "serverDown", message: "Not implemented" }); // TODO(client-net)
  }

  joinRoom(code: string, opts: JoinOptions): Promise<void> {
    void code;
    void opts;
    return Promise.reject({ kind: "serverDown", message: "Not implemented" }); // TODO(client-net)
  }

  /** Resolves true if a stored reconnection token rejoined a room. Never rejects. */
  async tryReconnect(): Promise<boolean> {
    return false;
  }

  /** Consented leave; clears the stored token; emits `disconnected` { error: null }. */
  async leave(): Promise<void> {}

  sendReady(ready: boolean): void {
    void ready;
  }

  sendCharacter(character: CharacterId): void {
    void character;
  }

  sendSettings(patch: SettingsMsg): void {
    void patch;
  }

  sendStart(): void {}

  sendEmote(emote: EmoteId): void {
    void emote;
  }

  sendRematch(ready: boolean): void {
    void ready;
  }

  /**
   * Send one 30 Hz input and predict it. Returns the first-prediction StepPlayerResult, or null
   * when not predicting (then the input isn't sent either). On result.throw: spawns predicted
   * balls in BallSync (computeThrowVelocities) and emits `localThrow`; always emits `localStep`.
   */
  sendInput(cmd: InputCmd): StepPlayerResult | null {
    void cmd;
    return null;
  }

  /** Per render frame: advance BallSync, smoothing and the clock. */
  update(nowMs: number, dtSec: number): void {
    void nowMs;
    void dtSec;
  }

  /**
   * Local player frame (predicted, interpolated by `alpha` = fixed-step accumulator fraction).
   * yaw/pitch are overridden with `look` (the Input's current values) for zero-latency aiming.
   * When not predicting (round-end slow-mo, ghost, spectator, matchEnd) returns the local player
   * snapshot-interpolated exactly like a remote player (smooth, server yaw/pitch), falling back to
   * the raw server state when no snapshot exists yet; null if absent.
   */
  getLocalPlayer(alpha: number, look: { yaw: number; pitch: number }): PlayerFrame | null {
    void alpha;
    void look;
    return null;
  }

  /**
   * Every other player in state.players (alive or not; spectators included — Characters hides
   * them), snapshot-interpolated at the Interpolation render tick (~RTT/2 + INTERP_DELAY_MS behind
   * the server's present).
   */
  getRemotePlayers(nowMs: number): PlayerFrame[] {
    void nowMs;
    return [];
  }

  /** Every ball to render this frame (dead-reckoned server balls + predicted throws). */
  getBalls(): BallFrame[] {
    return [];
  }

  dispose(): void {
    this.events.clear();
  }
}
