// Home screen: the bouncy "RAFT RUSH" logo over a sunset beach, name (+ dice), Start an island / Join with a
// 4-letter code, EN / TR switch, a row of key hints (the active key preset's keys in the player's keyboard layout,
// re-printed when either changes).
// Adapted from games/bonk-brawl/client/src/ui/Home.ts.
// Emits create { nickname } / join { code, nickname } (code validated against CODE_PATTERN first; problems show
// inline with uiError) and language { lang } (then i18n setLanguage reloads the page). Owner: client-ui.
// A language switch from here or the settings menu saves the typed name + code first (homeState.ts) and the
// next load puts them back. Without a fine pointer (phones, most tablets) a "needs a keyboard and a mouse" card
// stands in for the form until "Continue anyway" (remembered for the tab) or a mouse shows up; an invite link then
// waits on it with the code filled in (App skips the auto-join while it is due).
// The "game was updated" error (menu.errOutdated) comes with a one-click "Reload the page" button, which keeps the
// typed name + code the same way.

import { CODE_ALPHABET, CODE_LENGTH, CODE_PATTERN, NICKNAME_MAX, NICKNAME_MIN } from "../../../../shared/constants";
import { settings } from "../../app/settings";
import { LANGS, setLanguage, t } from "../../i18n";
import { onKeyCapsChange } from "../../input/bindings";
import type { Emitter } from "../../util/Emitter";
import { keyParams, keysSignature } from "../controls";
import { button, el, fill, play, setHidden, setText, SHAKE_KEYFRAMES, svg, tr } from "../dom";
import { ICON_BACK, ICON_DICE } from "../icons";
import type { HomeModel, UiEventMap } from "../models";
import { browserMedia, deviceNoticeDue, dismissDeviceNotice, reloadKeepingDraft, saveHomeDraft, sessionStore, takeHomeDraft, type HomeDraft } from "./homeState";

type Action = "create" | "join";

const LOGO_WORDS = ["RAFT", "RUSH"];

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
  const a = t("menu.nameA").split("|");
  const b = t("menu.nameB").split("|");
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)] ?? "";
  return `${pick(a)}${pick(b)}`.slice(0, NICKNAME_MAX);
}

const BACKDROP = `
<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax slice" class="rr-home__scene" aria-hidden="true">
  <defs>
    <linearGradient id="rrHomeSky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2E3A7A"/><stop offset="0.45" stop-color="#C85A8A"/><stop offset="0.72" stop-color="#FF9A5A"/><stop offset="1" stop-color="#FFD166"/>
    </linearGradient>
    <linearGradient id="rrHomeSea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3FB7D9"/><stop offset="1" stop-color="#102A4A"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#rrHomeSky)"/>
  <circle cx="800" cy="640" r="170" fill="#FFE08A" opacity="0.95"/>
  <circle cx="800" cy="640" r="230" fill="#FFE08A" opacity="0.18"/>
  <g fill="#FFF4DC" opacity="0.55"><ellipse cx="260" cy="230" rx="120" ry="20"/><ellipse cx="330" cy="214" rx="70" ry="18"/><ellipse cx="1260" cy="180" rx="140" ry="18"/><ellipse cx="1330" cy="166" rx="70" ry="16"/></g>
  <rect y="640" width="1600" height="260" fill="url(#rrHomeSea)"/>
  <g stroke="#FFF4DC" stroke-width="5" stroke-linecap="round" opacity="0.45" fill="none">
    <path d="M620 680h120M860 676h140M700 712h220M560 748h120M930 744h160"/>
  </g>
  <path d="M0 820c180-40 340-46 520-20 120 18 220 10 300-20l0 140H0Z" fill="#F4E4B0"/>
  <path d="M1600 800c-160-30-300-32-440-10-90 14-170 8-240-12V900h680Z" fill="#E6D7A8"/>
  <g class="rr-home__palm" fill="#2D2A32">
    <path d="M196 860c4-120 26-230 70-330l14 6c-38 104-56 210-58 324Z"/>
    <path d="M276 528c-60-40-150-30-196 14 60-12 120-6 178 22Zm8-4c10-70 70-120 140-120-50 26-90 66-122 128Zm-8 6c-80 0-150 50-170 120 50-50 110-82 176-96Zm12 2c70-10 150 30 180 100-56-40-116-60-180-70Zm-6-10c30-60 0-130-56-160 26 50 36 104 40 160Z"/>
    <circle cx="282" cy="540" r="12"/><circle cx="300" cy="548" r="10"/>
  </g>
  <g class="rr-home__raft">
    <path d="M1180 780v-110" stroke="#2D2A32" stroke-width="8"/>
    <path d="M1186 676c50 18 70 56 70 96h-70Z" fill="#FFF4DC" stroke="#2D2A32" stroke-width="6" stroke-linejoin="round"/>
    <g stroke="#2D2A32" stroke-width="6"><rect x="1100" y="776" width="170" height="20" rx="10" fill="#B07A45"/><rect x="1110" y="792" width="150" height="20" rx="10" fill="#C98E55"/></g>
  </g>
  <g fill="#FF4D3A" class="rr-home__eyes"><circle cx="1420" cy="832" r="7"/><circle cx="1440" cy="832" r="7"/><circle cx="90" cy="878" r="6"/><circle cx="108" cy="878" r="6"/></g>
</svg>`;

export class HomeScreen {
  readonly el = el("section", "rr-screen rr-screen--home");
  private readonly nickInput = el("input", "rr-field__input");
  private readonly codeInput = el("input", "rr-field__input rr-field__input--code");
  private readonly createBtn = button("rr-btn rr-btn--primary rr-btn--big rr-home__create");
  private readonly joinBtn = button("rr-btn rr-btn--big rr-home__join");
  private readonly errorEl = el("p", "rr-home__error");
  /** One-click reload under the "the game was updated" error (menu.errOutdated). */
  private readonly reloadBtn = button("rr-btn rr-btn--primary rr-home__reload", `🔄 ${t("menu.reload")}`);
  private readonly inviteEl = el("p", "rr-home__invite");
  private readonly codeHint = el("p", "rr-home__code-hint");
  private readonly panel = el("form", "rr-panel rr-home__panel");
  private readonly deviceCard = el("section", "rr-panel rr-home__device");
  private readonly deviceBody = el("p", "rr-home__device-body");
  private readonly hints = el("p", "rr-home__hints");
  /** keysSignature() the key hints were printed for (the preset can change from the gear menu right here). */
  private keysSig = "";
  private readonly langButtons = new Map<string, HTMLButtonElement>();

  private model: HomeModel | null = null;
  /** Fields typed before the last language reload; they win over the model's on the first update. */
  private draft: HomeDraft | null = takeHomeDraft(sessionStore());
  private localError: string | null = null;
  /** Model error the user already reacted to (typed after it); hidden until a new attempt. */
  private dismissedError: string | null = null;
  private pending: Action | null = null;
  private invalidField: HTMLInputElement | null = null;
  private codeHintTimer = 0;

  constructor(private readonly events: Emitter<UiEventMap>) {
    this.el.setAttribute("aria-label", "Raft Rush");
    const tpl = document.createElement("template");
    tpl.innerHTML = BACKDROP.trim();
    const scene = tpl.content.firstElementChild;
    if (scene) this.el.append(scene);
    this.el.append(this.buildTopBar(), el("div", "rr-home__main", this.buildLogo(), this.buildDeviceCard(), this.buildPanel()), this.hints);
    this.renderKeys();
    this.watchPointer();
    // Both language switches (EN / TR here, the settings menu) reload the page: keep what was typed.
    events.on("language", () => {
      if (!this.el.hidden) saveHomeDraft(sessionStore(), this.typed());
    });
    settings.onChange(() => this.renderKeys());
    // The keyboard layout map (input/bindings.ts) usually resolves after this first paint: AZERTY then reads ZQSD.
    onKeyCapsChange(() => this.renderKeys());
  }

  update(model: HomeModel): void {
    const prev = this.model;
    this.model = model;
    const draft = this.draft;
    this.draft = null;
    if (draft) {
      this.nickInput.value = draft.nickname.slice(0, NICKNAME_MAX);
      this.codeInput.value = sanitizeCode(draft.code);
    }
    if (!draft && (!prev || prev.nickname !== model.nickname)) this.nickInput.value = model.nickname.slice(0, NICKNAME_MAX);
    if (!draft && (!prev || prev.joinCode !== model.joinCode)) this.codeInput.value = sanitizeCode(model.joinCode);
    if (model.busy && !prev?.busy) this.dismissedError = null;
    if (!model.busy && !model.error) this.pending = null;
    for (const [id, b] of this.langButtons) {
      b.classList.toggle("is-selected", id === model.language);
      b.setAttribute("aria-checked", String(id === model.language));
    }
    this.renderBusy(model.busy);
    this.renderInvite();
    this.renderError();
    this.renderKeys();
  }

  /** Focus the name field when the screen appears without a name yet (an invite link lands right here). */
  onShow(): void {
    window.setTimeout(() => {
      if (!this.el.hidden && this.deviceCard.hidden && !this.model?.busy && !this.nickInput.value) this.nickInput.focus({ preventScroll: true });
    }, 60);
  }

  /* ------------------------------------------------------------- building */

  private buildTopBar(): HTMLElement {
    const back = el("a", "rr-pill-link rr-home__back", svg(ICON_BACK), t("menu.allGames"));
    back.href = "/";
    const langs = el("div", "rr-segmented rr-home__langs");
    langs.setAttribute("role", "radiogroup");
    langs.setAttribute("aria-label", t("menu.language"));
    for (const l of LANGS) {
      const b = button("rr-segmented__btn", `${l.flag} ${l.id.toUpperCase()}`);
      b.setAttribute("role", "radio");
      b.title = l.label;
      b.addEventListener("click", () => {
        if (l.id === (this.model?.language ?? settings.get().language)) return;
        this.events.emit("language", { lang: l.id });
        setLanguage(l.id);
      });
      this.langButtons.set(l.id, b);
      langs.append(b);
    }
    return el("div", "rr-home__top", back, langs);
  }

  private buildLogo(): HTMLElement {
    const logo = el("h1", "rr-logo");
    logo.setAttribute("aria-label", "Raft Rush");
    let i = 0;
    LOGO_WORDS.forEach((word, w) => {
      const wordEl = el("span", `rr-logo__word rr-logo__word--${w + 1}`);
      wordEl.setAttribute("aria-hidden", "true");
      for (const ch of word) {
        const letter = el("span", "rr-logo__letter rr-outlined", ch);
        letter.dataset.text = ch;
        letter.style.setProperty("--i", String(i++));
        wordEl.append(letter);
      }
      logo.append(wordEl);
    });
    return el("div", "rr-home__hero", logo, el("p", "rr-home__tagline", t("menu.tagline")), el("p", "rr-home__meta", t("menu.meta")));
  }

  /** Phones / tablets without a mouse: say so up front instead of a first-person view nobody can steer. */
  private buildDeviceCard(): HTMLElement {
    const card = this.deviceCard;
    const title = el("h2", "rr-home__device-title", t("menu.deviceTitle"));
    title.id = "rr-device-title";
    card.setAttribute("aria-labelledby", title.id);
    const other = el("a", "rr-btn rr-btn--primary rr-home__device-other", `🎮 ${t("menu.deviceOther")}`);
    other.href = "/";
    const go = button("rr-btn rr-home__device-go", t("menu.deviceContinue"));
    go.addEventListener("click", () => {
      dismissDeviceNotice(sessionStore());
      this.showDeviceCard(false);
      this.nickInput.focus({ preventScroll: true });
    });
    card.append(
      el("span", "rr-home__device-icon", "⌨️🖱️"),
      title,
      this.deviceBody,
      el("div", "rr-home__device-actions", other),
      el("p", "rr-home__device-note", t("menu.deviceNote")),
      el("div", "rr-home__device-actions", go),
    );
    return card;
  }

  private buildPanel(): HTMLElement {
    const panel = this.panel;
    panel.noValidate = true;
    panel.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submit(this.codeInput.value ? "join" : "create");
    });
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing || !(e.target instanceof HTMLInputElement)) return;
      e.preventDefault();
      this.submit(this.codeInput.value ? "join" : "create");
    });
    this.createBtn.append(el("span", "rr-btn__label", `🏝️ ${t("menu.create")}`));
    this.createBtn.addEventListener("click", () => this.submit("create"));
    panel.append(this.buildNicknameField(), el("div", "rr-home__create-row", this.createBtn), el("div", "rr-home__or", el("span", "", t("menu.or"))));
    panel.append(this.buildJoinRow(), this.codeHint, this.inviteEl, this.errorEl, this.reloadBtn);
    this.errorEl.setAttribute("role", "alert");
    this.errorEl.hidden = true;
    this.reloadBtn.hidden = true;
    this.reloadBtn.addEventListener("click", () => reloadKeepingDraft(sessionStore(), this.typed(), () => window.location.reload()));
    this.inviteEl.hidden = true;
    this.codeHint.hidden = true;
    return panel;
  }

  private buildNicknameField(): HTMLElement {
    const input = this.nickInput;
    input.id = "rr-nickname";
    input.type = "text";
    input.maxLength = NICKNAME_MAX;
    input.setAttribute("autocomplete", "nickname");
    input.spellcheck = false;
    input.placeholder = t("menu.nickPlaceholder");
    input.addEventListener("input", () => this.clearErrors());
    const dice = button("rr-btn rr-btn--icon rr-home__dice", svg(ICON_DICE));
    dice.title = t("menu.randomName");
    dice.setAttribute("aria-label", t("menu.randomName"));
    dice.addEventListener("click", () => {
      input.value = randomNickname();
      this.clearErrors();
      play(dice, [{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], { duration: 420, easing: "ease-out" });
    });
    const label = el("label", "rr-field__label", t("menu.nickLabel"));
    label.htmlFor = input.id;
    return el("div", "rr-field", label, el("div", "rr-field__row", input, dice));
  }

  private buildJoinRow(): HTMLElement {
    const input = this.codeInput;
    input.id = "rr-code";
    input.type = "text";
    input.maxLength = CODE_LENGTH;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "characters");
    input.placeholder = t("menu.codePlaceholder");
    input.setAttribute("aria-label", t("menu.codeAria"));
    input.addEventListener("input", () => this.onCodeInput());
    this.joinBtn.append(el("span", "rr-btn__label", t("menu.join")));
    this.joinBtn.addEventListener("click", () => this.submit("join"));
    return el("div", "rr-home__join-row", input, this.joinBtn);
  }

  /** The key hint row and the device card's "you walk with WASD": the active preset's keys, re-printed on a change. */
  private renderKeys(): void {
    const sig = keysSignature();
    if (sig === this.keysSig) return;
    this.keysSig = sig;
    const keys = keyParams();
    const items: Array<[string, string]> = [
      [String(keys.kMove), "menu.hintMove"],
      [t("menu.keyMouse"), "menu.hintLook"],
      [t("menu.keyHoldInteract", keys), "menu.hintGather"],
      [t("menu.keyHoldLmb"), "menu.hintThrow"],
      [String(keys.kEat), "menu.hintEat"],
      [String(keys.kPing), "menu.hintPing"],
    ];
    fill(this.hints, ...items.map(([key, what]) => el("span", "", el("kbd", "", key), ` ${t(what)}`)));
    setText(this.deviceBody, t("menu.deviceBody", keys));
  }

  /** What is typed in the form right now (kept across a reload). */
  private typed(): HomeDraft {
    return { nickname: this.nickInput.value, code: this.codeInput.value };
  }

  /* ------------------------------------------------------------ behaviour */

  /** Show the keyboard + mouse card on a device without a fine pointer; hide it once one is plugged in. */
  private watchPointer(): void {
    const needsCard = () => deviceNoticeDue(browserMedia(), sessionStore());
    this.showDeviceCard(needsCard());
    try {
      window.matchMedia?.("(any-pointer: fine)").addEventListener?.("change", () => {
        if (!this.deviceCard.hidden && !needsCard()) this.showDeviceCard(false);
      });
    } catch {
      // Old engines without MediaQueryList events: the card stays until "Continue anyway".
    }
  }

  private showDeviceCard(show: boolean): void {
    setHidden(this.deviceCard, !show);
    setHidden(this.panel, show);
    setHidden(this.hints, show);
  }

  private onCodeInput(): void {
    const raw = this.codeInput.value;
    const clean = sanitizeCode(raw);
    if (clean !== raw) {
      this.codeInput.value = clean;
      if (/[IO]/i.test(raw)) this.flashCodeHint(t("menu.codeNoIO"));
      else if (/[^A-Za-z]/.test(raw)) this.flashCodeHint(t("menu.codeLetters"));
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
    if (action === "join" && !code) return this.fail(t("menu.errNeedCode"), this.codeInput);
    if (action === "join" && !CODE_PATTERN.test(code)) return this.fail(t("menu.errBadCode"), this.codeInput);
    if (nickname.length < NICKNAME_MIN) return this.fail(t("menu.errNeedName"), this.nickInput);
    this.pending = action;
    this.localError = null;
    this.invalidField = null;
    this.renderError();
    settings.set({ nickname });
    if (action === "join") this.events.emit("join", { code, nickname });
    else this.events.emit("create", { nickname });
  }

  private fail(message: string, field: HTMLInputElement): void {
    this.localError = message;
    this.invalidField = field;
    this.renderError();
    field.focus();
    play(field, SHAKE_KEYFRAMES, { duration: 360 });
    this.events.emit("sound", { name: "uiError" });
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
    const invited = !!this.model?.joinCode && code === sanitizeCode(this.model.joinCode) && CODE_PATTERN.test(code);
    this.panel.classList.toggle("is-invited", invited);
    this.joinBtn.classList.toggle("rr-btn--primary", invited);
    this.createBtn.classList.toggle("rr-btn--primary", !invited);
    if (invited) setText(this.inviteEl, `💌 ${t("menu.invited", { code })}`);
    setHidden(this.inviteEl, !invited);
  }

  private renderError(): void {
    const modelError = this.model?.error && this.model.error !== this.dismissedError ? tr(this.model.error, "menu") : null;
    const message = this.localError ?? (this.model?.busy ? null : modelError);
    const wasHidden = this.errorEl.hidden;
    setHidden(this.errorEl, !message);
    setHidden(this.reloadBtn, !message || !!this.localError || this.model?.error !== "menu.errOutdated");
    for (const input of [this.nickInput, this.codeInput]) input.classList.toggle("is-invalid", !!this.localError && this.invalidField === input);
    if (!message) return;
    setText(this.errorEl, `🙈 ${message}`);
    if (wasHidden) play(this.errorEl, SHAKE_KEYFRAMES, { duration: 360 });
  }
}
