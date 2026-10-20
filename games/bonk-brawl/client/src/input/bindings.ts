// Key bindings (game1.md §6), by KeyboardEvent.code so they're keyboard-layout independent.
// Owner: client-app.

import { BTN } from "../../../shared/protocol";

/** Keys tracked while held: movement and the ghost camera's up/down. */
export type HeldAction = "forward" | "back" | "left" | "right" | "up" | "down";

export interface KeyBinding {
  /** Held state this key drives. */
  held?: HeldAction;
  /** Edge-triggered BTN bit latched on keydown. */
  edge?: number;
  /** Q: emote. */
  emote?: boolean;
}

export const KEY_BINDINGS: Readonly<Record<string, KeyBinding>> = {
  KeyW: { held: "forward" },
  ArrowUp: { held: "forward" },
  KeyS: { held: "back" },
  ArrowDown: { held: "back" },
  KeyA: { held: "left" },
  ArrowLeft: { held: "left" },
  KeyD: { held: "right" },
  ArrowRight: { held: "right" },
  // Space jumps (and flies the ghost camera up); Shift rolls (and flies it down).
  Space: { held: "up", edge: BTN.JUMP },
  ShiftLeft: { held: "down", edge: BTN.ROLL },
  ShiftRight: { held: "down", edge: BTN.ROLL },
  KeyE: { edge: BTN.ABILITY },
  KeyQ: { emote: true },
};

/** Typing into a form field must never move the player. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}
