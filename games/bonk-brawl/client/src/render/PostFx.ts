// Optional EffectComposer chain: [render (HDR target, optional MSAA)] → [bloom] → output (sRGB) → [FXAA].
// Bloom runs on linear HDR values with a threshold above anything the lit toon environment reaches
// (white tiles under the sun land around 1.0), so only emissive things glow: live balls, the
// crown, candle flame cores.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { FXAAPass } from "three/addons/postprocessing/FXAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

export interface PostFxOptions {
  bloom: boolean;
  /** FXAA after the output pass (used when the render target has no MSAA). */
  fxaa: boolean;
  /** MSAA samples on the scene render target (0 = none). */
  samples: number;
}

const BLOOM_STRENGTH = 0.6;
const BLOOM_RADIUS = 0.35;
const BLOOM_THRESHOLD = 1.1;

export class PostFx {
  private readonly composer: EffectComposer;

  constructor(
    webgl: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    readonly options: PostFxOptions,
  ) {
    const size = webgl.getSize(new THREE.Vector2());
    // Sized for real by setSize() below.
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: options.samples });
    target.texture.name = "PostFx.scene";
    this.composer = new EffectComposer(webgl, target);
    this.composer.addPass(new RenderPass(scene, camera));
    if (options.bloom) {
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(size.x, size.y), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD));
    }
    this.composer.addPass(new OutputPass());
    if (options.fxaa) this.composer.addPass(new FXAAPass());
    this.setSize(size.x, size.y, webgl.getPixelRatio());
  }

  /** CSS-pixel size + pixel ratio (the composer scales its targets and passes by the ratio). */
  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(Math.max(1, width), Math.max(1, height));
  }

  render(): void {
    this.composer.render();
  }

  dispose(): void {
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
  }
}
