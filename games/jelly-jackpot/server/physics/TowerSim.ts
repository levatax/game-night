// Rapier tower physics. Owner: server-physics. SIGNATURES ARE THE CONTRACT; fill in the bodies.
//
// Everything lives in the cake stand's LOCAL frame (the stand's rotation is visual only, so the
// cake is a STATIC body here). World: table (static cuboid top at y=0, radius TABLE_RADIUS, plus a
// big floor at y=-0.8 so fallen pieces don't drop forever), stand plate (static cylinder, top at
// STAND_PLATE_Y, radius STAND_PLATE_RADIUS), cake (static cylinder, radius CAKE_RADIUS, top at
// CAKE_TOP_Y). Pieces are dynamic rigid bodies built from PIECES[type].colliders (scaled by `scale`),
// with mass/friction/restitution from the def, modified by the card (see SpawnMods).
//
// Use `import RAPIER from "@dimforge/rapier3d-compat"` and `await RAPIER.init()` once (TowerSim.create).
// Fixed step 1/TICK_HZ. Enable CCD on dynamic bodies (small fast pieces). Use an EventQueue with
// contact force events / collision events to produce `impacts` (throttle: per piece max 1 per 120 ms,
// speed ≥ IMPACT_MIN_SPEED, at most 6 per step).

import RAPIER from "@dimforge/rapier3d-compat";
import {
  CAKE_RADIUS,
  CAKE_TOP_Y,
  GRAVITY,
  IMPACT_MIN_SPEED,
  MIN_DROP_GAP,
  PIECES,
  SLEEP_ANG,
  SLEEP_HOLD_SEC,
  SLEEP_LIN,
  STAND_PLATE_RADIUS,
  STAND_PLATE_Y,
  TABLE_RADIUS,
  TICK_HZ,
  TOPPLE_Y,
  WIND_FORCE,
} from "../../shared/constants.js";
import type { CardId, ColliderDef, PieceType } from "../../shared/constants.js";
import type { Pose } from "../../shared/protocol.js";

export interface SpawnMods {
  /** Scale factor (Chonk = CHONK_SCALE). */
  scale: number;
  /** Mass multiplier (Heavy Snack = HEAVY_SNACK_MASS). */
  massScale: number;
  /** Override friction (Butter Fingers = BUTTER_FRICTION). */
  friction?: number;
  /** Override restitution (Jelly Mode = JELLY_RESTITUTION). */
  restitution?: number;
  /** Glue Gun: on first contact with any other body, lock it with a fixed joint (and it stays glued). */
  glue: boolean;
  /** The card active this turn (for bookkeeping only). */
  card: CardId | "";
}

export interface SimPiece {
  id: string;
  type: PieceType;
  ownerId: string;
  scale: number;
  card: string;
  pose: Pose;
  asleep: boolean;
}

export interface SimImpact {
  pieceId: string;
  type: PieceType;
  speed: number;
  x: number;
  y: number;
  z: number;
}

// ------------------------------------------------------------------ tuning (toy-scale wobble)
const LINEAR_DAMPING = 0.2;
const ANGULAR_DAMPING = 0.8;
const SOLVER_ITERATIONS = 8;
const STATIC_FRICTION = 0.8;
const STATIC_RESTITUTION = 0.1;
const IMPACT_COOLDOWN_SEC = 0.12;
const MAX_IMPACTS_PER_STEP = 6;
/** Earthquake: chance per body per step of a jolt, and the jolt's velocity change (m/s). */
const QUAKE_JOLT_CHANCE = 0.3;
const QUAKE_JOLT_H = 0.14;
const QUAKE_JOLT_V = 0.08;
const QUAKE_SPIN = 0.6;
/** Margin below the cake top for pieces that slid off past the plate rim. */
const OFF_PLATE_DROP = 0.05;
const FLOOR_Y = -0.8;

let rapierReady: Promise<void> | null = null;

/** A collider def already multiplied by the piece's scale (positions + sizes). */
type ScaledCollider = ColliderDef;

interface Piece {
  id: string;
  type: PieceType;
  ownerId: string;
  scale: number;
  card: string;
  body: RAPIER.RigidBody;
  colliders: RAPIER.Collider[];
  defs: ScaledCollider[];
  glue: boolean;
  glued: boolean;
  lowTime: number;
  lastImpact: number;
  prevVel: { x: number; y: number; z: number };
}

function scaleDef(c: ColliderDef, s: number): ScaledCollider {
  const pos: [number, number, number] | undefined = c.pos ? [c.pos[0] * s, c.pos[1] * s, c.pos[2] * s] : undefined;
  switch (c.kind) {
    case "box":
      return { kind: "box", hx: c.hx * s, hy: c.hy * s, hz: c.hz * s, pos, rot: c.rot };
    case "ball":
      return { kind: "ball", r: c.r * s, pos };
    case "capsule":
      return { kind: "capsule", halfHeight: c.halfHeight * s, r: c.r * s, pos, rot: c.rot };
    case "cylinder":
      return { kind: "cylinder", halfHeight: c.halfHeight * s, r: c.r * s, pos, rot: c.rot };
    case "cone":
      return { kind: "cone", halfHeight: c.halfHeight * s, r: c.r * s, pos, rot: c.rot };
  }
}

function colliderDesc(c: ScaledCollider): RAPIER.ColliderDesc {
  let d: RAPIER.ColliderDesc;
  switch (c.kind) {
    case "box": d = RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz); break;
    case "ball": d = RAPIER.ColliderDesc.ball(c.r); break;
    case "capsule": d = RAPIER.ColliderDesc.capsule(c.halfHeight, c.r); break;
    case "cylinder": d = RAPIER.ColliderDesc.cylinder(c.halfHeight, c.r); break;
    case "cone": d = RAPIER.ColliderDesc.cone(c.halfHeight, c.r); break;
  }
  if (c.pos) d.setTranslation(c.pos[0], c.pos[1], c.pos[2]);
  if ("rot" in c && c.rot) {
    const [x, y, z, w] = c.rot;
    const n = Math.hypot(x, y, z, w) || 1;
    d.setRotation({ x: x / n, y: y / n, z: z / n, w: w / n });
  }
  return d;
}

/** Half height (world Y) of a collider's AABB, from its world rotation. */
function halfExtentY(c: ScaledCollider, q: RAPIER.Rotation): number {
  // Row 1 of the rotation matrix: how each local axis projects onto world Y.
  const r10 = 2 * (q.x * q.y + q.w * q.z);
  const r11 = 1 - 2 * (q.x * q.x + q.z * q.z);
  const r12 = 2 * (q.y * q.z - q.w * q.x);
  switch (c.kind) {
    case "ball":
      return c.r;
    case "box":
      return Math.abs(r10) * c.hx + Math.abs(r11) * c.hy + Math.abs(r12) * c.hz;
    case "capsule":
      return Math.abs(r11) * c.halfHeight + c.r;
    case "cylinder":
    case "cone":
      return Math.abs(r11) * c.halfHeight + c.r * Math.sqrt(Math.max(0, 1 - r11 * r11));
  }
}

function len3(v: { x: number; y: number; z: number }): number {
  return Math.hypot(v.x, v.y, v.z);
}

export class TowerSim {
  private world: RAPIER.World;
  private events: RAPIER.EventQueue;
  private list: Piece[] = [];
  /** Collider handle → piece (dynamic colliders only). */
  private byCollider = new Map<number, Piece>();
  private nextId = 1;
  private time = 0;

  private gravityScale = 1;
  private windDir = { x: 0, z: 0 };
  private windStrength = 0;
  private quakeLeft = 0;
  private quakeTotal = 0;

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = 1 / TICK_HZ;
    this.world.numSolverIterations = SOLVER_ITERATIONS;
    this.events = new RAPIER.EventQueue(true);
    this.buildStatics();
  }

  /** Loads the Rapier WASM (once per process) and builds the static world. */
  static async create(): Promise<TowerSim> {
    if (!rapierReady) rapierReady = RAPIER.init();
    await rapierReady;
    return new TowerSim();
  }

  // Table, floor, stand (pedestal + plate) and the cake: all static, all grippy-ish.
  private buildStatics(): void {
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const add = (d: RAPIER.ColliderDesc): void => {
      d.setFriction(STATIC_FRICTION).setRestitution(STATIC_RESTITUTION);
      this.world.createCollider(d, ground);
    };
    add(RAPIER.ColliderDesc.cylinder(0.05, TABLE_RADIUS).setTranslation(0, -0.05, 0));
    add(RAPIER.ColliderDesc.cuboid(20, 0.1, 20).setTranslation(0, FLOOR_Y - 0.1, 0));
    // Pedestal from the table up to the plate underside, then a thin plate disc.
    const plateHalf = 0.015;
    const pedestalTop = STAND_PLATE_Y - plateHalf * 2;
    add(RAPIER.ColliderDesc.cylinder(pedestalTop / 2, 0.07).setTranslation(0, pedestalTop / 2, 0));
    add(RAPIER.ColliderDesc.cylinder(plateHalf, STAND_PLATE_RADIUS).setTranslation(0, STAND_PLATE_Y - plateHalf, 0));
    const cakeHalf = (CAKE_TOP_Y - STAND_PLATE_Y) / 2;
    add(RAPIER.ColliderDesc.cylinder(cakeHalf, CAKE_RADIUS).setTranslation(0, STAND_PLATE_Y + cakeHalf, 0));
  }

  /** Remove every piece (fresh cake). */
  clear(): void {
    for (const p of this.list) this.world.removeRigidBody(p.body);
    this.list = [];
    this.byCollider.clear();
    this.quakeLeft = 0;
    this.quakeTotal = 0;
  }

  /** Spawn a dynamic piece at `pose` (already validated by the room). Returns its id. Starts with zero velocity. */
  spawn(type: PieceType, ownerId: string, pose: Pose, mods: SpawnMods): string {
    const def = PIECES[type];
    const scale = mods.scale > 0 ? mods.scale : 1;
    const qn = Math.hypot(pose.qx, pose.qy, pose.qz, pose.qw) || 1;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pose.x, pose.y, pose.z)
        .setRotation({ x: pose.qx / qn, y: pose.qy / qn, z: pose.qz / qn, w: pose.qw / qn })
        .setLinearDamping(LINEAR_DAMPING)
        .setAngularDamping(ANGULAR_DAMPING)
        .setCcdEnabled(true)
        .setCanSleep(true),
    );

    const friction = mods.friction ?? def.friction;
    const restitution = mods.restitution ?? def.restitution;
    const targetMass = Math.max(0.005, def.mass * (mods.massScale > 0 ? mods.massScale : 1));
    const threshold = Math.max(0.3, targetMass * 12);
    const defs = def.colliders.map((c) => scaleDef(c, scale));
    const colliders = defs.map((c) => {
      const d = colliderDesc(c)
        .setDensity(1)
        .setFriction(friction)
        // Min so slippery pieces (soap, butter) stay slippery on the grippy cake.
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(restitution)
        // Max so Jelly Mode actually bounces off the cake.
        .setRestitutionCombineRule(
          mods.restitution !== undefined ? RAPIER.CoefficientCombineRule.Max : RAPIER.CoefficientCombineRule.Average,
        )
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(threshold);
      return this.world.createCollider(d, body);
    });

    // Density 1 → body mass == total volume; rescale density so the body weighs the target mass.
    body.recomputeMassPropertiesFromColliders();
    const volume = body.mass();
    const density = volume > 0 ? targetMass / volume : 1;
    for (const c of colliders) c.setDensity(density);
    body.recomputeMassPropertiesFromColliders();

    const piece: Piece = {
      id: `p${this.nextId++}`,
      type,
      ownerId,
      scale,
      card: mods.card,
      body,
      colliders,
      defs,
      glue: mods.glue,
      glued: false,
      lowTime: 0,
      lastImpact: -Infinity,
      prevVel: { x: 0, y: 0, z: 0 },
    };
    this.list.push(piece);
    for (const c of colliders) this.byCollider.set(c.handle, piece);
    return piece.id;
  }

  /** Gravity multiplier (1 or MOON_GRAVITY_SCALE). */
  setGravityScale(scale: number): void {
    if (scale === this.gravityScale) return;
    this.gravityScale = scale;
    this.world.gravity = { x: 0, y: GRAVITY * scale, z: 0 };
    for (const p of this.list) p.body.wakeUp();
  }

  /** Constant wind acceleration along unit (dx, dz) with strength 0..1 (× WIND_FORCE m/s², gusty: modulate it yourself over time). 0 = off. */
  setWind(dx: number, dz: number, strength: number): void {
    const n = Math.hypot(dx, dz);
    this.windDir = n > 1e-6 ? { x: dx / n, z: dz / n } : { x: 0, z: 0 };
    this.windStrength = n > 1e-6 ? Math.max(0, Math.min(1, strength)) : 0;
    if (this.windStrength === 0) for (const p of this.list) p.body.resetForces(false);
  }

  /** Start an earthquake: random small horizontal/vertical impulses on every dynamic body for `seconds`. */
  quake(seconds: number): void {
    this.quakeLeft = Math.max(this.quakeLeft, seconds);
    this.quakeTotal = Math.max(this.quakeLeft, 1e-3);
    for (const p of this.list) p.body.wakeUp();
  }

  /** Advance one fixed step of `dt` seconds (TICK_MS/1000, or less for slow-mo). Returns impacts this step. */
  step(dt: number): SimImpact[] {
    if (!(dt > 0)) return [];
    this.time += dt;
    this.world.timestep = dt;
    this.applyWind();
    this.applyQuake(dt);
    for (const p of this.list) {
      const v = p.body.linvel();
      p.prevVel = { x: v.x, y: v.y, z: v.z };
    }

    this.world.step(this.events);

    const impacts: SimImpact[] = [];
    const glueQueue: Array<[Piece, RAPIER.RigidBody]> = [];
    const onContact = (h1: number, h2: number): void => {
      const a = this.byCollider.get(h1);
      const b = this.byCollider.get(h2);
      if (!a && !b) return;
      for (const [self, otherHandle, other] of [[a, h2, b], [b, h1, a]] as const) {
        if (!self || !self.glue || self.glued) continue;
        const otherBody = other ? other.body : this.world.getCollider(otherHandle)?.parent();
        if (otherBody && otherBody.handle !== self.body.handle) {
          self.glued = true;
          glueQueue.push([self, otherBody]);
        }
      }
      if (impacts.length >= MAX_IMPACTS_PER_STEP) return;
      const va = a ? a.prevVel : { x: 0, y: 0, z: 0 };
      const vb = b ? b.prevVel : { x: 0, y: 0, z: 0 };
      const speed = len3({ x: va.x - vb.x, y: va.y - vb.y, z: va.z - vb.z });
      if (speed < IMPACT_MIN_SPEED) return;
      // Credit the faster piece (it's the one making the noise).
      const who = a && b ? (len3(a.prevVel) >= len3(b.prevVel) ? a : b) : (a ?? b)!;
      if (this.time - who.lastImpact < IMPACT_COOLDOWN_SEC) return;
      who.lastImpact = this.time;
      impacts.push({ pieceId: who.id, type: who.type, speed, ...this.contactPoint(h1, h2, who) });
    };
    this.events.drainCollisionEvents((h1, h2, started) => {
      if (started) onContact(h1, h2);
    });
    this.events.drainContactForceEvents((e) => onContact(e.collider1(), e.collider2()));

    for (const [piece, other] of glueQueue) this.glue(piece, other);
    this.updateSleep(dt);
    return impacts;
  }

  /** True when every dynamic body has stayed below SLEEP_LIN / SLEEP_ANG for SLEEP_HOLD_SEC (or Rapier says asleep). */
  allAsleep(): boolean {
    return this.list.every((p) => this.isAsleep(p));
  }

  /** First piece whose center is below TOPPLE_Y (or outside the plate radius + 5 cm below CAKE_TOP_Y), or null. */
  toppled(): SimPiece | null {
    for (const p of this.list) {
      const t = p.body.translation();
      const r = Math.hypot(t.x, t.z);
      if (t.y < TOPPLE_Y || (r > STAND_PLATE_RADIUS && t.y < CAKE_TOP_Y - OFF_PLATE_DROP)) return this.view(p);
    }
    return null;
  }

  /** Current transforms of all pieces. */
  pieces(): SimPiece[] {
    return this.list.map((p) => this.view(p));
  }

  /** Highest point of any piece above CAKE_TOP_Y, in meters (0 on an empty cake). Use collider AABBs. */
  towerTop(): number {
    let top = CAKE_TOP_Y;
    for (const p of this.list) {
      // Pieces still flying through the air (just dropped, or tumbling off) aren't part of the tower yet.
      const v = p.body.linvel();
      if (Math.hypot(v.x, v.y, v.z) > 0.3) continue;
      p.colliders.forEach((c, i) => {
        const y = c.translation().y + halfExtentY(p.defs[i], c.rotation());
        if (y > top) top = y;
      });
    }
    return top - CAKE_TOP_Y;
  }

  /**
   * Lowest legal y for the CENTER of a hovering piece of `type` at `scale`: CAKE_TOP_Y + towerTop() +
   * MIN_DROP_GAP + the piece's bounding radius × scale.
   */
  minHoverY(type: PieceType, scale: number): number {
    return CAKE_TOP_Y + this.towerTop() + MIN_DROP_GAP + PIECES[type].radius * scale;
  }

  /** Free the Rapier world. */
  dispose(): void {
    this.list = [];
    this.byCollider.clear();
    this.events.free();
    this.world.free();
  }

  // ------------------------------------------------------------------------------ internals

  private view(p: Piece): SimPiece {
    const t = p.body.translation();
    const q = p.body.rotation();
    return {
      id: p.id,
      type: p.type,
      ownerId: p.ownerId,
      scale: p.scale,
      card: p.card,
      pose: { x: t.x, y: t.y, z: t.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w },
      asleep: this.isAsleep(p),
    };
  }

  private isAsleep(p: Piece): boolean {
    // Anything that rolled off the table onto the kitchen floor is out of the game: count it as asleep.
    return p.body.isSleeping() || p.lowTime >= SLEEP_HOLD_SEC || p.body.translation().y < 0;
  }

  private updateSleep(dt: number): void {
    for (const p of this.list) {
      const still = len3(p.body.linvel()) < SLEEP_LIN && len3(p.body.angvel()) < SLEEP_ANG;
      p.lowTime = still ? p.lowTime + dt : 0;
    }
  }

  // Gusty fan: two out-of-phase sines plus a little direction wobble. Never fully calm, never a hurricane.
  private applyWind(): void {
    if (this.windStrength <= 0) return;
    const t = this.time;
    const gust = Math.max(0, 0.6 + 0.3 * Math.sin(t * 1.7) + 0.25 * Math.sin(t * 4.3 + 1.1));
    const wobble = 0.25 * Math.sin(t * 0.9 + 0.4);
    const c = Math.cos(wobble);
    const s = Math.sin(wobble);
    const dx = this.windDir.x * c - this.windDir.z * s;
    const dz = this.windDir.x * s + this.windDir.z * c;
    const a = WIND_FORCE * this.windStrength * gust;
    for (const p of this.list) {
      const m = p.body.mass();
      p.body.resetForces(false);
      p.body.addForce({ x: dx * a * m, y: 0, z: dz * a * m }, true);
    }
  }

  // Earthquake: random jolts that fade out over the quake's duration.
  private applyQuake(dt: number): void {
    if (this.quakeLeft <= 0) return;
    const fade = Math.min(1, this.quakeLeft / this.quakeTotal) * 0.6 + 0.4;
    this.quakeLeft -= dt;
    for (const p of this.list) {
      if (Math.random() > QUAKE_JOLT_CHANCE) continue;
      const m = p.body.mass();
      const h = QUAKE_JOLT_H * fade;
      p.body.applyImpulse(
        {
          x: (Math.random() * 2 - 1) * h * m,
          y: Math.random() * QUAKE_JOLT_V * fade * m,
          z: (Math.random() * 2 - 1) * h * m,
        },
        true,
      );
      const w = QUAKE_SPIN * fade;
      p.body.setAngvel(
        {
          x: p.body.angvel().x + (Math.random() * 2 - 1) * w,
          y: p.body.angvel().y + (Math.random() * 2 - 1) * w,
          z: p.body.angvel().z + (Math.random() * 2 - 1) * w,
        },
        true,
      );
    }
  }

  // Glue Gun: freeze the current relative pose with a fixed joint (frames: rot1·f1 = rot2·f2).
  private glue(piece: Piece, other: RAPIER.RigidBody): void {
    const b1 = piece.body;
    const p1 = b1.translation();
    const q1 = b1.rotation();
    const p2 = other.translation();
    const q2 = other.rotation();
    const inv2 = { x: -q2.x, y: -q2.y, z: -q2.z, w: q2.w };
    const anchor2 = rotate(inv2, { x: p1.x - p2.x, y: p1.y - p2.y, z: p1.z - p2.z });
    const frame2 = qmul(inv2, q1);
    const data = RAPIER.JointData.fixed({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, anchor2, frame2);
    this.world.createImpulseJoint(data, b1, other, true);
  }

  private contactPoint(h1: number, h2: number, fallback: Piece): { x: number; y: number; z: number } {
    const c1 = this.world.getCollider(h1);
    const c2 = this.world.getCollider(h2);
    let point: { x: number; y: number; z: number } | null = null;
    if (c1 && c2) {
      this.world.contactPair(c1, c2, (m) => {
        if (!point && m.numSolverContacts() > 0) {
          const s = m.solverContactPoint(0);
          point = { x: s.x, y: s.y, z: s.z };
        }
      });
    }
    if (point) return point;
    const t = fallback.body.translation();
    return { x: t.x, y: t.y, z: t.z };
  }
}

type Q = { x: number; y: number; z: number; w: number };
type V = { x: number; y: number; z: number };

function qmul(a: Q, b: Q): Q {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function rotate(q: Q, v: V): V {
  const r = qmul(qmul(q, { x: v.x, y: v.y, z: v.z, w: 0 }), { x: -q.x, y: -q.y, z: -q.z, w: q.w });
  return { x: r.x, y: r.y, z: r.z };
}
