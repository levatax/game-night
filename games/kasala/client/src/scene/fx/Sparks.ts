// Billboard spark system: one THREE.Points draw call with a tiny shader (per-particle size, color, alpha,
// rotation and atlas frame). Used for sparkles, glints, smoke puffs, dust and water droplets. Fixed capacity,
// oldest particle recycled when full, zero per-frame allocations. A point never grows past MAX_SCREEN of the
// screen height, so a glow that happens right in front of a first-person eye stays a glow, not a white-out.
// Owner: client-cards-fx.

import * as THREE from "three";
import { sparkAtlas } from "./textures";

export const SPARK_GLOW = 0;
export const SPARK_STAR = 1;
export const SPARK_SMOKE = 2;
export const SPARK_DOT = 3;

export interface SparkSpawn {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  /** World size (m) at birth and at death. */
  size: number;
  sizeEnd?: number;
  life: number;
  color: THREE.ColorRepresentation;
  alpha?: number;
  frame?: number;
  /** m/s² downward (negative floats upward). */
  gravity?: number;
  /** Velocity damping per second (0 = none). */
  drag?: number;
  /** Angular speed of the sprite (rad/s). */
  spin?: number;
  /** Kill when falling below this height. */
  floor?: number;
}

/** Largest on-screen point size as a fraction of the drawing-buffer height. */
const MAX_SCREEN = 0.3;

const VERT = /* glsl */ `
uniform float uScale;
uniform float uMaxPx;
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
attribute float aRot;
attribute float aFrame;
varying vec3 vColor;
varying float vAlpha;
varying float vRot;
varying float vFrame;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vRot = aRot;
  vFrame = aFrame;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aAlpha <= 0.0 ? 0.0 : min(uMaxPx, aSize * uScale / max(0.05, -mv.z));
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec3 vColor;
varying float vAlpha;
varying float vRot;
varying float vFrame;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float c = cos(vRot);
  float s = sin(vRot);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;
  vec2 cell = vec2(mod(vFrame, 2.0), floor(vFrame / 2.0));
  vec4 t = texture2D(uMap, (clamp(p, 0.01, 0.99) + cell) * 0.5);
  gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
  if (gl_FragColor.a < 0.004) discard;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const _color = new THREE.Color();
const _size = new THREE.Vector2();

export class Sparks {
  readonly points: THREE.Points;
  readonly cap: number;
  private readonly mat: THREE.ShaderMaterial;
  private readonly geo: THREE.BufferGeometry;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly rot: Float32Array;
  private readonly frame: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly max: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly a0: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private readonly spin: Float32Array;
  private readonly floor: Float32Array;
  private cursor = 0;
  private live = 0;

  constructor(parent: THREE.Object3D, cap: number, additive: boolean, name: string) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.rot = new Float32Array(cap);
    this.frame = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap);
    this.s0 = new Float32Array(cap);
    this.s1 = new Float32Array(cap);
    this.a0 = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.spin = new Float32Array(cap);
    this.floor = new Float32Array(cap).fill(-1e9);

    this.geo = new THREE.BufferGeometry();
    const attr = (arr: Float32Array, n: number) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", attr(this.pos, 3));
    this.geo.setAttribute("aColor", attr(this.col, 3));
    this.geo.setAttribute("aSize", attr(this.size, 1));
    this.geo.setAttribute("aAlpha", attr(this.alpha, 1));
    this.geo.setAttribute("aRot", attr(this.rot, 1));
    this.geo.setAttribute("aFrame", attr(this.frame, 1));

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: sparkAtlas() }, uScale: { value: 600 }, uMaxPx: { value: 300 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.name = name;
    this.points.renderOrder = additive ? 6 : 5;
    this.points.raycast = () => {};
    parent.add(this.points);
  }

  spawn(o: SparkSpawn): void {
    let i = -1;
    for (let k = 0; k < this.cap; k++) {
      const c = (this.cursor + k) % this.cap;
      if (this.max[c] === 0) {
        i = c;
        break;
      }
    }
    if (i < 0) i = this.cursor;
    else this.live++;
    this.cursor = (i + 1) % this.cap;
    const j = i * 3;
    this.pos[j] = o.x;
    this.pos[j + 1] = o.y;
    this.pos[j + 2] = o.z;
    this.vel[j] = o.vx ?? 0;
    this.vel[j + 1] = o.vy ?? 0;
    this.vel[j + 2] = o.vz ?? 0;
    _color.set(o.color);
    this.col[j] = _color.r;
    this.col[j + 1] = _color.g;
    this.col[j + 2] = _color.b;
    this.life[i] = 0;
    this.max[i] = Math.max(0.05, o.life);
    this.s0[i] = o.size;
    this.s1[i] = o.sizeEnd ?? o.size;
    this.a0[i] = o.alpha ?? 1;
    this.grav[i] = o.gravity ?? 0;
    this.drag[i] = o.drag ?? 0;
    this.spin[i] = o.spin ?? 0;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.frame[i] = o.frame ?? SPARK_STAR;
    this.floor[i] = o.floor ?? -1e9;
    this.size[i] = o.size;
    this.alpha[i] = 0;
  }

  clear(): void {
    this.max.fill(0);
    this.alpha.fill(0);
    this.live = 0;
    this.markDirty();
  }

  /** `renderer` + `camera` set the point-size scale (world meters → pixels). */
  update(dt: number, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    if (this.live === 0) {
      this.points.visible = false;
      return;
    }
    renderer.getDrawingBufferSize(_size);
    this.mat.uniforms.uScale!.value = _size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.mat.uniforms.uMaxPx!.value = _size.y * MAX_SCREEN;
    if (dt > 0) {
      for (let i = 0; i < this.cap; i++) {
        const max = this.max[i]!;
        if (max === 0) continue;
        const life = (this.life[i] += dt);
        const j = i * 3;
        if (life >= max || this.pos[j + 1]! < this.floor[i]!) {
          this.max[i] = 0;
          this.alpha[i] = 0;
          this.live--;
          continue;
        }
        const t = life / max;
        const d = this.drag[i]!;
        if (d > 0) {
          const k = Math.exp(-d * dt);
          this.vel[j] *= k;
          this.vel[j + 1] *= k;
          this.vel[j + 2] *= k;
        }
        this.vel[j + 1] -= this.grav[i]! * dt;
        this.pos[j] += this.vel[j]! * dt;
        this.pos[j + 1] += this.vel[j + 1]! * dt;
        this.pos[j + 2] += this.vel[j + 2]! * dt;
        this.rot[i] += this.spin[i]! * dt;
        const e = 1 - (1 - t) * (1 - t);
        this.size[i] = this.s0[i]! + (this.s1[i]! - this.s0[i]!) * e;
        const fadeIn = t < 0.08 ? t / 0.08 : 1;
        const fadeOut = t > 0.55 ? 1 - (t - 0.55) / 0.45 : 1;
        this.alpha[i] = this.a0[i]! * fadeIn * fadeOut;
      }
      this.markDirty();
    }
    this.points.visible = this.live > 0;
  }

  private markDirty(): void {
    const a = this.geo.attributes;
    a.position!.needsUpdate = true;
    a.aColor!.needsUpdate = true;
    a.aSize!.needsUpdate = true;
    a.aAlpha!.needsUpdate = true;
    a.aRot!.needsUpdate = true;
    a.aFrame!.needsUpdate = true;
  }
}
