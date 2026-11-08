// Building blocks for the procedural animals: cached unit geometries, the per-animal material set
// (one vertex-colored toon material with slot mask, ghost mix and rim light; two face materials;
// body + accessory outlines) and a batched builder. Primitives are recorded per pivot in feet
// space and merged at finish() into ONE mesh (+ one outline hull) per pivot.
// Owner: client-characters.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { PALETTE, type CharacterColors } from "../../../shared/constants";
import { createOutlineMaterial, createToonMaterial, getSmoothOutlineGeometry } from "../render/Toon";
import { mixHex } from "../util/color";

/* ============================================================ geometry */

/** Animal detail ("hi" players / lobby, "mid" menu crowd); primitives also use "lo" / "xs" (tiny bits). */
export type Detail = "hi" | "mid" | "lo" | "xs";

const SPHERE_SEGMENTS: Record<Detail, readonly [number, number]> = {
  hi: [14, 10],
  mid: [10, 7],
  lo: [7, 5],
  xs: [5, 4],
};

const geometries = new Map<string, THREE.BufferGeometry>();

/** Geometries are shared by every animal (and both renderers); they are never disposed. */
function cachedGeometry(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let geometry = geometries.get(key);
  if (!geometry) {
    geometry = make();
    geometries.set(key, geometry);
  }
  return geometry;
}

/** Unit sphere (radius 1); primitives scale it into ellipsoids. */
export function sphereGeometry(detail: Detail = "mid"): THREE.BufferGeometry {
  const [w, h] = SPHERE_SEGMENTS[detail];
  return cachedGeometry(`sphere:${detail}`, () => new THREE.SphereGeometry(1, w, h));
}

/**
 * Unit egg: a sphere whose horizontal radius is scaled by (1 + k·y). k > 0 = wider at the top,
 * k < 0 = pear (wider at the bottom). Analytic normals.
 */
export function eggGeometry(k: number, detail: Detail = "mid"): THREE.BufferGeometry {
  const [w, h] = SPHERE_SEGMENTS[detail];
  return cachedGeometry(`egg:${k.toFixed(3)}:${detail}`, () => {
    const g = new THREE.SphereGeometry(1, w, h);
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const nor = g.getAttribute("normal") as THREE.BufferAttribute;
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const f = 1 + k * y;
      const x = pos.getX(i) * f;
      const z = pos.getZ(i) * f;
      pos.setXYZ(i, x, y, z);
      // ∇((x²+z²)/f² + y² − 1)
      n.set(x / (f * f), y - (k * (x * x + z * z)) / (f * f * f), z / (f * f));
      if (n.lengthSq() < 1e-12) n.set(0, Math.sign(y) || 1, 0);
      n.normalize();
      nor.setXYZ(i, n.x, n.y, n.z);
    }
    return g;
  });
}

/** Capsule along +Y from y = 0 to y = length + 2·radius (caps included). */
export function capsuleGeometry(radius: number, length: number, detail: Detail = "mid"): THREE.BufferGeometry {
  const radial = detail === "hi" ? 10 : detail === "mid" ? 8 : detail === "lo" ? 6 : 5;
  const caps = detail === "hi" || detail === "mid" ? 3 : detail === "lo" ? 2 : 1;
  const key = `capsule:${radius.toFixed(3)}:${length.toFixed(3)}:${detail}`;
  return cachedGeometry(key, () => {
    const g = new THREE.CapsuleGeometry(radius, Math.max(1e-4, length), caps, radial);
    g.translate(0, length / 2 + radius, 0);
    return g;
  });
}

/** Unit cone: base radius 1 at y = 0, tip at y = 1. */
export function coneGeometry(segments = 8): THREE.BufferGeometry {
  return cachedGeometry(`cone:${segments}`, () => {
    const g = new THREE.ConeGeometry(1, 1, segments, 1);
    g.translate(0, 0.5, 0);
    return g;
  });
}

/** Unit cylinder: radius 1, from y = 0 to y = 1. `top` is the top radius ratio. */
export function cylinderGeometry(top = 1, segments = 10, open = false): THREE.BufferGeometry {
  return cachedGeometry(`cyl:${top.toFixed(3)}:${segments}:${open}`, () => {
    const g = new THREE.CylinderGeometry(top, 1, 1, segments, 1, open);
    g.translate(0, 0.5, 0);
    return g;
  });
}

/** Torus lying in the XZ plane (a ring around +Y) with a given tube/radius ratio and arc. */
export function torusGeometry(tubeRatio: number, arc = Math.PI * 2, tubular = 12, radial = 5): THREE.BufferGeometry {
  return cachedGeometry(`torus:${tubeRatio.toFixed(3)}:${arc.toFixed(3)}:${tubular}:${radial}`, () => {
    const g = new THREE.TorusGeometry(1, tubeRatio, radial, tubular, arc);
    g.rotateX(Math.PI / 2);
    return g;
  });
}

/** Little hand bell (unit height, mouth at y = 0, radius 1 at the mouth). */
export function bellGeometry(segments = 8): THREE.BufferGeometry {
  return cachedGeometry(`bell:${segments}`, () => {
    // Bottom to top, so the lathe faces point outward.
    const profile = [
      new THREE.Vector2(0.8, 0),
      new THREE.Vector2(1, 0),
      new THREE.Vector2(0.85, 0.15),
      new THREE.Vector2(0.62, 0.45),
      new THREE.Vector2(0.55, 0.75),
      new THREE.Vector2(0.38, 0.95),
      new THREE.Vector2(0, 1),
    ];
    return new THREE.LatheGeometry(profile, segments);
  });
}

/** Rounded box centered on the origin. */
export function roundedBoxGeometry(size: V3, radius: number, detail: Detail = "mid"): THREE.BufferGeometry {
  const seg = detail === "hi" ? 2 : 1;
  const key = `rbox:${size.map((n) => n.toFixed(3)).join(",")}:${radius.toFixed(3)}:${seg}`;
  return cachedGeometry(key, () => new RoundedBoxGeometry(size[0], size[1], size[2], seg, radius));
}

const tubeTmp = {
  t: new THREE.Vector3(),
  n: new THREE.Vector3(),
  b: new THREE.Vector3(),
  p: new THREE.Vector3(),
  q: new THREE.Vector3(),
};

/**
 * Tapered tube through `points` (absolute coordinates) with a radius per point, closed with
 * pointed-round caps. Parallel-transport frames, so curls (horns, S-tails) don't twist.
 */
export function tubeGeometry(points: ReadonlyArray<V3>, radii: ReadonlyArray<number>, radial = 6): THREE.BufferGeometry {
  const key = `tube:${points.map((p) => p.map((n) => n.toFixed(3)).join(",")).join(";")}:${radii.map((r) => r.toFixed(3)).join(",")}:${radial}`;
  return cachedGeometry(key, () => {
    const count = points.length;
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const { t, n, b, p, q } = tubeTmp;
    const tangents: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const a = points[Math.max(0, i - 1)];
      const c = points[Math.min(count - 1, i + 1)];
      tangents.push(new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]).normalize());
    }
    // Initial normal: any vector perpendicular to the first tangent.
    t.copy(tangents[0]);
    n.set(0, 0, 1);
    if (Math.abs(t.dot(n)) > 0.9) n.set(1, 0, 0);
    n.sub(p.copy(t).multiplyScalar(t.dot(n))).normalize();
    const ring = (i: number): void => {
      b.crossVectors(tangents[i], n).normalize();
      for (let j = 0; j < radial; j++) {
        const ang = (j / radial) * Math.PI * 2;
        const cx = Math.cos(ang);
        const sx = Math.sin(ang);
        q.set(n.x * cx + b.x * sx, n.y * cx + b.y * sx, n.z * cx + b.z * sx);
        positions.push(points[i][0] + q.x * radii[i], points[i][1] + q.y * radii[i], points[i][2] + q.z * radii[i]);
        normals.push(q.x, q.y, q.z);
      }
    };
    for (let i = 0; i < count; i++) {
      if (i > 0) {
        // Transport the normal onto the new tangent.
        const tc = tangents[i];
        n.sub(p.copy(tc).multiplyScalar(tc.dot(n))).normalize();
      }
      ring(i);
    }
    for (let i = 0; i < count - 1; i++) {
      for (let j = 0; j < radial; j++) {
        const a = i * radial + j;
        const c = i * radial + ((j + 1) % radial);
        const d = (i + 1) * radial + j;
        const e = (i + 1) * radial + ((j + 1) % radial);
        indices.push(a, c, d, c, e, d);
      }
    }
    // Caps: one apex vertex beyond each end.
    const cap = (i: number, dir: number): void => {
      const tc = tangents[i];
      const r = radii[i];
      const idx = positions.length / 3;
      positions.push(points[i][0] + tc.x * r * 0.7 * dir, points[i][1] + tc.y * r * 0.7 * dir, points[i][2] + tc.z * r * 0.7 * dir);
      normals.push(tc.x * dir, tc.y * dir, tc.z * dir);
      for (let j = 0; j < radial; j++) {
        const a = i * radial + j;
        const c = i * radial + ((j + 1) % radial);
        if (dir > 0) indices.push(a, c, idx);
        else indices.push(c, a, idx);
      }
    };
    cap(count - 1, 1);
    cap(0, -1);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    g.setIndex(indices);
    return g;
  });
}

/* ============================================================== faces */

/** Sub-rectangle of a face-sheet cell, in cell UV space (v = 1 is the top of the cell). */
export interface UvRect {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** Cell bands (see faces.ts): the eye band is the top 150 px of a 256 px tall cell. */
export const EYE_BAND_V = 1 - 150 / 256;
export const UV_EYES: UvRect = { u0: 0, u1: 1, v0: EYE_BAND_V, v1: 1 };
export const UV_MOUTH: UvRect = { u0: 0, u1: 1, v0: 0, v1: EYE_BAND_V };
/** Viewer's left half of the eye band (the character's RIGHT eye). */
export const UV_EYE_RIGHT: UvRect = { u0: 0, u1: 0.5, v0: EYE_BAND_V, v1: 1 };
export const UV_EYE_LEFT: UvRect = { u0: 0.5, u1: 1, v0: EYE_BAND_V, v1: 1 };

/** Logical drawing aspect (width / height) of each band; patches are sized to match. */
export const EYE_BAND_ASPECT = 256 / 150;
export const MOUTH_BAND_ASPECT = 256 / 106;

export interface PatchSpec {
  /** Polar angle of the patch center (0 = top of the sphere, PI/2 = equator). */
  theta: number;
  /** Polar extent in radians. */
  thetaLength: number;
  /** Width / height of the band drawn on it (EYE_BAND_ASPECT, …). */
  aspect: number;
  /** Radii of the parent ellipsoid (to keep drawings round on ellipsoids). */
  parentScale: THREE.Vector3;
  /** Turn toward the character's right (radians around +Y). */
  turn?: number;
  uv: UvRect;
  /** Radius relative to the parent unit sphere (sits just above its surface). */
  lift?: number;
  /** Grid resolution (default 12×8). */
  segments?: readonly [number, number];
}

/**
 * A curved decal on a unit-sphere parent: a sphere section facing -Z whose UVs span `uv` within
 * one face-sheet cell. Cached per spec, so identical patches share geometry.
 */
export function facePatchGeometry(spec: PatchSpec): THREE.BufferGeometry {
  const sx = spec.parentScale.x;
  const sy = spec.parentScale.y;
  const phiLength = (spec.aspect * spec.thetaLength * sy) / (sx * Math.sin(spec.theta));
  const lift = spec.lift ?? 1.015;
  const turn = spec.turn ?? 0;
  const { u0, u1, v0, v1 } = spec.uv;
  const [sw, sh] = spec.segments ?? [12, 8];
  const key = [spec.theta, spec.thetaLength, phiLength, lift, turn, u0, u1, v0, v1, sw, sh].map((n) => n.toFixed(4)).join(":");
  return cachedGeometry(`patch:${key}`, () => {
    const phiCenter = (Math.PI * 3) / 2 - turn;
    const g = new THREE.SphereGeometry(
      lift,
      sw,
      sh,
      phiCenter - phiLength / 2,
      phiLength,
      spec.theta - spec.thetaLength / 2,
      spec.thetaLength,
    );
    const uv = g.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    }
    uv.needsUpdate = true;
    return g;
  });
}

/* ========================================================== materials */

/** A paint is a character color role, the player slot color, ink, or a literal "#RRGGBB". */
export type Paint = keyof CharacterColors | "slot" | "ink" | `#${string}`;

const GHOST_TINT = new THREE.Color("#DDEEFF");
const GHOST_GLOW = new THREE.Color("#9FC8FF");
const GHOST_OUTLINE = new THREE.Color("#7FA6D9");
const GHOST_OPACITY = 0.55;
const FLASH_COLOR = new THREE.Color("#FFFFFF");
const FLASH_INTENSITY = 0.6;
const RIM_COLOR = new THREE.Color("#FFF6E0");
const RIM_STRENGTH = 0.28;
const RIM_GHOST = 0.35;
export const OUTLINE_THICKNESS = 0.022;
export const OUTLINE_THICKNESS_ACCESSORY = 0.015;

/** Dark, slot-tinted outline: still reads as an ink line but tells players apart. */
export function outlineColorFor(slotColor: string): string {
  return mixHex(PALETTE.ink, slotColor, 0.42);
}

let characterRamp: THREE.DataTexture | null = null;

/** Character toon ramp: a lighter shadow band than the world's so saturated fur stays saturated. */
export function getCharacterRamp(): THREE.DataTexture {
  if (characterRamp) return characterRamp;
  const data = new Uint8Array([150, 212, 255, 255]);
  characterRamp = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  characterRamp.minFilter = THREE.NearestFilter;
  characterRamp.magFilter = THREE.NearestFilter;
  characterRamp.generateMipmaps = false;
  characterRamp.needsUpdate = true;
  return characterRamp;
}

interface CharacterUniforms {
  slotColor: { value: THREE.Color };
  ghostMix: { value: number };
  ghostTint: { value: THREE.Color };
  rimColor: { value: THREE.Color };
  rimStrength: { value: number };
}

const VERTEX_PARS = /* glsl */ `
attribute float slot;
uniform vec3 slotColor;
`;
const VERTEX_SLOT = /* glsl */ `
#ifdef USE_COLOR
  vColor.rgb = mix(vColor.rgb, slotColor, slot);
#endif
`;
const FRAGMENT_PARS = /* glsl */ `
uniform float ghostMix;
uniform vec3 ghostTint;
uniform vec3 rimColor;
uniform float rimStrength;
`;
const FRAGMENT_GHOST = /* glsl */ `
  diffuseColor.rgb = mix(diffuseColor.rgb, ghostTint, 0.6 * ghostMix);
`;
const FRAGMENT_RIM = /* glsl */ `
  {
    float rimDot = 1.0 - max(dot(normalize(vViewPosition), normal), 0.0);
    float rimAmt = smoothstep(0.60, 0.66, rimDot) * rimStrength * (0.55 + 0.45 * clamp(normal.y * 0.5 + 0.5, 0.0, 1.0));
    outgoingLight += rimColor * rimAmt;
  }
`;

/** The shared animal shader: vertex colors + slot mask + ghost tint + rim, one program for all. */
function createCharacterMaterial(uniforms: CharacterUniforms): THREE.MeshToonMaterial {
  const m = createToonMaterial("#FFFFFF", { vertexColors: true });
  m.gradientMap = getCharacterRamp();
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
      .replace("#include <color_vertex>", `#include <color_vertex>\n${VERTEX_SLOT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${FRAGMENT_GHOST}`)
      .replace("#include <opaque_fragment>", `${FRAGMENT_RIM}\n#include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => "bonkAnimal";
  return m;
}

export interface FaceMaps {
  eyes: THREE.Texture;
  mouth: THREE.Texture;
}

/**
 * Every material one animal uses: ONE character material (vertex colors, slot mask uniform,
 * ghost mix, rim), the eyes / mouth face materials (not flashed, so eyes stay readable) and the
 * body / accessory outlines. Owned per animal so ghost fades, flashes and slot tints never leak.
 */
export class AnimalMaterials {
  readonly character: THREE.MeshToonMaterial;
  readonly outline: THREE.ShaderMaterial;
  readonly outlineAccessory: THREE.ShaderMaterial;
  readonly eyes: THREE.MeshToonMaterial | null;
  readonly mouth: THREE.MeshToonMaterial | null;
  private readonly uniforms: CharacterUniforms;
  private readonly extras: THREE.Material[] = [];
  private slotColor: string;
  private rimBase = RIM_STRENGTH;
  private ghost = false;
  private ghostFade = 1;
  private flash = false;

  constructor(
    private readonly colors: CharacterColors,
    slotColor: string,
    faces?: FaceMaps,
  ) {
    this.slotColor = slotColor;
    this.uniforms = {
      slotColor: { value: new THREE.Color(slotColor) },
      ghostMix: { value: 0 },
      ghostTint: { value: GHOST_TINT.clone() },
      rimColor: { value: RIM_COLOR.clone() },
      rimStrength: { value: RIM_STRENGTH },
    };
    this.character = createCharacterMaterial(this.uniforms);
    this.outline = createOutlineMaterial(OUTLINE_THICKNESS, outlineColorFor(slotColor));
    this.outlineAccessory = createOutlineMaterial(OUTLINE_THICKNESS_ACCESSORY, outlineColorFor(slotColor));
    this.eyes = faces ? createFaceMaterial(faces.eyes) : null;
    this.mouth = faces ? createFaceMaterial(faces.mouth) : null;
  }

  /** Resolve a paint to "#RRGGBB" (slot resolves to the current slot color). */
  resolve(paint: Paint): string {
    if (paint === "slot") return this.slotColor;
    if (paint === "ink") return PALETTE.ink;
    if (paint.startsWith("#")) return paint;
    return this.colors[paint as keyof CharacterColors];
  }

  /** Per-animal rim strength (dark bodies want less). */
  setRimStrength(strength: number): void {
    this.rimBase = strength;
    this.uniforms.rimStrength.value = this.ghost ? RIM_GHOST : strength;
  }

  /** Track a material created elsewhere so dispose() frees it. */
  adopt<M extends THREE.Material>(material: M): M {
    this.extras.push(material);
    return material;
  }

  setSlotColor(color: string): void {
    if (color === this.slotColor) return;
    this.slotColor = color;
    this.uniforms.slotColor.value.set(color);
    this.applyOutlines();
  }

  setGhost(ghost: boolean): void {
    if (ghost === this.ghost) return;
    this.ghost = ghost;
    this.uniforms.ghostMix.value = ghost ? 1 : 0;
    this.uniforms.rimStrength.value = ghost ? RIM_GHOST : this.rimBase;
    const m = this.character;
    m.transparent = ghost;
    m.needsUpdate = true;
    this.applyAll();
  }

  /** 0..1 ghost visibility (fade-in after a KO). Uniform / opacity writes only. */
  setGhostFade(fade: number): void {
    const clamped = Math.max(0, Math.min(1, fade));
    if (Math.abs(clamped - this.ghostFade) < 1e-3) return;
    this.ghostFade = clamped;
    if (this.ghost) this.applyAll();
  }

  setFlash(on: boolean): void {
    if (on === this.flash) return;
    this.flash = on;
    this.applyEmissive();
  }

  dispose(): void {
    this.character.dispose();
    this.eyes?.dispose();
    this.mouth?.dispose();
    this.outline.dispose();
    this.outlineAccessory.dispose();
    for (const m of this.extras) m.dispose();
    this.extras.length = 0;
  }

  /* ------------------------------------------------------------ internals */

  private applyAll(): void {
    this.character.opacity = this.ghost ? GHOST_OPACITY * this.ghostFade : 1;
    const faceOpacity = this.ghost ? GHOST_OPACITY * 1.4 * this.ghostFade : 1;
    if (this.eyes) this.eyes.opacity = faceOpacity;
    if (this.mouth) this.mouth.opacity = faceOpacity;
    this.applyEmissive();
    this.applyOutlines();
  }

  private applyEmissive(): void {
    const m = this.character;
    if (this.ghost) {
      m.emissive.copy(GHOST_GLOW);
      m.emissiveIntensity = 0.3;
    } else if (this.flash) {
      m.emissive.copy(FLASH_COLOR);
      m.emissiveIntensity = FLASH_INTENSITY;
    } else {
      m.emissive.setRGB(0, 0, 0);
      m.emissiveIntensity = 1;
    }
  }

  private applyOutlines(): void {
    for (const outline of [this.outline, this.outlineAccessory]) {
      const uniforms = outline.uniforms;
      if (this.ghost) {
        (uniforms.color.value as THREE.Color).copy(GHOST_OUTLINE);
        uniforms.opacity.value = 0.6 * this.ghostFade;
      } else {
        (uniforms.color.value as THREE.Color).set(outlineColorFor(this.slotColor));
        uniforms.opacity.value = 1;
      }
      if (outline.transparent !== this.ghost) {
        outline.transparent = this.ghost;
        outline.needsUpdate = true;
      }
    }
  }
}

function createFaceMaterial(map: THREE.Texture): THREE.MeshToonMaterial {
  const m = createToonMaterial("#FFFFFF", { map, transparent: true, depthWrite: false });
  m.gradientMap = getCharacterRamp();
  m.alphaTest = 0.02;
  return m;
}

/* ============================================================ builder */

export type V3 = readonly [number, number, number];

/** Per-primitive options. */
export interface PrimOpts {
  /** Euler XYZ rotation of the primitive around its own anchor (applied before placement). */
  rot?: V3;
  /** Extra local scale. */
  scale?: V3;
  /** Requested detail (downgraded one step on a "mid" animal). */
  detail?: Detail;
  /** Gets an ink outline hull (default true). */
  outline?: boolean;
  /** Thin accessory outline instead of the body one (hat, ribbons, bell…). */
  accessory?: boolean;
  /** May protrude from the hitbox (ears, horns, hat, tails…). */
  flair?: boolean;
  /** Its pivot casts a shadow. */
  shadow?: boolean;
  /** Baked top-light / bottom-dark gradient strength (default 0.07). */
  gradient?: number;
  /** Tiny detail (toes, spots, finger blobs): skipped on "mid" animals (menu crowd). */
  hiOnly?: boolean;
  /** Per-vertex color override in feet space (stripes); writes into `out` (linear). */
  vertexPaint?: (x: number, y: number, z: number, out: THREE.Color) => void;
}

export interface ConeOpts extends PrimOpts {
  segments?: number;
}
export interface CylinderOpts extends PrimOpts {
  topRatio?: number;
  segments?: number;
}
export interface TorusOpts extends PrimOpts {
  axis?: V3;
  arc?: number;
  /** Arc start, radians around the axis, measured from the local +X. */
  start?: number;
  tubular?: number;
  radial?: number;
}

/** Analytic shape of a primitive (for the volume / hitbox tests). */
export type PrimShape =
  | { kind: "ellipsoid"; k: number }
  | { kind: "box"; size: V3; radius: number }
  | { kind: "other" };

/** One recorded primitive (feet space). Exposed read-only for tests and the dev harness. */
export interface Prim {
  geometry: THREE.BufferGeometry;
  /** Source geometry → feet space (rest pose). */
  matrix: THREE.Matrix4;
  color: string;
  slot: boolean;
  outline: boolean;
  accessory: boolean;
  flair: boolean;
  shadow: boolean;
  gradient: number;
  vertexPaint?: PrimOpts["vertexPaint"];
  shape: PrimShape;
}

export interface FacePrim {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  kind: "eyes" | "mouth";
}

export interface PrimHandle {
  pivot: THREE.Object3D;
  index: number;
}

interface PivotRecord {
  prims: Prim[];
  faces: FacePrim[];
}

interface MergedPivot {
  body: THREE.BufferGeometry | null;
  outlineBody: THREE.BufferGeometry | null;
  outlineAccessory: THREE.BufferGeometry | null;
  face: THREE.BufferGeometry | null;
  /** Material index per face group: 0 = eyes, 1 = mouth. */
  shadow: boolean;
}

export interface FinishResult {
  /** Every visible color-pass mesh (body + face meshes, outlines excluded). */
  meshes: THREE.Mesh[];
  /** Meshes that cast shadows. */
  casters: THREE.Mesh[];
  /** Face meshes by pivot name. */
  faces: Map<string, THREE.Mesh>;
  outlines: THREE.Mesh[];
}

const merged = new Map<string, MergedPivot>();

const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();

function lower(d: Detail): Detail {
  return d === "hi" ? "mid" : d === "mid" ? "lo" : "xs";
}

/**
 * Records primitives in "feet space" (the model's rest pose: feet at y = 0, facing -Z, +X = the
 * character's right) per pivot group, then merges them at finish(). Pivots keep identity rest
 * rotation and scale 1: tilts are baked into the geometry via opts.rot or frame().
 */
export class PartBuilder {
  /** Animal detail level ("mid" downgrades every primitive one step). */
  readonly detail: Detail;
  /** Merge-cache prefix (character:detail); null = never cache. */
  readonly cacheKey: string | null;
  private readonly records = new Map<THREE.Object3D, PivotRecord>();
  private readonly frames: THREE.Matrix4[] = [];

  constructor(
    readonly materials: AnimalMaterials,
    opts: { detail?: Detail; cacheKey?: string | null } = {},
  ) {
    this.detail = opts.detail ?? "hi";
    this.cacheKey = opts.cacheKey ?? null;
  }

  /** A pivot group at feet-space `at`. */
  group(parent: THREE.Object3D, at: V3 = [0, 0, 0], name = ""): THREE.Group {
    const g = new THREE.Group();
    g.name = name;
    this.attach(parent, g, at);
    return g;
  }

  /** Empty anchor (hand, head top) at feet-space `at`. */
  anchor(parent: THREE.Object3D, at: V3, name: string): THREE.Object3D {
    const o = new THREE.Object3D();
    o.name = name;
    this.attach(parent, o, at);
    return o;
  }

  /**
   * Bake a transform around feet-space `origin` (Euler XYZ `rot`, optional `scale`) into every
   * primitive recorded inside `fn` (tilted hats, pitched torsos). Nests.
   */
  frame(origin: V3, rot: V3, fn: () => void, scale: number | V3 = 1): void {
    const s = typeof scale === "number" ? [scale, scale, scale] : scale;
    const m = new THREE.Matrix4()
      .makeTranslation(origin[0], origin[1], origin[2])
      .multiply(tmpM.makeRotationFromEuler(tmpE.set(rot[0], rot[1], rot[2])))
      .multiply(tmpM.makeScale(s[0], s[1], s[2]))
      .multiply(tmpM.makeTranslation(-origin[0], -origin[1], -origin[2]));
    const parent = this.frames[this.frames.length - 1];
    this.frames.push(parent ? parent.clone().multiply(m) : m);
    try {
      fn();
    } finally {
      this.frames.pop();
    }
  }

  /** Ellipsoid centered at `at` with radii `r`. */
  sphere(parent: THREE.Object3D, paint: Paint, at: V3, r: number | V3, opts: PrimOpts = {}): PrimHandle {
    const radii: V3 = typeof r === "number" ? [r, r, r] : r;
    return this.place(parent, sphereGeometry(this.lod(opts.detail ?? "mid")), paint, at, radii, null, opts, {
      kind: "ellipsoid",
      k: 0,
    });
  }

  /** Egg / pear (k > 0 wider on top, k < 0 wider at the bottom) centered at `at`. */
  egg(parent: THREE.Object3D, paint: Paint, at: V3, r: V3, k: number, opts: PrimOpts = {}): PrimHandle {
    return this.place(parent, eggGeometry(k, this.lod(opts.detail ?? "mid")), paint, at, r, null, opts, {
      kind: "ellipsoid",
      k,
    });
  }

  /** Rounded box centered at `at`. */
  roundedBox(parent: THREE.Object3D, paint: Paint, at: V3, size: V3, radius: number, opts: PrimOpts = {}): PrimHandle {
    return this.place(parent, roundedBoxGeometry(size, radius, this.lod(opts.detail ?? "mid")), paint, at, [1, 1, 1], null, opts, {
      kind: "box",
      size,
      radius,
    });
  }

  /** Capsule from `from` to `to` (feet space, cap centers) with `radius`. */
  capsule(parent: THREE.Object3D, paint: Paint, from: V3, to: V3, radius: number, opts: PrimOpts = {}): PrimHandle {
    const length = tmpA.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]).length();
    const g = capsuleGeometry(radius, length, this.lod(opts.detail ?? "lo"));
    // Capsule geometry starts at its bottom cap: shift so the first cap center sits on `from`.
    return this.placeAlong(parent, g, paint, from, to, [1, 1, 1], -radius, opts);
  }

  /**
   * Flat strip (ribbon, scarf tail, suspender): a capsule from→to, `width` wide and `thickness`
   * thick, whose flat side faces `normal`.
   */
  flatStrip(
    parent: THREE.Object3D,
    paint: Paint,
    from: V3,
    to: V3,
    width: number,
    thickness: number,
    normal: V3 = [0, 0, 1],
    opts: PrimOpts = {},
  ): PrimHandle {
    const r = width / 2;
    const length = tmpA.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]).length();
    // "xs" strips (whiskers, painted straps) are an open 4-sided prism: 8 triangles.
    const thin = opts.detail === "xs";
    const g = thin ? cylinderGeometry(1, 4, true) : capsuleGeometry(r, length, this.lod(opts.detail ?? "lo"));
    const dir = tmpA.normalize().clone();
    const nz = tmpB.set(normal[0], normal[1], normal[2]);
    nz.sub(tmpC.copy(dir).multiplyScalar(dir.dot(nz)));
    if (nz.lengthSq() < 1e-8) nz.set(dir.y, dir.z, dir.x);
    nz.normalize();
    const nx = new THREE.Vector3().crossVectors(dir, nz);
    const basis = new THREE.Matrix4().makeBasis(nx, dir, nz);
    const m = new THREE.Matrix4()
      .makeTranslation(from[0], from[1], from[2])
      .multiply(basis)
      .multiply(tmpM.makeScale(thin ? r : 1, thin ? length : 1, (thin ? r : 1) * (thickness / width)))
      .multiply(tmpM2.makeTranslation(0, thin ? 0 : -r, 0));
    return this.record(parent, g, paint, this.withLocal(m, opts), opts, { kind: "other" });
  }

  /** Cone with its base centered at `base` pointing at `tip`. */
  cone(parent: THREE.Object3D, paint: Paint, base: V3, tip: V3, radius: number, opts: ConeOpts = {}): PrimHandle {
    const length = tmpA.set(tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]).length();
    return this.placeAlong(parent, coneGeometry(opts.segments ?? 8), paint, base, tip, [radius, length, radius], 0, opts);
  }

  /** Cylinder from `base` to `top` with `radius` (and top radius ratio). */
  cylinder(parent: THREE.Object3D, paint: Paint, base: V3, top: V3, radius: number, opts: CylinderOpts = {}): PrimHandle {
    const length = tmpA.set(top[0] - base[0], top[1] - base[1], top[2] - base[2]).length();
    const g = cylinderGeometry(opts.topRatio ?? 1, opts.segments ?? 10);
    return this.placeAlong(parent, g, paint, base, top, [radius, length, radius], 0, opts);
  }

  /** Ring around `axis` (default +Y) centered at `at`. `arc` < 2π makes an open curl. */
  torus(parent: THREE.Object3D, paint: Paint, at: V3, radius: number, tube: number, opts: TorusOpts = {}): PrimHandle {
    const axis = opts.axis ?? [0, 1, 0];
    const mid = this.detail !== "hi";
    const tubular = Math.max(3, Math.round((opts.tubular ?? 12) * (mid ? 0.7 : 1)));
    const g = torusGeometry(tube / radius, opts.arc ?? Math.PI * 2, tubular, Math.max(3, (opts.radial ?? 4) - (mid ? 1 : 0)));
    tmpQ.setFromUnitVectors(UP, tmpA.set(axis[0], axis[1], axis[2]).normalize());
    const m = new THREE.Matrix4()
      .makeTranslation(at[0], at[1], at[2])
      .multiply(tmpM.makeRotationFromQuaternion(tmpQ))
      .multiply(tmpM2.makeRotationY(-(opts.start ?? 0)))
      .multiply(new THREE.Matrix4().makeScale(radius, radius, radius));
    return this.record(parent, g, paint, this.withLocal(m, opts), opts, { kind: "other" });
  }

  /** Tapered tube through feet-space `points` (tails, horns, curls). */
  tube(parent: THREE.Object3D, paint: Paint, points: ReadonlyArray<V3>, radii: ReadonlyArray<number>, opts: PrimOpts & { radial?: number } = {}): PrimHandle {
    const radial = Math.max(4, (opts.radial ?? 7) - (this.detail === "hi" ? 0 : 2));
    return this.record(parent, tubeGeometry(points, radii, radial), paint, new THREE.Matrix4(), opts, { kind: "other" });
  }

  /** Hand bell hanging with its mouth at `at`, `radius` wide, `height` tall. */
  bell(parent: THREE.Object3D, paint: Paint, at: V3, radius: number, height: number, opts: PrimOpts = {}): PrimHandle {
    return this.place(parent, bellGeometry(this.detail === "hi" ? 8 : 6), paint, at, [radius, height, radius], null, opts, { kind: "other" });
  }

  /** Arbitrary cached geometry at `at` (scaled by `scale`). */
  mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, paint: Paint, at: V3, opts: PrimOpts = {}): PrimHandle {
    return this.place(parent, geometry, paint, at, [1, 1, 1], null, opts, { kind: "other" });
  }

  /**
   * Curved face decal on the ellipsoid (center, radii) recorded on `pivot`. `kind` picks the eyes
   * or the mouth texture (independent expressions).
   */
  facePatch(
    pivot: THREE.Object3D,
    center: V3,
    radii: V3,
    kind: "eyes" | "mouth",
    spec: Omit<PatchSpec, "parentScale">,
  ): void {
    const small = kind === "mouth" || spec.aspect < 1.2;
    const segments: readonly [number, number] = this.detail === "hi" ? (small ? [8, 6] : [10, 7]) : small ? [6, 4] : [8, 5];
    const geometry = facePatchGeometry({ ...spec, segments, parentScale: new THREE.Vector3(radii[0], radii[1], radii[2]) });
    const m = new THREE.Matrix4().makeTranslation(center[0], center[1], center[2]).multiply(tmpM.makeScale(radii[0], radii[1], radii[2]));
    const frame = this.frames[this.frames.length - 1];
    if (frame) m.premultiply(frame);
    this.recordOf(pivot).faces.push({ geometry, matrix: m, kind });
  }

  /** All recorded primitives (tests, harness). */
  allPrims(): ReadonlyArray<{ pivot: THREE.Object3D; prim: Prim }> {
    const out: Array<{ pivot: THREE.Object3D; prim: Prim }> = [];
    for (const [pivot, rec] of this.records) for (const prim of rec.prims) out.push({ pivot, prim });
    return out;
  }

  /**
   * Merge every pivot's primitives into one mesh (+ body / accessory outline hulls, + one face
   * mesh with an eyes and a mouth group). Merged geometry is cached per cacheKey + pivot.
   */
  finish(root: THREE.Object3D): FinishResult {
    root.updateMatrixWorld(true);
    const result: FinishResult = { meshes: [], casters: [], faces: new Map(), outlines: [] };
    const m = this.materials;
    let index = 0;
    for (const [pivot, rec] of this.records) {
      const key = this.cacheKey ? `${this.cacheKey}:${index}:${pivot.name}` : null;
      index++;
      let entry = key ? merged.get(key) : undefined;
      if (!entry) {
        const inv = new THREE.Matrix4().copy(pivot.matrixWorld).invert();
        entry = mergePivot(rec, inv, m);
        if (key) merged.set(key, entry);
      }
      if (entry.body) {
        const mesh = new THREE.Mesh(entry.body, m.character);
        mesh.name = `${pivot.name}:mesh`;
        mesh.castShadow = entry.shadow;
        mesh.receiveShadow = false;
        pivot.add(mesh);
        result.meshes.push(mesh);
        if (entry.shadow) result.casters.push(mesh);
      }
      for (const [geometry, material] of [
        [entry.outlineBody, m.outline],
        [entry.outlineAccessory, m.outlineAccessory],
      ] as const) {
        if (!geometry) continue;
        const outline = new THREE.Mesh(geometry, material);
        outline.name = "outline";
        outline.userData.isOutline = true;
        outline.castShadow = false;
        outline.raycast = () => {};
        pivot.add(outline);
        result.outlines.push(outline);
      }
      if (entry.face && m.eyes && m.mouth) {
        const face = new THREE.Mesh(entry.face, [m.eyes, m.mouth]);
        face.name = "face";
        face.userData.noOutline = true;
        face.renderOrder = 1;
        face.castShadow = false;
        pivot.add(face);
        result.meshes.push(face);
        result.faces.set(pivot.name, face);
      }
    }
    this.records.clear();
    return result;
  }

  /* ------------------------------------------------------------ internals */

  private lod(d: Detail): Detail {
    return this.detail === "hi" ? d : lower(d);
  }

  private recordOf(pivot: THREE.Object3D): PivotRecord {
    let rec = this.records.get(pivot);
    if (!rec) {
      rec = { prims: [], faces: [] };
      this.records.set(pivot, rec);
    }
    return rec;
  }

  /** Local rot/scale opts applied around the primitive's own anchor (right-multiplied). */
  private withLocal(m: THREE.Matrix4, opts: PrimOpts): THREE.Matrix4 {
    // rot / scale for placed prims are composed in place(); here they rotate around the anchor.
    if (opts.rot) m.multiply(tmpM.makeRotationFromEuler(tmpE.set(opts.rot[0], opts.rot[1], opts.rot[2])));
    if (opts.scale) m.multiply(tmpM.makeScale(opts.scale[0], opts.scale[1], opts.scale[2]));
    return m;
  }

  private place(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    paint: Paint,
    at: V3,
    scale: V3,
    quat: THREE.Quaternion | null,
    opts: PrimOpts,
    shape: PrimShape,
  ): PrimHandle {
    const m = new THREE.Matrix4().makeTranslation(at[0], at[1], at[2]);
    if (quat) m.multiply(tmpM.makeRotationFromQuaternion(quat));
    if (opts.rot) m.multiply(tmpM.makeRotationFromEuler(tmpE.set(opts.rot[0], opts.rot[1], opts.rot[2])));
    const s = opts.scale ?? [1, 1, 1];
    m.multiply(tmpM.makeScale(scale[0] * s[0], scale[1] * s[1], scale[2] * s[2]));
    return this.record(parent, geometry, paint, m, opts, shape);
  }

  /** Orient +Y of the geometry along from→to, shifted by `shift` along the axis, scaled. */
  private placeAlong(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    paint: Paint,
    from: V3,
    to: V3,
    scale: V3,
    shift: number,
    opts: PrimOpts,
  ): PrimHandle {
    const dir = tmpA.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0);
    tmpQ.setFromUnitVectors(UP, dir.normalize());
    const m = new THREE.Matrix4()
      .makeTranslation(from[0], from[1], from[2])
      .multiply(tmpM.makeRotationFromQuaternion(tmpQ));
    if (opts.rot) m.multiply(tmpM.makeRotationFromEuler(tmpE.set(opts.rot[0], opts.rot[1], opts.rot[2])));
    const s = opts.scale ?? [1, 1, 1];
    m.multiply(tmpM.makeScale(scale[0] * s[0], scale[1] * s[1], scale[2] * s[2]));
    m.multiply(tmpM.makeTranslation(0, shift / Math.max(1e-6, scale[1] * s[1]), 0));
    return this.record(parent, geometry, paint, m, opts, { kind: "other" });
  }

  private record(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    paint: Paint,
    matrix: THREE.Matrix4,
    opts: PrimOpts,
    shape: PrimShape,
  ): PrimHandle {
    if (opts.hiOnly && this.detail !== "hi") return { pivot: parent, index: -1 };
    const frame = this.frames[this.frames.length - 1];
    if (frame) matrix.premultiply(frame);
    const rec = this.recordOf(parent);
    rec.prims.push({
      geometry,
      matrix,
      color: paint === "slot" ? "#FFFFFF" : this.materials.resolve(paint),
      slot: paint === "slot",
      outline: opts.outline ?? true,
      accessory: opts.accessory ?? false,
      flair: opts.flair ?? false,
      shadow: opts.shadow ?? false,
      gradient: opts.gradient ?? 0.07,
      vertexPaint: opts.vertexPaint,
      shape,
    });
    return { pivot: parent, index: rec.prims.length - 1 };
  }

  private attach(parent: THREE.Object3D, obj: THREE.Object3D, at: V3): void {
    parent.add(obj);
    parent.updateWorldMatrix(true, false);
    obj.position.copy(parent.worldToLocal(tmpA.set(at[0], at[1], at[2])));
  }
}

/* ============================================================== merge */

const CONTACT_Y = 0.12;
const CONTACT_DARKEN = 0.88;

/** Feet-space vertex positions of one primitive (tests / bounds). */
export function primPositions(prim: Prim): Float32Array {
  const src = prim.geometry.getAttribute("position") as THREE.BufferAttribute;
  const out = new Float32Array(src.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < src.count; i++) {
    v.fromBufferAttribute(src, i).applyMatrix4(prim.matrix);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return out;
}

function indexOf(g: THREE.BufferGeometry): ArrayLike<number> {
  if (g.index) return g.index.array as ArrayLike<number>;
  const n = g.getAttribute("position").count;
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

interface MergeSource {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  prim: Prim | null;
}

function mergeGeometries(
  sources: ReadonlyArray<MergeSource>,
  inv: THREE.Matrix4,
  withColor: boolean,
): THREE.BufferGeometry | null {
  if (sources.length === 0) return null;
  let vCount = 0;
  let iCount = 0;
  for (const s of sources) {
    vCount += s.geometry.getAttribute("position").count;
    iCount += indexOf(s.geometry).length;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = withColor ? new Float32Array(vCount * 3) : null;
  const slot = withColor ? new Float32Array(vCount) : null;
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const feet = new THREE.Vector3();
  const local = new THREE.Matrix4();
  const normalM = new THREE.Matrix3();
  const base = new THREE.Color();
  const c = new THREE.Color();
  let vo = 0;
  let io = 0;
  for (const s of sources) {
    const p = s.geometry.getAttribute("position") as THREE.BufferAttribute;
    const nn = s.geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
    local.multiplyMatrices(inv, s.matrix);
    normalM.getNormalMatrix(local);
    const flip = local.determinant() < 0;
    let cy = 0;
    let ry = 1;
    const prim = s.prim;
    if (prim && col) {
      base.set(prim.color);
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < p.count; i++) {
        feet.fromBufferAttribute(p, i).applyMatrix4(s.matrix);
        minY = Math.min(minY, feet.y);
        maxY = Math.max(maxY, feet.y);
      }
      cy = (minY + maxY) / 2;
      ry = Math.max(1e-3, (maxY - minY) / 2);
    }
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      feet.copy(v).applyMatrix4(s.matrix);
      v.applyMatrix4(local);
      pos[(vo + i) * 3] = v.x;
      pos[(vo + i) * 3 + 1] = v.y;
      pos[(vo + i) * 3 + 2] = v.z;
      if (nn) n.fromBufferAttribute(nn, i).applyMatrix3(normalM).normalize();
      else n.set(0, 1, 0);
      nor[(vo + i) * 3] = n.x;
      nor[(vo + i) * 3 + 1] = n.y;
      nor[(vo + i) * 3 + 2] = n.z;
      if (prim && col && slot) {
        c.copy(base);
        if (prim.vertexPaint) prim.vertexPaint(feet.x, feet.y, feet.z, c);
        const g = 1 + prim.gradient * Math.max(-1, Math.min(1, (feet.y - cy) / ry));
        let k = g;
        if (feet.y < CONTACT_Y) k *= CONTACT_DARKEN;
        col[(vo + i) * 3] = Math.min(1, c.r * k);
        col[(vo + i) * 3 + 1] = Math.min(1, c.g * k);
        col[(vo + i) * 3 + 2] = Math.min(1, c.b * k);
        slot[vo + i] = prim.slot ? 1 : 0;
      }
    }
    const src = indexOf(s.geometry);
    for (let t = 0; t < src.length; t += 3) {
      idx[io + t] = src[t] + vo;
      idx[io + t + 1] = (flip ? src[t + 2] : src[t + 1]) + vo;
      idx[io + t + 2] = (flip ? src[t + 1] : src[t + 2]) + vo;
    }
    vo += p.count;
    io += src.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  if (col && slot) {
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("slot", new THREE.BufferAttribute(slot, 1));
  }
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

function mergePivot(rec: PivotRecord, inv: THREE.Matrix4, _materials: AnimalMaterials): MergedPivot {
  const body = mergeGeometries(
    rec.prims.map((prim) => ({ geometry: prim.geometry, matrix: prim.matrix, prim })),
    inv,
    true,
  );
  // One hull per pivot: a pivot that is all accessory gets the thin accessory line; accessory bits
  // merged onto a body pivot (collars, headbands) share the body hull (one draw call).
  const outlined = rec.prims.filter((p) => p.outline);
  const allAccessory = outlined.length > 0 && outlined.every((p) => p.accessory);
  const hull = mergeGeometries(
    outlined.map((p) => ({ geometry: getSmoothOutlineGeometry(p.geometry), matrix: p.matrix, prim: null })),
    inv,
    false,
  );
  return {
    body,
    outlineBody: allAccessory ? null : hull,
    outlineAccessory: allAccessory ? hull : null,
    face: mergeFaces(rec.faces, inv),
    shadow: rec.prims.some((p) => p.shadow),
  };
}

/** One geometry for all face patches of a pivot: group 0 = eyes, group 1 = mouth. */
function mergeFaces(faces: ReadonlyArray<FacePrim>, inv: THREE.Matrix4): THREE.BufferGeometry | null {
  if (faces.length === 0) return null;
  const ordered = [...faces.filter((f) => f.kind === "eyes"), ...faces.filter((f) => f.kind === "mouth")];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const v = new THREE.Vector3();
  const local = new THREE.Matrix4();
  const normalM = new THREE.Matrix3();
  let eyeIndexCount = 0;
  for (const f of ordered) {
    local.multiplyMatrices(inv, f.matrix);
    normalM.getNormalMatrix(local);
    const p = f.geometry.getAttribute("position") as THREE.BufferAttribute;
    const n = f.geometry.getAttribute("normal") as THREE.BufferAttribute;
    const uv = f.geometry.getAttribute("uv") as THREE.BufferAttribute;
    const vo = positions.length / 3;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(local);
      positions.push(v.x, v.y, v.z);
      v.fromBufferAttribute(n, i).applyMatrix3(normalM).normalize();
      normals.push(v.x, v.y, v.z);
      uvs.push(uv.getX(i), uv.getY(i));
    }
    const src = indexOf(f.geometry);
    for (let t = 0; t < src.length; t++) indices.push(src[t] + vo);
    if (f.kind === "eyes") eyeIndexCount += src.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  if (eyeIndexCount > 0) g.addGroup(0, eyeIndexCount, 0);
  if (indices.length > eyeIndexCount) g.addGroup(eyeIndexCount, indices.length - eyeIndexCount, 1);
  g.computeBoundingSphere();
  return g;
}

/** Mark a subtree as non-shadow-casting (decals, small floating bits). */
export function noShadows(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    o.castShadow = false;
  });
}

/** Rest-pose feet-space helper: mirror a point across X. */
export function mirrorX(at: V3, side: 1 | -1): V3 {
  return [at[0] * side, at[1], at[2]];
}
