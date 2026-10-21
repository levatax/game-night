// Sound captions on a minimal DOM shim (node env): the aria-live wrapper stays rendered from the first frame to
// the last (only the pill inside it hides), each caption is written into that standing region, the same line again
// only refreshes its timer, and the faded caption leaves the region empty. Owner: client-ui.
// Run: npx vitest run games/raft-rush/client/src/ui

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Subtitle } from "./Subtitle";

/** Just enough of an HTMLElement for Subtitle and the ui/dom.ts helpers it uses (el, setText, replay). */
class FakeElement {
  className = "";
  hidden = false;
  readonly offsetWidth = 0;
  parent: FakeElement | null = null;
  private kids: FakeElement[] = [];
  private ownText = "";
  private readonly attrs = new Map<string, string>();
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]) => names.forEach((n) => this.classes.add(n)),
    remove: (...names: string[]) => names.forEach((n) => this.classes.delete(n)),
    contains: (name: string) => this.classes.has(name),
  };

  get textContent(): string {
    return this.kids.length ? this.kids.map((k) => k.textContent).join("") : this.ownText;
  }
  set textContent(text: string) {
    this.kids = [];
    this.ownText = text;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.kids.push(node);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  /** In the accessibility tree: neither this node nor an ancestor is hidden. */
  get rendered(): boolean {
    return !this.hidden && (this.parent?.rendered ?? true);
  }
}

const THUNDER = { key: "cap_thunder", icon: "⛈️" };
const THUNDER_TEXT = "Thunder rumbles in the distance";

let sub: Subtitle;
let region: FakeElement;
/** Whether the live region was ever taken out of the tree while the caption cycled. */
let regionDropped: boolean;

function advance(ms: number): void {
  for (let left = ms; left > 0; left -= 50) {
    vi.advanceTimersByTime(Math.min(50, left));
    if (!region.rendered) regionDropped = true;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("document", { createElement: () => new FakeElement() });
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  });
  sub = new Subtitle();
  region = sub.el as unknown as FakeElement;
  regionDropped = false;
});

afterEach(() => {
  sub.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Subtitle", () => {
  it("is a polite, atomic live region that is rendered and empty before the first caption", () => {
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.rendered).toBe(true);
    expect(region.textContent).toBe("");
  });

  it("writes each caption into the standing region and empties it again after the fade", () => {
    sub.show(THUNDER);
    expect(region.rendered).toBe(true);
    expect(region.textContent).toBe(`⛈️${THUNDER_TEXT}`);
    advance(3600);
    expect(region.textContent).toBe("");
    sub.show({ key: "cap_thunderNear", icon: "" });
    expect(region.textContent).toBe("Thunder cracks across the sky!");
    advance(3600);
    sub.show(THUNDER);
    sub.clear();
    expect(region.textContent).toBe("");
    expect(regionDropped).toBe(false);
    expect(region.rendered).toBe(true);
  });

  it("the same line again only refreshes its timer", () => {
    sub.show(THUNDER);
    advance(3000);
    sub.show(THUNDER);
    advance(3000); // 6 s after the first show: still up thanks to the refresh
    expect(region.textContent).toBe(`⛈️${THUNDER_TEXT}`);
    advance(600);
    expect(region.textContent).toBe("");
    expect(regionDropped).toBe(false);
  });

  it("ignores a caption with no text", () => {
    sub.show({ key: "", icon: "🦀" });
    expect(region.textContent).toBe("");
  });
});
