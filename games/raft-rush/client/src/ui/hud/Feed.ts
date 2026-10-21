// Left-side event feed (§17, KASALA declutter: "every event is said once"): at most FEED_MAX lines, each fades
// after FEED_LIFE_MS. The app only pushes what nothing else on screen tells (feed.* keys, params already
// translated; the {k…} key placeholders are filled here, ui/controls.ts withKeys). The last HISTORY lines are kept
// for the hold-H guide. Copied + adapted from games/kasala/client/src/ui/hud/Feed.ts (timers instead of a tick so it
// runs with any frame rate). Owner: client-ui.

import { withKeys } from "../controls";
import { el, tr } from "../dom";
import type { FeedEntry } from "../models";

const FEED_MAX = 2;
const FEED_LIFE_MS = 5000;
const FADE_MS = 450;
const HISTORY = 6;

interface FeedLine {
  node: HTMLElement;
  timer: number;
}

export interface FeedHistoryEntry {
  icon: string;
  text: string;
  tone: FeedEntry["tone"];
}

export class Feed {
  readonly el = el("div", "rr-feed");
  private readonly lines: FeedLine[] = [];
  private readonly hist: FeedHistoryEntry[] = [];
  /** Bumps on every history change (the guide re-renders its list only then). */
  version = 0;

  constructor() {
    this.el.setAttribute("aria-live", "polite");
  }

  get history(): readonly FeedHistoryEntry[] {
    return this.hist;
  }

  push(entry: FeedEntry): void {
    const text = tr(entry.key, "feed", withKeys(entry.params));
    // The same line twice in a row (two crabs flipped at once…) refreshes instead of stacking.
    const last = this.lines[this.lines.length - 1];
    if (last && last.node.dataset.text === text) {
      window.clearTimeout(last.timer);
      last.node.classList.remove("is-out");
      last.node.classList.add("is-bump");
      window.setTimeout(() => last.node.classList.remove("is-bump"), 300);
      last.timer = this.schedule(last);
      return;
    }
    const node = el("div", `rr-feed__line rr-tone--${entry.tone}`, entry.icon ? el("span", "rr-feed__icon", entry.icon) : null, el("span", "rr-feed__text", text));
    node.dataset.text = text;
    this.el.append(node);
    const line: FeedLine = { node, timer: 0 };
    line.timer = this.schedule(line);
    this.lines.push(line);
    while (this.lines.length > FEED_MAX) this.drop(this.lines[0]!);
    this.hist.push({ icon: entry.icon, text, tone: entry.tone });
    while (this.hist.length > HISTORY) this.hist.shift();
    this.version++;
  }

  clear(): void {
    for (const l of [...this.lines]) this.drop(l);
    if (this.hist.length) {
      this.hist.length = 0;
      this.version++;
    }
  }

  private schedule(line: FeedLine): number {
    return window.setTimeout(() => {
      line.node.classList.add("is-out");
      line.timer = window.setTimeout(() => this.drop(line), FADE_MS);
    }, FEED_LIFE_MS);
  }

  private drop(line: FeedLine): void {
    window.clearTimeout(line.timer);
    const i = this.lines.indexOf(line);
    if (i >= 0) this.lines.splice(i, 1);
    line.node.remove();
  }
}
