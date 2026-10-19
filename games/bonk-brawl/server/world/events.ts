// Server-internal GameEvent union produced by GameWorld. Written by the architect (complete).
//
// Broadcast events are exactly the protocol payloads plus a `type` discriminator equal to the
// message name, so BonkRoom can do `this.broadcast(ev.type, ev)` after scoring. Internal events
// (not broadcast) carry information only the room needs.

import type { ServerMessages, WorldEventType } from "../../shared/protocol.js";

/** A world event that is broadcast to clients unchanged (the extra `type` field is harmless). */
export type BroadcastWorldEvent = { [K in WorldEventType]: { type: K } & ServerMessages[K] }[WorldEventType];

/**
 * A ball left play: fell below BALL_KILL_Y, or a bonus (Triple Shot) ball came to rest and was
 * removed. `respawn` is false for bonus balls (they never count toward the arena's ball target).
 * The room schedules a center drop BALL_RESPAWN_TICKS later when respawn is true and the
 * ball count is below target.
 */
export interface BallLostEvent {
  type: "ballLost";
  tick: number;
  ballId: string;
  respawn: boolean;
}

export type InternalWorldEvent = BallLostEvent;

export type GameEvent = BroadcastWorldEvent | InternalWorldEvent;

export type GameEventType = GameEvent["type"];

/** Narrow a GameEvent to one type. */
export type GameEventOf<T extends GameEventType> = Extract<GameEvent, { type: T }>;

const INTERNAL: ReadonlySet<string> = new Set<InternalWorldEvent["type"]>(["ballLost"]);

export function isBroadcastEvent(ev: GameEvent): ev is BroadcastWorldEvent {
  return !INTERNAL.has(ev.type);
}
