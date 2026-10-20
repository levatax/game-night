// Gradient sky dome (no texture): bottom → top above the horizon, bottom → void color below it,
// plus an optional crisp toon sun disc with a soft halo.

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
  uniform vec3 bottomColor;
  uniform vec3 belowColor;
  uniform vec3 sunColor;
  uniform vec3 sunDir;
  uniform float sunSize;
  uniform float sunGlow;
  uniform float curve;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = h >= 0.0
      ? mix(bottomColor, topColor, pow(clamp(h, 0.0, 1.0), curve))
      : mix(bottomColor, belowColor, smoothstep(0.0, 0.4, -h));
    float s = max(dot(d, sunDir), 0.0);
    float halo = pow(s, 10.0) * 0.35 + pow(s, 80.0) * 0.5;
    col = mix(col, sunColor, clamp(halo * sunGlow, 0.0, 1.0));
    float disc = smoothstep(sunSize, sunSize + 0.0015, s) * step(0.001, sunGlow);
    col = mix(col, vec3(1.0, 0.98, 0.9), disc);
    gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
    #include <colorspace_fragment>
  }
`;

export interface SkyDomeOptions {
  top: string;
  bottom: string;
  below: string;
  /** Unit direction TO the sun; null = no sun (indoor). */
  sunDir: THREE.Vector3 | null;
  sunColor: string;
  /** Angular size: cos of the disc radius (closer to 1 = smaller). */
  sunSize?: number;
  /** Halo strength 0..1.5. */
  sunGlow?: number;
  /** Gradient falloff exponent above the horizon (< 1 keeps the bottom color low). */
  curve?: number;
}

export function createSkyDome(opts: SkyDomeOptions, radius = 420): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: srgbColor(opts.top) },
      bottomColor: { value: srgbColor(opts.bottom) },
      belowColor: { value: srgbColor(opts.below) },
      sunColor: { value: srgbColor(opts.sunColor) },
      sunDir: { value: (opts.sunDir ?? new THREE.Vector3(0, 1, 0)).clone().normalize() },
      sunSize: { value: opts.sunSize ?? 0.9988 },
      sunGlow: { value: opts.sunDir ? (opts.sunGlow ?? 1) : 0 },
      curve: { value: opts.curve ?? 0.6 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 20), material);
  mesh.name = "skyDome";
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

/** A Color whose r/g/b hold the sRGB-encoded components of `hex` (for perceptual blending in GLSL). */
function srgbColor(hex: string): THREE.Color {
  const linear = new THREE.Color(hex);
  const out = { r: 0, g: 0, b: 0 };
  linear.getRGB(out, THREE.SRGBColorSpace);
  return new THREE.Color(out.r, out.g, out.b);
}
