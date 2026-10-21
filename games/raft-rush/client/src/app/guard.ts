// Fault isolation for the client modules. Owner: client-app.
// Adapted from games/kasala/client/src/game/context.ts: every module the app drives is wrapped by guard(), so a
// throwing method is logged once and returns undefined (a rejected promise resolves to undefined), and a module
// whose constructor throws is replaced by a dead stand-in (make()). One module's bug never stops the frame loop.

const logged = new Set<string>();

/** console.error once per key (per module method), so a broken module doesn't flood the console at 60 fps. */
export function logOnce(key: string, err: unknown): void {
  if (logged.has(key)) return;
  logged.add(key);
  console.error(`[raft-rush] ${key} failed`, err);
}

/** Forget what was logged (tests). */
export function resetLogOnce(): void {
  logged.clear();
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Proxy that turns exceptions in `target`'s methods into a logged no-op. Properties pass through untouched,
 * except the sub-modules named in `nested` (e.g. characters.fpArms), which are guarded too. A method the module
 * doesn't have (yet) becomes a logged no-op as well, so one missing contract method can't cut the frame short.
 * Methods are applied to the raw target (private fields and `this` keep working).
 */
export function guard<T extends object>(name: string, target: T, nested: ReadonlyArray<string> = []): T {
  const cache = new Map<PropertyKey, { orig: AnyFn; wrapped: AnyFn }>();
  const missing = new Map<PropertyKey, AnyFn>();
  const subs = new Map<PropertyKey, { orig: object; wrapped: object }>();
  return new Proxy(target, {
    get(t, prop) {
      let v: unknown;
      try {
        v = Reflect.get(t, prop, t);
      } catch (err) {
        logOnce(`${name}.${String(prop)}`, err);
        return undefined;
      }
      if (typeof prop === "string" && nested.includes(prop) && v !== null && typeof v === "object") {
        const hit = subs.get(prop);
        if (hit && hit.orig === v) return hit.wrapped;
        const wrapped = guard(`${name}.${prop}`, v);
        subs.set(prop, { orig: v, wrapped });
        return wrapped;
      }
      if (v === undefined && typeof prop === "string" && prop !== "then" && prop !== "toJSON" && !(prop in t)) {
        let stub = missing.get(prop);
        if (!stub) {
          stub = () => {
            logOnce(`${name}.${prop} missing`, new Error(`${name}.${prop} is not implemented`));
            return undefined;
          };
          missing.set(prop, stub);
        }
        return stub;
      }
      if (typeof v !== "function") return v;
      const orig = v as AnyFn;
      const hit = cache.get(prop);
      if (hit && hit.orig === orig) return hit.wrapped;
      const key = `${name}.${String(prop)}`;
      const wrapped: AnyFn = (...args) => {
        try {
          const r = orig.apply(t, args);
          if (r && typeof (r as PromiseLike<unknown>).then === "function") {
            return Promise.resolve(r).then(undefined, (err: unknown) => {
              logOnce(key, err);
              return undefined;
            });
          }
          return r;
        } catch (err) {
          logOnce(key, err);
          return undefined;
        }
      };
      cache.set(prop, { orig, wrapped });
      return wrapped;
    },
    set(t, prop, value) {
      try {
        return Reflect.set(t, prop, value, t);
      } catch (err) {
        logOnce(`${name}.${String(prop)}=`, err);
        return true;
      }
    },
  });
}

/** Stand-in for a module whose constructor threw: every property is callable and returns undefined. */
export function deadModule<T>(): T {
  const fn = function () {
    return undefined;
  };
  const dead: unknown = new Proxy(fn, {
    get: (_t, prop) => (prop === "then" ? undefined : prop === Symbol.toPrimitive ? () => 0 : prop === Symbol.iterator ? undefined : dead),
    apply: () => undefined,
  });
  return dead as T;
}

/** Build a module, or log and fall back to a dead stand-in. `ok` tells whether the real module exists. */
export function make<T>(name: string, build: () => T): { value: T; ok: boolean } {
  try {
    return { value: build(), ok: true };
  } catch (err) {
    logOnce(`${name} constructor`, err);
    return { value: deadModule<T>(), ok: false };
  }
}

/** Run one frame step; a throw is logged once per step name and the frame carries on. */
export function step(name: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logOnce(`frame:${name}`, err);
  }
}

/** step() that returns a value, or `fallback` on a throw. */
export function attempt<T>(name: string, fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    logOnce(`frame:${name}`, err);
    return fallback;
  }
}

/**
 * Timers on the frame clock (not setTimeout): run fn once `delayMs` of frame time has passed. cancelAll() drops
 * everything (leaving the game view / a new match), so a stale reel sound never plays over the next match.
 */
export class Later {
  private now = 0;
  private readonly queue: { at: number; fn: () => void; name: string }[] = [];

  /** Advance the clock (ms) and run every due callback. */
  update(nowMs: number): void {
    this.now = nowMs;
    if (this.queue.length === 0) return;
    const due: { at: number; fn: () => void; name: string }[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const job = this.queue[i]!;
      if (job.at <= nowMs) {
        due.push(job);
        this.queue.splice(i, 1);
      }
    }
    due.sort((a, b) => a.at - b.at);
    for (const job of due) step(`later:${job.name}`, job.fn);
  }

  run(delayMs: number, name: string, fn: () => void): void {
    this.queue.push({ at: this.now + Math.max(0, delayMs), fn, name });
  }

  cancelAll(): void {
    this.queue.length = 0;
  }

  get pending(): number {
    return this.queue.length;
  }
}
