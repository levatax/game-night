// "Click to play" veil over the game while the pointer isn't locked (HudModel.needsPointer) and no panel is open.
// The click is the pointer-lock gesture (emits `resume`); a small Menu button opens the Esc menu instead.
// Keyboard players: the Play button takes the focus when the veil shows, so Enter / Space resumes too (Input
// falls back to drag-look when the browser won't lock from a key press). With settings.mouseLock off it says
// how drag-look works instead. Adapted from games/bonk-brawl/client/src/ui/Overlays.ts ClickToPlay. Owner: client-ui.

import { settings } from "../../app/settings";
import { t } from "../../i18n";
import { button, el, play, setHidden, setText, svg } from "../dom";
import { ICON_GEAR, ICON_MOUSE } from "../icons";

export class PointerVeil {
  readonly el = el("div", "rr-veil");
  private readonly playBtn: HTMLButtonElement;
  private readonly keysHint = el("span", "rr-veil__hint rr-veil__hint--keys");
  private visible = false;

  constructor(onResume: () => void, onMenu: () => void) {
    this.el.hidden = true;
    this.playBtn = button(
      "rr-veil__play",
      el("span", "rr-veil__icon", svg(ICON_MOUSE)),
      el("span", "rr-veil__title", t("hud.clickToPlay")),
      el("span", "rr-veil__hint", el("kbd", "", "Esc"), " ", t("hud.clickHint")),
      this.keysHint,
    );
    this.playBtn.dataset.hover = "off";
    this.playBtn.addEventListener("click", () => onResume());
    const menu = button("rr-btn rr-btn--small rr-veil__menu", svg(ICON_GEAR), t("hud.menuBtn"));
    menu.addEventListener("click", (e) => {
      e.stopPropagation();
      onMenu();
    });
    this.el.append(this.playBtn, menu);
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    setHidden(this.el, !visible);
    if (!visible) return;
    setText(this.keysHint, t(settings.get().mouseLock ? "hud.veilKeys" : "hud.veilDrag"));
    play(this.el, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
    // Nothing else is focused while playing (or only something hidden, like a closed panel's tile); a field being
    // typed in keeps its focus.
    const active = document.activeElement;
    if (!active || active === document.body || active.closest("[hidden]")) this.playBtn.focus({ preventScroll: true });
  }
}
