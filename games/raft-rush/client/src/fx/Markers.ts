// 3D ping balloons (§12 ping wheel): a toon balloon in the marker color floating over the pinged spot on a
// string, a label pill with the kind's icon + the (translated) text that stays readable across the island, and a
// pulsing ground ring. Pops in, bobs and sways, and pops (confetti) when its time is up. One balloon per id: a
// new ping from the same player replaces the old one. Owner: client-fx-audio.

import * as THREE from "three";
import { PALETTE } from "../../../shared/constants";
import type { MarkerKind } from "../../../shared/types";
import { addOutline, createToonMaterial, glowMaterial, OVERLAY_LAYER } from "../render/Toon";
import type { MarkerVisual } from "./Fx";
import type { Particles } from "./Particles";

/** Balloon center above the pinged point (m). */
const FLOAT_HEIGHT = 2.5;
const BALLOON_RADIUS = 0.32;
const POP_IN_SEC = 0.28;
const POP_OUT_SEC = 0.3;
/** Label pill height in meters at close range; grows with distance to keep ~constant screen size. */
const LABEL_HEIGHT = 0.34;
const LABEL_GROW_PER_M = 0.028;
const LABEL_CANVAS_W = 512;
const LABEL_CANVAS_H = 128;
const RING_PERIOD = 1.6;

let balloonGeometry: THREE.BufferGeometry | null = null;
let knotGeometry: THREE.BufferGeometry | null = null;
let ringGeometry: THREE.BufferGeometry | null = null;

function geometries(): { balloon: THREE.BufferGeometry; knot: THREE.BufferGeometry; ring: THREE.BufferGeometry } {
  if (!balloonGeometry || !knotGeometry || !ringGeometry) {
    const profile: Array<[number, number]> = [
      [0.001, -1.08],
      [0.18, -0.98],
      [0.55, -0.72],
      [0.86, -0.34],
      [1.0, 0.08],
      [0.94, 0.5],
      [0.7, 0.84],
      [0.36, 1.02],
      [0.001, 1.07],
    ];
    balloonGeometry = new THREE.LatheGeometry(
      profile.map(([r, y]) => new THREE.Vector2(r * BALLOON_RADIUS, y * BALLOON_RADIUS)),
      12,
    );
    balloonGeometry.computeVertexNormals();
    knotGeometry = new THREE.ConeGeometry(0.06, 0.1, 6).translate(0, -BALLOON_RADIUS * 1.1, 0);
    ringGeometry = new THREE.RingGeometry(0.82, 1, 28).rotateX(-Math.PI / 2);
  }
  return { balloon: balloonGeometry, knot: knotGeometry, ring: ringGeometry };
}

interface Balloon {
  id: string;
  kind: MarkerKind;
  color: string;
  label: string;
  group: THREE.Group;
  float: THREE.Group;
  balloonMaterial: THREE.MeshToonMaterial;
  knotMaterial: THREE.MeshToonMaterial;
  string: THREE.Line;
  stringGeometry: THREE.BufferGeometry;
  stringMaterial: THREE.LineBasicMaterial;
  sprite: THREE.Sprite;
  spriteMaterial: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture;
  labelAspect: number;
  ring: THREE.Mesh;
  ringMaterial: THREE.MeshBasicMaterial;
  shine: THREE.Mesh;
  age: number;
  ttl: number;
  phase: number;
  popped: boolean;
}

/** Draw the kind icon centered at (cx, cy) with radius r (white symbol on the marker color disc). */
function drawIcon(ctx: CanvasRenderingContext2D, kind: MarkerKind, cx: number, cy: number, r: number, color: string): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = PALETTE.ink;
  ctx.stroke();
  ctx.fillStyle = "#FFFFFF";
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  switch (kind) {
    case "here": {
      // A down arrow: "over here!".
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.2, cy - r * 0.55);
      ctx.lineTo(cx + r * 0.2, cy - r * 0.55);
      ctx.lineTo(cx + r * 0.2, cy);
      ctx.lineTo(cx + r * 0.48, cy);
      ctx.lineTo(cx, cy + r * 0.55);
      ctx.lineTo(cx - r * 0.48, cy);
      ctx.lineTo(cx - r * 0.2, cy);
      ctx.closePath();
      ctx.lineWidth = 5;
      ctx.fill();
      ctx.stroke();
      return;
    }
    case "help": {
      // A life ring (red/white stripes).
      ctx.lineWidth = r * 0.34;
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.strokeStyle = i % 2 === 0 ? "#FFFFFF" : "#FF5A5F";
        ctx.arc(cx, cy, r * 0.52, (i / 4) * Math.PI * 2 + 0.4, ((i + 1) / 4) * Math.PI * 2 + 0.4);
        ctx.stroke();
      }
      ctx.lineWidth = 4;
      ctx.strokeStyle = PALETTE.ink;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.69, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.35, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    case "need": {
      // A question mark: "need this".
      ctx.font = `700 ${Math.round(r * 1.35)}px Fredoka, "Arial Rounded MT Bold", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 8;
      ctx.strokeText("?", cx, cy + r * 0.06);
      ctx.fillText("?", cx, cy + r * 0.06);
      return;
    }
    case "danger": {
      // Warning triangle with "!".
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 0.62);
      ctx.lineTo(cx + r * 0.62, cy + r * 0.48);
      ctx.lineTo(cx - r * 0.62, cy + r * 0.48);
      ctx.closePath();
      ctx.fillStyle = "#FFD166";
      ctx.lineWidth = 5;
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = PALETTE.ink;
      ctx.fillRect(cx - r * 0.06, cy - r * 0.28, r * 0.12, r * 0.42);
      ctx.beginPath();
      ctx.arc(cx, cy + r * 0.3, r * 0.08, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
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

/** Paint the label pill; returns its used width / height (sprite aspect). */
function paintLabel(canvas: HTMLCanvasElement, kind: MarkerKind, color: string, label: string): number {
  const ctx = canvas.getContext("2d");
  if (!ctx) return 1;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const h = LABEL_CANVAS_H - 16;
  const iconR = h * 0.42;
  let px = 56;
  const fontFor = (size: number): string => `600 ${size}px Fredoka, "Arial Rounded MT Bold", "Trebuchet MS", sans-serif`;
  ctx.font = fontFor(px);
  const maxText = LABEL_CANVAS_W - 8 - h - 30;
  let textW = label ? ctx.measureText(label).width : 0;
  if (textW > maxText) {
    px = Math.max(26, Math.floor((px * maxText) / textW));
    ctx.font = fontFor(px);
    textW = ctx.measureText(label).width;
  }
  const w = Math.min(LABEL_CANVAS_W - 8, h + (label ? textW + 30 : 0));
  const x = 4;
  const y = 8;
  // Drop shadow, pill, ink border.
  ctx.fillStyle = "rgba(45,42,50,0.35)";
  roundRect(ctx, x + 3, y + 5, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = PALETTE.cream;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = PALETTE.ink;
  ctx.stroke();
  drawIcon(ctx, kind, x + h / 2, y + h / 2, iconR, color);
  if (label) {
    ctx.font = fontFor(px);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PALETTE.ink;
    ctx.fillText(label, x + h + 6, y + h / 2 + 2, maxText);
  }
  return (w + 8) / LABEL_CANVAS_H;
}

export class Markers {
  private readonly root = new THREE.Group();
  private readonly balloons = new Map<string, Balloon>();
  private readonly camPos = new THREE.Vector3();
  private readonly world = new THREE.Vector3();

  constructor(
    parent: THREE.Object3D,
    private readonly camera: THREE.Camera,
    private readonly particles: Particles,
  ) {
    this.root.name = "fx-markers";
    parent.add(this.root);
  }

  get count(): number {
    return this.balloons.size;
  }

  add(m: MarkerVisual): void {
    const old = this.balloons.get(m.id);
    if (old) this.remove(old);
    const { balloon, knot, ring } = geometries();
    const group = new THREE.Group();
    group.name = `fx-marker-${m.id}`;
    group.position.set(m.pos.x, m.pos.y, m.pos.z);
    const float = new THREE.Group();
    float.position.y = FLOAT_HEIGHT;
    group.add(float);

    const balloonMaterial = createToonMaterial(m.color, { emissive: m.color, emissiveIntensity: 0.18 });
    const knotMaterial = createToonMaterial(m.color);
    const body = new THREE.Mesh(balloon, balloonMaterial);
    body.castShadow = false;
    const knotMesh = new THREE.Mesh(knot, knotMaterial);
    knotMesh.castShadow = false;
    float.add(body, knotMesh);
    addOutline(body, 0.02);
    addOutline(knotMesh, 0.015);
    // Shiny highlight blob (cartoon balloon gloss).
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), glowMaterial("#FFFFFF", 0.75));
    shine.position.set(-0.12, 0.13, 0.22);
    shine.scale.set(0.8, 1.4, 0.5);
    shine.userData.noOutline = true;
    float.add(shine);

    const stringGeometry = new THREE.BufferGeometry();
    stringGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9 * 3), 3));
    const stringMaterial = new THREE.LineBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.8 });
    const string = new THREE.Line(stringGeometry, stringMaterial);
    string.frustumCulled = false;
    group.add(string);

    const canvas = document.createElement("canvas");
    canvas.width = LABEL_CANVAS_W;
    canvas.height = LABEL_CANVAS_H;
    const labelAspect = paintLabel(canvas, m.kind, m.color, m.label);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    // Show only the used part of the canvas.
    texture.repeat.set(Math.min(1, (labelAspect * LABEL_CANVAS_H) / LABEL_CANVAS_W), 1);
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.center.set(0.5, 0);
    sprite.renderOrder = 12;
    sprite.layers.set(OVERLAY_LAYER);
    sprite.raycast = () => {};
    float.add(sprite);

    const ringMaterial = new THREE.MeshBasicMaterial({ color: m.color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    const ringMesh = new THREE.Mesh(ring, ringMaterial);
    ringMesh.position.y = 0.06;
    ringMesh.renderOrder = 2;
    group.add(ringMesh);

    this.root.add(group);
    const b: Balloon = {
      id: m.id,
      kind: m.kind,
      color: m.color,
      label: m.label,
      group,
      float,
      balloonMaterial,
      knotMaterial,
      string,
      stringGeometry,
      stringMaterial,
      sprite,
      spriteMaterial,
      texture,
      labelAspect,
      ring: ringMesh,
      ringMaterial,
      shine,
      age: 0,
      ttl: Math.max(0.5, m.ttl),
      phase: Math.random() * Math.PI * 2,
      popped: false,
    };
    this.balloons.set(m.id, b);
    this.particles.burst("ripple", m.pos, { color: m.color, scale: 0.9 });
  }

  update(dt: number): void {
    this.camera.getWorldPosition(this.camPos);
    for (const b of [...this.balloons.values()]) {
      b.age += dt;
      if (b.age >= b.ttl) {
        this.pop(b);
        continue;
      }
      this.animate(b);
    }
  }

  clear(): void {
    for (const b of [...this.balloons.values()]) this.remove(b);
  }

  dispose(): void {
    this.clear();
    this.root.removeFromParent();
  }

  private animate(b: Balloon): void {
    const t = b.age;
    const left = b.ttl - t;
    let scale: number;
    if (t < POP_IN_SEC) {
      const k = t / POP_IN_SEC;
      scale = k < 0.6 ? 1.25 * easeOut(k / 0.6) : 1.25 - 0.25 * ((k - 0.6) / 0.4);
    } else if (left < POP_OUT_SEC) {
      scale = 1 + 0.35 * (1 - left / POP_OUT_SEC);
    } else {
      scale = 1;
    }
    b.group.getWorldPosition(this.world);
    const dist = this.world.distanceTo(this.camPos);
    // Far balloons grow so a ping across the island is still easy to spot.
    const grow = Math.min(2.6, Math.max(1, dist / 14));
    const bob = Math.sin(t * 2.2 + b.phase) * 0.09;
    b.float.position.set(Math.sin(t * 1.3 + b.phase) * 0.06, FLOAT_HEIGHT + bob + (grow - 1) * 0.6, 0);
    b.float.rotation.z = Math.sin(t * 1.7 + b.phase) * 0.09;
    b.float.scale.setScalar(Math.max(0.001, scale * grow));
    const labelH = LABEL_HEIGHT + dist * LABEL_GROW_PER_M;
    const s = labelH / Math.max(0.001, scale * grow);
    b.sprite.scale.set(s * b.labelAspect, s, 1);
    b.sprite.position.set(0, BALLOON_RADIUS * 1.2, 0);
    b.spriteMaterial.opacity = left < POP_OUT_SEC ? left / POP_OUT_SEC : Math.min(1, t / 0.15);
    // String from the knot (in group space) to the ground point, with a lazy wave.
    const pos = b.stringGeometry.getAttribute("position") as THREE.BufferAttribute;
    const topX = b.float.position.x;
    const topY = b.float.position.y - BALLOON_RADIUS * 1.15 * scale * grow;
    for (let i = 0; i < 9; i++) {
      const u = i / 8;
      const wave = Math.sin(u * Math.PI) * 0.12 * Math.sin(t * 2.4 + u * 4 + b.phase);
      pos.setXYZ(i, topX * (1 - u) + wave, topY * (1 - u) + 0.05 * u, wave * 0.5);
    }
    pos.needsUpdate = true;
    b.stringMaterial.opacity = 0.8 * Math.min(1, t / POP_IN_SEC);
    // Ground ring: expanding pulse every RING_PERIOD.
    const rp = (t % RING_PERIOD) / RING_PERIOD;
    const rr = 0.4 + rp * 1.3;
    b.ring.scale.set(rr, 1, rr);
    b.ringMaterial.opacity = 0.55 * (1 - rp) * (left < POP_OUT_SEC ? left / POP_OUT_SEC : 1);
  }

  private pop(b: Balloon): void {
    b.float.getWorldPosition(this.world);
    this.particles.burst("confetti", this.world, { count: 10, color: b.color, scale: 0.35 });
    this.particles.burst("sparkle", this.world, { count: 4, color: b.color, scale: 0.6 });
    this.remove(b);
  }

  private remove(b: Balloon): void {
    this.balloons.delete(b.id);
    b.group.removeFromParent();
    b.balloonMaterial.dispose();
    b.knotMaterial.dispose();
    b.stringGeometry.dispose();
    b.stringMaterial.dispose();
    b.spriteMaterial.dispose();
    b.texture.dispose();
    b.ringMaterial.dispose();
    b.shine.geometry.dispose();
  }
}

function easeOut(x: number): number {
  const k = 1 - Math.min(1, Math.max(0, x));
  return 1 - k * k * k;
}
