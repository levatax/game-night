// View models the UI renders and the events it emits. Owner: client-ui (written by the architect, complete).
// client-app builds every model (app/viewModels.ts) from Net state + prediction; client-ui only renders them.
// All user-facing text is resolved with i18n t() INSIDE the UI from the keys / ids given here, except where a
// field says "already translated".

import type { ChestMsg, SettingsMsg } from "../../../shared/protocol";
import type {
  Biome,
  BotRole,
  CharacterId,
  DayPhase,
  Difficulty,
  EmoteId,
  FishLoot,
  GameMode,
  InteractKind,
  InvKind,
  ItemKind,
  MarkerKind,
  Phase,
  RaftStage,
  RecipeId,
  StatsView,
  TitleId,
  TreasureId,
  Weather,
  WinReason,
} from "../../../shared/types";
import type { Lang, Settings } from "../app/settings";

export type Screen = "home" | "connecting" | "lobby" | "game" | "matchEnd";

/* ================================================================= menus */

export interface HomeModel {
  nickname: string;
  /** Prefilled from ?room=CODE / /r/CODE links. */
  joinCode: string;
  busy: boolean;
  /** i18n key (menu.err*) or null. */
  error: string | null;
  language: Lang;
}

export interface LobbyPlayerModel {
  id: string;
  nickname: string;
  character: CharacterId;
  seat: number;
  color: string;
  ready: boolean;
  host: boolean;
  bot: boolean;
  botRole: BotRole | "";
  you: boolean;
  connected: boolean;
  ping: number;
  /** PNG data URL from Characters.portrait() ("" until rendered). */
  portrait: string;
}

export interface LobbyModel {
  code: string;
  /** Share link (https://host/r/CODE). */
  link: string;
  youId: string;
  isHost: boolean;
  players: LobbyPlayerModel[];
  maxPlayers: number;
  mode: GameMode;
  difficulty: Difficulty;
  /** Seed setting (0 = random each match). */
  seedSetting: number;
  /** Seed of the island preview shown (the next match's island when seedSetting != 0). */
  previewSeed: number;
  biome: Biome;
  canAddBot: boolean;
  canStart: boolean;
  /** i18n key explaining why Start is disabled ("" when it isn't). */
  startHint: string;
  /** You are ready. */
  ready: boolean;
  /** A lone human starting with no bots gets this many helper bots. */
  autoBots: number;
}

/* =================================================================== HUD */

export interface PromptModel {
  kind: InteractKind;
  /** i18n key under `prompt.` (e.g. "prompt.gather_wood", "prompt.deliver"), with params. */
  key: string;
  params?: Record<string, string | number>;
  /** Key glyph to show ("E"). */
  keyGlyph: string;
  hold: boolean;
  /** 0..1 while the hold channel runs. */
  progress: number;
  ok: boolean;
  /** i18n key under `reject.` when !ok. */
  reason: string;
}

export interface SlotModel {
  kind: InvKind;
  count: number;
  /** 0..1 burn left for a torch / fuse left for a puffer, -1 n/a. */
  meter: number;
}

export interface RaftPartModel {
  /** "hullWood" | "mastWood" | "mastRope" | "food" | "water". */
  part: "hullWood" | "mastWood" | "mastRope" | "food" | "water";
  have: number;
  need: number;
}

export type CompassMarkKind = "camp" | "raft" | "spring" | "secret" | "ping" | "player" | "resource" | "danger" | "cave";

export interface CompassMark {
  kind: CompassMarkKind;
  /** World bearing (yaw convention: 0 = -Z) from the local player. */
  bearing: number;
  /** Meters. */
  dist: number;
  color: string;
  /** Emoji / glyph. */
  icon: string;
  /** Already translated short label ("" none). */
  label: string;
}

export interface TeammateModel {
  id: string;
  nickname: string;
  character: CharacterId;
  color: string;
  bot: boolean;
  hp: number;
  downed: boolean;
  washed: boolean;
  boarded: boolean;
  connected: boolean;
}

export interface HudModel {
  phase: Phase;
  day: number;
  days: number;
  dayPhase: DayPhase;
  /** Seconds left in the current day phase / until the storm. */
  phaseSecLeft: number;
  stormSecLeft: number;
  /** 0..1 position of the sun / moon on the arc (schedule.ts ClockInfo.cycle). */
  cycle: number;
  weather: Weather;
  /** Bars 0..1. */
  hp: number;
  hunger: number;
  thirst: number;
  warmth: number;
  /** Bars below LOW_BAR_FRACTION (flash unless reducedFlashing). */
  low: { hp: boolean; hunger: boolean; thirst: boolean; warmth: boolean };
  slots: SlotModel[];
  activeSlot: number;
  prompt: PromptModel | null;
  /** 0..1 throw charge (0 = hidden). */
  charge: number;
  /** Fishing: "cast" waiting, "bite" (click now! windowFrac 1 → 0), "reel" (result coming). */
  fishing: { state: "cast" | "bite" | "reel"; windowFrac: number } | null;
  raft: { stage: RaftStage; parts: RaftPartModel[]; ready: boolean; aboard: number; total: number };
  fire: { frac: number; lit: boolean; low: boolean; secLeft: number };
  compass: { yaw: number; marks: CompassMark[] };
  /** You are downed: seconds until you wash ashore; `revive` 0..1 when a teammate is reviving you. */
  downed: { secLeft: number; revive: number } | null;
  /** You washed ashore (death screen): respawn at dawn? */
  washed: { willRespawn: boolean; secToDawn: number } | null;
  boarded: boolean;
  /** Boarding countdown after the first player boarded. */
  launch: { secLeft: number; aboard: number; total: number } | null;
  stormWarning: boolean;
  /** Rung of the storm-warning ladder the HUD is showing (-1 = no warning yet). */
  stormTier: number;
  spectator: boolean;
  /** Crosshair style. */
  crosshair: "dot" | "throw" | "interact" | "hidden";
  teammates: TeammateModel[];
  /** Needs a click to re-capture the mouse (pointer lock lost). */
  needsPointer: boolean;
  reducedFlashing: boolean;
}

/* ====================================================== transient HUD */

export type Tone = "info" | "good" | "bad" | "warn" | "gold";

/** One feed line (2 visible, 5 s each). `key` under feed.* (owner client-app), params already translated. */
export interface FeedEntry {
  key: string;
  params?: Record<string, string | number>;
  icon: string;
  tone: Tone;
}

/** Big center banner ("NIGHT IS COMING", "RAFT READY!", "STORM!"). `key` under banner.*; `sub` optional second line key. */
export interface BannerModel {
  key: string;
  params?: Record<string, string | number>;
  sub?: string;
  subParams?: Record<string, string | number>;
  tone: Tone;
  /** Seconds on screen (default 2.5). */
  duration?: number;
}

/**
 * Caption for a sound nothing else on screen says (crabs crawling ashore, thunder, a fence being gnawed): one
 * line above the feed (ui/hud/Subtitle.ts). `key` under hud.*, params already translated.
 */
export interface CaptionEntry {
  key: string;
  params?: Record<string, string | number>;
  icon: string;
}

/** "What did I get?" strip (Jelly CaseReel style). The UI spins past `strip` and stops at strip[stopIndex]. */
export interface ReelModel {
  kind: "fish" | "treasure";
  strip: (FishLoot | TreasureId)[];
  stopIndex: number;
  durationMs: number;
  /** Fisher's name (already translated / raw nickname) for remote reels ("" = it's you). */
  who: string;
  /**
   * Called once when this reel lands (or when it is dropped from a full queue / cleared), so the result is revealed
   * (sound, banner, feed line) exactly when the player sees it, even after waiting behind another reel.
   */
  onLanded?: () => void;
}

export interface RecipeRowModel {
  id: RecipeId;
  cost: { kind: ItemKind; have: number; need: number }[];
  /** Craftable now (ingredients in inventory + chest, fire lit). */
  ok: boolean;
  /** Bottle recipe not unlocked yet (hidden or "???"). */
  locked: boolean;
  /** Output item (null for fuel / team feast). */
  out: ItemKind | null;
}

export interface CraftPanelModel {
  recipes: RecipeRowModel[];
  fireLit: boolean;
  /** Fire fuel 0..1 and seconds. */
  fuelFrac: number;
  fuelSec: number;
}

export interface ChestPanelModel {
  /** Chest contents sorted by kind order. */
  chest: { kind: ItemKind; count: number }[];
  slots: SlotModel[];
  activeSlot: number;
  /**
   * The held slot as the server last reported it (net.me.activeSlot; absent = activeSlot).
   * @deprecated No longer filled or read: every chest put names its pocket (ChestMsg `slot`), so nothing waits for
   * the server's held slot any more. Kept so the frozen model stays additive.
   */
  heldSlot?: number;
}

export interface ScoreRow {
  id: string;
  nickname: string;
  character: CharacterId;
  color: string;
  bot: boolean;
  you: boolean;
  score: number;
  stats: StatsView;
  ping: number;
}

export interface MatchEndRow extends ScoreRow {
  place: number;
  titles: TitleId[];
  aboard: boolean;
}

export interface MatchEndModel {
  win: boolean;
  reason: WinReason;
  /** Seconds that were left before the storm at the launch. */
  secLeft: number;
  teamScore: number;
  seed: number;
  biome: Biome;
  mvpId: string;
  rows: MatchEndRow[];
  canRematch: boolean;
  secToLobby: number;
}

/* ================================================================= events */

export interface UiEventMap {
  create: { nickname: string };
  join: { code: string; nickname: string };
  leave: void;
  ready: { ready: boolean };
  character: { character: CharacterId };
  /** Host lobby settings (difficulty / seed / mode). */
  roomSettings: SettingsMsg;
  start: void;
  addBot: void;
  removeBot: { id: string };
  copyLink: void;
  rematch: { ready: boolean };
  craft: { recipe: RecipeId };
  chest: ChestMsg;
  /** Chest panel click on a pocket that isn't held: make pocket `slot` (0-based) the held one (Input.selectSlot). */
  selectSlot: { slot: number };
  /** A panel / menu was closed by the UI (Esc / click outside): the app re-locks the pointer. */
  closePanel: void;
  marker: { kind: MarkerKind };
  emote: { emote: EmoteId };
  /** Settings menu changes (client settings, not room settings). */
  settings: Partial<Settings>;
  language: { lang: Lang };
  /** Clicked the "click to play" veil: request pointer lock. */
  resume: void;
  /** Any UI sound cue (the app routes it to AudioEngine). */
  sound: { name: "uiClick" | "uiHover" | "uiOpen" | "uiClose" | "uiError" | "uiTick" };
}
