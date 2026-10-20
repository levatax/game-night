// WebGL renderer, scene, lights, shadows, quality levels, optional post-FX. Owner: client-render.

import * as THREE from "three";
import { getArena, type ArenaTheme } from "../../../shared/maps";
import type { MapId } from "../../../shared/types";
import type { Quality } from "../app/settings";
import { Arena } from "./Arena";
import { PostFx } from "./PostFx";
import { pixelRatioFor, QUALITY_PROFILES } from "./quality";
import { Sky } from "./Sky";

/** Sun distance from the island center (only the direction matters for a directional light). */
const SUN_DISTANCE = 40;
/** Half extent of the sun's shadow frustum: the whole island (±15 m) plus some margin. */
const SHADOW_EXTENT = 17;
/** Softness of the PCF shadow edge (in shadow-map texels) and how dark shadowed areas get. */
const SHADOW_RADIUS = 3;
const SHADOW_INTENSITY = 0.6;

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
 *   (Medium renders straight to the canvas when the context has native MSAA and only falls back
 *   to an FXAA pass without it; High uses an MSAA render target, so FXAA is only added if MSAA
 *   is unavailable. three r186 removed PCFSoftShadowMap: PCF + shadow.radius gives the soft edge.)
 */
export class Renderer {
  readonly webgl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 600);

  private readonly container: HTMLElement;
  private readonly sun = new THREE.DirectionalLight("#FFFFFF", 2);
  private readonly hemi = new THREE.HemisphereLight("#FFFFFF", "#FFFFFF", 1);
  private readonly fog = new THREE.Fog("#FFFFFF", 40, 120);
  private readonly resizeObserver: ResizeObserver | null;
  private quality: Quality;
  private currentArena: Arena | null = null;
  private sky: Sky | null = null;
  private post: PostFx | null = null;
  private size = { width: 1, height: 1 };

  constructor(container: HTMLElement, quality: Quality) {
    this.container = container;
    this.quality = quality;
    this.webgl = new THREE.WebGLRenderer({ antialias: quality !== "low", powerPreference: "high-performance" });
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.toneMapping = THREE.NoToneMapping;
    this.webgl.shadowMap.type = THREE.PCFShadowMap;
    this.webgl.domElement.style.display = "block";
    container.appendChild(this.webgl.domElement);

    this.scene.name = "bonk-brawl";
    this.scene.fog = this.fog;
    this.setupLights();
    this.applyTheme(getArena("picnic").theme);

    this.resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(container);
    this.applyQuality();
    this.resize();
  }

  /** Current arena (null before the first loadArena). */
  get arena(): Arena | null {
    return this.currentArena;
  }

  /**
   * Build the arena + Sky + lights/fog theme for mapId, replacing (and disposing) the previous
   * one. No-op returning the current Arena if mapId is already loaded.
   */
  loadArena(mapId: MapId): Arena {
    if (this.currentArena && this.currentArena.def.id === mapId) return this.currentArena;
    this.disposeWorld();
    const def = getArena(mapId);
    const arena = new Arena(def, this.quality);
    this.currentArena = arena;
    this.scene.add(arena.group);
    this.sky = new Sky(def.theme, this.quality);
    this.scene.add(this.sky.object);
    this.applyTheme(def.theme);
    return arena;
  }

  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.currentArena?.setQuality(quality);
    if (this.currentArena) this.rebuildSky(this.currentArena.def.theme);
    this.applyQuality();
    this.resize();
  }

  /** Per frame: sky/cloud drift, arena animations (rings, decor). */
  update(dt: number, elapsed: number): void {
    this.sky?.update(dt, elapsed);
    this.currentArena?.update(dt, elapsed);
  }

  /** Render the scene (through the composer when post-FX are on). */
  render(): void {
    if (this.post) this.post.render();
    else this.webgl.render(this.scene, this.camera);
  }

  /** Match the canvas to its container size and update the camera aspect. */
  resize(): void {
    const w = Math.max(1, Math.floor(this.container.clientWidth || window.innerWidth));
    const h = Math.max(1, Math.floor(this.container.clientHeight || window.innerHeight));
    const ratio = pixelRatioFor(this.quality);
    const sameSize = w === this.size.width && h === this.size.height && ratio === this.webgl.getPixelRatio();
    this.size = { width: w, height: h };
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (sameSize) return;
    this.webgl.setPixelRatio(ratio);
    this.webgl.setSize(w, h, false);
    this.post?.setSize(w, h, ratio);
  }

  /** Viewport size in CSS pixels (for off-screen indicators). */
  get viewport(): { width: number; height: number } {
    const c = this.webgl.domElement;
    return { width: c.clientWidth || this.size.width, height: c.clientHeight || this.size.height };
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.disposeWorld();
    this.post?.dispose();
    this.post = null;
    this.scene.remove(this.sun, this.sun.target, this.hemi);
    this.sun.dispose();
    this.webgl.dispose();
    this.webgl.domElement.remove();
  }

  /* --------------------------------------------------------------- internals */

  private setupLights(): void {
    this.sun.name = "sun";
    this.sun.target.position.set(0, 0, 0);
    const shadow = this.sun.shadow;
    const cam = shadow.camera;
    cam.left = -SHADOW_EXTENT;
    cam.right = SHADOW_EXTENT;
    cam.top = SHADOW_EXTENT;
    cam.bottom = -SHADOW_EXTENT;
    cam.near = 1;
    cam.far = SUN_DISTANCE * 2;
    cam.updateProjectionMatrix();
    shadow.bias = -0.0005;
    shadow.normalBias = 0.03;
    shadow.radius = SHADOW_RADIUS;
    shadow.intensity = SHADOW_INTENSITY;
    this.hemi.name = "hemi";
    this.scene.add(this.sun, this.sun.target, this.hemi);
  }

  private applyTheme(theme: ArenaTheme): void {
    const d = theme.sunDirection;
    const dir = new THREE.Vector3(d.x, d.y, d.z);
    if (dir.lengthSq() < 1e-6) dir.set(0, -1, 0);
    dir.normalize();
    this.sun.position.copy(dir).multiplyScalar(-SUN_DISTANCE);
    this.sun.color.set(theme.sunColor);
    this.sun.intensity = theme.sunIntensity;
    this.hemi.color.set(theme.hemiSkyColor);
    this.hemi.groundColor.set(theme.hemiGroundColor);
    this.hemi.intensity = theme.hemiIntensity;
    this.fog.color.set(theme.fogColor);
    this.fog.near = theme.fogNear;
    this.fog.far = theme.fogFar;
    // Only visible for a frame if the sky dome were missing; keeps the clear color on-theme.
    this.scene.background = new THREE.Color(theme.fogColor);
  }

  private applyQuality(): void {
    const profile = QUALITY_PROFILES[this.quality];
    const shadowsChanged = this.webgl.shadowMap.enabled !== profile.shadows;
    this.webgl.shadowMap.enabled = profile.shadows;
    this.sun.castShadow = profile.shadows;
    if (this.sun.shadow.mapSize.x !== profile.shadowMapSize) {
      this.sun.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
      // A new size needs a new shadow map target.
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    if (shadowsChanged) this.recompileMaterials();
    this.rebuildPost();
  }

  /** Shadow receivers bake the shadow toggle into their shader: force a recompile everywhere. */
  private recompileMaterials(): void {
    this.scene.traverse((obj) => {
      const material = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!material) return;
      for (const m of Array.isArray(material) ? material : [material]) m.needsUpdate = true;
    });
  }

  private rebuildPost(): void {
    this.post?.dispose();
    this.post = null;
    const profile = QUALITY_PROFILES[this.quality];
    if (this.quality === "low") return;
    const nativeAA = this.webgl.getContextAttributes()?.antialias === true;
    if (!profile.bloom && nativeAA) return;
    const samples = profile.bloom ? profile.postSamples : 0;
    this.post = new PostFx(this.webgl, this.scene, this.camera, {
      bloom: profile.bloom,
      samples,
      fxaa: samples === 0,
    });
  }

  private rebuildSky(theme: ArenaTheme): void {
    this.sky?.dispose();
    this.sky = new Sky(theme, this.quality);
    this.scene.add(this.sky.object);
  }

  private disposeWorld(): void {
    this.currentArena?.dispose();
    this.currentArena = null;
    this.sky?.dispose();
    this.sky = null;
  }
}
