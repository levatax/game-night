// Home screen: bouncy "BONK BRAWL" logo, nickname, Create Room / Join Room (code input). Owner: client-ui.

import type { Emitter } from "../util/Emitter";
import type { HomeModel, UiEventMap } from "./models";

/**
 * Emits createRoom { nickname } / joinRoom { code, nickname } (code uppercased, validated against
 * CODE_PATTERN before emitting; invalid → inline error, uiSound "error"). Enter submits Join when
 * a code is typed, else Create. Nickname max NICKNAME_MAX chars. A "← Game Night" link emits backToPortal.
 * The 3D backdrop (MenuScene) renders behind; this screen is transparent except for the panel.
 */
export class HomeScreen {
  readonly el: HTMLElement = document.createElement("section");

  constructor(events: Emitter<UiEventMap>) {
    void events;
    this.el.className = "screen screen--home";
  }

  update(model: HomeModel): void {
    void model;
  }
}
