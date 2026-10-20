// HUD bottom left: 3 big cartoon hearts that crack and fall apart when lost. Owner: client-ui.

import { el, play, POP_KEYFRAMES, SHAKE_KEYFRAMES, svg } from "../dom";
import { ICON_HEART_EMPTY, ICON_HEART_FULL } from "../icons";

interface HeartView {
  root: HTMLElement;
  left: HTMLElement;
  right: HTMLElement;
}

const BREAK_MS = 650;

export class Hearts {
  readonly el = el("div", "hearts");
  private views: HeartView[] = [];
  private count = -1;

  update(hearts: number, max: number): void {
    if (max !== this.views.length) this.build(max);
    const next = Math.max(0, Math.min(max, hearts));
    if (next === this.count) return;
    const prev = this.count;
    this.count = next;
    this.el.setAttribute("aria-label", `${next} of ${max} hearts`);
    if (prev < 0) return this.views.forEach((v, i) => this.setFull(v, i < next));
    if (next < prev) this.lose(prev, next);
    else this.gain(prev, next);
  }

  private build(max: number): void {
    this.views = Array.from({ length: max }, () => {
      const left = el("div", "heart__half heart__half--l", svg(ICON_HEART_FULL));
      const right = el("div", "heart__half heart__half--r", svg(ICON_HEART_FULL));
      const root = el("div", "heart", svg(ICON_HEART_EMPTY), left, right);
      return { root, left, right };
    });
    this.el.replaceChildren(...this.views.map((v) => v.root));
    this.el.setAttribute("role", "img");
    this.count = -1;
  }

  private setFull(v: HeartView, full: boolean): void {
    v.root.classList.toggle("is-full", full);
    v.root.classList.toggle("is-empty", !full);
  }

  private lose(prev: number, next: number): void {
    for (let i = next; i < prev; i++) this.breakHeart(this.views[i]);
    play(this.el, SHAKE_KEYFRAMES, { duration: 380 });
  }

  private gain(prev: number, next: number): void {
    for (let i = prev; i < next; i++) {
      const v = this.views[i];
      v.left.getAnimations().forEach((a) => a.cancel());
      v.right.getAnimations().forEach((a) => a.cancel());
      this.setFull(v, true);
      play(v.root, POP_KEYFRAMES, { duration: 420, delay: (i - prev) * 90, easing: "ease-out", fill: "backwards" });
    }
  }

  /** The two halves split along the crack, spin away and fade; the empty outline stays. */
  private breakHeart(v: HeartView): void {
    v.root.classList.add("is-breaking");
    const half = (dir: number): Keyframe[] => [
      { transform: "translate(0,0) rotate(0)", opacity: 1 },
      { transform: `translate(${dir * 6}px,-6px) rotate(${dir * 12}deg)`, opacity: 1, offset: 0.25 },
      { transform: `translate(${dir * 22}px,40px) rotate(${dir * 50}deg)`, opacity: 0 },
    ];
    play(v.root, [{ transform: "scale(1.25)" }, { transform: "scale(1)" }], { duration: 200, easing: "ease-out" });
    play(v.left, half(-1), { duration: BREAK_MS, easing: "cubic-bezier(.4,0,.8,.6)", fill: "forwards" });
    const anim = play(v.right, half(1), { duration: BREAK_MS, easing: "cubic-bezier(.4,0,.8,.6)", fill: "forwards" });
    const finish = () => {
      v.root.classList.remove("is-breaking");
      // A refill meanwhile cancels these animations, so finishing means the heart is really gone.
      if (this.views.indexOf(v) >= this.count) this.setFull(v, false);
      v.left.getAnimations().forEach((a) => a.cancel());
      v.right.getAnimations().forEach((a) => a.cancel());
    };
    if (anim) anim.onfinish = finish;
    else finish();
  }
}
