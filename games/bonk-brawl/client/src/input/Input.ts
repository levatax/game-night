// Keyboard + mouse → InputCmd, pointer lock, UI hotkeys. Owner: client-app.

import type { InputCmd } from "../../../shared/protocol";
import { Emitter } from "../util/Emitter";

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
 * Keys are also released on window blur (no stuck keys after alt-tab).
 */
export class Input {
  readonly events = new Emitter<InputEventMap>();

  /** `target` is the element that requests pointer lock on click (the #game container). */
  constructor(target: HTMLElement) {
    void target;
  }

  get yaw(): number {
    return 0; // TODO(client-app)
  }

  get pitch(): number {
    return 0;
  }

  /** Set look (e.g. to the spawn yaw at round start). */
  setLook(yaw: number, pitch: number): void {
    void yaw;
    void pitch;
  }

  /** Mouse sensitivity multiplier and invert-Y (from settings). */
  configure(opts: { sensitivity: number; invertY: boolean }): void {
    void opts;
  }

  /** Enable/disable gameplay input (menus, lobby, round-end card). Hotkeys Tab/Esc still work. */
  setEnabled(enabled: boolean): void {
    void enabled;
  }

  get pointerLocked(): boolean {
    return false;
  }

  /** Request pointer lock (must be called from a user gesture, e.g. the "click to play" overlay). */
  requestPointerLock(): void {}

  exitPointerLock(): void {}

  /**
   * Build the InputCmd for one sim tick: moveX = D - A, moveZ = W - S (normalized if diagonal),
   * yaw/pitch current look, buttons = THROW (held or pressed since last sample) | latched edges;
   * then clears the latched edges and the THROW press latch.
   */
  sample(seq: number): InputCmd {
    return { seq, moveX: 0, moveZ: 0, yaw: this.yaw, pitch: this.pitch, buttons: 0 };
  }

  /** WASD as a free-fly vector for the spectator ghost camera: x right, z forward, y (Space up / Shift down). */
  ghostMove(): { x: number; y: number; z: number } {
    return { x: 0, y: 0, z: 0 };
  }

  /** Is the throw button currently held (for HUD/arc preview between ticks)? */
  get throwHeld(): boolean {
    return false;
  }

  dispose(): void {
    this.events.clear();
  }
}
