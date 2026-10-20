// Picnic Plateau cover: picnic table with benches, giant watermelon slice, wicker basket.
// Each builder fills its exact collision footprint (box halfX/halfZ/height or cylinder radius/height).

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { PALETTE } from "../../../../../shared/constants";
import type { CoverBox, CoverCylinder } from "../../../../../shared/maps";
import { checkerTexture, melonSliceTexture, wickerTexture, woodTexture } from "../../textures";
import { propMesh, scaleUv, type PropBuild, type PropContext } from "./common";

/* ============================================================ picnic table */

/** Wood texture metres per repeat (its 6 planks are ~0.17 m each). */
const WOOD_METERS = 1.0;

export function buildPicnicTable(ctx: PropContext, c: CoverBox): PropBuild {
  const { halfX: hx, halfZ: hz, height: h } = c;
  const bank = ctx.kit.bank;
  const group = new THREE.Group();
  group.name = "picnicTable";
  const wood = bank.toonColor("#FFFFFF", { map: bank.tex(woodTexture()) });
  const dark = bank.toonColor(PALETTE.woodDark, { flatShading: true });

  const topDepth = hz * 1.24;
  const topThick = 0.09;
  const plankCount = 4;
  const benchDepth = 0.3;
  const benchTop = h * 0.53;
  const benchZ = hz - benchDepth / 2;

  // Tabletop + benches as separate planks (small gaps read as wood at any distance).
  const planks: THREE.BufferGeometry[] = [];
  const plankW = topDepth / plankCount;
  for (let i = 0; i < plankCount; i++) {
    const z = -topDepth / 2 + plankW * (i + 0.5);
    planks.push(plank(hx * 2, topThick, plankW - 0.025, 0, h - topThick / 2, z));
  }
  for (const side of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const w = benchDepth / 2;
      const z = side * (benchZ - benchDepth / 4 + w * i);
      planks.push(plank(hx * 1.9, 0.07, w - 0.02, 0, benchTop - 0.035, z));
    }
  }
  group.add(propMesh(ctx, mergeGeometries(planks), wood, "tablePlanks"));
  for (const g of planks) g.dispose();

  // A-frame legs at both ends + a beam under the benches.
  const legs: THREE.BufferGeometry[] = [];
  const legX = hx - 0.32;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const footZ = sz * (hz - 0.08);
      const topZ = sz * topDepth * 0.22;
      const len = Math.hypot(footZ - topZ, h - topThick);
      const leg = new THREE.BoxGeometry(0.11, len, 0.11);
      leg.rotateX(-Math.atan2(footZ - topZ, h - topThick));
      leg.translate(sx * legX, (h - topThick) / 2, (footZ + topZ) / 2);
      legs.push(leg);
    }
    const beam = new THREE.BoxGeometry(0.1, 0.09, hz * 2 - 0.04);
    beam.translate(sx * legX, benchTop - 0.11, 0);
    legs.push(beam);
  }
  const brace = new THREE.BoxGeometry(hx * 2 - 0.7, 0.08, 0.08);
  brace.translate(0, h - topThick - 0.12, 0);
  legs.push(brace);
  group.add(propMesh(ctx, mergeGeometries(legs), dark, "tableLegs"));
  for (const g of legs) g.dispose();

  // Gingham runner down the middle of the tabletop.
  const runnerW = topDepth * 0.42;
  const runnerL = hx * 2 * 0.9;
  const runner = scaleUv(new THREE.PlaneGeometry(runnerL, runnerW), runnerL / 0.9, runnerW / 0.9);
  runner.rotateX(-Math.PI / 2);
  runner.translate(0, h + 0.004, 0);
  const cloth = bank.toonColor("#FFFFFF", { map: bank.tex(checkerTexture("#E8505B", "#FFF6EE", 8)) });
  group.add(propMesh(ctx, runner, cloth, "tableRunner"));
  return { object: group };
}

function plank(len: number, thick: number, width: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(len, thick, width);
  // Planks run along X; the texture's planks run along u, so map u to length.
  scaleUv(g, len / WOOD_METERS, width / WOOD_METERS);
  g.translate(x, y, z);
  return g;
}

/* ============================================================== watermelon */

const MELON_EXPONENT = 3;

/**
 * Giant watermelon slice standing on its cut edge. The outline is a superellipse half-disc
 * (exponent 3) so the slice fills most of its box footprint while still reading as a slice.
 */
export function buildWatermelon(ctx: PropContext, c: CoverBox): PropBuild {
  const { halfX: hx, halfZ: hz, height: h } = c;
  const bank = ctx.kit.bank;
  const bevel = 0.07;
  const a = hx - bevel;
  const b = h - 2 * bevel;
  const shape = new THREE.Shape();
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI;
    const cs = Math.cos(t);
    const sn = Math.sin(t);
    const x = Math.sign(cs) * Math.pow(Math.abs(cs), 2 / MELON_EXPONENT) * a;
    const y = bevel + Math.pow(Math.abs(sn), 2 / MELON_EXPONENT) * b;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.lineTo(-a, bevel);
  shape.lineTo(a, bevel);
  const depth = hz * 2 - bevel * 2;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 1,
  });
  geo.translate(0, 0, -depth / 2);
  remapCapUvs(geo, a, bevel, b);
  const face = bank.toonColor("#FFFFFF", { map: bank.tex(melonSliceTexture(MELON_EXPONENT)) });
  const rind = bank.toonColor("#3E9E4A");
  const group = new THREE.Group();
  group.name = "watermelon";
  group.add(propMesh(ctx, geo, [face, rind], "melonSlice"));
  return { object: group };
}

/**
 * Caps (group 0) get UVs spanning the un-bevelled outline (x: -a..a, y: y0..y0+b) so the painted
 * rind bands line up with the edge; the bevel itself uses the rind material.
 */
function remapCapUvs(geo: THREE.BufferGeometry, a: number, y0: number, b: number): void {
  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");
  const caps = geo.groups.find((g) => g.materialIndex === 0);
  if (!caps) return;
  const index = geo.index;
  for (let i = caps.start; i < caps.start + caps.count; i++) {
    const v = index ? index.getX(i) : i;
    uv.setXY(v, (pos.getX(v) + a) / (a * 2), (pos.getY(v) - y0) / b);
  }
  uv.needsUpdate = true;
}

/* ================================================================== basket */

export function buildBasket(ctx: PropContext, c: CoverCylinder): PropBuild {
  const { radius: r, height: h } = c;
  const bank = ctx.kit.bank;
  const group = new THREE.Group();
  group.name = "basket";
  const wicker = bank.toonColor("#FFFFFF", { map: bank.tex(wickerTexture()) });
  const rimMat = bank.toonColor("#9A6638", { flatShading: true });
  const cloth = bank.toonColor("#FFFFFF", { map: bank.tex(checkerTexture("#E8505B", "#FFF6EE", 8)) });

  const bodyH = h * 0.72;
  const circumference = Math.PI * 2 * r;
  const body = scaleUv(new THREE.CylinderGeometry(r * 0.97, r * 0.86, bodyH, 28, 1), circumference / 0.7, bodyH / 0.7);
  body.translate(0, bodyH / 2, 0);
  group.add(propMesh(ctx, body, wicker, "basketBody"));

  const clothH = h * 0.12;
  const clothGeo = scaleUv(new THREE.CylinderGeometry(r, r * 0.98, clothH, 28, 1, true), circumference / 0.6, clothH / 0.6);
  clothGeo.translate(0, bodyH + clothH / 2 - 0.02, 0);
  group.add(propMesh(ctx, clothGeo, cloth, "basketCloth"));

  const lidH = h * 0.11;
  const lidY = bodyH + clothH - 0.02;
  const lid = scaleUv(new THREE.CylinderGeometry(r * 0.98, r, lidH, 28, 1), circumference / 0.7, lidH / 0.7);
  lid.translate(0, lidY + lidH / 2, 0);
  group.add(propMesh(ctx, lid, wicker, "basketLid"));

  const rims: THREE.BufferGeometry[] = [];
  for (const [y, rr] of [
    [0.05, r * 0.87],
    [bodyH, r * 0.97],
    [lidY + lidH, r * 0.97],
  ] as const) {
    const ring = new THREE.TorusGeometry(rr, 0.035, 6, 32);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, y, 0);
    rims.push(ring);
  }
  // Handle folded flat across the lid, so the silhouette stays inside the collision height.
  const tube = Math.min(0.04, (h - lidY - lidH) / 2);
  const handle = new THREE.TorusGeometry(r * 0.62, tube, 6, 18, Math.PI);
  handle.rotateX(-Math.PI / 2);
  handle.translate(0, h - tube, 0);
  rims.push(handle);
  for (const sx of [-1, 1]) {
    const hinge = new THREE.CylinderGeometry(0.06, 0.06, 0.05, 8);
    hinge.translate(sx * r * 0.62, h - tube, 0);
    rims.push(hinge);
  }
  group.add(propMesh(ctx, mergeGeometries(rims), rimMat, "basketRims"));
  for (const g of rims) g.dispose();
  return { object: group };
}
