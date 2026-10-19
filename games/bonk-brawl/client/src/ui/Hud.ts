// In-game HUD. Owner: client-ui.

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

  constructor() {
    this.el.className = "hud";
  }

  update(model: HudModel): void {
    void model;
  }

  /** Reuse arrow elements keyed by indicator id; hide unused ones. */
  setIndicators(list: readonly OffscreenIndicator[]): void {
    void list;
  }

  setVisible(visible: boolean): void {
    this.el.hidden = !visible;
  }
}
