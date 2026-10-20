// HUD bottom center: held-ball pips, power-up badge and the Zoomies timer. Fixed-width slots so
// nothing shifts when a power-up appears. Owner: client-ui.

import { POWERUPS } from "../../../../shared/constants";
import type { HeldPowerUp } from "../../../../shared/types";
import { el, play, POP_KEYFRAMES, setHidden, setText, setVar, svg } from "../dom";
import { ICON_BALL } from "../icons";
import type { HudModel } from "../models";

export class HeldTray {
  readonly el = el("div", "tray");

  private readonly balls = el("div", "tray__balls");
  private readonly ballHint = el("span", "tray__hint", "Grab a ball!");
  private readonly badge = el("div", "powerup-badge");
  private readonly badgeIcon = el("span", "powerup-badge__icon");
  private readonly badgeName = el("span", "powerup-badge__name");
  private readonly zoomies = el("div", "powerup-badge powerup-badge--zoomies");
  private readonly zoomiesBar = el("i", "powerup-badge__bar");
  private pips: HTMLElement[] = [];
  private held = -1;
  private powerUp: HeldPowerUp | null = null;
  private zoomiesOn: boolean | null = null;

  constructor() {
    this.badge.append(this.badgeIcon, el("span", "powerup-badge__text", this.badgeName, el("small", "", "next throw")));
    const z = POWERUPS.zoomies;
    this.zoomies.style.setProperty("--pu", z.color);
    this.zoomies.append(
      el("span", "powerup-badge__icon", z.icon),
      el("span", "powerup-badge__text", el("span", "powerup-badge__name", z.name), el("span", "powerup-badge__meter", this.zoomiesBar)),
    );
    const side = el("div", "tray__side", this.badge, this.zoomies);
    this.el.append(el("div", "tray__held", this.ballHint, this.balls), side);
    this.badge.hidden = true;
    this.zoomies.hidden = true;
  }

  update(m: HudModel): void {
    if (m.maxHeld !== this.pips.length) this.buildPips(m.maxHeld);
    this.renderBalls(m.heldBalls);
    this.renderPowerUp(m.powerUp);
    this.renderZoomies(m.zoomiesFrac);
  }

  private buildPips(max: number): void {
    const prev = this.pips.length;
    this.pips = Array.from({ length: Math.max(1, max) }, () => el("span", "ball-pip", svg(ICON_BALL)));
    this.balls.replaceChildren(...this.pips);
    this.held = -1;
    if (prev > 0 && max > prev) play(this.balls, POP_KEYFRAMES, { duration: 360 });
  }

  private renderBalls(held: number): void {
    if (held === this.held) return;
    const prev = this.held;
    this.held = held;
    this.pips.forEach((pip, i) => {
      const full = i < held;
      pip.classList.toggle("is-held", full);
      if (full && prev >= 0 && i >= prev) play(pip, POP_KEYFRAMES, { duration: 360, easing: "ease-out" });
    });
    this.balls.setAttribute("aria-label", `${held} ball${held === 1 ? "" : "s"} held`);
    this.ballHint.classList.toggle("is-shown", held === 0);
  }

  private renderPowerUp(type: HeldPowerUp): void {
    if (type === this.powerUp) return;
    this.powerUp = type;
    setHidden(this.badge, type === "");
    if (type === "") return;
    const def = POWERUPS[type];
    setVar(this.badge, "--pu", def.color);
    setText(this.badgeIcon, def.icon);
    setText(this.badgeName, def.name);
    play(this.badge, [{ transform: "scale(0.4) rotate(-10deg)" }, { transform: "scale(1.15) rotate(3deg)", offset: 0.6 }, { transform: "none" }], { duration: 420, easing: "ease-out" });
  }

  private renderZoomies(frac: number): void {
    const on = frac > 0;
    if (on) setVar(this.zoomiesBar, "--frac", (Math.round(frac * 200) / 200).toFixed(3));
    if (on === this.zoomiesOn) return;
    this.zoomiesOn = on;
    setHidden(this.zoomies, !on);
    if (on) play(this.zoomies, POP_KEYFRAMES, { duration: 380, easing: "ease-out" });
  }
}
