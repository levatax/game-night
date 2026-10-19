// Colyseus schema v3 state for Jelly Jackpot. FROZEN CONTRACT: mirrors shared/protocol.ts *View
// interfaces field-for-field (checked at compile time at the bottom). Secrets (roles, bets, votes,
// rigs) are NEVER stored here; JellyRoom keeps them in plain server-side fields.

import { ArraySchema, MapSchema, Schema, type } from "@colyseus/schema";
import { DEFAULT_TURN_TIMER, START_COINS } from "../shared/constants.js";
import type { PieceType } from "../shared/constants.js";
import type {
  CardView,
  HoverView,
  JellyStateView,
  Phase,
  PieceView,
  PlayerView,
  SettingsView,
  SpinStage,
  StatsView,
} from "../shared/protocol.js";

export class StatsState extends Schema implements StatsView {
  @type("uint16") survived = 0;
  @type("uint16") topples = 0;
  @type("uint8") bestMultiplierX10 = 0;
  @type("int32") betProfit = 0;
}

export class SettingsState extends Schema implements SettingsView {
  @type("uint8") rounds = 0;
  @type("uint8") turnTimer = DEFAULT_TURN_TIMER;
  @type("boolean") saboteur = true;
  @type("boolean") sideBets = true;
}

export class PlayerState extends Schema implements PlayerView {
  @type("string") id = "";
  @type("string") nickname = "";
  @type("uint8") color = 0;
  @type("uint8") seat = 0;
  @type("boolean") ready = false;
  @type("boolean") connected = true;
  @type("boolean") spectator = false;
  @type("int32") coins = START_COINS;
  @type("boolean") hasBet = false;
  @type("boolean") voted = false;
  @type("uint8") place = 0;
  @type(StatsState) stats = new StatsState();
}

export class PieceState extends Schema implements PieceView {
  @type("string") id = "";
  @type("string") type: PieceType = "toaster";
  @type("string") ownerId = "";
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") z = 0;
  @type("float32") qx = 0;
  @type("float32") qy = 0;
  @type("float32") qz = 0;
  @type("float32") qw = 1;
  @type("float32") scale = 1;
  @type("string") card = "";
  @type("boolean") asleep = false;
}

export class HoverState extends Schema implements HoverView {
  @type("boolean") active = false;
  @type("string") type: PieceType = "toaster";
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") z = 0;
  @type("float32") qx = 0;
  @type("float32") qy = 0;
  @type("float32") qz = 0;
  @type("float32") qw = 1;
  @type("float32") scale = 1;
}

export class CardState extends Schema implements CardView {
  @type("string") id = "";
  @type("string") rarity = "";
  @type("float32") multiplier = 1;
}

export class JellyState extends Schema {
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
  @type("string") spinStage: SpinStage = "idle";
  @type(CardState) card = new CardState();
  @type("string") currentPiece = "";
  @type("string") nextPiece = "";
  @type("uint8") piecesLeft = 0;
  @type(HoverState) hover = new HoverState();
  @type({ map: PieceState }) pieces = new MapSchema<PieceState>();
  @type("float32") standAngle = 0;
  @type("float32") standSpeed = 0;
  @type("float32") towerHeightCm = 0;
  @type("uint16") payoutPreview = 0;
  @type("float32") windX = 1;
  @type("float32") windZ = 0;
  @type("float32") wind = 0;
  @type("boolean") quake = false;
  @type("float32") gravityScale = 1;
}

// Compile-time check that the schema matches the shared view (structural).
const _check: JellyStateView = null as unknown as JellyState;
void _check;
