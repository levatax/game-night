// Big center banner ("NIGHT IS COMING", "RAFT READY!", "STORM!"): a chunky sticker that slams in, rests for
// BannerModel.duration (2.5 s default) and floats away. A new banner replaces the current one. Both lines get the
// {k…} key placeholders filled (ui/controls.ts withKeys: "Everyone press U on the raft" in the left-handed preset).
// Adapted from games/kasala/client/src/ui/hud/Banner.ts + games/bonk-brawl/client/src/ui/Overlays.ts. Owner: client-ui.

import { withKeys } from "../controls";
import { el, play, setOutlinedText, setText, tr } from "../dom";
import type { BannerModel, HudModel } from "../models";

const DEFAULT_SEC = 2.5;

export class Banner {
  readonly el = el("div", "rr-banner-layer");
  private current: HTMLElement | null = null;
  private currentModel: BannerModel | null = null;
  private main: HTMLElement | null = null;
  private lastSec = -1;
  private timer = 0;

  constructor() {
    this.el.setAttribute("aria-live", "assertive");
  }

  show(m: BannerModel, calm: boolean): void {
    window.clearTimeout(this.timer);
    this.current?.remove();
    const main = el("span", "rr-banner__main rr-outlined");
    setOutlinedText(main, tr(m.key, "banner", withKeys(m.params)));
    const node = el("div", `rr-banner rr-tone--${m.tone}`, el("span", "rr-banner__stripe"), main);
    if (m.sub) {
      const sub = el("span", "rr-banner__sub");
      setText(sub, tr(m.sub, "banner", withKeys(m.subParams)));
      node.append(sub);
    }
    this.el.append(node);
    this.current = node;
    this.currentModel = m;
    this.main = main;
    this.lastSec = typeof m.params?.sec === "number" ? m.params.sec : -1;
    play(
      node,
      calm
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { transform: "scale(2.1) rotate(-6deg)", opacity: 0 },
            { transform: "scale(0.92) rotate(-2deg)", opacity: 1, offset: 0.55 },
            { transform: "scale(1) rotate(-2deg)", opacity: 1 },
          ],
      { duration: calm ? 200 : 380, easing: "cubic-bezier(.3,1.3,.5,1)", fill: "both" },
    );
    const sec = m.duration && m.duration > 0 ? m.duration : DEFAULT_SEC;
    this.timer = window.setTimeout(() => this.leave(node), sec * 1000);
  }

  clear(): void {
    window.clearTimeout(this.timer);
    this.current?.remove();
    this.current = null;
    this.currentModel = null;
    this.main = null;
    this.lastSec = -1;
  }

  /**
   * Keep the storm-warning banner in step with the HUD clock: same ceil of the same live stormSecLeft, so the
   * banner and the top clock never show different seconds while both are on screen.
   */
  syncCountdown(m: HudModel): void {
    const model = this.currentModel;
    if (!model || model.key !== "banner.stormWarning" || !this.main) return;
    if (!((m.phase === "playing" || m.phase === "landing") && m.stormSecLeft > 0)) return;
    const sec = Math.max(0, Math.ceil(m.stormSecLeft));
    if (sec === this.lastSec) return;
    this.lastSec = sec;
    setOutlinedText(this.main, tr(model.key, "banner", withKeys({ ...model.params, sec })));
  }

  private leave(node: HTMLElement): void {
    const done = () => {
      node.remove();
      if (this.current === node) {
        this.current = null;
        this.currentModel = null;
        this.main = null;
        this.lastSec = -1;
      }
    };
    const anim = play(node, [{ opacity: 1, transform: "scale(1) rotate(-2deg)" }, { opacity: 0, transform: "scale(1.12) rotate(-2deg) translateY(-18px)" }], {
      duration: 260,
      easing: "ease-in",
      fill: "forwards",
    });
    if (anim) anim.onfinish = done;
    else done();
  }
}
