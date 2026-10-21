// Kaptan Yengeç, the night-3 boss (game4.md §10/§16): a crab 2.2× the size with one giant fiddler claw, who
// walks head-on (no sideways scuttle), never flips, smashes with the big claw, and wears the captain's cap he
// fished out of the shipwreck, slightly askew. Shares the instanced crab parts; the cap is a regular mesh on
// the shell. Owner: client-characters.

import * as THREE from "three";
import { MONSTERS } from "../../../../shared/constants";
import { getSmoothOutlineGeometry } from "../../render/Toon";
import { alongMatrix, bodyMaterial, cylinderGeo, inkOutline, latheGeo, sphereGeo, torusGeo, trs } from "../kit";
import { type InstancedPool, MONSTER_OUTLINE, PartBaker } from "./common";
import { CrabRig } from "./crab";

/** Boss scale over a regular crab (radius 1.1 vs 0.5). */
export const BOSS_SCALE = MONSTERS.boss.radius / MONSTERS.crab.radius;

let hat: { geometry: THREE.BufferGeometry; outline: THREE.BufferGeometry } | null = null;

/** The wreck's captain cap in shell space (white crown, navy band, black visor, gold anchor badge). */
function hatGeometry(): { geometry: THREE.BufferGeometry; outline: THREE.BufferGeometry } {
  if (hat) return hat;
  const b = new PartBaker()
    .add(cylinderGeo(1.03, 10), "#1F3A68", alongMatrix([0, 0, 0], [0, 0.06, 0], 0.15))
    .add(
      latheGeo(
        "boss-cap",
        [
          [0.15, 0.055],
          [0.19, 0.1],
          [0.2, 0.13],
          [0.16, 0.155],
          [0, 0.16],
        ],
        10,
      ),
      "#F7F7F2",
      trs([0, 0, 0]),
    )
    .put(sphereGeo(8), "#1E2430", [0, 0.005, -0.14], [0.13, 0.016, 0.09], [-0.2, 0, 0])
    .put(sphereGeo(5), "#F2C14E", [0, 0.035, -0.152], [0.03, 0.03, 0.01], [0, 0, 0], false)
    .add(torusGeo(0.08), "#F2C14E", trs([0, 0.032, 0], [0, 0, 0], 0.153), false);
  const baked = b.bake();
  hat = { geometry: baked.geometry, outline: baked.outline ?? baked.geometry };
  return hat;
}

export class BossRig extends CrabRig {
  private readonly hatMesh: THREE.Mesh;

  constructor(id: string, pool: InstancedPool) {
    super(id, "boss", pool, { scale: BOSS_SCALE, boss: true });
    const g = hatGeometry();
    this.hatMesh = new THREE.Mesh(g.geometry, bodyMaterial());
    this.hatMesh.name = "bossCap";
    this.hatMesh.castShadow = true;
    const outline = new THREE.Mesh(getSmoothOutlineGeometry(g.outline), inkOutline(MONSTER_OUTLINE));
    outline.userData.isOutline = true;
    this.hatMesh.add(outline);
    this.hatMesh.position.set(0.02, 0.16, 0.02);
    this.hatMesh.rotation.set(-0.12, 0.25, 0.18);
    this.shell.add(this.hatMesh);
  }

  override dispose(): void {
    this.hatMesh.removeFromParent();
    super.dispose();
  }
}
