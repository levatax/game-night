// Builds one bean chef: jelly-bean body, puffy chef hat, googly eyes, rosy cheeks, noodle arms, apron,
// optional curly mustache / unibrow / buck tooth (picked by seat), plus the hidden extras the reactions
// need (cream-pie face, devil hat + tail, dizzy stars). Owner: client-chefs.
//
// Model units: the chef stands at y = 0, faces +Z, top of the hat at ~1.38. Chefs.ts scales it to fit.
// Hierarchy: root (seat) > lean (pivot at feet) > bounce (jump offset) > squash (scale at feet) > parts.

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { addOutlines, googlyEyes, toon } from "../toon";

export const BODY_R = 0.3;
export const BODY_L = 0.4;
export const MODEL_HEIGHT = 1.4;
/** Face anchor (squash space): roughly between the eyes and the nose. */
export const FACE_Y = 0.72;
export const FACE_Z = 0.3;
export const EYE_Y = 0.77;
export const EYE_SPACING = 0.088;
export const SHOULDER = new THREE.Vector3(0.295, 0.5, 0.02);
export const UPPER_ARM = 0.17;
export const FOREARM = 0.16;

export type Mouth = "smile" | "frown" | "o" | "grin";

export interface Arm {
  side: -1 | 1;
  shoulder: THREE.Group;
  elbow: THREE.Group;
  hand: THREE.Group;
}

export interface Cream {
  group: THREE.Group;
  drips: THREE.Group[];
  /** Slot where the pie tin gets stuck for a moment. */
  tinSlot: THREE.Group;
}

export interface ChefRig {
  root: THREE.Group;
  lean: THREE.Group;
  bounce: THREE.Group;
  squash: THREE.Group;
  body: THREE.Mesh;
  face: THREE.Object3D;
  eyes: THREE.Group;
  brows: THREE.Group[];
  mouths: Record<Mouth, THREE.Object3D>;
  mustache: THREE.Group | null;
  hat: THREE.Group;
  hatHome: THREE.Vector3;
  devilHat: THREE.Group;
  tail: THREE.Group;
  arms: [Arm, Arm];
  cream: Cream;
  stars: THREE.Group;
  bodyMat: THREE.MeshToonMaterial;
}

// --------------------------------------------------------- shared geometry
let geo: ReturnType<typeof buildGeometry> | null = null;

function beanGeometry(): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(BODY_R, BODY_L, 10, 24, 4);
  g.translate(0, BODY_R + BODY_L / 2, 0);
  // Bend into a jelly bean: belly pushed forward, top and bottom tipped back.
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = (y - 0.5) / 0.5;
    pos.setX(i, pos.getX(i) * 1.04);
    pos.setZ(i, pos.getZ(i) - 0.07 * t * t + 0.02);
  }
  pos.needsUpdate = true;
  return g;
}

function curl(points: [number, number, number][], radius: number): THREE.TubeGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return new THREE.TubeGeometry(curve, 24, radius, 6, false);
}

function starGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 0.055 : 0.024;
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.018, bevelEnabled: false });
  g.center();
  return g;
}

function buildGeometry() {
  return {
    bean: beanGeometry(),
    sphere: new THREE.SphereGeometry(1, 16, 12),
    smallSphere: new THREE.SphereGeometry(1, 10, 8),
    band: new THREE.CylinderGeometry(0.205, 0.215, 0.14, 20),
    apron: new THREE.CylinderGeometry(0.318, 0.326, 0.17, 20, 1, true, -0.95, 1.9),
    arm: new THREE.CapsuleGeometry(0.034, UPPER_ARM - 0.04, 4, 8),
    forearm: new THREE.CapsuleGeometry(0.032, FOREARM - 0.04, 4, 8),
    brow: new THREE.CapsuleGeometry(0.015, 0.065, 3, 6),
    unibrow: new THREE.CapsuleGeometry(0.017, 0.2, 3, 6),
    smile: new THREE.TorusGeometry(0.068, 0.015, 6, 16, Math.PI),
    grin: new THREE.CircleGeometry(0.085, 20, Math.PI, Math.PI),
    tongue: new THREE.CircleGeometry(0.04, 14, Math.PI, Math.PI),
    tooth: new THREE.BoxGeometry(0.034, 0.038, 0.012),
    mustacheR: curl(
      [
        [0, 0, 0],
        [0.05, -0.012, 0.004],
        [0.1, -0.004, 0.0],
        [0.135, 0.03, -0.006],
        [0.12, 0.062, -0.01],
        [0.092, 0.05, -0.008],
        [0.1, 0.03, -0.006],
      ],
      0.019,
    ),
    horn: new THREE.ConeGeometry(0.042, 0.14, 10),
    tail: curl(
      [
        [0, 0.26, -0.26],
        [0, 0.17, -0.42],
        [0.02, 0.24, -0.58],
        [0.07, 0.4, -0.6],
        [0.06, 0.5, -0.52],
      ],
      0.02,
    ),
    tailTip: new THREE.ConeGeometry(0.05, 0.1, 4),
    drip: new THREE.CapsuleGeometry(0.026, 0.07, 4, 8),
    star: starGeometry(),
  };
}

export function chefGeometry(): ReturnType<typeof buildGeometry> {
  if (!geo) geo = buildGeometry();
  return geo;
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, sx = 1, sy = sx, sz = sx): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.scale.set(sx, sy, sz);
  o.castShadow = true;
  return o;
}

const inkMat = new THREE.MeshBasicMaterial({ color: PALETTE.ink });
const mouthMat = new THREE.MeshBasicMaterial({ color: "#5A1A2E" });
const tongueMat = new THREE.MeshBasicMaterial({ color: "#FF6F91" });

/** Pie tin (built fresh for each splat since it flies off and gets thrown away). */
export function buildPieTin(): THREE.Group {
  const G = chefGeometry();
  const tin = new THREE.Group();
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.13, 0.05, 20), toon("#C9CED8"));
  dish.rotation.x = Math.PI / 2;
  tin.add(dish);
  // Crimped edge bumps.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    tin.add(mesh(G.smallSphere, toon("#E4E7EE"), Math.cos(a) * 0.165, Math.sin(a) * 0.165, -0.02, 0.022));
  }
  addOutlines(tin, 1.06);
  tin.userData.dispose = () => dish.geometry.dispose();
  return tin;
}

/** A whole flying cream pie (tin + whipped cream dome + cherry), cream side along +Y. */
export function buildFlyingPie(): THREE.Group {
  const G = chefGeometry();
  const pie = new THREE.Group();
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.13, 0.05, 20), toon("#C9CED8"));
  pie.add(dish);
  pie.add(mesh(G.sphere, toon("#FFFFFF"), 0, 0.03, 0, 0.17, 0.07, 0.17));
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    pie.add(mesh(G.sphere, toon("#FFF6E8"), Math.cos(a) * 0.11, 0.07, Math.sin(a) * 0.11, 0.045));
  }
  pie.add(mesh(G.sphere, toon("#E8203A"), 0, 0.12, 0, 0.035));
  addOutlines(pie, 1.06);
  pie.userData.dispose = () => dish.geometry.dispose();
  return pie;
}

export function buildChef(colorHex: string, seat: number): ChefRig {
  const G = chefGeometry();
  const color = new THREE.Color(colorHex);
  const root = new THREE.Group();
  root.name = "chef";
  const lean = new THREE.Group();
  const bounce = new THREE.Group();
  const squash = new THREE.Group();
  root.add(lean);
  lean.add(bounce);
  bounce.add(squash);

  // Body.
  const bodyMat = toon(color);
  const body = mesh(G.bean, bodyMat);
  squash.add(body);

  // Apron (white, with a pocket and a tiny heart in the player color).
  const apron = mesh(G.apron, toon("#FFFFFF", { unique: true }), 0, 0.395, 0.017);
  apron.userData.noOutline = true;
  (apron.material as THREE.MeshToonMaterial).side = THREE.DoubleSide;
  squash.add(apron);
  const heart = new THREE.Group();
  heart.position.set(0.1, 0.42, 0.33);
  heart.add(mesh(G.smallSphere, toon(color.clone().offsetHSL(0, 0, -0.1)), -0.014, 0.008, 0, 0.02));
  heart.add(mesh(G.smallSphere, toon(color.clone().offsetHSL(0, 0, -0.1)), 0.014, 0.008, 0, 0.02));
  const hb = mesh(G.smallSphere, toon(color.clone().offsetHSL(0, 0, -0.1)), 0, -0.01, 0, 0.022, 0.026, 0.012);
  heart.add(hb);
  heart.traverse((o) => (o.userData.noOutline = true));
  squash.add(heart);

  // Feet: shiny black clown-ish shoes.
  for (const s of [-1, 1]) squash.add(mesh(G.sphere, toon("#3A3446"), s * 0.12, 0.035, 0.13, 0.085, 0.045, 0.13));

  // Face.
  const face = new THREE.Object3D();
  face.position.set(0, FACE_Y, FACE_Z);
  squash.add(face);

  const eyes = googlyEyes(0.07, EYE_SPACING);
  eyes.position.set(0, EYE_Y, 0.272);
  squash.add(eyes);

  const brows: THREE.Group[] = [];
  if (seat % 6 === 4) {
    const b = new THREE.Group();
    b.position.set(0, 0.875, 0.258);
    const m = mesh(G.unibrow, inkMat);
    m.rotation.z = Math.PI / 2;
    b.add(m);
    b.userData.side = 0;
    brows.push(b);
  } else {
    for (const s of [-1, 1] as const) {
      const b = new THREE.Group();
      b.position.set(s * EYE_SPACING, 0.872, 0.255);
      const m = mesh(G.brow, inkMat);
      m.rotation.z = Math.PI / 2;
      b.add(m);
      b.userData.side = s;
      brows.push(b);
    }
  }
  for (const b of brows) {
    b.userData.home = b.position.clone();
    squash.add(b);
  }

  // Rosy cheeks + clown nose.
  const cheekMat = toon("#FF8FB1");
  for (const s of [-1, 1]) {
    const c = mesh(G.sphere, cheekMat, s * 0.175, 0.645, 0.262, 0.058, 0.04, 0.02);
    c.userData.noOutline = true;
    squash.add(c);
  }
  squash.add(mesh(G.sphere, toon("#FF6B6B"), 0, 0.69, 0.312, 0.042));

  // Mouths (one visible at a time).
  const smile = mesh(G.smile, inkMat, 0, 0.62, 0.312);
  smile.rotation.z = Math.PI;
  const frown = mesh(G.smile, inkMat, 0, 0.545, 0.31);
  const o = mesh(G.sphere, mouthMat, 0, 0.58, 0.31, 0.05, 0.062, 0.018);
  const grin = new THREE.Group();
  grin.position.set(0, 0.625, 0.318);
  grin.add(new THREE.Mesh(G.grin, mouthMat));
  const tongue = new THREE.Mesh(G.tongue, tongueMat);
  tongue.position.set(0, -0.045, 0.002);
  grin.add(tongue);
  const mouths: Record<Mouth, THREE.Object3D> = { smile, frown, o, grin };
  for (const m of Object.values(mouths)) {
    m.traverse((c) => (c.userData.noOutline = true));
    m.visible = false;
    squash.add(m);
  }
  smile.visible = true;
  if (seat % 6 === 2) {
    const tooth = mesh(G.tooth, toon("#FFFFFF"), 0.014, 0.6, 0.322);
    tooth.userData.noOutline = true;
    squash.add(tooth);
  }

  // Ridiculous curly mustache on odd seats.
  let mustache: THREE.Group | null = null;
  if (seat % 2 === 1) {
    mustache = new THREE.Group();
    mustache.position.set(0, 0.645, 0.322);
    const mm = toon("#5A3A22");
    const r = new THREE.Mesh(G.mustacheR, mm);
    const l = new THREE.Mesh(G.mustacheR, mm);
    l.scale.x = -1;
    mustache.add(r, l);
    mustache.traverse((c) => (c.userData.noOutline = true));
    squash.add(mustache);
  }

  // Puffy chef hat, lightly tinted with the player color.
  const hatHome = new THREE.Vector3(0, 0.93, -0.03);
  const hat = new THREE.Group();
  hat.position.copy(hatHome);
  const hatMat = toon(new THREE.Color("#FFFFFF").lerp(color, 0.3));
  hat.add(mesh(G.band, toon("#FFFFFF"), 0, 0.05, 0));
  hat.add(mesh(G.sphere, hatMat, 0, 0.25, 0, 0.18, 0.15, 0.18));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    hat.add(mesh(G.sphere, hatMat, Math.cos(a) * 0.12, 0.2 + (i % 2) * 0.03, Math.sin(a) * 0.12, 0.12));
  }
  squash.add(hat);

  // Tiny devil hat + horns (hidden until the reveal).
  const devilHat = new THREE.Group();
  devilHat.position.copy(hatHome);
  const red = toon("#E5323B");
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.17, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), red);
  cap.scale.y = 0.5;
  devilHat.add(cap);
  for (const s of [-1, 1]) {
    const h = mesh(G.horn, red, s * 0.1, 0.11, 0);
    h.rotation.z = -s * 0.55;
    devilHat.add(h);
  }
  devilHat.visible = false;
  devilHat.scale.setScalar(0.001);
  squash.add(devilHat);

  const tail = new THREE.Group();
  tail.add(new THREE.Mesh(G.tail, red));
  const tip = mesh(G.tailTip, red, 0.06, 0.53, -0.5);
  tip.rotation.set(-0.6, 0, -0.3);
  tip.scale.set(1, 1, 0.4);
  tail.add(tip);
  tail.visible = false;
  tail.scale.setScalar(0.001);
  squash.add(tail);

  // Noodle arms: shoulder > upper arm > elbow > forearm > white glove.
  const arms: Arm[] = [];
  for (const s of [-1, 1] as const) {
    const shoulder = new THREE.Group();
    shoulder.position.set(s * SHOULDER.x, SHOULDER.y, SHOULDER.z);
    const upper = mesh(G.arm, bodyMat, 0, -UPPER_ARM / 2, 0);
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -UPPER_ARM;
    shoulder.add(elbow);
    elbow.add(mesh(G.forearm, bodyMat, 0, -FOREARM / 2, 0));
    const hand = new THREE.Group();
    hand.position.y = -FOREARM;
    elbow.add(hand);
    const glove = toon("#FFFFFF");
    hand.add(mesh(G.sphere, glove, 0, -0.02, 0, 0.058, 0.052, 0.045));
    hand.add(mesh(G.sphere, glove, -s * 0.045, 0.0, 0.02, 0.022));
    squash.add(shoulder);
    arms.push({ side: s, shoulder, elbow, hand });
  }

  // Dizzy stars (circle the head after a pie).
  const stars = new THREE.Group();
  stars.position.set(0, 1.08, 0);
  const starMat = toon("#FFD84A");
  for (let i = 0; i < 3; i++) {
    const st = new THREE.Mesh(G.star, starMat);
    st.userData.phase = (i / 3) * Math.PI * 2;
    stars.add(st);
  }
  stars.visible = false;
  squash.add(stars);

  // Cream face (hidden until SPLAT).
  const cream = buildCream();
  squash.add(cream.group);

  addOutlines(squash, 1.05);
  return {
    root,
    lean,
    bounce,
    squash,
    body,
    face,
    eyes,
    brows,
    mouths,
    mustache,
    hat,
    hatHome,
    devilHat,
    tail,
    arms: arms as [Arm, Arm],
    cream,
    stars,
    bodyMat,
  };
}

function buildCream(): Cream {
  const G = chefGeometry();
  const white = toon("#FFFFFF");
  const off = toon("#FFF4E2");
  const group = new THREE.Group();
  group.position.set(0, 0.7, 0.285);
  group.add(mesh(G.sphere, white, 0, 0, 0, 0.23, 0.19, 0.075));
  const blobs: [number, number, number, number][] = [
    [-0.17, 0.08, 0.02, 0.08],
    [0.16, 0.1, 0.01, 0.075],
    [0.19, -0.07, 0.0, 0.07],
    [-0.15, -0.1, 0.02, 0.07],
    [0.03, 0.17, 0.0, 0.08],
    [-0.04, -0.16, 0.03, 0.06],
  ];
  for (const [x, y, z, r] of blobs) group.add(mesh(G.sphere, off, x, y, z, r, r, r * 0.6));
  // A cherry stuck on the forehead, obviously.
  group.add(mesh(G.sphere, toon("#E8203A"), 0.06, 0.2, 0.05, 0.035));
  const drips: THREE.Group[] = [];
  const dripX = [-0.14, -0.05, 0.07, 0.15];
  for (let i = 0; i < dripX.length; i++) {
    const d = new THREE.Group();
    d.position.set(dripX[i]!, -0.13 - (i % 2) * 0.03, 0.03);
    d.add(mesh(G.drip, white, 0, -0.06, 0));
    d.userData.speed = 0.6 + Math.random() * 0.8;
    group.add(d);
    drips.push(d);
  }
  const tinSlot = new THREE.Group();
  tinSlot.position.z = 0.09;
  group.add(tinSlot);
  group.visible = false;
  return { group, drips, tinSlot };
}

/**
 * Wobbly wooden kitchen stool that lifts the chef so its face clears the table edge. Top surface at
 * y = 0; call `setStoolHeight(stool, h)` to stretch the legs down to the floor (model units).
 */
export function buildStool(): THREE.Group {
  const G = chefGeometry();
  const wood = toon("#B5743B");
  const stool = new THREE.Group();
  stool.name = "stool";
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.25, 0.07, 20), wood);
  top.position.y = -0.035;
  stool.add(top);
  stool.add(mesh(G.sphere, toon("#FFF1D6"), 0, 0.0, 0, 0.22, 0.03, 0.22));
  const legs = new THREE.Group();
  legs.name = "legs";
  legs.position.y = -0.07;
  const legGeo = new THREE.CylinderGeometry(0.028, 0.034, 1, 8);
  legGeo.translate(0, -0.5, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(Math.cos(a) * 0.17, 0, Math.sin(a) * 0.17);
    leg.rotation.set(Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12);
    legs.add(leg);
  }
  stool.add(legs);
  addOutlines(stool, 1.06);
  stool.userData.dispose = () => {
    top.geometry.dispose();
    legGeo.dispose();
  };
  return stool;
}

export function setStoolHeight(stool: THREE.Group, h: number): void {
  const legs = stool.getObjectByName("legs");
  if (legs) legs.scale.y = Math.max(0.01, h - 0.07);
  stool.visible = h > 0.08;
}
