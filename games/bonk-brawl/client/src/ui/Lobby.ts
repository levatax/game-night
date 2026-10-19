// Lobby screen. Owner: client-ui.

import type { Emitter } from "../util/Emitter";
import type { LobbyModel, UiEventMap } from "./models";

/**
 * Big room code + "Copy link" (navigator.clipboard.writeText(shareUrl), toast "Link copied!"),
 * 4 player cards (nickname, character emoji/name, slot color, ready ✓, host crown icon, ping,
 * "Waiting for player…" for empty seats), character carousel (← → arrows over CHARACTER_IDS,
 * name, ability name + description from CHARACTERS) around `previewCanvas` (the App renders the
 * 3D turntable into it), Ready toggle, and host-only settings: map (MAP_CHOICES), rounds
 * (ROUND_OPTIONS), power-ups on/off, Start (disabled with startHint unless canStart).
 * Non-hosts see the settings read-only. Spectators see "Match in progress — you'll join the next one".
 * Emits selectCharacter, setReady, updateSettings, startMatch, leaveRoom.
 */
export class LobbyScreen {
  readonly el: HTMLElement = document.createElement("section");
  /** 3D character preview target (~320×320 CSS px; App sizes the renderer to its client size). */
  readonly previewCanvas: HTMLCanvasElement = document.createElement("canvas");

  constructor(events: Emitter<UiEventMap>) {
    void events;
    this.el.className = "screen screen--lobby";
  }

  update(model: LobbyModel): void {
    void model;
  }
}
