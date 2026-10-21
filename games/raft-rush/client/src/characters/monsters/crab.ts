// Night crabs (game4.md §16): red-orange #FF4D3A shells, neon googly eyes on stalks, oversized claws with
// snapping pincers and six legs that scuttle sideways; flipped onto their backs they wave every leg in the
// air until they wobble back up. Drawn through the shared instanced crab pool (Kaptan Yengeç uses the same
// parts, scaled up: boss.ts). Animations for every MonsterMode: emerge from the surf, hunt scuttle, bite
// lunge, flipped leg-wave, flee panic, stunned dizzy eyes, lured sniffing. Owner: client-characters.

import * as THREE from "three";
import { CRAB_FLIP_TICKS, MONSTER_EMERGE_TICKS, MONSTERS, PALETTE } from "../../../../shared/constants";
import type { MonsterFrame } from "../../net/types";
import type { MonsterTrigger } from "../Characters";
import { alongMatrix, capsuleGeo, coneGeo, cylinderGeo, sphereGeo } from "../kit";
import { Clip, Googly, type InstancedPool, type MonsterEnv, type MonsterRig, neonEyeMaterial, type PartDef, PartBaker, pupilMaterial, Squash, YawFollower } from "./common";

const RED = PALETTE.crab;
const RED_LIGHT = "#FF7656";
const RED_DARK = "#C9311F";
const BELLY = "#FFD6AE";
const TIP = "#FFE0C2";

/** Shell center height above the feet at rest. */
const BODY_Y = 0.3;
const EYE_R = 0.07;
const PUPIL_R = 0.036;
/** Leg hips (right side; the left side mirrors by a half turn around Y). */
const LEG_Z: readonly number[] = [-0.1, 0.05, 0.19];

/** Geometry of every crab part (local spaces documented per part). */
export function crabPartDefs(): PartDef[] {
  // Shell around the body node.
  const shell = new PartBaker()
    .put(sphereGeo(8), RED, [0, 0, 0], [0.42, 0.19, 0.34])
    .put(sphereGeo(6), RED_LIGHT, [0, 0.07, 0.03], [0.31, 0.12, 0.24], [0, 0, 0], false)
    .put(sphereGeo(6), BELLY, [0, -0.07, 0], [0.37, 0.09, 0.29], [0, 0, 0], false)
    .put(sphereGeo(4), RED_DARK, [0, -0.02, -0.33], [0.07, 0.018, 0.02], [0, 0, 0], false);
  for (const s of [1, -1]) {
    shell.add(coneGeo(4), RED_DARK, alongMatrix([0.22 * s, 0.07, -0.25], [0.29 * s, 0.13, -0.33], 0.035), false);
    shell.add(coneGeo(4), RED_DARK, alongMatrix([0.35 * s, 0.05, -0.12], [0.45 * s, 0.09, -0.16], 0.03), false);
  }
  const shellBake = shell.bake();
  // Eye stalk: from the shell top (origin) up +Y.
  const stalk = new PartBaker().add(cylinderGeo(0.8, 5), RED, alongMatrix([0, 0, 0], [0, 0.2, 0], 0.022), false).bake();
  const eyeball = new PartBaker().put(sphereGeo(6), "#FFFFFF", [0, 0, 0], EYE_R, [0, 0, 0], false).bake();
  const pupil = new PartBaker().put(sphereGeo(5), "#111111", [0, 0, 0], PUPIL_R, [0, 0, 0], false).bake();
  // Claw arm: from the shoulder (origin) forward along −Z (the shoulder node yaws it outward).
  const clawArm = new PartBaker().add(capsuleGeo(0.045, 0.16, 5, 1), RED, alongMatrix([0, 0, 0], [0, 0.04, -0.2], 1), true).bake();
  // Claw: from the wrist (origin) forward: the big palm and the fixed lower finger.
  const claw = new PartBaker()
    .put(sphereGeo(7), RED, [0, 0, -0.1], [0.13, 0.1, 0.16])
    .add(coneGeo(5), RED, alongMatrix([0, -0.035, -0.2], [0, -0.045, -0.37], 0.05), true)
    .put(sphereGeo(4), TIP, [0, -0.045, -0.35], 0.022, [0, 0, 0], false)
    .bake();
  // Pincer: the moving upper finger from its hinge (origin) forward.
  const pincer = new PartBaker()
    .add(coneGeo(5), RED, alongMatrix([0, 0, 0], [0, -0.01, -0.18], 0.055), true)
    .put(sphereGeo(5), RED_LIGHT, [0, 0.005, -0.01], 0.042, [0, 0, 0], false)
    .bake();
  // Leg segments: upper from the hip outward (+X), lower from the knee down to a point.
  const legUpper = new PartBaker().add(cylinderGeo(0.85, 4), RED, alongMatrix([0, 0, 0], [0.17, 0.12, 0], 0.021), false).bake();
  const legLower = new PartBaker().add(coneGeo(4), RED_DARK, alongMatrix([0, 0, 0], [0.17, -0.36, 0], 0.019), false).bake();
  return [
    { name: "shell", geometry: shellBake.geometry, outline: shellBake.outline, perMonster: 1, castShadow: true },
    { name: "stalk", geometry: stalk.geometry, outline: null, perMonster: 2 },
    { name: "eye", geometry: eyeball.geometry, outline: null, perMonster: 2, material: neonEyeMaterial() },
    { name: "pupil", geometry: pupil.geometry, outline: null, perMonster: 2, material: pupilMaterial() },
    { name: "clawArm", geometry: clawArm.geometry, outline: null, perMonster: 2 },
    { name: "claw", geometry: claw.geometry, outline: claw.outline, perMonster: 2, castShadow: true },
    { name: "pincer", geometry: pincer.geometry, outline: pincer.outline, perMonster: 2 },
    { name: "legUpper", geometry: legUpper.geometry, outline: null, perMonster: 6 },
    { name: "legLower", geometry: legLower.geometry, outline: null, perMonster: 6 },
  ];
}

interface Leg {
  hip: THREE.Object3D;
  knee: THREE.Object3D;
  side: number;
  phase: number;
}

interface Claw {
  shoulder: THREE.Object3D;
  wrist: THREE.Object3D;
  pincer: THREE.Object3D;
  side: number;
}

interface Eye {
  stalk: THREE.Object3D;
  ball: THREE.Object3D;
  pupil: THREE.Object3D;
  googly: Googly;
}

export interface CrabOptions {
  /** Overall scale (the boss is 2.2). */
  scale: number;
  /** Boss behavior: walks head-on, smashes, never flips. */
  boss: boolean;
}

export class CrabRig implements MonsterRig {
  readonly id: string;
  readonly kind: MonsterFrame["kind"];
  readonly root = new THREE.Object3D();
  /** Visual turn (sideways scuttle) and flip container. */
  protected readonly turn = new THREE.Object3D();
  protected readonly body = new THREE.Object3D();
  protected readonly shell = new THREE.Object3D();
  private readonly legs: Leg[] = [];
  private readonly claws: Claw[] = [];
  private readonly eyes: Eye[] = [];
  private readonly yaw = new YawFollower();
  private readonly squash = new Squash();
  private readonly attack = new Clip();
  private readonly spawnClip = new Clip();
  private readonly dropClip = new Clip();
  private walkPhase = Math.random() * 10;
  private sideW = 0;
  private flipW = 0;
  private flipTarget = 0;
  /** A flip / unflip trigger holds its target this long (the state patch may lag the event). */
  private flipHold = 0;
  private time = Math.random() * 10;
  private mode: MonsterFrame["mode"] = "emerge";
  private modeTicks = 0;
  private speed = 0;
  private death: { t: number; dur: number; style: "pop" | "sink" | "collect" } | null = null;
  private hurtShake = 0;

  constructor(
    id: string,
    kind: MonsterFrame["kind"],
    private readonly pool: InstancedPool,
    readonly opts: CrabOptions,
  ) {
    this.id = id;
    this.kind = kind;
    this.root.name = `crab:${id}`;
    this.root.scale.setScalar(opts.scale);
    this.root.add(this.turn);
    this.turn.add(this.body);
    this.body.position.y = BODY_Y;
    this.body.rotation.order = "YXZ";
    this.body.add(this.shell);
    for (const side of [1, -1]) {
      const stalk = new THREE.Object3D();
      stalk.position.set(0.11 * side, 0.12, -0.21);
      stalk.rotation.z = -0.18 * side;
      const ball = new THREE.Object3D();
      ball.position.y = 0.21;
      const pupil = new THREE.Object3D();
      stalk.add(ball);
      ball.add(pupil);
      this.body.add(stalk);
      this.eyes.push({ stalk, ball, pupil, googly: new Googly() });

      const shoulder = new THREE.Object3D();
      shoulder.position.set(0.3 * side, -0.01, -0.2);
      shoulder.rotation.order = "YXZ";
      const wrist = new THREE.Object3D();
      wrist.position.set(0, 0.04, -0.2);
      wrist.rotation.order = "YXZ";
      const pincer = new THREE.Object3D();
      pincer.position.set(0, 0.03, -0.2);
      shoulder.add(wrist);
      wrist.add(pincer);
      this.body.add(shoulder);
      this.claws.push({ shoulder, wrist, pincer, side });

      for (let i = 0; i < LEG_Z.length; i++) {
        const hip = new THREE.Object3D();
        hip.position.set(0.33 * side, -0.03, LEG_Z[i]!);
        hip.rotation.order = "YXZ";
        const knee = new THREE.Object3D();
        knee.position.set(0.17, 0.12, 0);
        hip.add(knee);
        this.body.add(hip);
        // Tripod gait: alternate legs share a phase.
        this.legs.push({ hip, knee, side, phase: (i + (side > 0 ? 0 : 1)) % 2 === 0 ? 0 : Math.PI });
      }
    }
    if (opts.boss) {
      // Kaptan Yengeç: one giant fiddler claw.
      this.claws[0]!.shoulder.scale.setScalar(1.35);
    }
  }

  update(f: MonsterFrame, dt: number, _env: MonsterEnv): void {
    this.time += dt;
    this.mode = f.mode;
    this.modeTicks = f.modeTicks;
    this.speed = f.speed;
    this.root.position.set(f.x, f.y, f.z);
    this.root.rotation.y = this.yaw.update(f.yaw, dt, this.opts.boss ? 4 : 9);
    this.attack.step(dt);
    this.spawnClip.step(dt);
    this.dropClip.step(dt);
    this.squash.step(dt);
    this.hurtShake = Math.max(0, this.hurtShake - dt * 3);
    this.pose(dt);
  }

  trigger(what: MonsterTrigger): void {
    switch (what) {
      case "spawn":
        this.spawnClip.start(0.45);
        break;
      case "hurt":
        this.squash.kick(-3.2);
        this.hurtShake = 1;
        for (const e of this.eyes) e.googly.update(0.016, 30);
        break;
      case "flip":
        if (!this.opts.boss) {
          this.flipTarget = 1;
          this.flipHold = 0.3;
          this.squash.kick(3);
        }
        break;
      case "unflip":
        this.flipTarget = 0;
        this.flipHold = 0.3;
        this.squash.kick(2.5);
        break;
      case "attack":
        this.attack.start(this.opts.boss ? 0.55 : 0.35);
        this.squash.kick(1.5);
        break;
      case "flee":
        this.squash.kick(1.2);
        break;
      case "drop":
      case "steal":
        this.dropClip.start(0.4);
        break;
      case "die":
        break;
    }
  }

  writeInstances(): void {
    const p = this.pool;
    p.part("shell").push(this.shell.matrixWorld);
    for (const e of this.eyes) {
      p.part("stalk").push(e.stalk.matrixWorld);
      p.part("eye").push(e.ball.matrixWorld);
      p.part("pupil").push(e.pupil.matrixWorld);
    }
    for (const c of this.claws) {
      p.part("clawArm").push(c.shoulder.matrixWorld);
      p.part("claw").push(c.wrist.matrixWorld);
      p.part("pincer").push(c.pincer.matrixWorld);
    }
    for (const l of this.legs) {
      p.part("legUpper").push(l.hip.matrixWorld);
      p.part("legLower").push(l.knee.matrixWorld);
    }
  }

  center(out: THREE.Vector3): void {
    this.body.getWorldPosition(out);
  }

  beginDeath(): number {
    if (this.death) return this.death.dur - this.death.t;
    const style = this.mode === "flee" ? "sink" : this.mode === "flipped" ? "collect" : "pop";
    const dur = style === "sink" ? 0.8 : style === "collect" ? 0.3 : 0.4;
    this.death = { t: 0, dur, style };
    return dur;
  }

  updateDeath(dt: number, _env: MonsterEnv): void {
    const d = this.death;
    if (!d) return;
    d.t += dt;
    this.time += dt;
    this.squash.step(dt);
    this.pose(dt);
    const u = Math.min(1, d.t / d.dur);
    if (d.style === "sink") {
      this.turn.position.y = -0.9 * u * u;
    } else if (d.style === "collect") {
      this.turn.scale.setScalar(Math.max(0.001, 1 - u));
      this.turn.position.y = 0.3 * Math.sin(Math.PI * u);
    } else {
      const s = u < 0.35 ? 1 + 0.35 * (u / 0.35) : Math.max(0.001, 1.35 * (1 - (u - 0.35) / 0.65));
      this.turn.scale.setScalar(s);
      this.turn.rotation.y += dt * 14;
    }
    this.root.updateMatrixWorld(true);
  }

  dispose(): void {
    this.root.removeFromParent();
  }

  /* ----------------------------------------------------------- posing */

  private pose(dt: number): void {
    const t = this.time;
    const mode = this.mode;
    const moving = Math.min(1, this.speed / 1.2);
    const boss = this.opts.boss;
    this.flipHold = Math.max(0, this.flipHold - dt);
    if (this.flipHold <= 0 && !this.death) this.flipTarget = mode === "flipped" && !boss ? 1 : 0;
    this.flipW += (this.flipTarget - this.flipW) * (1 - Math.exp(-9 * dt));
    // Sideways scuttle while hunting / fleeing (the boss always walks head-on).
    const sideways = !boss && (mode === "hunt" || mode === "flee") && this.speed > 0.6 ? 1 : 0;
    this.sideW += (sideways - this.sideW) * (1 - Math.exp(-6 * dt));
    this.turn.rotation.y = (Math.PI / 2) * this.sideW;

    // Gait.
    const rate = mode === "flee" ? 16 : 9 + 5 * moving;
    this.walkPhase += dt * rate * Math.max(0.15, moving);

    // Body: bob, emerge rise, bite lunge, flip.
    let y = BODY_Y + 0.025 * Math.abs(Math.sin(this.walkPhase)) * moving;
    let pitch = 0;
    let roll = 0;
    let fwd = 0;
    let scale = 1;
    if (mode === "emerge") {
      const p = 1 - Math.min(1, this.modeTicks / MONSTER_EMERGE_TICKS);
      y -= 0.45 * (1 - p);
      roll += 0.12 * Math.sin(t * 30) * (p > 0.7 ? 1 : 0.3);
      scale *= 0.7 + 0.3 * p;
    }
    if (this.spawnClip.active) scale *= 0.2 + 0.8 * easeOutBack(this.spawnClip.u);
    if (mode === "bite" || this.attack.active) {
      const a = this.attack.active ? Math.sin(Math.PI * this.attack.u) : 0.4 + 0.3 * Math.sin(t * 9);
      fwd -= 0.12 * a;
      pitch += 0.18 * a;
    }
    if (mode === "lured" && this.speed < 0.5) {
      // Sniffing at the bait.
      pitch += 0.2 + 0.08 * Math.sin(t * 18);
      y -= 0.04;
    }
    if (mode === "stunned") roll += 0.15 * Math.sin(t * 9);
    roll += 0.1 * this.hurtShake * Math.sin(t * 40);
    // Flipped: on its back, shell on the sand, wobbling to get up near the end.
    const flip = this.flipW;
    if (flip > 0.001) {
      y = y * (1 - flip) + (0.2 + 0.03 * Math.sin(t * 6)) * flip;
      roll += Math.PI * flip;
      if (mode === "flipped" && this.modeTicks < CRAB_FLIP_TICKS * 0.25) roll += 0.35 * Math.sin(t * 13) * flip;
    }
    const sq = this.squash.x;
    this.body.position.set(0, y, fwd);
    this.body.rotation.set(pitch, 0, roll);
    this.body.scale.set(scale * (1 - sq * 0.5), scale * (1 + sq), scale * (1 - sq * 0.5));

    // Legs.
    const waving = flip > 0.5;
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i]!;
      const base = l.side > 0 ? 0 : Math.PI;
      let swing: number;
      let lift: number;
      let knee: number;
      if (waving) {
        swing = 0.45 * Math.sin(t * 15 + i * 1.3);
        lift = 0.5 + 0.35 * Math.sin(t * 12 + i);
        knee = -0.4 + 0.5 * Math.sin(t * 17 + i * 2);
      } else if (mode === "emerge" || mode === "stunned") {
        swing = 0.1 * Math.sin(t * 6 + i);
        lift = mode === "stunned" ? -0.2 : 0.05;
        knee = 0.1;
      } else {
        const ph = this.walkPhase + l.phase;
        swing = 0.32 * Math.sin(ph) * moving;
        lift = 0.28 * Math.max(0, Math.cos(ph)) * moving;
        knee = -0.15 * Math.max(0, Math.cos(ph)) * moving;
      }
      l.hip.rotation.set(0, base + swing * l.side, lift * l.side);
      l.knee.rotation.set(0, 0, knee * l.side);
    }

    // Claws: raised to the front, pincers clicking; up high in panic; snapping in a bite.
    const panic = mode === "flee" || mode === "emerge";
    for (const c of this.claws) {
      const s = c.side;
      let raise = 0.25 + 0.06 * Math.sin(t * 2 + s);
      let open = 0.25 + 0.2 * Math.max(0, Math.sin(t * 3.1 + s * 2)) ** 6;
      let out = 0.55;
      if (panic) {
        raise = 1.0 + 0.25 * Math.sin(t * 14 + s);
        open = 0.6 * Math.abs(Math.sin(t * 16 + s));
      }
      if (mode === "bite" || this.attack.active) {
        const a = this.attack.active ? this.attack.u : (t * 2) % 1;
        raise = boss && this.attack.active ? 1.4 - 1.9 * smash(a) : 0.5 - 0.6 * Math.sin(Math.PI * a);
        open = 0.7 * Math.abs(Math.sin(t * 18));
        out = 0.35;
      }
      if (mode === "lured") open = 0.5 * Math.abs(Math.sin(t * 20 + s));
      if (waving) {
        raise = 0.6 + 0.5 * Math.sin(t * 11 + s);
        open = 0.6 * Math.abs(Math.sin(t * 13 + s));
      }
      if (this.dropClip.active) raise += 0.8 * Math.sin(Math.PI * this.dropClip.u);
      c.shoulder.rotation.set(raise * 0.6, -out * s, 0);
      c.wrist.rotation.set(-raise * 0.4, 0.2 * s, 0);
      c.pincer.rotation.set(Math.max(0, open), 0, 0);
    }

    // Eyes: googly pupils rattle with motion; dizzy circles when stunned.
    const shake = moving * 1.5 + this.hurtShake * 4 + (panic ? 3 : 0) + (waving ? 4 : 0);
    for (let i = 0; i < this.eyes.length; i++) {
      const e = this.eyes[i]!;
      if (mode === "stunned") e.googly.spin(t * 9 + i * Math.PI);
      else e.googly.update(dt, shake);
      const stalkSway = 0.12 * Math.sin(t * 3 + i * 2) + (mode === "lured" ? -0.3 : 0);
      e.stalk.rotation.x = stalkSway + 0.1 * moving;
      e.pupil.position.set(e.googly.off.x * EYE_R, e.googly.off.y * EYE_R, -EYE_R * 0.62);
    }
  }
}

function easeOutBack(t: number): number {
  const x = Math.max(0, Math.min(1, t)) - 1;
  return 1 + 2.4 * x * x * x + 1.4 * x * x;
}

/** Wind up (0 → 0.45) then slam down (→ 0.6) and hold. */
function smash(u: number): number {
  if (u < 0.45) return -0.3 * Math.sin((u / 0.45) * Math.PI * 0.5);
  if (u < 0.6) return -0.3 + 1.3 * ((u - 0.45) / 0.15);
  return 1;
}

/** Shell radius for blob shadows / fx anchors. */
export const CRAB_RADIUS = MONSTERS.crab.radius;
