// HUD center: big 3-2-1-BONK! countdown. Owner: client-ui.

import { el, play, setOutlinedText } from "../dom";

/** Each number stays up at least this long, so a one-frame "0" still reads as BONK!. */
const MIN_SHOW_MS = 850;

export class Countdown {
  readonly el = el("div", "countdown");

  private readonly text = el("span", "countdown__text outlined");
  private value: number | null = null;
  private shownAt = 0;
  private hideTimer = 0;

  constructor() {
    this.el.append(this.text);
    this.el.hidden = true;
    this.el.setAttribute("aria-live", "assertive");
  }

  update(value: number | null): void {
    if (value === this.value) return;
    this.value = value;
    if (value === null) return this.scheduleHide();
    window.clearTimeout(this.hideTimer);
    this.show(value);
  }

  private show(value: number): void {
    const go = value <= 0;
    setOutlinedText(this.text, go ? "BONK!" : String(value));
    this.el.classList.toggle("is-go", go);
    this.el.classList.remove("is-leaving");
    this.el.hidden = false;
    this.shownAt = performance.now();
    const keyframes: Keyframe[] = go
      ? [{ transform: "scale(0.2) rotate(-20deg)" }, { transform: "scale(1.35) rotate(6deg)", offset: 0.55 }, { transform: "scale(1) rotate(-4deg)" }]
      : [{ transform: "scale(2.4)", opacity: 0 }, { transform: "scale(0.9)", opacity: 1, offset: 0.6 }, { transform: "scale(1)", opacity: 1 }];
    play(this.text, keyframes, { duration: go ? 480 : 360, easing: "cubic-bezier(.3,1.4,.5,1)" });
  }

  private scheduleHide(): void {
    const wait = Math.max(0, this.shownAt + MIN_SHOW_MS - performance.now());
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (this.value !== null) return;
      this.el.classList.add("is-leaving");
      const anim = play(this.text, [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(1.6)", opacity: 0 }], { duration: 260, easing: "ease-in", fill: "forwards" });
      const done = () => {
        if (this.value === null) this.el.hidden = true;
        anim?.cancel();
      };
      if (anim) anim.onfinish = done;
      else done();
    }, wait);
  }
}
