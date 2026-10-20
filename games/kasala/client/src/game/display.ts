// What the HUD and the room show, as opposed to what the server already knows. Owner: client-net-game.
// The server applies a card the instant it is flipped and patches the state ~50 ms later, while the card
// is still turning over for ~1.1 s. Showing the new pot / siren / phase right away would spoil the reveal,
// so Game "holds" those fields at their pre-card values until the animation lands (bounded by a deadline).
// view(state) returns the state itself when nothing is held, else a cached read-through proxy that
// overrides only the held fields (old proxies fall back to live values once the hold ends).

import type { KasalaStateView } from "../../../shared/protocol";

export type HeldFields = Partial<
  Pick<
    KasalaStateView,
    | "phase"
    | "busy"
    | "turnPot"
    | "raidChance"
    | "sirenLevel"
    | "flips"
    | "lawyers"
    | "curseArmed"
    | "kumbara"
    | "lastCard"
    | "pendingCard"
    | "wheelSlice"
    | "betsLocked"
  >
>;

interface Hold {
  token: number;
  fields: HeldFields;
  until: number;
}

export class DisplayState {
  private holds: Hold[] = [];
  private nextToken = 1;
  private proxies = new WeakMap<object, KasalaStateView>();
  private merged: HeldFields | null = null;
  private onChange: () => void = () => {};

  /** Called whenever a hold ends (Game re-presents the live state). */
  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  /** Hold `fields` until release(token) or for at most maxMs. Later holds override earlier ones. */
  hold(fields: HeldFields, maxMs: number): number {
    const token = this.nextToken++;
    this.holds.push({ token, fields: { ...fields }, until: performance.now() + maxMs });
    this.merge();
    return token;
  }

  release(token: number): void {
    const before = this.holds.length;
    this.holds = this.holds.filter((h) => h.token !== token);
    if (this.holds.length !== before) {
      this.merge();
      this.onChange();
    }
  }

  clear(): void {
    if (this.holds.length === 0) return;
    this.holds = [];
    this.merged = null;
    this.onChange();
  }

  /** Per frame: drop expired holds. */
  tick(): void {
    if (this.holds.length === 0) return;
    const now = performance.now();
    const live = this.holds.filter((h) => h.until > now);
    if (live.length === this.holds.length) return;
    this.holds = live;
    this.merge();
    this.onChange();
  }

  get active(): boolean {
    return this.merged !== null;
  }

  /** A held field's value, if held. */
  held<K extends keyof HeldFields>(key: K): HeldFields[K] | undefined {
    return this.merged?.[key];
  }

  view(state: KasalaStateView): KasalaStateView {
    if (!this.merged) return state;
    let p = this.proxies.get(state as object);
    if (!p) {
      p = new Proxy(state as object, {
        get: (t, prop) => {
          const m = this.merged;
          if (m && typeof prop === "string" && prop in m) return (m as Record<string, unknown>)[prop];
          const v = Reflect.get(t, prop, t);
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      }) as KasalaStateView;
      this.proxies.set(state as object, p);
    }
    return p;
  }

  private merge(): void {
    if (this.holds.length === 0) {
      this.merged = null;
      return;
    }
    const m: HeldFields = {};
    for (const h of this.holds) Object.assign(m, h.fields);
    this.merged = m;
  }
}
