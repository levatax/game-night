// The client orchestrator. Owner: client-net-game. Wires Net → Stage / Characters / Cards / Wheel / Fx /
// AudioEngine / Menu / Hud / Overlays / Controls. Constructor signature + start() are the contract (main.ts).
// See docs/ARCHITECTURE.md "Client flow" for what reacts to which event.
//
// Helpers live in ./game/: context.ts (module bag, guards, timers, world spots), display.ts (anti-spoiler
// holds), director.ts (camera + music), reactions.ts (event choreography + the told-once event policy),
// feed.ts (Turkish feed lines), turn.ts (legal actions, targets), attract.ts (home-screen demo), session.ts
// (share links, empty state), toast.ts (toasts + connection pill).
//
// DOM layers (each its own stacking context, bottom → top): labels (3D name tags) < tint (Fx vignette / edge
// glow / siren pulse, under the HUD) < hud < fx (slams, floats, flashes) < overlays < menu < toasts. While the
// home / lobby screen is up the overlays layer sits above the menu, so the settings dialog and the emote
// picker opened there stay on top of the menu's backdrop.
//
// First person: settings.view picks the seated view ("fp", default) or the classic "Masa" camera; Stage only
// uses first person while setFirstPersonAllowed(true): a seated participant (not a ghost, not a spectator) in
// a running match. V toggles the setting. Controls does drag-look and the optional pointer lock.

import {
  BET_BOXES,
  CHIP_AMOUNTS,
  EMOTE_COOLDOWN_SEC,
  HECKLE_CASH_TAUNT,
  HECKLE_FLIP_TAUNT,
  RAID_BASE_CHANCE,
  ROYALE_START_KASA,
  SIREN_SHAKE_CHANCE,
  START_KASA,
  START_KUMBARA,
  type BetBox,
  type EmoteId,
} from "../../shared/constants";
import type { KasalaStateView, MatchEndMsg, Phase } from "../../shared/protocol";
import { settings, type ViewMode } from "./app/settings";
import { playerColor, type UiSound } from "./app/ui";
import { AudioEngine, type SfxId } from "./audio/AudioEngine";
import { Controls, type Action } from "./input/Controls";
import { Net, NetError, NET_TEXT } from "./net/Net";
import { Cards } from "./scene/Cards";
import { Characters } from "./scene/Characters";
import { Fx } from "./scene/Fx";
import { Stage, type SeatProps } from "./scene/Stage";
import { fontsReady } from "./scene/toon";
import { Wheel } from "./scene/Wheel";
import { Hud } from "./ui/Hud";
import { Menu } from "./ui/Menu";
import { Overlays, type MatchEndStep } from "./ui/Overlays";
import { Attract } from "./game/attract";
import { Later, deadModule, guard, logOnce, make, type Ctx } from "./game/context";
import { Director } from "./game/director";
import { DisplayState } from "./game/display";
import * as feed from "./game/feed";
import { Show } from "./game/reactions";
import {
  emptyState,
  hasReconnectToken,
  matchEndFromState,
  setUrlRoom,
  shareCode,
  storeNickname,
  storedNickname,
} from "./game/session";
import { Toasts } from "./game/toast";
import {
  MATCH_PHASES,
  SIREN_PHASES,
  TURN_PHASES,
  amTargeting,
  betBlockReason,
  canCash,
  canShop,
  canFlip,
  canHeckle,
  cashBlockReason,
  chipFor,
  flipBlockReason,
  flipWaitsForBets,
  isParticipant,
  loanBlockReason,
  marketBlockReason,
  me,
  myBet,
  participants,
  rowLeft,
  sideBetsFor,
  stateTurnKey,
  turnKey,
  validTargets,
} from "./game/turn";

/** Visual dt cap (animation / physics): one long frame never teleports anything. */
const DT_MAX = 0.05;
/** Wall-clock dt cap for timers (HUD, overlays, controls): real time, but a tab switch isn't a 30 s jump. */
const REAL_DT_MAX = 0.5;
/** Raid chance span that maps the siren to the 0..1 tension level: 0 at the base 8%, 0.5 at 29% (card 3), 1 from 50%. */
const TENSION_SPAN = 0.42;
/** Pointer-lock crosshair: how often the aim is re-checked against the valid targets. */
const AIM_PICK_MS = 120;
/** Frames the first lobby roster sync waits after entering a room (one paints the lobby, one to spare). */
const ROSTER_HOLD_FRAMES = 2;

const UI_SFX: Record<UiSound, SfxId> = {
  click: "click",
  hover: "hover",
  pop: "pop",
  chip: "chips",
  deny: "deny",
  open: "open",
  close: "close",
};
const WEBGL_ERROR = "KASALA! için WebGL gerekli. Tarayıcını güncelle ya da donanım hızlandırmayı aç.";
const DISCONNECTED = "Bağlantı koptu. Masadan düştün, tekrar otur.";

/** Stacking order of the DOM layers in #ui (each layer is its own stacking context). */
const LAYER_Z = { labels: 1, tint: 2, hud: 3, fx: 4, overlays: 5, menu: 6, toasts: 8 } as const;
/** The overlays layer while the menu screen is up (above the menu, under the toasts). */
const OVERLAYS_OVER_MENU_Z = 7;

/** One absolutely positioned, click-through layer in #ui (modules opt in to pointer events). */
function layer(parent: HTMLElement, name: keyof typeof LAYER_Z): HTMLElement {
  const el = document.createElement("div");
  el.className = `ks-layer ks-layer--${name}`;
  el.style.cssText = `position:absolute;inset:0;pointer-events:none;z-index:${LAYER_Z[name]};isolation:isolate;`;
  parent.appendChild(el);
  return el;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

type Crosshair = "off" | "idle" | "target";

/** Raw module refs for the frame loop (each update is try/caught on its own). */
interface FrameModules {
  stage: Stage;
  characters: Characters;
  cards: Cards;
  wheel: Wheel;
  fx: Fx;
  hud: Hud;
  overlays: Overlays;
  controls: Controls;
}

/**
 * Everything a seat, plate, label or the character puppets show, as one string: the heavy syncs (seats,
 * characters, view seat) only run when it changes, not on every 20 Hz timer patch. The pending attack card is
 * in it for Characters' target previews. The raid chance is not: Characters follows it every frame from the
 * live state object it got in sync (holding a rise until the dealt card has landed), which is why a reconnect
 * (a new state object) forces a fresh sync.
 */
function rosterKey(s: KasalaStateView, myId: string): string {
  let k = `${myId}|${s.phase}|${s.activeId}|${s.settings.mode}|${s.pendingCard}|`;
  s.players.forEach((p) => {
    k +=
      `${p.id},${p.seat},${p.nickname},${p.animal},${p.color},${p.kasa},` +
      `${+p.ghost}${+p.connected}${+p.spectator}${+p.bot}${+p.taslik}${+p.cursed}${+p.trapped}${+p.lawyerNext}` +
      `${+p.ghostReturned}${+p.karaListe};`;
  });
  s.turnOrder.forEach((id) => (k += `${id},`));
  return k;
}

/** What the loan / offer / score windows show beyond the roster. */
function ledgerKey(s: KasalaStateView): string {
  let k = `${s.phase}|`;
  s.offers.forEach((o) => (k += `${o.id},${o.timeLeft},${o.amount};`));
  k += "|";
  s.debts.forEach((d) => (k += `${d.id},${d.owed};`));
  return k;
}

export class Game {
  private net = new Net();
  private later = new Later();
  private display = new DisplayState();
  private ctx: Ctx;
  private raw: FrameModules;
  private director: Director;
  private show: Show;
  private attract: Attract;
  private toasts: Toasts;
  private overLayer: HTMLElement;
  private fatal = "";

  // Room bookkeeping.
  private inRoom = false;
  private phase: Phase | null = null;
  private turnKey = "";
  private chip: number = CHIP_AMOUNTS[0];
  private picker: "emote" | "taunt" | null = null;
  private matchEndShown = false;
  private matchEndMsg: MatchEndMsg | null = null;
  private lobbyIds = new Set<string>();
  private spectatorNoted = false;
  private announcerPlayer = { id: "", playerId: "" };
  private lastSocial = new Map<string, number>();
  private lastDenyAt = 0;
  private lastHeckleAt = -1e9;
  /** Space during my bet window: flip the moment flipping opens. */
  private flipQueued = false;
  /** Turn key I already said PAS on. */
  private passedTurn = "";
  private scoreboardOpen = false;

  // Per-patch diffing (heavy DOM syncs only when something they show changed).
  private rosterSeen = "";
  /**
   * Frames left before the first roster sync of a room I just entered while it sits in the lobby: building
   * the puppets (and compiling whatever they need) waits until the lobby screen has been painted, so the
   * lobby UI shows at once and the 3D table fills in behind it.
   */
  private rosterHold = 0;
  private ledgerSeen = "";
  private lawyerSeen = "";
  private sirenSeen = -1;
  private tensionSeen = -1;

  // View (first person / Masa) as last pushed to the modules.
  private viewSeen: ViewMode | "" = "";
  private fpAllowedSeen: boolean | null = null;
  private hudViewSeen: ViewMode | "" = "";
  private lockSeen = "";
  /** Starts false so the boot goHome() really raises the overlays layer above the menu. */
  private menuShown = false;

  // Aiming (targeting hover + pointer-lock crosshair).
  private hoverOn = false;
  private crosshair: Crosshair = "off";
  private aimPickAt = 0;
  private aimOnTarget = false;

  // Frame loop.
  private time = 0;
  private lastFrame = 0;
  private prewarmed = false;

  constructor(gameEl: HTMLElement, uiEl: HTMLElement) {
    const labelLayer = layer(uiEl, "labels");
    const tintLayer = layer(uiEl, "tint");
    const hudLayer = layer(uiEl, "hud");
    const fxLayer = layer(uiEl, "fx");
    const overLayer = layer(uiEl, "overlays");
    const menuLayer = layer(uiEl, "menu");
    const toastLayer = layer(uiEl, "toasts");
    this.overLayer = overLayer;

    const stageM = make("Stage", () => new Stage(gameEl));
    if (!stageM.ok) this.fatal = WEBGL_ERROR;
    const stage = stageM.value;
    const characters = make("Characters", () => new Characters(stage, labelLayer)).value;
    const cards = make("Cards", () => new Cards(stage)).value;
    const wheel = make("Wheel", () => new Wheel(stage)).value;
    const fx = make("Fx", () => new Fx(stage, fxLayer, tintLayer)).value;
    const audio = make("AudioEngine", () => new AudioEngine()).value;
    const ui = (kind: UiSound) => this.uiSound(kind);
    const menu = make(
      "Menu",
      () =>
        new Menu(menuLayer, {
          onCreate: (nick) => void this.connect(() => this.net.create(nick), nick, true),
          onJoin: (code, nick) => void this.connect(() => this.net.join(code, nick), nick, false),
          onReady: (ready) => this.net.ready(ready),
          onAnimal: (animal) => this.net.animal(animal),
          onColor: (color) => this.net.color(color),
          onSettings: (patch) => this.net.settings(patch),
          onStart: () => this.net.start(),
          onLeave: () => this.leaveRoom(),
          onAddBot: () => this.net.addBot(),
          onRemoveBot: (id) => this.net.removeBot(id),
          onUiSound: ui,
        }),
    ).value;
    const hud = make(
      "Hud",
      () =>
        new Hud(hudLayer, {
          onFlip: () => this.safe("hud.flip", () => this.tryFlip()),
          onCash: () => this.safe("hud.cash", () => this.tryCash()),
          onBet: (box, amount) => this.safe("hud.bet", () => this.placeBet(box, amount, false)),
          onBetPass: () => this.safe("hud.pass", () => this.betPass()),
          onMarket: (flipNo) => this.safe("hud.market", () => this.marketChoose(flipNo)),
          onChip: (amount) => this.safe("hud.chip", () => this.setChip(amount)),
          onLoanMenu: () => this.safe("hud.loans", () => this.hudLoanMenu()),
          onEmotePicker: () => this.safe("hud.emote", () => this.openPicker(this.picker === "emote" ? null : "emote")),
          onTauntPicker: () => this.safe("hud.taunt", () => this.openPicker(this.picker === "taunt" ? null : "taunt")),
          onHeckle: (kind) => this.safe("hud.heckle", () => this.tryHeckle(kind)),
          onView: () => this.safe("hud.view", () => this.toggleView()),
          onScoreboard: () => this.safe("hud.scoreboard", () => {
            this.closePicker();
            this.scoreboardOpen = true;
            this.ctx.overlays.setScoreboard(true);
          }),
          onSettings: () => this.safe("hud.settings", () => {
            this.closePicker();
            this.ctx.overlays.toggleSettings(true);
          }),
          onUiSound: ui,
        }),
    ).value;
    const overlays = make(
      "Overlays",
      () =>
        new Overlays(overLayer, {
          onPropose: (toId, kind, amount, ratePct) => this.net.propose(toId, kind, amount, ratePct),
          onRespond: (offerId, accept) => this.net.respond(offerId, accept),
          onCancelOffer: (offerId) => this.net.cancelOffer(offerId),
          onRepay: (debtId, amount) => this.net.repay(debtId, amount),
          onEmote: (emote) => this.safe("ov.emote", () => this.sendEmote(emote, true)),
          onTaunt: (index) => this.safe("ov.taunt", () => this.sendTaunt(index, true)),
          onRematch: () => this.net.rematch(),
          onLeave: () => this.leaveRoom(),
          onStep: (step, index) => this.safe("ov.step", () => this.matchEndStep(step, index)),
          onUiSound: ui,
        }),
    ).value;
    const controls = make("Controls", () => new Controls(stage)).value;

    this.raw = { stage, characters, cards, wheel, fx, hud, overlays, controls };
    this.ctx = {
      net: this.net,
      stage: guard("stage", stage),
      characters: guard("characters", characters),
      dealer: guard("dealer", characters.dealer ?? deadModule()),
      cards: guard("cards", cards),
      wheel: guard("wheel", wheel),
      fx: guard("fx", fx),
      audio: guard("audio", audio),
      announcer: guard("announcer", audio.announcer ?? deadModule()),
      menu: guard("menu", menu),
      hud: guard("hud", hud),
      overlays: guard("overlays", overlays),
      controls: guard("controls", controls),
      later: this.later,
      display: this.display,
    };
    this.director = new Director(this.ctx);
    this.show = new Show(this.ctx, this.director);
    this.attract = new Attract(this.ctx);
    this.toasts = new Toasts(toastLayer);
    this.display.setOnChange(() => this.present());

    this.wireNet();
    this.wireAnnouncer();
    this.ctx.controls.actions.on("action", (a) => this.safe(`action.${a.type}`, () => this.onAction(a)));
    this.ctx.controls.setKeyFilter(() => !!(this.ctx.menu.capturesKeys() || this.ctx.overlays.capturesKeys()));
    settings.onChange(() => this.syncView());
    this.syncView();

    // The AudioContext starts suspended: unlock on any gesture (cheap + safe to repeat).
    const unlock = () => this.ctx.audio.unlock();
    window.addEventListener("pointerdown", unlock, { capture: true });
    window.addEventListener("keydown", unlock, { capture: true });
    window.addEventListener("touchend", unlock, { capture: true });
  }

  async start(): Promise<void> {
    this.goHome(shareCode() ?? undefined, this.fatal || undefined);
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
    // Compile every material once everything exists (fonts first: canvas textures are drawn with them), so
    // the first card, slam or wheel doesn't hitch.
    void fontsReady().then(() =>
      requestAnimationFrame(() => {
        if (this.prewarmed || this.fatal) return;
        this.prewarmed = true;
        this.ctx.stage.prewarm();
      }),
    );
    if (this.fatal || !hasReconnectToken()) return;
    this.ctx.menu.setBusy(true, "Masaya dönülüyor…");
    let back = false;
    try {
      back = await this.net.tryReconnect();
    } catch {
      back = false;
    }
    if (!this.inRoom) this.ctx.menu.setBusy(false);
    if (back) this.toasts.show("Masaya geri döndün!", "good");
  }

  // ===================================================================== frame loop
  /**
   * One frame: input → camera (first, so every DOM projection below uses this frame's camera) → 3D modules
   * → HUD / overlay timers (wall-clock dt) → render. No closures or allocations here.
   */
  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const raw = Math.max(0, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const dt = Math.min(DT_MAX, raw);
    const realDt = Math.min(REAL_DT_MAX, raw);
    const r = this.raw;
    // Freeze frames: honor Fx's time scale only right after we asked for one (never stuck frozen).
    let scale = 1;
    if (now < this.show.freezeUntil + 250) {
      try {
        const ts = r.fx.timeScale();
        scale = typeof ts === "number" && Number.isFinite(ts) ? clamp01(ts) : 1;
      } catch (err) {
        logOnce("fx.timeScale", err);
      }
    }
    const vdt = dt * scale;
    this.time += vdt;
    const t = this.time;

    try {
      this.display.tick();
      this.director.tick();
      if (this.rosterHold > 0 && --this.rosterHold === 0) this.flushRoster();
    } catch (err) {
      logOnce("game.tick", err);
    }
    try {
      r.controls.update(realDt);
    } catch (err) {
      logOnce("controls.update", err);
    }
    if (this.attract.running) {
      try {
        this.attract.update(dt);
      } catch (err) {
        logOnce("attract.update", err);
      }
    }
    try {
      r.stage.update(vdt, t);
    } catch (err) {
      logOnce("stage.update", err);
    }
    this.aimFrame(now);
    try {
      r.characters.update(vdt, t);
    } catch (err) {
      logOnce("characters.update", err);
    }
    try {
      r.cards.update(vdt, t);
    } catch (err) {
      logOnce("cards.update", err);
    }
    // No name tag draws over the hero card (Characters only touches the DOM when this flips).
    try {
      r.characters.setLabelsHidden(r.cards.heroActive === true);
    } catch (err) {
      logOnce("characters.setLabelsHidden", err);
    }
    try {
      r.wheel.update(vdt, t);
    } catch (err) {
      logOnce("wheel.update", err);
    }
    try {
      r.fx.update(vdt, t);
    } catch (err) {
      logOnce("fx.update", err);
    }
    try {
      r.hud.tick(realDt, t);
    } catch (err) {
      logOnce("hud.tick", err);
    }
    try {
      r.overlays.tick(realDt);
    } catch (err) {
      logOnce("overlays.tick", err);
    }
    try {
      r.stage.render();
    } catch (err) {
      logOnce("stage.render", err);
    }
  };

  /** Targeting hover from the aim (mouse or crosshair) and the pointer-lock crosshair state. */
  private aimFrame(now: number): void {
    const r = this.raw;
    const targeting = this.show.targeting === "me";
    try {
      if (targeting) r.characters.updateHover(r.controls.aim);
      else if (this.hoverOn) r.characters.updateHover(null);
    } catch (err) {
      logOnce("characters.updateHover", err);
    }
    this.hoverOn = targeting;
    try {
      let cross: Crosshair = "off";
      if (r.controls.locked && this.hudVisible()) {
        cross = "idle";
        if (targeting) {
          if (now - this.aimPickAt >= AIM_PICK_MS) {
            this.aimPickAt = now;
            const aim = r.controls.aim;
            const id = aim ? r.characters.pick(aim.x, aim.y) : null;
            this.aimOnTarget = !!id && validTargets(this.net.state).includes(id);
          }
          if (this.aimOnTarget) cross = "target";
        }
      }
      if (cross !== this.crosshair) {
        this.crosshair = cross;
        r.hud.setCrosshair(cross);
      }
    } catch (err) {
      logOnce("game.aim", err);
    }
  }

  private safe(name: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      logOnce(`game.${name}`, err);
    }
  }

  // ===================================================================== net wiring
  private wireNet(): void {
    const n = this.net.events;
    const show = this.show;
    n.on("phase", ({ phase, prev }) => this.onPhase(phase, prev));
    n.on("state", (s) => this.onState(s));
    n.on("welcome", (m) => {
      if (!this.inRoom) this.enterRoom();
      setUrlRoom(m.code);
    });
    n.on("turnStart", (m) => {
      if (!this.inRoom) this.enterRoom();
      this.turnKey = turnKey(m.round, m.turnInRound, m.playerId);
      this.flipQueued = false;
      this.display.clear();
      show.turnStart(m);
    });
    n.on("card", (m) => show.card(m));
    n.on("attack", (m) => show.attack(m));
    n.on("wheelStart", (m) => show.wheelStart(m));
    n.on("wheelResult", (m) => show.wheelResult(m));
    n.on("cashed", (m) => show.cashed(m));
    n.on("raided", (m) => show.raided(m));
    n.on("betsSettled", (m) => show.betsSettled(m));
    n.on("marketResult", (m) => show.marketResult(m));
    n.on("loan", (m) => show.loan(m));
    n.on("taslik", (m) => show.taslik(m));
    n.on("roundEnd", (m) => show.roundEnd(m));
    n.on("lastChance", (m) => show.lastChance(m));
    n.on("saved", (m) => show.saved(m));
    n.on("eliminated", (m) => {
      show.eliminated(m);
      this.syncView();
    });
    n.on("ghostReturn", (m) => {
      show.ghostReturn(m);
      this.syncView();
    });
    n.on("emoted", (m) => show.emoted(m));
    n.on("taunted", (m) => show.taunted(m));
    n.on("matchEnd", (m) => {
      this.matchEndMsg = m;
      this.matchEndShown = false;
      const s = this.net.state;
      if (s) this.showMatchEnd(m, s);
    });
    n.on("announcer", (m) => {
      this.announcerPlayer = { id: m.id, playerId: m.playerId };
      this.ctx.announcer.say(m.id);
    });
    n.on("notice", (m) => {
      const [icon, html] = feed.noticeLine(m.text);
      if (this.hudVisible()) this.ctx.hud.feed(icon, html);
      else this.toasts.show(m.text);
    });
    n.on("reconnecting", () => {
      this.toasts.pill("Bağlantı koptu, yeniden bağlanılıyor…");
      this.ctx.controls.setEnabled(false);
    });
    n.on("reconnected", () => {
      this.toasts.pill(null);
      this.toasts.show("Geri döndün!", "good");
      this.ctx.controls.setEnabled(true);
      // The new Room has a new state object: modules that keep the live state (Characters) must get it now,
      // even when nothing in the roster changed while I was gone.
      this.rosterSeen = "";
      this.flushRoster();
    });
    n.on("disconnected", () => {
      this.toasts.pill(null);
      this.ctx.controls.setEnabled(true);
      this.goHome(undefined, DISCONNECTED);
    });
  }

  /** Cemil Abi's lines → subtitle (names on screen only) + his jaw. */
  private wireAnnouncer(): void {
    const events = this.ctx.announcer.events;
    if (!events || typeof events.on !== "function") return;
    events.on("line", (l) => {
      let who = "Cemil Abi";
      if (this.announcerPlayer.id === l.id && this.announcerPlayer.playerId) {
        const pid = this.announcerPlayer.playerId;
        who += ` → ${pid === this.net.myId ? "Sen" : feed.nameText(this.net.state, pid)}`;
      }
      if (settings.get().subtitles) this.ctx.hud.subtitle(`${who}: ${l.text}`, l.durationSec);
      this.ctx.dealer.talk(l.durationSec);
    });
  }

  // ===================================================================== state
  private onState(s: KasalaStateView): void {
    if (!this.inRoom) this.enterRoom();
    const c = this.ctx;
    const myId = this.net.myId;
    // Right after the lobby screen appears the 3D roster waits a couple of frames (see rosterHold).
    const rosterChanged = this.rosterHold > 0 && s.phase === "lobby" ? false : this.syncRoster(s);
    const ledger = ledgerKey(s);
    if (rosterChanged || ledger !== this.ledgerSeen || this.scoreboardOpen || c.overlays.capturesKeys()) {
      this.ledgerSeen = ledger;
      c.overlays.update(s, myId);
    }
    if (s.phase === "lobby") {
      c.menu.updateLobby(s, myId);
      this.watchLobby(s);
    }
    this.show.watchBets(s);
    // Missed TURN_START (reconnect / late join): rebuild the turn from state.
    const key = stateTurnKey(s);
    if (key && key !== this.turnKey) {
      this.turnKey = key;
      this.display.clear();
      this.show.rebuildTurn(s);
    }
    if (s.phase === "matchEnd" && !this.matchEndShown) this.showMatchEnd(this.matchEndMsg ?? matchEndFromState(s), s);
    this.present();
  }

  /**
   * Seats, view seat, puppets and labels, only when something they show changed (timer-only patches must not
   * rebuild them). Returns true when it ran.
   */
  private syncRoster(s: KasalaStateView): boolean {
    const c = this.ctx;
    const myId = this.net.myId;
    const roster = rosterKey(s, myId);
    if (roster === this.rosterSeen) return false;
    this.rosterSeen = roster;
    c.stage.setSeats(this.seatProps(s));
    c.stage.setViewSeat(this.viewSeat(s));
    c.characters.sync(s, myId);
    this.syncView();
    return true;
  }

  /** The lobby screen has been painted: build the roster that waited for it. */
  private flushRoster(): void {
    const s = this.net.state;
    if (this.inRoom && s) this.syncRoster(s);
  }

  /** Everything the room shows from the (possibly held) state: siren, kumbara, lawyers, HUD, camera, music. */
  private present(): void {
    if (!this.inRoom) return;
    const live = this.net.state;
    if (!live) return;
    const v = this.display.view(live);
    const c = this.ctx;
    const myId = this.net.myId;
    const inMatch = MATCH_PHASES.has(live.phase);

    const sirenOn = inMatch && SIREN_PHASES.has(v.phase) && !this.director.wheelActive;
    const chance = sirenOn ? v.raidChance : 0;
    // Tension reaches the music / vignette early: half way at card 3, full at card 6 (§14).
    const level = sirenOn ? clamp01((chance - RAID_BASE_CHANCE) / TENSION_SPAN) : 0;
    if (chance !== this.sirenSeen) {
      this.sirenSeen = chance;
      c.stage.setSiren(chance);
      c.stage.setTremble(chance >= SIREN_SHAKE_CHANCE ? Math.min(0.45, 0.15 + (chance - SIREN_SHAKE_CHANCE) * 0.7) : 0);
    }
    if (level !== this.tensionSeen) {
      this.tensionSeen = level;
      c.fx.setSirenPulse(level);
      c.audio.setTension(level);
    }
    c.stage.setKumbara(v.kumbara);
    const finalTable = inMatch && live.finalTable;
    c.stage.setFinalTable(finalTable);
    c.fx.setFinalTable(finalTable);
    const lawyerPose = inMatch && TURN_PHASES.has(v.phase) && v.lawyers > 0 ? this.show.spots.pose(live.activeId) : null;
    const lawyerKey = lawyerPose ? `${lawyerPose.seat}:${v.lawyers}` : "";
    if (lawyerKey !== this.lawyerSeen) {
      this.lawyerSeen = lawyerKey;
      c.cards.setLawyers(lawyerPose, lawyerPose ? v.lawyers : 0);
    }

    if (inMatch) {
      c.hud.update(v, myId);
      this.show.syncTargeting(v);
      this.show.watch(v);
    }
    this.show.noteShown(v);
    this.director.refresh(v, true);
  }

  private seatProps(s: KasalaStateView): SeatProps[] {
    const inMatch = s.phase !== "lobby";
    const startKasa = s.settings.mode === "royale" ? ROYALE_START_KASA : START_KASA;
    const turnLive = TURN_PHASES.has(s.phase);
    const list = inMatch ? participants(s) : [...s.players.values()].filter((p) => !p.spectator);
    return list
      .map((p) => ({
        seat: p.seat,
        color: playerColor(p.color),
        nickname: p.nickname,
        kasa: inMatch ? p.kasa : startKasa,
        active: turnLive && p.id === s.activeId,
        ghost: p.ghost,
        connected: p.connected,
      }))
      .sort((a, b) => a.seat - b.seat);
  }

  private viewSeat(s: KasalaStateView): number | null {
    const p = me(s, this.net.myId);
    if (!p || p.spectator) return null;
    if (s.phase !== "lobby" && !isParticipant(s, p.id)) return null;
    return p.seat;
  }

  /**
   * Lobby arrivals: a pop and a little wave. The words come from the server's NOTICE (joined / bot joined /
   * left), which is the one and only join / leave message.
   */
  private watchLobby(s: KasalaStateView): void {
    const myId = this.net.myId;
    const now = new Set<string>();
    s.players.forEach((p) => {
      if (!p.spectator) now.add(p.id);
    });
    if (this.lobbyIds.size > 0) {
      for (const id of now) {
        if (this.lobbyIds.has(id) || id === myId) continue;
        // The lobby screen plays the join pop and the server NOTICE is the message; only the wave is ours.
        this.later.run(400, () => this.ctx.characters.react(id, "happy"));
      }
    }
    this.lobbyIds = now;
  }

  // ===================================================================== phases
  private onPhase(phase: Phase, prev: Phase | null): void {
    if (!this.inRoom) this.enterRoom();
    const c = this.ctx;
    const s = this.net.state;
    const myId = this.net.myId;
    this.phase = phase;

    if (prev === "wheel" && phase !== "wheel") this.show.raiseWheel();
    if (prev === "result" && phase !== "result") c.dealer.hide(false);
    if (prev === "market" && phase !== "market") c.cards.markRow(null);
    if (phase === "market" && prev !== "market") c.audio.sfx("open", { volume: 0.6 });
    if (phase !== "betting" && phase !== "flipping") this.flipQueued = false;
    if (phase !== "matchEnd" && this.matchEndShown) {
      c.overlays.hideMatchEnd();
      c.characters.podium(null);
      this.director.setEndShot(null);
      this.matchEndShown = false;
      this.matchEndMsg = null;
      this.show.setMatchEnd(null);
    }

    if (phase === "lobby") {
      // Back in the lobby (first join or a rematch): a clean slate for every transient UI.
      this.turnKey = "";
      this.spectatorNoted = false;
      this.passedTurn = "";
      this.display.clear();
      this.show.reset();
      this.director.reset();
      c.cards.clearTurn();
      c.hud.setVisible(false);
      c.hud.setLegend(false);
      c.characters.setAttract(false);
      if (prev !== null) c.overlays.closeAll();
      this.scoreboardOpen = false;
      this.closePicker();
      c.menu.showLobby();
      this.setMenuShown(true);
      if (s) {
        c.menu.updateLobby(s, myId);
        this.watchLobby(s);
      }
    } else if (phase === "matchEnd") {
      c.hud.setVisible(false);
      c.hud.setLegend(false);
      c.menu.hide();
      this.setMenuShown(false);
      c.characters.setAttract(false);
      this.show.clearTargeting();
      this.closePicker();
      c.overlays.toggleLoans(false);
      c.overlays.setScoreboard(false);
      this.scoreboardOpen = false;
      if (s && !this.matchEndShown) this.showMatchEnd(this.matchEndMsg ?? matchEndFromState(s), s);
    } else {
      c.menu.hide();
      this.setMenuShown(false);
      if (phase === "intro") {
        // A new match: nothing left over from the lobby or the last match.
        this.turnKey = "";
        this.passedTurn = "";
        c.overlays.closeAll();
        c.fx.clear();
        this.scoreboardOpen = false;
        this.closePicker();
        c.hud.setVisible(false);
        this.show.intro(s);
      }
      c.hud.setVisible(true);
      c.characters.setAttract(false);
      if (phase === "flipping" && s && s.activeId === myId) this.flippingOpens(s);
    }
    c.controls.setInMatch(this.hudVisible());
    if (s && MATCH_PHASES.has(phase)) this.noteSpectator(s);
    this.syncView();
    this.present();
  }

  /** My cards are live: a flip I pressed during the bet window goes out now (the HUD plays the GO cue). */
  private flippingOpens(s: KasalaStateView): void {
    if (!this.flipQueued) return;
    this.flipQueued = false;
    if (!canFlip(s, this.net.myId)) return;
    this.net.flip();
    this.ctx.audio.sfx("click", { volume: 0.5 });
  }

  private noteSpectator(s: KasalaStateView): void {
    if (this.spectatorNoted) return;
    const p = me(s, this.net.myId);
    if (!p?.spectator) return;
    this.spectatorNoted = true;
    this.toasts.show("Maç sürüyor: seyircisin. Bir sonraki maçta masadasın!", "info", 4);
  }

  /** The home / lobby screen is up: overlays opened there must sit above it. */
  private setMenuShown(on: boolean): void {
    if (this.menuShown === on) return;
    this.menuShown = on;
    this.overLayer.style.zIndex = String(on ? OVERLAYS_OVER_MENU_Z : LAYER_Z.overlays);
  }

  // ===================================================================== view
  /** First person is allowed: a seated match participant (not a ghost, not a spectator) while the match runs. */
  private fpAllowed(): boolean {
    if (!this.inRoom) return false;
    const s = this.net.state;
    if (!s || !MATCH_PHASES.has(s.phase)) return false;
    const myId = this.net.myId;
    const p = me(s, myId);
    return !!p && !p.spectator && !p.ghost && isParticipant(s, myId);
  }

  /** settings.view + where I am → Stage, Hud and Controls (each only when its input changed). */
  private syncView(): void {
    const c = this.ctx;
    const st = settings.get();
    const allowed = this.fpAllowed();
    const fp = allowed && st.view === "fp";
    if (st.view !== this.viewSeen) {
      this.viewSeen = st.view;
      c.stage.setViewMode(st.view);
    }
    if (allowed !== this.fpAllowedSeen) {
      // Back in my seat (match start, a ghost's return, a reconnect): no out-of-body shot left over from
      // before (e.g. a GHOST_RETURN missed while the socket was down).
      if (allowed && this.fpAllowedSeen === false) c.stage.outOfBody(0);
      this.fpAllowedSeen = allowed;
      c.stage.setFirstPersonAllowed(allowed);
    }
    // The HUD lays itself out for what is on screen (Masa while first person isn't possible).
    const hudView: ViewMode = fp ? "fp" : "masa";
    if (hudView !== this.hudViewSeen) {
      this.hudViewSeen = hudView;
      c.hud.setView(hudView);
    }
    const lock = `${fp}:${st.mouseLock}`;
    if (lock !== this.lockSeen) {
      this.lockSeen = lock;
      c.controls.setFirstPerson(fp, st.mouseLock);
    }
  }

  /** V / the HUD view button: first person ⇄ Masa. */
  private toggleView(): void {
    const next: ViewMode = settings.get().view === "fp" ? "masa" : "fp";
    settings.set({ view: next });
    const note = this.inRoom && !this.fpAllowed() && next === "fp" ? " (masaya oturunca)" : "";
    this.toasts.show(next === "fp" ? `Görünüm: Birinci şahıs${note}` : "Görünüm: Masa", "info", 1.6);
    this.uiSound("click");
  }

  // ===================================================================== match end
  private showMatchEnd(m: MatchEndMsg, s: KasalaStateView): void {
    if (this.matchEndShown) return;
    const c = this.ctx;
    this.matchEndShown = true;
    this.matchEndMsg = m;
    this.show.setMatchEnd(m);
    this.show.clearTargeting();
    this.closePicker();
    c.hud.setVisible(false);
    c.overlays.toggleLoans(false);
    c.overlays.setScoreboard(false);
    this.scoreboardOpen = false;
    c.overlays.matchEnd(m, s, this.net.myId);
    this.director.setEndShot("table");
    c.audio.sfx("cymbal", { volume: 0.6 });
  }

  private matchEndStep(step: MatchEndStep, index: number): void {
    if (!this.inRoom) return;
    this.show.matchEndStep(step, index);
  }

  // ===================================================================== actions
  private onAction(a: Action): void {
    const c = this.ctx;
    // Outside a running match the table keys are silent (no deny toasts, no chip clicks over the menu).
    if (!this.hudVisible()) {
      switch (a.type) {
        case "emote":
        case "taunt":
        case "picker":
        case "escape":
        case "view":
          break;
        case "scoreboard":
          if (!a.open) this.closeScoreboard();
          return;
        case "legend":
          if (!a.on) c.hud.setLegend(false);
          return;
        default:
          return;
      }
    }
    switch (a.type) {
      case "flip":
        return this.tryFlip();
      case "cash":
        return this.tryCash();
      case "digit":
        return this.digit(a.n);
      case "chip":
        return this.setChip(a.amount);
      case "loans":
        return this.openLoans();
      case "emote":
        return this.sendEmote(a.emote, false);
      case "taunt":
        return this.sendTaunt(a.index, false);
      case "picker":
        return this.openPicker(a.kind);
      case "scoreboard":
        if (!a.open) return this.closeScoreboard();
        if (this.inRoom && this.phase !== "lobby") {
          this.scoreboardOpen = true;
          c.overlays.setScoreboard(true);
        }
        return;
      case "escape":
        return this.escape();
      case "click":
        return this.click(a.x, a.y);
      case "view":
        return this.toggleView();
      case "cycleTarget":
        return this.cycleTarget(a.dir);
      case "legend":
        c.hud.setLegend(a.on);
        return;
      case "heckle":
        return this.tryHeckle(a.kind);
    }
  }

  private closeScoreboard(): void {
    this.scoreboardOpen = false;
    this.ctx.overlays.setScoreboard(false);
  }

  private tryFlip(): void {
    if (!this.inRoom) return;
    const s = this.net.state;
    const myId = this.net.myId;
    if (amTargeting(s, myId)) return this.confirmTarget();
    if (canFlip(s, myId)) {
      this.flipQueued = false;
      this.net.flip();
      this.ctx.audio.sfx("click", { volume: 0.5 });
      return;
    }
    // My turn but the bet window is still open: remember it, flip the moment it closes.
    if (flipWaitsForBets(s, myId)) {
      if (this.flipQueued) return;
      this.flipQueued = true;
      this.ctx.audio.sfx("click", { volume: 0.35, rate: 1.15 });
      this.toasts.show("Hazır! Bahisler kapanınca kart açılır.", "info", 1.8);
      return;
    }
    const why = flipBlockReason(s, myId);
    if (why) this.deny(why);
  }

  private tryCash(): void {
    if (!this.inRoom) return;
    const s = this.net.state;
    const myId = this.net.myId;
    if (amTargeting(s, myId)) return this.confirmTarget();
    // KASALA needs at least one card: never send it at 0 flips.
    if (canCash(s, myId)) {
      this.net.cash();
      this.ctx.audio.sfx("click", { volume: 0.5 });
      return;
    }
    const why = cashBlockReason(s, myId);
    if (why) this.deny(why);
  }

  /** 0–9: the Pazar (the N-th card on sale, 0 = pas), a target while I pick one, else a bet box (1–4) / PAS (0). */
  private digit(n: number): void {
    if (!this.inRoom) return;
    const s = this.net.state;
    const myId = this.net.myId;
    if (s?.phase === "market") {
      if (n === 0) return this.marketChoose(0);
      const card = rowLeft(s)[n - 1];
      if (card) return this.marketChoose(card.flipNo);
      if (canShop(s, myId)) this.deny("Bu numarada kart yok.");
      return;
    }
    if (amTargeting(s, myId)) {
      if (n > 0) this.targetByNumber(n);
      return;
    }
    // Side bets are off at most tables now: the digits stay quiet there.
    if (!s || !sideBetsFor(s, me(s, myId))) return;
    if (n === 0) return this.betPass();
    const box = BET_BOXES[n - 1];
    if (box) this.placeBet(box.id, null, true);
  }

  /** Pazar pick (0 = pas): secret until the reveal, changeable until the market closes. */
  private marketChoose(flipNo: number): void {
    if (!this.inRoom) return;
    const c = this.ctx;
    const why = marketBlockReason(this.net.state, this.net.myId, flipNo);
    if (why !== null) {
      if (why) this.deny(why);
      return;
    }
    this.net.market(flipNo);
    c.hud.marketPicked(flipNo);
    c.cards.markRow(flipNo || null);
    c.audio.sfx(flipNo ? "chips" : "click", { volume: flipNo ? 0.7 : 0.6 });
  }

  /**
   * Bet on a box. `amount` null = the selected chip (keyboard); 0 = cancel. From the keyboard, pressing the box
   * I already bet on with the same chip takes the bet back.
   */
  private placeBet(box: BetBox, amount: number | null, fromKey: boolean): void {
    if (!this.inRoom) return;
    const c = this.ctx;
    const s = this.net.state;
    const myId = this.net.myId;
    const p = me(s, myId);
    let stake = amount === null ? chipFor(p, this.chip) : amount > 0 ? chipFor(p, amount) : 0;
    const current = myBet(s, myId);
    if (fromKey && current && current.box === box && (p?.ghost || current.amount === stake)) stake = 0;
    if (stake === 0 && !current) return;
    const why = betBlockReason(s, myId, stake);
    if (why !== null) {
      c.hud.flashBox(box, false);
      this.deny(why);
      return;
    }
    this.net.bet(box, stake);
    c.hud.flashBox(box, true);
    c.audio.sfx(stake > 0 ? "chips" : "click", { volume: 0.8 });
    if (stake > 0) this.passedTurn = "";
  }

  /** 0 / the HUD "PAS" button: no bet this turn (a bet already down is taken back first). */
  private betPass(): void {
    if (!this.inRoom) return;
    const c = this.ctx;
    const s = this.net.state;
    const myId = this.net.myId;
    const current = myBet(s, myId);
    if (!current && this.passedTurn && this.passedTurn === this.turnKey) {
      c.hud.betPassed(); // already passed this turn: keep the tray folded (e.g. after a HUD reset)
      return;
    }
    const why = betBlockReason(s, myId, 0);
    if (why !== null) {
      this.deny(why);
      return;
    }
    this.net.bet(current?.box ?? BET_BOXES[0].id, 0);
    c.audio.sfx("click", { volume: 0.6, rate: 0.9 });
    if (current) {
      c.hud.flashBox(current.box, true);
      return;
    }
    this.passedTurn = this.turnKey;
    c.hud.betPassed(); // the tray folds only for a PAS that was actually sent
    this.toasts.show("Bu tur pas.", "info", 1.2);
  }

  /** Q/W/E or a HUD chip: select it; a bet already on the table moves to the new chip. */
  private setChip(amount: number): void {
    if (!(CHIP_AMOUNTS as readonly number[]).includes(amount)) return;
    const changed = amount !== this.chip;
    this.chip = amount;
    this.ctx.hud.setChip(amount);
    this.ctx.audio.sfx("click", { volume: 0.4, rate: 0.9 + CHIP_AMOUNTS.indexOf(amount as (typeof CHIP_AMOUNTS)[number]) * 0.1 });
    const s = this.net.state;
    const myId = this.net.myId;
    const current = myBet(s, myId);
    if (!changed || !current || me(s, myId)?.ghost || current.amount === amount) return;
    if (betBlockReason(s, myId, amount) === null) this.placeBet(current.box, amount, false);
  }

  private openLoans(): void {
    if (!this.inRoom) return;
    const why = loanBlockReason(this.net.state, this.net.myId);
    if (why === null) {
      this.ctx.overlays.toggleLoans();
      this.uiSound("open");
    } else if (why) this.deny(why);
  }

  /** HUD "Borç" / "Borç ver" button: during a last chance it opens the menu on the broke player. */
  private hudLoanMenu(): void {
    const s = this.net.state;
    const myId = this.net.myId;
    if (s?.phase === "lastChance" && s.lastChanceId && s.lastChanceId !== myId && loanBlockReason(s, myId) === null) {
      this.ctx.overlays.toggleLoans(true, s.lastChanceId);
      this.uiSound("open");
      return;
    }
    this.openLoans();
  }

  /** Emote / taunt from a key AND the picker can arrive together: send one. */
  private social(key: string): boolean {
    if (!this.inRoom || !this.net.connected) return false;
    const now = performance.now();
    if (now - (this.lastSocial.get(key) ?? -1e9) < 300) return false;
    this.lastSocial.set(key, now);
    return true;
  }

  private sendEmote(emote: EmoteId, fromPicker: boolean): void {
    if (fromPicker || this.picker === "emote") this.closePicker();
    if (!this.social(`e:${emote}`)) return;
    this.net.emote(emote);
  }

  private sendTaunt(index: number, fromPicker: boolean): void {
    if (fromPicker || this.picker === "taunt") this.closePicker();
    if (!this.social(`t:${index}`)) return;
    this.net.taunt(index);
  }

  /**
   * Z / X / the HUD heckle buttons: shout "ÇEVİR!" / "KASALA!" at whoever is flipping (sent as the matching
   * TAUNT). Only for match players watching someone else's turn; the server's taunt cooldown is mirrored.
   */
  private tryHeckle(kind: "flip" | "cash"): void {
    if (!this.inRoom || !this.net.connected) return;
    if (!canHeckle(this.net.state, this.net.myId)) return;
    const now = performance.now();
    if (now - this.lastHeckleAt < EMOTE_COOLDOWN_SEC * 1000) return;
    this.lastHeckleAt = now;
    this.net.taunt(kind === "flip" ? HECKLE_FLIP_TAUNT : HECKLE_CASH_TAUNT);
  }

  private openPicker(kind: "emote" | "taunt" | null): void {
    if (kind && !this.inRoom) {
      this.ctx.controls.syncPicker(null);
      return;
    }
    if (kind === this.picker) return;
    this.picker = kind;
    this.ctx.overlays.openPicker(kind);
    this.ctx.controls.syncPicker(kind);
    this.uiSound(kind ? "open" : "close");
  }

  private closePicker(): void {
    if (this.picker === null) return;
    this.picker = null;
    this.ctx.overlays.openPicker(null);
    this.ctx.controls.syncPicker(null);
  }

  private escape(): void {
    const c = this.ctx;
    if (this.picker) {
      this.closePicker();
      this.uiSound("close");
      return;
    }
    if (c.overlays.closeTop()) {
      this.scoreboardOpen = false;
      this.uiSound("close");
      return;
    }
    c.overlays.toggleSettings();
    this.uiSound("open");
  }

  // ------------------------------------------------------------------ targeting
  /** Targeting input is live: I'm the one picking and the attack card has landed. */
  private targetingLive(): boolean {
    return amTargeting(this.net.state, this.net.myId) && this.display.held("phase") !== "flipping";
  }

  /** Send the target (validated). Returns true when it went out. */
  private sendTarget(id: string): boolean {
    if (!this.targetingLive()) return false;
    const c = this.ctx;
    if (!validTargets(this.net.state).includes(id)) {
      this.deny(id === this.net.myId ? "Kendine saldıramazsın!" : "Bu oyuncu hedef olamaz.");
      return false;
    }
    this.net.target(id);
    c.audio.sfx("click");
    c.characters.highlight(id);
    c.characters.react(id, "shock");
    return true;
  }

  /** Left click (or the crosshair while locked) on the 3D table: pick an attack target while I'm targeting. */
  private click(x: number, y: number): void {
    if (!this.inRoom) return;
    const s = this.net.state;
    if (s?.phase === "market" && canShop(s, this.net.myId)) {
      const flipNo = this.ctx.cards.rowCardAt(x, y, rowLeft(s).map((card) => card.flipNo));
      if (flipNo !== null) this.marketChoose(flipNo);
      return;
    }
    if (!this.targetingLive()) return;
    const id = this.ctx.characters.pick(x, y);
    if (id) this.sendTarget(id);
  }

  /** Space / Enter while targeting: confirm the highlighted (or only) target, else highlight the first one. */
  private confirmTarget(): void {
    if (!this.targetingLive()) return;
    const id = this.show.targetChoice();
    if (id) this.sendTarget(id);
    else this.show.cycleTarget(1);
  }

  /** ←/→ while targeting. */
  private cycleTarget(dir: -1 | 1): void {
    if (!this.targetingLive()) return;
    this.show.cycleTarget(dir);
  }

  /** 1–9 while targeting: the N-th valid target (in seat order, as the HUD prompt lists them). */
  private targetByNumber(n: number): void {
    if (!this.targetingLive()) return;
    const id = validTargets(this.net.state)[n - 1];
    if (id) this.sendTarget(id);
    else this.deny("Bu numarada hedef yok.");
  }

  private deny(text: string): void {
    const now = performance.now();
    if (now - this.lastDenyAt < 350) return;
    this.lastDenyAt = now;
    this.ctx.audio.sfx("deny", { volume: 0.6 });
    if (text) this.toasts.show(text, "bad", 1.8);
  }

  private uiSound(kind: UiSound): void {
    this.ctx?.audio.sfx(UI_SFX[kind] ?? "click", { volume: kind === "hover" ? 0.35 : 0.7 });
  }

  private hudVisible(): boolean {
    return this.inRoom && this.phase !== null && MATCH_PHASES.has(this.phase);
  }

  // ===================================================================== room lifecycle
  /** `freshRoom`: a table I just created, which always starts in its lobby. */
  private async connect(run: () => Promise<unknown>, nickname: string, freshRoom: boolean): Promise<void> {
    const menu = this.ctx.menu;
    menu.setBusy(true, "Bağlanıyor…");
    storeNickname(nickname);
    try {
      await run();
      menu.setBusy(false);
      // My new table: the lobby goes up now, without waiting for the first state patch (it fills the seats
      // a moment later; the camera move and the puppets catch up behind it).
      if (freshRoom && !this.inRoom && this.net.connected) {
        this.enterRoom();
        menu.showLobby();
        this.setMenuShown(true);
      }
      if (this.net.code) setUrlRoom(this.net.code);
    } catch (err) {
      menu.setBusy(false);
      menu.showError(joinErrorText(err));
      this.ctx.audio.sfx("deny", { volume: 0.6 });
    }
  }

  private enterRoom(): void {
    const c = this.ctx;
    this.inRoom = true;
    this.later.cancelAll();
    this.attract.stop();
    this.display.clear();
    this.show.reset();
    this.director.reset();
    this.resetRoomState();
    this.rosterHold = ROSTER_HOLD_FRAMES;
    c.fx.clear();
    c.characters.setAttract(false);
    c.menu.setBusy(false);
    c.controls.setEnabled(true);
    c.controls.setInMatch(false);
    c.hud.setChip(this.chip);
    this.toasts.pill(null);
    this.syncView();
    if (this.net.code) setUrlRoom(this.net.code);
  }

  /** Per-room bookkeeping back to its defaults (joining a room, or leaving one). */
  private resetRoomState(): void {
    this.turnKey = "";
    this.lobbyIds = new Set();
    this.matchEndShown = false;
    this.matchEndMsg = null;
    this.spectatorNoted = false;
    this.flipQueued = false;
    this.passedTurn = "";
    this.scoreboardOpen = false;
    this.rosterSeen = "";
    this.rosterHold = 0;
    this.ledgerSeen = "";
    this.lawyerSeen = "";
    this.sirenSeen = -1;
    this.tensionSeen = -1;
    this.aimOnTarget = false;
  }

  private leaveRoom(): void {
    this.net.leave();
    this.goHome();
  }

  /** Back to the home screen with the attract loop (also the boot state). */
  private goHome(prefillCode?: string, error?: string): void {
    const c = this.ctx;
    const empty = emptyState();
    this.later.cancelAll();
    this.inRoom = false;
    this.phase = null;
    this.resetRoomState();
    this.display.clear();
    this.show.reset();
    this.closePicker();

    // Every window, picker, offer and pill goes (leaving from Ayarlar must not leave Ayarlar open).
    c.overlays.closeAll();
    c.overlays.hideMatchEnd();
    c.fx.clear();
    this.toasts.pill(null);
    c.controls.setEnabled(true);
    c.controls.setInMatch(false);
    c.hud.setVisible(false);
    c.hud.setLegend(false);
    c.overlays.update(empty, "");
    c.characters.podium(null);
    c.characters.sync(empty, "");
    c.cards.clearTurn();
    c.cards.setLawyers(null, 0);
    c.dealer.hide(false);
    c.stage.setLightsOut(false);
    c.stage.setViewSeat(null);
    c.stage.setSiren(0);
    c.stage.setTremble(0);
    c.stage.setFinalTable(false);
    c.stage.setKumbara(START_KUMBARA);
    c.fx.setSirenPulse(0);
    c.fx.setFinalTable(false);
    c.audio.setTension(0);
    c.announcer.stop();
    this.syncView();
    c.characters.setAttract(true);
    this.director.home();
    c.menu.showHome({ nickname: storedNickname(), code: prefillCode, error });
    this.setMenuShown(true);
    this.attract.start();
    setUrlRoom(prefillCode ?? "");
  }
}

/** NetError → the Turkish line for the home screen. */
function joinErrorText(err: unknown): string {
  if (err instanceof NetError) {
    if (err.message) return err.message;
    if (err.code === "notFound") return NET_TEXT.notFound;
    if (err.code === "full") return NET_TEXT.full;
    if (err.code === "serverDown") return NET_TEXT.serverDown;
  }
  return NET_TEXT.unknown;
}
