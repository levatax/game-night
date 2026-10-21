// The events RaftWorld buffers between two drains. Owner: server-world.
//
// The room drains after every step (docs/ARCHITECTURE.md §4.2 steps 5–6), but craft / chest messages and
// removals arriving between two ticks add to the same buffer, so one client spamming them could grow it without
// bound. Two guards:
// - identical rejects (same tick, player, action, reason and interact kind) coalesce into the first one until
//   the next drain;
// - a hard cap of EVENT_BUFFER_CAP events. At the cap a newcomer only gets in at the expense of the (type, actor)
//   buffered most often, and only while that one holds at least two more events than the newcomer's own (its
//   oldest event goes); otherwise the newcomer is dropped. So a flood from one actor drops its own repeats and
//   gives way to anybody else's events, rejects included. Internal events (launchRequest / teamWiped) are never
//   dropped: they evict the same way, or go past the cap when nothing broadcast is buffered. The first overflow
//   logs one warning.
// A legit tick stays far below the cap (MAX_PLAYERS players, MONSTER_CAP monsters, MAX_PROJECTILES projectiles).
// The buffer only carries feedback: state lives in the schema, so a dropped event never desyncs a client.

import { isBroadcastEvent, type GameEvent, type GameEventOf } from "./events.js";

/** Events buffered between two drains at most. */
export const EVENT_BUFFER_CAP = 512;

/** Fields naming who / what an event is about, most specific first (the actor part of the duplicate key). */
const ACTOR_FIELDS = ["playerId", "ownerId", "throwerId", "id", "projectileId", "byId"] as const;
type ActorFields = Partial<Record<(typeof ACTOR_FIELDS)[number], unknown>>;

export interface EventBufferStats {
  /** Events dropped (or evicted) at the cap. */
  dropped: number;
  /** Rejects folded into an identical one. */
  coalesced: number;
}

export class EventBuffer {
  private events: GameEvent[] = [];
  /** Keys of the rejects buffered for `rejectTick`. */
  private readonly rejects = new Set<string>();
  private rejectTick = -1;
  /** While the buffer sits at the cap: the duplicate key of every buffered event, "" for internal ones (parallel to `events`)… */
  private keys: string[] | null = null;
  /** …how many buffered broadcast events share each key… */
  private readonly counts = new Map<string, number>();
  /** …and the one buffered most often (null = no broadcast event buffered; stale = recount before use). */
  private top: string | null = null;
  private topStale = false;
  private warned = false;
  private readonly totals: EventBufferStats = { dropped: 0, coalesced: 0 };

  constructor(private readonly cap = EVENT_BUFFER_CAP) {}

  get length(): number {
    return this.events.length;
  }

  /** Lifetime drop / coalesce counts (diagnostics, tests). */
  stats(): Readonly<EventBufferStats> {
    return this.totals;
  }

  push(ev: GameEvent): void {
    if (ev.type === "reject" && !this.firstReject(ev)) return;
    if (this.events.length < this.cap) this.events.push(ev);
    else this.overflow(ev);
  }

  /** Hand every buffered event over and start empty. */
  drain(): GameEvent[] {
    const out = this.events;
    this.events = [];
    this.rejects.clear();
    this.rejectTick = -1;
    this.keys = null;
    this.counts.clear();
    this.top = null;
    this.topStale = false;
    return out;
  }

  /** False when an identical reject of the same tick is already buffered. */
  private firstReject(ev: GameEventOf<"reject">): boolean {
    if (ev.tick !== this.rejectTick) {
      this.rejects.clear();
      this.rejectTick = ev.tick;
    }
    const key = `${ev.playerId}|${ev.action}|${ev.reason}|${ev.interact ?? ""}`;
    if (this.rejects.has(key)) {
      this.totals.coalesced++;
      return false;
    }
    this.rejects.add(key);
    return true;
  }

  private overflow(ev: GameEvent): void {
    if (!this.warned) {
      this.warned = true;
      console.warn(`[raft-rush] world: ${this.cap} events buffered since the last drain; dropping the most repeated ones (first: ${ev.type})`);
    }
    const keys = this.keys ?? this.index();
    const internal = !isBroadcastEvent(ev);
    const key = internal ? "" : duplicateKey(ev);
    const top = this.mostBuffered();
    // Taking one from `top` must leave it ahead of the newcomer's key, else the newcomer is the repeat.
    if (!internal && (this.counts.get(key) ?? 0) + 2 > (top === null ? 0 : this.counts.get(top)!)) {
      this.totals.dropped++;
      return;
    }
    if (top !== null) {
      const at = keys.indexOf(top);
      this.events.splice(at, 1);
      keys.splice(at, 1);
      this.uncount(top);
      this.totals.dropped++;
    }
    this.events.push(ev);
    keys.push(key);
    if (!internal) this.count(key);
  }

  /** First overflow since the last drain: key every buffered event (internal ones aren't counted). */
  private index(): string[] {
    const keys = this.events.map((e) => (isBroadcastEvent(e) ? duplicateKey(e) : ""));
    for (const k of keys) if (k !== "") this.count(k);
    this.keys = keys;
    return keys;
  }

  private count(key: string): void {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (!this.topStale && (this.top === null || n > this.counts.get(this.top)!)) this.top = key;
  }

  private uncount(key: string): void {
    const n = (this.counts.get(key) ?? 0) - 1;
    if (n > 0) this.counts.set(key, n);
    else this.counts.delete(key);
    if (key === this.top) this.topStale = true;
  }

  /** The broadcast key buffered most often (ties: the one buffered first); null = none buffered. */
  private mostBuffered(): string | null {
    if (this.topStale) {
      this.topStale = false;
      this.top = null;
      let best = 0;
      for (const [k, n] of this.counts) {
        if (n > best) {
          best = n;
          this.top = k;
        }
      }
    }
    return this.top;
  }
}

/** `type|actor`: the first non-empty actor field (see ACTOR_FIELDS), or the bare type. */
export function duplicateKey(ev: GameEvent): string {
  const fields = ev as ActorFields;
  for (const f of ACTOR_FIELDS) {
    const v = fields[f];
    if (typeof v === "string" && v !== "") return `${ev.type}|${v}`;
  }
  return ev.type;
}
