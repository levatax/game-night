// Ball visuals. Owner: client-fx.

import * as THREE from "three";
import { PALETTE } from "../../../shared/constants";
import type { BallKind } from "../../../shared/types";
import type { BallFrame } from "../net/types";
import { createOutlineMaterial, createToonMaterial, getSmoothOutlineGeometry } from "../render/Toon";
import { ballSkinTexture, beachBallTexture, glowTexture, swirlTexture } from "./fxTextures";
import { ballGeometry, bananaGeometry } from "./geometries";
import { Trail } from "./Trail";
import type { BallVisualContext } from "./types";

/** Trail length (s) and how fast glow/trail fade once a ball turns dead. */
const TRAIL_SEC = 0.25;
const DEAD_FADE_SEC = 0.3;
const LIVE_FADE_IN_SEC = 0.05;
const SQUASH_SEC = 0.22;
const REMOVE_SEC = 0.15;
const RADIUS_SMOOTH_SEC = 0.12;
/** Neutral resting bob (m) and idle spin of held balls (rad/s). */
const BOB_HEIGHT = 0.05;
const HOLD_SPIN = 2.2;
/** Rolling spin is capped so fast throws don't strobe. */
const MAX_SPIN = 28;
const RESTING_SPEED = 0.6;
/** Halo sprite diameter relative to the ball radius. */
const HALO_SCALE = 5;
/** A predicted visual is adopted by a server ball of the same owner within this distance (m). */
const ADOPT_DIST = 3;
const OUTLINE_THICKNESS = 0.022;
const BONUS_TINT = "#E6DDFF";
const BONUS_SCALE = 0.85;
/** Banana length is ~2 geometry units: scale so it spans ~2.4 ball radii. */
const BANANA_SCALE = 1.2;

const UP = new THREE.Vector3(0, 1, 0);

interface BallVisual {
  id: string;
  ownerId: string;
  kind: BallKind | "";
  stamp: number;
  /** World position (+ bob). */
  root: THREE.Group;
  /** R·S and R⁻¹: scale along an arbitrary axis (squash on bounce, stretch in flight). */
  squash: THREE.Group;
  unsquash: THREE.Group;
  spinner: THREE.Group;
  sphere: THREE.Mesh;
  sphereMaterial: THREE.MeshToonMaterial;
  banana: THREE.Mesh;
  bananaMaterial: THREE.MeshToonMaterial;
  outlineMaterial: THREE.ShaderMaterial;
  halo: THREE.Sprite;
  haloMaterial: THREE.SpriteMaterial;
  swirl: THREE.Sprite;
  swirlMaterial: THREE.SpriteMaterial;
  trail: Trail;
  color: THREE.Color;
  colorKey: string;
  /** Live glow 0..1 (fades over DEAD_FADE_SEC when dead). */
  glow: number;
  radius: number;
  squashT: number;
  squashAmount: number;
  squashAxis: THREE.Vector3;
  prevV: THREE.Vector3;
  bob: number;
  phase: number;
  /** > 0 while shrinking away after the ball left the state. */
  removing: number;
  heldIndex: number;
}

/**
 * One pooled visual per BallFrame.id. When a predicted "pred:*" ball is replaced by its server
 * ball, the server id appears at (nearly) the same position because BallSync blends, so plain
 * create/remove by id works; reusing the predicted visual (same ownerId) keeps the trail intact.
 * - neutral: cream (ballTexture), subtle bob (+0.05 m sine) when resting, outline.
 * - held: placed at ctx.handOf(holderId) (hidden if false); small idle spin; glows in the holder's
 *   color while charging (handled by GameController via setChargeGlow).
 * - live: emissive glow in the owner's color (intensity grows with charge), colored ribbon trail
 *   (last ~0.25 s of positions), slight stretch along velocity.
 * - dead: glow + trail fade out over 0.3 s.
 * - kinds: mega = radius 0.5 red beach-ball stripes; boomerang = banana-shaped mesh spinning;
 *   bonus = smaller/faded variant of normal; curve = swirl sprite on the trail.
 * - bounced: squash along the impact normal for ~0.12 s.
 * - opacity < 1 for fading predicted balls. castShadow on.
 */
export class BallVisuals {
  private readonly scene: THREE.Scene;
  private readonly visuals = new Map<string, BallVisual>();
  private readonly pool: BallVisual[] = [];
  private readonly charge = new Map<string, number>();
  private readonly unmatched: BallFrame[] = [];
  private readonly heldCounts = new Map<string, number>();
  private stamp = 0;
  private time = 0;
  private readonly hand = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly spinQuat = new THREE.Quaternion();
  private readonly tmpColor = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Per frame with cosmetic dt. */
  sync(balls: readonly BallFrame[], dt: number, ctx: BallVisualContext): void {
    this.stamp++;
    this.time += dt;
    this.heldCounts.clear();
    this.unmatched.length = 0;
    for (const frame of balls) {
      const v = this.visuals.get(frame.id);
      if (v) v.stamp = this.stamp;
      else this.unmatched.push(frame);
    }
    for (const frame of this.unmatched) this.attach(frame).stamp = this.stamp;
    for (const frame of balls) {
      const v = this.visuals.get(frame.id);
      if (v) this.updateVisual(v, frame, dt, ctx);
    }
    for (const v of this.visuals.values()) {
      if (v.stamp !== this.stamp) this.updateRemoved(v, dt);
    }
  }

  /** Held-ball charge glow for a player (0 = off, 1 = full). */
  setChargeGlow(playerId: string, charge: number): void {
    if (charge > 0) this.charge.set(playerId, Math.min(1, charge));
    else this.charge.delete(playerId);
  }

  /** World position of a ball visual (false if unknown). Handy for effects attached to balls. */
  getPosition(id: string, out: THREE.Vector3): boolean {
    const v = this.visuals.get(id);
    if (!v || !v.root.visible) return false;
    out.copy(v.root.position);
    return true;
  }

  clear(): void {
    for (const v of [...this.visuals.values()]) this.release(v);
    this.charge.clear();
  }

  dispose(): void {
    this.clear();
    for (const v of this.pool) disposeVisual(v);
    this.pool.length = 0;
  }

  /* ------------------------------------------------------------- lifecycle */

  /** Visual for a new id: adopt a predicted visual of the same throw, else take one from the pool. */
  private attach(frame: BallFrame): BallVisual {
    const adopted = frame.predicted ? null : this.adoptPredicted(frame);
    if (adopted) return adopted;
    const v = this.pool.pop() ?? this.createVisual();
    v.id = frame.id;
    v.ownerId = frame.ownerId;
    v.kind = "";
    v.glow = frame.state === "live" ? 1 : 0;
    v.radius = frame.radius;
    v.squashT = 0;
    v.removing = 0;
    v.bob = 0;
    v.prevV.set(frame.vx, frame.vy, frame.vz);
    v.root.position.set(frame.x, frame.y, frame.z);
    v.root.scale.setScalar(1);
    v.root.visible = true;
    v.trail.reset();
    this.visuals.set(frame.id, v);
    return v;
  }

  private adoptPredicted(frame: BallFrame): BallVisual | null {
    let best: BallVisual | null = null;
    let bestDist = ADOPT_DIST * ADOPT_DIST;
    for (const v of this.visuals.values()) {
      if (v.stamp === this.stamp || !v.id.startsWith("pred:") || v.ownerId !== frame.ownerId) continue;
      const d = v.root.position.distanceToSquared(this.hand.set(frame.x, frame.y, frame.z));
      if (d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
    if (!best) return null;
    this.visuals.delete(best.id);
    best.id = frame.id;
    best.removing = 0;
    this.visuals.set(frame.id, best);
    return best;
  }

  private release(v: BallVisual): void {
    this.visuals.delete(v.id);
    v.root.visible = false;
    v.trail.reset();
    this.pool.push(v);
  }

  private updateRemoved(v: BallVisual, dt: number): void {
    v.removing += dt;
    const k = 1 - v.removing / REMOVE_SEC;
    if (k <= 0 || v.id.startsWith("pred:")) {
      this.release(v);
      return;
    }
    v.root.scale.setScalar(k * (1 + 0.25 * Math.sin(k * Math.PI)));
    v.glow = Math.max(0, v.glow - dt / DEAD_FADE_SEC);
    v.trail.setStyle(v.color, v.radius * 1.4, v.glow * 0.85);
    v.trail.rebuild(v.root.position.x, v.root.position.y, v.root.position.z);
  }

  private createVisual(): BallVisual {
    const root = new THREE.Group();
    root.name = "fx-ball";
    const squash = new THREE.Group();
    const unsquash = new THREE.Group();
    const spinner = new THREE.Group();
    root.add(squash);
    squash.add(unsquash);
    unsquash.add(spinner);

    const outlineMaterial = createOutlineMaterial(OUTLINE_THICKNESS);
    outlineMaterial.transparent = true;
    const sphereMaterial = createToonMaterial("#FFFFFF", { map: ballSkinTexture() });
    const sphere = new THREE.Mesh(ballGeometry(), sphereMaterial);
    sphere.castShadow = true;
    sphere.add(outlineMesh(ballGeometry(), outlineMaterial));
    const bananaMaterial = createToonMaterial("#FFFFFF", { vertexColors: true, flatShading: true });
    const banana = new THREE.Mesh(bananaGeometry(), bananaMaterial);
    banana.castShadow = true;
    banana.add(outlineMesh(bananaGeometry(), outlineMaterial));
    spinner.add(sphere, banana);

    const haloMaterial = new THREE.SpriteMaterial({
      map: glowTexture(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const halo = new THREE.Sprite(haloMaterial);
    halo.renderOrder = 1;
    const swirlMaterial = new THREE.SpriteMaterial({
      map: swirlTexture(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const swirl = new THREE.Sprite(swirlMaterial);
    swirl.renderOrder = 1;
    root.add(halo, swirl);
    this.scene.add(root);

    return {
      id: "",
      ownerId: "",
      kind: "",
      stamp: 0,
      root,
      squash,
      unsquash,
      spinner,
      sphere,
      sphereMaterial,
      banana,
      bananaMaterial,
      outlineMaterial,
      halo,
      haloMaterial,
      swirl,
      swirlMaterial,
      trail: new Trail(this.scene, TRAIL_SEC),
      color: new THREE.Color(),
      colorKey: "",
      glow: 0,
      radius: 0.25,
      squashT: 0,
      squashAmount: 0,
      squashAxis: new THREE.Vector3(0, 1, 0),
      prevV: new THREE.Vector3(),
      bob: 0,
      phase: Math.random() * Math.PI * 2,
      removing: 0,
      heldIndex: 0,
    };
  }

  /* ----------------------------------------------------------------- update */

  private updateVisual(v: BallVisual, frame: BallFrame, dt: number, ctx: BallVisualContext): void {
    v.removing = 0;
    v.root.scale.setScalar(1);
    v.ownerId = frame.ownerId || v.ownerId;
    this.applyKind(v, frame.kind);
    this.applyColor(v, frame, ctx);
    v.radius += (frame.radius - v.radius) * Math.min(1, dt / RADIUS_SMOOTH_SEC);
    if (frame.state === "held") {
      this.updateHeld(v, frame, dt, ctx);
    } else {
      v.root.visible = true;
      this.updateFree(v, frame, dt);
    }
    this.applyOpacity(v, frame.opacity);
  }

  private applyKind(v: BallVisual, kind: BallKind): void {
    if (v.kind === kind) return;
    v.kind = kind;
    const isBanana = kind === "boomerang";
    v.sphere.visible = !isBanana;
    v.banana.visible = isBanana;
    v.sphereMaterial.map = kind === "mega" ? beachBallTexture() : ballSkinTexture();
    v.sphereMaterial.color.set(kind === "bonus" ? BONUS_TINT : "#FFFFFF");
    v.spinner.quaternion.identity();
  }

  private applyColor(v: BallVisual, frame: BallFrame, ctx: BallVisualContext): void {
    const who = frame.state === "held" ? frame.holderId : frame.ownerId;
    const key = who ? ctx.colorOf(who) : PALETTE.neutralBall;
    if (key === v.colorKey) return;
    v.colorKey = key;
    v.color.set(key);
    v.haloMaterial.color.copy(v.color);
    v.swirlMaterial.color.copy(v.color);
  }

  private updateHeld(v: BallVisual, frame: BallFrame, dt: number, ctx: BallVisualContext): void {
    if (!ctx.handOf(frame.holderId, this.hand)) {
      v.root.visible = false;
      v.trail.reset();
      return;
    }
    // A Triple Shot carrier holds two: stack the second one just above the hand.
    const index = this.heldCounts.get(frame.holderId) ?? 0;
    this.heldCounts.set(frame.holderId, index + 1);
    v.root.visible = true;
    v.root.position.copy(this.hand);
    v.root.position.y += index * v.radius * 1.7;
    v.trail.reset();
    v.squashT = 0;
    this.resetSquash(v);
    this.spinAround(v, UP, HOLD_SPIN * dt);

    const charge = this.charge.get(frame.holderId) ?? 0;
    v.glow = charge;
    const full = charge >= 0.999;
    const pulse = full ? 0.5 + 0.5 * Math.sin(this.time * 16) : 0;
    const wobble = full ? 1 + 0.06 * Math.sin(this.time * 22) : 1;
    this.setBodyScale(v, wobble);
    this.setEmissive(v, charge * (0.55 + 0.35 * pulse));
    this.setHalo(v, charge * charge * (0.75 + 0.25 * pulse), 0.8 + 0.25 * pulse);
    v.swirl.visible = false;
  }

  private updateFree(v: BallVisual, frame: BallFrame, dt: number): void {
    const live = frame.state === "live";
    if (live) v.glow = Math.min(1, v.glow + dt / LIVE_FADE_IN_SEC);
    else v.glow = Math.max(0, v.glow - dt / DEAD_FADE_SEC);

    this.updateBob(v, frame, dt);
    v.root.position.set(frame.x, frame.y + v.bob * BOB_HEIGHT * (0.5 + 0.5 * Math.sin(this.time * 2.6 + v.phase)), frame.z);
    this.vel.set(frame.vx, frame.vy, frame.vz);
    if (frame.bounced) this.startSquash(v, frame.bounceSpeed);
    this.updateDeform(v, live, dt);
    this.updateSpin(v, frame, dt);
    v.prevV.copy(this.vel);

    this.setBodyScale(v);
    const strength = v.glow * (0.45 + 0.55 * frame.charge);
    this.setEmissive(v, strength * 0.85);
    this.setHalo(v, strength * 0.7, 1);
    this.updateSwirl(v, frame, dt);
    this.updateTrail(v, frame, dt);
  }

  private updateBob(v: BallVisual, frame: BallFrame, dt: number): void {
    const speed = Math.hypot(frame.vx, frame.vy, frame.vz);
    const resting = frame.state === "neutral" && speed < RESTING_SPEED;
    v.bob += ((resting ? 1 : 0) - v.bob) * Math.min(1, dt * 3);
  }

  private updateSpin(v: BallVisual, frame: BallFrame, dt: number): void {
    if (v.kind === "boomerang") {
      // Boomerangs whirl flat; a resting banana just lies there.
      const rate = frame.state === "live" ? (frame.returning ? -16 : 16) : Math.hypot(frame.vx, frame.vz) * 2;
      this.spinAround(v, UP, rate * dt);
      return;
    }
    const h = Math.hypot(frame.vx, frame.vz);
    if (h < 1e-3) return;
    // Rolling: axis = up × velocity.
    this.axis.set(frame.vz / h, 0, -frame.vx / h);
    this.spinAround(v, this.axis, Math.min(MAX_SPIN, h / Math.max(0.05, v.radius)) * dt);
  }

  private spinAround(v: BallVisual, axis: THREE.Vector3, angle: number): void {
    if (angle === 0) return;
    this.spinQuat.setFromAxisAngle(axis, angle);
    v.spinner.quaternion.premultiply(this.spinQuat).normalize();
  }

  private startSquash(v: BallVisual, impactSpeed: number): void {
    this.axis.subVectors(this.vel, v.prevV);
    if (this.axis.lengthSq() < 0.25) this.axis.copy(UP);
    v.squashAxis.copy(this.axis.normalize());
    v.squashAmount = Math.min(1, Math.max(0.2, impactSpeed / 14)) * 0.38;
    v.squashT = SQUASH_SEC;
  }

  /** Jelly squash after a bounce, otherwise a slight stretch along the flight direction. */
  private updateDeform(v: BallVisual, live: boolean, dt: number): void {
    if (v.squashT > 0) {
      v.squashT = Math.max(0, v.squashT - dt);
      const u = 1 - v.squashT / SQUASH_SEC;
      const k = v.squashAmount * (1 - u) * Math.cos(u * Math.PI * 2.5);
      this.setDeform(v, v.squashAxis, 1 - k, 1 + k * 0.5);
      return;
    }
    const speed = this.vel.length();
    if (live && speed > 1 && v.kind !== "boomerang") {
      const k = Math.min(1, speed / 34) * 0.13;
      this.axis.copy(this.vel).divideScalar(speed);
      this.setDeform(v, this.axis, 1 + k, 1 - k * 0.45);
      return;
    }
    this.resetSquash(v);
  }

  private setDeform(v: BallVisual, axis: THREE.Vector3, along: number, across: number): void {
    this.quat.setFromUnitVectors(UP, axis);
    v.squash.quaternion.copy(this.quat);
    v.squash.scale.set(across, along, across);
    v.unsquash.quaternion.copy(this.quat).invert();
  }

  private resetSquash(v: BallVisual): void {
    v.squash.quaternion.identity();
    v.squash.scale.setScalar(1);
    v.unsquash.quaternion.identity();
  }

  /** Body size from the (smoothed) radius and kind. */
  private setBodyScale(v: BallVisual, extra = 1): void {
    const r = v.radius * extra;
    if (v.kind === "boomerang") v.banana.scale.setScalar(r * BANANA_SCALE);
    else v.sphere.scale.setScalar(v.kind === "bonus" ? r * BONUS_SCALE : r);
  }

  private setEmissive(v: BallVisual, strength: number): void {
    const s = Math.max(0, strength);
    this.tmpColor.copy(v.color).multiplyScalar(s);
    v.sphereMaterial.emissive.copy(this.tmpColor);
    v.bananaMaterial.emissive.copy(this.tmpColor);
  }

  private setHalo(v: BallVisual, alpha: number, size: number): void {
    v.halo.visible = alpha > 0.01;
    if (!v.halo.visible) return;
    v.haloMaterial.opacity = Math.min(1, alpha);
    v.halo.scale.setScalar(v.radius * HALO_SCALE * size);
  }

  private updateSwirl(v: BallVisual, frame: BallFrame, dt: number): void {
    v.swirl.visible = frame.curve && v.glow > 0.02;
    if (!v.swirl.visible) return;
    v.swirlMaterial.rotation -= 12 * dt;
    v.swirlMaterial.opacity = v.glow * 0.9;
    v.swirl.scale.setScalar(v.radius * 3.4);
  }

  private updateTrail(v: BallVisual, frame: BallFrame, dt: number): void {
    if (v.glow <= 0.01 && frame.state !== "live") {
      v.trail.reset();
      return;
    }
    v.trail.record(dt, frame.x, frame.y, frame.z);
    const width = v.radius * (v.kind === "mega" ? 1.5 : 1.4);
    v.trail.setStyle(v.color, width, v.glow * 0.85 * frame.opacity);
    v.trail.rebuild(frame.x, frame.y, frame.z);
  }

  private applyOpacity(v: BallVisual, opacity: number): void {
    const transparent = opacity < 0.999;
    if (v.sphereMaterial.transparent !== transparent) {
      v.sphereMaterial.transparent = transparent;
      v.bananaMaterial.transparent = transparent;
      v.sphereMaterial.needsUpdate = true;
      v.bananaMaterial.needsUpdate = true;
    }
    v.sphereMaterial.opacity = opacity;
    v.bananaMaterial.opacity = opacity;
    v.outlineMaterial.uniforms.opacity.value = opacity;
    v.outlineMaterial.visible = opacity > 0.05;
    if (transparent) v.haloMaterial.opacity *= opacity;
  }
}

function outlineMesh(geometry: THREE.BufferGeometry, material: THREE.ShaderMaterial): THREE.Mesh {
  const mesh = new THREE.Mesh(getSmoothOutlineGeometry(geometry), material);
  mesh.name = "outline";
  mesh.userData.isOutline = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.raycast = () => {};
  return mesh;
}

function disposeVisual(v: BallVisual): void {
  v.root.removeFromParent();
  v.trail.dispose();
  v.sphereMaterial.dispose();
  v.bananaMaterial.dispose();
  v.outlineMaterial.dispose();
  v.haloMaterial.dispose();
  v.swirlMaterial.dispose();
}
