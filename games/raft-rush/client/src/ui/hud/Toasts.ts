// Short toasts (connection + server notices, "Link copied!"): max 3 stacked, auto-dismiss after 3.5 s (bad: 6 s),
// click to dismiss, a repeat refreshes instead of stacking. Copied + adapted from
// games/bonk-brawl/client/src/ui/Toasts.ts. Owner: client-ui.

import { button, el, play } from "../dom";

export type ToastTone = "info" | "good" | "bad" | "warn";

const MAX_TOASTS = 3;
const DURATION_MS = 3500;
const BAD_DURATION_MS = 6000;
const LEAVE_MS = 220;

interface ToastView {
  node: HTMLButtonElement;
  timer: number;
  text: string;
  tone: ToastTone;
}

export class Toasts {
  readonly el = el("div", "rr-toasts");
  private readonly views: ToastView[] = [];

  constructor() {
    this.el.setAttribute("aria-live", "polite");
    this.el.setAttribute("aria-relevant", "additions");
  }

  show(text: string, tone: ToastTone = "info"): void {
    if (!text) return;
    const duplicate = this.views.find((v) => v.text === text && v.tone === tone);
    if (duplicate) return this.refresh(duplicate);
    const node = button(`rr-toast rr-tone--${tone}`, el("span", "rr-toast__text", text));
    node.setAttribute("role", tone === "bad" ? "alert" : "status");
    node.tabIndex = -1;
    const view: ToastView = { node, timer: 0, text, tone };
    node.addEventListener("click", () => this.dismiss(view));
    this.el.append(node);
    this.views.push(view);
    this.schedule(view);
    play(node, [{ transform: "translateY(-16px) scale(0.85)", opacity: 0 }, { transform: "translateY(2px) scale(1.03)", opacity: 1, offset: 0.7 }, { transform: "none", opacity: 1 }], {
      duration: 300,
      easing: "ease-out",
    });
    while (this.views.length > MAX_TOASTS) this.remove(this.views[0]!);
  }

  clear(): void {
    for (const v of [...this.views]) this.remove(v);
  }

  private schedule(view: ToastView): void {
    window.clearTimeout(view.timer);
    view.timer = window.setTimeout(() => this.dismiss(view), view.tone === "bad" ? BAD_DURATION_MS : DURATION_MS);
  }

  private refresh(view: ToastView): void {
    this.schedule(view);
    play(view.node, [{ transform: "scale(1)" }, { transform: "scale(1.08)" }, { transform: "scale(1)" }], { duration: 240 });
  }

  private dismiss(view: ToastView): void {
    if (!this.views.includes(view) || view.node.classList.contains("is-leaving")) return;
    window.clearTimeout(view.timer);
    view.node.classList.add("is-leaving");
    const anim = play(view.node, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-10px) scale(0.92)" }], {
      duration: LEAVE_MS,
      easing: "ease-in",
      fill: "forwards",
    });
    if (anim) anim.onfinish = () => this.remove(view);
    else this.remove(view);
  }

  private remove(view: ToastView): void {
    window.clearTimeout(view.timer);
    const i = this.views.indexOf(view);
    if (i >= 0) this.views.splice(i, 1);
    view.node.remove();
  }
}
