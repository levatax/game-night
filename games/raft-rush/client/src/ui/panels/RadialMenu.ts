// Shared radial picker for the ping wheel and the emote wheel: N chunky buttons on a ring around a hub, the slice
// under the mouse lights up (by angle from the center, so a flick toward a slice is enough), number keys pick,
// and releasing the opening key / middle button over a lit slice picks it (hold-release), while a quick tap leaves
// the wheel open for a click. The slice key badges and the hint follow the key preset (1–6, or 7 8 9 0 - =
// left-handed; the plain digits work in both). Owner: client-ui.

import { t } from "../../i18n";
import { keyParams, wheelKey } from "../controls";
import { button, el, play, setText, toggleClass } from "../dom";

export interface RadialOption<T extends string> {
  id: T;
  icon: string;
  label: string;
  color: string;
  /** Small ribbon under the label ("Influencer special"). */
  tag?: string;
}

/** Hold-release only counts after the wheel has been open this long (a tap opens it for clicking). */
const HOLD_PICK_MS = 220;
/** Mouse within this radius (px) of the hub = no slice lit. */
const DEAD_ZONE = 28;

export class RadialMenu<T extends string> {
  readonly el: HTMLElement;
  private readonly ring = el("div", "rr-radial__ring");
  private readonly hubLabel = el("span", "rr-radial__hub-label");
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly keys: HTMLElement[] = [];
  private readonly hint = el("p", "rr-radial__hint");
  private hovered = -1;
  private openedAt = 0;

  /** `hintKey`: i18n key of the hint line (may use the ui/controls.ts {k…} key placeholders). */
  constructor(
    className: string,
    private readonly title: string,
    private readonly hintKey: string,
    private readonly options: ReadonlyArray<RadialOption<T>>,
    private readonly onPick: (id: T) => void,
    onClose: () => void,
  ) {
    this.el = el("div", `rr-radial ${className}`);
    this.el.hidden = true;
    this.el.setAttribute("role", "menu");
    this.el.setAttribute("aria-label", title);
    const n = options.length;
    options.forEach((o, i) => {
      // Slice 0 at the top, clockwise.
      const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const key = el("span", "rr-radial__key", String(i + 1));
      this.keys.push(key);
      const b = button(
        "rr-radial__opt",
        key,
        el("span", "rr-radial__icon", o.icon),
        el("span", "rr-radial__label", o.label),
        o.tag ? el("span", "rr-radial__tag", o.tag) : null,
      );
      b.setAttribute("role", "menuitem");
      b.style.setProperty("--x", Math.cos(ang).toFixed(4));
      b.style.setProperty("--y", Math.sin(ang).toFixed(4));
      b.style.setProperty("--c", o.color);
      b.tabIndex = -1;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pick(i);
      });
      b.addEventListener("pointerenter", () => this.setHovered(i));
      this.buttons.push(b);
      this.ring.append(b);
    });
    const hub = el("div", "rr-radial__hub", this.hubLabel);
    setText(this.hubLabel, title);
    this.ring.append(hub);
    this.el.append(this.ring, this.hint);
    this.el.addEventListener("pointermove", (e) => this.onMove(e));
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) onClose();
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(): void {
    this.el.hidden = false;
    this.openedAt = performance.now();
    this.setHovered(-1);
    this.keys.forEach((k, i) => setText(k, wheelKey(i)));
    setText(this.hint, t(this.hintKey, keyParams()));
    play(this.ring, [{ transform: "scale(0.4) rotate(-30deg)", opacity: 0 }, { transform: "scale(1.05)", opacity: 1, offset: 0.7 }, { transform: "none", opacity: 1 }], {
      duration: 240,
      easing: "ease-out",
    });
  }

  close(): void {
    this.el.hidden = true;
    this.setHovered(-1);
  }

  /** Number key 1..N. */
  pickIndex(n: number): boolean {
    if (n < 1 || n > this.options.length) return false;
    this.pick(n - 1);
    return true;
  }

  /** The opening key / button was released: pick the lit slice if the wheel was held long enough. */
  release(): boolean {
    if (performance.now() - this.openedAt < HOLD_PICK_MS || this.hovered < 0) return false;
    this.pick(this.hovered);
    return true;
  }

  private pick(i: number): void {
    const o = this.options[i];
    if (!o) return;
    const b = this.buttons[i];
    // Buttons are placed with the individual `translate` property, so animating `transform` doesn't move them.
    if (b) play(b, [{ transform: "scale(1)" }, { transform: "scale(1.25)" }, { transform: "scale(1)" }], { duration: 200 });
    this.onPick(o.id);
  }

  private onMove(e: PointerEvent): void {
    const r = this.ring.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < DEAD_ZONE) return this.setHovered(-1);
    const n = this.options.length;
    let a = Math.atan2(dy, dx) + Math.PI / 2; // 0 = up, clockwise
    if (a < 0) a += Math.PI * 2;
    this.setHovered(Math.round((a / (Math.PI * 2)) * n) % n);
  }

  private setHovered(i: number): void {
    if (i === this.hovered) return;
    this.hovered = i;
    this.buttons.forEach((b, k) => toggleClass(b, "is-hover", k === i));
    setText(this.hubLabel, i >= 0 ? (this.options[i]?.label ?? this.title) : this.title);
  }
}
