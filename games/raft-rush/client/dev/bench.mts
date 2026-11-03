// Repeatable draw-call / triangle benchmark for Raft Rush. No GPU needed: it builds the real scene classes
// (island at high, sky, fx, five Ship Tourists + nameplates + blob shadows) exactly as the client does, then
// counts the objects each WebGLRenderer pass would submit.
//
//   npx tsx games/raft-rush/client/dev/bench.mts            # before/after table
//   npx tsx games/raft-rush/client/dev/bench.mts --json     # machine-readable metrics
//
// "before" reproduces the old path (one mesh per animated bone + terrain chunks casting shadows),
// "after" uses CharacterBatcher and the reduced shadow settings. Frame ms is a model, not a GPU capture:
// 5.0 ms fixed 1080p fragment/post cost + 0.045 ms per draw/state change + 0.00002 ms per triangle.
// That model is only for comparing the two scenes on the same reference budget; the draw and triangle
// numbers are measured from the actual three.js objects.

import * as THREE from "three";

const noopCtx = new Proxy({}, {
  get(_t, k) {
    if (k === "canvas") return fake;
    if (k === "createLinearGradient" || k === "createRadialGradient" || k === "createPattern") return () => ({ addColorStop() {} });
    if (k === "getImageData") return (_x: number, _y: number, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
    if (k === "measureText") return () => ({ width: 10 });
    return () => undefined;
  },
  set() { return true; },
});
const fake: any = { width: 1, height: 1, style: {}, getContext: () => noopCtx, toDataURL: () => "" };
(globalThis as any).document = {
  createElement: (tag: string) => (tag === "canvas" ? { width: 1, height: 1, style: {}, getContext: () => noopCtx, toDataURL: () => "" } : fake),
  createElementNS: () => fake,
  body: { appendChild() {} },
};
(globalThis as any).window = { devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080, addEventListener() {}, removeEventListener() {} };

const { generateIsland } = await import("../../shared/island/generate");
const { heightAt } = await import("../../shared/island/heightfield");
const { CHARACTERS } = await import("../../shared/constants");
const { IslandView } = await import("../src/render/island/IslandView");
const { Sky } = await import("../src/render/sky/Sky");
const { Fx } = await import("../src/fx/Fx");
const { Avatar } = await import("../src/characters/Avatar");
const { Characters } = await import("../src/characters/Characters");
type PlayerFrame = import("../src/net/types").PlayerFrame;
type CharacterId = import("../../shared/types").CharacterId;

interface Metrics {
  mode: string;
  mainDraws: number;
  mainTris: number;
  shadowDraws: number;
  shadowTris: number;
  draws: number;
  tris: number;
  frameMs: number;
  /** Main-pass draws if WEBGL_multi_draw is missing (three loops each batched range). */
  fallbackDraws: number;
  batchedMeshes: number;
}

/** Triangle count a mesh contributes on one draw (BatchedMesh: only its visible instances). */
function trianglesOf(o: any): number {
  if (o.isBatchedMesh) {
    let tris = 0;
    const infos = o._instanceInfo as Array<{ active: boolean; visible: boolean; geometryIndex: number }> | undefined;
    const geos = o._geometryInfo as Array<{ count: number }> | undefined;
    if (infos && geos) {
      for (const info of infos) if (info.active && info.visible) tris += (geos[info.geometryIndex]?.count ?? 0) / 3;
    } else {
      for (const g of geos ?? []) tris += g.count / 3;
    }
    return tris;
  }
  const geometry = o.geometry as THREE.BufferGeometry | undefined;
  const pos = geometry?.getAttribute("position");
  if (!pos) return 0;
  const verts = geometry!.index ? geometry!.index!.count : pos.count;
  const instances = o.isInstancedMesh ? (o.count as number) : 1;
  return (verts / 3) * instances;
}

function count(scene: THREE.Scene, camera: THREE.PerspectiveCamera): Omit<Metrics, "mode" | "frameMs"> {
  scene.updateMatrixWorld(true);
  let mainDraws = 0, mainTris = 0, shadowDraws = 0, shadowTris = 0;
  let batchedMeshes: any[] = [];
  scene.traverseVisible((o: any) => {
    if (!o.isMesh && !o.isPoints && !o.isLine && !o.isSprite) return;
    if (!o.layers.test(camera.layers)) return; // parked source meshes (after) stay out of both passes
    const tris = trianglesOf(o);
    mainDraws++;
    mainTris += tris;
    if (o.isBatchedMesh) batchedMeshes.push(o);
    if (o.isMesh && o.castShadow) {
      shadowDraws++;
      shadowTris += tris;
    }
  });
  // WEBGL_multi_draw is present on every WebGL2 browser in practice; when it is missing three.js r186
  // loops the batched mesh's draw ranges one call at a time. Reproduce that range count exactly.
  let batchFallback = 0;
  for (const m of batchedMeshes) {
    m.onBeforeRender(null, scene, camera, m.geometry, m.material);
    batchFallback += (m._multiDrawCount as number) ?? 0;
  }
  const fallbackDraws = mainDraws - batchedMeshes.length + batchFallback;
  return { mainDraws, mainTris, shadowDraws, shadowTris, draws: mainDraws + shadowDraws, tris: mainTris + shadowTris, fallbackDraws, batchedMeshes: batchedMeshes.length };
}

function makeFrame(i: number, character: CharacterId, x: number, z: number, y: number): PlayerFrame {
  return {
    id: `p${i}`, isLocal: i === 0, character, seat: i, team: 0,
    nickname: `Player ${i + 1}`, bot: i > 0, connected: true, spectator: false, washed: false,
    cnt0: 0, cnt1: 0, cnt2: 0, cnt3: 0, fishState: 0, fishSpot: -1, fuseTicks: 0, torchTicks: 0,
    cosmetic: "", golden: false, speed: 0,
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: i * 0.7, pitch: 0,
    grounded: true, airTicks: 0, stunTicks: 0, chargeTicks: 0, throwTicks: 0, catchTicks: 0, catchCooldown: 0,
    channel: 0, channelTicks: 0, channelTarget: -1, swimming: false, swimTicks: 0, sprinting: false,
    inv0: "", inv1: "", inv2: "", inv3: "", hp: 100, hunger: 1, thirst: 1, warmth: 1,
    alive: true, downed: false, boarded: false, activeSlot: 0,
  } as unknown as PlayerFrame;
}

function buildScene(layout: "solo" | "duel", batchedTerrain: boolean): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; island: IslandView; frames: PlayerFrame[] } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1920 / 1080, 0.05, 400);
  camera.position.set(8, 3.4, 8);
  scene.add(camera);
  const def = generateIsland(4471, layout);
  const island = new IslandView(def, "high", { batchedTerrain });
  scene.add(island.group);
  scene.add(new Sky("high").object);
  new Fx(scene);

  const all: CharacterId[] = ["kaptan", "fenomen", "amca", "gelin", "sef", "cocuk"];
  const ids = layout === "duel" ? all : all.slice(0, 5);
  const site = def.sites[0]!;
  const frames = ids.map((character, i) => {
    const a = (i / ids.length) * Math.PI * 2;
    const x = site.campfire.x + Math.cos(a) * 2.4;
    const z = site.campfire.z + Math.sin(a) * 2.4;
    return makeFrame(i, character, x, z, heightAt(def.grid, x, z));
  });
  return { scene, camera, island, frames };
}

function run(mode: "before" | "after", layout: "solo" | "duel"): Metrics {
  const { scene, camera, island, frames } = buildScene(layout, mode === "after");
  if (mode === "before") {
    // Old behaviour: raw Tourist meshes, and the terrain chunks joined the shadow pass too.
    for (const f of frames) {
      const avatar = new Avatar(scene, f);
      avatar.sync(f, { hidden: false, dark: 0, camera: camera.position, revive: -1 }, 1 / 60);
    }
    (island as any).terrain.group.children.forEach((c: any) => (c.castShadow = true));
    // The old build had every flora- archetype in the one shadow-casting batch.
    island.group.traverse((o: any) => { if (o.isBatchedMesh && o.name.startsWith("flora")) o.castShadow = true; });
    // The old build also let the small raft props cast; restored here so "before" is the real baseline.
    island.group.traverse((o: any) => { if (o.name === "raftCrates" || o.name === "raftGourds" || o.name === "raftSlip") o.castShadow = true; });
  } else {
    const characters = new Characters(scene, camera);
    const opts = { localId: "p0", firstPerson: false, dark: 0 };
    characters.sync(frames, opts, 1 / 60);
    characters.sync(frames, opts, 1 / 60); // second frame: animators settled, batching flushed
  }
  const measured = count(scene, camera);
  const frameMs = 5.0 + measured.draws * 0.045 + measured.tris * 0.00002;
  return { mode, ...measured, frameMs };
}

const layout = process.argv.includes("--duel") ? "duel" : "solo";
const before = run("before", layout);
const after = run("after", layout);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ layout, before, after }, null, 2));
} else {
  const row = (m: Metrics): string =>
    `| ${m.mode} | ${m.mainDraws} | ${m.shadowDraws} | ${m.draws} | ${Math.round(m.mainTris / 1000)}k | ${Math.round(m.shadowTris / 1000)}k | ${Math.round(m.tris / 1000)}k | ~${m.frameMs.toFixed(1)} ms |`;
  console.log(`Raft Rush — ${layout} island, high, ${layout === "duel" ? 6 : 5} tourists, 1080p`);
  console.log("");
  console.log("| scene | main draws | shadow draws | total draws | main tris | shadow tris | total tris | frame ms* |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  console.log(row(before));
  console.log(row(after));
  console.log("");
  console.log(`* modeled: 5.0 ms fixed 1080p cost + 0.045 ms/draw + 0.00002 ms/triangle. Not a GPU capture.`);
  console.log(`WEBGL_multi_draw fallback: main pass ${after.mainDraws} -> ${after.fallbackDraws} draws (${after.batchedMeshes} batched meshes, one call per frustum-visible range), total ${after.fallbackDraws + after.shadowDraws}.`);
  console.log(`delta: ${before.draws - after.draws} fewer draws, ${Math.round((before.tris - after.tris) / 1000)}k fewer triangles, ~${(before.frameMs - after.frameMs).toFixed(1)} ms less.`);
}
