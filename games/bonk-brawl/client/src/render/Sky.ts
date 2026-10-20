// Sky dome, clouds and the void below the island. Owner: client-render.

import * as THREE from "three";
import type { ArenaTheme } from "../../../shared/maps";
import type { Quality } from "../app/settings";
import { mixHex } from "../util/color";
import { qualityScale } from "./arena/kit";
import { createRng, randRange } from "./noise";
import { pixelRatioFor } from "./quality";
import { AmbientBubbles, Butterflies, DriftingBalloons, type SkyPart } from "./sky/ambient";
import { BathroomRoom, CakeTiers, DistantIslands, DrainWater, Stars } from "./sky/backdrops";
import { CloudLayer, type CloudSpec } from "./sky/CloudLayer";
import { createSkyDome } from "./sky/SkyDome";

/**
 * - Gradient sky: large inverted sphere (radius ~420) with a tiny ShaderMaterial lerping
 *   theme.skyBottom → theme.skyTop by view height (no texture), fog: false, depthWrite false,
 *   with a crisp toon sun disc + halo (sunny picnic sun, low dusk sun; none indoors).
 * - Cloud billboards (cloudTexture, one instanced draw call per layer): a ring of slow-drifting
 *   clouds around the island (12 on low, 24 on medium/high; steam puffs in the bathroom), plus
 *   the void layer per theme.voidKind: "clouds" (cloud sea far below + tiny floating islands),
 *   "drainWater" (cartoon bathroom: tiled walls, mirror, window, swirling drain water with toy
 *   ducks), "duskSky" (dark purple below, twinkling stars, the rest of the giant cake far below).
 * - Ambient flavor per theme.ambient: butterflies / rising bubbles / drifting balloons
 *   (instanced; fewer on low quality).
 */
export class Sky {
  readonly object = new THREE.Group();
  private readonly dome: THREE.Mesh;
  private readonly cloudLayers: CloudLayer[] = [];
  private readonly drifting: Array<{ object: THREE.Object3D; speed: number }> = [];
  private readonly parts: SkyPart[] = [];

  constructor(theme: ArenaTheme, quality: Quality) {
    this.object.name = "sky";
    this.dome = createSkyDome(domeOptions(theme));
    this.object.add(this.dome);
    this.buildClouds(theme, quality);
    this.buildVoid(theme, quality);
    this.buildAmbient(theme, quality);
  }

  update(dt: number, elapsed: number): void {
    for (const d of this.drifting) d.object.rotation.y += d.speed * dt;
    for (const part of this.parts) part.update(dt, elapsed);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.dome.geometry.dispose();
    (this.dome.material as THREE.Material).dispose();
    for (const layer of this.cloudLayers) layer.dispose();
    for (const part of this.parts) part.dispose();
    this.cloudLayers.length = 0;
    this.parts.length = 0;
  }

  /* ------------------------------------------------------------------ build */

  private addClouds(specs: CloudSpec[], theme: ArenaTheme, name: string, speed: number): void {
    if (specs.length === 0) return;
    const layer = new CloudLayer(specs, theme.cloudColor, theme.cloudShadowColor, name);
    this.cloudLayers.push(layer);
    this.object.add(layer.mesh);
    this.drifting.push({ object: layer.mesh, speed });
  }

  private buildClouds(theme: ArenaTheme, quality: Quality): void {
    const rng = createRng(theme.skyTop.length * 97 + theme.voidKind.length);
    const many = quality === "low" ? 12 : 24;
    if (theme.voidKind === "drainWater") {
      // Indoors: a few soft steam puffs drifting under the ceiling.
      const steam = ringClouds(rng, Math.round(many / 3), { rMin: 28, rMax: 58, yMin: 20, yMax: 40, wMin: 12, wMax: 24 }, () => new THREE.Color(1, 1, 1));
      this.addClouds(steam, theme, "steam", 0.01);
      return;
    }
    const haze = new THREE.Color(theme.skyBottom);
    const white = new THREE.Color(1, 1, 1);
    const count = theme.voidKind === "duskSky" ? Math.round(many * 0.7) : many;
    const ring = ringClouds(rng, count, { rMin: 95, rMax: 180, yMin: -8, yMax: 42, wMin: 26, wMax: 56 }, (r) =>
      white.clone().lerp(haze, ((r - 95) / 85) * 0.3),
    );
    this.addClouds(ring, theme, "clouds", theme.voidKind === "duskSky" ? 0.004 : 0.006);
    // Clouds below the island: a full cloud sea for the sky island, a few dim ones at dusk.
    const below = new THREE.Color(theme.voidKind === "duskSky" ? theme.voidColor : theme.skyBottom);
    const seaCount = theme.voidKind === "clouds" ? Math.round(many * 1.1) : Math.round(many * 0.4);
    const sea = ringClouds(rng, seaCount, { rMin: 10, rMax: 140, yMin: -48, yMax: -24, wMin: 40, wMax: 80 }, (_r, y) =>
      white.clone().lerp(below, 0.15 + ((-24 - y) / 24) * (theme.voidKind === "duskSky" ? 0.5 : 0.25)),
    );
    this.addClouds(sea, theme, "cloudSea", -0.003);
  }

  private buildVoid(theme: ArenaTheme, quality: Quality): void {
    switch (theme.voidKind) {
      case "clouds":
        this.addPart(new DistantIslands(theme.rimColor, theme.sideColor));
        return;
      case "drainWater":
        this.addPart(new BathroomRoom());
        this.addPart(new DrainWater(theme.voidColor));
        return;
      case "duskSky": {
        this.addPart(new Stars(Math.round(280 * qualityScale(quality)), pixelRatioFor(quality)));
        this.addPart(new CakeTiers(theme.floorColor, theme.sideColor));
        return;
      }
    }
  }

  private buildAmbient(theme: ArenaTheme, quality: Quality): void {
    const scale = qualityScale(quality);
    switch (theme.ambient) {
      case "butterflies":
        this.addPart(new Butterflies(Math.round(12 * scale)));
        return;
      case "bubbles":
        this.addPart(new AmbientBubbles(Math.round(28 * scale)));
        return;
      case "balloons":
        this.addPart(new DriftingBalloons(Math.round(16 * scale)));
        return;
    }
  }

  private addPart(part: SkyPart): void {
    this.parts.push(part);
    this.object.add(part.object);
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

function ringClouds(
  rng: () => number,
  count: number,
  ring: CloudRing,
  tint: (radius: number, y: number) => THREE.Color,
): CloudSpec[] {
  const specs: CloudSpec[] = [];
  for (let i = 0; i < count; i++) {
    // Evenly spread azimuths with jitter so no side of the island is empty.
    const a = ((i + rng() * 0.8) / count) * Math.PI * 2;
    const r = randRange(rng, ring.rMin, ring.rMax);
    const y = ring.yMin + Math.pow(rng(), 1.4) * (ring.yMax - ring.yMin);
    specs.push({
      x: Math.cos(a) * r,
      y,
      z: Math.sin(a) * r,
      width: randRange(rng, ring.wMin, ring.wMax),
      tint: tint(r, y),
    });
  }
  return specs;
}

function domeOptions(theme: ArenaTheme): Parameters<typeof createSkyDome>[0] {
  const toSun = new THREE.Vector3(-theme.sunDirection.x, -theme.sunDirection.y, -theme.sunDirection.z).normalize();
  switch (theme.voidKind) {
    case "clouds":
      return {
        top: theme.skyTop,
        bottom: theme.skyBottom,
        below: mixHex(theme.skyBottom, theme.cloudColor, 0.6),
        sunDir: toSun,
        sunColor: "#FFF4C2",
        sunSize: 0.9985,
        sunGlow: 0.9,
      };
    case "drainWater":
      return { top: theme.skyTop, bottom: theme.skyBottom, below: theme.voidColor, sunDir: null, sunColor: "#FFFFFF" };
    case "duskSky": {
      // Decorative low sun on the light's azimuth so the dusk glow sits on the horizon.
      const low = new THREE.Vector3(toSun.x, 0, toSun.z).normalize();
      low.y = 0.07;
      return {
        top: theme.skyTop,
        bottom: theme.skyBottom,
        below: theme.voidColor,
        sunDir: low.normalize(),
        sunColor: "#FFC38A",
        sunSize: 0.9972,
        sunGlow: 1.3,
        curve: 0.45,
      };
    }
  }
}
