// Home screen (§16.1): a hanging neon "KASALA!" sign (Monoton, flickering), a random tagline, and a cream paper
// form card: nickname (+ dice), "Masa Kur", "Masaya Otur" with a 4-letter code, inline error, busy line, a
// "Nasıl oynanır?" fold-out (the rule in one line + keys) and a hint that bots fill the table for solo play.
// Compact on the left so Cemil Abi shuffling in the 3D scene stays visible.
// Enter: in the code field → join; in the nickname field → join when a full code is typed, else create.

import { CODE_ALPHABET, CODE_LENGTH, NICKNAME_MAX, NICKNAME_STORAGE_KEY } from "../../../../shared/constants";
import type { UiSound } from "../../app/ui";
import { GANGSTER_NAMES, HOW_TO, HOW_TO_RULE, SOLO_HINT, TAGLINES } from "./copy";
import { h, pick, readStorage, replay, writeStorage } from "./dom";

export interface HomeCallbacks {
  onCreate(nickname: string): void;
  onJoin(code: string, nickname: string): void;
  sound(kind: UiSound): void;
}

/**
 * Codes are ASCII: plain toUpperCase on purpose (the Turkish locale would turn "i" into "İ"). A pasted share
 * link ("…/r/ABCD" or "?room=ABCD") yields its code.
 */
export function sanitizeCode(raw: string): string {
  const link = /(?:\/r\/|[?&]room=)([A-Za-z]+)/.exec(raw);
  if (link) raw = link[1]!;
  let out = "";
  for (const ch of raw.toUpperCase()) if (CODE_ALPHABET.includes(ch)) out += ch;
  return out.slice(0, CODE_LENGTH);
}

export class HomeScreen {
  readonly el: HTMLElement;
  private readonly cb: HomeCallbacks;
  private readonly tagline: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly nick: HTMLInputElement;
  private readonly code: HTMLInputElement;
  private readonly createBtn: HTMLButtonElement;
  private readonly joinBtn: HTMLButtonElement;
  private readonly error: HTMLElement;
  private readonly busyLine: HTMLElement;
  private readonly busyText: HTMLElement;
  private readonly logo: HTMLElement;
  private busy = false;
  private pending: "create" | "join" | null = null;

  constructor(cb: HomeCallbacks) {
    this.cb = cb;
    this.el = h("section", "ks-menu-screen ks-menu-home", { "aria-label": "Ana sayfa" });
    const shade = h("div", "ks-menu-home-shade", { "aria-hidden": "true" });

    const back = h("a", "ks-menu-back", { href: "/" }, "← Oyun Gecesi");

    // ---------------------------------------------------------------- neon sign
    const sign = h("div", "ks-menu-sign");
    sign.append(h("span", "ks-menu-chain ks-menu-chain--l", { "aria-hidden": "true" }), h("span", "ks-menu-chain ks-menu-chain--r", { "aria-hidden": "true" }));
    this.logo = h("h1", "ks-menu-logo ks-neon", { "aria-label": "KASALA!" });
    [..."KASALA!"].forEach((ch, i) => {
      const s = h("span", `ks-menu-logo-ch${i === 3 ? " ks-menu-logo-ch--broken" : ""}`, { "aria-hidden": "true" }, ch);
      s.style.setProperty("--i", String(i));
      this.logo.appendChild(s);
    });
    const siren = h("span", "ks-menu-siren", { "aria-hidden": "true" });
    siren.appendChild(h("span", "ks-menu-siren-beam"));
    const sub = h("p", "ks-menu-sign-sub", undefined, "Cemil Abi'nin masası · 2–6 gangster, botlar dahil");
    sign.append(siren, this.logo, sub);
    // Poking the sign makes it buzz.
    sign.addEventListener("pointerenter", () => {
      replay(sign, "ks-menu-sign--buzz");
      cb.sound("hover");
    });

    this.tagline = h("p", "ks-menu-tagline", { "aria-live": "off" }, pick(TAGLINES));

    // ---------------------------------------------------------------- form
    this.form = h("form", "ks-menu-paper ks-menu-home-card", { novalidate: "", "aria-label": "Masaya katıl" });
    const nickLabel = h("label", "ks-menu-label", { for: "ks-menu-nick" }, "Takma adın");
    this.nick = h("input", "ks-menu-input", {
      id: "ks-menu-nick",
      type: "text",
      maxlength: String(NICKNAME_MAX),
      autocomplete: "nickname",
      spellcheck: "false",
      enterkeyhint: "go",
      placeholder: pick(GANGSTER_NAMES),
    });
    const dice = h("button", "ks-menu-dice", { type: "button", "aria-label": "Rastgele gangster adı", title: "Rastgele gangster adı" }, "🎲");
    dice.addEventListener("click", () => {
      let name = pick(GANGSTER_NAMES);
      for (let i = 0; i < 4 && name === this.nick.value; i++) name = pick(GANGSTER_NAMES);
      this.nick.value = name.slice(0, NICKNAME_MAX);
      writeStorage(NICKNAME_STORAGE_KEY, this.nick.value);
      replay(dice, "ks-menu-roll");
      this.nick.focus();
      cb.sound("pop");
    });
    const nickRow = h("div", "ks-menu-row");
    nickRow.append(this.nick, dice);

    this.createBtn = h("button", "ks-btn ks-menu-big ks-menu-create", { type: "button" });
    this.createBtn.addEventListener("click", () => this.doCreate());

    const solo = h("p", "ks-menu-solo", undefined, SOLO_HINT);
    const or = h("div", "ks-menu-or", { "aria-hidden": "true" }, "ya da bir masaya otur");

    const codeLabel = h("label", "ks-menu-label", { for: "ks-menu-code" }, "Masa kodu");
    this.code = h("input", "ks-menu-input ks-menu-code-input", {
      id: "ks-menu-code",
      type: "text",
      autocomplete: "off",
      autocapitalize: "characters",
      spellcheck: "false",
      enterkeyhint: "go",
      placeholder: "ABCD",
      "aria-describedby": "ks-menu-code-hint",
    });
    this.code.addEventListener("input", () => {
      const clean = sanitizeCode(this.code.value);
      if (clean !== this.code.value) {
        const caret = Math.min(clean.length, this.code.selectionStart ?? clean.length);
        this.code.value = clean;
        this.code.setSelectionRange(caret, caret);
      }
      this.code.classList.toggle("ks-menu-code-input--full", clean.length === CODE_LENGTH);
      this.clearError();
    });
    this.joinBtn = h("button", "ks-btn ks-btn--pink ks-menu-join", { type: "button" });
    this.joinBtn.addEventListener("click", () => this.doJoin());
    const joinRow = h("div", "ks-menu-row ks-menu-join-row");
    joinRow.append(this.code, this.joinBtn);
    const hint = h("span", "ks-menu-sr", { id: "ks-menu-code-hint" }, `${CODE_LENGTH} harfli masa kodu`);

    this.error = h("p", "ks-menu-error", { role: "alert", "aria-live": "assertive" });
    this.busyLine = h("p", "ks-menu-busy", { "aria-live": "polite" });
    this.busyText = h("span", undefined, undefined, "Bağlanıyor…");
    this.busyLine.append(h("span", "ks-menu-chip-spin", { "aria-hidden": "true" }), this.busyText);

    const how = h("details", "ks-menu-how");
    how.appendChild(h("summary", undefined, undefined, "Nasıl oynanır?"));
    how.appendChild(h("p", "ks-menu-how-rule", undefined, HOW_TO_RULE));
    const list = h("ul", "ks-menu-how-list");
    for (const [key, text] of HOW_TO) {
      const li = h("li");
      li.append(h("kbd", "ks-key", undefined, key), document.createTextNode(` ${text}`));
      list.appendChild(li);
    }
    how.appendChild(list);
    how.addEventListener("toggle", () => cb.sound(how.open ? "open" : "close"));

    this.form.append(nickLabel, nickRow, this.createBtn, solo, or, codeLabel, joinRow, hint, this.error, this.busyLine, how);
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submit();
    });
    // Inputs inside a form with no submit button: handle Enter ourselves.
    for (const input of [this.nick, this.code]) {
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing) return;
        e.preventDefault();
        this.submit(input);
      });
    }
    this.nick.addEventListener("input", () => this.clearError());
    this.nick.addEventListener("change", () => {
      const v = this.nick.value.trim();
      if (v) writeStorage(NICKNAME_STORAGE_KEY, v.slice(0, NICKNAME_MAX));
    });

    const col = h("div", "ks-menu-home-col");
    col.append(sign, this.tagline, this.form);
    this.el.append(shade, back, col);
    this.renderButtons();
  }

  show(opts: { nickname: string; code?: string; error?: string }): void {
    this.tagline.textContent = pick(TAGLINES);
    const name = (opts.nickname || readStorage(NICKNAME_STORAGE_KEY)).slice(0, NICKNAME_MAX);
    if (name) this.nick.value = name;
    if (opts.code !== undefined) {
      this.code.value = sanitizeCode(opts.code);
      this.code.classList.toggle("ks-menu-code-input--full", this.code.value.length === CODE_LENGTH);
    }
    this.setBusy(false);
    if (opts.error) this.showError(opts.error, false);
    else this.clearError();
    replay(this.logo, "ks-menu-logo--on");
    requestAnimationFrame(() => {
      if (this.el.hidden) return;
      if (!this.nick.value) this.nick.focus({ preventScroll: true });
      else if (this.code.value && this.code.value.length < CODE_LENGTH) this.code.focus({ preventScroll: true });
      else this.nick.focus({ preventScroll: true });
    });
  }

  setBusy(busy: boolean, label?: string): void {
    this.busy = busy;
    if (!busy) this.pending = null;
    this.busyText.textContent = label || "Bağlanıyor…";
    this.el.classList.toggle("ks-menu-home--busy", busy);
    this.el.setAttribute("aria-busy", String(busy));
    this.nick.readOnly = busy;
    this.code.readOnly = busy;
    this.renderButtons();
  }

  showError(text: string, withSound = true): void {
    this.setBusy(false);
    this.error.textContent = text;
    replay(this.error, "ks-menu-shake");
    if (withSound) this.cb.sound("deny");
  }

  private clearError(): void {
    if (this.error.textContent) this.error.textContent = "";
  }

  private renderButtons(): void {
    const busyLabel = this.busyText.textContent ?? "Bağlanıyor…";
    this.createBtn.disabled = this.busy;
    this.joinBtn.disabled = this.busy;
    this.createBtn.textContent = this.busy && this.pending === "create" ? busyLabel : "🎩 Masa Kur";
    this.joinBtn.textContent = this.busy && this.pending === "join" ? busyLabel : "🪑 Masaya Otur";
  }

  private submit(from?: HTMLInputElement): void {
    if (from === this.code || (from === this.nick && this.code.value.length === CODE_LENGTH)) this.doJoin();
    else this.doCreate();
  }

  /** Trimmed nickname; empty → the placeholder gangster name (filled in so the player sees it). */
  private takeNickname(): string {
    let name = this.nick.value.replace(/\s+/g, " ").trim().slice(0, NICKNAME_MAX);
    if (!name) {
      name = (this.nick.placeholder || pick(GANGSTER_NAMES)).slice(0, NICKNAME_MAX);
      this.nick.value = name;
    }
    writeStorage(NICKNAME_STORAGE_KEY, name);
    return name;
  }

  private doCreate(): void {
    if (this.busy) return;
    this.clearError();
    const name = this.takeNickname();
    this.pending = "create";
    this.setBusy(true);
    this.cb.onCreate(name);
  }

  private doJoin(): void {
    if (this.busy) return;
    const code = sanitizeCode(this.code.value);
    if (code.length !== CODE_LENGTH) {
      this.showError(code.length === 0 ? "Önce masa kodunu yaz." : `Masa kodu ${CODE_LENGTH} harfli olmalı.`);
      this.code.focus();
      return;
    }
    this.clearError();
    const name = this.takeNickname();
    this.pending = "join";
    this.setBusy(true);
    this.cb.onJoin(code, name);
  }
}
