// Input accessibility paths on the same minimal DOM shim as Input.test.ts (node env): Tab inside panels, the chest
// panel's slot switch, the left-handed preset, mouse lock off (drag-look), the keyboard drag-look fallback, the
// drag-look left button (click / hold / look) and learned key caps. Owner: client-app.
// Run: npx vitest run games/raft-rush/client/src/input

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BTN } from "../../../shared/protocol";
import { SettingsStore } from "../app/settings";
import { keyCap, resetKeyCaps } from "./bindings";
import { Input } from "./Input";

interface FakeDocument extends EventTarget {
  pointerLockElement: EventTarget | null;
  hidden: boolean;
  exitPointerLock(): void;
}

class FakeTarget extends EventTarget {
  refuse = false;
  requests = 0;
  constructor(private readonly doc: FakeDocument) {
    super();
  }
  requestPointerLock(): Promise<void> {
    this.requests++;
    if (this.refuse) {
      this.doc.dispatchEvent(new Event("pointerlockerror"));
      return Promise.reject(new Error("refused"));
    }
    this.doc.pointerLockElement = this;
    this.doc.dispatchEvent(new Event("pointerlockchange"));
    return Promise.resolve();
  }
  contains(node: unknown): boolean {
    return node === this;
  }
}

let doc: FakeDocument;
let win: EventTarget;
let target: FakeTarget;
let store: SettingsStore;
let input: Input;

function fire(on: EventTarget, type: string, props: Record<string, unknown> = {}): Event {
  const ev = Object.assign(new Event(type, { cancelable: true }), props);
  on.dispatchEvent(ev);
  return ev;
}

const key = (type: "keydown" | "keyup", code: string, props: Record<string, unknown> = {}): Event => fire(win, type, { code, repeat: false, ...props });
const tap = (code: string): void => {
  key("keydown", code);
  key("keyup", code);
};

function userUnlock(): void {
  doc.pointerLockElement = null;
  doc.dispatchEvent(new Event("pointerlockchange"));
}

/** A press / release on the game surface (the listener sits on the document). */
function mouse(type: "mousedown" | "mouseup", button: number): void {
  const ev = Object.assign(new Event(type, { cancelable: true }), { button, clientX: 0, clientY: 0, buttons: type === "mousedown" ? 1 : 0 });
  Object.defineProperty(ev, "target", { value: target });
  doc.dispatchEvent(ev);
}

beforeEach(() => {
  doc = Object.assign(new EventTarget(), {
    pointerLockElement: null as EventTarget | null,
    hidden: false,
    exitPointerLock(this: FakeDocument) {
      this.pointerLockElement = null;
      this.dispatchEvent(new Event("pointerlockchange"));
    },
  });
  win = new EventTarget();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  target = new FakeTarget(doc);
  store = new SettingsStore("raft-rush.input-access-test");
  input = new Input(target as unknown as HTMLElement, store);
  input.setInGame(true);
  input.setEnabled(true);
  input.requestPointerLock();
});

afterEach(() => {
  input.dispose();
  resetKeyCaps();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Input with a panel open", () => {
  it("Tab moves the focus (no stats table, not prevented) in the craft / chest panel and in menus", () => {
    const board = vi.fn();
    input.events.on("scoreboard", board);
    input.setCapture("panel");
    expect(key("keydown", "Tab").defaultPrevented).toBe(false);
    key("keyup", "Tab");
    input.setCapture("full");
    expect(key("keydown", "Tab").defaultPrevented).toBe(false);
    expect(board).not.toHaveBeenCalled();
  });

  it("selectSlot rides the next sample while the chest panel captures, nothing else does", () => {
    input.setCapture("panel");
    tap("Digit3"); // a digit typed in the panel is the UI's business, not a slot switch
    expect(input.sample(1).buttons).toBe(0);
    input.selectSlot(2);
    expect(input.sample(2).buttons).toBe(BTN.SLOT3);
    expect(input.sample(3).buttons).toBe(0);
    input.selectSlot(7); // no such slot
    expect(input.sample(4).buttons).toBe(0);
  });

  it("selectSlot does nothing while a menu owns the input", () => {
    input.setCapture("full");
    input.selectSlot(0);
    input.setCapture("none");
    input.requestPointerLock();
    expect(input.sample(1).buttons).toBe(0);
  });
});

describe("Input key presets", () => {
  it("left-handed: IJKL walks, U interacts, H eats, O tosses, 7–0 pick slots, P is the guide; WASD / E / F are free", () => {
    store.set({ keyPreset: "leftHanded" });
    input.requestPointerLock();
    key("keydown", "KeyI");
    key("keydown", "KeyL");
    const walk = input.sample(1);
    expect(walk.moveZ).toBeCloseTo(Math.SQRT1_2);
    expect(walk.moveX).toBeCloseTo(Math.SQRT1_2);
    key("keyup", "KeyI");
    key("keyup", "KeyL");
    tap("KeyU");
    tap("KeyH");
    tap("KeyO");
    tap("Digit0");
    expect(input.sample(2).buttons).toBe(BTN.INTERACT | BTN.INTERACT_PRESS | BTN.EAT | BTN.DROP | BTN.SLOT4);
    tap("KeyW");
    tap("KeyE");
    tap("KeyF");
    tap("Digit1");
    expect(input.sample(3)).toMatchObject({ moveZ: 0, buttons: 0 });
    const legend = vi.fn();
    input.events.on("legend", legend);
    tap("KeyP");
    expect(legend.mock.calls.map((c) => c[0])).toEqual([{ open: true }, { open: false }]);
  });

  it("the panel-close key follows the preset", () => {
    const panelKey = vi.fn();
    input.events.on("panelKey", panelKey);
    store.set({ keyPreset: "leftHanded" });
    input.setCapture("panel");
    tap("KeyE");
    expect(panelKey).not.toHaveBeenCalled();
    tap("KeyU");
    expect(panelKey).toHaveBeenCalledTimes(1);
  });

  it("a preset change releases the keys held under the old one", () => {
    key("keydown", "KeyW");
    store.set({ keyPreset: "leftHanded" });
    expect(input.sample(1).moveZ).toBe(0);
  });
});

describe("Input mouse lock", () => {
  it("mouse lock off plays with drag-look and never asks the browser for a lock", () => {
    userUnlock();
    store.set({ mouseLock: false });
    const before = target.requests;
    input.requestPointerLock();
    expect(target.requests).toBe(before);
    expect(input.dragLook).toBe(true);
    key("keydown", "KeyW");
    expect(input.sample(1).moveZ).toBe(1);
  });

  it("a refused lock after Enter (the veil's Play) falls back to drag-look; after Esc it keeps the veil", () => {
    userUnlock();
    target.refuse = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let t = 1e9;
    vi.spyOn(performance, "now").mockImplementation(() => t);
    key("keydown", "Escape");
    input.requestPointerLock();
    expect(input.pointerLocked).toBe(false);
    t += 100;
    key("keydown", "Enter");
    input.requestPointerLock();
    expect(input.dragLook).toBe(true);
    expect(input.pointerLocked).toBe(true);
  });
});

describe("Input drag-look left button (trackpads)", () => {
  const USE = BTN.THROW | BTN.USE_PRESS;
  let t = 1e9;

  beforeEach(() => {
    userUnlock();
    store.set({ mouseLock: false });
    vi.spyOn(performance, "now").mockImplementation(() => t);
    input.requestPointerLock();
    expect(input.dragLook).toBe(true);
  });

  it("a left drag only looks: no use, no charge, nothing on release", () => {
    const yaw = input.yaw;
    mouse("mousedown", 0);
    expect(input.sample(1).buttons & USE).toBe(0);
    t += 50;
    fire(doc, "mousemove", { movementX: 30, movementY: 0, buttons: 1, clientX: 30, clientY: 0 });
    expect(input.yaw).toBeLessThan(yaw);
    t += 500; // a long look is still a look
    expect(input.sample(2).buttons & USE).toBe(0);
    expect(input.throwHeld).toBe(false);
    mouse("mouseup", 0);
    expect(input.sample(3).buttons & USE).toBe(0);
  });

  it("a click without a drag uses once on release (THROW for one tick)", () => {
    mouse("mousedown", 0);
    t += 80;
    expect(input.sample(1).buttons & USE).toBe(0);
    mouse("mouseup", 0);
    expect(input.sample(2).buttons & USE).toBe(USE);
    expect(input.sample(3).buttons & USE).toBe(0);
  });

  it("a press held still is a hold: it uses and charges, and a drag then aims while it stays held", () => {
    mouse("mousedown", 0);
    t += 250;
    expect(input.sample(1).buttons & USE).toBe(USE);
    expect(input.sample(2).buttons & USE).toBe(BTN.THROW);
    const yaw = input.yaw;
    fire(doc, "mousemove", { movementX: 30, movementY: 0, buttons: 1, clientX: 30, clientY: 0 });
    expect(input.yaw).toBeLessThan(yaw);
    expect(input.sample(3).buttons & USE).toBe(BTN.THROW);
    mouse("mouseup", 0);
    expect(input.sample(4).buttons & USE).toBe(0);
  });

  it("under a real lock the left button still acts on the press", () => {
    input.exitPointerLock();
    store.set({ mouseLock: true });
    input.requestPointerLock();
    expect(input.dragLook).toBe(false);
    mouse("mousedown", 0);
    expect(input.sample(1).buttons & USE).toBe(USE);
    mouse("mouseup", 0);
  });
});

describe("Input key caps", () => {
  it("learns what a letter key types (AZERTY's KeyW is Z), not with Shift held, never digits", () => {
    expect(keyCap("KeyW")).toBe("W");
    key("keydown", "KeyW", { key: "z" });
    expect(keyCap("KeyW")).toBe("Z");
    key("keydown", "KeyQ", { key: "A", shiftKey: true });
    expect(keyCap("KeyQ")).toBe("Q");
    key("keydown", "Digit1", { key: "&" });
    expect(keyCap("Digit1")).toBe("1");
  });
});
