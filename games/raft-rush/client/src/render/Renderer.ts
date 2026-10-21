// Three.js renderer facade: WebGL renderer, scene, first-person camera, the island scene (terrain chunks, water,
// batched flora, landmarks, raft, campfire, structures), sky dome + day/night lighting + fog + weather
// particles, post-FX and quality tiers. Owner: client-render. Signatures by the architect; keep them.
//
// Copied + adapted from games/bonk-brawl/client/src/render/ (Renderer, Toon, noise, PostFx, quality, textures,
// arena/{Baker,MeshBuilder,MaterialBank} → kit/, sky/{SkyDome,CloudLayer} → sky/, camera/CameraShake) and the
// adaptive resolution of games/kasala/client/src/scene/Stage.ts. Island scene in island/, day/night in
// sky/DayNight.ts, the camera rig in FpCamera.ts (re-exported here). Budget §20: ~75k triangles, 35–50 draw
// calls solo (terrain 4, sea 1, flora 1 batched, grass 1, landmarks 3, sky 3–4, fire / raft / fx extras).
//
// Lighting: one directional key light (the sun by day, the moon by night; the only shadow caster, a 60 m
// ortho box following the camera, no shadows on low), a hemisphere ambient, and a fixed pool of point lights
// for campfires / torches (constant count per tier so nothing recompiles mid-match). Fog 160 m day / 45 m
// night (swamp 30, fog weather 25). Everything is driven by shared data (IslandDef + WorldFrame) only.
//
// Context loss (GPU reset, long background): ContextWatch flags it, render() / prewarm() pause, `onContextChange`
// tells the app (reload card); on restore three.js rebuilds its GL state and re-uploads everything lazily, and
// this facade re-applies its size and prewarms the shaders again (or, when three's rebuild failed, stays lost so
// the card keeps offering the reload).

import * as THREE from "three";
import { WATER_Y } from "../../../shared/constants";
import { heightAt, inGrid } from "../../../shared/island/heightfield";
import type { IslandDef } from "../../../shared/island/types";
import type { Vec3Like, Weather as WeatherKind } from "../../../shared/types";
import type { Quality } from "../app/settings";
import { ContextWatch } from "./ContextWatch";
import { FpCamera } from "./FpCamera";
import { FrameGovernor } from "./FrameGovernor";
import type { LightRequest } from "./island/Campfire";
import { IslandView } from "./island/IslandView";
import type { RaftPose } from "./island/Raft";
import { Weather } from "./island/Weather";
import { LightPool } from "./LightPool";
import { PostFx } from "./PostFx";
import { pixelRatioFor, QUALITY_PROFILES } from "./quality";
import { computeLighting, createLighting, type Lighting, type WeatherWeights } from "./sky/DayNight";
import { Sky } from "./sky/Sky";
import type { WorldFrame } from "./types";

export { FpCamera } from "./FpCamera";
export type { RaftPose } from "./island/Raft";
export type { Lighting } from "./sky/DayNight";

/** Distance of the key light from its shadow target (direction is all that matters). */
const KEY_DISTANCE = 70;
/** How fast weather fades in / out (per second). */
const WEATHER_RATE = 0.45;
const UNDERWATER_FOG = new THREE.Color("#0E4A5C");

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpProj = new THREE.Vector3();

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(75, 1, 0.05, 400);
  readonly fp: FpCamera;
  readonly canvas: HTMLCanvasElement;
  private gl: THREE.WebGLRenderer | null = null;

  private readonly container: HTMLElement;
  private quality: Quality;
  private readonly key = new THREE.DirectionalLight("#FFFFFF", 2);
  private readonly hemi = new THREE.HemisphereLight("#FFFFFF", "#FFFFFF", 1);
  private readonly fog = new THREE.Fog("#BFE6F5", 40, 160);
  private readonly lighting: Lighting = createLighting();
  private readonly weatherW: WeatherWeights = { rain: 0, fog: 0, heat: 0, fullmoon: 0 };
  private readonly governor = new FrameGovernor();
  private readonly heldLights: LightRequest[] = [];
  private readonly allLights: LightRequest[] = [];
  private sky: Sky;
  private weather: Weather;
  private pool: LightPool;
  private post: PostFx | null = null;
  private island: IslandView | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private size = { width: 1, height: 1, ratio: 0 };
  private elapsed = 0;
  private lastDesat = -1;
  private needsPrewarm = false;
  private underwater = false;
  /** Jump weather weights straight to the current weather on the next update (island load / join). */
  private snapNext = true;
  private lightningHook: ((strength: number, distance: number) => void) | null = null;
  /** Context loss / restore on the canvas (null without WebGL). */
  private contextWatch: ContextWatch | null = null;
  /** three's `info` before a restore: a successful rebuild replaces it (see onContextRestored). */
  private glInfo: THREE.WebGLRenderer["info"] | null = null;

  constructor(container: HTMLElement, quality: Quality) {
    this.fp = new FpCamera(this.camera);
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    container.appendChild(this.canvas);
    this.container = container;
    this.quality = quality;
    try {
      this.gl = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: quality !== "low", powerPreference: "high-performance" });
      this.gl.outputColorSpace = THREE.SRGBColorSpace;
      this.gl.toneMapping = THREE.NoToneMapping;
      this.gl.shadowMap.type = THREE.PCFShadowMap;
      // After WebGLRenderer, so three's own restore runs before ours.
      this.glInfo = this.gl.info;
      this.contextWatch = new ContextWatch(this.canvas, () => this.onContextRestored());
    } catch (err) {
      console.error("[render] WebGL unavailable", err);
      this.gl = null;
    }
    this.scene.name = "raft-rush";
    this.scene.fog = this.fog;
    this.scene.background = this.fog.color.clone();
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.camera);
    this.setupLights();
    this.sky = new Sky(quality);
    this.scene.add(this.sky.object);
    this.weather = new Weather(quality);
    this.weather.onStrike = (s, d) => this.lightningHook?.(s, d);
    this.scene.add(this.weather.group);
    this.pool = new LightPool(QUALITY_PROFILES[quality].pointLights);
    this.scene.add(this.pool.group);
    this.governor.onChange = () => this.resize();
    this.resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(container);
    this.applyQuality();
    this.resize();
  }

  /* ------------------------------------------------------------- extra API */

  /** The WebGL renderer (null when WebGL is unavailable). Characters may use it for portraits. */
  get webgl(): THREE.WebGLRenderer | null {
    return this.gl;
  }

  /** False when no WebGL context could be created (the app shows an error screen). */
  get supported(): boolean {
    return this.gl !== null;
  }

  /** The WebGL context is lost right now (nothing is drawn until the browser restores it). */
  get contextLost(): boolean {
    return this.contextWatch?.lost ?? false;
  }

  /** Context lost (true) / restored and rebuilt (false): the app shows / hides the "graphics were reset" card. */
  set onContextChange(fn: ((lost: boolean) => void) | null) {
    if (this.contextWatch) this.contextWatch.onChange = fn;
  }

  /** The island currently shown (null before the first loadIsland). */
  get islandDef(): IslandDef | null {
    return this.island ? this.island.def : null;
  }

  /** 0 (day) .. 1 (night) this frame: CharacterSyncOptions.dark, HUD tinting. */
  get darkness(): number {
    return this.lighting.dark;
  }

  /** The camera is below the sea surface (underwater fog is on). */
  get isUnderwater(): boolean {
    return this.underwater;
  }

  /** This frame's full lighting state (read-only). */
  get light(): Readonly<Lighting> {
    return this.lighting;
  }

  /** Lightning strikes (storm / night rain): thunder SFX and a camera shake hook. Strength 0..1, distance m. */
  set onLightning(fn: ((strength: number, distance: number) => void) | null) {
    this.lightningHook = fn;
  }

  /** Force a lightning strike now (e.g. on the `storm` event). */
  lightning(strength = 1): void {
    this.weather.strike(strength, this.camera);
  }

  /** Current pose of a team's raft (it moves during the launch cinematic). False when there is none. */
  raftPose(team: number, out: RaftPose): boolean {
    const pose = this.island?.raftPose(team);
    if (!pose) return false;
    out.x = pose.x;
    out.y = pose.y;
    out.z = pose.z;
    out.yaw = pose.yaw;
    return true;
  }

  /** Compile every shader of the current scene in the background (call after loadIsland; done automatically too). */
  prewarm(): void {
    const gl = this.gl;
    if (!gl || this.contextLost) return;
    this.needsPrewarm = false;
    try {
      void gl.compileAsync(this.scene, this.camera).catch(() => undefined);
    } catch {
      // Older drivers without parallel compile: the first frames compile instead.
    }
  }

  /** Skip the weather fade on the next update (e.g. after joining mid-match, or a harness screenshot). */
  snapWeather(): void {
    this.snapNext = true;
  }

  /** Render stats for the dev harness / budget checks. */
  stats(): { calls: number; triangles: number; geometries: number; textures: number; programs: number; islandTriangles: number; pixelRatio: number } {
    const info = this.gl?.info;
    return {
      calls: info?.render.calls ?? 0,
      triangles: info?.render.triangles ?? 0,
      geometries: info?.memory.geometries ?? 0,
      textures: info?.memory.textures ?? 0,
      programs: info?.programs?.length ?? 0,
      islandTriangles: this.island?.triangles ?? 0,
      pixelRatio: this.size.ratio,
    };
  }

  /* ------------------------------------------------------------ frozen API */

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    if (this.gl) this.gl.setPixelRatio(pixelRatioFor(q));
    this.sky.dispose();
    this.sky = new Sky(q);
    this.scene.add(this.sky.object);
    this.weather.setQuality(q);
    const lights = QUALITY_PROFILES[q].pointLights;
    if (lights !== this.pool.size) {
      this.pool.dispose();
      this.pool = new LightPool(lights);
      this.scene.add(this.pool.group);
    }
    this.island?.setQuality(q);
    this.applyQuality();
    this.governor.reset(now());
    this.resize();
    this.needsPrewarm = true;
  }

  /** Build (and dispose the previous) island scene for `def`. ~50–150 ms; call on welcome / matchStart / lobby seed change. */
  loadIsland(def: IslandDef): void {
    if (this.island && this.island.def === def) return;
    this.island?.dispose();
    this.island = new IslandView(def, this.quality);
    this.scene.add(this.island.group);
    const site = def.sites[0];
    if (site) this.fp.setSpectateCenter({ x: site.campfire.x, y: heightAt(def.grid, site.campfire.x, site.campfire.z), z: site.campfire.z });
    this.governor.reset(now());
    this.needsPrewarm = true;
    this.snapNext = true;
  }

  /** World-space ground position for UI anchoring (prompts, markers): screen-projected by the caller. */
  project(pos: { x: number; y: number; z: number }, out: { x: number; y: number; visible: boolean }): void {
    this.camera.updateMatrixWorld();
    tmpProj.set(pos.x, pos.y, pos.z).applyMatrix4(this.camera.matrixWorldInverse);
    const inFront = tmpProj.z < -this.camera.near;
    tmpProj.set(pos.x, pos.y, pos.z).project(this.camera);
    const w = this.canvas.clientWidth || this.size.width;
    const h = this.canvas.clientHeight || this.size.height;
    out.x = (tmpProj.x * 0.5 + 0.5) * w;
    out.y = (-tmpProj.y * 0.5 + 0.5) * h;
    out.visible = inFront && Math.abs(tmpProj.x) <= 1.05 && Math.abs(tmpProj.y) <= 1.05;
  }

  /** Per frame: sky / sun / moon / fog from the clock, water waves, flora sway, node depletion, raft + fire + structures, lights, weather. */
  update(dt: number, elapsed: number, world: WorldFrame): void {
    const step = Math.max(0, Math.min(dt, 0.1));
    this.elapsed = elapsed;
    this.easeWeather(world.weather, step);
    const light = computeLighting(
      { phase: world.phase, clockTicks: world.clockTicks, timings: world.timings, biome: world.biome, weather: this.weatherW, storm: world.storm },
      this.lighting,
    );
    this.fp.reducedFlashing = world.reducedFlashing;
    this.weather.setReducedFlashing(world.reducedFlashing);
    this.camera.getWorldPosition(tmpV);
    this.weather.update(step, elapsed, light.rain, world.storm, light.dark, light.wind, tmpV, this.camera);
    const flash = this.weather.flash;

    // Key (sun / moon) + ambient + fog.
    this.key.color.copy(light.keyColor);
    this.key.intensity = light.keyIntensity + flash * 0.8;
    this.key.shadow.intensity = 0.72 * Math.min(1, light.keyIntensity / 1.2);
    this.hemi.color.copy(light.hemiSky);
    this.hemi.groundColor.copy(light.hemiGround);
    this.hemi.intensity = light.hemiIntensity + flash * 2.4;
    this.fog.color.copy(light.fogColor);
    this.fog.near = light.fogNear;
    this.fog.far = light.fogFar;
    (this.scene.background as THREE.Color).copy(light.fogColor);
    this.sky.update(step, elapsed, light, this.camera, flash);

    const ratio = this.size.ratio || 1;
    if (this.island) this.island.update(step, elapsed, world, light, tmpV, ratio);

    // Point lights: campfires, planted torches, held torches.
    this.allLights.length = 0;
    if (this.island) for (const r of this.island.lightRequests()) this.allLights.push(r);
    world.lights.forEach((l, i) => {
      let req = this.heldLights[i];
      if (!req) {
        req = { pos: new THREE.Vector3(), color: new THREE.Color("#FFB347"), intensity: 0, radius: l.radius, priority: 1 };
        this.heldLights[i] = req;
      }
      req.pos.set(l.x, l.y, l.z);
      req.radius = l.radius;
      req.intensity = Math.max(0, Math.min(1.2, l.intensity)) * (1 + Math.sin(elapsed * 11 + i * 2.3) * 0.06);
      this.allLights.push(req);
    });
    this.pool.assign(this.allLights, toVector(world.focus, tmpV2), light.dark);
  }

  render(): void {
    const gl = this.gl;
    // Lost context: draw nothing (the app shows the reload card) until the browser restores it.
    if (!gl || this.contextLost) return;
    this.followCamera();
    this.applyUnderwater();
    this.applyDesaturation();
    if (this.needsPrewarm) this.prewarm();
    if (this.post) this.post.render();
    else gl.render(this.scene, this.camera);
    this.governor.frame(now());
  }

  resize(): void {
    const w = Math.max(1, Math.floor(this.container.clientWidth || window.innerWidth));
    const h = Math.max(1, Math.floor(this.container.clientHeight || window.innerHeight));
    const ratio = pixelRatioFor(this.quality) * this.governor.scale;
    const same = w === this.size.width && h === this.size.height && Math.abs(ratio - this.size.ratio) < 1e-3;
    this.size = { width: w, height: h, ratio };
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (same || !this.gl) return;
    this.gl.setPixelRatio(ratio);
    this.gl.setSize(w, h, false);
    this.post?.setSize(w, h, ratio);
    this.sky.setPixelRatio(ratio);
  }

  dispose(): void {
    this.contextWatch?.dispose();
    this.contextWatch = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.island?.dispose();
    this.island = null;
    this.sky.dispose();
    this.weather.dispose();
    this.pool.dispose();
    this.post?.dispose();
    this.post = null;
    this.scene.remove(this.key, this.key.target, this.hemi);
    this.key.dispose();
    this.hemi.dispose();
    this.gl?.dispose();
    this.gl = null;
    this.canvas.remove();
  }

  /* --------------------------------------------------------------- internals */

  /**
   * three.js has rebuilt its GL state (programs, textures, buffers and render targets re-upload on first use: every
   * texture here is canvas / data based). Re-apply the drawing-buffer size, let the frame governor forget the
   * stall and compile the shaders in the background again so the first frames back don't hitch.
   * Throws (ContextWatch then stays lost and the reload card stays up) when that rebuild didn't happen: three's
   * restore listener runs first and assigns a new `info` as the very last step, so the old `info` means it threw
   * part-way; a context that still reports lost means the restore didn't hold.
   */
  private onContextRestored(): void {
    const gl = this.gl;
    if (!gl || gl.getContext().isContextLost() || gl.info === this.glInfo) throw new Error("three.js didn't rebuild its GL state");
    this.glInfo = gl.info;
    this.size = { ...this.size, ratio: 0 };
    this.resize();
    this.governor.reset(now());
    this.needsPrewarm = true;
  }

  private setupLights(): void {
    this.key.name = "keyLight";
    const shadow = this.key.shadow;
    shadow.camera.near = 1;
    shadow.camera.far = KEY_DISTANCE * 2.2;
    shadow.bias = -0.0006;
    shadow.normalBias = 0.04;
    shadow.radius = 3;
    shadow.intensity = 0.55;
    this.hemi.name = "hemi";
    this.scene.add(this.key, this.key.target, this.hemi);
  }

  private applyQuality(): void {
    const gl = this.gl;
    const profile = QUALITY_PROFILES[this.quality];
    const cam = this.key.shadow.camera;
    cam.left = -profile.shadowExtent;
    cam.right = profile.shadowExtent;
    cam.top = profile.shadowExtent;
    cam.bottom = -profile.shadowExtent;
    cam.updateProjectionMatrix();
    if (!gl) return;
    const shadowsChanged = gl.shadowMap.enabled !== profile.shadows;
    gl.shadowMap.enabled = profile.shadows;
    this.key.castShadow = profile.shadows;
    if (this.key.shadow.mapSize.x !== profile.shadowMapSize) {
      this.key.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
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
    const gl = this.gl;
    this.post?.dispose();
    this.post = null;
    if (!gl || this.quality === "low") return;
    const profile = QUALITY_PROFILES[this.quality];
    const nativeAA = gl.getContextAttributes()?.antialias === true;
    if (!profile.bloom && nativeAA) return;
    const samples = profile.bloom ? profile.postSamples : 0;
    this.post = new PostFx(gl, this.scene, this.camera, { bloom: profile.bloom, samples, fxaa: samples === 0 });
    this.post.setSize(this.size.width, this.size.height, this.size.ratio || pixelRatioFor(this.quality));
  }

  private easeWeather(kind: WeatherKind, dt: number): void {
    const w = this.weatherW;
    const k = this.snapNext ? 1 : Math.min(1, dt * WEATHER_RATE * 2);
    this.snapNext = false;
    w.rain += ((kind === "rain" ? 1 : 0) - w.rain) * k;
    w.fog += ((kind === "fog" ? 1 : 0) - w.fog) * k;
    w.heat += ((kind === "heatwave" ? 1 : 0) - w.heat) * k;
    w.fullmoon += ((kind === "fullmoon" ? 1 : 0) - w.fullmoon) * k;
  }

  /** Sky dome / stars / key-light shadow box follow the final (post FpCamera) camera position. */
  private followCamera(): void {
    this.camera.updateMatrixWorld();
    this.camera.getWorldPosition(tmpV);
    this.sky.object.children.forEach((c) => {
      if (c.name === "skyDome" || c.name === "stars") c.position.copy(tmpV);
    });
    // Shadow box: centered a little ahead of the camera on the ground, snapped to shadow texels.
    const profile = QUALITY_PROFILES[this.quality];
    this.camera.getWorldDirection(tmpV2);
    tmpV2.y = 0;
    if (tmpV2.lengthSq() > 1e-6) tmpV2.normalize().multiplyScalar(profile.shadowExtent * 0.35);
    const texel = (profile.shadowExtent * 2) / profile.shadowMapSize;
    const cx = Math.round((tmpV.x + tmpV2.x) / texel) * texel;
    const cz = Math.round((tmpV.z + tmpV2.z) / texel) * texel;
    this.key.target.position.set(cx, 0, cz);
    this.key.position.set(cx, 0, cz).addScaledVector(this.lighting.keyDir, KEY_DISTANCE);
    this.key.target.updateMatrixWorld();
  }

  /** Below the sea surface: short teal fog (restored by the next update()). */
  private applyUnderwater(): void {
    const p = this.camera.position;
    const def = this.island?.def;
    const under = def !== undefined && p.y < WATER_Y - 0.1 && (!inGrid(def.grid, p.x, p.z) || heightAt(def.grid, p.x, p.z) < p.y);
    if (under) {
      this.fog.color.copy(UNDERWATER_FOG);
      this.fog.near = 0.5;
      this.fog.far = 9;
      (this.scene.background as THREE.Color).copy(UNDERWATER_FOG);
    }
    this.underwater = under;
  }

  /** Downed view (§16): half black-and-white, applied as a cheap canvas filter. */
  private applyDesaturation(): void {
    const d = Math.round(this.fp.desaturation * 50) / 50;
    if (d === this.lastDesat) return;
    this.lastDesat = d;
    this.canvas.style.filter = d > 0.01 ? `saturate(${(1 - d).toFixed(2)}) brightness(${(1 - d * 0.12).toFixed(2)})` : "";
  }
}

function toVector(v: Vec3Like, out: THREE.Vector3): THREE.Vector3 {
  return out.set(v.x, v.y, v.z);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}
