// Tiny typed event emitter. Shared by every client module (complete).
//
//   const e = new Emitter<{ hit: HitEvent; closed: void }>();
//   const off = e.on("hit", (ev) => ...);
//   e.emit("hit", ev); e.emit("closed", undefined); off();

export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends object> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();

  /** Subscribe. Returns an unsubscribe function. */
  on<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn as Listener<never>);
    return () => this.off(type, fn);
  }

  /** Subscribe for a single emission. */
  once<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off<K extends keyof Events>(type: K, fn: Listener<Events[K]>): void {
    this.listeners.get(type)?.delete(fn as Listener<never>);
  }

  /** Call every listener in subscription order. A throwing listener doesn't stop the others. */
  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try {
        (fn as Listener<Events[K]>)(payload);
      } catch (err) {
        console.error(`[emitter] listener for "${String(type)}" threw`, err);
      }
    }
  }

  /** Remove all listeners (of one type, or all). */
  clear(type?: keyof Events): void {
    if (type === undefined) this.listeners.clear();
    else this.listeners.delete(type);
  }
}
