// The client orchestrator. Owner: client-game. Wires Net → Stage / TowerView / Chefs / Fx / AudioEngine /
// Menu / Hud / CaseReel / Overlays / Controls. Constructor signature + start() are the contract (main.ts).
// See docs/ARCHITECTURE.md "Client flow" for what reacts to which event.
//
// Helpers live in ./game/: attract.ts (home-screen fake tower), placement.ts (my hover/drop loop),
// cardEffects.ts (local-only card screen effects), reactions.ts (event → fx/audio/chefs), feed.ts (escaped
// feed lines), context.ts (module bag + frame helpers).

import * as THREE from "three";
import { BET_AMOUNTS, CARD_BY_ID, NICKNAME_STORAGE_KEY, SABOTEUR_MIN_PLAYERS, type CardId } from "../../shared/constants";
import type { BetSide, JellyStateView, Phase, Role } from "../../shared/protocol";
import { settings, type Settings } from "./app/settings";
import { AudioEngine } from "./audio/AudioEngine";
import type { MusicMode } from "./audio/Music";
import { Controls } from "./input/Controls";
import { Net, NetError } from "./net/Net";
import { Chefs } from "./scene/Chefs";
import { Fx } from "./scene/Fx";
import { TowerView } from "./scene/Pieces";
import { Stage } from "./scene/Stage";
import { CaseReel } from "./ui/CaseReel";
import { Hud } from "./ui/Hud";
import { Menu } from "./ui/Menu";
import { Overlays } from "./ui/Overlays";
import { Attract } from "./game/attract";
import { CardEffects } from "./game/cardEffects";
import { Later, localToWorld, type Ctx } from "./game/context";
import * as feed from "./game/feed";
import { Placement } from "./game/placement";
import * as react from "./game/reactions";

const IN_GAME: ReadonlySet<Phase> = new Set<Phase>(["spinning", "placing", "settling", "result"]);
const END_SCREENS: ReadonlySet<Phase> = new Set<Phase>(["voting", "reveal", "matchEnd"]);
const MUSIC: Record<Phase, MusicMode> = {
  lobby: "lobby",
  roleReveal: "lounge",
  spinning: "lounge",
  placing: "tension",
  settling: "drumroll",
  result: "lounge",
  voting: "tension",
  reveal: "silent",
  matchEnd: "victory",
};
const DT_MAX = 0.05;

/** Lays out one absolutely positioned, click-through layer in #ui (modules opt in to pointer events). */
function layer(parent: HTMLElement, name: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `jj-layer jj-layer--${name}`;
  el.style.cssText = "position:absolute;inset:0;pointer-events:none;";
  parent.appendChild(el);
  return el;
}

export class Game {
  private ctx: Ctx;
  private net = new Net();
  private attract: Attract;
  private placement: Placement;
  private cardFx: CardEffects;
  private later = new Later();

  // Room / turn bookkeeping.
  private inRoom = false;
  private phase: Phase | null = null;
  private role: Role | null = null;
  private rig = { available: false, used: false };
  private myBet: { side: BetSide; amount: number } | null = null;
  private betAmount = 10;
  private betsLocked = false;
  private turnKey = "";
  private reelKey = "";
  private placingStart = -1;
  private lastTickSec = -1;
  private pendingNewCake = false;
  private holdId = "";
  private tmpHold = new THREE.Vector3();
  // Emote wheel: hold T (release closes) or tap T (stays open until a pick / next T).
  private wheelOpen = false;
  private wheelOpenedAt = 0;
  private wheelSticky = false;
  private emotePickedAt = -1;

  // Frame loop.
  private time = 0;
  private lastFrame = 0;

  constructor(gameEl: HTMLElement, uiEl: HTMLElement) {
    const stage = new Stage(gameEl);
    const fxLayer = layer(uiEl, "fx");
    const hudLayer = layer(uiEl, "hud");
    const reelLayer = layer(uiEl, "reel");
    const menuLayer = layer(uiEl, "menu");
    const overLayer = layer(uiEl, "overlays");

    const audio = new AudioEngine();
    const ui = (kind: "click" | "hover" | "pop" | "drum") => audio.sfx(kind === "drum" ? "rimshot" : kind);
    const tower = new TowerView(stage.standGroup);
    const chefs = new Chefs(stage);
    const fx = new Fx(stage, fxLayer);
    const menu = new Menu(menuLayer, {
      onCreate: (nick) => void this.connect(() => this.net.create(nick), nick),
      onJoin: (code, nick) => void this.connect(() => this.net.join(code, nick), nick),
      onReady: (ready) => this.net.ready(ready),
      onColor: (color) => this.net.color(color),
      onSettings: (patch) => this.net.settings(patch),
      onStart: () => this.net.start(),
      onLeave: () => this.leaveRoom(),
      onUiSound: ui,
    });
    const hud = new Hud(hudLayer, {
      onBet: (side, amount) => {
        if (amount > 0) this.betAmount = amount;
        this.placeBet(side, amount);
      },
      onSpin: () => this.trySpin(),
      onUiSound: ui,
    });
    const reel = new CaseReel(reelLayer, {
      onTick: (speed) => audio.reelTick(speed),
      onLanded: (msg) => {
        react.caseLanded(this.ctx, this.net.state, msg, this.net.myId);
        // Feed line only once the reel stops, so it doesn't spoil the suspense.
        const [icon, html] = feed.openedLine(this.net.state, msg.playerId, msg.card, msg.multiplier, this.net.myId);
        this.feedLine(icon, html);
      },
    });
    const overlays = new Overlays(overLayer, {
      onVote: (id) => this.net.vote(id),
      onRematch: () => this.net.rematch(),
      onLeave: () => this.leaveRoom(),
      onEmote: (emote) => {
        this.net.emote(emote);
        // Keys 1–4 pick an emote here AND reach Controls as bet-amount keys: swallow that echo.
        this.emotePickedAt = performance.now();
        this.setWheel(false);
      },
      onUiSound: ui,
    });
    const controls = new Controls(stage, stage.renderer.domElement);

    this.ctx = { net: this.net, stage, tower, chefs, fx, audio, menu, hud, reel, overlays, controls };
    this.attract = new Attract(stage, chefs, fx, audio);
    this.placement = new Placement(this.ctx);
    this.cardFx = new CardEffects(stage, fx);

    this.wireControls();
    this.wireNet();
    this.applySettings(settings.get());
    settings.onChange((s) => this.applySettings(s));

    // The AudioContext starts suspended: unlock on any gesture (cheap + safe to repeat).
    const unlock = () => audio.unlock();
    window.addEventListener("pointerdown", unlock, { capture: true });
    window.addEventListener("keydown", unlock, { capture: true });
    window.addEventListener("touchend", unlock, { capture: true });
  }

  async start(): Promise<void> {
    const code = new URLSearchParams(location.search).get("room") ?? "";
    this.goHome(/^[A-Za-z]{4}$/.test(code) ? code.toUpperCase() : undefined);
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
    try {
      await this.net.tryReconnect();
    } catch {
      /* nothing to rejoin: stay on the home screen */
    }
  }

  // ===================================================================== frame loop
  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = Math.min(DT_MAX, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const c = this.ctx;
    const vdt = dt * c.fx.timeScale(dt);
    this.time += vdt;
    const state = this.inRoom ? this.net.state : null;

    c.controls.update(dt);
    if (this.attract.isRunning) this.attract.update(vdt);
    if (state) this.frameInRoom(state, dt);

    c.tower.update(vdt, this.time);
    c.chefs.update(vdt, this.time);
    c.fx.update(vdt, this.time);
    c.stage.update(vdt, this.time);
    c.hud.tick(dt);
    c.stage.render();
  };

  private frameInRoom(state: JellyStateView, dt: number): void {
    const c = this.ctx;
    const myId = this.net.myId;
    const hoverWorld = this.placement.frame(state, dt);

    // The active chef puppets the hover piece.
    const holding = state.phase === "placing" && (hoverWorld !== null || state.hover.active);
    if (holding) {
      const h = state.hover;
      const world = hoverWorld ?? localToWorld(c.stage, h.x, h.y, h.z, this.tmpHold);
      if (this.holdId && this.holdId !== state.activeId) c.chefs.setHoldTarget(this.holdId, null);
      this.holdId = state.activeId;
      c.chefs.setHoldTarget(this.holdId, world);
    } else if (this.holdId) {
      c.chefs.setHoldTarget(this.holdId, null);
      this.holdId = "";
    }

    const placingElapsed = state.phase === "placing" && this.placingStart >= 0 ? this.time - this.placingStart : 0;
    this.cardFx.update({
      phase: state.phase,
      card: state.card.id as CardId | "",
      mine: state.activeId === myId,
      placingElapsed,
      doneDropping: this.betsLocked,
    });
  }

  // ===================================================================== net wiring
  private wireNet(): void {
    const n = this.net.events;
    const c = () => this.ctx;
    const st = () => this.net.state;
    const me = () => this.net.myId;

    n.on("phase", ({ phase, prev }) => this.onPhase(phase, prev));
    n.on("state", (s) => this.onState(s));
    n.on("welcome", (m) => this.setUrlRoom(m.code));
    n.on("role", (m) => {
      this.role = m.role;
      const s = st();
      if (s?.phase === "roleReveal") this.showRole(s);
    });
    n.on("rigStatus", (m) => {
      this.rig = { available: m.available, used: m.used };
      if (m.accepted === true) {
        c().fx.popText("RIGGED 😈", "bad");
        c().audio.sfx("cackle", { volume: 0.6 });
        this.feedLine("🤫", "You rigged this spin. Act natural.");
      } else if (m.accepted === false) {
        c().hud.banner(`😈 ${m.reason || "Can't rig right now"}`, "bad");
        c().audio.sfx("buzzer");
      }
      this.refreshHud();
    });
    n.on("spinStart", (m) => {
      this.reelKey = this.turnKey;
      c().reel.spin(feed.nickOf(st(), m.playerId));
      c().audio.sfx("whoosh", { pitch: 1.4 });
    });
    n.on("spinResult", (m) => {
      this.reelKey = this.turnKey;
      c().reel.land(m);
    });
    n.on("dropped", (m) => {
      c().audio.sfx("whoosh");
      if (m.playerId === me()) this.placement.serverDropped(m.type, m.piecesLeft);
      if (m.piecesLeft <= 0) this.betsLocked = true;
      this.refreshHud();
    });
    n.on("impact", (m) => react.impact(c(), m));
    n.on("hiccup", (m) => {
      react.hiccup(c(), st(), m);
      if (m.playerId === me()) this.placement.hiccup();
    });
    n.on("topple", (m) => react.topple(c(), st(), m, this.later));
    n.on("result", (m) => {
      react.result(c(), st(), m, this.later);
      const [icon, html] = feed.resultLine(st(), m, me());
      this.feedLine(icon, html);
      if (m.reset) this.pendingNewCake = true;
    });
    n.on("bets", (m) => {
      react.bets(c(), st(), m, me());
      const line = feed.betsLine(st(), m.bets, me());
      if (line) this.feedLine(line[0], line[1]);
      this.myBet = null;
      this.refreshHud();
    });
    n.on("votes", (m) => {
      const s = st();
      if (s) c().overlays.showVotes(m, s);
    });
    n.on("reveal", (m) => {
      const s = st();
      if (s) c().overlays.showReveal(m, s);
      react.reveal(c(), m, this.later);
      const [icon, html] = feed.revealLine(s, m, me());
      this.feedLine(icon, html);
    });
    n.on("emoted", (m) => react.emoted(c(), st(), m));
    n.on("notice", (m) => {
      const [icon, html] = feed.noticeLine(m.text);
      this.feedLine(icon, html);
    });
    n.on("reconnecting", () => c().overlays.connection("reconnecting"));
    n.on("reconnected", () => c().overlays.connection("ok"));
    n.on("disconnected", () => {
      c().overlays.connection("disconnected");
      this.later.run(2200, () => this.goHome());
    });
  }

  // ===================================================================== phases
  private onPhase(phase: Phase, prev: Phase | null): void {
    const c = this.ctx;
    const state = this.net.state;
    if (!this.inRoom) this.enterRoom();
    this.phase = phase;
    c.audio.music(MUSIC[phase]);
    c.stage.pushIn(phase === "settling");
    if (END_SCREENS.has(prev ?? "lobby") && !END_SCREENS.has(phase)) c.overlays.hideEnd();
    if (!IN_GAME.has(phase)) {
      this.placement.reset();
      this.cardFx.reset();
    }

    switch (phase) {
      case "lobby":
        this.role = null;
        this.rig = { available: false, used: false };
        this.reelKey = "";
        this.turnKey = "";
        c.hud.hide();
        c.reel.hide();
        c.stage.setSign(null);
        c.menu.showLobby();
        if (state) c.menu.updateLobby(state, this.net.myId);
        break;
      case "roleReveal":
        c.hud.hide();
        if (state && this.role) this.showRole(state);
        else c.menu.hide();
        break;
      case "spinning":
        c.menu.hide();
        c.hud.show();
        if (state) {
          this.checkTurn(state);
          const mine = state.activeId === this.net.myId;
          c.hud.banner(mine ? "YOUR TURN! Press SPACE 🎰" : `${feed.nickOf(state, state.activeId)}'s turn!`, mine ? "gold" : "neutral");
          if (state.players.get(this.net.myId)?.spectator) this.feedLine("👀", "You're watching this match. You're in the next one!");
        }
        break;
      case "placing":
        c.menu.hide();
        c.hud.show();
        this.placingStart = this.time;
        this.lastTickSec = -1;
        if (state) {
          this.checkTurn(state);
          const mine = state.activeId === this.net.myId;
          if (mine) c.hud.banner("PLACE IT! 🫳 Click to drop", "gold");
          else if (state.settings.sideBets && !state.players.get(this.net.myId)?.spectator) c.hud.banner("Place your bets! 🎲", "neutral");
          c.chefs.react(state.activeId, "standUp");
          state.players.forEach((p) => {
            if (p.id !== state.activeId && !p.spectator) c.chefs.react(p.id, "lean");
          });
        }
        break;
      case "settling":
        c.hud.show();
        this.betsLocked = true;
        c.hud.banner("Settling… 🥁", "neutral");
        if (state) c.chefs.react(state.activeId, "sitDown");
        break;
      case "result":
        c.hud.show();
        this.betsLocked = true;
        break;
      case "voting":
        c.menu.hide();
        c.reel.hide();
        if (state) c.overlays.showVote(state, this.net.myId);
        break;
      case "reveal":
        c.menu.hide();
        c.reel.hide();
        break;
      case "matchEnd":
        c.menu.hide();
        c.reel.hide();
        c.hud.hide();
        c.stage.setSign("🏆 CHAMPION 🏆", "#FFD700");
        if (state) {
          c.overlays.showPodium(state, this.net.myId);
          c.fx.confetti(localToWorld(c.stage, 0, 0.8, 0), 1.5);
          c.audio.sfx("partyPopper");
          c.audio.sfx("cheer");
          c.chefs.reactAll("cheer");
        }
        break;
    }
    this.refreshHud();
  }

  private onState(state: JellyStateView): void {
    const c = this.ctx;
    const myId = this.net.myId;
    if (!this.inRoom) this.enterRoom();
    const players = [...state.players.values()];

    if (IN_GAME.has(state.phase)) this.checkTurn(state);
    c.tower.sync(state);
    c.chefs.sync(players, IN_GAME.has(state.phase) ? state.activeId : "", myId);
    c.stage.setStandAngle(state.standAngle);
    c.stage.setTowerHeight(Math.max(0, state.towerHeightCm) / 100);
    c.stage.setWind(state.windX, state.windZ, state.wind);
    c.stage.setQuake(state.quake);
    c.fx.setWind(state.windX, state.windZ, state.wind, state.standAngle);
    c.audio.setWindLevel(state.wind);
    c.audio.setHum(IN_GAME.has(state.phase) ? state.standSpeed : 0);

    // A fresh cake slides in once the server has cleared the toppled tower.
    if (this.pendingNewCake && state.pieces.size === 0) {
      this.pendingNewCake = false;
      c.stage.newCake();
      c.audio.sfx("whoosh", { pitch: 0.7 });
    }

    // Reconnect / late join: show the already-landed card without the animation.
    if (IN_GAME.has(state.phase) && state.card.id && !c.reel.spinning && this.reelKey !== this.turnKey) {
      this.reelKey = this.turnKey;
      c.reel.showLanded({ card: state.card.id as CardId, rarity: state.card.rarity as never, multiplier: state.card.multiplier });
      const def = CARD_BY_ID[state.card.id as CardId];
      if (def) c.stage.setSign(`${def.emoji} ${def.name} ${feed.fmtMult(state.card.multiplier)}`);
    }

    if (state.phase === "placing") {
      this.placement.sync(state, myId);
      if (state.timeTotal > 0) c.audio.setIntensity(1 - state.timeLeft / state.timeTotal);
      const sec = Math.ceil(state.timeLeft);
      if (sec <= 3 && sec > 0 && sec !== this.lastTickSec && !this.betsLocked) {
        this.lastTickSec = sec;
        c.audio.sfx("tick", { volume: state.activeId === myId ? 1 : 0.5 });
      }
    } else {
      this.placement.sync(state, myId);
      c.audio.setIntensity(state.phase === "settling" ? 1 : 0);
    }

    if (state.phase === "lobby") c.menu.updateLobby(state, myId);
    if (state.phase === "voting") c.overlays.updateVote(state, myId);
    this.refreshHud(state);
  }

  /** New turn (round:turn changed) → reset per-turn locals. */
  private checkTurn(state: JellyStateView): void {
    const key = `${state.round}:${state.turnInRound}:${state.activeId}`;
    if (key === this.turnKey) return;
    this.turnKey = key;
    this.myBet = null;
    this.betsLocked = false;
    this.placingStart = state.phase === "placing" ? this.time : -1;
    this.cardFx.reset();
    this.placement.reset();
    if (!state.card.id) this.ctx.stage.setSign(null);
  }

  private showRole(state: JellyStateView): void {
    if (!this.role) return;
    const count = [...state.players.values()].filter((p) => !p.spectator).length;
    const solo = !state.settings.saboteur || count < SABOTEUR_MIN_PLAYERS;
    this.ctx.menu.showRole(this.role, solo);
    this.ctx.audio.stinger(this.role === "saboteur" && !solo ? "roleSaboteur" : "roleBaker");
  }

  // ===================================================================== actions
  private wireControls(): void {
    const a = this.ctx.controls.actions;
    const c = this.ctx;
    a.on("spin", () => this.trySpin());
    a.on("rig", () => this.tryRig());
    a.on("betAmount", (v) => {
      if (this.wheelOpen || performance.now() - this.emotePickedAt < 100) return;
      this.betAmount = toBetAmount(v);
      c.audio.sfx("click");
      // Re-pressing a chip with a bet already placed moves that bet to the new amount.
      if (this.myBet) this.placeBet(this.myBet.side, this.betAmount);
      else this.refreshHud();
    });
    a.on("bet", (side) => this.placeBet(side, this.betAmount));
    a.on("emoteDown", () => {
      if (!this.inRoom) return;
      if (this.wheelOpen) {
        this.setWheel(false); // second tap closes a sticky wheel
        return;
      }
      this.setWheel(true);
      this.wheelOpenedAt = performance.now();
    });
    a.on("emoteUp", () => {
      if (!this.wheelOpen) return;
      // A quick tap leaves the wheel open; a hold closes it on release.
      if (!this.wheelSticky && performance.now() - this.wheelOpenedAt < 300) this.wheelSticky = true;
      else this.setWheel(false);
    });
    a.on("scoreboardDown", () => {
      if (this.inRoom) c.hud.setScoreboard(true);
    });
    a.on("scoreboardUp", () => c.hud.setScoreboard(false));
    a.on("menu", () => {
      c.overlays.toggleSettings();
      c.audio.sfx("pop");
    });
    a.on("drop", (pose) => {
      if (this.placement.drop(pose, this.net.state)) {
        c.audio.sfx("whoosh");
        if (this.net.state?.card.id === "bowlingBall") c.fx.popText("STRIKE?!", "small");
      }
    });
  }

  private trySpin(): void {
    const s = this.net.state;
    if (!this.inRoom || !s || s.phase !== "spinning" || s.spinStage !== "idle" || s.activeId !== this.net.myId) return;
    this.net.spin();
    this.ctx.audio.sfx("click");
  }

  private tryRig(): void {
    const s = this.net.state;
    if (!this.inRoom || !s || !IN_GAME.has(s.phase)) return;
    if (this.role !== "saboteur") {
      this.ctx.fx.popText("You're a Baker. No funny business! 🧁", "small");
      return;
    }
    if (s.phase !== "spinning" || s.spinStage === "landed" || s.activeId === this.net.myId) {
      this.ctx.hud.banner("😈 Rig during someone else's spin!", "bad");
      this.ctx.audio.sfx("buzzer", { volume: 0.5 });
      return;
    }
    this.net.rig(); // feedback arrives as rigStatus
  }

  private placeBet(side: BetSide, amount: number): void {
    const s = this.net.state;
    const myId = this.net.myId;
    const me = s?.players.get(myId);
    if (!s || !me || me.spectator || !s.settings.sideBets) return;
    if (s.activeId === myId || this.betsLocked || (s.phase !== "spinning" && s.phase !== "placing")) {
      this.ctx.audio.sfx("buzzer", { volume: 0.5 });
      return;
    }
    if (amount > me.coins) {
      this.ctx.hud.banner("Not enough coins! 🪹", "bad");
      this.ctx.audio.sfx("buzzer", { volume: 0.5 });
      return;
    }
    this.net.bet(side, amount);
    this.myBet = amount > 0 ? { side, amount } : null;
    this.ctx.audio.sfx(amount > 0 ? "coin" : "click");
    this.refreshHud(s);
  }

  // ===================================================================== room lifecycle
  private async connect(run: () => Promise<unknown>, nickname: string): Promise<void> {
    const menu = this.ctx.menu;
    menu.setBusy(true);
    try {
      localStorage.setItem(NICKNAME_STORAGE_KEY, nickname);
    } catch {
      /* private mode */
    }
    try {
      await run();
      menu.setBusy(false);
      if (this.net.code) this.setUrlRoom(this.net.code);
    } catch (err) {
      menu.showError(err instanceof NetError ? err.message : "Something burned in the oven. Try again!");
    }
  }

  private enterRoom(): void {
    this.inRoom = true;
    this.later.cancelAll();
    this.attract.stop();
    this.ctx.tower.clear();
    this.ctx.overlays.connection("ok");
    if (this.net.code) this.setUrlRoom(this.net.code);
  }

  private leaveRoom(): void {
    this.net.leave();
    this.goHome();
  }

  /** Back to the home screen with the attract loop (also the initial boot state). */
  private goHome(prefillCode?: string): void {
    const c = this.ctx;
    this.later.cancelAll();
    this.inRoom = false;
    this.phase = null;
    this.role = null;
    this.rig = { available: false, used: false };
    this.myBet = null;
    this.betsLocked = false;
    this.turnKey = "";
    this.reelKey = "";
    this.pendingNewCake = false;
    this.holdId = "";
    this.placement.reset();
    this.cardFx.reset();
    c.hud.hide();
    c.hud.setScoreboard(false);
    c.reel.hide();
    c.overlays.hideEnd();
    this.setWheel(false);
    c.overlays.connection("ok");
    c.stage.pushIn(false);
    c.stage.setSign(null);
    c.stage.setWind(0, 0, 0);
    c.stage.setQuake(false);
    c.fx.setWind(0, 0, 0, 0);
    c.audio.setHum(0);
    c.audio.setWindLevel(0);
    c.audio.setIntensity(0);
    c.audio.music("lobby");
    c.tower.clear();
    c.chefs.sync([], "", "");
    c.menu.showHome(prefillCode);
    this.attract.start();
    if (!prefillCode) this.setUrlRoom("");
  }

  private setUrlRoom(code: string): void {
    try {
      const url = new URL(location.href);
      if (code) url.searchParams.set("room", code);
      else url.searchParams.delete("room");
      if (url.href !== location.href) history.replaceState(null, "", url.href);
    } catch {
      /* sandboxed iframe etc. */
    }
  }

  // ===================================================================== misc
  private refreshHud(state: JellyStateView | null = this.net.state): void {
    if (!this.inRoom || !state || !(IN_GAME.has(state.phase) || END_SCREENS.has(state.phase))) return;
    this.ctx.hud.update(state, {
      myId: this.net.myId,
      isSaboteur: this.role === "saboteur",
      rig: this.rig,
      myBet: this.myBet,
      betAmount: this.betAmount,
    });
  }

  private setWheel(open: boolean): void {
    this.wheelOpen = open;
    if (!open) this.wheelSticky = false;
    this.ctx.overlays.setEmoteWheel(open);
  }

  private feedLine(icon: string, html: string): void {
    this.ctx.hud.feed(html, icon);
  }

  private applySettings(s: Settings): void {
    const c = this.ctx;
    c.audio.setVolumes({ master: s.muted ? 0 : s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume });
    c.stage.setQuality(s.quality);
    c.stage.setReducedFlashing(s.reducedFlashing);
    c.fx.setReducedFlashing(s.reducedFlashing);
  }
}

/** Controls' betAmount payload: an amount from BET_AMOUNTS, or a chip index 0..3 (keys 1–4). */
function toBetAmount(v: number): number {
  if ((BET_AMOUNTS as readonly number[]).includes(v)) return v;
  const i = Math.max(0, Math.min(BET_AMOUNTS.length - 1, Math.round(v)));
  return BET_AMOUNTS[i]!;
}
