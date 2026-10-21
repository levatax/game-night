// Cross-module client data types for networking output. Owner: client-net (written by the architect, complete).
// Consumed by client-app (GameController), client-characters, client-fx, client-render.

import type { ServerMessages } from "../../../shared/protocol";
import type { StepPlayerResult } from "../../../shared/sim/player";
import type {
  CharacterId,
  InvKind,
  ItemKind,
  MonsterKind,
  MonsterMode,
  PlayerSimFields,
  PlayerView,
  ProjectileState,
  RaftStateView,
} from "../../../shared/types";

/**
 * One player's render-ready state for this frame.
 * Local player: predicted (lerp between the last two predicted ticks + smoothing offset), yaw/pitch straight
 * from Input for zero-latency look. Remote players: snapshot-interpolated ~INTERP_DELAY_MS in the past.
 */
export interface PlayerFrame extends PlayerSimFields {
  id: string;
  isLocal: boolean;
  character: CharacterId;
  seat: number;
  team: number;
  nickname: string;
  bot: boolean;
  connected: boolean;
  spectator: boolean;
  washed: boolean;
  /** Inventory counts (inv kinds are in PlayerSimFields). */
  cnt0: number;
  cnt1: number;
  cnt2: number;
  cnt3: number;
  fishState: number;
  fishSpot: number;
  fuseTicks: number;
  torchTicks: number;
  cosmetic: string;
  golden: boolean;
  /** Horizontal speed (m/s) for animation. */
  speed: number;
}

/** One projectile's render-ready state (dead-reckoned server projectile or a predicted throw). */
export interface ProjectileFrame {
  /** Server id, or "pred:<seq>:<index>" for a predicted projectile not matched yet. */
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  state: ProjectileState;
  kind: ItemKind;
  radius: number;
  ownerId: string;
  charge: number;
  /** Fish bait currently luring (glow / smell lines). */
  bait: boolean;
  predicted: boolean;
  /** Bounced since the previous getProjectiles() call (squash + bounce SFX), impact speed in bounceSpeed. */
  bounced: boolean;
  bounceSpeed: number;
  /** 0..1 fade for predicted projectiles that timed out (1 = fully visible). */
  opacity: number;
  /** Seconds since it was thrown / spawned (spin animation). */
  age: number;
}

/** One monster's render-ready state (snapshot-interpolated like remote players). */
export interface MonsterFrame {
  id: string;
  kind: MonsterKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  mode: MonsterMode;
  modeTicks: number;
  targetId: string;
  carry: InvKind;
  /** Horizontal speed (m/s) for leg animation. */
  speed: number;
}

export type NetStatus = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

/** User-presentable join / connection failure. `message` is an i18n key under `menu.` (e.g. "menu.errRoomFull"). */
export interface NetError {
  kind: "roomFull" | "notFound" | "badNickname" | "badCharacter" | "serverDown" | "serverBusy" | "serverRestart" | "outdated" | "kicked" | "unknown";
  message: string;
}

/** Events emitted by Net.events: every server message plus connection lifecycle. */
export interface NetEventMap extends ServerMessages {
  /** Joined / created / reconnected a room; state is available. */
  connected: { code: string; sessionId: string; reconnected: boolean };
  /** Lost the connection; Net is trying to reconnect. */
  reconnecting: { attempt: number };
  /** Left the room for good (consented leave, failed reconnect, server gone). */
  disconnected: { error: NetError | null };
  /** After every decoded state patch (state is the live decoded object, don't mutate). */
  state: RaftStateView;
  /** state.phase changed. */
  phase: { phase: RaftStateView["phase"]; previous: RaftStateView["phase"] };
  playerAdded: PlayerView;
  playerRemoved: { id: string };
  /**
   * The island to show changed (welcome / matchStart / seed change in the lobby). Net has already generated
   * it (generateIsland(seed, layout)); `mismatch` is true when its gridHash/defHash differ from the server's.
   */
  island: { seed: number; layout: RaftStateView["layout"]; mismatch: boolean };
  /** The local prediction released a throw / toss (first prediction only, never on replay). ProjectileSync has spawned the predicted projectile(s). */
  localThrow: { seq: number; result: NonNullable<StepPlayerResult["throw"]> };
  /** Other locally-predicted one-shots for instant feedback (first prediction only). */
  localStep: { seq: number; result: StepPlayerResult };
}
