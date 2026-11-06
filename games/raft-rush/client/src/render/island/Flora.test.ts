// Flora: node depletion read from WorldFrame.nodes (stumps, coconuts, pebbles, bare rope bushes, berries) and
// the instance budget. Runs the real BatchedMesh in node (no GPU needed). Owner: client-render.

import { describe, expect, it } from "vitest";
import { generateIsland } from "../../../../shared/island/generate";
import type { NodeDef } from "../../../../shared/island/types";
import { MaterialBank } from "../kit/MaterialBank";
import { Flora } from "./Flora";

interface SlotView {
  node: NodeDef;
  mesh: import("three").BatchedMesh;
  main: number;
  alt: number;
  extras: number[];
  geoFull: number;
  geoBare: number;
}

function setup() {
  const def = generateIsland(3, "solo");
  const flora = new Flora(def, new MaterialBank());
  const slots = (flora as unknown as { slots: SlotView[] }).slots;
  const nodes = def.nodes.map((n) => n.amount);
  const focus = { x: 0, y: 0, z: 0 };
  const run = (sec: number) => {
    for (let t = 0; t < sec; t += 1 / 30) flora.update(1 / 30, t, nodes, 0.3, focus);
  };
  run(0.1);
  return { def, flora, slots, nodes, run, mesh: flora.mesh };
}

describe("Flora", () => {
  it("draws every node of the island in batched meshes (casters + bushes)", () => {
    const { def, slots, mesh } = setup();
    expect(slots.length).toBe(def.nodes.length);
    expect(mesh.isBatchedMesh).toBe(true);
    for (const s of slots) expect(s.mesh.getVisibleAt(s.main)).toBe(true);
  });

  it("a felled tree falls over and leaves a stump", () => {
    const { slots, nodes, run, mesh } = setup();
    const tree = slots.find((s) => s.node.kind === "tree")!;
    expect(tree.mesh.getVisibleAt(tree.alt)).toBe(false);
    nodes[tree.node.i] = 0;
    run(0.2);
    // Falling: tree still drawn, stump already there.
    expect(tree.mesh.getVisibleAt(tree.main)).toBe(true);
    expect(tree.mesh.getVisibleAt(tree.alt)).toBe(true);
    run(2);
    expect(tree.mesh.getVisibleAt(tree.main)).toBe(false);
    expect(tree.mesh.getVisibleAt(tree.alt)).toBe(true);
  });

  it("palms show one coconut per remaining amount and regrow them", () => {
    const { slots, nodes, run, mesh } = setup();
    const palm = slots.find((s) => s.node.kind === "palm")!;
    expect(palm.extras.length).toBe(2);
    nodes[palm.node.i] = 1;
    run(0.1);
    expect(palm.mesh.getVisibleAt(palm.extras[0]!)).toBe(true);
    expect(palm.mesh.getVisibleAt(palm.extras[1]!)).toBe(false);
    nodes[palm.node.i] = 0;
    run(0.1);
    expect(palm.mesh.getVisibleAt(palm.extras[0]!)).toBe(false);
    nodes[palm.node.i] = 2;
    run(0.5);
    expect(palm.mesh.getVisibleAt(palm.extras[1]!)).toBe(true);
  });

  it("rocks crumble to pebbles", () => {
    const { slots, nodes, run, mesh } = setup();
    const rock = slots.find((s) => s.node.kind === "rock")!;
    nodes[rock.node.i] = 0;
    run(1);
    expect(rock.mesh.getVisibleAt(rock.main)).toBe(false);
    expect(rock.mesh.getVisibleAt(rock.alt)).toBe(true);
  });

  it("rope bushes go bare; berry bushes lose their berries", () => {
    const { slots, nodes, run, mesh } = setup();
    const rope = slots.find((s) => s.node.kind === "bush" && s.node.yield === "rope");
    const berry = slots.find((s) => s.node.kind === "bush" && s.node.yield === "berry");
    if (rope) {
      expect(rope.mesh.getGeometryIdAt(rope.main)).toBe(rope.geoFull);
      nodes[rope.node.i] = 0;
      run(0.1);
      expect(rope.mesh.getGeometryIdAt(rope.main)).toBe(rope.geoBare);
    }
    if (berry) {
      expect(berry.mesh.getVisibleAt(berry.extras[0]!)).toBe(true);
      nodes[berry.node.i] = 0;
      run(0.1);
      expect(berry.mesh.getVisibleAt(berry.extras[0]!)).toBe(false);
      expect(berry.mesh.getVisibleAt(berry.main)).toBe(true);
    }
    expect(rope ?? berry).toBeDefined();
  });

  it("an empty nodes view (lobby) keeps the initial amounts", () => {
    const { flora, slots, mesh } = setup();
    flora.update(1 / 30, 1, [], 0.3, { x: 0, y: 0, z: 0 });
    for (const s of slots) if (s.node.kind === "tree") expect(s.mesh.getVisibleAt(s.main)).toBe(s.node.amount > 0);
  });

  it("keeps low bushes out of the shadow pass", () => {
    const { flora, slots } = setup();
    expect(flora.mesh.castShadow).toBe(true);
    expect(flora.softMesh.castShadow).toBe(false);
    expect(slots.find((s) => s.node.kind === "bush")!.mesh).toBe(flora.softMesh);
    expect(slots.find((s) => s.node.kind === "tree")!.mesh).toBe(flora.mesh);
  });

  // §20 budgeted ≈ 40k flora triangles for the original ~290-node island (≈ 136 per node). The long-tide island
  // has ~2.5x the nodes, so the budget is per node (archetypes were trimmed to stay under it) with a hard cap that
  // keeps the whole solo scene inside docs/PERF_DRAWCALLS.md's 250k (dev/bench.mts).
  it("stays inside the flora budget (≤ 130 triangles per node, < 95k on a solo island)", () => {
    const { def, flora } = setup();
    expect(flora.triangles / def.nodes.length).toBeLessThan(130);
    expect(flora.triangles).toBeLessThan(95000);
  });
});
