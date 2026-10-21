// In-game HUD (DOM). Owner: client-hud. PUBLIC API IS THE CONTRACT.
// Styles in ./hud.css (create it, import it here). Tokens from ./theme.css. Responsive down to ~380 px wide.
//
// Layout (game2.md §13.4):
//  - Top center: round pips (●●●○○○○) + turn-order strip of chef icons (player-color hat circles, the active
//    one bigger + bouncing, "YOU" tag).
//  - Top right: coin leaderboard (sorted, animated count-up/down, coin emoji, 👑 for the leader, disconnected dim).
//  - Bottom center: current rule card chip (emoji, name, ×mult, rarity color) + placement timer ring (SVG
//    circle; turns red + shakes in the last 3 s) + "Next up" piece (PiecePreview canvas from ../scene/Pieces,
//    piece name + quip) + controls hint for the active player ("Move mouse • Q/E or scroll rotate • W/S tilt •
//    Click drop"), and "Press SPACE to open the case!" (pulsing) when it's my spin.
//  - Bottom right (not my turn, side bets on, before the drop): guess panel "Will it stay up?" with two big
//    buttons 👍 Stays up / 👎 Falls (F/G), one fixed stake (BET_STAKE); one click places the guess, the other
//    button switches it; "You guessed: Stays up ✔" after. Hidden when I can't afford the stake.
//  - Left: tower height meter (vertical ruler with a cartoon cake at the bottom, cm) + "If it stands: +34 🪙" /
//    "If it falls: −5 🪙".
//  - First-turn coach (my first 2 placing turns / my first spin): a big friendly bubble above the bottom row
//    plus a bouncing arrow over my hovering piece (pointAt). Someone else's first turn: a one-liner above the
//    guess panel.
//  - Saboteur only: small 😈 badge with "Rig ready (R)" / "Rig used" / "Wait for someone's spin".
//  - Feed (left-bottom): last 6 lines, slide in, fade out after 8 s. Game calls feed() with HTML.
//  - Status banner (top under pips): big short text like "Deniz's turn!", "YOUR TURN!", "Settling…" with a
//    drumroll wobble.
//  - Tab held: full scoreboard (coins, survived, topples, best ×, bet profit) — setScoreboard(visible).
//  - Emote wheel hint "T: emote".
//
// Everything is built once in the constructor and patched in place by update(); nicknames only ever go in
// through textContent. Funny bits: the timer ring sweats (and its face panics) in the last 3 s, a tiny ant
// climbs the height ruler (and gets flung off when the tower falls), coins jiggle while they count.

import "./hud.css";
import {
  BET_STAKE,
  CARD_BY_ID,
  PIECES,
  PLAYER_COLORS,
  RARITY_COLORS,
  topplePenalty,
  type CardId,
  type PieceType,
  type Rarity,
} from "../../../shared/constants";
import type { BetSide, JellyStateView, PlayerView } from "../../../shared/protocol";
import { PiecePreview } from "../scene/Pieces";
import { cardName, cardText, locale, pieceName, pieceQuip, t, upper } from "../i18n";

export interface HudHandlers {
  onBet(side: BetSide, amount: number): void;
  onSpin(): void;
  onUiSound(kind: "click" | "hover" | "pop"): void;
}

export interface HudExtra {
  myId: string;
  isSaboteur: boolean;
  rig: { available: boolean; used: boolean };
  /** My current bet this turn (local echo). */
  myBet: { side: BetSide; amount: number } | null;
  /** First-turn coach hints (Game decides when). */
  coach: { place: boolean; spin: boolean; watch: boolean };
}

/** Escape text for the HTML that Game passes to feed(). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

// ---------------------------------------------------------------- small DOM helpers
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}
function toggle(e: Element, cls: string, on: boolean): void {
  if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on);
}
function fmtNum(n: number): string {
  return n.toLocaleString(locale());
}
function fmtMult(m: number): string {
  return `×${m.toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: Number.isInteger(m) ? 0 : 1 })}`;
}
function playerColor(p: PlayerView | undefined): string {
  return PLAYER_COLORS[p ? p.color % PLAYER_COLORS.length : 0];
}
/** Restart a CSS animation class. */
function replay(e: HTMLElement, cls: string): void {
  e.classList.remove(cls);
  void e.offsetWidth;
  e.classList.add(cls);
}

const SVG_NS = "http://www.w3.org/2000/svg";
const RING_R = 28;
const RING_C = 2 * Math.PI * RING_R;
const PANIC_SEC = 3;
const FEED_MAX = 6;
const FEED_LIFE_MS = 8000;

// Cartoon cake at the bottom of the height ruler + the climbing ant.
const CAKE_SVG = `<svg viewBox="0 0 64 44" aria-hidden="true">
  <rect x="6" y="18" width="52" height="20" rx="5" fill="#F6D59A" stroke="#2D2A32" stroke-width="3"/>
  <path d="M6 24 C12 32 16 20 22 28 S32 20 38 28 S50 20 58 26 V20 a5 5 0 0 0-5-5 H11 a5 5 0 0 0-5 5z" fill="#FFB7D5" stroke="#2D2A32" stroke-width="3" stroke-linejoin="round"/>
  <rect x="2" y="37" width="60" height="5" rx="2.5" fill="#fff6e5" stroke="#2D2A32" stroke-width="3"/>
  <circle cx="32" cy="10" r="6" fill="#FF5A5F" stroke="#2D2A32" stroke-width="3"/>
  <path d="M32 4 q3-4 7-3" fill="none" stroke="#2D2A32" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="30" cy="10" r="1.6" fill="#fff"/>
</svg>`;
const ANT_SVG = `<svg viewBox="0 0 30 22" aria-hidden="true">
  <g class="jjh-ant__legs" stroke="#2D2A32" stroke-width="1.6" stroke-linecap="round" fill="none">
    <path class="l1" d="M11 13 l-3 6"/><path class="l2" d="M15 13 l0 7"/><path class="l3" d="M19 13 l3 6"/>
  </g>
  <ellipse cx="8" cy="11" rx="5" ry="4" fill="#3a2a22" stroke="#2D2A32" stroke-width="1.2"/>
  <ellipse cx="15" cy="11" rx="3" ry="2.6" fill="#3a2a22"/>
  <circle cx="22" cy="9" r="4" fill="#3a2a22" stroke="#2D2A32" stroke-width="1.2"/>
  <circle cx="23.5" cy="7.6" r="2" fill="#fff"/><circle class="jjh-ant__pupil" cx="24.2" cy="7.9" r="0.9" fill="#111"/>
  <path d="M24 5 q2-4 5-4 M22 5 q0-4 2-5" stroke="#2D2A32" stroke-width="1.2" fill="none" stroke-linecap="round"/>
  <rect x="17" y="1" width="6" height="3" rx="1" fill="#FFCF33" stroke="#2D2A32" stroke-width="0.8" transform="rotate(-15 20 2.5)"/>
</svg>`;

interface LbRow {
  root: HTMLDivElement;
  place: HTMLSpanElement;
  dot: HTMLSpanElement;
  name: HTMLSpanElement;
  bet: HTMLSpanElement;
  coins: HTMLSpanElement;
  target: number;
  shown: number;
}

interface SbRow {
  root: HTMLTableRowElement;
  cells: HTMLTableCellElement[];
}

export class Hud {
  private readonly handlers: HudHandlers;
  private readonly root: HTMLDivElement;
  private visible = false;
  private state: JellyStateView | null = null;
  private extra: HudExtra | null = null;

  // top center
  private readonly roundLabel: HTMLDivElement;
  private readonly pips: HTMLDivElement;
  private pipKey = "";
  private readonly strip: HTMLDivElement;
  private stripKey = "";
  private stripItems: HTMLDivElement[] = [];
  private readonly bannerEl: HTMLDivElement;
  private bannerTimer = 0;

  // leaderboard
  private readonly lb: HTMLDivElement;
  private readonly lbRows = new Map<string, LbRow>();

  // bottom center
  private readonly bottom: HTMLDivElement;
  private readonly cardChip: HTMLDivElement;
  private readonly cardEmoji: HTMLSpanElement;
  private readonly cardName: HTMLSpanElement;
  private readonly cardMult: HTMLSpanElement;
  private readonly cardText: HTMLSpanElement;
  private cardKey = "";
  private readonly timer: HTMLDivElement;
  private readonly timerArc: SVGCircleElement;
  private readonly timerNum: HTMLSpanElement;
  private readonly timerFace: HTMLSpanElement;
  private timerOn = false;
  private timerLeft = 0;
  private timerTotal = 1;
  private sweatClock = 0;
  private readonly next: HTMLDivElement;
  private readonly nextCanvasBox: HTMLDivElement;
  private readonly nextEmoji: HTMLSpanElement;
  private readonly nextName: HTMLSpanElement;
  private readonly nextQuip: HTMLSpanElement;
  private readonly inHand: HTMLDivElement;
  private preview: PiecePreview | null = null;
  private previewFailed = false;
  private previewType = "";
  private readonly hint: HTMLDivElement;
  private readonly spinBtn: HTMLButtonElement;

  // first-turn coach
  private readonly coachEl: HTMLDivElement;
  private readonly coachMain: HTMLDivElement;
  private readonly coachSub: HTMLDivElement;
  private readonly arrow: HTMLDivElement;
  private coachMode: "" | "aim" | "drop" | "spin" = "";
  private coachMoved = 0;
  private coachAge = 0;
  private lastPointer: { x: number; y: number } | null = null;
  private readonly touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

  // bet panel
  private readonly betPanel: HTMLDivElement;
  private readonly betCoach: HTMLDivElement;
  private readonly betStand: HTMLButtonElement;
  private readonly betFall: HTMLButtonElement;
  private readonly betStatus: HTMLDivElement;

  // height meter
  private readonly meter: HTMLDivElement;
  private readonly ruler: HTMLDivElement;
  private readonly ticks: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly ant: HTMLDivElement;
  private readonly recordFlag: HTMLDivElement;
  private readonly heightNum: HTMLSpanElement;
  private readonly payout: HTMLDivElement;
  private readonly penalty: HTMLDivElement;
  private rulerMax = 0;
  private heightTarget = 0;
  private heightShown = 0;
  private antPos = 0;
  private antFalling = 0;
  private record = 0;
  private lastHeight = 0;

  // saboteur
  private readonly sab: HTMLDivElement;
  private readonly sabText: HTMLSpanElement;

  // misc
  private readonly feedEl: HTMLDivElement;
  private readonly emoteHint: HTMLDivElement;
  private readonly board: HTMLDivElement;
  private readonly boardBody: HTMLTableSectionElement;
  private readonly boardRows = new Map<string, SbRow>();
  private boardVisible = false;

  constructor(root: HTMLElement, handlers: HudHandlers) {
    this.handlers = handlers;
    this.root = el("div", "jjh jjh--hidden", root);
    this.root.setAttribute("aria-live", "polite");

    // ---- top center: pips + turn strip + banner
    const top = el("div", "jjh-top", this.root);
    const roundBox = el("div", "jjh-round jjh-box", top);
    this.roundLabel = el("div", "jjh-round__label", roundBox, t("hud.round", { round: 1, total: 1 }));
    this.pips = el("div", "jjh-pips", roundBox);
    this.strip = el("div", "jjh-strip", top);
    this.bannerEl = el("div", "jjh-banner", top);

    // ---- top right: leaderboard
    this.lb = el("div", "jjh-lb jjh-box", this.root);
    el("div", "jjh-lb__title", this.lb, t("hud.coinJar"));

    // ---- left: height meter
    this.meter = el("div", "jjh-meter jjh-box", this.root);
    el("div", "jjh-meter__title", this.meter, t("hud.tower"));
    this.heightNum = el("span", "jjh-meter__num", el("div", "jjh-meter__height", this.meter), t("hud.heightCm", { n: 0 }));
    this.ruler = el("div", "jjh-ruler", this.meter);
    this.ticks = el("div", "jjh-ruler__ticks", this.ruler);
    this.fill = el("div", "jjh-ruler__fill", this.ruler);
    this.recordFlag = el("div", "jjh-ruler__record", this.ruler, "🚩");
    this.recordFlag.title = t("hud.recordTitle");
    this.ant = el("div", "jjh-ant", this.ruler);
    this.ant.innerHTML = ANT_SVG;
    const cake = el("div", "jjh-meter__cake", this.meter);
    cake.innerHTML = CAKE_SVG;
    this.payout = el("div", "jjh-meter__payout", this.meter);
    this.penalty = el("div", "jjh-meter__penalty", this.meter);

    // ---- saboteur badge
    this.sab = el("div", "jjh-sab jjh-box", this.root);
    el("span", "jjh-sab__devil", this.sab, "😈");
    this.sabText = el("span", "jjh-sab__text", this.sab);

    // ---- feed
    this.feedEl = el("div", "jjh-feed", this.root);

    // ---- bottom center
    this.bottom = el("div", "jjh-bottom", this.root);
    this.spinBtn = el("button", "jjh-spin jj-btn", this.bottom);
    this.spinBtn.type = "button";
    el("span", "jjh-spin__key", this.spinBtn, t("hud.spinKey"));
    this.spinBtn.append(` ${t("hud.spinPrompt")}`);
    this.wireButton(this.spinBtn, () => this.handlers.onSpin());

    const row = el("div", "jjh-bottom__row", this.bottom);
    this.cardChip = el("div", "jjh-card", row);
    this.cardEmoji = el("span", "jjh-card__emoji", this.cardChip);
    const cardMid = el("span", "jjh-card__mid", this.cardChip);
    this.cardName = el("span", "jjh-card__name", cardMid);
    this.cardText = el("span", "jjh-card__text", cardMid);
    this.cardMult = el("span", "jjh-card__mult", this.cardChip);

    this.timer = el("div", "jjh-timer", row);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 72 72");
    svg.classList.add("jjh-timer__svg");
    const bg = document.createElementNS(SVG_NS, "circle");
    bg.setAttribute("cx", "36");
    bg.setAttribute("cy", "36");
    bg.setAttribute("r", String(RING_R));
    bg.setAttribute("class", "jjh-timer__bg");
    this.timerArc = document.createElementNS(SVG_NS, "circle");
    this.timerArc.setAttribute("cx", "36");
    this.timerArc.setAttribute("cy", "36");
    this.timerArc.setAttribute("r", String(RING_R));
    this.timerArc.setAttribute("class", "jjh-timer__arc");
    this.timerArc.setAttribute("stroke-dasharray", RING_C.toFixed(2));
    this.timerArc.setAttribute("transform", "rotate(-90 36 36)");
    svg.append(bg, this.timerArc);
    this.timer.appendChild(svg);
    this.timerNum = el("span", "jjh-timer__num", this.timer, "10");
    this.timerFace = el("span", "jjh-timer__face", this.timer, "🙂");

    this.next = el("div", "jjh-next", row);
    this.nextCanvasBox = el("div", "jjh-next__canvas", this.next);
    this.nextEmoji = el("span", "jjh-next__emoji", this.nextCanvasBox);
    const nextInfo = el("div", "jjh-next__info", this.next);
    el("span", "jjh-next__label", nextInfo, t("hud.nextUp"));
    this.nextName = el("span", "jjh-next__name", nextInfo);
    this.nextQuip = el("span", "jjh-next__quip", nextInfo);
    this.inHand = el("div", "jjh-next__hand", nextInfo);

    this.hint = el("div", "jjh-hint", this.bottom);

    // ---- first-turn coach (bubble above the bottom row + arrow over my piece)
    this.coachEl = el("div", "jjh-coach", this.root);
    this.coachMain = el("div", "jjh-coach__main", this.coachEl);
    this.coachSub = el("div", "jjh-coach__sub", this.coachEl);
    this.arrow = el("div", "jjh-arrow", this.root);
    el("span", "jjh-arrow__icon", this.arrow, "👇");
    window.addEventListener("pointermove", (e) => {
      if (this.coachMode !== "aim") return;
      if (this.lastPointer) this.coachMoved += Math.hypot(e.clientX - this.lastPointer.x, e.clientY - this.lastPointer.y);
      this.lastPointer = { x: e.clientX, y: e.clientY };
    });

    // ---- bottom right: bet panel
    this.betPanel = el("div", "jjh-bet jjh-box", this.root);
    this.betCoach = el("div", "jjh-bet__coach", this.betPanel, t("hud.betCoach"));
    el("div", "jjh-bet__title", this.betPanel, t("hud.betTitle"));
    const sides = el("div", "jjh-bet__sides", this.betPanel);
    this.betStand = el("button", "jj-btn jj-btn--green jjh-side", sides);
    this.betStand.type = "button";
    el("span", "jjh-side__label", this.betStand, t("hud.stand"));
    el("small", "", this.betStand, "F");
    this.betFall = el("button", "jj-btn jj-btn--red jjh-side", sides);
    this.betFall.type = "button";
    el("span", "jjh-side__label", this.betFall, t("hud.fall"));
    el("small", "", this.betFall, "G");
    el("div", "jjh-bet__rules", this.betPanel, t("hud.betRules", { n: fmtNum(BET_STAKE) }));
    this.wireButton(this.betStand, () => this.placeBet("stand"));
    this.wireButton(this.betFall, () => this.placeBet("fall"));
    this.betStatus = el("div", "jjh-bet__status", this.betPanel);

    // ---- emote hint + scoreboard
    this.emoteHint = el("div", "jjh-emote", this.root);
    this.emoteHint.innerHTML = t("hud.emoteHint", { t: "<kbd>T</kbd>", tab: "<kbd>Tab</kbd>" });

    this.board = el("div", "jjh-board jj-panel", this.root);
    el("div", "jjh-board__title", this.board, t("hud.boardTitle"));
    const table = el("table", "jjh-board__table", this.board);
    const head = el("thead", "", table);
    const hr = el("tr", "", head);
    for (const h of ["", "colChef", "colCoins", "colSurvived", "colTopples", "colBest", "colBets"]) el("th", "", hr, h ? t(`hud.${h}`) : "");
    this.boardBody = el("tbody", "", table);

    this.hideAllDynamic();
  }

  show(): void {
    this.visible = true;
    toggle(this.root, "jjh--hidden", false);
  }

  hide(): void {
    this.visible = false;
    toggle(this.root, "jjh--hidden", true);
    if (this.coachMode) this.setCoach("");
    this.setScoreboard(false);
  }

  /** Re-render from state (every patch; diff internally, keep it cheap). */
  update(state: JellyStateView, extra: HudExtra): void {
    this.state = state;
    this.extra = extra;
    if (state.phase === "lobby") {
      this.record = 0;
      this.lastHeight = 0;
    }
    const me = state.players.get(extra.myId);
    const myTurn = state.activeId !== "" && state.activeId === extra.myId;
    const inTurn = state.phase === "spinning" || state.phase === "placing" || state.phase === "settling" || state.phase === "result";

    this.updatePips(state);
    this.updateStrip(state, extra.myId);
    this.updateLeaderboard(state, extra.myId);
    this.updateCard(state, inTurn);
    this.updateTimer(state);
    this.updateNext(state, myTurn);
    this.updateHint(state, myTurn, extra.coach.place);
    this.updateCoach(state, extra);
    this.updateBet(state, extra, me, myTurn);
    this.updateMeter(state, inTurn);
    this.updateSaboteur(state, extra);
    toggle(this.emoteHint, "jjh-on", inTurn);
    if (this.boardVisible) this.updateBoard(state, extra.myId);
  }

  /** Per-frame (timer ring smoothing, preview canvas). */
  tick(dt: number): void {
    if (!this.visible) return;
    const k = Math.min(1, dt * 7);

    // coin count-up / count-down
    for (const row of this.lbRows.values()) {
      if (row.shown === row.target) continue;
      const diff = row.target - row.shown;
      const step = diff * k;
      row.shown = Math.abs(diff) < 0.6 ? row.target : row.shown + (Math.abs(step) < 0.4 ? Math.sign(diff) * 0.4 : step);
      setText(row.coins, fmtNum(Math.round(row.shown)));
      toggle(row.root, "jjh-lb__row--counting", row.shown !== row.target);
    }

    // timer ring (local countdown between 20 Hz patches)
    if (this.timerOn) {
      this.timerLeft = Math.max(0, this.timerLeft - dt);
      this.renderTimer();
      if (this.timerLeft > 0 && this.timerLeft <= PANIC_SEC) {
        this.sweatClock -= dt;
        if (this.sweatClock <= 0) {
          this.sweatClock = 0.18 + Math.random() * 0.22;
          this.sweatDrop();
        }
      }
    }

    // height meter + ant
    this.heightShown += (this.heightTarget - this.heightShown) * k;
    if (Math.abs(this.heightTarget - this.heightShown) < 0.05) this.heightShown = this.heightTarget;
    const max = this.rulerMax || 40;
    const fillPct = Math.min(100, (this.heightShown / max) * 100);
    this.fill.style.height = `${fillPct.toFixed(2)}%`;
    setText(this.heightNum, t("hud.heightCm", { n: fmtNum(Math.round(this.heightShown)) }));
    if (this.antFalling > 0) {
      this.antFalling -= dt;
      if (this.antFalling <= 0) {
        this.ant.classList.remove("jjh-ant--fall");
        this.antPos = 0;
      }
    } else {
      // the ant strolls toward the top of the fill at ant speed (~30 %/s), so it visibly climbs
      const goal = Math.max(0, fillPct - 2);
      const d = goal - this.antPos;
      const walk = Math.sign(d) * Math.min(Math.abs(d), dt * 30);
      this.antPos += walk;
      toggle(this.ant, "jjh-ant--walk", Math.abs(d) > 0.5);
      toggle(this.ant, "jjh-ant--down", d < -0.5);
    }
    this.ant.style.bottom = `${this.antPos.toFixed(2)}%`;

    // coach: aim → drop once the mouse has moved a bit (or after a few seconds)
    if (this.coachMode === "aim" || this.coachMode === "drop") {
      this.coachAge += dt;
      if (this.coachMode === "aim" && (this.coachMoved > 220 || this.coachAge > 3.5)) this.setCoach("drop");
    }

    // next-up preview
    if (this.preview && this.previewType) {
      try {
        this.preview.update(dt);
      } catch {
        /* preview is decorative */
      }
    }
  }

  feed(html: string, icon?: string): void {
    const line = el("div", "jjh-feed__line", this.feedEl);
    if (icon) el("span", "jjh-feed__icon", line, icon);
    const body = el("span", "jjh-feed__text", line);
    body.innerHTML = html;
    while (this.feedEl.children.length > FEED_MAX) {
      const old = this.feedEl.firstElementChild as HTMLElement | null;
      if (!old) break;
      old.remove();
    }
    window.setTimeout(() => line.classList.add("jjh-feed__line--out"), FEED_LIFE_MS);
    window.setTimeout(() => line.remove(), FEED_LIFE_MS + 600);
  }

  banner(text: string, tone: "neutral" | "good" | "bad" | "gold" = "neutral"): void {
    const b = this.bannerEl;
    b.textContent = text;
    b.className = `jjh-banner jjh-banner--${tone}`;
    replay(b, "jjh-banner--in");
    this.handlers.onUiSound("pop");
    window.clearTimeout(this.bannerTimer);
    const ms = 1600 + Math.min(1400, text.length * 45);
    this.bannerTimer = window.setTimeout(() => b.classList.add("jjh-banner--out"), ms);
  }

  setScoreboard(visible: boolean): void {
    this.boardVisible = visible;
    toggle(this.board, "jjh-on", visible);
    if (visible && this.state && this.extra) this.updateBoard(this.state, this.extra.myId);
  }

  /** Flash a coin delta next to a player's leaderboard row. */
  coinDelta(playerId: string, delta: number): void {
    if (!delta) return;
    const row = this.lbRows.get(playerId);
    const host = row ? row.root : this.lb;
    const pop = el("span", `jjh-delta ${delta > 0 ? "jjh-delta--up" : "jjh-delta--down"}`, host, `${delta > 0 ? "+" : "−"}${fmtNum(Math.abs(delta))}`);
    pop.style.setProperty("--wob", `${(Math.random() * 16 - 8).toFixed(1)}deg`);
    window.setTimeout(() => pop.remove(), 1700);
    if (row) replay(row.root, delta > 0 ? "jjh-lb__row--yay" : "jjh-lb__row--ouch");
  }

  // ======================================================================= sections

  private updatePips(state: JellyStateView): void {
    const total = Math.max(1, state.totalRounds);
    const round = Math.max(1, Math.min(total, state.round));
    const key = `${total}:${round}`;
    setText(this.roundLabel, t("hud.round", { round, total }));
    if (key === this.pipKey) return;
    if (this.pips.children.length !== total) {
      this.pips.replaceChildren();
      for (let i = 0; i < total; i++) el("span", "jjh-pip", this.pips);
    }
    Array.from(this.pips.children).forEach((p, i) => {
      toggle(p, "jjh-pip--done", i < round - 1);
      toggle(p, "jjh-pip--now", i === round - 1);
    });
    this.pipKey = key;
  }

  private updateStrip(state: JellyStateView, myId: string): void {
    const ids: string[] = [];
    state.turnOrder.forEach((id) => ids.push(id));
    const key = ids
      .map((id) => {
        const p = state.players.get(id);
        return `${id}/${p?.color ?? 0}/${p?.nickname ?? ""}`;
      })
      .join("|") + `#${myId}`;
    if (key !== this.stripKey) {
      this.strip.replaceChildren();
      this.stripItems = ids.map((id) => {
        const p = state.players.get(id);
        const item = el("div", "jjh-chef", this.strip);
        item.style.setProperty("--pc", playerColor(p));
        item.title = p?.nickname ?? "?";
        el("span", "jjh-chef__hat", item);
        el("span", "jjh-chef__face", item, upper((p?.nickname ?? "?").slice(0, 1)));
        if (id === myId) el("span", "jjh-chef__you", item, upper(t("hud.you")));
        return item;
      });
      this.stripKey = key;
    }
    // the active slot: the index of this turn when the order covers every turn, else the active id
    const n = ids.length;
    let activeIdx = -1;
    if (state.activeId && n > 0) {
      const byTurn = state.turnInRound % n;
      activeIdx = ids[byTurn] === state.activeId ? byTurn : ids.indexOf(state.activeId);
    }
    const playing = state.phase !== "lobby" && state.phase !== "roleReveal" && state.phase !== "matchEnd";
    this.stripItems.forEach((item, i) => {
      const p = state.players.get(ids[i]);
      toggle(item, "jjh-chef--active", playing && i === activeIdx);
      toggle(item, "jjh-chef--done", playing && n >= state.turnsPerRound && i < state.turnInRound);
      toggle(item, "jjh-chef--off", !!p && !p.connected);
    });
  }

  private updateLeaderboard(state: JellyStateView, myId: string): void {
    const list: PlayerView[] = [];
    state.players.forEach((p) => {
      if (!p.spectator) list.push(p);
    });
    list.sort((a, b) => b.coins - a.coins || a.seat - b.seat);
    const seen = new Set<string>();
    const topCoins = list.length ? list[0].coins : 0;
    const tiedTop = list.filter((p) => p.coins === topCoins).length > 1;
    list.forEach((p, i) => {
      seen.add(p.id);
      let row = this.lbRows.get(p.id);
      if (!row) {
        const root = el("div", "jjh-lb__row", this.lb);
        row = {
          root,
          place: el("span", "jjh-lb__place", root),
          dot: el("span", "jjh-lb__dot", root),
          name: el("span", "jjh-lb__name", root),
          bet: el("span", "jjh-lb__bet", root, "🎲"),
          coins: el("span", "jjh-lb__coins", root, fmtNum(p.coins)),
          target: p.coins,
          shown: p.coins,
        };
        el("span", "jjh-lb__coin", root, "🪙");
        this.lbRows.set(p.id, row);
      }
      row.target = p.coins;
      row.root.style.setProperty("--i", String(i));
      row.dot.style.background = playerColor(p);
      setText(row.name, p.nickname);
      const leader = i === 0 && !tiedTop && p.coins > 0;
      setText(row.place, leader ? "👑" : `${i + 1}`);
      toggle(row.root, "jjh-lb__row--leader", leader);
      toggle(row.root, "jjh-lb__row--me", p.id === myId);
      toggle(row.root, "jjh-lb__row--off", !p.connected);
      toggle(row.root, "jjh-lb__row--active", p.id === state.activeId);
      toggle(row.bet, "jjh-on", p.hasBet && (state.phase === "spinning" || state.phase === "placing" || state.phase === "settling"));
      row.root.title = p.connected ? p.nickname : t("hud.reconnecting", { name: p.nickname });
    });
    for (const [id, row] of this.lbRows) {
      if (!seen.has(id)) {
        row.root.remove();
        this.lbRows.delete(id);
      }
    }
    this.lb.style.setProperty("--n", String(list.length));
  }

  private updateCard(state: JellyStateView, inTurn: boolean): void {
    // Don't spoil the reel: only show the rule once it has landed.
    const landed = state.phase !== "spinning" || state.spinStage === "landed";
    const id = state.card.id as CardId | "";
    const def = id ? CARD_BY_ID[id as CardId] : undefined;
    const on = inTurn && landed && !!def;
    toggle(this.cardChip, "jjh-on", on);
    if (!on || !def) {
      this.cardKey = "";
      return;
    }
    const key = `${id}:${state.card.multiplier}`;
    if (key === this.cardKey) return;
    this.cardKey = key;
    const rarity = (state.card.rarity || def.rarity) as Rarity;
    this.cardChip.style.setProperty("--rc", RARITY_COLORS[rarity] ?? RARITY_COLORS.common);
    this.cardChip.dataset.rarity = rarity;
    const mult = state.card.multiplier || def.multiplier;
    const plain = id === "plain";
    setText(this.cardEmoji, def.emoji);
    const rule = plain ? t("hud.cardPlain") : t("hud.cardRule", { name: cardName(id), mult: fmtMult(mult) });
    setText(this.cardName, rule);
    this.cardName.title = rule;
    setText(this.cardText, plain ? "" : cardText(id));
    toggle(this.cardChip, "jjh-card--plain", plain);
    setText(this.cardMult, fmtMult(mult));
    replay(this.cardChip, "jjh-card--pop");
  }

  private updateTimer(state: JellyStateView): void {
    const on = state.phase === "placing" && state.timeTotal > 0;
    toggle(this.timer, "jjh-on", on);
    if (!on) {
      this.timerOn = false;
      toggle(this.timer, "jjh-timer--panic", false);
      return;
    }
    if (!this.timerOn || Math.abs(state.timeLeft - this.timerLeft) > 0.25 || state.timeTotal !== this.timerTotal) {
      this.timerLeft = state.timeLeft;
    }
    this.timerTotal = Math.max(0.001, state.timeTotal);
    this.timerOn = true;
    this.renderTimer();
  }

  private renderTimer(): void {
    const frac = Math.max(0, Math.min(1, this.timerLeft / this.timerTotal));
    this.timerArc.setAttribute("stroke-dashoffset", (RING_C * (1 - frac)).toFixed(2));
    const hue = Math.round(120 * frac); // green → yellow → red
    this.timerArc.style.stroke = `hsl(${hue} 85% 52%)`;
    setText(this.timerNum, String(Math.ceil(this.timerLeft)));
    const panic = this.timerLeft > 0 && this.timerLeft <= PANIC_SEC;
    toggle(this.timer, "jjh-timer--panic", panic);
    setText(this.timerFace, this.timerLeft <= 1.2 ? "😱" : panic ? "😰" : frac < 0.6 ? "😬" : "🙂");
  }

  private sweatDrop(): void {
    const d = el("span", "jjh-sweat", this.timer);
    const side = Math.random() < 0.5 ? -1 : 1;
    d.style.left = `${50 + side * (28 + Math.random() * 18)}%`;
    d.style.top = `${10 + Math.random() * 30}%`;
    d.style.setProperty("--dx", `${side * (10 + Math.random() * 16)}px`);
    window.setTimeout(() => d.remove(), 900);
  }

  private updateNext(state: JellyStateView, myTurn: boolean): void {
    const active = state.phase === "spinning" || state.phase === "placing" || state.phase === "settling";
    const type = (state.nextPiece in PIECES ? state.nextPiece : "") as PieceType | "";
    toggle(this.next, "jjh-on", active && type !== "");
    if (type !== this.previewType) {
      this.previewType = type;
      if (type) {
        const def = PIECES[type];
        setText(this.nextName, t("hud.pieceLabel", { emoji: def.emoji, name: pieceName(type) }));
        setText(this.nextQuip, pieceQuip(type));
        setText(this.nextEmoji, def.emoji);
        replay(this.next, "jjh-next--pop");
      }
      this.ensurePreview();
      if (this.preview) {
        try {
          this.preview.set(type);
        } catch {
          /* fall back to the emoji */
        }
      }
    }
    // the piece in hand, for whoever is placing (the 3D scene shows it, this just names it)
    const handType = state.phase === "placing" && state.currentPiece in PIECES ? (state.currentPiece as PieceType) : null;
    toggle(this.inHand, "jjh-on", !!handType);
    if (handType) {
      const extra = state.piecesLeft > 1 ? t("hud.inHandMore", { n: fmtNum(state.piecesLeft - 1) }) : "";
      const piece = t("hud.pieceLabel", { emoji: PIECES[handType].emoji, name: pieceName(handType) });
      setText(this.inHand, t(myTurn ? "hud.inHandMine" : "hud.inHandOther", { piece, extra }));
    }
  }

  private ensurePreview(): void {
    if (this.preview || this.previewFailed) return;
    try {
      this.preview = new PiecePreview(80);
      this.preview.canvas.classList.add("jjh-next__gl");
      this.nextCanvasBox.appendChild(this.preview.canvas);
      this.nextCanvasBox.classList.add("jjh-next__canvas--gl");
    } catch {
      this.previewFailed = true; // no WebGL / not built yet: the emoji stays
      this.preview = null;
    }
  }

  private updateHint(state: JellyStateView, myTurn: boolean, coaching: boolean): void {
    const spin = myTurn && state.phase === "spinning" && state.spinStage === "idle";
    toggle(this.spinBtn, "jjh-on", spin);
    this.spinBtn.disabled = !spin;
    const placing = myTurn && state.phase === "placing";
    // while the big coach bubble is up, the compact hint stays out of the way
    toggle(this.hint, "jjh-on", placing && !coaching);
    if (!placing) return;
    const card = state.card.id;
    const rot = t(card === "tiedHands" ? "hud.hintTied" : "hud.hintRotate");
    const move = t(card === "mirrorHands" ? "hud.hintMoveMirror" : "hud.hintMove");
    const drop = t("hud.hintDrop");
    if (state.piecesLeft > 1) setText(this.hint, t("hud.hintLineLeft", { move, rot, drop, left: t("hud.hintPiecesLeft", { n: fmtNum(state.piecesLeft) }) }));
    else setText(this.hint, t("hud.hintLine", { move, rot, drop }));
  }

  private updateBet(state: JellyStateView, extra: HudExtra, me: PlayerView | undefined, myTurn: boolean): void {
    const bet = extra.myBet && extra.myBet.amount > 0 ? extra.myBet : null;
    const open =
      state.settings.sideBets &&
      !!me &&
      !me.spectator &&
      !myTurn &&
      state.activeId !== "" &&
      (state.phase === "spinning" || state.phase === "placing") &&
      // can't afford the stake (and haven't guessed yet): don't tease
      (!!bet || me.coins >= BET_STAKE);
    toggle(this.betPanel, "jjh-on", open);
    toggle(this.betCoach, "jjh-on", open && extra.coach.watch && !bet);
    if (!open || !me) return;
    toggle(this.betStand, "jjh-side--picked", bet?.side === "stand");
    toggle(this.betFall, "jjh-side--picked", bet?.side === "fall");
    toggle(this.betStand, "jjh-side--dim", bet?.side === "fall");
    toggle(this.betFall, "jjh-side--dim", bet?.side === "stand");
    toggle(this.betPanel, "jjh-bet--locked", !!bet);
    if (bet) {
      const side = t(bet.side === "stand" ? "hud.stand" : "hud.fall");
      setText(this.betStatus, t("hud.betGuessed", { side }));
      this.betStatus.title = t("hud.betSwitch");
    } else {
      setText(this.betStatus, "");
      this.betStatus.title = "";
    }
  }

  /** The big first-turn bubble: aim → drop while placing, a bonus note on my first spin. */
  private updateCoach(state: JellyStateView, extra: HudExtra): void {
    const c = extra.coach;
    const spin = c.spin && state.phase === "spinning";
    const want: typeof this.coachMode = c.place ? (this.coachMode === "drop" ? "drop" : "aim") : spin ? "spin" : "";
    if (want !== this.coachMode) this.setCoach(want);
  }

  private setCoach(mode: typeof this.coachMode): void {
    const prev = this.coachMode;
    this.coachMode = mode;
    toggle(this.coachEl, "jjh-on", mode !== "");
    if (mode !== "aim" && mode !== "drop") this.pointAt(null);
    if (!mode) return;
    if (mode === "aim" && prev !== "aim") {
      this.coachMoved = 0;
      this.coachAge = 0;
      this.lastPointer = null;
    }
    toggle(this.coachEl, "jjh-coach--spin", mode === "spin");
    toggle(this.coachEl, "jjh-coach--drop", mode === "drop");
    if (mode === "spin") {
      setText(this.coachMain, t("hud.coachSpin"));
      setText(this.coachSub, t("hud.coachSpinSub"));
    } else {
      const touch = this.touch;
      setText(this.coachMain, t(mode === "aim" ? (touch ? "hud.coachAimTouch" : "hud.coachAim") : touch ? "hud.coachDropTouch" : "hud.coachDrop"));
      setText(this.coachSub, t(touch ? "hud.coachRotateTouch" : "hud.coachRotate"));
    }
    replay(this.coachEl, "jjh-coach--pop");
    this.handlers.onUiSound("pop");
  }

  /** Per frame from Game: screen point of my hovering piece during the coach (null hides the arrow). */
  pointAt(p: { x: number; y: number } | null): void {
    const on = !!p && this.visible && (this.coachMode === "aim" || this.coachMode === "drop");
    toggle(this.arrow, "jjh-on", on);
    if (!on || !p) return;
    const r = this.root.getBoundingClientRect();
    this.arrow.style.transform = `translate(${(p.x - r.left).toFixed(1)}px, ${(p.y - r.top).toFixed(1)}px)`;
  }

  private updateMeter(state: JellyStateView, inTurn: boolean): void {
    toggle(this.meter, "jjh-on", inTurn);
    const h = Math.max(0, state.towerHeightCm);
    // tower fell / was cleared → fling the ant
    if (this.lastHeight - h > 8 && this.antPos > 3 && this.antFalling <= 0) {
      this.antFalling = 1.1;
      replay(this.ant, "jjh-ant--fall");
    }
    this.lastHeight = h;
    this.heightTarget = h;
    if (h > this.record) this.record = h;
    const want = Math.max(40, Math.ceil((Math.max(h, this.record) * 1.25) / 20) * 20);
    if (want !== this.rulerMax) {
      this.rulerMax = want;
      this.ticks.replaceChildren();
      for (let cm = 10; cm < want; cm += 10) {
        const t = el("div", cm % 20 === 0 ? "jjh-tick jjh-tick--big" : "jjh-tick", this.ticks);
        t.style.bottom = `${(cm / want) * 100}%`;
        if (cm % 20 === 0) el("span", "jjh-tick__label", t, String(cm));
      }
    }
    toggle(this.recordFlag, "jjh-on", this.record > 4);
    this.recordFlag.style.bottom = `${Math.min(100, (this.record / this.rulerMax) * 100).toFixed(2)}%`;

    const cardShown = state.card.id !== "" && (state.phase !== "spinning" || state.spinStage === "landed");
    const showPay = cardShown && state.phase !== "result" && state.payoutPreview > 0;
    toggle(this.payout, "jjh-on", showPay);
    toggle(this.penalty, "jjh-on", showPay);
    if (showPay) {
      setText(this.payout, t("hud.survive", { n: fmtNum(state.payoutPreview) }));
      const pen = state.card.id === "insurance" ? 0 : topplePenalty(state.card.multiplier || 1);
      setText(this.penalty, pen ? t("hud.topple", { n: fmtNum(pen) }) : t("hud.toppleInsured"));
    }
  }

  private updateSaboteur(state: JellyStateView, extra: HudExtra): void {
    const inMatch = state.phase !== "lobby" && state.phase !== "matchEnd" && state.phase !== "reveal" && state.phase !== "voting";
    const on = extra.isSaboteur && inMatch;
    toggle(this.sab, "jjh-on", on);
    if (!on) return;
    const rigWindow =
      state.phase === "spinning" &&
      state.activeId !== extra.myId &&
      (state.spinStage === "idle" || (state.spinStage === "rolling" && state.card.id === ""));
    let text: string;
    let ready = false;
    if (extra.rig.used) text = t("hud.rigUsed");
    else if (!extra.rig.available) text = t("hud.rigNone");
    else if (rigWindow) {
      text = t("hud.rigReady");
      ready = true;
    } else text = t("hud.rigWait");
    setText(this.sabText, text);
    toggle(this.sab, "jjh-sab--ready", ready);
    toggle(this.sab, "jjh-sab--used", extra.rig.used || !extra.rig.available);
  }

  private updateBoard(state: JellyStateView, myId: string): void {
    const list: PlayerView[] = [];
    state.players.forEach((p) => list.push(p));
    list.sort((a, b) => Number(a.spectator) - Number(b.spectator) || b.coins - a.coins || a.seat - b.seat);
    const seen = new Set<string>();
    list.forEach((p, i) => {
      seen.add(p.id);
      let row = this.boardRows.get(p.id);
      if (!row) {
        const tr = el("tr", "", this.boardBody);
        row = { root: tr, cells: Array.from({ length: 7 }, () => el("td", "", tr)) };
        this.boardRows.set(p.id, row);
      }
      if (this.boardBody.children[i] !== row.root) this.boardBody.insertBefore(row.root, this.boardBody.children[i] ?? null);
      const s = p.stats;
      const vals = [
        p.spectator ? "👀" : i === 0 ? "👑" : String(i + 1),
        p.nickname + (p.id === myId ? t("hud.youSuffix") : "") + (p.connected ? "" : " 🔌"),
        fmtNum(p.coins),
        fmtNum(s.survived),
        fmtNum(s.topples),
        s.bestMultiplierX10 > 0 ? fmtMult(s.bestMultiplierX10 / 10) : "—",
        `${s.betProfit > 0 ? "+" : s.betProfit < 0 ? "−" : ""}${fmtNum(Math.abs(s.betProfit))}`,
      ];
      vals.forEach((v, c) => setText(row!.cells[c], v));
      row.cells[1].style.setProperty("--pc", playerColor(p));
      toggle(row.cells[6], "jjh-good", s.betProfit > 0);
      toggle(row.cells[6], "jjh-bad", s.betProfit < 0);
      toggle(row.root, "jjh-board__me", p.id === myId);
      toggle(row.root, "jjh-board__off", !p.connected);
    });
    for (const [id, row] of this.boardRows) {
      if (!seen.has(id)) {
        row.root.remove();
        this.boardRows.delete(id);
      }
    }
  }

  // ========================================================================= helpers

  private hideAllDynamic(): void {
    for (const e of [this.cardChip, this.timer, this.next, this.hint, this.spinBtn, this.betPanel, this.meter, this.sab, this.board, this.coachEl, this.arrow]) {
      e.classList.remove("jjh-on");
    }
  }

  private wireButton(b: HTMLButtonElement, fn: () => void): void {
    b.addEventListener("pointerenter", () => {
      if (!b.disabled) this.handlers.onUiSound("hover");
    });
    b.addEventListener("click", (e) => {
      e.preventDefault();
      if (b.disabled) return;
      this.handlers.onUiSound("click");
      fn();
      b.blur(); // keep Space / keys going to the game, not the focused button
    });
  }

  private placeBet(side: BetSide): void {
    if (this.extra?.myBet?.side === side) return; // already guessed that
    this.handlers.onBet(side, BET_STAKE);
    replay(side === "stand" ? this.betStand : this.betFall, "jjh-side--boing");
  }
}
