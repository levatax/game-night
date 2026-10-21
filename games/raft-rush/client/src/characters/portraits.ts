// Lobby portraits: every tourist rendered once (bust framing, 3/4 view, holding their signature prop) into a
// small offscreen WebGL canvas, read back as a PNG data URL and cached for the page lifetime. One throwaway
// renderer draws all six on the first request, then releases its context. Owner: client-characters.

import * as THREE from "three";
import { CHARACTER_IDS } from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";
import { Animator } from "./Animator";
import { createPuppetFrame } from "./puppet";
import { Tourist } from "./Tourist";

/** Portrait size in pixels (square). */
export const PORTRAIT_SIZE = 256;
const FOV = 28;

const cache = new Map<CharacterId, string>();
let failed = false;

/** PNG data URL of `character` ("" when WebGL is unavailable). Renders all six on the first call. */
export function portraitOf(character: CharacterId): string {
  const hit = cache.get(character);
  if (hit !== undefined) return hit;
  if (failed) return "";
  renderAll();
  return cache.get(character) ?? "";
}

function renderAll(): void {
  let renderer: THREE.WebGLRenderer | null = null;
  try {
    const canvas = document.createElement("canvas");
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(PORTRAIT_SIZE, PORTRAIT_SIZE, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#FFF4DC", "#7FB8C9", 1.5));
    const key = new THREE.DirectionalLight("#FFFFFF", 2.2);
    key.position.set(-1.5, 3, -3);
    scene.add(key, key.target);
    const rim = new THREE.DirectionalLight("#FFD6A0", 1.2);
    rim.position.set(2, 1.5, 2);
    scene.add(rim, rim.target);
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 20);
    for (const id of CHARACTER_IDS) {
      const tourist = new Tourist(id, null, { shadows: false });
      const animator = new Animator(tourist);
      const frame = createPuppetFrame(id);
      // Let the signature-prop hold settle.
      for (let i = 0; i < 45; i++) animator.update(frame, "", 1 / 60);
      tourist.rig.root.rotation.y = 0;
      scene.add(tourist.rig.root);
      const s = tourist.spec.scale;
      const top = tourist.spec.topY * s + 0.04;
      const bottom = 0.72 * s;
      const half = (top - bottom) / 2;
      const cy = (top + bottom) / 2;
      const dist = (half / Math.tan(THREE.MathUtils.degToRad(FOV / 2))) * 1.12;
      camera.position.set(dist * 0.42, cy + 0.08, -dist * 0.91);
      camera.lookAt(0, cy, 0);
      renderer.render(scene, camera);
      cache.set(id, canvas.toDataURL("image/png"));
      scene.remove(tourist.rig.root);
      tourist.dispose();
    }
  } catch {
    failed = true;
  } finally {
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
    }
  }
}
