// The single UI facade the App talks to. Owner: client-ui.
// Plain DOM + ui.css inside the #ui root (which has pointer-events: none; interactive panels set
// pointer-events: auto). No framework. The UI never imports net/render/audio; it renders models
// (ui/models.ts) and emits UiEventMap events.

import type { Settings } from "../app/settings";
import { Emitter } from "../util/Emitter";
import { button, play, setHidden, svg } from "./dom";
import { HomeScreen } from "./Home";
import { Hud } from "./Hud";
import { ICON_GEAR } from "./icons";
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
import { Banner, ClickToPlay, ConnectingScreen } from "./Overlays";
import { RoundEndCard } from "./RoundEnd";
import { Scoreboard } from "./Scoreboard";
import { SettingsMenu } from "./SettingsMenu";
import { Toasts } from "./Toasts";

/** Hover sounds closer together than this are dropped (sweeping across a button row). */
const HOVER_SOUND_GAP_MS = 60;

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

  private readonly root: HTMLElement;
  private readonly connecting: ConnectingScreen;
  private readonly clickToPlay: ClickToPlay;
  private readonly bannerLayer = new Banner();
  private readonly gear = button("btn btn--icon corner-gear", svg(ICON_GEAR));
  private current: ScreenId = "home";
  private clickToPlayWanted = false;
  private settingsRequest: (() => void) | null = null;
  private hovered: Element | null = null;
  private lastHoverSound = 0;

  /** Builds every screen once and appends it to `root` (hidden until shown). */
  constructor(root: HTMLElement) {
    this.root = root;
    this.home = new HomeScreen(this.events);
    this.lobby = new LobbyScreen(this.events);
    this.hud = new Hud();
    this.killFeed = new KillFeed();
    this.scoreboard = new Scoreboard();
    this.roundEnd = new RoundEndCard();
    this.matchEnd = new MatchEndScreen(this.events);
    this.settingsMenu = new SettingsMenu(this.events);
    this.toasts = new Toasts();
    this.connecting = new ConnectingScreen(this.events);
    this.clickToPlay = new ClickToPlay(this.events);

    root.classList.add("bb-ui");
    root.append(
      this.home.el,
      this.lobby.el,
      this.hud.el,
      this.killFeed.el,
      this.roundEnd.el,
      this.matchEnd.el,
      this.bannerLayer.el,
      this.scoreboard.el,
      this.clickToPlay.el,
      this.connecting.el,
      this.gear,
      this.settingsMenu.el,
      this.toasts.el,
    );
    this.buildGear();
    this.wireSounds();
    // The menu closes itself on Resume / Esc; the click-to-play overlay may need to come back.
    this.events.on("resume", () => this.renderClickToPlay());
    this.applyScreen("home", null);
  }

  /**
   * Switch the full-screen view. "game" shows the HUD + kill feed; leaving "game" hides the
   * scoreboard/round-end overlays and clears the kill feed. "connecting" shows a spinner + text.
   */
  showScreen(id: ScreenId): void {
    if (id === this.current) return;
    const prev = this.current;
    this.current = id;
    this.applyScreen(id, prev);
  }

  get screen(): ScreenId {
    return this.current;
  }

  /** Text under the spinner on the "connecting" screen ("Joining ABCD…", "Reconnecting…"). */
  setConnecting(text: string): void {
    this.connecting.setText(text);
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
    this.renderClickToPlay();
  }

  closeSettings(): void {
    this.settingsMenu.close();
    this.renderClickToPlay();
  }

  get settingsOpen(): boolean {
    return this.settingsMenu.isOpen;
  }

  /** "Click to play" overlay over the game when the pointer isn't locked (and the menu is closed). */
  setClickToPlay(visible: boolean): void {
    this.clickToPlayWanted = visible;
    this.renderClickToPlay();
  }

  /** Short centered banner, e.g. "SUDDEN DEATH!" (style "danger") or "ROUND 3" (style "info"), ~1.5 s. */
  banner(text: string, style: "info" | "danger" | "success" = "info"): void {
    this.bannerLayer.show(text, style);
  }

  toast(text: string, kind: ToastKind = "info"): void {
    this.toasts.show(text, kind);
  }

  /**
   * Optional: show a gear button on the home and lobby screens that calls `handler` (the App
   * answers with `openSettings(settings.get(), inLobby)`). Hidden until a handler is registered,
   * so it never appears as a dead button. Returns an unsubscribe function.
   */
  onSettingsRequest(handler: () => void): () => void {
    this.settingsRequest = handler;
    this.renderGear();
    return () => {
      if (this.settingsRequest !== handler) return;
      this.settingsRequest = null;
      this.renderGear();
    };
  }

  /* -------------------------------------------------------------- screens */

  private applyScreen(id: ScreenId, prev: ScreenId | null): void {
    const inGame = id === "game";
    this.setScreenVisible(this.home.el, id === "home");
    this.setScreenVisible(this.lobby.el, id === "lobby");
    this.setScreenVisible(this.connecting.el, id === "connecting");
    this.setScreenVisible(this.matchEnd.el, id === "matchEnd");
    this.hud.setVisible(inGame);
    setHidden(this.killFeed.el, !inGame);
    if (!inGame) {
      this.scoreboard.set(false, []);
      this.roundEnd.hide();
      this.killFeed.clear();
    }
    if (id !== "game" && id !== "matchEnd") this.bannerLayer.clear();
    if (id === "connecting") this.connecting.onShow();
    else this.connecting.onHide();
    if (id === "matchEnd" && prev !== "matchEnd") this.matchEnd.onShow();
    this.root.dataset.screen = id;
    this.renderClickToPlay();
    this.renderGear();
  }

  private setScreenVisible(node: HTMLElement, visible: boolean): void {
    if (node.hidden === !visible) return;
    // Don't leave focus inside a screen that disappears (hotkeys would think we're still typing).
    if (!visible && document.activeElement instanceof HTMLElement && node.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    node.hidden = !visible;
    node.inert = !visible;
    if (visible) play(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
  }

  private renderClickToPlay(): void {
    this.clickToPlay.setVisible(this.clickToPlayWanted && this.current === "game" && !this.settingsMenu.isOpen);
  }

  /* ----------------------------------------------------------------- gear */

  private buildGear(): void {
    this.gear.setAttribute("aria-label", "Settings");
    this.gear.title = "Settings";
    this.gear.hidden = true;
    this.gear.addEventListener("click", () => this.settingsRequest?.());
  }

  private renderGear(): void {
    const show = !!this.settingsRequest && (this.current === "home" || this.current === "lobby");
    setHidden(this.gear, !show);
  }

  /* --------------------------------------------------------------- sounds */

  /** One delegated listener gives every button and link its click / hover sound. */
  private wireSounds(): void {
    this.root.addEventListener(
      "click",
      (e) => {
        const target = this.interactiveFrom(e.target);
        if (!target) return;
        if (target.getAttribute("aria-disabled") === "true") {
          this.events.emit("uiSound", { kind: "error" });
          return;
        }
        const kind = target.dataset.sound === "toggle" ? "toggle" : target.dataset.sound === "confirm" ? "confirm" : "click";
        this.events.emit("uiSound", { kind });
      },
      true,
    );
    this.root.addEventListener("pointerover", (e) => {
      const target = this.interactiveFrom(e.target);
      if (target === this.hovered) return;
      this.hovered = target;
      if (!target || target.dataset.hover === "off" || target.getAttribute("aria-disabled") === "true") return;
      const now = performance.now();
      if (now - this.lastHoverSound < HOVER_SOUND_GAP_MS) return;
      this.lastHoverSound = now;
      this.events.emit("uiSound", { kind: "hover" });
    });
  }

  private interactiveFrom(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const hit = target.closest<HTMLElement>("button, a[href]");
    if (!hit || !this.root.contains(hit)) return null;
    if (hit instanceof HTMLButtonElement && hit.disabled) return null;
    return hit;
  }
}
