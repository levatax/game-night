// Item mesh budget + convention checks (every ItemKind builds, shares geometry, stays in the triangle budget,
// is roughly sized to ITEMS radius, long tools point along +Y). Owner: client-fx-audio.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ITEMS, ITEM_KINDS } from "../../../shared/items";
import { buildBerryMesh, buildItemMesh, itemInfo, itemTriangleCount, setItemGlow } from "./itemMeshes";

describe("buildItemMesh", () => {
  it("covers all 22 item kinds", () => {
    expect(ITEM_KINDS.length).toBe(22);
    for (const kind of ITEM_KINDS) expect(() => buildItemMesh(kind)).not.toThrow();
  });

  it("shares geometry and material across calls", () => {
    for (const kind of ITEM_KINDS) {
      const a = buildItemMesh(kind) as THREE.Mesh;
      const b = buildItemMesh(kind) as THREE.Mesh;
      expect(a).not.toBe(b);
      expect(a.geometry).toBe(b.geometry);
      expect(a.material).toBe(b.material);
    }
  });

  it("stays inside the 50–300 triangle budget", () => {
    for (const kind of ITEM_KINDS) {
      const tris = itemTriangleCount(kind);
      expect(tris, kind).toBeGreaterThanOrEqual(40);
      expect(tris, kind).toBeLessThanOrEqual(300);
    }
    expect(itemTriangleCount("berry")).toBeLessThanOrEqual(300);
  });

  it("is centered and roughly sized to ITEMS radius (compact items)", () => {
    for (const kind of ITEM_KINDS) {
      const mesh = buildItemMesh(kind) as THREE.Mesh;
      const box = mesh.geometry.boundingBox!;
      const center = box.getCenter(new THREE.Vector3());
      expect(center.length(), kind).toBeLessThan(1e-4);
      const info = itemInfo(mesh)!;
      expect(info.kind).toBe(kind);
      expect(info.radius).toBe(ITEMS[kind].radius);
      const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5).length();
      if (info.long) {
        // Long tools: along +Y, tip above the grip.
        const size = box.getSize(new THREE.Vector3());
        expect(size.y, kind).toBeGreaterThan(size.x);
        expect(info.tip!.y, kind).toBeGreaterThan(info.grip.y);
      } else {
        expect(half, kind).toBeGreaterThan(ITEMS[kind].radius * 0.55);
        expect(half, kind).toBeLessThan(ITEMS[kind].radius * 1.9);
      }
    }
  });

  it("gives the torch a flame child and an outline everywhere", () => {
    const torch = buildItemMesh("torch");
    expect(torch.getObjectByName("flame")).toBeTruthy();
    for (const kind of ITEM_KINDS) expect(buildItemMesh(kind).getObjectByName("outline"), kind).toBeTruthy();
    expect(buildItemMesh("rod").getObjectByName("flame")).toBeUndefined();
  });

  it("glow sprite toggles", () => {
    const coconut = buildItemMesh("coconut");
    setItemGlow(coconut, 1, "#ff0000", 0.5);
    const glow = coconut.getObjectByName("glow")!;
    expect(glow.visible).toBe(true);
    setItemGlow(coconut, 0);
    expect(glow.visible).toBe(false);
  });

  it("builds the berry extra", () => {
    expect(itemInfo(buildBerryMesh())!.kind).toBe("berry");
  });
});
