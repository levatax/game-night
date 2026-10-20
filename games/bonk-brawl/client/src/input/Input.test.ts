// Input sampling, latching, look and pointer-lock behavior on a minimal DOM shim (node env).
// Owner: client-app.  Run: npx vitest run games/bonk-brawl/client/src/input

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
  constructor(private readonly doc: FakeDocument) {
    super();
  }
  requestPointerLock(): Promise<void> {
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
const mouse = (type: "mousedown" | "mouseup", button: number): Event => fire(doc, type, { button });

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
  for (const name of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement"]) {
    vi.stubGlobal(name, class {});
  }
  target = new FakeTarget(doc);
  input = new Input(target as unknown as HTMLElement);
  input.setInGame(true);
  input.setEnabled(true);
  input.requestPointerLock();
});

afterEach(() => {
  input.dispose();
  vi.unstubAllGlobals();
});

describe("Input.sample", () => {
  it("normalizes diagonal WASD and is camera-relative (x right, z forward)", () => {
    key("keydown", "KeyW");
    key("keydown", "KeyD");
    const cmd = input.sample(1);
    expect(cmd.moveX).toBeCloseTo(Math.SQRT1_2);
    expect(cmd.moveZ).toBeCloseTo(Math.SQRT1_2);
    key("keyup", "KeyW");
    key("keydown", "KeyA");
    expect(input.sample(2)).toMatchObject({ moveX: 0, moveZ: 0 });
  });

  it("turns a click shorter than a tick into a one-tick throw", () => {
    mouse("mousedown", 0);
    mouse("mouseup", 0);
    expect(input.sample(1).buttons & BTN.THROW).toBe(BTN.THROW);
    expect(input.sample(2).buttons & BTN.THROW).toBe(0);
  });

  it("holds THROW as a level while LMB is down", () => {
    mouse("mousedown", 0);
    expect(input.sample(1).buttons & BTN.THROW).toBe(BTN.THROW);
    expect(input.sample(2).buttons & BTN.THROW).toBe(BTN.THROW);
    expect(input.throwHeld).toBe(true);
  });

  it("latches edge buttons for exactly one sample", () => {
    key("keydown", "Space");
    key("keydown", "ShiftLeft");
    key("keydown", "KeyE");
    const rmb = mouse("mousedown", 2);
    expect(rmb.defaultPrevented).toBe(true);
    const buttons = input.sample(1).buttons;
    expect(buttons & (BTN.JUMP | BTN.ROLL | BTN.ABILITY | BTN.CATCH)).toBe(BTN.JUMP | BTN.ROLL | BTN.ABILITY | BTN.CATCH);
    expect(input.sample(2).buttons).toBe(0);
    // Key auto-repeat never re-latches.
    key("keydown", "Space", true);
    expect(input.sample(3).buttons & BTN.JUMP).toBe(0);
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
  });
});

describe("Input lifecycle", () => {
  it("losing pointer lock mid-game opens the menu and releases keys", () => {
    const menu = vi.fn();
    input.events.on("menu", menu);
    key("keydown", "KeyW");
    doc.exitPointerLock();
    expect(menu).toHaveBeenCalledTimes(1);
    expect(input.pointerLocked).toBe(false);
    input.requestPointerLock();
    expect(input.sample(1).moveZ).toBe(0);
  });

  it("releases everything on window blur", () => {
    key("keydown", "KeyS");
    mouse("mousedown", 0);
    fire(win, "blur");
    expect(input.sample(1)).toMatchObject({ moveZ: 0, buttons: 0 });
  });

  it("Tab holds the scoreboard only in game and prevents focus moves", () => {
    const board = vi.fn();
    input.events.on("scoreboard", board);
    const down = key("keydown", "Tab");
    expect(down.defaultPrevented).toBe(true);
    key("keyup", "Tab");
    expect(board.mock.calls.map((c) => c[0])).toEqual([{ open: true }, { open: false }]);
    input.setInGame(false);
    expect(key("keydown", "Tab").defaultPrevented).toBe(false);
  });

  it("Q asks for an emote; ghost move uses Space/Shift for up/down", () => {
    const emote = vi.fn();
    input.events.on("emote", emote);
    key("keydown", "KeyQ");
    expect(emote).toHaveBeenCalledTimes(1);
    key("keydown", "Space");
    expect(input.ghostMove()).toMatchObject({ x: 0, y: 1, z: 0 });
  });
});
