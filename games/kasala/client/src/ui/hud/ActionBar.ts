// Bottom center "stage": exactly one of
// - act: my turn — ÇEVİR [Space] and KASALA! [Enter] with the risk strip between them and a slim decision-timer
//   bar under it. KASALA! stays off until the first card ("Önce kart çevir"). The moment flipping opens the
//   ÇEVİR button pulses, a cue plays and the note says "ÇEVİR! Kartını aç." During the bet window the note
//   counts the bets against me ("🎲 2 bahis sana karşı") and the bar runs grey. The lawyer is a corner chip on
//   ÇEVİR. Incoming heckles stack up beside the buttons ("🗣 Kedi: ÇEVİR!").
// - watch: someone else's turn — one pill "🐶 Rakip · %22 · 45$ · 7", flanked during flipping by the two heckle
//   buttons [Z] ÇEVİR! / [X] KASALA! (the one that matches my bet glows).
// - wheel: a slim "🎡 Çark dönüyor…" pill, nothing that covers the wheel.
// - last: Battle Royale last chance ("SON ŞANS! Kedi'ye borç verecek var mı? 15" + "Borç ver" → onLoanMenu).
// - elim: the cement shoes moment.
// The attack target prompt lives at the top (TargetPrompt), so the table stays clickable.

import { EMOTE_COOLDOWN_SEC, SIREN_SHAKE_CHANCE, TASLIK_CUT_PCT, TIME_LOW_SEC, boxAlive, picksFor } from "../../../../shared/constants";
import { money, pct, playerColor, toName, type UiSound } from "../../app/ui";
import { uiCapturesKeys } from "../keyGate";
import { Countdown, setBar, tierColor, tierOf, type HudCtx } from "./ctx";
import { animalIcon, h, replay, setDisabled, setText, setVar, show, toggle, typingInField, wireButton } from "./dom";
import { RiskStrip } from "./RiskStrip";

type Mode = "none" | "act" | "watch" | "wheel" | "last" | "elim";
export type HeckleKind = "flip" | "cash";

const HECKLE_LIFE = 2.4;
const HECKLE_MAX = 3;

export interface ActionHandlers {
  onFlip(): void;
  onCash(): void;
  onLoanMenu(): void;
  onHeckle(kind: HeckleKind): void;
  onUiSound(kind: UiSound): void;
}

interface Incoming {
  node: HTMLDivElement;
  age: number;
}

export class ActionBar {
  readonly root: HTMLDivElement;
  private readonly cb: ActionHandlers;
  private mode: Mode = "none";

  // act
  readonly act: HTMLDivElement;
  private readonly actNote: HTMLDivElement;
  readonly flipBtn: HTMLButtonElement;
  private readonly lawyerChip: HTMLSpanElement;
  readonly cashBtn: HTMLButtonElement;
  private readonly cashSub: HTMLSpanElement;
  readonly risk: RiskStrip;
  private readonly timerEl: HTMLDivElement;
  private readonly timerFill: HTMLDivElement;
  private readonly timerNum: HTMLSpanElement;
  private readonly timerBar = { v: -1 };
  private readonly timer = new Countdown();
  private readonly incoming: HTMLDivElement;
  private readonly heckles: Incoming[] = [];
  private canAct = false;
  private wasLive = false;
  /** Space was pressed during my bet window: Game flips the moment flipping opens, so no GO cue then. */
  private queued = false;
  private betWindow = false;
  private noteKey = "";

  // watch
  private readonly watchRow: HTMLDivElement;
  private readonly watch: HTMLDivElement;
  private readonly watchFace: HTMLSpanElement;
  private readonly watchName: HTMLSpanElement;
  private readonly watchNote: HTMLSpanElement;
  private readonly watchRisk: HTMLSpanElement;
  private readonly watchPot: HTMLSpanElement;
  private readonly watchSecs: HTMLSpanElement;
  private readonly heckleFlip: HTMLButtonElement;
  private readonly heckleCash: HTMLButtonElement;
  private heckleOn = false;
  private heckleCool = 0;

  // wheel
  private readonly wheel: HTMLDivElement;
  private readonly wheelText: HTMLSpanElement;

  // last chance / elimination
  private readonly last: HTMLDivElement;
  private readonly lastTitle: HTMLDivElement;
  private readonly lastText: HTMLDivElement;
  private readonly lastNum: HTMLSpanElement;
  private readonly lastBtn: HTMLButtonElement;
  private readonly elim: HTMLDivElement;
  private readonly elimText: HTMLSpanElement;

  constructor(parent: HTMLElement, cb: ActionHandlers) {
    this.cb = cb;
    this.root = h("div", "ks-hud-stage", parent);
    const sound = (k: UiSound) => cb.onUiSound(k);

    // ---- act
    this.act = h("div", "ks-hud-act", this.root);
    this.actNote = h("div", "ks-hud-act__note", this.act);
    const row = h("div", "ks-hud-act__row", this.act);

    this.flipBtn = h("button", "ks-hud-btn ks-hud-btn--flip", row);
    h("span", "ks-hud-btn__key", this.flipBtn, "Space");
    h("span", "ks-hud-btn__label", this.flipBtn, "ÇEVİR");
    this.lawyerChip = h("span", "ks-hud-btn__chip", this.flipBtn);
    this.lawyerChip.title = "Avukat: bu turdaki ilk baskını iptal eder";
    this.flipBtn.setAttribute("aria-label", "ÇEVİR (Space)");
    wireButton(this.flipBtn, sound, () => cb.onFlip());

    const mid = h("div", "ks-hud-act__mid", row);
    this.risk = new RiskStrip(mid);
    this.timerEl = h("div", "ks-hud-timer", mid);
    const track = h("div", "ks-hud-timer__track", this.timerEl);
    this.timerFill = h("div", "ks-hud-timer__fill", track);
    this.timerNum = h("span", "ks-hud-timer__num", this.timerEl);

    this.cashBtn = h("button", "ks-hud-btn ks-hud-btn--cash", row);
    h("span", "ks-hud-btn__key", this.cashBtn, "Enter");
    h("span", "ks-hud-btn__label", this.cashBtn, "KASALA!");
    this.cashSub = h("span", "ks-hud-btn__sub", this.cashBtn);
    this.cashBtn.setAttribute("aria-label", "KASALA! (Enter)");
    wireButton(this.cashBtn, sound, () => cb.onCash());

    this.incoming = h("div", "ks-hud-incoming", this.act);
    this.incoming.setAttribute("aria-live", "polite");

    // ---- watch
    this.watchRow = h("div", "ks-hud-watchrow", this.root);
    this.heckleFlip = this.heckleButton("flip", "Z", "ÇEVİR!", "Bir tane daha çevirsin diye bağır");
    this.watch = h("div", "ks-hud-watch", this.watchRow);
    this.watchFace = h("span", "ks-hud-watch__face", this.watch);
    this.watchName = h("span", "ks-hud-watch__name", this.watch);
    this.watchNote = h("span", "ks-hud-watch__part ks-hud-watch__note", this.watch);
    this.watchRisk = h("span", "ks-hud-watch__part ks-hud-watch__risk", this.watch);
    this.watchRisk.title = "Sonraki kartın baskın ihtimali";
    this.watchPot = h("span", "ks-hud-watch__part ks-hud-watch__pot", this.watch);
    this.watchPot.title = "Vitrin";
    this.watchSecs = h("span", "ks-hud-watch__part ks-hud-watch__secs", this.watch);
    this.heckleCash = this.heckleButton("cash", "X", "KASALA!", "Kasalasın diye bağır");
    this.watchRow.appendChild(this.heckleCash);

    // ---- wheel
    this.wheel = h("div", "ks-hud-wheelpill", this.root);
    h("span", "ks-hud-wheelpill__icon", this.wheel, "🎡");
    this.wheelText = h("span", "ks-hud-wheelpill__text", this.wheel);

    // ---- last chance
    this.last = h("div", "ks-hud-last", this.root);
    const lHead = h("div", "ks-hud-last__head", this.last);
    this.lastTitle = h("div", "ks-hud-last__title", lHead, "SON ŞANS!");
    this.lastNum = h("span", "ks-hud-last__num", lHead);
    this.lastText = h("div", "ks-hud-last__text", this.last);
    this.lastBtn = h("button", "ks-hud-last__btn", this.last);
    wireButton(this.lastBtn, sound, () => cb.onLoanMenu(), "open");

    // ---- elimination
    this.elim = h("div", "ks-hud-elim", this.root);
    h("span", "ks-hud-elim__icon", this.elim, "🪣");
    this.elimText = h("span", "ks-hud-elim__text", this.elim);

    // Key-press echo: Space / Enter squash the matching button, Z / X the heckles (the action itself goes
    // through Controls → Game).
    window.addEventListener("keydown", (e) => this.keyEcho(e, true));
    window.addEventListener("keyup", (e) => this.keyEcho(e, false));
    window.addEventListener("blur", () => this.clearPressed());
  }

  /** Some players heckled me ("🗣 Kedi: ÇEVİR!"); shown only while it is my turn. */
  heckle(fromName: string, kind: HeckleKind): void {
    if (this.mode !== "act") return;
    const node = h("div", `ks-hud-incoming__line ks-hud-incoming__line--${kind}`, this.incoming);
    h("span", "ks-hud-incoming__icon", node, "🗣");
    h("span", "ks-hud-incoming__name", node, fromName);
    h("span", "ks-hud-incoming__word", node, kind === "flip" ? "ÇEVİR!" : "KASALA!");
    this.heckles.push({ node, age: 0 });
    while (this.heckles.length > HECKLE_MAX) this.heckles.shift()!.node.remove();
  }

  /** `trayOpen`: my bet tray owns the bottom center during betting (no watch pill then). */
  update(ctx: HudCtx, trayOpen: boolean): void {
    const s = ctx.state;
    const phase = ctx.phase;

    let mode: Mode = "none";
    if (phase === "lastChance" && s.lastChanceId) mode = "last";
    else if (phase === "elimination" && s.lastChanceId) mode = "elim";
    else if (phase === "wheel" && ctx.active) mode = "wheel";
    else if (ctx.myTurn && (phase === "betting" || phase === "flipping")) mode = "act";
    else if (!ctx.myTurn && ctx.active && (phase === "flipping" || (phase === "betting" && !trayOpen))) mode = "watch";
    if (mode !== this.mode) {
      if (this.mode === "act") this.clearHeckles();
      // a key held across the switch (Enter → KASALA → result) must not leave a button squashed for later
      this.clearPressed();
      this.mode = mode;
      const node = this.panelFor(mode);
      if (node) replay(node, "ks-hud-enter");
    }
    show(this.act, mode === "act");
    show(this.watchRow, mode === "watch");
    show(this.wheel, mode === "wheel");
    show(this.last, mode === "last");
    show(this.elim, mode === "elim");

    const timed = s.timeTotal > 0 && s.timeLeft > 0;
    if (mode === "act") this.updateAct(ctx, timed);
    else {
      this.canAct = false;
      this.wasLive = false;
      this.queued = false;
      this.betWindow = false;
    }
    if (mode === "watch") this.updateWatch(ctx, timed);
    else this.setHeckles(false);
    if (mode === "wheel") {
      const who = ctx.active;
      setText(this.wheelText, ctx.myTurn || !who ? "Patronun Çarkı dönüyor…" : `${who.nickname} çarkı çevirdi!`);
    } else if (mode === "last") this.updateLast(ctx);
    else if (mode === "elim") {
      const p = s.players.get(s.lastChanceId);
      setText(this.elimText, p ? `${p.nickname} çimento ayakkabılarla nehre… Balıklara selam!` : "Biri nehre gidiyor…");
    }
    if (mode === "none" || mode === "wheel" || mode === "elim") this.timer.sync(0, 1, false);
  }

  tick(dt: number): void {
    if (this.heckleCool > 0) {
      this.heckleCool -= dt;
      if (this.heckleCool <= 0) this.setHeckleCool(false);
    }
    for (let i = this.heckles.length - 1; i >= 0; i--) {
      const l = this.heckles[i];
      l.age += dt;
      if (l.age >= HECKLE_LIFE) {
        l.node.remove();
        this.heckles.splice(i, 1);
      }
    }
    if (this.mode === "none" || this.mode === "elim" || this.mode === "wheel") return;
    this.timer.tick(dt);
    const secs = this.timer.running ? String(this.timer.secs) : "";
    if (this.mode === "act") {
      this.risk.tick(dt);
      setBar(this.timerFill, this.timer.running ? this.timer.frac : this.timerEl.classList.contains("ks-hud-timer--busy") ? 1 : 0, this.timerBar);
      setText(this.timerNum, secs);
      const low = this.canAct && this.timer.running && this.timer.left > 0 && this.timer.left <= TIME_LOW_SEC;
      toggle(this.timerEl, "ks-hud-timer--low", low);
    } else if (this.mode === "watch") {
      setText(this.watchSecs, secs);
      show(this.watchSecs, secs !== "");
    } else if (this.mode === "last") {
      setText(this.lastNum, secs);
      toggle(this.lastNum, "ks-hud-last__num--low", this.timer.left <= 5);
    }
  }

  // ------------------------------------------------------------------ panels

  private panelFor(mode: Mode): HTMLElement | null {
    switch (mode) {
      case "act":
        return this.act;
      case "watch":
        return this.watchRow;
      case "wheel":
        return this.wheel;
      case "last":
        return this.last;
      case "elim":
        return this.elim;
      default:
        return null;
    }
  }

  private updateAct(ctx: HudCtx, timed: boolean): void {
    const s = ctx.state;
    const flipping = ctx.phase === "flipping";
    const can = flipping && !s.busy;
    this.canAct = can;
    setDisabled(this.flipBtn, !can);
    setDisabled(this.cashBtn, !can || s.flips === 0);
    toggle(this.act, "ks-hud-act--wait", !can);

    // GO cue: the moment the first card can be flipped (unless a queued Space is already flipping it)
    const go = can && s.flips === 0;
    if (go && !this.wasLive && !this.queued) {
      replay(this.flipBtn, "ks-hud-btn--go");
      replay(this.actNote, "ks-hud-pop");
      this.cb.onUiSound("open");
    }
    this.betWindow = ctx.phase === "betting";
    if (!this.betWindow) this.queued = false;
    if (!go) toggle(this.flipBtn, "ks-hud-btn--go", false);
    this.wasLive = can;

    const low = flipping && !s.busy && timed && s.timeLeft <= TIME_LOW_SEC;
    let note: string;
    let tone = "";
    if (ctx.phase === "betting") {
      if (s.settings.sideBets) {
        let against = 0;
        let backing = 0;
        s.bets.forEach((b) => {
          if (b.box === "cash") backing++;
          else against++;
        });
        const parts: string[] = [];
        if (against > 0) parts.push(`${against} bahis sana karşı`);
        if (backing > 0) parts.push(`${backing}${against > 0 ? "" : " bahis"} senden yana`);
        note = parts.length ? `🎲 ${parts.join(" · ")}` : "🎲 Bahisler toplanıyor… Sonra sıra sende.";
      } else note = "Sıra sende! Hazırlan…";
    } else if (s.busy) note = "Kart dönüyor…";
    else if (s.flips === 0) {
      note = low ? "Süre bitince kart otomatik çevrilir!" : "ÇEVİR! Kartını aç.";
      tone = low ? "hot" : "go";
    } else if (low) {
      note = "Süre bitince otomatik KASALA!";
      tone = "hot";
    } else if (s.raidChance >= SIREN_SHAKE_CHANCE) {
      note = "Delisin sen! Bir kart daha mı?";
      tone = "hot";
    } else if (picksFor(s.flips + 1) > picksFor(s.flips)) {
      note = `Bir kart daha: KASALA'da ${picksFor(s.flips + 1)} kart alırsın!`;
    } else note = "Çevir ya da KASALA! Karar senin.";
    setText(this.actNote, note);
    if (tone !== this.noteKey) {
      this.noteKey = tone;
      this.actNote.dataset.tone = tone;
    }

    // ÇEVİR heats up with the risk (one looping shake only at the very top)
    const tier = tierOf(s.raidChance);
    toggle(this.flipBtn, "ks-hud-btn--nervous", can && tier >= 2);
    toggle(this.flipBtn, "ks-hud-btn--scary", can && s.raidChance >= SIREN_SHAKE_CHANCE);
    show(this.lawyerChip, s.lawyers > 0);
    if (s.lawyers > 0) setText(this.lawyerChip, `⚖️×${s.lawyers}`);

    // what reaches the kasa under KASALA!: the best picksFor(flips) vitrin cards (the rest go to the Pazar)
    const values: number[] = [];
    s.row.forEach((card) => {
      if (!card.ownerId) values.push(card.value);
    });
    values.sort((a, b) => b - a);
    const picks = picksFor(s.flips);
    const pot = values.slice(0, picks).reduce((n, v) => n + v, 0);
    const kept = ctx.me?.taslik ? Math.floor(pot * (1 - TASLIK_CUT_PCT)) : pot;
    const rest = values.length > picks ? ` · ${values.length - picks} pazara` : "";
    let sub: string;
    if (s.flips === 0) sub = "Önce kart çevir";
    else if (ctx.me?.taslik && pot > 0) sub = `${money(kept, true)} · yarısı borca`;
    else sub = `${money(kept, true)}${rest}`;
    // (the row isn't held back while a card turns over: keep the old line until it has landed)
    if (!s.busy || s.flips === 0) setText(this.cashSub, sub);
    toggle(this.cashBtn, "ks-hud-btn--zero", s.flips === 0 || pot <= 0);
    toggle(this.cashBtn, "ks-hud-btn--juicy", can && pot >= 60);

    this.risk.update(ctx);

    // decision timer bar: grey while the bets come in or a card animates, red in the last seconds
    const betting = ctx.phase === "betting";
    toggle(this.timerEl, "ks-hud-timer--bet", betting);
    toggle(this.timerEl, "ks-hud-timer--busy", flipping && s.busy);
    if (flipping && s.busy) this.timer.sync(0, 1, false);
    else this.timer.sync(s.timeLeft, s.timeTotal, timed && (flipping || betting));
  }

  private updateWatch(ctx: HudCtx, timed: boolean): void {
    const s = ctx.state;
    const a = ctx.active!;
    setText(this.watchFace, animalIcon(a.animal));
    setVar(this.watchFace, "--pc", playerColor(a.color));
    setText(this.watchName, `${a.nickname}${a.bot ? " 🤖" : ""}`);
    const flipping = ctx.phase === "flipping";
    let note = "";
    if (ctx.phase === "betting") note = s.settings.sideBets ? "bahisler açık" : "hazırlanıyor";
    else if (s.busy) note = s.flips > 0 ? `${s.flips}. kart açılıyor…` : "kart açılıyor…";
    else if (s.flips === 0) note = "ilk kartı açacak";
    setText(this.watchNote, note);
    show(this.watchNote, note !== "");
    const riskOn = flipping;
    show(this.watchRisk, riskOn);
    if (riskOn) {
      setText(this.watchRisk, pct(s.raidChance));
      setVar(this.watchRisk, "--tier", tierColor(s.raidChance));
    }
    const potOn = flipping && s.flips > 0;
    show(this.watchPot, potOn);
    if (potOn) setText(this.watchPot, money(Math.max(0, s.turnPot)));
    toggle(this.watch, "ks-hud-watch--hot", flipping && s.raidChance >= SIREN_SHAKE_CHANCE);
    const runs = timed && !s.busy && (flipping || ctx.phase === "betting");
    this.timer.sync(s.timeLeft, s.timeTotal, runs);

    // heckles: only for players at the table, while cards are being flipped
    const heckle = flipping && ctx.participant;
    this.setHeckles(heckle);
    if (heckle) {
      const bet = ctx.me ? s.bets.get(ctx.me.id) : undefined;
      let want: HeckleKind | "" = "";
      if (bet && (bet.amount > 0 || bet.ghost)) {
        if (bet.box === "cash") want = "cash";
        else if (boxAlive(bet.box, s.flips)) want = "flip";
      }
      toggle(this.heckleFlip, "ks-hud-heckle--want", want === "flip");
      toggle(this.heckleCash, "ks-hud-heckle--want", want === "cash");
    }
  }

  private updateLast(ctx: HudCtx): void {
    const s = ctx.state;
    const broke = s.players.get(s.lastChanceId);
    const name = broke?.nickname ?? "?";
    const isMe = s.lastChanceId === ctx.myId;
    const me = ctx.me;
    const canLend = !!me && !isMe && !me.ghost && !ctx.spectator && me.kasa > 0 && s.settings.loans;
    toggle(this.last, "ks-hud-last--me", isMe);
    setText(this.lastTitle, isMe ? "KASAN SIFIR!" : "SON ŞANS!");
    setText(
      this.lastText,
      isMe ? "Biri borç vermezse nehre gidiyorsun. Yalvar, söz ver, faiz teklif et!" : `${toName(name)} borç verecek var mı? Yoksa balıklar zengin olacak.`,
    );
    show(this.lastBtn, s.settings.loans && (isMe || canLend));
    setText(this.lastBtn, isMe ? "Borç iste  [B]" : "Borç ver  [B]");
    this.timer.sync(s.timeLeft, s.timeTotal, s.timeTotal > 0);
  }

  // ------------------------------------------------------------------ heckles

  private heckleButton(kind: HeckleKind, key: string, label: string, title: string): HTMLButtonElement {
    const b = h("button", `ks-hud-heckle ks-hud-heckle--${kind}`, this.watchRow);
    h("span", "ks-hud-heckle__key", b, key);
    h("span", "ks-hud-heckle__label", b, label);
    b.title = `${title} (${key})`;
    wireButton(b, (k) => this.cb.onUiSound(k), () => this.sendHeckle(kind), "");
    return b;
  }

  private sendHeckle(kind: HeckleKind): void {
    if (this.heckleCool > 0) {
      this.cb.onUiSound("deny");
      return;
    }
    this.cb.onHeckle(kind);
    replay(kind === "flip" ? this.heckleFlip : this.heckleCash, "ks-hud-pop");
    this.heckleCool = EMOTE_COOLDOWN_SEC;
    this.setHeckleCool(true);
  }

  private setHeckleCool(on: boolean): void {
    toggle(this.heckleFlip, "ks-hud-heckle--cool", on);
    toggle(this.heckleCash, "ks-hud-heckle--cool", on);
  }

  private setHeckles(on: boolean): void {
    if (on === this.heckleOn) return;
    this.heckleOn = on;
    show(this.heckleFlip, on);
    show(this.heckleCash, on);
  }

  private clearHeckles(): void {
    for (const l of this.heckles) l.node.remove();
    this.heckles.length = 0;
  }

  /** New match / HUD hidden: drop transient bits. */
  reset(): void {
    this.clearHeckles();
    this.clearPressed();
    this.wasLive = false;
    this.queued = false;
    this.heckleCool = 0;
    this.setHeckleCool(false);
  }

  /** The button a game key squashes (whatever panel is up right now). */
  private keyButton(code: string): HTMLButtonElement | null {
    switch (code) {
      case "Space":
        return this.flipBtn;
      case "Enter":
      case "NumpadEnter":
        return this.cashBtn;
      case "KeyZ":
        return this.heckleFlip;
      case "KeyX":
        return this.heckleCash;
      default:
        return null;
    }
  }

  private clearPressed(): void {
    for (const b of [this.flipBtn, this.cashBtn, this.heckleFlip, this.heckleCash]) toggle(b, "ks-hud-btn--pressed", false);
  }

  private keyEcho(e: KeyboardEvent, down: boolean): void {
    const btn = this.keyButton(e.code);
    if (!btn) return;
    // Release: always let go, even when the panel changed while the key was held.
    if (!down) {
      toggle(btn, "ks-hud-btn--pressed", false);
      return;
    }
    // Same filter as Controls: nothing happens while typing, with modifiers or under a key-owning window.
    if (typingInField() || e.ctrlKey || e.metaKey || e.altKey || uiCapturesKeys()) return;
    if (this.mode === "act" && this.betWindow && e.code === "Space") this.queued = true;
    const live =
      this.mode === "act" ? btn === this.flipBtn || btn === this.cashBtn : this.mode === "watch" && this.heckleOn && (btn === this.heckleFlip || btn === this.heckleCash);
    if (!live || btn.disabled) return;
    toggle(btn, "ks-hud-btn--pressed", true);
    if (!e.repeat && (btn === this.heckleFlip || btn === this.heckleCash) && this.heckleCool <= 0) {
      // Controls sends the heckle; mirror the cooldown so the buttons read right
      this.heckleCool = EMOTE_COOLDOWN_SEC;
      this.setHeckleCool(true);
    }
  }
}
