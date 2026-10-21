// Per-client message budget: every client → server message (inputs included) spends one token of its client's
// bucket before RaftRoom validates it, so a flooding client costs one Map lookup per message instead of payload
// validation and world work. Plus ActionBudget, the per-player budget of a human's craft / chest messages in sim
// ticks. Owner: server-room.
//
// Token bucket: refills MESSAGE_RATE tokens per second up to MESSAGE_BURST. Legit traffic is ~32 messages per
// second (30 Hz inputs, 1 Hz pongs, a few UI clicks); a tab coming back from the background sends at most ~8
// buffered inputs at once, and the room tests' garbage-payload sweep sends 140 in one go. Over budget the message
// is dropped; `take` says "firstDrop" once per client per DROP_LOG_MS so the room logs a flood once per window.
// Time is a monotonic clock (RaftRoom passes performance.now()); a clock that still steps back re-anchors the
// bucket (no refill) instead of freezing it until the old timestamp comes round again.

/** Sustained messages per second per client (~4× legit traffic). */
export const MESSAGE_RATE = 120;
/** Bucket size: this many messages may arrive back to back. */
export const MESSAGE_BURST = 240;
/** At most one "firstDrop" (one log line) per client per this many ms. */
export const DROP_LOG_MS = 1000;

export type Admission = "ok" | "drop" | "firstDrop";

interface Bucket {
  tokens: number;
  at: number;
  /** Wall time of the last "firstDrop" verdict. */
  loggedAt: number;
}

export class MessageBudget {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly rate: number = MESSAGE_RATE,
    private readonly burst: number = MESSAGE_BURST,
    private readonly logEveryMs: number = DROP_LOG_MS,
  ) {}

  /** Spend one token of client `id` at monotonic time `nowMs`. */
  take(id: string, nowMs: number): Admission {
    let b = this.buckets.get(id);
    if (!b) {
      b = { tokens: this.burst, at: nowMs, loggedAt: Number.NEGATIVE_INFINITY };
      this.buckets.set(id, b);
    } else if (nowMs !== b.at) {
      if (nowMs > b.at) b.tokens = Math.min(this.burst, b.tokens + ((nowMs - b.at) * this.rate) / 1000);
      else if (b.loggedAt > nowMs) b.loggedAt = Number.NEGATIVE_INFINITY; // stepped back: re-anchor, no refill
      b.at = nowMs;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return "ok";
    }
    if (nowMs - b.loggedAt < this.logEveryMs) return "drop";
    b.loggedAt = nowMs;
    return "firstDrop";
  }

  /** Forget a client (it left for good). */
  forget(id: string): void {
    this.buckets.delete(id);
  }
}

/**
 * Per-player action budget in sim ticks (GCRA): `burst` actions back to back, then one per `every` ticks on
 * average. RaftRoom keeps one for a human's craft messages and one for their chest messages (Timings
 * actionCooldownTicks / actionBurst): a quick double click or a run of "Take 1" clicks is all served, a scripted
 * spam costs the world at most TICK_RATE / every validations per second per kind. Integer ticks keep it exact.
 */
export class ActionBudget {
  /** Per player: the tick at which their budget is full again ("theoretical arrival time"). */
  private readonly due = new Map<string, number>();

  constructor(
    private readonly every: number,
    private readonly burst: number,
  ) {}

  /** May `id` act at `tick`? True spends one action. */
  take(id: string, tick: number): boolean {
    const due = Math.max(this.due.get(id) ?? tick, tick);
    if (due - tick > (this.burst - 1) * this.every) return false;
    this.due.set(id, due + this.every);
    return true;
  }

  forget(id: string): void {
    this.due.delete(id);
  }

  /** Everyone starts with a full budget (match start). */
  clear(): void {
    this.due.clear();
  }
}
