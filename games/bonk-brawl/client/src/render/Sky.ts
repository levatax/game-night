// Sky dome, clouds and the void below the island. Owner: client-render.

import * as THREE from "three";
import type { ArenaTheme } from "../../../shared/maps";
import type { Quality } from "../app/settings";

/**
 * - Gradient sky: large inverted sphere (radius ~400) with a tiny ShaderMaterial lerping
 *   theme.skyBottom → theme.skyTop by view height (no texture), fog: false, depthWrite false.
 * - Cloud billboards (cloudTexture): a ring of slow-drifting clouds around/below the island
 *   (12 on low, 24 on medium/high), plus the void layer per theme.voidKind: "clouds" (cloud sea
 *   far below), "drainWater" (big animated water disc ~ y=-25 with a drain swirl), "duskSky"
 *   (dark purple gradient + twinkling sparkle points).
 * - Ambient flavor per theme.ambient: butterflies / rising bubbles / drifting balloons
 *   (cheap instanced or sprite-based; fewer on low quality).
 */
export class Sky {
  readonly object = new THREE.Group();

  constructor(theme: ArenaTheme, quality: Quality) {
    void theme;
    void quality;
    this.object.name = "sky";
  }

  update(dt: number, elapsed: number): void {
    void dt;
    void elapsed;
  }

  dispose(): void {}
}
