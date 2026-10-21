// Esc menu (§15, §17): sound sliders + mute, mouse sensitivity / invert Y / mouse lock (off = drag-look) / FOV /
// head bob, graphics quality (Auto or a fixed tier), HUD size, arc preview, reduced flashing, language (reloads
// the page), the key preset + the controls list, "Show tips again" and Leave room (with a confirm step). Every
// change is saved through settings.set() at once (live preview) and also emitted as `settings` / `language` for
// the app. A real modal: the first control takes the focus on open, Tab stays inside, the focus goes back where it
// was on close. Adapted from games/bonk-brawl/client/src/ui/SettingsMenu.ts. Owner: client-ui.

import { CAMERA_FOV_MAX, CAMERA_FOV_MIN } from "../../../../shared/constants";
import { HUD_SCALE_MAX, HUD_SCALE_MIN, settings, type KeyPreset, type Lang, type Quality, type Settings } from "../../app/settings";
import { LANGS, setLanguage, t } from "../../i18n";
import { buildControlsList, keyParams, refreshControlsList } from "../controls";
import { button, el, play, setDisabled, setHidden, setText, svg } from "../dom";
import { ICON_CLOSE } from "../icons";

type NumericKey = "mouseSensitivity" | "fov" | "masterVolume" | "musicVolume" | "sfxVolume" | "hudScale";
type ToggleKey = "invertY" | "headBob" | "showArcPreview" | "reducedFlashing" | "muted" | "mouseLock";
/** The quality segments: "auto" is settings.autoQuality, the rest a fixed tier. */
type QualityChoice = "auto" | Quality;

interface SliderSpec {
  key: NumericKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format(value: number): string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

const SLIDERS: ReadonlyArray<SliderSpec> = [
  { key: "masterVolume", label: "overlays.master", min: 0, max: 1, step: 0.01, format: pct },
  { key: "musicVolume", label: "overlays.music", min: 0, max: 1, step: 0.01, format: pct },
  { key: "sfxVolume", label: "overlays.sfx", min: 0, max: 1, step: 0.01, format: pct },
  { key: "mouseSensitivity", label: "overlays.sensitivity", min: 0.1, max: 3, step: 0.05, format: (v) => `${v.toFixed(2)}×` },
  { key: "fov", label: "overlays.fov", min: CAMERA_FOV_MIN, max: CAMERA_FOV_MAX, step: 1, format: (v) => `${Math.round(v)}°` },
  { key: "hudScale", label: "overlays.hudScale", min: HUD_SCALE_MIN, max: HUD_SCALE_MAX, step: 0.05, format: pct },
];

const QUALITY_CHOICES: ReadonlyArray<QualityChoice> = ["auto", "low", "medium", "high"];
const KEY_PRESETS: ReadonlyArray<KeyPreset> = ["standard", "leftHanded"];

class Slider {
  readonly el: HTMLElement;
  private readonly input = el("input", "rr-slider");
  private readonly value = el("output", "rr-setting__value");

  constructor(
    private readonly spec: SliderSpec,
    onInput: (key: NumericKey, value: number) => void,
  ) {
    const id = `rr-set-${spec.key}`;
    const input = this.input;
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
    const label = el("label", "rr-setting__label", t(spec.label));
    label.htmlFor = id;
    this.value.htmlFor.add(id);
    this.el = el("div", "rr-setting rr-setting--slider", label, this.value, input);
  }

  set(value: number): void {
    this.input.value = String(value);
    this.render(Number(this.input.value));
  }

  private render(value: number): void {
    const f = (value - this.spec.min) / (this.spec.max - this.spec.min);
    this.input.style.setProperty("--fill", `${Math.max(0, Math.min(1, f)) * 100}%`);
    const text = this.spec.format(value);
    setText(this.value, text);
    this.input.setAttribute("aria-valuetext", text);
  }
}

class Toggle {
  readonly el: HTMLElement;
  private readonly sw = button("rr-switch");
  private readonly state = el("span", "rr-switch__state");
  private readonly name: Text;

  constructor(label: string, onToggle: (on: boolean) => void, hint = "") {
    const sw = this.sw;
    this.name = document.createTextNode(label);
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-label", label);
    sw.append(el("span", "rr-switch__knob"), this.state);
    sw.addEventListener("click", () => {
      const next = sw.getAttribute("aria-checked") !== "true";
      this.set(next);
      onToggle(next);
    });
    const text = el("span", "rr-setting__label", this.name, hint ? el("small", "rr-setting__hint", hint) : null);
    this.el = el("div", "rr-setting rr-setting--toggle", text, sw);
  }

  set(on: boolean): void {
    this.sw.setAttribute("aria-checked", String(on));
    setText(this.state, on ? t("overlays.on") : t("overlays.off"));
  }

  /** New label text ("Mute everything (M)" names a key that follows the preset / layout). */
  relabel(label: string): void {
    if (this.name.data === label) return;
    this.name.data = label;
    this.sw.setAttribute("aria-label", label);
  }
}

/** A row of radio buttons (quality, key preset, language). */
function segmented<T extends string>(label: string, values: ReadonlyArray<T>, text: (v: T) => string, onPick: (v: T) => void): { el: HTMLElement; buttons: Map<T, HTMLButtonElement> } {
  const seg = el("div", "rr-segmented rr-segmented--wide");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", label);
  const buttons = new Map<T, HTMLButtonElement>();
  for (const v of values) {
    const b = button("rr-segmented__btn", text(v));
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => onPick(v));
    buttons.set(v, b);
    seg.append(b);
  }
  return { el: seg, buttons };
}

function markSelected<T extends string>(buttons: Map<T, HTMLButtonElement>, selected: T): void {
  for (const [value, b] of buttons) {
    b.setAttribute("aria-checked", String(value === selected));
    b.classList.toggle("is-selected", value === selected);
  }
}

export interface SettingsMenuHandlers {
  onClose(): void;
  onLeave(): void;
  onSettings(patch: Partial<Settings>): void;
  onLanguage(lang: Lang): void;
}

export class SettingsMenu {
  readonly el = el("div", "rr-modal rr-settings");
  private readonly panel = el("div", "rr-panel rr-settings__panel");
  private readonly heading = el("h2", "rr-modal__title");
  private readonly note = el("p", "rr-settings__note");
  private readonly sliders = new Map<NumericKey, Slider>();
  private readonly toggles = new Map<ToggleKey, Toggle>();
  /** i18n key of each toggle's label (re-translated with keyParams() on refresh: the mute key follows the layout). */
  private readonly toggleLabels = new Map<ToggleKey, string>();
  private qualityButtons = new Map<QualityChoice, HTMLButtonElement>();
  private readonly qualityHint = el("p", "rr-setting__hint");
  private presetButtons = new Map<KeyPreset, HTMLButtonElement>();
  private readonly presetHint = el("p", "rr-setting__hint");
  private readonly controlsList = buildControlsList("rr-controls rr-controls--compact");
  private readonly tipsBtn = button("rr-link-btn rr-settings__tips");
  private langButtons = new Map<Lang, HTMLButtonElement>();
  private readonly leaveBtn = button("rr-btn rr-btn--danger rr-btn--small", `🏊 ${t("overlays.leave")}`);
  private readonly confirm = el("div", "rr-settings__confirm");
  private openState = false;
  private inRoom = false;
  /** "Show tips again" was pressed during this opening (the label says so until the menu closes). */
  private tipsCleared = false;
  /** Where the focus was before the menu opened (it goes back there on close). */
  private returnFocus: HTMLElement | null = null;
  private readonly onDocKey = (e: KeyboardEvent): void => {
    if (e.key === "Tab" && this.openState) this.trapFocus(e);
  };

  constructor(private readonly h: SettingsMenuHandlers) {
    this.el.hidden = true;
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-modal", "true");
    this.heading.id = "rr-settings-title";
    this.el.setAttribute("aria-labelledby", this.heading.id);
    this.panel.append(this.buildHeader(), this.buildBody(), this.buildFooter());
    this.el.append(this.panel);
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.h.onClose();
    });
  }

  get isOpen(): boolean {
    return this.openState;
  }

  /** `inGame`: the island keeps running behind the menu; `inRoom` shows Leave room. */
  open(inRoom: boolean, inGame: boolean): void {
    this.inRoom = inRoom;
    setText(this.heading, inGame ? `⏸️ ${t("overlays.pausedTitle")}` : `⚙️ ${t("overlays.settingsTitle")}`);
    setText(this.note, inGame ? t("overlays.pausedNote") : "");
    setHidden(this.note, !inGame);
    this.showConfirm(false);
    if (this.openState) {
      this.refresh(settings.get());
      return;
    }
    this.openState = true;
    this.tipsCleared = false;
    this.refresh(settings.get());
    const active = document.activeElement;
    this.returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    this.el.hidden = false;
    document.addEventListener("keydown", this.onDocKey, true);
    play(this.panel, [{ transform: "translateY(24px) scale(0.94)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 240, easing: "cubic-bezier(.3,1.4,.5,1)" });
    // Screen readers and keyboards start on the first setting (not on the body behind the modal).
    this.focusables().find((n) => !n.closest(".rr-modal__head"))?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.el.hidden = true;
    this.showConfirm(false);
    document.removeEventListener("keydown", this.onDocKey, true);
    if (document.activeElement instanceof HTMLElement && this.el.contains(document.activeElement)) document.activeElement.blur();
    // Back to the opener (the lobby's gear…) once the caller has finished re-rendering (it may unhide it).
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back)
      queueMicrotask(() => {
        if (!this.openState && back.isConnected && !back.closest("[hidden]")) back.focus({ preventScroll: true });
      });
  }

  /** Esc inside the menu: first closes the leave confirmation, then the menu. Returns true when it was handled. */
  escape(): boolean {
    if (!this.confirm.hidden) {
      this.showConfirm(false);
      return true;
    }
    return false;
  }

  /** Re-read values (another module changed a setting, e.g. M mute, or the auto quality stepped down). */
  refresh(s: Readonly<Settings>): void {
    for (const [key, slider] of this.sliders) slider.set(s[key]);
    for (const [key, toggle] of this.toggles) {
      toggle.set(s[key]);
      toggle.relabel(t(this.toggleLabels.get(key) ?? "", keyParams()));
    }
    this.renderQuality(s);
    markSelected(this.presetButtons, s.keyPreset);
    setText(this.presetHint, t(`overlays.keyPresetHint_${s.keyPreset}`));
    refreshControlsList(this.controlsList);
    markSelected(this.langButtons, s.language);
    this.renderTips(s);
  }

  /* ------------------------------------------------------------- building */

  private buildHeader(): HTMLElement {
    const close = button("rr-btn rr-btn--icon rr-modal__close", svg(ICON_CLOSE));
    close.setAttribute("aria-label", t("overlays.close"));
    close.addEventListener("click", () => this.h.onClose());
    return el("header", "rr-modal__head", this.heading, close);
  }

  private buildBody(): HTMLElement {
    for (const spec of SLIDERS) this.sliders.set(spec.key, new Slider(spec, (key, value) => this.change({ [key]: value })));
    const tog = (key: ToggleKey, label: string, hint = "") => {
      const toggle = new Toggle(t(label, keyParams()), (on) => this.change({ [key]: on }), hint ? t(hint) : "");
      this.toggles.set(key, toggle);
      this.toggleLabels.set(key, label);
      return toggle.el;
    };
    const slider = (key: NumericKey) => this.sliders.get(key)!.el;
    const left = el(
      "div",
      "rr-settings__col",
      this.section(t("overlays.secSound"), slider("masterVolume"), slider("musicVolume"), slider("sfxVolume"), tog("muted", "overlays.mute")),
      this.section(
        t("overlays.secCamera"),
        slider("mouseSensitivity"),
        tog("invertY", "overlays.invertY"),
        tog("mouseLock", "overlays.mouseLock", "overlays.mouseLockHint"),
        slider("fov"),
        tog("headBob", "overlays.headBob"),
      ),
    );
    const right = el(
      "div",
      "rr-settings__col",
      this.section(
        t("overlays.secGraphics"),
        this.buildQuality(),
        slider("hudScale"),
        tog("showArcPreview", "overlays.arcPreview"),
        tog("reducedFlashing", "overlays.reducedFlashing", "overlays.reducedFlashingHint"),
      ),
      this.section(t("overlays.secLanguage"), this.buildLanguage(), el("p", "rr-setting__hint", t("overlays.languageNote"))),
      this.section(t("overlays.secControls"), this.buildPreset(), this.controlsList, this.buildTips()),
    );
    return el("div", "rr-settings__body", this.note, left, right);
  }

  private section(title: string, ...children: HTMLElement[]): HTMLElement {
    return el("section", "rr-settings__section", el("h3", "rr-settings__section-title", title), ...children);
  }

  private buildQuality(): HTMLElement {
    const seg = segmented(t("overlays.quality"), QUALITY_CHOICES, (q) => t(`overlays.quality_${q}`), (q) => {
      // Auto (also when it already is on) makes app/quality.ts re-guess the tier from the device; a tier turns Auto off.
      this.change(q === "auto" ? { autoQuality: true } : { quality: q, autoQuality: false });
      this.renderQuality(settings.get());
    });
    this.qualityButtons = seg.buttons;
    return el("div", "rr-setting rr-setting--quality", el("span", "rr-setting__label", t("overlays.quality")), seg.el, this.qualityHint);
  }

  private buildPreset(): HTMLElement {
    const seg = segmented(t("overlays.keyPreset"), KEY_PRESETS, (p) => t(`overlays.keyPreset_${p}`), (p) => {
      this.change({ keyPreset: p });
      this.refresh(settings.get());
    });
    this.presetButtons = seg.buttons;
    return el("div", "rr-setting rr-setting--quality", el("span", "rr-setting__label", t("overlays.keyPreset")), seg.el, this.presetHint);
  }

  private buildLanguage(): HTMLElement {
    const seg = segmented(t("overlays.secLanguage"), LANGS.map((l) => l.id), (id) => {
      const l = LANGS.find((x) => x.id === id)!;
      return `${l.flag} ${l.label}`;
    }, (id) => {
      if (id === settings.get().language) return;
      this.h.onLanguage(id);
      setLanguage(id);
    });
    this.langButtons = seg.buttons;
    return seg.el;
  }

  /** "Show tips again": clears settings.seenTips (the coach re-arms every tip), confirmed on the button itself. */
  private buildTips(): HTMLElement {
    this.tipsBtn.setAttribute("aria-live", "polite");
    this.tipsBtn.addEventListener("click", () => {
      if (this.tipsBtn.disabled || this.tipsCleared) return;
      this.tipsCleared = true;
      this.change({ seenTips: [] });
      this.renderTips(settings.get());
    });
    return el("div", "rr-setting rr-setting--tips", this.tipsBtn);
  }

  private buildFooter(): HTMLElement {
    const resume = button("rr-btn rr-btn--primary rr-btn--big", `🏝️ ${t("overlays.resume")}`);
    resume.addEventListener("click", () => this.h.onClose());
    const reset = button("rr-link-btn", t("overlays.reset"));
    reset.addEventListener("click", () => {
      settings.reset();
      this.refresh(settings.get());
      this.h.onSettings({ ...settings.get() });
    });
    this.leaveBtn.addEventListener("click", () => this.showConfirm(true));
    const yes = button("rr-btn rr-btn--danger rr-btn--small", t("overlays.leaveYes"));
    const no = button("rr-btn rr-btn--small", t("overlays.leaveNo"));
    yes.addEventListener("click", () => {
      this.close();
      this.h.onLeave();
    });
    no.addEventListener("click", () => this.showConfirm(false));
    this.confirm.append(el("span", "rr-settings__confirm-text", t("overlays.leaveConfirm")), yes, no);
    this.confirm.setAttribute("role", "alertdialog");
    return el("footer", "rr-settings__foot", resume, el("div", "rr-settings__secondary", reset, this.leaveBtn, this.confirm));
  }

  /* ------------------------------------------------------------ behaviour */

  private renderQuality(s: Readonly<Settings>): void {
    markSelected(this.qualityButtons, s.autoQuality ? "auto" : s.quality);
    setText(this.qualityHint, s.autoQuality ? t("overlays.qualityHint_auto", { tier: t(`overlays.quality_${s.quality}`) }) : t(`overlays.qualityHint_${s.quality}`));
  }

  private renderTips(s: Readonly<Settings>): void {
    const done = this.tipsCleared && s.seenTips.length === 0;
    setText(this.tipsBtn, done ? `✓ ${t("overlays.tipsResetDone")}` : `💡 ${t("overlays.tipsReset")}`);
    // Nothing seen yet = nothing to replay. Just pressed: stays enabled (and focused) to say it worked.
    setDisabled(this.tipsBtn, !done && s.seenTips.length === 0);
  }

  private showConfirm(show: boolean): void {
    setHidden(this.confirm, !show);
    setHidden(this.leaveBtn, show || !this.inRoom);
    if (show) play(this.confirm, [{ transform: "scale(0.9)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 180, easing: "ease-out" });
  }

  private change(patch: Partial<Settings>): void {
    settings.set(patch);
    this.h.onSettings(patch);
  }

  private focusables(): HTMLElement[] {
    return [...this.panel.querySelectorAll<HTMLElement>("button, input")].filter((n) => !n.closest("[hidden]") && !(n as HTMLButtonElement).disabled);
  }

  /** Keep keyboard focus inside the dialog while it is open (a document listener: it also catches a lost focus). */
  private trapFocus(e: KeyboardEvent): void {
    const focusables = this.focusables();
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
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
