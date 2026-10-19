// Kill feed (top left). Owner: client-ui.

import type { KillFeedEntry } from "./models";

/**
 * Renders entries per KillFeedKind (see models.ts for the exact phrasing), names in player colors,
 * newest on top, max 5, each fades out after 5 s. Slide-in animation.
 */
export class KillFeed {
  readonly el: HTMLElement = document.createElement("div");

  constructor() {
    this.el.className = "killfeed";
  }

  push(entry: KillFeedEntry): void {
    void entry;
  }

  clear(): void {}
}
