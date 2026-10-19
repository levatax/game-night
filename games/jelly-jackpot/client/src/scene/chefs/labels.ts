// Canvas-texture sprites for the chefs: nameplates (nickname + rolling coin count), comic speech bubbles
// ("HA HA!", "MWAHAHA!") and the soft radial glow used by the devil reveal. Owner: client-chefs.

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { t as tx } from "../../i18n";

const FONT = `"Fredoka", "Baloo 2", "Comic Sans MS", "Chalkboard SE", system-ui, sans-serif`;

/** A sprite backed by its own canvas; call `refresh()` after drawing. */
export class CanvasSprite {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly sprite: THREE.Sprite;

  constructor(w: number, h: number, worldWidth: number) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthWrite: false, depthTest: false });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.renderOrder = 20;
    this.sprite.scale.set(worldWidth, (worldWidth * h) / w, 1);
    this.sprite.userData.baseScale = this.sprite.scale.clone();
  }

  refresh(): void {
    this.texture.needsUpdate = true;
  }

  get material(): THREE.SpriteMaterial {
    return this.sprite.material;
  }

  dispose(): void {
    this.texture.dispose();
    this.sprite.material.dispose();
    this.sprite.removeFromParent();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Shrink the font until `text` fits `maxW`. Returns the chosen pixel size. */
function fitFont(ctx: CanvasRenderingContext2D, text: string, start: number, maxW: number, weight = 800): number {
  let size = start;
  ctx.font = `${weight} ${size}px ${FONT}`;
  while (size > 14 && ctx.measureText(text).width > maxW) {
    size -= 2;
    ctx.font = `${weight} ${size}px ${FONT}`;
  }
  return size;
}

// ------------------------------------------------------------------ nameplate
export interface PlateInfo {
  nickname: string;
  coins: number;
  color: string;
  isMe: boolean;
  isActive: boolean;
  connected: boolean;
  /** -1 falling, 0 settled, 1 rising (tints the coin number). */
  trend: number;
}

export class Nameplate extends CanvasSprite {
  constructor() {
    super(512, 200, 0.62);
  }

  draw(info: PlateInfo): void {
    const { ctx, canvas } = this;
    const W = canvas.width;
    ctx.clearRect(0, 0, W, canvas.height);
    const x = 14;
    const y = 14;
    const w = W - 28;
    const h = 150;

    // Plate: dark pill with a fat player-color border (gold for you).
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 6;
    roundRect(ctx, x, y, w, h, 40);
    ctx.fillStyle = info.connected ? "rgba(45,42,50,0.9)" : "rgba(80,78,88,0.85)";
    ctx.fill();
    ctx.restore();
    roundRect(ctx, x, y, w, h, 40);
    ctx.lineWidth = 10;
    ctx.strokeStyle = info.isMe ? PALETTE.coin : info.color;
    ctx.stroke();

    // Color dot (a tiny hat!) on the left.
    ctx.fillStyle = info.color;
    ctx.beginPath();
    ctx.arc(x + 46, y + 50, 20, 0, Math.PI * 2);
    ctx.arc(x + 32, y + 56, 14, 0, Math.PI * 2);
    ctx.arc(x + 60, y + 56, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(x + 30, y + 62, 32, 14);

    // Nickname.
    const name = info.nickname.length > 14 ? `${info.nickname.slice(0, 13)}…` : info.nickname;
    fitFont(ctx, name, 52, w - 110);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 8;
    ctx.strokeStyle = PALETTE.ink;
    ctx.strokeText(name, x + 82, y + 52);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(name, x + 82, y + 52);

    // Coin icon + count.
    const cy = y + 112;
    const cx = x + 100;
    ctx.fillStyle = PALETTE.coin;
    ctx.beginPath();
    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#C98F00";
    ctx.stroke();
    ctx.fillStyle = "#C98F00";
    ctx.font = `900 26px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText("¢", cx, cy + 1);

    const coins = `${Math.round(info.coins)}`;
    ctx.font = `900 46px ${FONT}`;
    ctx.textAlign = "left";
    ctx.lineWidth = 8;
    ctx.strokeStyle = PALETTE.ink;
    ctx.strokeText(coins, cx + 34, cy + 2);
    ctx.fillStyle = info.trend > 0 ? "#8CFF7A" : info.trend < 0 ? "#FF7A7A" : "#FFE27A";
    ctx.fillText(coins, cx + 34, cy + 2);

    // Tags on the right: YOU / zzz.
    ctx.textAlign = "right";
    const tag = !info.connected ? tx("scene.plateAway") : info.isMe ? tx("scene.plateYou") : "";
    if (tag) {
      fitFont(ctx, tag, 30, 120, 900);
      ctx.fillStyle = info.connected ? PALETTE.coin : "#BFBACF";
      ctx.fillText(tag, x + w - 28, cy);
    }

    // Little pointer under the plate.
    ctx.fillStyle = info.isMe ? PALETTE.coin : info.color;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 18, y + h + 4);
    ctx.lineTo(W / 2 + 18, y + h + 4);
    ctx.lineTo(W / 2, y + h + 30);
    ctx.closePath();
    ctx.fill();
    this.refresh();
  }
}

// ------------------------------------------------------------- speech bubble
export class Bubble extends CanvasSprite {
  private text = "";

  constructor() {
    super(512, 280, 0.62);
    this.sprite.visible = false;
  }

  draw(text: string, accent: string): void {
    if (text === this.text) return;
    this.text = text;
    const { ctx, canvas } = this;
    const W = canvas.width;
    ctx.clearRect(0, 0, W, canvas.height);
    const x = 16;
    const y = 16;
    const w = W - 32;
    const h = 190;

    // Puffy comic bubble with a tail pointing down at the chef.
    ctx.beginPath();
    roundRect(ctx, x, y, w, h, 90);
    ctx.moveTo(W / 2 - 50, y + h - 4);
    ctx.lineTo(W / 2 - 70, y + h + 66);
    ctx.lineTo(W / 2 + 20, y + h - 4);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
    ctx.lineWidth = 12;
    ctx.lineJoin = "round";
    ctx.strokeStyle = PALETTE.ink;
    roundRect(ctx, x, y, w, h, 90);
    ctx.stroke();
    // Cover the seam between tail and bubble, then outline the tail.
    ctx.beginPath();
    ctx.moveTo(W / 2 - 50, y + h - 8);
    ctx.lineTo(W / 2 - 70, y + h + 66);
    ctx.lineTo(W / 2 + 20, y + h - 8);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
    ctx.stroke();
    ctx.fillRect(W / 2 - 46, y + h - 20, 62, 14);

    const size = fitFont(ctx, text, 96, w - 60, 900);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(6, size * 0.12);
    ctx.strokeStyle = PALETTE.ink;
    ctx.strokeText(text, W / 2, y + h / 2 + 4);
    ctx.fillStyle = accent;
    ctx.fillText(text, W / 2, y + h / 2 + 4);
    this.refresh();
  }
}

// ------------------------------------------------------------------- glow
let glowTex: THREE.CanvasTexture | null = null;

/** Shared soft radial white glow (tint with material.color). */
export function glowTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
