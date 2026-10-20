// Building blocks for the procedural animals: cached unit geometries, the per-animal material set
// (slot tint, ghost, damage flash) and a builder that places primitives in feet space.
// Owner: client-characters.

import * as THREE from "three";
import { PALETTE, type CharacterColors } from "../../../shared/constants";
import { createOutlineMaterial, createToonMaterial } from "../render/Toon";
import { mixHex } from "../util/color";

/* ============================================================ geometry */

export type Detail = "hi" | "mid" | "lo";

const SPHERE_SEGMENTS: Record<Detail, readonly [number, number]> = {
  hi: [13, 9],
  mid: [9, 6],
  lo: [7, 5],
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

/** Unit sphere (radius 1); meshes scale it into ellipsoids. */
export function sphereGeometry(detail: Detail = "mid"): THREE.BufferGeometry {
  const [w, h] = SPHERE_SEGMENTS[detail];
  return cachedGeometry(`sphere:${detail}`, () => new THREE.SphereGeometry(1, w, h));
}

/** Capsule along +Y from y = 0 to y = length + 2·radius (caps included). */
export function capsuleGeometry(radius: number, length: number, detail: Detail = "mid"): THREE.BufferGeometry {
  const radial = detail === "hi" ? 10 : detail === "mid" ? 8 : 6;
  const caps = detail === "lo" ? 2 : 3;
  const key = `capsule:${radius.toFixed(3)}:${length.toFixed(3)}:${detail}`;
  return cachedGeometry(key, () => {
    const g = new THREE.CapsuleGeometry(radius, length, caps, radial);
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
export function torusGeometry(tubeRatio: number, arc = Math.PI * 2, tubular = 11): THREE.BufferGeometry {
  return cachedGeometry(`torus:${tubeRatio.toFixed(3)}:${arc.toFixed(3)}:${tubular}`, () => {
    const g = new THREE.TorusGeometry(1, tubeRatio, 4, tubular, arc);
    g.rotateX(Math.PI / 2);
    return g;
  });
}

/** Little hand bell (unit height, mouth at y = 0, radius 1 at the mouth). */
export function bellGeometry(): THREE.BufferGeometry {
  return cachedGeometry("bell", () => {
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
    return new THREE.LatheGeometry(profile, 10);
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
  /** Scale of the parent unit-sphere mesh (to keep drawings round on ellipsoids). */
  parentScale: THREE.Vector3;
  /** Turn toward the character's right (radians around +Y). */
  turn?: number;
  uv: UvRect;
  /** Radius relative to the parent unit sphere (sits just above its surface). */
  lift?: number;
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
  const key = [spec.theta, spec.thetaLength, phiLength, lift, turn, u0, u1, v0, v1].map((n) => n.toFixed(4)).join(":");
  return cachedGeometry(`patch:${key}`, () => {
    const phiCenter = (Math.PI * 3) / 2 - turn;
    const g = new THREE.SphereGeometry(
      lift,
      7,
      5,
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

const GHOST_TINT = "#DDEEFF";
const GHOST_GLOW = new THREE.Color("#9FC8FF");
const GHOST_OUTLINE = new THREE.Color("#7FA6D9");
const GHOST_OPACITY = 0.55;
const FLASH_COLOR = new THREE.Color("#FFFFFF");
const FLASH_INTENSITY = 0.6;
export const OUTLINE_THICKNESS = 0.024;

/** Dark, slot-tinted outline: still reads as an ink line but tells players apart. */
export function outlineColorFor(slotColor: string): string {
  return mixHex(PALETTE.ink, slotColor, 0.42);
}

interface MaterialEntry {
  material: THREE.MeshToonMaterial;
  hex: string;
}

/**
 * Every material one animal uses. Owned per animal so ghost fades, damage flashes and slot tints
 * never leak between players. The face material is exempt from the flash so eyes stay readable.
 */
export class AnimalMaterials {
  readonly outline: THREE.ShaderMaterial;
  private readonly entries = new Map<string, MaterialEntry>();
  private readonly extras: THREE.Material[] = [];
  private face: THREE.MeshToonMaterial | null = null;
  private slotColor: string;
  private ghost = false;
  private ghostFade = 1;
  private flash = false;

  constructor(
    private readonly colors: CharacterColors,
    slotColor: string,
  ) {
    this.slotColor = slotColor;
    this.outline = createOutlineMaterial(OUTLINE_THICKNESS, outlineColorFor(slotColor));
  }

  get(paint: Paint): THREE.MeshToonMaterial {
    let entry = this.entries.get(paint);
    if (!entry) {
      const hex = this.resolve(paint);
      entry = { material: createToonMaterial(hex), hex };
      this.entries.set(paint, entry);
      this.applyTo(entry);
    }
    return entry.material;
  }

  /** The face decal material (transparent sprite-sheet map, not flashed). */
  faceMaterial(map: THREE.Texture): THREE.MeshToonMaterial {
    if (!this.face) {
      this.face = createToonMaterial("#FFFFFF", { map, transparent: true, depthWrite: false });
      this.face.alphaTest = 0.02;
      this.applyFace();
    }
    return this.face;
  }

  /** Track a material created elsewhere so dispose() frees it. */
  adopt<M extends THREE.Material>(material: M): M {
    this.extras.push(material);
    return material;
  }

  setSlotColor(color: string): void {
    if (color === this.slotColor) return;
    this.slotColor = color;
    const slot = this.entries.get("slot");
    if (slot) {
      slot.hex = color;
      this.applyTo(slot);
    }
    this.applyOutline();
  }

  setGhost(ghost: boolean): void {
    if (ghost === this.ghost) return;
    this.ghost = ghost;
    this.applyAll();
  }

  /** 0..1 ghost visibility (fade-in after a KO). */
  setGhostFade(fade: number): void {
    const clamped = Math.max(0, Math.min(1, fade));
    if (Math.abs(clamped - this.ghostFade) < 1e-3) return;
    this.ghostFade = clamped;
    if (this.ghost) this.applyAll();
  }

  setFlash(on: boolean): void {
    if (on === this.flash) return;
    this.flash = on;
    for (const entry of this.entries.values()) this.applyEmissive(entry.material);
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.material.dispose();
    this.entries.clear();
    this.face?.dispose();
    this.face = null;
    this.outline.dispose();
    for (const m of this.extras) m.dispose();
    this.extras.length = 0;
  }

  /* ------------------------------------------------------------ internals */

  private resolve(paint: Paint): string {
    if (paint === "slot") return this.slotColor;
    if (paint === "ink") return PALETTE.ink;
    if (paint.startsWith("#")) return paint;
    return this.colors[paint as keyof CharacterColors];
  }

  private applyAll(): void {
    for (const entry of this.entries.values()) this.applyTo(entry);
    this.applyFace();
    this.applyOutline();
  }

  private applyTo(entry: MaterialEntry): void {
    const m = entry.material;
    m.color.set(this.ghost ? mixHex(entry.hex, GHOST_TINT, 0.6) : entry.hex);
    this.applyOpacity(m);
    this.applyEmissive(m);
  }

  private applyFace(): void {
    if (!this.face) return;
    this.face.opacity = this.ghost ? GHOST_OPACITY * 1.4 * this.ghostFade : 1;
  }

  private applyOpacity(m: THREE.Material): void {
    const transparent = this.ghost;
    if (m.transparent !== transparent) {
      m.transparent = transparent;
      m.needsUpdate = true;
    }
    m.opacity = this.ghost ? GHOST_OPACITY * this.ghostFade : 1;
  }

  private applyEmissive(m: THREE.MeshToonMaterial): void {
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

  private applyOutline(): void {
    const uniforms = this.outline.uniforms;
    if (this.ghost) {
      (uniforms.color.value as THREE.Color).copy(GHOST_OUTLINE);
      uniforms.opacity.value = 0.6 * this.ghostFade;
    } else {
      (uniforms.color.value as THREE.Color).set(outlineColorFor(this.slotColor));
      uniforms.opacity.value = 1;
    }
    if (this.outline.transparent !== this.ghost) {
      this.outline.transparent = this.ghost;
      this.outline.needsUpdate = true;
    }
  }
}

/* ============================================================ builder */

export type V3 = readonly [number, number, number];

const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/**
 * Places primitives in "feet space" (the model's rest pose: feet at y = 0, facing -Z, +X = the
 * character's right) regardless of which group they are parented to. Build under an
 * identity-transformed root so parent.worldToLocal() maps feet space into each group.
 */
export class PartBuilder {
  constructor(readonly materials: AnimalMaterials) {}

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

  /** Ellipsoid centered at `at` with radii `r`. */
  sphere(parent: THREE.Object3D, paint: Paint, at: V3, r: number | V3, detail: Detail = "mid"): THREE.Mesh {
    const mesh = this.mesh(parent, sphereGeometry(detail), paint, at);
    if (typeof r === "number") mesh.scale.setScalar(r);
    else mesh.scale.set(r[0], r[1], r[2]);
    return mesh;
  }

  /** Capsule from `from` to `to` (feet space, cap centers) with `radius`. */
  capsule(parent: THREE.Object3D, paint: Paint, from: V3, to: V3, radius: number, detail: Detail = "mid"): THREE.Mesh {
    const a = tmpA.set(from[0], from[1], from[2]);
    const b = tmpB.set(to[0], to[1], to[2]);
    const length = a.distanceTo(b);
    const mesh = this.mesh(parent, capsuleGeometry(radius, length, detail), paint, [a.x, a.y - radius, a.z]);
    this.aim(mesh, parent, from, to, radius);
    return mesh;
  }

  /** Cone with its base centered at `base` pointing at `tip`. */
  cone(parent: THREE.Object3D, paint: Paint, base: V3, tip: V3, radius: number, segments = 8): THREE.Mesh {
    const mesh = this.mesh(parent, coneGeometry(segments), paint, base);
    this.pointAlong(mesh, parent, base, tip);
    mesh.scale.set(radius, tmpA.set(tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]).length(), radius);
    return mesh;
  }

  /** Cylinder from `base` to `top` (feet space) with `radius` (and top radius ratio). */
  cylinder(
    parent: THREE.Object3D,
    paint: Paint,
    base: V3,
    top: V3,
    radius: number,
    topRatio = 1,
    segments = 10,
  ): THREE.Mesh {
    const mesh = this.mesh(parent, cylinderGeometry(topRatio, segments), paint, base);
    this.pointAlong(mesh, parent, base, top);
    mesh.scale.set(radius, tmpA.set(top[0] - base[0], top[1] - base[1], top[2] - base[2]).length(), radius);
    return mesh;
  }

  /** Ring around `axis` (default +Y) centered at `at`. `arc` < 2π makes an open curl. */
  torus(
    parent: THREE.Object3D,
    paint: Paint,
    at: V3,
    radius: number,
    tube: number,
    axis: V3 = [0, 1, 0],
    arc = Math.PI * 2,
  ): THREE.Mesh {
    const mesh = this.mesh(parent, torusGeometry(tube / radius, arc), paint, at);
    this.pointAlong(mesh, parent, at, [at[0] + axis[0], at[1] + axis[1], at[2] + axis[2]]);
    mesh.scale.setScalar(radius);
    return mesh;
  }

  mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, paint: Paint, at: V3): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, this.materials.get(paint));
    mesh.castShadow = true;
    this.attach(parent, mesh, at);
    return mesh;
  }

  /** Curved face decal on a unit-sphere mesh (child of that mesh, so it follows its scale). */
  facePatch(parentMesh: THREE.Mesh, map: THREE.Texture, spec: Omit<PatchSpec, "parentScale">): THREE.Mesh {
    const geometry = facePatchGeometry({ ...spec, parentScale: parentMesh.scale.clone() });
    const patch = new THREE.Mesh(geometry, this.materials.faceMaterial(map));
    patch.name = "face";
    patch.userData.noOutline = true;
    patch.renderOrder = 1;
    parentMesh.add(patch);
    return patch;
  }

  private attach(parent: THREE.Object3D, obj: THREE.Object3D, at: V3): void {
    parent.add(obj);
    parent.updateWorldMatrix(true, false);
    obj.position.copy(parent.worldToLocal(tmpA.set(at[0], at[1], at[2])));
  }

  /** Orient +Y of `obj` along from→to in the parent's frame. */
  private pointAlong(obj: THREE.Object3D, parent: THREE.Object3D, from: V3, to: V3): void {
    parent.updateWorldMatrix(true, false);
    const a = parent.worldToLocal(tmpA.set(from[0], from[1], from[2]));
    const b = parent.worldToLocal(tmpB.set(to[0], to[1], to[2]));
    const dir = b.sub(a);
    if (dir.lengthSq() < 1e-10) return;
    obj.quaternion.setFromUnitVectors(UP, dir.normalize());
  }

  /** Capsules are built from their bottom cap: re-anchor at `from` after orienting. */
  private aim(mesh: THREE.Mesh, parent: THREE.Object3D, from: V3, to: V3, radius: number): void {
    this.pointAlong(mesh, parent, from, to);
    parent.updateWorldMatrix(true, false);
    const start = parent.worldToLocal(tmpA.set(from[0], from[1], from[2]));
    const axis = tmpB.set(0, 1, 0).applyQuaternion(mesh.quaternion);
    mesh.position.copy(start).addScaledVector(axis, -radius);
  }
}

/** Mark a subtree as non-shadow-casting (decals, small floating bits). */
export function noShadows(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    o.castShadow = false;
  });
}
