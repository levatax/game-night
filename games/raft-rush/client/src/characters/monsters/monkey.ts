// The daytime monkeys (game4.md §6): brown, cheeky, long-armed. They knuckle-run to the camp chest, reach in
// and grab (steal), then scamper off upright with the loot held over their heads (the item mesh from
// fx/itemMeshes) and taunt from a distance; a coconut hit leaves them dizzy (stunned) and they drop it.
// Regular meshes (one bake per bone, shared by every monkey). Owner: client-characters.

import * as THREE from "three";
import { MONSTER_EMERGE_TICKS } from "../../../../shared/constants";
import type { InvKind, ItemKind } from "../../../../shared/types";
import type { MonsterFrame } from "../../net/types";
import { getSmoothOutlineGeometry } from "../../render/Toon";
import type { MonsterTrigger } from "../Characters";
import { createHeldItem } from "../holds";
import { alongMatrix, bodyMaterial, capsuleGeo, inkOutline, sphereGeo, torusGeo, trs } from "../kit";
import { Clip, type MonsterEnv, type MonsterRig, MONSTER_OUTLINE, PartBaker, Squash, YawFollower } from "./common";

const FUR = "#8B5A2B";
const FUR_DARK = "#6E4420";
const FACE = "#E8C39E";
const PALM = "#C9925E";
const INK = "#2D2A32";

type MonkeyBone = "torso" | "head" | "armL" | "armR" | "legL" | "legR";

interface MonkeyBake {
  bones: Record<MonkeyBone, { geometry: THREE.BufferGeometry; outline: THREE.BufferGeometry | null }>;
}

let bake: MonkeyBake | null = null;

/** Bone geometries (each in its own pivot space), baked once. */
function monkeyBake(): MonkeyBake {
  if (bake) return bake;
  const torso = new PartBaker()
    .put(sphereGeo(8), FUR, [0, 0.16, 0], [0.17, 0.21, 0.15])
    .put(sphereGeo(6), FACE, [0, 0.13, -0.1], [0.12, 0.15, 0.07], [0, 0, 0], false)
    .add(torusGeo(0.2, Math.PI * 1.45, 3, 9), FUR, trs([0, 0.02, 0.28], [0, Math.PI / 2, 0], [0.13, 0.13, 0.13]))
    .put(sphereGeo(5), FUR_DARK, [0, 0.13, 0.33], 0.035, [0, 0, 0], false);
  const head = new PartBaker()
    .put(sphereGeo(9), FUR, [0, 0.1, 0], 0.16)
    .put(sphereGeo(6), FACE, [0, 0.09, -0.085], [0.12, 0.11, 0.08], [0, 0, 0], false)
    .put(sphereGeo(6), FACE, [0, 0.02, -0.14], [0.085, 0.06, 0.055])
    .put(sphereGeo(4), INK, [0.02, 0.04, -0.192], 0.008, [0, 0, 0], false)
    .put(sphereGeo(4), INK, [-0.02, 0.04, -0.192], 0.008, [0, 0, 0], false)
    .add(torusGeo(0.18, Math.PI, 3, 6), INK, trs([0, 0.005, -0.19], [Math.PI / 2, 0, Math.PI], 0.035), false);
  for (const s of [1, -1]) {
    head.put(sphereGeo(5), INK, [0.05 * s, 0.12, -0.165], [0.022, 0.03, 0.012], [0, 0.3 * s, 0], false);
    head.put(sphereGeo(4), "#FFFFFF", [0.056 * s, 0.13, -0.175], 0.008, [0, 0, 0], false);
    head.put(sphereGeo(4), FUR_DARK, [0.05 * s, 0.165, -0.155], [0.03, 0.008, 0.01], [0, 0, -0.35 * s], false);
    head.put(sphereGeo(5), FUR, [0.155 * s, 0.11, 0], [0.03, 0.06, 0.055]);
    head.put(sphereGeo(4), FACE, [0.168 * s, 0.11, -0.01], [0.012, 0.04, 0.035], [0, 0, 0], false);
  }
  const arm = (s: number) =>
    new PartBaker()
      .add(capsuleGeo(0.038, 0.26, 5, 1), FUR, alongMatrix([0, 0, 0], [0.02 * s, -0.3, 0], 1))
      .put(sphereGeo(5), PALM, [0.02 * s, -0.33, -0.01], [0.045, 0.05, 0.04]);
  const leg = (s: number) =>
    new PartBaker()
      .add(capsuleGeo(0.042, 0.22, 5, 1), FUR, alongMatrix([0, 0, 0], [0.01 * s, -0.27, 0], 1))
      .put(sphereGeo(5), PALM, [0.01 * s, -0.31, -0.04], [0.05, 0.03, 0.08]);
  const b = (p: PartBaker) => {
    const x = p.bake();
    return { geometry: x.geometry, outline: x.outline };
  };
  bake = { bones: { torso: b(torso), head: b(head), armR: b(arm(1)), armL: b(arm(-1)), legR: b(leg(1)), legL: b(leg(-1)) } };
  return bake;
}

const HIP_Y = 0.34;

export class MonkeyRig implements MonsterRig {
  readonly id: string;
  readonly kind: MonsterFrame["kind"] = "monkey";
  readonly root = new THREE.Object3D();
  private readonly hips = new THREE.Object3D();
  private readonly bones = new Map<MonkeyBone, THREE.Object3D>();
  private readonly carryAnchor = new THREE.Object3D();
  private readonly yaw = new YawFollower();
  private readonly squash = new Squash();
  private readonly grab = new Clip();
  private readonly startle = new Clip();
  private carryKind: InvKind = "";
  private carryObj: THREE.Object3D | null = null;
  private readonly carryCache = new Map<ItemKind, THREE.Object3D>();
  private time = Math.random() * 10;
  private phase = 0;
  private prevY = Number.NaN;
  private vy = 0;
  private death: { t: number; dur: number } | null = null;

  constructor(id: string) {
    this.id = id;
    this.root.name = `monkey:${id}`;
    const bk = monkeyBake();
    this.hips.position.y = HIP_Y;
    this.root.add(this.hips);
    const pivots: Record<MonkeyBone, [number, number, number]> = {
      torso: [0, 0, 0],
      head: [0, 0.34, -0.02],
      armR: [0.15, 0.27, 0],
      armL: [-0.15, 0.27, 0],
      legR: [0.08, 0, 0],
      legL: [-0.08, 0, 0],
    };
    for (const name of Object.keys(pivots) as MonkeyBone[]) {
      const node = new THREE.Object3D();
      node.position.set(...pivots[name]);
      node.rotation.order = "YXZ";
      const parent = name === "legL" || name === "legR" || name === "torso" ? this.hips : this.bones.get("torso")!;
      parent.add(node);
      const g = bk.bones[name];
      const mesh = new THREE.Mesh(g.geometry, bodyMaterial());
      mesh.castShadow = name === "torso" || name === "head";
      node.add(mesh);
      if (g.outline) {
        const ol = new THREE.Mesh(getSmoothOutlineGeometry(g.outline), inkOutline(MONSTER_OUTLINE));
        ol.userData.isOutline = true;
        mesh.add(ol);
      }
      this.bones.set(name, node);
    }
    this.carryAnchor.position.set(0, 0.68, -0.06);
    this.bones.get("torso")!.add(this.carryAnchor);
  }

  update(f: MonsterFrame, dt: number, _env: MonsterEnv): void {
    this.time += dt;
    if (!Number.isNaN(this.prevY) && dt > 0) this.vy += ((f.y - this.prevY) / dt - this.vy) * (1 - Math.exp(-8 * dt));
    this.prevY = f.y;
    this.root.position.set(f.x, f.y, f.z);
    this.root.rotation.y = this.yaw.update(f.yaw, dt, 10);
    this.grab.step(dt);
    this.startle.step(dt);
    this.squash.step(dt);
    this.setCarry(f.carry);
    this.pose(f, dt);
  }

  trigger(what: MonsterTrigger): void {
    if (what === "steal") this.grab.start(0.5);
    else if (what === "drop" || what === "hurt") {
      this.startle.start(0.6);
      this.squash.kick(-2.5);
    } else this.squash.kick(1);
  }

  writeInstances(): void {}

  center(out: THREE.Vector3): void {
    this.hips.getWorldPosition(out);
    out.y += 0.15;
  }

  beginDeath(): number {
    if (!this.death) this.death = { t: 0, dur: 0.35 };
    return this.death.dur - this.death.t;
  }

  updateDeath(dt: number, _env: MonsterEnv): void {
    const d = this.death;
    if (!d) return;
    d.t += dt;
    const u = Math.min(1, d.t / d.dur);
    this.hips.scale.setScalar(Math.max(0.001, 1 - u));
    this.hips.rotation.y += dt * 10;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.carryCache.clear();
  }

  private setCarry(kind: InvKind): void {
    if (kind === this.carryKind) return;
    this.carryKind = kind;
    if (this.carryObj) this.carryObj.visible = false;
    this.carryObj = null;
    if (kind === "") return;
    let obj = this.carryCache.get(kind);
    if (!obj) {
      obj = createHeldItem(kind, "third");
      obj.scale.multiplyScalar(0.8);
      this.carryCache.set(kind, obj);
      this.carryAnchor.add(obj);
    }
    obj.visible = true;
    this.carryObj = obj;
  }

  private pose(f: MonsterFrame, dt: number): void {
    const b = (n: MonkeyBone) => this.bones.get(n)!;
    const t = this.time;
    const speed = f.speed;
    const moving = Math.min(1, speed / 3);
    this.phase += dt * (7 + speed * 2.2);
    const s = Math.sin(this.phase);
    const carrying = this.carryKind !== "";
    const climbing = this.vy > 0.6;
    let hipY = HIP_Y + 0.03 * Math.abs(s) * moving;
    let lean = 0;
    let armRX = 0;
    let armLX = 0;
    let armZ = 0.15;
    let legRX = s * 0.7 * moving;
    let legLX = -s * 0.7 * moving;
    let headX = 0;
    let headZ = 0;

    if (f.mode === "emerge") {
      // Drops in from the trees.
      const p = 1 - Math.min(1, f.modeTicks / MONSTER_EMERGE_TICKS);
      hipY += 1.4 * (1 - p) * (1 - p);
      armRX = armLX = 2.8;
      armZ = 0.4;
    } else if (f.mode === "stunned") {
      // Plopped on its bottom, head going round.
      hipY = 0.18;
      lean = -0.2;
      legRX = legLX = 1.3;
      armZ = 0.6;
      headZ = 0.3 * Math.sin(t * 7);
      headX = 0.2 * Math.cos(t * 7);
    } else if (climbing) {
      lean = 0.1;
      armRX = 2.8 + 0.4 * s;
      armLX = 2.8 - 0.4 * s;
      legRX = 0.9 + 0.4 * s;
      legLX = 0.9 - 0.4 * s;
    } else if (carrying || f.mode === "carry") {
      // Loot over the head; scamper away or taunt.
      armRX = armLX = 2.9;
      armZ = 0.25;
      lean = 0.15 * moving;
      if (moving < 0.2) {
        hipY += 0.08 * Math.max(0, Math.sin(t * 9));
        headZ = 0.25 * Math.sin(t * 4.5);
        lean = 0.1 * Math.sin(t * 4.5);
      }
    } else if (f.mode === "steal" || this.grab.active) {
      const g = this.grab.active ? Math.sin(Math.PI * this.grab.u) : 0.6 + 0.3 * Math.sin(t * 10);
      lean = 0.6 * g;
      armRX = armLX = 1.4 + 0.5 * g;
      armZ = 0.05;
      headX = 0.3 * g;
    } else {
      // Knuckle run on all fours (or a lazy scratch when standing).
      lean = 0.65 * moving;
      armRX = 0.75 * moving + -s * 0.8 * moving;
      armLX = 0.75 * moving + s * 0.8 * moving;
      headX = -0.5 * moving;
      if (moving < 0.1) {
        armRX = 2.6;
        armZ = -0.2;
        headZ = 0.15 * Math.sin(t * 2);
      }
    }
    if (this.startle.active) {
      const k = Math.sin(Math.PI * this.startle.u);
      hipY += 0.25 * k;
      armRX = armLX = 2.6 * k + armRX * (1 - k);
      armZ += 0.6 * k;
    }
    const sq = this.squash.x;
    this.hips.position.y = hipY;
    this.hips.scale.set(1 - sq * 0.4, 1 + sq, 1 - sq * 0.4);
    b("torso").rotation.set(-lean, 0, 0.05 * s * moving);
    b("head").rotation.set(-headX + lean * 0.6, 0.2 * Math.sin(t * 0.8), -headZ);
    b("armR").rotation.set(armRX, 0, armZ);
    b("armL").rotation.set(armLX, 0, -armZ);
    b("legR").rotation.set(legRX, 0, 0.05);
    b("legL").rotation.set(legLX, 0, -0.05);
  }
}
