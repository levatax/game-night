// The Colyseus room. Owner: server-room. The class name, ROOM_NAME registration (server/index.ts)
// and the message/phase semantics in shared/protocol.ts are the contract; everything else is yours.
//
// Responsibilities (see game2.md §4–7, §14, §16 and shared/protocol.ts phase doc):
// - onCreate: this.roomId = getRoomCodes().allocate(GAME_ID); state.code = roomId; maxClients = MAX_PLAYERS;
//   patchRate = PATCH_INTERVAL_MS; setSimulationInterval(tick, TICK_MS); sim = await TowerSim.create();
//   seeded rng (createRng) from a random seed. Options.fast && process.env.JELLY_TEST === "1" → tiny timers
//   (for server/JellyRoom.test.ts).
// - onJoin: validate nickname (trim, 1..NICKNAME_MAX, else default "Chef N"), first free color, seat,
//   host = first player. Mid-match joiners → spectator. Send WELCOME. Re-send ROLE / RIG_STATUS on reconnect.
// - onLeave: allowReconnection(client, RECONNECT_GRACE_SEC) unless consented; host migration; in lobby just
//   remove. If the active player is gone their timer still runs and the piece auto-drops at the center.
//   Remove them from turnOrder only if they are gone for good. Dispose EMPTY_ROOM_DISPOSE_SEC after empty.
// - onDispose: getRoomCodes().release(roomId); sim.dispose().
// - Phases & timers: state.timeLeft / timeTotal every tick. Turn order rotates by one each round.
//   Round = turnsPerRound(players) turns (wraps around turnOrder).
// - Spin: SPIN (or SPIN_IDLE_SEC) → spinStage "rolling", broadcast SPIN_START; roll the card NOW with rollCard;
//   a RIG before RIG_WINDOW_SEC swaps it to rollCursed (record a RigRecord); then broadcast SPIN_RESULT
//   (buildReel, landInMs = SPIN_SEC*1000 - RIG_WINDOW_SEC*1000), set state.card, spinStage "landed".
//   After SPIN_SEC + CARD_READ_SEC from SPIN_START → placing. RIG: only the Saboteur, not on their own
//   turn, once per round; reply RIG_STATUS { accepted, reason }.
// - Placing: currentPiece from PieceBag (card overrides: bowlingBall / goldenCherry), nextPiece = bag.peek();
//   piecesLeft = doubleDecker ? 2 : 1. Timer = settings.turnTimer (speedRound → SPEED_ROUND_TIMER).
//   HOVER: clamp into the cylinder r ≤ HOVER_RADIUS, y ≥ sim.minHoverY(type, scale), normalize the
//   quaternion; write to state.hover (active = true). Hiccups: every 0.8–1.6 s add a random hop (+4–8 cm up,
//   ±3 cm sideways) to the relayed pose for 0.25 s and broadcast HICCUP. DROP (or timer end → last hover pose,
//   or the center at minHoverY if none): sim.spawn with SpawnMods from the card, broadcast DROPPED. Double
//   Decker: after the first drop, piecesLeft = 1, next bag piece, timer keeps running; second drop → settling.
//   Bets lock at the (last) drop.
// - Board effects: standSpeed STAND_SPEED_DEG (spinCycle: SPIN_CYCLE_SPEED_DEG during placing+settling);
//   integrate standAngle every tick in all in-game phases. windStorm: random direction, sim.setWind during
//   placing + settling, mirror into state.wind/windX/windZ. moonGravity: sim.setGravityScale during settling.
//   earthquake: sim.quake(EARTHQUAKE_SEC) right after the drop, state.quake while shaking. Reset all after settle.
// - Settling: step the sim each tick (dt × SLOWMO_SCALE for the first SLOWMO_FIRST_SEC); copy sim.pieces() into
//   state.pieces; broadcast IMPACT for sim impacts; on the first sim.toppled() broadcast TOPPLE immediately and
//   keep simulating ~1 s more so pieces visibly fly, then → result. Asleep (or SETTLE_MAX_SEC) → result stand.
// - Result: placementDelta → coins, stats; settleBets → coins, stats.betProfit, broadcast RESULT then BETS;
//   Saboteur hidden bonus += SABOTEUR_TOPPLE_BONUS for a topple on someone else's turn. On topple, after
//   RESULT_SEC: sim.clear(), state.pieces.clear(). towerHeightCm / payoutPreview from sim.towerTop().
// - Voting (only with a Saboteur): VOTE → votes map, player.voted; all voted or timer → broadcast VOTES,
//   resolveVote → apply adjustments → reveal. Reveal: broadcast REVEAL. Then matchEnd with place set from
//   standings(). REMATCH (host) → lobby, coins = START_COINS, stats reset, spectators become players.
// - EMOTE → broadcast EMOTED (rate limit 1/s). Validate every payload defensively: wrong types → ignore.

import { Room, type Client } from "@colyseus/core";
import {
  BET_AMOUNTS,
  CARD_BY_ID,
  CHONK_SCALE,
  EARTHQUAKE_SEC,
  EMOTES,
  GAME_ID,
  HEAVY_SNACK_MASS,
  BUTTER_FRICTION,
  JELLY_RESTITUTION,
  MAX_PLAYERS,
  MIN_PLAYERS,
  MOON_GRAVITY_SCALE,
  PATCH_INTERVAL_MS,
  PLAYER_COLORS,
  REEL_WIN_INDEX,
  ROUND_OPTIONS,
  SABOTEUR_MIN_PLAYERS,
  SABOTEUR_TOPPLE_BONUS,
  SLOWMO_FIRST_SEC,
  SLOWMO_SCALE,
  SPIN_CYCLE_SPEED_DEG,
  STAND_SPEED_DEG,
  START_COINS,
  TICK_MS,
  TURN_TIMER_OPTIONS,
  autoRounds,
  survivePayout,
  turnsPerRound,
} from "../shared/constants.js";
import type { CardId, EmoteId, PieceType } from "../shared/constants.js";
import { MSG } from "../shared/protocol.js";
import type {
  BetSide,
  BetsMsg,
  DroppedMsg,
  EmotedMsg,
  HiccupMsg,
  ImpactMsg,
  NoticeMsg,
  Phase,
  Pose,
  ResultMsg,
  RevealMsg,
  RigRecord,
  RigStatusMsg,
  Role,
  RoleMsg,
  SpinResultMsg,
  SpinStartMsg,
  ToppleMsg,
  VotesMsg,
  WelcomeMsg,
} from "../shared/protocol.js";
import { getRoomCodes } from "./hub.js";
import { TowerSim, type SimPiece, type SpawnMods } from "./physics/TowerSim.js";
import {
  PieceBag,
  buildReel,
  createRng,
  legalBetAmount,
  placementDelta,
  rarityOf,
  resolveVote,
  rollCard,
  rollCursed,
  settleBets,
  shuffle,
  standings,
  type PendingBet,
  type Rng,
  type VoteOutcome,
} from "./rules.js";
import { centerPose, clampPose, offsetPose, readPose } from "./room/pose.js";
import { cleanNickname, say, uniqueNickname } from "./room/text.js";
import { FAST_TIMINGS, NORMAL_TIMINGS, type Timings } from "./room/timings.js";
import { JellyState, PieceState, PlayerState, StatsState } from "./schema.js";

/** Phases where a match is running and turn bookkeeping applies. */
const IN_TURNS: ReadonlySet<Phase> = new Set<Phase>(["roleReveal", "spinning", "placing", "settling", "result"]);
const EMOTE_COOLDOWN_MS = 1000;
const TAU = Math.PI * 2;

type Cancelable = { clear(): void };

export class JellyRoom extends Room<JellyState> {
  maxClients = MAX_PLAYERS;
  autoDispose = false;

  private sim: TowerSim | null = null;
  private rng: Rng = Math.random;
  private T: Timings = NORMAL_TIMINGS;
  /** Fast test mode: optional forced round count. */
  private forcedRounds = 0;
  private disposeTimer: Cancelable | null = null;
  private disposed = false;

  // --- roster
  /** Join order of everyone in state.players (seats are compacted from it). */
  private joinOrder: string[] = [];
  private lastEmote = new Map<string, number>();

  // --- phase timer (seconds since setTimer, and its length; 0 = untimed)
  private t = 0;
  private timerTotal = 0;

  // --- match secrets (never in state)
  private roles = new Map<string, Role>();
  private saboteurId = "";
  private hiddenBonus = 0;
  private rigs: RigRecord[] = [];
  /** Round number in which the Saboteur already rigged (0 = never). */
  private rigUsedRound = 0;
  private bets = new Map<string, PendingBet>();
  private votes = new Map<string, string>();
  private bag: PieceBag | null = null;
  /** This round's turn schedule (turnOrder wrapped to turnsPerRound), index = state.turnInRound. */
  private schedule: string[] = [];

  // --- current turn
  private pendingCard: CardId = "plain";
  private rigThisTurn = false;
  private rigRecord: RigRecord | null = null;
  private resultSent = false;
  private lastHover: Pose | null = null;
  private dropsThisTurn = 0;
  private betsLocked = false;
  private pieceScale = 1;
  private turnStartHeightCm = 0;
  private toppled: SimPiece | null = null;
  private sinceTopple = 0;
  private settleT = 0;
  private quakeLeft = 0;
  private hiccupIn = 0;
  private hopLeft = 0;
  private hop = { dx: 0, dy: 0, dz: 0 };
  private lastOutcome: BetSide = "stand";

  // ===================================================================== lifecycle
  async onCreate(options: unknown): Promise<void> {
    const opts = (options && typeof options === "object" ? options : {}) as Record<string, unknown>;
    const fast = !!opts.fast && process.env.JELLY_TEST === "1";
    this.T = fast ? FAST_TIMINGS : NORMAL_TIMINGS;
    if (fast && typeof opts.rounds === "number" && opts.rounds >= 1 && opts.rounds <= 10) this.forcedRounds = Math.floor(opts.rounds);

    this.roomId = getRoomCodes().allocate(GAME_ID);
    this.state = new JellyState();
    this.state.code = this.roomId;
    this.state.standSpeed = STAND_SPEED_DEG;
    this.patchRate = PATCH_INTERVAL_MS;
    this.rng = createRng((Math.random() * 0x1_0000_0000) >>> 0);

    this.onMessage(MSG.READY, (c, m: unknown) => this.onReady(c, m));
    this.onMessage(MSG.COLOR, (c, m: unknown) => this.onColor(c, m));
    this.onMessage(MSG.SETTINGS, (c, m: unknown) => this.onSettings(c, m));
    this.onMessage(MSG.START, (c) => this.onStart(c));
    this.onMessage(MSG.SPIN, (c) => this.onSpin(c));
    this.onMessage(MSG.HOVER, (c, m: unknown) => this.onHover(c, m));
    this.onMessage(MSG.DROP, (c, m: unknown) => this.onDrop(c, m));
    this.onMessage(MSG.RIG, (c) => this.onRig(c));
    this.onMessage(MSG.BET, (c, m: unknown) => this.onBet(c, m));
    this.onMessage(MSG.VOTE, (c, m: unknown) => this.onVote(c, m));
    this.onMessage(MSG.EMOTE, (c, m: unknown) => this.onEmote(c, m));
    this.onMessage(MSG.REMATCH, (c) => this.onRematch(c));
    this.onMessage("*", () => {
      /* unknown message types: ignore */
    });

    this.setSimulationInterval((dtMs) => this.tick(dtMs), TICK_MS);
    this.scheduleDisposeIfEmpty();

    const sim = await TowerSim.create();
    if (this.disposed) sim.dispose();
    else this.sim = sim;
  }

  onJoin(client: Client, options: unknown): void {
    this.cancelDispose();
    const opts = (options && typeof options === "object" ? options : {}) as Record<string, unknown>;
    const taken = new Set<string>();
    this.state.players.forEach((p) => taken.add(p.nickname));
    let nickname = cleanNickname(opts.nickname);
    if (!nickname) nickname = `Chef ${this.joinOrder.length + 1}`;
    nickname = uniqueNickname(nickname, taken);

    const p = new PlayerState();
    p.id = client.sessionId;
    p.nickname = nickname;
    p.color = this.firstFreeColor();
    p.connected = true;
    p.coins = START_COINS;
    p.spectator = this.state.phase !== "lobby";
    this.state.players.set(p.id, p);
    this.joinOrder.push(p.id);
    this.compactSeats();
    if (!this.state.hostId || !this.state.players.has(this.state.hostId)) this.state.hostId = p.id;

    client.send(MSG.WELCOME, { you: p.id, code: this.roomId } satisfies WelcomeMsg);
    this.notice(p.spectator ? say.spectating(this.rng, nickname) : say.joined(this.rng, nickname), client);
  }

  async onLeave(client: Client, consented?: boolean): Promise<void> {
    const id = client.sessionId;
    const p = this.state.players.get(id);
    if (!p) return;
    if (consented) {
      this.removePlayer(id);
      return;
    }
    p.connected = false;
    if (this.state.hostId === id) this.migrateHost(id);
    this.notice(say.reconnecting(p.nickname));
    this.scheduleDisposeIfEmpty();
    try {
      const back = await this.allowReconnection(client, this.T.reconnectGrace);
      const again = this.state.players.get(id);
      if (!again) return;
      this.cancelDispose();
      again.connected = true;
      if (!this.state.hostId || !this.isConnected(this.state.hostId)) this.state.hostId = id;
      back.send(MSG.WELCOME, { you: id, code: this.roomId } satisfies WelcomeMsg);
      this.resendSecrets(back);
      this.notice(say.reconnected(again.nickname), back);
    } catch {
      this.removePlayer(id);
    }
  }

  onDispose(): void {
    this.disposed = true;
    getRoomCodes().release(this.roomId);
    this.sim?.dispose();
    this.sim = null;
  }

  // ========================================================================= tick
  private tick(deltaMs: number): void {
    if (!this.sim) return;
    const dt = Math.min(Math.max(deltaMs, 0), 100) / 1000;
    const s = this.state;
    if (s.phase !== "lobby") s.standAngle = (s.standAngle + ((s.standSpeed * Math.PI) / 180) * dt) % (TAU * 1000);
    this.t += dt;

    switch (s.phase) {
      case "roleReveal":
        if (this.t >= this.timerTotal) this.beginRound();
        break;
      case "spinning":
        this.tickSpinning();
        break;
      case "placing":
        this.tickPlacing(dt);
        break;
      case "settling":
        this.tickSettling(dt);
        break;
      case "result":
        if (this.t >= this.timerTotal) this.afterResult();
        break;
      case "voting":
        if (this.t >= this.timerTotal) this.finishVote();
        break;
      case "reveal":
        if (this.t >= this.timerTotal) this.goMatchEnd();
        break;
      default:
        break;
    }
    s.timeTotal = this.timerTotal;
    s.timeLeft = this.timerTotal > 0 ? Math.max(0, this.timerTotal - this.t) : 0;
  }

  private setTimer(sec: number): void {
    this.t = 0;
    this.timerTotal = sec;
    this.state.timeTotal = sec;
    this.state.timeLeft = sec;
  }

  // ======================================================================= lobby
  private onReady(client: Client, msg: unknown): void {
    const p = this.state.players.get(client.sessionId);
    if (!p || p.spectator || this.state.phase !== "lobby" || !msg || typeof msg !== "object") return;
    const ready = (msg as Record<string, unknown>).ready;
    if (typeof ready === "boolean") p.ready = ready;
  }

  private onColor(client: Client, msg: unknown): void {
    const p = this.state.players.get(client.sessionId);
    if (!p || this.state.phase !== "lobby" || !msg || typeof msg !== "object") return;
    const color = (msg as Record<string, unknown>).color;
    if (typeof color !== "number" || !Number.isInteger(color) || color < 0 || color >= PLAYER_COLORS.length) return;
    let taken = false;
    this.state.players.forEach((o) => {
      if (o.id !== p.id && o.color === color) taken = true;
    });
    if (!taken) p.color = color;
  }

  private onSettings(client: Client, msg: unknown): void {
    if (client.sessionId !== this.state.hostId || this.state.phase !== "lobby" || !msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    const st = this.state.settings;
    if (typeof m.rounds === "number" && (ROUND_OPTIONS as readonly number[]).includes(m.rounds)) st.rounds = m.rounds;
    if (typeof m.turnTimer === "number" && (TURN_TIMER_OPTIONS as readonly number[]).includes(m.turnTimer)) st.turnTimer = m.turnTimer;
    if (typeof m.saboteur === "boolean") st.saboteur = m.saboteur;
    if (typeof m.sideBets === "boolean") st.sideBets = m.sideBets;
  }

  /** Host only. Everyone connected (except the host, whose Start counts as ready) must be ready. */
  private onStart(client: Client): void {
    const s = this.state;
    if (client.sessionId !== s.hostId || s.phase !== "lobby") return;
    if (!this.sim) return void client.send(MSG.NOTICE, { text: say.notReady() } satisfies NoticeMsg);
    const chefs = this.ordered().filter((p) => p.connected && !p.spectator);
    if (chefs.length < MIN_PLAYERS) {
      return void client.send(MSG.NOTICE, { text: say.cantStart(`need at least ${MIN_PLAYERS} chefs (a tower needs an audience).`) } satisfies NoticeMsg);
    }
    const lazy = chefs.filter((p) => !p.ready && p.id !== s.hostId);
    if (lazy.length) {
      const names = lazy.map((p) => p.nickname).join(", ");
      return void client.send(MSG.NOTICE, { text: say.cantStart(`${names} ${lazy.length === 1 ? "is" : "are"} still tying their apron.`) } satisfies NoticeMsg);
    }
    this.startMatch(chefs.map((p) => p.id));
  }

  private startMatch(ids: string[]): void {
    const s = this.state;
    // Anyone not taking part (disconnected in lobby) watches this match.
    s.players.forEach((p) => {
      p.spectator = !ids.includes(p.id);
      p.coins = START_COINS;
      p.stats = new StatsState();
      p.place = 0;
      p.hasBet = false;
      p.voted = false;
      p.ready = false;
    });
    this.resetMatchSecrets();
    this.sim!.clear();
    s.pieces.clear();
    this.resetBoardEffects();
    s.towerHeightCm = 0;
    s.payoutPreview = 0;

    s.turnOrder.clear();
    for (const id of shuffle(this.rng, ids)) s.turnOrder.push(id);
    s.totalRounds = this.forcedRounds || s.settings.rounds || autoRounds(ids.length);
    s.round = 0;
    s.turnInRound = 0;
    s.turnsPerRound = turnsPerRound(ids.length);
    s.activeId = "";
    this.bag = new PieceBag(this.rng);

    if (s.settings.saboteur && ids.length >= SABOTEUR_MIN_PLAYERS) {
      this.saboteurId = ids[Math.floor(this.rng() * ids.length) % ids.length]!;
    }
    for (const id of ids) this.roles.set(id, id === this.saboteurId ? "saboteur" : "baker");

    s.phase = "roleReveal";
    this.setTimer(this.T.roleReveal);
    for (const c of this.clients) {
      const role = this.roles.get(c.sessionId);
      if (role) c.send(MSG.ROLE, { role } satisfies RoleMsg);
    }
    this.sendRigStatus();
  }

  private resetMatchSecrets(): void {
    this.roles.clear();
    this.saboteurId = "";
    this.hiddenBonus = 0;
    this.rigs = [];
    this.rigUsedRound = 0;
    this.bets.clear();
    this.votes.clear();
    this.schedule = [];
    this.rigRecord = null;
    this.rigThisTurn = false;
  }

  // ====================================================================== rounds
  private beginRound(): void {
    const s = this.state;
    if (this.checkTooFew()) return;
    s.round++;
    if (s.round > 1 && s.turnOrder.length > 1) {
      const first = s.turnOrder.shift();
      if (first !== undefined) s.turnOrder.push(first);
    }
    const order = [...s.turnOrder];
    const n = turnsPerRound(order.length);
    this.schedule = Array.from({ length: n }, (_, i) => order[i % order.length]!);
    s.turnsPerRound = this.schedule.length;
    s.turnInRound = 0;
    this.beginTurn();
  }

  private beginTurn(): void {
    const s = this.state;
    s.activeId = this.schedule[s.turnInRound] ?? "";
    s.phase = "spinning";
    s.spinStage = "idle";
    s.card.id = "";
    s.card.rarity = "";
    s.card.multiplier = 1;
    s.currentPiece = "";
    s.nextPiece = this.bag?.peek() ?? "";
    s.piecesLeft = 0;
    s.hover.active = false;
    this.bets.clear();
    s.players.forEach((p) => (p.hasBet = false));
    this.betsLocked = false;
    this.rigThisTurn = false;
    this.rigRecord = null;
    this.resultSent = false;
    this.lastHover = null;
    this.dropsThisTurn = 0;
    this.toppled = null;
    this.sinceTopple = 0;
    this.turnStartHeightCm = s.towerHeightCm;
    s.payoutPreview = survivePayout(s.towerHeightCm, 1);
    this.setTimer(this.T.spinIdle);
    this.sendRigStatus();
  }

  /** Next turn / next round / end of match. */
  private advanceTurn(): void {
    const s = this.state;
    if (this.checkTooFew()) return;
    s.turnInRound++;
    if (s.turnInRound >= this.schedule.length) {
      if (s.round >= s.totalRounds) this.endOfMatch();
      else this.beginRound();
    } else {
      this.beginTurn();
    }
  }

  // ====================================================================== spin
  private onSpin(client: Client): void {
    const s = this.state;
    if (s.phase !== "spinning" || s.spinStage !== "idle" || client.sessionId !== s.activeId) return;
    this.startSpin();
  }

  private tickSpinning(): void {
    const s = this.state;
    if (s.spinStage === "idle") {
      if (this.t >= this.timerTotal) this.startSpin();
      return;
    }
    if (!this.resultSent && this.t >= this.T.rigWindow) this.sendSpinResult();
    if (this.t >= this.timerTotal) this.beginPlacing();
  }

  private startSpin(): void {
    const s = this.state;
    s.spinStage = "rolling";
    // The card is decided NOW; a rig inside the window swaps it before anyone sees it.
    this.pendingCard = this.rigThisTurn ? rollCursed(this.rng) : rollCard(this.rng, this.matchSize());
    if (this.rigRecord) this.rigRecord.card = this.pendingCard;
    this.setTimer(this.T.spin + this.T.cardRead);
    this.broadcast(MSG.SPIN_START, { playerId: s.activeId, durationMs: Math.round(this.T.spin * 1000) } satisfies SpinStartMsg);
    this.sendRigStatus();
  }

  private sendSpinResult(): void {
    const s = this.state;
    this.resultSent = true;
    const card = this.pendingCard;
    const def = CARD_BY_ID[card];
    s.card.id = card;
    s.card.rarity = rarityOf(card);
    s.card.multiplier = def.multiplier;
    s.spinStage = "landed";
    s.payoutPreview = survivePayout(s.towerHeightCm, def.multiplier);
    const msg: SpinResultMsg = {
      playerId: s.activeId,
      card,
      rarity: rarityOf(card),
      multiplier: def.multiplier,
      strip: buildReel(this.rng, card, this.matchSize()),
      winIndex: 0,
      landInMs: Math.max(0, Math.round((this.T.spin - this.T.rigWindow) * 1000)),
    };
    msg.winIndex = this.reelWinIndex(msg.strip, card);
    this.broadcast(MSG.SPIN_RESULT, msg);
    this.sendRigStatus();
  }

  /** REEL_WIN_INDEX by contract; fall back to the nearest matching slot if the strip disagrees. */
  private reelWinIndex(strip: CardId[], card: CardId): number {
    const want = REEL_WIN_INDEX;
    if (strip[want] === card) return want;
    let best = strip.indexOf(card);
    for (let i = 0; i < strip.length; i++) if (strip[i] === card && Math.abs(i - want) < Math.abs(best - want)) best = i;
    return best;
  }

  private onRig(client: Client): void {
    const s = this.state;
    const id = client.sessionId;
    const reply = (accepted: boolean, reason?: string) =>
      client.send(MSG.RIG_STATUS, { ...this.rigStatus(), accepted, ...(reason ? { reason } : {}) } satisfies RigStatusMsg);
    if (!this.saboteurId || id !== this.saboteurId) return reply(false, "You're a Baker! Bakers bake, they don't rig. 🧁");
    if (this.rigUsedRound === s.round) return reply(false, "Already rigged this round. Greedy little devil. 😈");
    if (s.phase !== "spinning" || this.resultSent) return reply(false, "Only while someone's case is spinning!");
    if (s.activeId === id) return reply(false, "Rigging your own case? Bold. Also not allowed.");
    this.rigUsedRound = s.round;
    this.rigThisTurn = true;
    this.rigRecord = { round: s.round, victimId: s.activeId, card: "bowlingBall", outcome: "stand" };
    this.rigs.push(this.rigRecord);
    if (s.spinStage === "rolling") {
      this.pendingCard = rollCursed(this.rng);
      this.rigRecord.card = this.pendingCard;
    }
    reply(true);
  }

  private rigStatus(): RigStatusMsg {
    const s = this.state;
    const used = this.rigUsedRound === s.round && s.round > 0;
    const available =
      !used && s.phase === "spinning" && !this.resultSent && !!s.activeId && s.activeId !== this.saboteurId;
    return { available, used };
  }

  private sendRigStatus(): void {
    if (!this.saboteurId) return;
    this.clientOf(this.saboteurId)?.send(MSG.RIG_STATUS, this.rigStatus());
  }

  // ===================================================================== placing
  private beginPlacing(): void {
    const s = this.state;
    const sim = this.sim!;
    if (!this.resultSent) this.sendSpinResult();
    const card = this.pendingCard;
    s.phase = "placing";
    s.spinStage = "landed";
    s.currentPiece = this.dealPiece(card);
    s.nextPiece = this.bag?.peek() ?? "";
    s.piecesLeft = card === "doubleDecker" ? 2 : 1;
    this.pieceScale = card === "chonk" ? CHONK_SCALE : 1;
    this.lastHover = null;
    this.writeHover(centerPose(sim.minHoverY(s.currentPiece as PieceType, this.pieceScale)));
    s.hover.active = true;

    if (card === "spinCycle") s.standSpeed = SPIN_CYCLE_SPEED_DEG;
    if (card === "windStorm") {
      const a = this.rng() * TAU;
      s.windX = Math.cos(a);
      s.windZ = Math.sin(a);
      s.wind = 1;
      sim.setWind(s.windX, s.windZ, 1);
    }
    this.hiccupIn = this.T.hiccupMin + this.rng() * (this.T.hiccupMax - this.T.hiccupMin);
    this.hopLeft = 0;

    const base = this.T.turnTimer ?? s.settings.turnTimer;
    this.setTimer(card === "speedRound" ? Math.min(base, this.T.speedRound) : base);
  }

  private dealPiece(card: CardId): PieceType {
    if (card === "bowlingBall") return "bowlingBall";
    if (card === "goldenCherry") return "goldenCherry";
    return this.bag?.next() ?? "toaster";
  }

  private tickPlacing(dt: number): void {
    const s = this.state;
    // Double Decker: the first piece is already falling while the second one hovers.
    if (this.dropsThisTurn > 0) {
      this.stepSim(TICK_MS / 1000, dt);
      if (this.toppled) return this.enterSettling();
    }
    if (this.pendingCard === "hiccups") this.tickHiccups(dt);
    if (this.t >= this.timerTotal) {
      const who = s.players.get(s.activeId);
      if (who) this.notice(say.autoDrop(who.nickname));
      this.drop(this.currentHoverPose(), true);
    }
  }

  private tickHiccups(dt: number): void {
    if (this.hopLeft > 0) {
      this.hopLeft -= dt;
      if (this.hopLeft <= 0) this.writeHover(this.lastHover ?? this.currentHoverPose());
      return;
    }
    this.hiccupIn -= dt;
    if (this.hiccupIn > 0) return;
    this.hiccupIn = this.T.hiccupMin + this.rng() * (this.T.hiccupMax - this.T.hiccupMin);
    this.hopLeft = this.T.hiccupHop;
    this.hop = { dx: (this.rng() * 2 - 1) * 0.03, dy: 0.04 + this.rng() * 0.04, dz: (this.rng() * 2 - 1) * 0.03 };
    this.writeHover(this.lastHover ?? this.currentHoverPose());
    this.broadcast(MSG.HICCUP, { playerId: this.state.activeId } satisfies HiccupMsg);
  }

  private onHover(client: Client, msg: unknown): void {
    const s = this.state;
    if (s.phase !== "placing" || client.sessionId !== s.activeId || !this.sim) return;
    const pose = readPose(msg);
    if (!pose) return;
    this.lastHover = clampPose(pose, this.minY());
    this.writeHover(this.lastHover);
  }

  private onDrop(client: Client, msg: unknown): void {
    const s = this.state;
    if (s.phase !== "placing" || client.sessionId !== s.activeId || !this.sim) return;
    const pose = readPose(msg);
    if (pose) {
      this.lastHover = clampPose(pose, this.minY());
      this.writeHover(this.lastHover);
    }
    this.drop(this.currentHoverPose(), false);
  }

  /** Writes the relayed pose (+ the hiccup hop while one is active) into state.hover. */
  private writeHover(base: Pose): void {
    const h = this.state.hover;
    const p = this.hopLeft > 0 ? clampPose(offsetPose(base, this.hop.dx, this.hop.dy, this.hop.dz), this.minY()) : base;
    h.type = (this.state.currentPiece || "toaster") as PieceType;
    h.scale = this.pieceScale;
    h.x = p.x;
    h.y = p.y;
    h.z = p.z;
    h.qx = p.qx;
    h.qy = p.qy;
    h.qz = p.qz;
    h.qw = p.qw;
  }

  /** What everyone currently sees hovering (hop included), clamped against the current tower. */
  private currentHoverPose(): Pose {
    const h = this.state.hover;
    return clampPose({ x: h.x, y: h.y, z: h.z, qx: h.qx, qy: h.qy, qz: h.qz, qw: h.qw }, this.minY());
  }

  private minY(): number {
    return this.sim ? this.sim.minHoverY((this.state.currentPiece || "toaster") as PieceType, this.pieceScale) : 0.6;
  }

  /** Spawn the held piece. `timeout` ends the turn's placement even with a Double Decker piece left. */
  private drop(pose: Pose, timeout: boolean): void {
    const s = this.state;
    const sim = this.sim!;
    const type = (s.currentPiece || "toaster") as PieceType;
    const card = this.pendingCard;
    const mods: SpawnMods = {
      scale: this.pieceScale,
      massScale: card === "heavySnack" ? HEAVY_SNACK_MASS : 1,
      glue: card === "glueGun",
      card,
    };
    if (card === "butterFingers") mods.friction = BUTTER_FRICTION;
    if (card === "jellyMode") mods.restitution = JELLY_RESTITUTION;
    const pieceId = sim.spawn(type, s.activeId, pose, mods);
    this.dropsThisTurn++;
    this.betsLocked = true;
    if (card === "moonGravity" && this.dropsThisTurn === 1) {
      sim.setGravityScale(MOON_GRAVITY_SCALE);
      s.gravityScale = MOON_GRAVITY_SCALE;
    }
    this.syncPieces();
    s.piecesLeft = timeout ? 0 : Math.max(0, s.piecesLeft - 1);
    this.broadcast(MSG.DROPPED, { playerId: s.activeId, pieceId, type, piecesLeft: s.piecesLeft } satisfies DroppedMsg);

    if (s.piecesLeft > 0) {
      // Double Decker: next piece from the bag, same timer keeps running.
      s.currentPiece = this.bag?.next() ?? "toaster";
      s.nextPiece = this.bag?.peek() ?? "";
      this.lastHover = null;
      this.hopLeft = 0;
      this.writeHover(centerPose(this.minY()));
      return;
    }
    this.enterSettling();
  }

  // ==================================================================== settling
  private enterSettling(): void {
    const s = this.state;
    const sim = this.sim!;
    s.phase = "settling";
    s.hover.active = false;
    s.piecesLeft = 0;
    this.betsLocked = true;
    this.hopLeft = 0;
    if (this.pendingCard === "moonGravity") {
      sim.setGravityScale(MOON_GRAVITY_SCALE);
      s.gravityScale = MOON_GRAVITY_SCALE;
    }
    if (this.pendingCard === "earthquake") {
      sim.quake(EARTHQUAKE_SEC);
      this.quakeLeft = EARTHQUAKE_SEC;
      s.quake = true;
    }
    this.settleT = 0;
    this.setTimer(this.T.settleMax);
  }

  private tickSettling(dt: number): void {
    const s = this.state;
    const sim = this.sim!;
    const simDt = (TICK_MS / 1000) * (this.settleT < SLOWMO_FIRST_SEC ? SLOWMO_SCALE : 1);
    this.settleT += dt;
    this.stepSim(simDt, dt);
    if (this.quakeLeft > 0) {
      this.quakeLeft -= dt;
      if (this.quakeLeft <= 0) s.quake = false;
    }
    if (this.toppled) {
      if (this.sinceTopple >= this.T.toppleLinger) this.enterResult("fall");
      return;
    }
    const asleep = this.settleT >= this.T.settleMin && sim.allAsleep();
    if (asleep || this.settleT >= this.T.settleMax) this.enterResult("stand");
  }

  /** One physics step: impacts → IMPACT, transforms → state, first topple → TOPPLE. */
  private stepSim(simDt: number, realDt: number): void {
    const s = this.state;
    const sim = this.sim!;
    const impacts = sim.step(simDt);
    for (const im of impacts) {
      this.broadcast(MSG.IMPACT, {
        pieceId: im.pieceId,
        type: im.type,
        speed: round3(im.speed),
        x: round3(im.x),
        y: round3(im.y),
        z: round3(im.z),
      } satisfies ImpactMsg);
    }
    this.syncPieces();
    if (this.toppled) {
      this.sinceTopple += realDt;
      return;
    }
    const height = Math.max(0, sim.towerTop() * 100);
    s.towerHeightCm = Math.round(height * 10) / 10;
    s.payoutPreview = survivePayout(s.towerHeightCm, s.card.multiplier || 1);
    const fell = sim.toppled();
    if (fell) {
      this.toppled = fell;
      this.sinceTopple = 0;
      this.broadcast(MSG.TOPPLE, {
        playerId: s.activeId,
        pieceId: fell.id,
        x: round3(fell.pose.x),
        y: round3(fell.pose.y),
        z: round3(fell.pose.z),
      } satisfies ToppleMsg);
    }
  }

  private syncPieces(): void {
    const pieces = this.state.pieces;
    const seen = new Set<string>();
    for (const sp of this.sim!.pieces()) {
      seen.add(sp.id);
      let ps = pieces.get(sp.id);
      if (!ps) {
        ps = new PieceState();
        ps.id = sp.id;
        ps.type = sp.type;
        ps.ownerId = sp.ownerId;
        ps.scale = sp.scale;
        ps.card = sp.card;
        pieces.set(sp.id, ps);
      }
      ps.x = sp.pose.x;
      ps.y = sp.pose.y;
      ps.z = sp.pose.z;
      ps.qx = sp.pose.qx;
      ps.qy = sp.pose.qy;
      ps.qz = sp.pose.qz;
      ps.qw = sp.pose.qw;
      ps.asleep = sp.asleep;
    }
    for (const id of [...pieces.keys()]) if (!seen.has(id)) pieces.delete(id);
  }

  // ====================================================================== result
  private enterResult(outcome: BetSide): void {
    const s = this.state;
    const sim = this.sim!;
    const card = this.pendingCard;
    const multiplier = CARD_BY_ID[card].multiplier;
    const insured = card === "insurance" && outcome === "fall";
    const heightCm = outcome === "stand" ? Math.max(0, Math.round(sim.towerTop() * 100)) : Math.round(this.turnStartHeightCm);
    const active = s.players.get(s.activeId);
    let delta = 0;
    if (active) {
      delta = placementDelta(outcome, heightCm, multiplier, active.coins, card === "insurance");
      active.coins = Math.max(0, active.coins + delta);
      if (outcome === "stand") {
        active.stats.survived++;
        active.stats.bestMultiplierX10 = Math.max(active.stats.bestMultiplierX10, Math.round(multiplier * 10));
      } else {
        active.stats.topples++;
      }
    }
    if (outcome === "fall" && this.saboteurId && s.activeId !== this.saboteurId) this.hiddenBonus += SABOTEUR_TOPPLE_BONUS;
    if (this.rigRecord) this.rigRecord.outcome = outcome;

    const pending = [...this.bets.values()].filter((b) => s.players.has(b.playerId) && b.playerId !== s.activeId);
    const results = settleBets(pending, outcome);
    for (const r of results) {
      const p = s.players.get(r.playerId);
      if (!p) continue;
      p.coins = Math.max(0, p.coins + r.delta);
      p.stats.betProfit += r.delta;
    }
    this.bets.clear();

    s.towerHeightCm = outcome === "stand" ? heightCm : s.towerHeightCm;
    this.lastOutcome = outcome;
    this.broadcast(MSG.RESULT, {
      playerId: s.activeId,
      outcome,
      delta,
      card,
      multiplier,
      heightCm,
      insured,
      reset: outcome === "fall",
    } satisfies ResultMsg);
    this.broadcast(MSG.BETS, { bets: results } satisfies BetsMsg);

    this.resetBoardEffects();
    s.phase = "result";
    s.hover.active = false;
    s.currentPiece = "";
    s.piecesLeft = 0;
    this.setTimer(this.T.result);
  }

  private afterResult(): void {
    const s = this.state;
    if (this.lastOutcome === "fall") {
      this.sim!.clear();
      s.pieces.clear();
      s.towerHeightCm = 0;
    }
    s.players.forEach((p) => (p.hasBet = false));
    this.advanceTurn();
  }

  /** Wind / gravity / stand speed / quake back to normal. */
  private resetBoardEffects(): void {
    const s = this.state;
    this.sim?.setWind(1, 0, 0);
    this.sim?.setGravityScale(1);
    s.wind = 0;
    s.windX = 1;
    s.windZ = 0;
    s.gravityScale = 1;
    s.quake = false;
    this.quakeLeft = 0;
    s.standSpeed = STAND_SPEED_DEG;
  }

  // ======================================================================== bets
  private onBet(client: Client, msg: unknown): void {
    const s = this.state;
    const id = client.sessionId;
    const p = s.players.get(id);
    if (!p || p.spectator || !s.settings.sideBets || id === s.activeId || this.betsLocked) return;
    if (s.phase !== "spinning" && s.phase !== "placing") return;
    if (!s.turnOrder.includes(id) || !msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.side !== "stand" && m.side !== "fall") return;
    if (typeof m.amount !== "number" || !Number.isFinite(m.amount)) return;
    const amount = legalBetAmount(Math.min(m.amount, BET_AMOUNTS[BET_AMOUNTS.length - 1]!), p.coins);
    if (amount <= 0) {
      this.bets.delete(id);
      p.hasBet = false;
    } else {
      this.bets.set(id, { playerId: id, side: m.side, amount });
      p.hasBet = true;
    }
  }

  // ================================================================ vote & reveal
  private endOfMatch(): void {
    const s = this.state;
    s.activeId = "";
    s.hover.active = false;
    s.currentPiece = "";
    s.nextPiece = "";
    if (this.saboteurId && s.players.has(this.saboteurId) && this.voters().length >= 2) {
      this.votes.clear();
      s.players.forEach((p) => (p.voted = false));
      s.phase = "voting";
      this.setTimer(this.T.vote);
      return;
    }
    if (this.saboteurId) this.notice(say.saboteurFled());
    this.enterReveal(null);
  }

  /** Match participants still in the room. */
  private voters(): PlayerState[] {
    return this.ordered().filter((p) => !p.spectator && this.state.turnOrder.includes(p.id));
  }

  private onVote(client: Client, msg: unknown): void {
    const s = this.state;
    const id = client.sessionId;
    if (s.phase !== "voting" || !msg || typeof msg !== "object") return;
    const voter = s.players.get(id);
    if (!voter || voter.spectator || !s.turnOrder.includes(id)) return;
    const suspectId = (msg as Record<string, unknown>).suspectId;
    if (typeof suspectId !== "string" || suspectId === id) return;
    const suspect = s.players.get(suspectId);
    if (!suspect || suspect.spectator || !s.turnOrder.includes(suspectId)) return;
    this.votes.set(id, suspectId);
    voter.voted = true;
    this.checkAllVoted();
  }

  private checkAllVoted(): void {
    if (this.state.phase !== "voting") return;
    const pending = this.voters().filter((p) => p.connected && !this.votes.has(p.id));
    if (pending.length === 0) this.finishVote();
  }

  private finishVote(): void {
    const s = this.state;
    if (s.phase !== "voting") return;
    for (const [voter, suspect] of [...this.votes]) if (!s.players.has(voter) || !s.players.has(suspect)) this.votes.delete(voter);
    const outcome = resolveVote(this.votes, this.saboteurId, this.hiddenBonus);
    this.broadcast(MSG.VOTES, {
      votes: [...this.votes].map(([voterId, suspectId]) => ({ voterId, suspectId })),
      majorityId: outcome.majorityId,
    } satisfies VotesMsg);
    for (const a of outcome.adjustments) {
      const p = s.players.get(a.playerId);
      if (p) p.coins = Math.max(0, p.coins + a.delta);
    }
    this.enterReveal(outcome);
  }

  private enterReveal(outcome: VoteOutcome | null): void {
    const s = this.state;
    s.phase = "reveal";
    this.setTimer(this.T.reveal);
    this.broadcast(MSG.REVEAL, {
      saboteurId: this.saboteurId,
      rigs: this.rigs.map((r) => ({ ...r })),
      hiddenBonus: this.hiddenBonus,
      caught: outcome?.caught ?? false,
      adjustments: (outcome?.adjustments ?? []).filter((a) => s.players.has(a.playerId)),
    } satisfies RevealMsg);
  }

  private goMatchEnd(): void {
    const s = this.state;
    this.resetBoardEffects();
    s.phase = "matchEnd";
    s.activeId = "";
    s.spinStage = "idle";
    s.hover.active = false;
    s.currentPiece = "";
    s.nextPiece = "";
    s.piecesLeft = 0;
    this.setTimer(0);
    const field = this.ordered().filter((p) => !p.spectator);
    const order = standings(field.map((p) => ({ id: p.id, coins: p.coins, survived: p.stats.survived })));
    s.players.forEach((p) => (p.place = 0));
    order.forEach((id, i) => {
      const p = s.players.get(id);
      if (p) p.place = i + 1;
    });
  }

  private onRematch(client: Client): void {
    const s = this.state;
    if (client.sessionId !== s.hostId || s.phase !== "matchEnd") return;
    this.resetMatchSecrets();
    this.sim?.clear();
    s.pieces.clear();
    this.resetBoardEffects();
    s.phase = "lobby";
    s.round = 0;
    s.totalRounds = 0;
    s.turnInRound = 0;
    s.turnsPerRound = 0;
    s.activeId = "";
    s.spinStage = "idle";
    s.card.id = "";
    s.card.rarity = "";
    s.card.multiplier = 1;
    s.currentPiece = "";
    s.nextPiece = "";
    s.piecesLeft = 0;
    s.towerHeightCm = 0;
    s.payoutPreview = 0;
    s.turnOrder.clear();
    s.players.forEach((p) => {
      p.coins = START_COINS;
      p.stats = new StatsState();
      p.spectator = false;
      p.ready = false;
      p.place = 0;
      p.hasBet = false;
      p.voted = false;
    });
    this.setTimer(0);
    this.notice(say.rematch());
  }

  // ======================================================================= emote
  private onEmote(client: Client, msg: unknown): void {
    const id = client.sessionId;
    if (!this.state.players.has(id) || !msg || typeof msg !== "object") return;
    const emote = (msg as Record<string, unknown>).emote;
    if (typeof emote !== "string" || !(EMOTES as string[]).includes(emote)) return;
    const now = Date.now();
    if (now - (this.lastEmote.get(id) ?? 0) < EMOTE_COOLDOWN_MS) return;
    this.lastEmote.set(id, now);
    this.broadcast(MSG.EMOTED, { playerId: id, emote: emote as EmoteId } satisfies EmotedMsg);
  }

  // ====================================================================== roster
  /** Gone for good (consented leave or reconnect grace ran out). */
  private removePlayer(id: string): void {
    const s = this.state;
    const p = s.players.get(id);
    if (!p) return;
    const name = p.nickname;
    s.players.delete(id);
    this.joinOrder = this.joinOrder.filter((j) => j !== id);
    this.lastEmote.delete(id);
    this.bets.delete(id);
    this.votes.delete(id);
    this.compactSeats();
    if (s.hostId === id) this.migrateHost(id);
    this.notice(say.left(this.rng, name));

    const idx = s.turnOrder.indexOf(id);
    if (idx >= 0) s.turnOrder.splice(idx, 1);
    if (IN_TURNS.has(s.phase)) {
      // Drop their future turns this round; the current slot stays so indexes don't shift.
      this.schedule = this.schedule.filter((sid, i) => i <= s.turnInRound || sid !== id);
      s.turnsPerRound = this.schedule.length;
      if (this.checkTooFew()) return;
      if (s.activeId === id) this.onActiveGone(name);
    } else if (s.phase === "voting") {
      this.checkAllVoted();
    }
    this.scheduleDisposeIfEmpty();
  }

  /** The active player left for good mid-turn. */
  private onActiveGone(name: string): void {
    const s = this.state;
    if (s.phase === "spinning" || (s.phase === "placing" && this.dropsThisTurn === 0)) {
      this.notice(say.fledTurn(name));
      this.resetBoardEffects();
      s.hover.active = false;
      this.bets.clear();
      this.advanceTurn();
    } else if (s.phase === "placing") {
      this.enterSettling(); // Double Decker half done: let the first piece settle.
    }
    // settling / result: finish normally; coins for a missing player are skipped.
  }

  /** Fewer than 2 match players left → straight to the podium. */
  private checkTooFew(): boolean {
    const s = this.state;
    if (!IN_TURNS.has(s.phase) || s.turnOrder.length >= 2) return false;
    this.notice(say.tooFew());
    this.goMatchEnd();
    return true;
  }

  private migrateHost(oldId: string): void {
    const s = this.state;
    const next =
      this.ordered().find((p) => p.id !== oldId && p.connected && !p.spectator) ??
      this.ordered().find((p) => p.id !== oldId && p.connected) ??
      this.ordered().find((p) => p.id !== oldId);
    s.hostId = next?.id ?? "";
    if (next && next.id !== oldId) this.notice(say.host(next.nickname));
  }

  private resendSecrets(client: Client): void {
    const id = client.sessionId;
    const role = this.roles.get(id);
    if (role && this.state.phase !== "lobby") client.send(MSG.ROLE, { role } satisfies RoleMsg);
    if (id === this.saboteurId && IN_TURNS.has(this.state.phase)) client.send(MSG.RIG_STATUS, this.rigStatus());
  }

  private compactSeats(): void {
    this.joinOrder.forEach((id, i) => {
      const p = this.state.players.get(id);
      if (p) p.seat = i;
    });
  }

  private firstFreeColor(): number {
    const used = new Set<number>();
    this.state.players.forEach((p) => used.add(p.color));
    for (let c = 0; c < PLAYER_COLORS.length; c++) if (!used.has(c)) return c;
    return 0;
  }

  /** Players in join order. */
  private ordered(): PlayerState[] {
    return this.joinOrder.map((id) => this.state.players.get(id)).filter((p): p is PlayerState => !!p);
  }

  private matchSize(): number {
    return Math.max(this.state.turnOrder.length, 1);
  }

  private isConnected(id: string): boolean {
    return !!this.state.players.get(id)?.connected;
  }

  private clientOf(id: string): Client | undefined {
    return this.clients.find((c) => c.sessionId === id);
  }

  private notice(text: string, except?: Client): void {
    this.broadcast(MSG.NOTICE, { text } satisfies NoticeMsg, except ? { except } : undefined);
  }

  // ===================================================================== dispose
  private scheduleDisposeIfEmpty(): void {
    if (this.clients.length > 0 || this.disposeTimer || this.disposed) return;
    this.disposeTimer = this.clock.setTimeout(() => {
      this.disposeTimer = null;
      if (this.clients.length === 0) void this.disconnect();
    }, this.T.emptyDispose * 1000);
  }

  private cancelDispose(): void {
    this.disposeTimer?.clear();
    this.disposeTimer = null;
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
