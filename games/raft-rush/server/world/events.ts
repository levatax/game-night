// Events produced by RaftWorld.step(). Owner: architect (complete).
// Broadcast events are exactly ServerMessages payloads tagged with `type`; internal events never leave the server.

import type { ServerMessages, WorldEventType } from "../../shared/protocol.js";

export type BroadcastWorldEvent = { [K in WorldEventType]: { type: K } & ServerMessages[K] }[WorldEventType];

/**
 * The push-off is over: every required player is aboard after timings.launchMin, or the countdown
 * (state.launchTicksLeft) ran out with at least one aboard. The room switches to the launch phase.
 * Required = the team's participants that are alive, not downed, not washed (and connected or bot-driven).
 */
export interface LaunchRequestEvent {
  type: "launchRequest";
  tick: number;
  team: number;
  aboard: string[];
  /** Every participant not aboard. */
  left: string[];
  /** The living ones among `left` (alive, not washed; downed included): LEFT_BEHIND_PENALTY each. */
  leftBehind: string[];
}

/** Every participant of a team is washed ashore and no dawn is coming (the last night): the room ends the match. */
export interface TeamWipedEvent {
  type: "teamWiped";
  tick: number;
  team: number;
}

export type InternalWorldEvent = LaunchRequestEvent | TeamWipedEvent;

export type GameEvent = BroadcastWorldEvent | InternalWorldEvent;
export type GameEventType = GameEvent["type"];
export type GameEventOf<T extends GameEventType> = Extract<GameEvent, { type: T }>;

const INTERNAL: ReadonlySet<string> = new Set(["launchRequest", "teamWiped"]);

export function isBroadcastEvent(ev: GameEvent): ev is BroadcastWorldEvent {
  return !INTERNAL.has(ev.type);
}
