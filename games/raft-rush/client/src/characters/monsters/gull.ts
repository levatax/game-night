// Şükrü the seagull (game4.md §6/§14): white body, grey back, black wingtips, a yellow beak with the red spot
// and a thief's eyebrows. Flaps in, dives to snatch a fish, then circles the camp (banking into the turns,
// gliding between flaps) with the fish in his beak before he drops it; tumbles when a coconut hits him; folds
// his wings and bobs his head if he ever lands. Regular meshes. Owner: client-characters.

import * as THREE from "three";
import { MONSTER_EMERGE_TICKS } from "../../../../shared/constants";
import type { InvKind, ItemKind } from "../../../../shared/types";
import type { MonsterFrame } from "../../net/types";
import { getSmoothOutlineGeometry } from "../../render/Toon";
import type { MonsterTrigger } from "../Characters";
import { createHeldItem } from "../holds";
import { alongMatrix, bodyMaterial, coneGeo, inkOutline, sphereGeo } from "../kit";
import { Clip, type MonsterEnv, type MonsterRig, MONSTER_OUTLINE, PartBaker, Squash, YawFollower } from "./common";

const WHITE = "#FFFFFF";
const GREY = "#C9D1D9";
const TIP = "#2D2A32";
const BEAK = "#FFB830";
const FEET = "#FF9A3D";

type GullBone = "body" | "head" | "wingL" | "wingR" | "feet";

let bake: Record<GullBone, { geometry: THREE.BufferGeometry; outline: THREE.BufferGeometry | null }> | null = null;

function gullBake(): NonNullable<typeof bake> {
  if (bake) return bake;
  const body = new PartBaker()
    .put(sphereGeo(9), WHITE, [0, 0, 0], [0.15, 0.13, 0.3])
    .put(sphereGeo(7), GREY, [0, 0.07, 0.04], [0.13, 0.06, 0.24], [0, 0, 0], false)
    .add(coneGeo(5), WHITE, alongMatrix([0, 0.02, 0.24], [0, 0.05, 0.46], 0.09).multiply(new THREE.Matrix4().makeScale(1, 1, 0.35)))
    .put(sphereGeo(5), GREY, [0, 0.05, 0.42], [0.06, 0.015, 0.05], [0, 0, 0], false);
  const head = new PartBaker()
    .put(sphereGeo(9), WHITE, [0, 0.05, -0.05], 0.1)
    .add(coneGeo(5), BEAK, alongMatrix([0, 0.03, -0.13], [0, 0.0, -0.29], 0.034))
    .put(sphereGeo(4), "#E5383B", [0, 0.012, -0.22], 0.012, [0, 0, 0], false);
  for (const s of [1, -1]) {
    head.put(sphereGeo(6), WHITE, [0.06 * s, 0.08, -0.1], 0.03, [0, 0, 0], false);
    head.put(sphereGeo(4), TIP, [0.068 * s, 0.08, -0.124], 0.015, [0, 0, 0], false);
    head.put(sphereGeo(4), TIP, [0.055 * s, 0.115, -0.11], [0.03, 0.007, 0.01], [0, 0.3 * s, 0.45 * s], false);
  }
  const wing = (s: number) =>
    new PartBaker()
      .put(sphereGeo(8), GREY, [0.22 * s, 0, 0.03], [0.24, 0.022, 0.1])
      .put(sphereGeo(7), TIP, [0.47 * s, 0, 0.07], [0.12, 0.018, 0.065]);
  const feet = new PartBaker();
  for (const s of [1, -1]) feet.put(sphereGeo(5), FEET, [0.05 * s, 0, 0], [0.03, 0.012, 0.05], [0, 0, 0], false);
  const b = (p: PartBaker) => {
    const x = p.bake();
    return { geometry: x.geometry, outline: x.outline };
  };
  bake = { body: b(body), head: b(head), wingR: b(wing(1)), wingL: b(wing(-1)), feet: b(feet) };
  return bake;
}

export class GullRig implements MonsterRig {
  readonly id: string;
  readonly kind: MonsterFrame["kind"] = "gull";
  readonly root = new THREE.Object3D();
  private readonly body = new THREE.Object3D();
  private readonly bones = new Map<GullBone, THREE.Object3D>();
  private readonly beak = new THREE.Object3D();
  private readonly yaw = new YawFollower();
  private readonly squash = new Squash();
  private readonly dive = new Clip();
  private readonly tumble = new Clip();
  private carryKind: InvKind = "";
  private carryObj: THREE.Object3D | null = null;
  private readonly carryCache = new Map<ItemKind, THREE.Object3D>();
  private time = Math.random() * 10;
  private flap = 0;
  private bank = 0;
  private restT = 0;
  private prevY = Number.NaN;
  private vy = 0;
  private death: { t: number; dur: number } | null = null;

  constructor(id: string) {
    this.id = id;
    this.root.name = `gull:${id}`;
    this.root.add(this.body);
    this.body.rotation.order = "YXZ";
    this.body.position.y = 0.25;
    const bk = gullBake();
    const pivots: Record<GullBone, [number, number, number]> = {
      body: [0, 0, 0],
      head: [0, 0.08, -0.24],
      wingR: [0.12, 0.06, -0.02],
      wingL: [-0.12, 0.06, -0.02],
      feet: [0, -0.13, 0.08],
    };
    for (const name of Object.keys(pivots) as GullBone[]) {
      const node = name === "body" ? this.body : new THREE.Object3D();
      if (name !== "body") {
        node.position.set(...pivots[name]);
        node.rotation.order = "YXZ";
        this.body.add(node);
      }
      const g = bk[name];
      const mesh = new THREE.Mesh(g.geometry, bodyMaterial());
      mesh.castShadow = name !== "feet";
      node.add(mesh);
      if (g.outline) {
        const ol = new THREE.Mesh(getSmoothOutlineGeometry(g.outline), inkOutline(MONSTER_OUTLINE));
        ol.userData.isOutline = true;
        mesh.add(ol);
      }
      this.bones.set(name, node);
    }
    this.beak.position.set(0, 0.0, -0.27);
    this.bones.get("head")!.add(this.beak);
  }

  update(f: MonsterFrame, dt: number, _env: MonsterEnv): void {
    this.time += dt;
    if (!Number.isNaN(this.prevY) && dt > 0) this.vy += ((f.y - this.prevY) / dt - this.vy) * (1 - Math.exp(-6 * dt));
    this.prevY = f.y;
    this.root.position.set(f.x, f.y, f.z);
    this.root.rotation.y = this.yaw.update(f.yaw, dt, 5);
    this.dive.step(dt);
    this.tumble.step(dt);
    this.squash.step(dt);
    this.setCarry(f.carry);
    this.restT = f.speed < 0.3 ? this.restT + dt : 0;
    this.pose(f, dt);
  }

  trigger(what: MonsterTrigger): void {
    if (what === "steal") this.dive.start(0.6);
    else if (what === "hurt" || what === "drop") {
      this.tumble.start(0.8);
      this.squash.kick(-2);
    } else this.squash.kick(1);
  }

  writeInstances(): void {}

  center(out: THREE.Vector3): void {
    this.body.getWorldPosition(out);
  }

  beginDeath(): number {
    if (!this.death) this.death = { t: 0, dur: 0.4 };
    return this.death.dur - this.death.t;
  }

  updateDeath(dt: number, _env: MonsterEnv): void {
    const d = this.death;
    if (!d) return;
    d.t += dt;
    this.time += dt;
    this.flap += dt * 22;
    const u = Math.min(1, d.t / d.dur);
    this.body.scale.setScalar(Math.max(0.001, 1 - u));
    this.body.position.y = 0.25 + 1.2 * u;
    this.wings(0.2 + 0.7 * Math.sin(this.flap));
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
      obj.scale.multiplyScalar(0.7);
      // Held crosswise in the beak.
      obj.rotation.y = Math.PI / 2;
      this.carryCache.set(kind, obj);
      this.beak.add(obj);
    }
    obj.visible = true;
    this.carryObj = obj;
  }

  private wings(angle: number): void {
    this.bones.get("wingR")!.rotation.set(0, 0, angle);
    this.bones.get("wingL")!.rotation.set(0, 0, -angle);
  }

  private pose(f: MonsterFrame, dt: number): void {
    const t = this.time;
    const head = this.bones.get("head")!;
    const feet = this.bones.get("feet")!;
    const resting = this.restT > 0.6 && f.mode !== "carry" && f.mode !== "flee";
    let pitch = 0;
    let roll = 0;
    if (resting) {
      // Standing: wings folded, head bobbing, feet down.
      this.wings(-1.25);
      this.bones.get("wingR")!.rotation.y = 0.35;
      this.bones.get("wingL")!.rotation.y = -0.35;
      head.rotation.set(0.25 * Math.max(0, Math.sin(t * 5)), 0.6 * Math.sin(t * 0.9), 0);
      feet.position.y = -0.2;
      feet.scale.setScalar(1);
      this.body.position.y = 0.33;
      pitch = -0.1;
    } else {
      // Flight: flap faster when climbing, glide while circling with loot.
      const gliding = (f.mode === "carry" || this.carryKind !== "") && Math.sin(t * 0.9) > 0.2 && this.vy > -0.5;
      const rate = gliding ? 0 : 11 + Math.max(0, this.vy) * 3 + (f.mode === "flee" ? 5 : 0);
      this.flap += dt * rate;
      const flapA = gliding ? 0.12 + 0.04 * Math.sin(t * 6) : 0.15 + 0.65 * Math.sin(this.flap);
      this.wings(flapA);
      this.bones.get("wingR")!.rotation.y = 0;
      this.bones.get("wingL")!.rotation.y = 0;
      feet.position.y = -0.13;
      feet.scale.setScalar(0.8);
      this.body.position.y = 0.25 + 0.03 * Math.sin(this.flap);
      head.rotation.set(0.15, 0.25 * Math.sin(t * 1.3), 0);
      // Bank into turns.
      const bankTarget = Math.max(-0.7, Math.min(0.7, -this.yaw.rate * 0.35));
      this.bank += (bankTarget - this.bank) * (1 - Math.exp(-5 * dt));
      roll = this.bank;
      pitch = Math.max(-0.4, Math.min(0.4, -this.vy * 0.12));
      if (f.mode === "emerge") {
        const p = 1 - Math.min(1, f.modeTicks / MONSTER_EMERGE_TICKS);
        this.body.position.y += 1.2 * (1 - p);
      }
    }
    if (f.mode === "steal" || this.dive.active) {
      const k = this.dive.active ? Math.sin(Math.PI * this.dive.u) : 0.6;
      pitch += 0.6 * k;
      this.wings(-0.2 - 0.3 * k);
      this.bones.get("wingR")!.rotation.y = -0.5 * k;
      this.bones.get("wingL")!.rotation.y = 0.5 * k;
    }
    if (f.mode === "stunned" || this.tumble.active) {
      roll += (this.tumble.active ? this.tumble.u : t * 0.5) * Math.PI * 4;
      this.wings(0.6 * Math.sin(t * 25));
    }
    const sq = this.squash.x;
    this.body.rotation.set(pitch, 0, roll);
    this.body.scale.set(1 - sq * 0.4, 1 + sq, 1 - sq * 0.4);
  }
}
