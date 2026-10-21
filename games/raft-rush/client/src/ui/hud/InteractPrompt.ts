// Interaction prompt under the crosshair (§17): "[E] Chop wood", a ring on the key cap fills while a hold
// channel runs, and a candidate that can't be done right now is greyed out with the reason ("Your pockets are
// full"). Text comes from PromptModel.key (prompt.* strings, owner client-app) and reason (reject.*). The "E" key
// cap shows the interact key of the key preset / layout (U left-handed, ui/controls.ts). Owner: client-ui.

import { settings } from "../../app/settings";
import { t } from "../../i18n";
import { keyCapsVersion } from "../../input/bindings";
import { keyLabel } from "../controls";
import { clamp01, el, replay, setHidden, setText, svgEl, toggleClass, tr } from "../dom";
import type { PromptModel } from "../models";

const R = 21;
const C = 2 * Math.PI * R;

export class InteractPrompt {
  readonly el = el("div", "rr-prompt");
  private readonly key = el("span", "rr-prompt__key");
  private readonly keyText = el("span", "rr-prompt__glyph");
  private readonly ring: SVGCircleElement;
  private readonly text = el("span", "rr-prompt__text");
  private readonly hold = el("span", "rr-prompt__hold", t("hud.holdE"));
  private readonly reason = el("span", "rr-prompt__reason");
  private sig = "";
  private progress = -1;

  constructor() {
    const s = svgEl("svg", { viewBox: "0 0 50 50", class: "rr-prompt__ring", "aria-hidden": "true" });
    svgEl("circle", { cx: 25, cy: 25, r: R, class: "rr-prompt__ring-track" }, s);
    this.ring = svgEl("circle", { cx: 25, cy: 25, r: R, class: "rr-prompt__ring-fill", "stroke-dasharray": C.toFixed(2), "stroke-dashoffset": C.toFixed(2) }, s);
    this.key.append(s, this.keyText);
    this.el.append(this.key, el("span", "rr-prompt__body", el("span", "rr-prompt__line", this.text, this.hold), this.reason));
    this.el.hidden = true;
    this.el.setAttribute("aria-live", "polite");
  }

  update(p: PromptModel | null): void {
    if (!p) {
      if (this.sig !== "") {
        this.sig = "";
        this.el.hidden = true;
      }
      return;
    }
    const params = p.params ? JSON.stringify(p.params) : "";
    const sig = `${p.kind}|${p.key}|${params}|${p.keyGlyph}|${p.hold}|${p.ok}|${p.reason}|${settings.get().keyPreset}${keyCapsVersion()}`;
    if (sig !== this.sig) {
      const wasHidden = this.sig === "";
      this.sig = sig;
      this.el.hidden = false;
      // The app says "E" for every interact-key prompt; other glyphs (LMB) are shown as given.
      setText(this.keyText, !p.keyGlyph || p.keyGlyph === "E" ? keyLabel("interact") : p.keyGlyph);
      setText(this.text, tr(p.key, "prompt", p.params));
      setHidden(this.hold, !p.hold || !p.ok);
      toggleClass(this.el, "is-blocked", !p.ok);
      toggleClass(this.el, "is-hold", p.hold);
      const reason = !p.ok && p.reason ? tr(p.reason, "reject") : "";
      setText(this.reason, reason);
      setHidden(this.reason, !reason);
      this.el.dataset.kind = p.kind;
      if (wasHidden) replay(this.el, "is-in");
    }
    const progress = p.hold && p.ok ? Math.round(clamp01(p.progress) * 100) / 100 : 0;
    if (progress !== this.progress) {
      this.progress = progress;
      this.ring.setAttribute("stroke-dashoffset", (C * (1 - progress)).toFixed(2));
      toggleClass(this.el, "is-channeling", progress > 0);
    }
  }
}
