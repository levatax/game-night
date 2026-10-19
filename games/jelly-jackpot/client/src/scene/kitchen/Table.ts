// Round kitchen table (top at y = 0, radius TABLE_RADIUS) with a red/white checkered tablecloth whose
// drape has a wavy, ruffled hem, on one chunky pedestal leg standing on the floor (FLOOR_Y).

import * as THREE from "three";
import { TABLE_RADIUS } from "../../../../shared/constants";
import { addOutlines, toon, toonRamp } from "../toon";
import { checkerTexture } from "./textures";

/** Kitchen floor height (matches the physics catch-floor: fallen pieces land here). */
export const FLOOR_Y = -0.8;

export function buildTable(): THREE.Group {
  const g = new THREE.Group();
  g.name = "table";
  const clothMat = new THREE.MeshToonMaterial({ color: "#FFFFFF", gradientMap: toonRamp(), map: checkerTexture(10, 1) });
  const drapeTex = checkerTexture(4, 1);
  drapeTex.wrapS = drapeTex.wrapT = THREE.RepeatWrapping;
  drapeTex.repeat.set(12, 1);
  const drapeMat = new THREE.MeshToonMaterial({ color: "#FFFFFF", gradientMap: toonRamp(), map: drapeTex, side: THREE.DoubleSide });

  // table top slab (hidden under the cloth, gives the outline its thickness)
  const slab = new THREE.Mesh(new THREE.CylinderGeometry(TABLE_RADIUS, TABLE_RADIUS, 0.05, 48), toon("#8A5A3C"));
  slab.position.y = -0.026;
  slab.receiveShadow = true;
  slab.castShadow = true;
  slab.userData.noOutline = true;
  const edge = new THREE.Mesh(new THREE.TorusGeometry(TABLE_RADIUS + 0.02, 0.007, 4, 64), new THREE.MeshBasicMaterial({ color: "#2D2A32" }));
  edge.rotation.x = -Math.PI / 2;
  edge.userData.noOutline = true;

  // cloth top: a disc exactly at y = 0
  const top = new THREE.Mesh(new THREE.CircleGeometry(TABLE_RADIUS + 0.02, 64), clothMat);
  top.rotation.x = -Math.PI / 2;
  top.position.y = 0.001;
  top.receiveShadow = true;
  top.userData.noOutline = true;

  // drape with a wavy hem: open cylinder whose bottom ring flares in and out
  const drapeH = 0.28;
  const segs = 96;
  const drapeGeo = new THREE.CylinderGeometry(TABLE_RADIUS + 0.02, TABLE_RADIUS + 0.09, drapeH, segs, 4, true);
  const pos = drapeGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = (drapeH / 2 - y) / drapeH; // 0 at top, 1 at hem
    const a = Math.atan2(z, x);
    const wave = 1 + Math.sin(a * 14) * 0.035 * k * k;
    pos.setXYZ(i, x * wave, y - Math.max(0, Math.sin(a * 14 + 1)) * 0.03 * k, z * wave);
  }
  drapeGeo.computeVertexNormals();
  const drape = new THREE.Mesh(drapeGeo, drapeMat);
  drape.position.y = -drapeH / 2 + 0.001;
  drape.receiveShadow = true;
  drape.userData.noOutline = true;
  // a hem line in ink so the cloth still reads as a cartoon outline
  const hemGeo = new THREE.TorusGeometry(TABLE_RADIUS + 0.095, 0.008, 4, segs);
  const hemPos = hemGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < hemPos.count; i++) {
    const x = hemPos.getX(i);
    const y = hemPos.getY(i);
    const a = Math.atan2(-y, x); // local -y is world +z after the -90° X rotation
    const wave = 1 + Math.sin(a * 14) * 0.035;
    hemPos.setXYZ(i, x * wave, y * wave, hemPos.getZ(i) - Math.max(0, Math.sin(a * 14 + 1)) * 0.03);
  }
  const hem = new THREE.Mesh(hemGeo, new THREE.MeshBasicMaterial({ color: "#2D2A32" }));
  hem.rotation.x = -Math.PI / 2;
  hem.position.y = -drapeH + 0.002;
  hem.userData.noOutline = true;

  // pedestal leg + foot
  const wood = toon("#6E452D");
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.7, 14), wood);
  leg.position.y = -0.4;
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.08, 20), wood);
  foot.position.y = -0.76;
  leg.castShadow = foot.castShadow = true;
  foot.receiveShadow = true;

  g.add(slab, edge, top, drape, hem, leg, foot);
  addOutlines(g, 1.03);
  return g;
}
