// Canvas-painted textures for glows and particles (cached, painted once). Owner: client-cards-fx.

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { canvasTexture } from "../toon";

const cache = new Map<string, THREE.Texture>();
function cached<T extends THREE.Texture>(key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit) return hit as T;
  const tex = make();
  cache.set(key, tex);
  return tex;
}

export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 2×2 atlas for billboard sparks (Sparks.ts). Frames in UV space: 0 soft glow · 1 four-point star ·
 * 2 smoke puff · 3 round droplet. No mipmaps (avoids bleeding between cells).
 */
export function sparkAtlas(): THREE.CanvasTexture {
  return cached("sparkAtlas", () => {
    const tex = canvasTexture(256, 256, (ctx) => {
      const cell = (frame: number): [number, number] => {
        const cx = frame % 2;
        const cy = Math.floor(frame / 2);
        // UV v grows upward, canvas y downward: frame row 0 lives in the bottom half of the canvas.
        return [cx * 128 + 64, (1 - cy) * 128 + 64];
      };
      // 0: soft glow
      {
        const [x, y] = cell(0);
        const g = ctx.createRadialGradient(x, y, 0, x, y, 58);
        g.addColorStop(0, "rgba(255,255,255,1)");
        g.addColorStop(0.25, "rgba(255,255,255,0.65)");
        g.addColorStop(0.6, "rgba(255,255,255,0.18)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x - 64, y - 64, 128, 128);
      }
      // 1: four-point star with a hot core
      {
        const [x, y] = cell(1);
        const g = ctx.createRadialGradient(x, y, 0, x, y, 30);
        g.addColorStop(0, "rgba(255,255,255,0.9)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x - 64, y - 64, 128, 128);
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        const R = 56;
        const r = 7;
        ctx.moveTo(x, y - R);
        ctx.quadraticCurveTo(x + r, y - r, x + R, y);
        ctx.quadraticCurveTo(x + r, y + r, x, y + R);
        ctx.quadraticCurveTo(x - r, y + r, x - R, y);
        ctx.quadraticCurveTo(x - r, y - r, x, y - R);
        ctx.fill();
      }
      // 2: cartoon smoke puff (overlapping soft lobes)
      {
        const [x, y] = cell(2);
        const lobes: [number, number, number][] = [
          [0, 6, 34],
          [-22, 12, 24],
          [22, 10, 26],
          [-10, -14, 26],
          [14, -12, 22],
        ];
        for (const [dx, dy, r] of lobes) {
          const g = ctx.createRadialGradient(x + dx, y + dy, r * 0.2, x + dx, y + dy, r + 8);
          g.addColorStop(0, "rgba(255,255,255,0.95)");
          g.addColorStop(0.7, "rgba(255,255,255,0.75)");
          g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x + dx, y + dy, r + 8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // 3: droplet / dot with a crisp edge and a highlight
      {
        const [x, y] = cell(3);
        ctx.fillStyle = "rgba(255,255,255,1)";
        ctx.beginPath();
        ctx.arc(x, y, 46, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.beginPath();
        ctx.arc(x, y, 54, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  });
}

/** White radial glow (halo sprites; tint with material color). */
export function glowTexture(): THREE.CanvasTexture {
  return cached("glow", () =>
    canvasTexture(128, 128, (ctx) => {
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.2, "rgba(255,255,255,0.75)");
      g.addColorStop(0.5, "rgba(255,255,255,0.25)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
    }),
  );
}

/** Light rays fanning out (behind revealed rare cards and the winning wheel slice). */
export function raysTexture(): THREE.CanvasTexture {
  return cached("rays", () =>
    canvasTexture(256, 256, (ctx) => {
      ctx.translate(128, 128);
      const n = 14;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const g = ctx.createLinearGradient(0, 0, Math.cos(a) * 128, Math.sin(a) * 128);
        g.addColorStop(0, "rgba(255,255,255,0.9)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, 128, a - 0.09, a + 0.09);
        ctx.closePath();
        ctx.fill();
      }
    }),
  );
}

/**
 * Soft glow ring around a card (rim glow). The plane using it is 1.6 × card width by 1.45 × card height, so
 * the card itself covers the middle 120 × 177 px; that middle is cut out, so a rim never tints the faces of
 * the neighbouring cards it overlaps in a fanned row.
 */
export function cardGlowTexture(): THREE.CanvasTexture {
  return cached("cardGlow", () =>
    canvasTexture(192, 256, (ctx, w, h) => {
      ctx.shadowColor = "rgba(255,255,255,1)";
      ctx.shadowBlur = 26;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      for (let i = 0; i < 3; i++) {
        roundRectPath(ctx, 34, 34, w - 68, h - 68, 16);
        ctx.fill();
      }
      // hollow out the card's own footprint (inset a little so the glow still hugs the border)
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "#000";
      const cw = w / 1.6;
      const ch = h / 1.45;
      roundRectPath(ctx, (w - cw) / 2 + 5, (h - ch) / 2 + 5, cw - 10, ch - 10, 10);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    }),
  );
}

/** Soft dark blob for fake contact shadows under hovering cards. */
export function shadowTexture(): THREE.CanvasTexture {
  return cached("shadow", () =>
    canvasTexture(128, 128, (ctx) => {
      const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
      g.addColorStop(0, "rgba(0,0,0,0.75)");
      g.addColorStop(0.6, "rgba(0,0,0,0.35)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
    }),
  );
}

/** A cartoon green banknote (both sides look the same). */
export function banknoteTexture(): THREE.CanvasTexture {
  return cached("banknote", () =>
    canvasTexture(256, 128, (ctx, w, h) => {
      ctx.fillStyle = PALETTE.ink;
      roundRectPath(ctx, 0, 0, w, h, 10);
      ctx.fill();
      ctx.fillStyle = "#8FDB97";
      roundRectPath(ctx, 6, 6, w - 12, h - 12, 7);
      ctx.fill();
      ctx.strokeStyle = "#3E9A55";
      ctx.lineWidth = 4;
      roundRectPath(ctx, 16, 14, w - 32, h - 28, 6);
      ctx.stroke();
      // guilloche waves
      ctx.strokeStyle = "rgba(62,154,85,0.45)";
      ctx.lineWidth = 2;
      for (let k = 0; k < 4; k++) {
        ctx.beginPath();
        for (let x = 20; x <= w - 20; x += 4) {
          const y = 30 + k * 22 + Math.sin(x * 0.08 + k) * 5;
          if (x === 20) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // portrait oval with a big $
      ctx.fillStyle = "#C9F0C4";
      ctx.strokeStyle = "#2F7A44";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, 38, 40, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#2F7A44";
      ctx.font = `700 60px Fredoka, "Arial Black", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("$", w / 2, h / 2 + 3);
      ctx.font = `700 26px Fredoka, "Arial Black", sans-serif`;
      ctx.fillText("100", 44, 34);
      ctx.fillText("100", w - 44, h - 32);
    }),
  );
}

/** Poker chip cap: `map` is white with dark notches, `emissive` is the white notch mask. */
export function chipTextures(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const draw = (ctx: CanvasRenderingContext2D, mask: boolean) => {
    const c = 64;
    ctx.fillStyle = mask ? "#000" : "#fff";
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = mask ? "#fff" : "#1a1a1a";
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(c, c, 62, a - 0.2, a + 0.2);
      ctx.arc(c, c, 46, a + 0.2, a - 0.2, true);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = mask ? "#fff" : "#1a1a1a";
    ctx.lineWidth = 4;
    ctx.setLineDash([7, 6]);
    ctx.beginPath();
    ctx.arc(c, c, 34, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  return {
    map: cached("chipMap", () => canvasTexture(128, 128, (ctx) => draw(ctx, false))),
    emissive: cached("chipMask", () => canvasTexture(128, 128, (ctx) => draw(ctx, true))),
  };
}

/** Nazar boncuğu (evil eye bead), seen from the front. */
export function nazarTexture(): THREE.CanvasTexture {
  return cached("nazar", () =>
    canvasTexture(128, 128, (ctx) => {
      drawNazar(ctx, 64, 64, 60);
    }),
  );
}

export function drawNazar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const ring = (rr: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fill();
  };
  ring(r, PALETTE.ink);
  ring(r * 0.9, "#1E46B4");
  ring(r * 0.62, "#FFFFFF");
  ring(r * 0.46, "#5FC0FF");
  ring(r * 0.26, "#111018");
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.ellipse(x - r * 0.38, y - r * 0.45, r * 0.22, r * 0.12, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - r * 0.08, y - r * 0.1, r * 0.07, 0, Math.PI * 2);
  ctx.fill();
}
