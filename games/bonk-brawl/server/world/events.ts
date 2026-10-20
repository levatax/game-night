// Server-internal GameEvent union produced by GameWorld. Written by the architect (complete).
//
// Broadcast events are exactly the protocol payloads plus a `type` discriminator equal to the
// message name, so BonkRoom can do `this.broadcast(ev.type, toMessage(ev))` after scoring. Internal
// events (not broadcast) carry information only the room needs.
//
// The three power-up payloads have their own `type` field (the PowerUpType), which would collide
// with the discriminator (the intersection is `never`, so they could not be built). Those events
// carry it as `powerUpType` instead and toMessage() restores the exact protocol payload.

import type { ServerMessages, WorldEventType } from "../../shared/protocol.js";
import type { PowerUpType } from "../../shared/types.js";

type PowerUpEventType = "powerUpWarning" | "powerUpSpawn" | "powerUpPickup";
type PlainEventType = Exclude<WorldEventType, PowerUpEventType>;

/** A world event broadcast unchanged (the extra `type` field is harmless to clients). */
type PlainWorldEvent = { [K in PlainEventType]: { type: K } & ServerMessages[K] }[PlainEventType];

/** A power-up world event: the payload's own `type` travels as `powerUpType`. */
type PowerUpWorldEvent = {
  [K in PowerUpEventType]: { type: K; powerUpType: PowerUpType } & Omit<ServerMessages[K], "type">;
}[PowerUpEventType];

/** A world event that is broadcast to clients under its `type` (payload: toMessage(ev)). */
export type BroadcastWorldEvent = PlainWorldEvent | PowerUpWorldEvent;

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
const POWER_UP_EVENTS: ReadonlySet<string> = new Set<PowerUpEventType>(["powerUpWarning", "powerUpSpawn", "powerUpPickup"]);

export function isBroadcastEvent(ev: GameEvent): ev is BroadcastWorldEvent {
  return !INTERNAL.has(ev.type);
}

function isPowerUpEvent(ev: BroadcastWorldEvent): ev is PowerUpWorldEvent {
  return POWER_UP_EVENTS.has(ev.type);
}

/** The exact protocol payload to send under `ev.type`. */
export function toMessage(ev: BroadcastWorldEvent): ServerMessages[WorldEventType] {
  if (!isPowerUpEvent(ev)) return ev;
  const { type: _name, powerUpType, ...payload } = ev;
  return { ...payload, type: powerUpType };
}
