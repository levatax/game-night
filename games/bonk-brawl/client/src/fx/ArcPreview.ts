// Full-charge trajectory hint (first ~25%). Owner: client-fx.

import * as THREE from "three";
import type { Vec3Like } from "../../../shared/types";
import { getOutlineMaterial } from "../render/Toon";

const MAX_DOTS = 48;
/** Distance between dots along the arc (m). */
const DOT_SPACING = 0.42;
/** Dots march along the arc at this speed (m/s), so the hint reads as motion. */
const MARCH_SPEED = 1.6;
/** No dot this close to the hand (it would sit on the held ball). */
const START_GAP = 0.45;
const DOT_RADIUS = 0.075;
const END_RADIUS = 0.035;
/** Fade-in time when the arc appears (s). */
const APPEAR_SEC = 0.12;

/**
 * Dotted/dashed tube or line of small dots along `points` (from sampleTrajectory with
 * ARC_PREVIEW_FRACTION), tinted with the player color, fading toward the end. Hidden when
 * points is null or has < 2 points.
 *
 * Implementation: instanced unlit dots (+ an instanced ink outline sharing the matrices) placed
 * every DOT_SPACING along the polyline, marching forward over time, shrinking and whitening
 * toward the end.
 */
export class ArcPreview {
  private readonly dots: THREE.InstancedMesh;
  private readonly outline: THREE.InstancedMesh;
  private readonly material = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  private readonly geometry = new THREE.IcosahedronGeometry(1, 1);
  private readonly tint = new THREE.Color();
  private readonly white = new THREE.Color(0xffffff);
  private readonly dotColor = new THREE.Color();
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private colorKey = "";
  private visibleSince = -1;

  constructor(scene: THREE.Scene) {
    this.dots = new THREE.InstancedMesh(this.geometry, this.material, MAX_DOTS);
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dots.setColorAt(0, this.white);
    this.outline = new THREE.InstancedMesh(this.geometry, getOutlineMaterial(0.012), MAX_DOTS);
    // Same matrices for the hull: share the attribute instead of copying it every frame.
    this.outline.instanceMatrix = this.dots.instanceMatrix;
    for (const mesh of [this.dots, this.outline]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.visible = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
    }
    this.dots.name = "fx-arc-preview";
  }

  update(points: readonly Vec3Like[] | null, color: string): void {
    if (!points || points.length < 2) {
      this.hide();
      return;
    }
    const now = performance.now() / 1000;
    if (this.visibleSince < 0) this.visibleSince = now;
    this.setColor(color);
    const total = polylineLength(points);
    if (total <= START_GAP) {
      this.hide();
      return;
    }
    const appear = Math.min(1, (now - this.visibleSince) / APPEAR_SEC);
    const phase = (now * MARCH_SPEED) % DOT_SPACING;
    let n = 0;
    let segment = 0;
    let segmentStart = 0;
    for (let d = START_GAP + phase; d < total && n < MAX_DOTS; d += DOT_SPACING) {
      while (segment < points.length - 2 && segmentStart + segLength(points, segment) < d) {
        segmentStart += segLength(points, segment);
        segment++;
      }
      const len = segLength(points, segment);
      const t = len > 1e-6 ? (d - segmentStart) / len : 0;
      const a = points[segment];
      const b = points[segment + 1];
      this.position.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
      const along = d / total;
      // Fade in at the hand, shrink toward the end.
      const fadeIn = Math.min(1, (d - START_GAP) / 0.4);
      const r = (DOT_RADIUS + (END_RADIUS - DOT_RADIUS) * along) * (0.4 + 0.6 * fadeIn) * appear;
      this.scale.setScalar(r);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.dots.setMatrixAt(n, this.matrix);
      this.dotColor.copy(this.tint).lerp(this.white, along * 0.65);
      this.dots.setColorAt(n, this.dotColor);
      n++;
    }
    this.show(n);
  }

  dispose(): void {
    this.dots.removeFromParent();
    this.outline.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.dots.dispose();
  }

  private setColor(color: string): void {
    if (color === this.colorKey) return;
    this.colorKey = color;
    this.tint.set(color);
  }

  private show(n: number): void {
    this.dots.count = n;
    this.outline.count = n;
    this.dots.visible = this.outline.visible = n > 0;
    this.dots.instanceMatrix.needsUpdate = true;
    if (this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;
  }

  private hide(): void {
    this.visibleSince = -1;
    this.dots.visible = this.outline.visible = false;
    this.dots.count = this.outline.count = 0;
  }
}

function segLength(points: readonly Vec3Like[], i: number): number {
  const a = points[i];
  const b = points[i + 1];
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

function polylineLength(points: readonly Vec3Like[]): number {
  let sum = 0;
  for (let i = 0; i < points.length - 1; i++) sum += segLength(points, i);
  return sum;
}
