// ContextWatch with a fake canvas: the loss is preventDefault()ed (so the browser may restore it), flags `lost`
// and calls the hook once; the restore rebuilds first, then clears the flag, unless the rebuild threw (stays
// lost); dispose() detaches. Owner: client-net-app.

import { describe, expect, it, vi } from "vitest";
import { CONTEXT_LOST, CONTEXT_RESTORED, ContextWatch, type ContextEventTarget } from "./ContextWatch";

class FakeCanvas implements ContextEventTarget {
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  addEventListener(type: string, listener: (event: Event) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  /** Dispatch a minimal event; returns whether preventDefault() was called. */
  fire(type: string): boolean {
    let prevented = false;
    const event = { type, preventDefault: () => (prevented = true) } as unknown as Event;
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return prevented;
  }
  count(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

describe("ContextWatch", () => {
  it("flags a lost context once, keeps it restorable and reports the change", () => {
    const canvas = new FakeCanvas();
    const restore = vi.fn();
    const watch = new ContextWatch(canvas, restore);
    const changes: boolean[] = [];
    watch.onChange = (lost) => changes.push(lost);
    expect(watch.lost).toBe(false);
    expect(canvas.fire(CONTEXT_LOST)).toBe(true);
    expect(canvas.fire(CONTEXT_LOST)).toBe(true);
    expect(watch.lost).toBe(true);
    expect(changes).toEqual([true]);
    expect(restore).not.toHaveBeenCalled();
  });

  it("rebuilds on restore before clearing the flag and telling the app", () => {
    const canvas = new FakeCanvas();
    const order: string[] = [];
    let watch: ContextWatch | null = null;
    watch = new ContextWatch(canvas, () => order.push(`rebuild lost=${watch?.lost}`));
    watch.onChange = (lost) => order.push(`change ${lost}`);
    canvas.fire(CONTEXT_RESTORED); // a stray restore without a loss is ignored
    canvas.fire(CONTEXT_LOST);
    canvas.fire(CONTEXT_RESTORED);
    expect(order).toEqual(["change true", "rebuild lost=true", "change false"]);
    expect(watch.lost).toBe(false);
  });

  it("a failing rebuild keeps it lost (the card and its Reload stay up) until a later restore works", () => {
    const canvas = new FakeCanvas();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let rebuildWorks = false;
    const watch = new ContextWatch(canvas, () => {
      if (!rebuildWorks) throw new Error("three.js didn't rebuild");
    });
    const changes: boolean[] = [];
    watch.onChange = (lost) => changes.push(lost);
    canvas.fire(CONTEXT_LOST);
    canvas.fire(CONTEXT_RESTORED);
    expect(watch.lost).toBe(true);
    expect(changes).toEqual([true]);
    expect(error).toHaveBeenCalledTimes(1);
    // The next GPU reset may go better: lost again (no second card), then restored for real.
    expect(canvas.fire(CONTEXT_LOST)).toBe(true);
    rebuildWorks = true;
    canvas.fire(CONTEXT_RESTORED);
    expect(watch.lost).toBe(false);
    expect(changes).toEqual([true, false]);
    error.mockRestore();
  });

  it("a throwing change hook is contained", () => {
    const canvas = new FakeCanvas();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const watch = new ContextWatch(canvas, () => undefined);
    watch.onChange = () => {
      throw new Error("ui gone");
    };
    canvas.fire(CONTEXT_LOST);
    canvas.fire(CONTEXT_RESTORED);
    expect(watch.lost).toBe(false);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("dispose() detaches both listeners", () => {
    const canvas = new FakeCanvas();
    const watch = new ContextWatch(canvas, () => undefined);
    expect(canvas.count()).toBe(2);
    watch.dispose();
    watch.dispose();
    expect(canvas.count()).toBe(0);
    expect(canvas.fire(CONTEXT_LOST)).toBe(false);
    expect(watch.lost).toBe(false);
  });
});
