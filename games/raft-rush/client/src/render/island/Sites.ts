// Per-team landmarks (game4.md §9/§16): the wreck "MS Neşe" with its hull lettering and tourist debris, the
// campfire's stone ring / seating / workbench, the camp chest, the fresh-water spring (pool + glint), the cave
// mouth, and the secret chest — drawn only once a bottle revealed it (WorldFrame.secretShown), lid open once
// looted (TeamView.secretOpened), gold sparkles until then. Everything static is ONE baked mesh + one outline
// mesh for all sites. Owner: client-render.

import * as THREE from "three";
import { heightAt } from "../../../../shared/island/heightfield";
import type { IslandDef } from "../../../../shared/island/types";
import type { ArrayView, TeamView } from "../../../../shared/types";
import { Baker, composeMatrix } from "../kit/Baker";
import type { MaterialBank } from "../kit/MaterialBank";
import { letteringTexture } from "../textures";
import { addOutline, createToonMaterial, vertexColorToon } from "../Toon";
import { gradeVertexColors, groundPalette } from "./flora/palette";
import { bakeCampChest, bakeCampfireBase, yawToward } from "./props/camp";
import { bakeCave, bakeSpring, secretChestGeometries, SPRING_POOL_RADIUS, SPRING_WATER_HEIGHT } from "./props/landmarks";
import { bakeWreck, wreckLetteringGeometry } from "./props/wreck";
import { Sparkles } from "./Sparkles";

const LID_OPEN = 1.9;
/** Grade of the baked landmark mesh (wreck, camp, spring, cave): 1 = source colors. */
const LANDMARK_SATURATION = 0.78;
const LANDMARK_VALUE = 0.94;

interface SecretChest {
  team: number;
  group: THREE.Group;
  lid: THREE.Object3D;
  sparkles: Sparkles;
  open: number;
  shown: number;
}

export class Sites {
  readonly group = new THREE.Group();
  readonly triangles: number;
  private readonly secrets: SecretChest[] = [];
  private readonly springSparkles: Sparkles[] = [];
  private readonly springWater: THREE.Mesh[] = [];

  constructor(def: IslandDef, bank: MaterialBank) {
    this.group.name = "sites";
    const grid = def.grid;
    const ground = (x: number, z: number) => heightAt(grid, x, z);
    const colors = groundPalette(def.biome);
    const statics = new Baker();
    const letterGeos: THREE.BufferGeometry[] = [];
    def.sites.forEach((site, k) => {
      const seed = (def.seed ^ (k * 0x9e37)) >>> 0;
      // Wreck.
      const wy = ground(site.wreck.x, site.wreck.z);
      const wreckM = composeMatrix(new THREE.Vector3(site.wreck.x, wy, site.wreck.z), new THREE.Euler(0, site.wreck.yaw, 0), 1);
      const local = new THREE.Vector3();
      const localGround = (x: number, z: number) => {
        local.set(x, 0, z).applyMatrix4(wreckM);
        return ground(local.x, local.z) - wy;
      };
      const parts = bakeWreck(statics, wreckM, seed, localGround);
      const letters = wreckLetteringGeometry();
      letters.applyMatrix4(new THREE.Matrix4().multiplyMatrices(wreckM, parts.hullMatrix));
      letterGeos.push(letters);
      // Camp.
      bakeCampfireBase(statics, site.campfire, site.chest, ground, seed);
      bakeCampChest(statics, site.chest, site.campfire, ground);
      // Spring + its water and glint.
      const sy = bakeSpring(statics, site.spring, colors.rock, colors.grass, ground, seed);
      this.addSpringWater(site.spring.x, sy, site.spring.z, bank);
      // Cave.
      if (site.cave) bakeCave(statics, site.cave, grid, colors.rock, ground, seed);
      // Secret chest (hidden until revealed).
      this.addSecretChest(k, site.secretChest.x, ground(site.secretChest.x, site.secretChest.z), site.secretChest.z, yawToward(site.secretChest, site.center), bank);
    });

    // The props bake bright source colors (white hull, red funnel, beach chair): pull them toward the calmer
    // island grade while keeping them the brightest, most readable things on the ground.
    const geometry = bank.geo(gradeVertexColors(statics.build(), LANDMARK_SATURATION, LANDMARK_VALUE));
    const mesh = new THREE.Mesh(geometry, vertexColorToon());
    mesh.name = "landmarks";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    for (const o of addOutline(mesh, 0.025)) o.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.triangles = statics.triangles;

    if (letterGeos.length > 0) {
      const merged = bank.geo(mergeSimple(letterGeos));
      const mat = bank.own(createToonMaterial(0xffffff, { map: bank.tex(letteringTexture("MS NEŞE", "#1F3A68", "#FFFFFF", 512, 128)), transparent: true }));
      mat.alphaTest = 0.4;
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -2;
      mat.polygonOffsetUnits = -2;
      mat.side = THREE.DoubleSide;
      const name = new THREE.Mesh(merged, mat);
      name.name = "wreckName";
      name.receiveShadow = true;
      name.matrixAutoUpdate = false;
      this.group.add(name);
    }
  }

  /** Per frame: secret chest reveal / lid, sparkles, spring shimmer. */
  update(dt: number, elapsed: number, secretShown: ReadonlyArray<boolean>, teams: ArrayView<TeamView>): void {
    for (const s of this.secrets) {
      const shown = secretShown[s.team] === true;
      const team = teams[s.team];
      const opened = team ? team.secretOpened : false;
      s.shown += ((shown ? 1 : 0) - s.shown) * Math.min(1, dt * 6);
      s.group.visible = s.shown > 0.02;
      s.group.scale.setScalar(Math.max(0.01, easeOutBack(s.shown)));
      s.open += ((opened ? 1 : 0) - s.open) * Math.min(1, dt * 4);
      s.lid.rotation.x = s.open * LID_OPEN;
      s.sparkles.update(elapsed, s.group.visible ? 1 - s.open : 0);
    }
    // The spring always glints a little; once a bottle marked it on the compass it sparkles hard.
    this.springSparkles.forEach((sp, k) => sp.update(elapsed, teams[k]?.springRevealed ? 1 : 0.55));
    for (const w of this.springWater) {
      const m = w.material as THREE.MeshToonMaterial;
      m.emissiveIntensity = 0.18 + Math.sin(elapsed * 2.1) * 0.05;
    }
  }

  setPixelRatio(ratio: number): void {
    for (const s of this.secrets) s.sparkles.setPixelRatio(ratio);
    for (const s of this.springSparkles) s.setPixelRatio(ratio);
  }

  /* ------------------------------------------------------------------ build */

  private addSpringWater(x: number, y: number, z: number, bank: MaterialBank): void {
    const geo = bank.geo(new THREE.CircleGeometry(SPRING_POOL_RADIUS * 0.98, 16));
    geo.rotateX(-Math.PI / 2);
    const mat = bank.own(createToonMaterial("#6FB4BE", { emissive: "#A9D8DC", emissiveIntensity: 0.18, transparent: true, opacity: 0.85 }));
    const water = new THREE.Mesh(geo, mat);
    water.name = "springWater";
    water.position.set(x, y + SPRING_WATER_HEIGHT, z);
    water.receiveShadow = true;
    water.renderOrder = 2;
    this.group.add(water);
    this.springWater.push(water);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + i;
      const d = SPRING_POOL_RADIUS * (0.25 + (i % 3) * 0.22);
      pts.push(new THREE.Vector3(x + Math.cos(a) * d, y + SPRING_WATER_HEIGHT + 0.05, z + Math.sin(a) * d));
    }
    const sp = new Sparkles(pts, "#EFFFFF", 22, bank);
    this.group.add(sp.object);
    this.springSparkles.push(sp);
  }

  private addSecretChest(team: number, x: number, y: number, z: number, yaw: number, bank: MaterialBank): void {
    const geos = secretChestGeometries();
    const group = new THREE.Group();
    group.name = `secretChest${team}`;
    group.position.set(x, y, z);
    group.rotation.y = yaw;
    const body = new THREE.Mesh(bank.geo(geos.body), vertexColorToon());
    body.castShadow = true;
    body.receiveShadow = true;
    const hinge = new THREE.Group();
    hinge.position.copy(geos.lidPivot);
    const lid = new THREE.Mesh(bank.geo(geos.lid), vertexColorToon());
    lid.castShadow = true;
    hinge.add(lid);
    group.add(body, hinge);
    addOutline(group, 0.025);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 7; i++) pts.push(new THREE.Vector3(Math.cos(i * 1.7) * 0.45, 0.4 + (i % 3) * 0.22, Math.sin(i * 1.7) * 0.35));
    const sparkles = new Sparkles(pts, "#FFD166", 26, bank);
    group.add(sparkles.object);
    group.visible = false;
    this.group.add(group);
    this.secrets.push({ team, group, lid: hinge, sparkles, open: 0, shown: 0 });
  }
}

function easeOutBack(t: number): number {
  const c = 1.70158;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}

/** Merge non-indexed geometries that share position / uv / normal attributes. */
function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const names = ["position", "normal", "uv"] as const;
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const parts: number[] = [];
    let item = 3;
    for (const g of geos) {
      const a = g.getAttribute(name);
      if (!a) continue;
      item = a.itemSize;
      parts.push(...(a.array as Float32Array));
    }
    out.setAttribute(name, new THREE.Float32BufferAttribute(parts, item));
  }
  for (const g of geos) g.dispose();
  out.computeBoundingSphere();
  return out;
}
