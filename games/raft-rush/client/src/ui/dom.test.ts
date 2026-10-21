// DOM-free helpers of ui/dom.ts: the arrow-key grid move (chest tiles, craft cards) and the panels' Tab trap
// (on a fake container). Owner: client-ui.  Run: npx vitest run games/raft-rush/client/src/ui

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arrowDir, neighborIndex, trapTab, type Box } from "./dom";

/** A 3-wide wrapped grid of 7 tiles (100 × 80, 10 px gaps). */
const GRID: Box[] = Array.from({ length: 7 }, (_, i) => ({ x: (i % 3) * 110, y: Math.floor(i / 3) * 90, w: 100, h: 80 }));

describe("neighborIndex", () => {
  it("left / right walk the reading order and stop at the ends", () => {
    expect(neighborIndex(GRID, 2, "right")).toBe(3);
    expect(neighborIndex(GRID, 3, "left")).toBe(2);
    expect(neighborIndex(GRID, 0, "left")).toBe(0);
    expect(neighborIndex(GRID, 6, "right")).toBe(6);
  });

  it("up / down go to the nearest tile of the next row", () => {
    expect(neighborIndex(GRID, 1, "down")).toBe(4);
    expect(neighborIndex(GRID, 4, "up")).toBe(1);
    expect(neighborIndex(GRID, 5, "down")).toBe(6); // the short last row: nearest is the only tile
    expect(neighborIndex(GRID, 1, "up")).toBe(1); // top row: stay
  });

  it("without a layout up / down step like left / right; a lost focus starts at the first tile", () => {
    const flat: Box[] = [0, 1, 2].map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
    expect(neighborIndex(flat, 1, "down")).toBe(2);
    expect(neighborIndex(flat, 1, "up")).toBe(0);
    expect(neighborIndex(flat, -1, "down")).toBe(0);
    expect(neighborIndex([], 0, "down")).toBe(-1);
  });
});

describe("arrowDir", () => {
  it("maps the four arrow keys, nothing else", () => {
    expect(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].map(arrowDir)).toEqual(["left", "right", "up", "down"]);
    expect(arrowDir("KeyA")).toBeNull();
    expect(arrowDir("Tab")).toBeNull();
  });
});

describe("trapTab", () => {
  interface FakeItem {
    tabIndex: number;
    disabled?: boolean;
    hidden?: boolean;
    closest(sel: string): FakeItem | null;
    focus(): void;
  }
  let active: unknown = null;
  const item = (props: Partial<FakeItem> = {}): FakeItem => {
    const n: FakeItem = {
      tabIndex: 0,
      closest: () => (n.hidden ? n : null),
      focus: () => void (active = n),
      ...props,
    };
    return n;
  };
  const panel = (items: FakeItem[]): HTMLElement => {
    const self = { querySelectorAll: () => items, contains: (n: unknown) => n === self || items.includes(n as FakeItem) };
    return self as unknown as HTMLElement;
  };
  const tab = (shiftKey = false): KeyboardEvent => ({ code: "Tab", shiftKey }) as KeyboardEvent;

  beforeEach(() => {
    active = null;
    vi.stubGlobal("document", {
      get activeElement() {
        return active;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("from the dialog itself (focused on open) or from outside: Tab goes to the first item, Shift+Tab to the last", () => {
    const a = item();
    const b = item();
    const p = panel([a, b]);
    active = p;
    expect(trapTab(p, tab())).toBe(true);
    expect(active).toBe(a);
    active = p;
    expect(trapTab(p, tab(true))).toBe(true);
    expect(active).toBe(b);
    active = { outside: true };
    expect(trapTab(p, tab())).toBe(true);
    expect(active).toBe(a);
  });

  it("wraps at the ends and leaves the middle to the browser", () => {
    const [a, b, c] = [item(), item(), item()];
    const p = panel([a, b, c]);
    active = c;
    expect(trapTab(p, tab())).toBe(true);
    expect(active).toBe(a);
    expect(trapTab(p, tab(true))).toBe(true);
    expect(active).toBe(c);
    active = b;
    expect(trapTab(p, tab())).toBe(false);
    expect(active).toBe(b);
  });

  it("skips hidden, disabled and tabIndex -1 items; other keys and an empty panel are not used", () => {
    const a = item();
    const p = panel([item({ tabIndex: -1 }), a, item({ disabled: true }), item({ hidden: true })]);
    active = p;
    expect(trapTab(p, tab(true))).toBe(true);
    expect(active).toBe(a); // the only real item is both the first and the last
    expect(trapTab(p, { code: "KeyA", shiftKey: false } as KeyboardEvent)).toBe(false);
    expect(trapTab(panel([]), tab())).toBe(false);
  });
});
