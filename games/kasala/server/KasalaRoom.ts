// The Colyseus room. Owner: server. The class name, ROOM_NAME registration (server/index.ts) and the
// message / phase semantics in shared/protocol.ts are the contract; everything else is yours.
// Put pure game math in server/rules.ts (unit-tested in server/rules.test.ts) and split helpers into
// server/room/** (timings, text, loans, …). End-to-end test: server/KasalaRoom.test.ts.
//
// Responsibilities (game3.md §4–§10, §17, §19; shared/protocol.ts phase doc):
// - onCreate: this.roomId = getRoomCodes().allocate(GAME_ID); state.code = roomId; maxClients = MAX_PLAYERS;
//   patchRate = PATCH_INTERVAL_MS; setSimulationInterval(tick, TICK_MS); seeded rng from a random seed (re-seed
//   at every match start). options.fast && process.env.KASALA_TEST === "1" → tiny timers for the e2e test,
//   and options.seed (number) makes the rng deterministic in tests.
// - onJoin: nickname (trim, 1..NICKNAME_MAX, else "Gangster N"; unique in the room), first free animal and color,
//   seat, host = first human. Mid-match joiners → spectator (watch, no turns, no bets, no loans). Send WELCOME.
//   A human joining a full lobby takes the seat of the last bot.
// - onLeave: allowReconnection(client, RECONNECT_GRACE_SEC) unless consented; host migrates to the next
//   connected human (NOTICE) and comes back to the old host if they reconnect within the grace. In the lobby
//   just remove. A disconnected player keeps their seat until the grace ends (their turns are skipped, §17);
//   then a match player is taken over by a bot (bot = true, same name and seat) so the match goes on, and
//   their pending offers are removed. Dispose EMPTY_ROOM_DISPOSE_SEC after the last human left.
// - onDispose: getRoomCodes().release(roomId).
// - Lobby: READY, ANIMAL, COLOR (unique), SETTINGS (host only, validated against the option lists), START
//   (host, ≥ MIN_PLAYERS connected non-spectators, everyone ready; bots count and are always ready), ADD_BOT /
//   REMOVE_BOT (host only, humans + bots ≤ MAX_PLAYERS). Bots: server/room/bots.ts.
// - Match start: kasa = START_KASA (royale ROYALE_START_KASA), kumbara = START_KUMBARA, stats reset, flags reset,
//   turnOrder = players by seat, totalRounds = settings.turns || classicRounds(n) (royale: ROYALE_MAX_ROUNDS),
//   round = 1, intro (ANNOUNCER matchStart). finalTable = classic && round === totalRounds. Each new match in
//   the room starts one seat further round the table.
// - Turn start (betting): active = next non-ghost player in turnOrder; skip disconnected ones (CASHED skipped=true,
//   no bets; they still "take" the turn). sirenLevel = trapped ? TRAP_LEVEL : 0 (clear trapped);
//   lawyers = lawyerNext ? 1 : 0 (clear lawyerNext); curseArmed = player.cursed; turnPot = flips = 0;
//   raidChance = raidChance(sirenLevel, floorBonus); clear bets; lastCard reset. Broadcast TURN_START,
//   ANNOUNCER turnStart / betsOpen only now and then (the first turn, special turns, every fourth turn).
//   Phase timer BET_WINDOW_FIRST_ROUND_SEC (round 1) / BET_WINDOW_SEC, or TURN_INTRO_SEC when nobody can bet.
// - BET (§8): non-active, non-spectator, phase betting, settings.sideBets, amount ∈ CHIP_AMOUNTS and ≤ kasa
//   (stake leaves the kasa now; a replaced bet is refunded first; 0 cancels, or PAS when there is no bet).
//   Ghosts: ghost = true, amount GHOST_CHIP, free (in Battle Royale even with side bets off, §10). Once every
//   eligible bettor has bet or passed, the window closes ~0.8 s later. Bets lock at the first FLIP.
// - Flipping: the first card is mandatory. Its timer is max(decisionSec, FIRST_CARD_SEC); CASH before it is
//   refused (NOTICE "Önce bir kart çevir!"); when it runs out Cemil Abi flips it for the player (a disconnected
//   player's turn is skipped). The decision timer (decisionSec) runs after every card, then auto KASALA.
// - FLIP (active, flipping, !busy; during betting it is queued for the moment bets close): roll with rules: raid with p = state.raidChance, else a weighted card (CARDS
//   weights). Then sirenLevel += 1 (rusvet: then −BRIBE_ENVELOPE_DROP, floor 0); flips += 1; stats.maxFlips.
//   Effects: money → value × (finalTable ? 2 : 1), or 0 when curseArmed (curseArmed = false, cursed = false,
//   ANNOUNCER curseHit); aklama → pot × 2; avukat → lawyers += 1; tuzak → next player (in turn order, after the
//   active one, skipping ghosts) trapped = true, ATTACK; haracTuru → every other non-ghost player pays
//   min(HARAC_TURU_FEE, kasa) into the pot, ATTACK; harac / lanet / takas → targeting (needsTarget);
//   cark → wheel; baskin → if lawyers > 0: lawyers -= 1, CARD saved = true, ANNOUNCER lawyerSaved, busy
//   LAWYER_ANIM_SEC, turn goes on (the raid does NOT count for bets) · else → result (raid).
//   Broadcast CARD first (with pot / sirenLevel / raidChance after the card), then at most one announcer line
//   (money lines only for çanta / külçe / aklama; sirenCritical / sirenMid once per turn per tier when the new
//   raidChance crosses SIREN_CRITICAL_CHANCE / SIREN_MID_CHANCE). busy = true for FLIP_ANIM_SEC, then the timer
//   restarts. timeLeft ≤ TIME_LOW_SEC after a card: ANNOUNCER timeLow (humans only, max once per turn).
// - Targeting: TARGET or random after TARGET_SEC; a single legal target resolves on its own ~1 s after the card
//   landed. harac: floor(target.kasa × HARAC_PCT) from the target's kasa into
//   the pot; lanet: target.cursed = true; takas: swap the two kasas (permanent). ATTACK, announcer, busy
//   ATTACK_ANIM_SEC. Targets must be other non-ghost, non-spectator match players (connected or not).
// - Wheel (§7): slice from WHEEL_SLICES weights, decided before WHEEL_START. spinMs random in
//   [WHEEL_SPIN_MIN_SEC, WHEEL_SPIN_MAX_SEC]. ANNOUNCER wheel on the first spin. At descendMs + spinMs apply:
//   kumbara → active kasa += kumbara, kumbara = 0 · x10 → pot × WHEEL_POT_MULT · herkese100 → every non-ghost
//   player +WHEEL_EVERYONE_GAIN · karistir → shuffle the kasas of all non-ghost players · herkeseOde → the active
//   player pays each other non-ghost player min(WHEEL_PAY_EACH, kasa left) · avukat → lawyers += 1 and
//   lawyerNext = true · topluBaskin → every non-ghost player pays floor(kasa × WHEEL_RAID_PCT) to the kumbara ·
//   birDaha → spin again. Broadcast WHEEL_RESULT + ANNOUNCER wheel_<slice>; hold WHEEL_HOLD_SEC; again → new
//   WHEEL_START with descendMs 0; else busy WHEEL_ASCEND_SEC → flipping.
// - Vitrin: money cards, Haraç and Haraç Turu money land in state.row (one card each, value > 0); turnPot is the
//   row value still on the table. Kara Para Aklama doubles every row card, the wheel's POT ×10 multiplies them.
// - CASH (or decision timer end → auto): KASALA takes the picksFor(flips) most valuable row cards (bestPicks);
//   their value is the "pot" below. Taşlık → TASLIK_CUT_PCT of the pot repays creditors (largest debt first),
//   the rest to the kasa. Stats cashes / earlyCashes (1..EARLY_CASH_FLIPS cards) / biggestCash. CASHED, ANNOUNCER
//   cashSmall (0 < pot < SMALL_CASH after ≤ EARLY_CASH_FLIPS cards) / cashBig (pot ≥ BIG_CASH) → result for CASH_RESULT_SEC (CASH_RESULT_BIG_SEC
//   when pot ≥ BIG_CASH), sent as CashedMsg.resultSec.
// - Raid: pot → kumbara; bribe = classic ? floor(kasa × RAID_BRIBE_PCT × (finalTable ? 2 : 1)) : min(kasa,
//   round × ROYALE_BRIBE_PER_ROUND) → kumbara. stats.raids. RAIDED (anim = random RAID_ANIMS), ANNOUNCER raidFirst
//   (flip 1) / raidLate (flip ≥ 4) / raid → result for RAID_RESULT_SEC when the raid is "long" (pot + bribe ≥
//   60$, flip ≥ 4 or the player's first raid of the match: full door sequence), else RAID_RESULT_SHORT_SEC.
// - Pazar (after the KASALA result phase, when row cards are left): every other non-ghost player who can pay for
//   at least one card is a buyer (disconnected humans sit it out). MARKET (row card or 0 = pas, changeable, secret)
//   → state.marketDone; everyone chose → closes after T.marketCloseGrace. resolveMarket: the poorer buyer wins a
//   clash; each sale moves value − fee to the buyer and the fee to the seller (Taşlık cut applies), unsold cards
//   go to the kumbara. MARKET_RESULT, busy for MARKET_REVEAL_SEC, then settle. Leftovers with no buyer at all
//   skip the phase (MARKET_RESULT with leftovers only). A raid sends the whole row to the kumbara (no Pazar).
// - Settle (§8): boxWins(box, outcome) → winner gets floor(amount × payout × (finalTable ? 2 : 1)) back;
//   losing real stakes: floor(total × HOUSE_CUT_PCT) to the active player, the rest to the kumbara. Ghost wins →
//   ghostWins += 1; at GHOST_WINS_TO_RETURN (and !ghostReturned) → ghost = false, ghostReturned = true, kasa =
//   GHOST_RETURN_KASA, GHOST_RETURN + ANNOUNCER ghostReturn. Stats. BETS_SETTLED + ANNOUNCER betsRaidersWon
//   (majority of bettors won on raid boxes) / betsCashLost (majority lost on "cash"), nothing otherwise. A turn
//   whose active player disconnected → bets refunded, no settle.
// - After every turn: the active player's `cursed` is cleared (the curse only lasts one turn); bets cleared,
//   lastCard / pendingCard / wheelSlice reset, busy false. Recompute taslik (TASLIK on change + ANNOUNCER taslik when it turns on). Battle Royale: any
//   non-ghost player with kasa ≤ 0 → lastChance (one at a time, LAST_CHANCE + ANNOUNCER lastChance). Saved by an
//   accepted loan → SAVED, back to the flow; timeout → elimination (ELIMINATED + ANNOUNCER eliminated, ghost =
//   true, their bets/offers cleared, debts owed TO them written off, their own debts stop growing, no Taşlık).
//   Son Şans is short when nobody (or only one player) can lend, or the broke player is disconnected (a drop
//   mid-Son Şans cuts it short, a return / bot takeover restores it). One non-ghost player left → matchEnd.
// - Round end (all turnsPerRound turns done): interest on every debt (owed = ceil(owed × (1 + rate/100))),
//   royale floorBonus += ROYALE_FLOOR_STEP, ROUND_END (with standings and each player's kasa change since the
//   round began). Classic: round === totalRounds → matchEnd. Royale: round === ROYALE_MAX_ROUNDS → matchEnd
//   (richest non-ghost wins). Otherwise busy for ROUND_SUMMARY_SEC (the clients' round summary), then the next
//   round. Next round finalTable → ANNOUNCER finalTable.
// - Loans (§9, settings.loans, any phase except lobby / intro / matchEnd, ghosts and spectators excluded):
//   LOAN_PROPOSE (rate-limited per player) → offers map (one outgoing pending per player, LOAN_OFFER_SEC,
//   LOAN "proposed"; the same offer again only restarts its clock);
//   LOAN_RESPOND by toId → accept: lender = (kind offer ? from : to); amount ≤ floor(lender.kasa ×
//   LOAN_MAX_PCT) else NOTICE + decline; move money, new DebtState, stats lent / borrowed, LOAN "accepted",
//   ANNOUNCER loanAccepted · decline → LOAN "declined", ANNOUNCER loanDeclined. LOAN_CANCEL by fromId. Expiry →
//   LOAN "expired". LOAN_REPAY by the borrower: min(amount, owed, kasa) → lender; owed 0 → delete the debt, LOAN
//   "paidOff" + ANNOUNCER loanRepaid, else LOAN "repaid". Taşlık recomputed after every money move.
// - Match end (§9, §16): collect every debt (min(owed, kasa) to the lender, rest wiped → karaListe), standings
//   (classic: kasa desc, tie → fewer raids; royale: survivors by kasa, then ghosts by elimination order, latest
//   first), place, shame titles (each only when earned, see TITLES: most raids ≥1, most borrowed ≥1, most
//   earlyCashes ≥1, worst betProfit < 0 with ≥2 bets, any karaListe, most maxFlips ≥4), MATCH_END, ANNOUNCER
//   matchEnd. REMATCH (host) → lobby: players kept, ready = false, spectators join, state reset.
// - EMOTE / TAUNT → EMOTED / TAUNTED (EMOTE_COOLDOWN_SEC per player). Validate every payload defensively: wrong
//   types / wrong phase / wrong player → ignore (optionally NOTICE to that client only).
// - ANNOUNCER: always through pickLine(event, lastIdForEvent, rng) from shared/announcer.ts.
//
// Implementation notes (server owner):
// - Animation locks (`busy`) freeze the phase timer. A raid card, the wheel card and instant attacks (Haraç Turu,
//   Tuzak) resolve when the card's FLIP_ANIM_SEC lock ends, so clients see the card first and the consequence
//   (RAIDED / WHEEL_START / ATTACK) right after. "pick" attacks enter targeting at once (TARGET is accepted during
//   the flip lock and applied when it ends).
// - At most one Cemil Abi line per flip / turn start, so lines don't cut each other off: an attack / protection
//   line beats a crossed siren tier, which beats "bets closed", which beats a money line. A crossed tier that
//   lost out stays pending and plays on a later flip of the same turn. Turn starts alternate betsOpen /
//   turnStart (the SON MASA line wins on the final round's first turn).
// - Match players who leave for good are taken over by a bot until the rematch (then they are removed).
// - Three rng streams per match: `rng` for outcomes (cards, wheel, targets, shuffles), `fxRng` for cosmetics
//   (announcer variations, raid animation, wheel spin length) and `botRng` for every bot decision and think
//   delay, so timing-dependent or bot picks never shift outcomes.
// - Every action has an id-based act* method (actFlip, actCash, actTarget, actBet, …): client messages and
//   bots go through the same validation.
// - state.timeLeft is quantized to TIMER_QUANTUM_SEC and offer timeLeft to whole seconds, so a running timer
//   doesn't patch every tick (clients count down smoothly on their own).

import { Room, type Client } from "@colyseus/core";
import {
  ANIMALS,
  ANIMAL_BY_ID,
  BET_BOX_BY_ID,
  BIG_CASH,
  CARD_BY_ID,
  BOT_NAMES,
  CHIP_AMOUNTS,
  DECISION_SEC_OPTIONS,
  EARLY_CASH_FLIPS,
  EMOTES,
  FIRST_CARD_SEC,
  GAME_ID,
  GHOST_CHIP,
  GHOST_RETURN_KASA,
  LOAN_MIN,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PATCH_INTERVAL_MS,
  PLAYER_COLORS,
  RAID_ANIMS,
  ROYALE_FLOOR_STEP,
  ROYALE_MAX_ROUNDS,
  ROYALE_START_KASA,
  SIREN_CRITICAL_CHANCE,
  SIREN_MID_CHANCE,
  SMALL_CASH,
  START_KASA,
  START_KUMBARA,
  TAUNTS,
  TICK_MS,
  TIMER_QUANTUM_SEC,
  TRAP_LEVEL,
  TURN_OPTIONS,
  WHEEL_POT_MULT,
  classicRounds,
  marketFee,
  picksFor,
  raidChance,
} from "../shared/constants.js";
import type { Animal, BetBox, CardId, EmoteId, TurnOutcome, WheelSliceId } from "../shared/constants.js";
import type { AnnouncerEvent } from "../shared/announcer.js";
import { MSG } from "../shared/protocol.js";
import type {
  AnnouncerMsg,
  AttackMsg,
  BetsSettledMsg,
  CardMsg,
  CashedMsg,
  EliminatedMsg,
  EmotedMsg,
  GhostReturnMsg,
  LastChanceMsg,
  LoanMsg,
  LoanProposeMsg,
  MarketResultMsg,
  MatchEndMsg,
  NoticeMsg,
  Phase,
  RaidedMsg,
  RoundEndMsg,
  SavedMsg,
  TaslikMsg,
  TauntedMsg,
  TurnStartMsg,
  WelcomeMsg,
  WheelResultMsg,
  WheelStartMsg,
} from "../shared/protocol.js";
import { getRoomCodes } from "./hub.js";
import {
  MAX_WHEEL_SPINS,
  applyWheel,
  bestPicks,
  betsLineEvent,
  createRng,
  ghostAfterWin,
  haracAmount,
  haracTuruPayments,
  isEarlyCash,
  isTaslik,
  loanLimit,
  moneyValue,
  nextInOrder,
  pick,
  raidBribe,
  randInt,
  randomTarget,
  resolveMarket,
  rollFlip,
  rollWheel,
  rowValue,
  settleBets,
  shameTitles,
  sirenAfter,
  standings,
  type Rng,
} from "./rules.js";
import { AnnouncerPicker, matchEndScript, type ScriptedLine } from "./room/announce.js";
import { BotDesk, personalityFor, type BotHost } from "./room/bots.js";
import { LoanDesk, type LoanHost } from "./room/loans.js";
import { readKnobs, type TestKnobs } from "./room/testing.js";
import { botNickname, cleanNickname, defaultNickname, say, uniqueNickname } from "./room/text.js";
import { FAST_TIMINGS, NORMAL_TIMINGS, type Timings } from "./room/timings.js";
import { BetState, KasalaState, PlayerState, RowCardState, StatsState } from "./schema.js";

/** A match is running (turn bookkeeping applies). */
const IN_MATCH: ReadonlySet<Phase> = new Set<Phase>([
  "intro",
  "betting",
  "flipping",
  "targeting",
  "wheel",
  "result",
  "market",
  "settle",
  "lastChance",
  "elimination",
]);
/** Loans can be proposed / answered / repaid (§9: any time during the match). */
const LOAN_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  "betting",
  "flipping",
  "targeting",
  "wheel",
  "result",
  "market",
  "settle",
  "lastChance",
  "elimination",
]);

type Cancelable = { clear(): void };
type AfterFlip = "resume" | "raid" | "saved" | "target" | "attack" | "wheel";

/** A raid this big (pot + bribe) gets the full door sequence (RaidedMsg.long). */
const LONG_RAID_LOSS = 60;
/** …and so does a raid on this card or later. */
const LONG_RAID_FLIP = 4;
/** Turn-start lines (turnStart / betsOpen) play every this many turns, plus the match's first and special turns. */
const TURN_LINE_EVERY = 4;

function obj(m: unknown): Record<string, unknown> | null {
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
}

function randomSeed(): number {
  return (Math.floor(Math.random() * 0x1_0000_0000) ^ Date.now()) >>> 0;
}

export class KasalaRoom extends Room<KasalaState> {
  maxClients = MAX_PLAYERS;
  autoDispose = false;

  private T: Timings = NORMAL_TIMINGS;
  private knobs!: TestKnobs;
  private rng: Rng = Math.random;
  private fxRng: Rng = Math.random;
  private botRng: Rng = Math.random;
  private matchNo = 0;
  private announcer = new AnnouncerPicker(Math.random);
  private loans!: LoanDesk;
  private bots!: BotDesk;
  private disposeTimer: Cancelable | null = null;
  private disposed = false;

  // --- roster
  /** Seat order (seats are compacted from it). In a match the match players come first, in turn order. */
  private order: string[] = [];
  /** Match players who left for good (a bot plays their seat, or they wait on the podium): removed at the rematch. */
  private leavers = new Set<string>();
  /** The host dropped (not consented): they get host back if they reconnect within the grace. */
  private hostBeforeDrop = "";
  private botSeq = 0;
  private lastEmote = new Map<string, number>();
  private lastTaunt = new Map<string, number>();
  private lastLoanPropose = new Map<string, number>();
  private lastLoanRepay = new Map<string, number>();

  // --- phase timer (seconds into it, its length) and the animation lock that freezes it
  private t = 0;
  private timerTotal = 0;
  private lockLeft = 0;
  private afterLock: (() => void) | null = null;

  // --- round / turn
  /** Each match player's kasa when the current round began (round summary deltas). */
  private readonly roundStartKasa = new Map<string, number>();
  /** This round's turns (non-ghost match players when the round started); index = state.turnInRound. */
  private schedule: string[] = [];
  /** Each match starts this many seats round the table (rotates per match in the room). */
  private firstSeat = 0;
  private turnCount = 0;
  private finalLinePending = false;
  /** Turn-start lines said this match (betsOpen / turnStart alternate). */
  private turnLines = 0;
  /** This turn opened with the betsOpen line: "bets closed" may follow on the first card. */
  private openedWithBets = false;
  private betsOpen = false;
  /** Bettors who bet or passed in this bet window. */
  private betDone = new Set<string>();
  /** The active player pressed FLIP during the bet window: flip the moment bets close. */
  private flipQueued = false;
  private outcome: TurnOutcome = { raided: false, raidFlip: 0 };
  private refundBets = false;
  private timeLowSaid = false;
  /** Siren tier already announced this turn (0 none, 1 mid, 2 critical) and a crossed tier still waiting for its line. */
  private sirenSaid = 0;
  private sirenPending = 0;
  private chosenTarget = "";
  /** The only legal target of the pending attack card (it resolves on its own after T.autoTarget). */
  private forcedTarget = "";
  private wheelStage: "spin" | "hold" = "spin";
  private wheelSpin = 0;
  private wheelNext: WheelSliceId = "kumbara";
  private wheelAgain = false;
  /** Pazar buyers of this market (turn order after the seller) and their secret choices (flipNo, 0 = pas). */
  private marketBuyers: string[] = [];
  private marketChoice = new Map<string, number>();
  private elimSeq = 0;
  private elimIndex = new Map<string, number>();

  // --- match end announcer sequence
  private endScript: ScriptedLine[] = [];
  private endT = 0;

  // ===================================================================== lifecycle
  onCreate(options: unknown): void {
    const opts = obj(options) ?? {};
    const testEnv = process.env.KASALA_TEST === "1";
    const fast = testEnv && opts.fast === true;
    this.T = fast ? FAST_TIMINGS : NORMAL_TIMINGS;
    this.knobs = readKnobs(opts, testEnv, fast);

    this.roomId = getRoomCodes().allocate(GAME_ID);
    this.state = new KasalaState();
    this.state.code = this.roomId;
    this.patchRate = PATCH_INTERVAL_MS;
    this.reseed();
    this.loans = new LoanDesk(this.loanHost(), this.T.loanOffer);
    this.bots = new BotDesk(this.botHost());

    // Client messages only resolve the sender; the act* methods do all the validation (bots use them too).
    this.handle(MSG.READY, (c, m) => this.onReady(c, m));
    this.handle(MSG.ANIMAL, (c, m) => this.onAnimal(c, m));
    this.handle(MSG.COLOR, (c, m) => this.onColor(c, m));
    this.handle(MSG.SETTINGS, (c, m) => this.onSettings(c, m));
    this.handle(MSG.START, (c) => this.onStart(c));
    this.handle(MSG.ADD_BOT, (c) => this.onAddBot(c));
    this.handle(MSG.REMOVE_BOT, (c, m) => this.onRemoveBot(c, m));
    this.handle(MSG.FLIP, (c) => this.actFlip(c.sessionId));
    this.handle(MSG.CASH, (c) => this.actCash(c.sessionId));
    this.handle(MSG.TARGET, (c, m) => this.actTarget(c.sessionId, obj(m)?.targetId));
    this.handle(MSG.BET, (c, m) => this.actBet(c.sessionId, obj(m)?.box, obj(m)?.amount));
    this.handle(MSG.MARKET, (c, m) => this.actMarket(c.sessionId, obj(m)?.flipNo));
    this.handle(MSG.LOAN_PROPOSE, (c, m) => this.actLoanPropose(c.sessionId, m));
    this.handle(MSG.LOAN_RESPOND, (c, m) => this.actLoanRespond(c.sessionId, m));
    this.handle(MSG.LOAN_CANCEL, (c, m) => this.loans.cancel(c.sessionId, m));
    this.handle(MSG.LOAN_REPAY, (c, m) => this.actLoanRepay(c.sessionId, m));
    this.handle(MSG.EMOTE, (c, m) => this.actEmote(c.sessionId, obj(m)?.emote));
    this.handle(MSG.TAUNT, (c, m) => this.actTaunt(c.sessionId, obj(m)?.index));
    this.handle(MSG.REMATCH, (c) => this.onRematch(c));
    this.onMessage("*", () => {
      /* unknown message types: ignore */
    });

    this.setSimulationInterval((dtMs) => this.tick(dtMs), TICK_MS);
    this.scheduleDisposeIfEmpty();
  }

  onJoin(client: Client, options: unknown): void {
    this.cancelDispose();
    const s = this.state;
    const opts = obj(options) ?? {};
    // A full lobby: the newest bot gives its seat to the human.
    if (s.phase === "lobby" && this.seatedCount() >= MAX_PLAYERS) this.dropLastBot();
    const taken: string[] = [];
    s.players.forEach((p) => taken.push(p.nickname));
    const nickname = uniqueNickname(cleanNickname(opts.nickname) || defaultNickname(this.order.length + 1), taken);

    const p = new PlayerState();
    p.id = client.sessionId;
    p.nickname = nickname;
    p.animal = this.firstFreeAnimal();
    p.color = this.firstFreeColor();
    p.connected = true;
    p.spectator = s.phase !== "lobby";
    p.kasa = p.spectator ? 0 : START_KASA;
    s.players.set(p.id, p);
    this.order.push(p.id);
    this.compactSeats();
    if (!this.hostOk()) s.hostId = p.id;

    client.send(MSG.WELCOME, { you: p.id, code: this.roomId } satisfies WelcomeMsg);
    this.notice(p.spectator ? say.spectating(nickname) : say.joined(this.fxRng, nickname), client);
  }

  async onLeave(client: Client, consented?: boolean): Promise<void> {
    const id = client.sessionId;
    const p = this.state.players.get(id);
    if (!p || p.bot) return;
    p.connected = false;
    if (consented) {
      this.leaveForGood(id);
      return;
    }
    if (this.state.hostId === id) {
      this.hostBeforeDrop = id;
      this.migrateHost(id);
    }
    this.notice(say.reconnecting(p.nickname));
    this.maybeCloseBets();
    this.maybeCloseMarket();
    this.lastChanceConnection(id);
    this.scheduleDisposeIfEmpty();
    try {
      const back = await this.allowReconnection(client, this.T.reconnectGrace);
      const again = this.state.players.get(id);
      if (!again || this.disposed || again.bot) return;
      this.cancelDispose();
      again.connected = true;
      this.lastChanceConnection(id);
      // The host who only blipped gets the table back; anyone gets it when there is no usable host.
      if ((this.hostBeforeDrop === id || !this.hostOk()) && this.state.hostId !== id) {
        this.state.hostId = id;
        this.notice(say.host(again.nickname));
      }
      if (this.hostBeforeDrop === id) this.hostBeforeDrop = "";
      back.send(MSG.WELCOME, { you: id, code: this.roomId } satisfies WelcomeMsg);
      this.notice(say.reconnected(again.nickname), back);
    } catch {
      if (!this.disposed) this.leaveForGood(id);
    }
  }

  onDispose(): void {
    this.disposed = true;
    this.cancelDispose();
    getRoomCodes().release(this.roomId);
  }

  // ========================================================================= tick
  private tick(deltaMs: number): void {
    try {
      this.step(Math.min(Math.max(deltaMs, 0), 250) / 1000);
    } catch (e) {
      console.error("[kasala] tick failed", e);
    }
  }

  private step(dt: number): void {
    const s = this.state;
    if (LOAN_PHASES.has(s.phase) && s.offers.size) this.loans.tick(dt);
    if (s.phase === "matchEnd") this.tickEndScript(dt);
    this.stepPhase(dt);
    // Bots act after this tick's transitions, so they always see the current phase.
    if (this.bots.size && IN_MATCH.has(this.state.phase)) this.bots.tick(dt);
    this.syncTimer();
  }

  private stepPhase(dt: number): void {
    const s = this.state;
    if (this.lockLeft > 0) {
      this.lockLeft -= dt;
      if (this.lockLeft <= 0) {
        this.lockLeft = 0;
        s.busy = false;
        const then = this.afterLock;
        this.afterLock = null;
        then?.();
      }
      return;
    }

    this.t += dt;
    const over = this.timerTotal > 0 && this.t >= this.timerTotal;
    switch (s.phase) {
      case "intro":
        if (over) this.beginRound();
        break;
      case "betting":
        if (over) this.endBetting();
        break;
      case "flipping":
        this.tickDecision(over);
        break;
      case "targeting":
        if (over) this.targetTimeout();
        break;
      case "wheel":
        if (over) {
          if (this.wheelStage === "spin") this.landWheel();
          else this.afterWheelHold();
        }
        break;
      case "result":
        if (over) this.afterResult();
        break;
      case "market":
        if (over) this.closeMarket();
        break;
      case "settle":
        if (over) this.afterTurn();
        break;
      case "lastChance":
        if (over) this.lastChanceTimeout();
        break;
      case "elimination":
        if (over) this.afterElimination();
        break;
      default:
        break;
    }
  }

  private setTimer(sec: number): void {
    this.t = 0;
    this.timerTotal = Math.max(0, sec);
    this.syncTimer();
  }

  /** Seconds left on the phase timer (unquantized), Infinity when untimed. */
  private timeLeftExact(): number {
    return this.timerTotal > 0 ? Math.max(0, this.timerTotal - this.t) : Infinity;
  }

  /** timeLeft rounded UP to TIMER_QUANTUM_SEC: the synced value changes a few times a second, not every tick. */
  private syncTimer(): void {
    const s = this.state;
    s.timeTotal = this.timerTotal;
    if (this.timerTotal <= 0) {
      s.timeLeft = 0;
      return;
    }
    const q = TIMER_QUANTUM_SEC;
    const left = Math.max(0, this.timerTotal - this.t);
    s.timeLeft = Math.min(this.timerTotal, Math.ceil(left / q - 1e-6) * q);
  }

  /** Animation lock: busy for `sec`, the phase timer is frozen, then `then` runs. */
  private busyFor(sec: number, then?: () => void): void {
    this.lockLeft = Math.max(sec, 0.001);
    this.afterLock = then ?? null;
    this.state.busy = true;
  }

  private clearLock(): void {
    this.lockLeft = 0;
    this.afterLock = null;
    this.state.busy = false;
  }

  // ======================================================================= lobby
  private onReady(client: Client, msg: unknown): void {
    const p = this.state.players.get(client.sessionId);
    const m = obj(msg);
    if (!p || !m || this.state.phase !== "lobby" || p.spectator || typeof m.ready !== "boolean") return;
    p.ready = m.ready;
  }

  private onAnimal(client: Client, msg: unknown): void {
    const p = this.state.players.get(client.sessionId);
    const m = obj(msg);
    if (!p || !m || this.state.phase !== "lobby" || typeof m.animal !== "string" || !(m.animal in ANIMAL_BY_ID)) return;
    const animal = m.animal as Animal;
    let taken = false;
    this.state.players.forEach((o) => {
      if (o.id !== p.id && o.animal === animal) taken = true;
    });
    if (!taken) p.animal = animal;
  }

  private onColor(client: Client, msg: unknown): void {
    const p = this.state.players.get(client.sessionId);
    const m = obj(msg);
    if (!p || !m || this.state.phase !== "lobby") return;
    const color = m.color;
    if (typeof color !== "number" || !Number.isInteger(color) || color < 0 || color >= PLAYER_COLORS.length) return;
    let taken = false;
    this.state.players.forEach((o) => {
      if (o.id !== p.id && o.color === color) taken = true;
    });
    if (!taken) p.color = color;
  }

  private onSettings(client: Client, msg: unknown): void {
    const m = obj(msg);
    if (!m || client.sessionId !== this.state.hostId || this.state.phase !== "lobby") return;
    const st = this.state.settings;
    if (m.mode === "classic" || m.mode === "royale") st.mode = m.mode;
    if (typeof m.turns === "number" && (TURN_OPTIONS as readonly number[]).includes(m.turns)) st.turns = m.turns;
    if (typeof m.decisionSec === "number" && (DECISION_SEC_OPTIONS as readonly number[]).includes(m.decisionSec)) st.decisionSec = m.decisionSec;
    if (typeof m.loans === "boolean") st.loans = m.loans;
    if (typeof m.sideBets === "boolean") st.sideBets = m.sideBets;
  }

  /** Host only, lobby only: a bot takes the first free seat. */
  private onAddBot(client: Client): void {
    const s = this.state;
    if (client.sessionId !== s.hostId || s.phase !== "lobby") return;
    if (this.seatedCount() >= MAX_PLAYERS) return void client.send(MSG.NOTICE, say.tableFull(MAX_PLAYERS) satisfies NoticeMsg);
    this.addBot();
  }

  /** Host only, lobby only. */
  private onRemoveBot(client: Client, msg: unknown): void {
    const s = this.state;
    const m = obj(msg);
    if (!m || client.sessionId !== s.hostId || s.phase !== "lobby" || typeof m.id !== "string") return;
    const p = s.players.get(m.id);
    if (!p || !p.bot) return;
    const name = p.nickname;
    this.removePlayer(p.id);
    this.notice(say.botLeft(name));
  }

  private addBot(): PlayerState {
    const s = this.state;
    const taken: string[] = [];
    s.players.forEach((p) => taken.push(p.nickname));
    let id = "";
    do id = `bot-${++this.botSeq}`;
    while (s.players.has(id));
    const p = new PlayerState();
    p.id = id;
    p.nickname = botNickname(BOT_NAMES, taken);
    p.animal = this.firstFreeAnimal();
    p.color = this.firstFreeColor();
    p.bot = true;
    p.connected = true;
    p.ready = true;
    p.spectator = false;
    p.kasa = START_KASA;
    s.players.set(id, p);
    this.order.push(id);
    this.compactSeats();
    this.bots.add(id, personalityFor(p.nickname));
    this.notice(say.botJoined(p.nickname));
    return p;
  }

  /** Lobby: remove the most recently seated bot (a human needs the seat). */
  private dropLastBot(): boolean {
    const bot = [...this.ordered()].reverse().find((p) => p.bot);
    if (!bot) return false;
    const name = bot.nickname;
    this.removePlayer(bot.id);
    this.notice(say.botMadeRoom(name));
    return true;
  }

  /** Players with a seat at the table (everyone but spectators). */
  private seatedCount(): number {
    let n = 0;
    this.state.players.forEach((p) => {
      if (!p.spectator) n++;
    });
    return n;
  }

  /** Host only. Everyone connected must be ready (the host's Start counts as their ready). */
  private onStart(client: Client): void {
    const s = this.state;
    if (client.sessionId !== s.hostId || s.phase !== "lobby") return;
    const seated = this.ordered().filter((p) => p.connected && !p.spectator);
    if (seated.length < MIN_PLAYERS) return void client.send(MSG.NOTICE, say.cantStartFew(MIN_PLAYERS) satisfies NoticeMsg);
    const lazy = seated.filter((p) => !p.ready && p.id !== s.hostId);
    if (lazy.length) return void client.send(MSG.NOTICE, say.cantStartLazy(lazy.map((p) => p.nickname)) satisfies NoticeMsg);
    this.startMatch(seated.slice(0, MAX_PLAYERS).map((p) => p.id));
  }

  private startMatch(ids: string[]): void {
    const s = this.state;
    this.matchNo++;
    this.reseed();
    const royale = s.settings.mode === "royale";
    const startKasa = this.knobs.startKasa ?? (royale ? ROYALE_START_KASA : START_KASA);

    this.order = [...ids, ...this.order.filter((id) => !ids.includes(id))];
    this.compactSeats();
    s.players.forEach((p) => {
      const plays = ids.includes(p.id);
      this.resetPlayer(p, plays ? startKasa : 0);
      p.spectator = !plays;
    });
    this.leavers.clear();
    this.elimIndex.clear();
    this.elimSeq = 0;
    this.endScript = [];
    this.firstSeat = ids.length ? (this.matchNo - 1) % ids.length : 0;
    this.turnLines = 0;
    this.lastLoanPropose.clear();
    this.lastLoanRepay.clear();
    this.bots.resetMatch();

    s.turnOrder.clear();
    for (const id of ids) s.turnOrder.push(id);
    s.round = 0;
    s.totalRounds = this.knobs.rounds ?? (royale ? ROYALE_MAX_ROUNDS : s.settings.turns || classicRounds(ids.length));
    s.turnInRound = 0;
    s.turnsPerRound = ids.length;
    s.activeId = "";
    s.lastChanceId = "";
    s.kumbara = START_KUMBARA;
    s.floorBonus = 0;
    s.finalTable = false;
    s.bets.clear();
    this.loans.clearAll();
    this.schedule = [];
    this.turnCount = 0;
    this.resetTurn();
    this.clearLock();

    s.phase = "intro";
    this.setTimer(this.T.intro);
    this.announce("matchStart");
  }

  private resetPlayer(p: PlayerState, kasa: number): void {
    p.kasa = kasa;
    p.stats = new StatsState();
    p.ready = p.bot;
    p.ghost = false;
    p.ghostWins = 0;
    p.ghostReturned = false;
    p.cursed = false;
    p.trapped = false;
    p.lawyerNext = false;
    p.taslik = false;
    p.karaListe = false;
    p.place = 0;
  }

  private reseed(): void {
    const seed = this.knobs.seed !== null ? (this.knobs.seed + Math.imul(this.matchNo, 0x9e3779b9)) >>> 0 : randomSeed();
    this.rng = createRng(seed);
    this.fxRng = createRng((seed ^ 0x5bd1e995) >>> 0);
    this.botRng = createRng((seed ^ 0x27d4eb2f) >>> 0);
    this.announcer.setRng(this.fxRng);
  }

  // ====================================================================== rounds
  private beginRound(): void {
    const s = this.state;
    s.round += 1;
    const order = [...s.turnOrder];
    const k = order.length ? this.firstSeat % order.length : 0;
    this.schedule = [...order.slice(k), ...order.slice(0, k)].filter((id) => {
      const p = s.players.get(id);
      return !!p && !p.ghost;
    });
    s.turnsPerRound = this.schedule.length;
    s.turnInRound = 0;
    this.roundStartKasa.clear();
    for (const id of s.turnOrder) {
      const p = s.players.get(id);
      if (p) this.roundStartKasa.set(id, p.kasa);
    }
    s.finalTable = s.settings.mode === "classic" && s.round === s.totalRounds;
    this.finalLinePending = s.finalTable;
    this.beginTurn();
  }

  private beginTurn(): void {
    const s = this.state;
    const id = this.schedule[s.turnInRound] ?? "";
    const p = s.players.get(id);
    if (!p || p.ghost) return this.advanceTurn();

    this.resetTurn();
    this.turnCount++;
    s.activeId = id;
    const trapped = p.trapped;
    p.trapped = false;
    s.sirenLevel = trapped ? TRAP_LEVEL : 0;
    s.lawyers = p.lawyerNext ? 1 : 0;
    p.lawyerNext = false;
    s.curseArmed = p.cursed;
    s.raidChance = raidChance(s.sirenLevel, s.floorBonus);
    s.bets.clear();
    this.betsOpen = p.connected && this.anyoneCanBet();

    s.phase = "betting";
    this.setTimer(this.betsOpen ? (s.round <= 1 ? this.T.betWindowFirst : this.T.betWindow) : this.T.turnIntro);
    this.broadcast(MSG.TURN_START, {
      playerId: id,
      round: s.round,
      turnInRound: s.turnInRound,
      sirenLevel: s.sirenLevel,
      trapped,
      cursed: s.curseArmed,
      lawyers: s.lawyers,
      finalTable: s.finalTable,
      betsOpen: this.betsOpen,
    } satisfies TurnStartMsg);
    this.turnStartLine(p, trapped);
  }

  /**
   * Cemil Abi at turn start, only now and then: the SON MASA line on its first turn, then turnStart / betsOpen
   * (alternating) on the match's first turn, a special turn (trapped, cursed, lawyer) and every TURN_LINE_EVERY turns.
   */
  private turnStartLine(p: PlayerState, trapped: boolean): void {
    const s = this.state;
    if (this.finalLinePending) {
      this.finalLinePending = false;
      return this.announce("finalTable");
    }
    if (!p.connected) return;
    const special = trapped || s.curseArmed || s.lawyers > 0;
    if (this.turnCount !== 1 && !special && this.turnCount % TURN_LINE_EVERY !== 0) return;
    const bets = this.betsOpen && this.turnLines % 2 === 0;
    this.turnLines++;
    this.openedWithBets = bets;
    this.announce(bets ? "betsOpen" : "turnStart", p.id);
  }

  /** Clears everything that only lives for one turn. */
  private resetTurn(): void {
    const s = this.state;
    s.sirenLevel = 0;
    s.raidChance = 0;
    s.turnPot = 0;
    s.row.clear();
    s.marketDone.clear();
    this.marketBuyers = [];
    this.marketChoice.clear();
    s.flips = 0;
    s.lawyers = 0;
    s.curseArmed = false;
    s.betsLocked = false;
    s.pendingCard = "";
    s.wheelSlice = "";
    s.busy = false;
    const c = s.lastCard;
    c.flipNo = 0;
    c.id = "";
    c.rarity = "";
    c.value = 0;
    c.targetId = "";
    this.betsOpen = false;
    this.betDone.clear();
    this.flipQueued = false;
    this.openedWithBets = false;
    this.forcedTarget = "";
    this.outcome = { raided: false, raidFlip: 0 };
    this.refundBets = false;
    this.timeLowSaid = false;
    this.sirenSaid = 0;
    this.sirenPending = 0;
    this.chosenTarget = "";
    this.wheelStage = "spin";
    this.wheelSpin = 0;
    this.wheelAgain = false;
  }

  /** Bets close: the first card is mandatory and gets the longer FIRST_CARD_SEC timer (§4: the decision timer runs after each card). */
  private endBetting(): void {
    const s = this.state;
    const p = s.players.get(s.activeId);
    if (!p || !p.connected) return this.skipTurn();
    s.phase = "flipping";
    this.setTimer(this.T.firstCard ?? Math.max(s.settings.decisionSec, FIRST_CARD_SEC));
    if (this.flipQueued) {
      this.flipQueued = false;
      this.flip();
    }
  }

  private startDecision(): void {
    this.setTimer(this.T.decision ?? this.state.settings.decisionSec);
  }

  private tickDecision(over: boolean): void {
    const s = this.state;
    if (s.busy) return;
    const p = s.players.get(s.activeId);
    const left = this.timerTotal - this.t;
    // "Karar ver!" only once there is something to decide, and only for people (bots never stall).
    if (!this.timeLowSaid && s.flips > 0 && p?.connected && !p.bot && this.timerTotal > this.T.timeLow && left <= this.T.timeLow) {
      this.timeLowSaid = true;
      this.announce("timeLow", s.activeId);
    }
    if (!over) return;
    if (s.flips > 0) return this.cash(true);
    // No card yet: Cemil Abi deals the first one for a player who is still here, a dropped player is skipped.
    if (p?.connected) this.flip();
    else this.skipTurn();
  }

  /** Next turn, round end, or match end. */
  private advanceTurn(): void {
    const s = this.state;
    s.turnInRound += 1;
    if (s.turnInRound >= this.schedule.length) this.endRound();
    else this.beginTurn();
  }

  private endRound(): void {
    const s = this.state;
    const classic = s.settings.mode === "classic";
    // A ghost's debts stop growing while they are in the river.
    const interest = this.loans.interest((id) => !!s.players.get(id)?.ghost);
    if (!classic) s.floorBonus = Math.round((s.floorBonus + ROYALE_FLOOR_STEP) * 1000) / 1000;
    const last = s.round >= s.totalRounds;
    const pauseSec = last ? 0 : this.T.roundSummary;
    this.broadcast(MSG.ROUND_END, {
      round: s.round,
      interest,
      floorBonus: s.floorBonus,
      finalTableNext: classic && !last && s.round + 1 === s.totalRounds,
      standings: this.roundStandings(),
      pauseSec,
    } satisfies RoundEndMsg);
    this.updateTaslik();
    if (last) this.endMatch();
    else this.busyFor(pauseSec, () => this.beginRound());
  }

  /** Match players richest first (ghosts last), with their kasa change since the round began. */
  private roundStandings(): RoundEndMsg["standings"] {
    const s = this.state;
    return [...s.turnOrder]
      .map((id) => s.players.get(id))
      .filter((p): p is PlayerState => !!p && !p.spectator)
      .sort((a, b) => Number(a.ghost) - Number(b.ghost) || b.kasa - a.kasa || a.seat - b.seat)
      .map((p) => ({ playerId: p.id, kasa: p.kasa, delta: p.kasa - (this.roundStartKasa.get(p.id) ?? p.kasa) }));
  }

  // ======================================================================= flips
  /** FLIP by the active player. During the bet window it is queued and happens the moment bets close. */
  private actFlip(id: string): boolean {
    const s = this.state;
    if (id !== s.activeId || !this.isConnected(id)) return false;
    if (s.phase === "betting" && s.flips === 0) {
      this.flipQueued = true;
      return true;
    }
    if (s.phase !== "flipping" || s.busy) return false;
    this.flip();
    return true;
  }

  /** KASALA! by the active player: only after the first card. */
  private actCash(id: string): boolean {
    const s = this.state;
    if (s.phase !== "flipping" || s.busy || id !== s.activeId) return false;
    if (s.flips === 0) {
      this.tell(id, say.flipFirst());
      return false;
    }
    this.cash(false);
    return true;
  }

  private flip(): void {
    const s = this.state;
    const p = s.players.get(s.activeId);
    if (!p) return;
    const first = s.flips === 0;
    if (first) s.betsLocked = true;

    const card: CardId = this.knobs.cards.shift() ?? rollFlip(this.rng, s.raidChance);
    const def = CARD_BY_ID[card];
    const flipNo = s.flips + 1;
    s.flips = flipNo;
    p.stats.maxFlips = Math.max(p.stats.maxFlips, flipNo);
    s.sirenLevel = sirenAfter(s.sirenLevel, card);
    s.raidChance = raidChance(s.sirenLevel, s.floorBonus);

    let value = 0;
    let curseHit = false;
    let saved = false;
    let needsTarget = false;
    let next: AfterFlip = "resume";
    let line: AnnouncerEvent | null = null;
    switch (def.kind) {
      case "money":
        if (s.curseArmed) {
          curseHit = true;
          s.curseArmed = false;
          p.cursed = false;
          line = "curseHit";
        } else {
          value = moneyValue(card, s.finalTable);
          this.addToRow(flipNo, card, value);
          // Small change (Bozukluk / Tomar) isn't worth a line; Çanta and Külçe are.
          if (card === "canta" || card === "kulce") line = card;
        }
        break;
      case "multiplier":
        value = s.turnPot;
        this.scaleRow(def.value);
        line = "aklama";
        break;
      case "protection":
        if (card === "avukat") s.lawyers += 1;
        line = card as AnnouncerEvent;
        break;
      case "raid":
        if (s.lawyers > 0) {
          s.lawyers -= 1;
          saved = true;
          next = "saved";
          line = "lawyerSaved";
        } else {
          next = "raid";
        }
        break;
      case "attack":
        if (def.target === "pick") {
          if (this.targetCandidates().length) {
            needsTarget = true;
            next = "target";
          }
        } else {
          next = "attack";
        }
        break;
      case "special":
        next = "wheel";
        break;
    }

    const lc = s.lastCard;
    lc.flipNo = flipNo;
    lc.id = card;
    lc.rarity = def.rarity;
    lc.value = value;
    lc.targetId = "";
    this.broadcast(MSG.CARD, {
      playerId: p.id,
      flipNo,
      card,
      rarity: def.rarity,
      value,
      pot: s.turnPot,
      sirenLevel: s.sirenLevel,
      raidChance: s.raidChance,
      curseHit,
      saved,
      needsTarget,
    } satisfies CardMsg);
    if (next !== "raid") this.flipLine(first && s.bets.size > 0 && this.openedWithBets, line, next === "target" || next === "attack" || next === "wheel");
    // Bot watchers heckle only a turn that really goes on: never over a raid, the wheel or an attack's choreography.
    if (next === "resume" || next === "saved") this.bots.onCard(p.id, flipNo);

    switch (next) {
      case "raid":
        this.busyFor(this.T.flipAnim, () => this.raid(flipNo));
        break;
      case "saved":
        this.startDecision();
        this.busyFor(this.T.lawyerAnim);
        break;
      case "target": {
        s.phase = "targeting";
        s.pendingCard = card;
        this.chosenTarget = "";
        // Exactly one legal target (every 2-player game): no picking, it resolves ~1 s after the card landed.
        const cands = this.targetCandidates();
        this.forcedTarget = cands.length === 1 ? cands[0]! : "";
        this.setTimer(this.forcedTarget ? this.T.autoTarget : this.T.target);
        this.busyFor(this.T.flipAnim, () => {
          if (this.chosenTarget && this.state.phase === "targeting") this.resolveTarget(this.chosenTarget, false);
        });
        break;
      }
      case "attack":
        this.startDecision();
        this.busyFor(this.T.flipAnim, () => this.instantAttack(card));
        break;
      case "wheel":
        this.busyFor(this.T.flipAnim, () => this.startWheel(1));
        break;
      default:
        this.startDecision();
        this.busyFor(this.T.flipAnim);
        break;
    }
  }

  /**
   * At most one Cemil Abi line per flip: an attack / protection / curse / lawyer line beats a crossed siren tier,
   * which beats a money line (çanta / külçe / aklama), which beats "bets closed" (only after a betsOpen opening),
   * which beats the mid siren tier. `laterLine`: the card speaks for itself a moment later (attack / wheel), so
   * nothing is said now; a crossed tier stays pending and plays on a later flip of the same turn.
   */
  private flipLine(betsClosed: boolean, cardLine: AnnouncerEvent | null, laterLine: boolean): void {
    const s = this.state;
    if (s.raidChance >= SIREN_CRITICAL_CHANCE && this.sirenSaid < 2) this.sirenPending = 2;
    else if (s.raidChance >= SIREN_MID_CHANCE && this.sirenSaid < 1) this.sirenPending = Math.max(this.sirenPending, 1);
    if (laterLine) return;
    const id = s.activeId;
    const moneyish = cardLine === "aklama" || (cardLine !== null && CARD_BY_ID[cardLine as CardId]?.kind === "money");
    if (cardLine && !moneyish) return this.announce(cardLine, id);
    if (this.sirenPending === 2) {
      this.sirenSaid = 2;
      this.sirenPending = 0;
      return this.announce("sirenCritical", id);
    }
    if (cardLine) return this.announce(cardLine, id);
    if (betsClosed) return this.announce("betsClosed");
    if (this.sirenPending === 1) {
      this.sirenSaid = 1;
      this.sirenPending = 0;
      this.announce("sirenMid", id);
    }
  }

  // ===================================================================== attacks
  /** Other non-ghost, non-spectator match players (connected or not). */
  private targetCandidates(): string[] {
    const s = this.state;
    return [...s.turnOrder].filter((id) => {
      const p = s.players.get(id);
      return !!p && id !== s.activeId && !p.ghost && !p.spectator;
    });
  }

  /** TARGET by the active player (accepted during the flip lock, applied when it ends). */
  private actTarget(id: string, targetId: unknown): boolean {
    const s = this.state;
    if (s.phase !== "targeting" || id !== s.activeId || typeof targetId !== "string") return false;
    if (!this.targetCandidates().includes(targetId)) return false;
    if (s.busy) this.chosenTarget = targetId;
    else this.resolveTarget(targetId, false);
    return true;
  }

  /** Targeting timer ran out: the only legal target, or a random one (preferring targets the card can hurt). */
  private targetTimeout(): void {
    if (this.forcedTarget) return this.resolveTarget(this.forcedTarget, false);
    const s = this.state;
    const all = this.targetCandidates();
    const useful = all.filter((id) => {
      const p = s.players.get(id);
      return !!p && p.connected && (s.pendingCard !== "harac" || p.kasa > 0);
    });
    this.resolveTarget(randomTarget(this.rng, useful.length ? useful : all), true);
  }

  /** Haraç / Lanet / Takas on the chosen (or random) target, then back to flipping. */
  private resolveTarget(targetId: string, random: boolean): void {
    const s = this.state;
    if (s.phase !== "targeting") return;
    const card = s.pendingCard;
    const me = s.players.get(s.activeId);
    const target = s.players.get(targetId);
    this.forcedTarget = "";
    this.chosenTarget = "";
    s.pendingCard = "";
    s.phase = "flipping";
    this.startDecision();
    if (!me || !target || !card) return void this.busyFor(this.T.attackAnim);

    let amount = 0;
    if (card === "harac") {
      amount = Math.min(target.kasa, haracAmount(target.kasa));
      target.kasa -= amount;
      this.addToRow(s.lastCard.flipNo, "harac", amount);
    } else if (card === "lanet") {
      target.cursed = true;
    } else if (card === "takas") {
      const mine = me.kasa;
      me.kasa = target.kasa;
      target.kasa = mine;
      amount = me.kasa - mine;
    }
    s.lastCard.targetId = targetId;
    this.broadcast(MSG.ATTACK, { card, fromId: me.id, targetId, amount, payers: [], pot: s.turnPot, random } satisfies AttackMsg);
    this.announce(card as AnnouncerEvent, me.id);
    this.busyFor(this.T.attackAnim);
    this.moneyChanged();
  }

  /** Haraç Turu / Tuzak, right after the card's flip animation. */
  private instantAttack(card: CardId): void {
    const s = this.state;
    if (s.phase !== "flipping") return;
    const id = s.activeId;
    if (card === "tuzak") {
      // The next player who will actually play a turn (a dropped player's turn is skipped, the trap would be wasted).
      const order = [...s.turnOrder];
      const eligible = (x: string, strict: boolean) => {
        const p = s.players.get(x);
        return !!p && !p.ghost && !p.spectator && (!strict || p.connected);
      };
      const targetId = nextInOrder(order, id, (x) => eligible(x, true)) || nextInOrder(order, id, (x) => eligible(x, false));
      const target = s.players.get(targetId);
      if (target) target.trapped = true;
      s.lastCard.targetId = targetId;
      this.broadcast(MSG.ATTACK, { card, fromId: id, targetId, amount: 0, payers: [], pot: s.turnPot, random: false } satisfies AttackMsg);
      this.announce("tuzak", id);
    } else {
      const others = this.inGame().filter((p) => p.id !== id);
      const payers = haracTuruPayments(others.map((p) => ({ id: p.id, kasa: p.kasa }))).filter((x) => x.amount > 0);
      let total = 0;
      for (const pay of payers) {
        const p = s.players.get(pay.playerId);
        if (!p) continue;
        p.kasa -= pay.amount;
        total += pay.amount;
      }
      this.addToRow(s.lastCard.flipNo, "haracTuru", total);
      this.broadcast(MSG.ATTACK, { card, fromId: id, targetId: "", amount: total, payers, pot: s.turnPot, random: false } satisfies AttackMsg);
      this.announce("haracTuru", id);
    }
    this.startDecision();
    this.busyFor(this.T.attackAnim);
    this.moneyChanged();
  }

  // ======================================================================= wheel
  private startWheel(spin: number): void {
    const s = this.state;
    if (s.phase !== "flipping" && s.phase !== "wheel") return;
    s.phase = "wheel";
    s.wheelSlice = "";
    this.wheelSpin = spin;
    this.wheelStage = "spin";
    this.wheelNext = this.knobs.wheel.shift() ?? rollWheel(this.rng, spin < MAX_WHEEL_SPINS);
    const descendMs = spin === 1 ? Math.round(this.T.wheelDescend * 1000) : 0;
    const spinMs = Math.round((this.T.wheelSpinMin + this.fxRng() * (this.T.wheelSpinMax - this.T.wheelSpinMin)) * 1000);
    this.setTimer((descendMs + spinMs) / 1000);
    this.broadcast(MSG.WHEEL_START, {
      playerId: s.activeId,
      slice: this.wheelNext,
      spin,
      descendMs,
      spinMs,
      turns: 4 + randInt(this.fxRng, 4),
    } satisfies WheelStartMsg);
    if (spin === 1) this.announce("wheel", s.activeId);
  }

  private landWheel(): void {
    const s = this.state;
    const slice = this.wheelNext;
    const id = s.activeId;
    const players = this.inGame();
    const kasas: Record<string, number> = {};
    for (const p of players) kasas[p.id] = p.kasa;
    const out = applyWheel(this.rng, {
      slice,
      activeId: id,
      order: players.map((p) => p.id),
      kasas,
      kumbara: s.kumbara,
      pot: s.turnPot,
    });
    for (const p of players) p.kasa = out.kasas[p.id] ?? p.kasa;
    s.kumbara = out.kumbara;
    if (slice === "x10") this.scaleRow(WHEEL_POT_MULT);
    if (out.lawyer) {
      s.lawyers += 1;
      const me = s.players.get(id);
      if (me) me.lawyerNext = true;
    }
    s.wheelSlice = slice;
    this.wheelAgain = out.again;
    this.wheelStage = "hold";
    this.setTimer(this.T.wheelHold);
    this.broadcast(MSG.WHEEL_RESULT, {
      playerId: id,
      slice,
      deltas: out.deltas,
      kumbaraDelta: out.kumbaraDelta,
      pot: s.turnPot,
      again: out.again,
    } satisfies WheelResultMsg);
    this.announce(`wheel_${slice}` as AnnouncerEvent, id);
    this.moneyChanged();
  }

  private afterWheelHold(): void {
    if (this.wheelAgain) return this.startWheel(this.wheelSpin + 1);
    const s = this.state;
    s.wheelSlice = "";
    s.phase = "flipping";
    this.startDecision();
    this.busyFor(this.T.wheelAscend);
  }

  // ===================================================================== results
  /** KASALA! (auto = the decision timer ran out): the best picksFor(flips) row cards go to the kasa. */
  private cash(auto: boolean): void {
    const s = this.state;
    const p = s.players.get(s.activeId);
    if (!p) return;
    const flips = s.flips;
    const taken = bestPicks([...s.row], picksFor(flips));
    let pot = 0;
    for (const c of s.row) {
      if (!taken.includes(c.flipNo)) continue;
      c.ownerId = p.id;
      pot += c.value;
    }
    let kept = pot;
    let cut: CashedMsg["taslikCut"] = [];
    if (pot > 0 && isTaslik(p.kasa, this.loans.totalOwed(p.id))) {
      const r = this.loans.applyTaslikCut(p.id, pot);
      kept = r.kept;
      cut = r.cut;
    }
    p.kasa += kept;
    s.turnPot = rowValue([...s.row]);
    const rowLeft = [...s.row].filter((c) => !c.ownerId).length;
    if (pot > 0) {
      p.stats.cashes += 1;
      p.stats.biggestCash = Math.max(p.stats.biggestCash, pot);
    }
    if (isEarlyCash(flips, auto)) p.stats.earlyCashes += 1;
    this.outcome = { raided: false, raidFlip: 0 };
    this.refundBets = auto && !p.connected;
    this.clearLock();
    s.phase = "result";
    const resultSec = pot >= BIG_CASH ? this.T.cashResultBig : this.T.cashResult;
    this.setTimer(resultSec);
    this.broadcast(MSG.CASHED, { playerId: p.id, pot, flips, kept, taslikCut: cut, taken, rowLeft, auto, skipped: false, resultSec } satisfies CashedMsg);
    // Big hauls always get a line; a small one only when it was a timid early KASALA (that's what the lines tease).
    if (pot >= BIG_CASH) this.announce("cashBig", p.id);
    else if (pot > 0 && pot < SMALL_CASH && flips <= EARLY_CASH_FLIPS) this.announce("cashSmall", p.id);
    this.bots.noteTurnEnd(p.id, flips);
    this.bots.onCashed(p.id, pot);
    this.moneyChanged();
  }

  /** The active player isn't connected: the turn passes with 0 cards, bets are refunded. */
  private skipTurn(): void {
    const s = this.state;
    this.clearLock();
    this.outcome = { raided: false, raidFlip: 0 };
    this.refundBets = true;
    s.phase = "result";
    const resultSec = this.T.skipResult;
    this.setTimer(resultSec);
    this.broadcast(MSG.CASHED, {
      playerId: s.activeId,
      pot: 0,
      flips: 0,
      kept: 0,
      taslikCut: [],
      taken: [],
      rowLeft: 0,
      auto: true,
      skipped: true,
      resultSec,
    } satisfies CashedMsg);
  }

  /** POLİS BASKINI: the pot and a bribe go to the kumbara. */
  private raid(flipNo: number): void {
    const s = this.state;
    if (s.phase !== "flipping") return;
    const p = s.players.get(s.activeId);
    if (!p) return;
    const potLost = Math.max(0, s.turnPot);
    s.turnPot = 0;
    s.row.clear();
    const bribe = raidBribe(s.settings.mode, p.kasa, s.round, s.finalTable);
    p.kasa -= bribe;
    s.kumbara += potLost + bribe;
    // Big, late, or this player's first raid of the match → the full door sequence; else a quick raid at the seat.
    const long = potLost + bribe >= LONG_RAID_LOSS || flipNo >= LONG_RAID_FLIP || p.stats.raids === 0;
    p.stats.raids += 1;
    this.outcome = { raided: true, raidFlip: flipNo };
    this.refundBets = false;
    s.phase = "result";
    const resultSec = long ? this.T.raidResult : this.T.raidResultShort;
    this.setTimer(resultSec);
    this.broadcast(MSG.RAIDED, {
      playerId: p.id,
      flipNo,
      potLost,
      bribe,
      anim: pick(this.fxRng, RAID_ANIMS),
      resultSec,
      long,
    } satisfies RaidedMsg);
    this.announce(flipNo === 1 ? "raidFirst" : flipNo >= 4 ? "raidLate" : "raid", p.id);
    this.bots.noteTurnEnd(p.id, flipNo);
    this.bots.onRaided(p.id);
    this.moneyChanged();
  }

  private afterResult(): void {
    const s = this.state;
    if (!this.outcome.raided && [...s.row].some((c) => !c.ownerId)) return this.openMarket();
    this.finishTurn();
  }

  /** The turn's money is settled (KASALA / raid / market): side bets, then the end of the turn. */
  private finishTurn(): void {
    const s = this.state;
    if (s.bets.size === 0) return this.afterTurn();
    if (this.refundBets) {
      this.refundAllBets();
      this.notice(say.betsRefunded());
      this.moneyChanged();
      return this.afterTurn();
    }
    this.settle();
  }

  // ================================================================ vitrin & pazar
  /** Money that lands in the vitrin as one row card (nothing for 0$). */
  private addToRow(flipNo: number, id: CardId, value: number): void {
    const s = this.state;
    if (value > 0) {
      const c = new RowCardState();
      c.flipNo = flipNo;
      c.id = id;
      c.value = value;
      s.row.push(c);
    }
    s.turnPot = rowValue([...s.row]);
  }

  /** Kara Para Aklama ×2 / the wheel's POT ×10: every row card on the table is worth `mult` times more. */
  private scaleRow(mult: number): void {
    const s = this.state;
    for (const c of s.row) if (!c.ownerId) c.value = Math.floor(c.value * mult);
    s.turnPot = rowValue([...s.row]);
  }

  /** Row cards still on the table, in flip order. */
  private rowLeft(): RowCardState[] {
    return [...this.state.row].filter((c) => !c.ownerId);
  }

  /** Pazar after a KASALA with cards left: buyers are the others still in the game who can pay for something. */
  private openMarket(): void {
    const s = this.state;
    const left = this.rowLeft();
    const cheapest = Math.min(...left.map((c) => marketFee(c.value)));
    const order = [...s.turnOrder];
    const start = Math.max(0, order.indexOf(s.activeId));
    const after = [...order.slice(start + 1), ...order.slice(0, start)];
    this.marketBuyers = after.filter((id) => {
      const p = s.players.get(id);
      return !!p && !p.ghost && !p.spectator && (p.connected || p.bot) && p.kasa >= cheapest;
    });
    this.marketChoice.clear();
    s.marketDone.clear();
    if (!this.marketBuyers.length) return this.closeMarket();
    s.phase = "market";
    this.setTimer(this.T.market);
  }

  /** MARKET: a row card (flipNo) or 0 = pas. Changeable until the market closes; secret until then. */
  private actMarket(id: string, flipNo: unknown): boolean {
    const s = this.state;
    if (s.phase !== "market" || s.busy || !this.marketBuyers.includes(id)) return false;
    if (typeof flipNo !== "number" || !Number.isInteger(flipNo) || flipNo < 0) return false;
    if (flipNo > 0) {
      const card = this.rowLeft().find((c) => c.flipNo === flipNo);
      const p = s.players.get(id);
      if (!card || !p) return false;
      if (p.kasa < marketFee(card.value)) {
        this.tell(id, say.marketBroke());
        return false;
      }
    }
    this.marketChoice.set(id, flipNo);
    if (s.marketDone.indexOf(id) < 0) s.marketDone.push(id);
    this.maybeCloseMarket();
    return true;
  }

  /** Every buyer who can still answer has chosen: close shortly after the last answer. */
  private maybeCloseMarket(): void {
    const s = this.state;
    if (s.phase !== "market" || s.busy || this.timerTotal <= 0) return;
    const waiting = this.marketBuyers.some((id) => {
      const p = s.players.get(id);
      return !!p && (p.connected || p.bot) && !this.marketChoice.has(id);
    });
    if (waiting) return;
    this.t = Math.max(this.t, this.timerTotal - this.T.marketCloseGrace);
  }

  /** The reveal: sales, clashes, the seller's fees, leftovers to the kumbara. Then the bets / the next turn. */
  private closeMarket(): void {
    const s = this.state;
    const seller = s.players.get(s.activeId);
    const left = this.rowLeft();
    const buyers = this.marketBuyers
      .map((id) => s.players.get(id))
      .filter((p): p is PlayerState => !!p)
      .map((p) => ({ id: p.id, kasa: p.kasa, choice: this.marketChoice.get(p.id) ?? 0 }));
    const out = resolveMarket(left, buyers);
    let fees = 0;
    const sales: MarketResultMsg["sales"] = [];
    for (const sale of out.sales) {
      const buyer = s.players.get(sale.buyerId);
      const card = left.find((c) => c.flipNo === sale.flipNo);
      if (!buyer || !card) continue;
      buyer.kasa += sale.value - sale.fee;
      card.ownerId = buyer.id;
      fees += sale.fee;
      sales.push({ ...sale, card: card.id });
    }
    let feesKept = fees;
    let cut: MarketResultMsg["taslikCut"] = [];
    if (seller && fees > 0) {
      if (isTaslik(seller.kasa, this.loans.totalOwed(seller.id))) {
        const r = this.loans.applyTaslikCut(seller.id, fees);
        feesKept = r.kept;
        cut = r.cut;
      }
      seller.kasa += feesKept;
    } else if (fees > 0) {
      s.kumbara += fees;
    }
    const leftovers = this.rowLeft().map((c) => ({ flipNo: c.flipNo, value: c.value }));
    const toKumbara = leftovers.reduce((n, c) => n + c.value, 0);
    s.kumbara += toKumbara;
    const rows = [...s.row];
    for (let i = rows.length - 1; i >= 0; i--) if (!rows[i]!.ownerId) s.row.splice(i, 1);
    s.turnPot = 0;
    this.broadcast(MSG.MARKET_RESULT, {
      sellerId: s.activeId,
      sales,
      clashes: out.clashes,
      leftovers,
      toKumbara,
      feesKept,
      taslikCut: cut,
    } satisfies MarketResultMsg);
    this.moneyChanged();
    this.busyFor(this.T.marketReveal, () => this.finishTurn());
  }

  private refundAllBets(): void {
    const s = this.state;
    s.bets.forEach((b) => {
      const p = s.players.get(b.playerId);
      if (p && !b.ghost) p.kasa += b.amount;
    });
    s.bets.clear();
  }

  /** Side bet payout (§8). */
  private settle(): void {
    const s = this.state;
    const bets = [...s.bets.values()].map((b) => ({ playerId: b.playerId, box: b.box, amount: b.amount, ghost: b.ghost }));
    const r = settleBets(bets, this.outcome, s.finalTable);
    const returners: PlayerState[] = [];
    for (const res of r.results) {
      const p = s.players.get(res.playerId);
      if (!p) continue;
      if (res.ghost) {
        if (res.won && p.ghost) {
          const g = ghostAfterWin(p.ghostWins, p.ghostReturned);
          p.ghostWins = g.ghostWins;
          if (g.returns) returners.push(p);
        }
        continue;
      }
      p.kasa += res.delta;
      if (res.won) {
        p.stats.betsWon += 1;
        p.stats.betProfit += res.delta - res.amount;
      } else {
        p.stats.betsLost += 1;
        p.stats.betProfit -= res.amount;
      }
    }
    const active = s.players.get(s.activeId);
    let toKumbara = r.toKumbara;
    if (active) active.kasa += r.houseCut;
    else toKumbara += r.houseCut;
    s.kumbara += toKumbara;
    s.bets.clear();
    this.broadcast(MSG.BETS_SETTLED, {
      activeId: s.activeId,
      raided: this.outcome.raided,
      raidFlip: this.outcome.raidFlip,
      results: r.results,
      houseCut: active ? r.houseCut : 0,
      toKumbara,
    } satisfies BetsSettledMsg);

    for (const p of returners) {
      p.ghost = false;
      p.ghostReturned = true;
      p.kasa = Math.max(0, p.kasa) + GHOST_RETURN_KASA;
      this.broadcast(MSG.GHOST_RETURN, { playerId: p.id, kasa: p.kasa } satisfies GhostReturnMsg);
    }
    // Only the telling settlements get a line (most bettors called the raid / most "Kasalar" bets lost).
    const line = betsLineEvent(r.results);
    if (returners.length) this.announce("ghostReturn", returners[0]!.id);
    else if (line !== "betsSettled") this.announce(line, s.activeId);
    this.bots.onSettled(r.results);

    s.phase = "settle";
    this.setTimer(this.T.settle);
    this.moneyChanged();
  }

  /** End of a turn: one-turn effects cleared, then Son Şans / next turn / round end / match end. */
  private afterTurn(): void {
    const s = this.state;
    const p = s.players.get(s.activeId);
    if (p) p.cursed = false;
    s.bets.clear();
    this.resetTurn();
    this.clearLock();
    this.updateTaslik();
    this.continueFlow();
  }

  private continueFlow(): void {
    const s = this.state;
    if (this.checkTooFew()) return;
    if (s.settings.mode === "royale") {
      const broke = [...s.turnOrder].find((id) => {
        const p = s.players.get(id);
        return !!p && !p.ghost && !p.spectator && p.kasa <= 0;
      });
      if (broke) return this.startLastChance(broke);
      if (this.inGame().length <= 1) return this.endMatch();
    }
    this.advanceTurn();
  }

  // =================================================================== son şans
  private startLastChance(id: string): void {
    const s = this.state;
    s.activeId = "";
    s.lastChanceId = id;
    if (!s.settings.loans) return this.eliminate(id);
    s.phase = "lastChance";
    this.setTimer(this.lastChanceSec(id));
    this.broadcast(MSG.LAST_CHANCE, { playerId: id } satisfies LastChanceMsg);
    this.announce("lastChance", id);
  }

  /**
   * Son Şans length. Nobody waits 15 s for a loan that can't happen: short when only one player can lend, and
   * just Cemil Abi's line when nobody can, or when the broke player is disconnected (no offer can reach them,
   * they can't ask, bots don't throw them a rope).
   */
  private lastChanceSec(brokeId: string): number {
    const lenders = this.state.players.get(brokeId)?.connected ? this.possibleLenders(brokeId) : 0;
    if (lenders === 0) return this.T.lastChanceNoLender;
    return lenders === 1 ? Math.min(this.T.lastChance, this.T.lastChanceOneLender) : this.T.lastChance;
  }

  /**
   * The broke player's connection changed during Son Şans (dropped, came back, or a bot took the seat over):
   * a drop cuts the wait to the no-lender length, a return gives back the full length counted from the start.
   */
  private lastChanceConnection(id: string): void {
    const s = this.state;
    if (s.phase !== "lastChance" || s.lastChanceId !== id) return;
    const want = this.lastChanceSec(id);
    this.timerTotal = s.players.get(id)?.connected ? Math.max(this.timerTotal, want) : Math.min(this.timerTotal, this.t + want);
    this.syncTimer();
  }

  /** Players who could lend the broke player at least LOAN_MIN right now. */
  private possibleLenders(brokeId: string): number {
    return this.inGame().filter((p) => p.id !== brokeId && p.connected && loanLimit(p.kasa) >= LOAN_MIN).length;
  }

  private saved(lenderId: string): void {
    const s = this.state;
    const id = s.lastChanceId;
    s.lastChanceId = "";
    this.broadcast(MSG.SAVED, { playerId: id, lenderId } satisfies SavedMsg);
    this.continueFlow();
  }

  private lastChanceTimeout(): void {
    const p = this.state.players.get(this.state.lastChanceId);
    if (p && p.kasa > 0) return this.saved("");
    this.eliminate(this.state.lastChanceId);
  }

  /** Cement shoes: the player becomes a ghost. */
  private eliminate(id: string): void {
    const s = this.state;
    const p = s.players.get(id);
    if (p) {
      p.ghost = true;
      p.ghostWins = 0;
      p.kasa = Math.max(0, p.kasa);
      p.cursed = false;
      p.trapped = false;
      p.lawyerNext = false;
    }
    this.elimIndex.set(id, ++this.elimSeq);
    this.schedule = this.schedule.filter((x, i) => i <= s.turnInRound || x !== id);
    s.turnsPerRound = this.schedule.length;
    s.bets.delete(id);
    this.loans.dropOffersOf(id);
    // Money owed to someone in the river would just leave the game: those debts are written off.
    if (p && this.loans.forgiveDebtsTo(id) > 0) this.notice(say.debtsForgiven(p.nickname));
    s.lastChanceId = id;
    s.phase = "elimination";
    this.setTimer(this.T.elimination);
    this.broadcast(MSG.ELIMINATED, { playerId: id, remaining: this.inGame().length } satisfies EliminatedMsg);
    this.announce("eliminated", id);
    this.updateTaslik();
  }

  private afterElimination(): void {
    this.state.lastChanceId = "";
    this.continueFlow();
  }

  // ======================================================================= bets
  /**
   * BET (§8). amount 0 cancels a bet, or is PAS when there is none yet (box ignored). Once every eligible bettor
   * has bet or passed, the window closes T.betCloseGrace later.
   */
  private actBet(id: string, box: unknown, amount: unknown): boolean {
    const s = this.state;
    const p = s.players.get(id);
    if (!p || s.phase !== "betting" || !this.betsOpen || !this.mayBet(id)) return false;
    if (typeof amount !== "number" || !Number.isFinite(amount)) return false;
    const old = s.bets.get(id);
    const refund = old && !old.ghost ? old.amount : 0;
    if (amount === 0) {
      if (old) {
        // Taking the chip back: undecided again.
        p.kasa += refund;
        s.bets.delete(id);
        this.betDone.delete(id);
        this.moneyChanged();
      } else {
        this.betDone.add(id);
        this.maybeCloseBets();
      }
      return true;
    }
    if (typeof box !== "string" || !(box in BET_BOX_BY_ID)) return false;
    if (!p.ghost && (!(CHIP_AMOUNTS as readonly number[]).includes(amount) || amount > p.kasa + refund)) return false;
    if (old) {
      p.kasa += refund;
      s.bets.delete(id);
    }
    const b = new BetState();
    b.playerId = id;
    b.box = box as BetBox;
    b.ghost = p.ghost;
    b.amount = p.ghost ? GHOST_CHIP : amount;
    if (!p.ghost) p.kasa -= b.amount;
    s.bets.set(id, b);
    this.betDone.add(id);
    this.moneyChanged();
    this.maybeCloseBets();
    return true;
  }

  /** May this player take part in this turn's side bets at all (ignoring their kasa)? */
  private mayBet(id: string): boolean {
    const s = this.state;
    const p = s.players.get(id);
    if (!p || id === s.activeId || p.spectator || !p.connected || !s.turnOrder.includes(id)) return false;
    // Battle Royale ghosts keep their free chip even with side bets off: it is their only way back (§10).
    return s.settings.sideBets || (p.ghost && s.settings.mode === "royale");
  }

  /** An eligible bettor right now: may bet and can afford the smallest chip (ghosts bet for free). */
  private canBet(id: string): boolean {
    const p = this.state.players.get(id);
    return !!p && this.mayBet(id) && (p.ghost || p.kasa >= CHIP_AMOUNTS[0]);
  }

  private anyoneCanBet(): boolean {
    return [...this.state.turnOrder].some((id) => this.canBet(id));
  }

  /** Everyone who can bet has bet or passed: close the window shortly (never lengthens it). */
  private maybeCloseBets(): void {
    const s = this.state;
    if (s.phase !== "betting" || !this.betsOpen || this.timerTotal <= 0) return;
    if ([...s.turnOrder].some((id) => this.canBet(id) && !this.betDone.has(id))) return;
    this.t = Math.max(this.t, this.timerTotal - this.T.betCloseGrace);
  }

  // ======================================================================= money
  private loanHost(): LoanHost {
    return {
      state: this.state,
      canDeal: (id) => this.canDeal(id),
      isConnected: (id) => this.isConnected(id),
      broadcastLoan: (msg: LoanMsg) => this.broadcast(MSG.LOAN, msg),
      announce: (event, playerId) => this.announce(event, playerId),
      notify: (playerId, n) => this.clientOf(playerId)?.send(MSG.NOTICE, n),
      moneyMoved: (fromId, toId) => {
        this.moneyChanged();
        const s = this.state;
        if (s.phase === "lastChance" && toId === s.lastChanceId) {
          const p = s.players.get(toId);
          if (p && p.kasa > 0) this.saved(fromId);
        }
      },
    };
  }

  /** May lend / borrow right now: a match player who isn't a ghost, in a loan phase. */
  private canDeal(id: string): boolean {
    const s = this.state;
    const p = s.players.get(id);
    return LOAN_PHASES.has(s.phase) && !!p && !p.spectator && !p.ghost && s.turnOrder.includes(id);
  }

  private loansOpen(): boolean {
    const s = this.state;
    return s.settings.loans && LOAN_PHASES.has(s.phase);
  }

  /** LOAN_PROPOSE, rate-limited per player (every offer is a pop-up on every screen, §9). */
  private actLoanPropose(id: string, raw: unknown): void {
    if (!this.loansOpen() || !this.cooldownFree(this.lastLoanPropose, id, this.T.loanCooldown)) return;
    if (this.loans.propose(id, raw)) this.lastLoanPropose.set(id, Date.now());
  }

  private actLoanRespond(id: string, raw: unknown): void {
    if (this.loansOpen()) this.loans.respond(id, raw);
  }

  private actLoanRepay(id: string, raw: unknown): void {
    if (!this.loansOpen() || !this.cooldownFree(this.lastLoanRepay, id, this.T.loanCooldown / 2)) return;
    if (this.loans.repay(id, raw)) this.lastLoanRepay.set(id, Date.now());
  }

  /** After every money move: Taşlık flags. */
  private moneyChanged(): void {
    this.updateTaslik();
  }

  private updateTaslik(): void {
    const s = this.state;
    if (!IN_MATCH.has(s.phase)) return;
    for (const id of s.turnOrder) {
      const p = s.players.get(id);
      if (!p) continue;
      // A ghost has nothing to cash: no collar in the river.
      const on = !p.ghost && isTaslik(p.kasa, this.loans.totalOwed(id));
      if (on === p.taslik) continue;
      p.taslik = on;
      this.broadcast(MSG.TASLIK, { playerId: id, on } satisfies TaslikMsg);
      if (on) this.announce("taslik", id);
    }
  }

  // =================================================================== match end
  private endMatch(): void {
    const s = this.state;
    // The flow only ends a match between turns (leavers are taken over by bots). Should it ever happen mid-turn,
    // no money may vanish: the live pot is banked by its owner and open bets are refunded.
    if (s.turnPot > 0) {
      console.warn(`[kasala] match ended mid-turn in phase ${s.phase}; banking a ${s.turnPot}$ pot`);
      const owner = s.players.get(s.activeId);
      if (owner) owner.kasa += s.turnPot;
      else s.kumbara += s.turnPot;
      s.turnPot = 0;
    }
    this.clearLock();
    if (s.bets.size) this.refundAllBets();
    s.phase = "matchEnd";
    this.setTimer(0);
    s.activeId = "";
    s.lastChanceId = "";
    s.finalTable = false;
    this.resetTurn();

    const field = [...s.turnOrder].map((id) => s.players.get(id)).filter((p): p is PlayerState => !!p);
    const { collections, wiped } = this.loans.collect();
    for (const p of field) p.taslik = false;
    const st = standings(
      s.settings.mode,
      field.map((p) => ({ id: p.id, kasa: p.kasa, raids: p.stats.raids, seat: p.seat, ghost: p.ghost, elimIndex: this.elimIndex.get(p.id) ?? 0 })),
    );
    s.players.forEach((p) => (p.place = 0));
    for (const row of st) {
      const p = s.players.get(row.playerId);
      if (p) p.place = row.place;
    }
    const titles = shameTitles(
      field.map((p) => ({ id: p.id, place: p.place, stats: p.stats, karaListe: p.karaListe, wiped: wiped.get(p.id) ?? 0 })),
    );
    const msg: MatchEndMsg = { mode: s.settings.mode, collections, titles, standings: st, winnerId: st[0]?.playerId ?? "" };
    this.broadcast(MSG.MATCH_END, msg);
    this.announce("matchEnd");
    this.endScript = matchEndScript(msg, this.T.matchEndScale);
    this.endT = 0;
  }

  private tickEndScript(dt: number): void {
    if (!this.endScript.length) return;
    this.endT += dt;
    while (this.endScript.length && this.endScript[0]!.at <= this.endT) {
      const line = this.endScript.shift()!;
      this.announce(line.event, line.playerId);
    }
  }

  private onRematch(client: Client): void {
    const s = this.state;
    if (client.sessionId !== s.hostId || s.phase !== "matchEnd") return;
    this.endScript = [];
    for (const id of [...this.leavers]) this.removePlayer(id);
    this.leavers.clear();
    s.phase = "lobby";
    s.round = 0;
    s.totalRounds = 0;
    s.turnInRound = 0;
    s.turnsPerRound = 0;
    s.activeId = "";
    s.lastChanceId = "";
    s.kumbara = 0;
    s.floorBonus = 0;
    s.finalTable = false;
    s.turnOrder.clear();
    s.bets.clear();
    this.loans.clearAll();
    this.schedule = [];
    this.resetTurn();
    this.clearLock();
    this.setTimer(0);
    s.players.forEach((p) => {
      this.resetPlayer(p, START_KASA);
      p.spectator = false;
    });
    // Spectators sit down for the next match: bots give up seats so humans + bots fit the table.
    while (this.seatedCount() > MAX_PLAYERS && this.dropLastBot()) {
      /* keep dropping */
    }
    this.fixDuplicateLooks();
    this.compactSeats();
    this.notice(say.rematch());
  }

  // ===================================================================== social
  private actEmote(id: string, emote: unknown): boolean {
    if (!this.state.players.has(id) || typeof emote !== "string") return false;
    if (!EMOTES.some((e) => e.id === emote) || !this.cooldownOk(this.lastEmote, id)) return false;
    this.broadcast(MSG.EMOTED, { playerId: id, emote: emote as EmoteId } satisfies EmotedMsg);
    return true;
  }

  /** TAUNT (speech bubble); heckles are TAUNT with HECKLE_FLIP_TAUNT / HECKLE_CASH_TAUNT. */
  private actTaunt(id: string, index: unknown): boolean {
    if (!this.state.players.has(id)) return false;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= TAUNTS.length) return false;
    if (!this.cooldownOk(this.lastTaunt, id)) return false;
    this.broadcast(MSG.TAUNTED, { playerId: id, index } satisfies TauntedMsg);
    return true;
  }

  private cooldownOk(map: Map<string, number>, id: string, sec = this.T.emoteCooldown): boolean {
    if (!this.cooldownFree(map, id, sec)) return false;
    map.set(id, Date.now());
    return true;
  }

  /** The per-player cooldown in `map` has run out (doesn't start a new one). */
  private cooldownFree(map: Map<string, number>, id: string, sec: number): boolean {
    return Date.now() - (map.get(id) ?? -Infinity) >= sec * 1000;
  }

  // ===================================================================== roster
  /**
   * Consented leave or the reconnect grace ran out. A match player's seat is taken over by a bot (same name,
   * seat and kasa) so the match goes on: no turn pot, pending raid or bet is lost, and quitting locks in nothing.
   */
  private leaveForGood(id: string): void {
    const s = this.state;
    const p = s.players.get(id);
    if (!p || p.bot) return;
    if (this.hostBeforeDrop === id) this.hostBeforeDrop = "";
    p.connected = false;
    if (s.hostId === id) this.migrateHost(id);
    this.loans.dropOffersOf(id);
    const matchPlayer = s.phase !== "lobby" && s.turnOrder.includes(id);
    if (matchPlayer && IN_MATCH.has(s.phase)) {
      this.takeOver(p);
    } else if (matchPlayer) {
      // matchEnd: they stay on the podium until the rematch.
      this.leavers.add(id);
      this.notice(say.left(this.fxRng, p.nickname));
    } else {
      const name = p.nickname;
      this.removePlayer(id);
      this.notice(say.left(this.fxRng, name));
    }
    this.scheduleDisposeIfEmpty();
  }

  /** A bot sits down in a leaver's seat for the rest of the match (removed at the rematch). */
  private takeOver(p: PlayerState): void {
    p.bot = true;
    p.connected = true;
    p.ready = true;
    this.leavers.add(p.id);
    this.bots.add(p.id, "dengeli");
    this.notice(say.botTookOver(p.nickname));
    this.maybeCloseBets();
    this.lastChanceConnection(p.id);
  }

  private removePlayer(id: string): void {
    const s = this.state;
    s.players.delete(id);
    s.bets.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.lastEmote.delete(id);
    this.lastTaunt.delete(id);
    this.lastLoanPropose.delete(id);
    this.lastLoanRepay.delete(id);
    this.bots.remove(id);
    this.compactSeats();
    if (s.hostId === id) this.migrateHost(id);
  }

  /** Fewer than 2 match players still in the game (ghosts are out, bots count) → straight to the podium. */
  private checkTooFew(): boolean {
    const s = this.state;
    if (!IN_MATCH.has(s.phase)) return false;
    const alive = this.inGame();
    if (alive.length >= MIN_PLAYERS) return false;
    // Battle Royale down to its last survivor is a normal finish, not a walk-out.
    const survivorWins = s.settings.mode === "royale" && alive.length <= 1;
    if (!survivorWins) this.notice(say.tooFew());
    this.endMatch();
    return true;
  }

  /** The host is a connected human in the room. */
  private hostOk(): boolean {
    const h = this.state.players.get(this.state.hostId);
    return !!h && h.connected && !h.bot;
  }

  /** Host goes to the next connected human (never a bot); nobody left → no host until a human shows up. */
  private migrateHost(oldId: string): void {
    const s = this.state;
    const list = this.ordered();
    const at = Math.max(0, list.findIndex((p) => p.id === oldId));
    const rotated = [...list.slice(at + 1), ...list.slice(0, at + 1)].filter((p) => p.id !== oldId && p.connected && !p.bot);
    const next = rotated.find((p) => !p.spectator) ?? rotated[0];
    if (!next) {
      // Keep a host who only dropped (they get it back on reconnect); clear one who is gone for good.
      const old = s.players.get(oldId);
      if (!old || old.bot || this.hostBeforeDrop !== oldId) s.hostId = "";
      return;
    }
    s.hostId = next.id;
    this.notice(say.host(next.nickname));
  }

  private compactSeats(): void {
    this.order.forEach((id, i) => {
      const p = this.state.players.get(id);
      if (p) p.seat = i;
    });
  }

  /** Spectators who joined a full table may share an animal / color with someone; fix that for the lobby. */
  private fixDuplicateLooks(): void {
    const animals = new Set<Animal>();
    const colors = new Set<number>();
    for (const p of this.ordered()) {
      if (animals.has(p.animal)) p.animal = ANIMALS.find((a) => !animals.has(a.id))?.id ?? p.animal;
      if (colors.has(p.color)) p.color = PLAYER_COLORS.findIndex((_, i) => !colors.has(i));
      if (p.color < 0) p.color = 0;
      animals.add(p.animal);
      colors.add(p.color);
    }
  }

  private firstFreeAnimal(): Animal {
    const used = new Set<Animal>();
    this.state.players.forEach((p) => used.add(p.animal));
    return ANIMALS.find((a) => !used.has(a.id))?.id ?? ANIMALS[this.order.length % ANIMALS.length]!.id;
  }

  private firstFreeColor(): number {
    const used = new Set<number>();
    this.state.players.forEach((p) => used.add(p.color));
    for (let c = 0; c < PLAYER_COLORS.length; c++) if (!used.has(c)) return c;
    return this.order.length % PLAYER_COLORS.length;
  }

  /** Players in seat order. */
  private ordered(): PlayerState[] {
    return this.order.map((id) => this.state.players.get(id)).filter((p): p is PlayerState => !!p);
  }

  /** Non-ghost match players in turn order (connected or not). */
  private inGame(): PlayerState[] {
    const s = this.state;
    return [...s.turnOrder].map((id) => s.players.get(id)).filter((p): p is PlayerState => !!p && !p.ghost && !p.spectator);
  }

  private isConnected(id: string): boolean {
    return !!this.state.players.get(id)?.connected;
  }

  private clientOf(id: string): Client | undefined {
    return this.clients.find((c) => c.sessionId === id);
  }

  /** NOTICE to one player (no-op for bots). */
  private tell(id: string, msg: NoticeMsg): void {
    this.clientOf(id)?.send(MSG.NOTICE, msg);
  }

  // ======================================================================= bots
  private botHost(): BotHost {
    return {
      state: this.state,
      rng: () => this.botRng(),
      think: () => ({ min: this.T.botThinkMin, max: this.T.botThinkMax }),
      timeLeft: () => this.timeLeftExact(),
      timeLowSec: () => this.T.timeLow,
      turnSerial: () => this.turnCount,
      flip: (id) => this.actFlip(id),
      cash: (id) => this.actCash(id),
      target: (id, targetId) => this.actTarget(id, targetId),
      bet: (id, box, amount) => this.actBet(id, box, amount),
      canBet: (id) => this.betsOpen && this.canBet(id),
      betDecided: (id) => this.betDone.has(id),
      canShop: (id) => this.state.phase === "market" && !this.state.busy && this.marketBuyers.includes(id),
      shopped: (id) => this.marketChoice.has(id),
      marketCards: () => this.rowLeft().map((c) => ({ flipNo: c.flipNo, value: c.value })),
      marketRivals: (id) => this.marketBuyers.filter((x) => x !== id).map((x) => this.state.players.get(x)?.kasa ?? 0),
      market: (id, flipNo) => this.actMarket(id, flipNo),
      targetCandidates: () => this.targetCandidates(),
      bribeFor: (id) => {
        const s = this.state;
        return raidBribe(s.settings.mode, s.players.get(id)?.kasa ?? 0, s.round, s.finalTable);
      },
      canDeal: (id) => this.loansOpen() && this.canDeal(id),
      loanPropose: (id, msg: LoanProposeMsg) => this.actLoanPropose(id, msg),
      loanRespond: (id, offerId, accept) => this.actLoanRespond(id, { offerId, accept }),
      loanRepay: (id, debtId, amount) => this.actLoanRepay(id, { debtId, amount }),
      emote: (id, emote) => this.actEmote(id, emote),
      taunt: (id, index) => this.actTaunt(id, index),
    };
  }

  private notice(msg: NoticeMsg, except?: Client): void {
    this.broadcast(MSG.NOTICE, msg, except ? { except } : undefined);
  }

  private announce(event: AnnouncerEvent, playerId = ""): void {
    const line = this.announcer.pick(event);
    if (line) this.broadcast(MSG.ANNOUNCER, { id: line.id, playerId } satisfies AnnouncerMsg);
  }

  /** onMessage with a guard: a bad payload can never throw out of a handler. */
  private handle(type: string, fn: (client: Client, msg: unknown) => void): void {
    this.onMessage(type, (client: Client, msg: unknown) => {
      try {
        fn(client, msg);
      } catch (e) {
        console.error(`[kasala] "${type}" handler failed`, e);
      }
    });
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
