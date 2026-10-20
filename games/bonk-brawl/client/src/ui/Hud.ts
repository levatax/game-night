// In-game HUD. Owner: client-ui.

import { el, play, setText, svg } from "./dom";
import { formatPing, pingLevel } from "./format";
import { AbilityWidget } from "./hud/AbilityWidget";
import { Countdown } from "./hud/Countdown";
import { Hearts } from "./hud/Hearts";
import { HeldTray } from "./hud/HeldTray";
import { IndicatorArrows } from "./hud/IndicatorArrows";
import { MiniScoreboard } from "./hud/MiniScoreboard";
import { Reticle } from "./hud/Reticle";
import { RoundTimer } from "./hud/RoundTimer";
import { SpectateBanner } from "./hud/SpectateBanner";
import { ICON_SIGNAL } from "./icons";
import type { HudModel, OffscreenIndicator } from "./models";

/**
 * game1.md §13.3: top center round timer + round dots (●●○○○) + "SUDDEN DEATH" banner;
 * top right mini scoreboard (color dot, name, points, crown); bottom left 3 big cartoon hearts +
 * ability icon with radial cooldown (conic-gradient) and armed/active glow; bottom center
 * crosshair (small circle, gap = crosshairSpread, player color), curved charge meter under it
 * (pulses at full charge), held-ball pips + power-up badge (POWERUPS icon/color) + zoomies bar;
 * catch/roll cooldown pips; big center countdown 3-2-1-BONK!; spectating banner; off-screen
 * incoming-ball arrows (setIndicators).
 * update() is called EVERY frame: cache last values and only touch the DOM when they change;
 * no layout reads (no getBoundingClientRect in update).
 */
export class Hud {
  readonly el: HTMLElement = document.createElement("section");

  private readonly timer = new RoundTimer();
  private readonly board = new MiniScoreboard();
  private readonly hearts = new Hearts();
  private readonly ability = new AbilityWidget();
  private readonly reticle = new Reticle();
  private readonly tray = new HeldTray();
  private readonly countdown = new Countdown();
  private readonly spectate = new SpectateBanner();
  private readonly arrows = new IndicatorArrows();
  private readonly vignette = el("div", "hud-vignette");
  private readonly ping = el("div", "hud-ping");
  private readonly pingText = el("span", "");

  private lastHearts = -1;
  private lastPing = -1;
  private modeKey = "";

  constructor() {
    this.el.className = "hud";
    this.el.setAttribute("aria-label", "Game HUD");
    this.ping.append(svg(ICON_SIGNAL), this.pingText);
    const bottomLeft = el("div", "hud-bl", this.hearts.el, this.ability.el);
    this.el.append(
      this.vignette,
      this.arrows.el,
      this.timer.el,
      this.board.el,
      this.reticle.el,
      this.countdown.el,
      bottomLeft,
      this.tray.el,
      this.spectate.el,
      this.ping,
    );
  }

  update(model: HudModel): void {
    this.renderMode(model);
    this.timer.update(model);
    this.board.update(model.scoreboard);
    this.renderHearts(model);
    this.ability.update(model);
    this.reticle.update(model);
    this.tray.update(model);
    this.countdown.update(model.countdown);
    this.spectate.update(model.spectating);
    this.renderPing(model.ping);
  }

  /** Reuse arrow elements keyed by indicator id; hide unused ones. */
  setIndicators(list: readonly OffscreenIndicator[]): void {
    this.arrows.update(list);
  }

  setVisible(visible: boolean): void {
    this.el.hidden = !visible;
    if (!visible) this.arrows.clear();
  }

  /** Hide combat widgets for ghosts/spectators and during the round-end card. */
  private renderMode(m: HudModel): void {
    const key = `${m.spectating ? 1 : 0}|${m.phase}`;
    if (key === this.modeKey) return;
    this.modeKey = key;
    this.el.classList.toggle("is-spectating", !!m.spectating);
    this.el.classList.toggle("is-round-over", m.phase === "roundEnd");
    this.el.classList.toggle("is-countdown", m.phase === "countdown");
  }

  private renderHearts(m: HudModel): void {
    this.hearts.update(m.hearts, m.maxHearts);
    const lost = this.lastHearts > m.hearts && m.hearts >= 0;
    this.lastHearts = m.hearts;
    if (lost) play(this.vignette, [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }], { duration: 520, easing: "ease-out" });
  }

  private renderPing(ping: number): void {
    const rounded = Math.round(ping);
    if (rounded === this.lastPing) return;
    this.lastPing = rounded;
    setText(this.pingText, formatPing(rounded));
    this.ping.dataset.level = pingLevel(rounded);
  }
}
