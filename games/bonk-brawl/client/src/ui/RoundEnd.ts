// Round-end card (3 s). Owner: client-ui.

import type { RoundEndModel } from "./models";

/**
 * "<emoji> <Name> WINS ROUND 2!" (or "DRAW!") in the winner's color, a dancing emoji/portrait,
 * and per-player "+N" round points with running totals (count-up animation). The 3D winner dance
 * is the characters' "victory" trigger, not this card.
 */
export class RoundEndCard {
  readonly el: HTMLElement = document.createElement("div");

  constructor() {
    this.el.className = "round-end";
  }

  show(model: RoundEndModel): void {
    void model;
  }

  hide(): void {}
}
