// Colyseus schema v3 state for KASALA!. FROZEN CONTRACT: mirrors shared/protocol.ts *View interfaces
// field-for-field (checked at compile time at the bottom). Everything in here is public by design.

import { ArraySchema, MapSchema, Schema, type } from "@colyseus/schema";
import { DEFAULT_DECISION_SEC, START_KASA } from "../shared/constants.js";
import type { Animal, BetBox, CardId, Rarity, WheelSliceId } from "../shared/constants.js";
import type {
  BetView,
  CardView,
  DebtView,
  KasalaStateView,
  LoanKind,
  Mode,
  OfferView,
  Phase,
  PlayerView,
  SettingsView,
  StatsView,
} from "../shared/protocol.js";

export class StatsState extends Schema implements StatsView {
  @type("uint16") raids = 0;
  @type("uint16") cashes = 0;
  @type("uint16") earlyCashes = 0;
  @type("int32") biggestCash = 0;
  @type("int32") betProfit = 0;
  @type("uint16") betsWon = 0;
  @type("uint16") betsLost = 0;
  @type("uint8") maxFlips = 0;
  @type("int32") lent = 0;
  @type("int32") borrowed = 0;
}

export class SettingsState extends Schema implements SettingsView {
  @type("string") mode: Mode = "classic";
  @type("uint8") turns = 0;
  @type("uint8") decisionSec = DEFAULT_DECISION_SEC;
  @type("boolean") loans = true;
  @type("boolean") sideBets = true;
}

export class PlayerState extends Schema implements PlayerView {
  @type("string") id = "";
  @type("string") nickname = "";
  @type("string") animal: Animal = "kedi";
  @type("uint8") color = 0;
  @type("uint8") seat = 0;
  @type("boolean") ready = false;
  @type("boolean") connected = true;
  @type("boolean") spectator = false;
  @type("boolean") bot = false;
  @type("int32") kasa = START_KASA;
  @type("boolean") ghost = false;
  @type("uint8") ghostWins = 0;
  @type("boolean") ghostReturned = false;
  @type("boolean") cursed = false;
  @type("boolean") trapped = false;
  @type("boolean") lawyerNext = false;
  @type("boolean") taslik = false;
  @type("boolean") karaListe = false;
  @type("uint8") place = 0;
  @type(StatsState) stats = new StatsState();
}

export class BetState extends Schema implements BetView {
  @type("string") playerId = "";
  @type("string") box: BetBox = "cash";
  @type("uint16") amount = 0;
  @type("boolean") ghost = false;
}

export class DebtState extends Schema implements DebtView {
  @type("string") id = "";
  @type("string") lenderId = "";
  @type("string") borrowerId = "";
  @type("int32") principal = 0;
  @type("uint8") ratePct = 0;
  @type("int32") owed = 0;
}

export class OfferState extends Schema implements OfferView {
  @type("string") id = "";
  @type("string") fromId = "";
  @type("string") toId = "";
  @type("string") kind: LoanKind = "offer";
  @type("int32") amount = 0;
  @type("uint8") ratePct = 0;
  @type("float32") timeLeft = 0;
}

export class CardState extends Schema implements CardView {
  @type("uint8") flipNo = 0;
  @type("string") id: CardId | "" = "";
  @type("string") rarity: Rarity | "" = "";
  @type("int32") value = 0;
  @type("string") targetId = "";
}

export class KasalaState extends Schema {
  @type("string") phase: Phase = "lobby";
  @type("string") code = "";
  @type("string") hostId = "";
  @type(SettingsState) settings = new SettingsState();
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type(["string"]) turnOrder = new ArraySchema<string>();
  @type("uint8") round = 0;
  @type("uint8") totalRounds = 0;
  @type("uint8") turnInRound = 0;
  @type("uint8") turnsPerRound = 0;
  @type("string") activeId = "";
  @type("float32") timeLeft = 0;
  @type("float32") timeTotal = 0;
  @type("boolean") busy = false;
  @type("uint8") sirenLevel = 0;
  @type("float32") raidChance = 0;
  @type("float32") floorBonus = 0;
  @type("int32") turnPot = 0;
  @type("uint8") flips = 0;
  @type("uint8") lawyers = 0;
  @type("boolean") curseArmed = false;
  @type("int32") kumbara = 0;
  @type("boolean") finalTable = false;
  @type("boolean") betsLocked = false;
  @type(CardState) lastCard = new CardState();
  @type("string") pendingCard: CardId | "" = "";
  @type("string") wheelSlice: WheelSliceId | "" = "";
  @type("string") lastChanceId = "";
  @type({ map: BetState }) bets = new MapSchema<BetState>();
  @type({ map: DebtState }) debts = new MapSchema<DebtState>();
  @type({ map: OfferState }) offers = new MapSchema<OfferState>();
}

// Compile-time check that the schema matches the shared view (structural).
const _check: KasalaStateView = null as unknown as KasalaState;
void _check;
