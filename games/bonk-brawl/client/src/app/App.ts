// Boot + screen state machine. Owner: client-app.

import { EMOTE_COOLDOWN_TICKS, EMOTE_IDS, TICK_MS, playerColor } from "../../../shared/constants";
import type { NoticeKind, NoticeMsg, StandingEntry } from "../../../shared/protocol";
import type { CharacterId, EmoteId, Phase } from "../../../shared/types";
import { AudioEngine } from "../audio/AudioEngine";
import type { SfxId } from "../audio/Sfx";
import { CharacterPreview } from "../characters/CharacterPreview";
import { Characters } from "../characters/Characters";
import { createMenuCrowd } from "../characters/MenuCrowd";
import { Fx } from "../fx/Fx";
import { Input } from "../input/Input";
import { Net } from "../net/Net";
import type { NetError } from "../net/types";
import { CameraRig } from "../render/CameraRig";
import { MenuScene } from "../render/MenuScene";
import { Renderer } from "../render/Renderer";
import type { ScreenId, ToastKind, UiEventMap } from "../ui/models";
import { Ui } from "../ui/Ui";
import { GameController } from "./GameController";
import { delay, errorMessage, hasReconnectToken, readRoomCodeFromUrl, setRoomInUrl } from "./session";
import { settings, type Quality, type Settings } from "./settings";
import { buildLobbyModel, buildMatchEndModel, matchEndTiming } from "./viewModels";

/** Frame time cap: a background tab or a debugger pause must not explode the simulation. */
const MAX_FRAME_DT = 0.25;
const PORTAL_URL = "/";
/** Don't hang on a dead socket when leaving for the portal. */
const PORTAL_LEAVE_TIMEOUT_MS = 1000;
/** Same spacing as the server's emote rate limit, so the Q cycle never skips an emote. */
const EMOTE_COOLDOWN_MS = EMOTE_COOLDOWN_TICKS * TICK_MS;
const MAX_LOGGED_FRAME_ERRORS = 5;

const PARTICLE_SCALE: Readonly<Record<Quality, number>> = { low: 0.45, medium: 0.75, high: 1 };

const NOTICE_TOAST: Readonly<Record<NoticeKind, ToastKind>> = {
  joined: "info",
  left: "info",
  reconnecting: "warning",
  reconnected: "success",
  dropped: "warning",
  hostChanged: "info",
  cantStart: "warning",
  spectating: "info",
  rematch: "info",
  info: "info",
};

const UI_SOUND: Readonly<Record<UiEventMap["uiSound"]["kind"], SfxId>> = {
  click: "uiClick",
  hover: "uiHover",
  toggle: "uiToggle",
  error: "uiError",
};

type ConnectKind = "create" | "join";

/**
 * App owns every long-lived object and the requestAnimationFrame loop:
 *   settings (app/settings.ts), Renderer(#game), Ui(#ui), AudioEngine, Net, Input(#game),
 *   CameraRig(renderer.camera), Characters(renderer.scene), Fx(renderer.scene),
 *   MenuScene(renderer, createMenuCrowd), CharacterPreview(ui.previewCanvas), GameController.
 *
 * Boot (start()):
 *  1. Apply settings to renderer quality, audio volumes, input sensitivity/invert, camera FOV;
 *     subscribe to settings.onChange for live updates.
 *  2. Unlock audio on the first pointerdown/keydown anywhere.
 *  3. If sessionStorage has a reconnection token → screen "connecting" ("Reconnecting…"),
 *     net.tryReconnect(). Otherwise / on failure → "home". Deep link ?room=CODE (validated
 *     against CODE_PATTERN): prefill the code; if a nickname is saved, auto-join.
 *  4. Start the rAF loop: MenuScene.update while on home/lobby, GameController.frame while in game.
 *
 * Screen state machine (driven by net events, never by timers):
 *   no room                        → "home"     (MenuScene, music "lobby")
 *   create/join in flight          → "connecting"
 *   phase lobby                    → "lobby"    (MenuScene backdrop + CharacterPreview, music "lobby")
 *   countdown/playing/suddenDeath/roundEnd → "game" (GameController.enter; spectators too)
 *   matchEnd                       → "matchEnd" (GameController keeps rendering; podium overlay)
 *   disconnected                   → "home" + toast/error (Room full, No room with that code,
 *                                     Lost connection to the server…)
 * UI events → actions: createRoom/joinRoom (save nickname + lastCharacter in settings; character
 * = settings.lastCharacter), selectCharacter (net.sendCharacter + settings), setReady,
 * updateSettings, startMatch, rematch, leaveRoom (net.leave → home; history.replaceState to drop
 * ?room), backToPortal (net.leave then location.href = "/"), settingsChange (settings.set),
 * resume (input.requestPointerLock in the same gesture), emote (net.sendEmote), uiSound (audio).
 * Input events: menu → ui.openSettings + input.setEnabled(false); scoreboard → ui.setScoreboard;
 * emote (Q) → cycle honk → wave → dance and net.sendEmote; pointerLock false in game → click-to-play overlay.
 * The URL is kept in sync: after joining, history.replaceState to `?room=CODE` so a reload rejoins.
 */
export class App {
  private readonly renderer: Renderer;
  private readonly ui: Ui;
  private readonly audio = new AudioEngine();
  private readonly net = new Net();
  private readonly input: Input;
  private readonly camera: CameraRig;
  private readonly characters: Characters;
  private readonly fx: Fx;
  private readonly menu: MenuScene;
  private readonly preview: CharacterPreview;
  private readonly game: GameController;

  private started = false;
  private screen: ScreenId | null = null;
  /** A create/join is in flight (its own error handling owns the home screen). */
  private busy = false;
  /** A consented leave is in flight: late patches must not pull us back into the room. */
  private leaving = false;
  private homeCode = "";
  private homeError: string | null = null;
  /** Code of the room we're in, kept to prefill a quick rejoin after an unexpected drop. */
  private roomCode = "";
  /** Round-flow messages arrive one patch before the phase change they announce. */
  private phaseHint: { phase: Phase; tick: number } | null = null;
  private standings: StandingEntry[] | null = null;
  private matchEndKey = "";
  private previewKey = "";
  private previewRunning = false;
  private menuMusicOn = false;
  private clickToPlay = false;
  private emoteIndex = 0;
  private lastEmoteAt = -Infinity;
  private audioReady = false;
  private lastFrameMs = 0;
  private menuElapsed = 0;
  private frameErrors = 0;

  constructor(gameRoot: HTMLElement, uiRoot: HTMLElement) {
    this.renderer = new Renderer(gameRoot, settings.get().quality);
    this.ui = new Ui(uiRoot);
    this.input = new Input(gameRoot);
    this.camera = new CameraRig(this.renderer.camera);
    this.characters = new Characters(this.renderer.scene);
    this.fx = new Fx(this.renderer.scene);
    this.menu = new MenuScene(this.renderer, createMenuCrowd);
    this.preview = new CharacterPreview(this.ui.previewCanvas);
    this.game = new GameController({
      net: this.net,
      input: this.input,
      renderer: this.renderer,
      camera: this.camera,
      characters: this.characters,
      fx: this.fx,
      audio: this.audio,
      ui: this.ui,
    });
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

    this.homeCode = readRoomCodeFromUrl() ?? "";
    this.enterScreen("home");
    requestAnimationFrame(this.loop);

    if (hasReconnectToken()) {
      this.showConnecting("Reconnecting…");
      if (await this.net.tryReconnect()) {
        this.syncScreen();
        return;
      }
      this.enterScreen("home");
    }
    this.autoJoinDeepLink();
  }

  /* ============================================================ settings */

  /** `changed` null = apply everything (boot). */
  private applySettings(s: Readonly<Settings>, changed: ReadonlyArray<keyof Settings> | null): void {
    const has = (...keys: Array<keyof Settings>): boolean => changed === null || keys.some((k) => changed.includes(k));
    if (has("quality")) {
      // The renderer was built with the boot quality already.
      if (changed !== null) this.renderer.setQuality(s.quality);
      this.fx.particles.setQualityScale(PARTICLE_SCALE[s.quality]);
      this.audio.setSpatialQuality(s.quality !== "low");
    }
    if (has("masterVolume", "musicVolume", "sfxVolume")) this.audio.setVolumes(s.masterVolume, s.musicVolume, s.sfxVolume);
    if (has("mouseSensitivity", "invertY")) this.input.configure({ sensitivity: s.mouseSensitivity, invertY: s.invertY });
    if (has("fov")) this.camera.setBaseFov(s.fov);
  }

  /* =============================================================== audio */

  /** Browsers only start audio from a user gesture; unlock() is idempotent and also resumes. */
  private installAudioUnlock(): void {
    const unlock = (): void => this.audio.unlock();
    for (const type of ["pointerdown", "keydown", "touchend"]) {
      window.addEventListener(type, unlock, { capture: true, passive: true });
    }
  }

  /** Calls made before the unlock were silent no-ops: re-apply volumes and music once it's ready. */
  private pollAudio(): void {
    const ready = this.audio.ready;
    if (ready === this.audioReady) return;
    this.audioReady = ready;
    if (!ready) return;
    const s = settings.get();
    this.audio.setVolumes(s.masterVolume, s.musicVolume, s.sfxVolume);
    this.audio.playMusic(this.game.active ? this.game.musicTrack : "lobby");
  }

  private playMenuMusic(): void {
    if (this.menuMusicOn) return;
    this.menuMusicOn = true;
    this.audio.setMusicTempo(1);
    this.audio.playMusic("lobby");
  }

  /* ================================================================= net */

  private bindNet(): void {
    const ev = this.net.events;
    ev.on("connected", (e) => this.onConnected(e.code, e.reconnected));
    ev.on("reconnecting", (e) => {
      if (e.attempt <= 1) this.ui.toast("Connection lost. Reconnecting…", "warning");
    });
    ev.on("disconnected", (e) => this.onDisconnected(e.error));
    ev.on("phase", () => this.syncScreen());
    ev.on("state", () => this.onState());
    ev.on("roundStart", (e) => {
      this.phaseHint = { phase: "countdown", tick: e.tick };
      this.syncScreen();
    });
    ev.on("matchEnd", (e) => {
      this.standings = e.standings;
      this.phaseHint = { phase: "matchEnd", tick: e.tick };
      this.matchEndKey = "";
      this.syncScreen();
    });
    ev.on("notice", (n) => this.onNotice(n));
  }

  private onConnected(code: string, reconnected: boolean): void {
    this.leaving = false;
    this.roomCode = code;
    this.homeCode = "";
    this.homeError = null;
    setRoomInUrl(code);
    if (reconnected) this.ui.toast("Reconnected!", "success");
    this.syncScreen();
  }

  private onDisconnected(error: NetError | null): void {
    this.leaving = false;
    this.phaseHint = null;
    this.standings = null;
    setRoomInUrl(null);
    // A create/join in flight shows its own error on the home screen.
    if (this.busy) return;
    if (error) {
      // Unexpected drop: prefill the code so rejoining is one click.
      this.homeCode = this.roomCode;
      this.ui.toast(error.message || "Lost connection to the server", "error");
    }
    this.roomCode = "";
    this.enterScreen("home");
  }

  private onState(): void {
    this.syncScreen();
    if (this.screen === "lobby") this.renderLobby();
  }

  private onNotice(n: NoticeMsg): void {
    // The joining player already sees the lobby; "<you> joined" is noise.
    if (n.kind === "joined" && n.playerId === this.net.sessionId) return;
    this.ui.toast(n.text, NOTICE_TOAST[n.kind] ?? "info");
  }

  /**
   * Phase as announced: a roundStart/matchEnd message beats the patch that carries the change
   * (possibly a patch of the very same tick, sent before the message), so a state that is not yet
   * in the announced phase and not newer than the message is treated as stale.
   */
  private effectivePhase(phase: Phase, tick: number): Phase {
    const hint = this.phaseHint;
    return hint && phase !== hint.phase && tick <= hint.tick ? hint.phase : phase;
  }

  /** Pick the screen for the room phase. Idempotent; ignores everything while not in a room. */
  private syncScreen(): void {
    if (this.leaving || this.net.status !== "connected") return;
    const state = this.net.state;
    if (!state) return;
    const phase = this.effectivePhase(state.phase, state.tick);
    const target: ScreenId = phase === "lobby" ? "lobby" : phase === "matchEnd" ? "matchEnd" : "game";
    this.enterScreen(target);
  }

  /* ============================================================= screens */

  private enterScreen(target: ScreenId): void {
    if (target === this.screen) return;
    this.screen = target;
    switch (target) {
      case "home":
        this.leaveGameView();
        this.ui.closeSettings();
        this.startMenu();
        this.setPreviewRunning(false);
        this.playMenuMusic();
        this.renderHome();
        break;
      case "connecting":
        // Keep whatever backdrop is running behind the spinner.
        break;
      case "lobby":
        this.leaveGameView();
        this.startMenu();
        this.renderLobby();
        this.setPreviewRunning(true);
        this.playMenuMusic();
        break;
      case "game":
      case "matchEnd":
        this.stopMenu();
        this.setPreviewRunning(false);
        this.menuMusicOn = false;
        this.game.enter();
        if (target === "matchEnd") this.renderMatchEnd(true);
        break;
    }
    this.ui.showScreen(target);
    this.updateInputMode();
  }

  private showConnecting(text: string): void {
    this.ui.setConnecting(text);
    this.enterScreen("connecting");
  }

  private leaveGameView(): void {
    this.game.setScoreboardOpen(false);
    this.game.exit();
  }

  /** The menu backdrop is cosmetic: a failure there must never block the screen flow. */
  private startMenu(): void {
    if (this.menu.running) return;
    try {
      this.menu.start();
    } catch (err) {
      console.error("[bonk-brawl] menu backdrop failed to start", err);
    }
  }

  private stopMenu(): void {
    if (this.menu.running) this.menu.stop();
  }

  private setPreviewRunning(on: boolean): void {
    if (on === this.previewRunning) return;
    this.previewRunning = on;
    if (on) {
      this.previewKey = "";
      this.syncPreviewCharacter();
      this.preview.start();
    } else {
      this.preview.stop();
    }
  }

  private syncPreviewCharacter(): void {
    const me = this.net.me;
    if (!me) return;
    this.showPreview(me.character, me.slot);
  }

  private showPreview(character: CharacterId, slot: number): void {
    const key = `${character}|${slot}`;
    if (key === this.previewKey) return;
    this.previewKey = key;
    this.preview.setCharacter(character, playerColor(slot));
  }

  private renderHome(): void {
    this.ui.setHome({ nickname: settings.get().nickname, code: this.homeCode, busy: this.busy, error: this.homeError });
  }

  private renderLobby(): void {
    const state = this.net.state;
    if (!state) return;
    this.ui.setLobby(buildLobbyModel(state, this.net.sessionId, this.net.code || this.roomCode, window.location.origin));
    if (this.previewRunning) this.syncPreviewCharacter();
  }

  /** Rebuilt when what it shows changes (seconds left, rematch unlock, players, standings). */
  private renderMatchEnd(force: boolean): void {
    const state = this.net.state;
    if (!state) return;
    const timing = matchEndTiming(state);
    const key = `${timing.autoLobbySec}|${timing.canRematch}|${state.players.size}|${this.standings?.length ?? -1}`;
    if (!force && key === this.matchEndKey) return;
    this.matchEndKey = key;
    this.ui.setMatchEnd(buildMatchEndModel(state, this.net.sessionId, this.standings));
  }

  /* =============================================================== input */

  private bindInput(): void {
    const ev = this.input.events;
    ev.on("menu", () => this.toggleSettings());
    ev.on("scoreboard", ({ open }) => this.game.setScoreboardOpen(open));
    ev.on("emote", () => this.cycleEmote());
    ev.on("pointerLock", () => this.updateInputMode());
  }

  /**
   * Gameplay input only flows on the game screen with the settings menu closed; the
   * click-to-play overlay shows whenever that view lacks pointer lock.
   */
  private updateInputMode(): void {
    const inGame = this.screen === "game";
    const menuOpen = this.ui.settingsOpen;
    this.input.setInGame(inGame);
    this.input.setEnabled(inGame && !menuOpen);
    if (!inGame && this.input.pointerLocked) this.input.exitPointerLock();
    const clickToPlay = inGame && !menuOpen && !this.input.pointerLocked;
    if (clickToPlay === this.clickToPlay) return;
    this.clickToPlay = clickToPlay;
    this.ui.setClickToPlay(clickToPlay);
  }

  private toggleSettings(): void {
    if (this.screen === "connecting" || this.screen === null) return;
    if (this.ui.settingsOpen) {
      this.resume();
      return;
    }
    this.ui.openSettings(settings.get(), this.inRoom());
    this.updateInputMode();
  }

  /** Must run inside the user gesture (click / key) so the pointer lock request is allowed. */
  private resume(): void {
    this.ui.closeSettings();
    if (this.screen === "game") {
      this.input.setEnabled(true);
      this.input.requestPointerLock();
    }
    this.updateInputMode();
  }

  private inRoom(): boolean {
    const status = this.net.status;
    return status === "connected" || status === "reconnecting";
  }

  /** Q: honk → wave → dance, only while playing (ghosts and spectators don't emote). */
  private cycleEmote(): void {
    const me = this.net.me;
    const phase = this.net.state?.phase;
    if (!me || !me.alive || me.spectator || this.screen !== "game") return;
    if (phase !== "countdown" && phase !== "playing" && phase !== "suddenDeath" && phase !== "roundEnd") return;
    if (!this.sendEmote(EMOTE_IDS[this.emoteIndex])) return;
    this.emoteIndex = (this.emoteIndex + 1) % EMOTE_IDS.length;
  }

  private sendEmote(emote: EmoteId): boolean {
    const now = performance.now();
    if (now - this.lastEmoteAt < EMOTE_COOLDOWN_MS) return false;
    this.lastEmoteAt = now;
    this.net.sendEmote(emote);
    return true;
  }

  /* ================================================================== UI */

  private bindUi(): void {
    const ev = this.ui.events;
    ev.on("createRoom", ({ nickname }) => void this.connect("create", nickname, ""));
    ev.on("joinRoom", ({ code, nickname }) => void this.connect("join", nickname, code));
    ev.on("selectCharacter", ({ character }) => this.selectCharacter(character));
    ev.on("setReady", ({ ready }) => this.net.sendReady(ready));
    ev.on("updateSettings", (patch) => this.net.sendSettings(patch));
    ev.on("startMatch", () => this.net.sendStart());
    ev.on("rematch", ({ ready }) => this.net.sendRematch(ready));
    ev.on("leaveRoom", () => void this.leaveRoom());
    ev.on("backToPortal", () => void this.backToPortal());
    ev.on("settingsChange", (patch) => settings.set(patch));
    ev.on("resume", () => this.resume());
    ev.on("emote", ({ emote }) => void this.sendEmote(emote));
    ev.on("uiSound", ({ kind }) => this.audio.play(UI_SOUND[kind]));
  }

  private async connect(kind: ConnectKind, nickname: string, code: string): Promise<void> {
    if (this.busy || this.inRoom()) return;
    const name = nickname.trim();
    settings.set({ nickname: name });
    this.busy = true;
    this.homeCode = code;
    this.homeError = null;
    this.showConnecting(kind === "create" ? "Creating a room…" : `Joining ${code}…`);
    const opts = { nickname: name, character: settings.get().lastCharacter };
    try {
      if (kind === "create") await this.net.createRoom(opts);
      else await this.net.joinRoom(code, opts);
      this.busy = false;
      this.syncScreen();
    } catch (err) {
      this.busy = false;
      this.homeError = errorMessage(err);
      this.audio.play("uiError");
      if (this.screen === "home") this.renderHome();
      else this.enterScreen("home");
    }
  }

  private autoJoinDeepLink(): void {
    const nickname = settings.get().nickname.trim();
    if (this.homeCode && nickname) void this.connect("join", nickname, this.homeCode);
  }

  private selectCharacter(character: CharacterId): void {
    settings.set({ lastCharacter: character });
    this.net.sendCharacter(character);
    this.showPreview(character, this.net.me?.slot ?? 0);
  }

  private async leaveRoom(): Promise<void> {
    this.ui.closeSettings();
    this.leaving = true;
    this.roomCode = "";
    this.homeCode = "";
    setRoomInUrl(null);
    this.enterScreen("home");
    try {
      await this.net.leave();
    } finally {
      this.leaving = false;
    }
  }

  private async backToPortal(): Promise<void> {
    this.ui.closeSettings();
    if (this.inRoom()) {
      this.leaving = true;
      await Promise.race([this.net.leave().catch(() => undefined), delay(PORTAL_LEAVE_TIMEOUT_MS)]);
    }
    window.location.href = PORTAL_URL;
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
      if (this.frameErrors++ < MAX_LOGGED_FRAME_ERRORS) console.error("[bonk-brawl] frame failed", err);
    }
  };

  private tick(now: number, realDt: number): void {
    this.pollAudio();
    this.updateInputMode();
    if (this.game.active) {
      this.game.frame(now, realDt);
    } else {
      this.menuElapsed += realDt;
      if (this.menu.running) this.menu.update(realDt, this.menuElapsed);
      this.renderer.render();
    }
    if (this.screen === "matchEnd") this.renderMatchEnd(false);
  }
}
