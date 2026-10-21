// The engine's fixed mixing graph. Owner: client-fx-audio. Adapted from
// games/bonk-brawl/client/src/audio/engine/graph.ts (no slow-mo bend; adds the voice / ambience / radio buses
// and the underwater "world" low-pass):
//
//   sfx sources ──▶ sfx bus ──────┐
//   voices ───────▶ voice bus ────┤
//   ambience ─────▶ ambience bus ─┼▶ world low-pass (underwater) ▶ glue compressor ┐
//   music ────────▶ music bus ────┘                                                  ├▶ master ▶ limiter ▶ out
//   ui sources ───▶ ui bus ──────────────────────────────────────────────────────────┘
//
// master = masterVolume (0 when muted); music bus = musicVolume; sfx / voice / ambience / ui = sfxVolume.

import { belowNyquist } from "../synth/dsp";

export interface EngineGraph {
  readonly master: GainNode;
  readonly sfx: GainNode;
  readonly voice: GainNode;
  readonly ambience: GainNode;
  readonly music: GainNode;
  readonly ui: GainNode;
  /** Low-pass shared by every in-world sound (opens fully above water). */
  readonly world: BiquadFilterNode;
  /** Final node before the destination (meters tap here). */
  readonly output: AudioNode;
}

/** Bus volume smoothing (s): slider drags never zipper. */
const VOLUME_TAU = 0.03;
/** World low-pass cutoff above / under water (Hz). */
export const WORLD_OPEN_HZ = 20000;
export const WORLD_UNDERWATER_HZ = 520;

export function buildGraph(ctx: BaseAudioContext): EngineGraph {
  const limiter = ctx.createDynamicsCompressor();
  setCompressor(limiter, -3, 0, 20, 0.002, 0.12);
  limiter.connect(ctx.destination);

  const master = ctx.createGain();
  master.connect(limiter);

  // Glues stacked one-shots together so spam gets denser, not louder.
  const glue = ctx.createDynamicsCompressor();
  setCompressor(glue, -12, 8, 3, 0.003, 0.18);
  glue.connect(master);

  const world = ctx.createBiquadFilter();
  world.type = "lowpass";
  world.frequency.value = belowNyquist(ctx, WORLD_OPEN_HZ);
  world.Q.value = 0.7;
  world.connect(glue);

  const bus = (dest: AudioNode): GainNode => {
    const g = ctx.createGain();
    g.connect(dest);
    return g;
  };
  return {
    master,
    sfx: bus(world),
    voice: bus(world),
    ambience: bus(world),
    music: bus(world),
    ui: bus(master),
    world,
    output: limiter,
  };
}

function setCompressor(c: DynamicsCompressorNode, threshold: number, knee: number, ratio: number, attack: number, release: number): void {
  c.threshold.value = threshold;
  c.knee.value = knee;
  c.ratio.value = ratio;
  c.attack.value = attack;
  c.release.value = release;
}

/** Slider 0..1 → gain with a perceptual (squared) taper. */
export function sliderToGain(v: number): number {
  const c = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  return c * c;
}

export function rampGain(param: AudioParam, value: number, now: number, tau = VOLUME_TAU): void {
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, tau);
}

export function disposeGraph(g: EngineGraph): void {
  for (const node of [g.sfx, g.voice, g.ambience, g.music, g.ui, g.world, g.master, g.output]) {
    try {
      node.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}
