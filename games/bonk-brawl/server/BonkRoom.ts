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
//
// Robustness: every message handler and every fixed tick runs inside a try/catch that logs and
// carries on, so one bad payload or bug never takes the room down.

import { Room, ServerError, type Client } from "@colyseus/core";
import {
  ballsForPlayers,
  EMOTE_COOLDOWN_TICKS,
  EMPTY_ROOM_DISPOSE_SEC,
  MAX_HEARTS,
  MAX_PLAYERS,
  MIN_PLAYERS_TO_START,
  PATCH_INTERVAL_MS,
  PING_INTERVAL_MS,
  RECONNECT_GRACE_SEC,
  rewindTicksForRtt,
  ROUND_END_SLOWMO_SCALE,
  TICK_MS,
  TICK_RATE,
} from "../shared/constants.js";
import { getArena } from "../shared/maps.js";
import type {
  CharacterMsg,
  CreateOptions,
  EmoteMsg,
  InputCmd,
  JoinOptions,
  NoticeKind,
  PongMsg,
  ReadyMsg,
  RematchMsg,
  ServerMessages,
  SettingsMsg,
  StartMsg,
} from "../shared/protocol.js";
import { JOIN_ERROR, JOIN_ERROR_TEXT, MSG } from "../shared/protocol.js";
import type { MapId, Phase, Vec3Like } from "../shared/types.js";
import { GAME_ID, getRoomCodes } from "./hub.js";
import {
  checkJoinOptions,
  fallbackNickname,
  firstFreeCharacter,
  isCharacterId,
  isEmoteId,
  lowestFreeSlot,
  nextHost,
  parseSettingsPatch,
  readBoolean,
  readField,
  resolveMap,
  uniqueNickname,
} from "./room/lobby.js";
import { nextRttEma, rttSample } from "./room/ping.js";
import { RoundSchedule } from "./room/schedule.js";
import { awardRoundWin, crownLeader, rankStandings, scoreEvent, stalemateWinner } from "./room/scoring.js";
import { countdownNumber, roomTimings, wantsFastTimers, type RoomTimings } from "./room/timings.js";
import { BonkState, PlayerState } from "./schema.js";
import { isBroadcastEvent, toMessage, type GameEvent } from "./world/events.js";
import { GameWorld, type WorldStepOptions } from "./world/World.js";

/** Fixed ticks run per simulation-interval callback at most (excess dropped after a stall). */
const MAX_TICKS_PER_CALL = 4;
/** Phases in which a round is running (alive players get eliminated when they leave). */
const ROUND_PHASES: ReadonlySet<Phase> = new Set<Phase>(["countdown", "playing", "suddenDeath"]);
const COUNTDOWN_STEP: WorldStepOptions = { dtScale: 1, locked: true, combat: false };
const FIGHT_STEP: WorldStepOptions = { dtScale: 1, locked: false, combat: true };
const SLOWMO_STEP: WorldStepOptions = { dtScale: ROUND_END_SLOWMO_SCALE, locked: true, combat: false };
const MAX_PING_MS = 0xffff;
/**
 * Close code for the room closing itself (empty-room dispose): Colyseus' WS_CLOSE_CONSENTED. The
 * client treats 1000/4000 as final and auto-reconnects on any other code.
 */
const ROOM_CLOSED_CODE = 4000;

type ClockTimer = ReturnType<Room["clock"]["setTimeout"]>;

export class BonkRoom extends Room<BonkState> {
  maxClients = MAX_PLAYERS;
  autoDispose = false;

  /** The 4-letter code (=== roomId). */
  protected code = "";
  /** Shortened test timers (CreateOptions.fast && process.env.BONK_TEST === "1"). */
  protected fast = false;
  protected world!: GameWorld;

  private timings: Readonly<RoomTimings> = roomTimings(false);
  private schedule = new RoundSchedule(this.timings);
  private readonly random: () => number = Math.random;
  /** Real milliseconds not yet simulated. */
  private accumulator = 0;
  /** sessionIds in join order (host migration). */
  private readonly joinOrder: string[] = [];
  private readonly rtt = new Map<string, number>();
  private readonly lastEmoteTick = new Map<string, number>();
  /** sessionIds playing the current round (alive at its start). */
  private participants: string[] = [];
  private lastCountdown = -1;
  /** Tick the current roundEnd / matchEnd phase began. */
  private phaseStartTick = 0;
  /** Last eliminated player of the round (KO camera cut). */
  private lastEliminated: { id: string; pos: Vec3Like } | null = null;
  private emptyTimer: ClockTimer | null = null;
  private disposed = false;

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
    this.fast = wantsFastTimers(readField(options, "fast"));
    this.timings = roomTimings(this.fast);
    this.schedule = new RoundSchedule(this.timings, this.random);
    this.patchRate = PATCH_INTERVAL_MS;
    this.setSimulationInterval((dt) => this.onTick(dt), TICK_MS);

    this.onMessage(MSG.INPUT, this.guarded("input", (client, msg) => this.handleInput(client, msg as InputCmd)));
    this.onMessage(MSG.READY, this.guarded("ready", (client, msg) => this.handleReady(client, msg as ReadyMsg)));
    this.onMessage(MSG.CHARACTER, this.guarded("character", (client, msg) => this.handleCharacter(client, msg as CharacterMsg)));
    this.onMessage(MSG.SETTINGS, this.guarded("settings", (client, msg) => this.handleSettings(client, msg as SettingsMsg)));
    this.onMessage(MSG.START, this.guarded("start", (client, msg) => this.handleStart(client, msg as StartMsg)));
    this.onMessage(MSG.EMOTE, this.guarded("emote", (client, msg) => this.handleEmote(client, msg as EmoteMsg)));
    this.onMessage(MSG.REMATCH, this.guarded("rematch", (client, msg) => this.handleRematch(client, msg as RematchMsg)));
    this.onMessage(MSG.PONG, this.guarded("pong", (client, msg) => this.handlePong(client, msg as PongMsg)));
    this.onMessage("*", () => undefined);

    this.clock.setInterval(() => this.sendPings(), PING_INTERVAL_MS);
    this.armEmptyTimer();
  }

  /**
   * Validate join options BEFORE a seat is taken. Throws `new ServerError(JOIN_ERROR.X, text)`:
   * a non-string nickname → BAD_NICKNAME; a character that isn't a CharacterId → BAD_CHARACTER;
   * a room that already has MAX_PLAYERS players → ROOM_FULL (Colyseus itself rejects a locked,
   * full room's joinById with 4212 "is locked", which the client maps to the same "Room full").
   * Nicknames are sanitized (invisible characters stripped, whitespace collapsed, trimmed, capped
   * at NICKNAME_MAX); an empty one gets a fallback name in onJoin ("Player N"), duplicates get
   * " 2", " 3" appended.
   */
  onAuth(client: Client, options: JoinOptions): boolean {
    void client;
    const check = checkJoinOptions(options);
    if (!check.ok) throw new ServerError(check.code, check.message);
    if (this.state.players.size >= MAX_PLAYERS) {
      throw new ServerError(JOIN_ERROR.ROOM_FULL, JOIN_ERROR_TEXT[JOIN_ERROR.ROOM_FULL]);
    }
    return true;
  }

  /**
   * Add a PlayerState: id = sessionId, nickname, character, slot = lowest free slot 0..7,
   * connected = true, ready = false, alive = false. First player (or no host) → hostId.
   * Phase lobby → normal player. Any other phase → spectator = true (watches with the ghost camera
   * until matchEnd → lobby, where spectator flags are cleared). world.clearInputs(id). Send
   * MSG.WELCOME to the client and a MSG.NOTICE "joined" to the others (plus "spectating" to the
   * joiner when spectator). Cancel the empty-room dispose timer.
   * A joiner without a character gets the first one nobody in the room uses (duplicates are
   * allowed when picked explicitly; colors come from slots).
   */
  onJoin(client: Client, options: JoinOptions): void {
    const check = checkJoinOptions(options);
    const slot = lowestFreeSlot(Array.from(this.state.players.values(), (p) => p.slot));
    if (slot < 0) throw new ServerError(JOIN_ERROR.ROOM_FULL, JOIN_ERROR_TEXT[JOIN_ERROR.ROOM_FULL]);

    const id = client.sessionId;
    const p = new PlayerState();
    p.id = id;
    p.slot = slot;
    const wanted = check.ok && check.nickname ? check.nickname : fallbackNickname(slot);
    p.nickname = uniqueNickname(wanted, Array.from(this.state.players.values(), (o) => o.nickname));
    p.character = check.ok && check.character ? check.character : firstFreeCharacter(Array.from(this.state.players.values(), (o) => o.character));
    p.connected = true;
    p.ready = false;
    p.alive = false;
    p.hearts = MAX_HEARTS;
    p.spectator = this.state.phase !== "lobby";
    this.state.players.set(id, p);
    this.joinOrder.push(id);
    if (!this.state.hostId || !this.state.players.has(this.state.hostId)) this.state.hostId = id;
    this.world.clearInputs(id);
    this.cancelEmptyTimer();

    this.sendWelcome(client, false);
    this.notice("joined", `${p.nickname} joined`, id, client);
    if (p.spectator) this.noticeTo(client, "spectating", "A match is in progress: you're spectating until it ends.", id);
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
    const id = client.sessionId;
    try {
      const p = this.state.players.get(id);
      if (!p) return;
      if (consented || this.disposed) {
        this.removePlayer(id, "left");
        return;
      }
      p.connected = false;
      this.notice("reconnecting", `${p.nickname} lost connection…`, id);
      this.armEmptyTimerIfEmpty();
      let rejoined: Client | null = null;
      try {
        rejoined = await this.allowReconnection(client, RECONNECT_GRACE_SEC);
      } catch {
        rejoined = null;
      }
      if (rejoined) this.onReconnected(rejoined);
      else this.removePlayer(id, "dropped");
    } catch (err) {
      this.logError("onLeave", err);
    }
  }

  /** Release the room code (getRoomCodes().release(code)). */
  onDispose(): void {
    this.disposed = true;
    this.cancelEmptyTimer();
    if (this.code) getRoomCodes().release(this.code);
  }

  /**
   * Called by setSimulationInterval with the real elapsed ms. Accumulates it and runs one fixed
   * 30 Hz server tick per TICK_MS due (see "Fixed rate" at the top of this file).
   * Per-tick phase behavior:
   * - lobby / matchEnd: no world step (matchEnd counts phaseTicksLeft down → returnToLobby).
   * - countdown: broadcast COUNTDOWN n=3,2,1 at each whole second and n=0 at the end → playing;
   *   world.step({ dtScale: 1, locked: true, combat: false }).
   * - playing: scheduler (ball respawns, power-ups) → world.step({ 1, false, true }); at
   *   phaseTicksLeft 0 → suddenDeath (broadcast SUDDEN_DEATH, spawn the extra ball).
   * - suddenDeath: same as playing plus the ring schedule: every RING_DROP_INTERVAL_TICKS shake
   *   world.outermostSolidRing() and drop it RING_SHAKE_TICKS later (first shake immediately on
   *   entering sudden death). Stalemate guard: STALEMATE_TICKS after the last droppable ring fell,
   *   the alive player with the most hearts wins the round (a tie → no winner, no +3).
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
    this.accumulator += Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
    let ticks = 0;
    while (this.accumulator >= TICK_MS && ticks < MAX_TICKS_PER_CALL) {
      this.accumulator -= TICK_MS;
      ticks++;
      try {
        this.fixedTick();
      } catch (err) {
        this.logError(`tick ${this.state.tick}`, err);
      }
    }
    if (this.accumulator >= TICK_MS) this.accumulator = 0;
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
   * Broadcast every isBroadcastEvent(ev) as this.broadcast(ev.type, toMessage(ev)). Then update
   * crownId: the unique player with the most points (> 0), else "".
   */
  protected applyEvents(events: GameEvent[]): void {
    for (const ev of events) {
      try {
        scoreEvent(ev, (id) => this.state.players.get(id));
        if (ev.type === "ko" || ev.type === "ringOut") this.lastEliminated = { id: ev.playerId, pos: ev.pos };
        if (ev.type === "ballLost" && ev.respawn && this.isFighting()) this.schedule.onBallLost(ev.tick);
        if (isBroadcastEvent(ev)) this.broadcast(ev.type, toMessage(ev));
      } catch (err) {
        this.logError(`event ${ev.type}`, err);
      }
    }
    this.updateCrown();
  }

  /** Moves/look/buttons for the sender's player: world.queueInput (alive participants only). */
  protected handleInput(client: Client, msg: InputCmd): void {
    if (!ROUND_PHASES.has(this.state.phase)) return;
    const p = this.state.players.get(client.sessionId);
    if (!p || !p.alive || p.spectator) return;
    this.world.queueInput(client.sessionId, msg);
  }

  /** Lobby only, non-spectators: player.ready = msg.ready (must be a boolean). */
  protected handleReady(client: Client, msg: ReadyMsg): void {
    if (this.state.phase !== "lobby") return;
    const p = this.state.players.get(client.sessionId);
    const ready = readBoolean(msg, "ready");
    if (!p || p.spectator || ready === null) return;
    p.ready = ready;
  }

  /** Lobby only: valid CharacterId → player.character (duplicates allowed; the ready flag is kept). */
  protected handleCharacter(client: Client, msg: CharacterMsg): void {
    if (this.state.phase !== "lobby") return;
    const p = this.state.players.get(client.sessionId);
    const character = readField(msg, "character");
    if (!p || !isCharacterId(character)) return;
    p.character = character;
  }

  /** Host only, lobby only: map in MapChoice, rounds in ROUND_OPTIONS, powerUps boolean. */
  protected handleSettings(client: Client, msg: SettingsMsg): void {
    if (this.state.phase !== "lobby" || client.sessionId !== this.state.hostId) return;
    const patch = parseSettingsPatch(msg);
    const settings = this.state.settings;
    if (patch.map !== undefined) settings.map = patch.map;
    if (patch.rounds !== undefined) settings.rounds = patch.rounds;
    if (patch.powerUps !== undefined) settings.powerUps = patch.powerUps;
    if (patch.map !== undefined && patch.map !== "random") this.loadMap(patch.map);
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
    void msg;
    if (this.state.phase !== "lobby" || client.sessionId !== this.state.hostId) return;
    const blocker = this.startBlocker();
    if (blocker) {
      this.noticeTo(client, "cantStart", blocker);
      return;
    }
    this.startMatch();
  }

  /** Any phase, any player (ghosts too). Rate-limited by EMOTE_COOLDOWN_TICKS; broadcast EMOTE. */
  protected handleEmote(client: Client, msg: EmoteMsg): void {
    const id = client.sessionId;
    const emote = readField(msg, "emote");
    if (!this.state.players.has(id) || !isEmoteId(emote)) return;
    const tick = this.state.tick;
    const last = this.lastEmoteTick.get(id);
    if (last !== undefined && tick - last < EMOTE_COOLDOWN_TICKS) return;
    this.lastEmoteTick.set(id, tick);
    this.sendAll(MSG.EMOTE, { tick, playerId: id, emote });
  }

  /**
   * matchEnd only, after MATCH_END_MIN_TICKS: return everyone to the lobby (phase lobby, round 0,
   * all ready = false, spectator = false, alive = false, places cleared, points kept until the
   * next start), then sender.ready = !!msg.ready. Notice "rematch".
   */
  protected handleRematch(client: Client, msg: RematchMsg): void {
    if (this.state.phase !== "matchEnd") return;
    if (this.state.tick - this.phaseStartTick < this.timings.matchEndMinTicks) return;
    const sender = this.state.players.get(client.sessionId);
    if (!sender) return;
    const ready = readBoolean(msg, "ready") === true;
    this.returnToLobby();
    sender.ready = ready;
    const text = ready ? `${sender.nickname} wants a rematch!` : `${sender.nickname} went back to the lobby`;
    this.notice("rematch", text, sender.id);
  }

  /** RTT = Date.now() - msg.t; EMA with RTT_EMA_ALPHA → player.ping; world.setRewindTicks(rewindTicksForRtt). */
  protected handlePong(client: Client, msg: PongMsg): void {
    const id = client.sessionId;
    const p = this.state.players.get(id);
    const sample = rttSample(msg, Date.now());
    if (!p || sample === null) return;
    const ema = nextRttEma(this.rtt.get(id), sample);
    this.rtt.set(id, ema);
    p.ping = Math.min(MAX_PING_MS, Math.round(ema));
    this.world.setRewindTicks(id, rewindTicksForRtt(ema));
  }

  /* ======================================================== fixed tick */

  private fixedTick(): void {
    this.state.tick++;
    const events = this.advancePhase();
    events.push(...this.world.drainEvents());
    this.applyEvents(events);
    this.checkRoundOver();
  }

  private advancePhase(): GameEvent[] {
    switch (this.state.phase) {
      case "countdown":
        return this.tickCountdown();
      case "playing":
        return this.tickFight(false);
      case "suddenDeath":
        return this.tickFight(true);
      case "roundEnd":
        return this.tickRoundEnd();
      case "matchEnd":
        return this.tickMatchEnd();
      default:
        return this.world.drainEvents();
    }
  }

  private countDownPhase(): number {
    this.state.phaseTicksLeft = Math.max(0, this.state.phaseTicksLeft - 1);
    return this.state.phaseTicksLeft;
  }

  /**
   * The "go" tick (state.tick + phaseTicksLeft as seen during the countdown) is already the first
   * playing tick: the input consumed on it is unlocked, which is what client prediction assumes.
   */
  private tickCountdown(): GameEvent[] {
    const left = this.countDownPhase();
    this.broadcastCountdown(countdownNumber(left));
    if (left > 0) return this.world.step(COUNTDOWN_STEP);
    this.enterPlaying();
    return this.tickFight(false);
  }

  private tickFight(suddenDeath: boolean): GameEvent[] {
    const tick = this.state.tick;
    this.schedule.update(tick, this.world);
    const events = this.world.step(FIGHT_STEP);
    if (suddenDeath) {
      this.state.phaseTicksLeft = this.schedule.ticksToNextDrop(tick, this.world);
    } else if (this.countDownPhase() === 0) {
      this.enterSuddenDeath();
    }
    return events;
  }

  private tickRoundEnd(): GameEvent[] {
    const left = this.countDownPhase();
    const inSlowMo = this.state.tick - this.phaseStartTick <= this.timings.roundEndSlowmoTicks;
    const events = inSlowMo ? this.world.step(SLOWMO_STEP) : this.world.drainEvents();
    if (left === 0) this.afterRoundEnd();
    return events;
  }

  private tickMatchEnd(): GameEvent[] {
    const events = this.world.drainEvents();
    if (this.countDownPhase() === 0) this.returnToLobby();
    return events;
  }

  private broadcastCountdown(n: number): void {
    if (n === this.lastCountdown) return;
    this.lastCountdown = n;
    this.sendAll(MSG.COUNTDOWN, { tick: this.state.tick, round: this.state.round, n });
  }

  /* ======================================================= match flow */

  /** Why the host can't start yet, or "" when the match can start. */
  private startBlocker(): string {
    const players = this.eligiblePlayers();
    const connected = players.filter((p) => p.connected);
    if (connected.length < MIN_PLAYERS_TO_START) return `Need at least ${MIN_PLAYERS_TO_START} players to start`;
    const away = players.find((p) => !p.connected);
    if (away) return `Waiting for ${away.nickname} to reconnect`;
    const unready = players.find((p) => !p.ready);
    if (unready) return `Waiting for ${unready.nickname} to get ready`;
    return "";
  }

  private startMatch(): void {
    this.state.players.forEach((p) => {
      p.points = 0;
      p.roundPoints = 0;
      p.place = 0;
      const s = p.stats;
      s.throws = 0;
      s.hits = 0;
      s.catches = 0;
      s.ringOuts = 0;
      s.kos = 0;
      s.roundWins = 0;
    });
    this.state.totalRounds = this.state.settings.rounds;
    this.state.matchWinnerId = "";
    this.state.roundWinnerId = "";
    this.updateCrown();
    this.startRound(1);
  }

  private startRound(round: number): void {
    const players = this.eligiblePlayers();
    if (players.length < MIN_PLAYERS_TO_START) {
      this.endMatch();
      return;
    }
    const tick = this.state.tick;
    this.loadMap(resolveMap(this.state.settings.map, this.state.mapId, this.random));
    this.participants = players.map((p) => p.id);
    this.world.resetForRound(this.participants);
    this.state.players.forEach((p) => {
      p.roundPoints = 0;
    });
    this.schedule.clear();
    this.lastEliminated = null;
    this.state.round = round;
    this.state.roundWinnerId = "";
    this.state.phase = "countdown";
    this.state.phaseTicksLeft = this.timings.countdownTicks;

    this.sendAll(MSG.ROUND_START, {
      tick,
      round,
      totalRounds: this.state.totalRounds,
      mapId: this.state.mapId,
      participants: [...this.participants],
    });
    const balls = ballsForPlayers(this.participants.length, false);
    for (let i = 0; i < balls; i++) this.world.spawnBall();
    this.applyEvents(this.world.drainEvents());
    this.lastCountdown = -1;
    this.broadcastCountdown(countdownNumber(this.state.phaseTicksLeft));
  }

  private enterPlaying(): void {
    this.state.phase = "playing";
    this.state.phaseTicksLeft = this.timings.roundTicks;
    this.schedule.startPlaying(this.state.tick, this.participants.length, this.state.settings.powerUps);
  }

  private enterSuddenDeath(): void {
    const tick = this.state.tick;
    this.state.phase = "suddenDeath";
    this.sendAll(MSG.SUDDEN_DEATH, { tick, round: this.state.round });
    this.schedule.startSuddenDeath(tick, this.world);
    this.state.phaseTicksLeft = this.schedule.ticksToNextDrop(tick, this.world);
  }

  /** After applyEvents: ≤ 1 participant alive (or the stalemate guard) decides the round. */
  private checkRoundOver(): void {
    if (!this.isFighting()) return;
    const alive = this.world.alivePlayers();
    if (alive.length <= 1) {
      this.endRound(alive[0] ?? "");
      return;
    }
    if (this.state.phase === "suddenDeath" && this.schedule.stalemateDue(this.state.tick)) {
      const hearts = alive.map((id) => ({ id, hearts: this.state.players.get(id)?.hearts ?? 0 }));
      this.endRound(stalemateWinner(hearts));
    }
  }

  private endRound(winnerId: string): void {
    const tick = this.state.tick;
    const winner = winnerId ? this.state.players.get(winnerId) : undefined;
    if (winner) awardRoundWin(winner);
    this.state.roundWinnerId = winner ? winnerId : "";
    const more = this.state.round < this.state.totalRounds && this.eligiblePlayers().length >= MIN_PLAYERS_TO_START;
    this.sendAll(MSG.ROUND_WIN, {
      tick,
      round: this.state.round,
      winnerId: this.state.roundWinnerId,
      finalVictimId: this.lastEliminated?.id ?? "",
      finalPos: this.lastEliminated?.pos ?? null,
      roundPoints: this.roundPointsById(),
      nextRound: more ? this.state.round + 1 : 0,
    });
    this.schedule.clear();
    this.state.phase = "roundEnd";
    this.state.phaseTicksLeft = this.timings.roundEndSlowmoTicks + this.timings.roundEndCardTicks;
    this.phaseStartTick = tick;
    this.updateCrown();
  }

  private afterRoundEnd(): void {
    const more = this.state.round < this.state.totalRounds && this.eligiblePlayers().length >= MIN_PLAYERS_TO_START;
    if (more) this.startRound(this.state.round + 1);
    else this.endMatch();
  }

  private endMatch(): void {
    const standings = rankStandings(this.eligiblePlayers());
    this.state.players.forEach((p) => {
      p.place = 0;
    });
    for (const s of standings) {
      const p = this.state.players.get(s.id);
      if (p) p.place = s.place;
    }
    this.state.matchWinnerId = standings[0]?.id ?? "";
    this.schedule.clear();
    this.state.phase = "matchEnd";
    this.state.phaseTicksLeft = this.timings.matchEndLobbyTicks;
    this.phaseStartTick = this.state.tick;
    this.sendAll(MSG.MATCH_END, { tick: this.state.tick, winnerId: this.state.matchWinnerId, standings });
    this.updateCrown();
  }

  private returnToLobby(): void {
    this.state.phase = "lobby";
    this.state.round = 0;
    this.state.phaseTicksLeft = 0;
    this.world.resetForRound([]);
    this.state.players.forEach((p) => {
      p.ready = false;
      p.spectator = false;
      p.place = 0;
    });
    this.schedule.clear();
    this.participants = [];
    this.lastEliminated = null;
  }

  /* ===================================================== players */

  private onReconnected(client: Client): void {
    const id = client.sessionId;
    const p = this.state.players.get(id);
    if (!p) return;
    p.connected = true;
    this.world.clearInputs(id);
    this.cancelEmptyTimer();
    this.notice("reconnected", `${p.nickname} is back`, id);
    this.sendWelcome(client, true);
  }

  private removePlayer(id: string, reason: "left" | "dropped"): void {
    const p = this.state.players.get(id);
    if (!p) return;
    if (p.alive && ROUND_PHASES.has(this.state.phase)) {
      this.world.eliminate(id, "disconnect");
      this.applyEvents(this.world.drainEvents());
    }
    this.world.removePlayer(id);
    this.state.players.delete(id);
    const order = this.joinOrder.indexOf(id);
    if (order >= 0) this.joinOrder.splice(order, 1);
    this.rtt.delete(id);
    this.lastEmoteTick.delete(id);
    this.participants = this.participants.filter((pid) => pid !== id);

    if (this.state.hostId === id) this.migrateHost();
    this.notice(reason, reason === "left" ? `${p.nickname} left` : `${p.nickname} dropped out`, id);
    this.updateCrown();
    this.armEmptyTimerIfEmpty();
  }

  private migrateHost(): void {
    const host = nextHost(this.joinOrder, (pid) => this.state.players.get(pid)?.connected);
    this.state.hostId = host;
    const p = host ? this.state.players.get(host) : undefined;
    if (p) this.notice("hostChanged", `${p.nickname} is now the host`, host);
  }

  /** Non-spectator players (including ones inside the reconnect window), in slot order. */
  private eligiblePlayers(): PlayerState[] {
    return Array.from(this.state.players.values())
      .filter((p) => !p.spectator)
      .sort((a, b) => a.slot - b.slot);
  }

  private roundPointsById(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.eligiblePlayers()) out[p.id] = p.roundPoints;
    return out;
  }

  private updateCrown(): void {
    const leader = crownLeader(Array.from(this.state.players.values(), (p) => ({ id: p.id, points: p.points })));
    if (this.state.crownId !== leader) this.state.crownId = leader;
  }

  private isFighting(): boolean {
    return this.state.phase === "playing" || this.state.phase === "suddenDeath";
  }

  private loadMap(mapId: MapId): void {
    if (this.state.mapId === mapId && this.world.arena.id === mapId) return;
    this.state.mapId = mapId;
    this.world.setArena(getArena(mapId));
  }

  /* ============================================== messages & timers */

  /** Typed broadcast of a server → client message. */
  private sendAll<K extends keyof ServerMessages>(type: K, msg: ServerMessages[K]): void {
    this.broadcast(type, msg);
  }

  private sendWelcome(client: Client, reconnected: boolean): void {
    const msg: ServerMessages["welcome"] = {
      code: this.code,
      sessionId: client.sessionId,
      tick: this.state.tick,
      tickRate: TICK_RATE,
      fast: this.fast,
      reconnected,
    };
    client.send(MSG.WELCOME, msg);
  }

  private notice(kind: NoticeKind, text: string, playerId?: string, except?: Client): void {
    const msg: ServerMessages["notice"] = playerId ? { kind, text, playerId } : { kind, text };
    this.broadcast(MSG.NOTICE, msg, except ? { except } : undefined);
  }

  private noticeTo(client: Client, kind: NoticeKind, text: string, playerId?: string): void {
    const msg: ServerMessages["notice"] = playerId ? { kind, text, playerId } : { kind, text };
    client.send(MSG.NOTICE, msg);
  }

  private sendPings(): void {
    try {
      this.sendAll(MSG.PING, { t: Date.now(), tick: this.state.tick });
    } catch (err) {
      this.logError("ping", err);
    }
  }

  private armEmptyTimer(): void {
    if (this.emptyTimer || this.disposed) return;
    this.emptyTimer = this.clock.setTimeout(() => {
      this.emptyTimer = null;
      if (this.clients.length > 0) return;
      this.disconnect(ROOM_CLOSED_CODE).catch((err: unknown) => this.logError("dispose", err));
    }, EMPTY_ROOM_DISPOSE_SEC * 1000);
  }

  private armEmptyTimerIfEmpty(): void {
    if (this.clients.length === 0) this.armEmptyTimer();
  }

  private cancelEmptyTimer(): void {
    this.emptyTimer?.clear();
    this.emptyTimer = null;
  }

  /** Wrap a message handler so a bad payload or a bug is logged instead of thrown. */
  private guarded(label: string, handler: (client: Client, msg: unknown) => void): (client: Client, msg: unknown) => void {
    return (client, msg) => {
      try {
        handler(client, msg);
      } catch (err) {
        this.logError(`message ${label}`, err);
      }
    };
  }

  private logError(where: string, err: unknown): void {
    console.error(`[bonk-brawl ${this.code}] ${where} failed:`, err);
  }
}
