// Canvas textures for the back room: wallpaper, wainscot wood, floor planks, the round rug, the felt, rail
// wood, smoke wisps, soft glows, light cones, the boss portrait, wall clock, door glass, crate stencil, the
// banknote brick and chip edge. Everything is generated once at boot (no image files). Textures with text
// repaint themselves once the web fonts are loaded (fontsReady).

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { fontsReady } from "../toon";

export const FONT = `"Fredoka", system-ui, sans-serif`;
export const DECO_FONT = `"Monoton", "Fredoka", system-ui, sans-serif`;

export function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

export function toTexture(c: HTMLCanvasElement, opts: { repeat?: [number, number]; srgb?: boolean; aniso?: number } = {}): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (opts.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(opts.repeat[0], opts.repeat[1]);
  }
  t.anisotropy = opts.aniso ?? 4;
  return t;
}

/** A texture whose painter uses text: painted now with fallback fonts, repainted when the web fonts land. */
export function textTexture(w: number, h: number, paint: (g: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const [c, g] = makeCanvas(w, h);
  paint(g, w, h);
  const t = toTexture(c);
  void fontsReady().then(() => {
    g.clearRect(0, 0, w, h);
    paint(g, w, h);
    t.needsUpdate = true;
  });
  return t;
}

/** Deterministic pseudo random (textures look the same every load). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
export { roundRect };

// ------------------------------------------------------------------------------------------ room
/** Dark plum damask wallpaper with thin pinstripes (tiles horizontally). */
export function wallpaperTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(256, 256);
  g.fillStyle = PALETTE.wall;
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = "#231C29";
  for (let x = 0; x < 256; x += 64) g.fillRect(x, 0, 3, 256);
  // damask lozenges: a diamond with a fleur dot in the middle, staggered
  const motif = (cx: number, cy: number) => {
    g.fillStyle = "#2A2131";
    g.beginPath();
    g.moveTo(cx, cy - 34);
    g.quadraticCurveTo(cx + 22, cy - 6, cx, cy + 34);
    g.quadraticCurveTo(cx - 22, cy - 6, cx, cy - 34);
    g.fill();
    g.fillStyle = "#33283A";
    g.beginPath();
    g.arc(cx, cy - 4, 7, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.arc(cx - 9, cy + 8, 4, 0, Math.PI * 2);
    g.arc(cx + 9, cy + 8, 4, 0, Math.PI * 2);
    g.fill();
  };
  for (const [x, y] of [[32, 64], [96, 192], [160, 64], [224, 192]] as const) motif(x, y);
  for (const [x, y] of [[32, -64], [96, 320 - 256], [160, 320], [224, -64]] as const) motif(x, y);
  return toTexture(c, { repeat: [12, 1.6] });
}

/** Dark lacquered wood with vertical grain (wainscot panels, door, furniture). */
export function woodTexture(base: string, grain: string, seed = 7, horizontal = false): THREE.CanvasTexture {
  const [c, g] = makeCanvas(128, 128);
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 128);
  const r = rng(seed);
  g.strokeStyle = grain;
  for (let i = 0; i < 22; i++) {
    g.globalAlpha = 0.25 + r() * 0.35;
    g.lineWidth = 1 + r() * 2.5;
    const x0 = r() * 128;
    g.beginPath();
    if (horizontal) {
      g.moveTo(0, x0);
      g.bezierCurveTo(40, x0 + (r() - 0.5) * 10, 90, x0 + (r() - 0.5) * 10, 128, x0);
    } else {
      g.moveTo(x0, 0);
      g.bezierCurveTo(x0 + (r() - 0.5) * 10, 40, x0 + (r() - 0.5) * 10, 90, x0, 128);
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  return toTexture(c, { repeat: [1, 1] });
}

/** Floor: long dark planks with staggered joints. */
export function floorTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(256, 256);
  const r = rng(11);
  const rows = 8;
  const h = 256 / rows;
  for (let i = 0; i < rows; i++) {
    const shade = 30 + Math.floor(r() * 12);
    g.fillStyle = `rgb(${shade + 22}, ${shade + 6}, ${shade - 4})`;
    g.fillRect(0, i * h, 256, h);
    g.strokeStyle = "rgba(0,0,0,0.25)";
    g.lineWidth = 1;
    for (let k = 0; k < 3; k++) {
      const y = i * h + 4 + r() * (h - 8);
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(256, y + (r() - 0.5) * 4);
      g.stroke();
    }
    g.fillStyle = "#140D0C";
    g.fillRect(0, i * h, 256, 2);
    const joint = (i % 2 ? 60 : 180) + r() * 30;
    g.fillRect(joint, i * h, 2, h);
  }
  return toTexture(c, { repeat: [5, 5] });
}

/** Round burgundy rug with a gold border (drawn on a square, mapped to a circle). */
export function rugTexture(): THREE.CanvasTexture {
  const S = 512;
  const [c, g] = makeCanvas(S, S);
  const m = S / 2;
  g.fillStyle = "#4A1420";
  g.beginPath();
  g.arc(m, m, m, 0, Math.PI * 2);
  g.fill();
  const ring = (r: number, w: number, col: string) => {
    g.strokeStyle = col;
    g.lineWidth = w;
    g.beginPath();
    g.arc(m, m, r, 0, Math.PI * 2);
    g.stroke();
  };
  ring(m - 14, 14, "#B8862E");
  ring(m - 34, 4, "#B8862E");
  ring(m * 0.55, 3, "#7A2A34");
  // little gold diamonds around the border
  g.fillStyle = "#D8A848";
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const x = m + Math.cos(a) * (m - 24);
    const y = m + Math.sin(a) * (m - 24);
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.fillRect(-4, -4, 8, 8);
    g.restore();
  }
  // worn pile noise
  const r = rng(5);
  for (let i = 0; i < 1600; i++) {
    g.fillStyle = r() < 0.5 ? "rgba(0,0,0,0.12)" : "rgba(255,180,160,0.05)";
    g.fillRect(r() * S, r() * S, 2, 2);
  }
  return toTexture(c);
}

/** Felt top: #1F6B47 center fading to #134A31 at the rim, gold betting ring + a printed slogan circle. */
export function feltTexture(): THREE.CanvasTexture {
  const S = 1024;
  return textTexture(S, S, (g) => {
    const m = S / 2;
    const grd = g.createRadialGradient(m, m, 0, m, m, m);
    grd.addColorStop(0, "#25784F");
    grd.addColorStop(0.55, PALETTE.felt);
    grd.addColorStop(0.88, "#185C3D");
    grd.addColorStop(1, PALETTE.feltShadow);
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    const r = rng(23);
    for (let i = 0; i < 5000; i++) {
      g.fillStyle = r() < 0.5 ? "rgba(0,0,0,0.07)" : "rgba(200,255,220,0.035)";
      g.fillRect(r() * S, r() * S, 2, 2);
    }
    // gold rings
    g.strokeStyle = "rgba(255,201,60,0.55)";
    g.lineWidth = 5;
    g.beginPath();
    g.arc(m, m, m * 0.82, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 2;
    g.beginPath();
    g.arc(m, m, m * 0.78, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(m, m, m * 0.17, 0, Math.PI * 2);
    g.stroke();
    // circular slogan between the rings, printed in faded gold
    const text = "• PATRONUN MASASI • KASALA • POLİS GELİRSE BEN SİZİ TANIMIYORUM • KASALA ";
    g.fillStyle = "rgba(255,201,60,0.42)";
    g.font = `600 30px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const rad = m * 0.8;
    const total = text.length;
    for (let i = 0; i < total; i++) {
      const a = (i / total) * Math.PI * 2 - Math.PI / 2;
      g.save();
      g.translate(m + Math.cos(a) * rad, m + Math.sin(a) * rad);
      g.rotate(a + Math.PI / 2);
      g.fillText(text[i]!, 0, 0);
      g.restore();
    }
    // suit pips around the inner ring
    g.fillStyle = "rgba(255,201,60,0.3)";
    g.font = `700 40px ${FONT}`;
    ["♠", "♥", "♣", "♦"].forEach((s, i) => {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      g.fillText(s, m + Math.cos(a) * m * 0.27, m + Math.sin(a) * m * 0.27);
    });
  });
}

/** Soft white radial dot (glow sprites, smoke puffs). */
let softDot: THREE.CanvasTexture | null = null;
export function softDotTexture(): THREE.CanvasTexture {
  if (softDot) return softDot;
  const [c, g] = makeCanvas(64, 64);
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.35, "rgba(255,255,255,0.5)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  softDot = toTexture(c);
  return softDot;
}

/** Long wispy smoke sheet (white on transparent, tiles horizontally). */
export function smokeTexture(seed: number): THREE.CanvasTexture {
  const [c, g] = makeCanvas(512, 128);
  const r = rng(seed);
  for (let i = 0; i < 90; i++) {
    const x = r() * 512;
    const y = 30 + r() * 68;
    const rad = 18 + r() * 46;
    const a = 0.025 + r() * 0.05;
    for (const dx of [-512, 0, 512]) {
      const grd = g.createRadialGradient(x + dx, y, 0, x + dx, y, rad);
      grd.addColorStop(0, `rgba(255,255,255,${a})`);
      grd.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(x + dx, y, rad * 1.8, rad * 0.6, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  // fade top and bottom
  g.globalCompositeOperation = "destination-in";
  const fade = g.createLinearGradient(0, 0, 0, 128);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(0.3, "rgba(0,0,0,1)");
  fade.addColorStop(0.7, "rgba(0,0,0,1)");
  fade.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = fade;
  g.fillRect(0, 0, 512, 128);
  g.globalCompositeOperation = "source-over";
  const t = toTexture(c, { srgb: false });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** Vertical light cone gradient: bright at the top (v = 1), gone at the bottom, soft at the sides. */
export function coneTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(64, 128);
  const v = g.createLinearGradient(0, 0, 0, 128);
  v.addColorStop(0, "rgba(255,255,255,0.9)");
  v.addColorStop(0.5, "rgba(255,255,255,0.35)");
  v.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = v;
  g.fillRect(0, 0, 64, 128);
  g.globalCompositeOperation = "destination-in";
  const h = g.createLinearGradient(0, 0, 64, 0);
  h.addColorStop(0, "rgba(0,0,0,0.25)");
  h.addColorStop(0.5, "rgba(0,0,0,1)");
  h.addColorStop(1, "rgba(0,0,0,0.25)");
  g.fillStyle = h;
  g.fillRect(0, 0, 64, 128);
  const t = toTexture(c, { srgb: false });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

// ------------------------------------------------------------------------------------------ dressing
/** The boss: a fat tomcat in a white fedora with shades and a cigar, gold-framed oil painting look. */
export function portraitTexture(): THREE.CanvasTexture {
  return textTexture(256, 320, (g, W, H) => {
    const bg = g.createRadialGradient(W / 2, H * 0.4, 10, W / 2, H * 0.45, H * 0.7);
    bg.addColorStop(0, "#5B3A2E");
    bg.addColorStop(1, "#1E1214");
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    const cx = W / 2;
    // shoulders / suit
    g.fillStyle = "#26222E";
    g.beginPath();
    g.ellipse(cx, H * 0.98, W * 0.48, H * 0.3, 0, Math.PI, 0);
    g.fill();
    g.fillStyle = "#F4EDE0";
    g.beginPath();
    g.moveTo(cx - 26, H * 0.7);
    g.lineTo(cx, H * 0.86);
    g.lineTo(cx + 26, H * 0.7);
    g.fill();
    g.fillStyle = "#C3262E";
    g.beginPath();
    g.moveTo(cx - 12, H * 0.73);
    g.lineTo(cx + 12, H * 0.73);
    g.lineTo(cx, H * 0.8);
    g.fill();
    // fat cat head
    g.fillStyle = "#9C9AA8";
    g.beginPath();
    g.ellipse(cx, H * 0.5, 76, 64, 0, 0, Math.PI * 2);
    g.fill();
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(cx + s * 70, H * 0.4);
      g.lineTo(cx + s * 52, H * 0.22);
      g.lineTo(cx + s * 30, H * 0.36);
      g.fill();
    }
    g.fillStyle = "#E6E2EA";
    g.beginPath();
    g.ellipse(cx, H * 0.58, 40, 26, 0, 0, Math.PI * 2);
    g.fill();
    // shades
    g.fillStyle = "#111";
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + s * 26, H * 0.46, 22, 13, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.fillRect(cx - 8, H * 0.455 - 3, 16, 5);
    g.fillStyle = "rgba(255,255,255,0.5)";
    for (const s of [-1, 1]) g.fillRect(cx + s * 26 - 12, H * 0.44, 7, 3);
    // nose + smirk + cigar
    g.fillStyle = "#E58AA0";
    g.beginPath();
    g.ellipse(cx, H * 0.535, 9, 6, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#2B2530";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx - 20, H * 0.6);
    g.quadraticCurveTo(cx + 2, H * 0.64, cx + 22, H * 0.585);
    g.stroke();
    g.fillStyle = "#6B3E22";
    g.save();
    g.translate(cx + 30, H * 0.6);
    g.rotate(-0.25);
    g.fillRect(0, -5, 52, 11);
    g.fillStyle = "#FF8A3D";
    g.fillRect(50, -5, 6, 11);
    g.restore();
    // whiskers
    g.strokeStyle = "#F4EDE0";
    g.lineWidth = 2;
    for (const s of [-1, 1]) {
      for (const dy of [-6, 4]) {
        g.beginPath();
        g.moveTo(cx + s * 34, H * 0.57 + dy);
        g.lineTo(cx + s * 78, H * 0.55 + dy * 2);
        g.stroke();
      }
    }
    // white fedora with a black band
    g.fillStyle = "#EFE8DA";
    g.beginPath();
    g.ellipse(cx, H * 0.32, 96, 18, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(cx - 56, H * 0.32);
    g.quadraticCurveTo(cx - 54, H * 0.12, cx, H * 0.14);
    g.quadraticCurveTo(cx + 54, H * 0.12, cx + 56, H * 0.32);
    g.fill();
    g.fillStyle = "#1A1A1E";
    g.fillRect(cx - 56, H * 0.27, 112, 14);
    // varnish highlight
    const shine = g.createLinearGradient(0, 0, W, H);
    shine.addColorStop(0, "rgba(255,240,200,0.12)");
    shine.addColorStop(0.5, "rgba(255,240,200,0)");
    g.fillStyle = shine;
    g.fillRect(0, 0, W, H);
  });
}

/** Little brass plaque under the portrait. */
export function plaqueTexture(text: string): THREE.CanvasTexture {
  return textTexture(256, 64, (g, W, H) => {
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, "#F0C866");
    grd.addColorStop(1, "#A8792A");
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = "#6E4A16";
    g.lineWidth = 4;
    g.strokeRect(3, 3, W - 6, H - 6);
    g.fillStyle = "#3A260C";
    g.font = `700 34px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, W / 2, H / 2 + 2);
  });
}

/** Wall clock: cream face, roman-ish numerals, says it's always 03:00. */
export function clockFaceTexture(): THREE.CanvasTexture {
  return textTexture(256, 256, (g) => {
    g.fillStyle = "#F3E6C8";
    g.beginPath();
    g.arc(128, 128, 126, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#3A2116";
    g.lineWidth = 8;
    g.stroke();
    g.fillStyle = PALETTE.ink;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `700 30px ${FONT}`;
    for (let i = 1; i <= 12; i++) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      g.fillText(String(i), 128 + Math.cos(a) * 98, 128 + Math.sin(a) * 98);
    }
    g.font = `600 16px ${FONT}`;
    g.fillStyle = "#8A2A2A";
    g.fillText("CEMİL & OĞULLARI", 128, 168);
  });
}

/** Door window: frosted amber glass with a stenciled "ÖZEL". */
export function doorGlassTexture(): THREE.CanvasTexture {
  return textTexture(128, 160, (g, W, H) => {
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, "#C9A46A");
    grd.addColorStop(1, "#8A6A3E");
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    const r = rng(3);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = r() < 0.5 ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";
      g.fillRect(r() * W, r() * H, 3, 3);
    }
    g.fillStyle = "#2A1A10";
    g.font = `700 34px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("ÖZEL", W / 2, H * 0.42);
    g.font = `600 15px ${FONT}`;
    g.fillText("GİRMEK YASAK", W / 2, H * 0.62);
  });
}

/** Cash crate side: planks + red stencil. */
export function crateTexture(): THREE.CanvasTexture {
  return textTexture(256, 256, (g, W, H) => {
    g.fillStyle = "#8A5A33";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#6E4426";
    for (let i = 0; i < 4; i++) g.fillRect(0, i * 64, W, 4);
    g.strokeStyle = "#5A361E";
    g.lineWidth = 14;
    g.strokeRect(7, 7, W - 14, H - 14);
    g.beginPath();
    g.moveTo(14, 14);
    g.lineTo(W - 14, H - 14);
    g.stroke();
    g.fillStyle = "rgba(200,40,40,0.85)";
    g.font = `700 44px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.save();
    g.translate(W / 2, H / 2);
    g.rotate(-0.12);
    g.fillText("NAKİT", 0, -24);
    g.font = `700 26px ${FONT}`;
    g.fillText("SORU SORMA", 0, 22);
    g.restore();
  });
}

/** "ARANIYOR" poster for Komiser Rıfat's least favorite customer (a pig in a fedora). */
export function wantedTexture(): THREE.CanvasTexture {
  return textTexture(192, 256, (g, W, H) => {
    g.fillStyle = "#EBDDB8";
    g.fillRect(0, 0, W, H);
    g.strokeStyle = "#8A6B3A";
    g.lineWidth = 6;
    g.strokeRect(6, 6, W - 12, H - 12);
    g.fillStyle = "#3A2A16";
    g.font = `700 32px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("ARANIYOR", W / 2, 34);
    g.fillStyle = "#F5A3B5";
    g.beginPath();
    g.ellipse(W / 2, 118, 46, 40, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#E57C97";
    g.beginPath();
    g.ellipse(W / 2, 128, 18, 12, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#3A2A16";
    g.beginPath();
    g.arc(W / 2 - 7, 128, 3, 0, Math.PI * 2);
    g.arc(W / 2 + 7, 128, 3, 0, Math.PI * 2);
    g.arc(W / 2 - 18, 105, 4, 0, Math.PI * 2);
    g.arc(W / 2 + 18, 105, 4, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#2B2530";
    g.fillRect(W / 2 - 50, 74, 100, 10);
    g.fillRect(W / 2 - 34, 56, 68, 22);
    g.fillStyle = "#3A2A16";
    g.font = `700 22px ${FONT}`;
    g.fillText("ÖDÜL: 500$", W / 2, 186);
    g.font = `500 14px ${FONT}`;
    g.fillText("Suçu: bir kart daha", W / 2, 212);
    g.fillText("çevirmek", W / 2, 228);
  });
}

/** Banknote brick: green bills seen from every side with a cream paper band. */
export function brickTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(128, 64);
  g.fillStyle = "#5FB872";
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = "#4C9C5E";
  for (let y = 2; y < 64; y += 5) g.fillRect(0, y, 128, 1);
  g.strokeStyle = "#2F7A44";
  g.lineWidth = 3;
  g.strokeRect(4, 4, 120, 56);
  g.fillStyle = "#3E8C52";
  g.beginPath();
  g.ellipse(30, 32, 12, 16, 0, 0, Math.PI * 2);
  g.ellipse(98, 32, 12, 16, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#F4E7C6";
  g.fillRect(54, 0, 20, 64);
  g.fillStyle = "#C9A15A";
  g.fillRect(54, 0, 2, 64);
  g.fillRect(72, 0, 2, 64);
  return toTexture(c);
}

/** Chip detail: white edge notches on transparent (side) — alpha tested over the colored body. */
export function chipEdgeTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(128, 16);
  g.clearRect(0, 0, 128, 16);
  g.fillStyle = "#FFFFFF";
  for (let i = 0; i < 8; i++) g.fillRect(i * 16 + 4, 0, 8, 16);
  const t = toTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  return t;
}

/** Chip top: a dashed white ring + center dot (alpha tested). */
export function chipTopTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(64, 64);
  g.strokeStyle = "#FFFFFF";
  g.lineWidth = 5;
  g.setLineDash([7, 5]);
  g.beginPath();
  g.arc(32, 32, 22, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  g.lineWidth = 2;
  g.beginPath();
  g.arc(32, 32, 13, 0, Math.PI * 2);
  g.stroke();
  const t = toTexture(c);
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  return t;
}

/** Gold coins seen from above (kumbara fill top). */
export function coinPileTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(128, 128);
  g.fillStyle = "#C9932C";
  g.fillRect(0, 0, 128, 128);
  const r = rng(17);
  for (let i = 0; i < 70; i++) {
    const x = r() * 128;
    const y = r() * 128;
    const rad = 7 + r() * 5;
    g.fillStyle = r() < 0.5 ? "#FFC93C" : "#E8B03A";
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#9A6A1C";
    g.lineWidth = 1.5;
    g.stroke();
    g.fillStyle = "rgba(255,255,255,0.45)";
    g.fillRect(x - rad * 0.4, y - rad * 0.5, rad * 0.5, 2);
  }
  return toTexture(c, { repeat: [2, 2] });
}

/** Paper tag hanging from the kumbara's neck. */
export function kumbaraTagTexture(): THREE.CanvasTexture {
  return textTexture(256, 112, (g, W, H) => {
    g.fillStyle = "#F4E7C6";
    roundRect(g, 4, 4, W - 8, H - 8, 14);
    g.fill();
    g.strokeStyle = "#8A6B3A";
    g.lineWidth = 4;
    g.stroke();
    g.fillStyle = "#3A2A16";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `600 24px ${FONT}`;
    g.fillText("PATRONUN", W / 2, H * 0.33);
    g.font = `700 36px ${FONT}`;
    g.fillStyle = "#B0262C";
    g.fillText("KUMBARASI", W / 2, H * 0.68);
  });
}
