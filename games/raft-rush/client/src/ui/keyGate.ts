// Which UI layer owns the keyboard right now (an open panel / wheel / menu, a focused lobby field). Owner: client-ui.
// Copied from games/kasala/client/src/ui/keyGate.ts. Ui registers its gates; Ui.capturesInput and every UI key
// listener read uiCapturesKeys() so they stay in step with what Input is told to ignore.

const gates: Array<() => boolean> = [];

/** Register a "the UI owns the keyboard" predicate. Returns an unregister function. */
export function addKeyGate(fn: () => boolean): () => void {
  gates.push(fn);
  return () => {
    const i = gates.indexOf(fn);
    if (i >= 0) gates.splice(i, 1);
  };
}

/** True when any registered gate says the UI owns the keyboard (a throwing gate never blocks it). */
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
