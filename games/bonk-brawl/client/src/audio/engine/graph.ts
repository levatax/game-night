// The engine's fixed mixing graph:
//   sfx sources → sfx bus → glue compressor ┐
//   ui sources  → ui bus  ───────────────────┼→ master → limiter → destination
//   music       → music bus ─────────────────┘
// plus a ConstantSource "bend" (cents) that every sfx source's detune listens to (slow-mo).

export interface EngineGraph {
  readonly master: GainNode;
  readonly sfx: GainNode;
  readonly ui: GainNode;
  readonly music: GainNode;
  /** Final node before the destination (meters tap here). */
  readonly output: AudioNode;
  /** Global sfx pitch bend in cents; null when ConstantSourceNode is unsupported. */
  readonly bend: ConstantSourceNode | null;
}

/** Bus volume smoothing (s): slider drags never zipper. */
const VOLUME_TAU = 0.03;

export function buildGraph(ctx: AudioContext): EngineGraph {
  const limiter = ctx.createDynamicsCompressor();
  setCompressor(limiter, -3, 0, 20, 0.002, 0.12);
  limiter.connect(ctx.destination);

  const master = ctx.createGain();
  master.connect(limiter);

  // Glues stacked one-shots together so spam gets denser, not louder.
  const glue = ctx.createDynamicsCompressor();
  setCompressor(glue, -10, 8, 3, 0.003, 0.15);
  glue.connect(master);

  const sfx = ctx.createGain();
  sfx.connect(glue);
  const ui = ctx.createGain();
  ui.connect(master);
  const music = ctx.createGain();
  music.connect(master);

  return { master, sfx, ui, music, output: limiter, bend: createBend(ctx) };
}

function setCompressor(c: DynamicsCompressorNode, threshold: number, knee: number, ratio: number, attack: number, release: number): void {
  c.threshold.value = threshold;
  c.knee.value = knee;
  c.ratio.value = ratio;
  c.attack.value = attack;
  c.release.value = release;
}

function createBend(ctx: AudioContext): ConstantSourceNode | null {
  if (typeof ctx.createConstantSource !== "function") return null;
  const bend = ctx.createConstantSource();
  bend.offset.value = 0;
  bend.start();
  return bend;
}

/** Slider 0..1 → gain with a perceptual (squared) taper. */
export function sliderToGain(v: number): number {
  const c = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  return c * c;
}

export function rampGain(param: AudioParam, value: number, now: number): void {
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, VOLUME_TAU);
}

export function disposeGraph(g: EngineGraph): void {
  try {
    g.bend?.stop();
  } catch {
    // Never started or already stopped.
  }
  for (const node of [g.sfx, g.ui, g.music, g.master, g.output, g.bend]) node?.disconnect();
}
