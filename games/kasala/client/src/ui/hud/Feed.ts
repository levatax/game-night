// Bottom-left event feed: at most FEED_MAX lines on screen, each fades after FEED_LIFE seconds (timed in tick,
// so freeze frames pause it). Game only pushes what nothing else on screen told (attacks on/by me, loans,
// notices). The last HISTORY lines are kept for the hold-H panel. HTML comes pre-escaped from Game.

import { h } from "./dom";

const FEED_MAX = 2;
const FEED_LIFE = 5;
const FADE = 0.5;
const HISTORY = 6;

interface FeedLine {
  node: HTMLDivElement;
  age: number;
  fading: boolean;
  born: number;
}

export interface FeedEntry {
  icon: string;
  html: string;
  born: number;
}

export class Feed {
  readonly root: HTMLDivElement;
  private readonly lines: FeedLine[] = [];
  private readonly hist: FeedEntry[] = [];
  /** Bumps on every history change (the legend re-renders its list only then). */
  version = 0;

  constructor(parent: HTMLElement) {
    this.root = h("div", "ks-hud-feed", parent);
    this.root.setAttribute("aria-live", "polite");
  }

  get history(): readonly FeedEntry[] {
    return this.hist;
  }

  push(icon: string, html: string): void {
    const born = performance.now();
    const node = h("div", "ks-hud-feed__line", this.root);
    if (icon) h("span", "ks-hud-feed__icon", node, icon);
    const body = h("span", "ks-hud-feed__text", node);
    body.innerHTML = html;
    this.lines.push({ node, age: 0, fading: false, born });
    while (this.lines.length > FEED_MAX) this.lines.shift()!.node.remove();
    this.hist.push({ icon, html, born });
    while (this.hist.length > HISTORY) this.hist.shift();
    this.version++;
  }

  /** Drop everything older than `keepMs` (lines pushed in the same moment as a new match survive). */
  clear(keepMs = 0): void {
    const cut = performance.now() - keepMs;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (keepMs > 0 && this.lines[i].born >= cut) continue;
      this.lines[i].node.remove();
      this.lines.splice(i, 1);
    }
    const before = this.hist.length;
    for (let i = this.hist.length - 1; i >= 0; i--) {
      if (keepMs > 0 && this.hist[i].born >= cut) continue;
      this.hist.splice(i, 1);
    }
    if (this.hist.length !== before) this.version++;
  }

  tick(dt: number): void {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      l.age += dt;
      if (!l.fading && l.age >= FEED_LIFE) {
        l.fading = true;
        l.node.classList.add("ks-hud-feed__line--out");
      }
      if (l.age >= FEED_LIFE + FADE) {
        l.node.remove();
        this.lines.splice(i, 1);
      }
    }
  }
}
