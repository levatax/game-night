// Worn cosmetics (PlayerView.cosmetic): the pirate hat from a treasure reel (game4.md §8 "Korsan şapkası"). One shared
// set of geometries / materials; each wearer gets a cheap clone. Sized for a head of radius HEAD_R and sat on the
// Tourist's carryTop anchor (just above the head). Owner: client-characters.

import * as THREE from "three";
import { getSmoothOutlineGeometry, toonColor } from "../render/Toon";
import { inkOutline } from "./kit";

/** Head radius the hat is modeled for (Tourist scales it to its own head). */
export const COSMETIC_HEAD_R = 0.22;
const OUTLINE = 0.018;

let pirateHat: THREE.Group | null = null;

function part(geo: THREE.BufferGeometry, color: string, outline = true): THREE.Object3D {
  const mesh = new THREE.Mesh(geo, toonColor(color));
  mesh.castShadow = true;
  if (!outline) return mesh;
  const group = new THREE.Group();
  const hull = new THREE.Mesh(getSmoothOutlineGeometry(geo), inkOutline(OUTLINE));
  group.add(mesh, hull);
  return group;
}

/** Black tricorn with a gold rim and a skull badge, origin at the brim's center. */
function buildPirateHat(): THREE.Group {
  const hat = new THREE.Group();
  hat.name = "pirateHat";
  // Three-cornered brim: a flat 3-sided cylinder, rounded crown on top, gold rim just above the brim.
  const brim = part(new THREE.CylinderGeometry(0.3, 0.3, 0.035, 3), "#2D2A32");
  brim.rotation.y = Math.PI / 6;
  const crown = part(new THREE.CylinderGeometry(0.15, 0.18, 0.15, 10), "#2D2A32");
  crown.position.y = 0.09;
  const rim = part(new THREE.CylinderGeometry(0.185, 0.185, 0.03, 10), "#FFD166", false);
  rim.position.y = 0.03;
  // Skull badge on the front (-Z is forward for tourists).
  const skull = part(new THREE.SphereGeometry(0.045, 8, 6), "#FFF4DC", false);
  skull.position.set(0, 0.1, -0.165);
  const eyeGeo = new THREE.SphereGeometry(0.011, 5, 4);
  const eyeL = part(eyeGeo, "#2D2A32", false);
  eyeL.position.set(-0.016, 0.106, -0.205);
  const eyeR = part(eyeGeo, "#2D2A32", false);
  eyeR.position.set(0.016, 0.106, -0.205);
  hat.add(brim, crown, rim, skull, eyeL, eyeR);
  return hat;
}

/** A new instance of cosmetic `kind` ("" or unknown → null). Shares geometry and materials with every other one. */
export function createCosmetic(kind: string): THREE.Object3D | null {
  if (kind !== "pirate_hat") return null;
  pirateHat ??= buildPirateHat();
  return pirateHat.clone(true);
}
