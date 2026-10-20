// Props for the cast, built once and shared where possible (merged static geometry, cached materials):
// casino chair, tails, raid gear (cuffs, sack, wallet, mugshot board + number plate, box camera), flag
// props (iron collar + ball and chain, nazar bead, briefcase), emote props (cigar, lighter, bill wad,
// handkerchief, buckets of tears), podium money piles, the cement-shoes pier, moss / fish for the wet
// ghost, dizzy stars and the targeting ring + arrow. Owner: client-characters.

import * as THREE from "three";
import { PALETTE, type Animal } from "../../../../shared/constants";
import { addOutlines, canvasTexture } from "../toon";
import { FONT, G, glowTexture, mat, mergeParts, mergeStatic, mesh, noOutline, optimizeShadows, trs } from "./kit";

const WOOD = PALETTE.wood;
const WOOD_DARK = PALETTE.woodDark;
const VELVET = "#8E1F2F";
const IRON = "#5C6170";

// ------------------------------------------------------------------- chair
let chairGeo: { wood: THREE.BufferGeometry; velvet: THREE.BufferGeometry } | null = null;

/** Casino chair (seat top ≈ 0.43 m), backrest toward −z. */
export function buildChair(): THREE.Group {
  const g = G();
  if (!chairGeo) {
    const wood: { g: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) wood.push({ g: g.cylLo, m: trs(sx * 0.19, 0.18, sz * 0.17, sz * 0.06, 0, -sx * 0.05, 0.024, 0.36, 0.024) });
      wood.push({ g: g.cylLo, m: trs(sx * 0.18, 0.68, -0.22, -0.12, 0, 0, 0.022, 0.6, 0.022) });
    }
    wood.push({ g: g.cyl, m: trs(0, 0.36, 0, 0, 0, 0, 0.25, 0.04, 0.23) });
    wood.push({ g: g.rbox, m: trs(0, 0.95, -0.26, -0.12, 0, 0, 0.46, 0.06, 0.06) });
    const velvet: { g: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [
      { g: g.cyl, m: trs(0, 0.4, 0, 0, 0, 0, 0.225, 0.06, 0.21) },
      { g: g.rbox, m: trs(0, 0.7, -0.245, -0.12, 0, 0, 0.36, 0.42, 0.06) },
    ];
    chairGeo = { wood: mergeParts(wood), velvet: mergeParts(velvet) };
  }
  const chair = new THREE.Group();
  const w = new THREE.Mesh(chairGeo.wood, mat(WOOD_DARK));
  const v = new THREE.Mesh(chairGeo.velvet, mat(VELVET));
  w.castShadow = v.castShadow = true;
  w.receiveShadow = v.receiveShadow = true;
  chair.add(w, v);
  addOutlines(chair, 1.03);
  return chair;
}

// -------------------------------------------------------------------- tails
const tailCache = new Map<Animal, THREE.BufferGeometry | null>();

function tube(points: [number, number, number][], r: number, seg = 24): THREE.TubeGeometry {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))), seg, r, 7, false);
}

/** Animal tail mounted on the pelvis back (null for the frog). */
export function buildTail(animal: Animal, fur: string): THREE.Group | null {
  const g = G();
  if (animal === "kurbaga") return null;
  const grp = new THREE.Group();
  if (animal === "tavsan") {
    grp.add(mesh(g.sphere, mat("#FFFFFF"), 0, 0, -0.04, 0.07));
  } else if (animal === "kopek") {
    const stub = mesh(g.capsule, mat(fur), 0, 0.06, -0.06, 0.04, 0.12, 0.04);
    stub.rotation.x = -0.7;
    grp.add(stub);
  } else {
    if (!tailCache.has(animal)) {
      let geo: THREE.BufferGeometry | null = null;
      if (animal === "kedi") geo = tube([[0, 0, 0], [0, -0.05, -0.15], [0, 0.05, -0.3], [0.04, 0.3, -0.36], [0.12, 0.48, -0.3], [0.16, 0.55, -0.2]], 0.032);
      else if (animal === "fare") geo = tube([[0, 0, 0], [0, -0.1, -0.12], [0.02, -0.35, -0.22], [0.1, -0.46, -0.4], [0.3, -0.48, -0.5], [0.45, -0.47, -0.42]], 0.012);
      else if (animal === "domuz") {
        const pts: [number, number, number][] = [];
        for (let i = 0; i <= 16; i++) {
          const a = (i / 16) * Math.PI * 4;
          pts.push([Math.cos(a) * 0.035 - 0.035, Math.sin(a) * 0.035, -i * 0.007]);
        }
        geo = tube(pts, 0.012, 40);
      }
      tailCache.set(animal, geo);
    }
    const geo = tailCache.get(animal);
    if (geo) grp.add(new THREE.Mesh(geo, mat(animal === "fare" ? "#F4B6C2" : animal === "domuz" ? "#F08AA0" : fur)));
    if (animal === "kedi") grp.add(mesh(g.sphere, mat("#3A2A22"), 0.16, 0.56, -0.2, 0.038));
  }
  addOutlines(grp, 1.06);
  return grp;
}

// --------------------------------------------------------------- raid gear
/** One handcuff ring (attach at the wrist). */
export function buildCuff(): THREE.Mesh {
  const m = mesh(G().torusFat, mat("#AEB4C2"), 0, 0.0, 0, 0.065, 0.065, 0.065);
  m.rotation.x = Math.PI / 2;
  return m;
}

/** A thin cylinder that can be stretched between two world points (chains, leashes). */
export function buildStrand(color: string, radius: number): THREE.Mesh {
  const m = new THREE.Mesh(G().cylLo, mat(color));
  m.userData.radius = radius;
  m.castShadow = false;
  return noOutline(m);
}
const _up = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();
/** Place a strand between a and b (world, strand parented to a world-space group). */
export function stretchStrand(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
  _d.subVectors(b, a);
  const len = Math.max(0.001, _d.length());
  m.position.copy(a).addScaledVector(_d, 0.5);
  m.quaternion.setFromUnitVectors(_up, _d.normalize());
  const r = m.userData.radius as number;
  m.scale.set(r, len, r);
}

/** Burlap sack that covers the head (and the hat sits on top, of course). */
export function buildSack(): THREE.Group {
  const g = G();
  const grp = new THREE.Group();
  const burlap = mat("#B48C58");
  grp.add(mesh(g.sphere, burlap, 0, 0.21, 0.01, 0.27, 0.31, 0.265));
  const pinch = mesh(g.cone, burlap, 0, 0.53, 0, 0.09, 0.14, 0.09);
  grp.add(pinch);
  grp.add(mesh(g.torusFat, mat("#6B4E2E"), 0, -0.02, 0.0, 0.2, 0.2, 0.2).rotateX(Math.PI / 2));
  // Stitches and a patch.
  const stitch = mat("#5E4425");
  for (let i = 0; i < 3; i++) grp.add(noOutline(mesh(g.box, stitch, -0.08 + i * 0.06, 0.22, 0.265, 0.008, 0.06, 0.01)));
  grp.add(noOutline(mesh(g.box, mat("#8C6A3F"), 0.1, 0.3, 0.24, 0.1, 0.08, 0.02)).rotateZ(0.2));
  addOutlines(grp, 1.04);
  return grp;
}

export interface Wallet {
  group: THREE.Group;
  left: THREE.Group;
  right: THREE.Group;
}
/** Leather wallet that opens like a book (hinge along y). */
export function buildWallet(): Wallet {
  const g = G();
  const group = new THREE.Group();
  const leather = mat("#5B3A26");
  const left = new THREE.Group();
  const right = new THREE.Group();
  left.add(mesh(g.rbox, leather, -0.05, 0, 0, 0.1, 0.075, 0.014));
  right.add(mesh(g.rbox, leather, 0.05, 0, 0, 0.1, 0.075, 0.014));
  right.add(noOutline(mesh(g.box, mat("#3A2418"), 0.05, 0, 0.008, 0.09, 0.06, 0.002)));
  group.add(left, right);
  addOutlines(group, 1.05);
  return { group, left, right };
}

function plateCanvasDraw(ctx: CanvasRenderingContext2D, w: number, h: number, no: number): void {
  ctx.fillStyle = "#17151C";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#EDE7DA";
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, w - 16, h - 16);
  ctx.fillStyle = "#EDE7DA";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 26px ${FONT}`;
  ctx.fillText("KASALA EMNİYET", w / 2, 34);
  ctx.font = `700 54px ${FONT}`;
  ctx.fillText(`SABIKA ${no}`, w / 2, h / 2 + 10);
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText("SUÇU: BİR KART DAHA", w / 2, h - 30);
}

export interface NumberPlate {
  group: THREE.Mesh;
  redraw(): void;
}
/** Hand-held mugshot number plate ("SABIKA 4521"); redraw() rolls a new number. */
export function buildNumberPlate(): NumberPlate {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 170;
  const ctx = canvas.getContext("2d")!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const redraw = () => {
    plateCanvasDraw(ctx, canvas.width, canvas.height, 1000 + Math.floor(Math.random() * 9000));
    tex.needsUpdate = true;
  };
  redraw();
  const m = new THREE.Mesh(G().box, [mat("#17151C"), mat("#17151C"), mat("#17151C"), mat("#17151C"), new THREE.MeshBasicMaterial({ map: tex }), mat("#17151C")]);
  m.scale.set(0.3, 0.16, 0.012);
  m.userData.keepSkin = true;
  return { group: m, redraw };
}

let boardTex: THREE.CanvasTexture | null = null;
function boardTexture(): THREE.CanvasTexture {
  if (boardTex) return boardTex;
  boardTex = canvasTexture(256, 512, (ctx, w, h) => {
    ctx.fillStyle = "#2B3546";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#E9E4D8";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    // 2.0 m tall board: a line every 10 cm, labels every 20 cm.
    for (let cm = 0; cm <= 200; cm += 10) {
      const y = h - (cm / 200) * h;
      const major = cm % 20 === 0;
      ctx.fillRect(0, y - (major ? 3 : 1.5), major ? w : w * 0.7, major ? 6 : 3);
      if (major && cm > 0 && cm < 200) {
        ctx.font = `700 26px ${FONT}`;
        ctx.fillText(`${cm}`, 10, y - 18);
      }
    }
    ctx.textAlign = "center";
    ctx.font = `700 30px ${FONT}`;
    ctx.fillStyle = "#FFC93C";
    ctx.fillText("SABIKA", w / 2, 30);
  });
  return boardTex;
}

/** Height-line mugshot board (2 m), readable from both sides. Bottom at y = 0. */
export function buildMugshotBoard(): THREE.Group {
  const g = G();
  const grp = new THREE.Group();
  const face = new THREE.MeshBasicMaterial({ map: boardTexture() });
  const front = mesh(g.plane, face, 0, 1.0, 0.012, 0.95, 1.9, 1);
  const back = mesh(g.plane, face, 0, 1.0, -0.012, 0.95, 1.9, 1);
  back.rotation.y = Math.PI;
  grp.add(front, back);
  grp.add(mesh(g.box, mat(WOOD_DARK), 0, 1.0, 0, 1.0, 1.98, 0.02));
  for (const s of [-1, 1]) grp.add(mesh(g.box, mat(WOOD), s * 0.5, 1.0, 0, 0.05, 2.0, 0.06));
  front.userData.noOutline = back.userData.noOutline = true;
  addOutlines(grp, 1.02);
  return grp;
}

export interface BoxCamera {
  group: THREE.Group;
  bulb: THREE.Mesh;
  glow: THREE.Sprite;
}
/** Old press camera with a flash bulb (Komiser Rıfat's mugshot camera). */
export function buildBoxCamera(): BoxCamera {
  const g = G();
  const group = new THREE.Group();
  group.add(mesh(g.rbox, mat("#1E1C24"), 0, 0, 0, 0.18, 0.13, 0.12));
  const lens = mesh(g.cyl, mat("#3B3946"), 0, 0, 0.08, 0.045, 0.06, 0.045);
  lens.rotation.x = Math.PI / 2;
  group.add(lens);
  group.add(noOutline(mesh(g.sphere, mat("#8FB8FF"), 0, 0, 0.112, 0.03, 0.03, 0.01)));
  group.add(mesh(g.cylLo, mat("#C9CED8"), 0.07, 0.11, 0.0, 0.01, 0.14, 0.01));
  const dish = mesh(g.cone, mat("#E3E7EE"), 0.07, 0.2, 0.03, 0.06, 0.05, 0.06);
  dish.rotation.x = Math.PI / 2 + 0.3;
  group.add(dish);
  const bulb = mesh(g.sphere, new THREE.MeshToonMaterial({ color: "#FFFFFF", emissive: "#FFF6C8", emissiveIntensity: 0 }), 0.07, 0.2, 0.05, 0.025);
  bulb.userData.keepSkin = true;
  group.add(bulb);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: "#FFF8E0", transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.position.set(0.07, 0.2, 0.08);
  glow.scale.setScalar(1.6);
  group.add(glow);
  addOutlines(group, 1.04);
  return { group, bulb, glow };
}

// ------------------------------------------------------------- flag props
/** Iron collar (Taşlık) around the neck; attach to the torso at neck height. */
export function buildCollar(): THREE.Group {
  const grp = new THREE.Group();
  const ring = mesh(G().torusFat, mat(IRON), 0, 0, 0, 0.125, 0.125, 0.16);
  ring.rotation.x = Math.PI / 2;
  grp.add(ring);
  grp.add(mesh(G().torus, mat("#7E8494"), 0, -0.03, 0.15, 0.03, 0.03, 0.06));
  addOutlines(grp, 1.05);
  return grp;
}

export function buildIronBall(): THREE.Group {
  const grp = new THREE.Group();
  grp.add(mesh(G().sphere, mat("#3A3E48"), 0, 0.1, 0, 0.1));
  grp.add(mesh(G().torus, mat("#7E8494"), 0, 0.21, 0, 0.03, 0.03, 0.06));
  addOutlines(grp, 1.05);
  return grp;
}

/** Chain links (positioned every frame along a sagging curve). */
export function buildChainLinks(n: number): THREE.Mesh[] {
  const links: THREE.Mesh[] = [];
  const m = mat("#8A90A0");
  for (let i = 0; i < n; i++) {
    const l = noOutline(mesh(G().torus, m, 0, 0, 0, 0.028, 0.04, 0.04));
    links.push(l);
  }
  return links;
}

/** Blue nazar bead (Lanet). */
export function buildNazar(): THREE.Group {
  const g = G();
  const grp = new THREE.Group();
  const layer = (r: number, h: number, color: string) => {
    const m = mesh(g.cyl, mat(color), 0, 0, 0, r, h, r);
    m.rotation.x = Math.PI / 2;
    grp.add(m);
    return m;
  };
  layer(0.075, 0.03, "#1E4FCF");
  layer(0.05, 0.034, "#FFFFFF").userData.noOutline = true;
  layer(0.034, 0.038, "#6EC3FF").userData.noOutline = true;
  layer(0.017, 0.042, "#111111").userData.noOutline = true;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: "#4DA3FF", transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.scale.setScalar(0.42);
  grp.add(glow);
  addOutlines(grp, 1.08);
  return grp;
}

/** Lawyer's briefcase (BEDAVA AVUKAT waiting). Bottom at y = 0. */
export function buildBriefcase(): THREE.Group {
  const g = G();
  const grp = new THREE.Group();
  grp.add(mesh(g.rbox, mat("#6B3E22"), 0, 0.12, 0, 0.32, 0.23, 0.09));
  grp.add(mesh(g.halfTorus, mat("#3A2116"), 0, 0.235, 0, 0.05, 0.05, 0.08));
  const gold = mat(PALETTE.gold);
  for (const s of [-1, 1]) grp.add(noOutline(mesh(g.box, gold, s * 0.09, 0.2, 0.046, 0.035, 0.03, 0.01)));
  grp.add(noOutline(mesh(g.box, mat("#FFF4DF"), 0.06, 0.1, 0.047, 0.09, 0.06, 0.005)));
  addOutlines(grp, 1.04);
  return grp;
}

// ------------------------------------------------------------ emote props
/** Cigar: tip (ember) at +z. */
export function buildCigar(): { group: THREE.Group; ember: THREE.Mesh } {
  const g = G();
  const group = new THREE.Group();
  const body = mesh(g.cylLo, mat("#6B4226"), 0, 0, 0.06, 0.017, 0.14, 0.017);
  body.rotation.x = Math.PI / 2;
  group.add(body);
  const band = noOutline(mesh(g.cylLo, mat(PALETTE.gold), 0, 0, 0.02, 0.019, 0.02, 0.019));
  band.rotation.x = Math.PI / 2;
  group.add(band);
  const ember = noOutline(mesh(g.sphereLo, new THREE.MeshToonMaterial({ color: "#FF7A2E", emissive: "#FF5A10", emissiveIntensity: 1.2 }), 0, 0, 0.132, 0.018, 0.018, 0.012));
  ember.userData.keepSkin = true;
  group.add(ember);
  addOutlines(group, 1.08);
  return { group, ember };
}

/** Zippo with a flickering flame. */
export function buildLighter(): { group: THREE.Group; flame: THREE.Mesh } {
  const g = G();
  const group = new THREE.Group();
  group.add(mesh(g.rbox, mat("#C9CED8"), 0, 0, 0, 0.04, 0.06, 0.022));
  const flame = noOutline(
    mesh(g.cone, new THREE.MeshBasicMaterial({ color: "#FFC93C", transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }), 0, 0.065, 0, 0.014, 0.05, 0.014),
  );
  flame.userData.keepSkin = true;
  group.add(flame);
  addOutlines(group, 1.06);
  return { group, flame };
}

/** A wad of bills with a paper band, and one loose bill on top for counting flicks. */
export function buildBillWad(): { group: THREE.Group; top: THREE.Mesh } {
  const g = G();
  const group = new THREE.Group();
  const green = mat(PALETTE.money);
  group.add(mesh(g.box, green, 0, 0, 0, 0.14, 0.035, 0.075));
  group.add(noOutline(mesh(g.box, mat("#FFF4DF"), 0, 0, 0, 0.03, 0.04, 0.08)));
  const top = mesh(g.box, mat("#9BE3A6"), 0, 0.022, 0, 0.14, 0.004, 0.075);
  group.add(top);
  addOutlines(group, 1.05);
  return { group, top };
}

/** White handkerchief. */
export function buildHanky(): THREE.Group {
  const g = G();
  const grp = new THREE.Group();
  grp.add(mesh(g.sphere, mat("#FFFFFF"), 0, -0.02, 0.02, 0.085, 0.1, 0.03));
  grp.add(noOutline(mesh(g.torus, mat("#E5383B"), 0, -0.02, 0.022, 0.07, 0.085, 0.05)));
  addOutlines(grp, 1.05);
  return grp;
}

export interface Bucket {
  group: THREE.Group;
  fill: THREE.Mesh;
}
/** Tin bucket (tears, cement shoes). `fill` is the water / cement disc (set its y). */
export function buildBucket(fillColor: string, r = 0.13, h = 0.2): Bucket {
  const g = G();
  const group = new THREE.Group();
  const tin = mat("#AEB4C2");
  const wall = mesh(g.cylOpen, tin, 0, h / 2, 0, r, h, r);
  (wall.material as THREE.Material).side = THREE.DoubleSide;
  group.add(wall);
  group.add(mesh(g.cyl, tin, 0, 0.005, 0, r * 0.92, 0.01, r * 0.92));
  group.add(noOutline(mesh(g.torus, mat("#8A90A0"), 0, h, 0, r, r, r * 2).rotateX(Math.PI / 2)));
  const handle = noOutline(mesh(g.halfTorus, mat("#5C6170"), 0, h, 0, r * 0.95, r * 0.9, r * 2));
  group.add(handle);
  const fill = noOutline(mesh(g.cyl, mat(fillColor), 0, h * 0.5, 0, r * 0.93, 0.012, r * 0.93));
  group.add(fill);
  addOutlines(group, 1.04);
  return { group, fill };
}

// ----------------------------------------------------------------- podium
const pileCache = new Map<number, { cash: THREE.BufferGeometry; bands: THREE.BufferGeometry; coins: THREE.BufferGeometry; top: number }>();

/** A pile of banknote bricks and coins `layers` high. userData.top = height of the standing surface. */
export function buildMoneyPile(layers: number, place: number): THREE.Group {
  const g = G();
  let geo = pileCache.get(layers);
  if (!geo) {
    const cash: { g: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
    const bands: { g: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
    const coins: { g: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
    const bw = 0.26;
    const bh = 0.09;
    const bd = 0.14;
    let seed = layers * 7.13;
    const rnd = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let l = 0; l < layers; l++) {
      const shrink = 1 - (l / Math.max(1, layers)) * 0.25;
      const y = bh / 2 + l * bh;
      const rot = (l % 2) * (Math.PI / 2) + (rnd() - 0.5) * 0.15;
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 3; j++) {
          const lx = (i - 0.5) * bw * 1.02 * shrink;
          const lz = (j - 1) * bd * 1.04 * shrink;
          const x = Math.cos(rot) * lx - Math.sin(rot) * lz;
          const z = Math.sin(rot) * lx + Math.cos(rot) * lz;
          const ry = -rot + (rnd() - 0.5) * 0.12;
          cash.push({ g: g.box, m: trs(x, y, z, 0, ry, 0, bw * 0.98, bh * 0.94, bd * 0.96) });
          bands.push({ g: g.box, m: trs(x, y, z, 0, ry, 0, 0.05, bh * 0.98, bd * 1.0) });
        }
      }
    }
    const top = layers * bh;
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 0.32 + rnd() * 0.12;
      const hgt = 0.02 + Math.floor(rnd() * 4) * 0.02;
      coins.push({ g: g.cyl, m: trs(Math.cos(a) * r, hgt / 2, Math.sin(a) * r, 0, 0, 0, 0.05, hgt, 0.05) });
    }
    geo = { cash: mergeParts(cash), bands: mergeParts(bands), coins: mergeParts(coins), top };
    pileCache.set(layers, geo);
  }
  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(geo.cash, mat(PALETTE.money)));
  grp.add(new THREE.Mesh(geo.bands, mat("#FFF4DF")));
  grp.add(new THREE.Mesh(geo.coins, mat(PALETTE.gold)));
  // Place plaque on the front.
  const tex = canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = place === 1 ? PALETTE.gold : place === 2 ? "#D9DEE6" : "#D08B4E";
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w / 2 - 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 8;
    ctx.strokeStyle = PALETTE.ink;
    ctx.stroke();
    ctx.fillStyle = PALETTE.ink;
    ctx.font = `700 74px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${place}`, w / 2, h / 2 + 4);
  });
  const plaque = new THREE.Mesh(g.cyl, [mat(PALETTE.ink), new THREE.MeshBasicMaterial({ map: tex }), mat(PALETTE.ink)]);
  plaque.position.set(0, geo.top * 0.5, 0.3);
  plaque.scale.set(0.1, 0.02, 0.1);
  plaque.rotation.x = Math.PI / 2;
  grp.add(plaque);
  for (const c of grp.children) c.castShadow = c.receiveShadow = true;
  addOutlines(grp, 1.025);
  grp.userData.top = geo.top;
  return grp;
}

// ------------------------------------------------------------------- pier
export interface Pier {
  group: THREE.Group;
  water: THREE.Mesh;
  ripples: THREE.Mesh[];
  /** Local point where the condemned stands (top of the plank end). */
  edge: THREE.Vector3;
  /** Local point in the water where they land. */
  drop: THREE.Vector3;
}
/** Little wooden pier over a pool of Bosphorus water (cement shoes scene). Faces +z (water side). */
export function buildPier(): Pier {
  const g = G();
  const group = new THREE.Group();
  const wood = mat("#7A5134");
  const plank = mat("#8C5E3C");
  for (let i = 0; i < 4; i++) group.add(mesh(g.rbox, i % 2 ? plank : wood, -0.21 + i * 0.14, 0.3, 0.25, 0.13, 0.05, 0.95));
  for (const sx of [-1, 1]) for (const sz of [0, 1]) group.add(mesh(g.cylLo, mat(WOOD_DARK), sx * 0.24, 0.14, -0.12 + sz * 0.72, 0.035, 0.32, 0.035));
  const waterMat = new THREE.MeshToonMaterial({ color: "#2E86C1", emissive: "#0F4C75", emissiveIntensity: 0.35, transparent: true, opacity: 0.9 });
  const water = mesh(g.disc, waterMat, 0, 0.012, 1.15, 0.85);
  water.rotation.x = -Math.PI / 2;
  water.userData.noOutline = true;
  water.userData.keepSkin = true;
  group.add(water);
  const ripples: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const r = noOutline(mesh(g.ring, new THREE.MeshBasicMaterial({ color: "#BFE6FF", transparent: true, opacity: 0, depthWrite: false }), 0, 0.016, 1.15, 0.3));
    r.rotation.x = -Math.PI / 2;
    group.add(r);
    ripples.push(r);
  }
  addOutlines(group, 1.03);
  mergeStatic(group, new Set([water, ...ripples]));
  optimizeShadows(group);
  return { group, water, ripples, edge: new THREE.Vector3(0, 0.33, 0.62), drop: new THREE.Vector3(0, 0, 1.15) };
}

// ----------------------------------------------------------------- the wet
/** Moss blobs + a seaweed strand for a ghost that came back from the river. */
export function buildMoss(): THREE.Group {
  const g = G();
  const grp = new THREE.Group();
  const moss = mat("#5E8F3A");
  const dark = mat("#3F6B2A");
  grp.add(mesh(g.sphere, moss, 0.08, 0.15, 0.05, 0.08, 0.03, 0.06));
  grp.add(mesh(g.sphere, dark, -0.1, 0.12, -0.04, 0.06, 0.025, 0.05));
  grp.add(mesh(g.sphere, moss, 0.0, 0.17, -0.09, 0.05, 0.02, 0.04));
  const weed = mesh(g.capsule, dark, 0.22, -0.04, 0.08, 0.018, 0.16, 0.012);
  weed.rotation.z = 0.2;
  weed.name = "weed";
  grp.add(weed);
  addOutlines(grp, 1.06);
  return grp;
}

/** Small fish that flops on the hat. */
export function buildFish(): THREE.Group {
  const g = G();
  const grp = new THREE.Group();
  grp.add(mesh(g.sphere, mat("#A8C6D8"), 0, 0, 0, 0.07, 0.035, 0.025));
  const tail = mesh(g.coneLo, mat("#7FA3B8"), -0.085, 0, 0, 0.035, 0.05, 0.012);
  tail.rotation.z = Math.PI / 2;
  grp.add(tail);
  grp.add(noOutline(mesh(g.sphereLo, mat("#111111"), 0.045, 0.01, 0.02, 0.008)));
  addOutlines(grp, 1.06);
  return grp;
}

// ---------------------------------------------------------- dizzy stars
let starGeo: THREE.BufferGeometry | null = null;
export function starGeometry(): THREE.BufferGeometry {
  if (starGeo) return starGeo;
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 0.05 : 0.022;
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  starGeo = new THREE.ExtrudeGeometry(s, { depth: 0.016, bevelEnabled: false });
  starGeo.center();
  return starGeo;
}
export function buildStars(): THREE.Group {
  const grp = new THREE.Group();
  const m = new THREE.MeshToonMaterial({ color: "#FFD84A", emissive: "#B88A00", emissiveIntensity: 0.4 });
  for (let i = 0; i < 3; i++) {
    const st = new THREE.Mesh(starGeometry(), m);
    st.userData.phase = (i / 3) * Math.PI * 2;
    st.userData.keepSkin = true;
    grp.add(st);
  }
  grp.visible = false;
  return grp;
}

// ----------------------------------------------------------- targeting
export interface TargetMarker {
  group: THREE.Group;
  ring: THREE.Mesh;
  arrow: THREE.Group;
}
const ringMat = () => new THREE.MeshBasicMaterial({ color: "#FF3B3F", transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
/** Pulsing red floor ring + bouncing arrow over the head. */
export function buildTargetMarker(): TargetMarker {
  const g = G();
  const group = new THREE.Group();
  const ring = mesh(g.ring, ringMat(), 0, 0.02, 0, 0.62);
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 2;
  group.add(ring);
  const arrow = new THREE.Group();
  const red = new THREE.MeshToonMaterial({ color: "#FF3B3F", emissive: "#B0141A", emissiveIntensity: 0.6 });
  const head = mesh(g.cone, red, 0, 0, 0, 0.09, -0.16, 0.09);
  arrow.add(head);
  arrow.add(mesh(g.cylLo, red, 0, 0.14, 0, 0.035, 0.16, 0.035));
  addOutlines(arrow, 1.08);
  group.add(arrow);
  group.visible = false;
  return { group, ring, arrow };
}

// ------------------------------------------------------------ shuffling
/** Half-deck block held in each hand (cream edges, dark red back on top). */
export function buildDeckHalf(): THREE.Group {
  const g = G();
  const grp = new THREE.Group();
  grp.add(mesh(g.box, mat("#F4EBD9"), 0, 0, 0, 0.065, 0.03, 0.09));
  grp.add(noOutline(mesh(g.box, mat("#7A1E2C"), 0, 0.0155, 0, 0.062, 0.002, 0.087)));
  addOutlines(grp, 1.05);
  return grp;
}
export function buildCardSliver(): THREE.Mesh {
  const edge = mat("#F4EBD9");
  const m = new THREE.Mesh(G().box, [edge, edge, mat("#7A1E2C"), mat("#FFF4DF"), edge, edge]);
  m.scale.set(0.064, 0.003, 0.089);
  return m;
}

/** Sheets of legal paper (the lawyer waves them). */
export function buildPapers(): THREE.Group {
  const g = G();
  const grp = new THREE.Group();
  const paper = new THREE.MeshToonMaterial({ color: "#FFFDF5", side: THREE.DoubleSide });
  for (let i = 0; i < 3; i++) {
    const p = mesh(g.plane, paper, i * 0.02, i * 0.015, i * 0.004, 0.16, 0.22, 1);
    p.rotation.z = (i - 1) * 0.18;
    grp.add(p);
    for (let l = 0; l < 4; l++) grp.add(noOutline(mesh(g.box, mat("#6A6478"), i * 0.02, i * 0.015 + 0.06 - l * 0.035, i * 0.004 + 0.002, 0.1, 0.008, 0.001)));
  }
  return grp;
}
