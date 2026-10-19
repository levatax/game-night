// One builder per piece type. Each fills rig.body with meshes modelled on PIECES[type].colliders (same local
// frame, COM at the origin; Rapier half extents, cylinder/capsule axis = local Y) and adds the piece's
// personality: googly eyes, faces, and little idle/impact anims (toast pops, chicken neck flops, fish tail
// flaps, teapot steam, soap bubbles, egg cracks, cherry sparkles).

import * as THREE from "three";
import type { PieceType } from "../../../../shared/constants";
import { PIECES } from "../../../../shared/constants";
import { toonRamp } from "../toon";
import {
  G, INK, M, PINK, WHITE, blob, cachedMat, canvasTex, cheeks, detail, eye, eyes, faceted, facePlate, geo, mesh,
  mustache, openMouth, orient, smile, softMat, sparkleMat, sprinkleGeo, sprinkleMat, sprite,
  type PieceRig,
} from "./kit";

const C = (t: PieceType) => PIECES[t].colors;
const PI = Math.PI;

/** Point on a sphere of radius r: theta from +Y (0 = top), phi around Y (0 = +Z, PI/2 = +X). */
function sph(r: number, theta: number, phi: number): [number, number, number] {
  return [r * Math.sin(theta) * Math.sin(phi), r * Math.cos(theta), r * Math.sin(theta) * Math.cos(phi)];
}
function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// ------------------------------------------------------------------ jelly: nervous wobbly dome
function jelly(r: PieceRig): void {
  const [main, accent] = C("jelly");
  const prof: [number, number][] = [
    [0, -0.06], [0.07, -0.06], [0.075, -0.055], [0.076, -0.044], [0.07, -0.034], [0.076, -0.022], [0.075, -0.008],
    [0.07, 0.006], [0.072, 0.015], [0.064, 0.028], [0.057, 0.04], [0.045, 0.06], [0.03, 0.072], [0.015, 0.078], [0, 0.08],
  ];
  mesh(G.lathe("jelly", prof, 28), M(main), r.body);
  // Shiny highlight blobs (jelly is glossy).
  blob(M(accent), r.body, [-0.035, 0.055, 0.025], [0.014, 0.009, 0.008]).rotation.set(0.3, 0.4, 0.6);
  blob(M(accent), r.body, [-0.055, 0.02, 0.045], [0.006, 0.004, 0.004]);
  const face = facePlate(r.body, [0, 0.028, 0.063], [0, 0.35, 1]);
  eyes(r, face, { size: 0.017, spacing: 0.024, brows: "worried" });
  openMouth(face, 0.014, 0.017, { y: -0.04 });
  cheeks(face, 0.04, 0.008, -0.03);
  r.jelly = true;
}

// ------------------------------------------------------------------ rubber chicken: floppy neck, tongue out
function chicken(r: PieceRig): void {
  const [main, accent] = C("chicken");
  const bodyM = mesh(G.capsule(0.035, 0.18), M(main), r.body);
  bodyM.rotation.z = PI / 2;
  // Wings (sad little flaps).
  for (const s of [-1, 1]) blob(M(main), r.body, [-0.01, 0.008, s * 0.034], [0.05, 0.02, 0.009], true).rotation.y = s * 0.15;
  // Tail feathers.
  for (let i = 0; i < 3; i++) blob(M("#FFF3A8"), r.body, [-0.125, 0.018 + i * 0.008, (i - 1) * 0.012], [0.018, 0.008, 0.006], true).rotation.z = 0.6 + i * 0.2;
  // Dangly legs lying backwards, with three-toed feet.
  for (const s of [-1, 1]) {
    const leg = mesh(G.cyl(0.004, 0.004, 0.05, 6), M(accent), r.body, -0.105, -0.022, s * 0.014);
    leg.rotation.z = PI / 2 + 0.25;
    for (let t = -1; t <= 1; t++) {
      const toe = mesh(G.cone(0.004, 0.018, 5), M(accent), r.body, -0.135, -0.03, s * 0.014 + t * 0.006);
      toe.rotation.set(0, 0, PI / 2 + t * 0.0);
      toe.rotation.y = t * 0.5;
    }
  }
  // Floppy neck: pivot at the shoulder, head at (0.13, 0.03) when straight.
  const neck = new THREE.Group();
  neck.position.set(0.09, 0.0, 0);
  r.body.add(neck);
  const neckM = mesh(G.capsule(0.02, 0.03), M(main), neck, 0.02, 0.015, 0);
  neckM.rotation.z = -0.9;
  const head = new THREE.Group();
  head.position.set(0.04, 0.03, 0);
  neck.add(head);
  mesh(G.sphere(0.04, 16, 12), M(main), head);
  const beak = mesh(G.cone(0.014, 0.034, 8), M(accent), head, 0.048, -0.004, 0);
  beak.rotation.z = -PI / 2;
  // Tongue flopping out of the beak.
  const tongue = blob(M(PINK), head, [0.058, -0.016, 0], [0.012, 0.004, 0.007]);
  tongue.rotation.z = -0.5;
  // Comb + wattle.
  for (let i = 0; i < 3; i++) mesh(G.sphere(0.011, 8, 6), M("#FF5A5F"), head, -0.012 + i * 0.013, 0.04 - Math.abs(i - 1) * 0.004, 0);
  blob(M("#FF5A5F"), head, [0.035, -0.03, 0], [0.008, 0.012, 0.006], true);
  const face = facePlate(head, [0.03, 0.017, 0], [1, 0.35, 0]);
  eyes(r, face, { sizes: [0.017, 0.012], spacing: 0.019 });
  r.parts.neck = neck;
  r.vars.neck = -0.1;
  r.vars.neckV = 0;
  r.anims.push((rig, dt, t, speed) => {
    // Damped spring around a droopy rest angle; motion and random flops kick it.
    const rest = -0.18 + Math.sin(t * 1.1 + rig.seed * 9) * 0.05;
    const a = -(rig.vars.neck - rest) * 70 - rig.vars.neckV * 4;
    rig.vars.neckV += (a + (Math.random() - 0.5) * speed * 60) * dt;
    rig.vars.neck += rig.vars.neckV * dt;
    rig.vars.neck = THREE.MathUtils.clamp(rig.vars.neck, -0.5, 0.35);
    rig.parts.neck.rotation.z = rig.vars.neck;
  });
  r.hits.push((rig, k) => {
    rig.vars.neckV += (Math.random() < 0.5 ? -1 : 1) * 10 * k;
  });
}

// ------------------------------------------------------------------ fish: goofy pout, flappy tail
function fish(r: PieceRig): void {
  const [main, accent] = C("fish");
  const bodyM = mesh(G.capsule(0.04, 0.16, 14), M(main), r.body);
  bodyM.rotation.z = PI / 2;
  bodyM.scale.set(1, 1, 0.82);
  // Belly stripe + spots.
  blob(M("#E8F6FF"), r.body, [0.01, -0.02, 0], [0.09, 0.02, 0.03]);
  for (const [x, y] of [[-0.04, 0.025], [0.0, 0.03], [-0.07, 0.015]]) {
    for (const s of [-1, 1]) blob(M(accent), r.body, [x, y, s * 0.029], [0.008, 0.008, 0.003]);
  }
  // Dorsal + side fins.
  const finGeo = geo("fishFin", () => {
    const sh = new THREE.Shape();
    sh.moveTo(-0.04, 0);
    sh.quadraticCurveTo(-0.01, 0.035, 0.03, 0.0);
    sh.lineTo(-0.04, 0);
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.006, bevelEnabled: false });
    g.translate(0, 0, -0.003);
    return g;
  });
  mesh(finGeo, M(accent), r.body, -0.01, 0.033, 0);
  for (const s of [-1, 1]) {
    const pf = mesh(finGeo, M(accent), r.body, 0.03, -0.01, s * 0.03);
    pf.scale.setScalar(0.45);
    pf.rotation.set(s * 1.2, 0, -0.6);
  }
  // Tail (two lobes) on a pivot so it can flap.
  const tail = new THREE.Group();
  tail.position.set(-0.11, 0, 0);
  r.body.add(tail);
  const tailGeo = geo("fishTail", () => {
    const sh = new THREE.Shape();
    sh.moveTo(0.005, 0);
    sh.lineTo(-0.06, 0.05);
    sh.quadraticCurveTo(-0.045, 0, -0.06, -0.05);
    sh.lineTo(0.005, 0);
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.012, bevelEnabled: false });
    g.translate(0, 0, -0.006);
    return g;
  });
  mesh(tailGeo, M(accent), tail);
  // Big pouty lips.
  for (const s of [-1, 1]) blob(M("#FF7FA8"), r.body, [0.123, s * 0.009, 0], [0.013, 0.008, 0.019], true);
  // One googly eye per side + gill smiles.
  for (const s of [-1, 1]) {
    const plate = facePlate(r.body, [0.072, 0.014, s * 0.03], [0.25, 0.25, s]);
    eye(r, plate, s > 0 ? 0.019 : 0.015);
    const gill = facePlate(r.body, [0.035, -0.003, s * 0.033], [0, 0, s]);
    smile(gill, 0.03, { arc: PI * 0.6, tilt: s * PI / 2 });
  }
  r.parts.tail = tail;
  r.anims.push((rig, _dt, t, speed) => {
    const f = 5 + Math.min(speed, 3) * 8;
    rig.parts.tail.rotation.y = Math.sin(t * f + rig.seed * 20) * (0.12 + Math.min(speed, 2) * 0.35);
  });
}

// ------------------------------------------------------------------ toaster: derpy smile, toast pops up
function toaster(r: PieceRig): void {
  const [main, accent] = C("toaster");
  mesh(G.rbox(0.2, 0.15, 0.12, 0.022), M(main), r.body);
  // Chrome stripe + slots.
  mesh(G.rbox(0.204, 0.02, 0.124, 0.008), M(accent), r.body, 0, -0.045, 0);
  for (const z of [-0.025, 0.025]) detail(G.box(0.145, 0.004, 0.024), INK, r.body, 0, 0.0745, z);
  // Lever + dial on the side.
  mesh(G.rbox(0.02, 0.014, 0.03, 0.005), M("#FF5A5F"), r.body, 0.108, 0.035, 0.01);
  const dial = mesh(G.cyl(0.012, 0.012, 0.008, 12), M(accent), r.body, 0.103, -0.01, -0.02);
  dial.rotation.z = PI / 2;
  // Two slices of toast hiding in the slots (they pop!).
  const toastG = new THREE.Group();
  r.body.add(toastG);
  const slices: THREE.Object3D[] = [];
  for (const z of [-0.025, 0.025]) {
    const sl = new THREE.Group();
    sl.position.set(0, 0.035, z);
    toastG.add(sl);
    mesh(G.rbox(0.12, 0.085, 0.016, 0.02), M("#E8B060"), sl);
    mesh(G.rbox(0.106, 0.07, 0.018, 0.016), M("#F6D59A"), sl, 0, 0.002, 0);
    blob(M("#8B5A2B"), sl, [0.025, 0.02, 0.0095], [0.012, 0.008, 0.002]); // burnt spot
    slices.push(sl);
  }
  // The front slice has its own tiny shocked eyes.
  const tf = facePlate(slices[1], [0, 0.022, 0.01], [0, 0, 1]);
  eyes(r, tf, { size: 0.007, spacing: 0.012 });
  openMouth(tf, 0.008, 0.009, { y: -0.016 });
  // Derpy face: mismatched eyes, huge smile, one buck tooth.
  const face = facePlate(r.body, [0, 0.022, 0.06], [0, 0, 1]);
  eyes(r, face, { sizes: [0.024, 0.017], spacing: 0.036 });
  smile(face, 0.085, { arc: PI * 0.75, y: -0.05, thick: 0.005 });
  detail(G.box(0.012, 0.014, 0.004), M(WHITE), face, 0.006, -0.064, 0.003);
  cheeks(face, 0.065, 0.012, -0.035);
  r.parts.s0 = slices[0];
  r.parts.s1 = slices[1];
  r.vars.y0 = 0; r.vars.v0 = 0; r.vars.y1 = 0; r.vars.v1 = 0;
  r.vars.next = 3 + r.seed * 6;
  const pop = (rig: PieceRig, k: number) => {
    if (rig.vars.y0 > 0.002 || rig.vars.y1 > 0.002) return;
    rig.vars.v0 = 0.8 + k * 0.5 + Math.random() * 0.15;
    rig.vars.v1 = 0.8 + k * 0.5 + Math.random() * 0.15;
  };
  r.anims.push((rig, dt, t) => {
    if (rig.vars.next <= 0) rig.vars.next = t + 4 + Math.random() * 6;
    if (t > rig.vars.next) {
      pop(rig, 0);
      rig.vars.next = t + 5 + Math.random() * 7;
    }
    for (const i of [0, 1]) {
      let y = rig.vars[`y${i}`];
      let v = rig.vars[`v${i}`];
      if (y > 0 || v > 0) {
        v -= 9.81 * dt;
        y += v * dt;
        if (y <= 0) {
          y = 0;
          v = v < -0.3 ? -v * 0.25 : 0;
        }
      }
      rig.vars[`y${i}`] = y;
      rig.vars[`v${i}`] = v;
      const s = rig.parts[`s${i}`];
      s.position.y = 0.035 + y;
      s.rotation.x = y * (i ? 2.5 : -2.5);
    }
  });
  r.hits.push((rig, k) => {
    if (k > 0.25) pop(rig, k);
  });
}

// ------------------------------------------------------------------ donut: sprinkles, sugar-high eyes
function donut(r: PieceRig): void {
  const [main, accent] = C("donut");
  const R = 0.052;
  const dough = mesh(G.torus(R, 0.028, PI * 2, 28), M(main), r.body);
  dough.rotation.x = PI / 2;
  dough.scale.z = 0.88;
  const icing = mesh(G.torus(R, 0.027, PI * 2, 28), M(accent), r.body, 0, 0.007, 0);
  icing.rotation.x = PI / 2;
  icing.scale.z = 0.66;
  // Drippy icing blobs over the outer edge.
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * PI * 2 + 0.3;
    blob(M(accent), r.body, [Math.sin(a) * 0.074, 0.001, Math.cos(a) * 0.074], [0.009, 0.012, 0.009]);
  }
  const sg = sprinkleGeo("donut", 26, (rnd) => {
    const a = rnd() * PI * 2;
    const rho = R + (rnd() - 0.5) * 0.034;
    const h = 0.007 + 0.66 * Math.sqrt(Math.max(0, 0.027 ** 2 - (rho - R) ** 2));
    return [Math.sin(a) * rho, h, Math.cos(a) * rho, rnd() * PI, (rho - R) * 12];
  });
  detail(sg, sprinkleMat(), r.body);
  const face = facePlate(r.body, [0, 0.006, 0.077], [0, 0.15, 1]);
  eyes(r, face, { sizes: [0.016, 0.019], spacing: 0.022 });
  smile(face, 0.024, { y: -0.017, arc: PI * 0.9, thick: 0.0028 });
}

// ------------------------------------------------------------------ banana: peel-fect mustache
function banana(r: PieceRig): void {
  const [main, accent] = C("banana");
  const g = geo("bananaTube", () => {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.128, -0.004, 0), new THREE.Vector3(-0.075, 0.022, 0), new THREE.Vector3(0, 0.04, 0),
      new THREE.Vector3(0.075, 0.022, 0), new THREE.Vector3(0.128, -0.004, 0),
    ]);
    const N = 28;
    const RAD = 12;
    const tube = new THREE.TubeGeometry(curve, N, 0.027, RAD, false);
    // Taper the ends (TubeGeometry is constant radius): ring i sits at curve.getPointAt(i / N).
    const pos = tube.getAttribute("position") as THREE.BufferAttribute;
    const c = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      curve.getPointAt(u, c);
      const f = 0.3 + 0.7 * Math.pow(Math.sin(PI * u), 0.45);
      for (let j = 0; j <= RAD; j++) {
        const k = i * (RAD + 1) + j;
        v.fromBufferAttribute(pos, k).sub(c).multiplyScalar(f).add(c);
        pos.setXYZ(k, v.x, v.y, v.z);
      }
    }
    tube.computeVertexNormals();
    return tube;
  });
  mesh(g, M(main), r.body);
  // Stem + dark tip.
  const stem = mesh(G.cyl(0.006, 0.008, 0.022, 8), M(accent), r.body, 0.136, 0.0, 0);
  stem.rotation.z = PI / 2 + 0.6;
  mesh(G.sphere(0.008, 8, 6), M(accent), r.body, -0.13, -0.006, 0);
  // Brown bruise spots.
  blob(M("#C8A21A"), r.body, [-0.06, 0.03, 0.017], [0.006, 0.004, 0.002]);
  blob(M("#C8A21A"), r.body, [0.07, 0.03, 0.016], [0.004, 0.003, 0.002]);
  const face = facePlate(r.body, [0, 0.048, 0.02], [0, 0.35, 1]);
  eyes(r, face, { size: 0.014, spacing: 0.018, brows: "posh" });
  mustache(face, 0.05, accent, -0.02);
}

// ------------------------------------------------------------------ teapot: posh, steaming
function teapot(r: PieceRig): void {
  const [main, accent] = C("teapot");
  mesh(G.sphere(0.08, 22, 16), M(main), r.body);
  const band = mesh(G.torus(0.079, 0.006, PI * 2, 36), M(accent), r.body, 0, -0.02, 0);
  band.rotation.x = PI / 2;
  band.scale.setScalar(0.98);
  // Polka dots.
  for (const [th, ph] of [[0.9, 2.2], [1.2, 3.4], [0.7, 4.3], [1.0, -0.9], [0.6, 1.2], [1.25, 2.8]]) {
    const p = sph(0.0805, th, ph);
    const d = detail(G.cyl(0.009, 0.009, 0.002, 10), M(accent), r.body);
    orient(d, p, norm(p));
    d.rotateX(PI / 2);
  }
  // Lid + knob.
  mesh(G.cyl(0.042, 0.046, 0.012, 20), M(main), r.body, 0, 0.074, 0);
  mesh(G.sphere(0.012, 10, 8), M(accent), r.body, 0, 0.088, 0);
  // Spout along the capsule collider: center (0.1, 0.02), axis tilted 60° from +Y toward +X.
  const spout = mesh(G.cyl(0.01, 0.018, 0.085, 10), M(main), r.body, 0.1, 0.02, 0);
  spout.rotation.z = -PI / 3;
  // Handle: a "C" on the -X side.
  const handle = mesh(G.torus(0.03, 0.009, PI * 1.1, 16), M(accent), r.body, -0.082, 0.012, 0);
  handle.rotation.z = PI / 2 - 0.05 * PI;
  const face = facePlate(r.body, [0, 0.018, 0.075], [0, 0.22, 1]);
  eyes(r, face, { size: 0.017, spacing: 0.026, lids: 0.4, lidColor: main, brows: "posh" });
  openMouth(face, 0.01, 0.012, { y: -0.03 });
  cheeks(face, 0.042, 0.01, -0.022);
  // Steam puffs out of the spout tip.
  const tip: [number, number, number] = [0.1 + 0.866 * 0.045, 0.02 + 0.5 * 0.045, 0];
  const puffs: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) puffs.push(detail(G.sphere(0.012, 10, 8), softMat("#FFFFFF", 0.6), r.body, ...tip));
  r.anims.push((rig, _dt, t) => {
    for (let i = 0; i < puffs.length; i++) {
      const u = (t * 0.6 + i / puffs.length + rig.seed) % 1;
      const p = puffs[i];
      p.position.set(tip[0] + u * 0.03 + Math.sin(u * 9 + i) * 0.006, tip[1] + u * 0.07, Math.sin(u * 7 + i * 2) * 0.008);
      p.scale.setScalar(0.4 + u * 1.1 * (1 - u * u));
    }
  });
}

// ------------------------------------------------------------------ cheese: buck-toothed, holey
function cheese(r: PieceRig): void {
  const [main, accent] = C("cheese");
  const g = geo("cheeseBlock", () => {
    const sh = new THREE.Shape();
    sh.moveTo(-0.09, -0.04);
    sh.lineTo(0.09, -0.04);
    sh.lineTo(0.09, 0.024);
    sh.lineTo(-0.09, 0.04);
    sh.closePath();
    const e = new THREE.ExtrudeGeometry(sh, { depth: 0.12, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.004, bevelSegments: 2 });
    e.translate(0, 0, -0.06);
    e.scale(0.96, 0.92, 0.94);
    return e;
  });
  mesh(g, M(main), r.body);
  // Holes on every face.
  const holes: [number, number, number, number, number, number, number][] = [
    // x, y, z, sx, sy, sz, rotY
    [0.05, -0.012, 0.058, 0.012, 0.01, 0.003, 0], [0.07, 0.012, 0.058, 0.006, 0.006, 0.003, 0],
    [0.088, -0.01, 0.02, 0.003, 0.012, 0.014, 0], [0.088, 0.008, -0.03, 0.003, 0.007, 0.008, 0],
    [-0.04, 0.0, -0.058, 0.014, 0.012, 0.003, 0], [0.03, -0.02, -0.058, 0.007, 0.007, 0.003, 0],
    [-0.088, -0.015, 0.0, 0.003, 0.01, 0.012, 0],
  ];
  for (const [x, y, z, sx, sy, sz] of holes) blob(M(accent), r.body, [x, y, z], [sx, sy, sz]);
  // Top holes (the top slopes from 0.04 at -X to 0.024 at +X, scaled ×0.92).
  for (const [x, z, s] of [[-0.03, -0.02, 0.012], [0.04, 0.025, 0.008], [0.0, 0.03, 0.006]]) {
    const y = (0.04 + ((x + 0.09) / 0.18) * (0.024 - 0.04)) * 0.92;
    blob(M(accent), r.body, [x, y, z], [s, 0.003, s]);
  }
  const face = facePlate(r.body, [-0.03, 0.008, 0.0605], [0, 0, 1]);
  eyes(r, face, { size: 0.016, spacing: 0.021 });
  openMouth(face, 0.034, 0.018, { y: -0.027, buck: true, tongue: true });
}

// ------------------------------------------------------------------ spatula: eyes up top, says "flip!"
function spatula(r: PieceRig): void {
  const [main, accent] = C("spatula");
  mesh(G.rbox(0.12, 0.012, 0.09, 0.005), M(main), r.body, 0.08, 0, 0);
  for (const z of [-0.024, 0, 0.024]) detail(G.rbox(0.05, 0.003, 0.008, 0.0015), INK, r.body, 0.06, 0.0055, z);
  mesh(G.rbox(0.03, 0.012, 0.022, 0.004), M("#C9D1D9"), r.body, 0.012, 0, 0);
  mesh(G.rbox(0.16, 0.016, 0.024, 0.007), M(accent), r.body, -0.06, 0, 0);
  const ring = detail(G.torus(0.006, 0.002, PI * 2, 12), M("#C9D1D9"), r.body, -0.122, 0.0085, 0);
  ring.rotation.x = PI / 2;
  // Face looks up at the sky from the paddle (its "up" is the paddle tip, +X).
  const face = facePlate(r.body, [0.112, 0.007, 0], [0, 1, 0], [1, 0, 0]);
  eyes(r, face, { size: 0.012, spacing: 0.018 });
  smile(face, 0.024, { y: -0.018, arc: PI * 0.85 });
}

// ------------------------------------------------------------------ egg: angry eyebrows, cracks when hit
function egg(r: PieceRig): void {
  const [main] = C("egg");
  const pts: [number, number][] = [];
  const N = 18;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const u = 2 * t - 1;
    const rad = 0.035 * Math.sqrt(Math.max(0, 1 - u * u)) * (1 - 0.12 * u);
    pts.push([i === 0 || i === N ? 0 : rad, -0.05 + 0.1 * t]);
  }
  mesh(G.lathe("egg", pts, 22), M(main), r.body);
  // Freckles.
  for (const [th, ph] of [[1.0, 2.0], [1.6, 3.5], [0.8, 4.4]]) {
    const p = sph(0.033, th, ph);
    blob(M("#E8D5B0"), r.body, p, [0.003, 0.003, 0.003]);
  }
  const face = facePlate(r.body, [0, 0.012, 0.032], [0, 0.15, 1]);
  eyes(r, face, { size: 0.013, spacing: 0.016, brows: "angry" });
  smile(face, 0.016, { frown: true, y: -0.022, arc: PI * 0.7 });
  // Zig-zag crack, hidden until a good bonk.
  const crack = facePlate(r.body, [0.016, -0.022, 0.026], [0.45, -0.3, 0.85]);
  const zig: [number, number, number][] = [[-0.008, 0.002, 0.7], [0, -0.001, -0.8], [0.008, 0.002, 0.7]];
  for (const [x, y, a] of zig) detail(G.box(0.01, 0.0018, 0.002), INK, crack, x, y, 0).rotation.z = a;
  crack.visible = false;
  r.parts.crack = crack;
  r.parts.face = face;
  r.hits.push((rig, k) => {
    if (k > 0.2) {
      rig.parts.crack.visible = true;
      rig.vars.rage = 1;
    }
  });
  r.anims.push((rig, dt) => {
    // Seething: trembles for a while after being cracked.
    const rage = rig.vars.rage ?? 0;
    if (rage > 0) {
      rig.vars.rage = Math.max(0, rage - dt * 0.5);
      rig.parts.face.position.x = (Math.random() - 0.5) * 0.002 * rage;
    }
  });
}

// ------------------------------------------------------------------ pancakes: a stack of three, syrupy
function pancakes(r: PieceRig): void {
  const [main, accent] = C("pancakes");
  const prof: [number, number][] = [[0, -0.013], [0.08, -0.013], [0.086, -0.01], [0.088, 0], [0.086, 0.01], [0.08, 0.013], [0, 0.013]];
  const pg = G.lathe("pancake", prof, 28);
  const offs = [[0.002, -0.027, -0.001, 0.0], [-0.003, 0, 0.002, 0.4], [0.002, 0.026, -0.002, 1.1]];
  for (const [x, y, z, ry] of offs) {
    const p = mesh(pg, M(main), r.body, x, y, z);
    p.rotation.y = ry;
    p.scale.set(0.99, 1, 0.99);
  }
  // Syrup pool on top + drips over the edge.
  mesh(G.cyl(0.07, 0.074, 0.004, 24), M(accent), r.body, 0.002, 0.0395, -0.002);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * PI * 2 + 0.7;
    const len = 0.012 + (i % 3) * 0.006;
    const d = mesh(G.capsule(0.006, len, 6), M(accent), r.body, Math.sin(a) * 0.084, 0.033 - len / 2, Math.cos(a) * 0.084);
    d.scale.set(1, 1, 0.7);
  }
  // A pat of butter.
  const butter = mesh(G.rbox(0.03, 0.012, 0.03, 0.003), M("#FFE58A"), r.body, -0.012, 0.046, 0.01);
  butter.rotation.y = 0.5;
  const face = facePlate(r.body, [0, 0.002, 0.088], [0, 0, 1]);
  eyes(r, face, { size: 0.012, spacing: 0.02 });
  smile(face, 0.03, { y: -0.018, arc: PI * 0.8 });
  // The squished bottom pancake is not having a good time.
  const sad = facePlate(r.body, [0.05, -0.027, 0.072], [0.57, 0, 0.82]);
  eyes(r, sad, { size: 0.007, spacing: 0.01, brows: "worried" });
}

// ------------------------------------------------------------------ watermelon: toothy grin
function stripeTex(): THREE.Texture {
  return canvasTex("melonStripes", 256, 64, (ctx) => {
    ctx.fillStyle = "#3DB25E";
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = "#1E6E36";
    for (let i = 0; i < 12; i++) {
      const x0 = (i / 12) * 256;
      ctx.beginPath();
      for (let y = 0; y <= 64; y += 4) ctx.lineTo(x0 + Math.sin(y * 0.35 + i) * 3, y);
      for (let y = 64; y >= 0; y -= 4) ctx.lineTo(x0 + 9 + Math.sin(y * 0.3 + i * 2) * 3, y);
      ctx.closePath();
      ctx.fill();
    }
  });
}
function watermelon(r: PieceRig): void {
  const [, flesh] = C("watermelon");
  const mat = cachedMat("melon", () => new THREE.MeshToonMaterial({ color: "#FFFFFF", map: stripeTex(), gradientMap: toonRamp() }));
  mesh(G.sphere(0.11, 28, 18), mat, r.body);
  // Stem nub.
  mesh(G.cyl(0.006, 0.01, 0.014, 8), M("#6B4F1D"), r.body, 0, 0.112, 0);
  // Grin: a patch of the sphere itself (white rind lip, red flesh inside), teeth along the top, seeds.
  // SphereGeometry: x = -r cos(phi) sin(theta), z = r sin(phi) sin(theta) → +Z at phi = PI/2.
  const rind = detail(geo("melonRind", () => new THREE.SphereGeometry(0.1103, 20, 8, PI / 2 - 0.62, 1.24, PI / 2 + 0.05, 0.62)), M("#F4FFE8"), r.body);
  rind.renderOrder = 1;
  const red = detail(geo("melonFlesh", () => new THREE.SphereGeometry(0.1108, 20, 8, PI / 2 - 0.56, 1.12, PI / 2 + 0.08, 0.55)), M(flesh), r.body);
  red.renderOrder = 2;
  for (let i = 0; i < 7; i++) {
    const ph = -0.45 + (i / 6) * 0.9;
    const p = sph(0.1112, PI / 2 + 0.13, ph);
    const tooth = detail(G.box(0.015, 0.016, 0.004), M(WHITE), r.body);
    orient(tooth, p, norm(p));
  }
  for (const [th, ph] of [[0.38, -0.25], [0.45, 0.05], [0.36, 0.3], [0.5, -0.38], [0.5, 0.4]]) {
    const p = sph(0.1112, PI / 2 + th, ph);
    const seed = blob(INK, r.body, p, [0.003, 0.005, 0.002]);
    orient(seed, p, norm(p));
    seed.scale.set(0.003, 0.005, 0.002);
  }
  const ep = sph(0.106, PI / 2 - 0.3, 0);
  const face = facePlate(r.body, ep, norm(ep));
  eyes(r, face, { size: 0.024, spacing: 0.036, brows: "angry" });
}

// ------------------------------------------------------------------ croissant: très français (beret!)
function croissant(r: PieceRig): void {
  const [main, accent] = C("croissant");
  const lobes: [number, number, string][] = [[-0.095, 0.021, accent], [-0.055, 0.031, "#D99547"], [0, 0.041, main], [0.055, 0.031, "#D99547"], [0.095, 0.021, accent]];
  for (const [x, rad, col] of lobes) {
    const z = -0.022 * (x / 0.1) ** 2;
    const l = mesh(G.sphere(rad, 16, 12), M(col), r.body, x, -0.04 + rad * 0.92, z);
    l.scale.set(1.15, 0.92, 1);
    l.rotation.y = -x * 2.5;
  }
  // Beret (slightly tilted) + nub.
  const beret = new THREE.Group();
  beret.position.set(0.006, 0.04, -0.006);
  beret.rotation.set(0.15, 0, -0.3);
  r.body.add(beret);
  blob(M("#E8344A"), beret, [0, 0, 0], [0.04, 0.009, 0.038], true);
  mesh(G.cyl(0.003, 0.003, 0.01, 6), M("#E8344A"), beret, 0, 0.01, 0);
  const face = facePlate(r.body, [0, 0.006, 0.037], [0, 0.2, 1]);
  eyes(r, face, { size: 0.013, spacing: 0.018, lids: 0.3, lidColor: main });
  mustache(face, 0.032, "#2D2A32", -0.016);
}

// ------------------------------------------------------------------ soap: smug, leaks bubbles
function soap(r: PieceRig): void {
  const [main] = C("soap");
  mesh(G.rbox(0.12, 0.044, 0.08, 0.016), M(main), r.body);
  const label = canvasTex("soapLabel", 128, 64, (ctx) => {
    ctx.fillStyle = "rgba(255,255,255,0.0)";
    ctx.fillRect(0, 0, 128, 64);
    ctx.font = "bold 34px Arial Black, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(60,140,180,0.85)";
    ctx.fillText("SOAP", 64, 34);
  });
  const lm = cachedMat("soapLabel", () => new THREE.MeshBasicMaterial({ map: label, transparent: true, depthWrite: false }));
  const plane = detail(geo("soapLabelPlane", () => new THREE.PlaneGeometry(0.08, 0.04)), lm, r.body, 0, 0.0225, 0);
  plane.rotation.x = -PI / 2;
  const face = facePlate(r.body, [0, 0.003, 0.0405], [0, 0, 1]);
  eyes(r, face, { size: 0.011, spacing: 0.02, lids: 0.55, lidColor: main });
  smile(face, 0.016, { y: -0.012, x: 0.004, tilt: 0.3, arc: PI * 0.6 });
  cheeks(face, 0.03, 0.007, -0.006);
  // Bubbles drift up and pop.
  const bubbles: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const b = detail(G.sphere(0.01, 12, 8), softMat("#DFF8FF", 0.45), r.body);
    detail(G.sphere(0.003, 6, 4), M(WHITE), b, -0.004, 0.004, 0.007);
    bubbles.push(b);
  }
  r.anims.push((rig, _dt, t) => {
    for (let i = 0; i < bubbles.length; i++) {
      const u = (t * 0.35 + i * 0.27 + rig.seed) % 1;
      const b = bubbles[i];
      const a = i * 1.7 + rig.seed * 6;
      b.position.set(Math.cos(a) * 0.045 + Math.sin(u * 6 + i) * 0.006, 0.02 + u * 0.09, Math.sin(a) * 0.03);
      b.scale.setScalar(u > 0.92 ? (1 - u) * 12 * 0.8 : 0.4 + u * 0.6);
    }
  });
}

// ------------------------------------------------------------------ cupcake: peeking from under its frosting
function cupcake(r: PieceRig): void {
  const [main, accent] = C("cupcake");
  mesh(faceted("wrapper", () => new THREE.CylinderGeometry(0.052, 0.036, 0.08, 14)), M(accent), r.body, 0, -0.01, 0);
  const prof: [number, number][] = [[0, 0.02], [0.054, 0.02], [0.059, 0.026], [0.059, 0.036], [0.052, 0.045], [0.035, 0.05], [0, 0.0505]];
  mesh(G.lathe("frosting", prof, 24), M(main), r.body);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * PI * 2 + 0.25;
    blob(M(main), r.body, [Math.sin(a) * 0.054, 0.019, Math.cos(a) * 0.054], [0.009, 0.011, 0.009]);
  }
  const sg = sprinkleGeo("cupcake", 18, (rnd) => {
    const a = rnd() * PI * 2;
    const rho = Math.sqrt(rnd()) * 0.042;
    return [Math.sin(a) * rho, 0.0505 - (rho / 0.06) ** 2 * 0.012, Math.cos(a) * rho, rnd() * PI, 0];
  });
  detail(sg, sprinkleMat(), r.body);
  const face = facePlate(r.body, [0, 0.003, 0.0465], [0, -0.18, 1]);
  eyes(r, face, { size: 0.012, spacing: 0.017 });
  smile(face, 0.018, { y: -0.02, arc: PI * 0.85 });
}

// ------------------------------------------------------------------ frying pan: a sunny-side-up egg lives in it
function pan(r: PieceRig): void {
  const [main, accent] = C("pan");
  const prof: [number, number][] = [[0, -0.012], [0.094, -0.012], [0.1, -0.008], [0.101, 0.012], [0.093, 0.012], [0.09, 0.004], [0, 0.004]];
  mesh(G.lathe("pan", prof, 32), M(main), r.body);
  mesh(G.rbox(0.03, 0.014, 0.018, 0.004), M("#6B7280"), r.body, 0.105, 0.004, 0);
  mesh(G.rbox(0.13, 0.02, 0.024, 0.008), M(accent), r.body, 0.175, 0.005, 0);
  const ring = detail(G.torus(0.006, 0.002, PI * 2, 12), M("#C9D1D9"), r.body, 0.228, 0.0155, 0);
  ring.rotation.x = PI / 2;
  // Fried egg: lumpy white + yolk with a face.
  blob(M(WHITE), r.body, [-0.012, 0.006, 0.006], [0.05, 0.004, 0.042]);
  blob(M(WHITE), r.body, [0.02, 0.006, -0.012], [0.032, 0.0035, 0.03]);
  blob(M("#FFC23F"), r.body, [-0.005, 0.01, 0.008], [0.02, 0.01, 0.02], true);
  const face = facePlate(r.body, [-0.005, 0.0185, 0.014], [0, 1, 0.7]);
  eyes(r, face, { size: 0.0075, spacing: 0.0095 });
  smile(face, 0.012, { y: -0.01, arc: PI * 0.9 });
}

// ------------------------------------------------------------------ bowling ball: smug as heck
function bowlingBall(r: PieceRig): void {
  const [main, accent] = C("bowlingBall");
  mesh(G.sphere(0.1, 26, 18), M(main), r.body);
  const swirl = detail(G.torus(0.098, 0.006, PI * 1.3, 32), M(accent), r.body);
  swirl.rotation.set(0.9, 0.5, 0.2);
  // Finger holes up top.
  for (const [th, ph] of [[0.35, 2.6], [0.38, 3.3], [0.62, 2.95]]) {
    const p = sph(0.1005, th, ph);
    const h = detail(geo("ballHole", () => new THREE.CircleGeometry(0.011, 12)), INK, r.body);
    orient(h, p, norm(p));
  }
  // Glossy highlight.
  blob(softMat("#FFFFFF", 0.5), r.body, [-0.045, 0.06, 0.055], [0.022, 0.012, 0.006]).lookAt(-0.45, 0.6, 0.55);
  const ep = sph(0.098, PI / 2 - 0.22, 0);
  const face = facePlate(r.body, ep, norm(ep));
  eyes(r, face, { size: 0.021, spacing: 0.031, lids: 0.3, lidColor: "#4A4670", brows: "smug", browColor: accent });
  smile(face, 0.042, { y: -0.04, x: 0.012, tilt: 0.28, arc: PI * 0.55, thick: 0.0045, mat: M(accent) });
}

// ------------------------------------------------------------------ golden cherry: tiny, shiny, money
let cherryMat: THREE.MeshToonMaterial | null = null;
/** Shared emissive gold (pulsed globally by pulseCherry). */
export function goldMat(): THREE.MeshToonMaterial {
  if (!cherryMat) cherryMat = new THREE.MeshToonMaterial({ color: "#FFD700", emissive: "#8A6A00", gradientMap: toonRamp() });
  return cherryMat;
}
let lastPulse = -1;
export function pulseCherry(time: number): void {
  if (!cherryMat || time === lastPulse) return;
  lastPulse = time;
  const k = 0.45 + 0.35 * Math.sin(time * 4);
  cherryMat.emissive.setRGB(0.55 * k + 0.1, 0.42 * k + 0.06, 0);
}
function goldenCherry(r: PieceRig): void {
  const [, light] = C("goldenCherry");
  mesh(G.sphere(0.022, 16, 12), goldMat(), r.body);
  blob(M(light), r.body, [-0.008, 0.012, 0.012], [0.005, 0.003, 0.002]);
  const stem = geo("cherryStem", () => {
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0.018, 0), new THREE.Vector3(0.002, 0.04, 0), new THREE.Vector3(0.012, 0.05, 0));
    return new THREE.TubeGeometry(curve, 8, 0.0022, 5, false);
  });
  mesh(stem, M("#5B8A2E"), r.body);
  blob(M("#7BE07B"), r.body, [0.02, 0.05, 0], [0.01, 0.002, 0.005], true).rotation.z = 0.3;
  const face = facePlate(r.body, [0, 0.003, 0.02], [0, 0.1, 1]);
  eyes(r, face, { size: 0.0072, spacing: 0.0085 });
  smile(face, 0.009, { y: -0.009, arc: PI * 0.9 });
  const sparks: THREE.Sprite[] = [];
  for (let i = 0; i < 3; i++) sparks.push(sprite(sparkleMat(), r.body, 0.02));
  r.anims.push((rig, _dt, t) => {
    pulseCherry(t);
    for (let i = 0; i < sparks.length; i++) {
      const a = t * 1.6 + (i / sparks.length) * PI * 2 + rig.seed * 6;
      const s = sparks[i];
      s.position.set(Math.cos(a) * 0.038, 0.01 + Math.sin(t * 2 + i * 2) * 0.015, Math.sin(a) * 0.038);
      const tw = Math.max(0, Math.sin(t * 5 + i * 2.1));
      s.scale.setScalar(0.006 + tw * 0.02);
    }
  });
}

export const BUILDERS: Record<PieceType, (r: PieceRig) => void> = {
  jelly, chicken, fish, toaster, donut, banana, teapot, cheese, spatula, egg, pancakes, watermelon, croissant, soap, cupcake, pan,
  bowlingBall, goldenCherry,
};
