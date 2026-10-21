// Weather particles and lightning (game4.md §9/§16/§17): rain streaks in a box that follows the camera (one
// instanced draw, animated entirely in the vertex shader, slanted by the wind; density = rain / storm), and
// lightning strikes during the storm (and now and then in a night rain): a jagged bolt on the horizon plus a sky
// / ambient flash that Renderer applies. Reduced flashing (§17) keeps the bolt but dims the flash to a soft
// glow with no strobe. Owner: client-render.

import * as THREE from "three";
import type { Quality } from "../../app/settings";
import { QUALITY_PROFILES } from "../quality";
import { glowMaterial } from "../Toon";

const BOX = new THREE.Vector3(34, 20, 34);
const FALL_SPEED = 16;
const BOLT_POINTS = 14;
const BOLT_SEC = 0.22;

const RAIN_VERTEX = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  uniform float time;
  uniform vec3 origin;
  uniform vec3 box;
  uniform vec2 wind;
  uniform float speed;
  varying float vFade;
  void main() {
    vec3 base = instanceMatrix[3].xyz;
    vec3 fall = vec3(wind.x, -speed, wind.y);
    vec3 corner = origin - box * 0.5;
    vec3 p = corner + mod(base + fall * time - corner, box);
    // Cylindrical billboard: width across the view, length along the fall direction.
    vec3 dir = normalize(fall);
    vec3 toCam = normalize(cameraPosition - p);
    vec3 side = normalize(cross(dir, toCam));
    vec3 world = p + side * position.x + dir * position.y;
    vFade = 1.0 - smoothstep(box.x * 0.3, box.x * 0.5, distance(p.xz, origin.xz));
    vec4 mvPosition = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const RAIN_FRAGMENT = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform vec3 color;
  uniform float opacity;
  varying float vFade;
  void main() {
    gl_FragColor = vec4(color, opacity * vFade);
    #include <fog_fragment>
    #include <colorspace_fragment>
  }
`;

export class Weather {
  readonly group = new THREE.Group();
  /** Current lightning flash 0..1 (sky, ambient and key boost). */
  flash = 0;
  /** Called on every strike (thunder SFX / camera shake hook): strength 0..1 and distance in meters. */
  onStrike: ((strength: number, distance: number) => void) | null = null;

  private readonly rain: THREE.InstancedMesh;
  private readonly rainMat: THREE.ShaderMaterial;
  private readonly maxDrops: number;
  private readonly bolt: THREE.Mesh;
  private readonly boltMat: THREE.MeshBasicMaterial;
  private readonly boltPos: Float32Array;
  private boltLeft = 0;
  private nextStrike = 4;
  private flashT = 0;
  private flashPeak = 0;
  private reduced = false;
  private quality: Quality = "medium";

  constructor(quality: Quality) {
    this.group.name = "weather";
    this.maxDrops = QUALITY_PROFILES.high.rainDrops;
    const geo = new THREE.PlaneGeometry(0.025, 0.7);
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          time: { value: 0 },
          origin: { value: new THREE.Vector3() },
          box: { value: BOX.clone() },
          wind: { value: new THREE.Vector2(1.5, 0.6) },
          speed: { value: FALL_SPEED },
          color: { value: new THREE.Color("#C9D6E8") },
          opacity: { value: 0.45 },
        },
      ]),
      vertexShader: RAIN_VERTEX,
      fragmentShader: RAIN_FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
    });
    this.rain = new THREE.InstancedMesh(geo, this.rainMat, this.maxDrops);
    this.rain.name = "rain";
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 6;
    const m = new THREE.Matrix4();
    let seed = 1234567;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < this.maxDrops; i++) {
      m.makeTranslation(rnd() * BOX.x, rnd() * BOX.y, rnd() * BOX.z);
      this.rain.setMatrixAt(i, m);
    }
    this.rain.count = 0;
    this.rain.visible = false;
    this.group.add(this.rain);
    this.setQuality(quality);

    // Lightning bolt: two crossed ribbons along a jagged polyline (rebuilt per strike).
    this.boltPos = new Float32Array(BOLT_POINTS * 2 * 2 * 3);
    const boltGeo = new THREE.BufferGeometry();
    boltGeo.setAttribute("position", new THREE.BufferAttribute(this.boltPos, 3));
    const idx: number[] = [];
    for (let r = 0; r < 2; r++) {
      const off = r * BOLT_POINTS * 2;
      for (let i = 0; i < BOLT_POINTS - 1; i++) {
        const a = off + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    boltGeo.setIndex(idx);
    this.boltMat = glowMaterial(new THREE.Color(2.2, 2.3, 2.6), 1).clone();
    this.boltMat.side = THREE.DoubleSide;
    this.bolt = new THREE.Mesh(boltGeo, this.boltMat);
    this.bolt.name = "lightning";
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    this.bolt.renderOrder = -4;
    this.group.add(this.bolt);
  }

  setQuality(q: Quality): void {
    this.quality = q;
  }

  setReducedFlashing(reduced: boolean): void {
    this.reduced = reduced;
  }

  /**
   * Per frame. `rain` 0..1 density, `storm` 0..1, `dark` night factor, `wind` 0..1, `focus` the camera / eye.
   * Updates `flash`.
   */
  update(dt: number, elapsed: number, rain: number, storm: number, dark: number, wind: number, focus: THREE.Vector3, camera: THREE.Camera): void {
    const cap = QUALITY_PROFILES[this.quality].rainDrops;
    const count = Math.round(Math.min(cap, this.maxDrops) * Math.max(0, Math.min(1, rain)));
    this.rain.count = count;
    this.rain.visible = count > 0;
    const u = this.rainMat.uniforms;
    u.time!.value = elapsed;
    (u.origin!.value as THREE.Vector3).set(focus.x, focus.y + 4, focus.z);
    (u.wind!.value as THREE.Vector2).set(1.2 + wind * 5.5, 0.4 + wind * 2.2);
    u.speed!.value = FALL_SPEED + storm * 8;
    u.opacity!.value = 0.32 + storm * 0.18;

    // Lightning scheduling.
    const nightRain = rain > 0.5 && dark > 0.5;
    if (storm > 0.25 || nightRain) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this.strike(storm, camera);
        this.nextStrike = storm > 0.25 ? 2 + Math.random() * (7.5 - storm * 5) : 12 + Math.random() * 16;
      }
    } else {
      this.nextStrike = Math.max(this.nextStrike, 3 + Math.random() * 3);
    }
    // Flash envelope: a sharp double flicker (or one soft glow with reduced flashing).
    this.flashT += dt;
    if (this.flashPeak > 0) {
      const t = this.flashT;
      let f: number;
      if (this.reduced) f = Math.max(0, 1 - t / 0.6) * 0.25;
      else f = (t < 0.07 ? 1 : t < 0.12 ? 0.25 : t < 0.2 ? 0.85 : Math.max(0, 1 - (t - 0.2) / 0.35) * 0.6) * (t < 0.55 ? 1 : 0);
      this.flash = f * this.flashPeak;
      if (t > 0.8) this.flashPeak = 0;
    } else {
      this.flash = 0;
    }
    this.boltLeft -= dt;
    this.bolt.visible = this.boltLeft > 0;
    if (this.bolt.visible) this.boltMat.opacity = (this.reduced ? 0.55 : 1) * (this.boltLeft / BOLT_SEC > 0.5 || this.reduced ? 1 : 0.4);
  }

  /** Force a strike now (e.g. when the storm begins). */
  strike(strength: number, camera: THREE.Camera): void {
    const s = Math.max(0.4, Math.min(1, strength));
    const pos = new THREE.Vector3();
    camera.getWorldPosition(pos);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    // Somewhere in front-ish so it is seen; far out over the sea.
    const yaw = Math.atan2(dir.x, dir.z) + (Math.random() - 0.5) * 2.2;
    const dist = 110 + Math.random() * 70;
    const bx = pos.x + Math.sin(yaw) * dist;
    const bz = pos.z + Math.cos(yaw) * dist;
    const top = 95 + Math.random() * 30;
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    let x = bx;
    let z = bz;
    const w = 0.9 + s * 0.8;
    for (let i = 0; i < BOLT_POINTS; i++) {
      const t = i / (BOLT_POINTS - 1);
      const y = top * (1 - t) - 2;
      if (i > 0) {
        const j = (Math.random() - 0.5) * 9;
        x += right.x * j;
        z += right.z * j;
      }
      const taper = w * (1 - t * 0.6);
      // Ribbon A spans "right", ribbon B spans the view direction.
      const a = i * 2 * 3;
      this.boltPos.set([x - right.x * taper, y, z - right.z * taper, x + right.x * taper, y, z + right.z * taper], a);
      const b = (BOLT_POINTS * 2 + i * 2) * 3;
      this.boltPos.set([x - Math.sin(yaw) * taper, y, z - Math.cos(yaw) * taper, x + Math.sin(yaw) * taper, y, z + Math.cos(yaw) * taper], b);
    }
    (this.bolt.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    this.bolt.geometry.computeBoundingSphere();
    this.boltLeft = BOLT_SEC;
    this.flashT = 0;
    this.flashPeak = s;
    this.onStrike?.(s, dist);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.rain.geometry.dispose();
    this.rainMat.dispose();
    this.rain.dispose();
    this.bolt.geometry.dispose();
    this.boltMat.dispose();
  }
}
