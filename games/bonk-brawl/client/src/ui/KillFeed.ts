// Kill feed (top left). Owner: client-ui.

import { el } from "./dom";
import { possessive } from "./format";
import type { FeedPlayer, KillFeedEntry, KillFeedKind } from "./models";

const MAX_VISIBLE = 5;
const LIFETIME_MS = 5000;
const LEAVE_MS = 320;

const BADGE: Record<KillFeedKind, string> = {
  bonk: "💥",
  catch: "🧤",
  ringOut: "🌀",
  fell: "🕳️",
  ko: "💫",
  dropped: "🔌",
};

interface FeedItem {
  li: HTMLLIElement;
  timer: number;
}

function nameChip(p: FeedPlayer, name = p.name): HTMLElement {
  const chip = el("span", "feed-name", el("span", "feed-name__emoji", p.emoji), el("span", "feed-name__text", name));
  chip.style.setProperty("--slot", p.color);
  return chip;
}

function verb(text: string): HTMLElement {
  return el("span", "feed-verb", text);
}

/** The line content per kind, following the phrasing in models.ts. */
function describe(entry: KillFeedEntry): Array<Node | string> {
  const { actor, victim } = entry;
  switch (entry.kind) {
    case "bonk":
      return actor ? [nameChip(actor), verb("BONKED"), nameChip(victim)] : [nameChip(victim), verb("got BONKED")];
    case "catch": {
      const victimBall = nameChip(victim, possessive(victim.name));
      if (!actor) return [victimBall, verb("ball got CAUGHT!")];
      return [nameChip(actor), verb("CAUGHT"), victimBall, el("span", "feed-plain", "ball!")];
    }
    case "ringOut":
      return actor ? [nameChip(actor), verb("RANG OUT"), nameChip(victim)] : [nameChip(victim), verb("fell off!")];
    case "fell":
      return [nameChip(victim), verb("fell off!")];
    case "ko":
      return [nameChip(victim), verb("is OUT!")];
    case "dropped":
      return [nameChip(victim), el("span", "feed-plain", "disconnected")];
  }
}

/**
 * Renders entries per KillFeedKind (see models.ts for the exact phrasing), names in player colors,
 * newest on top, max 5, each fades out after 5 s. Slide-in animation.
 */
export class KillFeed {
  readonly el: HTMLElement = document.createElement("div");

  private readonly list = el("ol", "killfeed__list");
  private readonly items: FeedItem[] = [];

  constructor() {
    this.el.className = "killfeed";
    this.el.setAttribute("aria-label", "Kill feed");
    this.list.setAttribute("aria-live", "polite");
    this.el.append(this.list);
  }

  push(entry: KillFeedEntry): void {
    const li = el("li", `feed-item feed-item--${entry.kind}`, el("span", "feed-badge", BADGE[entry.kind]), ...describe(entry));
    li.dataset.id = String(entry.id);
    this.list.prepend(li);
    const item: FeedItem = { li, timer: window.setTimeout(() => this.retire(item), LIFETIME_MS) };
    this.items.unshift(item);
    while (this.items.length > MAX_VISIBLE) {
      const oldest = this.items[this.items.length - 1];
      this.drop(oldest);
    }
  }

  clear(): void {
    for (const item of this.items) window.clearTimeout(item.timer);
    this.items.length = 0;
    this.list.replaceChildren();
  }

  /** Fade out, then remove. */
  private retire(item: FeedItem): void {
    if (!this.items.includes(item)) return;
    item.li.classList.add("is-leaving");
    item.timer = window.setTimeout(() => this.drop(item), LEAVE_MS);
  }

  private drop(item: FeedItem): void {
    window.clearTimeout(item.timer);
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
    item.li.remove();
  }
}
