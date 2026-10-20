// Keyboard + mouse → InputCmd, pointer lock, UI hotkeys. Owner: client-app.

import { PITCH_LIMIT } from "../../../shared/constants";
import { BTN, type InputCmd } from "../../../shared/protocol";
import { clamp, wrapAngle } from "../../../shared/sim/math";
import { MOUSE_RADIANS_PER_PIXEL } from "../app/settings";
import { Emitter } from "../util/Emitter";
import { KEY_BINDINGS, type HeldAction, isTextEntry } from "./bindings";

export interface InputEventMap {
  /** Q pressed (in game, pointer locked). The controller picks/cycles the emote and sends it. */
  emote: void;
  /** Tab down/up (scoreboard visible while held). Default browser focus change is prevented. */
  scoreboard: { open: boolean };
  /** Esc / pointer lock lost: open the settings menu. */
  menu: void;
  /** Pointer lock state changed. */
  pointerLock: { locked: boolean };
}

/** Browsers swallow Esc while exiting pointer lock; ignore a late Esc keydown right after a lock loss. */
const ESC_AFTER_UNLOCK_MS = 300;
/** Some Chrome builds report huge bogus movementX/Y spikes under pointer lock. */
const MAX_MOUSE_DELTA_PX = 400;
/** A lock request that hasn't engaged by then is treated as refused. */
const LOCK_TIMEOUT_MS = 600;
/** Chrome refuses a re-lock for ~1 s after the user left the lock; that's not a reason to fall back. */
const RELOCK_COOLDOWN_MS = 1500;

const MOUSE_LEFT = 0;
const MOUSE_RIGHT = 2;

/**
 * Bindings (game1.md §6): W A S D move (camera-relative), mouse look (pointer lock), LMB hold =
 * throw (level), RMB = catch, Space = jump, Shift = roll, E = ability, Q = emote, Tab =
 * scoreboard, Esc = menu. Uses KeyboardEvent.code (layout independent). Context menu disabled on
 * the canvas.
 *
 * Look: on mousemove while locked, yaw -= movementX * MOUSE_RADIANS_PER_PIXEL * sensitivity;
 * pitch -= movementY * ... * (invertY ? -1 : 1); pitch clamped to ±PITCH_LIMIT; yaw wrapped.
 * Edge buttons (CATCH, JUMP, ROLL, ABILITY) are latched on keydown/mousedown and cleared by the
 * next sample(), so a press shorter than a tick is never lost. THROW = LMB held now OR pressed
 * since the previous sample (so a click shorter than one 33 ms tick still produces a 1-tick quick
 * throw on the next sample, then reads as released).
 * While disabled (menus open) or unlocked: sample() returns zero move and no buttons (THROW
 * released → the sim cancels/throws per its rules; edges cleared) but keeps yaw/pitch.
 * Fallback: where the browser refuses pointer lock (sandboxed iframes, some embedded or
 * automated browsers), input switches to an unlocked "soft lock": gameplay input flows, the
 * mouse still aims from its movement, and Esc leaves it like a real lock.
 * Keys are also released on window blur (no stuck keys after alt-tab).
 */
export class Input {
  readonly events = new Emitter<InputEventMap>();

  private readonly target: HTMLElement;
  private yawValue = 0;
  private pitchValue = 0;
  private sensitivity = 1;
  private invertY = false;
  private enabled = false;
  private inGame = false;
  private locked = false;
  /** Playing without pointer lock because the browser refused it. */
  private softLocked = false;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUnlockAt = -Infinity;

  private readonly held: Record<HeldAction, boolean> = {
    forward: false,
    back: false,
    left: false,
    right: false,
    up: false,
    down: false,
  };
  private throwDown = false;
  /** LMB went down since the last sample (sub-tick clicks still throw). */
  private throwPressed = false;
  /** Edge button bits waiting for the next sample. */
  private latched = 0;
  private scoreboardOpen = false;
  private readonly ghost = { x: 0, y: 0, z: 0 };
  private readonly cleanups: Array<() => void> = [];

  /** `target` is the element that requests pointer lock on click (the #game container). */
  constructor(target: HTMLElement) {
    this.target = target;
    this.listen(document, "pointerlockchange", this.onPointerLockChange);
    this.listen(document, "pointerlockerror", this.onPointerLockError);
    this.listen(document, "mousemove", this.onMouseMove);
    this.listen(document, "mousedown", this.onMouseDown);
    this.listen(document, "mouseup", this.onMouseUp);
    this.listen(document, "contextmenu", this.onContextMenu);
    this.listen(target, "click", this.onTargetClick);
    this.listen(window, "keydown", this.onKeyDown);
    this.listen(window, "keyup", this.onKeyUp);
    this.listen(window, "blur", this.onBlur);
    this.listen(document, "visibilitychange", this.onVisibilityChange);
  }

  get yaw(): number {
    return this.yawValue;
  }

  get pitch(): number {
    return this.pitchValue;
  }

  /** Set look (e.g. to the spawn yaw at round start). */
  setLook(yaw: number, pitch: number): void {
    if (Number.isFinite(yaw)) this.yawValue = wrapAngle(yaw);
    if (Number.isFinite(pitch)) this.pitchValue = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Mouse sensitivity multiplier and invert-Y (from settings). */
  configure(opts: { sensitivity: number; invertY: boolean }): void {
    if (Number.isFinite(opts.sensitivity) && opts.sensitivity > 0) this.sensitivity = opts.sensitivity;
    this.invertY = opts.invertY;
  }

  /** Enable/disable gameplay input (menus, lobby, round-end card). Hotkeys Tab/Esc still work. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.releaseGameplay();
      this.softLocked = false;
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * In-game hotkeys (Tab scoreboard capture). Off on the home/lobby screens so Tab keeps its
   * normal focus-navigation role in forms.
   */
  setInGame(inGame: boolean): void {
    if (this.inGame === inGame) return;
    this.inGame = inGame;
    if (!inGame) this.closeScoreboard();
  }

  /** True while gameplay input is captured: real pointer lock, or the soft-lock fallback. */
  get pointerLocked(): boolean {
    return this.locked || this.softLocked;
  }

  /** Request pointer lock (must be called from a user gesture, e.g. the "click to play" overlay). */
  requestPointerLock(): void {
    if (document.pointerLockElement === this.target || this.softLocked) return;
    const refused = (): void => this.onLockRefused();
    try {
      const pending = this.target.requestPointerLock() as Promise<void> | undefined;
      pending?.catch(refused);
    } catch {
      // Older browsers throw synchronously in the same situations.
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

  exitPointerLock(): void {
    this.exitSoftLock();
    if (document.pointerLockElement === this.target) document.exitPointerLock();
  }

  /**
   * Build the InputCmd for one sim tick: moveX = D - A, moveZ = W - S (normalized if diagonal),
   * yaw/pitch current look, buttons = THROW (held or pressed since last sample) | latched edges;
   * then clears the latched edges and the THROW press latch.
   */
  sample(seq: number): InputCmd {
    let moveX = 0;
    let moveZ = 0;
    let buttons = 0;
    if (this.active) {
      moveX = axis(this.held.right, this.held.left);
      moveZ = axis(this.held.forward, this.held.back);
      const len = Math.hypot(moveX, moveZ);
      if (len > 1) {
        moveX /= len;
        moveZ /= len;
      }
      if (this.throwDown || this.throwPressed) buttons |= BTN.THROW;
      buttons |= this.latched;
    }
    this.clearLatches();
    return { seq, moveX, moveZ, yaw: this.yawValue, pitch: this.pitchValue, buttons };
  }

  /** Drop pending edge presses without sampling (frames where no input is being sent). */
  clearLatches(): void {
    this.latched = 0;
    this.throwPressed = false;
  }

  /**
   * WASD as a free-fly vector for the spectator ghost camera: x right, z forward, y (Space up /
   * Shift down). Returns a reused object: read it immediately, don't keep it.
   */
  ghostMove(): { x: number; y: number; z: number } {
    const g = this.ghost;
    if (!this.active) {
      g.x = 0;
      g.y = 0;
      g.z = 0;
      return g;
    }
    g.x = axis(this.held.right, this.held.left);
    g.y = axis(this.held.up, this.held.down);
    g.z = axis(this.held.forward, this.held.back);
    return g;
  }

  /** Is the throw button currently held (for HUD/arc preview between ticks)? */
  get throwHeld(): boolean {
    return this.active && this.throwDown;
  }

  dispose(): void {
    if (this.lockTimer !== null) clearTimeout(this.lockTimer);
    for (const off of this.cleanups.splice(0)) off();
    this.exitPointerLock();
    this.events.clear();
  }

  /* ------------------------------------------------------------ internals */

  /** Gameplay input flows only while enabled AND the pointer is locked (or soft-locked) to the game. */
  private get active(): boolean {
    return this.enabled && (this.locked || this.softLocked);
  }

  /**
   * The browser refused the lock. Right after leaving a lock that's just Chrome's re-lock
   * cooldown (the overlay stays and the next click retries); otherwise the browser can't lock
   * here at all, so play unlocked.
   */
  private onLockRefused(): void {
    if (this.locked || this.softLocked || !this.enabled) return;
    if (performance.now() - this.lastUnlockAt < RELOCK_COOLDOWN_MS) return;
    this.softLocked = true;
    this.events.emit("pointerLock", { locked: true });
  }

  private exitSoftLock(): void {
    if (!this.softLocked) return;
    this.softLocked = false;
    this.releaseGameplay();
    this.lastUnlockAt = performance.now();
    this.events.emit("pointerLock", { locked: false });
  }

  private listen<E extends Event>(el: EventTarget, type: string, fn: (e: E) => void): void {
    const handler = fn.bind(this) as EventListener;
    el.addEventListener(type, handler);
    this.cleanups.push(() => el.removeEventListener(type, handler));
  }

  private releaseGameplay(): void {
    for (const key of Object.keys(this.held) as HeldAction[]) this.held[key] = false;
    this.throwDown = false;
    this.clearLatches();
  }

  private closeScoreboard(): void {
    if (!this.scoreboardOpen) return;
    this.scoreboardOpen = false;
    this.events.emit("scoreboard", { open: false });
  }

  private onPointerLockChange(): void {
    const locked = document.pointerLockElement === this.target;
    if (locked === this.locked) return;
    this.locked = locked;
    if (locked) this.softLocked = false;
    if (!locked) {
      this.releaseGameplay();
      this.lastUnlockAt = performance.now();
    }
    this.events.emit("pointerLock", { locked });
    // Losing the lock mid-game (Esc, alt-tab) pauses into the settings menu.
    if (!locked && this.enabled) this.events.emit("menu", undefined);
  }

  private onPointerLockError(): void {
    this.locked = document.pointerLockElement === this.target;
    this.onLockRefused();
  }

  private onTargetClick(): void {
    if (this.enabled && !this.locked) this.requestPointerLock();
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.active) return;
    const dx = e.movementX;
    const dy = e.movementY;
    if (Math.abs(dx) > MAX_MOUSE_DELTA_PX || Math.abs(dy) > MAX_MOUSE_DELTA_PX) return;
    const k = MOUSE_RADIANS_PER_PIXEL * this.sensitivity;
    this.yawValue = wrapAngle(this.yawValue - dx * k);
    this.pitchValue = clamp(this.pitchValue - dy * k * (this.invertY ? -1 : 1), -PITCH_LIMIT, PITCH_LIMIT);
  }

  private onMouseDown(e: MouseEvent): void {
    if (!this.active) return;
    if (e.button === MOUSE_LEFT) {
      this.throwDown = true;
      this.throwPressed = true;
    } else if (e.button === MOUSE_RIGHT) {
      this.latched |= BTN.CATCH;
    }
    e.preventDefault();
  }

  private onMouseUp(e: MouseEvent): void {
    if (e.button === MOUSE_LEFT) this.throwDown = false;
  }

  private onContextMenu(e: MouseEvent): void {
    if (this.locked || e.target === this.target || this.target.contains(e.target as Node)) e.preventDefault();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.code === "Escape") {
      if (this.softLocked) {
        // No browser lock to release: leave the soft lock ourselves, like Esc does for a real one.
        this.exitSoftLock();
        if (this.enabled) this.events.emit("menu", undefined);
        return;
      }
      if (!e.repeat && performance.now() - this.lastUnlockAt > ESC_AFTER_UNLOCK_MS) this.events.emit("menu", undefined);
      return;
    }
    if (e.code === "Tab") {
      if (!this.inGame) return;
      e.preventDefault();
      if (!this.scoreboardOpen) {
        this.scoreboardOpen = true;
        this.events.emit("scoreboard", { open: true });
      }
      return;
    }
    if (!this.active || isTextEntry(e.target)) return;
    const binding = KEY_BINDINGS[e.code];
    if (!binding) return;
    e.preventDefault();
    if (binding.held) this.held[binding.held] = true;
    if (e.repeat) return;
    if (binding.edge) this.latched |= binding.edge;
    if (binding.emote && this.inGame) this.events.emit("emote", undefined);
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === "Tab") {
      if (this.inGame) e.preventDefault();
      this.closeScoreboard();
      return;
    }
    const binding = KEY_BINDINGS[e.code];
    if (binding?.held) this.held[binding.held] = false;
  }

  private onBlur(): void {
    this.releaseGameplay();
    this.closeScoreboard();
  }

  private onVisibilityChange(): void {
    if (document.hidden) this.onBlur();
  }
}

function axis(positive: boolean, negative: boolean): number {
  return (positive ? 1 : 0) - (negative ? 1 : 0);
}
