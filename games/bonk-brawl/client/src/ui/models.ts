// View models the UI renders and the events it emits. Owner: client-ui (written by architect, complete).
// client-app builds these from net state every frame / on change; client-ui only renders them and
// never reads net state itself. All strings are display-ready unless noted.

import type { Settings } from "../app/settings";
import type { SettingsMsg } from "../../../shared/protocol";
import type { CharacterId, EmoteId, HeldPowerUp, MapChoice, Phase, SettingsView } from "../../../shared/types";

/** Full-screen screens. Overlays (settings menu, scoreboard, round-end card, toasts) sit on top. */
export type ScreenId = "home" | "connecting" | "lobby" | "game" | "matchEnd";

export type ToastKind = "info" | "success" | "warning" | "error";

/* ------------------------------------------------------------------ home */

export interface HomeModel {
  nickname: string;
  /** Prefilled join code (deep link ?room=CODE), "" otherwise. */
  code: string;
  /** Create/Join in flight: disable buttons, show a spinner. */
  busy: boolean;
  /** Last join/create error, shown under the buttons. */
  error: string | null;
}

/* ----------------------------------------------------------------- lobby */

export interface LobbyPlayerCard {
  id: string;
  nickname: string;
  character: CharacterId;
  /** "🦆" etc. */
  emoji: string;
  slot: number;
  /** Slot color "#RRGGBB". */
  color: string;
  ready: boolean;
  isHost: boolean;
  isYou: boolean;
  connected: boolean;
  /** Joined mid-match, waiting for the next one. */
  spectator: boolean;
  ping: number;
}

export interface LobbyModel {
  code: string;
  /** `${location.origin}/r/${code}` for the "Copy link" button. */
  shareUrl: string;
  /** Sorted by slot, at most 4. Empty seats are drawn by the UI as "Waiting for player…". */
  players: LobbyPlayerCard[];
  you: { id: string; character: CharacterId; ready: boolean; isHost: boolean; spectator: boolean };
  settings: SettingsView;
  /** Host may press Start (≥ 2 players, all ready). */
  canStart: boolean;
  /** Why Start is disabled / what we're waiting for ("" when canStart). */
  startHint: string;
  /** Phase of the room (non-lobby while spectating a running match). */
  phase: Phase;
}

/** Options the host settings panel offers. */
export const MAP_CHOICES: ReadonlyArray<{ value: MapChoice; label: string }> = [
  { value: "random", label: "Random" },
  { value: "picnic", label: "Picnic Plateau" },
  { value: "bath", label: "Bath Time" },
  { value: "cake", label: "Cake Topper" },
];

/* ------------------------------------------------------------------- HUD */

export interface ScoreRow {
  id: string;
  nickname: string;
  character: CharacterId;
  emoji: string;
  color: string;
  points: number;
  hasCrown: boolean;
  isYou: boolean;
  /** Alive in the current round (dimmed + "OUT" when false during a round). */
  alive: boolean;
  hearts: number;
  connected: boolean;
  ping: number;
  roundWins: number;
  hits: number;
  catches: number;
  ringOuts: number;
}

export interface AbilityHud {
  name: string;
  icon: string;
  /** 0 = ready, 1 = just used (radial cooldown fill). */
  cooldownFrac: number;
  ready: boolean;
  /** Ability currently running (dash/slide/bounce...). */
  active: boolean;
  /** Whiskers' curveball armed (glowing icon). */
  armed: boolean;
}

export interface HudModel {
  phase: Phase;
  round: number;
  totalRounds: number;
  /** Seconds left: playing → until sudden death; suddenDeath → until the next ring drop; countdown → until go. */
  timerSec: number;
  suddenDeath: boolean;
  /** Big centered countdown: 3, 2, 1, 0 ("BONK!") or null when hidden. */
  countdown: number | null;
  hearts: number;
  maxHearts: number;
  ability: AbilityHud;
  /** Charge meter 0..1 (curved bar under the crosshair). */
  charge: number;
  charging: boolean;
  fullCharge: boolean;
  /** Crosshair gap 0..1 (1 = wide idle, tightens toward 0 while charging). */
  crosshairSpread: number;
  heldBalls: number;
  maxHeld: number;
  powerUp: HeldPowerUp;
  /** Zoomies remaining 0..1 (0 = none). */
  zoomiesFrac: number;
  /** Catch / roll cooldowns, 0 = ready. */
  catchCooldownFrac: number;
  rollCooldownFrac: number;
  /** Mini scoreboard rows (top right), sorted by points desc. */
  scoreboard: ScoreRow[];
  /** Non-null while the local player is a ghost (KO'd) or a mid-match spectator. */
  spectating: { reason: "ko" | "ringOut" | "spectator"; text: string } | null;
  /** Your color (crosshair / charge bar tint). */
  color: string;
  ping: number;
}

/** Off-screen incoming-ball arrow (game1.md §13). Screen pixels relative to the viewport. */
export interface OffscreenIndicator {
  /** Ball id (stable key for DOM reuse). */
  id: string;
  /** Arrow position, already clamped inside the screen edge margin. */
  x: number;
  y: number;
  /** Arrow direction in radians (0 = pointing right, PI/2 = pointing down). */
  angle: number;
  /** Thrower color. */
  color: string;
  /** 0..1, higher = closer to impact (bigger / pulsing). */
  urgency: number;
}

/* ------------------------------------------------------------- kill feed */

export interface FeedPlayer {
  name: string;
  emoji: string;
  color: string;
}

/**
 * bonk: "🦆 Quacky BONKED 🐸 Hopsworth"; catch: "🐻 Mochi CAUGHT 🐱 Whiskers' ball!";
 * ringOut: "🐐 Gruff RANG OUT 🐧 Pip"; fell: "🐧 Pip fell off!"; ko: "🐸 Hopsworth is OUT!";
 * dropped: "🐱 Whiskers disconnected".
 */
export type KillFeedKind = "bonk" | "catch" | "ringOut" | "fell" | "ko" | "dropped";

export interface KillFeedEntry {
  /** Unique, increasing. Entries fade after ~5 s; max 5 visible. */
  id: number;
  kind: KillFeedKind;
  actor: FeedPlayer | null;
  victim: FeedPlayer;
}

/* ------------------------------------------------------ round / match end */

export interface RoundEndRow {
  id: string;
  name: string;
  emoji: string;
  color: string;
  roundPoints: number;
  totalPoints: number;
  isWinner: boolean;
  isYou: boolean;
}

export interface RoundEndModel {
  round: number;
  totalRounds: number;
  /** null = draw. */
  winner: { id: string; name: string; character: CharacterId; emoji: string; color: string } | null;
  rows: RoundEndRow[];
  /** 0 when the match is over (the podium follows). */
  nextRound: number;
}

export interface PodiumEntry {
  id: string;
  name: string;
  character: CharacterId;
  emoji: string;
  color: string;
  /** 1..4 (4th "falls into the void"). */
  place: number;
  points: number;
  isYou: boolean;
  stats: {
    hits: number;
    catches: number;
    ringOuts: number;
    kos: number;
    roundWins: number;
    /** 0..100 integer: min(100, round(100 * hits / max(1, throws))). */
    accuracy: number;
  };
}

export interface MatchEndModel {
  /** Sorted by place. */
  entries: PodiumEntry[];
  winnerId: string;
  /** Rematch / Back to lobby enabled (server accepts after MATCH_END_MIN_TICKS). */
  canRematch: boolean;
  /** Seconds until the room returns to the lobby on its own. */
  autoLobbySec: number;
}

/* ------------------------------------------------------------- UI events */

/** Everything the UI asks the app to do. The UI never talks to Net directly. */
export interface UiEventMap {
  createRoom: { nickname: string };
  joinRoom: { code: string; nickname: string };
  selectCharacter: { character: CharacterId };
  setReady: { ready: boolean };
  /** Host only. */
  updateSettings: SettingsMsg;
  /** Host only. */
  startMatch: void;
  /** Podium "Rematch" → { ready: true }, "Back to lobby" → { ready: false }. */
  rematch: { ready: boolean };
  /** Leave the room and return to the home screen. */
  leaveRoom: void;
  /** Leave everything and go to the Game Night portal ("/"). */
  backToPortal: void;
  /** Settings menu edits (applied with settings.set by the app). */
  settingsChange: Partial<Settings>;
  /** "Resume" in the settings menu or the click-to-play overlay (a user gesture: request pointer lock). */
  resume: void;
  /** Emote picked from the settings/emote wheel (Q also emotes directly via Input). */
  emote: { emote: EmoteId };
  /** UI interaction sounds for the audio engine. */
  uiSound: { kind: "click" | "hover" | "toggle" | "error" };
}
