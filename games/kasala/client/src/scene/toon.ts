// Shared toon-shading helpers. Complete. Every 3D module builds materials through these so the look is
// consistent with Bonk Brawl / Jelly Jackpot (§13): MeshToonMaterial with a 3-step ramp + inverted-hull black
// outlines, plus a canvas-texture helper for painted labels (card faces, name plates, wheel slices, signs).
// Outline hulls live on OUTLINE_LAYER (the Stage camera renders it, shadow cameras don't), so they never cost
// a shadow-pass draw. Cached toon() materials are shared and must never be mutated (StaticBatch bakes them
// into vertex colors); ask for `unique: true` when you need to change one.

import * as THREE from "three";
import { PALETTE } from "../../../shared/constants";

let ramp: THREE.DataTexture | null = null;

/** The shared 3-step toon gradient. */
export function toonRamp(): THREE.DataTexture {
  if (ramp) return ramp;
  const data = new Uint8Array([90, 90, 90, 255, 180, 180, 180, 255, 255, 255, 255, 255]);
  ramp = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  ramp.minFilter = THREE.NearestFilter;
  ramp.magFilter = THREE.NearestFilter;
  ramp.generateMipmaps = false;
  ramp.needsUpdate = true;
  return ramp;
}

const materialCache = new Map<string, THREE.MeshToonMaterial>();
/** Cached (shared, never mutated) toon materials: StaticBatch may bake their color into vertex colors. */
const sharedToons = new WeakSet<THREE.Material>();

/** True for a material handed out by the toon() cache (shared, so callers must never mutate it). */
export function isSharedToon(mat: THREE.Material): boolean {
  return sharedToons.has(mat);
}

export interface ToonOptions {
  /** Return a fresh material you may mutate (emissive flashes, opacity fades…). */
  unique?: boolean;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  map?: THREE.Texture | null;
  side?: THREE.Side;
}

/** Cached toon material for a color. Pass `unique: true` when you'll mutate it. */
export function toon(color: THREE.ColorRepresentation, opts: ToonOptions = {}): THREE.MeshToonMaterial {
  const cacheable = !opts.unique && !opts.map;
  const key = `${new THREE.Color(color).getHexString()}|${opts.emissive ?? ""}|${opts.emissiveIntensity ?? 1}|${opts.opacity ?? 1}|${opts.side ?? 0}`;
  if (cacheable) {
    const hit = materialCache.get(key);
    if (hit) return hit;
  }
  const mat = new THREE.MeshToonMaterial({
    color,
    gradientMap: toonRamp(),
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    transparent: opts.transparent ?? (opts.opacity ?? 1) < 1,
    opacity: opts.opacity ?? 1,
    map: opts.map ?? null,
    side: opts.side ?? THREE.FrontSide,
  });
  if (cacheable) {
    materialCache.set(key, mat);
    sharedToons.add(mat);
  }
  return mat;
}

const outlineMat = new THREE.MeshBasicMaterial({ color: PALETTE.ink, side: THREE.BackSide });

/**
 * Render layer of every outline hull. The Stage camera enables it; shadow cameras only see layer 0, so a hull
 * can never reach the shadow pass, even on a clone or after a `traverse(m => m.castShadow = true)`.
 */
export const OUTLINE_LAYER = 5;

/**
 * Pin an outline hull out of the shadow passes: it lives on OUTLINE_LAYER only, and castShadow /
 * receiveShadow always read false whatever a later write says (a hull in the shadow map doubles every
 * caster's cost and fattens the shadow by the hull thickness).
 */
export function noShadow(mesh: THREE.Object3D): void {
  mesh.layers.set(OUTLINE_LAYER);
  for (const key of ["castShadow", "receiveShadow"] as const) {
    Object.defineProperty(mesh, key, { get: () => false, set: () => {}, configurable: true, enumerable: true });
  }
}

/**
 * Add an inverted-hull outline child to every Mesh under `root` (skips meshes named "noOutline"/"outline",
 * meshes with userData.noOutline, and transparent meshes). `thickness` is a scale factor (1.05 = 5% bigger).
 * Hulls never cast or receive shadows (see noShadow) and never take raycasts.
 */
export function addOutlines(root: THREE.Object3D, thickness = 1.05): void {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.name === "noOutline" || m.name === "outline" || m.userData.noOutline) return;
    const mat = m.material as THREE.Material;
    if (Array.isArray(mat) || mat.transparent) return;
    meshes.push(m);
  });
  for (const m of meshes) {
    const shell = new THREE.Mesh(m.geometry, outlineMat);
    shell.name = "outline";
    shell.scale.setScalar(thickness);
    noShadow(shell);
    shell.raycast = () => {};
    m.add(shell);
  }
}

/**
 * Paint onto a canvas and get a texture (sRGB, mipmapped). `draw` receives a 2D context of `w`×`h` px.
 * Fonts: use "Fredoka" (loaded by index.html; call after `document.fonts.ready` for crisp text).
 */
export function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Resolves once web fonts are loaded (or after 2 s), so canvas text uses Fredoka / Monoton. */
export function fontsReady(): Promise<void> {
  const ready = (document as Document & { fonts?: FontFaceSet }).fonts?.ready.then(() => undefined) ?? Promise.resolve();
  return Promise.race([ready, new Promise<void>((r) => setTimeout(r, 2000))]);
}
