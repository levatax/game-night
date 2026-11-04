// Draw-call batcher for the Ship Tourists. Every tourist is built from one animated mesh per bone plus an
// inverted-hull outline and a wristband; used directly that is ~17 draws per player (80+ for five). This
// collects those parts into a handful of THREE.BatchedMesh objects (one per material family) and keeps the
// per-bone transforms in sync each frame, so a full table costs one body, one face and one outline batch
// instead of 17 meshes each (the seat tint rides in the per-instance colour). The visible hierarchy stays intact (bone groups drive the matrices,
// held items / cosmetics / nameplates are untouched), the source meshes are moved to an off-camera layer and
// the batched copies are drawn from the character root. Owner: client-characters.
//
// BatchedMesh needs WEBGL_multi_draw for a true single draw; without it three falls back to one GL call per
// instance (still correct, just not fewer calls). Flora already relies on the same extension.

import * as THREE from "three";
import { CHARACTERS } from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";
import { bodyMaterial, faceMaterial, flashMaterial, torusGeo } from "./kit";
import { createOutlineMaterial } from "../render/Toon";
import { getTouristBake } from "./models";
import { MESH_BONES } from "./models/common";
import { TOURIST_OUTLINE } from "./Tourist";
import type { Tourist } from "./Tourist";

/** Layer the source meshes are parked on: the game camera and shadow camera only see layer 0. */
const PARKED_LAYER = 1;
/** Sockets for six players plus a short hand-over overlap (a leaving avatar and its replacement). */
const MAX_INSTANCES = 96;

type Role = "body" | "face" | "outline" | "band";

interface Part {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  batch: PartBatch;
  instance: number;
  role: Role;
  /** Mirror instance in the white-flash batch (body parts only). */
  flash: { batch: PartBatch; instance: number } | null;
  /** Last outline material, to refresh its per-instance tint when the seat colour changes. */
  material: THREE.Material | null;
  /** Last band colour, to avoid re-uploading the instance colour every frame. */
  colorHex: number;
}

interface Record {
  root: THREE.Object3D;
  tourist: Tourist;
  parts: Part[];
}

/** One BatchedMesh and the geometry-id bookkeeping it needs. */
class PartBatch {
  readonly mesh: THREE.BatchedMesh;
  private readonly ids = new Map<THREE.BufferGeometry, number>();

  constructor(material: THREE.Material, maxVertices: number, maxIndices: number, castShadow: boolean) {
    this.mesh = new THREE.BatchedMesh(MAX_INSTANCES, maxVertices, maxIndices, material);
    this.mesh.name = "characters-batch";
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.perObjectFrustumCulled = false;
    this.mesh.sortObjects = false;
  }

  idFor(geometry: THREE.BufferGeometry): number {
    let id = this.ids.get(geometry);
    if (id === undefined) {
      id = this.mesh.addGeometry(geometry);
      this.ids.set(geometry, id);
    }
    return id;
  }

  add(geometry: THREE.BufferGeometry): number {
    return this.mesh.addInstance(this.idFor(geometry));
  }

  remove(instance: number): void {
    this.mesh.deleteInstance(instance);
  }
}

/** Unit wristband torus converted to the body batch's attribute layout (position / normal / colour, no index). */
let bandGeometryCache: THREE.BufferGeometry | null = null;
function bandGeometry(): THREE.BufferGeometry {
  if (!bandGeometryCache) {
    const g = torusGeo(0.34, Math.PI * 2, 3, 8).toNonIndexed();
    g.deleteAttribute("uv");
    const count = (g.getAttribute("position") as THREE.BufferAttribute).count;
    const color = new Float32Array(count * 3).fill(1);
    g.setAttribute("color", new THREE.BufferAttribute(color, 3));
    bandGeometryCache = g;
  }
  return bandGeometryCache;
}

/** The ink colour of an outline ShaderMaterial (seat-tinted by Tourist.setSeatColor). */
function outlineColor(mesh: THREE.Mesh): THREE.Color {
  const uniforms = (mesh.material as THREE.ShaderMaterial).uniforms;
  return (uniforms?.color?.value as THREE.Color | undefined) ?? new THREE.Color(1, 1, 1);
}

export class CharacterBatcher {
  private readonly body: PartBatch;
  private readonly flash: PartBatch;
  private readonly face: PartBatch;
  /** One outline batch for every seat colour; the tint rides in the per-instance colour. */
  private readonly outline: PartBatch;
  private readonly records: Record[] = [];
  private readonly outlineVerts: number;
  private readonly outlineIndices: number;
  private readonly white = new THREE.Color(1, 1, 1);
  private bodyColorsReady = false;

  constructor(parent: THREE.Object3D) {
    // Size the batches from every character bake (shared, built once and reused by the portraits too).
    let bodyVerts = 0;
    let faceVerts = 0;
    let outlineVerts = 0;
    for (const id of Object.keys(CHARACTERS) as CharacterId[]) {
      const bake = getTouristBake(id);
      for (const [name, bone] of Object.entries(bake.bones) as [string, { geometry: THREE.BufferGeometry; outline: THREE.BufferGeometry | null }][]) {
        const g = bone.geometry;
        if ((MESH_BONES as readonly string[]).includes(name)) bodyVerts += g.getAttribute("position").count;
        else faceVerts += g.getAttribute("position").count;
        if (bone.outline) outlineVerts += bone.outline.getAttribute("position").count;
      }
    }
    bodyVerts += bandGeometry().getAttribute("position").count;
    // mergeVertices shrinks the outline shell; reserve the source count (always larger) so it cannot overflow.
    this.outlineVerts = Math.max(1024, outlineVerts);
    this.outlineIndices = Math.max(2048, outlineVerts * 6);

    this.body = new PartBatch(bodyMaterial(), bodyVerts, 0, true);
    this.flash = new PartBatch(flashMaterial(), bodyVerts, 0, false);
    this.face = new PartBatch(faceMaterial(), Math.max(512, faceVerts), 0, false);
    this.outline = new PartBatch(createOutlineMaterial(TOURIST_OUTLINE, "#FFFFFF"), this.outlineVerts, this.outlineIndices, false);
    parent.add(this.body.mesh, this.flash.mesh, this.face.mesh, this.outline.mesh);
  }

  /** Register a tourist's part meshes. Call once, right after it is built (before held props are added). */
  register(tourist: Tourist): void {
    const root = tourist.rig.root;
    const parts: Part[] = [];
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!geometry) return;
      let role: Role;
      if (mesh.userData.isOutline || mesh.name === "outline") role = "outline";
      else if (mesh.name === "wristband") role = "band";
      else if (mesh.name.endsWith("-mesh")) role = mesh.material === faceMaterial() ? "face" : "body";
      else return;
      parts.push(this.makePart(mesh, geometry, role));
      // Park the source mesh off the render layers; its world matrix still drives the batched instance.
      mesh.layers.set(PARKED_LAYER);
    });
    // The flash batch mirrors every body part (the band never flashes).
    for (const part of parts) {
      if (part.role !== "body") continue;
      part.flash = { batch: this.flash, instance: this.flash.add(part.geometry) };
    }
    this.records.push({ root, tourist, parts });
    if (parts.some((p) => p.role === "band")) this.ensureBodyColors();
  }

  /** Drop a tourist's instances (called before the tourist disposes its meshes). */
  unregister(tourist: Tourist): void {
    const i = this.records.findIndex((r) => r.tourist === tourist);
    if (i < 0) return;
    const record = this.records[i]!;
    for (const part of record.parts) {
      part.batch.remove(part.instance);
      part.flash?.batch.remove(part.flash.instance);
    }
    this.records.splice(i, 1);
  }

  /** Refresh every instance matrix / visibility. Call after the animators ran, before renderer.render(). */
  flush(): void {
    for (const record of this.records) {
      record.root.updateWorldMatrix(true, true);
      const rootVisible = record.root.visible;
      const flashing = record.tourist.isFlashing;
      for (const part of record.parts) {
        const visible = rootVisible && part.mesh.visible;
        const m = part.mesh.matrixWorld;
        if (part.material !== null && part.mesh.material !== part.material) this.refreshOutline(part);
        if (part.role === "body") {
          part.batch.mesh.setMatrixAt(part.instance, m);
          part.batch.mesh.setVisibleAt(part.instance, visible && !flashing);
          if (part.flash) {
            part.flash.batch.mesh.setMatrixAt(part.flash.instance, m);
            part.flash.batch.mesh.setVisibleAt(part.flash.instance, visible && flashing);
          }
        } else {
          part.batch.mesh.setMatrixAt(part.instance, m);
          part.batch.mesh.setVisibleAt(part.instance, visible);
          if (part.role === "band") {
            const color = (part.mesh.material as THREE.MeshToonMaterial).color;
            const hex = color.getHex();
            if (hex !== part.colorHex) {
              part.colorHex = hex;
              part.batch.mesh.setColorAt(part.instance, color);
            }
          }
        }
      }
    }
  }

  private makePart(mesh: THREE.Mesh, source: THREE.BufferGeometry, role: Role): Part {
    // The wristband uses the shared indexed unit torus; the body batch is non-indexed, so add the converted copy.
    const geometry = role === "band" ? bandGeometry() : source;
    const batch = role === "outline" ? this.outline : role === "face" ? this.face : this.body;
    const part: Part = {
      mesh,
      geometry,
      batch,
      instance: batch.add(geometry),
      role,
      flash: null,
      material: role === "outline" ? (mesh.material as THREE.Material) : null,
      colorHex: role === "band" ? (mesh.material as THREE.MeshToonMaterial).color.getHex() : -1,
    };
    if (role === "outline") {
      const tint = outlineColor(mesh);
      part.colorHex = tint.getHex();
      batch.mesh.setColorAt(part.instance, tint);
    } else if (role === "band") {
      const tint = (mesh.material as THREE.MeshToonMaterial).color;
      part.colorHex = tint.getHex();
      batch.mesh.setColorAt(part.instance, tint);
    }
    return part;
  }

  /**
   * Give every body/band instance a colour. Creating the colour texture is what switches the body material
   * to the batched-colour variant; doing it once here keeps that recompile out of the first fight frame.
   */
  private ensureBodyColors(): void {
    if (this.bodyColorsReady) return;
    this.bodyColorsReady = true;
    for (const record of this.records) {
      for (const part of record.parts) {
        if (part.role === "body") this.body.mesh.setColorAt(part.instance, this.white);
        else if (part.role === "band") this.body.mesh.setColorAt(part.instance, (part.mesh.material as THREE.MeshToonMaterial).color);
      }
    }
  }

  /** The seat colour lives in the per-instance colour now: swap it instead of moving between batches. */
  private refreshOutline(part: Part): void {
    const material = part.mesh.material as THREE.Material;
    part.material = material;
    const tint = outlineColor(part.mesh);
    const hex = tint.getHex();
    if (hex === part.colorHex) return;
    part.colorHex = hex;
    part.batch.mesh.setColorAt(part.instance, tint);
  }
}

