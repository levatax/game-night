// The fridge (with a magnet face: googly eyes + a mustache) and the NEON CASINO SIGN above it.
// Sign text is a canvas texture redrawn only when it changes; the marquee bulbs around the board are
// small meshes that swap between shared on/off materials for the chase pattern. Idle text is
// "JELLY JACKPOT" with one cheap neon letter that keeps buzzing out.

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { t as tx, upper } from "../../i18n";
import { addOutlines, googlyEyes, jiggleEyes, toon } from "../toon";
import { ROOM_HALF } from "./Room";
import { FLOOR_Y } from "./Table";

const SIGN_FONT = `"Fredoka", "Baloo 2", system-ui, sans-serif`;
const IDLE_COLOR = "#FF8BD1";
const GOLD = "#FFD700";
const BOARD_W = 1.9;
const BOARD_H = 0.62;
/** Sign center height: low enough to peek into the default 35° camera view. */
const SIGN_Y = 0.88;

export class NeonSign {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;

  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private textMat: THREE.MeshBasicMaterial;
  private bulbs: THREE.Mesh[] = [];
  private bulbOn = new THREE.MeshBasicMaterial({ color: "#FFE9A8" });
  private bulbOff = new THREE.MeshBasicMaterial({ color: "#6B5530" });
  private bulbGold = new THREE.MeshBasicMaterial({ color: GOLD });
  private text: string | null = null;
  private color = IDLE_COLOR;
  private brokenDim = false;
  private flashT = 0;
  private jackpot = false;
  private fridge = new THREE.Group();
  private fridgeEyes: THREE.Group;
  private freezerDoor = new THREE.Group();
  reducedFlashing = false;

  constructor() {
    this.canvas.width = 1024;
    this.canvas.height = 256;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.textMat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false });

    this.fridgeEyes = googlyEyes(0.06, 0.09);
    this.buildFridge();
    this.buildSign();
    this.light = new THREE.PointLight(IDLE_COLOR, 1.6, 4, 1.4);
    this.light.position.set(-1.6, SIGN_Y, -ROOM_HALF + 0.8);
    this.group.add(this.light);
    this.redraw();
  }

  private buildFridge(): void {
    const f = this.fridge;
    const W = 0.9;
    const H = SIGN_Y - BOARD_H / 2 - 0.08 - FLOOR_Y;
    const D = 0.72;
    f.position.set(-1.6, FLOOR_Y, -ROOM_HALF + D / 2 + 0.02);
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), toon("#BFF0E0"));
    body.position.y = H / 2;
    const doorMat = toon("#D6FFF1");
    const lower = new THREE.Mesh(new THREE.BoxGeometry(W - 0.04, H * 0.62, 0.04), doorMat);
    lower.position.set(0, H * 0.31 + 0.02, D / 2 + 0.02);
    // freezer door on a hinge (left side) so it can burp open a crack
    this.freezerDoor.position.set(-W / 2 + 0.02, H * 0.81, D / 2 + 0.02);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(W - 0.04, H * 0.34, 0.04), doorMat);
    upper.position.x = W / 2 - 0.02;
    this.freezerDoor.add(upper);
    const handleMat = toon("#9AA6B8");
    const h1 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.4, 0.05), handleMat);
    h1.position.set(W / 2 - 0.08, H * 0.48, D / 2 + 0.06);
    const h2 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.22, 0.05), handleMat);
    h2.position.set(W - 0.1, -0.06, 0.04);
    this.freezerDoor.add(h2);
    // magnet face on the freezer door
    this.fridgeEyes.position.set(W / 2 - 0.05, 0.03, 0.04);
    this.freezerDoor.add(this.fridgeEyes);
    const stache = new THREE.Group();
    const stacheMat = toon("#5A3A2A");
    for (const s of [-1, 1]) {
      const curl = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.018, 6, 12, Math.PI * 1.3), stacheMat);
      curl.position.x = s * 0.055;
      curl.rotation.z = -0.5;
      curl.scale.x = s; // mirror the left curl
      stache.add(curl);
    }
    stache.position.set(W / 2 - 0.05, -0.08, 0.035);
    this.freezerDoor.add(stache);
    // colorful magnets scattered on the lower door
    const magnetColors = ["#FF5A5F", "#3FA7FF", "#7BE07B", "#FFC23F", "#B07CFF"];
    magnetColors.forEach((c, i) => {
      const geo = i % 2 ? new THREE.CylinderGeometry(0.035, 0.035, 0.02, 5) : new THREE.SphereGeometry(0.03, 8, 6);
      const m = new THREE.Mesh(geo, toon(c));
      m.rotation.x = Math.PI / 2;
      m.position.set(-0.28 + i * 0.13, H * 0.42 + Math.sin(i * 2.1) * 0.12, D / 2 + 0.05);
      f.add(m);
    });
    // a crayon drawing of a cake held up by a magnet
    const art = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.2), new THREE.MeshBasicMaterial({ map: drawingTexture() }));
    art.position.set(0.12, H * 0.25, D / 2 + 0.042);
    art.rotation.z = 0.08;
    art.userData.noOutline = true;
    f.add(body, lower, h1, this.freezerDoor, art);
    f.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.receiveShadow = true;
    });
    addOutlines(f, 1.025);
    this.group.add(f);
  }

  private buildSign(): void {
    const s = new THREE.Group();
    s.position.set(-1.6, SIGN_Y, -ROOM_HALF + 0.08);
    const board = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, BOARD_H, 0.06), toon("#1B1730"));
    const frame = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W + 0.08, BOARD_H + 0.08, 0.04), toon("#C9A15A"));
    frame.position.z = -0.02;
    addOutlines(frame, 1.02);
    const text = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W - 0.16, (BOARD_W - 0.16) / 4), this.textMat);
    text.position.z = 0.035;
    text.renderOrder = 3;
    s.add(frame, board, text);
    // marquee bulbs around the frame
    const geo = new THREE.SphereGeometry(0.022, 8, 6);
    const perim = 2 * (BOARD_W + BOARD_H);
    const n = 34;
    for (let i = 0; i < n; i++) {
      let d = (i / n) * perim;
      let x: number;
      let y: number;
      const hw = BOARD_W / 2;
      const hh = BOARD_H / 2;
      if (d < BOARD_W) [x, y] = [-hw + d, hh];
      else if ((d -= BOARD_W) < BOARD_H) [x, y] = [hw, hh - d];
      else if ((d -= BOARD_H) < BOARD_W) [x, y] = [hw - d, -hh];
      else [x, y] = [-hw, -hh + (d - BOARD_W)];
      const b = new THREE.Mesh(geo, this.bulbOn);
      b.position.set(x, y, 0.045);
      s.add(b);
      this.bulbs.push(b);
    }
    // two dangling chains up to the ceiling, slightly crooked
    const chainMat = toon("#9AA6B8");
    for (const side of [-1, 1]) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.8, 4), chainMat);
      c.position.set(side * 0.7, BOARD_H / 2 + 0.4, 0);
      s.add(c);
    }
    s.rotation.z = 0.025; // hung slightly crooked, on purpose
    s.rotation.x = 0.12; // tipped toward the table so it reads from the default camera
    this.group.add(s);
  }

  /** Card name + rarity color; null = idle marquee. */
  set(text: string | null, color?: string): void {
    this.text = text;
    this.color = text === null ? IDLE_COLOR : color ?? "#FFFFFF";
    this.flashT = 0.7;
    this.redraw();
  }

  setJackpot(on: boolean): void {
    if (on === this.jackpot) return;
    this.jackpot = on;
    this.redraw();
  }

  private redraw(): void {
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    const label = upper(this.text ?? tx("scene.signIdle"));
    const color = this.jackpot ? GOLD : this.color;
    let size = 150;
    g.font = `700 ${size}px ${SIGN_FONT}`;
    while (g.measureText(label).width > W - 60 && size > 40) {
      size -= 6;
      g.font = `700 ${size}px ${SIGN_FONT}`;
    }
    g.textBaseline = "middle";
    const total = g.measureText(label).width;
    // cheap neon: in idle mode the O of JACKPOT keeps buzzing out
    const broken = this.text === null ? label.lastIndexOf("O") : -1;
    let x = (W - total) / 2;
    for (let i = 0; i < label.length; i++) {
      const ch = label[i]!;
      const w = g.measureText(ch).width;
      const dim = i === broken && this.brokenDim;
      g.globalAlpha = dim ? 0.18 : 1;
      g.shadowColor = color;
      for (const blur of dim ? [0] : [40, 20]) {
        g.shadowBlur = blur;
        g.lineWidth = 10;
        g.strokeStyle = color;
        g.strokeText(ch, x, H / 2 + 6);
      }
      g.shadowBlur = 0;
      g.fillStyle = "#FFFFFF";
      g.fillText(ch, x, H / 2 + 6);
      x += w;
    }
    g.globalAlpha = 1;
    this.texture.needsUpdate = true;
    this.light.color.set(color);
  }

  update(dt: number, time: number, rattle: number): void {
    // buzzing broken letter (idle only), redraw only on state change
    if (this.text === null) {
      const dim = Math.sin(time * 3.1) + Math.sin(time * 7.7) > 1.3 || (Math.sin(time * 0.37) > 0.92 && Math.random() < 0.5);
      if (dim !== this.brokenDim) {
        this.brokenDim = dim;
        this.redraw();
      }
    }
    // flash when a new card lands
    if (this.flashT > 0) {
      this.flashT = Math.max(0, this.flashT - dt);
      const on = this.reducedFlashing ? 1 : Math.floor(this.flashT * 14) % 2 === 0;
      this.textMat.opacity = this.reducedFlashing ? 1 - this.flashT * 0.5 : on ? 1 : 0.25;
    } else {
      this.textMat.opacity = 0.93 + Math.sin(time * 50) * 0.04 + Math.sin(time * 3) * 0.03;
    }
    // bulb chase
    const n = this.bulbs.length;
    if (this.jackpot) {
      const rate = this.reducedFlashing ? 3 : 14;
      const step = Math.floor(time * rate);
      for (let i = 0; i < n; i++) this.bulbs[i]!.material = (i + step) % 2 === 0 ? this.bulbGold : this.bulbOff;
    } else {
      const step = Math.floor(time * (this.flashT > 0 ? 16 : 6));
      for (let i = 0; i < n; i++) this.bulbs[i]!.material = (i + step) % 3 === 0 ? this.bulbOff : this.bulbOn;
    }
    this.light.intensity = this.jackpot ? (this.reducedFlashing ? 2 : 1.5 + Math.abs(Math.sin(time * 12)) * 2) : 1.4 + this.textMat.opacity * 0.3;

    // fridge: hum shudder + freezer burp every ~11 s
    const c = time % 11;
    const burp = c > 9.6 && c < 10.6 ? Math.sin(((c - 9.6) / 1) * Math.PI) : 0;
    this.freezerDoor.rotation.y = -burp * 0.25 - rattle * Math.abs(Math.sin(time * 22)) * 0.3;
    const hum = c > 4 && c < 4.6 ? 1 : 0;
    this.fridge.position.x = -1.6 + (hum * 0.003 + rattle * 0.012) * Math.sin(time * 70);
    jiggleEyes(this.fridgeEyes, dt, burp * 3 + hum + rattle * 3);
  }
}

/** Crayon kid drawing of a cake with a stick-figure chef. */
function drawingTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 100;
  const g = c.getContext("2d")!;
  g.fillStyle = "#FFFDF4";
  g.fillRect(0, 0, 128, 100);
  g.lineWidth = 4;
  g.lineCap = "round";
  g.strokeStyle = PALETTE.frostingShadow;
  g.strokeRect(30, 50, 50, 30);
  g.strokeStyle = "#FFC23F";
  g.beginPath();
  g.moveTo(55, 50);
  g.lineTo(55, 36);
  g.stroke();
  g.strokeStyle = "#3FA7FF";
  g.beginPath();
  g.arc(100, 40, 9, 0, Math.PI * 2);
  g.moveTo(100, 49);
  g.lineTo(100, 75);
  g.moveTo(88, 60);
  g.lineTo(112, 58);
  g.moveTo(100, 75);
  g.lineTo(92, 90);
  g.moveTo(100, 75);
  g.lineTo(108, 90);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
