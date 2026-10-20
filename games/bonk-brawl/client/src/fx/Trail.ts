// Camera-facing colored ribbon that follows a ball's recent path. Owner: client-fx.

import * as THREE from "three";

/** Max samples kept per trail (≈ 0.25 s at up to ~110 fps; older samples are dropped). */
const MAX_POINTS = 28;
/** Minimum spacing between samples (m), so a slow ball doesn't burn the history. */
const MIN_STEP = 0.02;

const VERTEX = /* glsl */ `
  attribute vec3 aDir;
  attribute float aSide;
  attribute float aT;
  uniform float uWidth;
  varying float vT;
  varying float vAcross;

  void main() {
    vT = aT;
    vAcross = aSide;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 tangent = (modelViewMatrix * vec4(aDir, 0.0)).xyz;
    vec3 side = cross(tangent, normalize(-mv.xyz));
    float len = length(side);
    side = len > 1e-5 ? side / len : vec3(0.0, 1.0, 0.0);
    float width = uWidth * pow(1.0 - aT, 0.7);
    mv.xyz += side * aSide * width;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vT;
  varying float vAcross;

  void main() {
    float core = 1.0 - abs(vAcross);
    float a = uOpacity * pow(1.0 - vT, 1.4) * smoothstep(0.0, 0.35, core);
    if (a < 0.01) discard;
    vec3 color = mix(uColor, vec3(1.0), core * core * 0.6 * (1.0 - vT));
    gl_FragColor = vec4(color, a);
    #include <colorspace_fragment>
  }
`;

/**
 * Ribbon built from the last `durationSec` of positions: centers on the CPU, the camera-facing
 * width in the vertex shader (no camera needed here). Tapers and fades toward the tail with a
 * white-hot core near the ball.
 */
export class Trail {
  readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly position: THREE.BufferAttribute;
  private readonly dir: THREE.BufferAttribute;
  private readonly t: THREE.BufferAttribute;
  /** History ring buffer: xyz + timestamp (cosmetic seconds). */
  private readonly hx = new Float32Array(MAX_POINTS);
  private readonly hy = new Float32Array(MAX_POINTS);
  private readonly hz = new Float32Array(MAX_POINTS);
  private readonly ht = new Float32Array(MAX_POINTS);
  private head = 0;
  private size = 0;
  private clock = 0;

  constructor(parent: THREE.Object3D, private readonly durationSec = 0.25) {
    const verts = MAX_POINTS * 2;
    this.position = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.dir = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.t = new THREE.BufferAttribute(new Float32Array(verts), 1).setUsage(THREE.DynamicDrawUsage);
    const side = new Float32Array(verts);
    for (let i = 0; i < MAX_POINTS; i++) {
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
    }
    const index: number[] = [];
    for (let i = 0; i < MAX_POINTS - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geometry.setAttribute("position", this.position);
    this.geometry.setAttribute("aDir", this.dir);
    this.geometry.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    this.geometry.setAttribute("aT", this.t);
    this.geometry.setIndex(index);
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color() },
        uOpacity: { value: 1 },
        uWidth: { value: 0.2 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = "fx-ball-trail";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  setStyle(color: THREE.Color, width: number, opacity: number): void {
    (this.material.uniforms.uColor.value as THREE.Color).copy(color);
    this.material.uniforms.uWidth.value = width;
    this.material.uniforms.uOpacity.value = opacity;
  }

  /** Forget the path (ball picked up / visual recycled). */
  reset(): void {
    this.size = 0;
    this.head = 0;
    this.mesh.visible = false;
    this.geometry.setDrawRange(0, 0);
  }

  /** Advance time and record the ball's current center. */
  record(dt: number, x: number, y: number, z: number): void {
    this.clock += dt;
    if (this.size > 0) {
      const last = (this.head + MAX_POINTS - 1) % MAX_POINTS;
      const dx = x - this.hx[last];
      const dy = y - this.hy[last];
      const dz = z - this.hz[last];
      // A teleport (ball respawn / snap) would draw a streak across the island.
      if (dx * dx + dy * dy + dz * dz > 9) this.size = 0;
      else if (dx * dx + dy * dy + dz * dz < MIN_STEP * MIN_STEP) {
        this.ht[last] = this.clock;
        return;
      }
    }
    this.hx[this.head] = x;
    this.hy[this.head] = y;
    this.hz[this.head] = z;
    this.ht[this.head] = this.clock;
    this.head = (this.head + 1) % MAX_POINTS;
    this.size = Math.min(MAX_POINTS, this.size + 1);
  }

  /** Rebuild the ribbon from the history, with the live ball center as the head. */
  rebuild(x: number, y: number, z: number): void {
    const n = this.fillPoints(x, y, z);
    this.geometry.setDrawRange(0, Math.max(0, n - 1) * 6);
    this.mesh.visible = n >= 2;
    if (n < 2) return;
    this.writeTangents(n);
    this.position.needsUpdate = true;
    this.dir.needsUpdate = true;
    this.t.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }

  /** Writes head + samples newer than durationSec (newest first); returns the point count. */
  private fillPoints(x: number, y: number, z: number): number {
    let n = this.writePoint(0, x, y, z, 0);
    for (let k = 1; k <= this.size && n < MAX_POINTS; k++) {
      const i = (this.head - k + MAX_POINTS) % MAX_POINTS;
      const age = this.clock - this.ht[i];
      if (age > this.durationSec) break;
      n = this.writePoint(n, this.hx[i], this.hy[i], this.hz[i], age);
    }
    return n;
  }

  /** Both ribbon vertices of point `n` sit on the center line; returns n + 1. */
  private writePoint(n: number, x: number, y: number, z: number, age: number): number {
    const pos = this.position.array as Float32Array;
    const tt = this.t.array as Float32Array;
    const v = n * 6;
    pos[v] = pos[v + 3] = x;
    pos[v + 1] = pos[v + 4] = y;
    pos[v + 2] = pos[v + 5] = z;
    tt[n * 2] = tt[n * 2 + 1] = Math.min(1, age / this.durationSec);
    return n + 1;
  }

  private writeTangents(n: number): void {
    const pos = this.position.array as Float32Array;
    const dir = this.dir.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1) * 6;
      const b = Math.min(n - 1, i + 1) * 6;
      const dx = pos[a] - pos[b];
      const dy = pos[a + 1] - pos[b + 1];
      const dz = pos[a + 2] - pos[b + 2];
      const v = i * 6;
      dir[v] = dir[v + 3] = dx;
      dir[v + 1] = dir[v + 4] = dy;
      dir[v + 2] = dir[v + 5] = dz;
    }
  }
}
