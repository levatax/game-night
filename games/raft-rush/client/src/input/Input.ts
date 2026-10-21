// Keyboard + mouse → 30 Hz InputCmd, pointer lock (with a drag-look fallback), in-game hotkeys. Owner: client-app.
// Adapted from games/bonk-brawl/client/src/input/Input.ts (edge latching, soft lock) and
// games/kasala/client/src/input/Controls.ts (drag-look when pointer lock is unavailable, the mouseLock setting).
// Reads settings.keyPreset (bindings.ts presets) and settings.mouseLock itself; sensitivity / invert-Y come from
// the app through configure().

import { PITCH_LIMIT } from "../../../shared/constants";
import { BTN, type InputCmd } from "../../../shared/protocol";
import { clamp, wrapAngle } from "../../../shared/sim/math";
import { MOUSE_RADIANS_PER_PIXEL, settings, type Settings, type SettingsStore } from "../app/settings";
import { Emitter } from "../util/Emitter";
import { bindingsFor, isTextEntry, KEY_BINDINGS, learnKeyCap, loadKeyboardLayout, MOUSE, SLOT_BITS, slotBit, WHEEL_STEP_PX, type KeyBinding, type MoveAction } from "./bindings";

/**
 * Who owns the keyboard / mouse right now (the app derives it from Ui.panel / Ui.capturesInput every frame):
 * - "none": playing; everything samples (needs pointer lock or the drag-look fallback).
 * - "panel": the craft / chest panel is open; the cursor is free, only WASD still walks (walking away closes it)
 *   and a slot picked from the chest panel (selectSlot) still switches the held item. Tab moves the focus.
 * - "full": a menu, a sticky wheel or a text field owns the input; nothing samples.
 */
export type CaptureMode = "none" | "panel" | "full";

export interface InputEventMap {
  /** Esc (or a pointer lock the user released mid-game). `captured`: a panel / menu was open at the time. */
  menu: { captured: boolean };
  /** Tab down / up (stats table while held). */
  scoreboard: { open: boolean };
  /** H down / up (legend while held). */
  legend: { open: boolean };
  /** V or the middle mouse button: open (or, while open, close) the ping wheel. */
  pingWheel: void;
  /**
   * T: open the emote wheel (T + 1–6 picks, so does a click or releasing T over a slice — the UI handles those
   * keys while the wheel is open); T while it is open closes it.
   */
  emoteWheel: { open: boolean };
  /** A digit 1–6 the UI didn't take while a wheel / menu owns the input (0-based slice index). */
  wheelPick: { index: number };
  /** E pressed while playing (the app opens the craft / chest panel when that's what E points at). */
  interact: void;
  /** The interact key (E; U left-handed) pressed while the craft / chest panel is open (the app closes it). */
  panelKey: void;
  /** M: quick mute toggle. */
  mute: void;
  /** Pointer lock (or the drag-look fallback) engaged / released. */
  pointerLock: { locked: boolean };
}

/** Browsers may still deliver the Esc that ended a pointer lock: ignore an Esc this soon after a user unlock. */
const ESC_AFTER_UNLOCK_MS = 300;
/** Some Chrome builds report huge bogus movementX/Y spikes under pointer lock. */
const MAX_MOUSE_DELTA_PX = 400;
/** A lock request that hasn't engaged by then is treated as refused. */
const LOCK_TIMEOUT_MS = 600;
/** Chrome refuses a re-lock for ~1 s after the user left the lock; that's not a reason to fall back. */
const RELOCK_COOLDOWN_MS = 1500;
/** A refusal only switches to drag-look when it answered a click (or an Enter / Space press) this recent. */
const POINTER_GESTURE_MS = 1500;
/**
 * Keys that activate a focused button (the veil's Play, the menu's Resume). A lock refused right after one of
 * these means "this player started from the keyboard": drag-look lets a keyboard + trackpad player in (WASD walks,
 * a trackpad drag looks), where a "mouse required" note would leave them stuck. Esc / E / digits closing a panel
 * are not activations: their refusal keeps the veil (the next click locks).
 */
const ACTIVATION_KEYS: ReadonlySet<string> = new Set(["Enter", "NumpadEnter", "Space"]);
/** Drag-look starts once the pointer moved this far with a button held (no lock). */
const DRAG_SLOP_PX = 4;
/**
 * Drag-look: a left press held this long without dragging past the slop is a hold (use, charge) rather than the
 * start of a look. On a trackpad the only practical drag is a left-button drag, so a press is only used once it is
 * a click (released without a drag) or such a hold; a drag to look never punches, casts or throws.
 */
const DRAG_HOLD_MS = 200;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Bindings (game4.md §15, docs/ARCHITECTURE.md §2.1; the standard preset, bindings.ts has the left-handed one):
 * W A S D move (camera-relative), mouse look (pointer lock), Space jump, Shift sprint, LMB = THROW level +
 * USE_PRESS edge, RMB = CATCH, E = INTERACT level + INTERACT_PRESS edge, F eat, Q drop / toss, 1–4 and the wheel
 * = slots, V / middle click = ping wheel, T = emote wheel (T + 1–6 picks inside it), H (held) legend, Tab (held)
 * stats, Esc menu, M mute. While a panel / wheel is open the UI handles its own keys first (window capture phase)
 * and stops the ones it uses; Input only sees the rest. Tab opens the stats only while nothing is captured: with a
 * panel or a menu open it moves the focus.
 *
 * Edge bits are latched on keydown / mousedown and cleared by the next sample(), so a press shorter than a tick
 * is never lost. THROW / INTERACT are "held now OR pressed since the previous sample": a click shorter than one
 * 33 ms tick still reaches the sim for one tick. Key repeats never re-latch.
 *
 * Look: under pointer lock, yaw -= movementX · MOUSE_RADIANS_PER_PIXEL · sensitivity and pitch -= movementY · …
 * (inverted with invertY), pitch clamped to ±PITCH_LIMIT, yaw wrapped. With settings.mouseLock off, or where the
 * browser refuses pointer lock after a click / Enter (sandboxed iframes, some embedded browsers), input switches
 * to a drag-look fallback: gameplay keys flow, the cursor stays visible and dragging with any mouse button held
 * looks around. There a left press becomes LMB (USE_PRESS + THROW) only as a click (on release, one tick) or a
 * hold that stays put for DRAG_HOLD_MS (then it charges, and dragging on aims); a press that turns into a drag is
 * a look only. Esc leaves it like a real lock. Keys are released on window blur (no stuck keys after alt-tab).
 *
 * Spectator free look (in game with gameplay input off: washed ashore, spectating, cinematics): mouse movement
 * under a lock still held, or a drag on the game surface, collects look deltas for the spectator camera; a click
 * without a drag or Space asks for the next teammate to follow (RMB: the previous one). takeFreeLook() drains it.
 */
export class Input {
  readonly events = new Emitter<InputEventMap>();

  private readonly target: HTMLElement;
  private yawValue = 0;
  private pitchValue = 0;
  private readonly lookValue = { yaw: 0, pitch: 0 };
  private sensitivity = 1;
  private invertY = false;

  private enabled = false;
  private inGame = false;
  private captureValue: CaptureMode = "none";

  private locked = false;
  private soft = false;
  private selfUnlock = false;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUnlockAt = -Infinity;
  private lastActivation: "pointer" | "key" | null = null;
  private lastActivationCode = "";
  private lastActivationAt = -Infinity;
  /** settings.mouseLock: off plays with drag-look and never asks the browser for a lock. */
  private mouseLock = true;
  /** The active preset's code → binding table (settings.keyPreset). */
  private bindings: Readonly<Record<string, KeyBinding>> = KEY_BINDINGS;

  private readonly move: Record<MoveAction, boolean> = { forward: false, back: false, left: false, right: false };
  private sprintDown = false;
  private interactDown = false;
  private interactPressed = false;
  private lmbDown = false;
  private lmbPressed = false;
  /** Edge bits waiting for the next sample. */
  private latched = 0;
  private wheelAcc = 0;

  private scoreboardOpen = false;
  private legendOpen = false;

  /** Drag-look (fallback): a button went down on the game surface at (x, y). */
  private drag: { x: number; y: number; moved: boolean } | null = null;
  /** Drag-look: when the left button went down, while that press is neither a click, a hold nor a look yet. */
  private pendingLmbAt: number | null = null;
  /** Spectator free look: the press being dragged, and what piled up since the last takeFreeLook(). */
  private freeDrag: { x: number; y: number; travel: number; button: number } | null = null;
  private freeYaw = 0;
  private freePitch = 0;
  private freeCycle = 0;
  private readonly freeLookValue = { yaw: 0, pitch: 0, cycle: 0 };
  private readonly cleanups: Array<() => void> = [];

  /** `target` is the element that takes pointer lock on click (the #game container). */
  constructor(target: HTMLElement, store: SettingsStore = settings) {
    this.target = target;
    this.applyPrefs(store.get());
    this.cleanups.push(
      store.onChange((next, changed) => {
        if (changed.includes("keyPreset") || changed.includes("mouseLock")) this.applyPrefs(next);
      }),
    );
    void loadKeyboardLayout();
    this.listen(document, "pointerlockchange", this.onPointerLockChange);
    this.listen(document, "pointerlockerror", this.onPointerLockError);
    this.listen(document, "mousemove", this.onMouseMove);
    this.listen(document, "mousedown", this.onMouseDown);
    this.listen(document, "mouseup", this.onMouseUp);
    this.listen(document, "contextmenu", this.onContextMenu);
    this.listen(window, "wheel", this.onWheel, { passive: false });
    this.listen(target, "click", this.onTargetClick);
    this.listen(window, "keydown", this.onKeyDown);
    this.listen(window, "keyup", this.onKeyUp);
    this.listen(window, "blur", this.onBlur);
    this.listen(document, "visibilitychange", this.onVisibilityChange);
  }

  /* ================================================================ look */

  get yaw(): number {
    return this.yawValue;
  }

  get pitch(): number {
    return this.pitchValue;
  }

  /** Current look as one reused object ({ yaw, pitch }); read it immediately. */
  get look(): { yaw: number; pitch: number } {
    this.lookValue.yaw = this.yawValue;
    this.lookValue.pitch = this.pitchValue;
    return this.lookValue;
  }

  /** Set the look (spawn / respawn facing, reconnect). */
  setLook(yaw: number, pitch: number): void {
    if (Number.isFinite(yaw)) this.yawValue = wrapAngle(yaw);
    if (Number.isFinite(pitch)) this.pitchValue = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /**
   * Spectator free look since the last call, then cleared: yaw / pitch deltas in radians (the same signs as the
   * look: mouse right lowers yaw) and follow steps (+1 next teammate, −1 previous). One reused object.
   */
  takeFreeLook(): { yaw: number; pitch: number; cycle: number } {
    const out = this.freeLookValue;
    out.yaw = this.freeYaw;
    out.pitch = this.freePitch;
    out.cycle = this.freeCycle;
    this.freeYaw = 0;
    this.freePitch = 0;
    this.freeCycle = 0;
    return out;
  }

  /** Mouse sensitivity multiplier and invert-Y (from settings). */
  configure(opts: { sensitivity: number; invertY: boolean }): void {
    if (Number.isFinite(opts.sensitivity) && opts.sensitivity > 0) this.sensitivity = opts.sensitivity;
    this.invertY = opts.invertY;
  }

  /* ================================================================ modes */

  /** Gameplay input wanted (alive in a simulated phase, first person). Off releases every held key. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.releaseGameplay(false);
      this.exitSoft();
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * On the game screen: the in-game hotkeys (Tab, H, V, T, E…) are live. Off on home / lobby so Tab keeps its
   * focus-navigation role in forms; also releases the pointer.
   */
  setInGame(inGame: boolean): void {
    if (this.inGame === inGame) return;
    this.inGame = inGame;
    if (!inGame) {
      this.releaseGameplay(false);
      this.closeHolds();
      this.exitPointerLock();
    }
  }

  get isInGame(): boolean {
    return this.inGame;
  }

  /** Who owns the input (see CaptureMode). Capturing releases the pointer lock (no menu) and the held keys. */
  setCapture(mode: CaptureMode): void {
    if (mode === this.captureValue) return;
    this.captureValue = mode;
    if (mode === "none") return;
    this.releaseGameplay(mode === "panel");
    this.exitPointerLock();
  }

  get capture(): CaptureMode {
    return this.captureValue;
  }

  /** True while gameplay input is captured: real pointer lock, or the drag-look fallback. */
  get pointerLocked(): boolean {
    return this.locked || this.soft;
  }

  /** Playing without pointer lock (drag-look) because the browser refused it. */
  get dragLook(): boolean {
    return this.soft;
  }

  /** Request pointer lock (call from a user gesture: the click-to-play veil, a panel close click). */
  requestPointerLock(): void {
    if (!this.inGame || this.captureValue !== "none" || this.locked || this.soft) return;
    const target = this.target as HTMLElement & { requestPointerLock?: () => Promise<void> | void };
    if (!this.mouseLock || typeof target.requestPointerLock !== "function") {
      this.enterSoft();
      return;
    }
    const refused = (): void => this.onLockRefused();
    try {
      const pending = target.requestPointerLock() as Promise<void> | undefined;
      pending?.catch?.(refused);
    } catch {
      refused();
      return;
    }
    // Some browsers neither lock nor report an error.
    if (this.lockTimer !== null) clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => {
      this.lockTimer = null;
      if (!this.locked) refused();
    }, LOCK_TIMEOUT_MS);
  }

  /** Release the pointer (and the drag-look fallback) on purpose: no menu opens. */
  exitPointerLock(): void {
    this.exitSoft();
    if (typeof document !== "undefined" && document.pointerLockElement === this.target) {
      this.selfUnlock = true;
      try {
        document.exitPointerLock();
      } catch {
        this.selfUnlock = false;
      }
    }
  }

  /**
   * Switch the held slot (0-based) from the UI: a click on a chest panel pocket that isn't held takes it in hand.
   * Rides the next sample, also while the panel captures the input.
   */
  selectSlot(slot: number): void {
    const bit = slotBit(slot + 1);
    if (bit && (this.playing || this.walkingInPanel)) this.latched |= bit;
  }

  /* ============================================================== sample */

  /**
   * Build the InputCmd for one sim tick: moveX = D − A, moveZ = W − S (normalized if diagonal), yaw / pitch, and
   * buttons = THROW / INTERACT (held or pressed since the last sample) | SPRINT | latched edges. Then clears the
   * edges and press latches. While not playing (menus, no pointer, disabled) move and buttons are zero but the
   * look is kept; with the craft / chest panel open only WASD walks (plus a slot picked through selectSlot).
   */
  sample(seq: number): InputCmd {
    let moveX = 0;
    let moveZ = 0;
    let buttons = 0;
    const playing = this.playing;
    if (playing || this.walkingInPanel) {
      moveX = axis(this.move.right, this.move.left);
      moveZ = axis(this.move.forward, this.move.back);
      const len = Math.hypot(moveX, moveZ);
      if (len > 1) {
        moveX /= len;
        moveZ /= len;
      }
    }
    if (playing) {
      // Drag-look: a left press held still long enough is a hold (it uses / charges from now on).
      if (this.pendingLmbAt !== null && now() - this.pendingLmbAt >= DRAG_HOLD_MS) this.pressLmb();
      if (this.lmbDown || this.lmbPressed) buttons |= BTN.THROW;
      if (this.interactDown || this.interactPressed) buttons |= BTN.INTERACT;
      if (this.sprintDown) buttons |= BTN.SPRINT;
      buttons |= this.latched;
    } else if (this.walkingInPanel) {
      buttons |= this.latched & SLOT_BITS;
    }
    this.clearLatches();
    return { seq, moveX, moveZ, yaw: this.yawValue, pitch: this.pitchValue, buttons };
  }

  /** Drop pending edges and press latches without sampling (frames where no input is sent). */
  clearLatches(): void {
    this.latched = 0;
    this.lmbPressed = false;
    this.interactPressed = false;
  }

  /** LMB held right now (HUD / arc between ticks). */
  get throwHeld(): boolean {
    return this.playing && this.lmbDown;
  }

  dispose(): void {
    if (this.lockTimer !== null) clearTimeout(this.lockTimer);
    this.lockTimer = null;
    this.exitPointerLock();
    for (const off of this.cleanups.splice(0)) off();
    this.events.clear();
  }

  /* ============================================================ internals */

  /** Every gameplay key samples: enabled, in game, nothing captured, pointer locked (or drag-look). */
  private get playing(): boolean {
    return this.enabled && this.inGame && this.captureValue === "none" && (this.locked || this.soft);
  }

  private get walkingInPanel(): boolean {
    return this.enabled && this.inGame && this.captureValue === "panel";
  }

  /** In game, nothing captured, but no gameplay input: the mouse steers the spectator camera. */
  private get freeLooking(): boolean {
    return !this.enabled && this.inGame && this.captureValue === "none";
  }

  private listen<E extends Event>(el: EventTarget, type: string, fn: (e: E) => void, opts?: AddEventListenerOptions): void {
    const handler = fn.bind(this) as EventListener;
    el.addEventListener(type, handler, opts);
    this.cleanups.push(() => el.removeEventListener(type, handler, opts));
  }

  private releaseGameplay(keepMove: boolean): void {
    if (!keepMove) for (const k of Object.keys(this.move) as MoveAction[]) this.move[k] = false;
    this.sprintDown = false;
    this.interactDown = false;
    this.lmbDown = false;
    this.pendingLmbAt = null;
    this.drag = null;
    this.freeDrag = null;
    this.freeYaw = 0;
    this.freePitch = 0;
    this.freeCycle = 0;
    this.wheelAcc = 0;
    this.clearLatches();
  }

  /** Tab / H holds end (blur, leaving the game). */
  private closeHolds(): void {
    if (this.scoreboardOpen) {
      this.scoreboardOpen = false;
      this.events.emit("scoreboard", { open: false });
    }
    if (this.legendOpen) {
      this.legendOpen = false;
      this.events.emit("legend", { open: false });
    }
  }

  private noteActivation(kind: "pointer" | "key", code = ""): void {
    this.lastActivation = kind;
    this.lastActivationCode = code;
    this.lastActivationAt = now();
  }

  /** Key preset and mouse lock from settings. A preset change releases held keys (their key-ups would not match). */
  private applyPrefs(s: Readonly<Settings>): void {
    const bindings = bindingsFor(s.keyPreset);
    if (bindings !== this.bindings) {
      this.bindings = bindings;
      this.releaseGameplay(false);
      this.closeHolds();
    }
    // Toggled in the settings menu, which already released the lock: the next requestPointerLock() follows it.
    this.mouseLock = s.mouseLock;
  }

  private enterSoft(): void {
    if (this.soft) return;
    this.soft = true;
    this.events.emit("pointerLock", { locked: true });
  }

  private exitSoft(): void {
    if (!this.soft) return;
    this.soft = false;
    this.drag = null;
    this.releaseGameplay(this.captureValue === "panel");
    this.events.emit("pointerLock", { locked: false });
  }

  /**
   * The browser refused the lock. Right after the user left a lock that's Chrome's re-lock cooldown, and a
   * request from a non-activating key (Esc / E closing a panel) can't lock at all: the veil stays and the next
   * click retries. A refused click, or a refused Enter / Space on the veil or the menu (ACTIVATION_KEYS), means
   * this browser can't lock here: play with drag-look.
   */
  private onLockRefused(): void {
    if (this.locked || this.soft || !this.enabled || !this.inGame || this.captureValue !== "none") return;
    const t = now();
    if (t - this.lastUnlockAt < RELOCK_COOLDOWN_MS) return;
    if (t - this.lastActivationAt > POINTER_GESTURE_MS) return;
    const gesture = this.lastActivation === "pointer" || (this.lastActivation === "key" && ACTIVATION_KEYS.has(this.lastActivationCode));
    if (gesture) this.enterSoft();
  }

  private onPointerLockChange(): void {
    const locked = typeof document !== "undefined" && document.pointerLockElement === this.target;
    if (locked === this.locked) return;
    this.locked = locked;
    if (locked && (!this.inGame || !this.enabled || this.captureValue !== "none")) {
      // A lock requested just before leaving the game (or opening a panel) was granted late: hand the cursor back.
      this.selfUnlock = true;
      try {
        document.exitPointerLock();
      } catch {
        this.selfUnlock = false;
      }
      return;
    }
    if (locked) {
      this.soft = false;
      if (this.lockTimer !== null) clearTimeout(this.lockTimer);
      this.lockTimer = null;
      this.events.emit("pointerLock", { locked: true });
      return;
    }
    const self = this.selfUnlock;
    this.selfUnlock = false;
    this.releaseGameplay(this.captureValue === "panel");
    this.events.emit("pointerLock", { locked: false });
    if (self) return;
    this.lastUnlockAt = now();
    // The user left the lock mid-game (Esc, alt-tab): pause into the menu.
    if (this.inGame && this.enabled && this.captureValue === "none") this.events.emit("menu", { captured: false });
  }

  private onPointerLockError(): void {
    this.locked = typeof document !== "undefined" && document.pointerLockElement === this.target;
    this.onLockRefused();
  }

  private onTargetClick(): void {
    this.noteActivation("pointer");
    if (this.enabled && this.inGame && this.captureValue === "none" && !this.locked && !this.soft) this.requestPointerLock();
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.freeLooking) {
      this.onFreeLookMove(e);
      return;
    }
    if (!this.enabled || !this.inGame || this.captureValue !== "none") return;
    let dx = 0;
    let dy = 0;
    if (this.locked) {
      dx = e.movementX || 0;
      dy = e.movementY || 0;
    } else if (this.soft && this.drag && (e.buttons ?? 1) !== 0) {
      const mx = e.movementX ?? 0;
      const my = e.movementY ?? 0;
      dx = mx || e.clientX - this.drag.x;
      dy = my || e.clientY - this.drag.y;
      if (!this.drag.moved && Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) < DRAG_SLOP_PX && Math.hypot(dx, dy) < DRAG_SLOP_PX) {
        return;
      }
      this.drag.moved = true;
      this.pendingLmbAt = null; // the press became a look: never used
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
    } else {
      return;
    }
    if (Math.abs(dx) > MAX_MOUSE_DELTA_PX || Math.abs(dy) > MAX_MOUSE_DELTA_PX) return;
    const k = MOUSE_RADIANS_PER_PIXEL * this.sensitivity;
    this.yawValue = wrapAngle(this.yawValue - dx * k);
    this.pitchValue = clamp(this.pitchValue - dy * k * (this.invertY ? -1 : 1), -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Spectator free look: movement under a held lock, or a drag past the slop (jitter in a click isn't a drag). */
  private onFreeLookMove(e: MouseEvent): void {
    const drag = this.freeDrag;
    let dx = 0;
    let dy = 0;
    if (this.locked) {
      dx = e.movementX || 0;
      dy = e.movementY || 0;
    } else if (drag && (e.buttons ?? 1) !== 0) {
      dx = e.movementX || e.clientX - drag.x;
      dy = e.movementY || e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
    } else {
      return;
    }
    if (Math.abs(dx) > MAX_MOUSE_DELTA_PX || Math.abs(dy) > MAX_MOUSE_DELTA_PX) return;
    if (drag) drag.travel += Math.hypot(dx, dy);
    if (!this.locked && drag && drag.travel < DRAG_SLOP_PX) return;
    const k = MOUSE_RADIANS_PER_PIXEL * this.sensitivity;
    this.freeYaw -= dx * k;
    this.freePitch -= dy * k * (this.invertY ? -1 : 1);
  }

  /** A press on the game surface (not on a UI widget) while playing. */
  private onGameSurface(e: MouseEvent): boolean {
    if (this.locked) return true;
    const t = e.target as Node | null;
    return t === this.target || (t !== null && typeof this.target.contains === "function" && this.target.contains(t));
  }

  private onMouseDown(e: MouseEvent): void {
    this.noteActivation("pointer");
    if (this.freeLooking && this.onGameSurface(e)) {
      this.freeDrag = { x: e.clientX, y: e.clientY, travel: 0, button: e.button };
      e.preventDefault();
      return;
    }
    if (!this.playing || !this.onGameSurface(e)) return;
    if (this.soft) this.drag = { x: e.clientX, y: e.clientY, moved: false };
    if (e.button === MOUSE.LEFT) {
      // Drag-look: wait to see whether this press is a click, a hold or a look (DRAG_HOLD_MS).
      if (this.soft) this.pendingLmbAt = now();
      else this.pressLmb();
    } else if (e.button === MOUSE.RIGHT) {
      this.latched |= BTN.CATCH;
    } else if (e.button === MOUSE.MIDDLE) {
      this.events.emit("pingWheel", undefined);
    }
    e.preventDefault();
  }

  /** LMB down: THROW held from now on, plus the USE_PRESS edge. */
  private pressLmb(): void {
    this.pendingLmbAt = null;
    this.lmbDown = true;
    this.lmbPressed = true;
    this.latched |= BTN.USE_PRESS;
  }

  private onMouseUp(e: MouseEvent): void {
    if (e.button === MOUSE.LEFT) {
      // Drag-look: released before it became a hold or a look, so it was a click (THROW for one tick + USE_PRESS).
      if (this.pendingLmbAt !== null && this.playing) {
        this.lmbPressed = true;
        this.latched |= BTN.USE_PRESS;
      }
      this.pendingLmbAt = null;
      this.lmbDown = false;
    }
    if ((e.buttons ?? 0) === 0) this.drag = null;
    const free = this.freeDrag;
    if (free && e.button === free.button) {
      this.freeDrag = null;
      // A click (no drag): LMB follows the next teammate, RMB the previous one.
      if (this.freeLooking && free.travel < DRAG_SLOP_PX && e.button !== MOUSE.MIDDLE) this.freeCycle += e.button === MOUSE.RIGHT ? -1 : 1;
    }
  }

  private onContextMenu(e: MouseEvent): void {
    const t = e.target as Node | null;
    if (this.locked || (this.inGame && (t === this.target || (t !== null && this.target.contains?.(t))))) e.preventDefault();
  }

  private onWheel(e: WheelEvent): void {
    if (!this.playing) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const dy = (e.deltaY || 0) * unit;
    if (dy === 0) return;
    e.preventDefault();
    // A mouse notch (≥ one step) always steps once; trackpads accumulate.
    if (Math.abs(dy) >= WHEEL_STEP_PX) {
      this.wheelAcc = 0;
      this.latched |= dy > 0 ? BTN.SLOT_NEXT : BTN.SLOT_PREV;
      return;
    }
    if (Math.sign(dy) !== Math.sign(this.wheelAcc)) this.wheelAcc = 0;
    this.wheelAcc += dy;
    if (Math.abs(this.wheelAcc) >= WHEEL_STEP_PX) {
      this.latched |= this.wheelAcc > 0 ? BTN.SLOT_NEXT : BTN.SLOT_PREV;
      this.wheelAcc = 0;
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    this.noteActivation("key", e.code);
    if (e.ctrlKey || e.metaKey || e.altKey) return; // browser shortcuts stay untouched
    if (e.code === "Escape") {
      this.onEscape(e);
      return;
    }
    if (isTextEntry(e.target)) return;
    // What a key types is its printed cap (AZERTY's KeyW says Z); with Shift / AltGr it would type another symbol.
    if (!e.repeat && !e.shiftKey && !e.getModifierState?.("AltGraph") && typeof e.key === "string") learnKeyCap(e.code, e.key);
    const b = this.bindings[e.code];
    if (!b) return;
    if (b.hotkey === "mute") {
      if (!e.repeat) this.events.emit("mute", undefined);
      return;
    }
    if (!this.inGame) return;
    if (b.hotkey === "scoreboard") {
      if (this.captureValue !== "none") return; // Tab keeps focus navigation in menus and the craft / chest panel
      e.preventDefault();
      if (!this.scoreboardOpen) {
        this.scoreboardOpen = true;
        this.events.emit("scoreboard", { open: true });
      }
      return;
    }
    if (this.captureValue === "full") {
      if (e.repeat) return;
      if (b.digit !== undefined) this.events.emit("wheelPick", { index: b.digit - 1 });
      else if (b.hotkey === "emoteChord") this.events.emit("emoteWheel", { open: false });
      else if (b.hotkey === "pingWheel") this.events.emit("pingWheel", undefined);
      return;
    }
    if (this.captureValue === "panel") {
      if (b.move) {
        e.preventDefault();
        this.move[b.move] = true;
      } else if (b.level === "interact" && !e.repeat) {
        this.events.emit("panelKey", undefined);
      }
      return;
    }
    if (this.freeLooking && b.edge === BTN.JUMP) {
      // Space while spectating: follow the next teammate.
      e.preventDefault();
      if (!e.repeat) this.freeCycle += 1;
      return;
    }
    if (!this.playing) return;
    e.preventDefault();
    if (b.move) {
      this.move[b.move] = true;
      return;
    }
    if (b.level === "sprint") this.sprintDown = true;
    if (b.level === "interact") this.interactDown = true;
    if (e.repeat) return;
    if (b.digit !== undefined) {
      const bit = slotBit(b.digit);
      if (bit) this.latched |= bit;
      return;
    }
    if (b.edge) this.latched |= b.edge;
    if (b.level === "interact") {
      this.interactPressed = true;
      this.events.emit("interact", undefined);
    }
    switch (b.hotkey) {
      case "legend":
        if (!this.legendOpen) {
          this.legendOpen = true;
          this.events.emit("legend", { open: true });
        }
        break;
      case "pingWheel":
        this.events.emit("pingWheel", undefined);
        break;
      case "emoteChord":
        this.events.emit("emoteWheel", { open: true });
        break;
      default:
        break;
    }
  }

  private onEscape(e: KeyboardEvent): void {
    if (e.repeat) return;
    if (this.soft && this.captureValue === "none") {
      // No browser lock to release: leave the drag-look fallback ourselves, like Esc does for a real lock.
      this.exitSoft();
      this.lastUnlockAt = now();
      this.events.emit("menu", { captured: false });
      return;
    }
    if (now() - this.lastUnlockAt < ESC_AFTER_UNLOCK_MS) return;
    this.events.emit("menu", { captured: this.captureValue !== "none" });
  }

  private onKeyUp(e: KeyboardEvent): void {
    const b = this.bindings[e.code];
    if (!b) return;
    if (b.move) this.move[b.move] = false;
    if (b.level === "sprint") this.sprintDown = false;
    if (b.level === "interact") this.interactDown = false;
    if (b.hotkey === "scoreboard" && this.scoreboardOpen) {
      if (this.inGame) e.preventDefault();
      this.scoreboardOpen = false;
      this.events.emit("scoreboard", { open: false });
      return;
    }
    if (b.hotkey === "legend" && this.legendOpen) {
      this.legendOpen = false;
      this.events.emit("legend", { open: false });
    }
  }

  private onBlur(): void {
    this.releaseGameplay(false);
    this.closeHolds();
  }

  private onVisibilityChange(): void {
    if (typeof document !== "undefined" && document.hidden) this.onBlur();
  }
}

function axis(positive: boolean, negative: boolean): number {
  return (positive ? 1 : 0) - (negative ? 1 : 0);
}
