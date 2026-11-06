// Grass tufts (game4.md §20): one InstancedMesh of a 5-blade tuft with a dark-root → sunlit-tip gradient,
// scattered on gentle grassy ground — never on the beach, the trodden paths, the camp or under dense canopy,
// clumped into meadows by noise. The count is the quality tier's tufts for the reference island scaled by this
// island's grassy area (a bigger lowland gets more tufts at the same density, capped). Each tuft is tinted with
// the muted ground palette at its spot (dry olive ↔ sage ↔ lush, same macro noise as Terrain.ts), sways in the
// wind and shrinks to nothing between FADE_NEAR and FADE_FAR from the camera (no far-field shimmer, no wasted
// fill). Never casts shadows. Owner: client-render.

import * as THREE from "three";
import { BEACH_MAX_Y } from "../../../../shared/constants";
import { heightAt, normalAt } from "../../../../shared/island/heightfield";
import type { IslandDef, XZ } from "../../../../shared/island/types";
import type { MaterialBank } from "../kit/MaterialBank";
import { createRng, fbm2 } from "../noise";
import { createToonMaterial } from "../Toon";
import { groundPalette } from "./flora/palette";
import { campPaths, CLEARING_RADIUS, PATH_HALF, segmentDistance } from "./Terrain";
import { createWindUniforms, injectWind } from "./wind";

const KEEP_OUT = 2.6;
/** Grassy area (m², gentle ground above the beach) of the island the quality tiers' tuft counts were tuned on. */
const REFERENCE_GRASS_AREA = 1400;
/** Never more than this × the tier count, however big the island. */
const MAX_AREA_SCALE = 3;
/** Distance fade (m from the camera): full size inside NEAR, gone beyond FAR. */
const FADE_NEAR = 24;
const FADE_FAR = 38;

export class Grass {
  readonly mesh: THREE.InstancedMesh;
  readonly triangles: number;
  private readonly uniforms = createWindUniforms();
  private readonly placed: number;

  /** `count` = the tier's tufts for the reference island (QUALITY_PROFILES[q].grassTufts). */
  constructor(def: IslandDef, bank: MaterialBank, count: number) {
    const pal = groundPalette(def.biome);
    const geometry = bank.geo(tuftGeometry());
    const material = bank.own(createToonMaterial(0xffffff, { vertexColors: true, side: THREE.DoubleSide }));
    material.name = "grass";
    injectWind(material, this.uniforms, { from: 0, calm: 0.05, storm: 0.2, profile: "linear", key: "raft-grass-sway" });
    addDistanceFade(material);
    const g = def.grid;
    const areaScale = Math.min(MAX_AREA_SCALE, Math.max(1, grassyArea(def) / REFERENCE_GRASS_AREA));
    const target = Math.round(count * areaScale * (def.layout === "duel" ? 1.8 : 1));
    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, target));
    this.mesh.name = "grass";
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;

    const keepOut: XZ[] = [];
    for (const s of def.sites) keepOut.push(s.campfire, s.chest, s.wreck, s.raft, s.spring, ...(s.cave ? [s.cave] : []));
    const { paths, clearings } = campPaths(def);
    const canopy: Array<{ x: number; z: number; r2: number }> = [];
    for (const n of def.nodes) if (n.kind === "tree" || n.kind === "rock") canopy.push({ x: n.x, z: n.z, r2: n.kind === "tree" ? 1.3 * 1.3 : (n.radius + 0.25) * (n.radius + 0.25) });
    const rng = createRng((def.seed ^ 0x6a55) >>> 0);
    const dry = new THREE.Color(pal.grassDry);
    const grass = new THREE.Color(pal.grass);
    const lush = new THREE.Color(pal.grassLush);
    const tint = new THREE.Color();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const spin = new THREE.Quaternion();
    const lean = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const n = { x: 0, y: 1, z: 0 };
    const minX = g.originX + 2;
    const minZ = g.originZ + 2;
    const spanX = (g.cols - 1) * g.cell - 4;
    const spanZ = (g.rows - 1) * g.cell - 4;
    const seed = def.seed | 0;
    let placed = 0;
    for (let attempt = 0; attempt < target * 24 && placed < target; attempt++) {
      const x = minX + rng() * spanX;
      const z = minZ + rng() * spanZ;
      const h = heightAt(g, x, z);
      // Off the beach (with the same ragged fringe feel as the terrain: a few strays reach a little lower).
      if (h < BEACH_MAX_Y + 0.3 + rng() * 0.25) continue;
      normalAt(g, x, z, n);
      if (n.y < 0.84) continue;
      // Clumpy: more tufts where the noise says "meadow".
      const meadow = fbm2(x * 0.08, z * 0.08, def.seed ^ 0x99, 2);
      if (rng() > meadow * 1.6 - 0.15) continue;
      if (near(keepOut, x, z, KEEP_OUT * KEEP_OUT)) continue;
      let onPath = false;
      for (const s of paths) {
        if (segmentDistance(s, x, z) < PATH_HALF + 0.25) {
          onPath = true;
          break;
        }
      }
      if (onPath || near(clearings, x, z, CLEARING_RADIUS * CLEARING_RADIUS)) continue;
      // Not in a trunk or a boulder.
      let covered = false;
      for (const c of canopy) {
        const dx = c.x - x;
        const dz = c.z - z;
        if (dx * dx + dz * dz < c.r2) {
          covered = true;
          break;
        }
      }
      if (covered) continue;
      pos.set(x, h - 0.03, z);
      // Lean with the slope a little so tufts don't stick out of hillsides.
      q.setFromUnitVectors(up, lean.set(n.x * 0.5, 1, n.z * 0.5).normalize());
      q.multiply(spin.setFromAxisAngle(up, rng() * Math.PI * 2));
      const s = 0.8 + rng() * 0.65;
      scl.set(s * (0.9 + rng() * 0.3), s * (0.75 + rng() * 0.6), s * (0.9 + rng() * 0.3));
      this.mesh.setMatrixAt(placed, m.compose(pos, q, scl));
      // Ground palette at this spot (same noises as Terrain.ts), a little value jitter on top.
      const macro = fbm2(x * 0.022, z * 0.022, seed ^ 0x6c3, 3);
      const patch = fbm2(x * 0.07, z * 0.07, seed ^ 0x2b17, 2) - 0.5;
      tint.copy(dry).lerp(grass, smooth(0.25, 0.65, macro + patch * 0.3 + (h - BEACH_MAX_Y) * 0.06));
      tint.lerp(lush, Math.max(0, Math.min(1, patch * 0.9 + (0.5 - macro) * 0.4 + meadow * 0.3)) * 0.7);
      tint.multiplyScalar(0.9 + rng() * 0.18);
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

function near(points: ReadonlyArray<XZ>, x: number, z: number, r2: number): boolean {
  for (const p of points) {
    const dx = p.x - x;
    const dz = p.z - z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Gentle grassy ground (m²): above the beach and not steep, sampled per grid vertex. */
function grassyArea(def: IslandDef): number {
  const g = def.grid;
  const hs = g.heights;
  let count = 0;
  for (let r = 1; r < g.rows - 1; r++) {
    for (let c = 1; c < g.cols - 1; c++) {
      const i = r * g.cols + c;
      if (hs[i]! < BEACH_MAX_Y + 0.35) continue;
      const dx = (hs[i + 1]! - hs[i - 1]!) / (2 * g.cell);
      const dz = (hs[i + g.cols]! - hs[i - g.cols]!) / (2 * g.cell);
      // normal.y > 0.84 ⇔ slope² < 1/0.84² − 1.
      if (dx * dx + dz * dz < 0.417) count++;
    }
  }
  return count * g.cell * g.cell;
}

/**
 * Shrink each tuft toward its root with the camera distance (chained after the wind patch; instancing only).
 */
function addDistanceFade(material: THREE.Material): void {
  const wind = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    wind.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      /* glsl */ `#include <begin_vertex>
      #ifdef USE_INSTANCING
      {
        vec3 tuftRoot = ( modelMatrix * vec4( instanceMatrix[ 3 ].xyz, 1.0 ) ).xyz;
        transformed *= 1.0 - smoothstep( ${FADE_NEAR.toFixed(1)}, ${FADE_FAR.toFixed(1)}, distance( tuftRoot, cameraPosition ) );
      }
      #endif`,
    );
  };
  material.customProgramCacheKey = () => "raft-grass-sway-fade";
}

/**
 * Five thin blades around the origin. Vertex colors are a neutral light ramp (dark root → slightly warm sunlit
 * tip); the per-instance color carries the actual grass tone.
 */
function tuftGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const base = [0.5, 0.53, 0.5];
  const tip = [1.12, 1.1, 0.96];
  const blades = [
    [0, 0.32, 0.05],
    [1.3, 0.26, 0.35],
    [2.6, 0.29, -0.3],
    [3.9, 0.22, 0.25],
    [5.1, 0.27, -0.2],
  ];
  for (const [a, h, lean] of blades) {
    const ca = Math.cos(a!);
    const sa = Math.sin(a!);
    const w = 0.045;
    const ox = ca * 0.06;
    const oz = sa * 0.06;
    // Blade as one triangle: two root corners + a leaning tip.
    const px = -sa * w;
    const pz = ca * w;
    pos.push(ox + px, 0, oz + pz, ox - px, 0, oz - pz, ox + ca * lean! * h!, h!, oz + sa * lean! * h!);
    for (let k = 0; k < 3; k++) nor.push(0, 1, 0);
    col.push(base[0]!, base[1]!, base[2]!, base[0]!, base[1]!, base[2]!, tip[0]!, tip[1]!, tip[2]!);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
