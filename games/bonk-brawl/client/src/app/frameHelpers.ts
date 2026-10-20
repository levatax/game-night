// Small allocation-free helpers for the per-frame game loop. Owner: client-app.

import type { ArenaDef, ArenaShape, CrumbleKind } from "../../../shared/maps";
import type { FloorQuery } from "../../../shared/sim/context";
import type { BonkStateView, Vec3Like } from "../../../shared/types";
import type { ShadowCaster } from "../fx/types";

const NO_RINGS: ReadonlyArray<number> = [];

/**
 * FloorQuery that always reads the CURRENT `state.rings`: a reconnect creates a new decoded
 * state object, so a captured array would go stale. `arena` is swapped on map changes.
 */
export class LiveFloorQuery implements FloorQuery {
  constructor(
    public arena: ArenaDef,
    private readonly getState: () => BonkStateView | null,
  ) {}

  get rings(): ArrayLike<number> {
    return this.getState()?.rings ?? NO_RINGS;
  }
}

/** Reusable list of shadow casters (pooled entries, rebuilt every frame). */
export class ShadowCasterBuffer {
  readonly list: ShadowCaster[] = [];
  private readonly pool: ShadowCaster[] = [];

  reset(): void {
    this.list.length = 0;
  }

  add(x: number, y: number, z: number, radius: number): void {
    const i = this.list.length;
    let c = this.pool[i];
    if (!c) {
      c = { x: 0, y: 0, z: 0, radius: 0 };
      this.pool[i] = c;
    }
    c.x = x;
    c.y = y;
    c.z = z;
    c.radius = radius;
    this.list.push(c);
  }
}

/**
 * Point at shape-metric radius `r` and polar angle `angle`: a circle, or the superellipse
 * |x|^4 + |z|^4 = r^4 used by rounded-square arenas (maps.shapeDistance).
 */
export function shapePoint(shape: ArenaShape, r: number, angle: number, out: Vec3Like): Vec3Like {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (shape === "circle") {
    out.x = r * c;
    out.z = r * s;
  } else {
    out.x = r * Math.sign(c) * Math.sqrt(Math.abs(c));
    out.z = r * Math.sign(s) * Math.sqrt(Math.abs(s));
  }
  return out;
}

/** Middle radius of ring `ring` (between its inner and outer edge), or -1 for a bad index. */
export function ringMidRadius(def: ArenaDef, ring: number): number {
  const outer = def.ringRadii[ring];
  if (outer === undefined) return -1;
  const inner = ring > 0 ? def.ringRadii[ring - 1] : 0;
  return (inner + outer) / 2;
}

/** Particle tint for a crumbling ring: dirt and cake crumbs use the slab color, tiles the floor. */
export function crumbColor(def: ArenaDef, crumble: CrumbleKind): string {
  return crumble === "tiles" ? def.theme.floorColor : def.theme.sideColor;
}
