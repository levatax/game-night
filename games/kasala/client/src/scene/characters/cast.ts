// The cast's data: one Actor per seated gangster (rig, face, hat, chair, flag props, emote props, label and
// animation state), pop-in / pop-out prop handles (props never blink in or out: they scale with a little
// overshoot) and the Npc wrapper used for Komiser Rıfat and the weasel lawyer. Owner: client-characters.

import * as THREE from "three";
import { ANIMAL_BY_ID, PLAYER_COLORS, type Animal } from "../../../../shared/constants";
import type { PlayerView } from "../../../../shared/protocol";
import { buildBody, Puppet, type BodyRig, type Face, type Skin } from "./body";
import { buildAnimalHead, buildBulldogHead, buildFedora, buildPoliceCap, buildWeaselHead, type Fedora } from "./heads";
import { mat, optimizeShadows, suitMat } from "./kit";
import {
  buildBillWad, buildBriefcase, buildBucket, buildChair, buildCigar, buildCollar, buildFish, buildHanky,
  buildIronBall, buildLighter, buildMoss, buildNazar, buildPapers, buildSack, buildTail, buildTargetMarker,
  buildWallet, type Bucket, type TargetMarker, type Wallet,
} from "./props";
import { Pop } from "./util";
import type { Label } from "./labels";
import type { ClipRun } from "./clips";
import type { Seq } from "./sequences";

export const sceneColor = (index: number): string => PLAYER_COLORS[index] ?? PLAYER_COLORS[0];

// ------------------------------------------------------------------- props
/** A prop that pops in / out by scale. Non-sticky props must be wanted every frame (clip / sequence held). */
export class PropHandle {
  readonly pop = new Pop(320, 23);
  want = false;
  constructor(
    readonly obj: THREE.Object3D,
    readonly base: THREE.Vector3,
    readonly sticky: boolean,
  ) {}
}

export class PropSet {
  private list: PropHandle[] = [];

  add(obj: THREE.Object3D, sticky = false): PropHandle {
    const h = new PropHandle(obj, obj.scale.clone(), sticky);
    obj.visible = false;
    this.list.push(h);
    return h;
  }

  update(dt: number): void {
    for (const h of this.list) {
      h.pop.target = h.want ? 1 : 0;
      if (!h.sticky) h.want = false;
      if (h.pop.x === 0 && h.pop.target === 0) {
        if (h.obj.visible) h.obj.visible = false;
        continue;
      }
      h.pop.step(dt);
      const s = Math.max(0.0001, h.pop.x);
      h.obj.scale.set(h.base.x * s, h.base.y * s, h.base.z * s);
      h.obj.visible = h.pop.x > 0.003;
    }
  }

  /** Hide everything at once (actor removed / scene reset). */
  clear(): void {
    for (const h of this.list) {
      h.want = false;
      h.pop.snap(0);
      h.obj.visible = false;
      h.obj.scale.copy(h.base);
    }
  }
}

export interface ActorProps {
  collar: PropHandle;
  ironBall: PropHandle;
  nazar: PropHandle;
  briefcase: PropHandle;
  moss: PropHandle;
  fish: PropHandle;
  stamp: PropHandle;
  blackEye: PropHandle | null;
  sack: PropHandle;
  cigar: PropHandle;
  lighter: PropHandle;
  wad: PropHandle;
  hanky: PropHandle;
  wallet: PropHandle;
  bucketL: PropHandle;
  bucketR: PropHandle;
  pocketL: PropHandle;
  pocketR: PropHandle;
}

// ------------------------------------------------------------------- actor
export interface Actor {
  id: string;
  animal: Animal;
  color: number;
  sample: boolean;
  root: THREE.Group;
  rig: BodyRig;
  face: Face;
  puppet: Puppet;
  fedora: Fedora;
  chair: THREE.Group;
  marker: TargetMarker;
  props: PropSet;
  pr: ActorProps;
  cigar: ReturnType<typeof buildCigar>;
  lighter: ReturnType<typeof buildLighter>;
  wad: ReturnType<typeof buildBillWad>;
  wallet: Wallet;
  buckets: [Bucket, Bucket];
  label: Label;
  data: PlayerView | null;
  active: boolean;
  seat: number;
  /** Seat angle φ (layout.ts), model yaw (φ + π), outward and right-hand directions of the seat. */
  phi: number;
  yaw: number;
  out: THREE.Vector3;
  right: THREE.Vector3;
  /** Chair spot, seated root (a little closer to the table) and the hands' rest points on the rail (world). */
  chairHome: THREE.Vector3;
  home: THREE.Vector3;
  rest: [THREE.Vector3, THREE.Vector3];
  chairOut: number;
  chairVel: Float32Array;
  /** Root follow velocity (back to the seat without snapping). */
  rootVel: THREE.Vector3;
  clips: ClipRun[];
  seq: Seq | null;
  tauntLeft: number;
  /** Seconds the label stays forced visible after a reaction (first person). */
  noteLeft: number;
  seed: number;
  idleIn: number;
  /** Next sweat drop while sweating out a high raid chance. */
  sweatIn: number;
  glance: { id: string; left: number; next: number };
  skin: Skin;
  blackEye: boolean;
  /** Seat assigned at least once. */
  placed: boolean;
}

/** Players reach a little further than the base rig so their hands rest on the rail with bent elbows. */
export const PLAYER_ARM_SCALE = 1.12;

export function createActor(id: string, animal: Animal, color: number, sample: boolean, label: Label): Actor {
  const def = ANIMAL_BY_ID[animal];
  const band = sceneColor(color);
  const rig = buildBody({
    suit: suitMat("#292833", "#605763"), hands: mat(def.fur), tie: mat(band),
    pocketSquare: mat(def.accent), shoes: mat("#17151E"),
    girth: animal === "domuz" ? 1.18 : animal === "fare" ? 0.82 : 1,
    height: animal === "tavsan" ? 1.07 : 1,
    armScale: PLAYER_ARM_SCALE,
  });
  const face = buildAnimalHead(animal);
  const fedora = buildFedora("#28252D", band, animal === "tavsan");
  const puppet = new Puppet(rig, face, fedora.group);
  const tail = buildTail(animal, def.fur);
  if (tail) rig.back.add(tail);
  const props = new PropSet();

  const collar = buildCollar();
  rig.neck.add(collar);
  const ironBall = buildIronBall();
  ironBall.position.set(-0.35, 0, 0.12);
  rig.root.add(ironBall);
  const nazar = buildNazar();
  nazar.position.set(0, 0.72, 0.1);
  rig.neck.add(nazar);
  const briefcase = buildBriefcase();
  briefcase.position.set(-0.35, 0, -0.13);
  rig.root.add(briefcase);
  const moss = buildMoss();
  fedora.group.add(moss);
  const fish = buildFish();
  fish.position.set(0.04, 0.18, 0);
  fedora.group.add(fish);
  const sack = buildSack();
  rig.neck.add(sack);
  const cigar = buildCigar();
  cigar.group.rotation.set(-0.5, 0, 0);
  rig.arms[1].grip.add(cigar.group);
  const lighter = buildLighter();
  rig.arms[0].grip.add(lighter.group);
  const wad = buildBillWad();
  rig.arms[0].grip.add(wad.group);
  const hanky = buildHanky();
  rig.arms[0].grip.add(hanky);
  const wallet = buildWallet();
  wallet.group.rotation.set(-0.9, 0, 0);
  rig.arms[1].grip.add(wallet.group);
  const buckets: [Bucket, Bucket] = [buildBucket("#8EDCFF"), buildBucket("#8EDCFF")];
  buckets[0].group.position.set(-0.36, 0, 0.18);
  buckets[1].group.position.set(0.36, 0, 0.18);
  rig.root.add(buckets[0].group, buckets[1].group);

  const chair = buildChair();
  const marker = buildTargetMarker();
  marker.arrow.position.y = 1.85;
  marker.group.visible = false;
  rig.root.add(marker.group);
  rig.hitbox.userData.playerId = id;
  optimizeShadows(rig.root);
  puppet.rememberMaterials(rig.root);

  const pr: ActorProps = {
    collar: props.add(collar, true),
    ironBall: props.add(ironBall, true),
    nazar: props.add(nazar, true),
    briefcase: props.add(briefcase, true),
    moss: props.add(moss, true),
    fish: props.add(fish, true),
    stamp: props.add(fedora.stamp, true),
    blackEye: face.blackEye ? props.add(face.blackEye, true) : null,
    sack: props.add(sack),
    cigar: props.add(cigar.group),
    lighter: props.add(lighter.group),
    wad: props.add(wad.group),
    hanky: props.add(hanky),
    wallet: props.add(wallet.group),
    bucketL: props.add(buckets[0].group),
    bucketR: props.add(buckets[1].group),
    pocketL: props.add(rig.pockets[0]!),
    pocketR: props.add(rig.pockets[1]!),
  };
  return {
    id, animal, color, sample, root: rig.root, rig, face, puppet, fedora, chair, marker, props, pr,
    cigar, lighter, wad, wallet, buckets, label, data: null, active: false,
    seat: -1, phi: 0, yaw: 0, out: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(1, 0, 0),
    chairHome: new THREE.Vector3(), home: new THREE.Vector3(),
    rest: [new THREE.Vector3(), new THREE.Vector3()], chairOut: 0, chairVel: new Float32Array(1), rootVel: new THREE.Vector3(),
    clips: [], seq: null, tauntLeft: 0, noteLeft: 0, seed: Math.random() * 100, idleIn: 2 + Math.random() * 5, sweatIn: 1,
    glance: { id: "", left: 0, next: 1 + Math.random() * 4 }, skin: "normal", blackEye: false, placed: false,
  };
}

// --------------------------------------------------------------------- npcs
/** A visiting character (cop, lawyer): pops in and out, posed every frame by whoever owns it. */
export class Npc {
  readonly root: THREE.Group;
  readonly pop = new Pop(260, 19);
  /** The sequence driving it this frame (cleared by the owner at the end). */
  owner: object | null = null;
  constructor(
    readonly rig: BodyRig,
    readonly face: Face,
    readonly puppet: Puppet,
  ) {
    this.root = rig.root;
    this.root.visible = false;
  }

  get shown(): boolean {
    return this.root.visible;
  }

  /** Place and show (popIn: grow from nothing; otherwise appear at full size, e.g. walking in a door). */
  appear(at: THREE.Vector3, yaw: number, popIn: boolean): void {
    this.root.position.copy(at);
    this.root.rotation.y = yaw;
    this.puppet.resetMotion();
    this.puppet.target.reset();
    this.puppet.target.sit = 0;
    this.puppet.settle();
    if (popIn) {
      this.pop.x = 0.05;
      this.pop.v = 0;
    } else this.pop.snap(1);
    this.pop.target = 1;
    this.root.visible = true;
  }

  vanish(instant = false): void {
    this.pop.target = 0;
    if (instant) {
      this.pop.snap(0);
      this.root.visible = false;
    }
  }

  update(dt: number, time: number): void {
    if (!this.root.visible) return;
    this.pop.step(dt);
    if (this.pop.target === 0 && this.pop.x <= 0.003) {
      this.root.visible = false;
      this.owner = null;
      return;
    }
    this.root.scale.setScalar(Math.max(0.001, this.pop.x));
    this.puppet.update(dt, time);
  }
}

export function buildCop(): Npc {
  const rig = buildBody({
    suit: suitMat("#273D62", "#55749A"), hands: mat("#B98462"),
    shirt: mat("#E6EDF7"), tie: mat("#1B2540"), coat: mat("#263A58"),
    shoes: mat("#171D29"), girth: 1.35, height: 1.05, armScale: 1.15,
  });
  const face = buildBulldogHead();
  const puppet = new Puppet(rig, face, buildPoliceCap());
  optimizeShadows(rig.root);
  return new Npc(rig, face, puppet);
}

export function buildLawyer(): Npc {
  const rig = buildBody({
    suit: suitMat("#41445A", "#9D9DB0"), hands: mat("#B7A081"),
    shirt: mat("#F8F5E9"), tie: mat("#D4B13C"), girth: 0.85, height: 0.9, armScale: 1.1,
  });
  const face = buildWeaselHead();
  const puppet = new Puppet(rig, face, buildFedora("#30333E", "#FFC93C").group);
  rig.arms[0].grip.add(buildBriefcase().translateY(-0.24));
  const papers = buildPapers();
  papers.rotation.set(-1.2, 0, 0);
  rig.arms[1].grip.add(papers);
  optimizeShadows(rig.root);
  puppet.rememberMaterials(rig.root);
  return new Npc(rig, face, puppet);
}
