// Key presets and printed key caps (input/bindings.ts). Owner: client-app.
// Run: npx vitest run games/raft-rush/client/src/input

import { afterEach, describe, expect, it, vi } from "vitest";
import { BTN } from "../../../shared/protocol";
import {
  bindingFor,
  bindingsFor,
  codesFor,
  KEY_BINDINGS,
  keyCap,
  keyCapsVersion,
  learnKeyCap,
  loadKeyboardLayout,
  onKeyCapsChange,
  resetKeyCaps,
  type KeyAction,
} from "./bindings";

const ACTIONS: KeyAction[] = ["forward", "left", "back", "right", "jump", "sprint", "interact", "eat", "toss", "slot1", "slot2", "slot3", "slot4", "slot5", "slot6", "ping", "emote", "legend", "stats", "mute"];

afterEach(() => resetKeyCaps());

describe("key presets", () => {
  it("the standard preset is the game4.md §15 layout", () => {
    expect(KEY_BINDINGS).toBe(bindingsFor("standard"));
    expect(KEY_BINDINGS.KeyW).toEqual({ move: "forward" });
    expect(KEY_BINDINGS.ArrowLeft).toEqual({ move: "left" });
    expect(KEY_BINDINGS.KeyE).toEqual({ level: "interact", edge: BTN.INTERACT_PRESS });
    expect(KEY_BINDINGS.KeyF).toEqual({ edge: BTN.EAT });
    expect(KEY_BINDINGS.KeyQ).toEqual({ edge: BTN.DROP });
    expect(KEY_BINDINGS.Numpad4).toEqual({ digit: 4 });
    expect(KEY_BINDINGS.Tab).toEqual({ hotkey: "scoreboard" });
    expect(KEY_BINDINGS.KeyM).toEqual({ hotkey: "mute" });
  });

  it("left-handed moves the cluster under the right hand and keeps arrows, Space, Shift, numpad, Tab and M", () => {
    expect(bindingFor("KeyI", "leftHanded")).toEqual({ move: "forward" });
    expect(bindingFor("KeyU", "leftHanded")?.level).toBe("interact");
    expect(bindingFor("KeyH", "leftHanded")?.edge).toBe(BTN.EAT);
    expect(bindingFor("Digit7", "leftHanded")?.digit).toBe(1);
    expect(bindingFor("Equal", "leftHanded")?.digit).toBe(6);
    expect(bindingFor("KeyW", "leftHanded")).toBeUndefined();
    for (const code of ["ArrowUp", "Space", "ShiftLeft", "ShiftRight", "Numpad1", "Tab", "KeyM"]) {
      expect(bindingFor(code, "leftHanded"), code).toEqual(bindingFor(code, "standard"));
    }
  });

  it("every action has a key in both presets and no key does two things", () => {
    for (const preset of ["standard", "leftHanded"] as const) {
      const seen = new Map<string, KeyAction>();
      for (const action of ACTIONS) {
        const codes = codesFor(action, preset);
        expect(codes.length, `${preset} ${action}`).toBeGreaterThan(0);
        for (const code of codes) {
          expect(seen.get(code), `${preset}: ${code} is ${seen.get(code)} and ${action}`).toBeUndefined();
          seen.set(code, action);
        }
      }
      expect(Object.keys(bindingsFor(preset)).sort()).toEqual([...seen.keys()].sort());
    }
  });
});

describe("key caps", () => {
  it("defaults to the US QWERTY caps", () => {
    expect(keyCap("KeyE")).toBe("E");
    expect(keyCap("Digit7")).toBe("7");
    expect(keyCap("Numpad2")).toBe("Num 2");
    expect(keyCap("ShiftLeft")).toBe("Shift");
    expect(keyCap("Backslash")).toBe("\\");
  });

  it("learns printable letters and punctuation, upper-cased, and bumps the version only on a change", () => {
    const v0 = keyCapsVersion();
    expect(learnKeyCap("KeyQ", "a")).toBe(true); // AZERTY
    expect(keyCap("KeyQ")).toBe("A");
    expect(learnKeyCap("KeyQ", "a")).toBe(false);
    expect(learnKeyCap("KeyE", "e")).toBe(false); // same as the default cap
    expect(keyCapsVersion()).toBe(v0 + 1);
    expect(learnKeyCap("Semicolon", "ş")).toBe(true); // Turkish Q
    expect(keyCap("Semicolon")).toBe("Ş");
  });

  it("ignores digits, dead keys, spaces and multi-character keys", () => {
    expect(learnKeyCap("Digit1", "&")).toBe(false);
    expect(learnKeyCap("KeyE", "Dead")).toBe(false);
    expect(learnKeyCap("Space", " ")).toBe(false);
    expect(learnKeyCap("KeyW", " ")).toBe(false);
    expect(keyCap("KeyW")).toBe("W");
  });

  it("prints a Turkish dotted i as İ, except on KeyI (a US board typing i)", () => {
    learnKeyCap("Quote", "i");
    learnKeyCap("KeyI", "ı");
    expect(keyCap("Quote")).toBe("İ");
    expect(keyCap("KeyI")).toBe("I");
    resetKeyCaps();
    learnKeyCap("KeyI", "i");
    expect(keyCap("KeyI")).toBe("I");
  });

  it("reads navigator.keyboard.getLayoutMap() where the browser has it", async () => {
    const layout = new Map([
      ["KeyW", "z"],
      ["KeyA", "q"],
      ["Digit1", "&"],
    ]);
    const nav = { keyboard: { getLayoutMap: async () => layout } };
    expect(await loadKeyboardLayout(nav)).toBe(true);
    expect([keyCap("KeyW"), keyCap("KeyA"), keyCap("KeyS"), keyCap("Digit1")]).toEqual(["Z", "Q", "S", "1"]);
    expect(await loadKeyboardLayout({})).toBe(false);
    expect(await loadKeyboardLayout({ keyboard: { getLayoutMap: () => Promise.reject(new Error("denied")) } })).toBe(false);
  });

  it("tells onKeyCapsChange listeners about a change: once per learned key, once for a whole layout map", async () => {
    let calls = 0;
    const off = onKeyCapsChange(() => calls++);
    expect(learnKeyCap("KeyQ", "a")).toBe(true);
    expect(learnKeyCap("KeyQ", "a")).toBe(false);
    expect(calls).toBe(1);
    const azerty = new Map([
      ["KeyW", "z"],
      ["KeyA", "q"],
      ["KeyQ", "a"],
    ]);
    expect(await loadKeyboardLayout({ keyboard: { getLayoutMap: async () => azerty } })).toBe(true);
    expect(calls).toBe(2);
    expect(await loadKeyboardLayout({ keyboard: { getLayoutMap: async () => azerty } })).toBe(false); // nothing new
    expect(calls).toBe(2);
    resetKeyCaps();
    expect(calls).toBe(3);
    resetKeyCaps(); // already the defaults
    expect(calls).toBe(3);
    off();
    learnKeyCap("KeyW", "z");
    expect(calls).toBe(3);
  });

  it("a throwing listener neither stops the others nor the learning", async () => {
    const seen: string[] = [];
    const offs = [
      onKeyCapsChange(() => {
        throw new Error("boom");
      }),
      onKeyCapsChange(() => seen.push(keyCap("KeyW"))),
    ];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await loadKeyboardLayout({ keyboard: { getLayoutMap: async () => new Map([["KeyW", "z"]]) } })).toBe(true);
      expect(learnKeyCap("KeyA", "q")).toBe(true);
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
      for (const off of offs) off();
    }
    expect(seen).toEqual(["Z", "Z"]);
    expect(keyCap("KeyA")).toBe("Q");
  });
});
