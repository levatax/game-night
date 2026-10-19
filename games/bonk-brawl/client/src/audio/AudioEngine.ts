// Web Audio engine: buses, positional one-shots, loops, voices, music. Owner: client-audio.

import type { CharacterId, Vec3Like } from "../../../shared/types";
import type { Jingle, MusicTrack } from "./Music";
import type { LoopId, SfxId, VoiceKind } from "./Sfx";

export interface PlayOptions {
  /** World position → PannerNode (HRTF on high quality, equalpower otherwise), distance model inverse, ref 3 m, max 40 m. */
  pos?: Vec3Like;
  /** Gain multiplier (default 1). */
  volume?: number;
  /** Playback-rate / pitch multiplier (default 1, with ±4% random variation unless exact). */
  pitch?: number;
  exactPitch?: boolean;
}

export interface LoopHandle {
  /** 0..1 loop parameter (charge amount, speed). */
  setParam(value: number): void;
  setPosition(pos: Vec3Like): void;
  /** Fade out and release (default 0.08 s). Safe to call twice. */
  stop(fadeSec?: number): void;
}

/**
 * Graph: sources → (sfx | ui) bus → master → destination; music → music bus → master.
 * Volumes from settings (master/music/sfx; ui bus follows sfx). Everything is synthesized at
 * play time (oscillators, noise buffers, envelopes) — cache noise buffers. Before unlock() (no
 * user gesture yet) every call is a silent no-op; nothing throws if Web Audio is unavailable.
 * Listener follows the camera (setListener each frame).
 * Character voices: CharacterDef.voice preset (quack, ribbit, grumble, meow, squawk, bleat) with
 * a VoiceKind variant (pitch/length/emotion), positional.
 */
export class AudioEngine {
  /** Create/resume the AudioContext. Call from user gestures (first click/key); idempotent. */
  unlock(): void {}

  get ready(): boolean {
    return false;
  }

  setVolumes(master: number, music: number, sfx: number): void {
    void master;
    void music;
    void sfx;
  }

  /** Listener pose (camera position + forward). */
  setListener(pos: Vec3Like, forward: Vec3Like): void {
    void pos;
    void forward;
  }

  play(id: SfxId, opts?: PlayOptions): void {
    void id;
    void opts;
  }

  voice(character: CharacterId, kind: VoiceKind, opts?: PlayOptions): void {
    void character;
    void kind;
    void opts;
  }

  /** Returns a handle even before unlock (a no-op handle). */
  startLoop(id: LoopId, opts?: PlayOptions): LoopHandle {
    void id;
    void opts;
    return { setParam() {}, setPosition() {}, stop() {} };
  }

  playMusic(track: MusicTrack): void {
    void track;
  }

  setMusicTempo(scale: number): void {
    void scale;
  }

  jingle(kind: Jingle): void {
    void kind;
  }

  /** Global slow-mo pitch bend for sfx (Feel.timeScale), 1 = normal. */
  setTimeScale(scale: number): void {
    void scale;
  }

  dispose(): void {}
}
