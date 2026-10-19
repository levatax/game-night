// Esc settings menu. Owner: client-ui.

import type { Settings } from "../app/settings";
import type { Emitter } from "../util/Emitter";
import type { UiEventMap } from "./models";

/**
 * Overlay with: mouse sensitivity (0.1–3), invert Y, FOV (60–100), Master/Music/SFX volume
 * (0–100%), graphics quality Low/Med/High, show arc preview. Every change emits settingsChange
 * immediately (live preview). Buttons: Resume (emits resume — App re-locks the pointer),
 * Leave room (leaveRoom, with a confirm step), Back to Game Night (backToPortal).
 * Also lists the controls (game1.md §6).
 */
export class SettingsMenu {
  readonly el: HTMLElement = document.createElement("div");

  constructor(events: Emitter<UiEventMap>) {
    void events;
    this.el.className = "settings-menu";
  }

  open(current: Readonly<Settings>, inRoom: boolean): void {
    void current;
    void inRoom;
  }

  close(): void {}

  get isOpen(): boolean {
    return false;
  }
}
