// Small full-screen overlays: connecting / reconnecting, click-to-play, and the center banner.
// Owner: client-ui.

import type { Emitter } from "../util/Emitter";
import { button, el, play, setHidden, setOutlinedText, setText, svg } from "./dom";
import { ICON_BALL, ICON_MOUSE } from "./icons";
import type { UiEventMap } from "./models";

/** A connect that takes longer than this offers a way out. */
const CANCEL_AFTER_MS = 8000;
const BANNER_MS = 1500;

/** "connecting" screen: bouncing ball + status text. Translucent so a frozen game shows behind it. */
export class ConnectingScreen {
  readonly el = el("section", "screen screen--connecting");

  private readonly text = el("p", "connecting__text");
  private readonly cancel = button("btn btn--small connecting__cancel", "Cancel");
  private cancelTimer = 0;

  constructor(events: Emitter<UiEventMap>) {
    this.el.setAttribute("aria-label", "Connecting");
    this.el.setAttribute("aria-busy", "true");
    this.text.setAttribute("role", "status");
    const spinner = el("div", "bouncer", el("span", "bouncer__ball", svg(ICON_BALL)), el("span", "bouncer__shadow"));
    this.cancel.addEventListener("click", () => events.emit("leaveRoom", undefined));
    this.el.append(el("div", "panel connecting__card", spinner, this.text, this.cancel));
    this.setText("Connecting…");
  }

  setText(text: string): void {
    setText(this.text, text);
  }

  /** Restart the "Cancel" reveal each time the screen is shown. */
  onShow(): void {
    window.clearTimeout(this.cancelTimer);
    setHidden(this.cancel, true);
    this.cancelTimer = window.setTimeout(() => {
      setHidden(this.cancel, false);
      play(this.cancel, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 240 });
    }, CANCEL_AFTER_MS);
  }

  onHide(): void {
    window.clearTimeout(this.cancelTimer);
  }
}

/** "Click to play" over the game while the pointer isn't locked. The click is the pointer-lock gesture. */
export class ClickToPlay {
  readonly el = button("click-to-play");

  private visible = false;

  constructor(events: Emitter<UiEventMap>) {
    this.el.hidden = true;
    this.el.dataset.hover = "off";
    this.el.setAttribute("aria-label", "Click to play");
    const card = el(
      "span",
      "click-to-play__card",
      el("span", "click-to-play__icon", svg(ICON_MOUSE)),
      el("span", "click-to-play__title", "Click to play"),
      el("span", "click-to-play__hint", el("kbd", "", "Esc"), " opens the menu"),
    );
    this.el.append(card);
    this.el.addEventListener("click", () => events.emit("resume", undefined));
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    setHidden(this.el, !visible);
    if (visible) play(this.el, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
  }
}

/** Short centered banner ("ROUND 3", "SUDDEN DEATH!"). A new banner replaces the current one. */
export class Banner {
  readonly el = el("div", "banner-layer");

  private current: HTMLElement | null = null;
  private timer = 0;

  constructor() {
    this.el.setAttribute("aria-live", "assertive");
  }

  show(text: string, style: "info" | "danger" | "success"): void {
    window.clearTimeout(this.timer);
    this.current?.remove();
    const label = el("span", "banner__text outlined");
    setOutlinedText(label, text);
    const node = el("div", `banner banner--${style}`, el("span", "banner__stripe"), label);
    this.el.append(node);
    this.current = node;
    play(node, [
      { transform: "scale(2.2) rotate(-6deg)", opacity: 0 },
      { transform: "scale(0.92) rotate(-2deg)", opacity: 1, offset: 0.55 },
      { transform: "scale(1) rotate(-2deg)", opacity: 1 },
    ], { duration: 380, easing: "cubic-bezier(.3,1.3,.5,1)" });
    this.timer = window.setTimeout(() => this.leave(node), BANNER_MS);
  }

  clear(): void {
    window.clearTimeout(this.timer);
    this.current?.remove();
    this.current = null;
  }

  private leave(node: HTMLElement): void {
    const anim = play(node, [{ transform: "scale(1) rotate(-2deg)", opacity: 1 }, { transform: "scale(1.15) rotate(-2deg) translateY(-20px)", opacity: 0 }], {
      duration: 260,
      easing: "ease-in",
      fill: "forwards",
    });
    const done = () => {
      node.remove();
      if (this.current === node) this.current = null;
    };
    if (anim) anim.onfinish = done;
    else done();
  }
}
