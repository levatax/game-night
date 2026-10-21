// Boot + screen state machine (home → connecting → lobby → game → matchEnd → lobby) + the one rAF loop.
// Owner: client-app. Adapted from games/bonk-brawl/client/src/app/App.ts.
//
// App owns every long-lived module (each built with make() and wrapped by guard(), so a broken module logs once
// and the game keeps running): Renderer(#game), Ui(#ui), Input(#game), AudioEngine(settings), Net, Characters and
// Fx (renderer scene + camera), GameController.
//
// Boot (start()): apply settings (renderer quality, input sensitivity / invert, language reload), unlock audio on
// the first gesture, show a locally generated backdrop island behind the home screen, then: a reconnect ticket in
// sessionStorage → "connecting" + net.tryReconnect() (page reload / language switch), unless the address bar invites
// to another room (then the ticket is dropped and the link followed); else home, prefilled from a `?room=CODE` /
// `/r/CODE` deep link (auto-join when a nickname is saved, unless Home's keyboard + mouse card is due).
//
// Screens follow the room phase (net events, never timers): lobby → "lobby" (island preview orbit), landing /
// playing / launch / storm → "game" (GameController.enter; mid-match joiners spectate), matchEnd → "matchEnd"
// (GameController keeps rendering the podium orbit), disconnected → "home" with the error. Flow messages beat the
// patch that changes the phase (PhaseTracker), so the screen switches on the message.
//
// Input modes (every frame): the game screen enables the in-game hotkeys; gameplay input + pointer lock only
// while the local castaway plays in first person; panels / wheels / menus capture the input (Input.setCapture).
//
// Edges: a mid-match drop shows the persistent "Reconnecting… (attempt n)" pill for Net's whole retry window and
// hands the mouse back (GameController.wantsPointer is false while not connected, the world is frozen by Net);
// on return the "click to play" veil asks for it again. A lost WebGL context shows the reload card the same way.
// A reload whose ticket was refused (seat expired) toasts why the deep-link auto-join of the ticket's room made you a
// new castaway.
// The index.html loading splash goes once the first screen is up.

import { CODE_PATTERN, DEFAULT_CHARACTER } from "../../../shared/constants";
import { generateIsland } from "../../../shared/island/generate";
import type { IslandDef } from "../../../shared/island/types";
import type { NoticeMsg } from "../../../shared/protocol";
import type { CharacterId, EmoteId, MarkerKind, RaftStateView } from "../../../shared/types";
import { AudioEngine } from "../audio/AudioEngine";
import { Characters } from "../characters/Characters";
import { Fx } from "../fx/Fx";
import { has, lang, setLanguage, t } from "../i18n";
import { Input, type CaptureMode } from "../input/Input";
import { Net } from "../net/Net";
import type { NetError } from "../net/types";
import { Renderer } from "../render/Renderer";
import type { WorldFrame } from "../render/types";
import type { Screen } from "../ui/models";
import { browserMedia, deviceNoticeDue, sessionStore } from "../ui/screens/homeState";
import { Ui } from "../ui/Ui";
import { CameraDirector } from "./cinematics";
import { Coach } from "./coach";
import { noticeText } from "./flow";
import { PhaseTracker } from "./frameHelpers";
import { GameController } from "./GameController";
import { guard, logOnce, make } from "./guard";
import { AutoQuality } from "./quality";
import {
  cleanNickname,
  copyText,
  delay,
  dropStaleTicket,
  hasReconnectToken,
  parseRoomCode,
  readRoomCodeFromUrl,
  reconnectTicketRoom,
  ReconnectWindow,
  SeatExpiry,
  setRoomInUrl,
  shareLink,
} from "./session";
import { settings, type Settings } from "./settings";
import { dismissSplash } from "./splash";
import { buildHomeModel, buildLobbyModel, buildMatchEndModel } from "./viewModels";

/** Frame time cap: a background tab or a debugger pause must not explode the simulation. */
const MAX_FRAME_DT = 0.25;
const PORTAL_URL = "/";
const PORTAL_LEAVE_TIMEOUT_MS = 1000;
const MAX_LOGGED_FRAME_ERRORS = 5;
/** Lobby portraits render lazily: re-check the lobby model this often while some are missing. */
const LOBBY_REFRESH_MS = 500;
/** The menu island: golden hour (fraction of the day phase). */
const MENU_DAY_FRACTION = 0.72;

type ConnectKind = "create" | "join";

/** Thrown when the page can't run the game at all (no WebGL); main.ts shows the fatal card. */
export class FatalError extends Error {}

export class App {
  private readonly autoQuality: AutoQuality;
  private readonly renderer: Renderer;
  private readonly ui: Ui;
  private readonly input: Input;
  private readonly audio: AudioEngine;
  private readonly net: Net;
  private readonly characters: Characters;
  private readonly fx: Fx;
  private readonly phases = new PhaseTracker();
  private readonly reconnect = new ReconnectWindow();
  private readonly seatExpiry = new SeatExpiry();
  private readonly coach: Coach;
  private readonly game: GameController;
  private readonly menuCamera: CameraDirector;

  private started = false;
  private screen: Screen | null = null;
  /** A create / join is in flight (its own error handling owns the home screen). */
  private busy = false;
  /** Id of the latest create / join attempt (a cancelled one is ignored when it settles). */
  private connectAttempt = 0;
  /** A consented leave is in flight: late patches must not pull us back into the room. */
  private leaving = false;
  private homeCode = "";
  private homeError: string | null = null;
  /** Code of the room we're in (prefills a quick rejoin after an unexpected drop). */
  private roomCode = "";
  private lobbySig = "";
  private lobbyRefreshAt = 0;
  private matchEndSig = "";
  private audioUnlocked = false;
  private lastFrameMs = 0;
  private menuElapsed = 0;
  private frameErrors = 0;
  private backdrop: IslandDef | null = null;
  private readonly menuWorld: WorldFrame;

  constructor(gameRoot: HTMLElement, uiRoot: HTMLElement) {
    // Before the renderer reads the quality: on Auto every boot picks one from the device.
    this.autoQuality = new AutoQuality(settings);
    const renderer = make("renderer", () => new Renderer(gameRoot, settings.get().quality));
    if (!renderer.ok || !renderer.value.supported) throw new FatalError("WebGL unavailable");
    this.renderer = guard("renderer", renderer.value, ["fp"]);
    this.ui = guard("ui", make("ui", () => new Ui(uiRoot)).value);
    this.input = guard("input", make("input", () => new Input(gameRoot)).value);
    this.audio = guard("audio", make("audio", () => new AudioEngine(settings)).value);
    this.net = guard("net", make("net", () => new Net()).value);
    this.characters = guard("characters", make("characters", () => new Characters(renderer.value.scene, renderer.value.camera)).value, ["fpArms", "monsters"]);
    this.fx = guard("fx", make("fx", () => new Fx(renderer.value.scene, renderer.value.camera)).value);
    this.coach = new Coach(this.ui, settings);
    this.game = new GameController({
      net: this.net,
      input: this.input,
      renderer: this.renderer,
      characters: this.characters,
      fx: this.fx,
      audio: this.audio,
      ui: this.ui,
      phases: this.phases,
      coach: this.coach,
    });
    this.menuCamera = new CameraDirector(this.renderer.fp);
    this.menuWorld = {
      phase: "lobby",
      clockTicks: 0,
      timings: this.net.timings,
      weather: "clear",
      biome: "tropic",
      nodes: [],
      teams: [],
      structures: [],
      lights: [],
      focus: { x: 0, y: 2, z: 0 },
      launch: 0,
      storm: 0,
      secretShown: [],
      reducedFlashing: false,
    };
    this.autoQuality.onStepDown = () => this.ui.toast(t("feed.qualityLowered"), "info");
    this.renderer.onContextChange = (lost) => this.onGraphicsContext(lost);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.applySettings(settings.get(), null);
    settings.onChange((next, changed) => this.applySettings(next, changed));
    this.installAudioUnlock();
    this.bindNet();
    this.bindUi();
    this.bindInput();
    window.addEventListener("resize", () => this.renderer.resize());
    this.showBackdrop();

    this.homeCode = readRoomCodeFromUrl() ?? "";
    this.enterScreen("home");
    requestAnimationFrame(this.loop);
    dismissSplash();

    // An invite to another room than the ticket's, opened in a tab that still held one: follow the link (the old
    // seat is left to its grace window, then a bot). The ticket's own room, or no link, rejoins below.
    dropStaleTicket(this.homeCode);
    if (hasReconnectToken()) {
      // Read first: a refused ticket is forgotten by tryReconnect().
      const ticketRoom = reconnectTicketRoom();
      this.ui.setConnecting(has("menu.reconnecting") ? t("menu.reconnecting") : "");
      this.enterScreen("connecting");
      if (await this.net.tryReconnect()) {
        this.syncScreen();
        return;
      }
      // The old seat is gone (a bot plays it now): a deep-link join of that same room takes a new one; say so when
      // it lands.
      this.seatExpiry.expired(this.homeCode, ticketRoom);
      this.enterScreen("home");
    }
    this.autoJoinDeepLink();
  }

  /* ============================================================ settings */

  /** `changed` null = apply everything (boot). */
  private applySettings(s: Readonly<Settings>, changed: ReadonlyArray<keyof Settings> | null): void {
    const has = (...keys: Array<keyof Settings>): boolean => changed === null || keys.some((k) => changed.includes(k));
    // The renderer was built with the boot quality already.
    if (changed !== null && has("quality")) this.renderer.setQuality(s.quality);
    if (has("quality")) {
      this.fx.setQuality(s.quality);
      this.audio.setSpatialQuality(s.quality !== "low");
    }
    if (has("reducedFlashing")) this.fx.setReducedFlashing(s.reducedFlashing);
    if (has("mouseSensitivity", "invertY")) this.input.configure({ sensitivity: s.mouseSensitivity, invertY: s.invertY });
    // A language change from the settings menu reloads the page (the room is rejoined via the ticket).
    if (changed !== null && has("language") && s.language !== lang()) setLanguage(s.language);
  }

  /* =============================================================== audio */

  /** Browsers only start audio from a user gesture; unlock() is idempotent and also resumes. */
  private installAudioUnlock(): void {
    const unlock = (): void => {
      this.audio.unlock();
      if (!this.audioUnlocked) {
        this.audioUnlocked = true;
        this.game.refreshAudio();
      }
    };
    for (const type of ["pointerdown", "keydown", "touchend"]) window.addEventListener(type, unlock, { capture: true, passive: true });
  }

  /* ================================================================= net */

  private bindNet(): void {
    const ev = this.net.events;
    ev.on("connected", (e) => this.onConnected(e.code, e.reconnected));
    ev.on("reconnecting", (e) => this.onReconnecting(e.attempt));
    ev.on("disconnected", (e) => this.onDisconnected(e.error));
    ev.on("phase", () => this.syncScreen());
    ev.on("state", (s) => this.onState(s));
    ev.on("island", (e) => this.onIsland(e.mismatch));
    ev.on("notice", (n) => this.onNotice(n));
    // Flow messages announce the phase one patch early (GameController announces matchStart / matchEnd).
    ev.on("matchStart", () => this.syncScreen());
    ev.on("matchEnd", () => {
      this.matchEndSig = "";
      this.syncScreen();
    });
    ev.on("raftLaunch", (e) => {
      this.phases.announce("launch", e.tick);
      this.syncScreen();
    });
    ev.on("storm", (e) => {
      this.phases.announce("storm", e.tick);
      this.syncScreen();
    });
  }

  private onConnected(code: string, reconnected: boolean): void {
    this.leaving = false;
    this.roomCode = code;
    this.homeCode = "";
    this.homeError = null;
    setRoomInUrl(code);
    if (this.reconnect.close()) this.ui.setReconnecting(null);
    if (reconnected) this.ui.toast(t("feed.connBack"), "good");
    this.syncScreen();
  }

  /**
   * Net lost the room and retries the ticket (attempt n, for up to RECONNECT_GRACE_SEC): the pill stays up the whole
   * time. On the first attempt the mouse is handed back (wantsPointer is already false: not connected), so the
   * player isn't stuck in a pointer lock over a frozen world; the veil asks for it again after the reconnect.
   */
  private onReconnecting(attempt: number): void {
    const opened = this.reconnect.attempted(attempt);
    this.ui.setReconnecting(this.reconnect.attempt);
    if (!opened) return;
    this.updateInputMode();
    this.input.exitPointerLock();
  }

  /** The WebGL context was lost (reload card, mouse handed back) or restored and rebuilt (card gone, veil asks again). */
  private onGraphicsContext(lost: boolean): void {
    this.ui.setGraphicsLost(lost);
    this.updateInputMode();
    if (lost) this.input.exitPointerLock();
  }

  private onDisconnected(error: NetError | null): void {
    this.leaving = false;
    this.phases.clear();
    setRoomInUrl(null);
    if (this.reconnect.close()) this.ui.setReconnecting(null);
    // A create / join in flight shows its own error on the home screen.
    if (this.busy) return;
    if (error) {
      // Unexpected drop: prefill the code so rejoining is one click; the home screen shows why.
      this.homeCode = this.roomCode;
      this.homeError = error.message || "menu.errUnknown";
      this.audio.play("uiError");
    }
    this.roomCode = "";
    this.enterScreen("home");
  }

  private onState(state: RaftStateView): void {
    this.syncScreen();
    if (this.screen === "lobby") this.renderLobby(state);
  }

  private onIsland(mismatch: boolean): void {
    const def = this.net.island;
    if (def) this.showIsland(def);
    if (mismatch) this.ui.toast(t("feed.islandMismatch"), "warn");
    this.lobbySig = "";
  }

  /** The island to show: the scene, the fx ground and the island's own tune. */
  private showIsland(def: IslandDef): void {
    this.renderer.loadIsland(def);
    this.fx.setIsland(def);
    this.audio.setMusicSeed(def.seed);
  }

  private onNotice(n: NoticeMsg): void {
    this.ui.toast(noticeText(n), "info");
  }

  /** Pick the screen for the room phase. Idempotent; ignores everything while not in a room. */
  private syncScreen(): void {
    if (this.leaving || this.net.status !== "connected") return;
    const state = this.net.state;
    if (!state) return;
    const phase = this.phases.effective(state);
    this.enterScreen(phase === "lobby" ? "lobby" : phase === "matchEnd" ? "matchEnd" : "game");
  }

  /* ============================================================= screens */

  private enterScreen(target: Screen): void {
    if (target === this.screen) return;
    const previous = this.screen;
    this.screen = target;
    switch (target) {
      case "home":
        this.game.exit();
        this.closeMenus();
        this.showBackdrop();
        this.renderHome();
        break;
      case "connecting":
        break;
      case "lobby":
        this.game.exit();
        this.closeMenus();
        this.lobbySig = "";
        if (this.net.island) this.showIsland(this.net.island);
        if (this.net.state) this.renderLobby(this.net.state);
        break;
      case "game":
        this.game.enter();
        break;
      case "matchEnd":
        this.game.enter();
        this.matchEndSig = "";
        this.renderMatchEnd();
        break;
    }
    if (previous === "game" && target !== "game") this.game.setScoreboardOpen(false);
    this.ui.showScreen(target);
    this.updateInputMode();
  }

  private closeMenus(): void {
    if (this.ui.panel !== null) this.ui.openPanel(null);
  }

  /** A cosmetic island behind the home screen (random seed, generated locally). */
  private showBackdrop(): void {
    if (this.renderer.islandDef) return;
    try {
      this.backdrop ??= generateIsland((Math.random() * 0xffffffff) >>> 0);
      this.showIsland(this.backdrop);
    } catch (err) {
      logOnce("backdrop island", err);
    }
  }

  private renderHome(): void {
    this.ui.setHome(buildHomeModel({ nickname: settings.get().nickname, joinCode: this.homeCode, busy: this.busy, error: this.homeError, language: lang() }));
  }

  private renderLobby(state: RaftStateView): void {
    const code = this.net.code || this.roomCode;
    const model = buildLobbyModel(state, this.net.sessionId, code, shareLink(code), (c) => this.characters.portrait(c) ?? "");
    const sig = JSON.stringify(model);
    if (sig === this.lobbySig) return;
    this.lobbySig = sig;
    this.ui.setLobby(model);
  }

  /** Rebuilt when what it shows changes (countdown, rematch unlock, players, standings). */
  private renderMatchEnd(): void {
    const state = this.net.state;
    if (!state) return;
    const model = buildMatchEndModel(state, this.net.sessionId, this.game.matchEnd, this.net.timings, this.game.directory);
    const sig = JSON.stringify(model);
    if (sig === this.matchEndSig) return;
    this.matchEndSig = sig;
    this.ui.setMatchEnd(model);
  }

  /* =============================================================== input */

  private bindInput(): void {
    const ev = this.input.events;
    ev.on("menu", ({ captured }) => this.onMenuKey(captured));
    ev.on("scoreboard", ({ open }) => {
      if (this.screen === "game") this.game.setScoreboardOpen(open);
    });
    ev.on("legend", ({ open }) => this.onLegend(open));
    ev.on("pingWheel", () => this.onPingWheel());
    ev.on("emoteWheel", ({ open }) => this.onEmoteWheel(open));
    ev.on("wheelPick", ({ index }) => {
      if (this.game.pickWheel(index)) this.closeWheel(true);
    });
    ev.on("interact", () => this.game.onInteractKey());
    ev.on("panelKey", () => this.game.onPanelKey());
    ev.on("mute", () => {
      const muted = !settings.get().muted;
      settings.set({ muted });
      this.ui.toast(t(muted ? "feed.muted" : "feed.unmuted"), "info");
    });
  }

  /** How much the open panel owns the input (legend: none, craft / chest: walk only, menus / wheels: all). */
  private captureMode(): CaptureMode {
    const panel = this.ui.panel;
    if (panel === "craft" || panel === "chest") return "panel";
    if (panel === "legend") return "none";
    if (panel === "pingWheel" || panel === "emoteWheel" || panel === "settings") return "full";
    return this.ui.capturesInput ? "full" : "none";
  }

  /** Every frame: which input the game screen takes right now. */
  private updateInputMode(): void {
    const inGame = this.screen === "game";
    this.input.setInGame(inGame);
    this.input.setCapture(this.captureMode());
    this.input.setEnabled(inGame && this.game.wantsPointer);
  }

  /** Esc: closes whatever is open (and resumes), else opens the settings menu. */
  private onMenuKey(captured: boolean): void {
    if (this.screen === "connecting" || this.screen === null) return;
    const panel = this.ui.panel;
    if (captured || (panel !== null && panel !== "legend")) {
      if (panel === "pingWheel") this.game.cancelPing();
      this.ui.openPanel(null);
      this.updateInputMode();
      if (this.screen === "game") this.input.requestPointerLock();
      return;
    }
    this.ui.openPanel("settings");
    this.audio.play("uiOpen");
    this.updateInputMode();
  }

  private onLegend(open: boolean): void {
    if (this.screen !== "game") return;
    const panel = this.ui.panel;
    if (open && panel === null) this.ui.openPanel("legend");
    else if (!open && panel === "legend") this.ui.openPanel(null);
  }

  private onPingWheel(): void {
    if (this.screen !== "game") return;
    if (this.ui.panel === "pingWheel") {
      this.game.cancelPing();
      this.closeWheel(true);
      return;
    }
    if (this.ui.panel !== null && this.ui.panel !== "legend") return;
    if (this.game.openPingWheel()) this.updateInputMode();
  }

  /** T: open the emote wheel (only for a castaway in the match), or close it. */
  private onEmoteWheel(open: boolean): void {
    if (this.screen !== "game") return;
    if (!open) {
      if (this.ui.panel === "emoteWheel") this.closeWheel(true);
      return;
    }
    if (this.ui.panel !== null && this.ui.panel !== "legend") return;
    if (!this.game.wantsPointer) return;
    this.ui.openPanel("emoteWheel");
    this.updateInputMode();
  }

  /** Close the ping / emote wheel; `relock` from a user gesture (key / click) takes the pointer back. */
  private closeWheel(relock: boolean): void {
    const panel = this.ui.panel;
    if (panel === "pingWheel" || panel === "emoteWheel") this.ui.openPanel(null);
    this.updateInputMode();
    if (relock && this.screen === "game") this.input.requestPointerLock();
  }

  /* ================================================================== UI */

  private bindUi(): void {
    const ev = this.ui.events;
    ev.on("create", ({ nickname }) => void this.connect("create", nickname, ""));
    ev.on("join", ({ code, nickname }) => void this.connect("join", nickname, code));
    ev.on("leave", () => void this.leaveRoom());
    ev.on("ready", ({ ready }) => this.net.send("ready", { ready }));
    ev.on("character", ({ character }) => this.selectCharacter(character));
    ev.on("roomSettings", (patch) => this.net.send("settings", patch));
    ev.on("start", () => this.net.send("start", {}));
    ev.on("addBot", () => this.net.send("addBot", {}));
    ev.on("removeBot", ({ id }) => this.net.send("removeBot", { id }));
    ev.on("copyLink", () => void this.copyLink());
    ev.on("rematch", ({ ready }) => this.net.send("rematch", { ready }));
    ev.on("craft", ({ recipe }) => this.net.send("craft", { recipe }));
    ev.on("chest", (msg) => this.net.send("chest", msg));
    ev.on("selectSlot", ({ slot }) => this.input.selectSlot(slot));
    ev.on("closePanel", () => this.onUiClosedPanel());
    ev.on("marker", ({ kind }) => this.onUiMarker(kind));
    ev.on("emote", ({ emote }) => this.onUiEmote(emote));
    ev.on("settings", (patch) => {
      settings.set(patch);
      if (patch.autoQuality === true) this.autoQuality.reguess(); // "Auto" clicked while already on: re-guess too
    });
    ev.on("language", ({ lang: next }) => setLanguage(next));
    ev.on("resume", () => this.resume());
    ev.on("sound", ({ name }) => this.audio.play(name));
  }

  /** The UI closed a panel itself (Esc, a click outside, its close button). */
  private onUiClosedPanel(): void {
    this.game.cancelPing();
    if (this.ui.panel === "craft" || this.ui.panel === "chest" || this.ui.panel === "pingWheel" || this.ui.panel === "emoteWheel") this.ui.openPanel(null);
    this.ui.setCraftPanel(null);
    this.ui.setChestPanel(null);
    this.updateInputMode();
    // Called from the UI's click / key handler: the pointer can be locked again right now.
    if (this.screen === "game") this.input.requestPointerLock();
  }

  private onUiMarker(kind: MarkerKind): void {
    this.game.sendMarker(kind);
    this.closeWheel(true);
  }

  private onUiEmote(emote: EmoteId): void {
    this.game.sendEmote(emote);
    if (this.ui.panel === "emoteWheel") this.closeWheel(true);
  }

  /** "Click to play" veil / settings "resume": must run inside the user gesture so pointer lock is allowed. */
  private resume(): void {
    if (this.ui.panel === "settings") this.ui.openPanel(null);
    this.updateInputMode();
    if (this.screen === "game") this.input.requestPointerLock();
  }

  private async copyLink(): Promise<void> {
    const code = this.net.code || this.roomCode;
    if (!code) return;
    const ok = await copyText(shareLink(code));
    this.ui.toast(t(ok ? "feed.linkCopied" : "feed.linkCopyFailed"), ok ? "good" : "warn");
  }

  private inRoom(): boolean {
    const status = this.net.status;
    return status === "connecting" || status === "connected" || status === "reconnecting";
  }

  private async connect(kind: ConnectKind, rawNickname: string, rawCode: string): Promise<void> {
    if (this.busy || this.inRoom()) return;
    const nickname = cleanNickname(rawNickname);
    const code = kind === "join" ? parseRoomCode(rawCode) : "";
    if (!nickname || (kind === "join" && !code)) {
      this.homeError = nickname ? "menu.errNotFound" : "menu.errBadNickname";
      this.homeCode = rawCode.trim().toUpperCase();
      this.audio.play("uiError");
      if (this.screen === "home") this.renderHome();
      else this.enterScreen("home");
      return;
    }
    settings.set({ nickname });
    // Each attempt has an id: Cancel on the connecting screen bumps it, so a late result is ignored.
    const attempt = ++this.connectAttempt;
    this.busy = true;
    this.homeCode = code ?? "";
    this.homeError = null;
    this.renderHome();
    this.ui.setConnecting("");
    this.enterScreen("connecting");
    const character: CharacterId = settings.get().lastCharacter ?? DEFAULT_CHARACTER;
    try {
      if (kind === "create") await this.net.createRoom({ nickname, character });
      else await this.net.joinRoom(code!, { nickname, character });
      if (attempt !== this.connectAttempt) return;
      this.busy = false;
      this.syncScreen();
      if (this.seatExpiry.settle(code ?? "", true)) this.ui.toast(t("feed.seatExpired"), "warn");
    } catch (err) {
      this.seatExpiry.settle(code ?? "", false);
      if (attempt !== this.connectAttempt) return;
      this.busy = false;
      this.homeError = netErrorKey(err);
      this.audio.play("uiError");
      if (this.screen === "home") this.renderHome();
      else this.enterScreen("home");
    }
  }

  private autoJoinDeepLink(): void {
    // No mouse yet in this tab: Home's keyboard + mouse card goes first (the invite code waits in the form).
    if (deviceNoticeDue(browserMedia(), sessionStore())) return;
    const nickname = cleanNickname(settings.get().nickname);
    if (this.homeCode && CODE_PATTERN.test(this.homeCode) && nickname && this.screen === "home") void this.connect("join", nickname, this.homeCode);
  }

  private selectCharacter(character: CharacterId): void {
    settings.set({ lastCharacter: character });
    this.net.send("character", { character });
  }

  private async leaveRoom(): Promise<void> {
    if (!this.inRoom()) {
      window.location.href = PORTAL_URL;
      return;
    }
    this.leaving = true;
    this.roomCode = "";
    this.homeCode = "";
    setRoomInUrl(null);
    if (this.busy) {
      // Cancelled while still connecting: forget that attempt and give the home screen back at once.
      this.connectAttempt++;
      this.busy = false;
      this.homeError = null;
    }
    this.enterScreen("home");
    try {
      await Promise.race([this.net.leave(), delay(PORTAL_LEAVE_TIMEOUT_MS)]);
    } finally {
      this.leaving = false;
    }
  }

  /* ================================================================ loop */

  private readonly loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const realDt = this.lastFrameMs > 0 ? Math.min(MAX_FRAME_DT, Math.max(0, (now - this.lastFrameMs) / 1000)) : 0;
    this.lastFrameMs = now;
    try {
      this.tick(now, realDt);
    } catch (err) {
      // Keep the loop alive; log only the first few so one bad frame can't flood the console.
      if (this.frameErrors++ < MAX_LOGGED_FRAME_ERRORS) console.error("[raft-rush] frame failed", err);
    }
  };

  private tick(now: number, realDt: number): void {
    this.updateInputMode();
    if (this.game.active) {
      this.game.frame(now, realDt);
      // Frames drawn without a WebGL context say nothing about the GPU.
      if (this.screen === "game" && !this.renderer.contextLost) this.autoQuality.frame(now);
      else this.autoQuality.pause();
    } else {
      this.autoQuality.pause();
      this.menuFrame(now, realDt);
    }
    if (this.screen === "matchEnd") this.renderMatchEnd();
    if (this.screen === "lobby" && now >= this.lobbyRefreshAt) {
      this.lobbyRefreshAt = now + LOBBY_REFRESH_MS;
      const state = this.net.state;
      if (state) this.renderLobby(state);
    }
  }

  /** Home / connecting / lobby: the island preview at golden hour, orbiting. */
  private menuFrame(now: number, realDt: number): void {
    const dt = Math.min(realDt, 0.1);
    this.menuElapsed += dt;
    const state = this.net.state;
    const island = this.renderer.islandDef ?? this.net.island ?? this.backdrop;
    const w = this.menuWorld;
    const timings = this.net.timings;
    w.timings = timings;
    w.clockTicks = timings.day * MENU_DAY_FRACTION;
    w.biome = island?.biome ?? state?.biome ?? "tropic";
    w.weather = "clear";
    w.nodes = state && state.phase === "lobby" && island && state.nodes.length === island.nodes.length ? state.nodes : [];
    w.teams = state?.teams ?? [];
    w.reducedFlashing = settings.get().reducedFlashing;
    this.renderer.update(dt, this.menuElapsed, w);
    this.menuCamera.update({
      phase: "lobby",
      state: null,
      me: null,
      local: null,
      look: { yaw: 0, pitch: 0 },
      island,
      timings,
      raft: null,
      fov: settings.get().fov,
      headBob: false,
      realDt,
      nowMs: now,
    });
    this.renderer.render();
    this.game.menuSound(dt);
  }
}

/** The menu.err* key of a failed create / join (Net rejects with a NetError whose message is that key). */
function netErrorKey(err: unknown): string {
  if (typeof err === "object" && err !== null && typeof (err as Partial<NetError>).message === "string") {
    const m = (err as NetError).message;
    if (m.startsWith("menu.")) return m;
  }
  return "menu.errUnknown";
}
