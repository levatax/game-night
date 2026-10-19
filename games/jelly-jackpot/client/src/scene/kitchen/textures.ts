// Canvas textures for the kitchen: tablecloth checks, floor tiles, polka dots, steam puff, night sky,
// the clock face with scrambled numbers. All generated once at boot (no image files).

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function tex(c: HTMLCanvasElement, repeat = 1, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat !== 1) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
  }
  t.anisotropy = 4;
  return t;
}

/** Red/white picnic checks (with a slightly darker woven overlap where stripes cross). */
export function checkerTexture(cells = 8, repeat = 1): THREE.CanvasTexture {
  const size = 256;
  const [c, g] = canvas(size, size);
  const s = size / cells;
  g.fillStyle = PALETTE.tableclothCheck;
  g.fillRect(0, 0, size, size);
  g.fillStyle = PALETTE.tablecloth;
  g.globalAlpha = 0.55;
  for (let i = 0; i < cells; i += 2) {
    g.fillRect(i * s, 0, s, size);
    g.fillRect(0, i * s, size, s);
  }
  g.globalAlpha = 1;
  for (let x = 0; x < cells; x += 2) for (let y = 0; y < cells; y += 2) g.fillRect(x * s, y * s, s, s);
  return tex(c, repeat);
}

/** Dark purple diner floor tiles. */
export function floorTexture(repeat = 6): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = "#3A3558";
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#4E4775";
  g.fillRect(0, 0, 64, 64);
  g.fillRect(64, 64, 64, 64);
  g.strokeStyle = "#2A2640";
  g.lineWidth = 3;
  g.strokeRect(0, 0, 128, 128);
  g.beginPath();
  g.moveTo(64, 0);
  g.lineTo(64, 128);
  g.moveTo(0, 64);
  g.lineTo(128, 64);
  g.stroke();
  return tex(c, repeat);
}

/** Polka dots on a base color (curtains, the lamp shade). */
export function polkaTexture(base: string, dot: string, repeat = 2): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = dot;
  for (const [x, y] of [[32, 32], [96, 96], [96, 32], [32, 96], [64, 64], [0, 64], [128, 64], [64, 0], [64, 128]]) {
    g.beginPath();
    g.arc(x!, y!, 9, 0, Math.PI * 2);
    g.fill();
  }
  return tex(c, repeat);
}

/** Vertical stripes (candles, wallpaper). */
export function stripeTexture(a: string, b: string, stripes = 6, diagonal = true): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  g.fillStyle = a;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = b;
  const w = 64 / stripes;
  for (let i = -stripes; i < stripes * 2; i += 2) {
    g.beginPath();
    const skew = diagonal ? 32 : 0;
    g.moveTo(i * w, 0);
    g.lineTo(i * w + w, 0);
    g.lineTo(i * w + w + skew, 64);
    g.lineTo(i * w + skew, 64);
    g.fill();
  }
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Soft round puff for steam particles / glows (white, alpha falloff). */
export function softDotTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.45, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return tex(c);
}

/** Night sky gradient with stars (the window view). */
export function skyTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, "#141033");
  grd.addColorStop(1, "#3B2E6E");
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = "#FFF6C8";
  for (let i = 0; i < 40; i++) {
    const r = Math.random() * 1.6 + 0.5;
    g.beginPath();
    g.arc(Math.random() * 256, Math.random() * 200, r, 0, Math.PI * 2);
    g.fill();
  }
  // a tiny rooftop skyline at the bottom
  g.fillStyle = "#1A1538";
  let x = 0;
  while (x < 256) {
    const w = 20 + Math.random() * 30;
    const h = 20 + Math.random() * 40;
    g.fillRect(x, 256 - h, w, h);
    g.fillStyle = Math.random() < 0.5 ? "#1A1538" : "#221B47";
    x += w;
  }
  return tex(c);
}

/** Clock face with numbers in the wrong places (and a 13, and a question mark). */
export function clockFaceTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = "#FFF4DC";
  g.beginPath();
  g.arc(128, 128, 126, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 10;
  g.strokeStyle = "#FF8BD1";
  g.stroke();
  const labels = ["12", "7", "3", "13", "1", "?", "6", "2", "9", "11", "4", "8"];
  g.fillStyle = PALETTE.ink;
  g.textAlign = "center";
  g.textBaseline = "middle";
  labels.forEach((l, i) => {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const r = 96 + (i % 3) * 4;
    g.save();
    g.translate(128 + Math.cos(a) * r, 128 + Math.sin(a) * r);
    g.rotate((i % 2 ? 1 : -1) * 0.25 * (i % 4));
    g.font = `bold ${26 + (i % 3) * 4}px Fredoka, system-ui, sans-serif`;
    g.fillText(l, 0, 0);
    g.restore();
  });
  return tex(c);
}

/** A tiny "Zzz" sprite for the snoring moon. */
export function zzzTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  g.fillStyle = "#FFF6C8";
  g.font = "bold 46px Fredoka, system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineWidth = 6;
  g.strokeStyle = PALETTE.ink;
  g.strokeText("z", 32, 34);
  g.fillText("z", 32, 34);
  return tex(c);
}

/** Wind "whoosh" streak (white swoosh fading at both ends). */
export function whooshTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 32);
  const grd = g.createLinearGradient(0, 0, 128, 0);
  grd.addColorStop(0, "rgba(255,255,255,0)");
  grd.addColorStop(0.5, "rgba(255,255,255,0.9)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.strokeStyle = grd;
  g.lineWidth = 5;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(4, 20);
  g.bezierCurveTo(40, 4, 80, 30, 124, 12);
  g.stroke();
  return tex(c);
}
