// Ambient life around the island per theme: butterflies (picnic), big soap bubbles (bath),
// party balloons drifting up (cake). Each kind is one or two InstancedMeshes.

import * as THREE from "three";
import { createToonMaterial } from "../Toon";
import { Baker } from "../arena/Baker";
import { BALLOON_COLORS } from "../arena/decor/partyDecor";
import { MaterialBank } from "../arena/MaterialBank";
import { createBubbleMaterial } from "../bubbleMaterial";
import { createRng, wobble } from "../noise";

export interface SkyPart {
  readonly object: THREE.Object3D;
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

/* ============================================================= butterflies */

interface ButterflyPath {
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  speed: number;
  phase: number;
}

const WING_COLORS = ["#FFB3D1", "#FFE066", "#FFFFFF", "#9FD8FF", "#C9B6FF", "#FFB36B"];

export class Butterflies implements SkyPart {
  readonly object = new THREE.Group();
  private readonly bank = new MaterialBank();
  private readonly paths: ButterflyPath[] = [];
  private readonly bodies: THREE.InstancedMesh;
  private readonly leftWings: THREE.InstancedMesh;
  private readonly rightWings: THREE.InstancedMesh;

  constructor(count: number) {
    this.object.name = "butterflies";
    const rng = createRng(4242);
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      const r = 6 + rng() * 9;
      this.paths.push({
        cx: Math.cos(a) * r,
        cy: 1.4 + rng() * 2.6,
        cz: Math.sin(a) * r,
        radius: 1.2 + rng() * 2.2,
        speed: 0.35 + rng() * 0.35,
        phase: rng() * 100,
      });
    }
    const wing = this.bank.geo(wingGeometry());
    const wingMat = this.bank.own(createToonMaterial("#FFFFFF", { side: THREE.DoubleSide }));
    const bodyGeo = this.bank.geo(new THREE.CapsuleGeometry(0.025, 0.14, 3, 6).rotateX(Math.PI / 2));
    const bodyMat = this.bank.own(createToonMaterial("#3B2E3A"));
    this.bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, count);
    this.leftWings = new THREE.InstancedMesh(wing, wingMat, count);
    this.rightWings = new THREE.InstancedMesh(wing, wingMat, count);
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      color.set(WING_COLORS[i % WING_COLORS.length]);
      this.leftWings.setColorAt(i, color);
      this.rightWings.setColorAt(i, color);
    }
    for (const m of [this.bodies, this.leftWings, this.rightWings]) {
      m.frustumCulled = false;
      this.object.add(m);
    }
  }

  update(_dt: number, elapsed: number): void {
    this.paths.forEach((p, i) => {
      const t = elapsed * p.speed + p.phase;
      const x = p.cx + Math.cos(t) * p.radius + wobble(t * 2.1, i) * 0.5;
      const y = p.cy + Math.sin(t * 2.3) * 0.5 + Math.abs(Math.sin(elapsed * 6 + i)) * 0.12;
      const z = p.cz + Math.sin(t) * p.radius * 0.7 + wobble(t * 1.7, i + 9) * 0.5;
      // Heading along the path derivative.
      const yaw = Math.atan2(-Math.sin(t) * p.radius, Math.cos(t) * p.radius * 0.7);
      tmpQ.setFromAxisAngle(UP, yaw);
      tmpP.set(x, y, z);
      tmpS.setScalar(1);
      tmpM.compose(tmpP, tmpQ, tmpS);
      this.bodies.setMatrixAt(i, tmpM);
      const flap = 0.15 + Math.abs(Math.sin(elapsed * 16 + p.phase)) * 1.1;
      this.rightWings.setMatrixAt(i, tmpM2.copy(tmpM).multiply(rotZ(flap)));
      this.leftWings.setMatrixAt(i, tmpM2.copy(tmpM).multiply(rotZ(-flap)).multiply(MIRROR_X));
    });
    this.bodies.instanceMatrix.needsUpdate = true;
    this.leftWings.instanceMatrix.needsUpdate = true;
    this.rightWings.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const m of [this.bodies, this.leftWings, this.rightWings]) m.dispose();
    this.bank.dispose();
  }
}

const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);
const rotZMatrix = new THREE.Matrix4();
function rotZ(angle: number): THREE.Matrix4 {
  return rotZMatrix.makeRotationAxis(AXIS_Z, angle);
}

/** Right wing in the XZ plane (two lobes), extending toward +X from the body axis. */
function wingGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0.02);
  s.bezierCurveTo(0.08, 0.2, 0.26, 0.2, 0.24, 0.06);
  s.bezierCurveTo(0.23, 0.0, 0.16, -0.02, 0.12, -0.02);
  s.bezierCurveTo(0.2, -0.06, 0.18, -0.17, 0.08, -0.15);
  s.bezierCurveTo(0.03, -0.14, 0.0, -0.06, 0, 0.02);
  const g = new THREE.ShapeGeometry(s, 6);
  g.rotateX(Math.PI / 2);
  return g;
}

/* ========================================================== giant bubbles */

interface FloatingBubble {
  x: number;
  y: number;
  z: number;
  size: number;
  speed: number;
  phase: number;
}

/** Big soap bubbles floating up around the tub, wrapping from below the water line to the ceiling. */
export class AmbientBubbles implements SkyPart {
  readonly object: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly bubbles: FloatingBubble[] = [];
  private static readonly BOTTOM = -22;
  private static readonly TOP = 34;

  constructor(count: number) {
    const rng = createRng(909);
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      const r = 17 + rng() * 30;
      this.bubbles.push({
        x: Math.cos(a) * r,
        y: AmbientBubbles.BOTTOM + rng() * (AmbientBubbles.TOP - AmbientBubbles.BOTTOM),
        z: Math.sin(a) * r,
        size: 0.35 + rng() * rng() * 1.6,
        speed: 0.5 + rng() * 0.9,
        phase: rng() * 40,
      });
    }
    this.material = createBubbleMaterial("#EAF8FF", 0.95);
    this.object = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 20, 14), this.material, Math.max(1, count));
    this.object.name = "ambientBubbles";
    this.object.count = count;
    this.object.frustumCulled = false;
    this.object.renderOrder = 3;
  }

  update(dt: number, elapsed: number): void {
    const span = AmbientBubbles.TOP - AmbientBubbles.BOTTOM;
    this.bubbles.forEach((b, i) => {
      b.y += b.speed * dt;
      if (b.y > AmbientBubbles.TOP) b.y -= span;
      const squish = 1 + Math.sin(elapsed * 2.2 + b.phase) * 0.05;
      tmpP.set(b.x + wobble(elapsed * 0.4 + b.phase, 1) * 1.5, b.y, b.z + wobble(elapsed * 0.35 + b.phase, 6) * 1.5);
      tmpM.makeScale(b.size * squish, b.size / squish, b.size * squish).setPosition(tmpP);
      this.object.setMatrixAt(i, tmpM);
    });
    this.object.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
    this.object.dispose();
  }
}

/* ========================================================== party balloons */

interface DriftBalloon {
  x: number;
  y: number;
  z: number;
  scale: number;
  speed: number;
  phase: number;
}

/** Distant balloons rising slowly through the dusk sky and wrapping around. */
export class DriftingBalloons implements SkyPart {
  readonly object: THREE.InstancedMesh;
  private readonly material: THREE.MeshToonMaterial;
  private readonly balloons: DriftBalloon[] = [];
  private static readonly BOTTOM = -40;
  private static readonly TOP = 60;

  constructor(count: number) {
    const rng = createRng(1717);
    this.material = createToonMaterial("#FFFFFF", { vertexColors: true });
    this.object = new THREE.InstancedMesh(balloonWhite().build(), this.material, Math.max(1, count));
    this.object.name = "driftingBalloons";
    this.object.count = count;
    this.object.frustumCulled = false;
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      const r = 28 + rng() * 45;
      this.balloons.push({
        x: Math.cos(a) * r,
        y: DriftingBalloons.BOTTOM + rng() * (DriftingBalloons.TOP - DriftingBalloons.BOTTOM),
        z: Math.sin(a) * r,
        scale: 1.6 + rng() * 1.6,
        speed: 0.6 + rng() * 0.8,
        phase: rng() * 30,
      });
      color.set(BALLOON_COLORS[i % BALLOON_COLORS.length]);
      this.object.setColorAt(i, color);
    }
  }

  update(dt: number, elapsed: number): void {
    const span = DriftingBalloons.TOP - DriftingBalloons.BOTTOM;
    this.balloons.forEach((b, i) => {
      b.y += b.speed * dt;
      if (b.y > DriftingBalloons.TOP) b.y -= span;
      tmpQ.setFromAxisAngle(AXIS_Z, wobble(elapsed * 0.6 + b.phase, 2) * 0.15);
      tmpP.set(b.x + wobble(elapsed * 0.2 + b.phase, 4) * 2, b.y, b.z);
      tmpS.setScalar(b.scale);
      tmpM.compose(tmpP, tmpQ, tmpS);
      this.object.setMatrixAt(i, tmpM);
    });
    this.object.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
    this.object.dispose();
  }
}

/** White balloon body + knot (tinted per instance), 1 m tall, centered at the origin. */
function balloonWhite(): Baker {
  const b = new Baker();
  b.addAt(new THREE.SphereGeometry(1, 16, 12), "#FFFFFF", new THREE.Vector3(0, 0, 0), null, new THREE.Vector3(0.42, 0.52, 0.42));
  b.addAt(new THREE.ConeGeometry(0.08, 0.12, 8), "#E6E6E6", new THREE.Vector3(0, -0.55, 0), new THREE.Euler(Math.PI, 0, 0));
  b.addAt(new THREE.CylinderGeometry(0.008, 0.008, 1.6, 3), "#F4F0FF", new THREE.Vector3(0, -1.4, 0));
  return b;
}
