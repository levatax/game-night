// Procedural power-up pickup models (toon + outline). Owner: client-fx.
// Each model is a fresh Group owning its materials (geometries are created per model and
// disposed with it); `materials` lets the caller flash them white when the pickup appears.

import * as THREE from "three";
import { POWERUPS } from "../../../shared/constants";
import type { PowerUpType } from "../../../shared/types";
import { addOutline, createToonMaterial } from "../render/Toon";
import { ballSkinTexture, beachBallTexture } from "./fxTextures";
import { bananaGeometry } from "./geometries";

export interface PowerUpModel {
  group: THREE.Group;
  materials: THREE.MeshToonMaterial[];
  /** Per-frame idle animation (wing flaps etc.), elapsed in seconds. */
  animate(elapsed: number): void;
  dispose(): void;
}

const OUTLINE = 0.025;
const CREAM = "#FFFFFF";
const WHITE = "#FFFFFF";

class ModelBuilder {
  readonly group = new THREE.Group();
  readonly materials: THREE.MeshToonMaterial[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

  material(color: THREE.ColorRepresentation, opts: Parameters<typeof createToonMaterial>[1] = {}): THREE.MeshToonMaterial {
    const m = createToonMaterial(color, opts);
    this.materials.push(m);
    return m;
  }

  /** Own a geometry (disposed with the model). Shared cached geometries must not go through here. */
  geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  mesh(geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D = this.group): THREE.Mesh {
    const m = new THREE.Mesh(geometry, material);
    m.castShadow = true;
    parent.add(m);
    return m;
  }

  finish(animate: (elapsed: number) => void = () => {}): PowerUpModel {
    addOutline(this.group, OUTLINE);
    const { group, materials, geometries } = this;
    return {
      group,
      materials,
      animate,
      dispose() {
        group.removeFromParent();
        for (const m of materials) m.dispose();
        for (const g of geometries) g.dispose();
      },
    };
  }
}

export function createPowerUpModel(type: PowerUpType): PowerUpModel {
  switch (type) {
    case "mega":
      return megaBall();
    case "triple":
      return tripleBundle();
    case "boomerang":
      return bananaBall();
    case "zoomies":
      return wingedSneaker();
  }
}

/** Giant red beach ball with a little valve nub. */
function megaBall(): PowerUpModel {
  const b = new ModelBuilder();
  const ball = b.mesh(b.geo(new THREE.SphereGeometry(0.46, 28, 18)), b.material(WHITE, { map: beachBallTexture() }));
  ball.rotation.set(0.35, 0, 0.25);
  const nub = b.mesh(b.geo(new THREE.CylinderGeometry(0.045, 0.06, 0.07, 10)), b.material("#FFF8EC"), ball);
  nub.position.set(0.3, 0.33, 0);
  nub.rotation.z = -0.75;
  return b.finish();
}

/** Three small balls stacked in a triangle, tied with a purple ribbon and a bow on top. */
function tripleBundle(): PowerUpModel {
  const b = new ModelBuilder();
  const ballGeo = b.geo(new THREE.SphereGeometry(0.22, 20, 14));
  const skin = b.material(CREAM, { map: ballSkinTexture() });
  const spots: ReadonlyArray<[number, number, number]> = [
    [-0.22, -0.15, 0.04],
    [0.22, -0.15, -0.04],
    [0, 0.21, 0],
  ];
  spots.forEach(([x, y, z], i) => {
    const ball = b.mesh(ballGeo, skin);
    ball.position.set(x, y, z);
    ball.rotation.set(i * 1.3, i * 2.1, i * 0.7);
  });
  const ribbon = b.material(POWERUPS.triple.color);
  // Ribbon loop around the stack (in its plane), squashed to hug the triangle.
  const band = b.mesh(b.geo(new THREE.TorusGeometry(0.44, 0.045, 8, 40)), ribbon);
  band.scale.set(1.04, 0.92, 1);
  band.position.y = -0.02;
  const bow = new THREE.Group();
  bow.position.set(0, 0.44, 0);
  b.group.add(bow);
  const loopGeo = b.geo(new THREE.TorusGeometry(0.1, 0.035, 8, 18));
  for (const side of [-1, 1]) {
    const loop = b.mesh(loopGeo, ribbon, bow);
    loop.position.set(side * 0.11, 0.04, 0);
    loop.rotation.set(0, 0, side * 0.45);
    loop.scale.set(1, 0.7, 1);
  }
  b.mesh(b.geo(new THREE.SphereGeometry(0.055, 10, 8)), ribbon, bow);
  return b.finish();
}

/** The Boomerang pickup: a fat banana. */
function bananaBall(): PowerUpModel {
  const b = new ModelBuilder();
  const banana = b.mesh(bananaGeometry(), b.material(WHITE, { vertexColors: true, flatShading: true }));
  banana.scale.setScalar(0.48);
  banana.rotation.z = 0.35;
  return b.finish();
}

/** Teal sneaker with white sole, laces, a lightning bolt and flapping wings. */
function wingedSneaker(): PowerUpModel {
  const b = new ModelBuilder();
  const teal = b.material(POWERUPS.zoomies.color);
  const white = b.material(WHITE);
  const shoe = new THREE.Group();
  shoe.position.set(-0.02, -0.24, 0);
  shoe.scale.setScalar(1.2);
  b.group.add(shoe);

  const sole = b.mesh(b.geo(new THREE.CapsuleGeometry(0.13, 0.42, 4, 12)), white, shoe);
  sole.rotation.z = Math.PI / 2;
  sole.scale.set(0.5, 1, 1.05);
  sole.position.y = 0.06;
  const upper = b.mesh(b.geo(new THREE.SphereGeometry(1, 18, 12)), teal, shoe);
  upper.scale.set(0.33, 0.19, 0.16);
  upper.position.set(0.04, 0.14, 0);
  const ankle = b.mesh(b.geo(new THREE.CylinderGeometry(0.13, 0.155, 0.34, 14)), teal, shoe);
  ankle.position.set(-0.15, 0.3, 0);
  const collar = b.mesh(b.geo(new THREE.TorusGeometry(0.13, 0.035, 8, 20)), white, shoe);
  collar.rotation.x = Math.PI / 2;
  collar.position.set(-0.15, 0.47, 0);
  const tongue = b.mesh(b.geo(new THREE.BoxGeometry(0.06, 0.2, 0.15)), white, shoe);
  tongue.position.set(-0.03, 0.42, 0);
  tongue.rotation.z = -0.4;
  const toe = b.mesh(b.geo(new THREE.SphereGeometry(1, 14, 10)), white, shoe);
  toe.scale.set(0.12, 0.09, 0.15);
  toe.position.set(0.28, 0.1, 0);
  const laceGeo = b.geo(new THREE.BoxGeometry(0.035, 0.025, 0.17));
  for (let i = 0; i < 3; i++) {
    const lace = b.mesh(laceGeo, white, shoe);
    lace.position.set(0.0 + i * 0.075, 0.3 - i * 0.04, 0);
    lace.rotation.z = -0.35;
  }
  const bolt = b.geo(boltGeometry());
  const yellow = b.material("#FFCF33");
  for (const side of [-1, 1]) {
    const decal = b.mesh(bolt, yellow, shoe);
    decal.position.set(0.04, 0.15, side * 0.16);
    decal.rotation.y = side > 0 ? 0 : Math.PI;
  }

  const wings = [wing(b, white, 1), wing(b, white, -1)];
  for (const w of wings) shoe.add(w);
  return b.finish((elapsed) => {
    const flap = Math.sin(elapsed * 14) * 0.45;
    wings[0].rotation.x = -0.25 - flap;
    wings[1].rotation.x = 0.25 + flap;
  });
}

/** Three fanned feathers on a pivot at the ankle; side = +1 (z+) or −1. */
function wing(b: ModelBuilder, material: THREE.Material, side: number): THREE.Group {
  const pivot = new THREE.Group();
  pivot.position.set(-0.16, 0.36, side * 0.16);
  const featherGeo = b.geo(new THREE.SphereGeometry(1, 12, 8));
  const fan: ReadonlyArray<[number, number]> = [
    [0.3, 0.34],
    [0.75, 0.4],
    [1.2, 0.3],
  ];
  for (const [angle, len] of fan) {
    const feather = b.mesh(featherGeo, material, pivot);
    feather.scale.set(len / 2, 0.065, 0.035);
    // Fan out backward/upward from the ankle.
    feather.rotation.z = Math.PI - angle;
    feather.position.set(-Math.cos(angle) * len * 0.45, Math.sin(angle) * len * 0.45, side * 0.02);
  }
  return pivot;
}

function boltGeometry(): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  const pts: ReadonlyArray<[number, number]> = [
    [0.02, 0.09],
    [-0.05, -0.005],
    [0.0, -0.005],
    [-0.03, -0.09],
    [0.06, 0.02],
    [0.01, 0.02],
    [0.05, 0.09],
  ];
  pts.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.015, bevelEnabled: false });
  geo.translate(0, 0, -0.0075);
  return geo;
}
