// Per-object draw breakdown for the raft-rush after-scene (dev only). No GPU.
// npx tsx games/raft-rush/client/dev/breakdown.mts [--duel]
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
const { Characters } = await import("../src/characters/Characters");

function trisOf(o: any): number {
  if (o.isBatchedMesh) {
    let t = 0;
    const infos = o._instanceInfo as Array<{ active: boolean; visible: boolean; geometryIndex: number }> | undefined;
    const geos = o._geometryInfo as Array<{ count: number }> | undefined;
    if (infos && geos) for (const i of infos) if (i.active && i.visible) t += (geos[i.geometryIndex]?.count ?? 0) / 3;
    return t;
  }
  const g = o.geometry as THREE.BufferGeometry | undefined;
  const p = g?.getAttribute("position");
  if (!p) return 0;
  return ((g!.index ? g!.index!.count : p.count) / 3) * (o.isInstancedMesh ? o.count : 1);
}

const layout = process.argv.includes("--duel") ? "duel" : "solo";
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1920 / 1080, 0.05, 400);
camera.position.set(8, 3.4, 8);
scene.add(camera);
const def = generateIsland(4471, layout);
const island = new IslandView(def, "high", { batchedTerrain: true });
scene.add(island.group);
scene.add(new Sky("high").object);
new Fx(scene);

const ids = (layout === "duel"
  ? ["kaptan", "fenomen", "amca", "gelin", "sef", "cocuk"]
  : ["kaptan", "fenomen", "amca", "gelin", "sef"]) as any[];
const site = def.sites[0]!;
const frames = ids.map((character, i) => {
  const a = (i / ids.length) * Math.PI * 2;
  const x = site.campfire.x + Math.cos(a) * 2.4;
  const z = site.campfire.z + Math.sin(a) * 2.4;
  return {
    id: `p${i}`, isLocal: i === 0, character, seat: i, team: 0,
    nickname: `Player ${i + 1}`, bot: i > 0, connected: true, spectator: false, washed: false,
    cnt0: 0, cnt1: 0, cnt2: 0, cnt3: 0, fishState: 0, fishSpot: -1, fuseTicks: 0, torchTicks: 0,
    cosmetic: "", golden: false, speed: 0,
    x, y: heightAt(def.grid, x, z), z, vx: 0, vy: 0, vz: 0, yaw: i * 0.7, pitch: 0,
    grounded: true, airTicks: 0, stunTicks: 0, chargeTicks: 0, throwTicks: 0, catchTicks: 0, catchCooldown: 0,
    channel: 0, channelTicks: 0, channelTarget: -1, swimming: false, swimTicks: 0, sprinting: false,
    inv0: "", inv1: "", inv2: "", inv3: "", hp: 100, hunger: 1, thirst: 1, warmth: 1,
    alive: true, downed: false, boarded: false, activeSlot: 0,
  } as any;
});
const characters = new Characters(scene, camera);
const opts = { localId: "p0", firstPerson: false, dark: 0 };
characters.sync(frames, opts, 1 / 60);
characters.sync(frames, opts, 1 / 60);

scene.updateMatrixWorld(true);
const rows = new Map<string, { d: number; t: number; shadow: number }>();
let main = 0;
scene.traverseVisible((o: any) => {
  if (!o.isMesh && !o.isPoints && !o.isLine && !o.isSprite) return;
  if (!o.layers.test(camera.layers)) return;
  main++;
  // group key: nearest named ancestor under the scene
  let top: any = o;
  while (top.parent && top.parent !== scene) top = top.parent;
  const key = `${top.name||"?"} > ${o.name || o.type}`;
  const e = rows.get(key) ?? { d: 0, t: 0, shadow: 0 };
  e.d++;
  e.t += trisOf(o);
  if (o.castShadow) e.shadow++;
  rows.set(key, e);
});
console.log(`layout=${layout} main draws=${main}`);
for (const [k, v] of [...rows.entries()].sort((a, b) => b[1].d - a[1].d)) {
  console.log(`  ${String(v.d).padStart(3)} draws  ${String(Math.round(v.t)).padStart(7)} tris  ${v.shadow} shadow  ${k}`);
}
