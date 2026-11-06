// Floating nameplate over a tourist (game4.md §12/§17): the nickname on a pill in the seat color, a 🤖 badge
// for bots, a "…" badge while reconnecting, a golden pill with twinkling sparkles after a golden fish, and a
// status bubble above it: a pulsing 🆘 with the revive progress ring while downed, ⛵ once aboard the raft. At
// night the plate gets a bright rim so it reads in the dark. Constant on-screen size, drawn on top (co-op:
// find your downed friend through the trees). Owner: client-characters. Adapted from
// games/bonk-brawl/client/src/characters/Nameplate.ts.

import * as THREE from "three";
import { PALETTE } from "../../../shared/constants";
import { OVERLAY_LAYER } from "../render/Toon";
import { shadeHex } from "../util/color";

const CANVAS_W = 512;
const CANVAS_H = 128;
const PILL_H = 92;
const PILL_Y = 18;
const FONT = '700 54px "Fredoka", "Baloo 2", system-ui, sans-serif';
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
/** On-screen height of the plate (sizeAttenuation off: a fraction of the view height). */
const PLATE_SCALE = 0.052;
const STATUS_SCALE = 0.07;
const STATUS_PX = 192;
const DISCONNECTED_OPACITY = 0.5;
const GOLD = "#FFD166";
const GOLD_DARK = "#C98A12";
const SPARKLES = 5;

export type PlateStatus = "none" | "downed" | "boarded";

interface PlateLook {
  nickname: string;
  color: string;
  bot: boolean;
  away: boolean;
  golden: boolean;
  night: boolean;
}

let sparkleMaterial: THREE.SpriteMaterial | null = null;

/** Shared additive four-point star (never disposed). */
function getSparkleMaterial(): THREE.SpriteMaterial {
  if (sparkleMaterial) return sparkleMaterial;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.3, "rgba(255,240,170,0.95)");
    g.addColorStop(1, "rgba(255,209,102,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? 31 : 7;
      ctx.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  sparkleMaterial = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: false,
    fog: false,
    toneMapped: false,
  });
  return sparkleMaterial;
}

export class Nameplate {
  /** Position this at the anchor above the head every frame. */
  readonly object = new THREE.Group();
  private readonly canvas = document.createElement("canvas");
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.SpriteMaterial;
  private readonly sprite: THREE.Sprite;
  private readonly statusCanvas = document.createElement("canvas");
  private readonly statusTexture: THREE.CanvasTexture;
  private readonly statusMaterial: THREE.SpriteMaterial;
  private readonly statusSprite: THREE.Sprite;
  private readonly sparkles = new THREE.Group();
  private look: PlateLook = { nickname: "", color: "", bot: false, away: false, golden: false, night: false };
  private drawnKey = "";
  private status: PlateStatus = "none";
  private progressStep = -1;
  private opacity = 1;
  private disposed = false;
  private time = Math.random() * 10;

  constructor() {
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: false,
      fog: false,
      toneMapped: false,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.center.set(0.5, 0);
    this.sprite.scale.set((PLATE_SCALE * CANVAS_W) / CANVAS_H, PLATE_SCALE, 1);
    this.sprite.renderOrder = 1000;

    this.statusCanvas.width = this.statusCanvas.height = STATUS_PX;
    this.statusTexture = new THREE.CanvasTexture(this.statusCanvas);
    this.statusTexture.colorSpace = THREE.SRGBColorSpace;
    this.statusMaterial = new THREE.SpriteMaterial({
      map: this.statusTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: false,
      fog: false,
      toneMapped: false,
    });
    this.statusSprite = new THREE.Sprite(this.statusMaterial);
    this.statusSprite.center.set(0.5, -0.62);
    this.statusSprite.scale.set(STATUS_SCALE, STATUS_SCALE, 1);
    this.statusSprite.renderOrder = 1001;
    this.statusSprite.visible = false;

    for (let i = 0; i < SPARKLES; i++) {
      const s = new THREE.Sprite(getSparkleMaterial());
      s.renderOrder = 1002;
      s.layers.set(OVERLAY_LAYER);
      s.userData.phase = i / SPARKLES;
      this.sparkles.add(s);
    }
    this.sparkles.visible = false;

    this.object.name = "nameplate";
    this.sprite.layers.set(OVERLAY_LAYER);
    this.statusSprite.layers.set(OVERLAY_LAYER);
    this.object.add(this.sprite, this.statusSprite, this.sparkles);
    this.redrawWhenFontLoads();
  }

  /** Plate content; redraws only when something visible changed. */
  setLook(nickname: string, color: string, bot: boolean, connected: boolean, golden: boolean, dark: number): void {
    const look: PlateLook = { nickname, color, bot, away: !connected, golden, night: dark > 0.5 };
    const key = `${look.nickname}|${look.color}|${look.bot}|${look.away}|${look.golden}|${look.night}`;
    this.look = look;
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    this.redraw();
    this.applyOpacity();
  }

  /** Status bubble: 🆘 (with revive progress 0..1, < 0 = nobody reviving) or ⛵. */
  setStatus(status: PlateStatus, reviveProgress = -1): void {
    const step = status === "downed" ? (reviveProgress < 0 ? -1 : Math.round(Math.min(1, reviveProgress) * 32)) : -2;
    if (status === this.status && step === this.progressStep) return;
    this.status = status;
    this.progressStep = step;
    this.statusSprite.visible = status !== "none";
    if (status !== "none") this.redrawStatus();
  }

  /** Extra fade (distance, washed-out moments). */
  setOpacity(opacity: number): void {
    if (Math.abs(opacity - this.opacity) < 1e-3) return;
    this.opacity = opacity;
    this.applyOpacity();
  }

  /** Per frame: SOS pulse and golden sparkles. */
  update(dt: number): void {
    this.time += dt;
    if (this.status === "downed") {
      const pulse = 1 + 0.12 * Math.sin(this.time * 7);
      this.statusSprite.scale.set(STATUS_SCALE * pulse, STATUS_SCALE * pulse, 1);
    } else if (this.status === "boarded") {
      this.statusSprite.scale.set(STATUS_SCALE * 0.85, STATUS_SCALE * 0.85, 1);
    }
    const golden = this.look.golden;
    this.sparkles.visible = golden && this.opacity > 0.05;
    if (!golden) return;
    const w = (PLATE_SCALE * CANVAS_W) / CANVAS_H;
    for (const s of this.sparkles.children as THREE.Sprite[]) {
      const phase = (s.userData.phase as number) ?? 0;
      const cycle = (this.time * 0.8 + phase) % 1;
      const x = (((phase * 7.31 + Math.floor(this.time * 0.8 + phase) * 0.37) % 1) - 0.5) * w * 0.9;
      const size = 0.018 * Math.sin(Math.PI * cycle) ** 2;
      // Sprites with sizeAttenuation off live in the same screen-fraction units as the plate.
      s.position.set(0, 0, 0);
      s.center.set(0.5 - x / Math.max(1e-4, size), -((PLATE_SCALE * (0.2 + 0.9 * cycle)) / Math.max(1e-4, size)));
      s.scale.set(Math.max(1e-4, size), Math.max(1e-4, size), 1);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.object.removeFromParent();
    this.texture.dispose();
    this.material.dispose();
    this.statusTexture.dispose();
    this.statusMaterial.dispose();
  }

  /* ------------------------------------------------------------ drawing */

  private applyOpacity(): void {
    const o = this.opacity * (this.look.away ? DISCONNECTED_OPACITY : 1);
    this.material.opacity = o;
    this.statusMaterial.opacity = Math.max(o, this.status === "downed" ? Math.min(1, this.opacity + 0.35) : 0);
  }

  private redrawWhenFontLoads(): void {
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    if (!fonts || fonts.check(FONT)) return;
    fonts
      .load(FONT)
      .then(() => {
        if (!this.disposed) this.redraw();
      })
      .catch(() => undefined);
  }

  private redraw(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const L = this.look;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.font = FONT;
    const badgeW = (L.bot ? 66 : 0) + (L.away ? 58 : 0);
    const label = fitText(ctx, L.nickname || "?", CANVAS_W - 110 - badgeW);
    const textW = ctx.measureText(label).width;
    const w = Math.min(CANVAS_W - 16, textW + 60 + badgeW);
    const x = (CANVAS_W - w) / 2;
    const r = PILL_H / 2;
    const fill = L.golden ? GOLD : L.color;

    if (L.night) {
      // Bright rim so the plate reads in the dark.
      ctx.fillStyle = "rgba(255, 244, 220, 0.85)";
      roundRect(ctx, x - 7, PILL_Y - 5, w + 14, PILL_H + 4, r + 7);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(45, 42, 50, 0.35)";
    roundRect(ctx, x + 2, PILL_Y + 7, w, PILL_H - 4, r);
    ctx.fill();
    if (L.golden) {
      const g = ctx.createLinearGradient(0, PILL_Y, 0, PILL_Y + PILL_H);
      g.addColorStop(0, "#FFF1B8");
      g.addColorStop(0.5, GOLD);
      g.addColorStop(1, "#F2A93B");
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = fill;
    }
    roundRect(ctx, x, PILL_Y + 3, w, PILL_H - 6, r);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
    roundRect(ctx, x + 10, PILL_Y + 10, w - 20, (PILL_H - 6) * 0.32, r * 0.5);
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = L.golden ? GOLD_DARK : PALETTE.ink;
    roundRect(ctx, x, PILL_Y + 3, w, PILL_H - 6, r);
    ctx.stroke();

    let bx = x + 40;
    const ty = PILL_Y + PILL_H / 2 + 2;
    if (L.bot) {
      drawBadge(ctx, bx, ty, "🤖", "#FFFFFF");
      bx += 66;
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = FONT;
    const tx = L.bot ? bx - 12 : x + 30;
    ctx.lineJoin = "round";
    ctx.lineWidth = 10;
    ctx.strokeStyle = shadeHex(fill, -0.55);
    ctx.strokeText(label, tx, ty);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(label, tx, ty);
    if (L.away) drawAwayBadge(ctx, tx + textW + 34, ty);
    this.texture.needsUpdate = true;
  }

  private redrawStatus(): void {
    const ctx = this.statusCanvas.getContext("2d");
    if (!ctx) return;
    const S = STATUS_PX;
    const c = S / 2;
    ctx.clearRect(0, 0, S, S);
    const downed = this.status === "downed";
    // Bubble.
    ctx.fillStyle = downed ? "#FF4D3A" : "#FFFFFF";
    ctx.beginPath();
    ctx.arc(c, c, S * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 8;
    ctx.strokeStyle = PALETTE.ink;
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(S * 0.4)}px ${EMOJI_FONT}`;
    ctx.fillText(downed ? "🆘" : "⛵", c, c + S * 0.03);
    if (downed && this.progressStep >= 0) {
      // Revive progress ring around the bubble.
      const p = this.progressStep / 32;
      ctx.lineCap = "round";
      ctx.lineWidth = 16;
      ctx.strokeStyle = "rgba(45, 42, 50, 0.55)";
      ctx.beginPath();
      ctx.arc(c, c, S * 0.44, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 11;
      ctx.strokeStyle = "#7CF06B";
      ctx.beginPath();
      ctx.arc(c, c, S * 0.44, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
      ctx.stroke();
    }
    this.statusTexture.needsUpdate = true;
    this.applyOpacity();
  }
}

function drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, emoji: string, bg: string): void {
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(x, y, 27, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = PALETTE.ink;
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `34px ${EMOJI_FONT}`;
  ctx.fillText(emoji, x, y + 2);
}

function drawAwayBadge(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.arc(x, y, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = PALETTE.ink;
  ctx.stroke();
  ctx.fillStyle = PALETTE.ink;
  for (const dx of [-9, 0, 9]) {
    ctx.beginPath();
    ctx.arc(x + dx, y + 2, 3.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, h / 2, w / 2));
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}
