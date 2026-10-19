// Hanging polka-dot lamp over the table: the scene's ONE shadow-casting light (a warm SpotLight inside
// the shade). It sways lazily on its cord (so the shadows sway too), swings harder in quakes, and a
// rubber duck rides on top of the shade. Jackpot mode strobes it gold/pink/white.

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { addOutlines, toon, toonRamp } from "../toon";
import { CEILING_Y } from "./Room";
import { polkaTexture } from "./textures";

const SHADE_Y = 2.0;
const STROBE = ["#FFD700", "#FF8BD1", "#FFFFFF", "#FFB830"];

export class Lamp {
  readonly group = new THREE.Group();
  readonly spot: THREE.SpotLight;
  private bulbMat = new THREE.MeshBasicMaterial({ color: "#FFF1C8" });
  private baseColor = new THREE.Color(PALETTE.lamp);
  private baseIntensity = 4.5;
  private gold = new THREE.Color(STROBE[0]);
  private swingVel = 0;
  private swing = 0;
  private duck = new THREE.Group();
  reducedFlashing = false;

  constructor() {
    // pivot at the ceiling
    this.group.position.set(0, CEILING_Y, 0);
    const cordLen = CEILING_Y - SHADE_Y;
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, cordLen, 5), toon(PALETTE.ink));
    cord.position.y = -cordLen / 2;
    const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.04, 10), toon("#F2E8D5"));
    rose.position.y = -0.02;
    const shadeMat = new THREE.MeshToonMaterial({ color: "#FFFFFF", map: polkaTexture("#FFC23F", "#FF5A5F", 3), gradientMap: toonRamp(), side: THREE.DoubleSide });
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.36, 0.28, 20, 1, true), shadeMat);
    shade.position.y = -cordLen;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 16), toon("#FFC23F"));
    cap.position.y = -cordLen + 0.14;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), this.bulbMat);
    bulb.position.y = -cordLen - 0.06;
    bulb.userData.noOutline = true;
    // ink rim on the shade bottom (open cylinder → no hull outline)
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.008, 4, 32), new THREE.MeshBasicMaterial({ color: PALETTE.ink }));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -cordLen - 0.14;
    shade.userData.noOutline = true;
    rim.userData.noOutline = true;

    // rubber duck sitting on the shade like it owns the place
    this.duck.position.set(0.05, -cordLen + 0.2, 0);
    const yellow = toon("#FFD84A");
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), yellow);
    body.scale.set(1.25, 0.85, 1);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), yellow);
    head.position.set(0.06, 0.07, 0);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.05, 6), toon("#FF9F43"));
    beak.rotation.z = -Math.PI / 2;
    beak.position.set(0.11, 0.065, 0);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.008, 6, 4), new THREE.MeshBasicMaterial({ color: PALETTE.ink }));
    eye.position.set(0.09, 0.085, 0.03);
    const eye2 = eye.clone();
    eye2.position.z = -0.03;
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.05, 5), yellow);
    tail.rotation.z = Math.PI / 2 + 0.6;
    tail.position.set(-0.09, 0.03, 0);
    this.duck.add(body, head, beak, eye, eye2, tail);

    this.group.add(cord, rose, shade, cap, bulb, rim, this.duck);
    addOutlines(this.group, 1.05);

    this.spot = new THREE.SpotLight(PALETTE.lamp, this.baseIntensity, 6, 0.8, 0.6, 1.1);
    this.spot.position.y = -cordLen - 0.05;
    this.spot.target.position.set(0, -CEILING_Y, 0);
    this.spot.shadow.camera.near = 0.3;
    this.spot.shadow.camera.far = 5;
    this.spot.shadow.bias = -0.0008;
    this.spot.shadow.normalBias = 0.02;
    this.group.add(this.spot, this.spot.target);
  }

  update(dt: number, time: number, rattle: number, jackpot: number): void {
    // damped pendulum, nudged by a lazy breeze and the earthquake
    const g = 9.81 / (CEILING_Y - SHADE_Y + 0.2);
    const force = Math.sin(time * 0.6) * 0.05 + rattle * Math.sin(time * 9) * 3;
    this.swingVel += (-g * this.swing + force) * dt;
    this.swingVel *= Math.max(0, 1 - 0.4 * dt);
    this.swing += this.swingVel * dt;
    this.group.rotation.z = this.swing;
    this.group.rotation.x = Math.sin(time * 0.43) * 0.025;
    this.duck.rotation.y = Math.sin(time * 0.5) * 0.4;
    this.duck.position.y = -(CEILING_Y - SHADE_Y) + 0.2 + rattle * Math.abs(Math.sin(time * 26)) * 0.03;

    if (jackpot > 0) {
      if (this.reducedFlashing) {
        this.spot.color.copy(this.baseColor).lerp(this.gold, 0.5 + Math.sin(time * 3) * 0.3);
        this.spot.intensity = this.baseIntensity * 1.2;
      } else {
        const c = STROBE[Math.floor(time * 10) % STROBE.length]!;
        this.spot.color.set(c);
        this.spot.intensity = this.baseIntensity * (1 + Math.abs(Math.sin(time * 20)) * 0.8);
      }
      this.bulbMat.color.copy(this.spot.color);
    } else {
      this.spot.color.copy(this.baseColor);
      this.spot.intensity = this.baseIntensity * (1 + Math.sin(time * 37) * 0.01);
      this.bulbMat.color.set("#FFF1C8");
    }
  }
}
