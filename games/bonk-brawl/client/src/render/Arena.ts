// Procedural arena built from shared/maps.ts. Owner: client-render.

import * as THREE from "three";
import { PEDESTAL_HEIGHT } from "../../../shared/constants";
import type { ArenaDef, CrumbleKind } from "../../../shared/maps";
import type { Quality } from "../app/settings";

/**
 * Builds, from ArenaDef only (no assets):
 * - Floor as one mesh per ring (ring 0 = disc, others = annuli in the arena's shape metric:
 *   circle or superellipse rounded square), top at y = 0, slab FLOOR_THICKNESS deep with
 *   theme.sideColor sides + rimColor lip; floor texture by theme.floorKind (textures.ts).
 *   Floor receives shadows. Rings are split into ~8 angular segments so the crumble can wobble
 *   and drop segments with slight per-segment delays.
 * - Cover pieces by `kind` (picnicTable, watermelon, basket, rubberDuck, soapBar, shampooBottle,
 *   candle (+ cosmetic animated flame), strawberry), toon-shaded, outlined, sized to the exact
 *   gameplay footprint (cylinder radius/height or box halfX/halfZ/height + rotation) so what you
 *   see is what blocks you. Cover receives shadows (characters and balls cast).
 * - Pedestals (3) at arena.pedestals with theme.pedestalColor/TrimColor, top at PEDESTAL_HEIGHT.
 *   Pedestals are NOT collidable (they are not in arena.cover): build them as a wide, low,
 *   glowing pad so feet passing over them don't read as clipping. They sit on ring 1 and fall
 *   with it.
 * - Decor items (cosmetic only) by DecorKind; decor inside the island is parented to the ring
 *   segment under it so it falls with the ring; outside the edge it floats in the backdrop.
 *   "ants" march along x,z → to and loop.
 * Ring animation (driven by syncRings each frame from state.rings):
 *   0 → solid; 1 → shake (small random jitter + wobble while shaking); 2 → wobbly fall: segments tumble down ~25 m over ~1.5 s with rotation, then hide;
 *   onRingFall(ring, theme.crumble) fires once when it starts falling (fx crumbs, audio rumble).
 *   A new arena (or round reset with all zeros) restores every ring instantly.
 */
export class Arena {
  readonly def: ArenaDef;
  readonly group = new THREE.Group();
  /** Fired once per ring when it starts to fall. */
  onRingFall: ((ring: number, crumble: CrumbleKind) => void) | null = null;

  constructor(def: ArenaDef, quality: Quality) {
    this.def = def;
    void quality;
    this.group.name = `arena:${def.id}`;
  }

  /** Apply ring states (call every frame with state.rings; idempotent; missing entries = solid). */
  syncRings(rings: ArrayLike<number>): void {
    void rings;
  }

  update(dt: number, elapsed: number): void {
    void dt;
    void elapsed;
  }

  /** World position of the top center of pedestal `index` (y = PEDESTAL_HEIGHT). */
  pedestalTop(index: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.def.pedestals[index] ?? { x: 0, z: 0 };
    return out.set(p.x, PEDESTAL_HEIGHT, p.z);
  }

  setQuality(quality: Quality): void {
    void quality;
  }

  dispose(): void {}
}
