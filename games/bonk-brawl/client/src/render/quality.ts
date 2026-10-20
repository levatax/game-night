// What each graphics quality level turns on. One table so Renderer, Sky and PostFx agree.

import type { Quality } from "../app/settings";

export interface QualityProfile {
  /** Upper bound for the canvas pixel ratio (device pixel ratio is clamped to it). */
  pixelRatioCap: number;
  /** Sun shadow map (characters + balls cast, environment receives). */
  shadows: boolean;
  shadowMapSize: number;
  /** UnrealBloom on emissive things (live balls, crown, candle flames). */
  bloom: boolean;
  /** MSAA samples on the post-FX render target (bloom path). */
  postSamples: number;
}

export const QUALITY_PROFILES: Readonly<Record<Quality, QualityProfile>> = {
  low: { pixelRatioCap: 1, shadows: false, shadowMapSize: 512, bloom: false, postSamples: 0 },
  medium: { pixelRatioCap: 1.5, shadows: true, shadowMapSize: 1024, bloom: false, postSamples: 0 },
  high: { pixelRatioCap: 2, shadows: true, shadowMapSize: 2048, bloom: true, postSamples: 4 },
};

export function pixelRatioFor(quality: Quality): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.max(1, Math.min(dpr, QUALITY_PROFILES[quality].pixelRatioCap));
}
