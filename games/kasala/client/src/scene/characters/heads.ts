// Heads and hats: the six gangster animals (§2: cat, dog, pig, mouse, frog, rabbit — each with its own
// silhouette: ears, snouts, whiskers), Cemil Abi the old crocodile (long snout, gold tooth, heavy lids),
// Komiser Rıfat the mustached bulldog, the weasel lawyer, plus fedora / police cap / dealer visor.
// Owner: client-characters. Head space: pivot at the neck, +z forward.

import * as THREE from "three";
import { ANIMAL_BY_ID, PALETTE, type Animal } from "../../../../shared/constants";
import { addOutlines, canvasTexture } from "../toon";
import type { Ear, Eye, Face, MouthKind } from "./body";
import { FONT, G, inkMat, mat, mergeParts, mergeStatic, mesh, mouthMat, noOutline, tongueMat, trs, uniqueMat, whiteMat } from "./kit";

// ------------------------------------------------------------------ pieces
const scleraMat = new THREE.MeshBasicMaterial({ color: "#FFFFFF" });
const pinkMat = () => mat("#FF8FA8");

function eye(parent: THREE.Object3D, x: number, y: number, z: number, sx: number, sy: number, sz: number, lidColor: THREE.ColorRepresentation, rotY = 0): Eye {
  const g = G();
  const root = new THREE.Group();
  root.position.set(x, y, z);
  root.rotation.y = rotY;
  const inner = new THREE.Group();
  inner.scale.set(sx, sy, sz);
  root.add(inner);
  inner.add(mesh(g.sphere, scleraMat));
  const pupil = new THREE.Group();
  pupil.add(noOutline(mesh(g.sphereLo, inkMat, 0, 0, 0, 0.44, 0.48, 0.16)));
  pupil.add(noOutline(mesh(g.sphereLo, whiteMat, 0.14, 0.17, 0.12, 0.13, 0.13, 0.06)));
  pupil.position.z = 0.88;
  inner.add(pupil);
  const lid = noOutline(mesh(g.hemi, mat(lidColor), 0, 0, 0, 1.13));
  inner.add(lid);
  parent.add(root);
  return { root, pupil, lid };
}

function browPair(parent: THREE.Object3D, x: number, y: number, z: number, len: number, thick: number, m: THREE.Material): Face["brows"] {
  const out: Face["brows"] = [];
  for (const s of [-1, 1]) {
    const grp = new THREE.Group();
    grp.position.set(s * x, y, z);
    const b = noOutline(mesh(G().capsule, m, 0, 0, 0, thick, len, thick));
    b.rotation.z = Math.PI / 2;
    grp.add(b);
    parent.add(grp);
    out.push({ obj: grp, side: s, home: grp.position.clone() });
  }
  return out;
}

/** The standard mouth set (one visible at a time), centered on the anchor, facing +z. */
function mouthSet(anchor: THREE.Group, w: number): Partial<Record<MouthKind, THREE.Object3D>> {
  const g = G();
  const smile = mesh(g.halfTorus, inkMat, 0, w * 0.45, 0, w, w, w);
  smile.rotation.z = Math.PI;
  const smirk = mesh(g.halfTorus, inkMat, w * 0.25, w * 0.3, 0, w * 0.72, w * 0.6, w);
  smirk.rotation.z = Math.PI + 0.35;
  const frown = mesh(g.halfTorus, inkMat, 0, -w * 0.55, 0, w * 0.85, w * 0.75, w);
  const o = mesh(g.sphere, mouthMat, 0, -w * 0.1, 0, w * 0.42, w * 0.55, w * 0.15);
  const grin = new THREE.Group();
  grin.position.y = w * 0.2;
  grin.add(mesh(g.halfDisc, mouthMat, 0, 0, 0, w * 1.15, w * 1.0, 1));
  grin.add(mesh(g.halfDisc, tongueMat, 0, -w * 0.55, 0.002, w * 0.55, w * 0.42, 1));
  grin.add(mesh(g.box, whiteMat, 0, -w * 0.09, 0.003, w * 1.7, w * 0.2, 0.002));
  const flat = mesh(g.capsule, inkMat, 0, 0, 0, w * 0.2, w * 1.1, w * 0.2);
  flat.rotation.z = Math.PI / 2;
  const kiss = mesh(g.torusFat, mat("#E8577A"), 0, 0, w * 0.15, w * 0.32, w * 0.32, w * 0.4);
  const teeth = new THREE.Group();
  teeth.add(mesh(g.box, whiteMat, 0, 0, 0, w * 1.4, w * 0.5, 0.004));
  teeth.add(mesh(g.box, inkMat, 0, 0, 0.003, w * 1.4, w * 0.05, 0.002));
  for (let i = -1; i <= 1; i++) teeth.add(mesh(g.box, inkMat, (i * w * 1.4) / 4, 0, 0.003, w * 0.04, w * 0.5, 0.002));
  const mouths: Partial<Record<MouthKind, THREE.Object3D>> = { smile, smirk, frown, o, grin, flat, kiss, teeth };
  for (const m of Object.values(mouths)) {
    noOutline(m!);
    m!.visible = false;
    anchor.add(m!);
  }
  smirk.visible = true;
  return mouths;
}

function whiskers(parent: THREE.Object3D, x: number, y: number, z: number, len: number): THREE.Group[] {
  const out: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const grp = new THREE.Group();
    grp.position.set(s * x, y, z);
    for (let i = 0; i < 3; i++) {
      const w = noOutline(mesh(G().cylLo, inkMat, s * len * 0.5, (i - 1) * 0.018, 0, 0.0035, len, 0.0035));
      w.rotation.z = Math.PI / 2 + s * (i - 1) * 0.16;
      grp.add(w);
    }
    mergeStatic(grp);
    parent.add(grp);
    out.push(grp);
  }
  return out;
}

function ear(parent: THREE.Object3D, x: number, y: number, z: number, base: [number, number, number], droop: [number, number, number], perk: [number, number, number]): Ear {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  pivot.rotation.set(...base);
  parent.add(pivot);
  return { pivot, base: new THREE.Euler(...base), droop: new THREE.Vector3(...droop), perk: new THREE.Vector3(...perk) };
}

function curl(points: [number, number, number][], radius: number): THREE.TubeGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return new THREE.TubeGeometry(curve, 20, radius, 6, false);
}

const darken = (hex: string, amt: number) => "#" + new THREE.Color(hex).offsetHSL(0, 0, -amt).getHexString();

// ------------------------------------------------------------------ animals
/** Gangster head for an animal. The fedora mounts on face.hatMount. */
export function buildAnimalHead(animal: Animal): Face {
  const def = ANIMAL_BY_ID[animal];
  const g = G();
  const head = new THREE.Group();
  const skullMat = uniqueMat(def.fur);
  const fur = mat(def.fur);
  const accent = mat(def.accent);
  const furDark = mat(darken(def.fur, 0.12));
  const hatMount = new THREE.Group();
  const mouth = new THREE.Group();
  const mouthTip = new THREE.Object3D();
  const nose = new THREE.Object3D();
  head.add(hatMount, mouth, mouthTip, nose);
  let skull: THREE.Mesh;
  let eyes: Eye[] = [];
  let brows: Face["brows"] = [];
  const ears: Ear[] = [];
  let top = 0.39;
  let extra: Face["extra"];
  let mouthW = 0.04;

  switch (animal) {
    case "kedi": {
      skull = mesh(g.sphere, skullMat, 0, 0.19, 0, 0.215, 0.195, 0.2);
      for (const s of [-1, 1]) head.add(mesh(g.sphere, accent, s * 0.045, 0.125, 0.165, 0.062, 0.048, 0.05));
      head.add(mesh(g.sphere, accent, 0, 0.098, 0.15, 0.04, 0.03, 0.035));
      const n = noOutline(mesh(g.cone, pinkMat(), 0, 0.158, 0.205, 0.024, 0.026, 0.016));
      n.rotation.z = Math.PI;
      head.add(n);
      nose.position.set(0, 0.16, 0.22);
      mouth.position.set(0, 0.112, 0.208);
      eyes = [eye(head, -0.078, 0.215, 0.158, 0.048, 0.058, 0.032, def.fur, -0.32), eye(head, 0.078, 0.215, 0.158, 0.048, 0.058, 0.032, def.fur, 0.32)];
      brows = browPair(head, 0.078, 0.282, 0.168, 0.05, 0.013, inkMat);
      for (const s of [-1, 1]) {
        const e = ear(head, s * 0.14, 0.31, -0.02, [0, 0, -s * 0.42], [0.3, 0, -s * 0.9], [0, 0, s * 0.18]);
        e.pivot.add(mesh(g.cone, fur, 0, 0.065, 0, 0.072, 0.14, 0.05));
        e.pivot.add(noOutline(mesh(g.cone, mat("#F7B9C4"), 0, 0.058, 0.022, 0.045, 0.1, 0.02)));
        ears.push(e);
      }
      const wh = whiskers(head, 0.07, 0.13, 0.19, 0.12);
      // Stripes on the cheeks: tabby gangster.
      for (const s of [-1, 1]) for (let i = 0; i < 2; i++) {
        const st = noOutline(mesh(g.capsule, furDark, s * 0.2, 0.2 + i * 0.04, 0.05, 0.012, 0.05, 0.012));
        st.rotation.z = Math.PI / 2;
        head.add(st);
      }
      extra = (time) => {
        wh[0]!.rotation.z = Math.sin(time * 3.1) * 0.06;
        wh[1]!.rotation.z = -Math.sin(time * 2.7 + 1) * 0.06;
      };
      break;
    }
    case "kopek": {
      skull = mesh(g.sphere, skullMat, 0, 0.19, 0, 0.2, 0.2, 0.2);
      head.add(mesh(g.sphere, accent, 0, 0.13, 0.17, 0.095, 0.078, 0.115));
      head.add(mesh(g.sphere, mat("#1C1A1F"), 0, 0.165, 0.275, 0.044, 0.033, 0.03));
      nose.position.set(0, 0.17, 0.3);
      head.add(noOutline(mesh(g.sphere, furDark, 0.078, 0.235, 0.145, 0.072, 0.07, 0.035)));
      mouth.position.set(0, 0.09, 0.258);
      mouthW = 0.045;
      eyes = [eye(head, -0.076, 0.232, 0.162, 0.045, 0.055, 0.03, def.fur, -0.25), eye(head, 0.076, 0.232, 0.162, 0.045, 0.055, 0.03, darken(def.fur, 0.12), 0.25)];
      brows = browPair(head, 0.076, 0.3, 0.165, 0.05, 0.014, inkMat);
      for (const s of [-1, 1]) {
        const e = ear(head, s * 0.165, 0.3, -0.01, [0.05, 0, s * 0.22], [0.35, 0, -s * 0.18], [0, 0, s * 1.35]);
        e.pivot.add(mesh(g.sphere, furDark, s * 0.012, -0.115, 0, 0.052, 0.135, 0.085));
        ears.push(e);
      }
      break;
    }
    case "domuz": {
      skull = mesh(g.sphere, skullMat, 0, 0.19, 0, 0.228, 0.2, 0.205);
      const snout = mesh(g.cyl, mat("#F08AA0"), 0, 0.15, 0.2, 0.075, 0.07, 0.06);
      snout.rotation.x = Math.PI / 2;
      head.add(snout);
      for (const s of [-1, 1]) head.add(noOutline(mesh(g.sphereLo, mat("#7A2E43"), s * 0.026, 0.15, 0.236, 0.013, 0.021, 0.006)));
      for (const s of [-1, 1]) head.add(noOutline(mesh(g.sphere, mat("#FF7F9C"), s * 0.135, 0.14, 0.13, 0.045, 0.03, 0.02)));
      nose.position.set(0, 0.15, 0.25);
      mouth.position.set(0, 0.085, 0.2);
      mouthW = 0.045;
      eyes = [eye(head, -0.082, 0.235, 0.168, 0.04, 0.05, 0.028, def.fur, -0.3), eye(head, 0.082, 0.235, 0.168, 0.04, 0.05, 0.028, def.fur, 0.3)];
      brows = browPair(head, 0.082, 0.295, 0.17, 0.045, 0.013, inkMat);
      for (const s of [-1, 1]) {
        const e = ear(head, s * 0.15, 0.31, 0.04, [0.95, 0, -s * 0.35], [0.55, 0, -s * 0.25], [-0.9, 0, s * 0.1]);
        e.pivot.add(mesh(g.cone, fur, 0, 0.05, 0, 0.065, 0.11, 0.035));
        ears.push(e);
      }
      break;
    }
    case "fare": {
      skull = mesh(g.sphere, skullMat, 0, 0.18, 0, 0.19, 0.18, 0.2);
      const snout = mesh(g.cone, fur, 0, 0.14, 0.215, 0.085, 0.17, 0.08);
      snout.rotation.x = Math.PI / 2;
      head.add(snout);
      head.add(mesh(g.sphere, mat("#FF8FA8"), 0, 0.14, 0.3, 0.026));
      nose.position.set(0, 0.14, 0.32);
      mouth.position.set(0, 0.098, 0.245);
      mouthW = 0.03;
      eyes = [eye(head, -0.07, 0.215, 0.162, 0.045, 0.055, 0.03, def.fur, -0.3), eye(head, 0.07, 0.215, 0.162, 0.045, 0.055, 0.03, def.fur, 0.3)];
      brows = browPair(head, 0.07, 0.278, 0.17, 0.045, 0.012, inkMat);
      for (const s of [-1, 1]) {
        const e = ear(head, s * 0.15, 0.28, -0.03, [0, s * 0.3, -s * 0.3], [0.2, 0, -s * 0.75], [0, 0, s * 0.25]);
        e.pivot.add(mesh(g.sphere, fur, s * 0.04, 0.07, 0, 0.115, 0.115, 0.025));
        e.pivot.add(noOutline(mesh(g.sphere, mat(def.accent), s * 0.04, 0.07, 0.016, 0.078, 0.078, 0.014)));
        ears.push(e);
      }
      const wh = whiskers(head, 0.04, 0.14, 0.255, 0.13);
      extra = (time) => {
        const tw = Math.sin(time * 9) * Math.max(0, Math.sin(time * 0.7)) * 0.1;
        wh[0]!.rotation.z = tw;
        wh[1]!.rotation.z = -tw;
      };
      break;
    }
    case "kurbaga": {
      skull = mesh(g.sphere, skullMat, 0, 0.16, 0.01, 0.25, 0.155, 0.21);
      head.add(mesh(g.sphere, accent, 0, 0.09, 0.035, 0.2, 0.08, 0.17));
      const sac = noOutline(mesh(g.sphere, mat("#F2F7C8"), 0, 0.06, 0.13, 0.09, 0.065, 0.06));
      sac.userData.anim = true;
      head.add(sac);
      for (const s of [-1, 1]) head.add(mesh(g.sphere, fur, s * 0.105, 0.27, 0.075, 0.08, 0.075, 0.075));
      for (const s of [-1, 1]) head.add(noOutline(mesh(g.sphereLo, inkMat, s * 0.032, 0.2, 0.205, 0.009, 0.006, 0.004)));
      nose.position.set(0, 0.19, 0.22);
      mouth.position.set(0, 0.125, 0.2);
      mouthW = 0.085;
      eyes = [eye(head, -0.107, 0.285, 0.118, 0.055, 0.06, 0.045, def.fur, -0.28), eye(head, 0.107, 0.285, 0.118, 0.055, 0.06, 0.045, def.fur, 0.28)];
      brows = browPair(head, 0.107, 0.36, 0.13, 0.05, 0.013, inkMat);
      top = 0.36;
      extra = (time, _dt, p) => {
        const puff = p.mouth === "teeth" || p.mouth === "o" ? 0.35 + Math.abs(Math.sin(time * 9)) * 0.6 : Math.max(0, Math.sin(time * 1.6)) * 0.35;
        sac.scale.set(0.09 * (1 + puff), 0.065 * (1 + puff * 0.8), 0.06 * (1 + puff));
      };
      break;
    }
    case "tavsan":
    default: {
      skull = mesh(g.sphere, skullMat, 0, 0.19, 0, 0.2, 0.205, 0.2);
      for (const s of [-1, 1]) head.add(mesh(g.sphere, accent, s * 0.042, 0.128, 0.165, 0.058, 0.046, 0.05));
      head.add(mesh(g.sphere, mat("#FF8FA8"), 0, 0.162, 0.198, 0.024, 0.02, 0.02));
      for (const s of [-1, 1]) head.add(noOutline(mesh(g.rbox, whiteMat, s * 0.0115, 0.084, 0.198, 0.021, 0.036, 0.01)));
      nose.position.set(0, 0.165, 0.21);
      mouth.position.set(0, 0.112, 0.205);
      mouthW = 0.035;
      eyes = [eye(head, -0.075, 0.225, 0.162, 0.046, 0.058, 0.03, def.fur, -0.3), eye(head, 0.075, 0.225, 0.162, 0.046, 0.058, 0.03, def.fur, 0.3)];
      brows = browPair(head, 0.075, 0.292, 0.168, 0.048, 0.013, inkMat);
      for (const s of [-1, 1]) {
        const e = ear(head, s * 0.075, 0.33, -0.03, [-0.08, 0, -s * 0.12], [-0.4, 0, -s * 1.5], [0.12, 0, s * 0.06]);
        e.pivot.add(mesh(g.sphere, fur, 0, 0.19, 0, 0.05, 0.2, 0.032));
        e.pivot.add(noOutline(mesh(g.sphere, mat(def.accent), 0, 0.19, 0.02, 0.03, 0.15, 0.018)));
        ears.push(e);
      }
      const wh = whiskers(head, 0.06, 0.135, 0.19, 0.11);
      top = 0.5;
      extra = (time) => {
        const tw = Math.sin(time * 12) * Math.max(0, Math.sin(time * 0.9 + 2)) * 0.08;
        wh[0]!.rotation.z = tw;
        wh[1]!.rotation.z = -tw;
      };
      break;
    }
  }
  head.add(skull);
  const mouths = mouthSet(mouth, mouthW);
  mouthTip.position.copy(mouth.position).add(new THREE.Vector3(0, 0, 0.02));
  hatMount.position.set(0, animal === "kurbaga" ? 0.28 : 0.335, animal === "kurbaga" ? -0.075 : -0.01);
  if (animal === "kurbaga") hatMount.scale.setScalar(0.86);

  // Black eye (kelepçe return): a purple bruise ring around the +x eye.
  const bruise = noOutline(mesh(G().torusFat, mat("#5B3A8C"), 0, 0, 0, 1, 1, 0.5));
  const be = eyes[1]!.root;
  bruise.position.copy(be.position).add(new THREE.Vector3(0, 0, -0.005));
  bruise.rotation.y = be.rotation.y;
  bruise.scale.set(0.058, 0.066, 0.04);
  bruise.visible = false;
  bruise.userData.anim = true;
  head.add(bruise);
  addOutlines(head, 1.045);
  mergeStatic(head, new Set([skull, bruise]));

  return {
    head,
    skull,
    skullMat,
    eyes,
    brows,
    mouth,
    mouths,
    jaw: null,
    jawOpen: 0,
    ears,
    hatMount,
    mouthTip,
    nose,
    top,
    blackEye: bruise,
    extra,
  };
}

// ---------------------------------------------------------------- crocodile
/** Cemil Abi: old crocodile dealer. Jaw-hinged long snout, a gold tooth, tired heavy lids. */
export function buildCrocHead(): { face: Face; goldTooth: THREE.Mesh } {
  const g = G();
  const head = new THREE.Group();
  const greenHex = "#5F8F50";
  const skullMat = uniqueMat(greenHex);
  const green = mat(greenHex);
  const belly = mat("#C9D69A");
  const skull = mesh(g.sphere, skullMat, 0, 0.17, -0.02, 0.2, 0.17, 0.21);
  head.add(skull);
  head.add(mesh(g.rbox, green, 0, 0.165, 0.25, 0.2, 0.085, 0.36));
  for (const s of [-1, 1]) head.add(mesh(g.sphere, green, s * 0.042, 0.215, 0.405, 0.03, 0.022, 0.03));
  for (const s of [-1, 1]) head.add(noOutline(mesh(g.sphereLo, inkMat, s * 0.042, 0.236, 0.41, 0.01, 0.005, 0.01)));
  // Ridge bumps along the head.
  const ridge = mat("#4C7841");
  for (let i = 0; i < 4; i++) head.add(noOutline(mesh(g.sphereLo, ridge, 0, 0.33 - i * 0.025, -0.06 - i * 0.07, 0.03, 0.025, 0.035)));

  // Upper teeth (zigzag) merged into one mesh, plus the famous gold tooth.
  const toothParts: { g: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
  for (const s of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      if (s === 1 && i === 3) continue;
      toothParts.push({ g: g.cone, m: trs(s * 0.092, 0.11, 0.12 + i * 0.05, Math.PI, 0, 0, 0.014, 0.035, 0.014) });
    }
  }
  const teeth = noOutline(new THREE.Mesh(mergeParts(toothParts), mat("#FFFDF0")));
  head.add(teeth);
  const goldMat = new THREE.MeshToonMaterial({ color: PALETTE.gold, emissive: "#8A5A00", emissiveIntensity: 0.6 });
  const goldTooth = noOutline(mesh(g.cone, goldMat, 0.094, 0.105, 0.27, 0.022, -0.05, 0.022));
  goldTooth.userData.keepSkin = true;
  head.add(goldTooth);

  // Lower jaw on a hinge.
  const jaw = new THREE.Group();
  jaw.position.set(0, 0.12, 0.04);
  head.add(jaw);
  jaw.add(mesh(g.rbox, belly, 0, -0.035, 0.2, 0.19, 0.06, 0.34));
  jaw.add(noOutline(mesh(g.box, mat("#B5475C"), 0, -0.005, 0.2, 0.15, 0.006, 0.28)));
  const lowParts: { g: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
  for (const s of [-1, 1]) for (let i = 0; i < 5; i++) lowParts.push({ g: g.cone, m: trs(s * 0.085, 0.002, 0.1 + i * 0.055, 0, 0, 0, 0.012, 0.03, 0.012) });
  jaw.add(noOutline(new THREE.Mesh(mergeParts(lowParts), mat("#FFFDF0"))));

  // Eyes on bumps, bushy grey brows.
  for (const s of [-1, 1]) head.add(mesh(g.sphere, green, s * 0.085, 0.27, 0.05, 0.072, 0.065, 0.07));
  const eyes = [eye(head, -0.085, 0.29, 0.088, 0.045, 0.05, 0.036, "#557F47", -0.2), eye(head, 0.085, 0.29, 0.088, 0.045, 0.05, 0.036, "#557F47", 0.2)];
  const brows = browPair(head, 0.088, 0.35, 0.1, 0.06, 0.022, mat("#D7D3CC"));
  const mouth = new THREE.Group();
  mouth.position.set(0, 0.12, 0.3);
  head.add(mouth);
  const mouthTip = new THREE.Object3D();
  mouthTip.position.set(0.11, 0.125, 0.2);
  head.add(mouthTip);
  const nose = new THREE.Object3D();
  nose.position.set(0, 0.22, 0.42);
  head.add(nose);
  const hatMount = new THREE.Group();
  hatMount.position.set(0, 0.29, -0.03);
  head.add(hatMount);
  addOutlines(head, 1.04);
  mergeStatic(head, new Set([skull, goldTooth]));
  const face: Face = {
    head,
    skull,
    skullMat,
    eyes,
    brows,
    mouth,
    mouths: {},
    jaw,
    jawOpen: 0.42,
    ears: [],
    hatMount,
    mouthTip,
    nose,
    top: 0.36,
    blackEye: null,
  };
  return { face, goldTooth };
}

// ----------------------------------------------------------------- bulldog
/** Komiser Rıfat: jowly bulldog with an underbite and a fat black handlebar mustache. */
export function buildBulldogHead(): Face {
  const g = G();
  const head = new THREE.Group();
  const tan = "#C9A07A";
  const skullMat = uniqueMat(tan);
  const light = mat("#EEDCC2");
  const skull = mesh(g.sphere, skullMat, 0, 0.19, 0, 0.235, 0.2, 0.21);
  head.add(skull);
  for (const s of [-1, 1]) head.add(mesh(g.sphere, light, s * 0.095, 0.105, 0.13, 0.1, 0.09, 0.09));
  head.add(mesh(g.sphere, light, 0, 0.155, 0.17, 0.12, 0.075, 0.085));
  head.add(mesh(g.sphere, mat("#1B181E"), 0, 0.19, 0.245, 0.05, 0.032, 0.03));
  // Wrinkles on the brow.
  for (let i = 0; i < 2; i++) {
    const w = noOutline(mesh(g.halfTorus, mat("#8D6A4C"), 0, 0.31 + i * 0.022, 0.155, 0.05 - i * 0.008, 0.02, 0.02));
    head.add(w);
  }
  const jaw = new THREE.Group();
  jaw.position.set(0, 0.075, 0.05);
  head.add(jaw);
  jaw.add(mesh(g.sphere, light, 0, -0.01, 0.13, 0.115, 0.06, 0.1));
  for (const s of [-1, 1]) jaw.add(noOutline(mesh(g.cone, mat("#FFFDF0"), s * 0.05, 0.045, 0.205, 0.014, 0.04, 0.014)));
  const stache = new THREE.Group();
  stache.position.set(0, 0.135, 0.255);
  const sg = curl(
    [
      [0, 0, 0],
      [0.06, -0.015, 0.004],
      [0.12, -0.006, -0.01],
      [0.16, 0.035, -0.02],
      [0.14, 0.07, -0.025],
      [0.11, 0.055, -0.02],
    ],
    0.024,
  );
  const sm = mat("#1E1A20");
  const r = new THREE.Mesh(sg, sm);
  const l = new THREE.Mesh(sg, sm);
  l.scale.x = -1;
  stache.add(r, l);
  head.add(stache);
  const eyes = [eye(head, -0.088, 0.228, 0.165, 0.042, 0.05, 0.03, tan, -0.25), eye(head, 0.088, 0.228, 0.165, 0.042, 0.05, 0.03, tan, 0.25)];
  const brows = browPair(head, 0.09, 0.295, 0.172, 0.06, 0.02, inkMat);
  const ears: Ear[] = [];
  for (const s of [-1, 1]) {
    const e = ear(head, s * 0.19, 0.3, -0.02, [0, 0, -s * 0.5], [0.3, 0, -s * 0.4], [0, 0, s * 0.3]);
    e.pivot.add(mesh(g.sphere, mat("#7E5B3E"), s * 0.03, 0.02, 0, 0.065, 0.05, 0.025));
    ears.push(e);
  }
  const mouth = new THREE.Group();
  mouth.position.set(0, 0.1, 0.24);
  head.add(mouth);
  const mouths = mouthSet(mouth, 0.05);
  const mouthTip = new THREE.Object3D();
  mouthTip.position.set(0, 0.11, 0.26);
  head.add(mouthTip);
  const nose = new THREE.Object3D();
  nose.position.set(0, 0.19, 0.27);
  head.add(nose);
  const hatMount = new THREE.Group();
  hatMount.position.set(0, 0.33, -0.01);
  head.add(hatMount);
  addOutlines(head, 1.04);
  mergeStatic(head, new Set([skull]));
  return {
    head,
    skull,
    skullMat,
    eyes,
    brows,
    mouth,
    mouths,
    jaw,
    jawOpen: 0.35,
    ears,
    hatMount,
    mouthTip,
    nose,
    top: 0.4,
    blackEye: null,
    extra: (time) => {
      stache.rotation.z = Math.sin(time * 2.2) * 0.04;
    },
  };
}

// ------------------------------------------------------------------ weasel
/** The weasel lawyer: pointy snout, round glasses, slicked hair. */
export function buildWeaselHead(): Face {
  const g = G();
  const head = new THREE.Group();
  const brown = "#9C6B3F";
  const skullMat = uniqueMat(brown);
  const skull = mesh(g.sphere, skullMat, 0, 0.17, 0, 0.15, 0.15, 0.18);
  head.add(skull);
  const snout = mesh(g.cone, mat("#F1DDBF"), 0, 0.13, 0.19, 0.075, 0.15, 0.065);
  snout.rotation.x = Math.PI / 2;
  head.add(snout);
  head.add(mesh(g.sphere, mat("#1C1A1F"), 0, 0.13, 0.27, 0.02));
  head.add(mesh(g.sphere, mat("#4A2F1C"), 0, 0.28, -0.03, 0.15, 0.06, 0.16));
  const eyes = [eye(head, -0.06, 0.2, 0.135, 0.032, 0.04, 0.025, brown, -0.3), eye(head, 0.06, 0.2, 0.135, 0.032, 0.04, 0.025, brown, 0.3)];
  // Round glasses.
  const glass = mat("#E9C46A");
  for (const s of [-1, 1]) {
    const ring = noOutline(mesh(g.torus, glass, s * 0.062, 0.2, 0.16, 0.05, 0.05, 0.05));
    ring.rotation.y = s * 0.3;
    head.add(ring);
  }
  head.add(noOutline(mesh(g.cylLo, glass, 0, 0.205, 0.17, 0.006, 0.04, 0.006)).rotateZ(Math.PI / 2));
  const brows = browPair(head, 0.06, 0.255, 0.15, 0.04, 0.01, inkMat);
  const ears: Ear[] = [];
  for (const s of [-1, 1]) {
    const e = ear(head, s * 0.12, 0.25, -0.03, [0, 0, -s * 0.3], [0.3, 0, -s * 0.6], [0, 0, s * 0.2]);
    e.pivot.add(mesh(g.sphere, mat(brown), s * 0.02, 0.03, 0, 0.05, 0.05, 0.02));
    ears.push(e);
  }
  const mouth = new THREE.Group();
  mouth.position.set(0, 0.085, 0.2);
  head.add(mouth);
  const mouths = mouthSet(mouth, 0.03);
  const mouthTip = new THREE.Object3D();
  mouthTip.position.set(0, 0.09, 0.22);
  head.add(mouthTip);
  const nose = new THREE.Object3D();
  nose.position.set(0, 0.13, 0.28);
  head.add(nose);
  const hatMount = new THREE.Group();
  hatMount.position.set(0, 0.3, 0);
  head.add(hatMount);
  addOutlines(head, 1.05);
  mergeStatic(head, new Set([skull]));
  return { head, skull, skullMat, eyes, brows, mouth, mouths, jaw: null, jawOpen: 0, ears, hatMount, mouthTip, nose, top: 0.33, blackEye: null };
}

// -------------------------------------------------------------------- hats
export interface Fedora {
  group: THREE.Group;
  band: THREE.Mesh;
  stamp: THREE.Mesh;
}

let stampTex: THREE.CanvasTexture | null = null;
function stampTexture(): THREE.CanvasTexture {
  if (stampTex) return stampTex;
  stampTex = canvasTexture(256, 96, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255,244,223,0.92)";
    ctx.fillRect(6, 6, w - 12, h - 12);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, w - 20, h - 20);
    ctx.fillStyle = "#111";
    ctx.font = `700 46px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("KARA LİSTE", w / 2, h / 2 + 3);
    // Rubber-stamp speckles.
    ctx.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 140; i++) {
      ctx.beginPath();
      ctx.arc(Math.random() * w, Math.random() * h, Math.random() * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  return stampTex;
}

/** Gangster fedora: crown, brim, a band in the player color and a hidden "KARA LİSTE" stamp. */
export function buildFedora(hatColor: string, bandColor: string, earHoles = false): Fedora {
  const g = G();
  const group = new THREE.Group();
  const felt = mat(hatColor);
  const brim = mesh(g.brim, felt, 0, 0, 0, 1, 1, 0.92);
  group.add(brim);
  const crown = mesh(g.crown, felt, 0, 0.012, 0, 1, 1, 0.9);
  group.add(crown);
  const band = noOutline(mesh(g.cylOpen, mat(bandColor), 0, 0.04, 0, 0.176, 0.045, 0.159));
  group.add(band);
  // A little feather tucked into the band.
  const feather = noOutline(mesh(g.sphere, mat("#FFF4DF"), 0.15, 0.08, -0.04, 0.012, 0.06, 0.025));
  feather.rotation.z = -0.5;
  group.add(feather);
  if (earHoles) group.userData.earHoles = true;
  const stampMat = new THREE.MeshBasicMaterial({ map: stampTexture(), transparent: true, depthWrite: false });
  const stamp = mesh(g.plane, stampMat, 0, 0.095, 0.152, 0.2, 0.075, 1);
  stamp.rotation.set(-0.15, 0, -0.12);
  stamp.visible = false;
  stamp.userData.keepSkin = true;
  stamp.renderOrder = 3;
  group.add(stamp);
  addOutlines(group, 1.04);
  mergeStatic(group, new Set([band, stamp]));
  return { group, band, stamp };
}

/** Police cap for Komiser Rıfat. */
export function buildPoliceCap(): THREE.Group {
  const g = G();
  const group = new THREE.Group();
  const navy = mat("#1F2A4A");
  group.add(mesh(g.cyl, navy, 0, 0.06, 0, 0.18, 0.12, 0.18));
  group.add(mesh(g.cyl, navy, 0, 0.125, 0.01, 0.215, 0.035, 0.22));
  group.add(noOutline(mesh(g.cyl, mat("#111018"), 0, 0.03, 0, 0.183, 0.04, 0.183)));
  const visor = mesh(g.halfDisc, mat("#111018"), 0, 0.012, 0.17, 0.17, 0.11, 1);
  visor.rotation.x = -Math.PI / 2 + 0.3;
  (visor.material as THREE.Material).side = THREE.DoubleSide;
  visor.userData.noOutline = true;
  group.add(visor);
  const badge = noOutline(mesh(g.coneLo, new THREE.MeshToonMaterial({ color: PALETTE.gold, emissive: "#7A5200", emissiveIntensity: 0.5 }), 0, 0.075, 0.185, 0.04, 0.06, 0.012));
  badge.rotation.z = Math.PI;
  group.add(badge);
  addOutlines(group, 1.04);
  mergeStatic(group);
  return group;
}

/** Dealer's green eyeshade visor for Cemil Abi. */
export function buildVisor(): THREE.Group {
  const g = G();
  const group = new THREE.Group();
  group.add(noOutline(mesh(g.cylOpen, mat("#2E7D4F"), 0, 0.0, 0, 0.205, 0.05, 0.215)));
  const shade = new THREE.Mesh(
    g.halfDisc,
    new THREE.MeshToonMaterial({ color: "#3DDC84", emissive: "#1E8F4E", emissiveIntensity: 0.5, transparent: true, opacity: 0.72, side: THREE.DoubleSide }),
  );
  shade.scale.set(0.22, 0.2, 1);
  shade.position.set(0, -0.005, 0.19);
  shade.rotation.x = -Math.PI / 2 + 0.38;
  shade.userData.keepSkin = true;
  group.add(shade);
  return group;
}
