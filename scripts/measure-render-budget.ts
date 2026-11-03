// Render-budget readout for Raft Rush (owner: devops): builds the real island scene headlessly (no GPU, so no
// FPS) and counts what it would submit: draw objects and triangles, solo and duel, at the "high" quality the
// default settings pick. Characters are counted separately (one draw per visible mesh per tourist).
//
//   npx tsx scripts/measure-render-budget.ts
//
// Budget (Technical Artist): ≤ 50 draw calls and ≤ 138k triangles for the island scene.

import * as THREE from "three";

const noopCtx: any = new Proxy(
  {},
  {
    get(_t, k) {
      if (k === "canvas") return fake;
      if (k === "createLinearGradient" || k === "createRadialGradient" || k === "createPattern") return () => ({ addColorStop() {} });
      if (k === "getImageData") return (x: number, y: number, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (k === "measureText") return () => ({ width: 10 });
      return () => undefined;
    },
    set() {
      return true;
    },
  },
);
const fake: any = { width: 1, height: 1, style: {}, getContext: () => noopCtx, toDataURL: () => "" };
(globalThis as any).document = { createElement: () => fake, createElementNS: () => fake, body: { appendChild() {} } };
(globalThis as any).window = { devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080, addEventListener() {}, removeEventListener() {} };

const { generateIsland } = await import("../games/raft-rush/shared/island/generate.js");
const { IslandView } = await import("../games/raft-rush/client/src/render/island/IslandView.js");

interface Count {
  draws: number;
  tris: number;
}

function count(root: THREE.Object3D): Count {
  const out: Count = { draws: 0, tris: 0 };
  root.updateMatrixWorld(true);
  root.traverseVisible((o: any) => {
    if (!o.isMesh && !o.isPoints) return;
    const g = o.geometry as THREE.BufferGeometry | undefined;
    if (!g) return;
    out.draws++;
    const per = g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
    out.tris += per * (o.isInstancedMesh ? o.count : 1);
  });
  return out;
}

for (const layout of ["solo", "duel"] as const) {
  const def = generateIsland(4471, layout);
  const view = new IslandView(def, "high");
  const c = count(view.group);
  console.log(
    `${layout}: ${c.draws} draw objects, ${Math.round(c.tris)} triangles (cached static count ${view.triangles}); ` +
      `budget ${c.draws <= 50 && c.tris <= 138_000 ? "OK" : "OVER"} (≤50 draws / ≤138k tris)`,
  );
}
