// WebGL context loss / restore on the renderer canvas (GPU reset, driver update, a long time in the background).
// Owner: client-net-app (gap analysis N4), used by Renderer.ts only. No three.js import: unit-tested with a fake
// event target.
//
// three.js' WebGLRenderer listens to the same two events on its canvas (registered first, in its constructor): it
// also preventDefault()s the loss, skips render() while lost and rebuilds its whole GL state on restore, after
// which every texture / buffer / program uploads again on first use. This watch adds what the game needs on top:
// a `lost` flag the app can read, a change hook (the "graphics were reset" card) and a restore callback for the
// renderer's own rebuild. That callback runs while still flagged lost and throws when the rebuild didn't work: the
// watch then stays lost (nothing drawn, the card's Reload button stays up) until a later restore succeeds.
// preventDefault() is called here too, so a restore stays possible even without three's.

/** The two DOM events, by name, so the fake target in the tests and the real canvas agree. */
export const CONTEXT_LOST = "webglcontextlost";
export const CONTEXT_RESTORED = "webglcontextrestored";

/** What the watch needs from the canvas (an HTMLCanvasElement satisfies it). */
export interface ContextEventTarget {
  addEventListener(type: string, listener: (event: Event) => void, options?: boolean): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: boolean): void;
}

export class ContextWatch {
  /** Called with `true` when the context is lost and `false` once it is restored (after `onRestore` succeeded). */
  onChange: ((lost: boolean) => void) | null = null;
  private lostFlag = false;
  private target: ContextEventTarget | null;

  private readonly handleLost = (event: Event): void => {
    // Without this the browser never tries to restore the context.
    event.preventDefault();
    if (this.lostFlag) return;
    this.lostFlag = true;
    this.notify(true);
  };

  private readonly handleRestored = (): void => {
    if (!this.lostFlag) return;
    try {
      this.onRestore();
    } catch (err) {
      // Drawing with a half-rebuilt context shows nothing: stay lost, so the card keeps offering the reload.
      console.error("[render] rebuilding after a context restore failed", err);
      return;
    }
    this.lostFlag = false;
    this.notify(false);
  };

  constructor(
    target: ContextEventTarget,
    private readonly onRestore: () => void,
  ) {
    this.target = target;
    target.addEventListener(CONTEXT_LOST, this.handleLost, false);
    target.addEventListener(CONTEXT_RESTORED, this.handleRestored, false);
  }

  /** True between a webglcontextlost and the matching webglcontextrestored. */
  get lost(): boolean {
    return this.lostFlag;
  }

  dispose(): void {
    const target = this.target;
    this.target = null;
    this.onChange = null;
    if (!target) return;
    target.removeEventListener(CONTEXT_LOST, this.handleLost, false);
    target.removeEventListener(CONTEXT_RESTORED, this.handleRestored, false);
  }

  private notify(lost: boolean): void {
    try {
      this.onChange?.(lost);
    } catch (err) {
      console.error("[render] context change hook failed", err);
    }
  }
}
