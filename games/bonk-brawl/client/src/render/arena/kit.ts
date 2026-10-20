// Shared build context for arena pieces: where to parent things (the ring segment under them, so
// they fall with it, or the backdrop beyond the island edge), per-segment static bakers, and the
// list of per-frame animations.

import * as THREE from "three";
import type { ArenaDef } from "../../../../shared/maps";
import type { Quality } from "../../app/settings";
import { Baker } from "./Baker";
import type { FloorBuild, RingSegment } from "./floor";
import type { MaterialBank } from "./MaterialBank";

/** Anything that animates per frame (flames, ants, bubbles...). */
export interface Animated {
  update(dt: number, elapsed: number): void;
  /** Optional: scale cosmetic budgets (particle counts, glow sprites) to a quality level. */
  setQuality?(quality: Quality): void;
}

/** Particle / ambient budget multiplier per quality. */
export function qualityScale(quality: Quality): number {
  return quality === "low" ? 0.5 : quality === "medium" ? 0.8 : 1;
}

export class ArenaKit {
  readonly animated: Animated[] = [];
  /** Everything beyond the island edge (floating decor). Never falls. */
  readonly backdrop = new THREE.Group();
  private readonly bakers = new Map<RingSegment | null, Baker>();

  constructor(
    readonly def: ArenaDef,
    readonly bank: MaterialBank,
    readonly floor: FloorBuild,
    readonly quality: Quality,
  ) {
    this.backdrop.name = "backdrop";
  }

  /**
   * Parent `object` (positioned in world coordinates) to the segment under (x, z) so it shakes and
   * falls with it, or to the backdrop when (x, z) is beyond the edge.
   */
  attach(object: THREE.Object3D, x: number, z: number): RingSegment | null {
    const segment = this.floor.segmentAt(x, z);
    if (segment) {
      object.position.sub(segment.centroid);
      segment.object.add(object);
    } else {
      this.backdrop.add(object);
    }
    return segment;
  }

  /** Static vertex-colored baker for the segment under (x, z) (world coordinates). */
  bakerAt(x: number, z: number): Baker {
    const segment = this.floor.segmentAt(x, z);
    let baker = this.bakers.get(segment);
    if (!baker) {
      baker = new Baker();
      this.bakers.set(segment, baker);
    }
    return baker;
  }

  animate(item: Animated): void {
    this.animated.push(item);
  }

  /** Vertex-colored toon material shared by every baked prop/decor mesh. */
  bakedMaterial(): THREE.MeshToonMaterial {
    return this.bank.toonColor("#FFFFFF", { vertexColors: true });
  }

  /** Turn every per-segment baker into one mesh parented to its segment (or the backdrop). */
  flushBakers(): void {
    for (const [segment, baker] of this.bakers) {
      if (baker.empty) continue;
      const origin = segment ? segment.centroid : new THREE.Vector3();
      const mesh = new THREE.Mesh(this.bank.geo(baker.build(origin)), this.bakedMaterial());
      mesh.name = "bakedDecor";
      mesh.receiveShadow = true;
      (segment ? segment.object : this.backdrop).add(mesh);
    }
    this.bakers.clear();
  }

  /** A mesh from a baker in world coordinates, parented like attach(). */
  attachBaked(baker: Baker, x: number, z: number, name: string): THREE.Mesh {
    const mesh = new THREE.Mesh(this.bank.geo(baker.build({ x, y: 0, z })), this.bakedMaterial());
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.position.set(x, 0, z);
    this.attach(mesh, x, z);
    return mesh;
  }
}
