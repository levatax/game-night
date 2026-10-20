// HUD: ghost / spectator banner shown while the local player is out or watching. Owner: client-ui.

import { el, play, setHidden, setText } from "../dom";
import type { HudModel } from "../models";

type Spectating = NonNullable<HudModel["spectating"]>;

const ICON: Record<Spectating["reason"], string> = { ko: "👻", ringOut: "👻", spectator: "👀" };
/** The model text is display-ready; a " — " splits it into a headline and a smaller hint. */
const SPLIT = " — ";

export class SpectateBanner {
  readonly el = el("div", "spectate");

  private readonly icon = el("span", "spectate__icon");
  private readonly text = el("span", "spectate__text");
  private readonly hint = el("span", "spectate__hint");
  private key = "";

  constructor() {
    this.el.append(this.icon, el("span", "spectate__body", this.text, this.hint));
    this.el.hidden = true;
    this.el.setAttribute("role", "status");
  }

  update(spectating: HudModel["spectating"]): void {
    const key = spectating ? `${spectating.reason}|${spectating.text}` : "";
    if (key === this.key) return;
    const appearing = !this.key && !!key;
    this.key = key;
    setHidden(this.el, !spectating);
    if (!spectating) return;
    this.el.dataset.reason = spectating.reason;
    setText(this.icon, ICON[spectating.reason]);
    const at = spectating.text.indexOf(SPLIT);
    setText(this.text, at > 0 ? spectating.text.slice(0, at) : spectating.text);
    setText(this.hint, at > 0 ? spectating.text.slice(at + SPLIT.length) : "");
    setHidden(this.hint, at <= 0);
    if (appearing) play(this.el, [{ transform: "translate(-50%, 40px)", opacity: 0 }, { transform: "translate(-50%, 0)", opacity: 1 }], { duration: 420, easing: "cubic-bezier(.3,1.4,.5,1)" });
  }
}
