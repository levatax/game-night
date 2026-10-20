// Shared bag of client modules + small helpers for the game/ helpers. Owner: client-net-game.
// Every module in Ctx is wrapped by guard(): a throwing method is logged once and returns undefined (a
// rejected promise resolves to undefined), so one module's bug never stops the show or the frame loop.

import * as THREE from "three";
import type { Announcer } from "../audio/Announcer";
import type { AudioEngine, SfxId, SfxOptions } from "../audio/AudioEngine";
import type { Controls } from "../input/Controls";
import type { Net } from "../net/Net";
import type { Cards } from "../scene/Cards";
import type { Characters, DealerApi } from "../scene/Characters";
import type { Fx } from "../scene/Fx";
import type { SeatPose, Stage } from "../scene/Stage";
import type { Wheel } from "../scene/Wheel";
import type { Hud } from "../ui/Hud";
import type { Menu } from "../ui/Menu";
import type { Overlays } from "../ui/Overlays";
import type { DisplayState } from "./display";
import { isParticipant } from "./turn";

export interface Ctx {
  net: Net;
  stage: Stage;
  characters: Characters;
  dealer: DealerApi;
  cards: Cards;
  wheel: Wheel;
  fx: Fx;
  audio: AudioEngine;
  announcer: Announcer;
  menu: Menu;
  hud: Hud;
  overlays: Overlays;
  controls: Controls;
  later: Later;
  display: DisplayState;
}

// ------------------------------------------------------------------------- guards
const logged = new Set<string>();

/** console.error once per key (per module method), so a broken module doesn't flood the console at 60 fps. */
export function logOnce(key: string, err: unknown): void {
  if (logged.has(key)) return;
  logged.add(key);
  console.error(`[kasala] ${key} failed`, err);
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Proxy that turns exceptions in `target`'s methods into a logged no-op. Properties pass through. A method the
 * module doesn't have (yet) becomes a logged no-op too, so one missing contract method can't cut a whole
 * choreography short.
 */
export function guard<T extends object>(name: string, target: T): T {
  const cache = new Map<PropertyKey, { orig: AnyFn; wrapped: AnyFn }>();
  const missing = new Map<PropertyKey, AnyFn>();
  return new Proxy(target, {
    get(t, prop) {
      let v: unknown;
      try {
        v = Reflect.get(t, prop, t);
      } catch (err) {
        logOnce(`${name}.${String(prop)}`, err);
        return undefined;
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
  });
}

/** Stand-in for a module whose constructor threw: every property is callable and returns undefined. */
export function deadModule<T>(): T {
  const fn = function () {
    return undefined;
  };
  const dead: unknown = new Proxy(fn, {
    get: (_t, prop) => (prop === "then" ? undefined : prop === Symbol.toPrimitive ? () => 0 : dead),
    apply: () => undefined,
  });
  return dead as T;
}

/** Build a module, or log and fall back to a dead stand-in. */
export function make<T>(name: string, build: () => T): { value: T; ok: boolean } {
  try {
    return { value: build(), ok: true };
  } catch (err) {
    logOnce(`${name} constructor`, err);
    return { value: deadModule<T>(), ok: false };
  }
}

// ------------------------------------------------------------------------- timers
/** Run fn after `ms`, unless cancelAll() happened meanwhile (room left / reset). Exceptions are logged. */
export class Later {
  private gen = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  get generation(): number {
    return this.gen;
  }

  run(ms: number, fn: () => void): void {
    const gen = this.gen;
    const t = setTimeout(
      () => {
        this.timers.delete(t);
        if (gen !== this.gen) return;
        try {
          fn();
        } catch (err) {
          logOnce(`later:${fn.name || "anon"}`, err);
        }
      },
      Math.max(0, ms),
    );
    this.timers.add(t);
  }

  /** Continue after `p` (bounded by maxMs) unless cancelled meanwhile. */
  after(p: Promise<unknown> | undefined, maxMs: number, fn: () => void): void {
    const gen = this.gen;
    void withTimeout(p, maxMs).then(() => {
      if (gen !== this.gen) return;
      try {
        fn();
      } catch (err) {
        logOnce(`later.after:${fn.name || "anon"}`, err);
      }
    });
  }

  cancelAll(): void {
    this.gen++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves when `p` settles or after `ms`, whichever comes first. Never rejects. */
export function withTimeout(p: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!p) return Promise.resolve();
  return Promise.race([Promise.resolve(p).then(
    () => undefined,
    () => undefined,
  ), sleep(ms)]);
}

// ------------------------------------------------------------------------ places
const tmpV = new THREE.Vector3();
const panV = new THREE.Vector3();

/** World points of the people and props, from the live state (null when the player isn't seated). */
export class Spots {
  constructor(private ctx: Ctx) {}

  /**
   * Seat of a player who actually sits at the table: in the lobby every non-spectator, in a match the
   * participants only (a mid-match spectator's seat index is past the table, it would alias the last seat).
   */
  private seatOf(playerId: string): number | null {
    const s = this.ctx.net.state;
    const p = s?.players.get(playerId);
    if (!s || !p || p.spectator) return null;
    if (s.phase !== "lobby" && !isParticipant(s, playerId)) return null;
    return p.seat;
  }

  pose(playerId: string): SeatPose | null {
    const seat = this.seatOf(playerId);
    if (seat === null) return null;
    return this.ctx.stage.seatPose(seat, this.ctx.stage.seatCount) ?? null;
  }

  /** Seated at the table (has a 3D seat, character and stack). */
  seated(playerId: string): boolean {
    return this.seatOf(playerId) !== null;
  }

  seat(playerId: string): number | undefined {
    return this.seatOf(playerId) ?? undefined;
  }

  /** Top of the player's money stack. */
  stack(playerId: string, out = new THREE.Vector3()): THREE.Vector3 | null {
    const pose = this.pose(playerId);
    if (!pose) return null;
    out.copy(pose.stack);
    out.y += 0.08;
    return out;
  }

  head(playerId: string, out = new THREE.Vector3()): THREE.Vector3 | null {
    if (!this.seated(playerId)) return null;
    if (this.ctx.characters.anchor(playerId, "head", out)) return out;
    const pose = this.pose(playerId);
    if (!pose) return null;
    return out.copy(pose.chair).add(tmpV.set(0, 1.45, 0));
  }

  part(playerId: string, part: "hand" | "chest" | "hat", out = new THREE.Vector3()): THREE.Vector3 | null {
    if (!this.seated(playerId)) return null;
    if (this.ctx.characters.anchor(playerId, part, out)) return out;
    return this.head(playerId, out);
  }

  kumbara(out = new THREE.Vector3()): THREE.Vector3 {
    const k = this.ctx.stage.anchors?.kumbara;
    return k ? out.copy(k) : out.set(0.9, 1, 0.3);
  }

  deck(out = new THREE.Vector3()): THREE.Vector3 {
    const d = this.ctx.stage.anchors?.deck;
    return d ? out.copy(d) : out.set(0, 0.9, 0);
  }

  center(out = new THREE.Vector3()): THREE.Vector3 {
    return this.deck(out).add(tmpV.set(0, 0.1, 0));
  }

  /** Stereo pan −0.8..0.8 of the player's seat relative to the camera (0 when unknown or not seated). */
  pan(playerId: string): number {
    // In first person my own pile sits to the lower right of the view, but my sounds come from where I sit.
    if (playerId === this.ctx.net.myId && this.ctx.stage.firstPerson.active) return 0;
    const at = this.stack(playerId, panV);
    if (!at) return 0;
    const p = this.ctx.stage.panOf(at);
    return typeof p === "number" && Number.isFinite(p) ? Math.max(-0.8, Math.min(0.8, p)) : 0;
  }
}

// ------------------------------------------------------------------------- sound
/** Character mumbles / crowd voices, throttled so a big moment doesn't turn into a cacophony. */
export class Voices {
  private lastAt = 0;
  constructor(
    private ctx: Ctx,
    private spots: Spots,
  ) {}

  say(id: SfxId, playerId: string | null, opts: SfxOptions = {}, gapMs = 160): void {
    const now = performance.now();
    if (now - this.lastAt < gapMs) return;
    this.lastAt = now;
    this.ctx.audio.sfx(id, {
      volume: opts.volume ?? 0.7,
      rate: opts.rate ?? 0.9 + Math.random() * 0.25,
      pan: opts.pan ?? (playerId ? this.spots.pan(playerId) : 0),
    });
  }
}
