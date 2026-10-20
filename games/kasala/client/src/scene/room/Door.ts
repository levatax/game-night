// The back door (raids, §11/§14): an oxblood speakeasy door with a frosted "ÖZEL" window, hinged on its right
// edge so it swings into the room toward the coat rack. breakDoor(): kicked open (overshoots into its stop
// and bounces), a burst of splinters from the latch side, red/blue police lights flash in the corridor behind
// and spill across the floor; after ~2.9 s it slams back with a bounce. `onImpact(strength)` fires on the kick
// and the slam (Stage turns it into camera shake + a lamp swing). The police light itself is Stage's shared
// accent point light: the door only publishes policePos / policeColor / policeIntensity. The casing, the
// corridor and the door leaf are each one StaticBatch (the leaf's batch rides the hinge).

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { toon } from "../toon";
import { StaticBatch } from "./batch";
import { DOOR_H, DOOR_W, DOOR_X, ROOM_BACK_Z } from "./layout";
import { doorGlassTexture, softDotTexture, woodTexture } from "./textures";

const OPEN_STOP = 1.75;
const HOLD_SEC = 2.9;
const SPLINTERS = 18;
const DUST = 8;
const POLICE_INTENSITY = 30;
const RED = new THREE.Color(PALETTE.siren);
const BLUE = new THREE.Color(PALETTE.police);

interface Splinter {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  life: number;
  size: number;
}

export class Door {
  readonly group = new THREE.Group();
  /** Police light in the corridor (world), its flashing color and intensity (drives Stage's accent light). */
  readonly policePos = new THREE.Vector3(DOOR_X, 1.5, ROOM_BACK_Z - 0.7);
  readonly policeColor = new THREE.Color(RED);
  policeIntensity = 0;
  onImpact: (strength: number) => void = () => {};
  private hinge = new THREE.Group();
  private angle = 0;
  private vel = 0;
  private target = 0;
  private t = -1;
  private policeLevel = 0;
  private spill: THREE.Mesh;
  private spillMat: THREE.MeshBasicMaterial;
  private splinters: Splinter[] = [];
  private splinterMesh: THREE.InstancedMesh;
  private dust: THREE.Sprite[] = [];
  private dustT = -1;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3();
  private slammed = false;

  constructor() {
    const back = ROOM_BACK_Z;
    // frame casing + the corridor behind the door (seen only when it is open, lit by the police light)
    const fixed = new StaticBatch();
    const casing = toon(PALETTE.woodDark);
    const jamb = new THREE.BoxGeometry(0.12, DOOR_H + 0.06, 0.1);
    for (const s of [-1, 1]) {
      fixed.addAt(jamb, casing, new THREE.Vector3(DOOR_X + s * (DOOR_W / 2 + 0.06), (DOOR_H + 0.06) / 2, back + 0.04), null, 1, { outline: 1.03 });
    }
    fixed.addAt(new THREE.BoxGeometry(DOOR_W + 0.36, 0.14, 0.12), casing, new THREE.Vector3(DOOR_X, DOOR_H + 0.1, back + 0.05), null, 1, { outline: 1.03 });
    fixed.addAt(new THREE.BoxGeometry(DOOR_W + 0.2, 0.03, 0.16), toon("#2A1A12"), new THREE.Vector3(DOOR_X, 0.015, back), null, 1, { outline: 1.03 });
    fixed.addAt(new THREE.BoxGeometry(1.7, 2.7, 2.6), toon("#2A1C22", { side: THREE.BackSide }), new THREE.Vector3(DOOR_X, 1.35, back - 1.3));
    fixed.addAt(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshBasicMaterial({ color: "#6A6A5A" }), new THREE.Vector3(DOOR_X, 2.45, back - 1.2));
    this.group.add(fixed.build("doorFrame"));

    // the door panel on its hinge (right edge)
    const w = DOOR_W - 0.03;
    const h = DOOR_H - 0.02;
    this.hinge.position.set(DOOR_X + DOOR_W / 2 - 0.01, 0.01, back + 0.005);
    const doorTex = woodTexture("#5A1E1E", "#3A1010", 41);
    const leaf = new THREE.Group();
    const panel = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), toon("#FFFFFF", { map: doorTex, unique: true }));
    panel.position.set(-w / 2, h / 2, 0.025);
    panel.userData.castShadow = true;
    const inset = toon("#4A1616");
    for (const [y, ph] of [[0.48, 0.62], [1.18, 0.5]] as const) {
      for (const z of [0.055, -0.005]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(w - 0.24, ph, 0.012), inset);
        p.position.set(-w / 2, y, z);
        leaf.add(p);
      }
    }
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.52), new THREE.MeshBasicMaterial({ map: doorGlassTexture(), color: "#B89A72" }));
    glass.position.set(-w / 2, 1.78, 0.052);
    glass.userData.noOutline = true;
    const glassBack = glass.clone();
    glassBack.rotation.y = Math.PI;
    glassBack.position.z = -0.002;
    const glassFrame = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.02), toon("#B8862E"));
    glassFrame.position.set(-w / 2, 1.78, 0.04);
    const brass = toon("#D9A441");
    for (const z of [0.07, -0.02]) {
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), brass);
      knob.position.set(-w + 0.1, 1.0, z);
      const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.01, 12), brass);
      rose.rotation.x = Math.PI / 2;
      rose.position.set(-w + 0.1, 1.0, z > 0 ? 0.055 : -0.005);
      leaf.add(knob, rose);
    }
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.012), brass);
    plate.position.set(-w + 0.1, 0.9, 0.056);
    leaf.add(panel, glassFrame, glass, glassBack, plate);
    const leafBatch = new StaticBatch();
    leafBatch.addObject(leaf, { outline: 1.025 });
    this.hinge.add(leafBatch.build("doorLeaf"));
    this.group.add(this.hinge);

    // the colored police spill on the floor through the doorway
    const spillGeo = new THREE.BufferGeometry();
    // trapezoid from the doorway widening into the room
    const x0 = DOOR_X - DOOR_W / 2;
    const x1 = DOOR_X + DOOR_W / 2;
    const zIn = back + 0.02;
    const zOut = back + 2.6;
    spillGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([x0, 0.012, zIn, x1, 0.012, zIn, x1 + 0.9, 0.012, zOut, x0, 0.012, zIn, x1 + 0.9, 0.012, zOut, x0 - 0.9, 0.012, zOut], 3),
    );
    spillGeo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0], 2));
    this.spillMat = new THREE.MeshBasicMaterial({
      map: spillTexture(),
      color: RED,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.spill = new THREE.Mesh(spillGeo, this.spillMat);
    this.spill.renderOrder = 2;
    this.spill.visible = false;
    this.group.add(this.spill);

    // splinters (instanced) + dust puffs
    this.splinterMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), toon("#B07A4A"), SPLINTERS);
    this.splinterMesh.count = 0;
    this.splinterMesh.visible = false;
    this.splinterMesh.frustumCulled = false;
    this.group.add(this.splinterMesh);
    for (let i = 0; i < SPLINTERS; i++) {
      this.splinters.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Euler(), spin: new THREE.Vector3(), life: 0, size: 1 });
    }
    const dustMat = new THREE.SpriteMaterial({ map: softDotTexture(), color: "#8A7A6A", transparent: true, depthWrite: false, opacity: 0, fog: false });
    for (let i = 0; i < DUST; i++) {
      const s = new THREE.Sprite(dustMat);
      s.userData.base = new THREE.Vector3();
      s.userData.drift = new THREE.Vector3();
      s.visible = false;
      this.dust.push(s);
      this.group.add(s);
    }
  }

  /** Kick the door in (raid). Slams back by itself. */
  kick(): void {
    this.t = 0;
    this.slammed = false;
    this.target = OPEN_STOP * 0.94;
    this.vel = 16;
    this.onImpact(0.75);
    // splinters burst from the latch side into the room
    const latchX = DOOR_X - DOOR_W / 2;
    for (const s of this.splinters) {
      s.pos.set(latchX + (Math.random() - 0.5) * 0.08, 0.75 + Math.random() * 0.6, ROOM_BACK_Z + 0.05);
      s.vel.set(-0.6 + Math.random() * 1.8, 1 + Math.random() * 2.4, 1.4 + Math.random() * 2.6);
      s.rot.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      s.spin.set((Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22);
      s.life = 1.6 + Math.random() * 0.8;
      s.size = 0.6 + Math.random() * 0.8;
    }
    this.splinterMesh.count = SPLINTERS;
    this.splinterMesh.visible = true;
    this.puffDust(latchX + 0.1, 1.0);
  }

  private puffDust(x: number, y: number): void {
    this.dustT = 0;
    this.dust.forEach((d, i) => {
      d.visible = true;
      (d.userData.base as THREE.Vector3).set(x + (Math.random() - 0.5) * 0.3, y + (i / DUST - 0.5) * 1.6, ROOM_BACK_Z + 0.15);
      (d.userData.drift as THREE.Vector3).set((Math.random() - 0.5) * 0.4, Math.random() * 0.25, 0.25 + Math.random() * 0.4);
    });
  }

  /** True while the raid lights are flashing / the door is open. */
  get busy(): boolean {
    return this.t >= 0;
  }

  update(dt: number, time: number, reducedFlashing: boolean): void {
    if (this.t >= 0) {
      this.t += dt;
      if (this.t > HOLD_SEC && this.target > 0) {
        this.target = 0;
        this.vel = Math.min(this.vel, -9);
      }
      if (this.t > HOLD_SEC + 1.6) this.t = -1;
    }
    // stiff spring toward the target with hard stops (wall and frame) that bounce
    this.vel += ((this.target - this.angle) * 60 - this.vel * 4) * dt;
    this.angle += this.vel * dt;
    if (this.angle > OPEN_STOP) {
      this.angle = OPEN_STOP;
      this.vel = -Math.abs(this.vel) * 0.35;
    }
    if (this.angle < 0) {
      this.angle = 0;
      if (this.vel < -1.5 && !this.slammed && this.t > HOLD_SEC) {
        this.slammed = true;
        this.onImpact(0.45);
        this.puffDust(DOOR_X - DOOR_W / 2 + 0.05, 1.1);
      }
      this.vel = Math.abs(this.vel) * 0.22;
    }
    this.hinge.rotation.y = this.angle;

    // police lights: on while open, fade after the slam
    const want = this.t >= 0 && this.t < HOLD_SEC + 0.35 ? 1 : 0;
    this.policeLevel += (want - this.policeLevel) * (1 - Math.exp(-(want ? 10 : 3) * dt));
    const open = Math.min(1, this.angle / 0.9);
    let mix: number;
    if (reducedFlashing) mix = 0.5 + Math.sin(time * 3) * 0.5;
    else mix = Math.floor(time * 7) % 2;
    this.policeColor.copy(RED).lerp(BLUE, mix);
    this.policeIntensity = POLICE_INTENSITY * this.policeLevel * (0.25 + 0.75 * open);
    this.spill.visible = this.policeLevel > 0.01;
    this.spillMat.color.copy(this.policeColor);
    this.spillMat.opacity = 0.55 * this.policeLevel * open;

    // splinters: ballistic, bounce on the floor, shrink away
    if (this.splinterMesh.count > 0) {
      let alive = 0;
      for (const s of this.splinters) {
        if (s.life <= 0) continue;
        s.life -= dt;
        s.vel.y -= 9.8 * dt;
        s.pos.addScaledVector(s.vel, dt);
        if (s.pos.y < 0.01) {
          s.pos.y = 0.01;
          s.vel.y = Math.abs(s.vel.y) * 0.3;
          s.vel.x *= 0.6;
          s.vel.z *= 0.6;
          s.spin.multiplyScalar(0.5);
        }
        s.rot.x += s.spin.x * dt;
        s.rot.y += s.spin.y * dt;
        s.rot.z += s.spin.z * dt;
        const k = Math.min(1, s.life / 0.4) * s.size;
        this.tmpQ.setFromEuler(s.rot);
        this.tmpS.set(0.03 * k, 0.012 * k, 0.12 * k);
        this.tmpM.compose(s.pos, this.tmpQ, this.tmpS);
        this.splinterMesh.setMatrixAt(alive++, this.tmpM);
      }
      this.splinterMesh.count = alive;
      this.splinterMesh.visible = alive > 0;
      this.splinterMesh.instanceMatrix.needsUpdate = true;
    }

    // dust puffs
    if (this.dustT >= 0) {
      this.dustT += dt;
      const p = this.dustT / 1.2;
      for (const d of this.dust) {
        const base = d.userData.base as THREE.Vector3;
        const drift = d.userData.drift as THREE.Vector3;
        d.position.copy(base).addScaledVector(drift, p);
        d.scale.setScalar(0.15 + p * 0.45);
      }
      this.dust[0]!.material.opacity = Math.max(0, (1 - p) * 0.45);
      if (p >= 1) {
        this.dustT = -1;
        for (const d of this.dust) d.visible = false;
      }
    }
  }
}

/** Light spill: bright near the doorway (v = 1), fading into the room, soft edges. */
function spillTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d")!;
  const v = g.createLinearGradient(0, 0, 0, 64);
  v.addColorStop(0, "rgba(255,255,255,0.9)");
  v.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = v;
  g.fillRect(0, 0, 64, 64);
  g.globalCompositeOperation = "destination-in";
  const h = g.createLinearGradient(0, 0, 64, 0);
  h.addColorStop(0, "rgba(0,0,0,0)");
  h.addColorStop(0.25, "rgba(0,0,0,1)");
  h.addColorStop(0.75, "rgba(0,0,0,1)");
  h.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = h;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}
