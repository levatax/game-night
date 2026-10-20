// Floating nameplate + gold crown. Owner: client-characters.

import * as THREE from "three";
import { MAX_HEARTS, PALETTE } from "../../../shared/constants";
import { addOutline, createToonMaterial } from "../render/Toon";
import { shadeHex } from "../util/color";

const CANVAS_W = 512;
const CANVAS_H = 176;
const PILL_H = 92;
const PILL_Y = 6;
const HEART_SIZE = 46;
const HEART_Y = PILL_Y + PILL_H + 10;
const FONT = '700 54px "Fredoka", "Baloo 2", system-ui, sans-serif';
/** Screen-space height of the whole plate (fraction-ish of the viewport, sizeAttenuation off). */
const PLATE_SCALE = 0.07;
const HEART_RED = "#FF4D6A";
const HEART_EMPTY = "#FFFFFF";
const DISCONNECTED_OPACITY = 0.5;

/**
 * Canvas-texture sprite above the head: nickname in Fredoka bold on a rounded pill in the slot
 * color, small hearts row under it (♥♥♡). Size constant on screen-ish (sizeAttenuation false or
 * scaled by distance), depthTest false, renderOrder high. Hidden for the local player.
 */
export class Nameplate {
  readonly object = new THREE.Group();
  private readonly canvas = document.createElement("canvas");
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.SpriteMaterial;
  private readonly sprite: THREE.Sprite;
  private nickname = "";
  private color = "";
  private hearts = -1;
  private connected = true;
  private opacity = 1;
  private disposed = false;

  constructor(nickname: string, color: string) {
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
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.center.set(0.5, 0);
    this.sprite.scale.set((PLATE_SCALE * CANVAS_W) / CANVAS_H, PLATE_SCALE, 1);
    this.sprite.renderOrder = 1000;
    this.object.name = "nameplate";
    this.object.add(this.sprite);
    this.update(nickname, color, MAX_HEARTS);
    this.redrawWhenFontLoads();
  }

  update(nickname: string, color: string, hearts: number): void {
    const h = Math.max(0, Math.min(MAX_HEARTS, Math.round(hearts)));
    if (nickname === this.nickname && color === this.color && h === this.hearts) return;
    this.nickname = nickname;
    this.color = color;
    this.hearts = h;
    this.redraw();
  }

  /** Dim with a "…" badge while the player is in the reconnect window. */
  setConnected(connected: boolean): void {
    if (connected === this.connected) return;
    this.connected = connected;
    this.applyOpacity();
    this.redraw();
  }

  /** Extra fade (ghosts float with a fainter plate). */
  setOpacity(opacity: number): void {
    if (Math.abs(opacity - this.opacity) < 1e-3) return;
    this.opacity = opacity;
    this.applyOpacity();
  }

  dispose(): void {
    this.disposed = true;
    this.object.removeFromParent();
    this.texture.dispose();
    this.material.dispose();
  }

  private applyOpacity(): void {
    this.material.opacity = this.opacity * (this.connected ? 1 : DISCONNECTED_OPACITY);
  }

  private redrawWhenFontLoads(): void {
    const fonts = document.fonts;
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
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    drawPill(ctx, this.nickname, this.color, !this.connected);
    drawHearts(ctx, this.hearts);
    this.texture.needsUpdate = true;
  }
}

function drawPill(ctx: CanvasRenderingContext2D, nickname: string, color: string, away: boolean): void {
  ctx.font = FONT;
  const label = fitText(ctx, nickname || "?", CANVAS_W - 120);
  const textW = ctx.measureText(label).width;
  const badgeW = away ? 58 : 0;
  const w = Math.min(CANVAS_W - 12, textW + 56 + badgeW);
  const x = (CANVAS_W - w) / 2;
  const r = PILL_H / 2;

  // Drop shadow, then the pill with a thick ink border.
  ctx.fillStyle = "rgba(45, 42, 50, 0.35)";
  roundRect(ctx, x + 2, PILL_Y + 7, w, PILL_H - 4, r);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, x, PILL_Y + 3, w, PILL_H - 6, r);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
  roundRect(ctx, x + 10, PILL_Y + 10, w - 20, (PILL_H - 6) * 0.32, r * 0.5);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = PALETTE.ink;
  roundRect(ctx, x, PILL_Y + 3, w, PILL_H - 6, r);
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const tx = CANVAS_W / 2 - badgeW / 2;
  const ty = PILL_Y + PILL_H / 2 + 2;
  ctx.lineJoin = "round";
  ctx.lineWidth = 10;
  ctx.strokeStyle = shadeHex(color, -0.55);
  ctx.strokeText(label, tx, ty);
  ctx.fillStyle = "#FFFFFF";
  ctx.fillText(label, tx, ty);

  if (away) drawAwayBadge(ctx, tx + textW / 2 + 34, ty);
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

function drawHearts(ctx: CanvasRenderingContext2D, hearts: number): void {
  const gap = 8;
  const total = MAX_HEARTS * HEART_SIZE + (MAX_HEARTS - 1) * gap;
  let x = (CANVAS_W - total) / 2;
  for (let i = 0; i < MAX_HEARTS; i++) {
    heartPath(ctx, x + HEART_SIZE / 2, HEART_Y + HEART_SIZE / 2, HEART_SIZE);
    ctx.fillStyle = i < hearts ? HEART_RED : HEART_EMPTY;
    ctx.globalAlpha = i < hearts ? 1 : 0.75;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 5;
    ctx.strokeStyle = PALETTE.ink;
    ctx.stroke();
    if (i < hearts) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
      ctx.beginPath();
      ctx.ellipse(x + HEART_SIZE * 0.32, HEART_Y + HEART_SIZE * 0.3, 5, 4, -0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    x += HEART_SIZE + gap;
  }
}

/** Chunky cartoon heart centered on (cx, cy) fitting a size×size box. */
function heartPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const s = size / 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.85);
  ctx.bezierCurveTo(cx - s * 1.15, cy + s * 0.05, cx - s * 0.95, cy - s * 0.95, cx, cy - s * 0.42);
  ctx.bezierCurveTo(cx + s * 0.95, cy - s * 0.95, cx + s * 1.15, cy + s * 0.05, cx, cy + s * 0.85);
  ctx.closePath();
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

/* ================================================================ crown */

const CROWN_EMISSIVE = "#FFB300";
const JEWELS = ["#FF5A5F", "#3FA7FF", "#7BE07B"];
const SPARKLES = 4;

interface CrownKit {
  gold: THREE.MeshToonMaterial;
  jewels: THREE.MeshToonMaterial[];
  band: THREE.BufferGeometry;
  point: THREE.BufferGeometry;
  ball: THREE.BufferGeometry;
  jewel: THREE.BufferGeometry;
}

let crownKit: CrownKit | null = null;
let sparkleMaterial: THREE.SpriteMaterial | null = null;

/** Crown materials and geometries are shared by every crown and never disposed (a few KB). */
function getCrownKit(): CrownKit {
  if (!crownKit) {
    const band = new THREE.CylinderGeometry(0.15, 0.13, 0.085, 10, 1);
    band.translate(0, 0.0425, 0);
    crownKit = {
      gold: createToonMaterial(PALETTE.crownGold, { emissive: CROWN_EMISSIVE, emissiveIntensity: 0.45 }),
      jewels: JEWELS.map((c) => createToonMaterial(c, { emissive: c, emissiveIntensity: 0.35 })),
      band,
      point: new THREE.ConeGeometry(0.048, 0.11, 4),
      ball: new THREE.SphereGeometry(0.022, 6, 4),
      jewel: new THREE.SphereGeometry(0.026, 6, 4),
    };
  }
  return crownKit;
}

function getSparkleMaterial(): THREE.SpriteMaterial {
  if (!sparkleMaterial) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.25, "rgba(255,240,170,0.9)");
      g.addColorStop(1, "rgba(255,210,63,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      // Four-point star.
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
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }
  return sparkleMaterial;
}

/** Low-poly gold crown (PALETTE.crownGold, emissive so it blooms on high quality), slowly spinning/bobbing. */
export function createCrown(): THREE.Object3D {
  const kit = getCrownKit();
  const holder = new THREE.Group();
  holder.name = "crown";
  const spinner = new THREE.Group();
  spinner.name = "crownSpinner";
  holder.add(spinner);

  spinner.add(new THREE.Mesh(kit.band, kit.gold));
  const points = 5;
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const x = Math.sin(a) * 0.125;
    const z = Math.cos(a) * 0.125;
    const point = new THREE.Mesh(kit.point, kit.gold);
    point.position.set(x, 0.135, z);
    point.rotation.y = a;
    const ball = new THREE.Mesh(kit.ball, kit.gold);
    ball.position.set(x * 1.02, 0.198, z * 1.02);
    const jewel = new THREE.Mesh(kit.jewel, kit.jewels[i % kit.jewels.length]);
    jewel.position.set(Math.sin(a) * 0.147, 0.044, Math.cos(a) * 0.147);
    jewel.scale.set(1, 1.1, 0.6);
    jewel.lookAt(jewel.position.x * 2, jewel.position.y, jewel.position.z * 2);
    spinner.add(point, ball, jewel);
  }
  addOutline(spinner, 0.018);
  spinner.traverse((o) => {
    if (o instanceof THREE.Mesh && !o.userData.isOutline) o.castShadow = true;
  });

  const sparkles = new THREE.Group();
  sparkles.name = "crownSparkles";
  for (let i = 0; i < SPARKLES; i++) {
    const s = new THREE.Sprite(getSparkleMaterial());
    s.userData.phase = i / SPARKLES;
    sparkles.add(s);
  }
  holder.add(sparkles);
  spinner.rotation.z = 0.12;
  updateCrown(holder, 0);
  return holder;
}

/** Animate a crown made by createCrown(): bob, spin and twinkling sparkles. */
export function updateCrown(crown: THREE.Object3D, time: number): void {
  const spinner = crown.getObjectByName("crownSpinner");
  if (spinner) {
    spinner.position.y = 0.035 * Math.sin(time * 3.2);
    spinner.rotation.y = time * 1.1;
  }
  const sparkles = crown.getObjectByName("crownSparkles");
  if (!sparkles) return;
  sparkles.children.forEach((s, i) => {
    const phase = (s.userData.phase as number) ?? 0;
    const cycle = (time * 0.9 + phase) % 1;
    const a = phase * Math.PI * 2 + time * 0.6 + i;
    const size = 0.13 * Math.sin(Math.PI * cycle) ** 2;
    s.position.set(Math.sin(a) * 0.2, 0.08 + 0.18 * cycle, Math.cos(a) * 0.2);
    s.scale.setScalar(Math.max(0.001, size));
  });
}
