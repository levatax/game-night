// Home screen: bouncy "BONK BRAWL" logo, nickname, Create Room / Join Room (code input). Owner: client-ui.

import { CODE_ALPHABET, CODE_LENGTH, CODE_PATTERN, NICKNAME_MAX, NICKNAME_MIN } from "../../../shared/constants";
import type { Emitter } from "../util/Emitter";
import { button, el, play, setHidden, setText, SHAKE_KEYFRAMES, svg } from "./dom";
import { ICON_BACK } from "./icons";
import type { HomeModel, UiEventMap } from "./models";

type Action = "create" | "join";

const LOGO_WORDS = ["BONK", "BRAWL"];
const SILLY_FIRST = ["Bonky", "Wobbly", "Sneaky", "Turbo", "Captain", "Lil", "Mega", "Fluffy", "Sir", "Zippy"];
const SILLY_LAST = ["Duck", "Noodle", "Pickle", "Muffin", "Bean", "Waffle", "Dodger", "Bonker", "Taco", "Goose"];

/** Strip everything that can't be in a room code (lowercase is uppercased; I, O, digits dropped). */
export function sanitizeCode(raw: string): string {
  let out = "";
  for (const ch of raw.toUpperCase()) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
    if (out.length >= CODE_LENGTH) break;
  }
  return out;
}

function randomNickname(): string {
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];
  return `${pick(SILLY_FIRST)}${pick(SILLY_LAST)}`.slice(0, NICKNAME_MAX);
}

/**
 * Emits createRoom { nickname } / joinRoom { code, nickname } (code uppercased, validated against
 * CODE_PATTERN before emitting; invalid → inline error, uiSound "error"). Enter submits Join when
 * a code is typed, else Create. Nickname max NICKNAME_MAX chars. A "← Game Night" link emits backToPortal.
 * The 3D backdrop (MenuScene) renders behind; this screen is transparent except for the panel.
 */
export class HomeScreen {
  readonly el: HTMLElement = document.createElement("section");

  private readonly events: Emitter<UiEventMap>;
  private readonly nickInput = el("input", "field__input");
  private readonly codeInput = el("input", "field__input field__input--code");
  private readonly createBtn = button("btn btn--primary btn--big home__create");
  private readonly joinBtn = button("btn btn--big home__join");
  private readonly errorEl = el("p", "home__error");
  private readonly inviteEl = el("p", "home__invite");
  private readonly codeHint = el("p", "home__code-hint");
  private readonly panel = el("form", "panel home__panel");

  private model: HomeModel | null = null;
  private localError: string | null = null;
  /** Model error the user has already reacted to (typed after it); hidden until a new attempt. */
  private dismissedError: string | null = null;
  private pending: Action | null = null;
  private invalidField: HTMLInputElement | null = null;
  private codeHintTimer = 0;

  constructor(events: Emitter<UiEventMap>) {
    this.events = events;
    this.el.className = "screen screen--home";
    this.el.setAttribute("aria-label", "Bonk Brawl home");
    this.el.append(this.buildBackLink(), this.buildLogo(), this.buildPanel(), this.buildControlsHint());
  }

  update(model: HomeModel): void {
    const prev = this.model;
    this.model = model;
    if (!prev || prev.nickname !== model.nickname) this.nickInput.value = model.nickname.slice(0, NICKNAME_MAX);
    if (!prev || prev.code !== model.code) this.codeInput.value = sanitizeCode(model.code);
    if (model.busy && !prev?.busy) this.dismissedError = null;
    if (!model.busy) this.pending = model.error ? this.pending : null;
    this.renderBusy(model.busy);
    this.renderInvite();
    this.renderError();
  }

  /* ------------------------------------------------------------- building */

  private buildBackLink(): HTMLElement {
    const link = el("a", "pill-link home__back", svg(ICON_BACK), "All games");
    link.href = "/";
    link.addEventListener("click", (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      this.events.emit("backToPortal", undefined);
    });
    return link;
  }

  private buildLogo(): HTMLElement {
    const logo = el("h1", "logo");
    logo.setAttribute("aria-label", "Bonk Brawl");
    let i = 0;
    LOGO_WORDS.forEach((word, w) => {
      const wordEl = el("span", `logo__word logo__word--${w + 1}`);
      wordEl.setAttribute("aria-hidden", "true");
      for (const ch of word) {
        const letter = el("span", "logo__letter outlined", ch);
        letter.dataset.text = ch;
        letter.style.setProperty("--i", String(i++));
        wordEl.append(letter);
      }
      logo.append(wordEl);
    });
    const tagline = el("p", "home__tagline", "Dodgeball brawl on a floating island · 2–8 friends");
    return el("div", "home__hero", logo, tagline);
  }

  private buildPanel(): HTMLElement {
    const panel = this.panel;
    panel.noValidate = true;
    panel.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submit(this.codeInput.value ? "join" : "create");
    });
    // Two text fields and no submit button: browsers skip implicit submission, so Enter is wired by hand.
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing || !(e.target instanceof HTMLInputElement)) return;
      e.preventDefault();
      this.submit(this.codeInput.value ? "join" : "create");
    });

    panel.append(this.buildNicknameField(), this.buildCreateRow(), el("div", "home__or", el("span", "", "or join a friend")));
    panel.append(this.buildJoinRow(), this.codeHint, this.inviteEl, this.errorEl);
    this.errorEl.setAttribute("role", "alert");
    this.errorEl.hidden = true;
    this.inviteEl.hidden = true;
    this.codeHint.hidden = true;
    return panel;
  }

  private buildNicknameField(): HTMLElement {
    const input = this.nickInput;
    input.id = "bb-nickname";
    input.type = "text";
    input.maxLength = NICKNAME_MAX;
    input.setAttribute("autocomplete", "nickname");
    input.spellcheck = false;
    input.placeholder = "e.g. BonkMaster";
    input.addEventListener("input", () => this.clearErrors());

    const dice = button("btn btn--icon home__dice", "🎲");
    dice.title = "Random nickname";
    dice.setAttribute("aria-label", "Random nickname");
    dice.addEventListener("click", () => {
      input.value = randomNickname();
      this.clearErrors();
      play(dice, [{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], { duration: 420, easing: "ease-out" });
    });

    const label = el("label", "field__label", "Your nickname");
    label.htmlFor = input.id;
    return el("div", "field", label, el("div", "field__row", input, dice));
  }

  private buildCreateRow(): HTMLElement {
    this.createBtn.append(el("span", "btn__label", "Create Room"));
    this.createBtn.addEventListener("click", () => this.submit("create"));
    return el("div", "home__create-row", this.createBtn);
  }

  private buildJoinRow(): HTMLElement {
    const input = this.codeInput;
    input.id = "bb-code";
    input.type = "text";
    input.maxLength = CODE_LENGTH;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "characters");
    input.placeholder = "ABCD";
    input.setAttribute("aria-label", "Room code (4 letters)");
    input.addEventListener("input", () => this.onCodeInput());

    this.joinBtn.append(el("span", "btn__label", "Join Room"));
    this.joinBtn.addEventListener("click", () => this.submit("join"));
    return el("div", "home__join-row", input, this.joinBtn);
  }

  private buildControlsHint(): HTMLElement {
    const hint = el("p", "home__controls");
    const items: Array<[string, string]> = [
      ["WASD", "move"],
      ["Mouse", "aim"],
      ["Hold LMB", "charge & throw"],
      ["RMB", "catch"],
      ["Shift", "roll"],
      ["E", "ability"],
    ];
    for (const [key, what] of items) hint.append(el("span", "", el("kbd", "", key), ` ${what}`));
    return hint;
  }

  /* ------------------------------------------------------------ behaviour */

  private onCodeInput(): void {
    const raw = this.codeInput.value;
    const clean = sanitizeCode(raw);
    if (clean !== raw) {
      const droppedLetter = /[IO]/i.test(raw);
      this.codeInput.value = clean;
      if (droppedLetter) this.flashCodeHint("Room codes never use I or O");
      else if (/[^A-Za-z]/.test(raw)) this.flashCodeHint("Room codes are letters only");
    }
    this.clearErrors();
    this.renderInvite();
  }

  private flashCodeHint(text: string): void {
    setText(this.codeHint, text);
    this.codeHint.hidden = false;
    play(this.codeInput, SHAKE_KEYFRAMES, { duration: 320 });
    window.clearTimeout(this.codeHintTimer);
    this.codeHintTimer = window.setTimeout(() => (this.codeHint.hidden = true), 2200);
  }

  private submit(action: Action): void {
    if (this.model?.busy) return;
    const nickname = this.nickInput.value.trim();
    const code = sanitizeCode(this.codeInput.value);

    if (action === "join" && !code) return this.fail("Type your friend's 4-letter room code", this.codeInput);
    if (action === "join" && !CODE_PATTERN.test(code)) {
      return this.fail("Room codes are 4 letters (no I or O)", this.codeInput);
    }
    if (nickname.length < NICKNAME_MIN) return this.fail("Pick a nickname first!", this.nickInput);

    this.pending = action;
    this.localError = null;
    this.invalidField = null;
    this.renderError();
    if (action === "join") this.events.emit("joinRoom", { code, nickname });
    else this.events.emit("createRoom", { nickname });
  }

  private fail(message: string, field: HTMLInputElement): void {
    this.localError = message;
    this.invalidField = field;
    this.renderError();
    field.focus();
    play(field, SHAKE_KEYFRAMES, { duration: 360 });
    this.events.emit("uiSound", { kind: "error" });
  }

  private clearErrors(): void {
    this.localError = null;
    this.invalidField = null;
    if (this.model?.error) this.dismissedError = this.model.error;
    this.renderError();
  }

  /* ------------------------------------------------------------ rendering */

  private renderBusy(busy: boolean): void {
    this.panel.setAttribute("aria-busy", String(busy));
    for (const b of [this.createBtn, this.joinBtn]) b.disabled = busy;
    this.nickInput.disabled = busy;
    this.codeInput.disabled = busy;
    this.createBtn.classList.toggle("is-loading", busy && this.pending !== "join");
    this.joinBtn.classList.toggle("is-loading", busy && this.pending === "join");
  }

  private renderInvite(): void {
    const code = this.codeInput.value;
    const invited = !!this.model?.code && code === sanitizeCode(this.model.code) && CODE_PATTERN.test(code);
    this.panel.classList.toggle("is-invited", invited);
    this.joinBtn.classList.toggle("btn--primary", invited);
    this.createBtn.classList.toggle("btn--primary", !invited);
    if (invited) setText(this.inviteEl, `You're invited to room ${code}! Pick a name and hop in.`);
    setHidden(this.inviteEl, !invited);
  }

  private renderError(): void {
    const modelError = this.model?.error && this.model.error !== this.dismissedError ? this.model.error : null;
    const message = this.localError ?? (this.model?.busy ? null : modelError);
    const wasHidden = this.errorEl.hidden;
    setHidden(this.errorEl, !message);
    for (const input of [this.nickInput, this.codeInput]) {
      input.classList.toggle("is-invalid", !!this.localError && this.invalidField === input);
    }
    if (!message) return;
    setText(this.errorEl, message);
    if (wasHidden) play(this.errorEl, SHAKE_KEYFRAMES, { duration: 360 });
  }
}
