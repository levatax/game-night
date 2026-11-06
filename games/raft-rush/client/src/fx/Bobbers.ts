// Fishing bobbers + lines (§8): a red-and-white toon float riding the drawn sea surface (render/island/waves.ts:
// it heaves and tilts with the same swell the water shader shows) with lazy ripples, tied to the rod tip by a
// sagging line. When a fish bites the bobber yanks under, jitters and the line goes taut and twitches;
// a splash marks the cast landing and the line being reeled in. Owner: client-fx-audio.

import * as THREE from "three";
import { PALETTE, WATER_Y } from "../../../shared/constants";
import { sea, seaDepthAt, seaSurfaceY, waveAttenuation, waveSlopeAt } from "../render/island/waves";
import { addOutline, vertexColorToon } from "../render/Toon";
import type { Bobber } from "./Fx";
import { PartBuilder, cylinder, hemisphere, sphere } from "./itemParts";
import type { Particles } from "./Particles";

const LINE_POINTS = 16;
const LINE_WIDTH = 0.011;
const RIPPLE_EVERY = 1.5;
/** How far under the bobber yanks on a bite (m). */
const DIP_DEPTH = 0.13;
const DIP_EASE = 18;
/** Tilt (rad) per unit of surface slope, capped. */
const SLOPE_TILT = 0.9;
const MAX_TILT = 0.35;
const slope = { x: 0, z: 0 };

const LINE_VERTEX = /* glsl */ `
  #include <fog_pars_vertex>
  attribute vec3 aDir;
  attribute float aSide;
  uniform float uWidth;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vec3 tangent = (modelViewMatrix * vec4(aDir, 0.0)).xyz;
    vec3 side = cross(tangent, normalize(-mvPosition.xyz));
    float len = length(side);
    side = len > 1e-5 ? side / len : vec3(0.0, 1.0, 0.0);
    // Never thinner than ~1.5 px: the line must stay visible from first person.
    float w = max(uWidth, -mvPosition.z * 0.0022);
    mvPosition.xyz += side * aSide * w;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const LINE_FRAGMENT = /* glsl */ `
  #include <fog_pars_fragment>
  uniform vec3 uColor;
  uniform float uOpacity;
  void main() {
    gl_FragColor = vec4(uColor, uOpacity);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/** Camera-facing ribbon through a polyline (fishing line). */
class LineRibbon {
  readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly position: THREE.BufferAttribute;
  private readonly dir: THREE.BufferAttribute;

  constructor(parent: THREE.Object3D) {
    const verts = LINE_POINTS * 2;
    this.position = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.dir = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const side = new Float32Array(verts);
    for (let i = 0; i < LINE_POINTS; i++) {
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
    }
    const index: number[] = [];
    for (let i = 0; i < LINE_POINTS - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geometry.setAttribute("position", this.position);
    this.geometry.setAttribute("aDir", this.dir);
    this.geometry.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    this.geometry.setIndex(index);
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uColor: { value: new THREE.Color("#F4F1EA") }, uOpacity: { value: 0.9 }, uWidth: { value: LINE_WIDTH } },
      ]),
      vertexShader: LINE_VERTEX,
      fragmentShader: LINE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = "fx-fishing-line";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.raycast = () => {};
    parent.add(this.mesh);
  }

  /** Points: LINE_POINTS xyz triples. */
  set(points: Float32Array): void {
    const pos = this.position.array as Float32Array;
    const dir = this.dir.array as Float32Array;
    for (let i = 0; i < LINE_POINTS; i++) {
      const x = points[i * 3]!;
      const y = points[i * 3 + 1]!;
      const z = points[i * 3 + 2]!;
      const v = i * 6;
      pos[v] = pos[v + 3] = x;
      pos[v + 1] = pos[v + 4] = y;
      pos[v + 2] = pos[v + 5] = z;
      const a = Math.max(0, i - 1) * 3;
      const b = Math.min(LINE_POINTS - 1, i + 1) * 3;
      dir[v] = dir[v + 3] = points[b]! - points[a]!;
      dir[v + 1] = dir[v + 4] = points[b + 1]! - points[a + 1]!;
      dir[v + 2] = dir[v + 5] = points[b + 2]! - points[a + 2]!;
    }
    this.position.needsUpdate = true;
    this.dir.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

let bobberGeometry: THREE.BufferGeometry | null = null;

/** Red bottom, white top, little antenna: ~0.16 m tall, origin at the waterline. */
function bobberGeo(): THREE.BufferGeometry {
  if (bobberGeometry) return bobberGeometry;
  const b = new PartBuilder(0.05);
  b.add(hemisphere(0.06, 9, 4).rotateX(Math.PI), "#FF4D3A", { p: [0, 0.0, 0] });
  b.add(hemisphere(0.06, 9, 4), "#FFFFFF", { p: [0, 0.0, 0] });
  b.add(cylinder(0.062, 0.062, 0.012, 9), PALETTE.ink, { p: [0, 0.0, 0] });
  b.add(cylinder(0.008, 0.01, 0.09, 4), "#FF4D3A", { p: [0, 0.1, 0] });
  b.add(sphere(0.014, 5, 3), "#FFD166", { p: [0, 0.15, 0] });
  bobberGeometry = b.build(false).geometry;
  return bobberGeometry;
}

interface BobberVisual {
  playerId: string;
  mesh: THREE.Mesh;
  line: LineRibbon;
  points: Float32Array;
  biting: boolean;
  dip: number;
  age: number;
  rippleClock: number;
  phase: number;
  stamp: number;
  water: THREE.Vector3;
}

export class Bobbers {
  private readonly root = new THREE.Group();
  private readonly visuals = new Map<string, BobberVisual>();
  private list: ReadonlyArray<Bobber> = [];
  private stamp = 0;
  private time = 0;
  private readonly tip = new THREE.Vector3();

  constructor(
    parent: THREE.Object3D,
    private readonly particles: Particles,
  ) {
    this.root.name = "fx-bobbers";
    parent.add(this.root);
  }

  get count(): number {
    return this.visuals.size;
  }

  set(list: ReadonlyArray<Bobber>): void {
    this.list = list;
  }

  update(dt: number): void {
    this.time += dt;
    this.stamp++;
    for (const b of this.list) {
      let v = this.visuals.get(b.playerId);
      if (!v) v = this.create(b);
      v.stamp = this.stamp;
      this.animate(v, b, dt);
    }
    for (const v of [...this.visuals.values()]) {
      if (v.stamp !== this.stamp) this.remove(v, true);
    }
  }

  clear(): void {
    for (const v of [...this.visuals.values()]) this.remove(v, false);
    this.list = [];
  }

  dispose(): void {
    this.clear();
    this.root.removeFromParent();
  }

  private create(b: Bobber): BobberVisual {
    const mesh = new THREE.Mesh(bobberGeo(), vertexColorToon(THREE.FrontSide, true));
    mesh.name = `fx-bobber-${b.playerId}`;
    mesh.castShadow = false;
    addOutline(mesh, 0.01);
    this.root.add(mesh);
    const v: BobberVisual = {
      playerId: b.playerId,
      mesh,
      line: new LineRibbon(this.root),
      points: new Float32Array(LINE_POINTS * 3),
      biting: false,
      dip: 0,
      age: 0,
      rippleClock: 0,
      phase: Math.random() * Math.PI * 2,
      stamp: 0,
      water: new THREE.Vector3(b.pos.x, b.pos.y, b.pos.z),
    };
    this.visuals.set(b.playerId, v);
    // The cast lands: plop.
    this.particles.burst("splash", b.pos, { scale: 0.45, count: 6 });
    return v;
  }

  private animate(v: BobberVisual, b: Bobber, dt: number): void {
    v.age += dt;
    v.water.set(b.pos.x, b.pos.y + seaSurfaceY(b.pos.x, b.pos.z) - WATER_Y, b.pos.z);
    if (b.biting && !v.biting) {
      // CHOMP: splash + ring + bubbles the moment the fish bites.
      this.particles.burst("splash", b.pos, { scale: 0.7, count: 9 });
      this.particles.burst("ripple", b.pos, { scale: 0.8 });
      this.particles.burst("bubbles", b.pos, { scale: 0.4, count: 4 });
    }
    v.biting = b.biting;
    v.dip += ((b.biting ? 1 : 0) - v.dip) * (1 - Math.exp(-DIP_EASE * dt));
    v.rippleClock += dt;
    if (v.rippleClock >= (b.biting ? 0.35 : RIPPLE_EVERY)) {
      v.rippleClock = 0;
      this.particles.burst("ripple", b.pos, { scale: b.biting ? 0.55 : 0.4, count: 1 });
    }
    const t = this.time + v.phase;
    // Drop in from the cast for the first 0.2 s.
    const land = Math.min(1, v.age / 0.2);
    // Ride the drawn swell (heave + tilt with its slope), a small bob of its own on top.
    const heave = seaSurfaceY(b.pos.x, b.pos.z) - WATER_Y;
    waveSlopeAt(b.pos.x, b.pos.z, sea.time, sea.amp * waveAttenuation(seaDepthAt(b.pos.x, b.pos.z)), slope);
    const tiltX = Math.max(-MAX_TILT, Math.min(MAX_TILT, -slope.z * SLOPE_TILT));
    const tiltZ = Math.max(-MAX_TILT, Math.min(MAX_TILT, slope.x * SLOPE_TILT));
    const idleBob = 0.012 * Math.sin(t * 2.3) + 0.006 * Math.sin(t * 5.1);
    const jitter = b.biting ? 0.035 * Math.sin(t * 31) + 0.02 * Math.sin(t * 47) : 0;
    const y = b.pos.y + heave + (1 - land) * 0.6 + idleBob * (1 - v.dip) - DIP_DEPTH * v.dip + jitter;
    const jx = b.biting ? 0.03 * Math.sin(t * 23) : 0;
    v.mesh.position.set(b.pos.x + jx, y, b.pos.z);
    v.mesh.rotation.set(tiltX + 0.06 * Math.sin(t * 1.7) + (b.biting ? 0.35 * Math.sin(t * 19) : 0), 0, tiltZ + 0.06 * Math.cos(t * 1.4));
    // Line: rod tip → top of the antenna, sagging (taut and twitchy on a bite).
    this.tip.set(b.from.x, b.from.y, b.from.z);
    const ex = v.mesh.position.x;
    const ey = v.mesh.position.y + 0.15;
    const ez = v.mesh.position.z;
    const span = Math.hypot(ex - this.tip.x, ez - this.tip.z);
    const sag = (b.biting ? 0.02 : 0.11) * span * (0.6 + 0.4 * land);
    for (let i = 0; i < LINE_POINTS; i++) {
      const u = i / (LINE_POINTS - 1);
      const k = Math.sin(Math.PI * u);
      const twitch = b.biting ? 0.025 * Math.sin(t * 40 + u * 9) * k : 0.01 * Math.sin(t * 1.8 + u * 5) * k;
      v.points[i * 3] = this.tip.x + (ex - this.tip.x) * u + twitch;
      v.points[i * 3 + 1] = this.tip.y + (ey - this.tip.y) * u - sag * k;
      v.points[i * 3 + 2] = this.tip.z + (ez - this.tip.z) * u;
    }
    v.line.set(v.points);
  }

  private remove(v: BobberVisual, splash: boolean): void {
    this.visuals.delete(v.playerId);
    if (splash) this.particles.burst("splash", v.water, { scale: 0.5, count: 6 });
    v.mesh.removeFromParent();
    v.line.dispose();
  }
}
