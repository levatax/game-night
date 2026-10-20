// What a music generator gets to play into, and how siren tension thins the arrangement (§14, §15).

export interface LayerOut {
  /** Dry, crossfaded bus of this layer (bass, drums go here directly). */
  bus: GainNode;
  /** Rhodes / comping keys (shared tremolo), feeds bus + reverb. */
  keys: GainNode;
  /** Vibraphone (shared motor tremolo), feeds bus + reverb. */
  vib: GainNode;
  /** Other melodic voices that want room reverb (bandoneon, piano, brass). */
  mel: GainNode;
}

/** A beat-by-beat generator for one music mode. */
export interface Gen {
  /** Seconds per beat. */
  readonly spb: number;
  /** Schedule everything that starts inside the beat at ctx time `t`. */
  beat(t: number, tension: number): void;
  dispose(): void;
}

export type BassFeel = "walk" | "two" | "jaws";

export interface TensionMix {
  /** Improvised lead / melody. */
  lead: number;
  /** Chords (Rhodes, vibes comping, piano stabs, bandoneon pads). */
  comp: number;
  /** Ride, brushes, kick, fills, crashes. */
  drums: number;
  /** The lone hi-hat that stays when everything else is gone (until the heartbeat takes over). */
  hat: number;
  bass: BassFeel;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Tension at or above this the lone hi-hat gets louder (the band has mostly dropped out).
 * Scale: see tensionMix.
 */
export const LONE_HAT = 0.5;
/** From here the bass creeps on the root / minor-second "jaws" ostinato. */
export const JAWS = 0.78;

/**
 * 0..1 tension = the siren level (AudioEngine `sirenTension`): 0 at the base raid chance (8%), ≈0.17 after
 * card 1 (15%), 0.33 at 22%, 0.5 at 29%, 0.67 at 36%, 0.83 at 43%, 1 from 50%. The band reacts from the
 * second card on, when most turns are decided:
 * - card 1: the improvised lead fades and is gone by card 2 (22%);
 * - cards 2–3: comping and drums thin out, the heartbeat starts (Music.heartbeat);
 * - card 3 (29%): the bass drops to a two-feel under a lone hi-hat;
 * - card 4 (36%): drums and chords are gone and the heart beats on every beat;
 * - card 5 (43%): the hat gives way to the heartbeat and the bass creeps on the jaws ostinato.
 */
export function tensionMix(I: number): TensionMix {
  return {
    lead: clamp01((0.3 - I) / 0.14),
    comp: clamp01((0.62 - I) / 0.34),
    drums: clamp01((0.58 - I) / 0.3),
    hat: I < 0.8 ? 1 : clamp01(1 - (I - 0.8) / 0.12),
    bass: I < 0.45 ? "walk" : I < JAWS ? "two" : "jaws",
  };
}

/** Swung eighth position inside a beat (0.5 = straight, 0.667 = triplet). */
export const SWING = 0.64;

export const hum = (): number => (Math.random() - 0.5) * 0.012;
