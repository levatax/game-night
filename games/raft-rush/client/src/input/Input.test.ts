// Input sampling, edge latching, level bits, slots, chords, capture gating and pointer-lock behavior on a
// minimal DOM shim (node env). Owner: client-app.  Run: npx vitest run games/raft-rush/client/src/input

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PITCH_LIMIT } from "../../../shared/constants";
import { BTN } from "../../../shared/protocol";
import { MOUSE_RADIANS_PER_PIXEL } from "../app/settings";
import { Input } from "./Input";

interface FakeDocument extends EventTarget {
  pointerLockElement: EventTarget | null;
  hidden: boolean;
  exitPointerLock(): void;
}

class FakeTarget extends EventTarget {
  refuse = false;
  constructor(private readonly doc: FakeDocument) {
    super();
  }
  requestPointerLock(): Promise<void> {
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
let input: Input;

function fire(on: EventTarget, type: string, props: Record<string, unknown> = {}): Event {
  const ev = Object.assign(new Event(type, { cancelable: true }), props);
  on.dispatchEvent(ev);
  return ev;
}

const key = (type: "keydown" | "keyup", code: string, repeat = false): Event => fire(win, type, { code, repeat });
const tap = (code: string): void => {
  key("keydown", code);
  key("keyup", code);
};
const mouse = (type: "mousedown" | "mouseup", button: number, on: EventTarget = target): Event => {
  const ev = Object.assign(new Event(type, { cancelable: true, bubbles: true }), { button, clientX: 0, clientY: 0, buttons: type === "mousedown" ? 1 : 0 });
  // The listener sits on the document; the press "happened" on `on` (the game surface by default).
  Object.defineProperty(ev, "target", { value: on });
  doc.dispatchEvent(ev);
  return ev;
};
const wheel = (deltaY: number): Event => fire(win, "wheel", { deltaY, deltaMode: 0 });

/** User-initiated unlock (Esc / alt-tab): the browser drops the lock without our exitPointerLock(). */
function userUnlock(): void {
  doc.pointerLockElement = null;
  doc.dispatchEvent(new Event("pointerlockchange"));
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
  input = new Input(target as unknown as HTMLElement);
  input.setInGame(true);
  input.setEnabled(true);
  input.requestPointerLock();
});

afterEach(() => {
  input.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Input.sample: movement and level bits", () => {
  it("normalizes diagonal WASD and is camera-relative (x right, z forward)", () => {
    key("keydown", "KeyW");
    key("keydown", "KeyD");
    const cmd = input.sample(1);
    expect(cmd.seq).toBe(1);
    expect(cmd.moveX).toBeCloseTo(Math.SQRT1_2);
    expect(cmd.moveZ).toBeCloseTo(Math.SQRT1_2);
    key("keyup", "KeyW");
    key("keydown", "KeyA");
    expect(input.sample(2)).toMatchObject({ moveX: 0, moveZ: 0 });
  });

  it("holds THROW as a level while LMB is down, USE_PRESS only on the press tick", () => {
    mouse("mousedown", 0);
    const first = input.sample(1).buttons;
    expect(first & BTN.THROW).toBe(BTN.THROW);
    expect(first & BTN.USE_PRESS).toBe(BTN.USE_PRESS);
    const second = input.sample(2).buttons;
    expect(second & BTN.THROW).toBe(BTN.THROW);
    expect(second & BTN.USE_PRESS).toBe(0);
    expect(input.throwHeld).toBe(true);
    mouse("mouseup", 0);
    expect(input.sample(3).buttons & BTN.THROW).toBe(0);
  });

  it("turns a click shorter than a tick into a one-tick THROW + USE_PRESS", () => {
    mouse("mousedown", 0);
    mouse("mouseup", 0);
    expect(input.sample(1).buttons & (BTN.THROW | BTN.USE_PRESS)).toBe(BTN.THROW | BTN.USE_PRESS);
    expect(input.sample(2).buttons & (BTN.THROW | BTN.USE_PRESS)).toBe(0);
  });

  it("E is an INTERACT level plus an INTERACT_PRESS edge, and tells the app", () => {
    const interact = vi.fn();
    input.events.on("interact", interact);
    key("keydown", "KeyE");
    const a = input.sample(1).buttons;
    expect(a & (BTN.INTERACT | BTN.INTERACT_PRESS)).toBe(BTN.INTERACT | BTN.INTERACT_PRESS);
    key("keydown", "KeyE", true); // auto-repeat never re-latches
    const b = input.sample(2).buttons;
    expect(b & BTN.INTERACT).toBe(BTN.INTERACT);
    expect(b & BTN.INTERACT_PRESS).toBe(0);
    expect(interact).toHaveBeenCalledTimes(1);
    key("keyup", "KeyE");
    expect(input.sample(3).buttons & BTN.INTERACT).toBe(0);
  });

  it("a sub-tick E tap still sends INTERACT for one tick", () => {
    tap("KeyE");
    expect(input.sample(1).buttons & (BTN.INTERACT | BTN.INTERACT_PRESS)).toBe(BTN.INTERACT | BTN.INTERACT_PRESS);
    expect(input.sample(2).buttons).toBe(0);
  });

  it("Shift is a SPRINT level", () => {
    key("keydown", "ShiftLeft");
    expect(input.sample(1).buttons & BTN.SPRINT).toBe(BTN.SPRINT);
    expect(input.sample(2).buttons & BTN.SPRINT).toBe(BTN.SPRINT);
    key("keyup", "ShiftLeft");
    expect(input.sample(3).buttons & BTN.SPRINT).toBe(0);
  });
});

describe("Input.sample: edges", () => {
  it("latches Space / F / Q / RMB for exactly one sample", () => {
    key("keydown", "Space");
    key("keydown", "KeyF");
    key("keydown", "KeyQ");
    const rmb = mouse("mousedown", 2);
    expect(rmb.defaultPrevented).toBe(true);
    const edges = BTN.JUMP | BTN.EAT | BTN.DROP | BTN.CATCH;
    expect(input.sample(1).buttons & edges).toBe(edges);
    expect(input.sample(2).buttons).toBe(0);
    key("keydown", "Space", true);
    expect(input.sample(3).buttons & BTN.JUMP).toBe(0);
  });

  it("digits 1–4 latch SLOT1..SLOT4; 5 and 6 don't touch slots", () => {
    tap("Digit1");
    expect(input.sample(1).buttons).toBe(BTN.SLOT1);
    tap("Digit4");
    tap("Numpad2");
    expect(input.sample(2).buttons).toBe(BTN.SLOT4 | BTN.SLOT2);
    tap("Digit5");
    tap("Digit6");
    expect(input.sample(3).buttons).toBe(0);
  });

  it("the wheel steps slots: one notch = one step, trackpad deltas accumulate", () => {
    wheel(100);
    expect(input.sample(1).buttons).toBe(BTN.SLOT_NEXT);
    wheel(-120);
    expect(input.sample(2).buttons).toBe(BTN.SLOT_PREV);
    wheel(10);
    wheel(10);
    expect(input.sample(3).buttons).toBe(0);
    wheel(25);
    expect(input.sample(4).buttons).toBe(BTN.SLOT_NEXT);
  });

  it("the middle button opens the ping wheel instead of a button bit", () => {
    const ping = vi.fn();
    input.events.on("pingWheel", ping);
    const ev = mouse("mousedown", 1);
    expect(ev.defaultPrevented).toBe(true);
    tap("KeyV");
    expect(ping).toHaveBeenCalledTimes(2);
    expect(input.sample(1).buttons).toBe(0);
  });
});

describe("Input wheels", () => {
  it("T opens the emote wheel and, with the wheel capturing, closes it; digits the UI left go to wheelPick", () => {
    const wheelEv = vi.fn();
    const pick = vi.fn();
    input.events.on("emoteWheel", wheelEv);
    input.events.on("wheelPick", pick);
    key("keydown", "KeyT");
    expect(wheelEv).toHaveBeenLastCalledWith({ open: true });
    expect(input.sample(1).buttons).toBe(0);
    input.setCapture("full");
    expect(input.pointerLocked).toBe(false);
    tap("Digit6");
    expect(pick).toHaveBeenCalledWith({ index: 5 });
    tap("KeyT");
    expect(wheelEv).toHaveBeenLastCalledWith({ open: false });
  });
});

describe("Input capture gating", () => {
  it("panel: only WASD walks, E closes the panel, the pointer is released without a menu", () => {
    const menu = vi.fn();
    const panelKey = vi.fn();
    input.events.on("menu", menu);
    input.events.on("panelKey", panelKey);
    key("keydown", "KeyW");
    input.setCapture("panel");
    expect(input.pointerLocked).toBe(false);
    expect(menu).not.toHaveBeenCalled();
    key("keydown", "Space");
    mouse("mousedown", 0);
    tap("KeyE");
    const cmd = input.sample(1);
    expect(cmd.moveZ).toBe(1); // W kept walking through the capture
    expect(cmd.buttons).toBe(0);
    expect(panelKey).toHaveBeenCalledTimes(1);
  });

  it("full: nothing samples, digits pick wheel slices, Esc reports the capture", () => {
    const pick = vi.fn();
    const menu = vi.fn();
    input.events.on("wheelPick", pick);
    input.events.on("menu", menu);
    input.setCapture("full");
    key("keydown", "KeyW");
    tap("Digit3");
    key("keydown", "KeyE");
    expect(input.sample(1)).toMatchObject({ moveX: 0, moveZ: 0, buttons: 0 });
    expect(pick).toHaveBeenCalledWith({ index: 2 });
    key("keydown", "Escape");
    expect(menu).toHaveBeenCalledWith({ captured: true });
  });

  it("back to none: input flows again once the pointer is re-locked", () => {
    input.setCapture("full");
    input.setCapture("none");
    expect(input.sample(1).buttons).toBe(0);
    input.requestPointerLock();
    key("keydown", "KeyW");
    expect(input.sample(2).moveZ).toBe(1);
  });

  it("sends nothing while disabled or unlocked, but keeps the look", () => {
    input.setLook(1, 0.2);
    key("keydown", "KeyW");
    input.setEnabled(false);
    expect(input.sample(1)).toMatchObject({ moveX: 0, moveZ: 0, buttons: 0, yaw: 1, pitch: 0.2 });
    input.setEnabled(true);
    expect(input.sample(2).moveZ).toBe(0); // held keys were released on disable
  });
});

describe("Input look", () => {
  it("applies sensitivity, invert Y and the pitch clamp", () => {
    input.configure({ sensitivity: 2, invertY: false });
    fire(doc, "mousemove", { movementX: 100, movementY: 0 });
    expect(input.yaw).toBeCloseTo(-100 * MOUSE_RADIANS_PER_PIXEL * 2);
    fire(doc, "mousemove", { movementX: 0, movementY: -10 });
    expect(input.pitch).toBeGreaterThan(0);
    input.configure({ sensitivity: 2, invertY: true });
    fire(doc, "mousemove", { movementX: 0, movementY: -10 });
    expect(input.pitch).toBeCloseTo(0);
    for (let i = 0; i < 20; i++) fire(doc, "mousemove", { movementX: 0, movementY: 300 });
    expect(input.pitch).toBeCloseTo(PITCH_LIMIT);
    expect(input.look).toEqual({ yaw: input.yaw, pitch: input.pitch });
  });

  it("falls back to drag-look when a click's lock request is refused", () => {
    userUnlock();
    target.refuse = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Pretend the unlock happened long ago (no re-lock cooldown).
    vi.spyOn(performance, "now").mockReturnValue(1e9);
    fire(target, "click");
    expect(input.dragLook).toBe(true);
    expect(input.pointerLocked).toBe(true);
    const before = input.yaw;
    fire(doc, "mousemove", { movementX: 50, movementY: 0, buttons: 0 });
    expect(input.yaw).toBe(before); // a plain move doesn't look
    mouse("mousedown", 2);
    fire(doc, "mousemove", { movementX: 50, movementY: 0, buttons: 2, clientX: 50, clientY: 0 });
    expect(input.yaw).toBeLessThan(before);
    vi.restoreAllMocks();
  });
});

describe("Input spectator free look", () => {
  it("washed with the lock still held: the mouse steers the free look, not the player's look", () => {
    input.setEnabled(false);
    const yaw = input.yaw;
    fire(doc, "mousemove", { movementX: 10, movementY: -5 });
    const free = input.takeFreeLook();
    expect(free.yaw).toBeCloseTo(-10 * MOUSE_RADIANS_PER_PIXEL);
    expect(free.pitch).toBeCloseTo(5 * MOUSE_RADIANS_PER_PIXEL);
    expect(input.yaw).toBe(yaw);
    expect(input.takeFreeLook()).toEqual({ yaw: 0, pitch: 0, cycle: 0 });
  });

  it("unlocked: dragging on the game surface looks, a click or Space follows the next teammate, RMB the previous", () => {
    input.setEnabled(false);
    userUnlock();
    mouse("mousedown", 0);
    mouse("mouseup", 0);
    expect(input.takeFreeLook().cycle).toBe(1);
    mouse("mousedown", 2);
    mouse("mouseup", 2);
    expect(input.takeFreeLook().cycle).toBe(-1);
    expect(key("keydown", "Space").defaultPrevented).toBe(true);
    key("keydown", "Space", true);
    expect(input.takeFreeLook().cycle).toBe(1);
    // A drag past the slop looks around and is not a click.
    mouse("mousedown", 0);
    fire(doc, "mousemove", { movementX: 2, movementY: 0, buttons: 1, clientX: 2, clientY: 0 });
    expect(input.takeFreeLook().yaw).toBe(0); // jitter inside the slop
    fire(doc, "mousemove", { movementX: 30, movementY: 0, buttons: 1, clientX: 32, clientY: 0 });
    mouse("mouseup", 0);
    const free = input.takeFreeLook();
    expect(free.yaw).toBeCloseTo(-30 * MOUSE_RADIANS_PER_PIXEL);
    expect(free.cycle).toBe(0);
    // A press on a UI widget is not a spectator click.
    mouse("mousedown", 0, new EventTarget());
    mouse("mouseup", 0);
    expect(input.takeFreeLook().cycle).toBe(0);
    expect(input.sample(1).buttons).toBe(0);
  });

  it("collects nothing while playing, captured or out of the game", () => {
    fire(doc, "mousemove", { movementX: 10, movementY: 0 });
    key("keydown", "Space");
    expect(input.takeFreeLook()).toEqual({ yaw: 0, pitch: 0, cycle: 0 });
    input.setEnabled(false);
    input.setCapture("full");
    fire(doc, "mousemove", { movementX: 10, movementY: 0 });
    expect(input.takeFreeLook().yaw).toBe(0);
    input.setCapture("none");
    input.setInGame(false);
    mouse("mousedown", 0);
    mouse("mouseup", 0);
    expect(input.takeFreeLook().cycle).toBe(0);
  });
});

describe("Input lifecycle", () => {
  it("losing pointer lock mid-game opens the menu and releases keys", () => {
    const menu = vi.fn();
    input.events.on("menu", menu);
    key("keydown", "KeyW");
    userUnlock();
    expect(menu).toHaveBeenCalledWith({ captured: false });
    expect(input.pointerLocked).toBe(false);
    input.requestPointerLock();
    expect(input.sample(1).moveZ).toBe(0);
  });

  it("releases everything on window blur", () => {
    key("keydown", "KeyS");
    mouse("mousedown", 0);
    fire(win, "blur");
    const cmd = input.sample(1);
    expect(cmd.moveZ).toBe(0);
    expect(cmd.buttons & BTN.THROW).toBe(0);
  });

  it("Tab and H are holds, only in game; M mutes anywhere", () => {
    const board = vi.fn();
    const legend = vi.fn();
    const mute = vi.fn();
    input.events.on("scoreboard", board);
    input.events.on("legend", legend);
    input.events.on("mute", mute);
    const down = key("keydown", "Tab");
    expect(down.defaultPrevented).toBe(true);
    key("keyup", "Tab");
    tap("KeyH");
    expect(board.mock.calls.map((c) => c[0])).toEqual([{ open: true }, { open: false }]);
    expect(legend.mock.calls.map((c) => c[0])).toEqual([{ open: true }, { open: false }]);
    input.setInGame(false);
    expect(key("keydown", "Tab").defaultPrevented).toBe(false);
    tap("KeyM");
    expect(mute).toHaveBeenCalledTimes(1);
  });
});
