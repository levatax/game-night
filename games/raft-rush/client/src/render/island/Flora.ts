// Resource-node flora (trees, palms, rocks, bushes) in ONE BatchedMesh: every archetype geometry is added once
// and each node is an instance (the multi-draw equivalent of "InstancedMesh per archetype", game4.md §16/§20,
// at a single draw call; per-instance frustum culling included). Node depletion is read from WorldFrame.nodes:
// a tree falls over and leaves a stump at 0, palms show 0–2 coconuts (they pop back when regrown), rocks
// crumble to pebbles, rope bushes go bare, berry bushes show berries while amount > 0, and every hit shakes the
// node. Wind sway is injected into the toon shader (stronger in the storm). Each instance gets its own value,
// warm / cool tilt and (cosmetic) proportions, and plants on dry open ground (the terrain's macro noise) read a
// little yellower, so a big island's hundreds of copies of a few archetypes don't look stamped. The batches are
// sized from def.nodes, so they scale with the node count. Owner: client-render.

import * as THREE from "three";
import type { IslandDef, NodeDef } from "../../../../shared/island/types";
import type { ArrayView, Vec3Like } from "../../../../shared/types";
import type { MaterialBank } from "../kit/MaterialBank";
import { fbm2, hash2 } from "../noise";
import { createToonMaterial } from "../Toon";
import { buildFloraArchetypes, type FloraArchetypes } from "./flora/archetypes";
import { createWindUniforms, injectWind } from "./wind";

const FELL_SEC = 1.05;
const SINK_SEC = 0.4;
const SHAKE_SEC = 0.45;
const POP_SEC = 0.35;
const CRUMBLE_SEC = 0.3;

type AnimType = "fell" | "shake" | "pop" | "crumble";

interface Slot {
  node: NodeDef;
  /** Batch this node's instances live in (casters or the non-casting bush batch). */
  mesh: THREE.BatchedMesh;
  /** Tree / palm / rock / bush instance. */
  main: number;
  /** Stump (tree) or pebbles (rock), -1 otherwise. */
  alt: number;
  /** Coconuts (palm, 2) or the berry cluster (berry bush, 1). */
  extras: number[];
  /** Bush geometry ids: full / bare (rope bushes swap), -1 otherwise. */
  geoFull: number;
  geoBare: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
  /** World matrices of the extras at rest. */
  extraMatrices: THREE.Matrix4[];
  amount: number;
}

interface Anim {
  slot: Slot;
  type: AnimType;
  t: number;
  /** Horizontal axis for falls / shakes. */
  ax: number;
  az: number;
  /** Pop target: extra instance index, -1 = main, -2 = alt (pebbles). */
  extra: number;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpAxis = new THREE.Vector3();
const tmpColor = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export class Flora {
  /** Trees, palms and rocks: drawn in the main pass AND in the shadow pass. */
  readonly mesh: THREE.BatchedMesh;
  /** Bushes (and their berries): grass-level clumps drawn in one extra batch that does NOT cast shadows. */
  readonly softMesh: THREE.BatchedMesh;
  /** Triangles of all node instances at full growth (budget bookkeeping). */
  readonly triangles: number;
  private readonly slots: Slot[] = [];
  private readonly anims: Anim[] = [];
  private readonly uniforms = createWindUniforms();
  /** geometry → the batch that owns it and its geometry id there. */
  private readonly idsOf = new Map<THREE.BufferGeometry, { mesh: THREE.BatchedMesh; id: number }>();
  private primed = false;
  private readonly seed: number;

  constructor(def: IslandDef, bank: MaterialBank) {
    this.seed = def.seed | 0;
    const arch = buildFloraArchetypes(def.biome, def.seed);
    for (const g of arch.all) bank.geo(g);
    const material = bank.own(createToonMaterial(0xffffff, { vertexColors: true, side: THREE.DoubleSide }));
    material.name = "flora";
    injectWind(material, this.uniforms, { from: 1.1, calm: 0.0016, storm: 0.0065, profile: "quadratic", key: "raft-flora-sway" });
    const softMaterial = bank.own(createToonMaterial(0xffffff, { vertexColors: true, side: THREE.DoubleSide }));
    softMaterial.name = "flora-soft";
    injectWind(softMaterial, this.uniforms, { from: 1.1, calm: 0.0016, storm: 0.0065, profile: "quadratic", key: "raft-flora-sway" });

    const softGeos = new Set<THREE.BufferGeometry>([...arch.bushes, ...arch.vineBushes, arch.bareBush, arch.berries]);
    let castVerts = 0;
    let softVerts = 0;
    for (const g of arch.all) (softGeos.has(g) ? (softVerts += g.getAttribute("position").count) : (castVerts += g.getAttribute("position").count));
    let instances = 0;
    let softInstances = 0;
    for (const n of def.nodes) {
      const extra = n.kind === "palm" ? 3 : 2;
      if (n.kind === "bush") softInstances += extra;
      else instances += extra;
    }
    this.mesh = new THREE.BatchedMesh(Math.max(1, instances), Math.max(1, castVerts), Math.max(2, castVerts * 2), material);
    this.mesh.name = "flora";
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.softMesh = new THREE.BatchedMesh(Math.max(1, softInstances), Math.max(1, softVerts), Math.max(2, softVerts * 2), softMaterial);
    this.softMesh.name = "flora-soft";
    // Bushes sit in the grass: their contact shadow barely reads, so they stay out of the shadow pass
    // (the shadow camera is a 22 m box; dropping them saves ~23k shadow triangles on a duel island).
    this.softMesh.castShadow = false;
    this.softMesh.receiveShadow = true;
    this.addGeometries(arch, softGeos);
    let tris = 0;
    for (const node of def.nodes) tris += this.addNode(node, arch);
    this.triangles = tris;
    this.mesh.computeBoundingSphere();
    this.softMesh.computeBoundingSphere();
  }

  /** Per frame: depletion changes, running animations, sway. */
  update(dt: number, elapsed: number, nodes: ArrayView<number>, wind: number, focus: Vec3Like): void {
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uWind.value = wind;
    const have = nodes.length > 0;
    for (const slot of this.slots) {
      const amount = have ? (nodes[slot.node.i] ?? slot.node.amount) : slot.node.amount;
      if (amount !== slot.amount) {
        const prev = slot.amount;
        slot.amount = amount;
        this.applyAmount(slot, prev, amount, this.primed, focus);
      }
    }
    this.primed = true;
    this.stepAnims(dt);
  }

  /* ------------------------------------------------------------------ build */

  private addGeometries(arch: FloraArchetypes, softGeos: ReadonlySet<THREE.BufferGeometry>): void {
    for (const g of arch.all) {
      const mesh = softGeos.has(g) ? this.softMesh : this.mesh;
      this.idsOf.set(g, { mesh, id: mesh.addGeometry(g) });
    }
  }

  private geo(geometry: THREE.BufferGeometry): { mesh: THREE.BatchedMesh; id: number } {
    const entry = this.idsOf.get(geometry);
    if (!entry) throw new Error("flora geometry was not added to a batch");
    return entry;
  }

  private addNode(node: NodeDef, arch: FloraArchetypes): number {
    const v = Math.abs(node.variant | 0);
    const s = Number.isFinite(node.scale) && node.scale > 0 ? node.scale : 1;
    const pos = new THREE.Vector3(node.x, node.y, node.z);
    const quat = new THREE.Quaternion().setFromAxisAngle(UP, Number.isFinite(node.yaw) ? node.yaw : 0);
    const scale = new THREE.Vector3(1, 1, 1);
    let mainGeo: THREE.BufferGeometry;
    let altGeo: THREE.BufferGeometry | null = null;
    let extraGeo: THREE.BufferGeometry | null = null;
    let extraSpots: THREE.Vector3[] = [];
    let geoFull = -1;
    let geoBare = -1;
    switch (node.kind) {
      case "tree": {
        mainGeo = arch.trees[v % arch.trees.length]!;
        altGeo = arch.stump;
        const k = clamp(s, 0.7, 1.4);
        // Cosmetic proportions: some trees taller and slimmer, some squat and wide.
        const tall = 0.88 + hash2(node.x, node.z, 41) * 0.26;
        scale.set(k * (1.06 - (tall - 0.88) * 0.4), k * tall, k * (1.06 - (tall - 0.88) * 0.4));
        pos.y -= 0.05;
        break;
      }
      case "palm": {
        const k = v % arch.palms.length;
        mainGeo = arch.palms[k]!;
        extraGeo = arch.coconut;
        extraSpots = arch.palmCoconuts[k]!;
        const ps = clamp(0.92 + (s - 1) * 0.35, 0.8, 1.1);
        scale.set(ps, ps * (0.9 + hash2(node.x, node.z, 43) * 0.24), ps);
        pos.y -= 0.05;
        break;
      }
      case "rock": {
        mainGeo = arch.rocks[v % arch.rocks.length]!;
        altGeo = arch.pebbles;
        const r = node.radius > 0 ? node.radius : 0.7;
        scale.set(r * 1.05, r * (0.9 + (hash2(node.x, node.z, 3) - 0.5) * 0.3), r * 1.05);
        pos.y -= 0.12 * r;
        break;
      }
      default: {
        const k = v % arch.bushes.length;
        if (node.yield === "rope") {
          mainGeo = arch.vineBushes[k]!;
          geoFull = this.geo(mainGeo).id;
          geoBare = this.geo(arch.bareBush).id;
        } else {
          mainGeo = arch.bushes[k]!;
        }
        if (node.yield === "berry") {
          extraGeo = arch.berries;
          extraSpots = [new THREE.Vector3(0, 0, 0)];
        }
        const bs = clamp(s, 0.7, 1.35);
        const wide = 0.9 + hash2(node.x, node.z, 47) * 0.22;
        scale.set(bs * wide, bs * (0.92 + hash2(node.z, node.x, 49) * 0.16), bs * wide);
        pos.y -= 0.04;
        break;
      }
    }
    const home = this.geo(mainGeo).mesh;
    const slot: Slot = {
      node,
      mesh: home,
      main: home.addInstance(this.geo(mainGeo).id),
      alt: altGeo ? home.addInstance(this.geo(altGeo).id) : -1,
      extras: [],
      geoFull,
      geoBare,
      pos,
      quat,
      scale,
      extraMatrices: [],
      amount: node.amount,
    };
    const base = tmpM.compose(pos, quat, scale);
    home.setMatrixAt(slot.main, base);
    instanceTint(node, this.seed, tmpColor);
    home.setColorAt(slot.main, tmpColor);
    if (slot.alt >= 0) {
      home.setMatrixAt(slot.alt, base);
      home.setColorAt(slot.alt, tmpColor);
      home.setVisibleAt(slot.alt, false);
    }
    if (extraGeo) {
      for (const spot of extraSpots) {
        const id = home.addInstance(this.geo(extraGeo).id);
        tmpV.copy(spot).multiply(scale).applyQuaternion(quat).add(pos);
        const m = new THREE.Matrix4().compose(tmpV, quat, scale);
        home.setMatrixAt(id, m);
        slot.extras.push(id);
        slot.extraMatrices.push(m);
      }
    }
    this.slots.push(slot);
    this.applyAmount(slot, node.amount, node.amount, false, slot.pos);
    return triCount(mainGeo) + (extraGeo ? triCount(extraGeo) * extraSpots.length : 0);
  }

  /* -------------------------------------------------------------- depletion */

  private applyAmount(slot: Slot, prev: number, amount: number, animate: boolean, focus: Vec3Like): void {
    const m = slot.mesh;
    const kind = slot.node.kind;
    if (kind === "tree") {
      if (amount <= 0) {
        m.setVisibleAt(slot.alt, true);
        if (animate && prev > 0) this.startFall(slot, focus);
        else m.setVisibleAt(slot.main, false);
      } else {
        m.setVisibleAt(slot.alt, false);
        m.setVisibleAt(slot.main, true);
        this.cancelAnims(slot, "fell");
        this.resetMain(slot);
        if (animate && prev <= 0) this.start(slot, "pop", -1);
        else if (animate && amount < prev) this.startShake(slot, focus);
      }
      return;
    }
    if (kind === "palm") {
      slot.extras.forEach((id, k) => {
        const show = k < amount;
        const was = m.getVisibleAt(id);
        m.setVisibleAt(id, show);
        if (show && !was && animate) this.start(slot, "pop", k);
        if (show) m.setMatrixAt(id, slot.extraMatrices[k]!);
      });
      if (animate && amount < prev) this.startShake(slot, focus);
      return;
    }
    if (kind === "rock") {
      if (amount <= 0) {
        if (animate && prev > 0) this.start(slot, "crumble", -1);
        else {
          m.setVisibleAt(slot.main, false);
          m.setVisibleAt(slot.alt, true);
        }
      } else {
        this.cancelAnims(slot, "crumble");
        m.setVisibleAt(slot.main, true);
        m.setVisibleAt(slot.alt, false);
        // A chipped rock is a little smaller.
        this.resetMain(slot, amount < slot.node.amount ? 0.86 : 1);
        if (animate && amount < prev) this.startShake(slot, focus);
      }
      return;
    }
    // Bush.
    if (slot.geoFull >= 0) m.setGeometryIdAt(slot.main, amount > 0 ? slot.geoFull : slot.geoBare);
    for (const id of slot.extras) {
      const show = amount > 0;
      const was = m.getVisibleAt(id);
      m.setVisibleAt(id, show);
      if (show && !was && animate) this.start(slot, "pop", 0);
    }
    if (animate && amount < prev) this.startShake(slot, focus);
  }

  private resetMain(slot: Slot, k = 1): void {
    tmpS.copy(slot.scale).multiplyScalar(k);
    slot.mesh.setMatrixAt(slot.main, tmpM.compose(slot.pos, slot.quat, tmpS));
  }

  /* ------------------------------------------------------------- animation */

  private start(slot: Slot, type: AnimType, extra: number, ax = 1, az = 0): void {
    for (const a of this.anims) {
      if (a.slot === slot && a.type === type && a.extra === extra) {
        a.t = 0;
        return;
      }
    }
    this.anims.push({ slot, type, t: 0, ax, az, extra });
  }

  private startFall(slot: Slot, focus: Vec3Like): void {
    // Fall away from whoever is nearest (the camera's player is the usual chopper).
    let dx = slot.pos.x - focus.x;
    let dz = slot.pos.z - focus.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) {
      dx = Math.cos(slot.node.yaw);
      dz = Math.sin(slot.node.yaw);
    } else {
      dx /= len;
      dz /= len;
    }
    // Rotation axis = up × fall direction.
    this.start(slot, "fell", -1, dz, -dx);
  }

  private startShake(slot: Slot, focus: Vec3Like): void {
    const dx = slot.pos.x - focus.x;
    const dz = slot.pos.z - focus.z;
    const len = Math.hypot(dx, dz) || 1;
    this.start(slot, "shake", -1, dz / len, -dx / len);
  }

  private cancelAnims(slot: Slot, type: AnimType): void {
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i]!;
      if (a.slot === slot && a.type === type) this.anims.splice(i, 1);
    }
  }

  private stepAnims(dt: number): void {
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i]!;
      a.t += dt;
      const s = a.slot;
      const m = s.mesh;
      let done = false;
      switch (a.type) {
        case "fell": {
          const u = Math.min(1, a.t / FELL_SEC);
          const angle = Math.pow(u, 2.2) * 1.48;
          const sink = a.t > FELL_SEC ? Math.min(1, (a.t - FELL_SEC) / SINK_SEC) : 0;
          tmpQ.setFromAxisAngle(tmpAxis.set(a.ax, 0, a.az), angle).multiply(s.quat);
          tmpV.copy(s.pos);
          tmpV.y -= sink * 1.2;
          tmpS.copy(s.scale).multiplyScalar(1 - sink * 0.6);
          m.setMatrixAt(s.main, tmpM.compose(tmpV, tmpQ, tmpS));
          if (sink >= 1) {
            m.setVisibleAt(s.main, false);
            this.resetMain(s);
            done = true;
          }
          break;
        }
        case "shake": {
          const u = a.t / SHAKE_SEC;
          const angle = Math.sin(a.t * 38) * 0.06 * (1 - u);
          tmpQ.setFromAxisAngle(tmpAxis.set(a.ax, 0, a.az), angle).multiply(s.quat);
          m.setMatrixAt(s.main, tmpM.compose(s.pos, tmpQ, s.scale));
          if (u >= 1) {
            this.resetMain(s, s.node.kind === "rock" && s.amount < s.node.amount ? 0.86 : 1);
            done = true;
          }
          break;
        }
        case "pop": {
          const u = Math.min(1, a.t / POP_SEC);
          const k = u < 1 ? Math.sin(u * Math.PI * 0.5) * (1 + Math.sin(u * Math.PI) * 0.25) : 1;
          if (a.extra === -1) {
            this.resetMain(s, Math.max(0.01, k));
          } else if (a.extra === -2) {
            if (s.alt >= 0) m.setMatrixAt(s.alt, tmpM.compose(s.pos, s.quat, tmpS.copy(s.scale).multiplyScalar(Math.max(0.01, k))));
          } else {
            const id = s.extras[a.extra];
            const rest = s.extraMatrices[a.extra];
            if (id !== undefined && rest) {
              rest.decompose(tmpV, tmpQ, tmpS);
              tmpS.multiplyScalar(Math.max(0.01, k));
              m.setMatrixAt(id, tmpM.compose(tmpV, tmpQ, tmpS));
            }
          }
          done = u >= 1;
          break;
        }
        case "crumble": {
          const u = Math.min(1, a.t / CRUMBLE_SEC);
          tmpS.copy(s.scale).multiplyScalar(Math.max(0.01, 1 - u));
          tmpS.y *= 1 - u * 0.4;
          m.setMatrixAt(s.main, tmpM.compose(s.pos, s.quat, tmpS));
          if (u >= 1) {
            m.setVisibleAt(s.main, false);
            m.setVisibleAt(s.alt, true);
            this.resetMain(s);
            this.start(s, "pop", -2);
            done = true;
          }
          break;
        }
      }
      if (done) this.anims.splice(this.anims.indexOf(a), 1);
    }
  }
}

/**
 * Per-instance color multiplier: value 0.8–1.03, a warm (olive) / cool (blue-green) tilt and, for plants, a dry
 * tint where the terrain's large-scale noise says open dry ground (same noise and seed as Terrain.ts' macro).
 */
function instanceTint(node: NodeDef, seed: number, out: THREE.Color): THREE.Color {
  const rock = node.kind === "rock";
  const value = (rock ? 0.86 : 0.8) + hash2(node.x, node.z, 17) * (rock ? 0.18 : 0.23);
  const tilt = (hash2(node.z, node.x, 5) - 0.5) * (rock ? 0.05 : 0.14);
  const dry = rock ? 0 : Math.max(0, Math.min(1, (fbm2(node.x * 0.022, node.z * 0.022, seed ^ 0x6c3, 3) - 0.45) * 2)) * 0.08;
  return out.setRGB(value * (1 + tilt + dry), value * (1 + dry * 0.4), value * (1 - tilt - dry * 0.6));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function triCount(g: THREE.BufferGeometry): number {
  return g.getAttribute("position").count / 3;
}
