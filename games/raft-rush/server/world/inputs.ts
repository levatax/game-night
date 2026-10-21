// Per-player server input queues (docs/ARCHITECTURE.md §4.1). Owner: server-world.
// Copied from games/bonk-brawl/server/world/inputs.ts; the button mask and edge bits come from shared/protocol.ts.
//
// One input is consumed per player per tick. An empty queue repeats the last consumed input with its edge bits
// cleared (THROW / INTERACT / SPRINT are level bits and keep charging / channeling / sprinting). A queue that
// grows beyond INPUT_QUEUE_MAX drops its oldest input but carries that input's edge bits forward, so a press is
// never lost. Seqs must strictly increase; clear() forgets the last seen seq (reloaded clients restart at 1).
// A client that stops sending (hidden tab, app switch) must not keep running: after REPEAT_HOLD_TICKS repeats the
// repeat drops its movement and the SPRINT / INTERACT levels (look and a held THROW charge are kept, so nothing
// fires by surprise); ordinary packet jitter (a few ticks) is unaffected.
// Bots go through exactly the same queues (BotDesk → RaftWorld.queueInput).

import { INPUT_QUEUE_MAX, PITCH_LIMIT } from "../../shared/constants.js";
import { BTN, BUTTON_MASK, EDGE_BUTTONS, type InputCmd } from "../../shared/protocol.js";
import { clamp, wrapAngle } from "../../shared/sim/math.js";

/** player.lastSeq is a uint32 in the schema. */
const MAX_SEQ = 0xffffffff;
/** Repeats (≈ 0.33 s at 30 Hz) after which a silent client stops moving / sprinting / channeling. */
export const REPEAT_HOLD_TICKS = 10;
const HELD_LEVELS = BTN.SPRINT | BTN.INTERACT;

interface QueueState {
  queue: InputCmd[];
  /** Last consumed input with its edge bits already cleared (what an empty tick repeats). */
  repeat: InputCmd | null;
  /** Consecutive ticks the repeat has been used. */
  repeats: number;
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
 * Validate an untrusted input payload and return a clamped copy, or null when malformed: seq must be a positive
 * integer, the axes / look finite numbers and buttons an integer. moveX / moveZ are clamped to [-1, 1] and the
 * vector length to 1, pitch to ±PITCH_LIMIT, yaw is wrapped, buttons are masked to BUTTON_MASK.
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

/** The per-player queues. */
export class InputQueues {
  private readonly byId = new Map<string, QueueState>();

  /** Enqueue a sanitized input. Returns false when it was dropped as stale (seq not increasing). */
  push(id: string, cmd: InputCmd): boolean {
    const q = this.stateOf(id);
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
  take(id: string): TakenInput | null {
    const q = this.byId.get(id);
    if (!q) return null;
    const cmd = q.queue.shift();
    if (cmd) {
      q.repeat = { ...cmd, buttons: cmd.buttons & ~EDGE_BUTTONS };
      q.repeats = 0;
      return { cmd, consumed: true };
    }
    if (!q.repeat) return null;
    q.repeats++;
    const r = q.repeat;
    if (q.repeats > REPEAT_HOLD_TICKS && (r.moveX !== 0 || r.moveZ !== 0 || (r.buttons & HELD_LEVELS) !== 0)) {
      q.repeat = { ...r, moveX: 0, moveZ: 0, buttons: r.buttons & ~HELD_LEVELS };
    }
    return { cmd: q.repeat, consumed: false };
  }

  /** Discard everything queued; returns the highest discarded seq (0 when the queue was empty). */
  drain(id: string): number {
    const q = this.byId.get(id);
    if (!q || q.queue.length === 0) return 0;
    const last = q.queue[q.queue.length - 1]!.seq;
    q.queue.length = 0;
    return last;
  }

  /** Forget queue, repeat input AND the last seen seq (one player, or everyone). */
  clear(id?: string): void {
    if (id === undefined) {
      this.byId.clear();
      return;
    }
    this.byId.delete(id);
  }

  /**
   * New match: drop queued and repeat inputs but keep each player's last seen seq; with `keep`, players it
   * rejects (no longer in the room) are forgotten entirely.
   */
  resetQueues(keep?: (id: string) => boolean): void {
    for (const [id, q] of this.byId) {
      if (keep && !keep(id)) {
        this.byId.delete(id);
        continue;
      }
      q.queue.length = 0;
      q.repeat = null;
      q.repeats = 0;
    }
  }

  queuedCount(id: string): number {
    return this.byId.get(id)?.queue.length ?? 0;
  }

  /** Players with a queue record (tests: nothing outlives its player). */
  ids(): string[] {
    return [...this.byId.keys()];
  }

  private stateOf(id: string): QueueState {
    let q = this.byId.get(id);
    if (!q) {
      q = { queue: [], repeat: null, repeats: 0, lastSeenSeq: 0 };
      this.byId.set(id, q);
    }
    return q;
  }
}
