// The pavyon back room shell + set dressing: plum damask walls (#1C1720) over dark wood wainscot, plank floor
// with a round burgundy rug, a low beamed ceiling with a slot the wheel drops through (its flaps open for the
// wheel moment) and a round well the lamp hangs out of (it is hoisted up into it while the wheel is down), and
// character props: a sideboard with bottles and a gramophone, cash crates, the big iron
// "KASA" safe, the boss portrait, a wall clock stuck near 3 a.m., a coat rack with a fedora, an "ARANIYOR"
// poster, a potted palm and wall sconces. Static parts are merged per material (StaticBatch; every plain
// toon color bakes into one vertex-colored material); only the clock hands, the gramophone record and the
// ceiling flaps move.

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { toon } from "../toon";
import { StaticBatch } from "./batch";
import {
  BEAM_DROP,
  CEILING_Y,
  DOOR_H,
  DOOR_W,
  DOOR_X,
  LAMP_WELL_DEPTH,
  LAMP_WELL_R,
  ROOM_BACK_Z,
  ROOM_FRONT_Z,
  ROOM_HALF_X,
  SLOT_HALF_X,
  SLOT_HALF_Z,
  WHEEL_Z,
} from "./layout";
import {
  clockFaceTexture,
  crateTexture,
  floorTexture,
  plaqueTexture,
  portraitTexture,
  rugTexture,
  textTexture,
  FONT,
  wallpaperTexture,
  wantedTexture,
  woodTexture,
  brickTexture,
} from "./textures";

const WAINSCOT_H = 1.0;
const WALL_TILE = 1.15;

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const eul = (x: number, y: number, z: number) => new THREE.Euler(x, y, z);

/** Plane with UVs scaled to world size (so tiling textures keep their density on any wall). */
function tiledPlane(w: number, h: number, tile: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / tile, (uv.getY(i) * h) / tile);
  return g;
}

/** Multiply a geometry's UVs (tile a shared texture over long boxes). */
function scaleUV<T extends THREE.BufferGeometry>(g: T, su: number, sv: number): T {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

function texToon(map: THREE.Texture, color: THREE.ColorRepresentation = "#FFFFFF"): THREE.MeshToonMaterial {
  return toon(color, { map, unique: true });
}

export class Room {
  readonly group = new THREE.Group();
  /** Emissive sconce bulbs (dimmed by Stage when the lights go out). */
  readonly sconceMat = new THREE.MeshBasicMaterial({ color: "#FFC98A" });
  private hourHand = new THREE.Group();
  private minuteHand = new THREE.Group();
  private record = new THREE.Group();
  private flaps: THREE.Group[] = [];
  private flapOpen = 0;
  private flapTarget = 0;

  constructor() {
    this.group.name = "room";
    const b = new StaticBatch();
    this.buildShell(b);
    this.buildCeiling(b);
    this.buildSideboard(b);
    this.buildCrates(b);
    this.buildSafe(b);
    this.buildWallArt(b);
    this.buildCoatRack(b);
    this.buildPalm(b);
    this.buildSconces(b);
    this.group.add(b.build("roomStatic"));
  }

  // ------------------------------------------------------------------------------------------ shell
  private buildShell(b: StaticBatch): void {
    const W = ROOM_HALF_X;
    const depth = ROOM_FRONT_Z - ROOM_BACK_Z;
    const midZ = (ROOM_FRONT_Z + ROOM_BACK_Z) / 2;
    const H = CEILING_Y;

    // floor + rug
    const floorTex = floorTexture();
    floorTex.repeat.set(1, 1);
    const floorMat = texToon(floorTex);
    b.addAt(tiledPlane(W * 2, depth, 1.6), floorMat, v3(0, 0, midZ), eul(-Math.PI / 2, 0, 0));
    const rug = new THREE.CircleGeometry(2.8, 48);
    b.addAt(rug, texToon(rugTexture()), v3(0, 0.006, 0), eul(-Math.PI / 2, 0, 0));

    // wallpaper (upper wall) — back wall is cut around the door
    const paper = wallpaperTexture();
    paper.repeat.set(1, 1);
    const paperMat = texToon(paper);
    const upperH = H - WAINSCOT_H;
    const upperY = WAINSCOT_H + upperH / 2;
    const wall = (w: number, h: number, pos: THREE.Vector3, rotY: number) => b.addAt(tiledPlane(w, h, WALL_TILE), paperMat, pos, eul(0, rotY, 0));
    // side + front walls
    wall(depth, upperH, v3(-W, upperY, midZ), Math.PI / 2);
    wall(depth, upperH, v3(W, upperY, midZ), -Math.PI / 2);
    wall(W * 2, upperH, v3(0, upperY, ROOM_FRONT_Z), Math.PI);
    // back wall: left of door, right of door, above door
    const dl = DOOR_X - DOOR_W / 2;
    const dr = DOOR_X + DOOR_W / 2;
    const leftW = dl + W;
    wall(leftW, upperH, v3(-W + leftW / 2, upperY, ROOM_BACK_Z), 0);
    const rightW = W - dr;
    wall(rightW, upperH, v3(dr + rightW / 2, upperY, ROOM_BACK_Z), 0);
    wall(DOOR_W, H - DOOR_H, v3(DOOR_X, DOOR_H + (H - DOOR_H) / 2, ROOM_BACK_Z), 0);

    // wainscot: dark wood boxes with raised panels, a cap rail and a baseboard
    const woodTex = woodTexture("#3A2018", "#22120C", 3);
    woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
    const wainMat = texToon(woodTex);
    const panelMat = toon("#4A2A1E");
    const capMat = toon(PALETTE.wood);
    const runs: { from: number; to: number; axis: "x" | "z"; fixed: number; inward: number }[] = [
      { from: -W, to: dl, axis: "x", fixed: ROOM_BACK_Z, inward: 1 },
      { from: dr, to: W, axis: "x", fixed: ROOM_BACK_Z, inward: 1 },
      { from: -W, to: W, axis: "x", fixed: ROOM_FRONT_Z, inward: -1 },
      { from: ROOM_BACK_Z, to: ROOM_FRONT_Z, axis: "z", fixed: -W, inward: 1 },
      { from: ROOM_BACK_Z, to: ROOM_FRONT_Z, axis: "z", fixed: W, inward: -1 },
    ];
    for (const r of runs) {
      const len = r.to - r.from;
      if (len <= 0.05) continue;
      const mid = (r.from + r.to) / 2;
      const at = (along: number, y: number, off: number) =>
        r.axis === "x" ? v3(along, y, r.fixed + r.inward * off) : v3(r.fixed + r.inward * off, y, along);
      const box = (l: number, h: number, d: number) => (r.axis === "x" ? new THREE.BoxGeometry(l, h, d) : new THREE.BoxGeometry(d, h, l));
      b.addAt(scaleUV(box(len, WAINSCOT_H, 0.04), len / 0.9, 1), wainMat, at(mid, WAINSCOT_H / 2, 0.02), null, 1);
      b.addAt(box(len, 0.06, 0.08), capMat, at(mid, WAINSCOT_H, 0.04), null, 1, { outline: 1.04 });
      b.addAt(box(len, 0.12, 0.07), capMat, at(mid, 0.06, 0.035), null, 1);
      b.addAt(box(len, 0.08, 0.05), capMat, at(mid, CEILING_Y - 0.06, 0.025), null, 1);
      const n = Math.floor(len / 0.95);
      if (n < 1) continue;
      const step = len / n;
      for (let i = 0; i < n; i++) {
        const c = r.from + step * (i + 0.5);
        b.addAt(box(step - 0.22, WAINSCOT_H - 0.36, 0.02), panelMat, at(c, WAINSCOT_H / 2 + 0.02, 0.05), null, 1);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ ceiling
  private buildCeiling(b: StaticBatch): void {
    const W = ROOM_HALF_X;
    const ceilMat = toon("#151017");
    const beamTex = woodTexture("#2A1712", "#170C08", 9, true);
    const beamMat = texToon(beamTex);
    const y = CEILING_Y;
    const down = eul(Math.PI / 2, 0, 0);
    // ceiling pieces around the wheel slot
    const z0 = WHEEL_Z - SLOT_HALF_Z;
    const z1 = WHEEL_Z + SLOT_HALF_Z;
    const backD = z0 - ROOM_BACK_Z;
    const frontD = ROOM_FRONT_Z - z1;
    b.addAt(new THREE.PlaneGeometry(W * 2, backD), ceilMat, v3(0, y, ROOM_BACK_Z + backD / 2), down);
    // front piece with the lamp's round well cut out (shape x/y = world x/z once turned face down)
    const front = new THREE.Shape();
    front.moveTo(-W, z1);
    front.lineTo(W, z1);
    front.lineTo(W, z1 + frontD);
    front.lineTo(-W, z1 + frontD);
    front.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0, LAMP_WELL_R, 0, Math.PI * 2, true);
    front.holes.push(hole);
    b.addAt(new THREE.ShapeGeometry(front, 40), ceilMat, v3(0, y, 0), down);
    const sideW = W - SLOT_HALF_X;
    for (const s of [-1, 1]) b.addAt(new THREE.PlaneGeometry(sideW, z1 - z0), ceilMat, v3(s * (SLOT_HALF_X + sideW / 2), y, WHEEL_Z), down);
    // the slot shaft (dark box walls above the hole)
    const shaftMat = toon("#0B080C");
    b.addAt(new THREE.BoxGeometry(SLOT_HALF_X * 2, 0.02, 0.6), shaftMat, v3(0, y + 2.6, WHEEL_Z));
    for (const s of [-1, 1]) {
      b.addAt(new THREE.BoxGeometry(SLOT_HALF_X * 2 + 0.04, 2.6, 0.02), shaftMat, v3(0, y + 1.3, WHEEL_Z + s * (SLOT_HALF_Z + 0.01)));
      b.addAt(new THREE.BoxGeometry(0.02, 2.6, SLOT_HALF_Z * 2), shaftMat, v3(s * (SLOT_HALF_X + 0.01), y + 1.3, WHEEL_Z));
    }
    // the lamp's well: a dark round shaft over the hole (the lamp is hoisted up into it for the wheel), a brass
    // collar on the rim
    const wellMat = toon("#0B080C", { side: THREE.BackSide });
    b.addAt(new THREE.CylinderGeometry(LAMP_WELL_R, LAMP_WELL_R, LAMP_WELL_DEPTH, 32, 1, true), wellMat, v3(0, y + LAMP_WELL_DEPTH / 2, 0));
    b.addAt(new THREE.CircleGeometry(LAMP_WELL_R + 0.01, 32), shaftMat, v3(0, y + LAMP_WELL_DEPTH, 0), down);
    b.addAt(new THREE.TorusGeometry(LAMP_WELL_R + 0.012, 0.02, 6, 48), toon("#B8862E"), v3(0, y - 0.004, 0), eul(Math.PI / 2, 0, 0));
    // beams across x (skipping the slot and the lamp well)
    for (const z of [-2.75, -1.6, 0.66, 1.6, 2.8, 4.0]) {
      b.addAt(new THREE.BoxGeometry(W * 2, BEAM_DROP, 0.24), beamMat, v3(0, y - BEAM_DROP / 2, z), null, 1, { outline: 1.02 });
    }
    // slot trim
    const trimMat = toon(PALETTE.woodDark);
    for (const s of [-1, 1]) {
      b.addAt(new THREE.BoxGeometry(SLOT_HALF_X * 2 + 0.2, 0.08, 0.1), trimMat, v3(0, y - 0.04, WHEEL_Z + s * (SLOT_HALF_Z + 0.05)), null, 1, { outline: 1.04 });
    }
    // two hinged flaps closing the slot (open for the wheel)
    const flapMat = toon("#2A1712");
    for (const s of [-1, 1]) {
      const hinge = new THREE.Group();
      hinge.position.set(0, y - 0.005, WHEEL_Z + s * SLOT_HALF_Z);
      const flap = new THREE.Mesh(new THREE.BoxGeometry(SLOT_HALF_X * 2, 0.03, SLOT_HALF_Z), flapMat);
      flap.position.z = -s * (SLOT_HALF_Z / 2);
      hinge.add(flap);
      hinge.userData.side = s;
      this.flaps.push(hinge);
      this.group.add(hinge);
    }
  }

  // ------------------------------------------------------------------------------------------ dressing
  private buildSideboard(b: StaticBatch): void {
    const x = -3.3;
    const z = ROOM_BACK_Z + 0.3;
    const wood = texToon(woodTexture("#4A2A1E", "#2A160E", 13, true));
    const top = toon("#5E3626");
    b.addAt(new THREE.BoxGeometry(1.5, 0.82, 0.48), wood, v3(x, 0.41, z), null, 1, { outline: 1.02, castShadow: true });
    b.addAt(new THREE.BoxGeometry(1.58, 0.05, 0.54), top, v3(x, 0.845, z), null, 1, { outline: 1.03 });
    const knob = toon(PALETTE.gold);
    for (const dx of [-0.37, 0.37]) {
      b.addAt(new THREE.BoxGeometry(0.66, 0.6, 0.02), toon("#3A2018"), v3(x + dx, 0.42, z + 0.245), null, 1);
      b.addAt(new THREE.SphereGeometry(0.025, 8, 6), knob, v3(x + dx + (dx < 0 ? 0.26 : -0.26), 0.45, z + 0.27));
    }
    // bottles (opaque toon glass) + glasses
    const bottleCols = ["#2E6B3A", "#7A3A1E", "#C9A15A", "#3A2E6B"];
    bottleCols.forEach((c, i) => {
      const bx = x - 0.62 + i * 0.13;
      const h = 0.26 + (i % 2) * 0.06;
      const m = toon(c);
      b.addAt(new THREE.CylinderGeometry(0.045, 0.05, h, 10), m, v3(bx, 0.87 + h / 2, z - 0.05), null, 1, { outline: 1.06 });
      b.addAt(new THREE.CylinderGeometry(0.016, 0.022, 0.1, 8), m, v3(bx, 0.87 + h + 0.05, z - 0.05), null, 1, { outline: 1.1 });
      b.addAt(new THREE.BoxGeometry(0.07, 0.07, 0.005), toon("#F4E7C6"), v3(bx, 0.87 + h * 0.45, z - 0.002));
    });
    // gramophone: box, turntable, horn
    const gx = x + 0.38;
    const gz = z;
    b.addAt(new THREE.BoxGeometry(0.34, 0.12, 0.3), toon("#5A2E1E"), v3(gx, 0.93, gz), null, 1, { outline: 1.04 });
    this.record.position.set(gx, 1.0, gz);
    const disc = new StaticBatch();
    disc.addAt(new THREE.CylinderGeometry(0.13, 0.13, 0.01, 24), toon("#141014"), v3(0, 0, 0));
    disc.addAt(new THREE.CylinderGeometry(0.045, 0.045, 0.012, 16), toon("#C3262E"), v3(0, 0, 0));
    this.record.add(disc.build("record"));
    this.group.add(this.record);
    const brass = toon("#D9A441");
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.3, 8), brass);
    neck.position.set(gx + 0.12, 1.12, gz - 0.06);
    neck.rotation.z = 0.5;
    b.addObject(wrap(neck), { outline: 1.08 });
    const hornG = new THREE.Group();
    hornG.position.set(gx - 0.02, 1.36, gz - 0.02);
    hornG.rotation.set(0.5, 0, -0.75);
    const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.025, 0.36, 18, 1, true), toon("#E0B04A", { side: THREE.DoubleSide }));
    horn.userData.noOutline = true;
    const hornRim = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.014, 6, 24), toon(PALETTE.ink));
    hornRim.position.y = 0.18;
    hornRim.rotation.x = Math.PI / 2;
    hornRim.userData.noOutline = true;
    hornG.add(horn, hornRim);
    b.addObject(wrap(hornG));
  }

  private buildCrates(b: StaticBatch): void {
    const crate = texToon(crateTexture());
    const brick = texToon(brickTexture());
    const x = -3.85;
    const z = -2.15;
    b.addAt(new THREE.BoxGeometry(0.62, 0.55, 0.62), crate, v3(x, 0.275, z), eul(0, 0.12, 0), 1, { outline: 1.02, castShadow: true });
    b.addAt(new THREE.BoxGeometry(0.5, 0.42, 0.5), crate, v3(x + 0.04, 0.76, z - 0.02), eul(0, -0.2, 0), 1, { outline: 1.03, castShadow: true });
    // bricks of cash spilling out of the top crate
    const bricks: [number, number, number, number][] = [
      [0.0, 0.99, 0.0, 0.3],
      [0.1, 1.02, 0.08, -0.4],
      [-0.08, 1.04, -0.06, 1.1],
      [0.18, 0.62, 0.38, 0.2],
    ];
    for (const [dx, y, dz, r] of bricks) b.addAt(new THREE.BoxGeometry(0.2, 0.05, 0.1), brick, v3(x + dx, y, z + dz), eul(0.1, r, 0.08), 1, { outline: 1.06 });
    // a third crate on the floor in front, lid ajar
    b.addAt(new THREE.BoxGeometry(0.5, 0.36, 0.5), crate, v3(-3.75, 0.18, -1.45), eul(0, 0.5, 0), 1, { outline: 1.03, castShadow: true });
    b.addAt(new THREE.BoxGeometry(0.52, 0.03, 0.52), toon("#6E4426"), v3(-3.72, 0.4, -1.42), eul(0.18, 0.4, 0.1), 1, { outline: 1.04 });
  }

  private buildSafe(b: StaticBatch): void {
    const x = -ROOM_HALF_X + 0.45;
    const z = 0.9;
    const iron = toon("#3D4A44");
    const trim = toon("#C9A15A");
    b.addAt(new THREE.BoxGeometry(0.8, 1.15, 0.8), iron, v3(x, 0.62, z), null, 1, { outline: 1.02, castShadow: true });
    b.addAt(new THREE.BoxGeometry(0.86, 0.08, 0.86), toon("#2A332F"), v3(x, 0.04, z), null, 1, { outline: 1.02 });
    const face = new THREE.Group();
    face.position.set(x + 0.41, 0.62, z);
    face.rotation.y = Math.PI / 2;
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.95, 0.03), toon("#46554E"));
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.04, 20), trim);
    dial.rotation.x = Math.PI / 2;
    dial.position.set(0.05, 0.12, 0.03);
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 10), toon(PALETTE.ink));
    knob.rotation.x = Math.PI / 2;
    knob.position.set(0.05, 0.12, 0.06);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.22, 0.04), trim);
    handle.position.set(0.05, -0.18, 0.05);
    const hinge1 = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.14, 8), trim);
    hinge1.position.set(-0.32, 0.3, 0.02);
    const hinge2 = hinge1.clone();
    hinge2.position.y = -0.3;
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.09),
      texToon(
        textTexture(256, 80, (g, W, H) => {
          g.fillStyle = "#C9A15A";
          g.fillRect(0, 0, W, H);
          g.fillStyle = "#2A1A0A";
          g.font = `700 56px ${FONT}`;
          g.textAlign = "center";
          g.textBaseline = "middle";
          g.fillText("KASA", W / 2, H / 2 + 3);
        }),
      ),
    );
    plate.position.set(0.05, 0.36, 0.017);
    plate.userData.noOutline = true;
    face.add(door, dial, knob, handle, hinge1, hinge2, plate);
    b.addObject(wrap(face), { outline: 1.05 });
    // a fedora left on top of the safe
    b.addAt(new THREE.CylinderGeometry(0.2, 0.2, 0.015, 20), toon("#2B2530"), v3(x, 1.205, z + 0.05), null, 1, { outline: 1.06 });
    b.addAt(new THREE.CylinderGeometry(0.1, 0.12, 0.12, 14), toon("#2B2530"), v3(x, 1.27, z + 0.05), null, 1, { outline: 1.06 });
    b.addAt(new THREE.CylinderGeometry(0.122, 0.122, 0.03, 14), toon("#C3262E"), v3(x, 1.235, z + 0.05));
  }

  private buildWallArt(b: StaticBatch): void {
    // boss portrait (left wall, facing +x)
    const px = -ROOM_HALF_X + 0.05;
    const pz = -1.05;
    const frame = toon("#B8862E");
    const art = new THREE.Group();
    art.position.set(px, 1.98, pz);
    art.rotation.y = Math.PI / 2;
    const fr = new THREE.Mesh(new THREE.BoxGeometry(0.98, 1.2, 0.07), frame);
    const inner = new THREE.Mesh(new THREE.BoxGeometry(0.86, 1.08, 0.075), toon("#7A5418"));
    const pic = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.0), texToon(portraitTexture()));
    pic.position.z = 0.04;
    pic.userData.noOutline = true;
    const plaque = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.1), texToon(plaqueTexture("PATRON")));
    plaque.position.set(0, -0.7, 0.01);
    plaque.userData.noOutline = true;
    art.add(fr, inner, pic, plaque);
    b.addObject(wrap(art), { outline: 1.03 });

    // wall clock (right wall, facing −x); hands are live
    const clock = new THREE.Group();
    clock.position.set(ROOM_HALF_X - 0.05, 2.32, -1.15);
    clock.rotation.y = -Math.PI / 2;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.07, 28), toon(PALETTE.woodDark));
    rim.rotation.x = Math.PI / 2;
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.26, 28), new THREE.MeshBasicMaterial({ color: "#B8AA8C", map: clockFaceTexture() }));
    face.position.z = 0.036;
    face.userData.noOutline = true;
    clock.add(rim, face);
    b.addObject(wrap(clock), { outline: 1.04 });
    const handMat = new THREE.MeshBasicMaterial({ color: PALETTE.ink });
    const live = new THREE.Group();
    live.position.copy(clock.position);
    live.rotation.copy(clock.rotation);
    for (const [hand, len, wid] of [[this.hourHand, 0.13, 0.026], [this.minuteHand, 0.21, 0.016]] as const) {
      hand.position.z = 0.042;
      const m = new THREE.Mesh(new THREE.BoxGeometry(wid, len, 0.008), handMat);
      m.position.y = len / 2 - 0.02;
      hand.add(m);
      live.add(hand);
    }
    this.group.add(live);

    // wanted poster (right wall near the door) + a tilted newspaper clipping
    const poster = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.64), texToon(wantedTexture()));
    b.addAt(poster.geometry, poster.material as THREE.Material, v3(ROOM_HALF_X - 0.012, 1.68, -2.55), eul(0, -Math.PI / 2, 0.04));
    const news = texToon(
      textTexture(200, 240, (g, W, H) => {
        g.fillStyle = "#E8E0CC";
        g.fillRect(0, 0, W, H);
        g.fillStyle = "#1E1A16";
        g.font = `700 26px ${FONT}`;
        g.textAlign = "center";
        g.fillText("PAVYONA", W / 2, 36);
        g.fillText("BASKIN!", W / 2, 66);
        g.fillStyle = "#555";
        g.fillRect(20, 84, W - 40, 70);
        g.fillStyle = "#1E1A16";
        for (let i = 0; i < 5; i++) g.fillRect(20, 168 + i * 13, W - 40 - (i % 2) * 30, 5);
      }),
    );
    b.addAt(new THREE.PlaneGeometry(0.34, 0.41), news, v3(ROOM_HALF_X - 0.014, 1.5, 0.25), eul(0, -Math.PI / 2, -0.08));
  }

  private buildCoatRack(b: StaticBatch): void {
    const x = 3.75;
    const z = ROOM_BACK_Z + 0.42;
    const wood = toon(PALETTE.woodDark);
    b.addAt(new THREE.CylinderGeometry(0.03, 0.035, 1.8, 8), wood, v3(x, 0.9, z), null, 1, { outline: 1.12, castShadow: true });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      b.addAt(new THREE.CylinderGeometry(0.018, 0.018, 0.42, 6), wood, v3(x + Math.cos(a) * 0.15, 0.08, z + Math.sin(a) * 0.15), eul(Math.sin(a) * 1.1, 0, -Math.cos(a) * 1.1), 1, { outline: 1.15 });
    }
    // trench coat hanging + fedora on top
    const coat = toon("#8A7350");
    b.addAt(new THREE.CapsuleGeometry(0.16, 0.6, 4, 10), coat, v3(x - 0.08, 1.22, z + 0.12), eul(0.08, 0, 0.05), new THREE.Vector3(1, 1, 0.55), { outline: 1.04, castShadow: true });
    b.addAt(new THREE.SphereGeometry(0.06, 8, 6), coat, v3(x - 0.08, 1.62, z + 0.1), null, 1, { outline: 1.06 });
    b.addAt(new THREE.CylinderGeometry(0.17, 0.17, 0.012, 18), toon("#3A2E24"), v3(x, 1.82, z), eul(0.12, 0, 0.1), 1, { outline: 1.08 });
    b.addAt(new THREE.CylinderGeometry(0.085, 0.1, 0.11, 12), toon("#3A2E24"), v3(x + 0.01, 1.88, z), eul(0.12, 0, 0.1), 1, { outline: 1.08 });
    b.addAt(new THREE.CylinderGeometry(0.102, 0.102, 0.03, 12), toon(PALETTE.ink), v3(x + 0.006, 1.845, z), eul(0.12, 0, 0.1));
  }

  private buildPalm(b: StaticBatch): void {
    const x = ROOM_HALF_X - 0.45;
    const z = 0.7;
    b.addAt(new THREE.CylinderGeometry(0.22, 0.17, 0.42, 12), toon("#8A3A2A"), v3(x, 0.21, z), null, 1, { outline: 1.04, castShadow: true });
    b.addAt(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 12), toon("#2A1A12"), v3(x, 0.41, z));
    const trunk = toon("#6B4A2A");
    for (let i = 0; i < 4; i++) b.addAt(new THREE.CylinderGeometry(0.05 - i * 0.006, 0.055 - i * 0.006, 0.3, 7), trunk, v3(x + i * 0.02, 0.57 + i * 0.28, z), eul(0, 0, -0.06), 1, { outline: 1.08 });
    const leaf = toon("#2F7A44", { side: THREE.DoubleSide });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const geo = new THREE.PlaneGeometry(0.7, 0.16, 4, 1);
      const p = geo.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < p.count; k++) {
        const lx = p.getX(k) + 0.35;
        p.setY(k, p.getY(k) * (1 - lx / 0.8));
        p.setZ(k, -lx * lx * 0.55);
      }
      geo.translate(0.35, 0, 0);
      geo.computeVertexNormals();
      b.addAt(geo, leaf, v3(x + 0.07, 1.68, z), new THREE.Euler(-Math.PI / 2 + 0.5, a, 0, "YXZ"));
    }
  }

  private buildSconces(b: StaticBatch): void {
    const brass = toon("#B8862E");
    const shade = toon("#7A2A2A", { emissive: "#5A1A10", emissiveIntensity: 0.6 });
    const spots: [number, number, number][] = [
      [-ROOM_HALF_X + 0.06, 1.75, 1.9],
      [ROOM_HALF_X - 0.06, 1.75, 1.9],
      [-ROOM_HALF_X + 0.06, 1.8, -2.65],
      [-3.3, 1.95, ROOM_BACK_Z + 0.06],
    ];
    for (const [x, y, z] of spots) {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      if (Math.abs(x) > ROOM_HALF_X - 0.2) g.rotation.y = x < 0 ? Math.PI / 2 : -Math.PI / 2;
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 12), brass);
      plate.rotation.x = Math.PI / 2;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 6), brass);
      arm.rotation.x = Math.PI / 2;
      arm.position.z = 0.08;
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.05, 0.12, 12), shade);
      cup.position.set(0, 0.06, 0.16);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), this.sconceMat);
      bulb.position.set(0, 0.0, 0.16);
      bulb.userData.noOutline = true;
      g.add(plate, arm, cup, bulb);
      b.addObject(wrap(g), { outline: 1.08 });
    }
  }

  /** Wheel slot flaps open (true) / closed. */
  setSlotOpen(open: boolean): void {
    this.flapTarget = open ? 1 : 0;
  }

  update(dt: number, time: number): void {
    // clock: stuck near 03:00, the minute hand twitches every second
    const tick = Math.floor(time);
    const twitch = Math.exp(-(time - tick) * 10) * 0.05;
    this.minuteHand.rotation.z = -((tick % 60) / 60) * 0.5 - twitch;
    this.hourHand.rotation.z = -Math.PI / 2 - 0.02;
    this.record.rotation.y -= dt * 3.5;
    // slot flaps swing open with a little overshoot
    const k = 1 - Math.exp(-(this.flapTarget > this.flapOpen ? 7 : 4) * dt);
    this.flapOpen += (this.flapTarget - this.flapOpen) * k;
    for (const f of this.flaps) {
      const s = f.userData.side as number;
      f.rotation.x = -s * this.flapOpen * 1.5;
    }
  }
}

/** Wrap an object in a parent so StaticBatch.addObject bakes its own transform too. */
function wrap(o: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  g.add(o);
  return g;
}
