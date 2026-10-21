// "The graphics were reset" card, shown while the WebGL context is lost (GPU reset, driver update, a long time in
// the background): the canvas can't draw, so it covers everything and offers a one-click reload (the reconnect
// ticket rejoins the room). It hides by itself when the browser restores the context and the renderer rebuilt.
// Mounted by Ui (setGraphicsLost). Owner: client-net-app (gap N4).

import { t } from "../../i18n";
import { button, el, play, setHidden } from "../dom";

export class ContextLostCard {
  readonly el = el("div", "rr-gpu-lost");
  private readonly reload = button("rr-btn rr-btn--primary rr-btn--big rr-gpu-lost__reload", `🔄 ${t("hud.gpuLostReload")}`);
  private visible = false;

  constructor() {
    this.el.hidden = true;
    const title = el("h2", "rr-gpu-lost__title", t("hud.gpuLostTitle"));
    title.id = "rr-gpu-lost-title";
    const card = el("div", "rr-panel rr-gpu-lost__card", el("div", "rr-gpu-lost__icon", "🖥️"), title, el("p", "rr-gpu-lost__text", t("hud.gpuLostText")), this.reload);
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-labelledby", title.id);
    this.reload.addEventListener("click", () => window.location.reload());
    this.el.append(card);
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    setHidden(this.el, !visible);
    if (!visible) {
      if (document.activeElement === this.reload) this.reload.blur();
      return;
    }
    play(this.el, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
    // Enter / Space reloads right away (the pointer lock was released by the app).
    this.reload.focus({ preventScroll: true });
  }
}
