// Per-island cache of materials, geometries and textures so props share GPU state and everything an island
// scene created is released in one place when the next island loads (Renderer.loadIsland). Owner:
// client-render. Copied from games/bonk-brawl/client/src/render/arena/MaterialBank.ts.

import * as THREE from "three";
import { createToonMaterial, type ToonOptions } from "../Toon";

export class MaterialBank {
  private readonly toon = new Map<string, THREE.MeshToonMaterial>();
  private readonly owned = new Set<THREE.Material>();
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly textures = new Set<THREE.Texture>();

  /** Shared toon material for a flat color (+ options). Same args → same instance. */
  toonColor(color: THREE.ColorRepresentation, opts: ToonOptions = {}): THREE.MeshToonMaterial {
    const c = new THREE.Color(color);
    const key = [
      c.getHexString(),
      opts.map?.uuid ?? "",
      opts.vertexColors ? "vc" : "",
      opts.flatShading ? "flat" : "",
      opts.transparent ? `t${opts.opacity ?? 1}` : "",
      opts.emissive !== undefined ? new THREE.Color(opts.emissive).getHexString() + (opts.emissiveIntensity ?? 1) : "",
      opts.side ?? "",
      opts.depthWrite === false ? "nodw" : "",
    ].join("|");
    let mat = this.toon.get(key);
    if (!mat) {
      mat = createToonMaterial(color, opts);
      this.toon.set(key, mat);
    }
    return mat;
  }

  /** Register a material the island created itself (disposed with the bank). */
  own<T extends THREE.Material>(material: T): T {
    this.owned.add(material);
    return material;
  }

  /** Register a geometry (disposed with the bank). Returns it for chaining. */
  geo<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }

  /**
   * Register a texture to free on dispose. Cached textures from textures.ts may be passed too:
   * three re-uploads a disposed texture transparently the next time it is used.
   */
  tex<T extends THREE.Texture>(texture: T): T {
    this.textures.add(texture);
    return texture;
  }

  /** Every material created through the bank (e.g. to force recompiles on shadow toggles). */
  allMaterials(): THREE.Material[] {
    return [...this.toon.values(), ...this.owned];
  }

  dispose(): void {
    for (const m of this.toon.values()) m.dispose();
    for (const m of this.owned) m.dispose();
    for (const g of this.geometries) g.dispose();
    for (const t of this.textures) t.dispose();
    this.toon.clear();
    this.owned.clear();
    this.geometries.clear();
    this.textures.clear();
  }
}
