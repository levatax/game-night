// Readability of the first-person holds, on the real rig: for every item kind at 4:3, 16:10 and 21:9, settle the
// arms at rest and project the held item's mesh to the screen. One-handed items keep clear of the crosshair, palm
// items sit low, two-handed bundles stay in the bottom of the view, the hands stay on screen, nothing is NaN, and
// the framing does not move with the camera FOV (the viewmodel keeps its own 75°).

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ITEM_KINDS } from "../../../shared/items";
import type { ItemKind } from "../../../shared/types";
import type { FpArmsFrame } from "./Characters";
import { FpArmsRig } from "./fpArms";
import { fpHold } from "./fpHolds";

function frame(held: ItemKind | ""): FpArmsFrame {
  return {
    character: "kaptan",
    held,
    count: held === "" ? 0 : 1,
    charge: 0,
    channel: -1,
    channelKind: 0,
    speed: 0,
    grounded: true,
    sprinting: false,
    swimming: false,
    downed: false,
    fishState: 0,
    torchLit: true,
    fuse: -1,
    yaw: 0,
    pitch: 0,
  };
}

const _v = new THREE.Vector3();

/** Screen box (NDC) of an object's meshes, and the distance of its nearest vertex from the crosshair. */
function screenBox(root: THREE.Object3D, camera: THREE.PerspectiveCamera): { minR: number; top: number; bottom: number; nan: boolean } {
  let minR = Infinity;
  let top = -Infinity;
  let bottom = Infinity;
  let nan = false;
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    // (The depth-clear quad sits at the eye itself: it never projects.)
    if (!m.isMesh || o.userData.isOutline || o.name === "fpDepthClear") return;
    const pos = m.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).project(camera);
      if (!Number.isFinite(_v.x) || !Number.isFinite(_v.y)) nan = true;
      minR = Math.min(minR, Math.hypot(_v.x, _v.y));
      top = Math.max(top, _v.y);
      bottom = Math.min(bottom, _v.y);
    }
  });
  return { minR, top, bottom, nan };
}

/** A rig settled at rest holding `kind`, seen through a camera of `aspect` / `fov`. */
function settled(kind: ItemKind | "", aspect: number, fov = 75): { rig: FpArmsRig; camera: THREE.PerspectiveCamera } {
  const camera = new THREE.PerspectiveCamera(fov, aspect, 0.05, 500);
  const rig = new FpArmsRig();
  const f = frame(kind);
  for (let i = 0; i < 150; i++) rig.update(1 / 60, camera, f);
  camera.updateMatrixWorld(true);
  return { rig, camera };
}

const ASPECTS = [4 / 3, 16 / 10, 21 / 9] as const;

describe("first-person holds read at rest", () => {
  for (const kind of ITEM_KINDS) {
    const hold = fpHold(kind);
    it(`${kind} (${hold.style})`, () => {
      for (const aspect of ASPECTS) {
        const { rig, camera } = settled(kind, aspect);
        const held = rig.root.getObjectByName(`fpHeld:${kind}`);
        expect(held, "held object").toBeTruthy();
        expect(held!.visible).toBe(true);
        const box = screenBox(held!, camera);
        expect(box.nan, "finite").toBe(false);
        if (hold.style === "big") {
          // A bundle in the bottom of the view.
          expect(box.top, `${kind} top @${aspect.toFixed(2)}`).toBeLessThan(-0.35);
        } else {
          // Clear of the crosshair, and visible.
          expect(box.minR, `${kind} crosshair clearance @${aspect.toFixed(2)}`).toBeGreaterThan(aspect > 2 ? 0.18 : 0.22);
          expect(box.top, `${kind} on screen @${aspect.toFixed(2)}`).toBeGreaterThan(-1);
          if (hold.style === "cup" || hold.style === "tray") expect(box.top, `${kind} sits low @${aspect.toFixed(2)}`).toBeLessThan(-0.1);
        }
        // Both hands on screen.
        for (const name of ["fpHand"]) {
          rig.root.traverse((o) => {
            if (o.name !== name || !o.visible) return;
            o.getWorldPosition(_v).project(camera);
            expect(Number.isFinite(_v.x) && Number.isFinite(_v.y)).toBe(true);
          });
        }
      }
    });
  }

  it("keeps its framing whatever the camera FOV", () => {
    for (const kind of ["spear", "coconut", "raft_part"] as const) {
      const a = settled(kind, 1.6, 75);
      const b = settled(kind, 1.6, 100);
      const boxA = screenBox(a.rig.root.getObjectByName(`fpHeld:${kind}`)!, a.camera);
      const boxB = screenBox(b.rig.root.getObjectByName(`fpHeld:${kind}`)!, b.camera);
      expect(Math.abs(boxA.top - boxB.top)).toBeLessThan(0.02);
      expect(Math.abs(boxA.minR - boxB.minR)).toBeLessThan(0.02);
    }
  });

  it("swaps items through a holster without leaving the hand empty", () => {
    const camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 500);
    const rig = new FpArmsRig();
    for (let i = 0; i < 60; i++) rig.update(1 / 60, camera, frame("spear"));
    // Switching to the axe: the spear goes down first, then the axe comes up.
    rig.update(1 / 60, camera, frame("axe"));
    expect(rig.root.getObjectByName("fpHeld:spear")?.visible).toBe(true);
    for (let i = 0; i < 60; i++) rig.update(1 / 60, camera, frame("axe"));
    expect(rig.root.getObjectByName("fpHeld:axe")?.visible).toBe(true);
    expect(rig.root.getObjectByName("fpHeld:spear")?.visible).toBe(false);
  });

  it("plays every gesture with every hold without NaNs", () => {
    const gestures = ["throw", "toss", "use", "eat", "gather", "catch", "cast", "reel", "swing", "hurt", "place", "deliver"] as const;
    const camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 500);
    for (const kind of ["", ...ITEM_KINDS] as const) {
      const rig = new FpArmsRig();
      const f = frame(kind);
      for (let i = 0; i < 40; i++) rig.update(1 / 60, camera, f);
      for (const g of gestures) {
        rig.play(g);
        for (let i = 0; i < 20; i++) rig.update(1 / 60, camera, f);
      }
      camera.updateMatrixWorld(true);
      const box = screenBox(rig.root, camera);
      expect(box.nan, `${kind || "empty"} finite`).toBe(false);
    }
  });

  it("throwing the last unit empties the hand at once; one of a stack comes back up", () => {
    const camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 500);
    const rig = new FpArmsRig();
    const stone = rig.root.getObjectByName.bind(rig.root);
    for (let i = 0; i < 60; i++) rig.update(1 / 60, camera, frame("stone"));
    // One of two: hidden while released, visible again after the clip (a reload rise).
    rig.play("throw");
    for (let i = 0; i < 6; i++) rig.update(1 / 60, camera, frame("stone"));
    expect(stone("fpHeld:stone")?.visible).toBe(false);
    for (let i = 0; i < 60; i++) rig.update(1 / 60, camera, frame("stone"));
    expect(stone("fpHeld:stone")?.visible).toBe(true);
    // The last one: the slot empties the same frame; no holster dip with a ghost stone.
    rig.play("throw");
    rig.update(1 / 60, camera, frame(""));
    expect(stone("fpHeld:stone")?.visible).toBe(false);
    for (let i = 0; i < 60; i++) rig.update(1 / 60, camera, frame(""));
    expect(stone("fpHeld:stone")?.visible).toBe(false);
  });

  it("eating shows the food in the hand, F with something inedible keeps it", () => {
    const camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 500);
    const rig = new FpArmsRig();
    const find = (n: string): THREE.Object3D[] => {
      const out: THREE.Object3D[] = [];
      rig.root.traverse((o) => o.name === n && out.push(o));
      return out;
    };
    for (let i = 0; i < 60; i++) rig.update(1 / 60, camera, frame("crab_cooked"));
    rig.play("eat");
    for (let i = 0; i < 12; i++) rig.update(1 / 60, camera, frame("crab_cooked"));
    // The held crab is hidden and the food copy (a second object of the same kind) is in the hand.
    const crabs = find("fpHeld:crab_cooked");
    expect(crabs.filter((o) => o.visible).length).toBe(1);
    for (let i = 0; i < 90; i++) rig.update(1 / 60, camera, frame("crab_cooked"));
    expect(crabs.filter((o) => o.visible).length).toBe(1);
    // A spear can't be eaten: it stays in the hand the whole time.
    for (let i = 0; i < 60; i++) rig.update(1 / 60, camera, frame("spear"));
    rig.play("eat");
    for (let i = 0; i < 40; i++) {
      rig.update(1 / 60, camera, frame("spear"));
      expect(rig.root.getObjectByName("fpHeld:spear")?.visible).toBe(true);
    }
  });

  it("a caught item lands straight in the hands", () => {
    const camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 500);
    const rig = new FpArmsRig();
    for (let i = 0; i < 60; i++) rig.update(1 / 60, camera, frame(""));
    rig.play("catch");
    for (let i = 0; i < 10; i++) rig.update(1 / 60, camera, frame(""));
    rig.update(1 / 60, camera, frame("coconut"));
    expect(rig.root.getObjectByName("fpHeld:coconut")?.visible).toBe(true);
  });

  describe("review regressions", () => {
    const camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 500);
    const held = (rig: FpArmsRig, kind: string): THREE.Object3D | undefined => rig.root.getObjectByName(`fpHeld:${kind}`);
    const at = (kind: ItemKind | "", count: number): FpArmsFrame => ({ ...frame(kind), count });

    it("keeps the last fence in the hands until the place clip lets go", () => {
      const rig = new FpArmsRig();
      for (let i = 0; i < 60; i++) rig.update(1 / 60, camera, at("fence", 1));
      rig.play("place");
      for (let i = 0; i < 4; i++) rig.update(1 / 60, camera, at("fence", 1));
      // The server takes it off the slot at ~70 ms; it stays in the hands until the release at 0.3 s.
      for (let i = 0; i < 8; i++) rig.update(1 / 60, camera, at("", 0));
      expect(held(rig, "fence")?.visible).toBe(true);
      for (let i = 0; i < 20; i++) rig.update(1 / 60, camera, at("", 0));
      expect(held(rig, "fence")?.visible).toBe(false);
    });

    it("does not bring a thrown last stone back when the server answers late", () => {
      const rig = new FpArmsRig();
      for (let i = 0; i < 60; i++) rig.update(1 / 60, camera, at("stone", 1));
      rig.play("throw");
      // 0.5 s until the empty slot arrives: the stone must stay out of the hand the whole time.
      for (let i = 0; i < 30; i++) {
        rig.update(1 / 60, camera, at("stone", 1));
        expect(held(rig, "stone")?.visible).toBe(false);
      }
      for (let i = 0; i < 30; i++) {
        rig.update(1 / 60, camera, at("", 0));
        expect(held(rig, "stone")?.visible).toBe(false);
      }
    });

    it("claps onto a catch that went to another slot", () => {
      const rig = new FpArmsRig();
      for (let i = 0; i < 60; i++) rig.update(1 / 60, camera, at("coconut", 1));
      rig.play("catch");
      for (let i = 0; i < 8; i++) rig.update(1 / 60, camera, at("coconut", 1));
      rig.caught();
      rig.update(1 / 60, camera, at("coconut", 1));
      expect((rig as unknown as { run: { name: string } | null }).run?.name).toBe("caught");
    });

    it("holds a hit-stop for a fixed short time (the clip keeps its length)", () => {
      const rig = new FpArmsRig();
      for (let i = 0; i < 60; i++) rig.update(1 / 60, camera, at("", 0));
      rig.play("use");
      let frames = 0;
      while ((rig as unknown as { run: unknown }).run && frames < 200) {
        rig.update(1 / 60, camera, at("", 0));
        frames++;
      }
      // The jab is authored at 0.40 s, inside the 0.4 s use cooldown.
      expect(frames / 60).toBeLessThan(0.45);
    });

    it("keeps a tool in hand while delivering other things from the pockets", () => {
      const rig = new FpArmsRig();
      for (let i = 0; i < 60; i++) rig.update(1 / 60, camera, at("axe", 1));
      rig.play("deliver", ["wood"]);
      for (let i = 0; i < 50; i++) {
        rig.update(1 / 60, camera, at("axe", 1));
        expect(held(rig, "axe")?.visible).toBe(true);
      }
    });

    it("keeps both hands on a carried bundle through a one-handed gesture", () => {
      const rig = new FpArmsRig();
      for (let i = 0; i < 90; i++) rig.update(1 / 60, camera, at("raft_part", 1));
      const arms = (rig as unknown as { arms: { cur: THREE.Vector3 }[] }).arms;
      const rest = arms[0]!.cur.distanceTo(arms[1]!.cur);
      rig.play("eat");
      let worst = 0;
      for (let i = 0; i < 40; i++) {
        rig.update(1 / 60, camera, at("raft_part", 1));
        worst = Math.max(worst, Math.abs(arms[0]!.cur.distanceTo(arms[1]!.cur) - rest));
      }
      expect(worst).toBeLessThan(0.01);
    });
  });
});

