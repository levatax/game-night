// The raft on its beach slip, growing with TeamView (game4.md §7/§12 "every delivered part shows on the raft"; Long
// Tide §3: six build stages + the launch). The keel's logs appear as its materials come in and its assembly runs,
// cross beams (the deck) once the deck is assembled, the mast pole rises with the mast's progress (yard once it is
// up), rigging ropes with the sail stage, the sail unfurls when the sail is rigged (patched canvas once the
// rudder is fitted), provision crates (cooked food) and water barrels stack up, and on the launch stage a pulsing
// READY halo + pennant + sparkles. The raft shudders when it loses hp or a stage. During the launch phase the raft
// slides off the sand and sails away (WorldFrame.launch) riding the drawn sea: the shared wave surface
// (waves.ts) is sampled at four hull points (bow, stern, port, starboard) for heave, pitch and roll, each followed
// by a critically damped spring (frame-rate independent), so the raft lags and settles like a heavy thing on
// water; the push-off dips the bow into the water and the storm rocks it harder. The sail billows with the
// same gust field the palms sway in (wind.ts). Owner: client-render.

import * as THREE from "three";
import { PALETTE, RAFT_LAUNCH_STAGE, WATER_Y, type Timings } from "../../../../shared/constants";
import { heightAt } from "../../../../shared/island/heightfield";
import type { Heightfield, IslandSite } from "../../../../shared/island/types";
import type { TeamView } from "../../../../shared/types";
import { Baker, composeMatrix } from "../kit/Baker";
import type { MaterialBank } from "../kit/MaterialBank";
import { smoothing } from "../noise";
import { ringTexture, sailTexture, WOOD } from "../textures";
import { createToonMaterial, getOutlineMaterial, getSmoothOutlineGeometry, glowMaterial, vertexColorToon } from "../Toon";
import { Sparkles } from "./Sparkles";
import { waveAttenuation, waveHeightAt } from "./waves";
import { gustAt } from "./wind";

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
/** Buoyancy: hull sample half-length / half-width (m), spring rates (rad/s: higher = stiffer), angle limit. */
const HULL_HALF_LENGTH = LOG_LENGTH * 0.5;
const HULL_HALF_WIDTH = (LOGS * LOG_SPACING) * 0.5;
const HEAVE_RATE = 3.2;
const TILT_RATE = 2.6;
const MAX_TILT = 0.32;
/** How deep the loaded raft floats (m above its log axis at the waterline). */
const FREEBOARD = 0.08;

export interface RaftPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Bow-up pitch and starboard-down roll (rad) while afloat (optional: 0 on the slip). */
  pitch?: number;
  roll?: number;
}

/** A critically damped spring toward `target` (exact step, frame-rate independent). */
export interface Spring {
  x: number;
  v: number;
}

export function stepSpring(s: Spring, target: number, rate: number, dt: number): void {
  const d = s.x - target;
  const e = Math.exp(-rate * dt);
  const k = (s.v + rate * d) * dt;
  s.x = target + (d + k) * e;
  s.v = (s.v - rate * k) * e;
}

type ShownKey = "logs" | "ropes" | "crates" | "gourds";

interface Pop {
  kind: "log" | "crate" | "gourd";
  index: number;
  t: number;
}

/** What the raft shows for a team view (pure; Raft.update draws it). */
export interface RaftPieces {
  /** Keel logs 0..8. */
  logs: number;
  /** Cross beams + lashings (deck assembled). */
  beams: boolean;
  /** Mast pole growth 0..1 (mast stage progress) and the yard (mast assembled). */
  mast: number;
  yard: boolean;
  /** Rigging ropes 0..4 (sail stage progress). */
  ropes: number;
  /** Sail set (sail stage assembled), patched canvas (rudder fitted). */
  sail: boolean;
  oldSail: boolean;
  /** Provision crates / water barrels on deck (0..6 each). */
  crates: number;
  gourds: number;
  /** Launch stage: READY halo, pennant, sparkles. */
  ready: boolean;
}

/**
 * Progress 0..1 of build stage `s` for `team`: 1 once assembled, 0 before it is current; the current stage counts
 * its delivered materials (first half) and its assembly work (second half).
 */
export function raftStageProgress(team: TeamView, s: number): number {
  if (team.stage > s) return 1;
  if (team.stage < s) return 0;
  let have = 0;
  let need = 0;
  for (let i = 0; i < 3; i++) {
    const n = team.raftNeed[i] ?? 0;
    need += n;
    have += Math.min(n, team.raftHave[i] ?? 0);
  }
  const mat = need > 0 ? have / need : 0;
  const work = team.raftWorkNeed > 0 ? team.raftWork / team.raftWorkNeed : 0;
  return clamp01(mat * 0.5 + work * 0.5);
}

/** Visible raft pieces for `team` (undefined = lobby preview: the empty slip). `timings` kept for callers. */
export function raftPieces(team: TeamView | undefined, _timings: Readonly<Timings>): RaftPieces {
  if (!team) return { logs: 0, beams: false, mast: 0, yard: false, ropes: 0, sail: false, oldSail: false, crates: 0, gourds: 0, ready: false };
  const keel = raftStageProgress(team, 0);
  const deck = raftStageProgress(team, 1);
  const mast = raftStageProgress(team, 2);
  const sail = raftStageProgress(team, 3);
  const food = team.stage > 5 ? CRATES : team.stage === 5 ? Math.min(CRATES, team.raftHave[0] ?? 0) : 0;
  const barrels = team.stage > 5 ? GOURDS : team.stage === 5 ? Math.min(GOURDS, (team.raftHave[1] ?? 0) * 2) : 0;
  return {
    logs: keel <= 0 ? 0 : Math.max(1, Math.min(LOGS, Math.round(keel * LOGS))),
    beams: deck >= 1,
    mast,
    yard: mast >= 1,
    ropes: Math.min(ROPES, Math.round(sail * ROPES)),
    sail: sail >= 1,
    oldSail: team.stage > 4,
    crates: food,
    gourds: barrels,
    ready: team.stage >= RAFT_LAUNCH_STAGE,
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
  /** Hull logs + cross beams + crates + gourds in one BatchedMesh: one draw instead of five. */
  private readonly hull: THREE.BatchedMesh;
  /** The same hull parts' ink hull in one second batch (logs + beams only). */
  private readonly hullOutline: THREE.BatchedMesh;
  private readonly hullLogIds: number[] = [];
  private readonly hullCrateIds: number[] = [];
  private readonly hullGourdIds: number[] = [];
  private readonly hullLogOutlineIds: number[] = [];
  private hullBeamId = -1;
  private hullBeamOutlineId = -1;
  private readonly logRest: THREE.Matrix4[] = [];
  private readonly mast: THREE.Group = new THREE.Group();
  private readonly pole: THREE.Object3D;
  private readonly yard: THREE.Object3D;
  private readonly ropes: THREE.InstancedMesh;
  private readonly sail: THREE.Mesh;
  private readonly sailMats: [THREE.MeshToonMaterial, THREE.MeshToonMaterial];
  private readonly crateRest: THREE.Matrix4[] = [];
  private readonly gourdRest: THREE.Matrix4[] = [];
  private readonly pennant: THREE.Mesh;
  private readonly halo: THREE.Mesh;
  private readonly haloMat: THREE.MeshBasicMaterial;
  private readonly sparkles: Sparkles;
  private readonly pops: Pop[] = [];
  private shown: Record<ShownKey, number> = { logs: -1, ropes: -1, crates: -1, gourds: -1 };
  private beamsShown: boolean | null = null;
  private mastK = 0;
  private sailK = 0;
  private readyK = 0;
  private shudder = 0;
  private lastHull = -1;
  private primed = false;
  private readonly pose: RaftPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  private readonly heave: Spring = { x: 0, v: 0 };
  private readonly pitch: Spring = { x: 0, v: 0 };
  private readonly roll: Spring = { x: 0, v: 0 };
  /** Afloat fraction last frame (the push-off splash-in impulse fires when it crosses ½). */
  private lastAfloat = 0;
  private wasLaunching = false;

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

    // Hull logs, cross beams, provision crates and gourds in ONE BatchedMesh (all vertex-colored toon):
    // five draws per raft become one, plus a single batched ink outline instead of two.
    const logGeo = logGeometry();
    const beamsGeo = beamsBaker().build();
    const crateGeo = crateBaker().build();
    const gourdGeo = gourdBaker().build();
    const logOutlineGeo = getSmoothOutlineGeometry(logGeo);
    const beamsOutlineGeo = getSmoothOutlineGeometry(beamsGeo);
    const hullVerts = vertexCount(logGeo) + vertexCount(beamsGeo) + vertexCount(crateGeo) + vertexCount(gourdGeo);
    const hullIndices = indexCount(logGeo) + indexCount(beamsGeo) + indexCount(crateGeo) + indexCount(gourdGeo);
    this.hull = new THREE.BatchedMesh(LOGS + 1 + CRATES + GOURDS, hullVerts, Math.max(hullVerts * 2, hullIndices), vertexColorToon());
    this.hull.name = "raftHull";
    this.hull.castShadow = true;
    this.hull.receiveShadow = true;
    const outlineVerts = vertexCount(logOutlineGeo) + vertexCount(beamsOutlineGeo);
    const outlineIndices = indexCount(logOutlineGeo) + indexCount(beamsOutlineGeo);
    this.hullOutline = new THREE.BatchedMesh(LOGS + 1, Math.max(outlineVerts, outlineIndices), Math.max(outlineIndices, outlineVerts), getOutlineMaterial(0.025));
    this.hullOutline.name = "outline";
    this.hullOutline.userData.isOutline = true;
    this.hullOutline.castShadow = false;
    this.hullOutline.receiveShadow = false;
    const logId = this.hull.addGeometry(logGeo);
    const beamId = this.hull.addGeometry(beamsGeo);
    const crateId = this.hull.addGeometry(crateGeo);
    const gourdId = this.hull.addGeometry(gourdGeo);
    const logOutlineId = this.hullOutline.addGeometry(logOutlineGeo);
    const beamOutlineId = this.hullOutline.addGeometry(beamsOutlineGeo);
    const tint = new THREE.Color();
    for (let i = 0; i < LOGS; i++) {
      // Fill from the middle out so a half-built hull still looks like a raft.
      const order = [3, 4, 2, 5, 1, 6, 0, 7][i]!;
      const x = (order - (LOGS - 1) / 2) * LOG_SPACING;
      const len = 0.92 + ((order * 37) % 10) / 100;
      const m = composeMatrix(new THREE.Vector3(x, 0, ((order * 13) % 7) * 0.025), new THREE.Euler(0, 0, order * 0.7), new THREE.Vector3(1, 1, len));
      this.logRest.push(m);
      const id = this.hull.addInstance(logId);
      this.hull.setMatrixAt(id, m);
      this.hull.setColorAt(id, tint.setScalar(0.9 + ((order * 53) % 10) / 100));
      this.hull.setVisibleAt(id, false);
      this.hullLogIds.push(id);
      const outline = this.hullOutline.addInstance(logOutlineId);
      this.hullOutline.setMatrixAt(outline, m);
      this.hullOutline.setVisibleAt(outline, false);
      this.hullLogOutlineIds.push(outline);
    }
    this.hullBeamId = this.hull.addInstance(beamId);
    this.hull.setMatrixAt(this.hullBeamId, IDENTITY_MATRIX);
    this.hull.setVisibleAt(this.hullBeamId, false);
    this.hullBeamOutlineId = this.hullOutline.addInstance(beamOutlineId);
    this.hullOutline.setMatrixAt(this.hullBeamOutlineId, IDENTITY_MATRIX);
    this.hullOutline.setVisibleAt(this.hullBeamOutlineId, false);
    for (let i = 0; i < CRATES; i++) {
      const m = composeMatrix(new THREE.Vector3(-0.9 + (i % 3) * 0.9, LOG_RADIUS, 0.75 + Math.floor(i / 3) * 0.7), new THREE.Euler(0, (i * 0.37) % 0.5 - 0.25, 0), 1);
      this.crateRest.push(m);
      const id = this.hull.addInstance(crateId);
      this.hull.setMatrixAt(id, m);
      this.hull.setVisibleAt(id, false);
      this.hullCrateIds.push(id);
    }
    for (let i = 0; i < GOURDS; i++) {
      const m = composeMatrix(new THREE.Vector3(-0.95 + (i % 3) * 0.95, LOG_RADIUS, -0.8 - Math.floor(i / 3) * 0.6), new THREE.Euler(0, i * 1.3, 0), 1);
      this.gourdRest.push(m);
      const id = this.hull.addInstance(gourdId);
      this.hull.setMatrixAt(id, m);
      this.hull.setVisibleAt(id, false);
      this.hullGourdIds.push(id);
    }
    this.root.add(this.hull, this.hullOutline);

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

    // Provisions live in the hull batch above (they ride the shadowed hull: no extra shadow draws).

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
    // Shudder when the raft loses hp or a stage (gnawing, puffers, Captain Crab).
    const health = team ? team.stage * 1000 + team.raftHp : 0;
    if (this.primed && health < this.lastHull) this.shudder = 1;
    this.lastHull = health;

    this.setCount("logs", pieces.logs);
    this.setCount("ropes", pieces.ropes);
    this.setCount("crates", pieces.crates);
    this.setCount("gourds", pieces.gourds);
    this.primed = true;
    if (this.beamsShown !== pieces.beams) {
      this.beamsShown = pieces.beams;
      this.hull.setVisibleAt(this.hullBeamId, pieces.beams);
      this.hullOutline.setVisibleAt(this.hullBeamOutlineId, pieces.beams);
    }

    this.mastK += (pieces.mast - this.mastK) * smoothing(5, dt);
    this.sailK += ((pieces.sail ? 1 : 0) - this.sailK) * smoothing(2.2, dt);
    this.applyMast(this.mastK, pieces.yard);
    this.sail.material = pieces.oldSail ? this.sailMats[1] : this.sailMats[0];
    const ready = pieces.ready;
    this.readyK += ((ready ? 1 : 0) - this.readyK) * smoothing(3, dt);

    // Sail unfurl + billow with the local gust (stronger at sea / in the storm).
    this.sail.visible = this.sailK > 0.02;
    if (this.sail.visible) {
      const wind = Math.min(1, 0.25 + waveAmp * 0.6);
      const gust = 0.94 + gustAt(this.pose.x, this.pose.z, elapsed, wind) * 0.16 + launch * 0.25 + waveAmp * 0.08;
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
    this.stepPose(dt, elapsed, launch, waveAmp);
  }

  /** Pose: rest on the slip, shudder when gnawed, slide off and ride the waves on launch. */
  private stepPose(dt: number, elapsed: number, launch: number, waveAmp: number): void {
    const step = Math.max(0, Math.min(dt, 0.1));
    this.shudder = Math.max(0, this.shudder - step * 2.2);
    const shake = this.shudder > 0 ? Math.sin(elapsed * 46) * 0.035 * this.shudder : 0;
    const p = clamp01(launch);
    const launching = p > 0;
    if (launching && !this.wasLaunching) {
      // Fresh launch: springs start at rest on the slip.
      this.heave.x = this.restPos.y;
      this.heave.v = 0;
      this.pitch.x = this.pitch.v = this.roll.x = this.roll.v = 0;
      this.lastAfloat = 0;
    }
    this.wasLaunching = launching;
    if (!launching) {
      this.root.position.copy(this.restPos);
      this.root.rotation.set(shake, this.yaw, -shake, "YXZ");
      this.writePose(0, 0);
      return;
    }

    const dist = p * p * (3 - 2 * p) * LAUNCH_DISTANCE;
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    // Right-hand side of the hull (log row axis) on XZ.
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const x = this.restPos.x + fx * dist;
    const z = this.restPos.z + fz * dist;
    const ground = heightAt(this.grid, x, z);
    const afloat = clamp01((WATER_Y - ground) / 0.45);

    // Four hull samples of the drawn surface (bow, stern, port, starboard).
    const bow = this.surface(x + fx * HULL_HALF_LENGTH, z + fz * HULL_HALF_LENGTH, elapsed, waveAmp);
    const stern = this.surface(x - fx * HULL_HALF_LENGTH, z - fz * HULL_HALF_LENGTH, elapsed, waveAmp);
    const port = this.surface(x - rx * HULL_HALF_WIDTH, z - rz * HULL_HALF_WIDTH, elapsed, waveAmp);
    const star = this.surface(x + rx * HULL_HALF_WIDTH, z + rz * HULL_HALF_WIDTH, elapsed, waveAmp);
    const water = (bow + stern + port + star) * 0.25;
    const storm = Math.min(1, Math.max(0, (waveAmp - 0.25) / 0.85));
    const gain = 1.1 + storm * 0.7;
    const pitchT = clampAbs(Math.atan2(bow - stern, HULL_HALF_LENGTH * 2) * gain, MAX_TILT) * afloat;
    const rollT = clampAbs(Math.atan2(port - star, HULL_HALF_WIDTH * 2) * gain, MAX_TILT) * afloat;
    const floatY = water + LOG_RADIUS * 0.85 - FREEBOARD;
    const sandY = ground + LOG_RADIUS * 0.85;
    const heaveT = Math.max(sandY, floatY * afloat + sandY * (1 - afloat));

    // Push-off: the moment the hull floats it shoves into the water (dip + bow down), then the springs bring it up.
    if (afloat >= 0.5 && this.lastAfloat < 0.5) {
      this.heave.v -= 0.9;
      this.pitch.v -= 0.35;
    }
    this.lastAfloat = afloat;
    stepSpring(this.heave, heaveT, HEAVE_RATE, step);
    stepSpring(this.pitch, pitchT, TILT_RATE, step);
    stepSpring(this.roll, rollT, TILT_RATE * 1.15, step);
    // Never sink into the sand below the hull.
    if (this.heave.x < sandY - 0.05) {
      this.heave.x = sandY - 0.05;
      if (this.heave.v < 0) this.heave.v = 0;
    }

    this.root.position.set(x, this.heave.x, z);
    // Euler YXZ: +x raises the bow (local −Z), −z lowers the starboard side (local +X).
    this.root.rotation.set(this.pitch.x + shake, this.yaw + afloat * Math.sin(elapsed * 0.45) * 0.03, -this.roll.x - shake, "YXZ");
    this.writePose(this.pitch.x, this.roll.x);
  }

  /** The drawn water surface height under a hull point. */
  private surface(x: number, z: number, t: number, amp: number): number {
    const depth = WATER_Y - heightAt(this.grid, x, z);
    return WATER_Y + waveHeightAt(x, z, t, amp) * waveAttenuation(depth);
  }

  private writePose(pitch: number, roll: number): void {
    this.pose.x = this.root.position.x;
    this.pose.y = this.root.position.y;
    this.pose.z = this.root.position.z;
    this.pose.yaw = this.yaw;
    this.pose.pitch = pitch;
    this.pose.roll = roll;
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

  /** Show the first `count` pieces of a hull kind (logs / crates / gourds) or of the ropes. */
  private setCount(key: ShownKey, count: number): void {
    const prev = this.shown[key];
    if (count === prev) return;
    this.shown[key] = count;
    if (key === "ropes") {
      this.ropes.count = count;
    } else {
      const ids = key === "logs" ? this.hullLogIds : key === "crates" ? this.hullCrateIds : this.hullGourdIds;
      for (let i = 0; i < ids.length; i++) this.hull.setVisibleAt(ids[i]!, i < count);
      if (key === "logs") for (let i = 0; i < this.hullLogOutlineIds.length; i++) this.hullOutline.setVisibleAt(this.hullLogOutlineIds[i]!, i < count);
    }
    if (this.primed && prev >= 0 && count > prev) {
      const kind = key === "logs" ? "log" : key === "crates" ? "crate" : key === "gourds" ? "gourd" : null;
      if (kind) for (let i = prev; i < count; i++) this.pops.push({ kind, index: i, t: 0 });
    }
  }

  /** Rest matrix of a hull instance (pop animation start). */
  private restFor(kind: Pop["kind"], index: number): THREE.Matrix4 | null {
    if (kind === "log") return this.logRest[index] ?? null;
    if (kind === "crate") return this.crateRest[index] ?? null;
    return this.gourdRest[index] ?? null;
  }

  private instanceId(kind: Pop["kind"], index: number): number {
    const ids = kind === "log" ? this.hullLogIds : kind === "crate" ? this.hullCrateIds : this.hullGourdIds;
    return ids[index] ?? -1;
  }

  private stepPops(dt: number): void {
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const pop = this.pops[i]!;
      pop.t += dt;
      const u = Math.min(1, pop.t / POP_SEC);
      const rest = this.restFor(pop.kind, pop.index);
      const id = this.instanceId(pop.kind, pop.index);
      if (rest && id >= 0) {
        // Drop in from above with a squash on landing.
        rest.decompose(tmpV, tmpQ, tmpS);
        const k = u < 1 ? 0.6 + 0.4 * Math.sin(u * Math.PI * 0.5) + Math.sin(u * Math.PI) * 0.15 : 1;
        tmpV.y += (1 - u) * (1 - u) * 1.2;
        tmpS.multiplyScalar(k);
        tmpM.compose(tmpV, tmpQ, tmpS);
        this.hull.setMatrixAt(id, tmpM);
        if (pop.kind === "log") {
          const outline = this.hullLogOutlineIds[pop.index];
          if (outline !== undefined) this.hullOutline.setMatrixAt(outline, tmpM);
        }
      }
      if (u >= 1) this.pops.splice(i, 1);
    }
  }
}

const IDENTITY_MATRIX = new THREE.Matrix4();

function vertexCount(g: THREE.BufferGeometry): number {
  return g.getAttribute("position")?.count ?? 0;
}

function indexCount(g: THREE.BufferGeometry): number {
  return g.index ? g.index.count : 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampAbs(v: number, max: number): number {
  return v < -max ? -max : v > max ? max : v;
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
