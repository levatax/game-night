// Esc settings menu. Owner: client-ui.

import { CAMERA_FOV_MAX, CAMERA_FOV_MIN, EMOTE_IDS, EMOTES } from "../../../shared/constants";
import type { Quality, Settings } from "../app/settings";
import type { Emitter } from "../util/Emitter";
import { button, el, play, setHidden, setText } from "./dom";
import type { UiEventMap } from "./models";

type NumericKey = "mouseSensitivity" | "fov" | "masterVolume" | "musicVolume" | "sfxVolume";
type ToggleKey = "invertY" | "showArcPreview";

interface SliderSpec {
  key: NumericKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format(value: number): string;
}

const SLIDERS: Record<NumericKey, SliderSpec> = {
  mouseSensitivity: { key: "mouseSensitivity", label: "Mouse sensitivity", min: 0.1, max: 3, step: 0.05, format: (v) => `${v.toFixed(2)}×` },
  fov: { key: "fov", label: "Field of view", min: CAMERA_FOV_MIN, max: CAMERA_FOV_MAX, step: 1, format: (v) => `${Math.round(v)}°` },
  masterVolume: { key: "masterVolume", label: "Master", min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
  musicVolume: { key: "musicVolume", label: "Music", min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
  sfxVolume: { key: "sfxVolume", label: "Sound effects", min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
};

const QUALITIES: ReadonlyArray<{ value: Quality; label: string; hint: string }> = [
  { value: "low", label: "Low", hint: "No shadows or effects. Smoothest on older laptops." },
  { value: "medium", label: "Medium", hint: "Soft shadows and anti-aliasing. The sweet spot." },
  { value: "high", label: "High", hint: "Crisp shadows, glow and bloom on balls and the crown." },
];

const CONTROLS: ReadonlyArray<[string, string]> = [
  ["W A S D", "Move"],
  ["Mouse", "Aim"],
  ["Hold LMB", "Charge & throw"],
  ["Tap LMB", "Quick throw"],
  ["RMB", "Catch (time it!)"],
  ["Space", "Jump"],
  ["Shift", "Dodge roll"],
  ["E", "Ability"],
  ["Q", "Emote"],
  ["Tab", "Scoreboard"],
  ["Esc", "This menu"],
];

class Slider {
  readonly el: HTMLElement;
  readonly input = el("input", "slider");
  private readonly value = el("output", "setting__value");

  constructor(readonly spec: SliderSpec, onInput: (key: NumericKey, value: number) => void) {
    const id = `bb-set-${spec.key}`;
    const { input } = this;
    input.type = "range";
    input.id = id;
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.addEventListener("input", () => {
      const v = Number(input.value);
      this.render(v);
      onInput(spec.key, v);
    });
    const label = el("label", "setting__label", spec.label);
    label.htmlFor = id;
    this.value.htmlFor.add(id);
    this.el = el("div", "setting setting--slider", label, this.value, input);
  }

  set(value: number): void {
    this.input.value = String(value);
    this.render(Number(this.input.value));
  }

  private render(value: number): void {
    const t = (value - this.spec.min) / (this.spec.max - this.spec.min);
    this.input.style.setProperty("--fill", `${Math.max(0, Math.min(1, t)) * 100}%`);
    const text = this.spec.format(value);
    setText(this.value, text);
    this.input.setAttribute("aria-valuetext", text);
  }
}

class Toggle {
  readonly el: HTMLElement;
  private readonly sw = button("switch");
  private readonly state = el("span", "switch__state");

  constructor(label: string, onToggle: (on: boolean) => void) {
    const sw = this.sw;
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-label", label);
    sw.dataset.sound = "toggle";
    sw.append(el("span", "switch__knob"), this.state);
    sw.addEventListener("click", () => {
      const next = sw.getAttribute("aria-checked") !== "true";
      this.set(next);
      onToggle(next);
    });
    this.el = el("div", "setting setting--toggle", el("span", "setting__label", label), sw);
  }

  set(on: boolean): void {
    this.sw.setAttribute("aria-checked", String(on));
    setText(this.state, on ? "On" : "Off");
  }
}

/**
 * Overlay with: mouse sensitivity (0.1–3), invert Y, FOV (60–100), Master/Music/SFX volume
 * (0–100%), graphics quality Low/Med/High, show arc preview. Every change emits settingsChange
 * immediately (live preview). Buttons: Resume (emits resume — App re-locks the pointer),
 * Leave room (leaveRoom, with a confirm step), Back to Game Night (backToPortal).
 * Also lists the controls (game1.md §6).
 */
export class SettingsMenu {
  readonly el: HTMLElement = document.createElement("div");

  private readonly events: Emitter<UiEventMap>;
  private readonly panel = el("div", "panel settings-menu__panel");
  private readonly heading = el("h2", "settings-menu__title");
  private readonly sliders = new Map<NumericKey, Slider>();
  private readonly toggles = new Map<ToggleKey, Toggle>();
  private readonly qualityButtons = new Map<Quality, HTMLButtonElement>();
  private readonly qualityHint = el("p", "setting__hint");
  private readonly emoteRow = el("div", "settings-menu__emotes");
  private readonly resumeBtn = button("btn btn--primary btn--big settings-menu__resume", el("span", "btn__label", "Resume"));
  private readonly leaveBtn = button("btn settings-menu__leave", "Leave room");
  private readonly portalBtn = button("btn settings-menu__portal", "Back to Game Night");
  private readonly confirm = el("div", "settings-menu__confirm");
  private openState = false;
  private inRoom = false;

  constructor(events: Emitter<UiEventMap>) {
    this.events = events;
    this.el.className = "settings-menu";
    this.el.hidden = true;
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-modal", "true");
    this.heading.id = "bb-settings-title";
    this.el.setAttribute("aria-labelledby", this.heading.id);
    this.panel.append(this.buildHeader(), this.buildBody(), this.buildFooter());
    this.el.append(this.panel);
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.resume();
    });
    document.addEventListener("keydown", (e) => this.onKey(e), true);
  }

  open(current: Readonly<Settings>, inRoom: boolean): void {
    this.inRoom = inRoom;
    for (const [key, slider] of this.sliders) slider.set(current[key]);
    this.toggles.get("invertY")?.set(current.invertY);
    this.toggles.get("showArcPreview")?.set(current.showArcPreview);
    this.renderQuality(current.quality);
    setText(this.heading, inRoom ? "Paused" : "Settings");
    setHidden(this.leaveBtn, !inRoom);
    setHidden(this.emoteRow, !inRoom);
    this.showConfirm(false);
    if (this.openState) return;
    this.openState = true;
    this.el.hidden = false;
    play(this.panel, [{ transform: "translateY(24px) scale(0.94)", opacity: 0 }, { transform: "none", opacity: 1 }], {
      duration: 240,
      easing: "cubic-bezier(.3,1.4,.5,1)",
    });
    this.resumeBtn.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.el.hidden = true;
    this.showConfirm(false);
  }

  get isOpen(): boolean {
    return this.openState;
  }

  /* ------------------------------------------------------------- building */

  private buildHeader(): HTMLElement {
    const close = button("btn btn--icon settings-menu__close", "✕");
    close.setAttribute("aria-label", "Close menu and resume");
    close.addEventListener("click", () => this.resume());
    return el("header", "settings-menu__head", this.heading, close);
  }

  private buildBody(): HTMLElement {
    const change = (key: NumericKey, value: number) => this.emit({ [key]: value });
    for (const spec of Object.values(SLIDERS)) this.sliders.set(spec.key, new Slider(spec, change));
    this.toggles.set("invertY", new Toggle("Invert Y", (on) => this.emit({ invertY: on })));
    this.toggles.set("showArcPreview", new Toggle("Arc preview at full charge", (on) => this.emit({ showArcPreview: on })));

    const slider = (key: NumericKey) => (this.sliders.get(key) as Slider).el;
    const toggle = (key: ToggleKey) => (this.toggles.get(key) as Toggle).el;
    const left = el(
      "div",
      "settings-menu__col",
      this.section("🖱️ Mouse & camera", slider("mouseSensitivity"), toggle("invertY"), slider("fov")),
      this.section("🔊 Sound", slider("masterVolume"), slider("musicVolume"), slider("sfxVolume")),
    );
    const right = el(
      "div",
      "settings-menu__col",
      this.section("✨ Graphics", this.buildQuality(), toggle("showArcPreview")),
      this.buildEmotes(),
      this.buildControls(),
    );
    return el("div", "settings-menu__body", left, right);
  }

  private section(title: string, ...children: HTMLElement[]): HTMLElement {
    return el("section", "settings-section", el("h3", "settings-section__title", title), ...children);
  }

  private buildQuality(): HTMLElement {
    const seg = el("div", "segmented segmented--wide");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", "Graphics quality");
    for (const q of QUALITIES) {
      const b = button("segmented__btn", q.label);
      b.setAttribute("role", "radio");
      b.addEventListener("click", () => {
        this.renderQuality(q.value);
        this.emit({ quality: q.value });
      });
      this.qualityButtons.set(q.value, b);
      seg.append(b);
    }
    return el("div", "setting setting--quality", el("span", "setting__label", "Quality"), seg, this.qualityHint);
  }

  private buildEmotes(): HTMLElement {
    for (const id of EMOTE_IDS) {
      const def = EMOTES[id];
      const b = button("btn btn--small emote-btn", el("span", "emote-btn__icon", def.icon), def.name);
      b.addEventListener("click", () => {
        this.events.emit("emote", { emote: id });
        this.resume();
      });
      this.emoteRow.append(b);
    }
    return el("div", "settings-section settings-section--emotes", el("h3", "settings-section__title", "🎺 Emote"), this.emoteRow);
  }

  private buildControls(): HTMLElement {
    const list = el("dl", "controls-list");
    for (const [keys, action] of CONTROLS) list.append(el("div", "controls-list__row", el("dt", "", el("kbd", "", keys)), el("dd", "", action)));
    return this.section("🎮 Controls", list);
  }

  private buildFooter(): HTMLElement {
    this.resumeBtn.addEventListener("click", () => this.resume());
    this.leaveBtn.addEventListener("click", () => this.showConfirm(true));
    this.portalBtn.addEventListener("click", () => this.events.emit("backToPortal", undefined));

    const yes = button("btn btn--danger btn--small", "Yes, leave");
    const no = button("btn btn--small", "Stay");
    yes.addEventListener("click", () => {
      this.close();
      this.events.emit("leaveRoom", undefined);
    });
    no.addEventListener("click", () => {
      this.showConfirm(false);
      this.leaveBtn.focus();
    });
    this.confirm.append(el("span", "settings-menu__confirm-text", "Leave this room?"), yes, no);
    this.confirm.setAttribute("role", "alertdialog");

    const secondary = el("div", "settings-menu__secondary", this.leaveBtn, this.confirm, this.portalBtn);
    return el("footer", "settings-menu__foot", this.resumeBtn, secondary);
  }

  /* ------------------------------------------------------------ behaviour */

  private renderQuality(quality: Quality): void {
    for (const [value, b] of this.qualityButtons) {
      const selected = value === quality;
      b.setAttribute("aria-checked", String(selected));
      b.classList.toggle("is-selected", selected);
    }
    setText(this.qualityHint, QUALITIES.find((q) => q.value === quality)?.hint ?? "");
  }

  private showConfirm(show: boolean): void {
    setHidden(this.confirm, !show);
    setHidden(this.leaveBtn, show || !this.inRoom);
    if (show) {
      play(this.confirm, [{ transform: "scale(0.9)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 180, easing: "ease-out" });
      this.confirm.querySelector<HTMLButtonElement>(".btn--danger")?.focus();
    }
  }

  private emit(patch: Partial<Settings>): void {
    this.events.emit("settingsChange", patch);
  }

  private resume(): void {
    this.close();
    this.events.emit("resume", undefined);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.openState) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!this.confirm.hidden) this.showConfirm(false);
      else this.resume();
      return;
    }
    if (e.key === "Tab") this.trapFocus(e);
  }

  /** Keep keyboard focus inside the dialog while it is open. */
  private trapFocus(e: KeyboardEvent): void {
    const focusables = [...this.panel.querySelectorAll<HTMLElement>("button, input, [tabindex]")].filter(
      (n) => !n.hidden && !n.closest("[hidden]") && !(n as HTMLButtonElement).disabled && n.tabIndex >= 0,
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !this.panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !this.panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }
}
