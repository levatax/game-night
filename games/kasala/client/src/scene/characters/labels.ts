// Floating DOM labels over the gangsters: "name · kasa$", status icons, the target preview while I pick a
// target (what that rival would lose) and the taunt speech bubble. Positioned with translate3d only (no
// layout), text written only when it changes, shown/hidden with a class. The layer sits under the HUD.
// Owner: client-characters.

export type PreviewTone = "bad" | "good" | "info";

export class Label {
  readonly el: HTMLDivElement;
  readonly bubble: HTMLDivElement;
  private nameEl: HTMLSpanElement;
  private kasaEl: HTMLSpanElement;
  private iconsEl: HTMLSpanElement;
  private previewEl: HTMLSpanElement;
  private text = { name: "", kasa: "", icons: "", preview: "", tone: "", bubble: "" };
  private classes = new Map<string, boolean>();
  private shownNow = false;
  private color = "";
  private x = NaN;
  private y = NaN;

  constructor(layer: HTMLElement, color: string) {
    const el = document.createElement("div");
    el.className = "ks-char-label ks-char-label--hidden";
    el.style.setProperty("--player-color", color);
    this.color = color;
    const pill = document.createElement("div");
    pill.className = "ks-char-label__pill";
    this.nameEl = document.createElement("span");
    this.nameEl.className = "ks-char-label__name";
    this.kasaEl = document.createElement("span");
    this.kasaEl.className = "ks-char-label__kasa";
    this.iconsEl = document.createElement("span");
    this.iconsEl.className = "ks-char-label__icons";
    pill.append(this.nameEl, this.kasaEl, this.iconsEl);
    this.previewEl = document.createElement("span");
    this.previewEl.className = "ks-char-label__preview";
    this.bubble = document.createElement("div");
    this.bubble.className = "ks-char-bubble";
    el.append(this.bubble, pill, this.previewEl);
    layer.appendChild(el);
    this.el = el;
  }

  setColor(color: string): void {
    if (color === this.color) return;
    this.color = color;
    this.el.style.setProperty("--player-color", color);
  }

  setName(name: string): void {
    if (name === this.text.name) return;
    this.text.name = name;
    this.nameEl.textContent = name;
  }

  setKasa(kasa: string): void {
    if (kasa === this.text.kasa) return;
    this.text.kasa = kasa;
    this.kasaEl.textContent = kasa;
    this.flag("ks-char-label--nokasa", kasa === "");
  }

  setIcons(icons: string): void {
    if (icons === this.text.icons) return;
    this.text.icons = icons;
    this.iconsEl.textContent = icons;
    this.flag("ks-char-label--noicons", icons === "");
  }

  /** Target preview ("−40$"), "" hides it. */
  setPreview(text: string, tone: PreviewTone = "bad"): void {
    if (text !== this.text.preview) {
      this.text.preview = text;
      this.previewEl.textContent = text;
      this.flag("ks-char-label--preview", text !== "");
    }
    if (tone !== this.text.tone) {
      if (this.text.tone) this.previewEl.classList.remove(`ks-char-label__preview--${this.text.tone}`);
      this.text.tone = tone;
      this.previewEl.classList.add(`ks-char-label__preview--${tone}`);
    }
  }

  setBubble(text: string): void {
    if (text !== this.text.bubble) {
      this.text.bubble = text;
      if (text) this.bubble.textContent = text;
    }
    this.flag("ks-char-label--talk", text !== "");
  }

  /** Toggle a modifier class only when it changes (no style invalidation otherwise). */
  flag(name: string, on: boolean): void {
    if (this.classes.get(name) === on) return;
    this.classes.set(name, on);
    this.el.classList.toggle(name, on);
  }

  show(on: boolean): void {
    if (on === this.shownNow) return;
    this.shownNow = on;
    this.el.classList.toggle("ks-char-label--hidden", !on);
  }

  get shown(): boolean {
    return this.shownNow;
  }

  /** Screen position (layer px) of the label's bottom center. */
  place(x: number, y: number): void {
    if (Math.abs(x - this.x) < 0.3 && Math.abs(y - this.y) < 0.3) return;
    this.x = x;
    this.y = y;
    this.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-100%)`;
  }

  remove(): void {
    this.el.remove();
  }
}
