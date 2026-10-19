// The glass cake stand + the birthday cake that lives on it (children of Stage.standGroup, stand-local).
// Physics match: stand plate top at STAND_PLATE_Y (radius STAND_PLATE_RADIUS), cake cylinder radius
// CAKE_RADIUS with its top surface exactly at CAKE_TOP_Y. The decorations (drips, googly face, candles
// poking out of the side like a birthday hedgehog) stay on the sides so the stacking surface is flat.

import * as THREE from "three";
import { CAKE_RADIUS, CAKE_TOP_Y, PALETTE, STAND_PLATE_RADIUS, STAND_PLATE_Y } from "../../../../shared/constants";
import { addOutlines, googlyEyes, jiggleEyes, toon, toonRamp } from "../toon";
import { softDotTexture, stripeTexture } from "./textures";

const SPRINKLE_COLORS = ["#FF5A5F", "#3FA7FF", "#7BE07B", "#FFC23F", "#B07CFF", "#FFFFFF"];
const SLIDE_SEC = 0.8;

interface Candle {
  flame: THREE.Mesh;
  glow: THREE.Sprite;
  seed: number;
}

/** Marks every mesh under `root` so addOutlines skips it. */
export function skipOutlines(root: THREE.Object3D): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.userData.noOutline = true;
  });
}

export class CakeStand {
  /** The glass stand (static in the stand group). */
  readonly stand = new THREE.Group();
  /** The cake (slides in fresh after a topple). */
  readonly cake = new THREE.Group();
  /** Warm candle glow (no shadows). */
  readonly candleLight: THREE.PointLight;

  private candles: Candle[] = [];
  private face = new THREE.Group();
  private slideT = SLIDE_SEC;
  private wobble = 0;

  constructor() {
    this.buildStand();
    this.buildCake();
    this.candleLight = new THREE.PointLight("#FFB25A", 0.25, 1.2, 1.5);
    this.candleLight.position.set(-0.5, CAKE_TOP_Y - 0.02, 0);
    this.cake.add(this.candleLight);
  }

  private buildStand(): void {
    const glass = new THREE.MeshToonMaterial({
      color: "#BFEFFF",
      gradientMap: toonRamp(),
      transparent: true,
      opacity: 0.45,
      emissive: "#3A6A80",
      emissiveIntensity: 0.25,
      depthWrite: false,
    });
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.02, 32), glass);
    foot.position.y = 0.01;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.06, STAND_PLATE_Y - 0.04, 16), glass);
    stem.position.y = 0.02 + (STAND_PLATE_Y - 0.04) / 2;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 10), glass);
    knob.position.y = 0.1;
    knob.scale.y = 0.6;
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(STAND_PLATE_RADIUS, STAND_PLATE_RADIUS - 0.03, 0.02, 48), glass);
    plate.position.y = STAND_PLATE_Y - 0.01;
    plate.renderOrder = 2;
    this.stand.add(foot, stem, knob, plate);

    // cartoon ink rims (glass has no inverted-hull outline) + a shiny highlight arc
    const ink = new THREE.MeshBasicMaterial({ color: PALETTE.ink });
    const rim = (r: number, y: number, tube: number) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 4, 64), ink);
      m.rotation.x = Math.PI / 2;
      m.position.y = y;
      this.stand.add(m);
    };
    rim(STAND_PLATE_RADIUS, STAND_PLATE_Y, 0.006);
    rim(STAND_PLATE_RADIUS - 0.03, STAND_PLATE_Y - 0.02, 0.004);
    rim(0.24, 0.0, 0.005);
    rim(0.2, 0.02, 0.004);
    const shine = new THREE.Mesh(new THREE.TorusGeometry(STAND_PLATE_RADIUS - 0.04, 0.006, 4, 24, Math.PI / 3), new THREE.MeshBasicMaterial({ color: "#FFFFFF" }));
    shine.rotation.x = Math.PI / 2;
    shine.rotation.z = 0.6;
    shine.position.y = STAND_PLATE_Y + 0.001;
    this.stand.add(shine);
    this.stand.traverse((o) => (o.castShadow = (o as THREE.Mesh).isMesh && (o as THREE.Mesh).material === glass));
  }

  private buildCake(): void {
    const R = CAKE_RADIUS;
    const base = STAND_PLATE_Y;
    const frosting = toon(PALETTE.frosting);
    const body = new THREE.Group();

    const spongeH = 0.175;
    const sponge = new THREE.Mesh(new THREE.CylinderGeometry(R, R, spongeH, 40), toon(PALETTE.sponge));
    sponge.position.y = base + spongeH / 2;
    const jam = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.004, R + 0.004, 0.024, 40, 1, true), toon(PALETTE.frostingShadow));
    jam.position.y = base + 0.085;
    const capH = 0.026;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.006, R + 0.006, capH, 40), frosting);
    cap.position.y = CAKE_TOP_Y - capH / 2; // top surface exactly at CAKE_TOP_Y
    const bead = new THREE.Mesh(new THREE.TorusGeometry(R + 0.004, 0.013, 6, 40), frosting);
    bead.rotation.x = Math.PI / 2;
    bead.position.y = CAKE_TOP_Y - 0.009;
    body.add(sponge, jam, cap, bead);

    // frosting drips running down the side
    const dripCount = 18;
    for (let i = 0; i < dripCount; i++) {
      const a = (i / dripCount) * Math.PI * 2 + Math.sin(i * 7.3) * 0.12;
      const len = 0.02 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 0.07;
      const rad = 0.014 + (i % 3) * 0.003;
      const drip = new THREE.Mesh(new THREE.CapsuleGeometry(rad, len, 3, 8), frosting);
      drip.position.set(Math.cos(a) * (R + 0.004), CAKE_TOP_Y - 0.012 - len / 2, Math.sin(a) * (R + 0.004));
      body.add(drip);
    }

    // goofy cake face (front, +z)
    this.face = googlyEyes(0.036, 0.055);
    this.face.position.set(0, base + 0.12, R + 0.022);
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.007, 6, 14, Math.PI), new THREE.MeshBasicMaterial({ color: PALETTE.ink }));
    smile.rotation.z = Math.PI;
    smile.position.set(0, base + 0.07, R + 0.008);
    const cheekMat = toon("#FF7FA8");
    for (const s of [-1, 1]) {
      const cheek = new THREE.Mesh(new THREE.CircleGeometry(0.02, 12), cheekMat);
      cheek.position.set(s * 0.09, base + 0.075, R + 0.003);
      cheek.userData.noOutline = true;
      body.add(cheek);
    }
    body.add(this.face, smile);
    body.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    smile.userData.noOutline = true;
    addOutlines(body, 1.03);

    // sprinkles: flush with the top so pieces still sit on CAKE_TOP_Y
    const sprinkleGeo = new THREE.BoxGeometry(0.02, 0.003, 0.006);
    const sprinkleMat = new THREE.MeshToonMaterial({ gradientMap: toonRamp() });
    const count = 110;
    const sprinkles = new THREE.InstancedMesh(sprinkleGeo, sprinkleMat, count);
    sprinkles.userData.noOutline = true;
    sprinkles.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const r = Math.sqrt(Math.random()) * (R - 0.03);
      const a = Math.random() * Math.PI * 2;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI);
      m.compose(new THREE.Vector3(Math.cos(a) * r, CAKE_TOP_Y + 0.0005, Math.sin(a) * r), q, new THREE.Vector3(1, 1, 1));
      sprinkles.setMatrixAt(i, m);
      sprinkles.setColorAt(i, col.set(SPRINKLE_COLORS[i % SPRINKLE_COLORS.length]!));
    }
    body.add(sprinkles);

    // candles poking out of the back side, tilted outward
    const candleMat = new THREE.MeshToonMaterial({ color: "#FFFFFF", gradientMap: toonRamp(), map: stripeTexture("#FFFFFF", "#3FA7FF", 4) });
    const flameMat = new THREE.MeshBasicMaterial({ color: "#FFB830" });
    const coreMat = new THREE.MeshBasicMaterial({ color: "#FFF6C8" });
    const glowMat = new THREE.SpriteMaterial({ map: softDotTexture(), color: "#FFB25A", transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending });
    const up = new THREE.Vector3(0, 1, 0);
    const candleLen = 0.12;
    for (let i = 0; i < 5; i++) {
      const a = Math.PI * 0.62 + (i / 4) * Math.PI * 0.76; // back half (away from the face)
      const tilt = 0.75 + (i % 2) * 0.25;
      const g = new THREE.Group();
      g.position.set(Math.cos(a) * (R - 0.02), base + 0.14, Math.sin(a) * (R - 0.02));
      const dir = new THREE.Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
      g.quaternion.setFromUnitVectors(up, dir);
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, candleLen, 10), candleMat);
      stick.position.y = candleLen / 2;
      stick.castShadow = true;
      addOutlines(stick, 1.15);
      const wick = new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.002, 0.012, 4), new THREE.MeshBasicMaterial({ color: PALETTE.ink }));
      wick.position.y = candleLen + 0.006;
      // flames always point UP (counter the candle tilt)
      const flamePivot = new THREE.Group();
      flamePivot.position.y = candleLen + 0.012;
      flamePivot.quaternion.copy(g.quaternion).invert();
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.013, 10, 8), flameMat);
      flame.scale.set(1, 2, 1);
      flame.position.y = 0.022;
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 6), coreMat);
      core.position.y = -0.002;
      flame.add(core);
      const glow = new THREE.Sprite(glowMat);
      glow.scale.setScalar(0.12);
      glow.position.y = 0.02;
      flamePivot.add(flame, glow);
      g.add(stick, wick, flamePivot);
      body.add(g);
      this.candles.push({ flame, glow, seed: i * 1.7 + 0.3 });
    }

    this.cake.add(body);
  }

  /** Fresh cake flies in from the side and lands with a jelly squash. */
  slideIn(): void {
    this.slideT = 0;
  }

  update(dt: number, time: number, rattle: number): void {
    // candle flicker
    for (const c of this.candles) {
      const f = 0.85 + Math.sin(time * 17 + c.seed * 5) * 0.08 + Math.sin(time * 31 + c.seed) * 0.06 + (Math.random() - 0.5) * 0.08;
      c.flame.scale.set(1 / f, 2 * f, 1 / f);
      c.flame.rotation.z = Math.sin(time * 9 + c.seed) * 0.15;
      c.glow.scale.setScalar(0.1 + f * 0.03);
    }
    this.candleLight.intensity = 0.22 + Math.sin(time * 13) * 0.04 + Math.random() * 0.03;
    jiggleEyes(this.face, dt, rattle * 4);

    // slide-in animation
    if (this.slideT < SLIDE_SEC) {
      this.slideT = Math.min(SLIDE_SEC, this.slideT + dt);
      const p = this.slideT / SLIDE_SEC;
      const fly = Math.min(1, p / 0.65);
      const ease = 1 - Math.pow(1 - fly, 3);
      this.cake.position.set((1 - ease) * -1.8, Math.sin(fly * Math.PI) * 0.35, 0);
      this.cake.rotation.z = (1 - ease) * 0.6;
      if (p >= 0.65 && this.wobble === 0) this.wobble = 1;
      if (p >= 1) this.cake.position.set(0, 0, 0);
    }
    if (this.wobble > 0) {
      this.wobble = Math.max(0, this.wobble - dt * 1.6);
      const w = Math.sin((1 - this.wobble) * 22) * this.wobble * 0.22;
      this.cake.scale.set(1 + w * 0.5, 1 - w, 1 + w * 0.5);
      if (this.wobble === 0) this.cake.scale.set(1, 1, 1);
    }
  }
}
