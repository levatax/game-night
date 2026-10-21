// The Colyseus room. Owner: server-room (helpers in server/room/{lobby,timings,ping,text,testing,scoring,rng,registry,
// log,flood}.ts).
//
// RaftRoom owns the room LIFECYCLE and the MATCH FLOW around the simulation:
// - create: refused before anything is allocated when the options are bad / outdated (the JOIN_ERROR a join would
//   get) or the process already runs RAFT_MAX_ROOMS live rooms (SERVER_BUSY, room/registry.ts). The live-room slot
//   and the room code are given back exactly once: in onDispose, or right away when onCreate fails after taking them.
// - join / leave / reconnect: join options validated in onAuth / onJoin (JOIN_ERROR codes, OUTDATED for a client
//   with another PROTOCOL_VERSION), nickname cleaned and
//   made unique (a beachy fallback name by seat), character (first unused when none given), lowest free seat 0..5 kept for
//   the room lifetime, MAX_PLAYERS seats incl. bots and spectators (a full room rejects joins: bots keep their
//   seats). Mid-match joiners spectate until the match ends. A drop (not consented) keeps the seat for
//   RECONNECT_GRACE_SEC: in a match a BotDesk stand-in (BotSeatOptions.standIn: it moves, flees, revives and boards
//   but never spends the absent player's inventory) drives it meanwhile (connected = false, botRole "") and hands it
//   back on reconnection (inventory and position stay, the reconnected client gets a fresh welcome).
//   Leaving for good mid-match (consented, or the grace ran out) turns the seat into a bot (bot = true, same id,
//   name, seat, inventory, botRole from the character) until the lobby, where it is removed.
// - host: the first human; migrates to the next connected human (never a bot) when the host drops or leaves and
//   stays there: a returning ex-host only becomes host again when no connected human holds it (no flip-flop). A
//   dropped host with nobody to hand it to keeps the title through the grace. No human left → no host until one joins.
// - empty room: disposes itself EMPTY_ROOM_DISPOSE_SEC after the last client left, but never while a human is
//   inside the reconnect grace; a room nobody ever joined disposes NEVER_JOINED_DISPOSE_SEC after its creation.
//   Both are deadlines in room time (Σ simulation-interval deltas), so RAFT_TEST's manual clock drives them too.
// - lobby: ready, character, host settings (difficulty, seed: 0 = a random island every match, mode coop; duel is
//   rejected with a notice), add / remove bots (MAX_BOTS; id "bot-<n>", name from BOT_NAMES, role from BOT_ROLES
//   by the name's index, first unused character, always ready), start (host only; every other human ready — the
//   host's Start counts as their own ready; a lone human with no bots gets SOLO_AUTO_BOTS helpers).
// - lobby preview island: the island shown in the lobby is the island played. settings.seed fixed → that seed;
//   0 → a short random seed rolled at creation, at every return to the lobby and when the host clears the seed.
//   A seed change regenerates it (at most every previewCooldownTicks) via world.setIsland and sends a fresh
//   welcome to everyone so clients regenerate too.
// - phases & timers (ARCHITECTURE §4.2): lobby → landing → playing (clockTicks → day / dayPhase broadcasts,
//   stormWarning once on the last night) → launch (world's launchRequest) | storm (night 3 over or teamWiped) →
//   matchEnd (standings, titles, MVP, team score: room/scoring.ts) → lobby (any player's rematch after
//   matchEndMin, or automatically after matchEndLobby). Every human left mid-match → matchEnd "abandoned".
// - per match: gameplay rng (world) and bot rng (desk), separate mulberry32 streams from RAFT_TEST's testSeed or
//   a crypto seed (room/rng.ts); matchStart broadcast + welcome resend at the landing.
// - ping / RTT (EMA → player.ping, world.setRtt), welcome / notice (room/text.ts keys), markers (ping wheel,
//   MARKER_COOLDOWN_TICKS) and emotes (EMOTE_COOLDOWN_TICKS) broadcasts, craft / chest messages → world (a
//   human's through an ActionBudget per kind: actionBurst back to back, then one per actionCooldownTicks; bots
//   through BotHost are not throttled). World `reject` events go to the actor's own client only (none for bots and
//   dropped seats); every other event is broadcast.
// - every client message (inputs included) first spends the client's MessageBudget (room/flood.ts): a flood is
//   dropped before any validation and logged once per client per window. Rate limits, throttled logs and the
//   registry's tick ages run on performance.now() (monotonic: a wall-clock step can't freeze or trip them).
// - BotDesk ticking (server/room/bots.ts) before world.step; bots act through the same act* validation.
// - logs (room/log.ts): one JSON line per lifecycle transition (create, first join, match start, phase change,
//   match end + reason, dispose) plus rate-limited warnings (dropped sim time after a stall, floods, refused
//   creates); the registry slot keeps the last fixed-tick time for server/index.ts health().
// Every in-match gameplay rule lives in RaftWorld (server/world/World.ts).
//
// Tick order (setSimulationInterval at TICK_MS — RAFT_TEST manualClock: RaftRoom.advance instead —, patchRate
// PATCH_INTERVAL_MS; real time is accumulated and up to MAX_TICKS_PER_CALL fixed ticks run per callback, so the
// sim averages exactly TICK_RATE ticks per second; the excess after a stall is dropped and logged):
//   1. state.tick++; lobby / matchEnd: only timers (preview regeneration / auto-lobby), then drained world events.
//   2. landing: phaseTicksLeft--; at 0 → playing (clockTicks 0, dayPhase day 1 broadcast).
//   3. playing: clockTicks++ → clockAt → dayPhase broadcast on change → phaseTicksLeft → stormWarning → over ⇒ storm.
//   4. bots.tick()   5. world.step({ locked: inputLocked(...), clock: playing ? clock : null })
//   6. broadcast events; launchRequest → launch, teamWiped → storm   7. launch / storm timer 0 → matchEnd.
// Every message handler and fixed tick runs inside try/catch (log and carry on).

import { Room, ServerError, type Client } from "@colyseus/core";
import {
  DAYS,
  EMOTE_COOLDOWN_TICKS,
  MARKER_COOLDOWN_TICKS,
  MAX_BOTS,
  MAX_PLAYERS,
  PATCH_INTERVAL_MS,
  PING_INTERVAL_MS,
  SOLO_AUTO_BOTS,
  TICK_MS,
  TICK_RATE,
} from "../shared/constants.js";
import { generateIsland } from "../shared/island/generate.js";
import { mulberry32 } from "../shared/island/noise.js";
import { CLOSE_CODE, JOIN_ERROR, JOIN_ERROR_TEXT, MSG, PROTOCOL_VERSION } from "../shared/protocol.js";
import type { CreateOptions, NoticeMsg, ServerMessages, WelcomeMsg } from "../shared/protocol.js";
import { clockAt, inputLocked, matchTicks, type ClockInfo } from "../shared/rules/schedule.js";
import { eyePosition } from "../shared/sim/player.js";
import type { CharacterId, Phase, RecipeId } from "../shared/types.js";
import { GAME_ID, getRoomCodes } from "./hub.js";
import { BotDesk, roleForCharacter, type BotHost } from "./room/bots.js";
import { ActionBudget, MESSAGE_BURST, MESSAGE_RATE, MessageBudget } from "./room/flood.js";
import {
  botIdentity,
  checkJoinOptions,
  fallbackNickname,
  firstFreeCharacter,
  isCharacterId,
  lowestFreeSeat,
  nextHost,
  parseSettingsPatch,
  raftSeats,
  readBoolean,
  readChest,
  readEmote,
  readField,
  readInput,
  readMarker,
  readRecipe,
  roomFullError,
  uniqueNickname,
} from "./room/lobby.js";
import { LogThrottle, logLine } from "./room/log.js";
import { nextRttEma, pingField, rttSample } from "./room/ping.js";
import { claimRoomSlot, liveRoomCount, maxRooms, type RoomSlot } from "./room/registry.js";
import { matchRngs, previewSeed, textRng, type Rng } from "./room/rng.js";
import { scoreMatch, type ScoreInput } from "./room/scoring.js";
import { readKnobs, NO_KNOBS, type TestKnobs } from "./room/testing.js";
import { say } from "./room/text.js";
import { roomTimings, secondsLeft, type RoomTimings } from "./room/timings.js";
import { PlayerState, RaftState } from "./schema.js";
import { isBroadcastEvent, type GameEvent, type GameEventOf, type LaunchRequestEvent } from "./world/events.js";
import { RaftWorld } from "./world/World.js";

/** Fixed ticks run per simulation-interval callback at most (× the test warp); the excess is dropped after a stall. */
const MAX_TICKS_PER_CALL = 4;
/** A tick is due once the accumulator is within this of TICK_MS (float sums of 1000/30 land a hair below it). */
const TICK_DUE_MS = TICK_MS - 1e-6;
/** Close code for the room closing itself (Colyseus' WS_CLOSE_CONSENTED: clients treat it as final). */
const ROOM_CLOSED_CODE = 4000;
/** Phases in which the world is stepped and inputs flow. */
const MATCH_PHASES: ReadonlySet<Phase> = new Set<Phase>(["landing", "playing", "launch", "storm"]);
/** Phases in which players may craft, use the chest and ping (not during the cinematics). */
const ACTION_PHASES: ReadonlySet<Phase> = new Set<Phase>(["landing", "playing"]);
/** Repeating warnings (dropped sim time per room, refused creates per process) log at most once per this many ms. */
const WARN_EVERY_MS = 10_000;
/** Creates refused at the live-room cap (one summary line per WARN_EVERY_MS for the whole process). */
const busyLog = new LogThrottle(WARN_EVERY_MS);

export class RaftRoom extends Room<RaftState> {
  maxClients = MAX_PLAYERS;
  autoDispose = false;

  /** The 4-letter code (=== roomId). */
  protected code = "";
  /** Shortened test timers (CreateOptions.fast && RAFT_TEST=1). */
  protected fast = false;
  protected world!: RaftWorld;
  protected bots!: BotDesk;

  private knobs: TestKnobs = { ...NO_KNOBS };
  private timings: Readonly<RoomTimings> = roomTimings(false);
  /** Real milliseconds not yet simulated. */
  private accumulator = 0;
  /** Per-match streams (re-seeded at every match start); the world and the desk call through these fields. */
  private gameplayRng: Rng = mulberry32(1);
  private botRng: Rng = mulberry32(2);
  /** Cosmetic stream (notice variants). */
  private fxRng: Rng = mulberry32(3);
  private matchNo = 0;
  private previewNo = 0;
  private botSeq = 0;
  /** Lobby preview seed used while settings.seed is 0. */
  private randomPreview = 1;
  /** A lobby seed change is waiting for its island (regenerated at most every previewCooldownTicks). */
  private previewDirty = false;
  private lastPreviewTick = Number.NEGATIVE_INFINITY;
  /** Human sessionIds in join order (host migration). */
  private readonly joinOrder: string[] = [];
  private readonly rtt = new Map<string, number>();
  private readonly lastEmoteTick = new Map<string, number>();
  private readonly lastMarkerTick = new Map<string, number>();
  /** A human's craft / chest message budgets (Timings.actionCooldownTicks / actionBurst; built in setUp). */
  private craftBudget!: ActionBudget;
  private chestBudget!: ActionBudget;
  /** Per-client message token buckets (room/flood.ts). */
  private readonly budget = new MessageBudget();
  /** Player ids playing the current match (bots included), in seat order. */
  private matchIds: string[] = [];
  /** Humans who left a match for good: a bot plays their seat until the lobby, where they are removed. */
  private readonly leavers = new Set<string>();
  /** The day clock of the current tick (null outside playing). */
  private dayClock: ClockInfo | null = null;
  private stormWarned = false;
  /** Ticks that were left before the storm when the raft launched (team score bonus). */
  private launchTicksLeft = 0;
  private readonly aboard = new Set<string>();
  private matchEndTick = 0;
  private matchStartTick = 0;
  /** This process's live-room slot (registry.ts): claimed first thing in onCreate, released once. */
  private slot: RoomSlot | null = null;
  private codeReleased = false;
  /** Room time: real ms seen by onTick (unwarped; the manual test clock advances it too). */
  private roomMs = 0;
  /** Humans whose allowReconnection is pending (the grace that keeps an empty room alive). */
  private readonly inGrace = new Set<string>();
  /** Room time at which the room disposes itself if still empty (null = not armed). */
  private disposeAt: number | null = null;
  private everJoined = false;
  /** Fixed-tick time dropped after stalls (one warning per WARN_EVERY_MS). */
  private readonly dropLog = new LogThrottle(WARN_EVERY_MS);
  private closing = false;
  private disposed = false;

  /* ================================================================ lifecycle */

  onCreate(options: CreateOptions): void {
    // Refused before a slot, a code or an island exists: options any join would refuse (outdated client, bad
    // nickname / character), or a process already at its live-room cap.
    const check = checkJoinOptions(options);
    if (!check.ok) return this.refuseCreate(check.code, check.message);
    const slot = claimRoomSlot(performance.now());
    if (!slot) {
      const held = busyLog.note(1, performance.now());
      if (held) logLine("createRefused", { reason: "busy", refused: held.count, rooms: liveRoomCount(), maxRooms: maxRooms() }, "warn");
      return this.refuseCreate(JOIN_ERROR.SERVER_BUSY, JOIN_ERROR_TEXT[JOIN_ERROR.SERVER_BUSY] ?? "Server busy");
    }
    this.slot = slot;
    try {
      this.setUp(options, slot);
    } catch (err) {
      // e.g. generateIsland threw: nothing may stay reserved for a room Colyseus never registers.
      this.stopRoomTimers();
      this.releaseRoom();
      throw err;
    }
    logLine("create", { room: this.code, rooms: liveRoomCount(), maxRooms: maxRooms(), fast: this.fast, manualClock: this.knobs.manualClock });
  }

  /** onCreate after the checks: code, state, world, desk, handlers and timers. */
  private setUp(options: CreateOptions, slot: RoomSlot): void {
    this.knobs = readKnobs(options);
    this.fast = this.knobs.fast;
    this.timings = roomTimings(this.fast);
    this.craftBudget = new ActionBudget(this.timings.actionCooldownTicks, this.timings.actionBurst);
    this.chestBudget = new ActionBudget(this.timings.actionCooldownTicks, this.timings.actionBurst);
    this.fxRng = textRng(this.knobs.testSeed);
    this.code = getRoomCodes().allocate(GAME_ID);
    this.roomId = this.code;
    slot.code = this.code;
    slot.manual = this.knobs.manualClock;

    const state = new RaftState();
    state.fast = this.fast;
    state.difficulty = state.settings.difficulty;
    this.state = state;
    this.randomPreview = this.rollPreviewSeed();
    this.world = new RaftWorld(state, generateIsland(this.randomPreview, "solo"), {
      fast: this.fast,
      difficulty: state.settings.difficulty,
      rng: () => this.gameplayRng(),
    });
    this.bots = new BotDesk(this.botHost());

    this.patchRate = PATCH_INTERVAL_MS;
    if (!this.knobs.manualClock) this.setSimulationInterval((dt) => this.onTick(dt), TICK_MS);

    this.handle(MSG.INPUT, (c, m) => this.onInput(c, m));
    this.handle(MSG.READY, (c, m) => this.onReady(c, m));
    this.handle(MSG.CHARACTER, (c, m) => this.onCharacter(c, m));
    this.handle(MSG.SETTINGS, (c, m) => this.onSettings(c, m));
    this.handle(MSG.START, (c) => this.onStart(c));
    this.handle(MSG.ADD_BOT, (c) => this.onAddBot(c));
    this.handle(MSG.REMOVE_BOT, (c, m) => this.onRemoveBot(c, m));
    this.handle(MSG.REMATCH, (c, m) => this.onRematch(c, m));
    this.handle(MSG.PONG, (c, m) => this.onPong(c, m));
    this.handle(MSG.CRAFT, (c, m) => {
      const recipe = readRecipe(m);
      if (recipe && this.humanControls(c.sessionId) && this.craftBudget.take(c.sessionId, this.state.tick)) this.actCraft(c.sessionId, recipe);
    });
    this.handle(MSG.CHEST, (c, m) => {
      if (this.humanControls(c.sessionId) && this.chestBudget.take(c.sessionId, this.state.tick)) this.actChest(c.sessionId, m);
    });
    this.handle(MSG.MARKER, (c, m) => {
      if (this.humanControls(c.sessionId)) this.actMarker(c.sessionId, m);
    });
    this.handle(MSG.EMOTE, (c, m) => {
      if (this.humanControls(c.sessionId)) this.actEmote(c.sessionId, m);
    });
    // Unknown types do nothing, but they still spend the sender's budget.
    this.onMessage("*", (client: Client) => void this.admit(client));

    this.clock.setInterval(() => this.sendPings(), PING_INTERVAL_MS);
    this.armDisposeTimer(this.timings.neverJoinedSec);
  }

  /** Throw a create refusal (the client's create rejects with `code`), stopping what Colyseus started for us. */
  private refuseCreate(code: number, message: string): never {
    this.stopRoomTimers();
    throw new ServerError(code, message);
  }

  /**
   * A failed onCreate: Colyseus never registers (nor disposes) the room, but its __init already started the
   * patch interval and the clock. Stop them so a refused create leaves nothing running.
   */
  private stopRoomTimers(): void {
    this.patchRate = 0;
    this.setSimulationInterval();
    this.clock.clear();
    this.clock.stop();
  }

  /** Give back the room code and the live-room slot (exactly once: onDispose or a failed onCreate). */
  private releaseRoom(): void {
    if (this.code && !this.codeReleased) {
      this.codeReleased = true;
      getRoomCodes().release(this.code);
    }
    this.slot?.release();
  }

  /** Validate join options before a seat is taken (ServerError with a JOIN_ERROR code). */
  onAuth(client: Client, options: unknown): boolean {
    void client;
    const check = checkJoinOptions(options);
    if (!check.ok) throw new ServerError(check.code, check.message);
    if (this.state.players.size >= MAX_PLAYERS) {
      const full = roomFullError();
      throw new ServerError(full.code, full.message);
    }
    return true;
  }

  onJoin(client: Client, options: unknown): void {
    const s = this.state;
    const check = checkJoinOptions(options);
    if (!check.ok) throw new ServerError(check.code, check.message);
    const seat = lowestFreeSeat(this.seatsInUse());
    if (seat < 0 || s.players.size >= MAX_PLAYERS) {
      const full = roomFullError();
      throw new ServerError(full.code, full.message);
    }

    const id = client.sessionId;
    const p = new PlayerState();
    p.id = id;
    p.seat = seat;
    p.team = 0;
    p.nickname = uniqueNickname(check.nickname || fallbackNickname(seat), this.nicknames());
    p.character = check.character ?? firstFreeCharacter(this.characters());
    p.bot = false;
    p.botRole = "";
    p.connected = true;
    p.ready = false;
    p.alive = false;
    p.spectator = s.phase !== "lobby";
    s.players.set(id, p);
    this.joinOrder.push(id);
    this.world.clearInputs(id);
    this.cancelDisposeTimer();
    if (!this.everJoined) {
      this.everJoined = true;
      logLine("firstJoin", { room: this.code, afterMs: Math.round(this.roomMs) });
    }

    if (!this.hostOk()) {
      const others = s.players.size > 1;
      s.hostId = id;
      if (others) this.notice(say.host(p.nickname));
    }
    this.sendWelcome(client, false);
    if (p.spectator) {
      this.notice(say.spectating(this.fxRng, p.nickname), client);
      this.tell(client, say.spectatingYou());
    } else {
      this.notice(say.joined(this.fxRng, p.nickname), client);
    }
  }

  async onLeave(client: Client, consented?: boolean): Promise<void> {
    const id = client.sessionId;
    try {
      const p = this.state.players.get(id);
      if (!p || p.bot) return;
      if (consented || this.closing || this.disposed) {
        this.leaveForGood(id);
        return;
      }
      // The grace runs even if dropPlayer fails half-way, so the seat is always resolved (back or for good) and an
      // empty room is never kept alive by a seat nobody is waiting for.
      this.inGrace.add(id);
      try {
        this.dropPlayer(p);
      } catch (err) {
        this.logError("dropPlayer", err);
      }
      let back: Client | null = null;
      try {
        back = await this.allowReconnection(client, this.timings.reconnectGraceSec);
      } catch {
        back = null;
      } finally {
        this.inGrace.delete(id);
      }
      if (this.disposed) return;
      if (back) this.onReconnected(back);
      else this.leaveForGood(id);
    } catch (err) {
      this.logError("onLeave", err);
    }
  }

  /**
   * Graceful process shutdown (Colyseus calls this on SIGTERM / SIGINT before disposing every room): close the clients
   * with CLOSE_CODE.SERVER_RESTART so they show "the server restarted" instead of the default consented (4000) close.
   */
  onBeforeShutdown(): void {
    this.closing = true;
    logLine("shutdown", { room: this.code, phase: this.state.phase, clients: this.clients.length });
    this.disconnect(CLOSE_CODE.SERVER_RESTART).catch((err: unknown) => this.logError("shutdown", err));
  }

  onDispose(): void {
    this.disposed = true;
    this.cancelDisposeTimer();
    this.flushDropLog();
    logLine("dispose", {
      room: this.code,
      lifetimeSec: Math.round(this.roomMs / 1000),
      matches: this.matchNo,
      joined: this.everJoined,
      rooms: liveRoomCount() - 1,
    });
    this.releaseRoom();
  }

  /* ============================================================ fixed tick */

  /**
   * setSimulationInterval callback (or RaftRoom.advance): run every fixed tick that is due (× the test warp), drop
   * (and log) what is left after a stall, note the last good tick for health(), then the dispose timer.
   */
  protected onTick(deltaMs: number): void {
    const real = Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
    this.roomMs += real;
    const warp = this.knobs.warp;
    this.accumulator += real * warp;
    const max = MAX_TICKS_PER_CALL * warp;
    let ticks = 0;
    let good = 0;
    while (this.accumulator >= TICK_DUE_MS && ticks < max) {
      this.accumulator -= TICK_MS;
      ticks++;
      try {
        this.fixedTick();
        good++;
      } catch (err) {
        this.logError(`tick ${this.state.tick}`, err);
      }
    }
    // A room whose every tick throws stops refreshing it, so health() reports it as stalled.
    if (good > 0 && this.slot) this.slot.lastTickAt = performance.now();
    if (this.accumulator >= TICK_DUE_MS) {
      this.noteDropped(this.accumulator / warp);
      this.accumulator = 0;
    }
    this.checkDisposeTimer();
  }

  /**
   * RAFT_TEST manualClock rooms only (room/testing.ts): run `ms` of room time right now in TICK_MS steps — every
   * fixed tick that falls due (× warp) and the room's dispose timers. `stall`: as ONE simulation callback instead,
   * like a blocked event loop (at most MAX_TICKS_PER_CALL ticks run, the rest is dropped). A no-op for every other room.
   */
  advance(ms: number, stall = false): void {
    if (!this.knobs.manualClock) return;
    if (stall) return this.onTick(ms);
    for (let left = ms; left > 1e-6 && !this.closing && !this.disposed; left -= TICK_MS) this.onTick(Math.min(TICK_MS, left));
  }

  /** Simulated time thrown away after a stall (real ms): one warning per WARN_EVERY_MS with the sum. */
  private noteDropped(ms: number): void {
    const held = this.dropLog.note(ms, performance.now());
    if (held) logLine("simDropped", { room: this.code, droppedMs: Math.round(held.total), stalls: held.count, phase: this.state.phase }, "warn");
  }

  private flushDropLog(): void {
    const held = this.dropLog.flush();
    if (held) logLine("simDropped", { room: this.code, droppedMs: Math.round(held.total), stalls: held.count, phase: this.state.phase }, "warn");
  }

  /** One 1/30 s server tick in the order of ARCHITECTURE §4.2 (see the header). */
  private fixedTick(): void {
    const s = this.state;
    s.tick++;
    if (s.phase === "lobby" || s.phase === "matchEnd") {
      this.tickIdle();
      return;
    }

    let clock: ClockInfo | null = null;
    if (s.phase === "landing") clock = this.tickLanding();
    else if (s.phase === "playing") clock = this.tickClock();
    else if (s.phaseTicksLeft > 0) s.phaseTicksLeft--; // launch / storm cinematic
    this.dayClock = clock;

    this.bots.tick();
    const playing = s.phase === "playing";
    const events = this.world.step({ locked: inputLocked(s.phase, s.phaseTicksLeft, this.timings), clock: playing ? clock : null });
    this.applyEvents(events);

    if ((s.phase === "launch" || s.phase === "storm") && s.phaseTicksLeft === 0) this.endMatch();
  }

  /** Lobby: a pending preview island; matchEnd: the auto-lobby countdown. Then events emitted outside step(). */
  private tickIdle(): void {
    const s = this.state;
    if (s.phase === "matchEnd") {
      if (s.phaseTicksLeft > 0) s.phaseTicksLeft--;
      if (s.phaseTicksLeft === 0) {
        this.returnToLobby();
        this.notice(say.lobbyAuto());
      }
    } else {
      this.applyPreview(false);
    }
    this.applyEvents(this.world.drainEvents());
  }

  private tickLanding(): ClockInfo | null {
    const s = this.state;
    if (s.phaseTicksLeft > 0) s.phaseTicksLeft--;
    return s.phaseTicksLeft > 0 ? null : this.enterPlaying();
  }

  private tickClock(): ClockInfo | null {
    const s = this.state;
    s.clockTicks++;
    const clock = clockAt(s.clockTicks, this.timings);
    if (clock.day !== s.day || clock.dayPhase !== s.dayPhase) {
      s.day = clock.day;
      s.dayPhase = clock.dayPhase;
      this.sendAll(MSG.DAY_PHASE, { tick: s.tick, day: clock.day, dayPhase: clock.dayPhase });
    }
    s.phaseTicksLeft = clock.phaseLeft;
    if (!this.stormWarned && !clock.over && clock.day === DAYS && clock.dayPhase === "night" && clock.stormLeft <= this.timings.stormWarnTicks) {
      this.stormWarned = true;
      this.sendAll(MSG.STORM_WARNING, { tick: s.tick, secondsLeft: secondsLeft(clock.stormLeft) });
    }
    if (clock.over) {
      this.enterStorm();
      return null;
    }
    return clock;
  }

  /** Broadcast world events (a reject only to its actor); the internal ones drive the phases. */
  private applyEvents(events: GameEvent[]): void {
    for (const ev of events) {
      try {
        if (ev.type === "reject") this.sendReject(ev);
        else if (isBroadcastEvent(ev)) this.broadcast(ev.type, ev);
        else if (ev.type === "launchRequest") this.onLaunchRequest(ev);
        else if (ev.type === "teamWiped") this.onTeamWiped();
      } catch (err) {
        this.logError(`event ${ev.type}`, err);
      }
    }
  }

  /** A reject is a hint for the player who tried, never fanned out: their own client; bots and dropped seats get none. */
  private sendReject(ev: GameEventOf<"reject">): void {
    const p = this.state.players.get(ev.playerId);
    if (!p || p.bot || !p.connected) return;
    this.clients.getById(ev.playerId)?.send(ev.type, ev);
  }

  /* ============================================================ match flow */

  /** Every phase change goes through here (one log line per transition). */
  private setPhase(next: Phase): void {
    const s = this.state;
    if (s.phase === next) return;
    const from = s.phase;
    s.phase = next;
    logLine("phase", { room: this.code, match: this.matchNo, from, to: next, tick: s.tick });
  }

  private startMatch(): void {
    const s = this.state;
    this.ensurePreview();
    this.matchNo++;
    const rngs = matchRngs(this.knobs.testSeed, this.matchNo);
    this.gameplayRng = rngs.gameplay;
    this.botRng = rngs.bot;
    s.difficulty = s.settings.difficulty;
    this.world.setOptions({ fast: this.fast, difficulty: s.settings.difficulty });

    const ids = this.seated().map((p) => p.id);
    const seats = raftSeats(ids.length);
    this.matchIds = ids;
    this.leavers.clear();
    this.aboard.clear();
    this.stormWarned = false;
    this.launchTicksLeft = 0;
    this.dayClock = null;
    this.lastEmoteTick.clear();
    this.lastMarkerTick.clear();
    this.craftBudget.clear();
    this.chestBudget.clear();

    this.world.clearInputs();
    this.bots.reset();
    this.world.startMatch(ids, seats);
    this.matchStartTick = s.tick;
    const bots = this.seated().filter((p) => p.bot).length;
    logLine("matchStart", {
      room: this.code,
      match: this.matchNo,
      seed: s.seed,
      biome: s.biome,
      difficulty: s.difficulty,
      humans: ids.length - bots,
      bots,
    });
    this.setPhase("landing");
    s.phaseTicksLeft = this.timings.landing;
    s.clockTicks = 0;
    s.day = 1;
    s.dayPhase = "day";
    s.winnerTeam = -1;
    s.winReason = "";

    this.welcomeAll();
    this.sendAll(MSG.MATCH_START, { tick: s.tick, seed: s.seed, layout: s.layout, biome: s.biome, participants: [...ids], seats });
    this.applyEvents(this.world.drainEvents());
  }

  private enterPlaying(): ClockInfo {
    const s = this.state;
    this.setPhase("playing");
    s.clockTicks = 0;
    const clock = clockAt(0, this.timings);
    s.day = clock.day;
    s.dayPhase = clock.dayPhase;
    s.phaseTicksLeft = clock.phaseLeft;
    this.sendAll(MSG.DAY_PHASE, { tick: s.tick, day: clock.day, dayPhase: clock.dayPhase });
    return clock;
  }

  private enterStorm(): void {
    const s = this.state;
    this.setPhase("storm");
    s.phaseTicksLeft = this.timings.storm;
    s.winnerTeam = -1;
    s.winReason = "storm";
    this.launchTicksLeft = 0;
    this.sendAll(MSG.STORM, { tick: s.tick });
  }

  /** The world says the raft leaves (everyone required aboard, or the boarding countdown ran out). */
  private onLaunchRequest(ev: LaunchRequestEvent): void {
    const s = this.state;
    if (s.phase !== "playing" && s.phase !== "landing") return;
    this.launchTicksLeft = this.dayClock ? this.dayClock.stormLeft : matchTicks(this.timings);
    this.aboard.clear();
    for (const id of ev.aboard) this.aboard.add(id);
    this.setPhase("launch");
    s.phaseTicksLeft = this.timings.launch;
    s.winnerTeam = ev.team;
    s.winReason = "launched";
    this.sendAll(MSG.RAFT_LAUNCH, { tick: s.tick, team: ev.team, aboard: [...ev.aboard], left: [...ev.left] });
  }

  /** Everyone washed ashore on night 3: the storm takes the island right away. */
  private onTeamWiped(): void {
    const s = this.state;
    if (s.phase === "playing" || s.phase === "landing") this.enterStorm();
  }

  /** Standings, titles, MVP and team score → state.teams[].score + the matchEnd broadcast. */
  private endMatch(): void {
    const s = this.state;
    const won = s.winnerTeam >= 0;
    const inputs: ScoreInput[] = [];
    for (const id of this.matchIds) {
      const p = s.players.get(id);
      if (!p) continue;
      inputs.push({ id, seat: p.seat, team: p.team, score: p.score, stats: p.stats, aboard: won && (this.aboard.has(id) || p.boarded) });
    }
    const ticksLeft = won ? this.launchTicksLeft : 0;
    const result = scoreMatch(inputs, Math.max(1, s.teams.length), s.winnerTeam, ticksLeft);
    s.teams.forEach((team) => {
      team.score = result.teamScores[team.index] ?? 0;
    });
    this.setPhase("matchEnd");
    s.phaseTicksLeft = this.timings.matchEndLobby;
    this.matchEndTick = s.tick;
    this.dayClock = null;
    logLine("matchEnd", {
      room: this.code,
      match: this.matchNo,
      reason: s.winReason,
      winnerTeam: s.winnerTeam,
      teamScore: result.teamScores[0] ?? 0,
      seconds: Math.round((s.tick - this.matchStartTick) / TICK_RATE),
      day: s.day,
    });
    this.sendAll(MSG.MATCH_END, {
      tick: s.tick,
      winnerTeam: s.winnerTeam,
      reason: s.winReason,
      ticksLeft,
      teamScores: result.teamScores,
      mvpId: result.mvpId,
      standings: result.standings,
      seed: s.seed,
      biome: s.biome,
    });
  }

  /** Back to the lobby (rematch or timeout): leavers removed, everyone un-readied, a fresh preview island. */
  private returnToLobby(): void {
    const s = this.state;
    for (const id of [...this.leavers]) this.removePlayer(id);
    this.leavers.clear();
    this.world.resetToLobby();
    this.setPhase("lobby");
    s.phaseTicksLeft = 0;
    s.clockTicks = 0;
    s.day = 0;
    s.dayPhase = "day";
    // World-owned fields, reset defensively so the lobby never shows leftovers of the match.
    s.weather = "clear";
    s.launchTicksLeft = 0;
    s.winnerTeam = -1;
    s.winReason = "";
    s.players.forEach((p) => {
      p.ready = p.bot;
      p.spectator = false;
    });
    this.matchIds = [];
    this.aboard.clear();
    this.stormWarned = false;
    this.launchTicksLeft = 0;
    this.dayClock = null;
    if (s.settings.seed === 0) this.randomPreview = this.rollPreviewSeed();
    this.previewDirty = false;
    this.lastPreviewTick = s.tick;
    if (this.loadIsland(this.previewSeedNow())) this.welcomeAll();
    if (!this.hostOk()) this.migrateHost(s.hostId);
  }

  /** Every human left the match for good (only bots play): end it now. */
  private checkAbandoned(): void {
    const s = this.state;
    if (!MATCH_PHASES.has(s.phase)) return;
    // Only match participants keep it alive (one still in the reconnect grace counts); spectators just watch.
    for (const p of s.players.values()) if (!p.bot && !p.spectator) return;
    if (s.phase === "landing" || s.phase === "playing") {
      s.winnerTeam = -1;
      s.winReason = "abandoned";
      this.launchTicksLeft = 0;
    }
    this.endMatch();
  }

  /* ========================================================= lobby island */

  private previewSeedNow(): number {
    const seed = this.state.settings.seed;
    return seed !== 0 ? seed : this.randomPreview;
  }

  private rollPreviewSeed(): number {
    this.previewNo++;
    return previewSeed(this.knobs.testSeed, this.previewNo);
  }

  /** Load island `seed` (resetting node amounts). Returns true when it is a different island than before. */
  private loadIsland(seed: number): boolean {
    const current = this.world.island;
    if (current.seed === seed && current.layout === "solo") {
      this.world.setIsland(current);
      return false;
    }
    this.world.setIsland(generateIsland(seed, "solo"));
    return true;
  }

  /** A pending lobby seed change: regenerate (rate-limited unless `force`) and re-welcome everyone. */
  private applyPreview(force: boolean): void {
    if (!this.previewDirty) return;
    if (!force && this.state.tick - this.lastPreviewTick < this.timings.previewCooldownTicks) return;
    this.previewDirty = false;
    this.lastPreviewTick = this.state.tick;
    if (this.loadIsland(this.previewSeedNow())) this.welcomeAll();
  }

  /** Before a match: make sure the loaded island is the one the settings ask for. */
  private ensurePreview(): void {
    if (this.world.island.seed !== this.previewSeedNow()) this.previewDirty = true;
    this.applyPreview(true);
  }

  /* ======================================================= lobby messages */

  private onReady(client: Client, msg: unknown): void {
    if (this.state.phase !== "lobby") return;
    const p = this.state.players.get(client.sessionId);
    const ready = readBoolean(msg, "ready");
    if (!p || p.bot || p.spectator || ready === null) return;
    p.ready = ready;
  }

  /** Lobby only: any CharacterId (duplicates allowed; colors come from seats). */
  private onCharacter(client: Client, msg: unknown): void {
    if (this.state.phase !== "lobby") return;
    const p = this.state.players.get(client.sessionId);
    const character = readField(msg, "character");
    if (!p || p.bot || !isCharacterId(character)) return;
    p.character = character;
  }

  /** Host only, lobby only: difficulty, seed (0 = random each match), mode (coop; duel rejected). */
  private onSettings(client: Client, msg: unknown): void {
    const s = this.state;
    if (s.phase !== "lobby") return;
    if (!this.isHost(client)) return this.tell(client, say.hostOnly());
    const { patch, duelRejected } = parseSettingsPatch(msg);
    if (duelRejected) this.tell(client, say.duelLocked());
    if (patch.mode) s.settings.mode = patch.mode;
    if (patch.difficulty) {
      s.settings.difficulty = patch.difficulty;
      s.difficulty = patch.difficulty;
    }
    if (patch.seed !== undefined && patch.seed !== s.settings.seed) {
      s.settings.seed = patch.seed;
      if (patch.seed === 0) this.randomPreview = this.rollPreviewSeed();
      this.previewDirty = true;
      this.applyPreview(false);
    }
  }

  private onStart(client: Client): void {
    const s = this.state;
    if (s.phase !== "lobby") return;
    if (!this.isHost(client)) return this.tell(client, say.hostOnly());
    const blocker = this.startBlocker(client.sessionId);
    if (blocker) return this.tell(client, blocker);
    const seated = this.seated();
    if (seated.length === 1 && !seated[0]!.bot) {
      let added = 0;
      for (let i = 0; i < SOLO_AUTO_BOTS; i++) if (this.addBot(false)) added++;
      if (added > 0) this.notice(say.soloBots(added));
    }
    this.startMatch();
  }

  /** Why the host can't start yet (a notice for them), or null. */
  private startBlocker(hostId: string): NoticeMsg | null {
    const humans = this.seated().filter((p) => !p.bot);
    const away = humans.find((p) => !p.connected);
    if (away) return say.cantStartAway(away.nickname);
    const lazy = humans.filter((p) => !p.ready && p.id !== hostId);
    if (lazy.length > 0) return say.cantStartLazy(lazy.map((p) => p.nickname));
    return null;
  }

  private onAddBot(client: Client): void {
    if (this.state.phase !== "lobby") return;
    if (!this.isHost(client)) return this.tell(client, say.hostOnly());
    if (this.botCount() >= MAX_BOTS) return this.tell(client, say.tooManyBots(MAX_BOTS));
    if (this.state.players.size >= MAX_PLAYERS) return this.tell(client, say.beachFull(MAX_PLAYERS));
    this.addBot(true);
  }

  private onRemoveBot(client: Client, msg: unknown): void {
    if (this.state.phase !== "lobby") return;
    if (!this.isHost(client)) return this.tell(client, say.hostOnly());
    const id = readField(msg, "id");
    const p = typeof id === "string" ? this.state.players.get(id) : undefined;
    if (!p || !p.bot) return;
    const name = p.nickname;
    this.removePlayer(p.id);
    this.notice(say.botRemoved(name));
  }

  /** A helper bot takes the lowest free seat (lobby). Null when the room is full. */
  private addBot(announce: boolean): PlayerState | null {
    const s = this.state;
    const seat = lowestFreeSeat(this.seatsInUse());
    if (seat < 0 || s.players.size >= MAX_PLAYERS) return null;
    let id = "";
    do id = `bot-${++this.botSeq}`;
    while (s.players.has(id));
    const { nickname, role } = botIdentity(this.nicknames(), this.botCount());
    const p = new PlayerState();
    p.id = id;
    p.seat = seat;
    p.team = 0;
    p.nickname = nickname;
    p.character = firstFreeCharacter(this.characters());
    p.bot = true;
    p.botRole = role;
    p.ready = true;
    p.connected = true;
    p.spectator = false;
    p.alive = false;
    s.players.set(id, p);
    this.world.clearInputs(id);
    this.bots.add(id, role);
    if (announce) this.notice(say.botAdded(nickname));
    return p;
  }

  /**
   * matchEnd only, after Timings.matchEndMin: back to the lobby (characters kept, everyone un-readied), then the
   * sender's ready flag = msg.ready. Any human may send it.
   */
  private onRematch(client: Client, msg: unknown): void {
    const s = this.state;
    if (s.phase !== "matchEnd" || s.tick - this.matchEndTick < this.timings.matchEndMin) return;
    const sender = s.players.get(client.sessionId);
    if (!sender || sender.bot) return;
    const ready = readBoolean(msg, "ready") === true;
    const name = sender.nickname;
    this.returnToLobby();
    const again = s.players.get(client.sessionId);
    if (again && !again.spectator) again.ready = ready;
    this.notice(ready ? say.rematch(name) : say.backToLobby(name));
  }

  /* ======================================================= match messages */

  /** Inputs of alive human participants in the simulated phases (seats a bot drives ignore their old client). */
  private onInput(client: Client, msg: unknown): void {
    const s = this.state;
    if (!MATCH_PHASES.has(s.phase)) return;
    const id = client.sessionId;
    const p = s.players.get(id);
    if (!p || p.spectator || p.bot || !p.alive || this.bots.has(id)) return;
    const cmd = readInput(msg);
    if (cmd) this.world.queueInput(id, cmd);
  }

  /** RTT EMA → player.ping and the world's fishing lag allowance. */
  private onPong(client: Client, msg: unknown): void {
    const id = client.sessionId;
    const p = this.state.players.get(id);
    const sample = rttSample(msg, Date.now());
    if (!p || p.bot || sample === null) return;
    const ema = nextRttEma(this.rtt.get(id), sample);
    this.rtt.set(id, ema);
    p.ping = pingField(ema);
    this.world.setRtt(id, ema);
  }

  /** The sender is a human playing their own seat (not a stand-in / takeover bot). */
  private humanControls(id: string): boolean {
    const p = this.state.players.get(id);
    return !!p && !p.bot && !this.bots.has(id);
  }

  /** A participant who may act right now (landing / playing, alive, not spectating). */
  private canAct(id: string): boolean {
    const p = this.state.players.get(id);
    return !!p && ACTION_PHASES.has(this.state.phase) && !p.spectator && p.alive;
  }

  /** CraftMsg (humans and bots). The world validates range / fire / ingredients and emits crafted / reject. */
  private actCraft(id: string, recipe: RecipeId): boolean {
    if (!this.canAct(id)) return false;
    return this.world.craft(id, recipe);
  }

  /** ChestMsg (humans and bots). */
  private actChest(id: string, msg: unknown): boolean {
    const chest = readChest(msg);
    if (!chest || !this.canAct(id)) return false;
    return this.world.chest(id, chest);
  }

  /** Ping wheel (MARKER_COOLDOWN_TICKS per player): participants in landing / playing, washed ones included. */
  private actMarker(id: string, msg: unknown): boolean {
    const s = this.state;
    const p = s.players.get(id);
    if (!p || p.spectator || !ACTION_PHASES.has(s.phase)) return false;
    const last = this.lastMarkerTick.get(id);
    if (last !== undefined && s.tick - last < MARKER_COOLDOWN_TICKS) return false;
    const marker = readMarker(msg, eyePosition(p), this.world.island.bounds);
    if (!marker) return false;
    this.lastMarkerTick.set(id, s.tick);
    this.sendAll(MSG.MARKER, { tick: s.tick, playerId: id, kind: marker.kind, pos: marker.pos, need: marker.need });
    return true;
  }

  /** Emotes (EMOTE_COOLDOWN_TICKS per player), any phase. */
  private actEmote(id: string, msg: unknown): boolean {
    const s = this.state;
    const emote = readEmote(msg);
    if (!emote || !s.players.has(id)) return false;
    const last = this.lastEmoteTick.get(id);
    if (last !== undefined && s.tick - last < EMOTE_COOLDOWN_TICKS) return false;
    this.lastEmoteTick.set(id, s.tick);
    this.sendAll(MSG.EMOTE, { tick: s.tick, playerId: id, emote });
    return true;
  }

  /* ============================================================== players */

  /** A drop (not consented): keep the seat; in a match a stand-in bot drives it until they're back. */
  private dropPlayer(p: PlayerState): void {
    const s = this.state;
    p.connected = false;
    if (MATCH_PHASES.has(s.phase) && this.matchIds.includes(p.id)) {
      this.world.clearInputs(p.id);
      this.bots.add(p.id, roleForCharacter(p.character), { standIn: true });
    }
    if (s.hostId === p.id) this.migrateHost(p.id);
    this.notice(say.reconnecting(p.nickname));
    this.armEmptyTimerIfEmpty();
  }

  private onReconnected(client: Client): void {
    const s = this.state;
    const id = client.sessionId;
    const p = s.players.get(id);
    if (!p) return;
    p.connected = true;
    if (!p.bot) this.bots.remove(id);
    this.world.clearInputs(id);
    this.cancelDisposeTimer();
    // Still the host (nobody took it) → nothing to say. Somebody connected holds it → it stays with them.
    if (!this.hostOk()) {
      s.hostId = id;
      this.notice(say.host(p.nickname));
    }
    this.sendWelcome(client, true);
    this.notice(say.reconnected(p.nickname));
  }

  /** Consented leave or the grace ran out: a match participant's seat becomes a bot, anyone else is removed. */
  private leaveForGood(id: string): void {
    const s = this.state;
    const p = s.players.get(id);
    if (!p || p.bot) return;
    this.budget.forget(id);
    if (s.phase !== "lobby" && !p.spectator && this.matchIds.includes(id)) {
      this.takeOver(p);
      if (s.hostId === id) this.migrateHost(id);
    } else {
      const name = p.nickname;
      this.removePlayer(id);
      this.notice(say.left(this.fxRng, name));
    }
    this.armEmptyTimerIfEmpty();
    this.checkAbandoned();
  }

  /** A full helper bot (not a stand-in) plays a leaver's seat for the rest of the match (same id, name, seat, inventory). */
  private takeOver(p: PlayerState): void {
    const role = roleForCharacter(p.character);
    p.bot = true;
    p.botRole = role;
    p.connected = true;
    p.ready = true;
    this.leavers.add(p.id);
    this.world.clearInputs(p.id);
    this.bots.remove(p.id);
    this.bots.add(p.id, role);
    this.notice(MATCH_PHASES.has(this.state.phase) ? say.tookOver(p.nickname) : say.left(this.fxRng, p.nickname));
  }

  private removePlayer(id: string): void {
    const s = this.state;
    this.world.removePlayer(id);
    this.bots.remove(id);
    s.players.delete(id);
    const order = this.joinOrder.indexOf(id);
    if (order >= 0) this.joinOrder.splice(order, 1);
    this.rtt.delete(id);
    this.lastEmoteTick.delete(id);
    this.lastMarkerTick.delete(id);
    this.craftBudget.forget(id);
    this.chestBudget.forget(id);
    this.budget.forget(id);
    this.leavers.delete(id);
    if (s.hostId === id) this.migrateHost(id);
  }

  /** Host → the next connected human; nobody → a host who only dropped keeps it (through the grace), else no host. */
  private migrateHost(oldId: string): void {
    const s = this.state;
    const candidates = this.joinOrder
      .map((id) => s.players.get(id))
      .filter((p): p is PlayerState => !!p)
      .map((p) => ({ id: p.id, connected: p.connected, bot: p.bot, spectator: p.spectator }));
    const next = nextHost(candidates, oldId);
    if (next) {
      if (next !== s.hostId) {
        s.hostId = next;
        const p = s.players.get(next);
        if (p) this.notice(say.host(p.nickname));
      }
      return;
    }
    const old = s.players.get(oldId);
    if (!old || old.bot) s.hostId = "";
  }

  /** The host is a connected human in the room. */
  private hostOk(): boolean {
    const h = this.state.players.get(this.state.hostId);
    return !!h && h.connected && !h.bot;
  }

  private isHost(client: Client): boolean {
    return client.sessionId === this.state.hostId && this.hostOk();
  }

  /** Non-spectator players (bots and reconnecting humans included) in seat order. */
  private seated(): PlayerState[] {
    return Array.from(this.state.players.values())
      .filter((p) => !p.spectator)
      .sort((a, b) => a.seat - b.seat);
  }

  private seatsInUse(): number[] {
    return Array.from(this.state.players.values(), (p) => p.seat);
  }

  private nicknames(): string[] {
    return Array.from(this.state.players.values(), (p) => p.nickname);
  }

  private characters(): CharacterId[] {
    return Array.from(this.state.players.values(), (p) => p.character);
  }

  private botCount(): number {
    let n = 0;
    this.state.players.forEach((p) => {
      if (p.bot) n++;
    });
    return n;
  }

  /* ================================================================== bots */

  /** What the BotDesk may see and do: the same validation as a human's messages. */
  private botHost(): BotHost {
    const room = this;
    return {
      get state() {
        return room.state;
      },
      get world() {
        return room.world;
      },
      rng: () => room.botRng(),
      queueInput: (id, cmd) => {
        if (MATCH_PHASES.has(room.state.phase) && room.bots.has(id)) room.world.queueInput(id, cmd);
      },
      craft: (id, recipe) => room.bots.has(id) && room.actCraft(id, recipe),
      chest: (id, msg) => room.bots.has(id) && room.actChest(id, msg),
      emote: (id, msg) => room.bots.has(id) && room.actEmote(id, msg),
      marker: (id, msg) => room.bots.has(id) && room.actMarker(id, msg),
    };
  }

  /* ============================================== messages & timers */

  /** Typed broadcast of a server → client message. */
  private sendAll<K extends keyof ServerMessages>(type: K, msg: ServerMessages[K]): void {
    this.broadcast(type, msg);
  }

  private welcomeFor(client: Client, reconnected: boolean): WelcomeMsg {
    const island = this.world.island;
    return {
      code: this.code,
      sessionId: client.sessionId,
      tick: this.state.tick,
      tickRate: TICK_RATE,
      fast: this.fast,
      reconnected,
      seed: island.seed,
      layout: island.layout,
      gridHash: island.gridHash,
      defHash: island.defHash,
      protocol: PROTOCOL_VERSION,
    };
  }

  private sendWelcome(client: Client, reconnected: boolean): void {
    client.send(MSG.WELCOME, this.welcomeFor(client, reconnected));
  }

  /** Fresh welcome to everyone: the island changed (lobby seed) or a match starts. */
  private welcomeAll(): void {
    for (const c of this.clients) this.sendWelcome(c, false);
  }

  private notice(msg: NoticeMsg, except?: Client): void {
    this.broadcast(MSG.NOTICE, msg, except ? { except } : undefined);
  }

  private tell(client: Client, msg: NoticeMsg): void {
    client.send(MSG.NOTICE, msg);
  }

  private sendPings(): void {
    try {
      this.sendAll(MSG.PING, { t: Date.now(), tick: this.state.tick });
    } catch (err) {
      this.logError("ping", err);
    }
  }

  /** Dispose the room `sec` seconds of room time from now if it is still empty then (an armed timer is kept). */
  private armDisposeTimer(sec: number): void {
    if (this.disposeAt !== null || this.disposed) return;
    this.disposeAt = this.roomMs + sec * 1000;
  }

  private armEmptyTimerIfEmpty(): void {
    if (this.clients.length === 0) this.armDisposeTimer(this.timings.emptyDisposeSec);
  }

  private cancelDisposeTimer(): void {
    this.disposeAt = null;
  }

  /**
   * The dispose deadline passed: close the room unless a client is here or a human is inside the reconnect grace
   * (their grace ending — leaveForGood — re-arms the timer; their return cancels it).
   */
  private checkDisposeTimer(): void {
    if (this.disposeAt === null || this.roomMs < this.disposeAt || this.closing || this.disposed) return;
    this.disposeAt = null;
    if (this.clients.length > 0 || this.inGrace.size > 0) return;
    this.closing = true;
    this.disconnect(ROOM_CLOSED_CODE).catch((err: unknown) => this.logError("dispose", err));
  }

  /** onMessage with the sender's budget and a guard: a flood is dropped, a bad payload or a bug is logged. */
  private handle(type: string, fn: (client: Client, msg: unknown) => void): void {
    this.onMessage(type, (client: Client, msg: unknown) => {
      if (!this.admit(client)) return;
      try {
        fn(client, msg);
      } catch (err) {
        this.logError(`message ${type}`, err);
      }
    });
  }

  /** Spend one token of the sender's MessageBudget; false = drop the message (logged once per client per window). */
  private admit(client: Client): boolean {
    const verdict = this.budget.take(client.sessionId, performance.now());
    if (verdict === "ok") return true;
    if (verdict === "firstDrop") logLine("flood", { room: this.code, client: client.sessionId, rate: MESSAGE_RATE, burst: MESSAGE_BURST }, "warn");
    return false;
  }

  private logError(where: string, err: unknown): void {
    console.error(`[raft-rush ${this.code}] ${where} failed:`, err);
  }
}
