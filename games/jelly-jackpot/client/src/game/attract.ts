// Home-screen attract loop: a LOCAL fake tower (no server, no physics engine) that stacks random kitchen
// junk on the cake, wobbles ominously, then TIMBERS onto the tablecloth while four fake chefs laugh and one
// of them eats a pie. Then a fresh cake slides in and it starts over. Owner: client-game.

import * as THREE from "three";
import {
  BAG_PIECES,
  CAKE_RADIUS,
  CAKE_TOP_Y,
  PIECES,
  STAND_SPEED_DEG,
  TABLE_RADIUS,
  type ColliderDef,
  type PieceType,
} from "../../../shared/constants";
import type { PlayerView } from "../../../shared/protocol";
import type { AudioEngine } from "../audio/AudioEngine";
import type { Chefs } from "../scene/Chefs";
import type { Fx } from "../scene/Fx";
import { makePieceMesh } from "../scene/Pieces";
import type { Stage } from "../scene/Stage";

const FAKE_CHEFS = ["Chef Wobbles", "Sir Sprinkles", "Mama Meatball", "Lil' Noodle"];
const BASE_PIECES: PieceType[] = ["toaster", "cheese", "pancakes", "pan"];
const DROP_EVERY_SEC = 1.15;
const GRAVITY = 7.5;
const FLOOR_Y = -0.75;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

// ------------------------------------------------------------------ collider extents
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();

/** Vertical half-extent of a collider (about its own center), honoring its rotation. */
function colliderHalfY(c: ColliderDef): number {
  const r = c.kind !== "ball" && "rot" in c && c.rot ? c.rot : null;
  if (r) tmpQ.set(r[0], r[1], r[2], r[3]);
  else tmpQ.identity();
  // |world-Y component| of each rotated local axis.
  const ay = (x: number, y: number, z: number) => Math.abs(tmpV.set(x, y, z).applyQuaternion(tmpQ).y);
  switch (c.kind) {
    case "ball":
      return c.r;
    case "box":
      return ay(1, 0, 0) * c.hx + ay(0, 1, 0) * c.hy + ay(0, 0, 1) * c.hz;
    case "capsule":
      return ay(0, 1, 0) * c.halfHeight + c.r;
    case "cylinder":
    case "cone": {
      const k = ay(0, 1, 0);
      return k * c.halfHeight + Math.sqrt(Math.max(0, 1 - k * k)) * c.r;
    }
  }
}

/** Lowest / highest y of a piece type relative to its center (unrotated piece). */
function extentY(type: PieceType): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of PIECES[type].colliders) {
    const cy = c.pos ? c.pos[1] : 0;
    const h = colliderHalfY(c);
    lo = Math.min(lo, cy - h);
    hi = Math.max(hi, cy + h);
  }
  return { lo, hi };
}

// ------------------------------------------------------------------------- pieces
interface FakePiece {
  /** Outer wrapper: squash & stretch lives here, the real mesh is its child. */
  root: THREE.Group;
  state: "falling" | "resting" | "flying";
  restY: number;
  vy: number;
  squash: number;
  squashV: number;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
}

type Mode = "build" | "wobble" | "topple" | "pause";

export class Attract {
  /** In standGroup (rotates with the stand). Flying pieces get re-parented here too. */
  private group = new THREE.Group();
  /** Pivot at the cake top: the whole stack leans/wobbles around it. */
  private stack = new THREE.Group();
  private pieces: FakePiece[] = [];
  private running = false;
  private mode: Mode = "build";
  private timer = 0;
  private angle = 0;
  private top = CAKE_TOP_Y;
  private target = 7;
  private drift = new THREE.Vector2();
  private leanDir = new THREE.Vector2(1, 0);
  private fakes: PlayerView[] = [];
  private activeIdx = 0;

  constructor(
    private stage: Stage,
    private chefs: Chefs,
    private fx: Fx,
    private audio: AudioEngine,
  ) {
    this.group.name = "attract";
    this.stack.position.set(0, CAKE_TOP_Y, 0);
    this.group.add(this.stack);
    this.fakes = FAKE_CHEFS.map((nickname, i) => ({
      id: `attract-${i}`,
      nickname,
      color: (i * 2 + 1) % 6,
      seat: i,
      ready: true,
      connected: true,
      spectator: false,
      coins: 60 + Math.floor(Math.random() * 120),
      hasBet: false,
      voted: false,
      place: 0,
      stats: { survived: 0, topples: 0, bestMultiplierX10: 10, betProfit: 0 },
    }));
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stage.standGroup.add(this.group);
    this.restart();
    this.syncChefs();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.clearPieces();
    this.group.removeFromParent();
    this.chefs.sync([], "", "");
    this.stage.setTowerHeight(0);
  }

  update(dt: number): void {
    if (!this.running) return;
    this.angle += ((STAND_SPEED_DEG * Math.PI) / 180) * dt;
    this.stage.setStandAngle(this.angle);
    this.timer += dt;

    switch (this.mode) {
      case "build":
        if (this.timer >= DROP_EVERY_SEC) {
          this.timer = 0;
          if (this.pieces.length < this.target) this.spawn();
          else if (this.pieces.every((p) => p.state === "resting")) this.setMode("wobble");
        }
        break;
      case "wobble": {
        // A nervous sway that grows until something has to give.
        const k = Math.min(1, this.timer / 1.8);
        const amp = 0.02 + k * k * 0.12;
        const a = Math.sin(this.timer * (8 + k * 6)) * amp + k * 0.1;
        this.stack.rotation.set(this.leanDir.y * a, 0, -this.leanDir.x * a);
        if (this.timer > 1.8) this.topple();
        break;
      }
      case "topple":
        if (this.timer > 2.6) this.setMode("pause");
        break;
      case "pause":
        if (this.timer > 0.9) {
          this.stage.newCake();
          this.restart();
        }
        break;
    }

    for (const p of this.pieces) this.step(p, dt);
    // Faded-out flyers are removed.
    this.pieces = this.pieces.filter((p) => {
      if (p.state === "flying" && p.age > 3.2) {
        disposeTree(p.root);
        return false;
      }
      return true;
    });
    this.stage.setTowerHeight(this.mode === "build" || this.mode === "wobble" ? this.top - CAKE_TOP_Y : 0);
  }

  // ------------------------------------------------------------------ internals
  private restart(): void {
    this.clearPieces();
    this.stack.rotation.set(0, 0, 0);
    this.top = CAKE_TOP_Y;
    this.target = 6 + Math.floor(Math.random() * 4);
    this.drift.set(0, 0);
    const a = Math.random() * Math.PI * 2;
    this.leanDir.set(Math.cos(a), Math.sin(a));
    this.setMode("build");
    this.timer = DROP_EVERY_SEC * 0.6;
  }

  private setMode(m: Mode): void {
    this.mode = m;
    this.timer = 0;
  }

  private syncChefs(): void {
    this.chefs.sync(this.fakes, this.fakes[this.activeIdx]!.id, "");
  }

  private spawn(): void {
    const type = this.pieces.length === 0 ? pick(BASE_PIECES) : pick(BAG_PIECES);
    const mesh = makePieceMesh(type);
    const root = new THREE.Group();
    root.add(mesh);
    const ext = extentY(type);
    // The stack drifts off-center as it grows (the comedy lean).
    this.drift.x += this.leanDir.x * rand(0.004, 0.018) + rand(-0.01, 0.01);
    this.drift.y += this.leanDir.y * rand(0.004, 0.018) + rand(-0.01, 0.01);
    const lim = CAKE_RADIUS * 0.6;
    this.drift.clampLength(0, lim);
    const restY = this.top - CAKE_TOP_Y - ext.lo;
    this.top = CAKE_TOP_Y + restY + ext.hi;
    root.position.set(this.drift.x, restY + 0.9, this.drift.y);
    root.rotation.y = Math.random() * Math.PI * 2;
    this.stack.add(root);
    this.pieces.push({
      root,
      state: "falling",
      restY,
      vy: 0,
      squash: 0,
      squashV: 0,
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      age: 0,
    });
    // The fake "active" chef changes every drop so the table looks busy.
    this.activeIdx = (this.activeIdx + 1) % this.fakes.length;
    this.syncChefs();
  }

  private step(p: FakePiece, dt: number): void {
    p.age += dt;
    if (p.state === "falling") {
      p.vy -= GRAVITY * dt;
      p.root.position.y += p.vy * dt;
      if (p.root.position.y <= p.restY) {
        p.root.position.y = p.restY;
        p.squashV = Math.min(1, Math.abs(p.vy) / 3.5) * 9;
        p.state = "resting";
      }
    } else if (p.state === "flying") {
      p.vel.y -= GRAVITY * dt;
      p.root.position.addScaledVector(p.vel, dt);
      p.root.rotation.x += p.spin.x * dt;
      p.root.rotation.y += p.spin.y * dt;
      p.root.rotation.z += p.spin.z * dt;
      const pos = p.root.position;
      const floor = Math.hypot(pos.x, pos.z) < TABLE_RADIUS ? 0.03 : FLOOR_Y;
      if (pos.y < floor) {
        pos.y = floor;
        p.vel.y = Math.abs(p.vel.y) * 0.32;
        p.vel.x *= 0.55;
        p.vel.z *= 0.55;
        p.spin.multiplyScalar(0.5);
        p.squashV += 4;
      }
      if (p.age > 2.4) p.root.scale.setScalar(Math.max(0.001, 1 - (p.age - 2.4) / 0.8));
    }
    // Squash & stretch spring.
    p.squashV += (-90 * p.squash - 9 * p.squashV) * dt;
    p.squash += p.squashV * dt;
    if (p.state !== "flying" || p.age <= 2.4) {
      const s = Math.max(-0.4, Math.min(0.4, p.squash));
      p.root.scale.set(1 + s * 0.5, 1 - s, 1 + s * 0.5);
    }
  }

  private topple(): void {
    this.setMode("topple");
    this.stack.updateWorldMatrix(true, true);
    const n = this.pieces.length;
    this.pieces.forEach((p, i) => {
      this.group.attach(p.root); // keep the current (leaning) world pose
      const h = (i + 1) / n;
      const out = 0.6 + h * 1.6;
      p.vel.set(
        this.leanDir.x * out + rand(-0.5, 0.5),
        rand(0.4, 1.6) * (0.5 + h),
        this.leanDir.y * out + rand(-0.5, 0.5),
      );
      p.spin.set(rand(-9, 9), rand(-6, 6), rand(-9, 9));
      p.state = "flying";
      p.age = 0;
    });
    this.stack.rotation.set(0, 0, 0);

    const cakeTop = new THREE.Vector3(0, CAKE_TOP_Y + 0.05, 0);
    this.stage.standGroup.updateWorldMatrix(true, false);
    this.stage.standGroup.localToWorld(cakeTop);
    this.fx.splat(cakeTop);
    this.fx.puff(cakeTop, 0.6);
    this.audio.sfx("slideWhistle", { volume: 0.25 });
    this.audio.sfx("splat", { volume: 0.2 });

    // One random chef gets the pie, everyone else laughs at them.
    const victim = pick(this.fakes).id;
    setTimeout(() => {
      if (!this.running) return;
      this.chefs.react(victim, "pie");
      this.chefs.reactAll("laugh", victim);
    }, 350);
  }

  private clearPieces(): void {
    for (const p of this.pieces) disposeTree(p.root);
    this.pieces = [];
  }
}

/** Detach and free GPU geometry (Three re-uploads anything shared that is used again later). */
function disposeTree(obj: THREE.Object3D): void {
  obj.removeFromParent();
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.geometry?.dispose();
  });
}
