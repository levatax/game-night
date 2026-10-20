// HUD top center: round timer, round dots (●●○○○) and the sudden-death state. Owner: client-ui.

import { ROUND_TICKS, TICK_RATE } from "../../../../shared/constants";
import { el, play, setHidden, setOutlinedText, setText } from "../dom";
import { formatClock } from "../format";
import type { HudModel } from "../models";

const LOW_TIME_SEC = 10;

export class RoundTimer {
  readonly el = el("div", "hud-timer");

  private readonly card = el("div", "hud-timer__card");
  private readonly time = el("span", "hud-timer__time");
  private readonly caption = el("span", "hud-timer__caption");
  private readonly dots = el("div", "hud-timer__dots");
  private readonly ribbon = el("div", "hud-timer__ribbon outlined");
  private dotEls: HTMLElement[] = [];
  private total = -1;
  private round = -1;
  private sudden = false;

  constructor() {
    this.card.append(this.caption, this.time, this.dots);
    this.el.append(this.card, this.ribbon);
    setOutlinedText(this.ribbon, "SUDDEN DEATH!");
    this.ribbon.hidden = true;
    this.el.setAttribute("role", "timer");
  }

  update(m: HudModel): void {
    if (m.totalRounds !== this.total) this.buildDots(m.totalRounds);
    if (m.round !== this.round) this.markDots(m.round);
    this.renderTime(m);
    this.renderSuddenDeath(m.suddenDeath);
  }

  private buildDots(total: number): void {
    this.total = total;
    this.round = -1;
    this.dotEls = Array.from({ length: Math.max(0, total) }, () => el("i", "round-dot"));
    this.dots.replaceChildren(...this.dotEls);
  }

  private markDots(round: number): void {
    this.round = round;
    this.dotEls.forEach((dot, i) => {
      dot.classList.toggle("is-done", i < round - 1);
      dot.classList.toggle("is-current", i === round - 1);
    });
    this.dots.setAttribute("aria-label", `Round ${round} of ${this.total}`);
  }

  private renderTime(m: HudModel): void {
    let text: string | null = null;
    if (m.phase === "countdown") text = formatClock(ROUND_TICKS / TICK_RATE);
    else if (m.phase === "playing") text = formatClock(m.timerSec);
    else if (m.phase === "suddenDeath") text = m.timerSec > 0 ? formatClock(m.timerSec) : "–:––";
    // roundEnd / other phases freeze the last value.
    if (text !== null && text !== this.time.textContent) {
      this.time.textContent = text;
      const low = m.phase === "playing" && m.timerSec <= LOW_TIME_SEC;
      const lastRing = m.phase === "suddenDeath" && m.timerSec > 0 && m.timerSec <= 3;
      if (low || lastRing) play(this.time, [{ transform: "scale(1.3)" }, { transform: "scale(1)" }], { duration: 300, easing: "ease-out" });
    }
    this.card.classList.toggle("is-low", m.phase === "playing" && m.timerSec <= LOW_TIME_SEC);
    const caption = m.suddenDeath ? (m.timerSec > 0 ? "Ring drop in" : "Last ring!") : `Round ${Math.max(1, m.round)}`;
    setText(this.caption, caption);
  }

  private renderSuddenDeath(sudden: boolean): void {
    if (sudden === this.sudden) return;
    this.sudden = sudden;
    this.card.classList.toggle("is-sudden", sudden);
    setHidden(this.ribbon, !sudden);
    if (sudden) play(this.ribbon, [{ transform: "scale(2) rotate(-6deg)", opacity: 0 }, { transform: "scale(1) rotate(-3deg)", opacity: 1 }], { duration: 380, easing: "cubic-bezier(.3,1.5,.5,1)" });
  }
}
