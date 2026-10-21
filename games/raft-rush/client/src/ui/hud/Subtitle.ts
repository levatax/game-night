// Sound captions (game4.md §17, §20): one line above the feed for the cues that are only heard (crabs crawling
// out of the sea, thunder, a fence being gnawed), e.g. "🦀 Crabs crawling out of the sea · behind you". Faded
// in, held CAPTION_MS, gone; the same line again only refreshes its timer (no stacking, no second read-out). The
// app rate-limits and words the cues (app/feedback.ts) and never captions what a banner or feed line already
// says. Read out politely: the aria-live wrapper is always rendered (empty between captions) and only the pill
// inside it hides, so each caption is a change to a region screen readers already watch (one that appears
// together with its text is often not read). Adapted from games/kasala/client/src/ui/hud/Subtitle.ts (timers
// instead of a tick, like Feed.ts). Owner: client-ui.

import { el, replay, setText, tr } from "../dom";
import type { CaptionEntry } from "../models";

const CAPTION_MS = 3200;
const FADE_MS = 300;

export class Subtitle {
  /** The live region (never hidden; empty = nothing to see). */
  readonly el = el("div", "rr-caption-live");
  private readonly pill = el("div", "rr-caption");
  private readonly icon = el("span", "rr-caption__icon");
  private readonly text = el("span", "rr-caption__text");
  private hideTimer = 0;
  private fadeTimer = 0;

  constructor() {
    this.pill.append(this.icon, this.text);
    this.pill.hidden = true;
    this.el.append(this.pill);
    this.el.setAttribute("aria-live", "polite");
    this.el.setAttribute("aria-atomic", "true");
  }

  show(entry: CaptionEntry): void {
    const text = tr(entry.key, "hud", entry.params);
    if (!text) return;
    const same = !this.pill.hidden && this.text.textContent === text;
    window.clearTimeout(this.hideTimer);
    window.clearTimeout(this.fadeTimer);
    this.pill.classList.remove("is-out");
    if (!same) {
      setText(this.icon, entry.icon);
      this.icon.hidden = !entry.icon;
      setText(this.text, text);
      this.pill.hidden = false;
      replay(this.pill, "is-in");
    }
    this.hideTimer = window.setTimeout(() => this.fadeOut(), CAPTION_MS);
  }

  clear(): void {
    window.clearTimeout(this.hideTimer);
    window.clearTimeout(this.fadeTimer);
    this.pill.classList.remove("is-out", "is-in");
    this.pill.hidden = true;
    setText(this.icon, "");
    setText(this.text, "");
  }

  private fadeOut(): void {
    this.pill.classList.add("is-out");
    this.fadeTimer = window.setTimeout(() => this.clear(), FADE_MS);
  }
}
