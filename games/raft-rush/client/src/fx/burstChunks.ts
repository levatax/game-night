// Which chunky 3D debris each burst kind throws on top of its billboard particles (pure table, unit-tested for
// completeness). Counts / sizes are at burst scale 1; Fx scales count and size by BurstOptions.scale and lets
// BurstOptions.color replace the palette. Owner: client-fx-audio.

import type { ChunkKind } from "./Chunks";
import type { BurstKind } from "./Fx";

export interface ChunkSpec {
  chunk: ChunkKind;
  count: number;
  colors: ReadonlyArray<string>;
  /** Chunk size (m). */
  size: number;
  /** Launch speed (m/s). */
  speed: number;
}

const WOOD = ["#C98F57", "#B07A45", "#8B5A2B", "#E3B77E"] as const;
const STONE = ["#9C968C", "#7C776F", "#B5AFA5"] as const;
const SHELL = ["#FF4D3A", "#E23B2A", "#FF7A5C"] as const;
const BERRY = ["#5B2A86", "#8E55C2", "#6B2E9A"] as const;
const SPIKE = ["#C99A22", "#F2C94C", "#FFE27A"] as const;

export const BURST_CHUNKS: Readonly<Record<BurstKind, ReadonlyArray<ChunkSpec>>> = {
  woodChips: [{ chunk: "splinter", count: 6, colors: WOOD, size: 0.09, speed: 3.4 }],
  stoneChips: [{ chunk: "chip", count: 6, colors: STONE, size: 0.085, speed: 3.6 }],
  leaves: [],
  berries: [{ chunk: "berry", count: 5, colors: BERRY, size: 0.065, speed: 2.6 }],
  splash: [],
  ripple: [],
  hitStars: [],
  bonk: [],
  flip: [{ chunk: "shell", count: 2, colors: SHELL, size: 0.07, speed: 2.4 }],
  blast: [
    { chunk: "spike", count: 9, colors: SPIKE, size: 0.1, speed: 6 },
    { chunk: "chip", count: 4, colors: STONE, size: 0.07, speed: 4.5 },
  ],
  embers: [],
  smoke: [],
  sparkle: [],
  gold: [],
  dust: [],
  bubbles: [],
  feathers: [],
  crabBits: [
    { chunk: "shell", count: 7, colors: SHELL, size: 0.11, speed: 3.8 },
    { chunk: "splinter", count: 4, colors: SHELL, size: 0.05, speed: 3.2 },
  ],
  confetti: [],
  hearts: [],
};
