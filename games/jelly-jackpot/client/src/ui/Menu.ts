// Home, lobby and role-reveal screens (DOM). Owner: client-menu. PUBLIC API IS THE CONTRACT.
// Styles in ./menu.css. Uses the tokens + .jj-panel / .jj-btn from ./theme.css.
//
// Home (game2.md §13.1): jiggling "JELLY JACKPOT" logo (a googly-eyed cherry sits on the J), nickname field
// (localStorage[NICKNAME_STORAGE_KEY]), Create Room / Join Room (+ 4-letter code), "← Game Night" link.
// Lobby (§13.2): sticker room code + Copy link, 6 chef cards, hat color picker, Ready toggle, host settings
// (read-only for guests), host Start with a reason while disabled, Leave.
// Role reveal phase: a "How to play" card everyone sees (3 big steps + Got it!). The Saboteur gets a red
// secret badge on top; Bakers in a Saboteur match get a one-line "someone is a Saboteur" hint.
//
// All user text (nicknames) goes in through textContent only. The lobby is built once and updated in place,
// so focus and open <select>s survive the 20 Hz state patches.

import "./menu.css";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NICKNAME_MAX,
  NICKNAME_STORAGE_KEY,
  PLAYER_COLORS,
  BET_STAKE,
  ROUND_OPTIONS,
  SABOTEUR_MIN_PLAYERS,
  TOPPLE_PENALTY,
  TURN_TIMER_OPTIONS,
  autoRounds,
} from "../../../shared/constants";
import type { JellyStateView, PlayerView, Role, SettingsMsg } from "../../../shared/protocol";
import { LANGS, lang, setLanguage, t } from "../i18n";

export interface MenuHandlers {
  onCreate(nickname: string): void;
  onJoin(code: string, nickname: string): void;
  onReady(ready: boolean): void;
  onColor(color: number): void;
  onSettings(patch: SettingsMsg): void;
  onStart(): void;
  onLeave(): void;
  /** UI click/hover sounds. */
  onUiSound(kind: "click" | "hover" | "pop"): void;
}

// ------------------------------------------------------------------ silly copy (strings/menu.ts)
/** Numbered key pool: lines("tagline", 5) → ["menu.tagline1", …] translated. */
const lines = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => t(`menu.${prefix}${i + 1}`));
const COLOR_NAMES = lines("color", 6);
const SILLY_NAMES = lines("silly", 12);
const TAGLINES = lines("tagline", 5);
const EMPTY_SEATS = lines("emptySeat", 6);

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

/** Chef hat SVG (static markup, fill follows currentColor). */
const HAT_SVG =
  '<svg viewBox="0 0 64 56" aria-hidden="true" focusable="false">' +
  '<path d="M14 36c-9 0-12-12-4-16 0-10 12-14 18-8 4-8 16-8 20 0 8-4 16 4 12 12 6 4 4 12-4 12z" ' +
  'fill="currentColor" stroke="#2d2a32" stroke-width="4" stroke-linejoin="round"/>' +
  '<rect x="14" y="34" width="36" height="16" rx="4" fill="#fff6e5" stroke="#2d2a32" stroke-width="4"/>' +
  '<path d="M24 38v8M32 38v8M40 38v8" stroke="#2d2a32" stroke-width="3" stroke-linecap="round" opacity=".35"/>' +
  "</svg>";

// ------------------------------------------------------------------ tiny DOM helper
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  attrs?: Record<string, string>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
function toggle(el: Element, cls: string, on: boolean): void {
  el.classList.toggle(cls, on);
}
function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: no big deal */
  }
}
/** Googly eye pair (pupils jiggle via CSS). */
function googlyEyes(): HTMLElement {
  const eyes = h("span", "jjm-eyes", { "aria-hidden": "true" });
  for (let i = 0; i < 2; i++) {
    const eye = h("span", "jjm-eye");
    eye.appendChild(h("span", "jjm-pupil"));
    eyes.appendChild(eye);
  }
  return eyes;
}

interface SeatRefs {
  card: HTMLElement;
  hat: HTMLElement;
  name: HTMLElement;
  badges: HTMLElement;
  status: HTMLElement;
  /** Player id currently shown ("" = empty seat). */
  id: string;
  ready: boolean;
}

export class Menu {
  private readonly handlers: MenuHandlers;
  private readonly el: HTMLElement;
  private busy = false;
  private lastHoverSound = 0;

  // home
  private readonly home: HTMLElement;
  private readonly nickInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly createBtn: HTMLButtonElement;
  private readonly joinBtn: HTMLButtonElement;
  private readonly errorEl: HTMLElement;
  private readonly busyEl: HTMLElement;
  private readonly tagline: HTMLElement;

  // lobby
  private readonly lobby: HTMLElement;
  private readonly codeSticker: HTMLElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly countEl: HTMLElement;
  private readonly seats: SeatRefs[] = [];
  private readonly swatches: HTMLButtonElement[] = [];
  private readonly readyBtn: HTMLButtonElement;
  private readonly roundsSel: HTMLSelectElement;
  private readonly timerSel: HTMLSelectElement;
  private readonly sabBox: HTMLInputElement;
  private readonly betsBox: HTMLInputElement;
  private readonly sabNote: HTMLElement;
  private readonly settingsNote: HTMLElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly startReason: HTMLElement;
  private readonly leaveBtn: HTMLButtonElement;
  private code = "";
  private myReady = false;
  private copyTimer = 0;

  // role
  private readonly roleWrap: HTMLElement;
  /** Last known lobby setting, so the how-to card only mentions guessing when side bets are on. */
  private sideBetsOn = true;

  constructor(root: HTMLElement, handlers: MenuHandlers) {
    this.handlers = handlers;
    this.el = h("div", "jjm");
    root.appendChild(this.el);

    // ================================================================== HOME
    this.home = h("section", "jjm-screen jjm-home", { "aria-label": t("menu.homeAria") });
    const logo = h("h1", "jjm-logo", { "aria-label": t("menu.logoAria") });
    let idx = 0;
    for (const word of ["JELLY", "JACKPOT"]) {
      const w = h("span", "jjm-logo-word", { "aria-hidden": "true" });
      for (const ch of word) {
        const l = h("span", "jjm-letter", undefined, ch);
        l.style.setProperty("--i", String(idx));
        l.style.setProperty("--c", `var(--p${idx % 6})`);
        if (idx === 0) {
          const cherry = h("span", "jjm-cherry");
          cherry.appendChild(h("span", "jjm-cherry-stem"));
          cherry.appendChild(googlyEyes());
          l.appendChild(cherry);
        }
        w.appendChild(l);
        idx++;
      }
      logo.appendChild(w);
    }
    // Hovering the logo pokes it: it wobbles harder and plays a pop.
    logo.addEventListener("pointerenter", () => {
      logo.classList.remove("jjm-poked");
      void logo.offsetWidth;
      logo.classList.add("jjm-poked");
      this.handlers.onUiSound("pop");
    });

    this.tagline = h("p", "jjm-tagline", undefined, pick(TAGLINES));

    const card = h("form", "jj-panel jjm-card jjm-home-card", { novalidate: "" });
    const nickLabel = h("label", "jjm-label", { for: "jjm-nick" }, t("menu.nickLabel"));
    this.nickInput = h("input", "jjm-input", {
      id: "jjm-nick",
      type: "text",
      maxlength: String(NICKNAME_MAX),
      autocomplete: "nickname",
      spellcheck: "false",
      placeholder: pick(SILLY_NAMES),
    });
    this.nickInput.value = readStorage(NICKNAME_STORAGE_KEY).slice(0, NICKNAME_MAX);
    const diceBtn = h("button", "jjm-dice", { type: "button", "aria-label": t("menu.diceAria"), title: t("menu.diceAria") }, "🎲");
    const nickRow = h("div", "jjm-row jjm-nick-row");
    nickRow.append(this.nickInput, diceBtn);
    diceBtn.addEventListener("click", () => {
      this.nickInput.value = pick(SILLY_NAMES).slice(0, NICKNAME_MAX);
      this.nickInput.focus();
      this.handlers.onUiSound("pop");
    });

    this.createBtn = h("button", "jj-btn jj-btn--pink jjm-big", { type: "submit" }, t("menu.createRoom"));

    const or = h("div", "jjm-or", { "aria-hidden": "true" }, t("menu.or"));

    const codeLabel = h("label", "jjm-label", { for: "jjm-code" }, t("menu.codeLabel"));
    this.codeInput = h("input", "jjm-input jjm-code-input", {
      id: "jjm-code",
      type: "text",
      maxlength: String(CODE_LENGTH),
      autocomplete: "off",
      autocapitalize: "characters",
      spellcheck: "false",
      placeholder: t("menu.codePlaceholder"),
      inputmode: "text",
    });
    this.codeInput.addEventListener("input", () => {
      const clean = this.sanitizeCode(this.codeInput.value);
      if (clean !== this.codeInput.value) this.codeInput.value = clean;
      this.clearError();
    });
    this.joinBtn = h("button", "jj-btn jjm-big", { type: "button" }, t("menu.joinRoom"));
    const joinRow = h("div", "jjm-row jjm-join-row");
    joinRow.append(this.codeInput, this.joinBtn);

    this.errorEl = h("p", "jjm-error", { role: "alert", "aria-live": "assertive" });
    this.busyEl = h("p", "jjm-busy", { "aria-live": "polite" });
    const spinner = h("span", "jjm-spinner", { "aria-hidden": "true" }, "🍮");
    this.busyEl.append(spinner, h("span", undefined, undefined, t("menu.busy")));

    // Language switcher (saves + reloads; the room rejoins via the reconnect token).
    const langRow = h("div", "jjm-langs", { role: "group", "aria-label": t("menu.langAria") });
    for (const l of LANGS) {
      const on = l.id === lang();
      const b = h("button", `jjm-lang${on ? " jjm-lang--on" : ""}`, { type: "button", lang: l.id, "aria-pressed": String(on), title: l.label });
      b.append(h("span", "jjm-lang-flag", { "aria-hidden": "true" }, l.flag), h("span", "jjm-lang-name", undefined, l.label));
      b.addEventListener("click", () => setLanguage(l.id));
      langRow.appendChild(b);
    }

    card.append(langRow, nickLabel, nickRow, this.createBtn, or, codeLabel, joinRow, this.errorEl, this.busyEl);
    // Enter in the code field joins, Enter anywhere else creates.
    card.addEventListener("submit", (e) => {
      e.preventDefault();
      if (document.activeElement === this.codeInput) this.doJoin();
      else this.doCreate();
    });
    this.joinBtn.addEventListener("click", () => this.doJoin());
    this.nickInput.addEventListener("input", () => this.clearError());

    const back = h("a", "jjm-back", { href: "/" }, t("menu.backLink"));
    this.home.append(logo, this.tagline, card, back);

    // ================================================================== LOBBY
    this.lobby = h("section", "jjm-screen jjm-lobby", { "aria-label": t("menu.lobbyAria") });
    const lcard = h("div", "jj-panel jjm-card jjm-lobby-card");

    const top = h("div", "jjm-lobby-top");
    const stickerWrap = h("div", "jjm-sticker-wrap");
    stickerWrap.appendChild(h("span", "jjm-sticker-label", undefined, t("menu.kitchenCode")));
    this.codeSticker = h("div", "jjm-sticker", { "aria-live": "polite" });
    stickerWrap.appendChild(this.codeSticker);
    this.copyBtn = h("button", "jj-btn jj-btn--green jjm-copy", { type: "button" }, t("menu.copyLink"));
    this.copyBtn.addEventListener("click", () => void this.copyLink());
    top.append(stickerWrap, this.copyBtn);

    const chefsHead = h("div", "jjm-section-head");
    chefsHead.appendChild(h("h2", "jjm-h2", undefined, t("menu.chefsHeading")));
    this.countEl = h("span", "jjm-count");
    chefsHead.appendChild(this.countEl);

    const grid = h("ul", "jjm-chefs", { "aria-label": t("menu.playersAria") });
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const li = h("li", "jjm-chef jjm-chef--empty");
      li.style.setProperty("--tilt", `${(i % 2 ? 1 : -1) * (1 + (i % 3))}deg`);
      const avatar = h("div", "jjm-avatar", { "aria-hidden": "true" });
      const hat = h("span", "jjm-hat");
      hat.innerHTML = HAT_SVG; // static markup, no user text
      const blob = h("span", "jjm-blob");
      blob.appendChild(googlyEyes());
      blob.appendChild(h("span", "jjm-mouth"));
      avatar.append(hat, blob);
      const name = h("span", "jjm-chef-name");
      const badges = h("span", "jjm-badges");
      const status = h("span", "jjm-chef-status");
      li.append(avatar, name, badges, status);
      grid.appendChild(li);
      this.seats.push({ card: li, hat, name, badges, status, id: "", ready: false });
    }

    // Hat color picker.
    const colorHead = h("h2", "jjm-h2", { id: "jjm-color-h" }, t("menu.pickHat"));
    const colors = h("div", "jjm-colors", { role: "radiogroup", "aria-labelledby": "jjm-color-h" });
    PLAYER_COLORS.forEach((hex, i) => {
      const b = h("button", "jjm-swatch", { type: "button", role: "radio", "aria-checked": "false" });
      b.style.setProperty("--sw", hex);
      b.setAttribute("aria-label", COLOR_NAMES[i] ?? t("menu.colorFallback", { n: i + 1 }));
      b.title = COLOR_NAMES[i] ?? "";
      b.innerHTML = HAT_SVG;
      b.addEventListener("click", () => {
        if (b.disabled || b.getAttribute("aria-checked") === "true") return;
        b.classList.remove("jjm-boing");
        void b.offsetWidth;
        b.classList.add("jjm-boing");
        this.handlers.onUiSound("pop");
        this.handlers.onColor(i);
      });
      colors.appendChild(b);
      this.swatches.push(b);
    });
    // Arrow keys move between free hats (radiogroup pattern).
    colors.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      const dir = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
      const cur = this.swatches.indexOf(document.activeElement as HTMLButtonElement);
      for (let step = 1; step <= this.swatches.length; step++) {
        const n = (cur + dir * step + this.swatches.length * 2) % this.swatches.length;
        const sw = this.swatches[n]!;
        if (!sw.disabled) {
          sw.focus();
          break;
        }
      }
    });

    // Host settings.
    const setHead = h("h2", "jjm-h2", undefined, t("menu.houseRules"));
    const settings = h("div", "jjm-settings");
    this.roundsSel = h("select", "jjm-select", { id: "jjm-rounds" });
    for (const r of ROUND_OPTIONS) this.roundsSel.appendChild(h("option", undefined, { value: String(r) }, r === 0 ? t("menu.roundsAuto") : String(r)));
    this.timerSel = h("select", "jjm-select", { id: "jjm-timer" });
    for (const s of TURN_TIMER_OPTIONS) this.timerSel.appendChild(h("option", undefined, { value: String(s) }, t("menu.timerOption", { s })));
    this.sabBox = h("input", "jjm-switch", { id: "jjm-sab", type: "checkbox", role: "switch" });
    this.betsBox = h("input", "jjm-switch", { id: "jjm-bets", type: "checkbox", role: "switch" });
    const field = (id: string, label: string, ctl: HTMLElement): HTMLElement => {
      const f = h("div", "jjm-field");
      f.append(h("label", "jjm-label", { for: id }, label), ctl);
      return f;
    };
    this.sabNote = h("span", "jjm-note");
    const sabField = field("jjm-sab", t("menu.setSaboteur", { n: SABOTEUR_MIN_PLAYERS }), this.sabBox);
    sabField.classList.add("jjm-field--advanced");
    sabField.append(h("span", "jjm-explain", undefined, t("menu.sabExplain")), this.sabNote);
    settings.append(
      field("jjm-rounds", t("menu.setRounds"), this.roundsSel),
      field("jjm-timer", t("menu.setTimer"), this.timerSel),
      field("jjm-bets", t("menu.setBets"), this.betsBox),
      sabField,
    );
    this.roundsSel.addEventListener("change", () => this.sendSetting({ rounds: Number(this.roundsSel.value) }));
    this.timerSel.addEventListener("change", () => this.sendSetting({ turnTimer: Number(this.timerSel.value) }));
    this.sabBox.addEventListener("change", () => this.sendSetting({ saboteur: this.sabBox.checked }));
    this.betsBox.addEventListener("change", () => this.sendSetting({ sideBets: this.betsBox.checked }));
    this.settingsNote = h("p", "jjm-note jjm-settings-note");

    // Actions.
    const actions = h("div", "jjm-actions");
    this.leaveBtn = h("button", "jj-btn jj-btn--red", { type: "button" }, t("menu.leave"));
    this.leaveBtn.addEventListener("click", () => this.handlers.onLeave());
    this.readyBtn = h("button", "jj-btn jj-btn--green jjm-ready", { type: "button", "aria-pressed": "false" });
    this.readyBtn.addEventListener("click", () => {
      this.myReady = !this.myReady; // optimistic, the next patch confirms
      this.renderReady();
      this.handlers.onUiSound("pop");
      this.handlers.onReady(this.myReady);
    });
    this.startBtn = h("button", "jj-btn jj-btn--pink jjm-big jjm-start", { type: "button", "aria-describedby": "jjm-start-why" }, t("menu.start"));
    this.startBtn.addEventListener("click", () => this.handlers.onStart());
    this.startReason = h("p", "jjm-start-why", { id: "jjm-start-why", "aria-live": "polite" });
    actions.append(this.leaveBtn, this.readyBtn, this.startBtn);

    lcard.append(top, chefsHead, grid, colorHead, colors, setHead, settings, this.settingsNote, actions, this.startReason);
    this.lobby.appendChild(lcard);

    // ================================================================== ROLE
    this.roleWrap = h("section", "jjm-screen jjm-role", { "aria-label": t("menu.howAria"), "aria-live": "polite" });

    this.el.append(this.home, this.lobby, this.roleWrap);

    // Shared button sounds + squish (delegated).
    this.el.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("button");
      if (!btn || btn.disabled) return;
      btn.classList.remove("jjm-squish");
      void btn.offsetWidth;
      btn.classList.add("jjm-squish");
      if (!btn.classList.contains("jjm-swatch") && btn !== this.readyBtn) this.handlers.onUiSound("click");
    });
    this.el.addEventListener("pointerover", (e) => {
      const btn = (e.target as HTMLElement).closest("button");
      if (!btn || btn.disabled || (e.relatedTarget instanceof Node && btn.contains(e.relatedTarget))) return;
      const now = performance.now();
      if (now - this.lastHoverSound < 70) return;
      this.lastHoverSound = now;
      this.handlers.onUiSound("hover");
    });

    this.showOnly(null);
  }

  /** Prefill the join code (share link ?room=CODE). */
  showHome(prefillCode?: string): void {
    this.showOnly(this.home);
    this.tagline.textContent = pick(TAGLINES);
    if (prefillCode) this.codeInput.value = this.sanitizeCode(prefillCode);
    this.clearError();
    this.setBusy(false);
    // Focus where the player most likely wants to type next.
    requestAnimationFrame(() => {
      if (!this.nickInput.value) this.nickInput.focus({ preventScroll: true });
      else if (this.codeInput.value.length === CODE_LENGTH) this.joinBtn.focus({ preventScroll: true });
    });
  }

  /** Disable buttons + show a spinner while connecting. */
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.createBtn.disabled = busy;
    this.joinBtn.disabled = busy;
    this.nickInput.disabled = busy;
    this.codeInput.disabled = busy;
    toggle(this.home, "jjm-is-busy", busy);
    this.home.setAttribute("aria-busy", String(busy));
  }

  showError(message: string): void {
    this.setBusy(false);
    this.errorEl.textContent = t("menu.errorPrefix", { message });
    this.errorEl.classList.remove("jjm-shake");
    void this.errorEl.offsetWidth;
    this.errorEl.classList.add("jjm-shake");
  }

  showLobby(): void {
    this.setBusy(false);
    this.showOnly(this.lobby);
  }

  /** Re-render the lobby from state (call on every patch while in the lobby). */
  updateLobby(state: JellyStateView, myId: string): void {
    const isHost = state.hostId === myId;
    const players: PlayerView[] = [];
    state.players.forEach((p) => {
      if (!p.spectator) players.push(p);
    });
    players.sort((a, b) => a.seat - b.seat);
    const me = state.players.get(myId);
    const count = players.length;

    // Room code sticker.
    if (state.code !== this.code) {
      this.code = state.code;
      this.codeSticker.replaceChildren();
      for (const ch of state.code) {
        const s = h("span", "jjm-sticker-ch", undefined, ch);
        this.codeSticker.appendChild(s);
      }
      this.codeSticker.setAttribute("aria-label", t("menu.roomCodeAria", { code: state.code.split("").join(" ") }));
    }
    setText(this.countEl, t("menu.count", { count, max: MAX_PLAYERS }));

    // Chef cards (by seat order, updated in place).
    this.seats.forEach((seat, i) => {
      const p = players[i];
      if (!p) {
        if (seat.id !== "" || !seat.name.textContent) {
          seat.id = "";
          seat.ready = false;
          seat.card.className = "jjm-chef jjm-chef--empty";
          seat.hat.style.color = "";
          seat.hat.dataset.c = "";
          setText(seat.name, EMPTY_SEATS[i % EMPTY_SEATS.length]!);
          seat.badges.replaceChildren();
          setText(seat.status, "");
          seat.card.removeAttribute("aria-label");
        }
        return;
      }
      const joined = seat.id !== p.id;
      seat.id = p.id;
      toggle(seat.card, "jjm-chef--empty", false);
      toggle(seat.card, "jjm-chef--me", p.id === myId);
      toggle(seat.card, "jjm-chef--away", !p.connected);
      toggle(seat.card, "jjm-chef--ready", p.ready);
      if (joined) {
        seat.card.classList.remove("jjm-pop-in");
        void seat.card.offsetWidth;
        seat.card.classList.add("jjm-pop-in");
      }
      if (p.ready && !seat.ready && !joined) {
        seat.card.classList.remove("jjm-hop");
        void seat.card.offsetWidth;
        seat.card.classList.add("jjm-hop");
      }
      seat.ready = p.ready;
      const hex = PLAYER_COLORS[p.color] ?? PLAYER_COLORS[0];
      if (seat.hat.dataset.c !== hex) {
        seat.hat.dataset.c = hex;
        seat.hat.style.color = hex;
        seat.card.style.setProperty("--pc", hex);
      }
      setText(seat.name, p.nickname);
      const badgeKey = `${p.id === state.hostId ? "h" : ""}${p.id === myId ? "y" : ""}`;
      if (seat.badges.dataset.k !== badgeKey) {
        seat.badges.dataset.k = badgeKey;
        seat.badges.replaceChildren();
        if (p.id === state.hostId) seat.badges.appendChild(h("span", "jjm-badge jjm-badge--host", { title: t("menu.hostTitle") }, t("menu.hostBadge")));
        if (p.id === myId) seat.badges.appendChild(h("span", "jjm-badge jjm-badge--you", undefined, t("menu.youBadge")));
      }
      setText(seat.status, !p.connected ? t("menu.statusAway") : p.ready ? t("menu.statusReady") : t("menu.statusThinking"));
      seat.card.setAttribute(
        "aria-label",
        t("menu.seatAria", {
          name: p.nickname,
          host: p.id === state.hostId ? t("menu.seatAriaHost") : "",
          you: p.id === myId ? t("menu.seatAriaYou") : "",
          color: COLOR_NAMES[p.color] ?? "",
          status: p.connected ? (p.ready ? t("menu.seatAriaReady") : t("menu.seatAriaNotReady")) : t("menu.seatAriaAway"),
        }),
      );
    });

    // Color picker: mine checked, taken ones disabled.
    const taken = new Set<number>();
    players.forEach((p) => {
      if (p.id !== myId) taken.add(p.color);
    });
    this.swatches.forEach((sw, i) => {
      const mine = me?.color === i;
      const isTaken = taken.has(i);
      if (sw.disabled !== isTaken) sw.disabled = isTaken;
      sw.setAttribute("aria-checked", String(mine));
      sw.tabIndex = mine || (me === undefined && i === 0) ? 0 : -1;
      toggle(sw, "jjm-swatch--taken", isTaken);
      const label = isTaken ? t("menu.swatchTaken", { color: COLOR_NAMES[i] ?? "" }) : (COLOR_NAMES[i] ?? "");
      if (sw.getAttribute("aria-label") !== label) sw.setAttribute("aria-label", label);
    });

    // Ready toggle.
    if (me) this.myReady = me.ready;
    this.renderReady();

    // Settings (host edits, guests read-only). Skip a control while it has focus so we don't fight the user.
    const s = state.settings;
    const autoLabel = t("menu.roundsAutoN", { n: autoRounds(Math.max(count, MIN_PLAYERS)) });
    const autoOpt = this.roundsSel.options[0];
    if (autoOpt && autoOpt.textContent !== autoLabel) autoOpt.textContent = autoLabel;
    this.syncSelect(this.roundsSel, String(s.rounds));
    this.syncSelect(this.timerSel, String(s.turnTimer));
    if (this.sabBox.checked !== s.saboteur) this.sabBox.checked = s.saboteur;
    if (this.betsBox.checked !== s.sideBets) this.betsBox.checked = s.sideBets;
    this.sideBetsOn = s.sideBets;
    for (const ctl of [this.roundsSel, this.timerSel, this.sabBox, this.betsBox]) {
      if (ctl.disabled !== !isHost) ctl.disabled = !isHost;
    }
    toggle(this.lobby, "jjm-is-host", isHost);
    setText(
      this.sabNote,
      s.saboteur && count < SABOTEUR_MIN_PLAYERS ? t("menu.sabNeeds", { n: SABOTEUR_MIN_PLAYERS }) : "",
    );
    const host = state.players.get(state.hostId);
    setText(this.settingsNote, isHost ? t("menu.noteHost") : t("menu.noteGuest", { host: host ? host.nickname : t("menu.theHost") }));

    // Start button + reason.
    let reason = "";
    if (count < MIN_PLAYERS) {
      const need = MIN_PLAYERS - count;
      reason = need === 1 ? t("menu.needOne") : t("menu.needMany", { n: need });
    } else {
      // Mirrors the server's start rule: the host's Start counts as their ready, and chefs who are
      // disconnected at start just become spectators, so only connected guests need to be ready.
      const slow = players.filter((p) => p.connected && !p.ready && p.id !== state.hostId);
      if (slow.length === 1) reason = t("menu.waitingOne", { name: slow[0]!.nickname });
      else if (slow.length > 1) reason = t("menu.waitingMany", { n: slow.length });
    }
    this.startBtn.hidden = !isHost;
    this.startBtn.disabled = reason !== "";
    if (!isHost) reason = reason || t("menu.waitingHost", { host: host ? host.nickname : t("menu.theHost") });
    else if (!reason) reason = t("menu.allReady");
    setText(this.startReason, reason);
  }

  /**
   * The how-to-play card for the roleReveal phase. `solo` = no Saboteur this match (setting off or too few
   * players): roles are not mentioned at all. "Got it!" just hides the card locally.
   */
  showRole(role: Role, solo: boolean): void {
    this.showOnly(this.roleWrap);
    const sab = role === "saboteur" && !solo;

    const card = h("div", `jj-panel jjm-how${sab ? " jjm-how--sab" : ""}`);
    if (sab) card.appendChild(h("p", "jjm-how-secret", { role: "note" }, t("menu.howSabBadge")));
    const titleId = "jjm-how-title";
    card.append(
      h("h2", "jjm-how-title", { id: titleId }, t("menu.howTitle")),
      h("p", "jjm-how-sub", undefined, t("menu.howSub")),
    );

    const list = h("ol", "jjm-how-steps");
    const step3 = t("menu.howStep3Text", { penalty: TOPPLE_PENALTY });
    const steps: [string, string, string][] = [
      ["🎰", t("menu.howStep1Title"), t("menu.howStep1Text")],
      ["🖱️", t("menu.howStep2Title"), t("menu.howStep2Text")],
      ["🏰", t("menu.howStep3Title"), this.sideBetsOn ? `${step3} ${t("menu.howStep3Guess", { stake: BET_STAKE })}` : step3],
    ];
    steps.forEach(([emoji, title, text], i) => {
      const li = h("li", "jjm-how-step");
      li.style.setProperty("--i", String(i));
      const art = h("span", "jjm-how-art", { "aria-hidden": "true" });
      art.append(h("span", "jjm-how-num", undefined, String(i + 1)), h("span", "jjm-how-emoji", undefined, emoji));
      const copy = h("span", "jjm-how-copy");
      copy.append(h("strong", "jjm-how-step-title", undefined, title), h("span", "jjm-how-step-text", undefined, text));
      li.append(art, copy);
      list.appendChild(li);
    });
    card.appendChild(list);

    if (!solo && !sab) card.appendChild(h("p", "jjm-how-spy", undefined, t("menu.howSpyLine")));

    const ok = h("button", "jj-btn jj-btn--green jjm-big jjm-how-ok", { type: "button" }, t("menu.howGotIt"));
    ok.addEventListener("click", () => this.hide());
    card.appendChild(ok);

    this.roleWrap.replaceChildren(card);
    this.roleWrap.setAttribute("aria-labelledby", titleId);
    this.roleWrap.removeAttribute("aria-label");
  }

  hide(): void {
    this.roleWrap.replaceChildren();
    this.showOnly(null);
  }

  // ------------------------------------------------------------------ internals
  private showOnly(screen: HTMLElement | null): void {
    for (const s of [this.home, this.lobby, this.roleWrap]) {
      const on = s === screen;
      s.hidden = !on;
      if (on) {
        s.classList.remove("jjm-enter");
        void s.offsetWidth;
        s.classList.add("jjm-enter");
      }
    }
    this.el.hidden = screen === null;
  }

  private sanitizeCode(raw: string): string {
    let out = "";
    // Codes are ASCII: plain toUpperCase on purpose (a Turkish locale would turn "i" into "İ").
    for (const ch of raw.toUpperCase()) if (CODE_ALPHABET.includes(ch)) out += ch;
    return out.slice(0, CODE_LENGTH);
  }

  /** Trimmed nickname; empty → a random silly name (filled into the field so the player sees it). */
  private takeNickname(): string {
    let name = this.nickInput.value.replace(/\s+/g, " ").trim().slice(0, NICKNAME_MAX);
    if (!name) {
      name = (this.nickInput.placeholder || pick(SILLY_NAMES)).slice(0, NICKNAME_MAX);
      this.nickInput.value = name;
    }
    writeStorage(NICKNAME_STORAGE_KEY, name);
    return name;
  }

  private doCreate(): void {
    if (this.busy) return;
    this.clearError();
    const name = this.takeNickname();
    this.setBusy(true);
    this.handlers.onCreate(name);
  }

  private doJoin(): void {
    if (this.busy) return;
    const code = this.sanitizeCode(this.codeInput.value);
    if (code.length !== CODE_LENGTH) {
      this.showError(t("menu.errCodeLength", { n: CODE_LENGTH }));
      this.codeInput.focus();
      return;
    }
    this.clearError();
    const name = this.takeNickname();
    this.setBusy(true);
    this.handlers.onJoin(code, name);
  }

  private clearError(): void {
    if (this.errorEl.textContent) this.errorEl.textContent = "";
  }

  private renderReady(): void {
    this.readyBtn.setAttribute("aria-pressed", String(this.myReady));
    setText(this.readyBtn, this.myReady ? t("menu.readyOn") : t("menu.readyOff"));
    toggle(this.readyBtn, "jjm-ready--on", this.myReady);
  }

  private syncSelect(sel: HTMLSelectElement, value: string): void {
    if (document.activeElement === sel) return;
    if (sel.value !== value) sel.value = value;
  }

  private sendSetting(patch: SettingsMsg): void {
    this.handlers.onUiSound("click");
    this.handlers.onSettings(patch);
  }

  private async copyLink(): Promise<void> {
    const url = `${location.origin}/r/${this.code}`;
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      // Fallback for insecure origins (LAN play over http).
      const ta = h("textarea", "jjm-offscreen", { readonly: "", "aria-hidden": "true" });
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    this.handlers.onUiSound("pop");
    window.clearTimeout(this.copyTimer);
    this.copyBtn.textContent = ok ? t("menu.copied") : t("menu.copyFallback", { url });
    toggle(this.copyBtn, "jjm-copied", ok);
    this.copyTimer = window.setTimeout(() => {
      this.copyBtn.textContent = t("menu.copyLink");
      this.copyBtn.classList.remove("jjm-copied");
    }, ok ? 1600 : 6000);
  }
}
