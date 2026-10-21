// Sky container: gradient dome (sun + moon), a ring of fair-weather clouds, a storm / rain cloud layer that
// swells in, and night stars — 3–4 draw calls, all driven by DayNight's Lighting each frame. Persistent across
// islands (Renderer owns it); rebuilt only on a quality change. Owner: client-render.
// Adapted from games/bonk-brawl/client/src/render/Sky.ts (ringClouds).

import * as THREE from "three";
import type { Quality } from "../../app/settings";
import { createRng, randRange } from "../noise";
import { pixelRatioFor, scaledCount } from "../quality";
import { CloudLayer, type CloudSpec } from "./CloudLayer";
import type { Lighting } from "./DayNight";
import { SkyDome } from "./SkyDome";
import { Stars } from "./Stars";

const tmpPos = new THREE.Vector3();

export class Sky {
  readonly object = new THREE.Group();
  private readonly dome = new SkyDome();
  private readonly clouds: CloudLayer;
  private readonly stormClouds: CloudLayer;
  private readonly stars: Stars;
  private readonly drift: THREE.Group = new THREE.Group();

  constructor(quality: Quality) {
    this.object.name = "sky";
    this.object.add(this.dome.mesh);
    const rng = createRng(0x5ca1ab1e);
    const white = new THREE.Color(1, 1, 1);
    const haze = new THREE.Color("#DCEFF7");
    const fair = ringClouds(rng, scaledCount(22, quality), { rMin: 120, rMax: 200, yMin: 28, yMax: 80, wMin: 30, wMax: 64 }, (r) =>
      white.clone().lerp(haze, ((r - 120) / 80) * 0.35),
    );
    this.clouds = new CloudLayer(fair, "#FFFFFF", "#C9D6E8", "clouds");
    const dark = new THREE.Color("#B9C2CC");
    const heavy = ringClouds(rng, scaledCount(30, quality), { rMin: 70, rMax: 170, yMin: 26, yMax: 60, wMin: 46, wMax: 90 }, () =>
      white.clone().lerp(dark, rng() * 0.5),
    );
    this.stormClouds = new CloudLayer(heavy, "#E6EAEE", "#8E98A6", "stormClouds");
    this.drift.add(this.clouds.mesh, this.stormClouds.mesh);
    this.object.add(this.drift);
    this.stars = new Stars(scaledCount(420, quality), pixelRatioFor(quality));
    this.object.add(this.stars.object);
  }

  /** Per frame (after DayNight): colors, discs, clouds, stars; the dome and stars follow the camera. */
  update(dt: number, elapsed: number, light: Lighting, camera: THREE.Camera, flash: number): void {
    camera.getWorldPosition(tmpPos);
    this.dome.follow(tmpPos);
    this.dome.set({
      top: light.skyTop,
      horizon: light.skyHorizon,
      below: light.skyBelow,
      fog: light.fogColor,
      fogAmount: light.fogAmount,
      sunDir: light.sunDir,
      sunColor: light.sunColor,
      sunSize: light.sunSize,
      sunGlow: light.sunGlow,
      moonDir: light.moonDir,
      moonColor: light.moonColor,
      moonSize: light.moonSize,
      moonGlow: light.moonGlow,
      flash,
    });
    this.drift.rotation.y += dt * (0.004 + light.wind * 0.012);
    this.clouds.setTint(light.cloudTint);
    this.clouds.setGrow(1 - light.fogAmount * 0.6);
    this.stormClouds.setTint(light.cloudTint);
    this.stormClouds.setGrow(light.stormClouds);
    this.stars.update(elapsed, light.starAlpha, tmpPos);
  }

  setPixelRatio(ratio: number): void {
    this.stars.setPixelRatio(ratio);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.dome.dispose();
    this.clouds.dispose();
    this.stormClouds.dispose();
    this.stars.dispose();
  }
}

interface CloudRing {
  rMin: number;
  rMax: number;
  yMin: number;
  yMax: number;
  wMin: number;
  wMax: number;
}

function ringClouds(rng: () => number, count: number, ring: CloudRing, tint: (radius: number, y: number) => THREE.Color): CloudSpec[] {
  const specs: CloudSpec[] = [];
  for (let i = 0; i < count; i++) {
    // Evenly spread azimuths with jitter so no side of the island is empty.
    const a = ((i + rng() * 0.8) / count) * Math.PI * 2;
    const r = randRange(rng, ring.rMin, ring.rMax);
    const y = ring.yMin + Math.pow(rng(), 1.4) * (ring.yMax - ring.yMin);
    specs.push({ x: Math.cos(a) * r, y, z: Math.sin(a) * r, width: randRange(rng, ring.wMin, ring.wMax), tint: tint(r, y) });
  }
  return specs;
}
