// The single UI facade the App talks to. Owner: client-ui.
// Plain DOM + ui.css inside the #ui root (which has pointer-events: none; interactive panels set
// pointer-events: auto). No framework. The UI never imports net/render/audio; it renders models
// (ui/models.ts) and emits UiEventMap events.

import type { Settings } from "../app/settings";
import { Emitter } from "../util/Emitter";
import { HomeScreen } from "./Home";
import { Hud } from "./Hud";
import { KillFeed } from "./KillFeed";
import { LobbyScreen } from "./Lobby";
import { MatchEndScreen } from "./MatchEnd";
import type {
  HomeModel,
  HudModel,
  KillFeedEntry,
  LobbyModel,
  MatchEndModel,
  OffscreenIndicator,
  RoundEndModel,
  ScoreRow,
  ScreenId,
  ToastKind,
  UiEventMap,
} from "./models";
import { RoundEndCard } from "./RoundEnd";
import { Scoreboard } from "./Scoreboard";
import { SettingsMenu } from "./SettingsMenu";
import { Toasts } from "./Toasts";

export class Ui {
  readonly events = new Emitter<UiEventMap>();
  protected readonly home: HomeScreen;
  protected readonly lobby: LobbyScreen;
  protected readonly hud: Hud;
  protected readonly killFeed: KillFeed;
  protected readonly scoreboard: Scoreboard;
  protected readonly roundEnd: RoundEndCard;
  protected readonly matchEnd: MatchEndScreen;
  protected readonly settingsMenu: SettingsMenu;
  protected readonly toasts: Toasts;

  /** Builds every screen once and appends it to `root` (hidden until shown). */
  constructor(root: HTMLElement) {
    this.home = new HomeScreen(this.events);
    this.lobby = new LobbyScreen(this.events);
    this.hud = new Hud();
    this.killFeed = new KillFeed();
    this.scoreboard = new Scoreboard();
    this.roundEnd = new RoundEndCard();
    this.matchEnd = new MatchEndScreen(this.events);
    this.settingsMenu = new SettingsMenu(this.events);
    this.toasts = new Toasts();
    void root; // TODO(client-ui): append elements, wire DOM listeners.
  }

  /**
   * Switch the full-screen view. "game" shows the HUD + kill feed; leaving "game" hides the
   * scoreboard/round-end overlays and clears the kill feed. "connecting" shows a spinner + text.
   */
  showScreen(id: ScreenId): void {
    void id;
  }

  get screen(): ScreenId {
    return "home"; // TODO(client-ui)
  }

  /** Text under the spinner on the "connecting" screen ("Joining ABCD…", "Reconnecting…"). */
  setConnecting(text: string): void {
    void text;
  }

  setHome(model: HomeModel): void {
    this.home.update(model);
  }

  setLobby(model: LobbyModel): void {
    this.lobby.update(model);
  }

  /** Canvas for the 3D character turntable inside the lobby carousel. */
  get previewCanvas(): HTMLCanvasElement {
    return this.lobby.previewCanvas;
  }

  /** Called every frame while in game. Must be cheap (diff internally). */
  updateHud(model: HudModel): void {
    this.hud.update(model);
  }

  /** Called every frame while in game. */
  setIndicators(list: readonly OffscreenIndicator[]): void {
    this.hud.setIndicators(list);
  }

  pushKillFeed(entry: KillFeedEntry): void {
    this.killFeed.push(entry);
  }

  /** Tab scoreboard (open while held). */
  setScoreboard(open: boolean, rows: readonly ScoreRow[]): void {
    this.scoreboard.set(open, rows);
  }

  showRoundEnd(model: RoundEndModel): void {
    this.roundEnd.show(model);
  }

  hideRoundEnd(): void {
    this.roundEnd.hide();
  }

  setMatchEnd(model: MatchEndModel): void {
    this.matchEnd.update(model);
  }

  /** Esc menu. `inRoom` shows the Leave room button. */
  openSettings(current: Readonly<Settings>, inRoom: boolean): void {
    this.settingsMenu.open(current, inRoom);
  }

  closeSettings(): void {
    this.settingsMenu.close();
  }

  get settingsOpen(): boolean {
    return this.settingsMenu.isOpen;
  }

  /** "Click to play" overlay over the game when the pointer isn't locked (and the menu is closed). */
  setClickToPlay(visible: boolean): void {
    void visible;
  }

  /** Short centered banner, e.g. "SUDDEN DEATH!" (style "danger") or "ROUND 3" (style "info"), ~1.5 s. */
  banner(text: string, style: "info" | "danger" | "success" = "info"): void {
    void text;
    void style;
  }

  toast(text: string, kind: ToastKind = "info"): void {
    this.toasts.show(text, kind);
  }
}
