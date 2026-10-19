// Kitchen-junk piece meshes + the tower view (synced pieces, hover piece, ghost shadow).
// Owner: client-pieces. PUBLIC API IS THE CONTRACT; fill in the bodies (helpers under scene/pieces/ freely).
//
// Meshes (game2.md §8): procedural low-poly, toon() + addOutlines(), built so their shape roughly matches
// PIECES[type].colliders (same local frame, center of mass at origin) — the physics runs on the server with
// those colliders, so a visual that sticks out far beyond them looks like cheating. Make them FUNNY:
// googly eyes (googlyEyes/jiggleEyes from ./toon) on most pieces, a derpy smile on the toaster with toast
// popping up, the fish with a goofy pout, the chicken's floppy neck, sprinkles on the donut, the egg with
// angry eyebrows, the watermelon with a toothy grin, a bowling ball with a smug face, the golden cherry
// sparkling (emissive gold). Jelly wobbles with a vertex-shader-free trick (scale squash & stretch springs
// driven by velocity / landing). Card visuals on a piece (PieceView.card): jellyMode → translucent
// green-jelly look + wobble, butterFingers → shiny yellow butter pats + a glossy sheen, glueGun → white glue
// drips, heavySnack → a tiny "3 KG" weight tag, chonk handled by scale.
//
// Implementation: builders live in ./pieces/builders (one per type), card looks in ./pieces/cards, shared
// caches + face parts in ./pieces/kit, the removal poof in ./pieces/poof. Every mesh root carries its
// PieceRig in root.userData.rig (squash spring, pupils, per-piece anims, impact hooks).

import * as THREE from "three";
import type { PieceType } from "../../../shared/constants";
import { CAKE_RADIUS, CAKE_TOP_Y, PIECES, STAND_PLATE_RADIUS, STAND_PLATE_Y } from "../../../shared/constants";
import type { HoverView, JellyStateView, PieceView } from "../../../shared/protocol";
import { addOutlines } from "./toon";
import { BUILDERS } from "./pieces/builders";
import { applyCard } from "./pieces/cards";
import { geo, jigglePupils, newRig, type PieceRig } from "./pieces/kit";
import { Poofs } from "./pieces/poof";

/** Cards that change how a piece looks (others are invisible on the mesh). */
const VISUAL_CARDS = new Set(["jellyMode", "butterFingers", "glueGun", "heavySnack"]);

/** Build a fresh mesh group for a piece type. `card` adds card visuals (see header). */
export function makePieceMesh(type: PieceType, card = ""): THREE.Group {
  const def = PIECES[type] ?? PIECES.jelly;
  const c = VISUAL_CARDS.has(card) ? card : "";
  const rig = newRig(def.type, c);
  BUILDERS[def.type](rig);
  addOutlines(rig.body, 1.06);
  rig.root.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(rig.body);
  rig.bottom = bb.isEmpty() ? 0 : bb.min.y;
  applyCard(rig, c);
  return rig.root;
}

export function rigOf(o: THREE.Object3D): PieceRig | null {
  return (o.userData.rig as PieceRig | undefined) ?? null;
}

// Squash & stretch spring constants: jelly is soft and slow to settle.
const SPRING = { k: 520, c: 16, max: 0.22 };
const JELLY_SPRING = { k: 150, c: 3.2, max: 0.35 };

/** Step a rig's squash spring + eyes + per-piece anims. `speed` = how fast it moves (m/s). */
export function animateRig(rig: PieceRig, dt: number, time: number, speed: number): void {
  const sp = rig.jelly ? JELLY_SPRING : SPRING;
  const a = -sp.k * rig.sq - sp.c * rig.sqV;
  rig.sqV += a * dt;
  rig.sq += rig.sqV * dt;
  if (rig.sq > sp.max) {
    rig.sq = sp.max;
    rig.sqV = Math.min(0, rig.sqV);
  } else if (rig.sq < -sp.max) {
    rig.sq = -sp.max;
    rig.sqV = Math.max(0, rig.sqV);
  }
  // Jelly always jiggles a little (nervous wreck).
  const idle = rig.jelly ? Math.sin(time * 9 + rig.seed * 20) * 0.025 + Math.sin(time * 5.3 + rig.seed * 7) * 0.012 : 0;
  const s = rig.sq + idle;
  const sy = 1 - s;
  const sxz = 1 + s * 0.55;
  rig.body.scale.set(sxz, sy, sxz);
  // Pivot the squash at the piece's bottom so it squishes onto what it sits on.
  rig.body.position.y = rig.bottom * (1 - sy);
  if (rig.jelly) {
    rig.body.rotation.z = rig.sqV * 0.012 + Math.sin(time * 6.5 + rig.seed * 9) * 0.02;
    rig.body.rotation.x = Math.cos(time * 5.7 + rig.seed * 4) * 0.015;
  }
  jigglePupils(rig, dt, speed + Math.abs(rig.sqV) * 0.05);
  for (const fn of rig.anims) fn(rig, dt, time, speed);
}

/** Impact on a rig: kick the squash spring + per-piece reactions (toast pop, egg crack, chicken flop). */
export function hitRig(rig: PieceRig, intensity: number): void {
  const k = THREE.MathUtils.clamp(intensity, 0, 1);
  rig.sqV += (rig.jelly ? 7 : 4.5) * k;
  for (const p of rig.pupils) (p.userData.vel as THREE.Vector2).set((Math.random() - 0.5) * 0.5 * k, (Math.random() - 0.5) * 0.5 * k);
  for (const fn of rig.hits) fn(rig, k);
}

// ====================================================================== preview
interface SharedPreviewRenderer {
  renderer: THREE.WebGLRenderer | null;
  failed: boolean;
  users: number;
}
const previewGL: SharedPreviewRenderer = { renderer: null, failed: false, users: 0 };

function previewRenderer(): THREE.WebGLRenderer | null {
  if (previewGL.renderer || previewGL.failed) return previewGL.renderer;
  try {
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    r.setPixelRatio(1);
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    previewGL.renderer = r;
  } catch {
    previewGL.failed = true;
  }
  return previewGL.renderer;
}

/** A small rotating preview of a piece for the HUD "Next up" panel: renders into its own <canvas>. */
export class PiecePreview {
  readonly canvas!: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly px: number;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(28, 1, 0.01, 10);
  private readonly spin = new THREE.Group();
  private readonly cache = new Map<string, { root: THREE.Group; offset: THREE.Vector3; dist: number }>();
  private current: { root: THREE.Group; offset: THREE.Vector3; dist: number } | null = null;
  private type: PieceType | "" = "";
  private time = Math.random() * 10;
  private hopT = 1;
  private disposed = false;

  constructor(size = 96) {
    const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    this.px = Math.round(size * dpr);
    const c = document.createElement("canvas");
    c.width = this.px;
    c.height = this.px;
    c.style.width = `${size}px`;
    c.style.height = `${size}px`;
    c.className = "jj-piece-preview";
    this.canvas = c;
    this.ctx = c.getContext("2d");
    previewGL.users++;
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x5a4a7a, 1.6));
    const key = new THREE.DirectionalLight(0xffe2b8, 2.2);
    key.position.set(1, 2, 1.5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xb07cff, 1.0);
    rim.position.set(-1.5, 0.5, -1);
    this.scene.add(rim);
    this.scene.add(this.spin);
  }

  set(type: PieceType | ""): void {
    if (type === this.type) return;
    this.type = type;
    if (this.current) this.spin.remove(this.current.root);
    this.current = null;
    if (!type || !PIECES[type]) {
      this.draw();
      return;
    }
    let entry = this.cache.get(type);
    if (!entry) {
      const root = makePieceMesh(type);
      root.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(root);
      const offset = bb.getCenter(new THREE.Vector3()).negate();
      const r = Math.max(bb.getSize(new THREE.Vector3()).length() * 0.5, 0.03);
      const dist = r / Math.tan(THREE.MathUtils.degToRad(14)) * 1.05;
      entry = { root, offset, dist };
      this.cache.set(type, entry);
    }
    entry.root.position.copy(entry.offset);
    this.spin.add(entry.root);
    this.current = entry;
    this.hopT = 0; // new piece arrives with a happy hop
  }

  /** Render one frame (call each animation frame while visible). */
  update(dt: number): void {
    if (this.disposed) return;
    this.time += dt;
    if (this.current) {
      const t = this.time;
      this.spin.rotation.y += dt * 0.9;
      this.spin.rotation.x = 0.35 + Math.sin(t * 0.7) * 0.08;
      // Hop now and then (squash on landing).
      this.hopT += dt;
      if (this.hopT > 3.2 + Math.sin(t) * 0.5) this.hopT = 0;
      const h = this.hopT < 0.45 ? Math.sin((this.hopT / 0.45) * Math.PI) : 0;
      const rig = rigOf(this.current.root);
      if (rig) {
        if (this.hopT > 0.45 && this.hopT - dt <= 0.45) hitRig(rig, 0.6);
        animateRig(rig, dt, t, h * 2);
      }
      const d = this.current.dist;
      this.spin.position.y = h * d * 0.08;
      this.camera.position.set(0, d * 0.12, d);
      this.camera.lookAt(0, 0, 0);
    }
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.px, this.px);
    if (!this.current) return;
    const r = previewRenderer();
    if (!r) {
      // No WebGL: show the emoji instead.
      ctx.font = `${Math.round(this.px * 0.6)}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.type ? PIECES[this.type].emoji : "", this.px / 2, this.px / 2);
      return;
    }
    const size = r.getSize(_v2);
    if (size.x !== this.px || size.y !== this.px) r.setSize(this.px, this.px, false);
    r.render(this.scene, this.camera);
    ctx.drawImage(r.domElement, 0, 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cache.clear();
    this.current = null;
    previewGL.users = Math.max(0, previewGL.users - 1);
    if (previewGL.users === 0 && previewGL.renderer) {
      previewGL.renderer.dispose();
      previewGL.renderer.forceContextLoss();
      previewGL.renderer = null;
    }
  }
}
const _v2 = new THREE.Vector2();

// ====================================================================== tower view
export interface TowerViewEvents {
  /** A piece mesh appeared (first seen in state). Local-frame position. */
  pieceAdded?: (piece: PieceView) => void;
}

interface Entry {
  id: string;
  type: PieceType;
  card: string;
  rig: PieceRig;
  root: THREE.Group;
  tPos: THREE.Vector3;
  tQuat: THREE.Quaternion;
  scale: number;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  speed: number;
  asleep: boolean;
  stamp: number;
  /** < 0 alive, else seconds into the removal pop. */
  dying: number;
}

const SMOOTH = 12;
const SNAP_DIST = 0.5;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Keeps meshes in `parent` (Stage.standGroup) in sync with state.pieces and state.hover.
 * - Pieces: create on first sight, remove when gone (with a pop/poof scale-out), smoothly interpolate
 *   position/rotation toward the latest state values (exponential smoothing ~ 12/s, snap if > 0.5 m away).
 * - Hover piece: shown while state.hover.active (or the local override below), with a soft bob, a drop
 *   shadow ring projected straight down onto the highest surface beneath it (raycast the tower meshes +
 *   cake), and a faint vertical guide line.
 * - Local override: the active player's own client shows its own pose immediately (setLocalHover) instead
 *   of waiting for the relay, so placement feels instant.
 */
export class TowerView {
  private readonly parent: THREE.Object3D;
  private readonly events: TowerViewEvents;
  private readonly root = new THREE.Group();
  private readonly entries = new Map<string, Entry>();
  private readonly dying: Entry[] = [];
  private list: THREE.Object3D[] = [];
  private listDirty = true;
  private stamp = 0;
  private readonly poofs: Poofs;

  // hover
  private readonly hoverHolder = new THREE.Group();
  private readonly hoverCache = new Map<string, THREE.Group>();
  private hoverMesh: THREE.Group | null = null;
  private hoverKey = "";
  private readonly stateHover = { active: false, type: "" as PieceType | "", pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 1, fresh: false };
  private readonly shownPos = new THREE.Vector3();
  private readonly shownQuat = new THREE.Quaternion();
  private readonly lastHoverPos = new THREE.Vector3();
  private local: { type: PieceType | ""; pos: THREE.Vector3; quat: THREE.Quaternion; scale: number } | null = null;
  private readonly localStore = { type: "" as PieceType | "", pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 1 };
  private hoverCard = "";
  private suppressed = 0;
  private hoverVisibleLast = false;
  private hoverAppear = 0;

  // shadow + guide
  private readonly shadow = new THREE.Group();
  private readonly shadowDisc: THREE.Mesh;
  private readonly shadowRing: THREE.Mesh;
  private readonly guide: THREE.Mesh;
  private readonly discMat: THREE.MeshBasicMaterial;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly guideMat: THREE.MeshBasicMaterial;
  private readonly raycaster = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];

  constructor(parent: THREE.Object3D, events?: TowerViewEvents) {
    this.parent = parent;
    this.events = events ?? {};
    this.root.name = "tower";
    parent.add(this.root);
    this.hoverHolder.name = "hover";
    this.hoverHolder.visible = false;
    parent.add(this.hoverHolder);
    this.poofs = new Poofs(parent);

    this.discMat = new THREE.MeshBasicMaterial({ color: 0x2d2a32, transparent: true, opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    this.guideMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false });
    const discGeo = geo("shadowDisc", () => new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2));
    const ringGeo = geo("shadowRing", () => {
      // Dashed ring (12 dashes) so the spin is visible: it looks like a little target.
      const parts: THREE.BufferGeometry[] = [];
      const n = 12;
      for (let i = 0; i < n; i++) parts.push(new THREE.RingGeometry(0.86, 1, 3, 1, (i / n) * Math.PI * 2, (Math.PI * 2) / n * 0.6));
      const pos: number[] = [];
      for (const p of parts) {
        const ni = p.toNonIndexed();
        pos.push(...(ni.getAttribute("position").array as Float32Array));
        ni.dispose();
        p.dispose();
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.rotateX(-Math.PI / 2);
      return g;
    });
    const guideGeo = geo("guideLine", () => new THREE.CylinderGeometry(0.0018, 0.0018, 1, 6, 1, true).translate(0, 0.5, 0));
    this.shadowDisc = new THREE.Mesh(discGeo, this.discMat);
    this.shadowRing = new THREE.Mesh(ringGeo, this.ringMat);
    this.guide = new THREE.Mesh(guideGeo, this.guideMat);
    for (const m of [this.shadowDisc, this.shadowRing, this.guide]) {
      m.raycast = () => {};
      m.renderOrder = 5;
    }
    this.shadow.add(this.shadowDisc, this.shadowRing);
    this.shadow.visible = false;
    this.guide.visible = false;
    parent.add(this.shadow, this.guide);
  }

  /** Call on every state patch (cheap; diff internally). */
  sync(state: JellyStateView): void {
    const st = ++this.stamp;
    state.pieces?.forEach((p, key) => {
      const id = p.id || key;
      let e = this.entries.get(id);
      const card = VISUAL_CARDS.has(p.card) ? p.card : "";
      if (e && (e.type !== p.type || e.card !== card)) {
        this.root.remove(e.root);
        this.entries.delete(id);
        this.listDirty = true;
        e = undefined;
      }
      if (!e) {
        e = this.create(id, p.type, card);
        e.root.position.set(p.x, p.y, p.z);
        e.root.quaternion.set(p.qx, p.qy, p.qz, p.qw).normalize();
        e.prev.copy(e.root.position);
        e.tPos.copy(e.root.position);
        e.tQuat.copy(e.root.quaternion);
        e.scale = p.scale || 1;
        e.root.scale.setScalar(e.scale);
        e.stamp = st;
        this.events.pieceAdded?.(p);
        // A new piece lands in the tower: it arrives with a little squish.
        hitRig(e.rig, 0.35);
      }
      e.stamp = st;
      e.tPos.set(p.x, p.y, p.z);
      e.tQuat.set(p.qx, p.qy, p.qz, p.qw);
      if (e.tQuat.lengthSq() < 1e-8) e.tQuat.identity();
      else e.tQuat.normalize();
      e.scale = p.scale || 1;
      e.asleep = p.asleep;
      if (e.root.position.distanceTo(e.tPos) > SNAP_DIST) {
        e.root.position.copy(e.tPos);
        e.prev.copy(e.tPos);
        e.root.quaternion.copy(e.tQuat);
      }
    });
    for (const e of this.entries.values()) {
      if (e.stamp !== st) this.kill(e, true);
    }

    // Hover from state.
    const h = state.hover;
    const sh = this.stateHover;
    const wasActive = sh.active;
    sh.active = !!h?.active && !!h.type;
    if (h && sh.active) {
      if (!wasActive || sh.type !== h.type) sh.fresh = true;
      sh.type = h.type;
      sh.pos.set(h.x, h.y, h.z);
      sh.quat.set(h.qx, h.qy, h.qz, h.qw);
      if (sh.quat.lengthSq() < 1e-8) sh.quat.identity();
      else sh.quat.normalize();
      sh.scale = h.scale || 1;
    }
    if (!sh.active && this.suppressed > 0) this.suppressed = 0;
    this.hoverCard = state.phase === "placing" && VISUAL_CARDS.has(state.card?.id ?? "") ? state.card.id : "";
  }

  /** Local hover pose for the active player (null = use state.hover). */
  setLocalHover(type: PieceType | "", pose: { x: number; y: number; z: number; quat: THREE.Quaternion; scale: number } | null): void {
    if (!pose || !type) {
      this.local = null;
      return;
    }
    const l = this.localStore;
    l.type = type;
    l.pos.set(pose.x, pose.y, pose.z);
    l.quat.copy(pose.quat);
    l.scale = pose.scale || 1;
    if (!this.local) this.suppressed = 0; // a fresh placement (e.g. Double Decker's second piece)
    this.local = l;
  }

  /** Hide hover visuals right away (e.g. on drop). */
  clearHover(): void {
    this.suppressed = 0.7;
    this.local = null;
    this.hoverHolder.visible = false;
    this.shadow.visible = false;
    this.guide.visible = false;
    this.hoverVisibleLast = false;
  }

  /** Make a piece wobble/squish (impact); intensity 0..1. */
  squish(pieceId: string, intensity: number): void {
    const e = this.entries.get(pieceId);
    if (e) hitRig(e.rig, intensity);
  }

  /** Local-frame position of a piece mesh (or null). */
  piecePosition(pieceId: string): THREE.Vector3 | null {
    const e = this.entries.get(pieceId);
    return e ? e.root.position.clone() : null;
  }

  /** All tower meshes (for raycasts by other modules). */
  meshes(): THREE.Object3D[] {
    if (this.listDirty) {
      this.list = [];
      for (const e of this.entries.values()) this.list.push(e.root);
      this.listDirty = false;
    }
    return this.list;
  }

  /** Per-frame: interpolation, jelly wobble, googly eyes, hover bob. */
  update(dt: number, time: number): void {
    const step = Math.max(dt, 1e-4);
    const k = 1 - Math.exp(-SMOOTH * dt);
    for (const e of this.entries.values()) {
      e.prev.copy(e.root.position);
      e.root.position.lerp(e.tPos, k);
      e.root.quaternion.slerp(e.tQuat, k);
      const s = e.root.scale.x + (e.scale - e.root.scale.x) * k;
      e.root.scale.setScalar(s);
      _v.subVectors(e.root.position, e.prev).divideScalar(step);
      // Landing: a sudden stop after falling → squish.
      if (e.vel.y < -0.6 && _v.y > e.vel.y * 0.3) hitRig(e.rig, Math.min(1, -e.vel.y / 3) * 0.6);
      e.vel.lerp(_v, 0.5);
      e.speed = e.vel.length();
      animateRig(e.rig, dt, time, e.asleep ? 0 : e.speed);
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const e = this.dying[i];
      e.dying += dt;
      const u = e.dying / 0.28;
      if (u >= 1) {
        this.root.remove(e.root);
        this.dying.splice(i, 1);
        continue;
      }
      // Pop bigger, then shrink to nothing.
      const s = u < 0.3 ? 1 + 0.3 * (u / 0.3) : 1.3 * (1 - (u - 0.3) / 0.7);
      e.root.scale.setScalar(e.scale * Math.max(0.001, s));
      animateRig(e.rig, dt, time, 2);
    }
    this.poofs.update(dt);
    this.updateHover(dt, time);
  }

  /** Immediately remove every piece mesh (fresh cake). */
  clear(): void {
    for (const e of this.entries.values()) this.root.remove(e.root);
    for (const e of this.dying) this.root.remove(e.root);
    this.entries.clear();
    this.dying.length = 0;
    this.listDirty = true;
    this.poofs.clear();
    this.stateHover.active = false;
    this.local = null;
    this.clearHover();
    this.suppressed = 0;
  }

  /** For the hover-state type when not provided. */
  static hoverOf(state: JellyStateView): HoverView {
    return state.hover;
  }

  // ------------------------------------------------------------------ internals
  private create(id: string, type: PieceType, card: string): Entry {
    const root = makePieceMesh(type, card);
    const rig = rigOf(root) as PieceRig;
    root.name = `piece:${id}`;
    root.userData.pieceId = id;
    this.root.add(root);
    const e: Entry = {
      id, type, card, rig, root, tPos: new THREE.Vector3(), tQuat: new THREE.Quaternion(), scale: 1,
      prev: new THREE.Vector3(), vel: new THREE.Vector3(), speed: 0, asleep: false, stamp: 0, dying: -1,
    };
    this.entries.set(id, e);
    this.listDirty = true;
    return e;
  }

  private kill(e: Entry, poof: boolean): void {
    this.entries.delete(e.id);
    this.listDirty = true;
    if (!poof) {
      this.root.remove(e.root);
      return;
    }
    e.dying = 0;
    this.dying.push(e);
    const def = PIECES[e.type];
    this.poofs.spawn(e.root.position, (def?.radius ?? 0.08) * e.scale, def?.colors[0] ?? "#FFFFFF");
  }

  private hoverFor(type: PieceType, card: string): THREE.Group {
    const key = `${type}|${card}`;
    let m = this.hoverCache.get(key);
    if (!m) {
      m = makePieceMesh(type, card);
      m.traverse((o) => {
        o.raycast = () => {};
        const me = o as THREE.Mesh;
        if (me.isMesh) me.receiveShadow = false;
      });
      this.hoverCache.set(key, m);
    }
    return m;
  }

  private updateHover(dt: number, time: number): void {
    if (this.suppressed > 0) this.suppressed = Math.max(0, this.suppressed - dt);
    const sh = this.stateHover;
    const useLocal = this.local !== null;
    const type: PieceType | "" = useLocal ? this.local!.type : sh.active ? sh.type : "";
    const visible = type !== "" && !!PIECES[type as PieceType] && this.suppressed <= 0;
    if (!visible) {
      if (this.hoverVisibleLast) {
        this.hoverHolder.visible = false;
        this.shadow.visible = false;
        this.guide.visible = false;
        this.hoverVisibleLast = false;
      }
      return;
    }
    // Swap the mesh when the type / card changes.
    const key = `${type}|${this.hoverCard}`;
    if (key !== this.hoverKey || !this.hoverMesh) {
      if (this.hoverMesh) this.hoverHolder.remove(this.hoverMesh);
      this.hoverMesh = this.hoverFor(type as PieceType, this.hoverCard);
      this.hoverHolder.add(this.hoverMesh);
      this.hoverKey = key;
      this.hoverAppear = 0;
    }
    // Pose: local is immediate; the relayed one is smoothed (snap when it first appears).
    let scale: number;
    if (useLocal) {
      const l = this.local!;
      this.shownPos.copy(l.pos);
      this.shownQuat.copy(l.quat);
      scale = l.scale;
    } else {
      if (sh.fresh || !this.hoverVisibleLast) {
        this.shownPos.copy(sh.pos);
        this.shownQuat.copy(sh.quat);
        sh.fresh = false;
      } else {
        const k = 1 - Math.exp(-15 * dt);
        this.shownPos.lerp(sh.pos, k);
        this.shownQuat.slerp(sh.quat, k);
      }
      scale = sh.scale;
    }
    if (!this.hoverVisibleLast) {
      this.hoverAppear = 0;
      this.lastHoverPos.copy(this.shownPos);
    }
    this.hoverAppear = Math.min(1, this.hoverAppear + dt * 5);
    const speed = _w.subVectors(this.shownPos, this.lastHoverPos).length() / Math.max(dt, 1e-4);
    this.lastHoverPos.copy(this.shownPos);

    // Soft bob + a little nervous sway; pops in with an overshoot.
    const bob = Math.sin(time * 3.2) * 0.006;
    this.hoverHolder.position.set(this.shownPos.x, this.shownPos.y + bob, this.shownPos.z);
    _q.setFromAxisAngle(_w.set(0, 0, 1), Math.sin(time * 2.1) * 0.03);
    this.hoverHolder.quaternion.copy(this.shownQuat).multiply(_q);
    const a = this.hoverAppear;
    const pop = a < 1 ? 1 + Math.sin(a * Math.PI) * 0.25 - (1 - a) * 0.6 : 1;
    this.hoverHolder.scale.setScalar(scale * Math.max(0.05, pop));
    this.hoverHolder.visible = true;
    const rig = rigOf(this.hoverMesh);
    if (rig) animateRig(rig, dt, time, Math.min(speed, 3) + 0.4);

    // Shadow: raycast straight down (stand-local) onto the tower, else the cake / plate / table.
    const def = PIECES[type as PieceType];
    const lowest = this.shownPos.y - def.radius * scale * 0.7;
    let surfaceY = this.groundY(this.shownPos.x, this.shownPos.z);
    const meshes = this.meshes();
    if (meshes.length) {
      this.parent.updateMatrixWorld();
      _v.copy(this.shownPos);
      this.parent.localToWorld(_v);
      _w.copy(DOWN).transformDirection(this.parent.matrixWorld);
      this.raycaster.set(_v, _w);
      this.raycaster.far = 3;
      this.hits.length = 0;
      this.raycaster.intersectObjects(meshes, true, this.hits);
      for (const hit of this.hits) {
        if (!hit.object.visible) continue;
        _v.copy(hit.point);
        this.parent.worldToLocal(_v);
        if (_v.y < this.shownPos.y && _v.y > surfaceY) surfaceY = _v.y;
        break;
      }
    }
    const gap = Math.max(0, lowest - surfaceY);
    const r = def.radius * scale * (0.85 + Math.min(gap, 0.6) * 0.8);
    this.shadow.position.set(this.shownPos.x, surfaceY + 0.002, this.shownPos.z);
    this.shadow.scale.setScalar(Math.max(0.02, r));
    this.shadowRing.rotation.y = time * 1.5;
    const fade = THREE.MathUtils.clamp(1 - gap * 1.2, 0.35, 1);
    this.discMat.opacity = 0.32 * fade;
    this.ringMat.opacity = (0.55 + 0.3 * Math.sin(time * 6)) * fade;
    this.shadow.visible = true;
    // Guide line from the piece's underside down to the shadow.
    const len = Math.max(0, lowest - surfaceY);
    this.guide.visible = len > 0.01;
    this.guide.position.set(this.shownPos.x, surfaceY, this.shownPos.z);
    this.guide.scale.set(1, Math.max(0.001, len), 1);
    this.guideMat.opacity = 0.22 + 0.1 * Math.sin(time * 4);
    this.hoverVisibleLast = true;
  }

  /** Height of the static scenery under (x, z): cake top, stand plate, else the table. */
  private groundY(x: number, z: number): number {
    const d = Math.hypot(x, z);
    if (d <= CAKE_RADIUS) return CAKE_TOP_Y;
    if (d <= STAND_PLATE_RADIUS) return STAND_PLATE_Y;
    return 0;
  }
}
