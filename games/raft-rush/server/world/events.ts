// Events produced by RaftWorld.step(). Owner: architect (complete).
// Broadcast events are exactly ServerMessages payloads tagged with `type`; internal events never leave the server.

import type { ServerMessages, WorldEventType } from "../../shared/protocol.js";

export type BroadcastWorldEvent = { [K in WorldEventType]: { type: K } & ServerMessages[K] }[WorldEventType];

/**
 * The raft is ready and either every required player is aboard, or the boarding countdown
 * (state.launchTicksLeft) ran out with at least one aboard. The room switches to the launch phase.
 * Required = the team's participants that are alive, not downed, not washed (and connected or bot-driven).
 */
export interface LaunchRequestEvent {
  type: "launchRequest";
  tick: number;
  team: number;
  aboard: string[];
  left: string[];
}

/** Every participant of a team is washed ashore and no dawn is coming (night 3): the room ends the match. */
export interface TeamWipedEvent {
  type: "teamWiped";
  tick: number;
  team: number;
}

/** The anti-soft-lock supply cache landed by the wreck (the room tells the players). */
export interface SupplyCacheEvent {
  type: "supplyCache";
  tick: number;
  team: number;
  pos: { x: number; y: number; z: number };
  items: Record<string, number>;
}

export type InternalWorldEvent = LaunchRequestEvent | TeamWipedEvent | SupplyCacheEvent;

export type GameEvent = BroadcastWorldEvent | InternalWorldEvent;
export type GameEventType = GameEvent["type"];
export type GameEventOf<T extends GameEventType> = Extract<GameEvent, { type: T }>;

const INTERNAL: ReadonlySet<string> = new Set(["launchRequest", "teamWiped", "supplyCache"]);

export function isBroadcastEvent(ev: GameEvent): ev is BroadcastWorldEvent {
  return !INTERNAL.has(ev.type);
}
