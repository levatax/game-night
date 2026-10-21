// Everything one island scene draws, built from an IslandDef and driven every frame by the WorldFrame: terrain
// chunks, the sea, flora (batched) + grass, landmarks (wreck, camp, spring, cave, secret chests), campfires,
// rafts, placed structures, fireflies and (volcanic) the smoking peak. All GPU resources go through one
// MaterialBank so Renderer.loadIsland can release the whole island at once. Owner: client-render.

import * as THREE from "three";
import { FIRE_START_FUEL_TICKS } from "../../../../shared/constants";
import type { IslandDef } from "../../../../shared/island/types";
import type { Quality } from "../../app/settings";
import { MaterialBank } from "../kit/MaterialBank";
import { QUALITY_PROFILES, scaledCount } from "../quality";
import type { Lighting } from "../sky/DayNight";
import type { WorldFrame } from "../types";
import { Campfire, type LightRequest } from "./Campfire";
import { Fireflies } from "./Fireflies";
import { Flora } from "./Flora";
import { Grass } from "./Grass";
import { Raft, type RaftPose } from "./Raft";
import { Sites } from "./Sites";
import { Structures } from "./Structures";
import { Terrain } from "./Terrain";
import { Volcano } from "./Volcano";
import { Water } from "./Water";

const FIREFLIES = 90;

export class IslandView {
  readonly group = new THREE.Group();
  readonly def: IslandDef;
  /** Static triangles at full growth (terrain + water + flora + grass + landmarks), for the budget readout. */
  readonly triangles: number;
  private readonly bank = new MaterialBank();
  private readonly terrain: Terrain;
  private readonly water: Water;
  private readonly flora: Flora;
  private readonly grass: Grass;
  private readonly sites: Sites;
  private readonly campfires: Campfire[];
  private readonly rafts: Raft[];
  private readonly structures: Structures;
  private readonly fireflies: Fireflies;
  private readonly volcano: Volcano | null;
  private readonly requests: LightRequest[] = [];

  constructor(def: IslandDef, quality: Quality) {
    this.def = def;
    this.group.name = `island-${def.seed}`;
    const terrain = new Terrain(def, this.bank);
    this.terrain = terrain;
    this.water = new Water(def.grid, def.fishSpots, this.bank);
    this.flora = new Flora(def, this.bank);
    this.grass = new Grass(def, this.bank, QUALITY_PROFILES.high.grassTufts);
    this.sites = new Sites(def, this.bank);
    this.campfires = def.sites.map((s) => new Campfire(def.grid, s.campfire, this.bank));
    this.rafts = def.sites.map((s) => new Raft(def.grid, s, this.bank));
    this.structures = new Structures(def.grid, this.bank);
    this.fireflies = new Fireflies(def, FIREFLIES * (def.layout === "duel" ? 2 : 1), this.bank);
    this.volcano = def.biome === "volcanic" ? new Volcano(def, this.bank) : null;
    this.group.add(terrain.group, this.water.mesh, this.flora.mesh, this.grass.mesh, this.sites.group, this.structures.group, this.fireflies.points);
    for (const c of this.campfires) this.group.add(c.group);
    for (const r of this.rafts) this.group.add(r.group);
    if (this.volcano) this.group.add(this.volcano.group);
    this.setQuality(quality);
    this.triangles = terrain.triangles + 4608 + this.flora.triangles + this.grass.triangles + this.sites.triangles;
  }

  /** Grass density and other decorative counts for a tier (no rebuild). */
  setQuality(quality: Quality): void {
    const full = QUALITY_PROFILES.high.grassTufts;
    this.grass.setFraction(scaledCount(QUALITY_PROFILES[quality].grassTufts, quality) / full);
    this.terrain.setCastShadow(quality === "high");
  }

  /** Per frame. `eye` is the camera position (water follow, light priority). */
  update(dt: number, elapsed: number, world: WorldFrame, light: Lighting, eye: THREE.Vector3, pixelRatio: number): void {
    this.water.update(elapsed, light, eye);
    this.flora.update(dt, elapsed, world.nodes, light.wind, world.focus);
    this.grass.update(elapsed, light.wind);
    this.sites.update(dt, elapsed, world.secretShown, world.teams);
    this.sites.setPixelRatio(pixelRatio);
    this.campfires.forEach((c, i) => {
      const team = world.teams[i];
      // No team yet (lobby preview): a freshly lit fire.
      c.update(dt, elapsed, team ? team.fireFuel : FIRE_START_FUEL_TICKS, light.dark, light.rain, pixelRatio);
    });
    this.rafts.forEach((r, i) => r.update(dt, elapsed, world.teams[i], world.timings, world.launch, light.waveAmp, pixelRatio));
    this.structures.update(dt, elapsed, world.structures, light.dark);
    this.fireflies.update(elapsed, light.fireflies, pixelRatio);
    this.volcano?.update(elapsed, light.dark, light.wind, pixelRatio);
  }

  /** Campfires + planted torches wanting a pool light this frame. */
  lightRequests(): ReadonlyArray<LightRequest> {
    this.requests.length = 0;
    for (const c of this.campfires) this.requests.push(c.light);
    for (const l of this.structures.lights()) this.requests.push(l);
    return this.requests;
  }

  raftPose(team: number): Readonly<RaftPose> | null {
    const raft = this.rafts.find((r) => r.team === team);
    return raft ? raft.getPose() : null;
  }

  /** Every material the island created (shadow toggles force a recompile). */
  materials(): THREE.Material[] {
    return this.bank.allMaterials();
  }

  dispose(): void {
    this.group.removeFromParent();
    const outlineGeos = new Set<THREE.BufferGeometry>();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      // Inverted-hull outline geometries are derived (and cached) per island geometry: free them too.
      if (mesh.isMesh && (o.userData.isOutline || o.name === "outline")) outlineGeos.add(mesh.geometry);
      if ((o as unknown as { isBatchedMesh?: boolean }).isBatchedMesh || (o as THREE.InstancedMesh).isInstancedMesh) {
        (o as unknown as { dispose(): void }).dispose();
      }
    });
    for (const g of outlineGeos) g.dispose();
    this.bank.dispose();
  }
}
