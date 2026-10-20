// Procedural arena built from shared/maps.ts. Owner: client-render.

import * as THREE from "three";
import { PEDESTAL_HEIGHT } from "../../../shared/constants";
import type { ArenaDef, CrumbleKind } from "../../../shared/maps";
import type { Quality } from "../app/settings";
import { buildCover } from "./arena/cover";
import { RingAnimator } from "./arena/crumble";
import { buildDecor } from "./arena/decor";
import { buildFloor, type FloorBuild } from "./arena/floor";
import { ArenaKit, type Animated } from "./arena/kit";
import { MaterialBank } from "./arena/MaterialBank";
import { buildPedestals } from "./arena/pedestals";
import { hashString } from "./noise";

/**
 * Builds, from ArenaDef only (no assets):
 * - Floor as one mesh per ring (ring 0 = disc, others = annuli in the arena's shape metric:
 *   circle or superellipse rounded square), top at y = 0, slab FLOOR_THICKNESS deep with
 *   theme.sideColor sides + rimColor lip; floor texture by theme.floorKind (textures.ts).
 *   Floor receives shadows. Rings are split into ~8 angular segments so the crumble can wobble
 *   and drop segments with slight per-segment delays.
 * - Cover pieces by `kind` (picnicTable, watermelon, basket, rubberDuck, soapBar, shampooBottle,
 *   candle (+ cosmetic animated flame), strawberry), toon-shaded, sized to the exact gameplay
 *   footprint (cylinder radius/height or box halfX/halfZ/height + rotation) so what you see is
 *   what blocks you. Environment has no outlines (only characters and balls do). Cover receives
 *   shadows (characters and balls cast).
 * - Pedestals (3) at arena.pedestals with theme.pedestalColor/TrimColor, top at PEDESTAL_HEIGHT.
 *   Pedestals are NOT collidable (they are not in arena.cover): built as a wide, low, glowing pad
 *   so feet passing over them don't read as clipping. They sit on ring 1 and fall with it.
 * - Decor items (cosmetic only) by DecorKind; decor inside the island is parented to (or baked
 *   into) the ring segment under it so it falls with the ring; outside the edge it floats in the
 *   backdrop. "ants" march along x,z → to and loop.
 * Ring animation (driven by syncRings each frame from state.rings):
 *   0 → solid; 1 → shake (jitter + wobble ramping up over the 0.8 s); 2 → wobbly fall: segments
 *   tumble down and outward ~25 m over ~1.5 s with staggered starts, then hide;
 *   onRingFall(ring, theme.crumble) fires once when it starts falling (fx crumbs, audio rumble).
 *   A new arena (or round reset with all zeros) restores every ring instantly; the first sync of
 *   a new arena (late join / reconnect) snaps to the current states without animating.
 * GPU resources (geometries, materials, textures) are released by dispose().
 */
export class Arena {
  readonly def: ArenaDef;
  readonly group = new THREE.Group();
  /** Fired once per ring when it starts to fall. */
  onRingFall: ((ring: number, crumble: CrumbleKind) => void) | null = null;

  private readonly bank = new MaterialBank();
  private readonly floor: FloorBuild;
  private readonly rings: RingAnimator;
  private readonly animated: Animated[];
  private quality: Quality;

  constructor(def: ArenaDef, quality: Quality) {
    this.def = def;
    this.quality = quality;
    this.group.name = `arena:${def.id}`;

    this.floor = buildFloor(def, this.bank);
    for (const ring of this.floor.rings) {
      for (const segment of ring) this.group.add(segment.object);
    }
    const kit = new ArenaKit(def, this.bank, this.floor, quality);
    this.group.add(buildCover(kit));
    buildPedestals(kit);
    buildDecor(kit);
    kit.flushBakers();
    this.group.add(kit.backdrop);
    this.animated = kit.animated;

    this.rings = new RingAnimator(this.floor.rings, def.theme.crumble, hashString(def.id));
    this.rings.onRingFall = (ring, crumble) => this.onRingFall?.(ring, crumble);
  }

  /** Apply ring states (call every frame with state.rings; idempotent; missing entries = solid). */
  syncRings(rings: ArrayLike<number>): void {
    this.rings.sync(rings);
  }

  update(dt: number, elapsed: number): void {
    this.rings.update(dt);
    for (const item of this.animated) item.update(dt, elapsed);
  }

  /** World position of the top center of pedestal `index` (y = PEDESTAL_HEIGHT). */
  pedestalTop(index: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.def.pedestals[index] ?? { x: 0, z: 0 };
    return out.set(p.x, PEDESTAL_HEIGHT, p.z);
  }

  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    for (const item of this.animated) item.setQuality?.(quality);
  }

  /** Remove from the scene and free every geometry/material/texture this arena created. */
  dispose(): void {
    this.group.removeFromParent();
    this.onRingFall = null;
    this.group.traverse((obj) => {
      if (obj instanceof THREE.InstancedMesh) obj.dispose();
    });
    this.bank.dispose();
  }
}
