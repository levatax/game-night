// Power-up pickups + pedestal shimmer. Owner: client-fx.

import * as THREE from "three";
import { PEDESTAL_HEIGHT, POWERUP_HOVER_Y, POWERUP_WARNING_TICKS, POWERUPS, ticksToSec } from "../../../shared/constants";
import type { ArenaDef } from "../../../shared/maps";
import type { PowerUpType, PowerUpView } from "../../../shared/types";
import { glowTexture, spriteTexture, TILE } from "./fxTextures";
import { createPowerUpModel, type PowerUpModel } from "./powerUpModels";

const WARNING_SEC = ticksToSec(POWERUP_WARNING_TICKS);
const APPEAR_SEC = 0.35;
const PICKUP_SEC = 0.35;
const CANCEL_SEC = 0.25;
const COLUMN_HEIGHT = 2.6;
const COLUMN_RADIUS = 0.62;
const SPARKLES = 7;
const SPIN_SPEED = 1.8;
const BOB = 0.12;

const COLUMN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Rising bands that fade toward the top: a magic "something is coming" beam.
const COLUMN_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uIntensity;
  varying vec2 vUv;
  void main() {
    float fade = pow(1.0 - vUv.y, 1.6);
    float bands = smoothstep(0.55, 1.0, sin((vUv.y * 9.0 - uTime * 3.2) * 3.14159) * 0.5 + 0.5);
    float streaks = 0.75 + 0.25 * sin(vUv.x * 6.2832 * 6.0 + uTime * 1.5);
    float a = uIntensity * fade * (0.35 + 0.65 * bands) * streaks;
    gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.35) * a, a);
    #include <colorspace_fragment>
  }
`;

type Stage = "warning" | "ready" | "pickup" | "cancel";

interface PowerUpVisual {
  id: string;
  type: PowerUpType;
  stage: Stage;
  /** Seconds in the current stage. */
  t: number;
  stamp: number;
  phase: number;
  root: THREE.Group;
  hover: THREE.Group;
  model: PowerUpModel;
  column: THREE.Mesh;
  columnMaterial: THREE.ShaderMaterial;
  disc: THREE.Mesh;
  discMaterial: THREE.MeshBasicMaterial;
  ring: THREE.Mesh;
  ringMaterial: THREE.MeshBasicMaterial;
  halo: THREE.Sprite;
  haloMaterial: THREE.SpriteMaterial;
  sparkles: THREE.Sprite[];
  sparkleMaterial: THREE.SpriteMaterial;
  /** Column intensity when the warning ended (fades from here). */
  columnFrom: number;
}

/**
 * Models (procedural, toon + outline): mega = giant red beach ball, triple = 3 small balls in a
 * bundle, boomerang = banana-shaped ball, zoomies = sneakers with wings. Ready pickups hover at
 * PEDESTAL_HEIGHT + POWERUP_HOVER_Y, spin and bob, with a glow ring. "warning" phase: pedestal
 * shimmer column (sparkles + pulsing light) without the model. Removal = shrink-pop.
 *
 * Warning: the shimmer builds up over the 2 s and the model materializes as a glowing ghost in
 * the last half second. Ready: pop-in with a white flash. Picked up: swell-and-vanish with an
 * expanding ring. A warning that disappears without becoming ready just fades.
 */
export class PowerUpVisuals {
  private readonly scene: THREE.Scene;
  private readonly visuals = new Map<string, PowerUpVisual>();
  private stamp = 0;
  private arena: ArenaDef | null = null;
  private readonly columnGeometry: THREE.CylinderGeometry;
  private readonly discGeometry: THREE.PlaneGeometry;
  private readonly ringGeometry: THREE.RingGeometry;
  private readonly flash = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.columnGeometry = new THREE.CylinderGeometry(COLUMN_RADIUS, COLUMN_RADIUS * 0.85, COLUMN_HEIGHT, 28, 1, true);
    this.columnGeometry.translate(0, COLUMN_HEIGHT / 2, 0);
    this.discGeometry = new THREE.PlaneGeometry(2.4, 2.4);
    this.discGeometry.rotateX(-Math.PI / 2);
    this.ringGeometry = new THREE.RingGeometry(0.5, 0.63, 48);
    this.ringGeometry.rotateX(-Math.PI / 2);
  }

  /** New arena: forget pickups of the old one (the pedestals themselves are part of the Arena). */
  setArena(def: ArenaDef): void {
    this.arena = def;
    this.clear();
  }

  sync(powerUps: readonly PowerUpView[], dt: number, elapsed: number): void {
    this.stamp++;
    for (const pu of powerUps) {
      let v = this.visuals.get(pu.id);
      if (!v || v.type !== pu.type) {
        if (v) this.dropVisual(v);
        v = this.createVisual(pu);
        this.visuals.set(pu.id, v);
      }
      v.stamp = this.stamp;
      if (pu.phase === "ready" && v.stage === "warning") this.enterStage(v, "ready");
      const spot = this.arena?.pedestals[pu.pedestal] ?? pu;
      v.root.position.set(spot.x, PEDESTAL_HEIGHT, spot.z);
    }
    for (const v of this.visuals.values()) {
      if (v.stamp !== this.stamp && (v.stage === "warning" || v.stage === "ready")) {
        this.enterStage(v, v.stage === "ready" ? "pickup" : "cancel");
      }
      this.animate(v, dt, elapsed);
    }
  }

  clear(): void {
    for (const v of [...this.visuals.values()]) this.dropVisual(v);
  }

  dispose(): void {
    this.clear();
    this.columnGeometry.dispose();
    this.discGeometry.dispose();
    this.ringGeometry.dispose();
  }

  /* --------------------------------------------------------------- building */

  private createVisual(pu: PowerUpView): PowerUpVisual {
    const color = new THREE.Color(POWERUPS[pu.type].color);
    const root = new THREE.Group();
    root.name = `fx-powerup-${pu.type}`;
    const hover = new THREE.Group();
    hover.position.y = POWERUP_HOVER_Y;
    root.add(hover);
    const model = createPowerUpModel(pu.type);
    hover.add(model.group);

    const columnMaterial = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color.clone() }, uTime: { value: 0 }, uIntensity: { value: 0 } },
      vertexShader: COLUMN_VERTEX,
      fragmentShader: COLUMN_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const column = new THREE.Mesh(this.columnGeometry, columnMaterial);
    const discMaterial = additiveBasic(glowTexture(), color);
    const disc = new THREE.Mesh(this.discGeometry, discMaterial);
    disc.position.y = 0.02;
    const ringMaterial = additiveBasic(null, color);
    const ring = new THREE.Mesh(this.ringGeometry, ringMaterial);
    ring.position.y = 0.04;
    const haloMaterial = new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    const halo = new THREE.Sprite(haloMaterial);
    halo.position.y = POWERUP_HOVER_Y;
    const sparkleMaterial = new THREE.SpriteMaterial({
      map: spriteTexture(TILE.sparkle),
      color: color.clone().lerp(new THREE.Color("#FFFFFF"), 0.5),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const sparkles: THREE.Sprite[] = [];
    for (let i = 0; i < SPARKLES; i++) {
      const s = new THREE.Sprite(sparkleMaterial);
      sparkles.push(s);
      root.add(s);
    }
    for (const o of [column, disc, ring, halo]) {
      o.renderOrder = 2;
      root.add(o);
    }
    this.scene.add(root);
    const v: PowerUpVisual = {
      id: pu.id,
      type: pu.type,
      stage: pu.phase === "ready" ? "ready" : "warning",
      t: 0,
      stamp: 0,
      phase: Math.random() * Math.PI * 2,
      root,
      hover,
      model,
      column,
      columnMaterial,
      disc,
      discMaterial,
      ring,
      ringMaterial,
      halo,
      haloMaterial,
      sparkles,
      sparkleMaterial,
      columnFrom: pu.phase === "ready" ? 0 : 1,
    };
    return v;
  }

  private enterStage(v: PowerUpVisual, stage: Stage): void {
    if (stage === "ready" || stage === "cancel") v.columnFrom = this.columnIntensity(v);
    v.stage = stage;
    v.t = 0;
  }

  private dropVisual(v: PowerUpVisual): void {
    this.visuals.delete(v.id);
    v.root.removeFromParent();
    v.model.dispose();
    v.columnMaterial.dispose();
    v.discMaterial.dispose();
    v.ringMaterial.dispose();
    v.haloMaterial.dispose();
    v.sparkleMaterial.dispose();
  }

  /* -------------------------------------------------------------- animation */

  private animate(v: PowerUpVisual, dt: number, elapsed: number): void {
    v.t += dt;
    v.columnMaterial.uniforms.uTime.value = elapsed;
    v.model.animate(elapsed);
    switch (v.stage) {
      case "warning":
        this.animateWarning(v, elapsed);
        break;
      case "ready":
        this.animateReady(v, dt, elapsed);
        break;
      case "pickup":
        this.animatePickup(v);
        break;
      case "cancel":
        this.animateCancel(v);
        break;
    }
  }

  private columnIntensity(v: PowerUpVisual): number {
    return v.columnMaterial.uniforms.uIntensity.value as number;
  }

  private animateWarning(v: PowerUpVisual, elapsed: number): void {
    const p = Math.min(1, v.t / WARNING_SEC);
    const flicker = 0.85 + 0.15 * Math.sin(elapsed * (8 + 26 * p));
    v.columnMaterial.uniforms.uIntensity.value = (0.4 + 0.9 * p) * flicker;
    v.discMaterial.opacity = (0.3 + 0.5 * p) * flicker;
    v.ring.visible = true;
    v.ringMaterial.opacity = 0.25 + 0.5 * p;
    v.ring.scale.setScalar(1.6 - 0.6 * p);
    v.ring.rotation.y = elapsed * (1 + 3 * p);
    this.animateSparkles(v, elapsed, 0.6 + 1.6 * p, 0.4 + 0.6 * p);
    v.halo.visible = false;
    // The pickup materializes as a glowing ghost during the last half second.
    const ghost = Math.max(0, (p - 0.72) / 0.28);
    v.model.group.visible = ghost > 0;
    v.model.group.scale.setScalar(0.45 * ghost * (0.9 + 0.1 * Math.sin(elapsed * 40)));
    this.setFlash(v, 1);
    this.spin(v, elapsed);
  }

  private animateReady(v: PowerUpVisual, dt: number, elapsed: number): void {
    const appear = Math.min(1, v.t / APPEAR_SEC);
    v.model.group.visible = true;
    v.model.group.scale.setScalar(easeOutBack(appear));
    this.setFlash(v, Math.max(0, 1 - v.t / APPEAR_SEC));
    v.columnMaterial.uniforms.uIntensity.value = v.columnFrom * Math.max(0, 1 - v.t / 0.45);
    v.discMaterial.opacity = 0.45 + 0.15 * Math.sin(elapsed * 3 + v.phase);
    v.ring.visible = true;
    v.ring.scale.setScalar(1);
    v.ring.rotation.y += dt * 1.2;
    v.ringMaterial.opacity = 0.55 + 0.25 * Math.sin(elapsed * 4 + v.phase);
    v.halo.visible = true;
    v.haloMaterial.opacity = 0.45 + 0.1 * Math.sin(elapsed * 3);
    v.halo.scale.setScalar(2.1);
    v.halo.position.y = v.hover.position.y;
    this.animateSparkles(v, elapsed, 0.5, Math.max(0, 1 - v.t / 0.6) * 0.8);
    this.spin(v, elapsed);
  }

  private animatePickup(v: PowerUpVisual): void {
    const u = Math.min(1, v.t / PICKUP_SEC);
    const s = u < 0.3 ? 1 + 0.45 * (u / 0.3) : 1.45 * (1 - (u - 0.3) / 0.7);
    v.model.group.scale.setScalar(Math.max(0, s));
    this.setFlash(v, Math.min(1, u * 3));
    v.ring.scale.setScalar(1 + u * 3.2);
    v.ringMaterial.opacity = 1 - u;
    v.halo.scale.setScalar(2.1 + u * 2.5);
    v.haloMaterial.opacity = 0.8 * (1 - u);
    v.discMaterial.opacity = 0.6 * (1 - u);
    v.columnMaterial.uniforms.uIntensity.value = 0;
    this.hideSparkles(v);
    if (u >= 1) this.dropVisual(v);
  }

  private animateCancel(v: PowerUpVisual): void {
    const k = Math.max(0, 1 - v.t / CANCEL_SEC);
    v.columnMaterial.uniforms.uIntensity.value = v.columnFrom * k;
    v.discMaterial.opacity = 0.6 * v.columnFrom * k;
    v.ringMaterial.opacity = 0.6 * v.columnFrom * k;
    v.model.group.visible = false;
    this.hideSparkles(v);
    if (k <= 0) this.dropVisual(v);
  }

  private spin(v: PowerUpVisual, elapsed: number): void {
    v.hover.position.y = POWERUP_HOVER_Y + BOB * Math.sin(elapsed * 2.2 + v.phase);
    v.hover.rotation.y = elapsed * SPIN_SPEED + v.phase;
    v.hover.rotation.z = 0.12 * Math.sin(elapsed * 1.3 + v.phase);
  }

  /** Sparkles spiral up the column; `speed` in loops/s, `alpha` overall opacity. */
  private animateSparkles(v: PowerUpVisual, elapsed: number, speed: number, alpha: number): void {
    v.sparkleMaterial.opacity = Math.min(1, alpha);
    for (let i = 0; i < v.sparkles.length; i++) {
      const s = v.sparkles[i];
      const offset = i / v.sparkles.length;
      const u = (elapsed * speed * 0.45 + offset) % 1;
      const a = offset * Math.PI * 2 + elapsed * 2.4;
      const r = COLUMN_RADIUS * (0.95 - 0.35 * u);
      s.visible = alpha > 0.01;
      s.position.set(Math.cos(a) * r, 0.15 + u * COLUMN_HEIGHT * 0.85, Math.sin(a) * r);
      const twinkle = 0.6 + 0.4 * Math.sin(elapsed * 18 + i * 2.1);
      s.scale.setScalar(0.28 * twinkle * Math.sin(Math.PI * u));
    }
  }

  private hideSparkles(v: PowerUpVisual): void {
    for (const s of v.sparkles) s.visible = false;
  }

  /** White emissive flash on the model (1 = full white). */
  private setFlash(v: PowerUpVisual, k: number): void {
    this.flash.setRGB(k * 0.9, k * 0.9, k * 0.9);
    for (const m of v.model.materials) m.emissive.copy(this.flash);
  }
}

function additiveBasic(map: THREE.Texture | null, color: THREE.Color): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map,
    color,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
