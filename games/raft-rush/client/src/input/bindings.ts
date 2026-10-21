// Key bindings (game4.md §15 + docs/ARCHITECTURE.md §2.1), by KeyboardEvent.code so they're keyboard-layout
// independent (WASD stays under the left hand on a Turkish F or a French AZERTY keyboard too). Owner: client-app.
//
// Two presets (settings.keyPreset): "standard" (WASD, left hand on the keys) and "leftHanded" (IJKL with the
// action keys around it and 7–0 for the slots, for a mouse in the left hand). Arrows, Space, Shift, the numpad
// digits, Esc and M work in both. Since codes are physical, the only layout problem left is what the screen
// prints: keyCap(code) is the cap the player's keyboard really has (navigator.keyboard.getLayoutMap() where the
// browser has it, else learned from the keys the player presses, else the US QWERTY cap), so the HUD says ZQSD
// on AZERTY. Pure tables + that small cap cache; ui/controls.ts reads them for every printed key (logged in
// docs/CONTRACT_CHANGES.md: the UI may import this module), and onKeyCapsChange() tells a screen without a
// per-frame update (Home) when a cap changed, e.g. the layout map arriving after the first paint.

import { BTN } from "../../../shared/protocol";
import type { KeyPreset } from "../app/settings";

/** Movement keys tracked while held. */
export type MoveAction = "forward" | "back" | "left" | "right";

/** Gameplay level keys (held → bit set every sampled tick). */
export type LevelAction = "sprint" | "interact";

/** One-shot hotkeys handled by the app (not part of the InputCmd). */
export type HotkeyAction = "scoreboard" | "legend" | "pingWheel" | "emoteChord" | "mute";

export interface KeyBinding {
  move?: MoveAction;
  level?: LevelAction;
  /** Edge-triggered BTN bit latched on keydown until the next sample. */
  edge?: number;
  hotkey?: HotkeyAction;
  /** Digit 1–6 (slots 1–4, emotes with T held, wheel slices while a wheel is open). */
  digit?: number;
}

/** Every action the HUD, the legend and the coach print a key for. */
export type KeyAction =
  | MoveAction
  | "jump"
  | "sprint"
  | "interact"
  | "eat"
  | "toss"
  | "slot1"
  | "slot2"
  | "slot3"
  | "slot4"
  | "slot5"
  | "slot6"
  | "ping"
  | "emote"
  | "legend"
  | "stats"
  | "mute";

/** Codes per action; the first one is the key the screen prints. */
type PresetCodes = Readonly<Record<KeyAction, readonly string[]>>;

const PRESET_CODES: Readonly<Record<KeyPreset, PresetCodes>> = {
  standard: {
    forward: ["KeyW", "ArrowUp"],
    left: ["KeyA", "ArrowLeft"],
    back: ["KeyS", "ArrowDown"],
    right: ["KeyD", "ArrowRight"],
    jump: ["Space"],
    sprint: ["ShiftLeft", "ShiftRight"],
    // E: INTERACT level (hold to gather / revive) + INTERACT_PRESS edge (taps; panels open on the app side).
    interact: ["KeyE"],
    eat: ["KeyF"],
    toss: ["KeyQ"],
    slot1: ["Digit1", "Numpad1"],
    slot2: ["Digit2", "Numpad2"],
    slot3: ["Digit3", "Numpad3"],
    slot4: ["Digit4", "Numpad4"],
    slot5: ["Digit5", "Numpad5"],
    slot6: ["Digit6", "Numpad6"],
    ping: ["KeyV"],
    emote: ["KeyT"],
    legend: ["KeyH"],
    stats: ["Tab"],
    mute: ["KeyM"],
  },
  // The standard layout moved under the right hand: U / O sit where Q / E sit around W, H beside J like F beside
  // D, 7–0 above the cluster like 1–4, N / Y / P for ping / emote / guide. Backslash (right pinky) or Tab = stats.
  leftHanded: {
    forward: ["KeyI", "ArrowUp"],
    left: ["KeyJ", "ArrowLeft"],
    back: ["KeyK", "ArrowDown"],
    right: ["KeyL", "ArrowRight"],
    jump: ["Space"],
    sprint: ["ShiftRight", "ShiftLeft"],
    interact: ["KeyU"],
    eat: ["KeyH"],
    toss: ["KeyO"],
    slot1: ["Digit7", "Numpad1"],
    slot2: ["Digit8", "Numpad2"],
    slot3: ["Digit9", "Numpad3"],
    slot4: ["Digit0", "Numpad4"],
    slot5: ["Minus", "Numpad5"],
    slot6: ["Equal", "Numpad6"],
    ping: ["KeyN"],
    emote: ["KeyY"],
    legend: ["KeyP"],
    stats: ["Backslash", "Tab"],
    mute: ["KeyM"],
  },
};

const ACTION_BINDING: Readonly<Record<KeyAction, KeyBinding>> = {
  forward: { move: "forward" },
  left: { move: "left" },
  back: { move: "back" },
  right: { move: "right" },
  jump: { edge: BTN.JUMP },
  sprint: { level: "sprint" },
  interact: { level: "interact", edge: BTN.INTERACT_PRESS },
  eat: { edge: BTN.EAT },
  toss: { edge: BTN.DROP },
  slot1: { digit: 1 },
  slot2: { digit: 2 },
  slot3: { digit: 3 },
  slot4: { digit: 4 },
  slot5: { digit: 5 },
  slot6: { digit: 6 },
  ping: { hotkey: "pingWheel" },
  emote: { hotkey: "emoteChord" },
  legend: { hotkey: "legend" },
  stats: { hotkey: "scoreboard" },
  mute: { hotkey: "mute" },
};

function buildBindings(codes: PresetCodes): Readonly<Record<string, KeyBinding>> {
  const out: Record<string, KeyBinding> = {};
  for (const action of Object.keys(codes) as KeyAction[]) for (const code of codes[action]) out[code] = ACTION_BINDING[action];
  return out;
}

const PRESET_BINDINGS: Readonly<Record<KeyPreset, Readonly<Record<string, KeyBinding>>>> = {
  standard: buildBindings(PRESET_CODES.standard),
  leftHanded: buildBindings(PRESET_CODES.leftHanded),
};

/** The standard preset (code → binding). */
export const KEY_BINDINGS: Readonly<Record<string, KeyBinding>> = PRESET_BINDINGS.standard;

/** code → binding for a preset (unknown presets fall back to standard). */
export function bindingsFor(preset: KeyPreset): Readonly<Record<string, KeyBinding>> {
  return PRESET_BINDINGS[preset] ?? PRESET_BINDINGS.standard;
}

/** The binding of one key in a preset (undefined: the key does nothing in game). */
export function bindingFor(code: string, preset: KeyPreset): KeyBinding | undefined {
  return bindingsFor(preset)[code];
}

/** Every code bound to an action, the printed one first. */
export function codesFor(action: KeyAction, preset: KeyPreset): readonly string[] {
  return (PRESET_CODES[preset] ?? PRESET_CODES.standard)[action];
}

/** SLOT1..SLOT4 edge bit for digit 1..4 (0 for other digits). */
export function slotBit(digit: number): number {
  return digit === 1 ? BTN.SLOT1 : digit === 2 ? BTN.SLOT2 : digit === 3 ? BTN.SLOT3 : digit === 4 ? BTN.SLOT4 : 0;
}

/** Every slot edge bit (they also flow while the chest panel is open). */
export const SLOT_BITS = BTN.SLOT1 | BTN.SLOT2 | BTN.SLOT3 | BTN.SLOT4;

/* ============================================================== key caps */

/** Caps the US QWERTY board prints for the non-letter codes we bind. */
const QWERTY_CAPS: Readonly<Record<string, string>> = {
  Space: "Space",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  Tab: "Tab",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Minus: "-",
  Equal: "=",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  BracketLeft: "[",
  BracketRight: "]",
};

/**
 * Codes whose cap depends on the layout. Digits are left out on purpose: every layout prints the digit on the
 * number row, but its unshifted character differs (AZERTY's Digit1 types "&").
 */
const LAYOUT_CODE = /^(?:Key[A-Z]|Minus|Equal|Backslash|Semicolon|Quote|Comma|Period|Slash|BracketLeft|BracketRight)$/;

const layoutCaps = new Map<string, string>();
let capsVersion = 0;
const capsListeners = new Set<() => void>();
/** loadKeyboardLayout learns a whole map at once: the listeners hear about it once, after. */
let capsBatch = false;

function capsChanged(): void {
  capsVersion++;
  if (!capsBatch) notifyCaps();
}

function notifyCaps(): void {
  for (const fn of [...capsListeners]) {
    try {
      fn();
    } catch (err) {
      console.error("[bindings] key cap listener threw", err);
    }
  }
}

/**
 * Called after a printed cap changed (a pressed key taught one, the layout map arrived, a test reset): for screens
 * that print keys without a per-frame update (Home). Returns an unsubscribe function. Not called immediately.
 */
export function onKeyCapsChange(fn: () => void): () => void {
  capsListeners.add(fn);
  return () => capsListeners.delete(fn);
}

/** The cap printed on `code` for this player's keyboard ("Space" / "Shift" / "Tab" stay English: the UI translates). */
export function keyCap(code: string): string {
  const learned = layoutCaps.get(code);
  if (learned) return learned;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return QWERTY_CAPS[code] ?? code;
}

/** Bumped whenever a cap changed (the UI rebuilds printed key lists when it moved). */
export function keyCapsVersion(): number {
  return capsVersion;
}

/**
 * A key the player pressed (no modifiers, not a repeat): remember what it types as that key's cap. Returns true
 * when a printed cap changed.
 */
export function learnKeyCap(code: string, key: string): boolean {
  if (!LAYOUT_CODE.test(code) || typeof key !== "string" || [...key].length !== 1 || key.trim() === "") return false;
  // A dotted "i" typed by any key but KeyI comes from a Turkish board, whose cap reads "İ" ("ı" → "I" either way).
  const cap = key === "i" && code !== "KeyI" ? "İ" : key.toUpperCase();
  if (layoutCaps.get(code) === cap || (!layoutCaps.has(code) && keyCap(code) === cap)) return false;
  layoutCaps.set(code, cap);
  capsChanged();
  return true;
}

interface LayoutMapNavigator {
  keyboard?: { getLayoutMap?: () => Promise<{ forEach(fn: (key: string, code: string) => void): void }> };
}

/** Ask the browser for the real layout (Chromium: navigator.keyboard.getLayoutMap). Resolves false elsewhere. */
export async function loadKeyboardLayout(nav: LayoutMapNavigator | undefined = typeof navigator !== "undefined" ? (navigator as LayoutMapNavigator) : undefined): Promise<boolean> {
  const get = nav?.keyboard?.getLayoutMap;
  if (typeof get !== "function") return false;
  try {
    const map = await get.call(nav!.keyboard);
    let changed = false;
    capsBatch = true;
    try {
      map.forEach((key, code) => {
        if (learnKeyCap(code, key)) changed = true;
      });
    } finally {
      capsBatch = false;
    }
    if (changed) notifyCaps();
    return changed;
  } catch {
    return false;
  }
}

/** Forget learned caps (tests). */
export function resetKeyCaps(): void {
  if (layoutCaps.size === 0) return;
  layoutCaps.clear();
  capsChanged();
}

/* ================================================================ misc */

/** Mouse buttons (MouseEvent.button). */
export const MOUSE = { LEFT: 0, MIDDLE: 1, RIGHT: 2 } as const;

/** Wheel pixels (trackpads report many small deltas) that make one slot step. */
export const WHEEL_STEP_PX = 40;

/** Typing into a form field must never move the player or fire hotkeys. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement) return true;
  if (typeof HTMLSelectElement !== "undefined" && target instanceof HTMLSelectElement) return true;
  if (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement) {
    const type = target.type;
    return type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit" && type !== "range";
  }
  return false;
}
