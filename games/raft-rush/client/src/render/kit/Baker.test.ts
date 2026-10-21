// Baker: baking counts, vertex colors, face jitter and the thin-shell doubleSided helper. Owner: client-render.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Baker, doubleSided } from "./Baker";
import { MeshBuilder } from "./MeshBuilder";

describe("Baker", () => {
  it("bakes geometries into one position / normal / color soup", () => {
    const b = new Baker();
    b.add(new THREE.BoxGeometry(1, 1, 1), "#ff0000", new THREE.Matrix4(), true);
    b.addAt(new THREE.TetrahedronGeometry(1, 0), "#00ff00", new THREE.Vector3(3, 0, 0));
    expect(b.triangles).toBe(12 + 4);
    const g = b.build();
    expect(g.getAttribute("position").count).toBe(16 * 3);
    expect(g.getAttribute("normal").count).toBe(16 * 3);
    expect(g.getAttribute("color").count).toBe(16 * 3);
    // The tetrahedron was moved to x = 3.
    g.computeBoundingBox();
    expect(g.boundingBox!.max.x).toBeGreaterThan(3.5);
  });

  it("addVaried keeps the triangle count and jitters face colors around the base", () => {
    const b = new Baker();
    b.addVaried(new THREE.IcosahedronGeometry(1, 0), "#808080", new THREE.Matrix4(), 0.1, 7);
    const c = b.build().getAttribute("color");
    const base = new THREE.Color("#808080").r;
    let differs = false;
    for (let i = 0; i < c.count; i++) {
      expect(Math.abs(c.getX(i) - base)).toBeLessThanOrEqual(base * 0.1 + 1e-6);
      if (Math.abs(c.getX(i) - base) > 1e-4) differs = true;
    }
    expect(c.count).toBe(60);
    expect(differs).toBe(true);
  });

  it("addVertexColored keeps a MeshBuilder's per-face colors", () => {
    const mb = new MeshBuilder();
    mb.tri({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, "#ff0000", { x: 0, y: 1, z: 0 });
    mb.tri({ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 1 }, "#0000ff", { x: 0, y: 1, z: 0 });
    const b = new Baker();
    b.addVertexColored(mb.build(), new THREE.Matrix4(), true);
    const c = b.build().getAttribute("color");
    expect(c.getX(0)).toBeCloseTo(1, 5);
    expect(c.getZ(0)).toBeCloseTo(0, 5);
    expect(c.getZ(3)).toBeCloseTo(1, 5);
    expect(c.getX(3)).toBeCloseTo(0, 5);
  });

  it("doubleSided makes a thin shell: twice the triangles, the copy reversed and pushed behind", () => {
    const quad = new THREE.PlaneGeometry(1, 1);
    const shell = doubleSided(quad, 0.05);
    const pos = shell.getAttribute("position");
    expect(pos.count).toBe(12);
    // PlaneGeometry faces +Z: the back copy sits 5 cm behind it.
    for (let i = 6; i < 12; i++) expect(pos.getZ(i)).toBeCloseTo(-0.05, 6);
    const b = new Baker();
    b.add(shell, "#ffffff", new THREE.Matrix4(), true);
    const n = b.build().getAttribute("normal");
    expect(n.getZ(0)).toBeCloseTo(1, 5);
    expect(n.getZ(6)).toBeCloseTo(-1, 5);
  });
});
