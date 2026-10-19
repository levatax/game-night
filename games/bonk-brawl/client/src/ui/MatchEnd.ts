// Match-end podium + stats. Owner: client-ui.

import type { Emitter } from "../util/Emitter";
import type { MatchEndModel, UiEventMap } from "./models";

/**
 * Podium 1st/2nd/3rd (4th drawn "falling into the void" with a CSS tumble animation), confetti
 * (CSS), per-player stats table (hits, catches, ring-outs, accuracy %), countdown to auto-lobby,
 * buttons Rematch (rematch {ready:true}) and Back to lobby (rematch {ready:false}), both disabled
 * until canRematch; plus a small "Leave" link (leaveRoom).
 */
export class MatchEndScreen {
  readonly el: HTMLElement = document.createElement("section");

  constructor(events: Emitter<UiEventMap>) {
    void events;
    this.el.className = "screen screen--match-end";
  }

  update(model: MatchEndModel): void {
    void model;
  }
}
