// Toasts and errors. Owner: client-ui.

import type { ToastKind } from "./models";

/** Stack at the bottom/top center, max 3, auto-dismiss after 3.5 s (errors 6 s), click to dismiss. */
export class Toasts {
  readonly el: HTMLElement = document.createElement("div");

  constructor() {
    this.el.className = "toasts";
  }

  show(text: string, kind: ToastKind = "info"): void {
    void text;
    void kind;
  }
}
