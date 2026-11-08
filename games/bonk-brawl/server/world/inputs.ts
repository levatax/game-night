// Per-player server input queues (TECH_BRIEF §3, ARCHITECTURE §7.1).
//
// One input is consumed per player per tick. An empty queue repeats the last consumed input with
// its edge bits cleared (THROW is a level bit and keeps charging). A queue that grows beyond
// INPUT_QUEUE_MAX drops its oldest input but carries that input's edge bits forward, so a press
// is never lost. Seqs must strictly increase; clear() forgets the last seen seq (reloaded clients
// restart at 1).

import { INPUT_QUEUE_MAX, PITCH_LIMIT } from "../../shared/constants.js";
import { EDGE_BUTTONS, type InputCmd } from "../../shared/protocol.js";
import { clamp, wrapAngle } from "../../shared/sim/math.js";

/** Every defined BTN bit. */
const BUTTON_MASK = 63;
/** player.lastSeq is a uint32 in the schema. */
const MAX_SEQ = 0xffffffff;

interface QueueState {
  queue: InputCmd[];
  /** Last consumed input with its edge bits already cleared (what an empty tick repeats). */
  repeat: InputCmd | null;
  /** Highest seq queued or consumed since the last clear(). */
  lastSeenSeq: number;
}

/** Result of taking this tick's input. */
export interface TakenInput {
  cmd: InputCmd;
  /** True when a queued input was consumed (its seq becomes player.lastSeq); false when repeating. */
  consumed: boolean;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validate an untrusted input payload and return a clamped copy, or null when malformed:
 * seq must be a positive integer, the axes/look finite numbers and buttons an integer.
 * moveX/moveZ are clamped to [-1, 1] and the vector length to 1, pitch to ±PITCH_LIMIT, yaw is
 * wrapped, buttons are masked to the defined bits.
 */
export function sanitizeInput(raw: unknown): InputCmd | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { seq, moveX, moveZ, yaw, pitch, buttons } = raw as Record<string, unknown>;
  if (!isFiniteNumber(seq) || !Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) return null;
  if (!isFiniteNumber(moveX) || !isFiniteNumber(moveZ)) return null;
  if (!isFiniteNumber(yaw) || !isFiniteNumber(pitch)) return null;
  if (!isFiniteNumber(buttons) || !Number.isInteger(buttons)) return null;

  let mx = clamp(moveX, -1, 1);
  let mz = clamp(moveZ, -1, 1);
  const len = Math.sqrt(mx * mx + mz * mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  return {
    seq,
    moveX: mx,
    moveZ: mz,
    yaw: wrapAngle(yaw),
    pitch: clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT),
    buttons: buttons & BUTTON_MASK,
  };
}

export class InputQueues {
  private readonly byId = new Map<string, QueueState>();

  /** Enqueue a sanitized input. Returns false when it was dropped as stale (seq not increasing). */
  push(sessionId: string, cmd: InputCmd): boolean {
    const q = this.stateOf(sessionId);
    if (cmd.seq <= q.lastSeenSeq) return false;
    q.lastSeenSeq = cmd.seq;
    if (q.queue.length >= INPUT_QUEUE_MAX) {
      const dropped = q.queue.shift();
      const carry = (dropped?.buttons ?? 0) & EDGE_BUTTONS;
      const next = q.queue[0] ?? cmd;
      next.buttons |= carry;
    }
    q.queue.push(cmd);
    return true;
  }

  /** This tick's input: the oldest queued one, else a repeat of the last one; null if none ever. */
  take(sessionId: string): TakenInput | null {
    const q = this.byId.get(sessionId);
    if (!q) return null;
    const cmd = q.queue.shift();
    if (cmd) {
      q.repeat = { ...cmd, buttons: cmd.buttons & ~EDGE_BUTTONS };
      return { cmd, consumed: true };
    }
    return q.repeat ? { cmd: q.repeat, consumed: false } : null;
  }

  /** Discard everything queued; returns the highest discarded seq (0 when the queue was empty). */
  drain(sessionId: string): number {
    const q = this.byId.get(sessionId);
    if (!q || q.queue.length === 0) return 0;
    const last = q.queue[q.queue.length - 1].seq;
    q.queue.length = 0;
    return last;
  }

  /** Forget queue, repeat input AND the last seen seq (one player, or everyone). */
  clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.byId.clear();
      return;
    }
    this.byId.delete(sessionId);
  }

  /** New round: drop queued and repeat inputs but keep each player's last seen seq. */
  resetQueues(): void {
    for (const q of this.byId.values()) {
      q.queue.length = 0;
      q.repeat = null;
    }
  }

  queuedCount(sessionId: string): number {
    return this.byId.get(sessionId)?.queue.length ?? 0;
  }

  private stateOf(sessionId: string): QueueState {
    let q = this.byId.get(sessionId);
    if (!q) {
      q = { queue: [], repeat: null, lastSeenSeq: 0 };
      this.byId.set(sessionId, q);
    }
    return q;
  }
}
