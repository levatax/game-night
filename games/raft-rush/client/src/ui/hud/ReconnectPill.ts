// Persistent "Reconnecting… (attempt n)" pill for the whole automatic reconnect window (Net retries the ticket for
// up to RECONNECT_GRACE_SEC while the world stays frozen): top-center over every screen, a polite live region, gone
// on reconnect or on the final drop to Home. Mounted by Ui (setReconnecting). Owner: client-net-app (gap N1).

import { RECONNECT_GRACE_SEC } from "../../../../shared/constants";
import { t } from "../../i18n";
import { el, play, setHidden, setText } from "../dom";

export class ReconnectPill {
  readonly el = el("div", "rr-reconnect");
  private readonly text = el("span", "rr-reconnect__text");
  private readonly hint = el("span", "rr-reconnect__hint");
  private attempt: number | null = null;

  constructor() {
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-live", "polite");
    this.el.hidden = true;
    const dot = el("span", "rr-reconnect__dot");
    dot.setAttribute("aria-hidden", "true");
    setText(this.hint, t("hud.reconnectingHint", { sec: RECONNECT_GRACE_SEC }));
    this.el.append(dot, el("span", "rr-reconnect__lines", this.text, this.hint));
  }

  /** The attempt Net is on (1, 2, …), or null when not reconnecting. */
  set(attempt: number | null): void {
    const next = attempt !== null && Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : null;
    if (next === this.attempt) return;
    const appearing = this.attempt === null && next !== null;
    this.attempt = next;
    setHidden(this.el, next === null);
    if (next === null) return;
    setText(this.text, t("hud.reconnecting", { n: next }));
    if (appearing) play(this.el, [{ opacity: 0, transform: "translate(-50%, -8px)" }, { opacity: 1, transform: "translate(-50%, 0)" }], { duration: 220, easing: "ease-out" });
  }
}
