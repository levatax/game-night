// Toon shading + inverted-hull outlines shared by characters, fx and the arena.
// Owner: client-render (written by the architect, complete).

import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { PALETTE } from "../../../shared/constants";

let ramp: THREE.DataTexture | null = null;

/**
 * The shared 3-step toon ramp (dark / mid / light), 3×1 px, NearestFilter, used as the
 * gradientMap of every MeshToonMaterial so all lighting falls into crisp cel bands.
 */
export function getToonRamp(): THREE.DataTexture {
  if (ramp) return ramp;
  const data = new Uint8Array([110, 190, 255]);
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

// Works for plain meshes and InstancedMesh (three defines USE_INSTANCING + instanceMatrix for
// ShaderMaterial). Not for SkinnedMesh / morph targets (the animals are rigid part groups).
const OUTLINE_VERTEX = /* glsl */ `
  uniform float thickness;
  void main() {
    vec4 localPosition = vec4(position, 1.0);
    vec3 localNormal = normal;
    #ifdef USE_INSTANCING
      localPosition = instanceMatrix * localPosition;
      localNormal = mat3(instanceMatrix) * localNormal;
    #endif
    vec4 mvPosition = modelViewMatrix * localPosition;
    vec3 n = normalize(normalMatrix * localNormal);
    // Grow slightly with distance so far outlines stay visible (~2-3 px look).
    float grow = clamp(-mvPosition.z / 8.0, 1.0, 3.0);
    mvPosition.xyz += n * thickness * grow;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const OUTLINE_FRAGMENT = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  void main() {
    gl_FragColor = vec4(color, opacity);
  }
`;

const outlineMaterials = new Map<string, THREE.ShaderMaterial>();

/**
 * Shared back-face outline material (cached by thickness + color). Thickness is in view-space
 * meters (independent of the mesh's scale). Don't dispose cached materials.
 */
export function getOutlineMaterial(thickness = 0.03, color: THREE.ColorRepresentation = PALETTE.ink): THREE.ShaderMaterial {
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
    });
    outlineMaterials.set(key, mat);
  }
  return mat;
}

/** A new (uncached) outline material, for outlines whose color/opacity animates (e.g. tinted per player, fading ghosts). */
export function createOutlineMaterial(thickness = 0.03, color: THREE.ColorRepresentation = PALETTE.ink): THREE.ShaderMaterial {
  return getOutlineMaterial(thickness, color).clone();
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
 * InstancedMesh is skipped (a plain child would draw one copy at the origin): for instanced
 * objects create your own InstancedMesh with getOutlineMaterial() and the same instance matrices.
 * Returns the created outline meshes (e.g. to toggle visibility or swap materials).
 */
export function addOutline(
  target: THREE.Object3D,
  thickness = 0.03,
  color: THREE.ColorRepresentation = PALETTE.ink,
): THREE.Mesh[] {
  const material = getOutlineMaterial(thickness, color);
  const meshes: THREE.Mesh[] = [];
  target.traverse((obj) => {
    if (
      obj instanceof THREE.Mesh &&
      !(obj instanceof THREE.InstancedMesh) &&
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
