// Bath Time cover: giant rubber duck, soap bar, shampoo bottle. Sized to the exact footprints.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { CoverBox, CoverCylinder } from "../../../../../shared/maps";
import { labelTexture, soapTopTexture } from "../../textures";
import { Baker } from "../Baker";
import { lathe, propMesh, scaleUv, type PropBuild, type PropContext } from "./common";

const DUCK_YELLOW = "#FFD43B";
const DUCK_ORANGE = "#FF8A2E";
const SOAP_COLOR = "#A9EBD3";
const SHAMPOO_COLOR = "#FF8FA3";

/* ============================================================== rubber duck */

/** Built at radius 0.95 / height 1.35 proportions and scaled to the footprint. Faces local +Z. */
export function buildRubberDuck(ctx: PropContext, c: CoverCylinder): PropBuild {
  const sx = c.radius / 0.95;
  const sy = c.height / 1.35;
  const b = new Baker();
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const sphere = (detail = 20) => new THREE.SphereGeometry(1, detail, Math.round(detail * 0.7));

  b.addAt(sphere(28), DUCK_YELLOW, v(0, 0.42, -0.04), null, v(0.82, 0.46, 0.9));
  // Tail flicks up at the back.
  b.addAt(sphere(), DUCK_YELLOW, v(0, 0.72, -0.72), new THREE.Euler(-0.7, 0, 0), v(0.3, 0.16, 0.26));
  // Little wings.
  for (const side of [-1, 1]) {
    b.addAt(sphere(), "#FFC21F", v(side * 0.72, 0.5, -0.08), new THREE.Euler(0.25, 0, side * 0.35), v(0.13, 0.24, 0.42));
  }
  // Head + cheeks.
  b.addAt(sphere(24), DUCK_YELLOW, v(0, 0.96, 0.34), null, v(0.4, 0.39, 0.4));
  for (const side of [-1, 1]) {
    b.addAt(new THREE.CircleGeometry(0.075, 12), "#FF9EB5", v(side * 0.3, 0.88, 0.58), new THREE.Euler(0, side * 0.75, 0));
  }
  // Flat beak: top and bottom halves.
  b.addAt(sphere(), DUCK_ORANGE, v(0, 0.9, 0.72), null, v(0.2, 0.065, 0.2));
  b.addAt(sphere(), "#F26F1E", v(0, 0.84, 0.69), null, v(0.15, 0.045, 0.15));
  // Eyes with a sparkle.
  for (const side of [-1, 1]) {
    b.addAt(sphere(), "#2D2A32", v(side * 0.16, 1.06, 0.66), null, v(0.065, 0.085, 0.05));
    b.addAt(sphere(8), "#FFFFFF", v(side * 0.16 + 0.02, 1.09, 0.7), null, 0.022);
  }
  const mesh = propMesh(ctx, b.build(), ctx.kit.bakedMaterial(), "rubberDuck");
  mesh.scale.set(sx, sy, sx);
  const group = new THREE.Group();
  group.name = "rubberDuck";
  group.add(mesh);
  return { object: group };
}

/* ================================================================ soap bar */

export function buildSoapBar(ctx: PropContext, c: CoverBox): PropBuild {
  const { halfX: hx, halfZ: hz, height: h } = c;
  const bank = ctx.kit.bank;
  const radius = Math.min(0.18, h * 0.32);
  const geo = new RoundedBoxGeometry(hx * 2, h, hz * 2, 4, radius);
  geo.translate(0, h / 2, 0);
  const side = bank.toonColor(SOAP_COLOR);
  const top = bank.toonColor("#FFFFFF", { map: bank.tex(soapTopTexture(SOAP_COLOR)) });
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z.
  const group = new THREE.Group();
  group.name = "soapBar";
  group.add(propMesh(ctx, geo, [side, side, top, side, side, side], "soap"));

  // A few suds clinging to the base corners (inside the footprint, low).
  const suds = new Baker();
  for (let i = 0; i < 7; i++) {
    const corner = i % 4;
    const x = (corner < 2 ? -1 : 1) * (hx - 0.12 - ctx.rng() * 0.25);
    const z = (corner % 2 === 0 ? -1 : 1) * (hz - 0.08 - ctx.rng() * 0.12);
    const r = 0.07 + ctx.rng() * 0.07;
    suds.addAt(new THREE.SphereGeometry(r, 12, 8), "#FFFFFF", new THREE.Vector3(x, r * 0.5, z));
  }
  group.add(propMesh(ctx, suds.build(), ctx.kit.bakedMaterial(), "soapSuds"));
  return { object: group };
}

/* =========================================================== shampoo bottle */

export function buildShampooBottle(ctx: PropContext, c: CoverCylinder): PropBuild {
  const r = c.radius;
  const h = c.height;
  const bank = ctx.kit.bank;
  const group = new THREE.Group();
  group.name = "shampooBottle";
  // Profiles authored for r = 1, h = 1 and scaled.
  const bodyProfile: Array<[number, number]> = [
    [0, 0],
    [0.84, 0],
    [0.96, 0.02],
    [1, 0.07],
    [1, 0.64],
    [0.95, 0.72],
    [0.78, 0.78],
    [0.56, 0.815],
    [0.5, 0.82],
  ];
  const capProfile: Array<[number, number]> = [
    [0.5, 0.8],
    [0.58, 0.81],
    [0.58, 0.95],
    [0.5, 0.99],
    [0.3, 1],
    [0, 1],
  ];
  const scaled = (pts: Array<[number, number]>) => pts.map(([pr, py]) => [pr * r, py * h] as const);
  const body = lathe(scaled(bodyProfile), 28);
  group.add(propMesh(ctx, body, bank.toonColor(SHAMPOO_COLOR), "bottle"));
  const cap = lathe(scaled(capProfile), 24);
  group.add(propMesh(ctx, cap, bank.toonColor("#FFFFFF"), "bottleCap"));

  // Flip-top nozzle nub on the cap (inside the radius and below the top).
  const nub = new THREE.CylinderGeometry(r * 0.12, r * 0.14, h * 0.035, 10);
  nub.translate(r * 0.3, h * 0.985, 0);
  group.add(propMesh(ctx, nub, bank.toonColor("#F2F2F2"), "bottleNub"));

  // Wrap-around label.
  const labelH = h * 0.36;
  const label = scaleUv(new THREE.CylinderGeometry(r * 1.006, r * 1.006, labelH, 32, 1, true), 1, 1);
  label.translate(0, h * 0.18 + labelH / 2, 0);
  const labelMat = bank.toonColor("#FFFFFF", { map: bank.tex(labelTexture("#FFF7E8", "#3FC1C9")) });
  group.add(propMesh(ctx, label, labelMat, "bottleLabel"));
  return { object: group };
}
