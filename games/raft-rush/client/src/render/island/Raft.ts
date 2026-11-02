// The raft on its beach slip, growing with TeamView (game4.md §7/§12 "every delivered part shows on the raft"):
// hull logs appear with hull wood (the wreck's free part = the first logs; gnawing makes logs vanish and the raft
// shudder), cross beams + lashings when the hull is done, the mast pole rises with mast wood, rigging ropes with
// mast rope, the sail unfurls when the mast stage is done (the patched "old sail" treasure if team.sail),
// provision crates and water gourds stack up, and at stage 3 a pulsing READY halo + pennant + sparkles. During
// the launch phase the raft slides off the sand and sails away (WorldFrame.launch), bobbing and rocking.
// Owner: client-render.

import * as THREE from "three";
import { PALETTE, WATER_Y, WRECK_HULL_WOOD, type Timings } from "../../../../shared/constants";
import { heightAt } from "../../../../shared/island/heightfield";
import type { Heightfield, IslandSite } from "../../../../shared/island/types";
import { raftCost } from "../../../../shared/items";
import type { TeamView } from "../../../../shared/types";
import { Baker, composeMatrix } from "../kit/Baker";
import type { MaterialBank } from "../kit/MaterialBank";
import { smoothing } from "../noise";
import { ringTexture, sailTexture, WOOD } from "../textures";
import { createToonMaterial, getOutlineMaterial, getSmoothOutlineGeometry, glowMaterial, vertexColorToon } from "../Toon";
import { Sparkles } from "./Sparkles";

const LOGS = 8;
const LOG_SPACING = 0.38;
const LOG_LENGTH = 3.7;
const LOG_RADIUS = 0.19;
const ROPES = 4;
const CRATES = 6;
const GOURDS = 6;
const MAST_HEIGHT = 3.4;
const POP_SEC = 0.4;
/** How far the raft sails during the launch cinematic (m). */
const LAUNCH_DISTANCE = 75;

export interface RaftPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

type ShownKey = "logs" | "ropes" | "crates" | "gourds";

interface Pop {
  mesh: THREE.InstancedMesh;
  index: number;
  t: number;
}

/** What the raft shows for a team view (pure; Raft.update draws it). */
export interface RaftPieces {
  /** Hull logs 0..8 (the wreck's free part shows the first ones). */
  logs: number;
  /** Cross beams + lashings (hull complete). */
  beams: boolean;
  /** Mast pole growth 0..1 (mast wood delivered) and the yard (mast wood complete). */
  mast: number;
  yard: boolean;
  /** Rigging ropes 0..4. */
  ropes: number;
  /** Sail set (mast stage done), patched old sail (treasure). */
  sail: boolean;
  oldSail: boolean;
  /** Provision crates / water gourds on deck (0..6 each). */
  crates: number;
  gourds: number;
  /** Stage 3: READY halo, pennant, sparkles. */
  ready: boolean;
}

/** Visible raft pieces for `team` (undefined = lobby preview: just the wreck's free part). */
export function raftPieces(team: TeamView | undefined, timings: Readonly<Timings>): RaftPieces {
  const cost = raftCost(team ? team.seats : 2, timings.cheapRaft);
  const stage = team ? team.stage : 0;
  const hullFrac = stage >= 1 ? 1 : clamp01((team ? team.hullWood : WRECK_HULL_WOOD) / Math.max(1, cost.hullWood));
  const mastWood = stage >= 2 ? 1 : team ? clamp01(team.mastWood / Math.max(1, cost.mastWood)) : 0;
  const mastRope = stage >= 2 ? 1 : team ? clamp01(team.mastRope / Math.max(1, cost.mastRope)) : 0;
  return {
    logs: hullFrac <= 0 ? 0 : Math.max(1, Math.min(LOGS, Math.round(hullFrac * LOGS))),
    beams: hullFrac >= 1,
    mast: mastWood,
    yard: mastWood >= 1,
    ropes: Math.min(ROPES, Math.round(mastRope * ROPES)),
    sail: stage >= 2,
    oldSail: team ? team.sail : false,
    crates: team ? Math.min(CRATES, Math.max(0, Math.round(team.food))) : 0,
    gourds: team ? Math.min(GOURDS, Math.max(0, Math.round(team.water))) : 0,
    ready: stage >= 3,
  };
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Raft {
  readonly group = new THREE.Group();
  readonly team: number;
  private readonly root = new THREE.Group();
  private readonly grid: Heightfield;
  private readonly restPos: THREE.Vector3;
  private readonly yaw: number;
  private readonly logs: THREE.InstancedMesh;
  private readonly logOutlines: THREE.InstancedMesh;
  private readonly logRest: THREE.Matrix4[] = [];
  private readonly beams: THREE.Object3D;
  private readonly mast: THREE.Group = new THREE.Group();
  private readonly pole: THREE.Object3D;
  private readonly yard: THREE.Object3D;
  private readonly ropes: THREE.InstancedMesh;
  private readonly sail: THREE.Mesh;
  private readonly sailMats: [THREE.MeshToonMaterial, THREE.MeshToonMaterial];
  private readonly crates: THREE.InstancedMesh;
  private readonly gourds: THREE.InstancedMesh;
  private readonly crateRest: THREE.Matrix4[] = [];
  private readonly gourdRest: THREE.Matrix4[] = [];
  private readonly pennant: THREE.Mesh;
  private readonly halo: THREE.Mesh;
  private readonly haloMat: THREE.MeshBasicMaterial;
  private readonly sparkles: Sparkles;
  private readonly pops: Pop[] = [];
  private shown: Record<ShownKey, number> = { logs: -1, ropes: -1, crates: -1, gourds: -1 };
  private mastK = 0;
  private sailK = 0;
  private readyK = 0;
  private shudder = 0;
  private lastHull = -1;
  private primed = false;
  private readonly pose: RaftPose = { x: 0, y: 0, z: 0, yaw: 0 };

  constructor(grid: Heightfield, site: IslandSite, bank: MaterialBank) {
    this.team = site.team;
    this.grid = grid;
    this.group.name = `raft${site.team}`;
    this.yaw = site.raft.yaw;
    const ground = heightAt(grid, site.raft.x, site.raft.z);
    this.restPos = new THREE.Vector3(site.raft.x, Math.max(ground, WATER_Y) + LOG_RADIUS * 0.85, site.raft.z);
    this.root.position.copy(this.restPos);
    this.root.rotation.y = this.yaw;
    this.group.add(this.root);
    this.group.add(this.buildSlip(site, bank));

    // Hull logs (instanced, with an instanced ink outline).
    const logGeo = bank.geo(logGeometry());
    this.logs = new THREE.InstancedMesh(logGeo, vertexColorToon(), LOGS);
    this.logs.name = "raftLogs";
    this.logs.castShadow = true;
    this.logs.receiveShadow = true;
    this.logOutlines = new THREE.InstancedMesh(getSmoothOutlineGeometry(logGeo), getOutlineMaterial(0.025), LOGS);
    this.logOutlines.name = "outline";
    const tint = new THREE.Color();
    for (let i = 0; i < LOGS; i++) {
      // Fill from the middle out so a half-built hull still looks like a raft.
      const order = [3, 4, 2, 5, 1, 6, 0, 7][i]!;
      const x = (order - (LOGS - 1) / 2) * LOG_SPACING;
      const len = 0.92 + ((order * 37) % 10) / 100;
      const m = composeMatrix(new THREE.Vector3(x, 0, ((order * 13) % 7) * 0.025), new THREE.Euler(0, 0, order * 0.7), new THREE.Vector3(1, 1, len));
      this.logRest.push(m);
      this.logs.setMatrixAt(i, m);
      this.logOutlines.setMatrixAt(i, m);
      this.logs.setColorAt(i, tint.setScalar(0.9 + ((order * 53) % 10) / 100));
    }
    this.logs.count = 0;
    this.logOutlines.count = 0;
    this.root.add(this.logs, this.logOutlines);

    this.beams = this.bakedMesh(beamsBaker(), bank, "raftBeams");
    this.root.add(this.beams);

    // Mast: pole + yard (outlined), rigging ropes (instanced).
    this.pole = this.bakedMesh(poleBaker(), bank, "raftPole");
    this.yard = this.bakedMesh(yardBaker(), bank, "raftYard");
    this.mast.add(this.pole, this.yard);
    this.root.add(this.mast);
    const ropeGeo = bank.geo(new THREE.CylinderGeometry(0.018, 0.018, 1, 4));
    ropeGeo.translate(0, 0.5, 0);
    this.ropes = new THREE.InstancedMesh(ropeGeo, createRopeMaterial(bank), ROPES);
    this.ropes.name = "raftRopes";
    const top = new THREE.Vector3(0, MAST_HEIGHT * 0.92, 0);
    const anchors = [
      new THREE.Vector3(-1.35, 0.2, -1.6),
      new THREE.Vector3(1.35, 0.2, -1.6),
      new THREE.Vector3(-1.35, 0.2, 1.6),
      new THREE.Vector3(1.35, 0.2, 1.6),
    ];
    anchors.forEach((a, i) => {
      const dir = top.clone().sub(a);
      const len = dir.length();
      tmpQ.setFromUnitVectors(UP, dir.normalize());
      this.ropes.setMatrixAt(i, tmpM.compose(a, tmpQ, tmpS.set(1, len, 1)));
    });
    this.ropes.count = 0;
    this.root.add(this.ropes);

    // Sail (pre-billowed quad grid hanging from the yard).
    const sailGeo = bank.geo(sailGeometry());
    this.sailMats = [
      bank.own(createToonMaterial(0xffffff, { map: sailTexture(false), side: THREE.DoubleSide })),
      bank.own(createToonMaterial(0xffffff, { map: sailTexture(true), side: THREE.DoubleSide })),
    ];
    this.sail = new THREE.Mesh(sailGeo, this.sailMats[0]);
    this.sail.name = "raftSail";
    this.sail.castShadow = true;
    this.sail.position.set(0, MAST_HEIGHT * 0.88, -0.12);
    this.sail.visible = false;
    this.root.add(this.sail);

    // Provisions.
    this.crates = new THREE.InstancedMesh(bank.geo(crateBaker().build()), vertexColorToon(), CRATES);
    this.crates.name = "raftCrates";
    // Small provisions ride on the shadowed hull: skipping them removes three shadow-pass draws.
    this.crates.castShadow = false;
    this.gourds = new THREE.InstancedMesh(bank.geo(gourdBaker().build()), vertexColorToon(), GOURDS);
    this.gourds.name = "raftGourds";
    this.gourds.castShadow = false;
    for (let i = 0; i < CRATES; i++) {
      const m = composeMatrix(new THREE.Vector3(-0.9 + (i % 3) * 0.9, LOG_RADIUS, 0.75 + Math.floor(i / 3) * 0.7), new THREE.Euler(0, (i * 0.37) % 0.5 - 0.25, 0), 1);
      this.crateRest.push(m);
      this.crates.setMatrixAt(i, m);
    }
    for (let i = 0; i < GOURDS; i++) {
      const m = composeMatrix(new THREE.Vector3(-0.95 + (i % 3) * 0.95, LOG_RADIUS, -0.8 - Math.floor(i / 3) * 0.6), new THREE.Euler(0, i * 1.3, 0), 1);
      this.gourdRest.push(m);
      this.gourds.setMatrixAt(i, m);
    }
    this.crates.count = 0;
    this.gourds.count = 0;
    this.root.add(this.crates, this.gourds);

    // READY: pennant on the mast top, halo on the sand, sparkles.
    const pennantGeo = bank.geo(new THREE.BufferGeometry());
    pennantGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, -0.35, 0, 0.9, -0.17, 0], 3));
    pennantGeo.computeVertexNormals();
    this.pennant = new THREE.Mesh(pennantGeo, bank.own(createToonMaterial(PALETTE.hud, { side: THREE.DoubleSide, emissive: PALETTE.hud, emissiveIntensity: 0.35 })));
    this.pennant.position.set(0, MAST_HEIGHT + 0.05, 0);
    this.pennant.visible = false;
    this.mast.add(this.pennant);
    const haloGeo = bank.geo(new THREE.PlaneGeometry(6.4, 6.4));
    haloGeo.rotateX(-Math.PI / 2);
    this.haloMat = bank.own(glowMaterial(PALETTE.hud, 0.6, ringTexture()).clone());
    this.halo = new THREE.Mesh(haloGeo, this.haloMat);
    this.halo.position.copy(this.restPos).setY(this.restPos.y - LOG_RADIUS + 0.06);
    this.halo.renderOrder = 2;
    this.halo.visible = false;
    this.group.add(this.halo);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 10; i++) pts.push(new THREE.Vector3(Math.cos(i * 2.1) * 1.6, 0.5 + (i % 4) * 0.7, Math.sin(i * 2.1) * 1.9));
    this.sparkles = new Sparkles(pts, PALETTE.hud, 30, bank);
    this.root.add(this.sparkles.object);
    this.applyMast(0, false);
  }

  /** Current raft pose (moves during the launch). */
  getPose(): Readonly<RaftPose> {
    return this.pose;
  }

  /** Per frame from the team view; `launch` 0..1 sails it away. */
  update(dt: number, elapsed: number, team: TeamView | undefined, timings: Readonly<Timings>, launch: number, waveAmp: number, pixelRatio: number): void {
    const pieces = raftPieces(team, timings);
    const hullWood = team ? team.hullWood : 0;
    if (this.primed && hullWood < this.lastHull && !pieces.beams) this.shudder = 1;
    this.lastHull = hullWood;

    this.setCount(this.logs, pieces.logs, "logs", [this.logOutlines]);
    this.setCount(this.ropes, pieces.ropes, "ropes");
    this.setCount(this.crates, pieces.crates, "crates");
    this.setCount(this.gourds, pieces.gourds, "gourds");
    this.primed = true;
    this.beams.visible = pieces.beams;

    this.mastK += (pieces.mast - this.mastK) * smoothing(5, dt);
    this.sailK += ((pieces.sail ? 1 : 0) - this.sailK) * smoothing(2.2, dt);
    this.applyMast(this.mastK, pieces.yard);
    this.sail.material = pieces.oldSail ? this.sailMats[1] : this.sailMats[0];
    const ready = pieces.ready;
    this.readyK += ((ready ? 1 : 0) - this.readyK) * smoothing(3, dt);

    // Sail unfurl + billow (stronger at sea / in the storm).
    this.sail.visible = this.sailK > 0.02;
    if (this.sail.visible) {
      const gust = 1 + Math.sin(elapsed * 1.7) * 0.06 + launch * 0.25 + waveAmp * 0.1;
      this.sail.scale.set(1, Math.max(0.02, this.sailK), gust);
    }
    this.pennant.visible = this.readyK > 0.05;
    if (this.pennant.visible) {
      this.pennant.scale.set(this.readyK, 1, 1);
      this.pennant.rotation.y = Math.sin(elapsed * 3.1) * 0.35 + 0.4;
    }
    this.halo.visible = this.readyK > 0.02 && launch <= 0.02;
    this.haloMat.opacity = this.readyK * (0.35 + 0.25 * Math.sin(elapsed * 3.2));
    this.halo.scale.setScalar(1 + Math.sin(elapsed * 3.2) * 0.04);
    this.sparkles.update(elapsed, this.readyK);
    this.sparkles.setPixelRatio(pixelRatio);
    this.stepPops(dt);

    // Pose: rest on the slip, shudder when gnawed, sail away on launch.
    this.shudder = Math.max(0, this.shudder - dt * 2.2);
    const shake = this.shudder > 0 ? Math.sin(elapsed * 46) * 0.035 * this.shudder : 0;
    const p = clamp01(launch);
    const dist = p * p * (3 - 2 * p) * LAUNCH_DISTANCE;
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const x = this.restPos.x + fx * dist;
    const z = this.restPos.z + fz * dist;
    const ground = heightAt(this.grid, x, z);
    const afloat = Math.min(1, Math.max(0, (WATER_Y - ground) / 0.4));
    const bob = afloat * (Math.sin(elapsed * 1.6) * 0.08 + Math.sin(elapsed * 2.7 + 1) * 0.04) * (1 + waveAmp * 1.5);
    const y = Math.max(ground + LOG_RADIUS * 0.85, WATER_Y + 0.08) + bob;
    this.root.position.set(x, p > 0 ? y : this.restPos.y, z);
    this.root.rotation.set(
      afloat * Math.sin(elapsed * 1.3) * 0.05 * (1 + waveAmp) + shake,
      this.yaw + afloat * Math.sin(elapsed * 0.5) * 0.04,
      afloat * Math.sin(elapsed * 1.1 + 0.6) * 0.06 * (1 + waveAmp) - shake,
      "YXZ",
    );
    this.pose.x = this.root.position.x;
    this.pose.y = this.root.position.y;
    this.pose.z = this.root.position.z;
    this.pose.yaw = this.yaw;
  }

  /* ------------------------------------------------------------------ build */

  private bakedMesh(b: Baker, bank: MaterialBank, name: string): THREE.Mesh {
    const geo = bank.geo(b.build());
    const mesh = new THREE.Mesh(geo, vertexColorToon());
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const outline = new THREE.Mesh(getSmoothOutlineGeometry(geo), getOutlineMaterial(0.025));
    outline.name = "outline";
    outline.userData.isOutline = true;
    mesh.add(outline);
    return mesh;
  }

  /** Stakes and a rope outline marking the slip on the sand (where to deliver). */
  private buildSlip(site: IslandSite, bank: MaterialBank): THREE.Object3D {
    const b = new Baker();
    const hx = (LOGS * LOG_SPACING) / 2 + 0.3;
    const hz = LOG_LENGTH / 2 + 0.3;
    const corners = [
      [-hx, -hz],
      [hx, -hz],
      [hx, hz],
      [-hx, hz],
    ] as const;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const groundAt = (lx: number, lz: number) => {
      const wx = site.raft.x + lx * c + lz * s;
      const wz = site.raft.z - lx * s + lz * c;
      return heightAt(this.grid, wx, wz) - this.restPos.y;
    };
    for (const [x, z] of corners) {
      const gy = groundAt(x, z);
      b.addAt(new THREE.CylinderGeometry(0.05, 0.07, 0.7, 5), WOOD.dark, new THREE.Vector3(x, gy + 0.25, z), new THREE.Euler(0.05, 0, -0.06), 1, true);
    }
    for (let k = 0; k < 4; k++) {
      const [ax, az] = corners[k]!;
      const [bx, bz] = corners[(k + 1) % 4]!;
      const len = Math.hypot(bx - ax, bz - az);
      const mid = new THREE.Vector3((ax + bx) / 2, (groundAt(ax, az) + groundAt(bx, bz)) / 2 + 0.42, (az + bz) / 2);
      const q = new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(bx - ax, 0, bz - az).normalize());
      b.add(new THREE.CylinderGeometry(0.02, 0.02, len, 4), "#C9A15A", new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)), true);
    }
    const mesh = new THREE.Mesh(bank.geo(b.build()), vertexColorToon());
    mesh.name = "raftSlip";
    mesh.position.copy(this.restPos);
    mesh.rotation.y = this.yaw;
    mesh.castShadow = false;
    return mesh;
  }

  private applyMast(k: number, yard: boolean): void {
    this.pole.visible = k > 0.02;
    this.pole.scale.set(1, Math.max(0.02, k), 1);
    this.yard.visible = yard && k > 0.95;
  }

  private setCount(mesh: THREE.InstancedMesh, count: number, key: ShownKey, mirrors: THREE.InstancedMesh[] = []): void {
    const prev = this.shown[key];
    if (count === prev) return;
    this.shown[key] = count;
    mesh.count = count;
    for (const m of mirrors) m.count = count;
    if (this.primed && prev >= 0 && count > prev) {
      for (let i = prev; i < count; i++) this.pops.push({ mesh, index: i, t: 0 });
    }
  }

  private restFor(mesh: THREE.InstancedMesh, index: number): THREE.Matrix4 | null {
    if (mesh === this.logs) return this.logRest[index] ?? null;
    if (mesh === this.crates) return this.crateRest[index] ?? null;
    if (mesh === this.gourds) return this.gourdRest[index] ?? null;
    return null;
  }

  private stepPops(dt: number): void {
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const pop = this.pops[i]!;
      pop.t += dt;
      const u = Math.min(1, pop.t / POP_SEC);
      const rest = this.restFor(pop.mesh, pop.index);
      if (rest) {
        // Drop in from above with a squash on landing.
        rest.decompose(tmpV, tmpQ, tmpS);
        const k = u < 1 ? 0.6 + 0.4 * Math.sin(u * Math.PI * 0.5) + Math.sin(u * Math.PI) * 0.15 : 1;
        tmpV.y += (1 - u) * (1 - u) * 1.2;
        tmpS.multiplyScalar(k);
        tmpM.compose(tmpV, tmpQ, tmpS);
        pop.mesh.setMatrixAt(pop.index, tmpM);
        pop.mesh.instanceMatrix.needsUpdate = true;
        if (pop.mesh === this.logs) {
          this.logOutlines.setMatrixAt(pop.index, tmpM);
          this.logOutlines.instanceMatrix.needsUpdate = true;
        }
      }
      if (u >= 1) this.pops.splice(i, 1);
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function createRopeMaterial(bank: MaterialBank): THREE.MeshToonMaterial {
  return bank.own(createToonMaterial("#C9A15A"));
}

/** One log along Z with lighter cut ends and a couple of bark rings. */
function logGeometry(): THREE.BufferGeometry {
  const b = new Baker();
  b.addAt(new THREE.CylinderGeometry(LOG_RADIUS, LOG_RADIUS * 1.04, LOG_LENGTH, 7), WOOD.mid, new THREE.Vector3(0, 0, 0), new THREE.Euler(Math.PI / 2, 0, 0), 1, true);
  for (const z of [-LOG_LENGTH / 2, LOG_LENGTH / 2]) {
    b.addAt(new THREE.CylinderGeometry(LOG_RADIUS * 0.85, LOG_RADIUS * 0.85, 0.03, 7), "#E0B98A", new THREE.Vector3(0, 0, z), new THREE.Euler(Math.PI / 2, 0, 0), 1, true);
  }
  for (const z of [-1.1, 1.1]) {
    b.addAt(new THREE.CylinderGeometry(LOG_RADIUS * 1.06, LOG_RADIUS * 1.06, 0.12, 7), "#C9A15A", new THREE.Vector3(0, 0, z), new THREE.Euler(Math.PI / 2, 0, 0), 1, true);
  }
  return b.build();
}

function beamsBaker(): Baker {
  const b = new Baker();
  const w = LOGS * LOG_SPACING + 0.2;
  for (const z of [-1.15, 1.15]) {
    b.addAt(new THREE.BoxGeometry(w, 0.12, 0.2), WOOD.dark, new THREE.Vector3(0, LOG_RADIUS + 0.04, z), null, 1, true);
  }
  // A little steering oar at the stern (+Z) and a mast step block.
  b.addAt(new THREE.BoxGeometry(0.08, 0.08, 2.0), WOOD.light, new THREE.Vector3(0.9, LOG_RADIUS + 0.3, 2.3), new THREE.Euler(0.35, 0, 0), 1, true);
  b.addAt(new THREE.BoxGeometry(0.28, 0.04, 0.6), WOOD.light, new THREE.Vector3(0.9, LOG_RADIUS - 0.05, 3.2), new THREE.Euler(0.35, 0, 0), 1, true);
  b.addAt(new THREE.BoxGeometry(0.4, 0.14, 0.4), WOOD.dark, new THREE.Vector3(0, LOG_RADIUS + 0.06, 0), null, 1, true);
  return b;
}

function poleBaker(): Baker {
  const b = new Baker();
  b.addAt(new THREE.CylinderGeometry(0.07, 0.1, MAST_HEIGHT, 6), WOOD.light, new THREE.Vector3(0, MAST_HEIGHT / 2 + LOG_RADIUS, 0), null, 1, true);
  return b;
}

function yardBaker(): Baker {
  const b = new Baker();
  b.addAt(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 5), WOOD.light, new THREE.Vector3(0, MAST_HEIGHT * 0.9 + LOG_RADIUS, -0.1), new THREE.Euler(0, 0, Math.PI / 2), 1, true);
  b.addAt(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 6), "#C9A15A", new THREE.Vector3(0, MAST_HEIGHT * 0.9 + LOG_RADIUS, 0), null, 1, true);
  return b;
}

/** Sail hanging below the yard (y from 0 down to -2.3), billowed toward -Z (the sea). */
function sailGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(2.2, 2.3, 6, 6);
  g.translate(0, -1.15, 0);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / 1.1;
    const y = -pos.getY(i) / 2.3;
    pos.setZ(i, -(1 - x * x) * Math.sin(Math.PI * Math.min(1, y * 0.9 + 0.1)) * 0.38);
  }
  g.computeVertexNormals();
  return g;
}

function crateBaker(): Baker {
  const b = new Baker();
  b.addAt(new THREE.BoxGeometry(0.55, 0.42, 0.45), WOOD.light, new THREE.Vector3(0, 0.21, 0), null, 1, true);
  b.addAt(new THREE.BoxGeometry(0.57, 0.06, 0.47), WOOD.dark, new THREE.Vector3(0, 0.36, 0), null, 1, true);
  b.addAt(new THREE.BoxGeometry(0.57, 0.06, 0.47), WOOD.dark, new THREE.Vector3(0, 0.08, 0), null, 1, true);
  // Food on top: a coconut and a fish tail sticking out.
  b.addAt(new THREE.IcosahedronGeometry(0.11, 0), "#6B4A2B", new THREE.Vector3(-0.12, 0.47, 0.05), null, 1, true);
  b.addAt(new THREE.ConeGeometry(0.07, 0.16, 4), "#5FA8D3", new THREE.Vector3(0.14, 0.48, -0.05), new THREE.Euler(0, 0, -0.9), 1, true);
  return b;
}

function gourdBaker(): Baker {
  const b = new Baker();
  b.addAt(new THREE.SphereGeometry(0.17, 8, 6), "#D9C46A", new THREE.Vector3(0, 0.17, 0), null, 1, true);
  b.addAt(new THREE.SphereGeometry(0.1, 7, 5), "#CDB85E", new THREE.Vector3(0, 0.38, 0), null, 1, true);
  b.addAt(new THREE.CylinderGeometry(0.035, 0.04, 0.08, 5), "#7A4E2D", new THREE.Vector3(0, 0.5, 0), null, 1, true);
  b.addAt(new THREE.TorusGeometry(0.1, 0.018, 3, 8), "#C9A15A", new THREE.Vector3(0, 0.29, 0), new THREE.Euler(Math.PI / 2, 0, 0), 1, true);
  return b;
}
