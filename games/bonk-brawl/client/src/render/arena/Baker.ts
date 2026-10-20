// Bakes many small primitive parts into ONE vertex-colored geometry (one draw call per prop or
// per floor segment). Parts keep their own normals (smooth spheres stay smooth), or get faceted
// face normals when added with `flat` for the low-poly look.

import * as THREE from "three";

const tmpNormal = new THREE.Matrix3();
const tmpV = new THREE.Vector3();
const tmpColor = new THREE.Color();
const ab = new THREE.Vector3();
const ac = new THREE.Vector3();
const faceN = new THREE.Vector3();
const IDENTITY = new THREE.Matrix4();

export class Baker {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];

  /**
   * Append `geometry` transformed by `matrix` in a flat color. CONSUMES the geometry (it is
   * disposed after copying), so always pass a freshly created one.
   */
  add(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, matrix: THREE.Matrix4 = IDENTITY, flat = false): void {
    const source = geometry.index ? geometry.toNonIndexed() : geometry;
    const pos = source.getAttribute("position");
    if (!flat && !source.getAttribute("normal")) source.computeVertexNormals();
    const nor = flat ? null : source.getAttribute("normal");
    tmpNormal.getNormalMatrix(matrix);
    tmpColor.set(color);
    const start = this.positions.length;
    for (let i = 0; i < pos.count; i++) {
      tmpV.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      this.positions.push(tmpV.x, tmpV.y, tmpV.z);
      this.colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
      if (nor) {
        tmpV.fromBufferAttribute(nor, i).applyMatrix3(tmpNormal).normalize();
        this.normals.push(tmpV.x, tmpV.y, tmpV.z);
      }
    }
    if (flat) this.pushFaceNormals(start);
    if (source !== geometry) source.dispose();
    geometry.dispose();
  }

  /** Same as add() with a TRS built from position / Y-rotation-free euler / scale. */
  addAt(
    geometry: THREE.BufferGeometry,
    color: THREE.ColorRepresentation,
    position: THREE.Vector3Like,
    rotation: THREE.Euler | null = null,
    scale: THREE.Vector3Like | number = 1,
    flat = false,
  ): void {
    this.add(geometry, color, composeMatrix(position, rotation, scale), flat);
  }

  /** Append another baker's triangles transformed by `matrix` (used to place a pre-baked item). */
  merge(other: Baker, matrix: THREE.Matrix4 = IDENTITY): void {
    tmpNormal.getNormalMatrix(matrix);
    for (let i = 0; i < other.positions.length; i += 3) {
      tmpV.set(other.positions[i], other.positions[i + 1], other.positions[i + 2]).applyMatrix4(matrix);
      this.positions.push(tmpV.x, tmpV.y, tmpV.z);
      tmpV.set(other.normals[i], other.normals[i + 1], other.normals[i + 2]).applyMatrix3(tmpNormal).normalize();
      this.normals.push(tmpV.x, tmpV.y, tmpV.z);
      this.colors.push(other.colors[i], other.colors[i + 1], other.colors[i + 2]);
    }
  }

  get empty(): boolean {
    return this.positions.length === 0;
  }

  /** Build the geometry with positions re-centered by subtracting `origin`. */
  build(origin: THREE.Vector3Like = { x: 0, y: 0, z: 0 }): THREE.BufferGeometry {
    const pos = new Float32Array(this.positions.length);
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] = this.positions[i] - origin.x;
      pos[i + 1] = this.positions[i + 1] - origin.y;
      pos[i + 2] = this.positions[i + 2] - origin.z;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.computeBoundingSphere();
    return geometry;
  }

  private pushFaceNormals(start: number): void {
    const p = this.positions;
    for (let i = start; i < p.length; i += 9) {
      ab.set(p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]);
      ac.set(p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]);
      faceN.crossVectors(ab, ac).normalize();
      for (let k = 0; k < 3; k++) this.normals.push(faceN.x, faceN.y, faceN.z);
    }
  }
}

const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();

/** Matrix from position + optional euler + uniform or per-axis scale. */
export function composeMatrix(
  position: THREE.Vector3Like,
  rotation: THREE.Euler | null = null,
  scale: THREE.Vector3Like | number = 1,
  out: THREE.Matrix4 = new THREE.Matrix4(),
): THREE.Matrix4 {
  tmpPos.set(position.x, position.y, position.z);
  if (rotation) tmpQuat.setFromEuler(rotation);
  else tmpQuat.identity();
  if (typeof scale === "number") tmpScale.setScalar(scale);
  else tmpScale.set(scale.x, scale.y, scale.z);
  return out.compose(tmpPos, tmpQuat, tmpScale);
}
