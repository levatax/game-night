// Full scoreboard overlay (hold Tab). Owner: client-ui.

import type { ScoreRow } from "./models";

/** Columns: color/emoji, name (crown, "YOU"), points, round wins, hits, catches, ring-outs, hearts/OUT, ping. */
export class Scoreboard {
  readonly el: HTMLElement = document.createElement("div");

  constructor() {
    this.el.className = "scoreboard";
  }

  set(open: boolean, rows: readonly ScoreRow[]): void {
    void open;
    void rows;
  }
}
