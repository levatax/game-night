// The Colyseus room. Owner: server-room (helpers go in server/room/**).
//
// BonkRoom owns the room LIFECYCLE and the MATCH RULES around the simulation:
// - join/leave/reconnect, nickname/character validation, slots, host migration, spectators
// - lobby: ready, character select, host settings, start
// - phases & timers (state.phase / phaseTicksLeft / round / totalRounds / mapId)
// - spawn SCHEDULING (initial balls, respawns, sudden-death extra ball, power-up timer + type/
//   pedestal choice, warning → activate) and the sudden-death ring schedule (shake → drop)
// - scoring (points, roundPoints), stats, crown, round winner, standings/places, rematch
// - ping/RTT (EMA → player.ping and world.setRewindTicks), welcome/notice messages
// - turning GameWorld events into broadcasts
// Every in-tick gameplay rule lives in GameWorld (server/world/World.ts).
//
// Tick order (setSimulationInterval at TICK_MS, patchRate PATCH_INTERVAL_MS):
//   state.tick++ → phase timer/scheduler work (spawns, rings, countdown numbers, transitions)
//   → world.step(opts for the phase) → applyEvents (scoring/stats/crown + broadcast)
//   → round-end check → (Colyseus sends the patch on its own 20 Hz timer).
// Fixed rate: setSimulationInterval is a plain setInterval and Node truncates 33.33 ms to 33 ms
// (≈ 30.3 Hz), so onTick(deltaMs) accumulates real time and runs as many fixed ticks as are due
// (while acc >= TICK_MS; at most 4 per call, dropping the excess after a stall). The sim must
// average exactly TICK_RATE ticks per second to match the clients' 30 Hz input stream and clock.

import { Room, type Client } from "@colyseus/core";
import { MAX_PLAYERS, PATCH_INTERVAL_MS, TICK_MS } from "../shared/constants.js";
import { getArena } from "../shared/maps.js";
import type {
  CharacterMsg,
  CreateOptions,
  EmoteMsg,
  InputCmd,
  JoinOptions,
  PongMsg,
  ReadyMsg,
  RematchMsg,
  SettingsMsg,
  StartMsg,
} from "../shared/protocol.js";
import { MSG } from "../shared/protocol.js";
import { GAME_ID, getRoomCodes } from "./hub.js";
import { BonkState } from "./schema.js";
import type { GameEvent } from "./world/events.js";
import { GameWorld } from "./world/World.js";

export class BonkRoom extends Room<BonkState> {
  maxClients = MAX_PLAYERS;
  autoDispose = false;

  /** The 4-letter code (=== roomId). */
  protected code = "";
  /** Shortened test timers (CreateOptions.fast && process.env.BONK_TEST === "1"). */
  protected fast = false;
  protected world!: GameWorld;

  /**
   * - code = getRoomCodes().allocate(GAME_ID); this.roomId = code.
   * - state = new BonkState(); state.mapId = settings map (or DEFAULT_MAP); world = new GameWorld(...).
   * - fast = !!options.fast && process.env.BONK_TEST === "1" (use FAST_TIMINGS everywhere).
   * - setSimulationInterval(onTick, TICK_MS); patchRate = PATCH_INTERVAL_MS.
   * - register every ClientMessages handler (MSG.INPUT ... MSG.PONG). Validate payloads defensively
   *   (they come from untrusted clients): wrong types → ignore silently.
   * - ping interval: every PING_INTERVAL_MS send MSG.PING { t: Date.now(), tick } to each client.
   * - start the empty-room dispose timer (EMPTY_ROOM_DISPOSE_SEC) until the first join. With
   *   autoDispose = false the room disposes itself with this.disconnect() when that timer fires.
   */
  onCreate(options: CreateOptions): void {
    this.code = getRoomCodes().allocate(GAME_ID);
    this.roomId = this.code;
    this.state = new BonkState();
    this.world = new GameWorld(this.state, getArena(this.state.mapId));
    this.fast = !!options?.fast && process.env.BONK_TEST === "1";
    this.patchRate = PATCH_INTERVAL_MS;
    this.setSimulationInterval((dt) => this.onTick(dt), TICK_MS);

    this.onMessage(MSG.INPUT, (client, msg: InputCmd) => this.handleInput(client, msg));
    this.onMessage(MSG.READY, (client, msg: ReadyMsg) => this.handleReady(client, msg));
    this.onMessage(MSG.CHARACTER, (client, msg: CharacterMsg) => this.handleCharacter(client, msg));
    this.onMessage(MSG.SETTINGS, (client, msg: SettingsMsg) => this.handleSettings(client, msg));
    this.onMessage(MSG.START, (client, msg: StartMsg) => this.handleStart(client, msg));
    this.onMessage(MSG.EMOTE, (client, msg: EmoteMsg) => this.handleEmote(client, msg));
    this.onMessage(MSG.REMATCH, (client, msg: RematchMsg) => this.handleRematch(client, msg));
    this.onMessage(MSG.PONG, (client, msg: PongMsg) => this.handlePong(client, msg));
  }

  /**
   * Validate join options BEFORE a seat is taken. Throw `new ServerError(JOIN_ERROR.X, text)`:
   * nickname trimmed, control chars stripped, length NICKNAME_MIN..NICKNAME_MAX (else BAD_NICKNAME);
   * character in CHARACTER_IDS (else BAD_CHARACTER). Duplicate nicknames get " 2", " 3" appended
   * in onJoin. (A 5th client is rejected by Colyseus itself because maxClients = 4.)
   */
  onAuth(client: Client, options: JoinOptions): boolean {
    void client;
    void options;
    return true; // TODO(server-room)
  }

  /**
   * Add a PlayerState: id = sessionId, nickname, character, slot = lowest free slot 0..3,
   * connected = true, ready = false, alive = false. First player (or no host) → hostId.
   * Phase lobby → normal player. Any other phase → spectator = true (watches with the ghost camera
   * until matchEnd → lobby, where spectator flags are cleared). world.clearInputs(id). Send
   * MSG.WELCOME to the client and a MSG.NOTICE "joined" to the others (plus "spectating" to the
   * joiner when spectator). Cancel the empty-room dispose timer.
   */
  onJoin(client: Client, options: JoinOptions): void {
    void client;
    void options;
    // TODO(server-room)
  }

  /**
   * consented (left on purpose) → remove now. Otherwise: connected = false, notice "reconnecting",
   * await this.allowReconnection(client, RECONNECT_GRACE_SEC). While disconnected the player
   * stays in the round standing still (the world feeds a neutral input) and can be hit. On
   * success: connected = true, world.clearInputs(id) (a reloaded client restarts its seq at 1),
   * notice "reconnected", re-send WELCOME { reconnected: true }. On timeout: remove.
   * Removing a player (consented or timed out): if alive mid-round → world.eliminate(id,
   * "disconnect") first (kill feed "dropped"; the round can then be decided normally: the last
   * one alive wins it). Then delete from state.players, world.removePlayer, release the slot,
   * migrate host to the next player in join order (notice "hostChanged"), notice "dropped"/"left".
   * When no clients remain, dispose the room (this.disconnect()) after EMPTY_ROOM_DISPOSE_SEC
   * unless someone joins.
   */
  async onLeave(client: Client, consented?: boolean): Promise<void> {
    void client;
    void consented;
    // TODO(server-room)
  }

  /** Release the room code (getRoomCodes().release(code)). */
  onDispose(): void {
    getRoomCodes().release(this.code);
  }

  /**
   * Called by setSimulationInterval with the real elapsed ms. Accumulates it and runs one fixed
   * 30 Hz server tick per TICK_MS due (see "Fixed rate" at the top of this file); the placeholder
   * body below runs exactly one tick per call and must be replaced. Per-tick phase behavior:
   * - lobby / matchEnd: no world step (matchEnd counts phaseTicksLeft down → returnToLobby).
   * - countdown: broadcast COUNTDOWN n=3,2,1 at each whole second and n=0 at the end → playing;
   *   world.step({ dtScale: 1, locked: true, combat: false }).
   * - playing: scheduler (ball respawns, power-ups) → world.step({ 1, false, true }); at
   *   phaseTicksLeft 0 → suddenDeath (broadcast SUDDEN_DEATH, spawn the extra ball).
   * - suddenDeath: same as playing plus the ring schedule: every RING_DROP_INTERVAL_TICKS shake
   *   world.outermostSolidRing() and drop it RING_SHAKE_TICKS later (first shake immediately on
   *   entering sudden death).
   * - roundEnd: first ROUND_END_SLOWMO_TICKS: world.step({ dtScale: ROUND_END_SLOWMO_SCALE,
   *   locked: true, combat: false }); then the card (no step) for ROUND_END_CARD_TICKS; then the
   *   next round's countdown or matchEnd. matchEnd is also entered early when a new round would
   *   start with fewer than MIN_PLAYERS_TO_START participants (everyone else left).
   * - lobby / matchEnd / round-end card: still applyEvents(world.drainEvents()) every tick
   *   (spawns or disconnect KOs produced outside step()).
   * The round is decided right after applyEvents when ≤ 1 participant is alive (0 = draw).
   * Participants of a round = non-spectator players in state.players at its start (including
   * anyone inside the reconnect grace window).
   * Returning to the lobby (rematch or MATCH_END_LOBBY_TICKS timeout): phase lobby, round 0,
   * world.resetForRound([]) (clears balls/power-ups/rings, everyone alive = false), ready = false,
   * spectator = false, place = 0, all schedules cleared; points/stats kept until the next start.
   */
  protected onTick(deltaMs: number): void {
    void deltaMs;
    this.state.tick++;
    // TODO(server-room)
  }

  /**
   * Score + broadcast world events, in order:
   * - throw → thrower stats.throws += ev.ballIds.length (balls thrown, so a Triple Shot counts 3
   *   and accuracy = hits / throws never exceeds 100%).
   * - hit → thrower points/roundPoints += POINTS.hit, stats.hits++.
   * - catch → catcher += POINTS.catch, stats.catches++.
   * - ko → if byId && byId !== playerId: byId stats.kos++ (no extra points).
   * - ringOut → if creditId: creditId += POINTS.ringOut, stats.ringOuts++.
   * - ballLost (internal) → if respawn: schedule spawnBall in BALL_RESPAWN_TICKS when below target.
   * Broadcast every isBroadcastEvent(ev) as this.broadcast(ev.type, ev). Then update crownId:
   * the unique player with the most points (> 0), else "".
   */
  protected applyEvents(events: GameEvent[]): void {
    void events;
    // TODO(server-room)
  }

  /** Moves/look/buttons for the sender's player: world.queueInput (alive participants only). */
  protected handleInput(client: Client, msg: InputCmd): void {
    void client;
    void msg;
  }

  /** Lobby only, non-spectators: player.ready = !!msg.ready. */
  protected handleReady(client: Client, msg: ReadyMsg): void {
    void client;
    void msg;
  }

  /** Lobby only: valid CharacterId → player.character (duplicates allowed; the ready flag is kept). */
  protected handleCharacter(client: Client, msg: CharacterMsg): void {
    void client;
    void msg;
  }

  /** Host only, lobby only: map in MapChoice, rounds in ROUND_OPTIONS, powerUps boolean. */
  protected handleSettings(client: Client, msg: SettingsMsg): void {
    void client;
    void msg;
  }

  /**
   * Host only, lobby only. Requires ≥ MIN_PLAYERS_TO_START connected non-spectators, all ready
   * (else NOTICE "cantStart" to the host with the reason). Starts the match: points/stats/places
   * reset, totalRounds = settings.rounds, round 1 → countdown.
   * Each round start: resolve the map (random → a different MapId than last round; fixed → it),
   * world.setArena, world.resetForRound(participants), spawn ballsForPlayers(n, false) balls
   * (dropIndex 0..k-1), reset power-up/ring/respawn schedules, roundPoints = 0, broadcast ROUND_START.
   */
  protected handleStart(client: Client, msg: StartMsg): void {
    void client;
    void msg;
  }

  /** Any phase, any player (ghosts too). Rate-limited by EMOTE_COOLDOWN_TICKS; broadcast EMOTE. */
  protected handleEmote(client: Client, msg: EmoteMsg): void {
    void client;
    void msg;
  }

  /**
   * matchEnd only, after MATCH_END_MIN_TICKS: return everyone to the lobby (phase lobby, round 0,
   * all ready = false, spectator = false, alive = false, places cleared, points kept until the
   * next start), then sender.ready = !!msg.ready. Notice "rematch".
   */
  protected handleRematch(client: Client, msg: RematchMsg): void {
    void client;
    void msg;
  }

  /** RTT = Date.now() - msg.t; EMA with RTT_EMA_ALPHA → player.ping; world.setRewindTicks(rewindTicksForRtt). */
  protected handlePong(client: Client, msg: PongMsg): void {
    void client;
    void msg;
  }
}
