// Cross-module client data types for networking output. Owner: client-net (written by architect, complete).
// Consumed by client-app (GameController), client-characters, client-fx.

import type { ServerMessages } from "../../../shared/protocol";
import type { StepPlayerResult } from "../../../shared/sim/player";
import type {
  BallKind,
  BallState,
  BonkStateView,
  CharacterId,
  PlayerSimFields,
  PlayerView,
} from "../../../shared/types";

/**
 * One player's render-ready state for this frame.
 * Local player: predicted (interpolated between the last two predicted ticks + smoothing offset),
 * with yaw/pitch straight from Input for zero-latency look.
 * Remote players: snapshot-interpolated ~INTERP_DELAY_MS in the past.
 */
export interface PlayerFrame extends PlayerSimFields {
  id: string;
  isLocal: boolean;
  character: CharacterId;
  slot: number;
  nickname: string;
  hearts: number;
  connected: boolean;
  spectator: boolean;
}

/** One ball's render-ready state for this frame (dead-reckoned or predicted). */
export interface BallFrame {
  /** Server id, or "pred:<seq>:<index>" for a predicted ball not yet matched. */
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  state: BallState;
  kind: BallKind;
  radius: number;
  ownerId: string;
  holderId: string;
  charge: number;
  curve: boolean;
  returning: boolean;
  /** Client-side predicted throw (no server ball matched yet). */
  predicted: boolean;
  /** Bounced since the previous getBalls() call (squash + bounce SFX). Impact speed in bounceSpeed. */
  bounced: boolean;
  bounceSpeed: number;
  /** 0..1 fade for predicted balls that timed out (1 = fully visible). */
  opacity: number;
}

export type NetStatus = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

/** User-presentable join/connection failure. */
export interface NetError {
  kind: "roomFull" | "notFound" | "badNickname" | "badCharacter" | "serverDown" | "kicked" | "unknown";
  message: string;
}

/** Events emitted by Net.events: every server message plus connection lifecycle. */
export interface NetEventMap extends ServerMessages {
  /** Joined/created/reconnected a room; state is available. */
  connected: { code: string; sessionId: string; reconnected: boolean };
  /** Lost the connection; Net is trying to reconnect (TECH_BRIEF §4). */
  reconnecting: { attempt: number };
  /** Left the room for good (consented leave, failed reconnect, server gone). */
  disconnected: { error: NetError | null };
  /** After every decoded state patch (state is the live decoded object, don't mutate). */
  state: BonkStateView;
  /** state.phase changed. */
  phase: { phase: BonkStateView["phase"]; previous: BonkStateView["phase"] };
  /** A player was added/removed from state.players. */
  playerAdded: PlayerView;
  playerRemoved: { id: string };
  /**
   * The local prediction released a throw (first prediction of that input only, never on replay).
   * BallSync has already spawned the predicted ball(s); GameController plays throw feedback.
   */
  localThrow: { seq: number; result: NonNullable<StepPlayerResult["throw"]> };
  /** Other locally-predicted one-shots for instant feedback (first prediction only). */
  localStep: { seq: number; result: StepPlayerResult };
}
