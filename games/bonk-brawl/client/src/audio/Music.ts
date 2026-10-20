// Procedural music: lobby / fight / sudden-death loops + jingles. Owner: client-audio.

import { MusicCore } from "./music/MusicCore";
import { Ticker } from "./music/ticker";

/** "none" = silence. */
export type MusicTrack = "none" | "lobby" | "fight" | "suddenDeath";
export type Jingle = "roundWin" | "matchWin" | "roundLose";

/** Scheduler wake-up period and how far ahead it schedules (s). */
const TICK_MS = 25;
const LOOKAHEAD = 0.12;
/** In a background tab timers may fire only once a second: schedule further ahead there. */
const HIDDEN_LOOKAHEAD = 1.6;

/**
 * Upbeat goofy loops (~120 BPM), all synthesized: Karplus-Strong ukulele strums, kazoo lead
 * (buzzy sawtooth + vibrato + formant band-passes), xylophone counter-melody (struck partials),
 * plucky bass, light kick/snare/shaker/woodblock from noise and sines. Lookahead scheduler
 * (25 ms timer, ~120 ms ahead).
 * - lobby: relaxed 110 BPM; fight: 120 BPM, busier; suddenDeath: fight arrangement with tempo
 *   ramped by setTempo (1.0 → 1.35) and a tension layer.
 * - play(track) crossfades ~0.6 s; same track → no-op.
 * - jingle(): short stinger (2–3 s) that ducks the loop to 20% and restores it afterwards.
 *
 * The sequencer lives in music/MusicCore.ts (score in music/songs.ts, music/jingles.ts). Its
 * timer is a Worker (music/ticker.ts) so it keeps time in background tabs, the lookahead grows
 * while the tab is hidden, and a late timer skips missed steps instead of bursting them.
 */
export class Music {
  private readonly core: MusicCore;
  private readonly ticker: Ticker;
  private lookahead = LOOKAHEAD;
  private disposed = false;

  constructor(ctx: AudioContext, output: AudioNode) {
    this.core = new MusicCore(ctx, output);
    this.ticker = new Ticker(TICK_MS, () => this.pump());
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
      this.onVisibility();
    }
  }

  play(track: MusicTrack): void {
    if (this.disposed) return;
    this.core.play(track);
    this.pump();
  }

  get track(): MusicTrack {
    return this.core.track;
  }

  /** Tempo multiplier for the current loop (1 = base). */
  setTempo(scale: number): void {
    this.core.setTempo(scale);
  }

  jingle(kind: Jingle): void {
    if (this.disposed) return;
    this.core.jingle(kind);
  }

  stop(): void {
    if (this.disposed) return;
    this.core.stop();
    this.pump();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    this.ticker.dispose();
    this.core.dispose();
  }

  private pump(): void {
    if (this.disposed) return;
    this.core.pump(this.core.ctx.currentTime + this.lookahead);
    if (this.core.idle) this.ticker.stop();
    else this.ticker.start();
  }

  private readonly onVisibility = (): void => {
    this.lookahead = document.visibilityState === "hidden" ? HIDDEN_LOOKAHEAD : LOOKAHEAD;
    this.pump();
  };
}
