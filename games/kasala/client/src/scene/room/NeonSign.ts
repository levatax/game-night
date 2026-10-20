// The neon "KASALA" sign on the back wall: art-deco Monoton letters as pink (#FF3C8E) tubes with a white-hot
// core on a dark backboard, additive glows over every letter and a wall halo. Cheap neon: the word is painted
// ONCE into a two-row atlas (row 1 lit tubes, row 2 dark glass) and the sign is six letter quads in one mesh;
// a stuttering letter just swaps its quad's UVs to the dark row (no canvas repaint, no texture upload). The
// canvas is only repainted when the tube color changes (SON MASA). Every few seconds one letter stutters
// (never with reduced flashing). Off (lights out) = dark glass tubes. There is no point light: the pink wash
// on the wall is a baked additive halo (keeps the light count, and so every toon shader, small).

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { fontsReady, toon } from "../toon";
import { StaticBatch } from "./batch";
import { SIGN_POS } from "./layout";
import { DECO_FONT, makeCanvas, softDotTexture } from "./textures";

const TEXT = "KASALA";
const N = TEXT.length;
const CW = 1024;
/** One row of the atlas (the canvas holds two: lit on top, dark below). */
const CH = 320;
const BOARD_W = 2.0;
const BOARD_H = 0.66;
const TEXT_W = 1.86;
const TEXT_H = (TEXT_W * CH) / CW;
const GLOW_ALPHA = 0.55;
const GLOW_OFF_ALPHA = 0.05;

/** A flat quad list (position + uv + rgba color) in one BufferGeometry. */
function quads(count: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(count * 4 * 3), 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(count * 4 * 2), 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(count * 4 * 4).fill(1), 4));
  const index: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = i * 4;
    index.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
  }
  g.setIndex(index);
  return g;
}

/** Write quad `i`: corners (x0,y0)-(x1,y1) at depth z, uv rect (u0,v0)-(u1,v1). */
function setQuad(g: THREE.BufferGeometry, i: number, x0: number, y0: number, x1: number, y1: number, z: number, u0 = 0, v0 = 0, u1 = 1, v1 = 1): void {
  const p = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const v = i * 4;
  p.setXYZ(v, x0, y1, z);
  p.setXYZ(v + 1, x0, y0, z);
  p.setXYZ(v + 2, x1, y1, z);
  p.setXYZ(v + 3, x1, y0, z);
  uv.setXY(v, u0, v1);
  uv.setXY(v + 1, u0, v0);
  uv.setXY(v + 2, u1, v1);
  uv.setXY(v + 3, u1, v0);
  p.needsUpdate = true;
  uv.needsUpdate = true;
}

function setQuadAlpha(g: THREE.BufferGeometry, i: number, alpha: number): void {
  const c = g.attributes.color as THREE.BufferAttribute;
  for (let k = 0; k < 4; k++) c.setW(i * 4 + k, alpha);
  c.needsUpdate = true;
}

export class NeonSign {
  readonly group = new THREE.Group();
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private letters: THREE.BufferGeometry;
  private glowGeo: THREE.BufferGeometry;
  private glowMat: THREE.MeshBasicMaterial;
  private haloMat: THREE.MeshBasicMaterial;
  private letterX: number[] = [];
  /** Letter slice edges in canvas px (N + 1). */
  private edges: number[] = [];
  private lit: boolean[] = TEXT.split("").map(() => true);
  /** What each letter quad currently shows (true = lit row). */
  private shownLit: boolean[] = TEXT.split("").map(() => false);
  private color = new THREE.Color(PALETTE.neonPink);
  private colorHex: string = PALETTE.neonPink;
  private paintedHex = "";
  /** 0 = off .. 1 = full (moods). */
  power = 1;
  private shown = 1;
  private stutterLetter = -1;
  private stutterT = 0;
  private nextStutter = 3;
  private dipT = 0;
  private size = 180;

  constructor() {
    [this.canvas, this.ctx] = makeCanvas(CW, CH * 2);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.group.position.copy(SIGN_POS);

    // backboard + thin brass frame + wall brackets (one static batch)
    const b = new StaticBatch();
    b.addAt(new THREE.BoxGeometry(BOARD_W, BOARD_H, 0.05), toon("#140E16"), new THREE.Vector3(0, 0, 0.03));
    b.addAt(new THREE.BoxGeometry(BOARD_W + 0.06, BOARD_H + 0.06, 0.03), toon("#8A6A2E"), new THREE.Vector3(0, 0, 0.012), null, 1, { outline: 1.02 });
    for (const s of [-1, 1]) {
      b.addAt(new THREE.BoxGeometry(0.05, 0.05, 0.09), toon("#5A5560"), new THREE.Vector3(s * (BOARD_W / 2 - 0.15), BOARD_H / 2 + 0.03, 0.03), null, 1, { outline: 1.1 });
    }
    this.group.add(b.build("neonBoard"));

    // tube letters: six quads sampling the lit or the dark atlas row
    this.letters = quads(N);
    const plane = new THREE.Mesh(
      this.letters,
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, toneMapped: false, fog: false }),
    );
    plane.position.z = 0.075;
    plane.renderOrder = 4;
    plane.raycast = () => {};
    this.group.add(plane);

    // glows: a wall wash + halo behind the board, one soft glow over every letter (vertex alpha per quad)
    const dot = softDotTexture();
    const haloGeo = quads(2);
    setQuad(haloGeo, 0, -2.6, -1.55, 2.6, 1.45, 0);
    setQuad(haloGeo, 1, -1.8, -0.85, 1.8, 0.85, 0.01);
    setQuadAlpha(haloGeo, 0, 0.32);
    setQuadAlpha(haloGeo, 1, 1);
    this.haloMat = new THREE.MeshBasicMaterial({ map: dot, color: this.color, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.32, fog: false });
    const halo = new THREE.Mesh(haloGeo, this.haloMat);
    halo.position.z = 0.02;
    halo.renderOrder = 3;
    halo.raycast = () => {};
    this.group.add(halo);
    this.glowGeo = quads(N);
    this.glowMat = new THREE.MeshBasicMaterial({ map: dot, color: this.color, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 1, fog: false });
    const glows = new THREE.Mesh(this.glowGeo, this.glowMat);
    glows.position.z = 0.1;
    glows.renderOrder = 5;
    glows.raycast = () => {};
    this.group.add(glows);

    this.measure();
    this.paint();
    void fontsReady().then(() => {
      this.measure();
      this.paintedHex = "";
      this.paint();
    });
  }

  /** Tube color (pink normally, siren red on SON MASA). */
  setColor(hex: string): void {
    if (hex === this.colorHex) return;
    this.colorHex = hex;
    this.color.set(hex);
  }

  /** Fit the word into the canvas, cache letter centers and slice edges, lay out the letter + glow quads. */
  private measure(): void {
    const g = this.ctx;
    let size = 200;
    const spacing = 8;
    let widths: number[] = [];
    let total = 0;
    for (; size > 60; size -= 6) {
      g.font = `400 ${size}px ${DECO_FONT}`;
      widths = TEXT.split("").map((ch) => g.measureText(ch).width);
      total = widths.reduce((a, b) => a + b, 0) + spacing * (N - 1);
      if (total <= CW - 70) break;
    }
    this.size = size;
    let x = (CW - total) / 2;
    this.letterX = widths.map((w) => {
      const cx = x + w / 2;
      x += w + spacing;
      return cx;
    });
    this.edges = [0];
    for (let i = 1; i < N; i++) this.edges.push((this.letterX[i - 1]! + this.letterX[i]!) / 2);
    this.edges.push(CW);
    for (let i = 0; i < N; i++) {
      const cx = (this.letterX[i]! / CW - 0.5) * TEXT_W;
      setQuad(this.glowGeo, i, cx - 0.275, -0.295, cx + 0.275, 0.255, 0);
    }
    this.applyLetters(true);
    this.letters.computeBoundingSphere();
    this.glowGeo.computeBoundingSphere();
  }

  /** Paint both atlas rows (lit tubes on top, dark glass below). Only on color / font changes. */
  private paint(): void {
    if (this.paintedHex === this.colorHex) return;
    this.paintedHex = this.colorHex;
    const g = this.ctx;
    g.clearRect(0, 0, CW, CH * 2);
    g.font = `400 ${this.size}px ${DECO_FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const core = new THREE.Color(this.colorHex).lerp(new THREE.Color("#FFFFFF"), 0.6).getStyle();
    for (let row = 0; row < 2; row++) {
      const y = row * CH + CH / 2 + 6;
      for (let i = 0; i < N; i++) {
        const ch = TEXT[i]!;
        const x = this.letterX[i] ?? CW / 2;
        // dark glass tube (always visible)
        g.shadowBlur = 0;
        g.fillStyle = "#4A1A2E";
        g.fillText(ch, x + 3, y + 3);
        if (row === 1) continue;
        g.shadowColor = this.colorHex;
        g.fillStyle = this.colorHex;
        g.shadowBlur = 44;
        g.fillText(ch, x, y);
        g.shadowBlur = 18;
        g.fillText(ch, x, y);
        g.shadowBlur = 6;
        g.fillStyle = core;
        g.fillText(ch, x, y);
      }
    }
    g.shadowBlur = 0;
    this.texture.needsUpdate = true;
  }

  /** Point each letter quad at the lit or dark row (only the letters that changed). */
  private applyLetters(force = false): void {
    const on = this.shown > 0.5;
    for (let i = 0; i < N; i++) {
      const lit = on && this.lit[i]!;
      if (!force && lit === this.shownLit[i]) continue;
      this.shownLit[i] = lit;
      const e0 = this.edges[i]!;
      const e1 = this.edges[i + 1]!;
      const x0 = (e0 / CW - 0.5) * TEXT_W;
      const x1 = (e1 / CW - 0.5) * TEXT_W;
      // canvas row 0 (lit) is the top half of the texture: v 0.5..1; row 1 (dark): v 0..0.5
      setQuad(this.letters, i, x0, -TEXT_H / 2, x1, TEXT_H / 2, 0, e0 / CW, lit ? 0.5 : 0, e1 / CW, lit ? 1 : 0.5);
      setQuadAlpha(this.glowGeo, i, lit ? GLOW_ALPHA : GLOW_OFF_ALPHA);
    }
  }

  update(dt: number, time: number, reducedFlashing: boolean): void {
    this.shown += (this.power - this.shown) * (1 - Math.exp(-6 * dt));
    // stutter scheduler
    if (!reducedFlashing && this.power > 0.5) {
      this.nextStutter -= dt;
      if (this.nextStutter <= 0) {
        this.stutterLetter = Math.floor(Math.random() * N);
        this.stutterT = 0.35 + Math.random() * 0.6;
        this.nextStutter = 3.5 + Math.random() * 6;
        if (Math.random() < 0.18) this.dipT = 0.25;
      }
    } else {
      this.stutterT = 0;
    }
    for (let i = 0; i < N; i++) this.lit[i] = true;
    if (this.stutterT > 0) {
      this.stutterT -= dt;
      const on = Math.sin(time * 61) + Math.sin(time * 23) > 0.3;
      this.lit[this.stutterLetter] = this.stutterT <= 0 || on;
    }
    let dip = 1;
    if (this.dipT > 0) {
      this.dipT -= dt;
      dip = 0.55;
    }
    this.paint();
    this.applyLetters();

    const level = this.shown * dip;
    const buzz = reducedFlashing ? 1 : 0.94 + Math.sin(time * 50) * 0.03 + Math.sin(time * 3.3) * 0.03;
    this.glowMat.color.copy(this.color);
    this.glowMat.opacity = level * buzz;
    this.haloMat.color.copy(this.color);
    this.haloMat.opacity = 0.32 * level * buzz;
  }
}
