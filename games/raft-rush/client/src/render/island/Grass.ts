// Grass tufts (game4.md §20: ~600 instanced, half on low quality): one InstancedMesh of a 4-blade tuft with a
// base→tip gradient, scattered on gentle grassy ground away from the camp, paths and landmarks, tinted per
// position and swaying in the wind. Never casts shadows. Owner: client-render.

import * as THREE from "three";
import { BEACH_MAX_Y, BIOMES } from "../../../../shared/constants";
import { heightAt, normalAt } from "../../../../shared/island/heightfield";
import type { IslandDef, XZ } from "../../../../shared/island/types";
import type { MaterialBank } from "../kit/MaterialBank";
import { createRng, fbm2 } from "../noise";
import { createToonMaterial } from "../Toon";
import { createWindUniforms, injectWind } from "./wind";

const KEEP_OUT = 2.6;

export class Grass {
  readonly mesh: THREE.InstancedMesh;
  readonly triangles: number;
  private readonly uniforms = createWindUniforms();
  private readonly placed: number;

  constructor(def: IslandDef, bank: MaterialBank, count: number) {
    const b = BIOMES[def.biome].colors;
    const geometry = bank.geo(tuftGeometry(new THREE.Color(b.grass), new THREE.Color(b.forest)));
    const material = bank.own(createToonMaterial(0xffffff, { vertexColors: true, side: THREE.DoubleSide }));
    material.name = "grass";
    injectWind(material, this.uniforms, { from: 0, calm: 0.05, storm: 0.2, profile: "linear", key: "raft-grass-sway" });
    const target = def.layout === "duel" ? Math.round(count * 1.8) : count;
    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, target));
    this.mesh.name = "grass";
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;

    const keepOut: XZ[] = [];
    for (const s of def.sites) keepOut.push(s.campfire, s.chest, s.wreck, s.raft, s.spring, ...(s.cave ? [s.cave] : []));
    const rng = createRng((def.seed ^ 0x6a55) >>> 0);
    const grassColor = new THREE.Color(b.grass);
    const forestColor = new THREE.Color(b.forest);
    const tint = new THREE.Color();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const n = { x: 0, y: 1, z: 0 };
    const g = def.grid;
    const minX = g.originX + 2;
    const minZ = g.originZ + 2;
    const spanX = (g.cols - 1) * g.cell - 4;
    const spanZ = (g.rows - 1) * g.cell - 4;
    let placed = 0;
    for (let attempt = 0; attempt < target * 14 && placed < target; attempt++) {
      const x = minX + rng() * spanX;
      const z = minZ + rng() * spanZ;
      const h = heightAt(g, x, z);
      if (h < BEACH_MAX_Y + 0.35) continue;
      normalAt(g, x, z, n);
      if (n.y < 0.82) continue;
      // Clumpy: more tufts where the noise says "meadow".
      const meadow = fbm2(x * 0.08, z * 0.08, def.seed ^ 0x99, 2);
      if (rng() > meadow * 1.6 - 0.15) continue;
      let blocked = false;
      for (const p of keepOut) {
        const dx = p.x - x;
        const dz = p.z - z;
        if (dx * dx + dz * dz < KEEP_OUT * KEEP_OUT) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      pos.set(x, h - 0.02, z);
      // Lean with the slope a little so tufts don't stick out of hillsides.
      q.setFromUnitVectors(up, new THREE.Vector3(n.x * 0.5, 1, n.z * 0.5).normalize());
      q.multiply(new THREE.Quaternion().setFromAxisAngle(up, rng() * Math.PI * 2));
      const s = 0.75 + rng() * 0.6;
      scl.set(s, s * (0.8 + rng() * 0.5), s);
      this.mesh.setMatrixAt(placed, m.compose(pos, q, scl));
      tint.copy(grassColor).lerp(forestColor, meadow * 0.6 + rng() * 0.2).multiplyScalar(0.92 + rng() * 0.16);
      // Instance colors multiply the vertex gradient: normalize against the base grass color.
      tint.r /= Math.max(0.05, grassColor.r);
      tint.g /= Math.max(0.05, grassColor.g);
      tint.b /= Math.max(0.05, grassColor.b);
      this.mesh.setColorAt(placed, tint);
      placed++;
    }
    this.placed = placed;
    this.mesh.count = placed;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.computeBoundingSphere();
    this.triangles = placed * (geometry.getAttribute("position").count / 3);
  }

  /** Draw only `fraction` of the tufts (quality changes without a rebuild). */
  setFraction(fraction: number): void {
    this.mesh.count = Math.round(this.placed * Math.max(0, Math.min(1, fraction)));
  }

  update(elapsed: number, wind: number): void {
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uWind.value = wind;
  }
}

/** Four thin blades around the origin, dark at the root, light at the tip (vertex colors). */
function tuftGeometry(grass: THREE.Color, forest: THREE.Color): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const base = grass.clone().lerp(forest, 0.55).multiplyScalar(0.85);
  const tip = grass.clone().lerp(new THREE.Color(1, 1, 0.85), 0.18);
  const blades = [
    [0, 0.3, 0.0],
    [2.1, 0.24, 0.35],
    [4.0, 0.27, -0.3],
    [5.4, 0.2, 0.2],
  ];
  for (const [a, h, lean] of blades) {
    const ca = Math.cos(a!);
    const sa = Math.sin(a!);
    const w = 0.045;
    const ox = ca * 0.05;
    const oz = sa * 0.05;
    // Blade quad as one triangle: two root corners + a leaning tip.
    const px = -sa * w;
    const pz = ca * w;
    pos.push(ox + px, 0, oz + pz, ox - px, 0, oz - pz, ox + ca * lean! * h!, h!, oz + sa * lean! * h!);
    for (let k = 0; k < 3; k++) nor.push(0, 1, 0);
    col.push(base.r, base.g, base.b, base.r, base.g, base.b, tip.r, tip.g, tip.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
