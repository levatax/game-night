// Soap-bubble shader: clear center, iridescent fresnel rim, a crisp highlight dot. Works on plain
// meshes and InstancedMesh (USE_INSTANCING). Caller owns the returned material.

import * as THREE from "three";

const VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 p = vec4(position, 1.0);
    vec3 n = normal;
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
      n = mat3(instanceMatrix) * n;
    #endif
    vec4 mv = modelViewMatrix * p;
    vNormal = normalize(normalMatrix * n);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 tint;
  uniform float opacity;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vView);
    float f = 1.0 - abs(dot(n, v));
    float rim = pow(f, 2.0);
    vec3 rainbow = 0.55 + 0.45 * cos(6.28318 * (f * 1.4 + vec3(0.0, 0.33, 0.67)));
    vec3 col = mix(tint, rainbow, 0.4 * rim);
    vec3 l = normalize(vec3(-0.45, 0.65, 0.6));
    float spec = step(0.93, dot(reflect(-l, n), v));
    float alpha = clamp(rim * 0.8 + 0.06 + spec, 0.0, 1.0) * opacity;
    gl_FragColor = vec4(col + spec, alpha);
    #include <colorspace_fragment>
  }
`;

export function createBubbleMaterial(tint: THREE.ColorRepresentation = "#FFFFFF", opacity = 0.9): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      tint: { value: new THREE.Color(tint) },
      opacity: { value: opacity },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
  });
}
