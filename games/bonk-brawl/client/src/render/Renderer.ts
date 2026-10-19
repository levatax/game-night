// WebGL renderer, scene, lights, shadows, quality levels, optional post-FX. Owner: client-render.

import * as THREE from "three";
import type { MapId } from "../../../shared/types";
import type { Quality } from "../app/settings";
import { Arena } from "./Arena";

/**
 * One renderer + one scene for the whole app. Characters/fx add their objects to `scene`
 * directly (they own and remove them). The camera is driven by CameraRig.
 *
 * - WebGLRenderer({ antialias: quality !== "low", powerPreference: "high-performance" }),
 *   outputColorSpace SRGB, toneMapping None (flat cartoon colors), canvas appended to container,
 *   resizes with the window (ResizeObserver on the container).
 * - Lights: 1 directional sun (theme.sunColor / sunIntensity / sunDirection, shadow camera fit to
 *   the island ±16 m, PCFSoft, map 1024 medium / 2048 high, no shadows on low) + 1 hemisphere
 *   light (theme.hemiSkyColor/GroundColor/Intensity). Only characters and balls set castShadow.
 * - Fog per theme (scene.fog = Fog(fogColor, fogNear, fogFar)).
 * - Quality: low = pixelRatio 1, no shadows, no post; medium = pixelRatio min(dpr, 1.5),
 *   shadows, FXAA; high = pixelRatio min(dpr, 2), shadows, bloom (UnrealBloomPass, threshold high
 *   so only emissive live balls/crown bloom) + FXAA via EffectComposer from three/addons.
 */
export class Renderer {
  readonly webgl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 600);

  constructor(container: HTMLElement, quality: Quality) {
    this.webgl = new THREE.WebGLRenderer({ antialias: quality !== "low" });
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.webgl.domElement);
    this.resize();
  }

  /** Current arena (null before the first loadArena). */
  get arena(): Arena | null {
    return null; // TODO(client-render)
  }

  /**
   * Build the arena + Sky + lights/fog theme for mapId, replacing (and disposing) the previous
   * one. No-op returning the current Arena if mapId is already loaded.
   */
  loadArena(mapId: MapId): Arena {
    void mapId;
    throw new Error("TODO(client-render): loadArena");
  }

  setQuality(quality: Quality): void {
    void quality;
  }

  /** Per frame: sky/cloud drift, arena animations (rings, decor). */
  update(dt: number, elapsed: number): void {
    void dt;
    void elapsed;
  }

  /** Render the scene (through the composer when post-FX are on). */
  render(): void {
    this.webgl.render(this.scene, this.camera);
  }

  /** Match the canvas to its container size and update the camera aspect. */
  resize(): void {
    const el = this.webgl.domElement.parentElement;
    const w = el?.clientWidth || window.innerWidth;
    const h = el?.clientHeight || window.innerHeight;
    this.webgl.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /** Viewport size in CSS pixels (for off-screen indicators). */
  get viewport(): { width: number; height: number } {
    const c = this.webgl.domElement;
    return { width: c.clientWidth, height: c.clientHeight };
  }

  dispose(): void {
    this.webgl.dispose();
  }
}
