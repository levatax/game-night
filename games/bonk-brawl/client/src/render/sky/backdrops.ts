// Far scenery per theme: the cartoon bathroom (tiled walls, mirror, window) with drain water and
// toy ducks below the tub, the rest of the giant cake far below Cake Topper with twinkling dusk
// stars, and small floating islands around Picnic Plateau.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { Baker, composeMatrix } from "../arena/Baker";
import { MaterialBank } from "../arena/MaterialBank";
import { createRng, wobble } from "../noise";
import { drainWaterTexture, rippleTexture, wallTileTexture } from "../textures";
import type { SkyPart } from "./ambient";
import { mixHex, shadeHex } from "../../util/color";

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/* ================================================================ bathroom */

const ROOM_HALF = 68;
const WATER_Y = -26;
const ROOM_TOP = 46;
const WAINSCOT_TOP = 8;

/** Tiled walls around the tub (lit + fogged, so they read as a big misty room). */
export class BathroomRoom implements SkyPart {
  readonly object = new THREE.Group();
  private readonly bank = new MaterialBank();

  constructor() {
    this.object.name = "bathroom";
    const lower = this.bank.toonColor("#FFFFFF", { map: this.bank.tex(wallTileTexture("#9ED9E8", "#E4F5F9")) });
    const upper = this.bank.toonColor("#FFFFFF", { map: this.bank.tex(wallTileTexture("#F4FAFC", "#D6E9F0")) });
    const span = ROOM_HALF * 2;
    const tileMeters = 14;
    for (let k = 0; k < 4; k++) {
      const yaw = (k * Math.PI) / 2;
      const wall = new THREE.Group();
      wall.rotation.y = yaw;
      const low = this.wallBand(span, WAINSCOT_TOP - WATER_Y, WATER_Y, tileMeters, lower);
      const high = this.wallBand(span, ROOM_TOP - WAINSCOT_TOP, WAINSCOT_TOP, tileMeters, upper);
      wall.add(low, high);
      this.object.add(wall);
    }
    this.object.add(this.trims(), this.mirror(), this.window());
  }

  update(): void {}

  dispose(): void {
    this.bank.dispose();
  }

  /** A wall plane facing the center (wall frame: plane at z = -ROOM_HALF facing +Z). */
  private wallBand(width: number, height: number, bottom: number, tileMeters: number, material: THREE.Material): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(width, height);
    const uv = geo.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * width) / tileMeters, (uv.getY(i) * height) / tileMeters);
    geo.translate(0, bottom + height / 2, -ROOM_HALF);
    return new THREE.Mesh(this.bank.geo(geo), material);
  }

  /** Coral border stripe and a baseboard at the water line, all four walls in one mesh. */
  private trims(): THREE.Mesh {
    const b = new Baker();
    for (let k = 0; k < 4; k++) {
      const rot = new THREE.Euler(0, (k * Math.PI) / 2, 0);
      const m = composeMatrix(v3(0, 0, 0), rot);
      const stripe = new THREE.BoxGeometry(ROOM_HALF * 2, 1.6, 0.6);
      stripe.translate(0, WAINSCOT_TOP, -ROOM_HALF + 0.3);
      b.add(stripe, "#FF8FA3", m, true);
      const dots = new THREE.BoxGeometry(ROOM_HALF * 2, 0.5, 0.7);
      dots.translate(0, WAINSCOT_TOP + 1.3, -ROOM_HALF + 0.35);
      b.add(dots, "#FFFFFF", m, true);
    }
    return new THREE.Mesh(this.bank.geo(b.build()), this.bank.toonColor("#FFFFFF", { vertexColors: true }));
  }

  /** Big oval-ish mirror on the north wall behind the faucet. */
  private mirror(): THREE.Mesh {
    const b = new Baker();
    const z = -ROOM_HALF + 0.6;
    b.add(new RoundedBoxGeometry(34, 24, 1, 4, 3), "#FFFFFF", composeMatrix(v3(0, 24, z)));
    b.add(new RoundedBoxGeometry(31, 21, 1, 4, 2.4), "#CBEFF8", composeMatrix(v3(0, 24, z + 0.2)));
    for (const [x, w] of [
      [-6, 2.2],
      [-2, 1.1],
    ] as const) {
      b.addAt(new THREE.BoxGeometry(w, 26, 0.2), "#F1FCFF", v3(x, 24, z + 0.75), new THREE.Euler(0, 0, -0.6));
    }
    return this.bakedMesh(b, "mirror");
  }

  /** Window with a sunny sky view on the east wall. */
  private window(): THREE.Mesh {
    const b = new Baker();
    const x = ROOM_HALF - 0.6;
    const rot = new THREE.Euler(0, -Math.PI / 2, 0);
    b.add(new THREE.BoxGeometry(28, 22, 1), "#FFFFFF", composeMatrix(v3(x, 24, 8), rot));
    for (const [px, py] of [
      [-6.5, 5],
      [6.5, 5],
      [-6.5, -5],
      [6.5, -5],
    ] as const) {
      b.add(new THREE.BoxGeometry(12, 9, 0.4), "#8ED6FF", composeMatrix(v3(x - 0.45, 24 + py, 8 + px), rot));
    }
    for (const [dx, dy, r] of [
      [-4, 6.5, 2.6],
      [-1.5, 7.2, 3.2],
      [1.5, 6.5, 2.4],
    ] as const) {
      b.addAt(new THREE.SphereGeometry(r, 14, 10), "#FFFFFF", v3(x - 0.5, 24 + dy, 8 + dx), null, v3(0.2, 0.6, 1));
    }
    return this.bakedMesh(b, "window");
  }

  private bakedMesh(b: Baker, name: string): THREE.Mesh {
    const mesh = new THREE.Mesh(this.bank.geo(b.build()), this.bank.toonColor("#FFFFFF", { vertexColors: true }));
    mesh.name = name;
    return mesh;
  }
}

/** Drain water filling the bathroom floor, swirling toward the drain, plus bobbing toy ducks. */
export class DrainWater implements SkyPart {
  readonly object = new THREE.Group();
  private readonly bank = new MaterialBank();
  private readonly swirl: THREE.Texture;
  private readonly ripples: THREE.Texture;
  private readonly ducks: THREE.Mesh[] = [];

  constructor(color: string) {
    this.object.name = "drainWater";
    const size = ROOM_HALF * 2;
    this.swirl = this.bank.tex(drainWaterTexture(color));
    this.swirl.center.set(0.5, 0.5);
    const water = new THREE.PlaneGeometry(size, size);
    water.rotateX(-Math.PI / 2);
    const waterMesh = new THREE.Mesh(this.bank.geo(water), this.bank.own(new THREE.MeshBasicMaterial({ map: this.swirl })));
    waterMesh.position.y = WATER_Y;
    this.ripples = this.bank.tex(rippleTexture());
    this.ripples.repeat.set(9, 9);
    const rippleMat = this.bank.own(
      new THREE.MeshBasicMaterial({ map: this.ripples, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    const rippleMesh = new THREE.Mesh(this.bank.geo(water.clone()), rippleMat);
    rippleMesh.position.y = WATER_Y + 0.05;
    this.object.add(waterMesh, rippleMesh);

    const duck = this.bank.geo(toyDuckGeometry());
    const mat = this.bank.toonColor("#FFFFFF", { vertexColors: true });
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(duck, mat);
      m.scale.setScalar(2.2 + i * 0.3);
      this.ducks.push(m);
      this.object.add(m);
    }
  }

  update(_dt: number, elapsed: number): void {
    this.swirl.rotation = -elapsed * 0.05;
    this.ripples.offset.set(elapsed * 0.012, elapsed * 0.008);
    this.ducks.forEach((d, i) => {
      const r = 24 + i * 7;
      const a = elapsed * (0.05 - i * 0.006) + i * 1.7;
      d.position.set(Math.cos(a) * r, WATER_Y + 0.1 + Math.sin(elapsed * 1.6 + i) * 0.15, Math.sin(a) * r);
      // Face along the circular path (tangent), with a little rocking.
      d.rotation.set(wobble(elapsed + i, 1) * 0.08, -a, wobble(elapsed * 1.2 + i, 4) * 0.1);
    });
  }

  dispose(): void {
    this.bank.dispose();
  }
}

/** Small bath-toy duck (~0.8 m long at scale 1) facing +Z. */
function toyDuckGeometry(): THREE.BufferGeometry {
  const b = new Baker();
  b.addAt(new THREE.SphereGeometry(1, 16, 12), "#FFD43B", v3(0, 0.2, 0), null, v3(0.3, 0.22, 0.4));
  b.addAt(new THREE.SphereGeometry(0.2, 14, 10), "#FFD43B", v3(0, 0.5, 0.18));
  b.addAt(new THREE.SphereGeometry(1, 10, 8), "#FF8A2E", v3(0, 0.46, 0.38), null, v3(0.09, 0.035, 0.1));
  b.addAt(new THREE.SphereGeometry(0.035, 8, 6), "#2D2A32", v3(0.09, 0.56, 0.32));
  b.addAt(new THREE.SphereGeometry(0.035, 8, 6), "#2D2A32", v3(-0.09, 0.56, 0.32));
  b.addAt(new THREE.SphereGeometry(1, 10, 8), "#FFD43B", v3(0, 0.32, -0.36), new THREE.Euler(-0.6, 0, 0), v3(0.1, 0.06, 0.12));
  return b.build();
}

/* ================================================================== cake */

/** Lower tiers of the giant cake far below Cake Topper (well under the ring-out line). */
export class CakeTiers implements SkyPart {
  readonly object = new THREE.Group();
  private readonly bank = new MaterialBank();

  constructor(frosting: string, sponge: string) {
    this.object.name = "cakeTiers";
    const b = new Baker();
    const tiers: Array<[number, number, number]> = [
      [23, 10, -34],
      [33, 13, -44],
      [44, 16, -57],
    ];
    for (const [radius, height, top] of tiers) this.tier(b, radius, height, top, frosting, sponge);
    // Cake stand plate.
    b.addAt(new THREE.CylinderGeometry(52, 48, 2.5, 48), "#FFFFFF", v3(0, -74.5, 0), null, 1, true);
    const mesh = new THREE.Mesh(this.bank.geo(b.build()), this.bank.toonColor("#FFFFFF", { vertexColors: true }));
    mesh.name = "cakeTierMesh";
    this.object.add(mesh);
  }

  update(): void {}

  dispose(): void {
    this.bank.dispose();
  }

  private tier(b: Baker, radius: number, height: number, top: number, frosting: string, sponge: string): void {
    b.addAt(new THREE.CylinderGeometry(radius, radius, height, 48), sponge, v3(0, top - height / 2, 0), null, 1, true);
    b.addAt(new THREE.CylinderGeometry(radius + 0.3, radius + 0.3, 1.6, 48), frosting, v3(0, top - 0.8, 0), null, 1, true);
    // Frosting drips and a bead border at the base.
    const drips = Math.round(radius * 2);
    for (let i = 0; i < drips; i++) {
      const a = (i / drips) * Math.PI * 2;
      const len = 1.2 + ((i * 7) % 5) * 0.45;
      b.addAt(new THREE.CapsuleGeometry(0.75, len, 3, 6), frosting, v3(Math.cos(a) * (radius + 0.15), top - 1.4 - len / 2, Math.sin(a) * (radius + 0.15)));
    }
    const beads = Math.round(radius * 2.4);
    for (let i = 0; i < beads; i++) {
      const a = (i / beads) * Math.PI * 2;
      b.addAt(new THREE.SphereGeometry(0.9, 8, 6), "#FFF8EE", v3(Math.cos(a) * (radius + 0.3), top - height + 0.5, Math.sin(a) * (radius + 0.3)));
    }
  }
}

const STAR_VERTEX = /* glsl */ `
  attribute float phase;
  attribute float size;
  uniform float time;
  uniform float pixelRatio;
  varying float vAlpha;
  void main() {
    float tw = 0.5 + 0.5 * sin(time * (1.2 + fract(phase) * 1.8) + phase);
    vAlpha = 0.35 + 0.65 * tw;
    gl_PointSize = size * pixelRatio * (0.7 + 0.5 * tw);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const STAR_FRAGMENT = /* glsl */ `
  uniform vec3 color;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p);
    // Soft core + a 4-point twinkle cross.
    float core = smoothstep(0.22, 0.0, d);
    float cross = max(smoothstep(0.06, 0.0, abs(p.x)), smoothstep(0.06, 0.0, abs(p.y))) * smoothstep(0.5, 0.0, d);
    float a = clamp(core + cross * 0.8, 0.0, 1.0) * vAlpha;
    if (a < 0.02) discard;
    gl_FragColor = vec4(color, a);
    #include <colorspace_fragment>
  }
`;

/** Twinkling sparkle points scattered over the dusk sky and the void below. */
export class Stars implements SkyPart {
  readonly object: THREE.Points;
  private readonly material: THREE.ShaderMaterial;

  constructor(count: number, pixelRatio: number) {
    const rng = createRng(31337);
    const positions = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Mostly high in the sky, some in the void below the island.
      const below = rng() < 0.25;
      const elevation = below ? -0.15 - rng() * 1.1 : 0.12 + Math.asin(rng()) * 0.9;
      const azimuth = rng() * Math.PI * 2;
      const r = 360;
      positions[i * 3] = Math.cos(azimuth) * Math.cos(elevation) * r;
      positions[i * 3 + 1] = Math.sin(elevation) * r;
      positions[i * 3 + 2] = Math.sin(azimuth) * Math.cos(elevation) * r;
      phases[i] = rng() * 100;
      sizes[i] = 5 + rng() * rng() * 13;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("phase", new THREE.BufferAttribute(phases, 1));
    geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        pixelRatio: { value: pixelRatio },
        color: { value: new THREE.Color("#FFF6D6") },
      },
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.object = new THREE.Points(geo, this.material);
    this.object.name = "stars";
    this.object.frustumCulled = false;
    this.object.renderOrder = -8;
  }

  update(_dt: number, elapsed: number): void {
    this.material.uniforms.time.value = elapsed;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}

/* ================================================================ picnic */

/** A few tiny grassy islands floating far away (sense of scale), bobbing slowly. */
export class DistantIslands implements SkyPart {
  readonly object = new THREE.Group();
  private readonly bank = new MaterialBank();
  private readonly islands: Array<{ mesh: THREE.Mesh; baseY: number; phase: number }> = [];

  constructor(grass: string, dirt: string) {
    this.object.name = "distantIslands";
    const rng = createRng(2024);
    const spots: Array<[number, number, number, number]> = [
      [-78, 4, -92, 7],
      [104, -6, -38, 5],
      [52, 10, 112, 6],
      [-118, -10, 44, 4.5],
    ];
    const material = this.bank.toonColor("#FFFFFF", { vertexColors: true });
    for (const [x, y, z, r] of spots) {
      const b = new Baker();
      b.addAt(new THREE.CylinderGeometry(r, r * 0.92, 0.9, 9), grass, v3(0, 0, 0), null, 1, true);
      b.addAt(new THREE.ConeGeometry(r * 0.92, r * 1.5, 9, 2), dirt, v3(0, -0.45 - r * 0.75, 0), new THREE.Euler(Math.PI, 0, 0), 1, true);
      b.addAt(new THREE.ConeGeometry(r * 0.5, r * 0.8, 7), shadeHex(dirt, -0.15), v3(r * 0.2, -r * 1.5, -r * 0.1), new THREE.Euler(Math.PI, 0.3, 0), 1, true);
      const trees = 1 + Math.floor(rng() * 2);
      for (let t = 0; t < trees; t++) {
        const tx = (rng() - 0.5) * r;
        const tz = (rng() - 0.5) * r;
        b.addAt(new THREE.CylinderGeometry(0.25, 0.35, 2, 6), "#8D5B3A", v3(tx, 1.4, tz), null, 1, true);
        b.addAt(new THREE.IcosahedronGeometry(1.5, 0), mixHex(grass, "#2E7D4F", 0.3), v3(tx, 3.2, tz), null, 1, true);
      }
      const mesh = new THREE.Mesh(this.bank.geo(b.build()), material);
      mesh.position.set(x, y, z);
      mesh.rotation.y = rng() * Math.PI * 2;
      this.object.add(mesh);
      this.islands.push({ mesh, baseY: y, phase: rng() * 10 });
    }
  }

  update(_dt: number, elapsed: number): void {
    for (const island of this.islands) {
      island.mesh.position.y = island.baseY + Math.sin(elapsed * 0.25 + island.phase) * 0.8;
    }
  }

  dispose(): void {
    this.bank.dispose();
  }
}
