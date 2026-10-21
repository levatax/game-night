// The monster cast manager behind the Monsters facade: one rig per MonsterFrame id (created / updated /
// removed every frame), death and despawn animations for monsters that left the state, triggers that arrive
// before the state patch (kept briefly), the instanced crab + puffer pools, instanced blob shadows, and the
// night glow of the neon eyes. Owner: client-characters.

import * as THREE from "three";
import { MONSTER_CAP, MONSTERS } from "../../../../shared/constants";
import type { MonsterFrame } from "../../net/types";
import type { MonsterTrigger } from "../Characters";
import { blobGeometry, sharedBlobMaterial } from "../shadowBlob";
import { BossRig } from "./boss";
import { InstancedPool, type MonsterEnv, type MonsterRig, setEyeGlow } from "./common";
import { CrabRig, crabPartDefs } from "./crab";
import { GullRig } from "./gull";
import { MonkeyRig } from "./monkey";
import { PufferRig, pufferPartDefs } from "./puffer";

/** Triggers for ids we don't have yet are kept this long (spawn events can beat the state patch). */
const PENDING_SEC = 1.5;
/** Room for the cap plus monsters still playing their death animation. */
const POOL_CAPACITY = MONSTER_CAP + 8;
const SHADOW_CAPACITY = POOL_CAPACITY * 2;

interface Dying {
  rig: MonsterRig;
  left: number;
  /** Started by a "die" event: frames still carrying the id (the removal patch lags) are ignored. */
  killed: boolean;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();

export class MonsterHerd {
  /** Everything monsters draw lives under this group (the Characters facade adds it to the scene). */
  readonly root = new THREE.Group();
  dark = 0;
  private crabPool: InstancedPool | null = null;
  private pufferPool: InstancedPool | null = null;
  private readonly rigs = new Map<string, MonsterRig>();
  private readonly dying = new Map<string, Dying>();
  private readonly pending = new Map<string, { what: MonsterTrigger; age: number }[]>();
  private readonly shadows: THREE.InstancedMesh;
  private readonly seen = new Set<string>();
  private time = 0;

  constructor() {
    this.root.name = "monsters";
    this.shadows = new THREE.InstancedMesh(blobGeometry(), sharedBlobMaterial(), SHADOW_CAPACITY);
    this.shadows.name = "monster-shadows";
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = -1;
    this.shadows.count = 0;
    this.shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.shadows);
  }

  sync(frames: ReadonlyArray<MonsterFrame>, dt: number): void {
    this.time += dt;
    const env: MonsterEnv = { dark: this.dark, time: this.time };
    setEyeGlow(this.dark);
    this.seen.clear();
    for (const f of frames) {
      this.seen.add(f.id);
      let rig = this.rigs.get(f.id);
      if (rig && rig.kind !== f.kind) {
        rig.dispose();
        rig = undefined;
      }
      if (!rig) {
        const d = this.dying.get(f.id);
        if (d?.killed) continue;
        // A monster that came back (it was only missing from one frame) stops dying.
        if (d) {
          d.rig.dispose();
          this.dying.delete(f.id);
        }
        rig = this.create(f);
        this.rigs.set(f.id, rig);
        const queued = this.pending.get(f.id);
        if (queued) {
          for (const q of queued) rig.trigger(q.what);
          this.pending.delete(f.id);
        }
      }
      rig.update(f, dt, env);
    }
    for (const [id, rig] of this.rigs) {
      if (this.seen.has(id)) continue;
      this.rigs.delete(id);
      this.dying.set(id, { rig, left: rig.beginDeath(), killed: false });
    }
    for (const [id, d] of this.dying) {
      d.left -= dt;
      d.rig.updateDeath(dt, env);
      if (d.left <= 0) {
        d.rig.dispose();
        this.dying.delete(id);
      }
    }
    for (const [id, list] of this.pending) {
      for (const q of list) q.age += dt;
      const keep = list.filter((q) => q.age < PENDING_SEC);
      if (keep.length) this.pending.set(id, keep);
      else this.pending.delete(id);
    }
    this.flush();
  }

  trigger(id: string, what: MonsterTrigger): void {
    const rig = this.rigs.get(id);
    if (rig) {
      rig.trigger(what);
      if (what === "die") {
        // The state removal follows; start dying right away so the pop lines up with the event.
        this.rigs.delete(id);
        this.dying.set(id, { rig, left: rig.beginDeath(), killed: true });
      }
      return;
    }
    const dying = this.dying.get(id);
    if (dying) {
      dying.rig.trigger(what);
      return;
    }
    const list = this.pending.get(id) ?? [];
    list.push({ what, age: 0 });
    if (list.length > 4) list.shift();
    this.pending.set(id, list);
  }

  center(id: string, out: THREE.Vector3): boolean {
    const rig = this.rigs.get(id) ?? this.dying.get(id)?.rig;
    if (!rig) return false;
    rig.center(out);
    return true;
  }

  /** Number of live rigs (dev harness). */
  get count(): number {
    return this.rigs.size;
  }

  clear(): void {
    for (const rig of this.rigs.values()) rig.dispose();
    for (const d of this.dying.values()) d.rig.dispose();
    this.rigs.clear();
    this.dying.clear();
    this.pending.clear();
    this.flush();
  }

  private create(f: MonsterFrame): MonsterRig {
    let rig: MonsterRig;
    switch (f.kind) {
      case "crab":
        rig = new CrabRig(f.id, "crab", this.crabs(), { scale: 1, boss: false });
        break;
      case "boss":
        rig = new BossRig(f.id, this.crabs());
        break;
      case "puffer":
        rig = new PufferRig(f.id, this.puffers());
        break;
      case "monkey":
        rig = new MonkeyRig(f.id);
        break;
      case "gull":
        rig = new GullRig(f.id);
        break;
    }
    this.root.add(rig.root);
    return rig;
  }

  private crabs(): InstancedPool {
    if (!this.crabPool) this.crabPool = new InstancedPool(this.root, crabPartDefs(), POOL_CAPACITY);
    return this.crabPool;
  }

  private puffers(): InstancedPool {
    if (!this.pufferPool) this.pufferPool = new InstancedPool(this.root, pufferPartDefs(), POOL_CAPACITY);
    return this.pufferPool;
  }

  /** Update matrices, push every rig's parts into the pools, place the blob shadows. */
  private flush(): void {
    this.root.updateMatrixWorld(true);
    this.crabPool?.begin();
    this.pufferPool?.begin();
    let shadows = 0;
    const place = (rig: MonsterRig, fade: number): void => {
      rig.writeInstances();
      if (rig.kind === "gull" || shadows >= SHADOW_CAPACITY) return;
      const r = MONSTERS[rig.kind].radius * (rig.kind === "monkey" ? 1.1 : 1.25) * fade;
      rig.root.getWorldPosition(tmpP);
      tmpS.set(r, 1, r);
      tmpM.compose(tmpP.setY(tmpP.y + 0.03), tmpQ.identity(), tmpS);
      this.shadows.setMatrixAt(shadows++, tmpM);
    };
    for (const rig of this.rigs.values()) place(rig, 1);
    for (const d of this.dying.values()) place(d.rig, Math.max(0, Math.min(1, d.left * 3)));
    this.shadows.count = shadows;
    this.shadows.instanceMatrix.needsUpdate = true;
    this.crabPool?.end();
    this.pufferPool?.end();
  }
}
