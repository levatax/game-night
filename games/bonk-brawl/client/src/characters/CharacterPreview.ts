// Lobby turntable preview. Owner: client-characters.

import type { CharacterId } from "../../../shared/types";

/**
 * Own small WebGLRenderer (alpha: true, antialias) on the given canvas (the lobby's
 * previewCanvas), own scene with the shared toon lighting, a pedestal, and the selected animal
 * slowly rotating + playing idle and an occasional emote. Resizes to the canvas client size.
 * Runs its own requestAnimationFrame loop only while started.
 */
export class CharacterPreview {
  constructor(canvas: HTMLCanvasElement) {
    void canvas;
  }

  /** Show `character` tinted with the slot color (swap with a little hop). */
  setCharacter(character: CharacterId, slotColor: string): void {
    void character;
    void slotColor;
  }

  start(): void {}

  stop(): void {}

  dispose(): void {}
}
