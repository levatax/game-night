// "connecting" screen: a bobbing raft on little waves, the status text ("Paddling to the island…" by default,
// Ui.setConnecting() overrides it, e.g. while reconnecting), a rotating tip, and a Cancel button (emits `leave`)
// that appears when connecting takes a while. Adapted from games/bonk-brawl/client/src/ui/Overlays.ts.
// Owner: client-ui.

import { t } from "../../i18n";
import type { Emitter } from "../../util/Emitter";
import { button, el, pickVariant, play, setHidden, setText, svg } from "../dom";
import { ICON_RAFT } from "../icons";
import type { UiEventMap } from "../models";

/** A connect that takes longer than this offers a way out. */
const CANCEL_AFTER_MS = 8000;
const TIP_EVERY_MS = 3500;

export class ConnectingScreen {
  readonly el = el("section", "rr-screen rr-screen--connecting");
  private readonly text = el("p", "rr-connecting__text");
  private readonly tip = el("p", "rr-connecting__tip");
  private readonly cancel = button("rr-btn rr-btn--small rr-connecting__cancel", t("menu.cancel"));
  private cancelTimer = 0;
  private tipTimer = 0;
  private tipIndex = Math.floor(Math.random() * 5);

  constructor(events: Emitter<UiEventMap>) {
    this.el.setAttribute("aria-busy", "true");
    this.text.setAttribute("role", "status");
    const bob = el("div", "rr-bobber", el("span", "rr-bobber__raft", svg(ICON_RAFT)), el("span", "rr-bobber__waves"));
    this.cancel.addEventListener("click", () => events.emit("leave", undefined));
    this.el.append(el("div", "rr-panel rr-connecting__card", bob, this.text, this.tip, this.cancel));
    this.setText("");
  }

  /** Status text ("" = the default "Paddling to the island…"). */
  setText(text: string): void {
    setText(this.text, text || t("menu.connecting"));
  }

  onShow(): void {
    window.clearTimeout(this.cancelTimer);
    window.clearInterval(this.tipTimer);
    setHidden(this.cancel, true);
    this.showTip();
    this.tipTimer = window.setInterval(() => this.showTip(), TIP_EVERY_MS);
    this.cancelTimer = window.setTimeout(() => {
      setHidden(this.cancel, false);
      play(this.cancel, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 240 });
    }, CANCEL_AFTER_MS);
  }

  onHide(): void {
    window.clearTimeout(this.cancelTimer);
    window.clearInterval(this.tipTimer);
  }

  private showTip(): void {
    setText(this.tip, pickVariant(t("menu.connectTips"), this.tipIndex++));
  }
}
