// Power-up pedestals: a wide, low glowing pad with a short emitter post (top at PEDESTAL_HEIGHT).
// Not collidable (pedestals are not cover), so they stay low enough that walking over them
// doesn't read as clipping. Parented to their ring-1 segment so they fall with it.

import * as THREE from "three";
import { PEDESTAL_HEIGHT } from "../../../../shared/constants";
import { shadeHex } from "../../util/color";
import type { Animated, ArenaKit } from "./kit";

const PAD_RADIUS = 0.95;
const PAD_HEIGHT = 0.08;
const POST_RADIUS = 0.22;

export function buildPedestals(kit: ArenaKit): void {
  const { theme } = kit.def;
  const bank = kit.bank;
  const padMat = bank.toonColor(theme.pedestalColor, { flatShading: true });
  const sideMat = bank.toonColor(shadeHex(theme.pedestalColor, -0.18), { flatShading: true });
  // One shared emissive material so the whole set pulses together cheaply.
  const glowMat = bank.toonColor(theme.pedestalTrimColor, { emissive: theme.pedestalTrimColor, emissiveIntensity: 0.6 });

  const pad = bank.geo(new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS + 0.05, PAD_HEIGHT, 24));
  pad.translate(0, PAD_HEIGHT / 2, 0);
  const trim = bank.geo(new THREE.TorusGeometry(PAD_RADIUS - 0.12, 0.045, 6, 32));
  trim.rotateX(Math.PI / 2);
  trim.translate(0, PAD_HEIGHT + 0.005, 0);
  const postH = PEDESTAL_HEIGHT - PAD_HEIGHT - 0.04;
  const post = bank.geo(new THREE.CylinderGeometry(POST_RADIUS * 0.85, POST_RADIUS, postH, 12));
  post.translate(0, PAD_HEIGHT + postH / 2, 0);
  const cap = bank.geo(new THREE.CylinderGeometry(POST_RADIUS + 0.04, POST_RADIUS * 0.9, 0.04, 12));
  cap.translate(0, PEDESTAL_HEIGHT - 0.02, 0);

  kit.def.pedestals.forEach((p, i) => {
    const group = new THREE.Group();
    group.name = `pedestal${i}`;
    group.add(mesh(pad, padMat), mesh(trim, glowMat), mesh(post, sideMat), mesh(cap, glowMat));
    group.position.set(p.x, 0, p.z);
    kit.attach(group, p.x, p.z);
  });
  kit.animate(new GlowPulse(glowMat));
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.receiveShadow = true;
  return m;
}

class GlowPulse implements Animated {
  constructor(private readonly material: THREE.MeshToonMaterial) {}

  update(_dt: number, elapsed: number): void {
    this.material.emissiveIntensity = 0.45 + 0.25 * (0.5 + 0.5 * Math.sin(elapsed * 2.4));
  }
}
