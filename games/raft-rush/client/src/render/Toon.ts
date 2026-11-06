// Toon shading + inverted-hull outlines shared by the island scene, characters and fx. Owner: client-render.
// Copied from games/bonk-brawl/client/src/render/Toon.ts and extended with cached shared colors
// (toonColor), the shared vertex-colored toon material (vertexColorToon), additive glow materials and
// noShadow(). Characters and fx may import this file (docs/ARCHITECTURE.md §1).
// The ramp is soft on purpose (no pure-white lit band, a darker shade band that grade.ts tints cool): the
// global grade lives in grade.ts and is installed the first time a toon material is made.

import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { PALETTE } from "../../../shared/constants";
import { installGrade } from "./grade";

/** Outline / ink color of the whole game (game4.md §16). */
export const INK = PALETTE.ink;

/**
 * Camera layer of the depth-test-free screen overlay (marker labels, nameplates). The main camera sees it on every
 * tier; on the post-FX tier Renderer draws it after the composer, so OutputPass's grade never dims it.
 */
export const OVERLAY_LAYER = 2;

let ramp: THREE.DataTexture | null = null;

/**
 * The shared 3-step toon ramp (dark / mid / light), 3×1 px, NearestFilter, used as the
 * gradientMap of every MeshToonMaterial so all lighting falls into crisp cel bands. Steps 0.36 / 0.69 / 0.91:
 * the lit band stops short of 1 so sunlit sand and white cloth don't blow out, the shade band sits a little
 * lower than the classic cel 0.43 for depth (grade.ts tints it cool).
 */
export function getToonRamp(): THREE.DataTexture {
  if (ramp) return ramp;
  installGrade();
  const data = new Uint8Array([92, 176, 232]);
  ramp = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  ramp.minFilter = THREE.NearestFilter;
  ramp.magFilter = THREE.NearestFilter;
  ramp.generateMipmaps = false;
  ramp.needsUpdate = true;
  return ramp;
}

export interface ToonOptions {
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  vertexColors?: boolean;
  map?: THREE.Texture | null;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  /** Low-poly faceted look. Default false. */
  flatShading?: boolean;
  depthWrite?: boolean;
}

/** A MeshToonMaterial with the shared ramp. Each call returns a NEW material (caller owns/disposes it). */
export function createToonMaterial(color: THREE.ColorRepresentation, opts: ToonOptions = {}): THREE.MeshToonMaterial {
  const material = new THREE.MeshToonMaterial({
    color,
    gradientMap: getToonRamp(),
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    vertexColors: opts.vertexColors ?? false,
    map: opts.map ?? null,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    depthWrite: opts.depthWrite ?? true,
  });
  // MeshToonMaterial has no typed `flatShading` parameter (passing it to the constructor only logs a
  // warning), but its shader honors the base Material flag via FLAT_SHADED (derivative normals).
  if (opts.flatShading) (material as unknown as { flatShading: boolean }).flatShading = true;
  return material;
}

const sharedToons = new Map<string, THREE.MeshToonMaterial>();
const sharedSet = new WeakSet<THREE.Material>();

/**
 * Cached toon material for a plain color (+ options): same arguments → the same instance. Shared by every
 * module, so NEVER mutate or dispose it (use createToonMaterial for anything that animates).
 */
export function toonColor(color: THREE.ColorRepresentation, opts: ToonOptions = {}): THREE.MeshToonMaterial {
  const c = new THREE.Color(color);
  const key = [
    c.getHexString(),
    opts.map?.uuid ?? "",
    opts.vertexColors ? "vc" : "",
    opts.flatShading ? "flat" : "",
    opts.transparent ? `t${opts.opacity ?? 1}` : "",
    opts.emissive !== undefined ? new THREE.Color(opts.emissive).getHexString() + (opts.emissiveIntensity ?? 1) : "",
    opts.side ?? "",
    opts.depthWrite === false ? "nodw" : "",
  ].join("|");
  let mat = sharedToons.get(key);
  if (!mat) {
    mat = createToonMaterial(color, opts);
    mat.name = `toon-${c.getHexString()}`;
    sharedToons.set(key, mat);
    sharedSet.add(mat);
  }
  return mat;
}

/** True for materials returned by toonColor() / vertexColorToon() (shared: don't dispose). */
export function isSharedToon(material: THREE.Material): boolean {
  return sharedSet.has(material);
}

const vertexToons = new Map<string, THREE.MeshToonMaterial>();

/**
 * The shared vertex-colored toon material every baked (kit/Baker) mesh uses: one program and one material
 * for all static props. `flat` = faceted normals from derivatives (terrain-like low-poly look).
 */
export function vertexColorToon(side: THREE.Side = THREE.FrontSide, flat = false): THREE.MeshToonMaterial {
  const key = `${side}|${flat ? 1 : 0}`;
  let mat = vertexToons.get(key);
  if (!mat) {
    mat = createToonMaterial(0xffffff, { vertexColors: true, side, flatShading: flat });
    mat.name = "toon-vertex-color";
    vertexToons.set(key, mat);
    sharedSet.add(mat);
  }
  return mat;
}

const glowMaterials = new Map<string, THREE.MeshBasicMaterial>();

/**
 * Shared unlit additive glow (flames, embers, READY halo, firefly cores). Ignores fog and doesn't write
 * depth. Don't mutate or dispose; clone it for animated opacity.
 */
export function glowMaterial(color: THREE.ColorRepresentation, opacity = 1, map: THREE.Texture | null = null): THREE.MeshBasicMaterial {
  const c = new THREE.Color(color);
  const key = `${c.getHexString()}|${opacity}|${map?.uuid ?? ""}`;
  let mat = glowMaterials.get(key);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({
      color: c,
      transparent: true,
      opacity,
      map,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    mat.name = `glow-${c.getHexString()}`;
    glowMaterials.set(key, mat);
    sharedSet.add(mat);
  }
  return mat;
}

/** Mark an object (and its children) as neither casting nor receiving shadows. */
export function noShadow(root: THREE.Object3D): void {
  root.traverse((o) => {
    o.castShadow = false;
    o.receiveShadow = false;
  });
}

// Works for plain meshes, InstancedMesh and BatchedMesh (three defines USE_INSTANCING / USE_BATCHING for
// ShaderMaterial too). Not for SkinnedMesh / morph targets (characters are rigid part groups).
const OUTLINE_VERTEX = /* glsl */ `
  #include <common>
  #include <batching_pars_vertex>
  #include <color_pars_vertex>
  #include <fog_pars_vertex>
  uniform float thickness;
  void main() {
    #include <batching_vertex>
    #include <color_vertex>
    vec4 localPosition = vec4(position, 1.0);
    vec3 localNormal = normal;
    #ifdef USE_INSTANCING
      localPosition = instanceMatrix * localPosition;
      localNormal = mat3(instanceMatrix) * localNormal;
    #endif
    #ifdef USE_BATCHING
      localPosition = batchingMatrix * localPosition;
      localNormal = mat3(batchingMatrix) * localNormal;
    #endif
    vec4 mvPosition = modelViewMatrix * localPosition;
    vec3 n = normalize(normalMatrix * localNormal);
    // Grow slightly with distance so far outlines stay visible (~2-3 px look).
    float grow = clamp(-mvPosition.z / 8.0, 1.0, 3.0);
    mvPosition.xyz += n * thickness * grow;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const OUTLINE_FRAGMENT = /* glsl */ `
  #include <fog_pars_fragment>
  #include <color_pars_fragment>
  uniform vec3 color;
  uniform float opacity;
  void main() {
    vec3 tint = color;
    #ifdef USE_BATCHING_COLOR
      // Batched characters carry their seat-tinted ink in the per-instance colour.
      tint *= vColor.rgb;
    #endif
    gl_FragColor = vec4(tint, opacity);
    #include <fog_fragment>
  }
`;

const outlineMaterials = new Map<string, THREE.ShaderMaterial>();

/**
 * Shared back-face outline material (cached by thickness + color). Thickness is in view-space
 * meters (independent of the mesh's scale). Don't dispose cached materials.
 */
export function getOutlineMaterial(thickness = 0.03, color: THREE.ColorRepresentation = INK): THREE.ShaderMaterial {
  const c = new THREE.Color(color);
  const key = `${thickness.toFixed(4)}|${c.getHexString()}`;
  let mat = outlineMaterials.get(key);
  if (!mat) {
    mat = new THREE.ShaderMaterial({
      uniforms: {
        thickness: { value: thickness },
        color: { value: c },
        opacity: { value: 1 },
      },
      vertexShader: OUTLINE_VERTEX,
      fragmentShader: OUTLINE_FRAGMENT,
      side: THREE.BackSide,
      // Far outlines fade into the fog with their object instead of leaving ink silhouettes.
      fog: true,
    });
    mat.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, mat.uniforms]);
    mat.name = "outline";
    outlineMaterials.set(key, mat);
    sharedSet.add(mat);
  }
  return mat;
}

/** A new (uncached) outline material, for outlines whose color/opacity animates (e.g. tinted per player, fading ghosts). */
export function createOutlineMaterial(thickness = 0.03, color: THREE.ColorRepresentation = INK): THREE.ShaderMaterial {
  const mat = getOutlineMaterial(thickness, color).clone();
  return mat;
}

const smoothCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

/**
 * Geometry with merged vertices + smooth normals so the inverted hull has no cracks on
 * flat-shaded / split-normal low-poly meshes. Cached per source geometry.
 */
export function getSmoothOutlineGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  let smooth = smoothCache.get(geometry);
  if (!smooth) {
    const stripped = new THREE.BufferGeometry();
    stripped.setAttribute("position", geometry.getAttribute("position"));
    if (geometry.index) stripped.setIndex(geometry.index);
    smooth = mergeVertices(stripped, 1e-4);
    smooth.computeVertexNormals();
    smoothCache.set(geometry, smooth);
  }
  return smooth;
}

/**
 * Add an inverted-hull outline child to every Mesh under `target` (including target itself),
 * skipping meshes with userData.noOutline or userData.isOutline. Each outline is a child Mesh
 * named "outline" with userData.isOutline = true, sharing the smooth outline geometry, so it
 * follows the parent's transform and animation. Outlines don't cast/receive shadows.
 * InstancedMesh / BatchedMesh are skipped (a plain child would draw one copy at the origin): for those
 * create your own instanced copy with getOutlineMaterial() and the same instance matrices.
 * Returns the created outline meshes (e.g. to toggle visibility or swap materials).
 */
export function addOutline(target: THREE.Object3D, thickness = 0.03, color: THREE.ColorRepresentation = INK): THREE.Mesh[] {
  const material = getOutlineMaterial(thickness, color);
  const meshes: THREE.Mesh[] = [];
  target.traverse((obj) => {
    if (
      obj instanceof THREE.Mesh &&
      !(obj instanceof THREE.InstancedMesh) &&
      !(obj as unknown as { isBatchedMesh?: boolean }).isBatchedMesh &&
      !obj.userData.noOutline &&
      !obj.userData.isOutline
    ) {
      meshes.push(obj);
    }
  });
  const created: THREE.Mesh[] = [];
  for (const mesh of meshes) {
    const outline = new THREE.Mesh(getSmoothOutlineGeometry(mesh.geometry), material);
    outline.name = "outline";
    outline.userData.isOutline = true;
    outline.castShadow = false;
    outline.receiveShadow = false;
    outline.raycast = () => {};
    mesh.add(outline);
    created.push(outline);
  }
  return created;
}

/** Remove outlines previously added by addOutline under `target`. Geometry/material are shared (not disposed). */
export function removeOutline(target: THREE.Object3D): void {
  const outlines: THREE.Object3D[] = [];
  target.traverse((obj) => {
    if (obj.userData.isOutline) outlines.push(obj);
  });
  for (const o of outlines) o.removeFromParent();
}
