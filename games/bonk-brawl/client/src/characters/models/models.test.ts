// Model budgets, hitbox fairness and rig invariants for the six animals (node, no WebGL).
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CHARACTER_IDS, CHARACTERS, PLAYER_HEIGHT, PLAYER_RADIUS } from "../../../../shared/constants";
import type { CharacterId } from "../../../../shared/types";
import { measureBudget } from "../Animal";
import { AnimalMaterials, type Detail, PartBuilder, type Prim, primPositions } from "../parts";
import { type BuiltModel } from "./common";
import { buildAnimalModel, buildMemento } from "./index";

const BUDGET = {
  hi: { tris: 2400, trisWithOutline: 4400, meshes: 16, calls: 28, casters: 5 },
  mid: { tris: 1400, trisWithOutline: 2600, meshes: 16, calls: 28, casters: 5 },
} as const;
const TOLERANCE = 0.02;
/**
 * Limbs may poke out a bit more: arms hang beside the torso (they swing anyway) and feet must
 * show in front of the body, which the capsule's round bottom can't contain.
 */
const LIMB_TOLERANCE = 0.12;
const FLAIR_MAX = 0.25;
const TOP_LIMIT = 1.56;

interface Built {
  model: BuiltModel;
  prims: Array<{ pivot: THREE.Object3D; prim: Prim }>;
}

function build(character: CharacterId, detail: Detail): Built {
  const materials = new AnimalMaterials(CHARACTERS[character].colors, "#3B82F6", {
    eyes: new THREE.Texture(),
    mouth: new THREE.Texture(),
  });
  let prims: Array<{ pivot: THREE.Object3D; prim: Prim }> = [];
  const model = buildAnimalModel(character, new PartBuilder(materials, { detail, cacheKey: `test:${character}:${detail}` }), (b) => {
    prims = [...b.allPrims()];
  });
  return { model, prims };
}

/** Distance outside the hitbox capsule (≤ 0 = inside). */
function capsuleExcess(x: number, y: number, z: number): number {
  const r = PLAYER_RADIUS;
  const cy = Math.max(r, Math.min(PLAYER_HEIGHT - r, y));
  return Math.hypot(x, y - cy, z) - r;
}

function isUnder(o: THREE.Object3D, name: string): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.name === name) return true;
  return false;
}

/** Approximate volume (m³) of the union of the analytic core masses (ellipsoids / boxes). */
function coreVolume(prims: ReadonlyArray<{ pivot: THREE.Object3D; prim: Prim }>): number {
  const shapes = prims
    .filter(({ pivot, prim }) => prim.shape.kind !== "other" && !prim.flair && (pivot.name === "upper" || pivot.name === "head" || pivot.name === "belly"))
    .map(({ prim }) => ({ prim, inv: prim.matrix.clone().invert() }));
  const step = 0.02;
  const p = new THREE.Vector3();
  let count = 0;
  for (let x = -0.5; x <= 0.5; x += step) {
    for (let y = 0; y <= 1.5; y += step) {
      for (let z = -0.5; z <= 0.5; z += step) {
        for (const { prim, inv } of shapes) {
          p.set(x, y, z).applyMatrix4(inv);
          const shape = prim.shape;
          let inside = false;
          if (shape.kind === "ellipsoid") {
            const f = 1 + shape.k * p.y;
            inside = (p.x * p.x + p.z * p.z) / (f * f) + p.y * p.y <= 1;
          } else if (shape.kind === "box") {
            const qx = Math.max(0, Math.abs(p.x) - (shape.size[0] / 2 - shape.radius));
            const qy = Math.max(0, Math.abs(p.y) - (shape.size[1] / 2 - shape.radius));
            const qz = Math.max(0, Math.abs(p.z) - (shape.size[2] / 2 - shape.radius));
            inside = Math.hypot(qx, qy, qz) <= shape.radius;
          }
          if (inside) {
            count++;
            break;
          }
        }
      }
    }
  }
  return count * step * step * step;
}

describe("animal models", () => {
  for (const detail of ["hi", "mid"] as const) {
    for (const character of CHARACTER_IDS) {
      it(`${character} (${detail}) meets the mesh / draw-call / triangle / shadow budget`, () => {
        const { model } = build(character, detail);
        const b = measureBudget(model.root);
        const budget = BUDGET[detail];
        expect(b.triangles).toBeLessThanOrEqual(budget.tris);
        expect(b.triangles + b.outlineTriangles).toBeLessThanOrEqual(budget.trisWithOutline);
        expect(b.meshes).toBeLessThanOrEqual(budget.meshes);
        expect(b.drawCalls).toBeLessThanOrEqual(budget.calls);
        expect(b.casters).toBeLessThanOrEqual(budget.casters);
      });
    }
  }

  for (const character of CHARACTER_IDS) {
    it(`${character}: core inside the hitbox capsule, flair within limits, top ≤ topY`, () => {
      const { model, prims } = build(character, "hi");
      let maxY = 0;
      for (const { pivot, prim } of prims) {
        if (isUnder(pivot, "ghostTail")) continue;
        const pos = primPositions(prim);
        const limb = ["armR", "armL", "legR", "legL"].some((n) => isUnder(pivot, n));
        const limit = prim.flair ? FLAIR_MAX : limb ? LIMB_TOLERANCE : TOLERANCE;
        let worst = -Infinity;
        for (let i = 0; i < pos.length; i += 3) {
          worst = Math.max(worst, capsuleExcess(pos[i], pos[i + 1], pos[i + 2]));
          maxY = Math.max(maxY, pos[i + 1]);
        }
        expect(worst, `${pivot.name} primitive (${prim.flair ? "flair" : "core"})`).toBeLessThanOrEqual(limit);
      }
      expect(maxY).toBeLessThanOrEqual(model.spec.topY + 0.02);
      expect(model.spec.topY).toBeLessThanOrEqual(TOP_LIMIT);
    });

    it(`${character}: spring bones are unique, parents first, at identity rest pose`, () => {
      const { model } = build(character, "hi");
      const names = new Set<string>();
      model.springs.forEach((bone, i) => {
        expect(names.has(bone.name)).toBe(false);
        names.add(bone.name);
        expect(bone.name).toBe(bone.pivot.name);
        expect(bone.parent).toBeLessThan(i);
        expect(bone.pivot.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
        expect(bone.pivot.scale.x).toBe(1);
        expect(bone.pivot.scale.y).toBe(1);
        expect(bone.pivot.scale.z).toBe(1);
        expect(Math.hypot(...bone.tip)).toBeGreaterThan(0.01);
        if (bone.parent >= 0) {
          let ancestor = false;
          for (let o = bone.pivot.parent; o; o = o.parent) if (o === model.springs[bone.parent].pivot) ancestor = true;
          expect(ancestor).toBe(true);
        }
      });
      expect(model.springs.length).toBeLessThanOrEqual(14);
      for (const o of [...model.extras.cheeks, ...model.extras.eyeBulbs, ...model.extras.tail, ...model.extras.ears]) {
        expect(o.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
      }
    });

    it(`${character}: hand anchor sits just below the palm`, () => {
      const { model } = build(character, "hi");
      model.root.updateMatrixWorld(true);
      const hand = model.skeleton.hand.getWorldPosition(new THREE.Vector3());
      const arm = model.spec.arm;
      const handCenter = new THREE.Vector3(arm.shoulder[0] - (arm.reach?.[0] ?? 0), arm.shoulder[1] - arm.length, arm.shoulder[2] + (arm.reach?.[1] ?? 0));
      expect(hand.distanceTo(handCenter)).toBeLessThan(0.25);
      expect(hand.y).toBeLessThan(handCenter.y);
    });

    it(`${character}: KO memento builds as one batched mesh`, () => {
      const materials = new AnimalMaterials(CHARACTERS[character].colors, "#3B82F6");
      const memento = buildMemento(character, new PartBuilder(materials, { cacheKey: `test-memento:${character}` }));
      const b = measureBudget(memento);
      // One merged mesh per pivot (Mochi's nightcap keeps its cap / tip / pompom chain).
      expect(b.meshes).toBeLessThanOrEqual(3);
      expect(b.drawCalls).toBeLessThanOrEqual(6);
    });
  }

  it("core masses are similar in volume (equal visual hittability)", () => {
    const volumes = CHARACTER_IDS.map((c) => coreVolume(build(c, "hi").prims));
    const mean = volumes.reduce((a, v) => a + v, 0) / volumes.length;
    console.log("core volumes", CHARACTER_IDS.map((c, i) => `${c} ${volumes[i].toFixed(4)} (${((volumes[i] / mean - 1) * 100).toFixed(1)}%)`).join(", "));
    for (const v of volumes) expect(Math.abs(v / mean - 1)).toBeLessThanOrEqual(0.06);
  });
});
