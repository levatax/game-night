// Shared toon-shading helpers. Complete. Every 3D module builds materials through these so the
// look is consistent: MeshToonMaterial with a 3-step ramp + inverted-hull black outlines.

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

/** Cached toon material for a color. Pass `unique: true` when you'll mutate it (emissive flashes etc.). */
export function toon(color: THREE.ColorRepresentation, opts: { unique?: boolean; emissive?: THREE.ColorRepresentation; transparent?: boolean; opacity?: number } = {}): THREE.MeshToonMaterial {
  const key = `${new THREE.Color(color).getHexString()}|${opts.emissive ?? ""}|${opts.opacity ?? 1}`;
  if (!opts.unique) {
    const hit = materialCache.get(key);
    if (hit) return hit;
  }
  const mat = new THREE.MeshToonMaterial({
    color,
    gradientMap: toonRamp(),
    emissive: opts.emissive ?? 0x000000,
    transparent: opts.transparent ?? (opts.opacity ?? 1) < 1,
    opacity: opts.opacity ?? 1,
  });
  if (!opts.unique) materialCache.set(key, mat);
  return mat;
}

const outlineMat = new THREE.MeshBasicMaterial({ color: PALETTE.ink, side: THREE.BackSide });

/**
 * Add an inverted-hull outline child to every Mesh under `root` (skips meshes named "noOutline" and
 * meshes whose material is transparent). `thickness` is a scale factor (1.04 = 4% bigger).
 */
export function addOutlines(root: THREE.Object3D, thickness = 1.05): void {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.name === "noOutline" || m.name === "outline" || m.userData.noOutline) return;
    const mat = m.material as THREE.Material;
    if (mat.transparent) return;
    meshes.push(m);
  });
  for (const m of meshes) {
    const shell = new THREE.Mesh(m.geometry, outlineMat);
    shell.name = "outline";
    shell.scale.setScalar(thickness);
    shell.castShadow = false;
    shell.receiveShadow = false;
    shell.raycast = () => {};
    m.add(shell);
  }
}

/** Two googly eyes (white ball + black pupil that jiggles). Call `jiggleEyes(group, dt)` each frame. */
export function googlyEyes(size = 0.02, spacing = 0.025): THREE.Group {
  const g = new THREE.Group();
  g.name = "googly";
  const white = toon("#FFFFFF");
  const black = new THREE.MeshBasicMaterial({ color: PALETTE.ink });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 10), white);
    eye.position.x = side * spacing;
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(size * 0.5, 8, 6), black);
    pupil.name = "pupil";
    pupil.position.z = size * 0.7;
    pupil.userData.vel = new THREE.Vector2();
    pupil.userData.off = new THREE.Vector2();
    eye.add(pupil);
    g.add(eye);
  }
  return g;
}

/** Spring the pupils around; pass a world-space shake (e.g. the piece velocity) to make them wobble more. */
export function jiggleEyes(root: THREE.Object3D, dt: number, shake = 0): void {
  root.traverse((o) => {
    if (o.name !== "pupil") return;
    const v = o.userData.vel as THREE.Vector2;
    const off = o.userData.off as THREE.Vector2;
    const kick = shake * 0.02 + 0.0004;
    v.x += (Math.random() - 0.5) * kick - off.x * 120 * dt;
    v.y += (Math.random() - 0.5) * kick - off.y * 120 * dt;
    v.multiplyScalar(Math.max(0, 1 - 6 * dt));
    off.addScaledVector(v, dt * 60);
    const max = 0.45;
    if (off.length() > max) off.setLength(max);
    const parent = o.parent as THREE.Mesh;
    const r = (parent.geometry as THREE.SphereGeometry).parameters?.radius ?? 0.02;
    o.position.set(off.x * r, off.y * r, r * 0.7);
  });
}
