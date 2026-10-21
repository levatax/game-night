// The chest panel's deposits: every put names its pocket (putMsg, ChestMsg `slot`), so a put from a pocket that
// isn't held goes out at once with that slot — no slot switch, no wait for the server — while a click on such a
// pocket still only takes it in hand, while a screen reader's activate on a tile (virtualClick) does what Enter
// does; and which key puts which pocket in (slotOfKey). The panel runs on a minimal DOM shim (node env).
// Owner: client-ui.
// Run: npx vitest run games/raft-rush/client/src/ui

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChestMsg } from "../../../../shared/protocol";
import type { ChestPanelModel } from "../models";
import { ChestPanel, putMsg, slotOfKey, virtualClick } from "./ChestPanel";

// Installed before the imports above run (ui/dom.ts creates its <svg> template at load).
const shim = vi.hoisted(() => {
  type Child = FakeElement | string;
  /** Just enough of an element for ChestPanel and the ui/dom.ts helpers it uses. */
  class FakeElement {
    className = "";
    hidden = false;
    disabled = false;
    tabIndex = -1;
    title = "";
    type = "";
    innerHTML = "";
    readonly dataset: Record<string, string | undefined> = {};
    parent: FakeElement | null = null;
    kids: Child[] = [];
    private readonly attrs = new Map<string, string>();
    private readonly listeners = new Map<string, Array<(e: unknown) => void>>();

    constructor(readonly tag: string) {}

    get content(): { firstElementChild: FakeElement } {
      return { firstElementChild: new FakeElement("svg") };
    }
    get textContent(): string {
      return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("");
    }
    set textContent(text: string) {
      this.kids = [text];
    }
    append(...nodes: Child[]): void {
      for (const node of nodes) {
        if (typeof node !== "string") node.parent = this;
        this.kids.push(node);
      }
    }
    replaceChildren(...nodes: Child[]): void {
      this.kids = [];
      this.append(...nodes);
    }
    setAttribute(name: string, value: string): void {
      this.attrs.set(name, value);
    }
    getAttribute(name: string): string | null {
      return this.attrs.get(name) ?? null;
    }
    addEventListener(type: string, fn: (e: unknown) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    /** Fire `type` here, then on the ancestors until a listener stops it; `init` defaults to a real mouse click. */
    dispatch(type: string, init: Record<string, unknown> = { detail: 1, isTrusted: true, pointerType: "mouse" }): void {
      let stopped = false;
      const e = { ...init, target: this, stopPropagation: () => (stopped = true) };
      for (let n: FakeElement | null = this; n && !stopped; n = n.parent) n.listeners.get(type)?.forEach((fn) => fn(e));
    }
    focus(): void {
      doc.activeElement = this;
    }
    contains(node: unknown): boolean {
      for (let n = node instanceof FakeElement ? node : null; n; n = n.parent) if (n === this) return true;
      return false;
    }
    /** Every descendant element, depth first. */
    all(): FakeElement[] {
      return this.kids.flatMap((k) => (typeof k === "string" ? [] : [k, ...k.all()]));
    }
    /** ChestPanel.tiles()' selector: `.class[data-key]` alternatives. */
    querySelectorAll(selector: string): FakeElement[] {
      const classes = selector.split(",").map((s) => /^\s*\.([\w-]+)\[data-key\]\s*$/.exec(s)?.[1] ?? "");
      return this.all().filter((n) => n.dataset.key !== undefined && n.className.split(" ").some((c) => classes.includes(c)));
    }
  }
  const doc = { activeElement: null as FakeElement | null, createElement: (tag: string) => new FakeElement(tag) };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("SVGSVGElement", FakeElement);
  return { FakeElement, doc };
});
type FakeElement = InstanceType<typeof shim.FakeElement>;

afterAll(() => {
  vi.unstubAllGlobals();
});

/** Axe held (pocket 1), pocket 2 empty, wood ×3 and stone ×2 in pockets 3 and 4. */
function model(activeSlot = 0, heldSlot = activeSlot): ChestPanelModel {
  return {
    chest: [{ kind: "rope", count: 2 }],
    slots: [
      { kind: "axe", count: 1, meter: -1 },
      { kind: "", count: 0, meter: -1 },
      { kind: "wood", count: 3, meter: -1 },
      { kind: "stone", count: 2, meter: -1 },
    ],
    activeSlot,
    heldSlot,
  };
}

function key(code: string, shiftKey = false): KeyboardEvent {
  return { code, key: "", shiftKey, repeat: false } as unknown as KeyboardEvent;
}

let sent: ChestMsg[];
let selected: number[];
let panel: ChestPanel;

function tile(key: string): FakeElement {
  const root = panel.el as unknown as FakeElement;
  const found = root.all().find((n) => n.dataset.key === key);
  if (!found) throw new Error(`no tile ${key}`);
  return found;
}

beforeEach(() => {
  shim.doc.activeElement = null;
  sent = [];
  selected = [];
  panel = new ChestPanel(
    (m) => sent.push(m),
    () => {},
    (slot) => selected.push(slot),
  );
});

describe("putMsg", () => {
  it("names the pocket and what it holds, held or not; Shift puts one", () => {
    expect(putMsg(model(), 2, false)).toEqual({ op: "put", slot: 2, kind: "wood" });
    expect(putMsg(model(), 3, true)).toEqual({ op: "put", slot: 3, kind: "stone", count: 1 });
    expect(putMsg(model(), 0, false)).toEqual({ op: "put", slot: 0, kind: "axe" });
  });

  it("nothing for an empty or unknown pocket, or before the first model", () => {
    expect(putMsg(model(), 1, false)).toBeNull();
    expect(putMsg(model(), 7, false)).toBeNull();
    expect(putMsg(null, 2, false)).toBeNull();
  });
});

describe("ChestPanel deposits", () => {
  it("a pocket's slot key puts that pocket in at once with its slot: no switch, no wait", () => {
    panel.update(model());
    expect(panel.onKey(key("Digit3"))).toBe(true);
    expect(sent).toEqual([{ op: "put", slot: 2, kind: "wood" }]);
    expect(panel.onKey(key("Digit4", true))).toBe(true);
    expect(sent[1]).toEqual({ op: "put", slot: 3, kind: "stone", count: 1 });
    expect(selected).toEqual([]);
  });

  it("goes out at once even while a slot switch is still on its way to the server", () => {
    panel.update(model(2, 0)); // predicted: wood held; the server still holds the axe
    panel.onKey(key("Digit3"));
    panel.update(model(0, 2)); // and a switch back still in flight
    panel.onKey(key("Digit3"));
    expect(sent).toEqual([
      { op: "put", slot: 2, kind: "wood" },
      { op: "put", slot: 2, kind: "wood" },
    ]);
  });

  it("Enter on a focused pocket puts it in; an empty pocket sends nothing", () => {
    panel.update(model());
    tile("pocket:3").focus();
    expect(panel.onKey(key("Enter"))).toBe(true);
    expect(sent).toEqual([{ op: "put", slot: 3, kind: "stone" }]);
    expect(panel.onKey(key("Digit2"))).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("clicks: Put in / Put 1 on the held pocket name it; a click on another pocket only takes it in hand", () => {
    panel.update(model(2, 0)); // wood held (predicted), the server not there yet: the buttons name pocket 3 anyway
    const [put, putOne] = tile("pocket:2").all().filter((n) => n.tag === "button");
    expect(tile("pocket:0").all().some((n) => n.tag === "button")).toBe(false);
    putOne!.dispatch("click");
    put!.dispatch("click");
    expect(sent).toEqual([
      { op: "put", slot: 2, kind: "wood", count: 1 },
      { op: "put", slot: 2, kind: "wood" },
    ]);
    tile("pocket:3").dispatch("click");
    expect(selected).toEqual([3]);
    expect(sent).toHaveLength(2);
  });

  it("a mouse click on a tile's body moves nothing: the held pocket and the chest's tiles only focus", () => {
    panel.update(model());
    tile("pocket:0").dispatch("click");
    tile("chest:rope").dispatch("click");
    expect(sent).toEqual([]);
    expect(selected).toEqual([]);
  });

  it("a screen reader's activate (a click no pointer made) does what Enter does, as the tile's label says", () => {
    panel.update(model());
    tile("pocket:2").dispatch("click", { detail: 0, isTrusted: true, pointerType: "" }); // Chromium / Safari
    tile("pocket:0").dispatch("click", { detail: 0, isTrusted: true });
    tile("chest:rope").dispatch("click", { detail: 0, isTrusted: true, pointerType: "" });
    tile("pocket:3").dispatch("click", { detail: 1, isTrusted: true, mozInputSource: 0 }); // NVDA / JAWS + Firefox
    tile("pocket:1").dispatch("click", { detail: 0, isTrusted: true }); // empty: nothing to put
    expect(sent).toEqual([
      { op: "put", slot: 2, kind: "wood" },
      { op: "put", slot: 0, kind: "axe" },
      { op: "take", kind: "rope" },
      { op: "put", slot: 3, kind: "stone" },
    ]);
    expect(selected).toEqual([]); // the pocket that isn't held went in, not into the hand
  });
});

describe("virtualClick", () => {
  it("no pointer behind it: detail 0 without a pointer type, or Firefox's unknown input source", () => {
    expect(virtualClick({ detail: 0, isTrusted: true })).toBe(true);
    expect(virtualClick({ detail: 0, isTrusted: false, pointerType: "" })).toBe(true); // a script's click()
    expect(virtualClick({ detail: 1, isTrusted: true, mozInputSource: 0 })).toBe(true);
  });

  it("a mouse, pen or touch click is not one", () => {
    expect(virtualClick({ detail: 1, isTrusted: true, pointerType: "mouse" })).toBe(false);
    expect(virtualClick({ detail: 2, isTrusted: true })).toBe(false);
    expect(virtualClick({ detail: 1, isTrusted: true, pointerType: "touch", mozInputSource: 5 })).toBe(false);
    expect(virtualClick({ detail: 0, isTrusted: true, pointerType: "pen" })).toBe(false);
    expect(virtualClick({ detail: 1, isTrusted: false, mozInputSource: 0 })).toBe(false); // untrusted, a real detail
  });
});

describe("slotOfKey", () => {
  it("standard preset: 1–4 (row and numpad) put pockets 1–4, nothing else does", () => {
    expect(slotOfKey("Digit1", "standard")).toBe(0);
    expect(slotOfKey("Digit4", "standard")).toBe(3);
    expect(slotOfKey("Numpad2", "standard")).toBe(1);
    expect(slotOfKey("Digit5", "standard")).toBe(-1);
    expect(slotOfKey("KeyE", "standard")).toBe(-1);
  });

  it("left-handed preset: 7–0 are the slot keys, the plain digits 1–4 still work", () => {
    expect(slotOfKey("Digit7", "leftHanded")).toBe(0);
    expect(slotOfKey("Digit0", "leftHanded")).toBe(3);
    expect(slotOfKey("Digit1", "leftHanded")).toBe(0);
    expect(slotOfKey("Digit7", "standard")).toBe(-1);
    expect(slotOfKey("KeyU", "leftHanded")).toBe(-1);
  });
});
