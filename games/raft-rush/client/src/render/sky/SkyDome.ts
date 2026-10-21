// Gradient sky dome (no texture) driven every frame by DayNight: zenith → horizon above, horizon → sea haze
// below, a crisp toon sun disc with a halo, a cratered moon disc (bigger on a full moon), fog blending toward
// the horizon and a lightning flash term. Follows the camera so it never clips. Owner: client-render.
// Adapted from games/bonk-brawl/client/src/render/sky/SkyDome.ts (uniforms are live instead of baked).

import * as THREE from "three";

const VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Colors arrive in sRGB so the gradient blends perceptually; converted to linear before output.
const FRAGMENT = /* glsl */ `
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 belowColor;
  uniform vec3 fogColor;
  uniform float fogAmount;
  uniform vec3 sunColor;
  uniform vec3 sunDir;
  uniform float sunSize;
  uniform float sunGlow;
  uniform vec3 moonColor;
  uniform vec3 moonDir;
  uniform float moonSize;
  uniform float moonGlow;
  uniform float flash;
  uniform float curve;
  varying vec3 vDir;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = h >= 0.0
      ? mix(horizonColor, topColor, pow(clamp(h, 0.0, 1.0), curve))
      : mix(horizonColor, belowColor, smoothstep(0.0, 0.25, -h));
    // Fog: the lower sky melts into the fog color (dense fog swallows most of the dome).
    float fogBand = 1.0 - smoothstep(0.0, mix(0.15, 0.9, fogAmount), max(h, 0.0));
    col = mix(col, fogColor, clamp(fogAmount * fogBand + fogAmount * 0.35, 0.0, 1.0));

    // Sun: halo + crisp disc.
    float s = max(dot(d, sunDir), 0.0);
    float halo = pow(s, 10.0) * 0.35 + pow(s, 80.0) * 0.5;
    col = mix(col, sunColor, clamp(halo * sunGlow, 0.0, 1.0));
    float disc = smoothstep(sunSize, sunSize + 0.0012, s) * step(0.001, sunGlow) * step(-0.02, sunDir.y);
    col = mix(col, vec3(1.0, 0.98, 0.9), disc * (1.0 - fogAmount * 0.7));

    // Moon: soft glow + disc with a few darker "seas" and a crisp rim.
    float m = max(dot(d, moonDir), 0.0);
    col += moonColor * pow(m, 60.0) * 0.35 * moonGlow;
    float mdisc = smoothstep(moonSize, moonSize + 0.0008, m) * step(0.001, moonGlow);
    if (mdisc > 0.0) {
      vec3 side = normalize(cross(moonDir, vec3(0.0, 1.0, 0.0)));
      vec3 upv = cross(side, moonDir);
      vec2 uv = vec2(dot(d, side), dot(d, upv)) / sqrt(max(1e-6, 1.0 - moonSize * moonSize));
      float craters = smoothstep(0.55, 0.6, hash(floor(uv * 5.0 + 3.0))) * 0.18
        + smoothstep(0.25, 0.0, length(uv - vec2(0.25, 0.2))) * 0.16
        + smoothstep(0.2, 0.0, length(uv + vec2(0.3, 0.1))) * 0.12;
      vec3 mcol = moonColor * (1.0 - craters);
      col = mix(col, mcol, mdisc * moonGlow * (1.0 - fogAmount * 0.8));
    }

    col += vec3(0.75, 0.8, 1.0) * flash * (0.4 + 0.6 * max(h, 0.0));
    gl_FragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(2.2)), 1.0);
    #include <colorspace_fragment>
  }
`;

/** Live sky parameters (ordinary linear THREE colors; unit directions TO the sun / moon). */
export interface SkyParams {
  top: THREE.Color;
  horizon: THREE.Color;
  below: THREE.Color;
  fog: THREE.Color;
  /** 0 clear .. 1 dense fog. */
  fogAmount: number;
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  /** Cos of the disc radius (closer to 1 = smaller). */
  sunSize: number;
  /** Halo + disc strength (0 hides the sun). */
  sunGlow: number;
  moonDir: THREE.Vector3;
  moonColor: THREE.Color;
  moonSize: number;
  moonGlow: number;
  /** Lightning flash 0..1. */
  flash: number;
}

export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(radius = 360) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color() },
        horizonColor: { value: new THREE.Color() },
        belowColor: { value: new THREE.Color() },
        fogColor: { value: new THREE.Color() },
        fogAmount: { value: 0 },
        sunColor: { value: new THREE.Color() },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        sunSize: { value: 0.9988 },
        sunGlow: { value: 1 },
        moonColor: { value: new THREE.Color() },
        moonDir: { value: new THREE.Vector3(0, -1, 0) },
        moonSize: { value: 0.9993 },
        moonGlow: { value: 0 },
        flash: { value: 0 },
        curve: { value: 0.6 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 20), this.material);
    this.mesh.name = "skyDome";
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
  }

  /** Push this frame's parameters (converted to sRGB for perceptual blending in the shader). */
  set(p: SkyParams): void {
    const u = this.material.uniforms;
    (u.topColor!.value as THREE.Color).copy(p.top).convertLinearToSRGB();
    (u.horizonColor!.value as THREE.Color).copy(p.horizon).convertLinearToSRGB();
    (u.belowColor!.value as THREE.Color).copy(p.below).convertLinearToSRGB();
    (u.fogColor!.value as THREE.Color).copy(p.fog).convertLinearToSRGB();
    u.fogAmount!.value = p.fogAmount;
    (u.sunDir!.value as THREE.Vector3).copy(p.sunDir);
    (u.sunColor!.value as THREE.Color).copy(p.sunColor).convertLinearToSRGB();
    u.sunSize!.value = p.sunSize;
    u.sunGlow!.value = p.sunGlow;
    (u.moonDir!.value as THREE.Vector3).copy(p.moonDir);
    (u.moonColor!.value as THREE.Color).copy(p.moonColor).convertLinearToSRGB();
    u.moonSize!.value = p.moonSize;
    u.moonGlow!.value = p.moonGlow;
    u.flash!.value = p.flash;
  }

  /** Keep the dome centered on the camera. */
  follow(pos: THREE.Vector3): void {
    this.mesh.position.copy(pos);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
