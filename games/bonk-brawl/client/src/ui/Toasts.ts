// Toasts and errors. Owner: client-ui.

import { button, el, play } from "./dom";
import type { ToastKind } from "./models";

const MAX_TOASTS = 3;
const DURATION_MS = 3500;
const ERROR_DURATION_MS = 6000;
const LEAVE_MS = 220;

const ICON: Record<ToastKind, string> = { info: "💬", success: "🎉", warning: "⚠️", error: "💥" };

interface ToastView {
  node: HTMLButtonElement;
  timer: number;
  text: string;
  kind: ToastKind;
}

/** Stack at the bottom/top center, max 3, auto-dismiss after 3.5 s (errors 6 s), click to dismiss. */
export class Toasts {
  readonly el: HTMLElement = document.createElement("div");

  private readonly views: ToastView[] = [];

  constructor() {
    this.el.className = "toasts";
    this.el.setAttribute("aria-live", "polite");
    this.el.setAttribute("aria-relevant", "additions");
  }

  show(text: string, kind: ToastKind = "info"): void {
    const duplicate = this.views.find((v) => v.text === text && v.kind === kind);
    if (duplicate) return this.refresh(duplicate);

    const node = button(`toast toast--${kind}`, el("span", "toast__icon", ICON[kind]), el("span", "toast__text", text));
    node.title = "Dismiss";
    node.setAttribute("role", kind === "error" ? "alert" : "status");
    const view: ToastView = { node, timer: 0, text, kind };
    node.addEventListener("click", () => this.dismiss(view));
    this.el.append(node);
    this.views.push(view);
    this.schedule(view);
    play(node, [{ transform: "translateY(-16px) scale(0.85)", opacity: 0 }, { transform: "translateY(2px) scale(1.03)", opacity: 1, offset: 0.7 }, { transform: "none", opacity: 1 }], {
      duration: 300,
      easing: "ease-out",
    });
    while (this.views.length > MAX_TOASTS) this.remove(this.views[0]);
  }

  private schedule(view: ToastView): void {
    window.clearTimeout(view.timer);
    view.timer = window.setTimeout(() => this.dismiss(view), view.kind === "error" ? ERROR_DURATION_MS : DURATION_MS);
  }

  /** Same message again: restart its timer and wiggle instead of stacking a copy. */
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
