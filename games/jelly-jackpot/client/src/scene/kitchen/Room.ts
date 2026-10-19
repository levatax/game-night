// The night kitchen around the table: walls, floor, a window with a snoring cheese moon, a googly-eyed
// wall clock with scrambled numbers, counter + wobbly cabinets, a cat cookie jar that peeks out, a
// toaster that fires toast, a stove with a rattling pot and a rubber chicken hanging on a hook.
// The fridge + neon sign live in NeonSign.ts. update(dt, time, rattle): rattle 0..1 = earthquake.

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { addOutlines, googlyEyes, jiggleEyes, toon, toonRamp } from "../toon";
import { FLOOR_Y } from "./Table";
import { clockFaceTexture, floorTexture, polkaTexture, skyTexture, softDotTexture, stripeTexture, zzzTexture } from "./textures";

export const ROOM_HALF = 3.4;
export const CEILING_Y = 2.6;
const COUNTER_TOP = FLOOR_Y + 0.9;

type Updater = (dt: number, time: number, rattle: number) => void;

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

function texToon(map: THREE.Texture, color: THREE.ColorRepresentation = "#FFFFFF"): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, map, gradientMap: toonRamp() });
}

export class Room {
  readonly group = new THREE.Group();
  /** Shake-able props get a rest pose so quake jitter never drifts. */
  private rattlers: { obj: THREE.Object3D; base: THREE.Vector3; rot: THREE.Euler; amp: number }[] = [];
  private updaters: Updater[] = [];
  private eyes: THREE.Object3D[] = [];

  constructor() {
    this.group.name = "room";
    this.buildShell();
    this.buildWindow();
    this.buildClock();
    this.buildCounter();
    this.buildStove();
  }

  private rattle(obj: THREE.Object3D, amp = 1): void {
    this.rattlers.push({ obj, base: obj.position.clone(), rot: obj.rotation.clone(), amp });
  }

  // ---------------------------------------------------------------------------- walls / floor
  private buildShell(): void {
    const W = ROOM_HALF;
    const H = CEILING_Y - FLOOR_Y;
    const wallTex = stripeTexture(PALETTE.wall, "#353152", 4, false);
    wallTex.repeat.set(10, 1);
    const wall = texToon(wallTex);
    const ceiling = toon("#211E35");
    const box = new THREE.Mesh(new THREE.BoxGeometry(W * 2, H + 0.04, W * 2), [wall, wall, ceiling, ceiling, wall, wall]);
    (box.material as THREE.Material[]).forEach((m) => (m.side = THREE.BackSide));
    box.position.y = FLOOR_Y + H / 2;
    box.receiveShadow = true;
    this.group.add(box);

    const floor = mesh(new THREE.PlaneGeometry(W * 2, W * 2), texToon(floorTexture(7)), 0, FLOOR_Y, 0);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.group.add(floor);

    // minty wainscot band + baseboard on each wall
    const band = toon("#4FB3A9");
    const board = toon("#F2E8D5");
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      g.rotation.y = (i * Math.PI) / 2;
      const b = mesh(new THREE.BoxGeometry(W * 2, 0.7, 0.04), band, 0, FLOOR_Y + 0.35, -W + 0.02);
      const t = mesh(new THREE.BoxGeometry(W * 2, 0.05, 0.07), board, 0, FLOOR_Y + 0.72, -W + 0.035);
      const base = mesh(new THREE.BoxGeometry(W * 2, 0.1, 0.06), board, 0, FLOOR_Y + 0.05, -W + 0.03);
      g.add(b, t, base);
      this.group.add(g);
    }
  }

  // ---------------------------------------------------------------------------- window + moon
  private buildWindow(): void {
    const g = new THREE.Group();
    g.position.set(ROOM_HALF - 0.01, 0.85, 0.2);
    g.rotation.y = -Math.PI / 2; // faces -x (into the room)
    const w = 1.5;
    const h = 1.15;
    const sky = mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: skyTexture() }), 0, 0, 0.005);
    sky.userData.noOutline = true;
    g.add(sky);
    const frame = toon("#F2E8D5");
    const bar = (bw: number, bh: number, x: number, y: number) => g.add(mesh(new THREE.BoxGeometry(bw, bh, 0.08), frame, x, y, 0.04));
    bar(w + 0.12, 0.08, 0, h / 2);
    bar(w + 0.12, 0.08, 0, -h / 2);
    bar(0.08, h, -w / 2, 0);
    bar(0.08, h, w / 2, 0);
    bar(0.04, h, 0, 0);
    bar(w, 0.04, 0, 0.05);
    const sill = mesh(new THREE.BoxGeometry(w + 0.3, 0.05, 0.2), frame, 0, -h / 2 - 0.04, 0.1);
    g.add(sill);
    // a little potted cactus on the sill, wearing googly eyes
    const pot = mesh(new THREE.CylinderGeometry(0.07, 0.05, 0.1, 10), toon("#E07A4F"), 0.5, -h / 2 + 0.03, 0.12);
    const cactus = mesh(new THREE.CapsuleGeometry(0.045, 0.1, 4, 8), toon("#58C46B"), 0, 0.11, 0);
    const arm = mesh(new THREE.CapsuleGeometry(0.022, 0.05, 3, 6), toon("#58C46B"), 0.05, 0.03, 0);
    arm.rotation.z = -0.6;
    cactus.add(arm);
    const cEyes = googlyEyes(0.016, 0.022);
    cEyes.position.set(0, 0.04, 0.042);
    cactus.add(cEyes);
    this.eyes.push(cEyes);
    pot.add(cactus);
    g.add(pot);
    this.rattle(pot, 0.6);

    // the cheese moon: a flattened yellow disc with holes and a sleepy face
    const moon = new THREE.Group();
    moon.position.set(0.38, 0.22, 0.03);
    const cheese = mesh(new THREE.SphereGeometry(0.24, 24, 16), toon("#FFD54A", { emissive: "#6B5200" }));
    cheese.scale.z = 0.25;
    moon.add(cheese);
    const holeMat = toon("#E0A92E");
    for (const [x, y, r] of [[-0.1, 0.1, 0.045], [0.12, -0.08, 0.035], [-0.05, -0.13, 0.028], [0.13, 0.12, 0.022], [0.0, 0.16, 0.018]] as const) {
      const hole = mesh(new THREE.CircleGeometry(r, 14), holeMat, x, y, 0.061);
      hole.userData.noOutline = true;
      moon.add(hole);
    }
    const ink = new THREE.MeshBasicMaterial({ color: PALETTE.ink });
    for (const s of [-1, 1]) {
      const lid = mesh(new THREE.TorusGeometry(0.03, 0.007, 4, 10, Math.PI), ink, s * 0.07, 0.03, 0.062);
      lid.rotation.z = Math.PI; // closed sleepy eyes (smile-shaped arcs)
      lid.userData.noOutline = true;
      moon.add(lid);
    }
    const mouth = mesh(new THREE.CircleGeometry(0.018, 10), ink, 0, -0.05, 0.062);
    mouth.userData.noOutline = true;
    moon.add(mouth);
    addOutlines(cheese, 1.04);
    g.add(moon);
    // snore Zzz sprites floating out of the moon
    const zMat = new THREE.SpriteMaterial({ map: zzzTexture(), transparent: true, depthWrite: false });
    const zs: THREE.Sprite[] = [];
    for (let i = 0; i < 3; i++) {
      const z = new THREE.Sprite(zMat.clone());
      z.scale.setScalar(0.1);
      g.add(z);
      zs.push(z);
    }

    // polka-dot curtains, gently swaying
    const curtainMat = new THREE.MeshToonMaterial({ color: "#FFFFFF", map: polkaTexture("#FF8BD1", "#FFF4DC", 2), gradientMap: toonRamp(), side: THREE.DoubleSide });
    const curtains: THREE.Mesh[] = [];
    for (const s of [-1, 1]) {
      const geo = new THREE.PlaneGeometry(0.45, h + 0.3, 6, 6);
      const p = geo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin(p.getX(i) * 28) * 0.03);
      geo.computeVertexNormals();
      const c = mesh(geo, curtainMat, s * (w / 2 + 0.12), 0.05, 0.12);
      c.userData.noOutline = true;
      curtains.push(c);
      g.add(c);
    }
    const rod = mesh(new THREE.CylinderGeometry(0.02, 0.02, w + 0.8, 8), toon("#C9A15A"), 0, h / 2 + 0.16, 0.13);
    rod.rotation.z = Math.PI / 2;
    g.add(rod);
    addOutlines(g, 1.03);
    this.group.add(g);

    this.updaters.push((_dt, t) => {
      moon.position.y = 0.22 + Math.sin(t * 0.8) * 0.015;
      moon.rotation.z = Math.sin(t * 0.5) * 0.08;
      const breathe = 1 + Math.sin(t * 1.6) * 0.03;
      cheese.scale.set(breathe, breathe, 0.25);
      mouth.scale.setScalar(0.7 + (Math.sin(t * 1.6) * 0.5 + 0.5) * 0.8);
      zs.forEach((z, i) => {
        const p = (t * 0.35 + i / 3) % 1;
        z.position.set(0.55 + p * 0.25 + Math.sin(p * 9) * 0.03, 0.32 + p * 0.35, 0.06);
        z.scale.setScalar(0.05 + p * 0.09);
        (z.material as THREE.SpriteMaterial).opacity = Math.sin(p * Math.PI);
      });
      curtains.forEach((c, i) => (c.rotation.y = Math.sin(t * 0.9 + i * 2) * 0.06));
    });
  }

  // ---------------------------------------------------------------------------- googly clock
  private buildClock(): void {
    const g = new THREE.Group();
    g.position.set(-ROOM_HALF + 0.05, 1.0, 0.9);
    g.rotation.y = Math.PI / 2; // faces +x
    const body = mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.08, 28), toon("#FF8BD1"));
    body.rotation.x = Math.PI / 2;
    const face = mesh(new THREE.CircleGeometry(0.29, 28), new THREE.MeshBasicMaterial({ map: clockFaceTexture() }), 0, 0, 0.041);
    face.userData.noOutline = true;
    // little bells on top, like an alarm clock that lost its legs
    const bellMat = toon("#FFC23F");
    for (const s of [-1, 1]) {
      const bell = mesh(new THREE.SphereGeometry(0.09, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), bellMat, s * 0.2, 0.3, 0);
      bell.rotation.z = -s * 0.5;
      g.add(bell);
    }
    g.add(body, face);
    const handMat = new THREE.MeshBasicMaterial({ color: PALETTE.ink });
    const mkHand = (len: number, wid: number) => {
      const pivot = new THREE.Group();
      pivot.position.z = 0.05;
      const hand = mesh(new THREE.BoxGeometry(wid, len, 0.01), handMat, 0, len / 2 - 0.02, 0);
      hand.userData.noOutline = true;
      pivot.add(hand);
      g.add(pivot);
      return pivot;
    };
    const hour = mkHand(0.15, 0.028);
    const minute = mkHand(0.24, 0.018);
    const eyes = googlyEyes(0.07, 0.085);
    eyes.position.set(0, 0.08, 0.07);
    g.add(eyes);
    this.eyes.push(eyes);
    addOutlines(g, 1.03);
    this.group.add(g);
    this.rattle(g, 1.5);
    this.updaters.push((_dt, t, rattle) => {
      minute.rotation.z = -t * 2.2 * (1 + rattle * 6); // way too fast
      hour.rotation.z = t * 0.3; // backwards
      // tick-tock wobble that snaps once per second
      const tick = Math.floor(t) % 2 === 0 ? 1 : -1;
      g.rotation.z = tick * 0.04 * Math.exp(-(t % 1) * 6);
    });
  }

  // ---------------------------------------------------------------------------- counter, cabinets, jar, toaster
  private buildCounter(): void {
    const z0 = -ROOM_HALF;
    const x0 = -0.5;
    const x1 = 2.9;
    const len = x1 - x0;
    const cx = (x0 + x1) / 2;
    const g = new THREE.Group();
    const lowH = COUNTER_TOP - FLOOR_Y - 0.05;
    const low = mesh(new THREE.BoxGeometry(len, lowH, 0.62), toon("#7FC8F8"), cx, FLOOR_Y + lowH / 2, z0 + 0.33);
    const top = mesh(new THREE.BoxGeometry(len + 0.06, 0.05, 0.7), toon("#F2E8D5"), cx, COUNTER_TOP - 0.025, z0 + 0.36);
    top.receiveShadow = true;
    g.add(low, top);
    const knob = toon("#FFC23F");
    const doors = 4;
    for (let i = 0; i < doors; i++) {
      const dx = x0 + (len / doors) * (i + 0.5);
      const d = mesh(new THREE.BoxGeometry(len / doors - 0.06, lowH - 0.12, 0.02), toon("#A6DCFF"), dx, FLOOR_Y + lowH / 2, z0 + 0.65);
      g.add(d, mesh(new THREE.SphereGeometry(0.025, 8, 6), knob, dx + 0.25, FLOOR_Y + lowH * 0.6, z0 + 0.67));
    }

    // wobbly upper cabinets: doors hinge open a crack and creak
    const cabMat = toon("#7FC8F8");
    const doorMat = toon("#A6DCFF");
    const cabinets = 3;
    const cw = len / cabinets;
    const cy = 1.5;
    const ch = 0.7;
    const cabDoors: THREE.Group[] = [];
    for (let i = 0; i < cabinets; i++) {
      const x = x0 + cw * (i + 0.5);
      const box = mesh(new THREE.BoxGeometry(cw - 0.04, ch, 0.38), cabMat, x, cy, z0 + 0.2);
      box.rotation.z = (i - 1) * 0.02; // a bit crooked on purpose
      g.add(box);
      const hinge = new THREE.Group();
      hinge.position.set(x - cw / 2 + 0.04, cy, z0 + 0.4);
      const door = mesh(new THREE.BoxGeometry(cw - 0.1, ch - 0.08, 0.025), doorMat, (cw - 0.1) / 2, 0, 0);
      const k = mesh(new THREE.SphereGeometry(0.025, 8, 6), knob, cw - 0.16, -0.18, 0.025);
      door.add(k);
      hinge.add(door);
      g.add(hinge);
      cabDoors.push(hinge);
    }
    // the middle cabinet hides a pair of eyes in the dark gap
    const peek = googlyEyes(0.03, 0.035);
    peek.position.set(x0 + cw * 1.5 - cw / 2 + 0.1, cy + 0.12, z0 + 0.36);
    peek.rotation.y = -0.5;
    g.add(peek);
    this.eyes.push(peek);

    // cat cookie jar
    const jar = new THREE.Group();
    jar.position.set(1.7, COUNTER_TOP, z0 + 0.42);
    const jarBody = mesh(new THREE.CylinderGeometry(0.15, 0.16, 0.22, 18), texToon(stripeTexture("#FFB36B", "#FFD9A0", 6, false)), 0, 0.11, 0);
    const paws = toon("#FFF4DC");
    for (const s of [-1, 1]) jar.add(mesh(new THREE.SphereGeometry(0.04, 8, 6), paws, s * 0.06, 0.02, 0.14));
    const head = new THREE.Group();
    head.position.y = 0.22;
    const skull = mesh(new THREE.SphereGeometry(0.14, 18, 12), toon("#FF9F43"), 0, 0.07, 0);
    skull.scale.y = 0.85;
    const earMat = toon("#FF9F43");
    for (const s of [-1, 1]) {
      const ear = mesh(new THREE.ConeGeometry(0.05, 0.09, 4), earMat, s * 0.08, 0.19, 0);
      ear.rotation.z = -s * 0.35;
      head.add(ear);
    }
    const nose = mesh(new THREE.SphereGeometry(0.018, 8, 6), toon("#FF5A8A"), 0, 0.05, 0.135);
    const catEyes = googlyEyes(0.035, 0.05);
    catEyes.position.set(0, 0.1, 0.12);
    this.eyes.push(catEyes);
    const whiskerMat = new THREE.MeshBasicMaterial({ color: PALETTE.ink });
    for (const s of [-1, 1]) {
      for (const tilt of [-0.15, 0.12]) {
        const wsk = mesh(new THREE.BoxGeometry(0.12, 0.004, 0.004), whiskerMat, s * 0.12, 0.04, 0.11);
        wsk.rotation.z = tilt * s;
        wsk.userData.noOutline = true;
        head.add(wsk);
      }
    }
    const tail = mesh(new THREE.TorusGeometry(0.08, 0.018, 6, 12, Math.PI * 1.2), toon("#FF9F43"), 0.17, 0.12, -0.02);
    tail.rotation.y = Math.PI / 2;
    head.add(skull, nose, catEyes);
    jar.add(jarBody, head, tail);
    const cookie = mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.015, 12), toon("#C98A4B"), 0.0, 0.2, 0.06);
    cookie.rotation.x = 1.2;
    jar.add(cookie);
    g.add(jar);
    this.rattle(jar, 0.8);

    // toaster that randomly launches toast
    const toaster = new THREE.Group();
    toaster.position.set(0.3, COUNTER_TOP, z0 + 0.42);
    const shell = mesh(new THREE.BoxGeometry(0.34, 0.2, 0.2), toon("#D7DCE8"), 0, 0.1, 0);
    const lever = mesh(new THREE.BoxGeometry(0.03, 0.02, 0.05), toon("#FF5A5F"), 0.18, 0.12, 0);
    const toastMat = toon("#E8B36A");
    const toasts = [-0.06, 0.06].map((x) => {
      const t = mesh(new THREE.BoxGeometry(0.1, 0.12, 0.025), toastMat, x, 0.16, 0);
      t.rotation.y = Math.PI / 2;
      toaster.add(t);
      return t;
    });
    const tEyes = googlyEyes(0.025, 0.04);
    tEyes.position.set(0, 0.12, 0.105);
    this.eyes.push(tEyes);
    toaster.add(shell, lever, tEyes);
    g.add(toaster);
    this.rattle(toaster, 0.8);

    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.receiveShadow = true;
    });
    addOutlines(g, 1.03);
    this.group.add(g);

    this.updaters.push((_dt, t, rattle) => {
      cabDoors.forEach((d, i) => {
        const creak = Math.sin(t * (0.7 + i * 0.3) + i) * 0.05 + 0.06;
        d.rotation.y = -(creak + rattle * Math.abs(Math.sin(t * 25 + i)) * 0.5);
      });
      // jar peek cycle: every 8 s the cat lid lifts up and looks around
      const c = t % 8;
      const lift = c > 5.6 && c < 7.6 ? Math.sin(((c - 5.6) / 2) * Math.PI) : 0;
      head.position.y = 0.22 + lift * 0.09 + rattle * Math.abs(Math.sin(t * 30)) * 0.03;
      head.rotation.y = lift * Math.sin(t * 3) * 0.6;
      head.rotation.z = lift * 0.15;
      cookie.visible = lift > 0.2;
      // toast launch every ~9 s
      const p = (t + 3) % 9;
      toasts.forEach((ts, i) => {
        const k = p - i * 0.12;
        const h = k > 0 && k < 1.1 ? Math.sin((k / 1.1) * Math.PI) * 0.45 : 0;
        ts.position.y = 0.16 + h;
        ts.rotation.x = h > 0 ? k * (i ? -6 : 6) : 0;
      });
      lever.position.y = p < 1.2 ? 0.17 : 0.12;
    });
  }

  // ---------------------------------------------------------------------------- stove, pot, rubber chicken
  private buildStove(): void {
    const g = new THREE.Group();
    g.position.set(-0.6, 0, ROOM_HALF - 0.36);
    g.rotation.y = Math.PI; // faces -z (into the room)
    const h = COUNTER_TOP - FLOOR_Y;
    const body = mesh(new THREE.BoxGeometry(0.85, h, 0.65), toon("#FFF4DC"), 0, FLOOR_Y + h / 2, 0);
    const ovenWin = mesh(new THREE.BoxGeometry(0.55, 0.3, 0.02), toon("#2A2640", { emissive: "#5A2A10" }), 0, FLOOR_Y + 0.4, 0.33);
    const knobMat = toon("#FF5A5F");
    for (let i = 0; i < 4; i++) g.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 8), knobMat, -0.27 + i * 0.18, COUNTER_TOP - 0.1, 0.33).rotateX(Math.PI / 2));
    const burner = new THREE.MeshBasicMaterial({ color: "#222033" });
    for (const [x, z] of [[-0.2, -0.15], [0.2, -0.15], [-0.2, 0.15], [0.2, 0.15]] as const) {
      const b = mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.01, 14), burner, x, COUNTER_TOP + 0.005, z);
      b.userData.noOutline = true;
      g.add(b);
    }
    const pot = new THREE.Group();
    pot.position.set(0.2, COUNTER_TOP + 0.01, 0.1);
    const potBody = mesh(new THREE.CylinderGeometry(0.17, 0.15, 0.2, 18), toon("#FF5A5F"), 0, 0.1, 0);
    const lid = new THREE.Group();
    lid.position.y = 0.2;
    lid.add(mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.02, 18), toon("#D7DCE8")), mesh(new THREE.SphereGeometry(0.03, 8, 6), toon(PALETTE.ink), 0, 0.03, 0));
    for (const s of [-1, 1]) pot.add(mesh(new THREE.TorusGeometry(0.03, 0.01, 4, 8), toon("#FF5A5F"), s * 0.18, 0.15, 0).rotateY(Math.PI / 2));
    pot.add(potBody, lid);
    g.add(body, ovenWin, pot);

    // rubber chicken hanging upside down from a hook
    const hookY = 1.35;
    const chicken = new THREE.Group();
    chicken.position.set(-0.9, hookY, 0.05);
    const hook = mesh(new THREE.TorusGeometry(0.03, 0.006, 4, 10, Math.PI * 1.4), toon("#C9A15A"), 0, 0.03, 0);
    const hang = new THREE.Group();
    const yellow = toon("#FFD84A");
    const legs = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.12, 5), toon("#FF9F43"), 0, -0.06, 0);
    const bodyC = mesh(new THREE.CapsuleGeometry(0.07, 0.16, 4, 10), yellow, 0, -0.24, 0);
    const neck = mesh(new THREE.CapsuleGeometry(0.025, 0.2, 3, 8), yellow, 0, -0.48, 0);
    const headC = mesh(new THREE.SphereGeometry(0.05, 10, 8), yellow, 0, -0.62, 0);
    const comb = mesh(new THREE.ConeGeometry(0.03, 0.06, 5), toon("#FF5A5F"), 0, -0.68, 0);
    comb.rotation.z = Math.PI;
    const beak = mesh(new THREE.ConeGeometry(0.02, 0.06, 5), toon("#FF9F43"), 0, -0.6, 0.05);
    beak.rotation.x = Math.PI / 2;
    const cEyes = googlyEyes(0.018, 0.025);
    cEyes.position.set(0, -0.63, 0.04);
    cEyes.rotation.z = Math.PI;
    this.eyes.push(cEyes);
    hang.add(legs, bodyC, neck, headC, comb, beak, cEyes);
    chicken.add(hook, hang);
    g.add(chicken);

    addOutlines(g, 1.03);
    this.group.add(g);
    this.rattle(pot, 0.6);

    // little steam puffs from the pot
    const puffMat = new THREE.SpriteMaterial({ map: softDotTexture(), transparent: true, opacity: 0.5, depthWrite: false });
    const puffs: THREE.Sprite[] = [];
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Sprite(puffMat.clone());
      pot.add(s);
      puffs.push(s);
    }

    this.updaters.push((_dt, t, rattle) => {
      const boil = Math.max(0, Math.sin(t * 2.3)) > 0.7 ? 1 : 0;
      lid.position.y = 0.2 + (boil + rattle) * Math.abs(Math.sin(t * 40)) * 0.02;
      lid.rotation.z = (boil + rattle) * Math.sin(t * 33) * 0.08;
      puffs.forEach((s, i) => {
        const p = (t * 0.4 + i / puffs.length) % 1;
        s.position.set(Math.sin(p * 6 + i) * 0.05, 0.25 + p * 0.5, 0);
        s.scale.setScalar(0.08 + p * 0.18);
        (s.material as THREE.SpriteMaterial).opacity = Math.sin(p * Math.PI) * 0.45;
      });
      hang.rotation.z = Math.sin(t * 1.3) * 0.08 + rattle * Math.sin(t * 18) * 0.4;
      hang.rotation.x = Math.sin(t * 0.9) * 0.05;
    });
  }

  update(dt: number, time: number, rattle: number): void {
    for (const u of this.updaters) u(dt, time, rattle);
    for (const r of this.rattlers) {
      const a = rattle * r.amp;
      if (a <= 0.001) {
        r.obj.position.copy(r.base);
        if (r.obj.userData.rattled) r.obj.rotation.copy(r.rot);
        r.obj.userData.rattled = false;
        continue;
      }
      r.obj.userData.rattled = true;
      r.obj.position.set(r.base.x + (Math.random() - 0.5) * 0.02 * a, r.base.y + Math.abs(Math.sin(time * 37 + r.base.x)) * 0.02 * a, r.base.z + (Math.random() - 0.5) * 0.02 * a);
      r.obj.rotation.set(r.rot.x, r.rot.y + (Math.random() - 0.5) * 0.08 * a, r.rot.z + (Math.random() - 0.5) * 0.1 * a);
    }
    for (const e of this.eyes) jiggleEyes(e, dt, rattle * 3);
  }
}
