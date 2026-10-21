// Every HTML/CSS screen and HUD widget (ui.css + hud.css + panels.css + reel.css). Owner: client-ui. Signatures
// by the architect; keep them. The UI never imports net / render / audio: it renders the models in ./models.ts
// and emits UiEventMap events. #ui is pointer-events: none; only interactive widgets opt back in.
//
// Screens: home (logo, nickname, create / join by code, language), connecting, lobby (code + copy link, players
// with portraits / ready / bot badges, tourist picker, host: mode, difficulty, seed (random / typed), add /
// remove bots, start), game (HUD), matchEnd (win/lose card, MVP, titles, stats table, rematch / back to lobby).
// HUD (§17, KASALA declutter: "every event is said once"): bottom-left 3 bars + hp; bottom-center 4-slot hotbar;
// top-center sun/moon arc + "Day 2/3 — 1:35"; top-right raft 3 segments + fire flame; top compass strip;
// contextual: interact prompt under the crosshair, craft panel, chest panel, fishing timing bar, revive ring,
// charge bar, downed / washed screens, boarding countdown; transient: feed (2 lines, 5 s), sound captions (one
// line above the feed), banners, coach tips;
// optional: H legend (recipes, loot table, controls), Tab stats table, Esc settings menu (sound, language,
// sensitivity, mouse lock, FOV, quality / Auto, HUD size, reduced flashing, key preset, show tips again, leave).
// Ping wheel (V / middle click, 4 slices) and emote wheel
// (T + 1–6). Reels: fish "What did I get?" strip and treasure strip (Jelly CaseReel / reel.css style).
//
// Copy + adapt: games/bonk-brawl/client/src/ui/{dom,icons,Lobby,LobbyPlayers,LobbySettings,MatchEnd,Scoreboard,
// SettingsMenu,Toasts}.ts + ui.css; games/kasala/client/src/ui/{keyGate.ts, hud/{dom,Banner,Feed,Subtitle,Coach,
// Legend}.ts}; games/jelly-jackpot/client/src/ui/CaseReel.ts + reel.css.
//
// Who handles which key (so nothing toggles twice):
//  - The APP opens panels: E on craft / chest → openPanel("craft" | "chest"); V or middle click →
//    openPanel("pingWheel"); T → openPanel("emoteWheel"); Esc (pointer unlocked) → openPanel("settings");
//    H down → openPanel("legend"); Tab held → setScoreboard(rows) / setScoreboard(null) on release.
//  - The UI handles keys only while a panel is open (window capture phase, so the app never sees them): Esc
//    closes any panel (the settings confirm first); E closes craft / chest; 1–9 craft; the chest's slot keys,
//    Enter / Space and the arrows work its tiles (ChestPanel.onKey; a deposit names its pocket, a click on a
//    pocket that isn't held emits `selectSlot`), the arrows move between craft cards; 1–4 / 1–6 pick in the wheels, V / T close
//    their wheel, releasing V / T / the middle button over a lit slice picks it (hold-release); H release
//    closes the legend. Those letters follow settings.keyPreset (input/bindings.ts: U / N / Y / P left-handed).
//    The key press that opened a panel is never also handled as its close (event.timeStamp guard).
//  - The legend and the Tab table are passive overlays: capturesInput stays false (holding H / Tab must not
//    release the pointer lock). Everything else (craft, chest, settings, wheels, a focused text field) captures.
//  - A UI-initiated close (Esc, click outside, ✕, a wheel pick) emits `closePanel` while the game screen is up
//    (the app re-locks the pointer); on home / lobby it doesn't (nothing to lock).
//  - The "Click to play" veil (HudModel.needsPointer) emits `resume`; its Menu button opens the settings.
//  - Settings: the menu saves every change with settings.set() and also emits `settings`; a language pick emits
//    `language` and then calls i18n setLanguage() (reload; the room is rejoined via the reconnect token).
//  - Coach tip ids: ui/hud/Coach.ts COACH_TIPS (strings coach.<id>); each shows once per browser (seenTips) until
//    the settings menu's "Show tips again" clears it.
//  - Root prefs (dom.ts bindRootPrefs): --hud-scale (HUD size setting) and .rr-reduced (reduced flashing).
//  - Lobby startHint keys: menu.startHint_notReady / _away / _notLobby / _host (any menu.* key works).
//  - Over every screen: the "Reconnecting… (attempt n)" pill (setReconnecting) and the "graphics were reset" card
//    with its Reload button (setGraphicsLost), both driven by the app.

import { settings } from "../app/settings";
import { t } from "../i18n";
import { bindingFor } from "../input/bindings";
import { Emitter } from "../util/Emitter";
import { bindRootPrefs, button, el, isTyping, play, setHidden, svg } from "./dom";
import { Banner } from "./hud/Banner";
import { Coach } from "./hud/Coach";
import { ContextLostCard } from "./hud/ContextLostCard";
import { Hud } from "./hud/Hud";
import { Legend } from "./hud/Legend";
import { PointerVeil } from "./hud/PointerVeil";
import { ReconnectPill } from "./hud/ReconnectPill";
import { Scoreboard } from "./hud/Scoreboard";
import { Toasts } from "./hud/Toasts";
import { ICON_GEAR } from "./icons";
import { addKeyGate, uiCapturesKeys } from "./keyGate";
import type {
  BannerModel,
  CaptionEntry,
  ChestPanelModel,
  CraftPanelModel,
  FeedEntry,
  HomeModel,
  HudModel,
  LobbyModel,
  MatchEndModel,
  ReelModel,
  Screen,
  ScoreRow,
  UiEventMap,
} from "./models";
import { ChestPanel } from "./panels/ChestPanel";
import { CraftPanel } from "./panels/CraftPanel";
import { EmoteWheel } from "./panels/EmoteWheel";
import { PingWheel } from "./panels/PingWheel";
import { Reel } from "./panels/Reel";
import { SettingsMenu } from "./panels/SettingsMenu";
import { ConnectingScreen } from "./screens/Connecting";
import { HomeScreen } from "./screens/Home";
import { LobbyScreen } from "./screens/Lobby";
import { MatchEndScreen } from "./screens/MatchEnd";
import "./ui.css";
import "./hud.css";
import "./panels.css";
import "./reel.css";

export type Panel = "craft" | "chest" | "settings" | "legend" | "pingWheel" | "emoteWheel" | null;

/** Hover sounds closer together than this are dropped (sweeping across a row of buttons). */
const HOVER_SOUND_GAP_MS = 60;

export class Ui {
  readonly events = new Emitter<UiEventMap>();

  private readonly root: HTMLElement;
  private readonly home: HomeScreen;
  private readonly connecting: ConnectingScreen;
  private readonly lobby: LobbyScreen;
  private readonly matchEnd: MatchEndScreen;
  private readonly hud = new Hud();
  private readonly legend = new Legend();
  private readonly scoreboard = new Scoreboard();
  private readonly bannerLayer = new Banner();
  private readonly toasts = new Toasts();
  private readonly reconnectPill = new ReconnectPill();
  private readonly contextCard = new ContextLostCard();
  private readonly reels: Reel;
  private readonly coachTips: Coach;
  private readonly craftPanel: CraftPanel;
  private readonly chestPanel: ChestPanel;
  private readonly settingsMenu: SettingsMenu;
  private readonly pingWheel: PingWheel;
  private readonly emoteWheel: EmoteWheel;
  private readonly veil: PointerVeil;
  private readonly gear = button("rr-btn rr-btn--icon rr-corner-gear", svg(ICON_GEAR));
  private readonly overlay = el("div", "rr-overlays");

  private current: Screen = "home";
  private openPanelId: Panel = null;
  /** performance.now() when the current panel opened (key events created before it belong to the opener). */
  private openedAt = 0;
  private needsPointer = false;
  private reducedFlashing = settings.get().reducedFlashing;
  private hovered: Element | null = null;
  private lastHoverSound = 0;
  private readonly disposers: Array<() => void> = [];

  constructor(root: HTMLElement) {
    this.root = root;
    this.home = new HomeScreen(this.events);
    this.connecting = new ConnectingScreen(this.events);
    this.lobby = new LobbyScreen(this.events);
    this.matchEnd = new MatchEndScreen(this.events);
    this.reels = new Reel(() => this.events.emit("sound", { name: "uiTick" }));
    this.coachTips = new Coach(this.hud.el, (a) => this.hud.anchor(a));
    this.craftPanel = new CraftPanel(
      (recipe) => this.events.emit("craft", { recipe }),
      () => this.events.emit("sound", { name: "uiError" }),
      () => this.closeFromUi(),
    );
    this.chestPanel = new ChestPanel(
      (msg) => this.events.emit("chest", msg),
      () => this.closeFromUi(),
      (slot) => this.events.emit("selectSlot", { slot }),
    );
    this.settingsMenu = new SettingsMenu({
      onClose: () => this.closeFromUi(),
      onLeave: () => {
        // Close without "closePanel": that would ask for the pointer again right before we leave the game.
        this.openPanel(null);
        this.events.emit("leave", undefined);
      },
      onSettings: (patch) => this.events.emit("settings", patch),
      onLanguage: (lang) => this.events.emit("language", { lang }),
    });
    this.pingWheel = new PingWheel(
      (kind) => {
        this.events.emit("marker", { kind });
        this.closeFromUi();
      },
      () => this.closeFromUi(),
    );
    this.emoteWheel = new EmoteWheel(
      (emote) => {
        this.events.emit("emote", { emote });
        this.closeFromUi();
      },
      () => this.closeFromUi(),
    );
    this.veil = new PointerVeil(
      () => this.events.emit("resume", undefined),
      () => this.openPanel("settings"),
    );
    this.hud.el.append(this.coachTips.el);

    root.classList.add("rr-ui");
    this.disposers.push(bindRootPrefs(root));
    this.overlay.append(this.legend.el, this.scoreboard.el, this.reels.el, this.bannerLayer.el, this.veil.el, this.craftPanel.el, this.chestPanel.el, this.pingWheel.el, this.emoteWheel.el);
    root.append(this.home.el, this.lobby.el, this.matchEnd.el, this.hud.el, this.overlay, this.connecting.el, this.gear, this.settingsMenu.el, this.toasts.el, this.reconnectPill.el, this.contextCard.el);

    this.gear.setAttribute("aria-label", t("overlays.settingsTitle"));
    this.gear.title = t("overlays.settingsTitle");
    this.gear.addEventListener("click", () => this.openPanel(this.openPanelId === "settings" ? null : "settings"));

    this.disposers.push(addKeyGate(() => this.ownCaptures()));
    this.disposers.push(
      settings.onChange((s, changed) => {
        if (changed.includes("reducedFlashing")) this.reducedFlashing = s.reducedFlashing;
        if (this.settingsMenu.isOpen) this.settingsMenu.refresh(s);
      }),
    );
    this.listen(window, "keydown", (e) => this.onKeyDown(e as KeyboardEvent), true);
    this.listen(window, "keyup", (e) => this.onKeyUp(e as KeyboardEvent), true);
    this.listen(window, "mouseup", (e) => this.onMouseUp(e as MouseEvent), true);
    this.listen(window, "blur", () => {
      if (this.openPanelId === "legend") this.openPanel(null);
    });
    this.wireSounds();
    this.applyScreen("home", null);
  }

  /* =============================================================== screens */

  showScreen(screen: Screen): void {
    if (screen === this.current) return;
    const prev = this.current;
    this.current = screen;
    this.applyScreen(screen, prev);
  }

  /** The screen currently shown. */
  get screen(): Screen {
    return this.current;
  }

  /** Text on the connecting screen ("" = "Paddling to the island…"), e.g. t("menu.reconnecting"). */
  setConnecting(text: string): void {
    this.connecting.setText(text);
  }

  setHome(model: HomeModel): void {
    this.home.update(model);
  }

  setLobby(model: LobbyModel): void {
    this.lobby.update(model);
  }

  /** Every frame while in game (cheap: only touches the DOM when a value changed). */
  updateHud(model: HudModel): void {
    this.reducedFlashing = model.reducedFlashing;
    this.hud.update(model);
    if (model.needsPointer !== this.needsPointer) {
      this.needsPointer = model.needsPointer;
      this.renderVeil();
    }
  }

  setMatchEnd(model: MatchEndModel): void {
    this.matchEnd.update(model);
  }

  /* ============================================================= transient */

  feed(entry: FeedEntry): void {
    this.hud.feed.push(entry);
  }

  banner(model: BannerModel): void {
    this.bannerLayer.show(model, this.reducedFlashing);
  }

  /** Caption a sound-only cue (one line above the feed, in game only; the app rate-limits). */
  caption(entry: CaptionEntry): void {
    if (this.current === "game") this.hud.captions.show(entry);
  }

  /** Short toast (connection notices, server notices). `text` already translated. */
  toast(text: string, tone: "info" | "good" | "bad" | "warn" = "info"): void {
    this.toasts.show(text, tone);
  }

  /** Automatic reconnect window: the persistent "Reconnecting… (attempt n)" pill over every screen (null hides it). */
  setReconnecting(attempt: number | null): void {
    this.reconnectPill.set(attempt);
  }

  /** The WebGL context is lost: the "graphics were reset" card with a Reload button (false hides it). */
  setGraphicsLost(lost: boolean): void {
    this.contextCard.setVisible(lost);
  }

  /** First-match coach tip by id (coach.<id>); the UI shows each at most once (settings.seenTips). */
  coach(tipId: string): void {
    this.coachTips.offer(tipId);
  }

  reel(model: ReelModel): void {
    this.reels.show(model, this.reducedFlashing);
  }

  /* ================================================================ panels */

  /** Open a panel (null closes all). While a panel / menu is open `capturesInput` is true. */
  openPanel(panel: Panel): void {
    if (panel === this.openPanelId) {
      if (panel === "settings") this.settingsMenu.refresh(settings.get());
      return;
    }
    const prev = this.openPanelId;
    if (prev) this.hidePanel(prev);
    this.openPanelId = panel;
    this.openedAt = performance.now();
    if (panel) this.showPanel(panel);
    if (panel && panel !== "legend") this.events.emit("sound", { name: "uiOpen" });
    else if (!panel && prev && prev !== "legend") this.events.emit("sound", { name: "uiClose" });
    this.root.dataset.panel = panel ?? "";
    this.renderVeil();
    this.renderGear();
  }

  get panel(): Panel {
    return this.openPanelId;
  }

  /** Craft / chest panel contents while open (call every frame or on change; null = keep). */
  setCraftPanel(model: CraftPanelModel | null): void {
    if (!model) return;
    this.craftPanel.update(model);
    this.legend.setUnlocked(model.recipes.filter((r) => !r.locked).map((r) => r.id));
  }

  setChestPanel(model: ChestPanelModel | null): void {
    if (!model) return;
    this.chestPanel.update(model);
  }

  /** Tab stats table rows (null hides it). */
  setScoreboard(rows: ScoreRow[] | null): void {
    this.scoreboard.set(this.current === "game" ? rows : null);
  }

  /** True while a panel, wheel, menu or text field owns the keyboard / mouse: Input stops sampling game keys and releases pointer lock. */
  get capturesInput(): boolean {
    return uiCapturesKeys();
  }

  dispose(): void {
    for (const off of this.disposers.splice(0)) off();
    this.reels.clear();
    this.bannerLayer.clear();
    this.toasts.clear();
    this.hud.feed.clear();
    this.hud.captions.clear();
    this.connecting.onHide();
    this.events.clear();
    this.root.replaceChildren();
    this.root.classList.remove("rr-ui");
  }

  /* ============================================================= internals */

  /** This UI's own keyboard claim (registered as a key gate; capturesInput ORs every gate). */
  private ownCaptures(): boolean {
    return (this.openPanelId !== null && this.openPanelId !== "legend") || isTyping();
  }

  private applyScreen(screen: Screen, prev: Screen | null): void {
    const inGame = screen === "game";
    this.setScreenVisible(this.home.el, screen === "home");
    this.setScreenVisible(this.lobby.el, screen === "lobby");
    this.setScreenVisible(this.connecting.el, screen === "connecting");
    this.setScreenVisible(this.matchEnd.el, screen === "matchEnd");
    this.hud.setVisible(inGame);
    this.coachTips.setEnabled(inGame);
    if (!inGame) {
      this.scoreboard.set(null);
      if (this.openPanelId && this.openPanelId !== "settings") this.openPanel(null);
      this.reels.clear();
    }
    if (screen === "home" || screen === "lobby") {
      this.bannerLayer.clear();
      this.hud.feed.clear();
    }
    if (!inGame) this.hud.captions.clear();
    if (screen === "connecting") this.connecting.onShow();
    else this.connecting.onHide();
    if (screen === "home" && prev !== "home") this.home.onShow();
    if (screen === "matchEnd" && prev !== "matchEnd") this.matchEnd.onShow();
    this.root.dataset.screen = screen;
    this.renderVeil();
    this.renderGear();
  }

  private setScreenVisible(node: HTMLElement, visible: boolean): void {
    if (node.hidden === !visible) return;
    if (!visible && document.activeElement instanceof HTMLElement && node.contains(document.activeElement)) document.activeElement.blur();
    node.hidden = !visible;
    node.inert = !visible;
    if (visible) play(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
  }

  private showPanel(panel: Exclude<Panel, null>): void {
    switch (panel) {
      case "craft":
        this.craftPanel.el.hidden = false;
        this.craftPanel.onOpen();
        break;
      case "chest":
        this.chestPanel.el.hidden = false;
        this.chestPanel.onOpen();
        break;
      case "settings":
        this.settingsMenu.open(this.current !== "home" && this.current !== "connecting", this.current === "game");
        break;
      case "legend":
        this.legend.setOpen(true, this.hud.feed.history, this.hud.feed.version);
        break;
      case "pingWheel":
        this.pingWheel.open();
        break;
      case "emoteWheel":
        this.emoteWheel.open();
        break;
    }
  }

  private hidePanel(panel: Exclude<Panel, null>): void {
    // The browser drops the focus of a hidden tile only later: blur it now, so the veil (shown right after) can
    // give its Play button the focus.
    const blur = (node: HTMLElement): void => {
      if (document.activeElement instanceof HTMLElement && node.contains(document.activeElement)) document.activeElement.blur();
    };
    switch (panel) {
      case "craft":
        blur(this.craftPanel.el);
        this.craftPanel.el.hidden = true;
        break;
      case "chest":
        blur(this.chestPanel.el);
        this.chestPanel.el.hidden = true;
        this.chestPanel.onClose();
        break;
      case "settings":
        this.settingsMenu.close();
        break;
      case "legend":
        this.legend.setOpen(false, this.hud.feed.history, this.hud.feed.version);
        break;
      case "pingWheel":
        this.pingWheel.close();
        break;
      case "emoteWheel":
        this.emoteWheel.close();
        break;
    }
  }

  /** The UI itself closed the open panel (Esc, ✕, click outside, a pick): tell the app so it re-locks the pointer. */
  private closeFromUi(): void {
    if (!this.openPanelId) return;
    this.openPanel(null);
    if (this.current === "game") this.events.emit("closePanel", undefined);
  }

  private renderVeil(): void {
    const panelOpen = this.openPanelId !== null && this.openPanelId !== "legend";
    this.veil.setVisible(this.current === "game" && this.needsPointer && !panelOpen);
  }

  private renderGear(): void {
    setHidden(this.gear, !(this.current === "home" || this.current === "lobby") || this.openPanelId === "settings");
  }

  /* ================================================================== keys */

  /** True when this key event was created before the current panel opened (it is the opener, not a close). */
  private isOpener(e: Event): boolean {
    return e.timeStamp <= this.openedAt;
  }

  private onKeyDown(e: KeyboardEvent): void {
    const panel = this.openPanelId;
    if (!panel || panel === "legend" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.isOpener(e)) return;
    const code = e.code;
    const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
    const n = digit ? Number(digit[1]) : 0;
    // The active key preset's meaning of this key (E / V / T are U / N / Y left-handed).
    const bound = bindingFor(code, settings.get().keyPreset);
    let handled = false;
    if (code === "Escape") {
      if (panel === "settings" && this.settingsMenu.escape()) handled = true;
      else {
        this.closeFromUi();
        handled = true;
      }
    } else if (isTyping()) {
      return;
    } else if (panel === "craft" || panel === "chest") {
      if (bound?.level === "interact" && !e.repeat) {
        this.closeFromUi();
        handled = true;
      } else if (panel === "craft" && n >= 1 && n <= 9 && !e.repeat) {
        this.craftPanel.craftIndex(n);
        handled = true;
      } else {
        handled = panel === "chest" ? this.chestPanel.onKey(e) : this.craftPanel.onKey(e);
      }
    } else if (panel === "pingWheel") {
      if (bound?.hotkey === "pingWheel" && !e.repeat) {
        this.closeFromUi();
        handled = true;
      } else if (n >= 1 && !e.repeat) handled = this.pingWheel.pickIndex(n);
    } else if (panel === "emoteWheel") {
      if (bound?.hotkey === "emoteChord" && !e.repeat) {
        this.closeFromUi();
        handled = true;
      } else if (n >= 1 && !e.repeat) handled = this.emoteWheel.pickIndex(n);
    }
    if (e.repeat && (bound?.hotkey === "pingWheel" || bound?.hotkey === "emoteChord" || bound?.level === "interact")) handled = true;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    const panel = this.openPanelId;
    const hotkey = bindingFor(e.code, settings.get().keyPreset)?.hotkey;
    if (panel === "legend" && hotkey === "legend") {
      this.openPanel(null);
      return;
    }
    if (panel === "pingWheel" && hotkey === "pingWheel" && this.pingWheel.release()) e.stopPropagation();
    else if (panel === "emoteWheel" && hotkey === "emoteChord" && this.emoteWheel.release()) e.stopPropagation();
  }

  private onMouseUp(e: MouseEvent): void {
    if (e.button === 1 && this.openPanelId === "pingWheel" && this.pingWheel.release()) e.stopPropagation();
  }

  private listen(target: Window, type: string, fn: (e: Event) => void, capture = false): void {
    target.addEventListener(type, fn, capture);
    this.disposers.push(() => target.removeEventListener(type, fn, capture));
  }

  /* ================================================================ sounds */

  /** One delegated listener gives every button and link its click / hover sound. */
  private wireSounds(): void {
    const onClick = (e: Event) => {
      const target = this.interactiveFrom(e.target);
      if (!target) return;
      if (target.getAttribute("aria-disabled") === "true") {
        this.events.emit("sound", { name: "uiError" });
        return;
      }
      this.events.emit("sound", { name: "uiClick" });
    };
    const onOver = (e: Event) => {
      const target = this.interactiveFrom(e.target);
      if (target === this.hovered) return;
      this.hovered = target;
      if (!target || target.dataset.hover === "off" || target.getAttribute("aria-disabled") === "true") return;
      const now = performance.now();
      if (now - this.lastHoverSound < HOVER_SOUND_GAP_MS) return;
      this.lastHoverSound = now;
      this.events.emit("sound", { name: "uiHover" });
    };
    this.root.addEventListener("click", onClick, true);
    this.root.addEventListener("pointerover", onOver);
    this.disposers.push(() => {
      this.root.removeEventListener("click", onClick, true);
      this.root.removeEventListener("pointerover", onOver);
    });
  }

  private interactiveFrom(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const hit = target.closest<HTMLElement>("button, a[href], summary");
    if (!hit || !this.root.contains(hit)) return null;
    if (hit instanceof HTMLButtonElement && hit.disabled) return null;
    return hit;
  }
}
