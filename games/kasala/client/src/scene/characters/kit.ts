// Shared building blocks for every character model: unit geometries (scaled per mesh, so they are built
// once), cached toon materials, the pinstripe suit material, a tiny geometry merger for static props and a
// couple of canvas textures. Owner: client-characters.

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { canvasTexture, noShadow, toon } from "../toon";

// ---------------------------------------------------------------- geometry
function buildGeo() {
  const jacket = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.0, -0.02),
      new THREE.Vector2(0.17, -0.02),
      new THREE.Vector2(0.205, 0.05),
      new THREE.Vector2(0.22, 0.16),
      new THREE.Vector2(0.215, 0.28),
      new THREE.Vector2(0.2, 0.37),
      new THREE.Vector2(0.165, 0.44),
      new THREE.Vector2(0.1, 0.48),
      new THREE.Vector2(0.0, 0.49),
    ],
    18,
  );
  // Trench-coat / long-jacket skirt below the waist (open cone, double-sided).
  const skirt = new THREE.CylinderGeometry(0.2, 0.25, 0.42, 18, 1, true);
  skirt.translate(0, -0.21, 0);
  const crown = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.0, 0.135),
      new THREE.Vector2(0.06, 0.15),
      new THREE.Vector2(0.12, 0.165),
      new THREE.Vector2(0.15, 0.13),
      new THREE.Vector2(0.165, 0.06),
      new THREE.Vector2(0.172, 0.0),
      new THREE.Vector2(0.0, 0.0),
    ],
    18,
  );
  const brim = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.0, 0.0),
      new THREE.Vector2(0.18, 0.0),
      new THREE.Vector2(0.26, 0.004),
      new THREE.Vector2(0.285, 0.025),
      new THREE.Vector2(0.28, 0.035),
      new THREE.Vector2(0.25, 0.016),
      new THREE.Vector2(0.18, 0.016),
      new THREE.Vector2(0.0, 0.016),
    ],
    20,
  );
  const heart = heartGeometry();
  return {
    sphere: new THREE.SphereGeometry(1, 16, 12),
    sphereLo: new THREE.SphereGeometry(1, 10, 7),
    hemi: new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2),
    cyl: new THREE.CylinderGeometry(1, 1, 1, 16),
    cylLo: new THREE.CylinderGeometry(1, 1, 1, 8),
    cylOpen: new THREE.CylinderGeometry(1, 1, 1, 18, 1, true),
    cone: new THREE.ConeGeometry(1, 1, 12),
    coneLo: new THREE.ConeGeometry(1, 1, 6),
    box: new THREE.BoxGeometry(1, 1, 1),
    rbox: roundedBox(),
    torus: new THREE.TorusGeometry(1, 0.12, 6, 20),
    torusFat: new THREE.TorusGeometry(1, 0.28, 8, 18),
    halfTorus: new THREE.TorusGeometry(1, 0.2, 6, 14, Math.PI),
    halfDisc: new THREE.CircleGeometry(1, 16, Math.PI, Math.PI),
    disc: new THREE.CircleGeometry(1, 20),
    ring: new THREE.RingGeometry(0.86, 1, 40),
    plane: new THREE.PlaneGeometry(1, 1),
    capsule: new THREE.CapsuleGeometry(0.5, 1, 4, 10),
    jacket,
    skirt,
    crown,
    brim,
    heart,
    // Limbs: capsule along −Y starting at the joint (0) to −len.
    upperArm: limb(0.062, 0.2),
    foreArm: limb(0.055, 0.19),
    thigh: limb(0.078, 0.27),
    shin: limb(0.068, 0.28),
  };
}

function limb(r: number, len: number): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len - r), 4, 10);
  g.translate(0, -len / 2, 0);
  return g;
}

function roundedBox(): THREE.BufferGeometry {
  // A slightly puffed unit box: corners pulled toward a sphere so props read soft and toon-friendly.
  const g = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const s = v.clone().normalize().multiplyScalar(0.62);
    v.lerp(s, 0.22);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function heartGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, -0.5);
  s.bezierCurveTo(-0.15, -0.32, -0.55, -0.12, -0.55, 0.17);
  s.bezierCurveTo(-0.55, 0.42, -0.28, 0.55, 0, 0.32);
  s.bezierCurveTo(0.28, 0.55, 0.55, 0.42, 0.55, 0.17);
  s.bezierCurveTo(0.55, -0.12, 0.15, -0.32, 0, -0.5);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.22, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 2, curveSegments: 8 });
  g.center();
  return g;
}

let geo: ReturnType<typeof buildGeo> | null = null;
/** Shared unit geometries (lazy). */
export function G(): ReturnType<typeof buildGeo> {
  if (!geo) geo = buildGeo();
  return geo;
}

// --------------------------------------------------------------- materials
export const inkMat = new THREE.MeshBasicMaterial({ color: PALETTE.ink });
export const mouthMat = new THREE.MeshBasicMaterial({ color: "#4A1626" });
export const tongueMat = new THREE.MeshBasicMaterial({ color: "#FF6F91" });
export const whiteMat = new THREE.MeshBasicMaterial({ color: "#FFFFFF" });

/** Toon material shortcut (cached per color). */
export function mat(color: THREE.ColorRepresentation): THREE.MeshToonMaterial {
  return toon(color);
}

const suitCache = new Map<string, THREE.MeshToonMaterial>();
/** Pinstripe suit cloth (canvas texture, cached per color pair). */
export function suitMat(base: string, stripe: string): THREE.MeshToonMaterial {
  const key = `${base}|${stripe}`;
  const hit = suitCache.get(key);
  if (hit) return hit;
  const tex = canvasTexture(64, 64, (ctx, w, h) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = stripe;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(14, 0, 3, h);
    ctx.fillRect(46, 0, 3, h);
    ctx.globalAlpha = 0.25;
    ctx.fillRect(30, 0, 2, h);
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(7, 2);
  tex.magFilter = THREE.LinearFilter;
  const m = toon("#FFFFFF", { map: tex });
  suitCache.set(key, m);
  return m;
}

/** Fresh per-instance toon material (tints: anger, ghost, grey). */
export function uniqueMat(color: THREE.ColorRepresentation): THREE.MeshToonMaterial {
  return toon(color, { unique: true });
}

const greyCache = new Map<THREE.Material, THREE.Material>();
/** Desaturated twin of a material (disconnected players). */
export function greyOf(m: THREE.Material): THREE.Material {
  const hit = greyCache.get(m);
  if (hit) return hit;
  let out: THREE.Material = m;
  if (m === inkMat || (m as THREE.MeshBasicMaterial).name === "outline") out = m;
  else if ((m as THREE.MeshToonMaterial).isMeshToonMaterial) {
    const src = m as THREE.MeshToonMaterial;
    const c = src.color.clone();
    const l = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
    c.setRGB(l * 0.75 + 0.12, l * 0.75 + 0.12, l * 0.78 + 0.14);
    const g = toon(c, { unique: true, map: src.map, transparent: src.transparent, opacity: src.opacity, side: src.side });
    if (src.map) g.color.setRGB(0.62, 0.62, 0.66);
    out = g;
  } else if ((m as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
    const src = m as THREE.MeshBasicMaterial;
    const c = src.color.clone();
    const l = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
    out = new THREE.MeshBasicMaterial({ color: new THREE.Color(l, l, l), transparent: src.transparent, opacity: src.opacity });
  }
  greyCache.set(m, out);
  return out;
}

/** Translucent blue-green ghost body (§10 hayalet). */
export const ghostMat = new THREE.MeshToonMaterial({
  color: "#8FF5DA",
  emissive: "#2BB89A",
  emissiveIntensity: 0.55,
  transparent: true,
  opacity: 0.5,
  depthWrite: true,
});
export const ghostDarkMat = new THREE.MeshToonMaterial({
  color: "#4FB7A5",
  emissive: "#1D7F6E",
  emissiveIntensity: 0.4,
  transparent: true,
  opacity: 0.55,
  depthWrite: true,
});
export const ghostLineMat = new THREE.MeshBasicMaterial({ color: "#1C6E62", side: THREE.BackSide, transparent: true, opacity: 0.35 });

// ------------------------------------------------------------------ meshes
/** Mesh helper: unit geometry scaled to size. */
export function mesh(
  g: THREE.BufferGeometry,
  m: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  sx = 1,
  sy: number = sx,
  sz: number = sx,
): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.scale.set(sx, sy, sz);
  // Shadow casting is decided per rig by size (optimizeShadows): tiny face parts never cast.
  o.castShadow = false;
  return o;
}

/** Mark a subtree as "no outline" (small face details, decals). */
export function noOutline<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => (c.userData.noOutline = true));
  return o;
}

/** Merge static parts into one non-indexed geometry (position / normal / uv). */
export function mergeParts(parts: { g: THREE.BufferGeometry; m: THREE.Matrix4 }[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const p of parts) {
    const g = p.g.index ? p.g.toNonIndexed() : p.g;
    const pa = g.attributes.position as THREE.BufferAttribute;
    const na = g.attributes.normal as THREE.BufferAttribute | undefined;
    const ua = g.attributes.uv as THREE.BufferAttribute | undefined;
    nm.getNormalMatrix(p.m);
    for (let i = 0; i < pa.count; i++) {
      v.fromBufferAttribute(pa, i).applyMatrix4(p.m);
      pos.push(v.x, v.y, v.z);
      if (na) v.fromBufferAttribute(na, i).applyMatrix3(nm).normalize();
      else v.set(0, 1, 0);
      nor.push(v.x, v.y, v.z);
      if (ua) uv.push(ua.getX(i), ua.getY(i));
      else uv.push(0, 0);
    }
    if (g !== p.g) g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/**
 * Merge the static Mesh children of `parent` that share a material (and skin behavior) into one mesh each,
 * including a single merged inverted-hull outline for the parts that had one. Cuts draw calls per rig.
 * Skips meshes that are hidden (toggled props), referenced elsewhere (`skip`), animated (userData.anim) or that
 * carry children other than their outline shell.
 */
export function mergeStatic(parent: THREE.Object3D, skip?: ReadonlySet<THREE.Object3D>): void {
  const groups = new Map<string, THREE.Mesh[]>();
  for (const c of parent.children) {
    const m = c as THREE.Mesh;
    if (!m.isMesh || !m.visible || m.name === "noOutline" || m.name === "outline" || skip?.has(m) || m.userData.anim) continue;
    const material = m.material as THREE.Material;
    if (Array.isArray(m.material) || m.geometry.morphAttributes.position) continue;
    if (m.children.some((k) => k.name !== "outline")) continue;
    const key = `${material.uuid}|${m.userData.keepSkin ? 1 : 0}`;
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const body: { g: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
    const hull: { g: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
    let hullMat: THREE.Material | null = null;
    let cast = false;
    for (const m of list) {
      m.updateMatrix();
      body.push({ g: m.geometry, m: m.matrix.clone() });
      cast ||= m.castShadow;
      for (const k of m.children) {
        const shell = k as THREE.Mesh;
        if (!shell.isMesh) continue;
        shell.updateMatrix();
        hull.push({ g: shell.geometry, m: m.matrix.clone().multiply(shell.matrix) });
        hullMat = shell.material as THREE.Material;
      }
      parent.remove(m);
    }
    const merged = new THREE.Mesh(mergeParts(body), list[0]!.material);
    merged.geometry.userData.owned = true;
    merged.castShadow = cast;
    merged.userData.keepSkin = !!list[0]!.userData.keepSkin;
    merged.userData.noOutline = true;
    parent.add(merged);
    if (hull.length && hullMat) {
      const shell = new THREE.Mesh(mergeParts(hull), hullMat);
      shell.geometry.userData.owned = true;
      shell.name = "outline";
      noShadow(shell);
      shell.raycast = () => {};
      merged.add(shell);
    }
  }
}

/** Free the per-instance geometry a model owns (merged parts); shared unit geometries stay. */
export function disposeOwned(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry.userData.owned) m.geometry.dispose();
  });
}

const _ws = new THREE.Vector3();
const _ext = new THREE.Vector3();
/**
 * Shadow budget for a model: only solid, chunky meshes cast (jacket, skull, hat, limbs, paws, chair): a world
 * bounding radius ≥ `castMin` AND no thin dimension (whiskers, lids, cuffs, decals never cast). Only big ones
 * receive, and inverted-hull outline shells never do.
 */
export function optimizeShadows(root: THREE.Object3D, castMin = 0.075, receiveMin = 0.12): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.name === "outline" || m.name === "noOutline") {
      m.castShadow = m.receiveShadow = false;
      return;
    }
    const material = m.material as THREE.Material;
    const g = m.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    if (!g.boundingBox) g.computeBoundingBox();
    m.getWorldScale(_ws);
    _ws.set(Math.abs(_ws.x), Math.abs(_ws.y), Math.abs(_ws.z));
    const r = (g.boundingSphere?.radius ?? 0) * Math.max(_ws.x, _ws.y, _ws.z);
    g.boundingBox!.getSize(_ext).multiply(_ws);
    const thin = Math.min(_ext.x, _ext.y, _ext.z);
    const opaque = Array.isArray(material) || !material.transparent;
    m.castShadow = opaque && r >= castMin && thin >= 0.045;
    m.receiveShadow = opaque && r >= receiveMin;
  });
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
/** Matrix shortcut for mergeParts. */
export function trs(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy: number = sx, sz: number = sx): THREE.Matrix4 {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

// ---------------------------------------------------------------- textures
let glowTex: THREE.CanvasTexture | null = null;
/** Soft radial glow (white, tint with material color). */
export function glowTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  glowTex = canvasTexture(128, 128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.4, "rgba(255,255,255,0.5)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
  return glowTex;
}

let beamTex: THREE.CanvasTexture | null = null;
/** Vertical fade for light beams (opaque at the bottom, clear at the top). */
export function beamTexture(): THREE.CanvasTexture {
  if (beamTex) return beamTex;
  beamTex = canvasTexture(8, 128, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.55, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0.85)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 8, 128);
  });
  return beamTex;
}

export const FONT = `"Fredoka", "Baloo 2", system-ui, sans-serif`;
