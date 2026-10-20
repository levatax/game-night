// Cake Topper floating party balloons around the cake (decor kind "balloon").

import * as THREE from "three";
import type { DecorItem } from "../../../../../shared/maps";
import { shadeHex } from "../../../util/color";
import { wobble } from "../../noise";
import { Baker } from "../Baker";
import type { Animated, ArenaKit } from "../kit";

export const BALLOON_COLORS = ["#FF5A5F", "#3FA7FF", "#FFC23F", "#7BE07B", "#C08BFF", "#FF8FC7"];

/** Balloon + knot + highlight, 1 m tall body centered at y = 0, knot pointing down. */
export function balloonBaker(color: string): Baker {
  const b = new Baker();
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  b.addAt(new THREE.SphereGeometry(1, 20, 16), color, v(0, 0, 0), null, v(0.42, 0.52, 0.42));
  b.addAt(new THREE.ConeGeometry(0.08, 0.12, 8), shadeHex(color, -0.15), v(0, -0.55, 0), new THREE.Euler(Math.PI, 0, 0));
  b.addAt(new THREE.SphereGeometry(1, 10, 8), "#FFFFFF", v(-0.17, 0.22, 0.26), new THREE.Euler(0.3, 0.5, 0.5), v(0.06, 0.12, 0.04));
  return b;
}

/** Wavy string points hanging from the knot (local, balloon at origin). */
export function balloonStringPoints(length: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push(new THREE.Vector3(Math.sin(t * 7) * 0.07, -0.6 - t * length, Math.cos(t * 5) * 0.04));
  }
  return pts;
}

export function buildBalloon(kit: ArenaKit, item: DecorItem, index: number): void {
  const color = BALLOON_COLORS[index % BALLOON_COLORS.length];
  const group = new THREE.Group();
  group.name = "balloon";
  const body = new THREE.Mesh(kit.bank.geo(balloonBaker(color).build()), kit.bakedMaterial());
  const stringGeo = kit.bank.geo(new THREE.BufferGeometry().setFromPoints(balloonStringPoints(2.2)));
  const stringMat = kit.bank.own(new THREE.LineBasicMaterial({ color: "#F4F0FF", transparent: true, opacity: 0.8 }));
  group.add(body, new THREE.Line(stringGeo, stringMat));
  group.scale.setScalar(item.scale);
  group.position.set(item.x, item.y ?? 0, item.z);
  group.rotation.y = item.rotation;
  kit.backdrop.add(group);
  kit.animate(new BalloonDrift(group, index * 2.7));
}

class BalloonDrift implements Animated {
  private readonly base: THREE.Vector3;

  constructor(
    private readonly object: THREE.Object3D,
    private readonly phase: number,
  ) {
    this.base = object.position.clone();
  }

  update(_dt: number, elapsed: number): void {
    const t = elapsed * 0.45 + this.phase;
    this.object.position.set(
      this.base.x + wobble(t * 0.6, 1) * 0.6,
      this.base.y + Math.sin(t) * 0.45,
      this.base.z + wobble(t * 0.5, 3) * 0.6,
    );
    this.object.rotation.z = wobble(t * 0.9, 5) * 0.12;
    this.object.rotation.x = wobble(t * 0.8, 9) * 0.08;
  }
}
