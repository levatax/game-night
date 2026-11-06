// Volcanic biome flavor (game4.md §9 "kıpkırmızı gökyüzü"): a slow smoke plume and a glowing crater with
// sparks on each island's highest point; the plume leans with the wind and the glow pulses brighter at night.
// Three draws, volcanic islands only. Owner: client-render.

import * as THREE from "three";
import { ISLAND_RADIUS } from "../../../../shared/constants";
import type { IslandDef } from "../../../../shared/island/types";
import type { MaterialBank } from "../kit/MaterialBank";
import { glowMaterial } from "../Toon";
import { RisingPuffs } from "./particles";

const REACH = ISLAND_RADIUS * 1.5;

export class Volcano {
  readonly group = new THREE.Group();
  private readonly plumes: RisingPuffs[] = [];
  private readonly sparks: RisingPuffs[] = [];
  private readonly glows: THREE.MeshBasicMaterial[] = [];

  constructor(def: IslandDef, bank: MaterialBank) {
    this.group.name = "volcano";
    for (const site of def.sites) {
      const peak = highestPoint(def, site.center.x, site.center.z);
      const plume = new RisingPuffs(bank, { count: 22, x: peak.x, y: peak.y + 0.5, z: peak.z, jitter: 1.2, color: "#3F3A3C", additive: false, rise: 34, spread: 5, size: 420, life: 11, fadeIn: 0.08, drift: 8 });
      plume.points.name = "volcanoPlume";
      const sparks = new RisingPuffs(bank, { count: 18, x: peak.x, y: peak.y + 0.3, z: peak.z, jitter: 0.9, color: "#F07A35", additive: true, rise: 6, spread: 1.6, size: 14, life: 2.4, fadeIn: 0.02, drift: 1 });
      sparks.points.name = "volcanoSparks";
      const glowGeo = bank.geo(new THREE.CircleGeometry(1.4, 12));
      glowGeo.rotateX(-Math.PI / 2);
      const glow = bank.own(glowMaterial(new THREE.Color("#FF4A1F").multiplyScalar(1.8), 0.7).clone());
      const disc = new THREE.Mesh(glowGeo, glow);
      disc.position.set(peak.x, peak.y + 0.15, peak.z);
      disc.renderOrder = 3;
      this.group.add(plume.points, sparks.points, disc);
      this.plumes.push(plume);
      this.sparks.push(sparks);
      this.glows.push(glow);
    }
  }

  update(elapsed: number, dark: number, wind: number, pixelRatio: number): void {
    for (const p of this.plumes) p.update(elapsed, 0.55, pixelRatio, 6 + wind * 14);
    for (const s of this.sparks) s.update(elapsed, 0.5 + dark * 0.5, pixelRatio);
    for (const g of this.glows) g.opacity = (0.35 + dark * 0.5) * (0.85 + Math.sin(elapsed * 1.7) * 0.15);
  }
}

/** Highest grid vertex within reach (1.5 × ISLAND_RADIUS) of the island center (cx, cz). */
function highestPoint(def: IslandDef, cx: number, cz: number): THREE.Vector3 {
  const g = def.grid;
  let best = -Infinity;
  const out = new THREE.Vector3(cx, 0, cz);
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const x = g.originX + c * g.cell;
      const z = g.originZ + r * g.cell;
      if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > REACH * REACH) continue;
      const h = g.heights[r * g.cols + c]!;
      if (h > best) {
        best = h;
        out.set(x, h, z);
      }
    }
  }
  return out;
}
