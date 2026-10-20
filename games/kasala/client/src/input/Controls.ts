// Keyboard + mouse → game actions (§12). Owner: client-net-game. PUBLIC API IS THE CONTRACT.
//
// Space → flip · Enter → cash · 1–4 → box (BET_BOXES order) · 0 → PAS (no bet this turn) · Q/W/E → chip
// 10/25/50 · B → loans · T held + 1–6 → emote (tap T alone → picker "emote", T again / Esc closes) · Y held +
// 1–8 → taunt (tap Y → picker "taunt") · Z / X → heckle "ÇEVİR!" / "KASALA!" at the active player · V →
// first person / Masa view · H held → key legend · ←/→ → cycle the attack target · Tab down/up → scoreboard
// open/close (preventDefault) · Esc → escape · left click on the canvas → click (Game decides: pick a target)
// · left-drag (past the click slop) or right-drag on the canvas → look around (stage.orbit, which Stage
// routes to the first-person look) with no context menu. Ignore key repeats for one-shot actions. Ignore
// everything while the filter says so (typing in an input, overlay capturing keys) except Esc.
//
// Menus keep the keyboard: outside a match (setInMatch(false)) the table keys (Space/Enter/Tab/digits/
// chips/loans/heckles/arrows/H) are not handled at all, so the home and lobby screens get native button
// activation and Tab / arrow focus navigation. In a match the dialogs that need the keyboard (settings,
// loans, match end) block game keys through the filter; elsewhere a focused HUD / offer button is blurred
// and Space / Enter flip / cash.
//
// First person (setFirstPerson): with settings.mouseLock the first plain click on the canvas locks the
// pointer; while locked mouse movement looks around (stage.look(dx, dy, true)), a click aims at the screen
// center, and Esc / window blur / a modal or picker capturing keys unlocks (that Esc only unlocks, it doesn't
// open the settings). `aim` is the screen center while locked, else the last pointer position on the canvas.
//
// Extras: holding T / Y for a moment without a number shows the picker as a cheat sheet (closes on release);
// while a picker is open, plain number keys pick from it. Letters follow the printed key (e.key) so Turkish
// F keyboards work, with e.code as the fallback for non-Latin layouts. A one-finger touch drag looks around
// and a tap clicks, for free. Game tells Controls when it opens/closes a picker itself (syncPicker).

import { BET_BOXES, CHIP_AMOUNTS, EMOTES, TAUNTS, type BetBox, type EmoteId } from "../../../shared/constants";
import type { Stage } from "../scene/Stage";
import { Emitter } from "../util/Emitter";

export type Action =
  | { type: "flip" }
  | { type: "cash" }
  | { type: "box"; box: BetBox }
  | { type: "betPass" }
  | { type: "chip"; amount: number }
  | { type: "loans" }
  | { type: "emote"; emote: EmoteId }
  | { type: "taunt"; index: number }
  | { type: "picker"; kind: "emote" | "taunt" | null }
  | { type: "scoreboard"; open: boolean }
  | { type: "escape" }
  | { type: "click"; x: number; y: number }
  | { type: "view" }
  | { type: "cycleTarget"; dir: -1 | 1 }
  | { type: "legend"; on: boolean }
  | { type: "heckle"; kind: "flip" | "cash" };

type PickerKind = "emote" | "taunt";

/** A release within this long (no number pressed) counts as a tap → sticky picker. */
const TAP_SEC = 0.32;
/** Held this long without a number → show the picker as a cheat sheet until release. */
const HOLD_HINT_SEC = 0.45;
/** A left press that moves less than this (px) and is released within CLICK_MS is a click; more is a drag. */
const CLICK_SLOP_PX = 6;
const CLICK_MS = 650;
/** Touch drags look around once they move this far. */
const TOUCH_DRAG_PX = 10;
/** An Esc this soon after the pointer lock ended was the unlock key itself (some browsers still deliver it). */
const UNLOCK_ESC_MS = 150;

const LETTER_CODES: Record<string, string> = {
  KeyQ: "q",
  KeyW: "w",
  KeyE: "e",
  KeyB: "b",
  KeyT: "t",
  KeyY: "y",
  KeyV: "v",
  KeyH: "h",
  KeyZ: "z",
  KeyX: "x",
};

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (t as HTMLInputElement).type;
  return type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit";
}

/** Lowercase Latin letter of the printed key, else the physical key's letter (non-Latin layouts). */
function letterOf(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k && k.length === 1) {
    const l = k.toLocaleLowerCase("tr");
    if (l >= "a" && l <= "z") return l;
  }
  return LETTER_CODES[e.code] ?? null;
}

/** 0..9 from the digit row or the numpad, else -1. */
function digitOf(e: KeyboardEvent): number {
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  if (m) return Number(m[1]);
  if (e.key && e.key.length === 1 && e.key >= "0" && e.key <= "9") return Number(e.key);
  return -1;
}

interface Chord {
  code: string;
  kind: PickerKind;
  downAt: number;
  used: boolean;
  /** The picker was opened by holding (closes on release). */
  hinted: boolean;
}

interface Press {
  id: number;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  at: number;
  moved: number;
  touch: boolean;
  /** Past the slop: this press is a look-drag, not a click. */
  dragging: boolean;
}

export class Controls {
  readonly actions = new Emitter<{ action: Action }>();

  private stage: Stage;
  private filter: () => boolean = () => false;
  private enabled = true;
  private inMatch = false;
  private time = 0;

  private chord: Chord | null = null;
  /** The picker Game currently shows (kept in sync through emit + syncPicker). */
  private picker: PickerKind | null = null;
  private tabHeld = false;
  private legendHeld = "";

  private orbitDrag: { id: number; x: number; y: number } | null = null;
  private press: Press | null = null;

  // First person + pointer lock.
  private firstPerson = false;
  private mouseLock = false;
  private lockedNow = false;
  /** performance.now() when a user-initiated unlock happened (Esc guard). */
  private unlockedAt = -1e9;
  /** We asked for the unlock ourselves (no Esc guard needed). */
  private selfUnlock = false;
  private lockPending = false;
  /** Last pointer position over the canvas (null when it left or never came). */
  private pointer: { x: number; y: number } | null = null;
  private aimOut = { x: 0, y: 0 };

  constructor(stage: Stage) {
    this.stage = stage;
    const canvas = stage.canvas;
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.onKeyUp(e));
    window.addEventListener("blur", () => this.releaseAll());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.releaseAll();
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    // A right-drag that ends over the UI must not pop the browser menu either.
    window.addEventListener("contextmenu", (e) => {
      if (this.orbitDrag) e.preventDefault();
    });
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointerleave", () => {
      if (!this.press && !this.orbitDrag) this.pointer = null;
    });
    window.addEventListener("pointermove", (e) => this.onPointerMove(e));
    window.addEventListener("pointerup", (e) => this.onPointerUp(e));
    window.addEventListener("pointercancel", (e) => this.onPointerCancel(e));
    document.addEventListener("pointerlockchange", () => this.onLockChange());
    document.addEventListener("pointerlockerror", () => {
      this.lockPending = false;
    });
  }

  /** When `filter()` returns true, game keys are ignored (Esc still works). */
  setKeyFilter(filter: () => boolean): void {
    this.filter = filter;
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) this.releaseAll();
  }

  /** In a running match (HUD up): the table keys are live. Outside, menus keep their keyboard. */
  setInMatch(on: boolean): void {
    if (this.inMatch === on) return;
    this.inMatch = on;
    if (!on) {
      if (this.tabHeld) {
        this.tabHeld = false;
        this.emit({ type: "scoreboard", open: false });
      }
      this.endLegend();
    }
  }

  /** First-person look is active (drag-look) and whether a canvas click should lock the pointer. */
  setFirstPerson(on: boolean, mouseLock: boolean): void {
    this.firstPerson = on;
    this.mouseLock = mouseLock;
    if (!(on && mouseLock)) this.unlock();
  }

  /** Pointer currently locked to the canvas (crosshair aiming). */
  get locked(): boolean {
    return this.lockedNow;
  }

  /** Where the player aims: the screen center while locked, else the last pointer position on the canvas. */
  get aim(): { x: number; y: number } | null {
    if (this.lockedNow) {
      const r = this.canvasRect();
      this.aimOut.x = r.left + r.width / 2;
      this.aimOut.y = r.top + r.height / 2;
      return this.aimOut;
    }
    if (!this.pointer) return null;
    this.aimOut.x = this.pointer.x;
    this.aimOut.y = this.pointer.y;
    return this.aimOut;
  }

  /** Game opened / closed a picker on its own (button, click in the overlay, Esc). */
  syncPicker(kind: PickerKind | null): void {
    this.picker = kind;
    if (this.chord && kind === null) this.chord.hinted = false;
    // A picker needs a free cursor.
    if (kind) this.unlock();
  }

  update(dt: number): void {
    if (dt > 0) this.time += dt;
    const c = this.chord;
    // Holding T / Y without a number: show the picker as a cheat sheet.
    if (c && !c.used && !c.hinted && this.picker === null && this.time - c.downAt >= HOLD_HINT_SEC) {
      c.hinted = true;
      this.setPicker(c.kind);
    }
    // A modal / picker took the keyboard (or input got disabled): give the cursor back.
    if (this.lockedNow && (this.blocked() || this.picker !== null)) this.unlock();
  }

  // ------------------------------------------------------------------ keyboard
  private emit(action: Action): void {
    this.actions.emit("action", action);
  }

  private blocked(): boolean {
    if (!this.enabled) return true;
    try {
      return this.filter();
    } catch {
      return false;
    }
  }

  private setPicker(kind: PickerKind | null): void {
    if (this.picker === kind) return;
    this.picker = kind;
    if (kind) this.unlock();
    this.emit({ type: "picker", kind });
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // browser shortcuts stay untouched
    if (e.code === "Escape" || e.key === "Escape") {
      if (e.repeat) return;
      this.chord = null;
      // The Esc that ended the pointer lock only unlocks (the browser may or may not deliver it).
      if (this.lockedNow) {
        this.unlock(false);
        return;
      }
      if (performance.now() - this.unlockedAt < UNLOCK_ESC_MS) return;
      this.emit({ type: "escape" });
      return;
    }
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement) || this.blocked()) return;

    const letter = letterOf(e);
    const digit = digitOf(e);

    // Keys that work everywhere in a room (lobby too): emote / taunt chords + pickers, the view toggle.
    if (letter === "t" || letter === "y") {
      if (e.repeat) return;
      const kind: PickerKind = letter === "t" ? "emote" : "taunt";
      if (this.picker === kind) {
        // T again closes its own picker.
        this.chord = null;
        this.setPicker(null);
        return;
      }
      this.chord = { code: e.code, kind, downAt: this.time, used: false, hinted: false };
      return;
    }
    if (digit > 0) {
      const kind = this.chord?.kind ?? this.picker;
      if (kind) {
        if (e.repeat) return;
        if (this.pick(kind, digit - 1)) {
          if (this.chord) this.chord.used = true;
          if (this.picker && !this.chord) this.setPicker(null);
        }
        return;
      }
    }
    if (letter === "v") {
      if (!e.repeat) this.emit({ type: "view" });
      return;
    }

    // Everything below is a table key: off outside a match (the menus keep Tab / Space / Enter / arrows).
    if (!this.inMatch) return;

    if (e.code === "Tab") {
      e.preventDefault();
      if (!this.tabHeld) {
        this.tabHeld = true;
        this.emit({ type: "scoreboard", open: true });
      }
      return;
    }
    if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
      if (e.repeat) return;
      e.preventDefault();
      this.emit({ type: "cycleTarget", dir: e.code === "ArrowLeft" ? -1 : 1 });
      return;
    }

    if (digit >= 0) {
      if (e.repeat) return;
      if (digit === 0) {
        this.emit({ type: "betPass" });
        return;
      }
      const box = BET_BOXES[digit - 1];
      if (box) this.emit({ type: "box", box: box.id });
      return;
    }

    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      if (e.repeat) return;
      this.blurButton();
      this.emit({ type: "flip" });
      return;
    }
    if (e.code === "Enter" || e.code === "NumpadEnter" || e.key === "Enter") {
      e.preventDefault();
      if (e.repeat) return;
      this.blurButton();
      this.emit({ type: "cash" });
      return;
    }
    if (letter === "h") {
      if (e.repeat || this.legendHeld) return;
      this.legendHeld = e.code || "h";
      this.emit({ type: "legend", on: true });
      return;
    }
    if (e.repeat) return;
    switch (letter) {
      case "q":
        this.emit({ type: "chip", amount: CHIP_AMOUNTS[0] });
        break;
      case "w":
        this.emit({ type: "chip", amount: CHIP_AMOUNTS[1] });
        break;
      case "e":
        this.emit({ type: "chip", amount: CHIP_AMOUNTS[2] });
        break;
      case "b":
        this.emit({ type: "loans" });
        break;
      case "z":
        this.emit({ type: "heckle", kind: "flip" });
        break;
      case "x":
        this.emit({ type: "heckle", kind: "cash" });
        break;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === "Tab" && this.tabHeld) {
      e.preventDefault();
      this.tabHeld = false;
      this.emit({ type: "scoreboard", open: false });
      return;
    }
    if (this.legendHeld && (e.code === this.legendHeld || letterOf(e) === "h")) {
      this.endLegend();
      return;
    }
    const c = this.chord;
    if (!c || e.code !== c.code) return;
    this.chord = null;
    if (c.hinted) {
      // Cheat-sheet picker from a long hold closes with the key.
      if (this.picker === c.kind) this.setPicker(null);
      return;
    }
    if (!c.used && this.time - c.downAt <= TAP_SEC && !this.blocked()) this.setPicker(c.kind);
  }

  private endLegend(): void {
    if (!this.legendHeld) return;
    this.legendHeld = "";
    this.emit({ type: "legend", on: false });
  }

  /** Emote / taunt by index. Returns false when the index is out of range. */
  private pick(kind: PickerKind, index: number): boolean {
    if (kind === "emote") {
      const em = EMOTES[index];
      if (!em) return false;
      this.emit({ type: "emote", emote: em.id });
      return true;
    }
    if (index < 0 || index >= TAUNTS.length) return false;
    this.emit({ type: "taunt", index });
    return true;
  }

  /** Space / Enter on a focused HUD button would also click it natively: game keys win. */
  private blurButton(): void {
    const a = document.activeElement;
    if (a instanceof HTMLElement && a !== document.body && (a.tagName === "BUTTON" || a.getAttribute("role") === "button")) a.blur();
  }

  /** Window lost focus: nothing should stay "held", and the pointer lock ends. */
  private releaseAll(): void {
    if (this.tabHeld) {
      this.tabHeld = false;
      this.emit({ type: "scoreboard", open: false });
    }
    this.endLegend();
    const c = this.chord;
    this.chord = null;
    if (c?.hinted && this.picker === c.kind) this.setPicker(null);
    this.orbitDrag = null;
    this.press = null;
    this.unlock();
  }

  // ------------------------------------------------------------------- pointer
  private canvasRect(): DOMRect {
    try {
      const r = this.stage.canvasRect();
      if (r && r.width > 0) return r;
    } catch {
      /* Stage without the cached rect: fall through */
    }
    return this.stage.canvas.getBoundingClientRect();
  }

  private onPointerDown(e: PointerEvent): void {
    const touch = e.pointerType === "touch";
    if (!touch) this.notePointer(e);
    if (this.lockedNow) {
      // Locked: the left button "clicks" at the crosshair; movement already looks around.
      if (e.button === 0 && this.enabled) {
        const r = this.canvasRect();
        this.emit({ type: "click", x: r.left + r.width / 2, y: r.top + r.height / 2 });
      }
      e.preventDefault();
      return;
    }
    if (e.button === 2 && !touch) {
      this.orbitDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.capture(e);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    this.press = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      at: performance.now(),
      moved: 0,
      touch,
      dragging: false,
    };
    this.capture(e);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.lockedNow) {
      const dx = e.movementX || 0;
      const dy = e.movementY || 0;
      if ((dx || dy) && this.enabled) this.stage.look(dx, dy, true);
      return;
    }
    if (e.pointerType !== "touch" && e.target === this.stage.canvas) this.notePointer(e);
    const d = this.orbitDrag;
    if (d && d.id === e.pointerId) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      if (dx || dy) this.stage.orbit(dx, dy);
      return;
    }
    const p = this.press;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.lastX;
    const dy = e.clientY - p.lastY;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    p.moved = Math.max(p.moved, Math.hypot(e.clientX - p.x, e.clientY - p.y));
    if (!p.dragging && p.moved >= (p.touch ? TOUCH_DRAG_PX : CLICK_SLOP_PX)) p.dragging = true;
    // A left-drag looks around (first person) / orbits (Masa), like a right-drag.
    if (p.dragging && (dx || dy)) this.stage.orbit(dx, dy);
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.orbitDrag && this.orbitDrag.id === e.pointerId) {
      this.orbitDrag = null;
      return;
    }
    const p = this.press;
    if (!p || p.id !== e.pointerId) return;
    this.press = null;
    if (p.dragging || p.moved > CLICK_SLOP_PX || performance.now() - p.at > CLICK_MS) return;
    if (!this.enabled) return;
    this.emit({ type: "click", x: e.clientX, y: e.clientY });
    // First person with "Fareyi kilitle": a plain canvas click also locks the pointer (crosshair aim).
    if (this.firstPerson && this.mouseLock && !p.touch && !this.blocked() && this.picker === null) this.lock();
  }

  private onPointerCancel(e: PointerEvent): void {
    if (this.orbitDrag?.id === e.pointerId) this.orbitDrag = null;
    if (this.press?.id === e.pointerId) this.press = null;
  }

  private notePointer(e: PointerEvent): void {
    if (!this.pointer) this.pointer = { x: e.clientX, y: e.clientY };
    else {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
    }
  }

  private capture(e: PointerEvent): void {
    try {
      this.stage.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events / detached canvas */
    }
  }

  // --------------------------------------------------------------- pointer lock
  private lock(): void {
    if (this.lockedNow || this.lockPending) return;
    const canvas = this.stage.canvas;
    if (typeof canvas.requestPointerLock !== "function") return;
    // Older browsers return nothing, newer ones a promise (rejected e.g. when Chrome refuses a re-lock for ~1 s
    // after the user left it: the next click simply tries again).
    const request = (options?: { unadjustedMovement: boolean }): Promise<void> | null => {
      const r = (canvas.requestPointerLock as (o?: object) => unknown).call(canvas, options);
      return r && typeof (r as Promise<void>).then === "function" ? (r as Promise<void>) : null;
    };
    const plain = () => {
      try {
        request()?.then(undefined, () => (this.lockPending = false));
      } catch {
        this.lockPending = false;
      }
    };
    this.lockPending = true;
    try {
      // Raw mouse input when the platform has it; Safari / older Chrome don't take options.
      request({ unadjustedMovement: true })?.then(undefined, (err: unknown) => {
        if (err instanceof DOMException && err.name === "NotSupportedError") plain();
        else this.lockPending = false;
      });
    } catch {
      plain();
    }
  }

  /** Leave the pointer lock. `self` = we decided it (no Esc guard afterwards). */
  private unlock(self = true): void {
    if (!this.lockedNow && !this.lockPending) return;
    this.lockPending = false;
    if (document.pointerLockElement !== this.stage.canvas) return;
    this.selfUnlock = self;
    try {
      document.exitPointerLock();
    } catch {
      /* already gone */
    }
  }

  private onLockChange(): void {
    const locked = document.pointerLockElement === this.stage.canvas;
    this.lockPending = false;
    if (locked === this.lockedNow) return;
    this.lockedNow = locked;
    if (!locked) {
      if (!this.selfUnlock) this.unlockedAt = performance.now();
      this.selfUnlock = false;
      return;
    }
    // Locked while it is no longer wanted (setting flipped meanwhile): give it straight back.
    if (!(this.firstPerson && this.mouseLock) || !this.enabled) this.unlock();
    this.press = null;
    this.orbitDrag = null;
  }
}
