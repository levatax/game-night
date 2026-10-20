// Esc settings body: camera (view, mouse lock, field of view, sensitivity), sound, picture + accessibility, the
// key list, "Devam" / "Masadan kalk". Every control registers its own sync so each setting is shown in its own
// unit (58°, %80, 1,5×) instead of one generic value×100 rule. Mid-match "Masadan kalk" asks once more.

import { settings, type Quality, type Settings, type ViewMode } from "../../app/settings";
import type { UiSound } from "../../app/ui";
import { btn, h, kbd } from "./dom";

export interface SettingsCallbacks {
  onClose(): void;
  onLeave(): void;
  sound(kind: UiSound): void;
  /** Leaving now hands my seat to a bot (seated in a running match). */
  inMatch(): boolean;
}

type NumKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

const VIEWS: readonly [ViewMode, string, string][] = [
  ["fp", "🪑 Birinci şahıs", "koltuğun"],
  ["masa", "🎲 Masa", "üstten"],
];
const QUALITIES: readonly [Quality, string][] = [
  ["auto", "Otomatik"],
  ["low", "Düşük"],
  ["medium", "Orta"],
  ["high", "Yüksek"],
];
const KEYS: readonly [string, string][] = [
  ["Space", "Kart çevir"],
  ["Enter", "KASALA!"],
  ["1–4", "Bahis kutusu"],
  ["0", "Pas"],
  ["Q W E", "Fiş"],
  ["Z / X", "“Çevir!” / “Kasala!” diye bağır"],
  ["← →", "Hedef seç"],
  ["B", "Borç masası"],
  ["K / R", "Teklife kabul / ret"],
  ["T + 1–6", "Emote"],
  ["Y + 1–8", "Laf sok"],
  ["Tab", "Skor tablosu"],
  ["V", "Görünüm"],
  ["H", "Tuşları göster (basılı tut)"],
];

const times = (n: number) => `${n.toLocaleString("tr-TR", { maximumFractionDigits: 1 })}×`;

export class SettingsPanel {
  private readonly cb: SettingsCallbacks;
  private readonly syncers: (() => void)[] = [];
  private readonly leaveBtn: HTMLButtonElement;
  private leaveArmed = 0;

  constructor(body: HTMLElement, cb: SettingsCallbacks) {
    this.cb = cb;

    const camera = this.group("🎥 Kamera");
    camera.append(
      this.viewChoice(),
      this.check("mouseLock", "Fareyi kilitle (nişangâh)", "Masaya tıklayınca imleç kilitlenir, Esc bırakır."),
      this.range("fov", "Görüş açısı", 50, 75, 1, (n) => `${Math.round(n)}°`),
      this.range("cameraSensitivity", "Kamera hassasiyeti", 20, 300, 10, times, 100),
      h("p", "ks-ov-help", "Sürükle: etrafa bak · V: görünüm · H: tuşlar"),
    );

    const sound = this.group("🔊 Ses");
    sound.append(
      this.range("masterVolume", "Ana ses", 0, 100, 1, (n) => `%${Math.round(n * 100)}`, 100),
      this.range("musicVolume", "Müzik", 0, 100, 1, (n) => `%${Math.round(n * 100)}`, 100),
      this.range("sfxVolume", "Efekt", 0, 100, 1, (n) => `%${Math.round(n * 100)}`, 100),
      this.range("announcerVolume", "Cemil Abi (spiker)", 0, 100, 1, (n) => `%${Math.round(n * 100)}`, 100),
    );

    const look = this.group("👁️ Görüntü ve erişilebilirlik");
    look.append(
      this.quality(),
      this.check("subtitles", "Altyazı"),
      this.check("speechFallback", "Kayıt yoksa tarayıcı sesi okusun"),
      this.check("reducedFlashing", "Azaltılmış yanıp sönme", "Siren, flaş ve sarsıntılar yumuşar."),
    );

    const keys = h("details", "ks-ov-keys");
    const list = h("ul", "ks-ov-keylist");
    for (const [key, label] of KEYS) {
      const li = h("li");
      li.append(kbd(key), h("span", "", label));
      list.appendChild(li);
    }
    keys.append(h("summary", "", "⌨️ Tüm tuşlar"), list);
    keys.addEventListener("toggle", () => cb.sound(keys.open ? "open" : "close"));

    const actions = h("div", "ks-ov-actions");
    this.leaveBtn = btn("🚪 Masadan kalk", () => this.leave(), "red");
    actions.append(btn("Devam", () => cb.onClose(), "green"), this.leaveBtn);

    body.append(camera, sound, look, keys, actions);
    settings.onChange(() => this.syncers.forEach((fn) => fn()));
  }

  /** Called whenever the panel opens. */
  sync(): void {
    this.disarm();
    this.syncers.forEach((fn) => fn());
  }

  // ------------------------------------------------------------------ controls
  private group(legend: string): HTMLFieldSetElement {
    const f = h("fieldset");
    f.appendChild(h("legend", "", legend));
    return f;
  }

  /** Two big radio buttons: first person from my chair, or the classic camera over the table. */
  private viewChoice(): HTMLElement {
    const field = h("div", "ks-ov-field");
    const id = "ks-ov-view-label";
    const caption = h("span", "ks-ov-field__label", "Kamera görünümü");
    caption.id = id;
    field.appendChild(caption);
    const group = h("div", "ks-ov-seg");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-labelledby", id);
    const buttons = VIEWS.map(([mode, label, sub]) => {
      const b = btn(label, () => {
        if (settings.get().view === mode) return;
        settings.set({ view: mode });
        this.cb.sound("click");
      }, undefined, "ks-ov-seg__btn");
      b.setAttribute("role", "radio");
      b.appendChild(h("small", "", ` (${sub})`));
      group.appendChild(b);
      return b;
    });
    group.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      const cur = VIEWS.findIndex(([m]) => m === settings.get().view);
      const next = (cur + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? VIEWS.length - 1 : 1)) % VIEWS.length;
      settings.set({ view: VIEWS[next]![0] });
      buttons[next]!.focus();
      this.cb.sound("click");
    });
    this.syncers.push(() => {
      const view = settings.get().view;
      buttons.forEach((b, i) => {
        const on = VIEWS[i]![0] === view;
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
      });
    });
    field.appendChild(group);
    return field;
  }

  /** A slider shown in its own unit. `scale` maps the setting to the slider's integer steps (0.55 → 55). */
  private range(key: NumKey, label: string, min: number, max: number, step: number, format: (n: number) => string, scale = 1): HTMLElement {
    const field = h("label", "ks-ov-field ks-ov-field--range");
    const value = h("strong", "ks-ov-field__value");
    const input = h("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.addEventListener("input", () => {
      const n = Number(input.value) / scale;
      value.textContent = format(n);
      settings.set({ [key]: n } as Partial<Settings>);
    });
    field.append(h("span", "ks-ov-field__label", label), value, input);
    this.syncers.push(() => {
      const n = settings.get()[key];
      const v = String(Math.round(n * scale));
      if (input.value !== v) input.value = v;
      value.textContent = format(n);
    });
    return field;
  }

  private check(key: BoolKey, label: string, hint?: string): HTMLElement {
    const field = h("label", "ks-ov-field ks-ov-field--check");
    const input = h("input");
    input.type = "checkbox";
    input.addEventListener("change", () => {
      settings.set({ [key]: input.checked } as Partial<Settings>);
      this.cb.sound("click");
    });
    const text = h("span", "ks-ov-field__text", label);
    if (hint) text.appendChild(h("small", "", hint));
    field.append(input, text);
    this.syncers.push(() => {
      const on = settings.get()[key];
      if (input.checked !== on) input.checked = on;
    });
    return field;
  }

  private quality(): HTMLElement {
    const field = h("label", "ks-ov-field");
    const select = h("select");
    for (const [id, label] of QUALITIES) {
      const option = h("option", "", label);
      option.value = id;
      select.appendChild(option);
    }
    select.addEventListener("change", () => settings.set({ quality: select.value as Quality }));
    const caption = h("span", "ks-ov-field__label", "Grafik kalitesi");
    field.append(caption, select, h("small", "", "Otomatik: kare hızı düşerse çözünürlüğü kendisi ayarlar."));
    this.syncers.push(() => {
      if (select.value !== settings.get().quality) select.value = settings.get().quality;
    });
    return field;
  }

  // ------------------------------------------------------------------ leave
  /** Mid-match the first click only arms the button: leaving hands the seat to a bot for the rest of the match. */
  private leave(): void {
    if (this.cb.inMatch() && !this.leaveArmed) {
      this.leaveArmed = window.setTimeout(() => this.disarm(), 4000);
      this.leaveBtn.textContent = "Emin misin? Yerine bot geçer";
      this.leaveBtn.dataset.armed = "true";
      this.cb.sound("deny");
      return;
    }
    this.disarm();
    this.cb.onLeave();
  }

  private disarm(): void {
    if (!this.leaveArmed) return;
    window.clearTimeout(this.leaveArmed);
    this.leaveArmed = 0;
    this.leaveBtn.textContent = "🚪 Masadan kalk";
    delete this.leaveBtn.dataset.armed;
  }
}
