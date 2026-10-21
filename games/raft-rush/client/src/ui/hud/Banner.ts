// Big center banner ("NIGHT IS COMING", "RAFT READY!", "STORM!"): a chunky sticker that slams in, rests for
// BannerModel.duration (2.5 s default) and floats away. A new banner replaces the current one. Both lines get the
// {k…} key placeholders filled (ui/controls.ts withKeys: "Everyone press U on the raft" in the left-handed preset).
// Adapted from games/kasala/client/src/ui/hud/Banner.ts + games/bonk-brawl/client/src/ui/Overlays.ts. Owner: client-ui.

import { withKeys } from "../controls";
import { el, play, setOutlinedText, setText, tr } from "../dom";
import type { BannerModel } from "../models";

const DEFAULT_SEC = 2.5;

export class Banner {
  readonly el = el("div", "rr-banner-layer");
  private current: HTMLElement | null = null;
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
  }

  private leave(node: HTMLElement): void {
    const done = () => {
      node.remove();
      if (this.current === node) this.current = null;
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
