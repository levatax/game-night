// Shared, lazily-built fx geometries (never dispose the returned instances). Owner: client-fx.

import * as THREE from "three";

let sphere: THREE.SphereGeometry | null = null;
let banana: THREE.BufferGeometry | null = null;
let flatQuad: THREE.PlaneGeometry | null = null;

/** Unit-radius ball (UVs match ballSkinTexture / beachBallTexture). */
export function ballGeometry(): THREE.SphereGeometry {
  if (!sphere) sphere = new THREE.SphereGeometry(1, 28, 18);
  return sphere;
}

/** 2×2 quad lying flat in XZ (blob shadows, ground rings). */
export function flatQuadGeometry(): THREE.PlaneGeometry {
  if (!flatQuad) {
    flatQuad = new THREE.PlaneGeometry(2, 2);
    flatQuad.rotateX(-Math.PI / 2);
  }
  return flatQuad;
}

const BANANA_YELLOW = new THREE.Color("#FFE14D");
const BANANA_GREEN = new THREE.Color("#B9D84A");
const BANANA_TIP = new THREE.Color("#6B4A2B");

/**
 * Low-poly banana: a pentagonal tube bent along an arc, tapered toward both ends, with brown
 * tips and a green-ish stem end (vertex colors). Indexed with shared vertices so the
 * inverted-hull outline has no cracks; use with flatShading for the faceted look.
 * Centered on its bounding box, ~2 units long along X, curving toward +Y at the ends.
 */
export function bananaGeometry(): THREE.BufferGeometry {
  if (banana) return banana;
  const lengthSegments = 18;
  const sides = 5;
  const arc = 1.7;
  const arcRadius = 2 / arc;
  const maxRadius = 0.3;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const color = new THREE.Color();

  for (let i = 0; i <= lengthSegments; i++) {
    const t = i / lengthSegments;
    const a = (t - 0.5) * arc;
    // Arc center above the banana, so the ends curl up ("smile").
    const cx = Math.sin(a) * arcRadius;
    const cy = -Math.cos(a) * arcRadius;
    const nx = -Math.sin(a);
    const ny = Math.cos(a);
    const r = Math.max(0.05, maxRadius * Math.pow(Math.sin(Math.PI * t), 0.6));
    bananaRingColor(t, color);
    for (let k = 0; k < sides; k++) {
      const phi = (k / sides) * Math.PI * 2;
      const across = Math.cos(phi) * r;
      positions.push(cx + nx * across, cy + ny * across, Math.sin(phi) * r);
      colors.push(color.r, color.g, color.b);
    }
  }
  for (let i = 0; i < lengthSegments; i++) {
    for (let k = 0; k < sides; k++) {
      const a = i * sides + k;
      const b = i * sides + ((k + 1) % sides);
      const c = (i + 1) * sides + k;
      const d = (i + 1) * sides + ((k + 1) % sides);
      indices.push(a, b, c, b, d, c);
    }
  }
  addCap(positions, colors, indices, 0, sides, true);
  addCap(positions, colors, indices, lengthSegments * sides, sides, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.center();
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  banana = geo;
  return banana;
}

function bananaRingColor(t: number, out: THREE.Color): THREE.Color {
  if (t < 0.07 || t > 0.95) return out.copy(BANANA_TIP);
  if (t < 0.22) return out.copy(BANANA_GREEN).lerp(BANANA_YELLOW, (t - 0.07) / 0.15);
  return out.copy(BANANA_YELLOW);
}

/** Closes a tube end with a fan around the ring's centroid. */
function addCap(positions: number[], colors: number[], indices: number[], ringStart: number, sides: number, flip: boolean): void {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let k = 0; k < sides; k++) {
    x += positions[(ringStart + k) * 3];
    y += positions[(ringStart + k) * 3 + 1];
    z += positions[(ringStart + k) * 3 + 2];
  }
  const center = positions.length / 3;
  positions.push(x / sides, y / sides, z / sides);
  colors.push(BANANA_TIP.r, BANANA_TIP.g, BANANA_TIP.b);
  for (let k = 0; k < sides; k++) {
    const a = ringStart + k;
    const b = ringStart + ((k + 1) % sides);
    if (flip) indices.push(center, b, a);
    else indices.push(center, a, b);
  }
}
