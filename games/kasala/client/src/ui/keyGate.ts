// Which UI layer owns the keyboard right now (an open loans / settings window, the match end, a focused lobby
// field). Overlays and Menu register their capturesKeys(); the HUD's own window key listeners (key-press echo,
// the PAS fallback) check uiCapturesKeys() so they stay in step with the filter Game gives Controls
// (menu.capturesKeys() || overlays.capturesKeys()) and never show an action that Controls swallowed.

const gates: Array<() => boolean> = [];

export function addKeyGate(fn: () => boolean): void {
  gates.push(fn);
}

export function uiCapturesKeys(): boolean {
  for (const gate of gates) {
    try {
      if (gate()) return true;
    } catch {
      /* a broken gate never blocks the keyboard */
    }
  }
  return false;
}
