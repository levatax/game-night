// Cake Topper cover: striped birthday candles with animated cartoon flames, giant strawberries.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { CoverCylinder } from "../../../../../shared/maps";
import type { Quality } from "../../../app/settings";
import { shadeHex } from "../../../util/color";
import { wobble } from "../../noise";
import { softDotTexture, strawberryTexture, stripeTexture } from "../../textures";
import { Baker } from "../Baker";
import type { Animated } from "../kit";
import { lathe, propMesh, scaleUv, type PropBuild, type PropContext } from "./common";

/** Stripe colors per candle (picked by a stable hash of its position). */
const CANDLE_STRIPES = ["#FF7FB0", "#7CC8FF", "#B7E36A", "#FFC94D"];
/** Flame sits on the wick above the collision top: cosmetic only. */
const WICK_HEIGHT = 0.12;
const FLAME_HEIGHT = 0.42;

/* ================================================================== candle */

export function buildCandle(ctx: PropContext, c: CoverCylinder, index: number): PropBuild {
  const { radius: r, height: h } = c;
  const bank = ctx.kit.bank;
  const stripe = CANDLE_STRIPES[index % CANDLE_STRIPES.length];
  const group = new THREE.Group();
  group.name = "candle";

  // Body: diagonal stripes wrapping around (texture square ≈ circumference, so stripes stay 45°).
  const bodyH = h - 0.06;
  const circumference = Math.PI * 2 * r;
  const body = scaleUv(new THREE.CylinderGeometry(r * 0.96, r, bodyH, 24, 1), 1, bodyH / circumference);
  body.translate(0, bodyH / 2, 0);
  const bodyMat = bank.toonColor("#FFFFFF", { map: bank.tex(stripeTexture("#FFFDF6", stripe, 3, true)) });
  group.add(propMesh(ctx, body, bodyMat, "candleBody"));

  // Melted wax lip and drips down the side.
  const wax = new Baker();
  const waxColor = shadeHex(stripe, 0.55);
  wax.addAt(new THREE.CylinderGeometry(r * 1.0, r * 0.98, 0.07, 24), waxColor, new THREE.Vector3(0, h - 0.035, 0));
  wax.addAt(new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), waxColor, new THREE.Vector3(0, h - 0.01, 0), null, new THREE.Vector3(r * 0.92, 0.01, r * 0.92));
  const drips = 5;
  for (let i = 0; i < drips; i++) {
    const a = (i / drips) * Math.PI * 2 + ctx.rng() * 0.6;
    const len = 0.12 + ctx.rng() * 0.28;
    const dr = 0.045 + ctx.rng() * 0.025;
    const pos = new THREE.Vector3(Math.cos(a) * (r * 0.98 - dr * 0.4), h - 0.05 - len / 2, Math.sin(a) * (r * 0.98 - dr * 0.4));
    wax.addAt(new THREE.CapsuleGeometry(dr, len, 4, 8), waxColor, pos);
  }
  // Wick.
  wax.addAt(new THREE.CylinderGeometry(0.022, 0.028, WICK_HEIGHT, 6), "#3B2E2A", new THREE.Vector3(0, h + WICK_HEIGHT / 2 - 0.02, 0));
  group.add(propMesh(ctx, wax.build(), ctx.kit.bakedMaterial(), "candleWax"));

  const flame = new CandleFlame(ctx, h + WICK_HEIGHT - 0.04, ctx.rng() * 10);
  group.add(flame.object);
  return { object: group, animated: [flame] };
}

/**
 * Cartoon flame: two nested teardrops (orange shell, warm-white core) plus a soft glow sprite.
 * The core's color exceeds 1.0 so High-quality bloom picks it up; without post-FX it clamps to
 * white. The shell stays under the bloom threshold and clamps to orange.
 */
class CandleFlame implements Animated {
  readonly object = new THREE.Group();
  private readonly outer: THREE.Mesh;
  private readonly inner: THREE.Mesh;
  private readonly glow: THREE.Sprite;

  constructor(
    ctx: PropContext,
    baseY: number,
    private readonly phase: number,
  ) {
    const bank = ctx.kit.bank;
    this.object.name = "flame";
    this.object.position.y = baseY;
    const outerMat = bank.own(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 0.45, 0.06), fog: false }));
    const innerMat = bank.own(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.8, 0.9), fog: false }));
    this.outer = new THREE.Mesh(bank.geo(teardrop(0.13, FLAME_HEIGHT)), outerMat);
    this.inner = new THREE.Mesh(bank.geo(teardrop(0.07, FLAME_HEIGHT * 0.6)), innerMat);
    this.inner.position.set(0, 0.02, 0.0);
    this.inner.renderOrder = 1;
    const glowMat = bank.own(
      new THREE.SpriteMaterial({
        map: softDotTexture(),
        color: "#FFC46B",
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    this.glow = new THREE.Sprite(glowMat);
    this.glow.scale.setScalar(1.1);
    this.glow.position.y = FLAME_HEIGHT * 0.4;
    this.object.add(this.glow, this.outer, this.inner);
    this.setQuality(ctx.kit.quality);
  }

  setQuality(quality: Quality): void {
    this.glow.visible = quality !== "low";
  }

  update(_dt: number, elapsed: number): void {
    const t = elapsed * 9 + this.phase;
    const flicker = 1 + wobble(t, 0.3) * 0.12;
    const stretch = 1 + wobble(t * 1.3, 2.1) * 0.1;
    this.outer.scale.set(flicker, stretch, flicker);
    this.inner.scale.set(1 + wobble(t * 1.7, 4) * 0.1, stretch * 1.05, 1);
    // Lean the tip from side to side like a breeze.
    this.object.rotation.z = wobble(elapsed * 2.3 + this.phase, 1) * 0.16;
    this.object.rotation.x = wobble(elapsed * 1.9 + this.phase, 5) * 0.1;
    this.glow.scale.setScalar(1.05 + wobble(t * 0.7, 3) * 0.12);
  }
}

/** Teardrop lathe: round bottom, pointed top, base at y = 0. r(t) ∝ √t·(1−t)^1.2 peaks at t ≈ 0.29. */
function teardrop(radius: number, height: number): THREE.BufferGeometry {
  const peak = Math.sqrt(0.294) * Math.pow(1 - 0.294, 1.2);
  const pts: Array<[number, number]> = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([(radius * Math.sqrt(t) * Math.pow(1 - t, 1.2)) / peak, t * height]);
  }
  return lathe(pts, 10);
}

/* ============================================================== strawberry */

/** Tip-up strawberry on a skirt of leaves, authored for radius 0.8 / height 1.0 and scaled. */
export function buildStrawberry(ctx: PropContext, c: CoverCylinder): PropBuild {
  const bank = ctx.kit.bank;
  const sx = c.radius / 0.8;
  const sy = c.height / 1.0;
  const group = new THREE.Group();
  group.name = "strawberry";
  const profile: Array<[number, number]> = [
    [0, 0],
    [0.5, 0],
    [0.68, 0.06],
    [0.77, 0.19],
    [0.8, 0.34],
    [0.75, 0.52],
    [0.62, 0.69],
    [0.43, 0.85],
    [0.22, 0.96],
    [0.08, 0.995],
    [0, 1],
  ];
  const berry = scaleUv(lathe(profile, 24), 4, 2);
  const berryMat = bank.toonColor("#FFFFFF", { map: bank.tex(strawberryTexture()) });
  const berryMesh = propMesh(ctx, berry, berryMat, "berry");
  berryMesh.scale.set(sx, sy, sx);
  group.add(berryMesh);

  // Leafy calyx skirt lying on the frosting, plus a cartoon shine streak.
  const details = new Baker();
  const leaves = 7;
  for (let i = 0; i < leaves; i++) {
    const a = (i / leaves) * Math.PI * 2 + ctx.rng() * 0.3;
    const leafGeo = leafGeometry(0.42, 0.16);
    const m = new THREE.Matrix4()
      .makeRotationY(-a)
      .multiply(new THREE.Matrix4().makeTranslation(0.36, 0.035, 0))
      .multiply(new THREE.Matrix4().makeRotationZ(0.22));
    details.add(leafGeo, i % 2 === 0 ? "#4CAF50" : "#6CC24A", m, true);
  }
  details.addAt(new THREE.SphereGeometry(1, 12, 8), "#FFFFFF", new THREE.Vector3(-0.42, 0.62, 0.36), new THREE.Euler(0.3, 0.7, 0.5), new THREE.Vector3(0.05, 0.13, 0.03));
  details.addAt(new THREE.SphereGeometry(1, 10, 6), "#FFFFFF", new THREE.Vector3(-0.3, 0.8, 0.3), null, 0.035);
  const detailMesh = propMesh(ctx, details.build(), ctx.kit.bakedMaterial(), "berryLeaves");
  detailMesh.scale.set(sx, sy, sx);
  group.add(detailMesh);
  return { object: group };
}

/** Flat pointed leaf along +X from x = 0 to `length`, slightly cupped, double-sided by two faces. */
function leafGeometry(length: number, width: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(length * 0.45, width, length, 0);
  shape.quadraticCurveTo(length * 0.45, -width, 0, 0);
  const top = new THREE.ShapeGeometry(shape, 4);
  top.rotateX(-Math.PI / 2);
  const bottom = top.clone();
  bottom.rotateX(Math.PI);
  bottom.translate(0, -0.01, 0);
  const merged = mergeGeometries([top, bottom]);
  top.dispose();
  bottom.dispose();
  return merged;
}
