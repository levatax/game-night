// Wind Storm prop: a goofy desk fan with googly eyes on its motor that pops up at the table edge
// (stand-local, upwind of the cake) and blasts "whoosh" streaks across the tower along (dx, dz).
// Lives under Stage.standGroup because the wind direction is stand-local.

import * as THREE from "three";
import { PALETTE, TABLE_RADIUS } from "../../../../shared/constants";
import { addOutlines, googlyEyes, jiggleEyes, toon } from "../toon";
import { whooshTexture } from "./textures";

const STREAKS = 10;

export class DeskFan {
  readonly group = new THREE.Group();
  private fan = new THREE.Group();
  private head = new THREE.Group();
  private blades = new THREE.Group();
  private eyes: THREE.Group;
  private streaks: THREE.Mesh[] = [];
  private streakMat: THREE.MeshBasicMaterial;
  private strength = 0;
  private shown = 0;
  private spin = 0;

  constructor() {
    const body = toon("#7BE07B");
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.03, 16), body);
    base.position.y = 0.015;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.36, 8), toon("#D7DCE8"));
    neck.position.y = 0.2;
    this.head.position.y = 0.42;
    const motor = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), body);
    motor.scale.z = 1.4;
    motor.position.z = -0.05;
    this.eyes = googlyEyes(0.028, 0.035);
    this.eyes.position.set(0, 0.06, -0.06);
    this.eyes.rotation.x = -0.6;
    // cage: two rings + a few spokes
    const wire = toon("#D7DCE8");
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.006, 4, 24), wire);
    ring.position.z = 0.03;
    const ring2 = ring.clone();
    ring2.position.z = -0.0;
    ring2.scale.setScalar(0.98);
    const spokes = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.004, 0.004), wire);
      sp.rotation.z = (i / 6) * Math.PI;
      sp.position.z = 0.032;
      spokes.add(sp);
    }
    const bladeMat = toon("#FF8BD1");
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 6), bladeMat);
      b.scale.set(1, 0.45, 0.12);
      b.position.set(Math.cos((i / 3) * Math.PI * 2) * 0.065, Math.sin((i / 3) * Math.PI * 2) * 0.065, 0);
      b.rotation.z = (i / 3) * Math.PI * 2;
      this.blades.add(b);
    }
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), toon(PALETTE.ink));
    this.blades.add(hub);
    this.blades.position.z = 0.015;
    for (const o of [ring, ring2, ...spokes.children]) o.userData.noOutline = true;
    this.head.add(motor, this.eyes, ring, ring2, spokes, this.blades);
    this.fan.add(base, neck, this.head);
    this.fan.traverse((o) => (o.castShadow = (o as THREE.Mesh).isMesh));
    addOutlines(this.fan, 1.06);
    this.group.add(this.fan);

    // whoosh streaks flying downwind across the cake (fan faces +z of its group)
    this.streakMat = new THREE.MeshBasicMaterial({ map: whooshTexture(), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    const geo = new THREE.PlaneGeometry(0.4, 0.08);
    geo.rotateY(Math.PI / 2); // streak runs along +z
    for (let i = 0; i < STREAKS; i++) {
      const s = new THREE.Mesh(geo, this.streakMat);
      s.userData.seed = Math.random();
      s.userData.lane = new THREE.Vector2((Math.random() - 0.5) * 0.6, 0.45 + Math.random() * 0.4);
      this.group.add(s);
      this.streaks.push(s);
    }
    this.group.visible = false;
  }

  /** Direction (stand-local) + strength 0..1. */
  set(dx: number, dz: number, strength: number): void {
    this.strength = Math.max(0, Math.min(1, strength));
    const len = Math.hypot(dx, dz);
    if (len > 1e-4) {
      const ux = dx / len;
      const uz = dz / len;
      this.group.rotation.y = Math.atan2(ux, uz);
    }
  }

  update(dt: number, time: number): void {
    const target = this.strength > 0.01 ? 1 : 0;
    this.shown += (target - this.shown) * Math.min(1, dt * 6);
    if (this.shown < 0.01 && target === 0) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    // pop in with a boing (overshoot), sitting upwind at the table edge
    const pop = this.shown < 0.999 ? Math.sin(this.shown * Math.PI * 0.9) * 0.25 + this.shown : 1;
    this.fan.scale.setScalar(Math.max(0.001, pop * 1.4));
    this.fan.position.set(0, 0, -(TABLE_RADIUS - 0.2));
    // oscillating head + blades + rattly shaking
    const s = this.strength;
    this.spin += dt * (8 + s * 50);
    this.blades.rotation.z = this.spin;
    this.head.rotation.y = Math.sin(time * 1.4) * 0.25 * s;
    this.head.position.x = Math.sin(time * 60) * 0.004 * s;
    this.fan.rotation.z = Math.sin(time * 45) * 0.03 * s;
    jiggleEyes(this.eyes, dt, 2 + s * 8);

    this.streakMat.opacity = Math.min(1, s * 1.3) * this.shown * 0.8;
    const len = TABLE_RADIUS * 2;
    for (const st of this.streaks) {
      const lane = st.userData.lane as THREE.Vector2;
      const p = (time * (0.8 + s * 1.2) + (st.userData.seed as number)) % 1;
      st.position.set(lane.x + Math.sin(time * 3 + lane.y * 9) * 0.05, lane.y + Math.sin(p * 8) * 0.02, -(TABLE_RADIUS - 0.3) + p * len * 0.85);
      st.scale.setScalar(0.6 + Math.sin(p * Math.PI) * 0.6);
    }
  }
}
