// Voice limiting for one-shots: a global cap, a per-sound cap, a retrigger guard and gain staging for repeats,
// so spamming a sound (bounces, coconut volleys, six players chopping) never clips. Owner: client-fx-audio.
// Copied from games/bonk-brawl/client/src/audio/engine/VoicePool.ts (unchanged).

import { safeDisconnect } from "../synth/dsp";

export interface PoolVoice {
  readonly key: string;
  readonly startedAt: number;
  /** Absolute time the last source stops. */
  readonly endsAt: number;
  /** Voice output gain (fade target when the voice is stolen). */
  readonly output: GainNode;
  /** Nodes owned by the voice wrapper (output, panner), disconnected when it ends. */
  readonly chain: ReadonlyArray<AudioNode>;
  readonly sources: ReadonlyArray<AudioScheduledSourceNode>;
}

/** Fade applied to a stolen voice so the cut never clicks. */
const STEAL_FADE = 0.02;
/** Voices whose end passed this long ago are dropped even if `ended` never fired (suspended ctx). */
const PRUNE_GRACE = 0.25;

export class VoicePool {
  private readonly voices: PoolVoice[] = [];

  constructor(private readonly maxVoices: number) {}

  get size(): number {
    return this.voices.length;
  }

  /**
   * Make room for a new voice of `key`. Returns how many voices of that key are still playing
   * (for gain staging), or -1 if one started less than `minGap` seconds ago (drop the new one).
   */
  admit(key: string, cap: number, now: number, minGap: number): number {
    this.prune(now);
    let same = 0;
    let oldestSame: PoolVoice | null = null;
    let lastStart = -Infinity;
    for (const v of this.voices) {
      if (v.key !== key) continue;
      same++;
      lastStart = Math.max(lastStart, v.startedAt);
      if (!oldestSame || v.startedAt < oldestSame.startedAt) oldestSame = v;
    }
    if (now - lastStart < minGap) return -1;
    if (oldestSame && same >= Math.max(1, cap)) {
      this.kill(oldestSame, now);
      same--;
    }
    while (this.voices.length >= this.maxVoices) this.kill(this.voices[0]!, now);
    return same;
  }

  /** Track a started voice; `finalSource` ending releases its nodes. */
  add(v: PoolVoice, finalSource: AudioScheduledSourceNode | null): void {
    this.voices.push(v);
    if (finalSource) finalSource.addEventListener("ended", () => this.release(v), { once: true });
  }

  /** Fade out and stop every voice (leaving the game, dispose). */
  clear(now: number): void {
    while (this.voices.length > 0) this.kill(this.voices[0]!, now);
  }

  private kill(v: PoolVoice, now: number): void {
    this.remove(v);
    const g = v.output.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + STEAL_FADE);
    for (const s of v.sources) {
      try {
        s.stop(now + STEAL_FADE + 0.01);
      } catch {
        // Already stopped (older engines throw on a second stop()).
      }
    }
  }

  private release(v: PoolVoice): void {
    this.remove(v);
    for (const node of v.chain) safeDisconnect(node);
  }

  private prune(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i]!;
      if (v.endsAt + PRUNE_GRACE < now) this.release(v);
    }
  }

  private remove(v: PoolVoice): void {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }
}
