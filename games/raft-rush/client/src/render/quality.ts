// What each graphics quality level turns on. One table so Renderer, the island scene, sky, weather and post-FX
// agree. Owner: client-render. Adapted from games/bonk-brawl/client/src/render/quality.ts (+ island budgets,
// game4.md §20: low = no shadows, half the instances).

import type { Quality } from "../app/settings";

export interface QualityProfile {
  /** Upper bound for the canvas pixel ratio (device pixel ratio is clamped to it). */
  pixelRatioCap: number;
  /** Sun / moon shadow map (flora, characters and items cast, terrain receives). */
  shadows: boolean;
  shadowMapSize: number;
  /** Shadow frustum half extent around the camera (m): 30 = the 60 m ortho box of §20. */
  shadowExtent: number;
  /** UnrealBloom on emissive things (flames, torches, READY glow, golden fish). */
  bloom: boolean;
  /** MSAA samples on the post-FX render target (bloom path). */
  postSamples: number;
  /** Fraction of decorative instances drawn (grass tufts, clouds, stars, fireflies, rain drops). */
  instanceScale: number;
  /** Grass tufts on a solo island at instanceScale 1. */
  grassTufts: number;
  /** Rain streaks around the camera. */
  rainDrops: number;
  /** Fixed pool of point lights (campfires + torches). Constant per tier so shaders never recompile mid-match. */
  pointLights: number;
}

export const QUALITY_PROFILES: Readonly<Record<Quality, QualityProfile>> = {
  low: {
    pixelRatioCap: 1,
    shadows: false,
    shadowMapSize: 512,
    shadowExtent: 30,
    bloom: false,
    postSamples: 0,
    instanceScale: 0.5,
    grassTufts: 600,
    rainDrops: 300,
    pointLights: 3,
  },
  medium: {
    pixelRatioCap: 1.5,
    shadows: true,
    shadowMapSize: 1024,
    shadowExtent: 30,
    bloom: false,
    postSamples: 0,
    instanceScale: 1,
    grassTufts: 600,
    rainDrops: 700,
    pointLights: 5,
  },
  high: {
    pixelRatioCap: 2,
    shadows: true,
    shadowMapSize: 2048,
    shadowExtent: 34,
    bloom: true,
    postSamples: 4,
    instanceScale: 1,
    grassTufts: 900,
    rainDrops: 1000,
    pointLights: 6,
  },
};

export function pixelRatioFor(quality: Quality): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.max(1, Math.min(dpr, QUALITY_PROFILES[quality].pixelRatioCap));
}

/** Decorative instance count for a base number at this quality. */
export function scaledCount(base: number, quality: Quality): number {
  return Math.max(0, Math.round(base * QUALITY_PROFILES[quality].instanceScale));
}
