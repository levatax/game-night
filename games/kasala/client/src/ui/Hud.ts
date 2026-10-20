// In-game HUD (§5, §8, §9, §16.3). Owner: client-hud. PUBLIC API IS THE CONTRACT. Helpers under ui/hud/**,
// styles in ui/hud.css. All text Turkish; money via money(), percent via pct(). Nicknames only ever reach the
// DOM through textContent (feed() HTML is pre-escaped by Game).
//
// Minimal and contextual, in both camera views (first person adds .ks-hud--fp tweaks). Every event is told
// once; the table, the faces, the 3D siren and the nameplates carry the rest.
// - ALWAYS: one compact top-center plate "TUR 3/10 · TUR POTU 45$ ×3 🧿" + 🐷 kumbara footer, SON MASA tag
//   (hud/TopPlate) and a small bottom-left "💰 Kasan 200$" chip (hud/MyChips). Masa view adds a slim turn strip
//   (hud/TurnStrip).
// - MY TURN: ÇEVİR / KASALA! with the risk strip between them ("Sonraki kart %29 BASKIN", "Baskında −68$") and a
//   slim timer bar; a GO cue when flipping opens; heckles from the others stack beside them (hud/ActionBar,
//   hud/RiskStrip).
// - OTHERS' TURN: one pill "🐶 Rakip · %22 · 45$ · 7" + [Z] ÇEVİR! / [X] KASALA! heckles while they flip.
// - BETTING (I can bet): the bet tray, bottom center; after it closes one line with my bet's fate (hud/BetPanel).
// - CONTEXTUAL: debt chip only with debts, target prompt top center (hud/TargetPrompt), last chance panel.
//   The wheel phase hides everything that would cover the wheel and docks the banner (the wheel outcome)
//   just above the bottom stack.
// - ON DEMAND: hold H (setLegend) → keys + last 6 feed lines (hud/Legend); first own turn shows the keys once.
// - Transient: feed (2 lines, 5 s, hud/Feed), banner (hud/Banner), Cemil subtitle bottom left above my kasa chip
//   (hud/Subtitle, never over the faces across the table), first-time coach marks (hud/Coach), the
//   first-person crosshair dot.
//
// Layout: the bottom-left corner column has a fixed width (--corner-w); the bottom stack lives in a full-width
// band whose grid keeps it centered when there is room and pushes it right of the corner when there is not, so
// the two never overlap (774×590 … 2560×1440; narrow screens also stack the heckles above the watch pill).
//
// Everything is derived from state in update() (idempotent, every patch, no DOM writes when nothing changed);
// tick() only animates.

import "./hud.css";
import { CHIP_AMOUNTS, type BetBox, type CardId } from "../../../shared/constants";
import type { BetsSettledMsg, KasalaStateView, Phase, PlayerView } from "../../../shared/protocol";
import { settings, type ViewMode } from "../app/settings";
import { pct, type UiSound } from "../app/ui";
import { ActionBar } from "./hud/ActionBar";
import { Banner } from "./hud/Banner";
import { BetPanel } from "./hud/BetPanel";
import { Coach } from "./hud/Coach";
import { LIVE_PHASES, TURN_PHASES, type HudCtx } from "./hud/ctx";
import { h, show, toggle } from "./hud/dom";
import { Feed } from "./hud/Feed";
import { Legend, type LegendMode } from "./hud/Legend";
import { MyChips } from "./hud/MyChips";
import { Subtitle } from "./hud/Subtitle";
import { TargetPrompt } from "./hud/TargetPrompt";
import { TopPlate } from "./hud/TopPlate";
import { TurnStrip } from "./hud/TurnStrip";

export interface HudCallbacks {
  onFlip(): void;
  onCash(): void;
  /** Box click with the currently selected chip (amount 0 = cancel my bet). */
  onBet(box: BetBox, amount: number): void;
  onChip(amount: number): void;
  onLoanMenu(): void;
  onEmotePicker(): void;
  onTauntPicker(): void;
  onScoreboard(): void;
  onSettings(): void;
  onUiSound(kind: UiSound): void;
  /** PAS: no side bet this turn (bet amount 0 with no bet yet). */
  onBetPass(): void;
  /** One-tap heckle while someone else flips (sent as TAUNT HECKLE_FLIP_TAUNT / HECKLE_CASH_TAUNT). */
  onHeckle(kind: "flip" | "cash"): void;
  /** Toggle the camera view (legend "V"). */
  onView(): void;
}

/** First-time risk tip threshold (the siren turns red around here). */
const SIREN_TIP_CHANCE = 0.3;
/** Lines pushed in the same moment as a new match survive the reset (e.g. "Maç başladı!"). */
const FRESH_KEEP_MS = 400;

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly plate: TopPlate;
  private readonly strip: TurnStrip;
  private readonly tprompt: TargetPrompt;
  private readonly bannerEl: Banner;
  private readonly sub: Subtitle;
  private readonly legend: Legend;
  private readonly feedEl: Feed;
  private readonly mine: MyChips;
  private readonly bets: BetPanel;
  private readonly action: ActionBar;
  private readonly coach: Coach;
  private readonly cross: HTMLDivElement;
  private visible = false;
  private ctx: HudCtx | null = null;
  private lastState: KasalaStateView | null = null;
  private lastMyId = "";
  // match tracking (fresh match → clear transient state, snap numbers)
  private lastPhase: Phase | "" = "";
  private lastRound = 0;
  // turn outcome tracking (see derive())
  private trackTurn = "";
  private savedFlip = 0;
  private seenFlip = 0;
  private seenLawyers = 0;
  private outcome: { raided: boolean; raidFlip: number } | null = null;
  // legend
  private legendHeld = false;
  private legendPinned = false;
  private firstTurnKey = "";
  private firstTurnDone = false;
  private legendMode: LegendMode = "off";
  private legendVersion = -1;
  private crossState: "off" | "idle" | "target" = "off";

  constructor(root: HTMLElement, cb: HudCallbacks) {
    this.root = h("div", "ks-hud ks-hud--hidden", root);
    this.root.setAttribute("aria-label", "Oyun göstergeleri");
    const sound = (k: UiSound) => cb.onUiSound(k);

    // top center: plate, (Masa) turn strip, target prompt, banner
    const top = h("div", "ks-hud-center", this.root);
    this.plate = new TopPlate(top);
    this.strip = new TurnStrip(top);
    this.tprompt = new TargetPrompt(top);
    this.bannerEl = new Banner(top);

    // bottom left: help (on demand), feed, Cemil's subtitle, debt chip, my kasa
    const corner = h("div", "ks-hud-corner", this.root);
    this.legend = new Legend(corner, {
      onEmotePicker: () => cb.onEmotePicker(),
      onTauntPicker: () => cb.onTauntPicker(),
      onLoanMenu: () => cb.onLoanMenu(),
      onScoreboard: () => cb.onScoreboard(),
      onSettings: () => cb.onSettings(),
      onView: () => cb.onView(),
      onUiSound: sound,
    });
    this.feedEl = new Feed(corner);
    this.sub = new Subtitle(corner);
    this.mine = new MyChips(corner, {
      onLoanMenu: () => cb.onLoanMenu(),
      onHelp: () => {
        this.legendPinned = !this.legendPinned;
        this.renderLegend();
      },
      onUiSound: sound,
    });

    // bottom center (inside the band that keeps it clear of the corner): my bet line, the action stage, the tray
    const band = h("div", "ks-hud-band", this.root);
    const bottom = h("div", "ks-hud-bottom", band);
    const lineSlot = h("div", "ks-hud-lineslot", bottom);
    this.action = new ActionBar(bottom, {
      onFlip: () => cb.onFlip(),
      onCash: () => cb.onCash(),
      onLoanMenu: () => cb.onLoanMenu(),
      onHeckle: (kind) => cb.onHeckle(kind),
      onUiSound: sound,
    });
    this.bets = new BetPanel(bottom, lineSlot, {
      onBet: (box, amount) => cb.onBet(box, amount),
      onChip: (amount) => cb.onChip(amount),
      onPass: () => cb.onBetPass(),
      onUiSound: sound,
      onLocalChange: () => this.refresh(),
    });

    this.coach = new Coach(this.root);
    this.cross = h("div", "ks-hud-cross", this.root);
    this.cross.setAttribute("aria-hidden", "true");

    toggle(this.root, "ks-hud--calm", settings.get().reducedFlashing);
    settings.onChange((s) => toggle(this.root, "ks-hud--calm", s.reducedFlashing));
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    toggle(this.root, "ks-hud--hidden", !on);
    if (!on) {
      this.bannerEl.hide();
      this.sub.hide();
      this.coach.hideAll();
      this.action.reset();
      this.legendHeld = false;
      this.legendPinned = false;
      this.renderLegend();
      // the next update (a new match, another room) starts fresh
      this.lastPhase = "";
    }
  }

  /** Camera view: first person tucks the HUD to the edges ("fp"), Masa adds the turn strip. */
  setView(mode: ViewMode): void {
    toggle(this.root, "ks-hud--fp", mode === "fp");
  }

  /** Hold H: key legend + the last feed lines. */
  setLegend(on: boolean): void {
    this.legendHeld = on;
    if (!on) this.legendPinned = false;
    this.renderLegend();
  }

  /** First-person aim dot at the screen center (gold over a valid target). */
  setCrosshair(state: "off" | "idle" | "target"): void {
    if (state === this.crossState) return;
    this.crossState = state;
    this.cross.dataset.state = state;
    show(this.cross, state !== "off");
  }

  /** Someone heckled the active player; shown to me as a small stack beside my buttons when I am active. */
  heckle(fromName: string, kind: "flip" | "cash"): void {
    if (!this.visible) return;
    this.action.heckle(fromName, kind);
  }

  /** Every patch while in a match. */
  update(state: KasalaStateView, myId: string): void {
    this.lastState = state;
    this.lastMyId = myId;
    const ctx = this.derive(state, myId);
    const enteringWheel = ctx.phase === "wheel" && this.lastPhase !== "wheel";
    const fresh = this.detectFresh(ctx);
    if (fresh) this.newMatch();
    // The banner docks at the bottom while the wheel is down; a card banner from before it ("PATRONUN ÇARKI")
    // must not jump down there; the wheel and its pill say it now, and the outcome banner follows.
    if (enteringWheel) this.bannerEl.hide();
    this.ctx = ctx;
    const root = this.root;
    if (root.dataset.phase !== ctx.phase) root.dataset.phase = ctx.phase;
    toggle(root, "ks-hud--final", state.finalTable);
    toggle(root, "ks-hud--myturn", ctx.myTurn && TURN_PHASES.has(ctx.phase));
    toggle(root, "ks-hud--spectator", ctx.spectator);

    this.plate.update(ctx, fresh);
    this.strip.update(ctx);
    this.tprompt.update(ctx);
    this.bets.update(ctx);
    this.action.update(ctx, this.bets.trayOpen);
    this.mine.update(ctx, fresh);
    this.legend.setLoans(state.settings.loans);

    // the key legend shows itself during my first turn of the match
    const myLive = ctx.myTurn && LIVE_PHASES.has(ctx.phase);
    if (myLive && !this.firstTurnKey) this.firstTurnKey = ctx.turnKey;
    if (this.firstTurnKey && ctx.turnKey !== this.firstTurnKey) this.firstTurnDone = true;
    this.renderLegend();

    this.coachMarks(ctx);
  }

  /** Every frame: counters, timer bars, fades. */
  tick(dt: number, time: number): void {
    void time;
    if (!this.visible) return;
    const d = Math.min(0.1, Math.max(0, dt));
    this.plate.tick(d);
    this.tprompt.tick(d);
    this.action.tick(d);
    this.bets.tick(d);
    this.mine.tick(d);
    this.feedEl.tick(d);
    this.sub.tick(d);
    this.bannerEl.tick(d);
    this.coach.tick(d);
    if (this.legendMode === "full" && this.feedEl.version !== this.legendVersion) this.renderLegend();
  }

  /** Currently selected chip amount (Q/W/E or click). */
  setChip(amount: number): void {
    if (!(CHIP_AMOUNTS as readonly number[]).includes(amount)) return;
    this.bets.setChip(amount);
  }

  /** Feed line. `html` is trusted/pre-escaped (Game escapes nicknames). */
  feed(icon: string, html: string): void {
    this.feedEl.push(icon, html);
  }

  /** Announcer subtitle for `sec` seconds (replaces the current one). */
  subtitle(text: string, sec: number): void {
    this.sub.say(text, sec);
  }

  /**
   * Compact transient banner under the top plate (turn changes, rare+ / attack card names); during the wheel
   * phase it sits just above the bottom stack so the wheel stays clear and its outcome is still told.
   */
  banner(text: string, color: string, sub?: string): void {
    this.bannerEl.show(text, color, sub);
  }

  /** Show the target prompt for an attack card (null = hide). `mine` = I am the one picking. */
  targetPrompt(card: CardId | null, mine: boolean): void {
    this.tprompt.setPrompt(card, mine);
    this.refresh();
  }

  /** Bet payout: my bet line tells my result (the active player: the house cut). */
  betsSettled(msg: BetsSettledMsg, myId: string): void {
    this.bets.settled(msg, myId);
  }

  /** Flash a bet box (keyboard 1–4 feedback, or "deny" when the bet is not allowed). */
  flashBox(box: BetBox, ok: boolean): void {
    this.bets.flash(box, ok);
  }

  /**
   * Game sent my PAS (0 or the tray's PAS button, no bet down): the tray folds away for this turn. Once Game
   * calls this, the tray folds only through here (a refused or swallowed 0 leaves it open).
   */
  betPassed(): void {
    this.bets.markPassed();
  }

  // ---------------------------------------------------------------- internals

  /** Re-run the layout with the last patch (local-only changes: PAS, prompts). */
  private refresh(): void {
    if (this.lastState && this.visible) this.update(this.lastState, this.lastMyId);
  }

  /** A new match started (intro, the round counter went back) or the HUD came back from hiding. */
  private detectFresh(ctx: HudCtx): boolean {
    const round = ctx.state.round;
    let fresh = this.lastPhase === "";
    if (ctx.phase === "intro" && this.lastPhase !== "intro") fresh = true;
    else if (this.lastRound > 0 && round > 0 && round < this.lastRound) fresh = true;
    this.lastPhase = ctx.phase;
    this.lastRound = round;
    return fresh;
  }

  private newMatch(): void {
    this.feedEl.clear(FRESH_KEEP_MS);
    this.bannerEl.hide();
    this.sub.hide();
    this.coach.hideAll();
    this.action.reset();
    this.bets.reset();
    this.plate.reset();
    this.firstTurnKey = "";
    this.firstTurnDone = false;
    this.legendPinned = false;
  }

  private renderLegend(): void {
    const ctx = this.ctx;
    const auto =
      !!ctx && !this.firstTurnDone && !!this.firstTurnKey && ctx.myTurn && (ctx.phase === "betting" || ctx.phase === "flipping");
    const mode: LegendMode = this.legendHeld || this.legendPinned ? "full" : auto ? "keys" : "off";
    this.legendMode = mode;
    this.legendVersion = this.feedEl.version;
    this.legend.render(mode, this.feedEl.history, this.feedEl.version);
    toggle(this.root, "ks-hud--legend", mode === "full");
  }

  /** First-time tips: offer when the moment comes, dismiss as soon as it passes. */
  private coachMarks(ctx: HudCtx): void {
    const c = this.coach;
    if (!this.visible) return;
    const s = ctx.state;
    const myFlip = ctx.myTurn && ctx.phase === "flipping" && !s.busy;
    const targeting = ctx.phase === "targeting" && this.tprompt.choosing;
    if (!(myFlip && s.flips === 0)) c.dismiss("flip");
    if (!(myFlip && s.flips >= 1)) {
      c.dismiss("cash");
      c.dismiss("siren");
    }
    if (!this.bets.trayOpen) c.dismiss("bet");
    if (!targeting) c.dismiss("target");

    if (myFlip && s.flips === 0) {
      c.offer("flip", this.action.flipBtn, "Kartı aç: çıkan para tur potuna girer. Her kart sireni biraz daha doldurur.");
    } else if (myFlip && s.raidChance >= SIREN_TIP_CHANCE) {
      c.offer("siren", this.action.risk.root, "Siren kırmızıya döndü! Bir kart daha baskın getirebilir: kasalamanın tam zamanı olabilir.");
    } else if (myFlip) {
      c.offer(
        "cash",
        this.action.cashBtn,
        `KASALA! potu kasana atar. Bir kart daha çevirirsen ${pct(s.raidChance)} baskın: pot ve rüşvet gider.`,
      );
    }
    if (this.bets.trayOpen) {
      c.offer("bet", this.bets.tray, "Kaçıncı kartta baskın yer? Bir kutuya fiş koy (1–4), fişi Q/W/E ile seç ya da PAS (0).");
    }
    if (targeting) c.offer("target", this.tprompt.root, "Saldırı kartı! Bir rakibe tıkla; ←/→ ile de seçebilirsin.", "below");
  }

  // ---------------------------------------------------------------- derive

  private derive(state: KasalaStateView, myId: string): HudCtx {
    const phase = state.phase;
    const me = state.players.get(myId);
    const active = state.activeId ? state.players.get(state.activeId) : undefined;
    const turnKey = `${state.round}:${state.turnInRound}:${state.activeId}`;

    const order: PlayerView[] = [];
    state.turnOrder.forEach((id) => {
      const p = state.players.get(id);
      if (p && !p.spectator) order.push(p);
    });
    if (order.length === 0) {
      state.players.forEach((p) => {
        if (!p.spectator) order.push(p);
      });
      order.sort((a, b) => a.seat - b.seat);
    }

    // How did the turn end? A raid card that arrived together with a drop in `lawyers` was cancelled by a
    // lawyer (the turn goes on, and a KASALA right after it must not read as a raid). An unsaved raid card
    // ends the turn even before the server switches to the result phase. The outcome is kept for the settle
    // phase in case lastCard is already reset there.
    const live = LIVE_PHASES.has(phase);
    const card = state.lastCard;
    if (turnKey !== this.trackTurn) {
      this.trackTurn = turnKey;
      this.savedFlip = 0;
      this.seenFlip = card.flipNo;
      this.seenLawyers = state.lawyers;
      this.outcome = null;
    }
    if (live && card.flipNo !== this.seenFlip) {
      if (card.id === "baskin" && state.lawyers < this.seenLawyers) this.savedFlip = card.flipNo;
      this.seenFlip = card.flipNo;
    }
    if (live) this.seenLawyers = state.lawyers;
    const raidNow = card.id === "baskin" && card.flipNo > 0 && card.flipNo !== this.savedFlip;
    const turnOver = phase === "result" || phase === "settle" || (live && raidNow);
    let raided = turnOver && raidNow;
    let raidFlip = raided ? card.flipNo : 0;
    if (turnOver && (card.id !== "" || !this.outcome)) this.outcome = { raided, raidFlip };
    else if (phase === "settle" && this.outcome) ({ raided, raidFlip } = this.outcome);

    const myTurn = !!myId && state.activeId === myId;
    const spectator = !me || me.spectator;
    const participant = !spectator && state.turnOrder.indexOf(myId) >= 0;
    const canBet =
      participant &&
      !!me &&
      !myTurn &&
      me.connected &&
      !!active &&
      phase === "betting" &&
      !state.betsLocked &&
      // Battle Royale ghosts keep their free chip even with side bets off (§10; the server allows it).
      (state.settings.sideBets || (me.ghost && state.settings.mode === "royale"));

    return {
      state,
      phase,
      myId,
      me,
      active,
      myTurn,
      turnKey,
      inTurn: TURN_PHASES.has(phase),
      turnOver,
      raided,
      raidFlip,
      order,
      spectator,
      participant,
      canBet,
      calm: settings.get().reducedFlashing,
    };
  }
}
