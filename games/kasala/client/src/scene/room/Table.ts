// The round card table: green felt (#1F6B47 → #134A31 at the rim, gold ring + printed slogan), a padded
// wooden rail with a brass inlay, a chunky pedestal, the card tower plinth in the middle (the Cards module
// stacks the tower on it) and the dealer's side dressing: a brass ashtray with a smoldering cigar (smoke
// wisp) and a whiskey bottle + glass. Static parts merge into a few draw calls (plain colors bake into the
// shared vertex-color toon material).

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { toon } from "../toon";
import { StaticBatch } from "./batch";
import { ASHTRAY_POS as ASHTRAY, BOTTLE_POS as BOTTLE, GLASS_POS as GLASS, PLINTH_H, PLINTH_TOP_Y, TABLE_RADIUS, TABLE_TOP_Y } from "./layout";
import { feltTexture, softDotTexture, woodTexture } from "./textures";

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const eul = (x: number, y: number, z: number) => new THREE.Euler(x, y, z);

const PUFFS = 7;

export class Table {
  readonly group = new THREE.Group();
  /** Cigar ember (Stage dims it in the dark, the glow stays). */
  private ember: THREE.Mesh;
  private puffs: THREE.Sprite[] = [];
  private puffMat: THREE.SpriteMaterial[] = [];
  /** 0..1 smoke brightness (mood). */
  smokeLight = 1;

  constructor() {
    this.group.name = "table";
    const b = new StaticBatch();
    const R = TABLE_RADIUS;
    const top = TABLE_TOP_Y;

    // felt
    const feltMat = toon("#FFFFFF", { map: feltTexture(), unique: true });
    b.addAt(new THREE.CircleGeometry(R + 0.01, 72), feltMat, v3(0, top, 0), eul(-Math.PI / 2, 0, 0));

    // apron + pedestal
    const woodTex = woodTexture(PALETTE.wood, PALETTE.woodDark, 21);
    woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
    woodTex.repeat.set(6, 1);
    const wood = toon("#FFFFFF", { map: woodTex, unique: true });
    const dark = toon(PALETTE.woodDark);
    b.addAt(new THREE.CylinderGeometry(R + 0.04, R - 0.06, 0.13, 72), wood, v3(0, top - 0.07, 0), null, 1, { outline: 1.015, castShadow: true });
    b.addAt(new THREE.CylinderGeometry(0.17, 0.22, 0.58, 16), dark, v3(0, 0.39, 0), null, 1, { outline: 1.05, castShadow: true });
    b.addAt(new THREE.CylinderGeometry(0.3, 0.26, 0.08, 18), wood, v3(0, 0.66, 0), null, 1, { outline: 1.05 });
    b.addAt(new THREE.CylinderGeometry(0.62, 0.7, 0.1, 24), wood, v3(0, 0.05, 0), null, 1, { outline: 1.03, castShadow: true });
    b.addAt(new THREE.SphereGeometry(0.26, 16, 10), dark, v3(0, 0.12, 0), null, new THREE.Vector3(1, 0.5, 1), { outline: 1.05 });

    // rail: padded wood torus with a brass inlay line
    const railTex = woodTexture("#6A3F28", "#3A2116", 31, true);
    railTex.wrapS = railTex.wrapT = THREE.RepeatWrapping;
    railTex.repeat.set(14, 1);
    const rail = toon("#FFFFFF", { map: railTex, unique: true });
    b.addAt(new THREE.TorusGeometry(R + 0.03, 0.08, 10, 96), rail, v3(0, top + 0.02, 0), eul(Math.PI / 2, 0, 0), new THREE.Vector3(1, 1, 0.72), {
      outline: 1.012,
      castShadow: true,
    });
    b.addAt(new THREE.TorusGeometry(R + 0.03, 0.009, 4, 96), toon(PALETTE.gold), v3(0, top + 0.078, 0), eul(Math.PI / 2, 0, 0));
    // dark felt lip under the rail (rim shading)
    b.addAt(new THREE.RingGeometry(R - 0.1, R + 0.01, 72), toon(PALETTE.feltShadow), v3(0, top + 0.002, 0), eul(-Math.PI / 2, 0, 0));

    // deck plinth: wood base + brass top + tiny brass rail
    const brass = toon("#D9A441");
    b.addAt(new THREE.CylinderGeometry(0.2, 0.23, PLINTH_H * 0.55, 28), wood, v3(0, top + (PLINTH_H * 0.55) / 2, 0), null, 1, { outline: 1.04, castShadow: true });
    b.addAt(new THREE.CylinderGeometry(0.155, 0.17, PLINTH_H * 0.45, 28), brass, v3(0, top + PLINTH_H * 0.55 + (PLINTH_H * 0.45) / 2, 0), null, 1, { outline: 1.04 });
    b.addAt(new THREE.TorusGeometry(0.205, 0.012, 6, 32), brass, v3(0, top + PLINTH_H * 0.55, 0), eul(Math.PI / 2, 0, 0));
    b.addAt(new THREE.CircleGeometry(0.13, 28), toon("#8A2A2A"), v3(0, PLINTH_TOP_Y + 0.001, 0), eul(-Math.PI / 2, 0, 0));

    // ashtray + cigar
    b.addAt(new THREE.CylinderGeometry(0.09, 0.08, 0.03, 18), brass, v3(ASHTRAY.x, top + 0.015, ASHTRAY.z), null, 1, { outline: 1.06 });
    b.addAt(new THREE.CylinderGeometry(0.068, 0.068, 0.006, 16), toon("#3A3236"), v3(ASHTRAY.x, top + 0.031, ASHTRAY.z));
    for (const a of [0.4, 2.5, 4.6]) {
      b.addAt(new THREE.BoxGeometry(0.03, 0.012, 0.022), brass, v3(ASHTRAY.x + Math.cos(a) * 0.085, top + 0.034, ASHTRAY.z + Math.sin(a) * 0.085), eul(0, -a, 0));
    }
    const cigarYaw = 0.6;
    const cigarLen = 0.17;
    const cigarDir = new THREE.Vector3(Math.cos(cigarYaw), 0, -Math.sin(cigarYaw));
    const cigarMid = ASHTRAY.clone().addScaledVector(cigarDir, 0.06).setY(top + 0.045);
    b.addAt(new THREE.CylinderGeometry(0.014, 0.014, cigarLen, 8), toon("#6B3E22"), cigarMid, eul(0, cigarYaw, Math.PI / 2 - 0.12), 1, { outline: 1.15 });
    b.addAt(new THREE.CylinderGeometry(0.0155, 0.0155, 0.022, 8), toon("#C3262E"), cigarMid.clone().addScaledVector(cigarDir, 0.035), eul(0, cigarYaw, Math.PI / 2 - 0.12));
    const tip = cigarMid.clone().addScaledVector(cigarDir, -cigarLen / 2).setY(top + 0.035);
    this.ember = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), new THREE.MeshBasicMaterial({ color: "#FF6A2A" }));
    this.ember.position.copy(tip);
    this.group.add(this.ember);

    // whiskey bottle + glass (opaque toon glass with a label, short glass with ice)
    const bottle = toon("#5A2A12");
    b.addAt(new THREE.CylinderGeometry(0.05, 0.055, 0.2, 14), bottle, v3(BOTTLE.x, top + 0.1, BOTTLE.z), null, 1, { outline: 1.06, castShadow: true });
    b.addAt(new THREE.SphereGeometry(0.05, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), bottle, v3(BOTTLE.x, top + 0.2, BOTTLE.z), null, 1, { outline: 1.06 });
    b.addAt(new THREE.CylinderGeometry(0.017, 0.02, 0.09, 8), bottle, v3(BOTTLE.x, top + 0.27, BOTTLE.z), null, 1, { outline: 1.12 });
    b.addAt(new THREE.CylinderGeometry(0.02, 0.02, 0.025, 8), toon(PALETTE.gold), v3(BOTTLE.x, top + 0.32, BOTTLE.z), null, 1, { outline: 1.12 });
    b.addAt(new THREE.CylinderGeometry(0.0565, 0.0565, 0.08, 14, 1, true), toon("#F4E7C6"), v3(BOTTLE.x, top + 0.1, BOTTLE.z));
    b.addAt(new THREE.CylinderGeometry(0.045, 0.04, 0.085, 12), toon("#C9D8E0"), v3(GLASS.x, top + 0.0425, GLASS.z), null, 1, { outline: 1.06 });
    b.addAt(new THREE.CylinderGeometry(0.041, 0.037, 0.05, 12), toon("#C9852E"), v3(GLASS.x, top + 0.035, GLASS.z));
    b.addAt(new THREE.BoxGeometry(0.03, 0.03, 0.03), toon("#E8F4FF"), v3(GLASS.x + 0.01, top + 0.065, GLASS.z), eul(0.4, 0.5, 0.2), 1, { outline: 1.1 });
    b.addAt(new THREE.BoxGeometry(0.026, 0.026, 0.026), toon("#E8F4FF"), v3(GLASS.x - 0.014, top + 0.068, GLASS.z + 0.01), eul(0.2, 1.1, 0.5), 1, { outline: 1.1 });

    this.group.add(b.build("tableStatic"));

    // cigar smoke wisp: a few soft sprites curling up from the ember
    for (let i = 0; i < PUFFS; i++) {
      const mat = new THREE.SpriteMaterial({ map: softDotTexture(), color: PALETTE.smoke, transparent: true, opacity: 0, depthWrite: false, fog: false });
      const s = new THREE.Sprite(mat);
      s.position.copy(tip);
      this.group.add(s);
      this.puffs.push(s);
      this.puffMat.push(mat);
    }
  }

  update(_dt: number, time: number): void {
    const tip = this.ember.position;
    const glow = 0.75 + Math.sin(time * 1.7) * 0.15 + Math.sin(time * 5.3) * 0.1;
    (this.ember.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.35 * glow + 0.1, 0.12 * glow);
    for (let i = 0; i < PUFFS; i++) {
      const p = (time * 0.18 + i / PUFFS) % 1;
      const s = this.puffs[i]!;
      const curl = Math.sin(p * 7 + i * 1.3) * 0.05 * p;
      s.position.set(tip.x + curl + p * 0.06, tip.y + 0.02 + p * 0.75, tip.z + Math.cos(p * 5 + i) * 0.04 * p);
      s.scale.setScalar(0.03 + p * 0.22);
      const a = Math.sin(p * Math.PI) * 0.22 * this.smokeLight;
      this.puffMat[i]!.opacity = a;
      s.visible = a > 0.01;
    }
  }
}
