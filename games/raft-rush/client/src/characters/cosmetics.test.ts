// Worn cosmetics on a Tourist (the pirate-hat treasure). Owner: client-characters.

import type * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createCosmetic } from "./cosmetics";
import { Tourist } from "./Tourist";

describe("cosmetics", () => {
  it("builds a pirate hat (shared geometry) and nothing for unknown kinds", () => {
    const a = createCosmetic("pirate_hat")!;
    const b = createCosmetic("pirate_hat")!;
    expect(a.name).toBe("pirateHat");
    const meshA = a.getObjectByProperty("type", "Mesh") as THREE.Mesh;
    const meshB = b.getObjectByProperty("type", "Mesh") as THREE.Mesh;
    expect(meshA.geometry).toBe(meshB.geometry);
    expect(createCosmetic("")).toBeNull();
    expect(createCosmetic("boot")).toBeNull();
  });

  it("a tourist wears and takes off the hat on its head anchor", () => {
    const t = new Tourist("kaptan", "#FF5A5F", { outlines: false, shadows: false });
    t.setCosmetic("pirate_hat");
    expect(t.rig.carryTop.getObjectByName("pirateHat")).toBeTruthy();
    t.setCosmetic("pirate_hat");
    expect(t.rig.carryTop.children.filter((c) => c.name === "pirateHat")).toHaveLength(1);
    t.setCosmetic("");
    expect(t.rig.carryTop.getObjectByName("pirateHat")).toBeUndefined();
    t.dispose();
  });
});
