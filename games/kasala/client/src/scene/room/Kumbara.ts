// Patronun Kumbarası: a see-through glass piggy bank at the table edge. The glass is a tiny fresnel shader
// (clear in the middle, bright cyan-white rim + a fixed specular streak) so it reads as glass without a
// transmission pass. Inside, a gold coin mass is clipped at the fill height (local clipping planes) with a
// coin-pile disc on top; the fill eases toward setAmount(). pulse("in"): squash-and-stretch gulp + coins
// dropping into the slot. pulse("burst"): the glass vanishes (Fx throws the shards), the coins are gone,
// then the pig re-forms with an elastic pop. A tent card in front reads "PATRONUN KUMBARASI".

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PALETTE } from "../../../../shared/constants";
import { toon } from "../toon";
import { StaticBatch } from "./batch";
import { KUMBARA_BASE } from "./layout";
import { coinPileTexture, kumbaraTagTexture } from "./textures";

const RX = 0.16;
const RY = 0.145;
const RZ = 0.2;
const LEG_H = 0.045;
const CY = LEG_H + RY * 0.96;
const FILL_K = 0.9;
const YAW = 0.95;
const DROPS = 3;

const glassVert = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
#include <clipping_planes_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`;

const glassFrag = /* glsl */ `
uniform vec3 tint;
uniform vec3 rimColor;
uniform float opacity;
varying vec3 vN;
varying vec3 vV;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(vV);
  float f = 1.0 - abs(dot(n, v));
  float rim = pow(f, 2.4);
  vec3 l = normalize(vec3(-0.35, 0.8, 0.5));
  float spec = pow(max(dot(reflect(-l, n), v), 0.0), 60.0);
  vec3 col = mix(tint, rimColor, rim) + vec3(spec);
  float a = opacity * (0.12 + 0.8 * rim) + spec * 0.9;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}`;

export class Kumbara {
  readonly group = new THREE.Group();
  private pig = new THREE.Group();
  private glassMat: THREE.ShaderMaterial;
  private fill: THREE.Mesh;
  private fillTop: THREE.Mesh;
  private clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private amount = 0;
  private level = 0;
  private shownLevel = 0;
  private squash = 0;
  private squashVel = 0;
  private burstT = -1;
  private popScale = 1;
  private drops: THREE.Mesh[] = [];
  /** Seconds since each drop started (negative = waiting, NaN = idle). */
  private dropT: number[] = [];
  private slot = new THREE.Vector3(0, CY + RY + 0.02, -0.02);
  private tmp = new THREE.Vector3();

  constructor() {
    this.group.name = "kumbara";
    this.group.position.copy(KUMBARA_BASE);
    this.group.add(this.pig);
    this.pig.rotation.y = YAW;

    this.glassMat = new THREE.ShaderMaterial({
      uniforms: {
        tint: { value: new THREE.Color("#BFEFFF") },
        rimColor: { value: new THREE.Color("#F2FCFF") },
        opacity: { value: 0.55 },
      },
      vertexShader: glassVert,
      fragmentShader: glassFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // glass parts merged into one geometry
    const parts: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]) => {
      const m = new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(...scale));
      const ng = (g.index ? g.toNonIndexed() : g).applyMatrix4(m);
      for (const k of Object.keys(ng.attributes)) if (k !== "position" && k !== "normal") ng.deleteAttribute(k);
      parts.push(ng);
    };
    add(new THREE.SphereGeometry(1, 28, 18), [0, CY, 0], [0, 0, 0], [RX, RY, RZ]);
    add(new THREE.CylinderGeometry(0.058, 0.062, 0.07, 20), [0, CY - 0.01, RZ - 0.005], [Math.PI / 2, 0, 0]);
    for (const s of [-1, 1]) {
      add(new THREE.ConeGeometry(0.045, 0.07, 10), [s * 0.08, CY + RY * 0.82, 0.09], [-0.3, 0, -s * 0.35]);
      for (const z of [-0.1, 0.1]) add(new THREE.CylinderGeometry(0.033, 0.03, LEG_H + 0.03, 12), [s * 0.085, (LEG_H + 0.03) / 2, z]);
    }
    add(new THREE.TorusGeometry(0.03, 0.009, 6, 14, Math.PI * 1.5), [0, CY + 0.03, -RZ - 0.02], [0, Math.PI / 2, 0]);
    const glassGeo = mergeGeometries(parts, false)!;
    const glass = new THREE.Mesh(glassGeo, this.glassMat);
    glass.renderOrder = 7;
    glass.userData.noOutline = true;

    // opaque bits seen through / on the glass: eyes, nostrils, coin slot (one batch in pig space)
    const ink = toon(PALETTE.ink);
    const shineMat = new THREE.MeshBasicMaterial({ color: "#FFFFFF" });
    const bitsSrc = new THREE.Group();
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), ink);
      eye.position.set(s * 0.06, CY + 0.05, RZ * 0.86);
      const nostril = new THREE.Mesh(new THREE.CircleGeometry(0.011, 10), ink);
      nostril.position.set(s * 0.02, CY - 0.01, RZ + 0.032);
      nostril.userData.noOutline = true;
      const shine = new THREE.Mesh(new THREE.SphereGeometry(0.005, 6, 4), shineMat);
      shine.position.set(0.005, 0.006, 0.01);
      shine.userData.noOutline = true;
      eye.add(shine);
      bitsSrc.add(eye, nostril);
    }
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.012, 0.016), ink);
    slot.position.copy(this.slot).setY(CY + RY - 0.004);
    slot.userData.noOutline = true;
    bitsSrc.add(slot);
    const bitsBatch = new StaticBatch();
    bitsBatch.addObject(bitsSrc, { outline: 1.15 });
    const bits = bitsBatch.build("kumbaraBits");

    // coin fill (clipped ellipsoid) + coin pile top
    const gold = toon(PALETTE.gold, { emissive: "#5A3A00", emissiveIntensity: 0.35, unique: true });
    gold.clippingPlanes = [this.clip];
    this.fill = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), gold);
    this.fill.scale.set(RX * FILL_K, RY * FILL_K, RZ * FILL_K);
    this.fill.position.y = CY;
    const topTex = coinPileTexture();
    this.fillTop = new THREE.Mesh(new THREE.CircleGeometry(1, 28), toon("#FFFFFF", { map: topTex, emissive: "#3A2600", emissiveIntensity: 0.4, unique: true }));
    this.fillTop.rotation.x = -Math.PI / 2;
    this.fillTop.userData.noOutline = true;

    // coins that drop into the slot on pulse("in")
    const coinGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.006, 14);
    const coinMat = toon(PALETTE.gold, { emissive: "#6A4A00", emissiveIntensity: 0.5 });
    for (let i = 0; i < DROPS; i++) {
      const c = new THREE.Mesh(coinGeo, coinMat);
      c.visible = false;
      this.drops.push(c);
      this.dropT.push(NaN);
      this.pig.add(c);
    }

    this.pig.add(this.fill, this.fillTop, bits, glass);

    // tent card in front of the pig
    const tag = new THREE.Group();
    tag.position.set(0.2, 0, 0.2);
    tag.rotation.y = 0.35;
    const tagTex = kumbaraTagTexture();
    const cardMat = toon("#FFFFFF", { map: tagTex, unique: true });
    for (const s of [1, -1]) {
      const card = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.087), cardMat);
      const tilt = 0.32;
      card.rotation.set(-s * tilt, s > 0 ? 0 : Math.PI, 0);
      card.position.set(0, 0.087 / 2 * Math.cos(tilt) - 0.002, s * Math.sin(tilt) * 0.087 / 2);
      card.userData.noOutline = true;
      tag.add(card);
    }
    const tagBatch = new StaticBatch();
    tagBatch.addObject(tag);
    const tagMesh = tagBatch.build("kumbaraTag");
    tagMesh.position.copy(tag.position);
    tagMesh.rotation.copy(tag.rotation);
    this.group.add(tagMesh);
  }

  setAmount(amount: number): void {
    this.amount = Math.max(0, amount);
    // log-ish fill: 100$ ≈ 0.2, 500$ ≈ 0.6, 2000$ ≈ 0.95
    this.level = this.amount <= 0 ? 0 : Math.min(0.97, 0.06 + 0.91 * (1 - Math.exp(-this.amount / 520)));
  }

  pulse(kind: "in" | "burst"): void {
    if (kind === "in") {
      this.squashVel += 6;
      for (let i = 0; i < DROPS; i++) this.dropT[i] = -i * 0.12;
      return;
    }
    this.burstT = 0;
    this.shownLevel = 0;
    this.popScale = 0;
  }

  /** World center of the glass belly (for Fx). */
  center(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, CY, 0).applyMatrix4(this.pig.matrixWorld);
  }

  update(dt: number, time: number): void {
    // burst → wait → elastic re-form
    if (this.burstT >= 0) {
      this.burstT += dt;
      if (this.burstT < 1.3) this.popScale = 0;
      else {
        const t = Math.min(1, (this.burstT - 1.3) / 0.7);
        this.popScale = 1 - Math.pow(2, -10 * t) * Math.cos(t * 12);
        if (t >= 1) {
          this.burstT = -1;
          this.popScale = 1;
        }
      }
    }
    // squash spring
    this.squashVel += (-this.squash * 180 - this.squashVel * 9) * dt;
    this.squash += this.squashVel * dt;
    const s = this.squash * 0.08;
    const idle = Math.sin(time * 1.3) * 0.006;
    this.pig.scale.set((1 + s + idle) * this.popScale, (1 - s * 1.2 - idle) * this.popScale, (1 + s + idle) * this.popScale);
    this.pig.visible = this.popScale > 0.01;

    // fill level eases toward the amount (not while shattered)
    if (this.burstT < 0 || this.burstT > 1.3) this.shownLevel += (this.level - this.shownLevel) * (1 - Math.exp(-2.2 * dt));
    const ry = RY * FILL_K;
    const localY = -ry + this.shownLevel * 2 * ry; // relative to the belly center
    this.fill.visible = this.shownLevel > 0.005;
    this.fillTop.visible = this.fill.visible && this.shownLevel < 0.995;
    const k = Math.sqrt(Math.max(0, 1 - (localY / ry) ** 2));
    this.fillTop.position.set(0, CY + localY, 0);
    this.fillTop.scale.set(RX * FILL_K * k, RZ * FILL_K * k, 1);
    // world clip plane at the fill height (kept in sync with squash / pop)
    this.pig.updateWorldMatrix(true, false);
    this.tmp.set(0, CY + localY, 0).applyMatrix4(this.pig.matrixWorld);
    this.clip.constant = this.tmp.y;

    // dropping coins
    for (let i = 0; i < DROPS; i++) {
      const c = this.drops[i]!;
      if (Number.isNaN(this.dropT[i]!)) continue;
      this.dropT[i] = this.dropT[i]! + dt;
      const t = this.dropT[i]!;
      if (t < 0) continue;
      const p = t / 0.32;
      if (p >= 1) {
        c.visible = false;
        this.dropT[i] = NaN;
        if (i === DROPS - 1) this.squashVel += 2.5;
        continue;
      }
      c.visible = true;
      c.position.set(this.slot.x, this.slot.y + 0.28 * (1 - p * p), this.slot.z);
      c.rotation.set(Math.PI / 2, 0, t * 20);
    }
  }
}
