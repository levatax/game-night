// Procedural music: lobby / fight / sudden-death loops + jingles. Owner: client-audio.

/** "none" = silence. */
export type MusicTrack = "none" | "lobby" | "fight" | "suddenDeath";
export type Jingle = "roundWin" | "matchWin" | "roundLose";

/**
 * Upbeat goofy loops (~120 BPM) from oscillators: plucky ukulele-ish chords (filtered saw/tri +
 * fast decay), kazoo lead (sawtooth + vibrato + bandpass), xylophone counter-melody (sine + short
 * decay), simple kick/snare/shaker from noise. Lookahead scheduler (25 ms timer, 100 ms ahead).
 * - lobby: relaxed 110 BPM; fight: 120 BPM, busier; suddenDeath: fight arrangement with tempo
 *   ramped by setTempo (1.0 → 1.35) and a tension layer.
 * - play(track) crossfades ~0.6 s; same track → no-op.
 * - jingle(): short stinger (2–3 s) that ducks the loop to 20% and restores it afterwards.
 */
export class Music {
  constructor(ctx: AudioContext, output: AudioNode) {
    void ctx;
    void output;
  }

  play(track: MusicTrack): void {
    void track;
  }

  get track(): MusicTrack {
    return "none";
  }

  /** Tempo multiplier for the current loop (1 = base). */
  setTempo(scale: number): void {
    void scale;
  }

  jingle(kind: Jingle): void {
    void kind;
  }

  stop(): void {}

  dispose(): void {}
}
