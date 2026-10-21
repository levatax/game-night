// The cards on the table (§6, §14 "Kart çevirme"). Owner: client-cards-fx. PUBLIC API IS THE CONTRACT; fill in
// the bodies, helpers go under scene/fx/** (shared with Wheel.ts and Fx.ts).
//
// - Card faces: canvas textures (canvasTexture + fontsReady from ./toon), one per CardId, cached: cream card
//   stock, rarity-colored border (RARITIES[c.rarity].color), big icon art (draw it — simple shapes, not
//   emoji glyphs only), Turkish name (CARD_BY_ID.name, Fredoka bold), value line ("+50$", "×2", "%20 HARAÇ",
//   …) and the one-line desc. Raid card: red, police badge, "BASKIN!". Backs: dark red with a gold "K" monogram.
// - flip(): the card lifts off the deck tower (stage.anchors.deck) and flies up toward the viewer: a big "hero"
//   card in front of the reading basis (stage.readingBasis: the first-person eye's rest view, or the Masa
//   camera), a third of the screen tall, so its art, name and value read at a glance. It turns over in 0.4 s
//   slow motion (§14) with a rarity glow sized against the card (common cards barely glow; rare and above
//   get rays and shimmering edges), holds face up ~0.9 s, then settles into the active seat's row on the felt
//   (cards of the turn overlap like a fan along SeatPose.rowDir). `curseHit` → a 🧿 nazar bead pops on the
//   card and its value line is crossed out. `saved` (raid cancelled) → the raid card is torn in half while
//   it is still up in front of you.
// - Lawyer card (Avukat): stands up between the row and the deck while lawyers > 0 (setLawyers).
// - clearTurn(): all of this turn's cards slide back and vanish into the deck (≈0.6 s), or fly to a point
//   (the player's stack on KASALA) when one is given.
// - Vitrin (the row is the turn's goods): setRowValue() repaints a row card's value line ("+100$" after Kara
//   Para Aklama, a Haraç's take), sendRow() flies chosen cards off the row (KASALA picks → the stack, Pazar
//   sales → the buyer, leftovers → the kumbara, other cards → the deck) and the rest close ranks, markRow()
//   lifts and rings my Pazar choice in gold, rowCardAt() finds the row card under the pointer.
// - Deck tower: a neat stack of face-down cards at anchors.deck that subtly lowers as cards are dealt and is
//   restacked by clearTurn().
//
// Timeline of one flip (visual seconds): lift 0–0.12 → fly to the hero spot 0.12–0.4 → slow-mo turn 0.4–0.8
// (flip() resolves here: face up, readable, glowing) → hero hold until ~1.68 → drop into the row and land with
// a squash at ~2.0. A newer flip cuts the hold short (the old card drops while the new one rises), so the
// server's FLIP_ANIM_SEC lock never piles cards up. A wall-clock guard resolves the promise by 1.15 s even if
// visuals are frozen. Row cards lie on the felt turned toward the viewer (yaw fixed per turn, re-aimed while
// the view blends between first person and Masa); in first person your own row sits closer and is tilted up
// toward your eye. While a hero card is up (heroActive) it, its halo and rays draw on top of the scene (depth
// test off, high renderOrder), so the local chip stack or props never cover it; depth comes back mid-drop.

import * as THREE from "three";
import { CARD_BY_ID, PALETTE, RARITIES, type CardId, type Rarity } from "../../../shared/constants";
import type { CardMsg } from "../../../shared/protocol";
import { settings } from "../app/settings";
import { money } from "../app/ui";
import { TABLE_TOP_Y, type SeatPose, type Stage } from "./Stage";
import { addOutlines, fontsReady, toonRamp } from "./toon";
import { backTexture, cardTextures, deckEdgeTexture, faceTexture, valueText, warmCardTextures } from "./fx/cardArt";
import { SPARK_DOT, SPARK_GLOW, SPARK_STAR, Sparks } from "./fx/Sparks";
import { cardGlowTexture, glowTexture, nazarTexture, raysTexture, shadowTexture } from "./fx/textures";
import {
  TAU,
  clamp,
  clamp01,
  damp,
  dampAngle,
  easeInOutCubic,
  easeInOutSine,
  easeInQuad,
  easeOutBack,
  easeOutCubic,
  easeOutElastic,
  easeOutQuad,
  pick,
  rand,
} from "./fx/util";

/** Card size on the table (m). */
export const CARD_W = 0.17;
export const CARD_H = 0.24;

const T_LIFT = 0.12;
const T_ARC = 0.4;
const T_TURN = 0.8;
/** Face-up hero time before the card settles into the row (cut short by the next flip). */
const HERO_HOLD = 0.88;
/** A raid card that lands is shown shorter: the door sequence (camera, slam) takes over right after it. */
const RAID_HOLD = 0.42;
/** Non-hero (attract mode) hover hold. */
const HOVER_HOLD = 0.14;
const DROP_SEC = 0.34;
/** A raid card cancelled by a lawyer tears this long after it turned face up. */
const TEAR_AFTER = 0.4;
const TEAR_SEC = 0.95;
const SWEEP_SEC = 0.42;
const GUARD_MS = 1150;
/** The hero card's height as a fraction of the screen height (the distance is solved from it). */
const HERO_FRAC = 0.35;
/** World scale of the hero card. */
const HERO_SCALE = 1.6;
/** The hero spot sits this fraction of the screen height above the reading basis' center line. */
const HERO_RAISE = 0.06;
/** A hero card draws on top from this far into its flight (live.t)... */
const T_ON_TOP = T_LIFT + 0.3 * (T_ARC - T_LIFT);
/** ...until this far into its drop into the row (fraction of DROP_SEC), or of a tear (fraction of TEAR_SEC). */
const ON_TOP_DROP = 0.55;
const ON_TOP_TEAR = 0.7;
/** renderOrder bases while on top: a dropping card under the glow under the card being held up. */
const ORDER_DROP = 900;
const ORDER_GLOW = 905;
const ORDER_HELD = 910;
/** Attract-mode hover scale (the home screen keeps the small, over-the-table hover). */
const HOVER_SCALE = 1.32;
const DEFAULT_TOWER_H = 0.12;
const DEAL_DROP = 0.0045;
/** Row cards: the bottom card's lift off the felt and the step between overlapping cards (m). */
const ROW_LIFT = 0.0015;
const ROW_STEP = 0.0026;
/** First person: your own row sits at least this far out from the center and tilts up toward your eye. */
const LOCAL_ROW_R = 0.84;
const LOCAL_ROW_TILT = 0.52;
/** Cards built up front, so every card program is compiled by Stage.prewarm (more are added if ever needed). */
const PREALLOC = 14;

const RARITY_GLOW: Record<Rarity, number> = { common: 0.55, uncommon: 0.75, rare: 1.05, legendary: 1.35, trouble: 1.3 };
/** Halo strength per rarity: common cards barely glow, so a rare one stands out. */
const HALO_ALPHA: Record<Rarity, number> = { common: 0.16, uncommon: 0.3, rare: 0.55, legendary: 0.7, trouble: 0.6 };
const SHIMMER: ReadonlySet<Rarity> = new Set<Rarity>(["rare", "legendary"]);
const RAYS: ReadonlySet<Rarity> = new Set<Rarity>(["rare", "legendary", "trouble"]);

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();

// ------------------------------------------------------------------------------------- shared assets

const SHEEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SHEEN_FRAG = /* glsl */ `
uniform float uPhase;
uniform float uAlpha;
uniform vec3 uColor;
varying vec2 vUv;
float roundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  vec2 p = (vUv - 0.5) * vec2(${CARD_W.toFixed(3)}, ${CARD_H.toFixed(3)});
  if (roundBox(p, vec2(${(CARD_W / 2 - 0.005).toFixed(4)}, ${(CARD_H / 2 - 0.005).toFixed(4)}), 0.012) > 0.0) discard;
  float x = vUv.x + vUv.y * 0.55;
  float band = smoothstep(0.13, 0.0, abs(x - uPhase)) + 0.6 * smoothstep(0.04, 0.0, abs(x - uPhase - 0.2));
  float a = band * uAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

interface Geos {
  face: THREE.PlaneGeometry;
  back: THREE.PlaneGeometry;
  sheen: THREE.PlaneGeometry;
  rim: THREE.PlaneGeometry;
  shadow: THREE.PlaneGeometry;
  bead: THREE.CylinderGeometry;
  halves: [THREE.ShapeGeometry, THREE.ShapeGeometry];
}

let geos: Geos | null = null;
function sharedGeos(): Geos {
  if (geos) return geos;
  const face = new THREE.PlaneGeometry(CARD_W, CARD_H);
  face.rotateX(-Math.PI / 2);
  face.translate(0, 0.0012, 0);
  const back = new THREE.PlaneGeometry(CARD_W, CARD_H);
  back.rotateX(Math.PI / 2);
  back.rotateY(Math.PI);
  back.translate(0, -0.0012, 0);
  const sheen = new THREE.PlaneGeometry(CARD_W, CARD_H);
  sheen.rotateX(-Math.PI / 2);
  sheen.translate(0, 0.0022, 0);
  const rim = new THREE.PlaneGeometry(CARD_W * 1.6, CARD_H * 1.45);
  rim.rotateX(-Math.PI / 2);
  rim.translate(0, -0.0004, 0);
  const shadow = new THREE.PlaneGeometry(CARD_W * 1.7, CARD_H * 1.5);
  shadow.rotateX(-Math.PI / 2);
  const bead = new THREE.CylinderGeometry(0.03, 0.03, 0.012, 28);
  // A zigzag tear down the middle: two halves with UVs matching the full face.
  const zig: [number, number][] = [];
  const steps = 9;
  for (let k = 0; k <= steps; k++) {
    const y = CARD_H / 2 - (k / steps) * CARD_H;
    zig.push([(k % 2 ? 1 : -1) * 0.011, y]);
  }
  const left = new THREE.Shape();
  left.moveTo(-CARD_W / 2, CARD_H / 2);
  for (const [x, y] of zig) left.lineTo(x, y);
  left.lineTo(-CARD_W / 2, -CARD_H / 2);
  left.closePath();
  const right = new THREE.Shape();
  right.moveTo(CARD_W / 2, CARD_H / 2);
  right.lineTo(CARD_W / 2, -CARD_H / 2);
  for (let k = zig.length - 1; k >= 0; k--) right.lineTo(zig[k]![0], zig[k]![1]);
  right.closePath();
  const halves = [new THREE.ShapeGeometry(left), new THREE.ShapeGeometry(right)] as [THREE.ShapeGeometry, THREE.ShapeGeometry];
  for (const g of halves) {
    const pos = g.attributes.position!;
    const uv = g.attributes.uv!;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / CARD_W + 0.5, pos.getY(i) / CARD_H + 0.5);
    uv.needsUpdate = true;
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.0012, 0);
  }
  geos = { face, back, sheen, rim, shadow, bead, halves };
  return geos;
}

let backMat: THREE.MeshToonMaterial | null = null;
function sharedBackMat(): THREE.MeshToonMaterial {
  if (backMat) return backMat;
  const tex = backTexture();
  backMat = new THREE.MeshToonMaterial({
    map: tex,
    emissiveMap: tex,
    emissive: 0xffffff,
    emissiveIntensity: 0.45,
    alphaTest: 0.5,
    gradientMap: toonRamp(),
  });
  return backMat;
}

const FACE_EMISSIVE = 0.5;

/** One physical card: face + back planes, sheen, rim glow, nazar bead, tear halves and a fake shadow. */
class CardMesh {
  readonly root = new THREE.Group();
  readonly flipper = new THREE.Group();
  readonly face: THREE.Mesh;
  readonly back: THREE.Mesh;
  readonly faceMat: THREE.MeshToonMaterial;
  /** Per card (a clone of the shared back: same program), so one card can draw on top of the scene. */
  readonly backMat: THREE.MeshToonMaterial;
  readonly sheen: THREE.Mesh;
  readonly sheenMat: THREE.ShaderMaterial;
  readonly rim: THREE.Mesh;
  readonly rimMat: THREE.MeshBasicMaterial;
  readonly bead: THREE.Mesh;
  readonly halves: [THREE.Mesh, THREE.Mesh];
  readonly halfMat: THREE.MeshToonMaterial;
  readonly shadow: THREE.Mesh;
  readonly shadowMat: THREE.MeshBasicMaterial;
  /** renderOrder base while drawn on top of the scene, -1 = normal depth-tested drawing. */
  private onTop = -1;

  constructor(parent: THREE.Object3D) {
    const g = sharedGeos();
    this.root.add(this.flipper);
    // Built with a map already set, so the program compiled by Stage.prewarm is the one every flip uses.
    const placeholder = backTexture();
    this.faceMat = new THREE.MeshToonMaterial({
      map: placeholder,
      emissiveMap: placeholder,
      emissive: 0xffffff,
      emissiveIntensity: FACE_EMISSIVE,
      alphaTest: 0.5,
      gradientMap: toonRamp(),
    });
    this.face = new THREE.Mesh(g.face, this.faceMat);
    this.backMat = sharedBackMat().clone();
    this.back = new THREE.Mesh(g.back, this.backMat);
    this.flipper.add(this.face, this.back);

    this.sheenMat = new THREE.ShaderMaterial({
      uniforms: { uPhase: { value: -1 }, uAlpha: { value: 0 }, uColor: { value: new THREE.Color(0xffffff) } },
      vertexShader: SHEEN_VERT,
      fragmentShader: SHEEN_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.sheen = new THREE.Mesh(g.sheen, this.sheenMat);
    this.sheen.renderOrder = 4;
    this.sheen.visible = false;
    this.flipper.add(this.sheen);

    this.rimMat = new THREE.MeshBasicMaterial({
      map: cardGlowTexture(),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.rim = new THREE.Mesh(g.rim, this.rimMat);
    this.rim.renderOrder = 3;
    this.rim.visible = false;
    this.flipper.add(this.rim);

    const blue = new THREE.MeshToonMaterial({ color: "#1E46B4", gradientMap: toonRamp(), emissive: "#0A1A50" });
    const eye = new THREE.MeshToonMaterial({ map: nazarTexture(), gradientMap: toonRamp(), emissive: 0xffffff, emissiveMap: nazarTexture(), emissiveIntensity: 0.4 });
    this.bead = new THREE.Mesh(g.bead, [blue, eye, blue]);
    this.bead.position.set(CARD_W * 0.3, 0.008, -CARD_H * 0.34);
    this.bead.visible = false;
    addOutlines(this.bead, 1.08);
    this.flipper.add(this.bead);

    this.halfMat = new THREE.MeshToonMaterial({
      map: placeholder,
      emissiveMap: placeholder,
      emissive: 0xffffff,
      emissiveIntensity: FACE_EMISSIVE,
      alphaTest: 0.1,
      transparent: true,
      side: THREE.DoubleSide,
      gradientMap: toonRamp(),
    });
    this.halves = [new THREE.Mesh(g.halves[0], this.halfMat), new THREE.Mesh(g.halves[1], this.halfMat)];
    for (const h of this.halves) {
      h.visible = false;
      this.flipper.add(h);
    }

    this.shadowMat = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, opacity: 0, depthWrite: false });
    this.shadow = new THREE.Mesh(g.shadow, this.shadowMat);
    this.shadow.renderOrder = 1;
    this.shadow.visible = false;

    this.root.traverse((o) => {
      o.raycast = () => {};
    });
    this.shadow.raycast = () => {};
    this.root.visible = false;
    parent.add(this.root, this.shadow);
  }

  reset(map: THREE.Texture): void {
    this.faceMat.map = map;
    this.faceMat.emissiveMap = map;
    this.faceMat.emissiveIntensity = FACE_EMISSIVE;
    this.root.visible = true;
    this.root.scale.setScalar(1);
    this.flipper.rotation.set(0, 0, Math.PI);
    this.flipper.scale.setScalar(1);
    this.face.visible = true;
    this.back.visible = true;
    this.bead.visible = false;
    this.bead.scale.setScalar(1);
    for (const h of this.halves) {
      h.visible = false;
      if (h.parent !== this.flipper) this.flipper.add(h);
      h.position.set(0, 0, 0);
      h.rotation.set(0, 0, 0);
      h.scale.setScalar(1);
    }
    this.halfMat.opacity = 1;
    this.rimMat.opacity = 0;
    this.rim.visible = false;
    this.sheenMat.uniforms.uAlpha!.value = 0;
    this.sheen.visible = false;
    this.shadow.visible = false;
    this.setOnTop(-1);
  }

  hide(): void {
    this.root.visible = false;
    this.shadow.visible = false;
    this.setOnTop(-1);
    for (const h of this.halves) {
      h.visible = false;
      if (h.parent !== this.flipper) this.flipper.add(h);
    }
  }

  /**
   * Draw on top of the scene (`base` = renderOrder base) or normally (-1). Face and back (opaque, one of them
   * back-face culled) ignore depth but still write it, the bead follows them in the opaque pass and keeps its
   * depth test (it sits in front of the face), rim (hollow, so it only frames the face) and sheen come in the
   * transparent pass right after. Only touches the materials when the value changes.
   */
  setOnTop(base: number): void {
    if (base === this.onTop) return;
    this.onTop = base;
    const top = base >= 0;
    this.faceMat.depthTest = !top;
    this.backMat.depthTest = !top;
    this.halfMat.depthTest = !top;
    this.rimMat.depthTest = !top;
    this.sheenMat.depthTest = !top;
    this.face.renderOrder = top ? base : 0;
    this.back.renderOrder = top ? base : 0;
    for (const h of this.halves) h.renderOrder = top ? base : 0;
    this.bead.renderOrder = top ? base + 1 : 0;
    this.rim.renderOrder = top ? base + 2 : 3;
    this.sheen.renderOrder = top ? base + 3 : 4;
  }

  /** Rim and sheen are additive overdraw: only draw them while they show. */
  syncGlowVisibility(): void {
    this.rim.visible = this.rimMat.opacity > 0.01;
    this.sheen.visible = (this.sheenMat.uniforms.uAlpha!.value as number) > 0.003;
  }
}

// --------------------------------------------------------------------------------------- live state

type LiveState = "flip" | "row" | "torn" | "sweep";

interface Live {
  card: CardMesh;
  /** CardMsg.flipNo (row cards are looked up by it). */
  flipNo: number;
  id: CardId;
  rarity: Rarity;
  state: LiveState;
  t: number;
  curse: boolean;
  saved: boolean;
  raid: boolean;
  /** Big showcase toward the viewer (false in attract mode: a small hover over the table). */
  hero: boolean;
  /** My Pazar choice: lifted a little with a pulsing gold rim. */
  marked: boolean;
  color: THREE.Color;
  from: THREE.Vector3;
  /** Attract-mode hover pose (fixed at flip start). */
  hover: THREE.Vector3;
  qHover: THREE.Quaternion;
  qDeck: THREE.Quaternion;
  /** Hero roll (rad) about the line of sight: a jaunty, not-quite-straight showcase. */
  roll: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  flipAngle: number;
  scale: number;
  slotPos: THREE.Vector3;
  slotQuat: THREE.Quaternion;
  revealed: boolean;
  resolve: (() => void) | null;
  guard: number;
  /** When the hold ends and the drop into the row starts (live.t). */
  dropAt: number;
  dropping: boolean;
  dropFrom: THREE.Vector3;
  dropQ: THREE.Quaternion;
  dropScale: number;
  /** When a saved raid card tears (live.t). */
  tearAt: number;
  landT: number;
  sheenT: number;
  beadT: number;
  // sweep / tear
  delay: number;
  sweepFrom: THREE.Vector3;
  sweepQ: THREE.Quaternion;
  sweepFlip: number;
  sweepScale: number;
  /** Sweep target: null = the deck tower, else a fixed point (the player's stack). */
  sweepTo: THREE.Vector3 | null;
  tearVel: THREE.Vector3[];
  tearSpin: THREE.Vector3[];
}

interface Lawyer {
  card: CardMesh;
  t: number;
  leaving: boolean;
  /** Seconds until a dismissed lawyer actually leaves (it waits for the raid card it cancels to tear). */
  leaveIn: number;
  base: THREE.Vector3;
  phase: number;
}

function clonePose(s: SeatPose): SeatPose {
  return {
    seat: s.seat,
    chair: s.chair.clone(),
    yaw: s.yaw,
    stack: s.stack.clone(),
    cardRow: s.cardRow.clone(),
    rowDir: s.rowDir.clone().setY(0).normalize(),
    plate: s.plate.clone(),
  };
}

/** Face-up, lying flat, top of the card toward −z rotated by `yaw` about +y. */
function flatQuat(yaw: number, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromAxisAngle(UP, yaw);
}

/** Orientation whose face normal (+y local) is `normal` and whose top (−z local) points along `top`. */
function basisQuat(normal: THREE.Vector3, top: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _y.copy(normal).normalize();
  _z.copy(top).addScaledVector(_y, -top.dot(_y)).normalize().negate();
  _x.crossVectors(_y, _z).normalize();
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

// ------------------------------------------------------------------------------------------ Cards

export class Cards {
  private readonly stage: Stage;
  private readonly group = new THREE.Group();
  private readonly free: CardMesh[] = [];
  private row: Live[] = [];
  private loose: Live[] = [];
  private rowSeat: SeatPose | null = null;
  /** Yaw of this turn's row (top of the cards pointing away from the viewer), damped toward turnYawTarget. */
  private turnYaw = 0;
  private turnYawTarget = 0;
  private towerYaw = 0;
  private readonly sparks: Sparks;

  private readonly halo: THREE.Sprite;
  private readonly haloMat: THREE.SpriteMaterial;
  private readonly rays: THREE.Sprite;
  private readonly raysMat: THREE.SpriteMaterial;
  private glowCard: Live | null = null;
  private glow = 0;
  /** Halo and rays currently draw on top of the scene (with a hero card). */
  private glowOnTop = false;

  private readonly tower: THREE.Mesh;
  private towerH = DEFAULT_TOWER_H;
  private towerTarget = DEFAULT_TOWER_H;
  private towerFull = DEFAULT_TOWER_H;
  private towerVel = 0;
  private restackIn = -1;

  private lawyers: Lawyer[] = [];
  private lawyerSeat: SeatPose | null = null;

  /** Reading basis (stage.readingBasis): position, forward, and the derived up / right. */
  private readonly camPos = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3(0, 0, -1);
  private readonly camUp = new THREE.Vector3(0, 1, 0);
  private readonly camRight = new THREE.Vector3(1, 0, 0);
  /** Real camera position (for glow sizing). */
  private readonly eye = new THREE.Vector3();
  /**
   * Live camera basis for the hero showcase: in first person the camera turns toward whoever is flipping, so a
   * hero card held along the rest gaze would end up at the screen edge. The showcase follows the actual view.
   */
  private readonly viewDir = new THREE.Vector3(0, 0, -1);
  private readonly viewUp = new THREE.Vector3(0, 1, 0);
  /** First person: the local seat and how far the view has blended into it (0..1). */
  private fpSeat: number | null = null;
  private fpBlend = 0;
  /** The view was blending between Masa and first person last frame (the row follows until it settles). */
  private wasBlending = false;
  private clock = 0;
  private readonly uploads: THREE.Texture[] = [];

  constructor(stage: Stage) {
    this.stage = stage;
    this.group.name = "cards";
    stage.world.add(this.group);
    warmCardTextures();

    // deck tower: a box of card edges with a card back on top (base at y = 0, scaled to its height)
    const towerGeo = new THREE.BoxGeometry(CARD_W + 0.006, 1, CARD_H + 0.006);
    towerGeo.translate(0, 0.5, 0);
    const edge = new THREE.MeshToonMaterial({ map: deckEdgeTexture(), gradientMap: toonRamp(), emissive: "#2A1E14" });
    const top = new THREE.MeshToonMaterial({ map: backTexture(), gradientMap: toonRamp(), emissive: 0xffffff, emissiveMap: backTexture(), emissiveIntensity: 0.35 });
    this.tower = new THREE.Mesh(towerGeo, [edge, edge, top, edge, edge, edge]);
    this.tower.name = "deck-tower";
    this.tower.castShadow = true;
    this.tower.receiveShadow = true;
    addOutlines(this.tower, 1.03);
    this.tower.traverse((o) => {
      o.raycast = () => {};
    });
    this.group.add(this.tower);

    // Glow sprites. No point light: an extra light would add a term to every lit fragment for a 0.5 s glow
    // (the face's emissive boost fakes it instead).
    this.haloMat = new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.halo = new THREE.Sprite(this.haloMat);
    this.halo.renderOrder = 2;
    this.halo.visible = false;
    this.raysMat = new THREE.SpriteMaterial({ map: raysTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.rays = new THREE.Sprite(this.raysMat);
    this.rays.renderOrder = 2;
    this.rays.visible = false;
    this.halo.raycast = () => {};
    this.rays.raycast = () => {};
    this.group.add(this.halo, this.rays);

    this.sparks = new Sparks(this.group, 260, true, "card-sparks");
    // The card pool exists from the start (hidden), so Stage.prewarm compiles every card program up front.
    for (let k = 0; k < PREALLOC; k++) this.free.push(new CardMesh(this.group));
    this.readCamera();
    this.turnYaw = this.turnYawTarget = this.towerYaw = this.cameraYaw();
    this.layoutTower(0);
    // Upload the card faces to the GPU ahead of the first flip, one per frame (after the font repaint).
    void fontsReady().then(() => this.uploads.push(...cardTextures()));
  }

  /**
   * Animate one flip toward `seat`. Resolves when the card is face up and readable. `opts.hero` (default:
   * every real player; off for the home-screen attract players) shows the big showcase toward the viewer.
   */
  flip(msg: CardMsg, seat: SeatPose, opts?: { hero?: boolean }): Promise<void> {
    if (this.rowSeat && this.rowSeat.seat !== seat.seat && this.row.length > 0) this.clearTurn();
    this.readCamera();
    const firstOfTurn = !this.rowSeat || this.row.length === 0;
    if (firstOfTurn) this.turnYaw = this.turnYawTarget = this.cameraYaw();
    this.rowSeat = clonePose(seat);
    if (this.rowSeat.cardRow.y < 0.1) this.rowSeat.cardRow.y = TABLE_TOP_Y;

    // The previous card makes way: its hold ends now (it drops into the row while this one rises).
    for (const prev of this.row) {
      if (prev.state !== "flip") continue;
      if (prev.saved) prev.tearAt = Math.min(prev.tearAt, Math.max(prev.t, T_TURN));
      else prev.dropAt = Math.min(prev.dropAt, Math.max(prev.t, T_TURN));
    }

    const def = CARD_BY_ID[msg.card];
    const hero = opts?.hero ?? !msg.playerId.startsWith("attract-");
    const card = this.take();
    card.reset(faceTexture(msg.card, valueText(msg.card, msg.value), msg.curseHit));

    const from = this.deckTop(new THREE.Vector3());
    const live: Live = {
      card,
      flipNo: msg.flipNo,
      id: msg.card,
      rarity: def.rarity,
      state: "flip",
      t: 0,
      curse: msg.curseHit,
      saved: msg.saved,
      raid: def.kind === "raid",
      hero,
      marked: false,
      color: new THREE.Color(RARITIES[def.rarity].color),
      from,
      hover: new THREE.Vector3(),
      qHover: new THREE.Quaternion(),
      qDeck: flatQuat(this.towerYaw + rand(-0.12, 0.12), new THREE.Quaternion()),
      roll: rand(-0.06, 0.06),
      pos: from.clone(),
      quat: new THREE.Quaternion(),
      flipAngle: Math.PI,
      scale: 1,
      slotPos: new THREE.Vector3(),
      slotQuat: new THREE.Quaternion(),
      revealed: false,
      resolve: null,
      guard: 0,
      dropAt: T_TURN + (!hero ? HOVER_HOLD : def.kind === "raid" ? RAID_HOLD : HERO_HOLD),
      dropping: false,
      dropFrom: new THREE.Vector3(),
      dropQ: new THREE.Quaternion(),
      dropScale: 1,
      tearAt: msg.saved ? T_TURN + TEAR_AFTER : Infinity,
      landT: -1,
      sheenT: rand(0, 1),
      beadT: -1,
      delay: 0,
      sweepFrom: new THREE.Vector3(),
      sweepQ: new THREE.Quaternion(),
      sweepFlip: 0,
      sweepScale: 1,
      sweepTo: null,
      tearVel: [new THREE.Vector3(), new THREE.Vector3()],
      tearSpin: [new THREE.Vector3(), new THREE.Vector3()],
    };
    if (msg.saved) live.dropAt = Infinity;
    live.quat.copy(live.qDeck);
    this.row.push(live);
    this.syncFirstPerson();
    this.slotPose(this.row.length - 1, this.row.length, live.slotPos, live.slotQuat);

    if (!hero) {
      // Attract mode: hover above the way to the row, pulled toward the camera, face turned to the viewer.
      live.hover.lerpVectors(from, live.slotPos, 0.55);
      live.hover.y = Math.max(from.y, live.slotPos.y) + 0.36;
      _v.copy(this.eye).sub(live.hover).normalize();
      live.hover.addScaledVector(_v, 0.16);
      _v.copy(this.eye).sub(live.hover).normalize();
      _v2.copy(this.camUp).applyAxisAngle(_v, live.roll * 2);
      basisQuat(_v, _v2, live.qHover);
    }

    this.towerTarget = Math.max(this.towerFull * 0.4, this.towerTarget - DEAL_DROP);
    this.towerVel -= 0.6;
    this.restackIn = -1;
    this.glowCard = live;
    this.glow = 0;
    this.haloMat.color.copy(live.color);
    this.raysMat.color.copy(live.color);
    card.rimMat.color.copy(live.color);
    // a puff of card dust off the deck
    for (let k = 0; k < 6; k++) {
      this.sparks.spawn({ x: from.x + rand(-0.06, 0.06), y: from.y + 0.01, z: from.z + rand(-0.08, 0.08), vx: rand(-0.3, 0.3), vy: rand(0.1, 0.4), vz: rand(-0.3, 0.3), size: rand(0.02, 0.04), life: rand(0.3, 0.55), color: "#FFE9C0", alpha: 0.6, frame: SPARK_DOT, drag: 3 });
    }

    return new Promise<void>((resolve) => {
      live.resolve = resolve;
      live.guard = window.setTimeout(() => this.settle(live), GUARD_MS);
    });
  }

  /** Where the card being flipped is right now (false when no card is in the air). */
  focusPoint(out: THREE.Vector3): boolean {
    for (let i = this.row.length - 1; i >= 0; i--) {
      const live = this.row[i]!;
      if (live.state !== "flip") continue;
      out.copy(live.pos);
      return true;
    }
    return false;
  }

  /** True while a flipped card is held up big near the viewer (hero reveal, or a saved raid card tearing). */
  get heroActive(): boolean {
    for (const live of this.row) if (this.heroOrder(live) >= 0) return true;
    for (const live of this.loose) if (this.heroOrder(live) >= 0) return true;
    return false;
  }

  /** Center of this turn's row on the felt (false when the row is empty). Where the turn's money "lies". */
  rowCenter(out: THREE.Vector3): boolean {
    const n = this.row.length;
    if (!this.rowSeat || n === 0) return false;
    out.set(0, 0, 0);
    for (const live of this.row) out.add(live.slotPos);
    out.multiplyScalar(1 / n);
    out.y = TABLE_TOP_Y + 0.02;
    return true;
  }

  /** Repaint a row card's value line ("+100$"); no-op when it already says that or the card is gone. */
  setRowValue(flipNo: number, value: number): void {
    const live = this.row.find((l) => l.flipNo === flipNo);
    if (!live || live.curse) return;
    const map = faceTexture(live.id, money(value, true));
    const c = live.card;
    if (c.faceMat.map === map) return;
    c.faceMat.map = map;
    c.faceMat.emissiveMap = map;
    c.faceMat.needsUpdate = true;
    c.faceMat.emissiveIntensity = FACE_EMISSIVE + 0.35;
  }

  /**
   * Fly these row cards away (staggered): to `to` (a stack, the kumbara; they shrink into it with a sparkle) or
   * back into the deck (null). The cards left in the row close ranks.
   */
  sendRow(flipNos: readonly number[], to: THREE.Vector3 | null): void {
    const going = this.row.filter((l) => flipNos.includes(l.flipNo));
    if (!going.length) return;
    this.row = this.row.filter((l) => !going.includes(l));
    const stagger = going.length > 1 ? Math.min(0.08, 0.3 / (going.length - 1)) : 0;
    const target = to ? to.clone() : null;
    going.forEach((live, k) => {
      live.marked = false;
      this.settle(live);
      this.startSweep(live, k * stagger, target);
    });
    if (this.glowCard && going.includes(this.glowCard)) this.glowCard = null;
    if (!target) this.restackIn = 0.35 + going.length * stagger;
    if (this.row.length === 0) this.rowSeat = null;
  }

  /** Row cards (flip numbers) still lying in the row. */
  rowFlips(): number[] {
    return this.row.map((l) => l.flipNo);
  }

  /** My Pazar choice (null = none): it rises a little and its rim pulses gold. */
  markRow(flipNo: number | null): void {
    for (const live of this.row) {
      const marked = live.flipNo === flipNo;
      if (live.marked && !marked) live.card.rimMat.color.copy(live.color);
      live.marked = marked;
    }
  }

  /** Where a row card lies (false when it isn't in the row). */
  rowPoint(flipNo: number, out: THREE.Vector3): boolean {
    const live = this.row.find((l) => l.flipNo === flipNo);
    if (!live) return false;
    out.copy(live.pos);
    return true;
  }

  /** The row card under a screen point (client px), among `among` flip numbers; null = none close enough. */
  rowCardAt(clientX: number, clientY: number, among: readonly number[]): number | null {
    const cam = this.stage.camera;
    const rect = this.stage.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const toPx = (v: THREE.Vector3, out: THREE.Vector2) => {
      _v4.copy(v).project(cam);
      return out.set(rect.left + ((_v4.x + 1) / 2) * rect.width, rect.top + ((1 - _v4.y) / 2) * rect.height);
    };
    const a = new THREE.Vector2();
    const b = new THREE.Vector2();
    let best: number | null = null;
    let bestD = Infinity;
    for (const live of this.row) {
      if (!among.includes(live.flipNo) || live.state !== "row") continue;
      toPx(live.pos, a);
      // half the card's screen height is the hit radius
      _v3.copy(live.pos).addScaledVector(this.camUp, (CARD_H / 2) * live.scale);
      const r = Math.max(18, toPx(_v3, b).distanceTo(a));
      const d = Math.hypot(clientX - a.x, clientY - a.y);
      if (d < r * 1.15 && d < bestD) {
        bestD = d;
        best = live.flipNo;
      }
    }
    return best;
  }

  /** Standing lawyer cards in front of `seat` (count 0 / seat null = none). */
  setLawyers(seat: SeatPose | null, count: number): void {
    const n = seat ? Math.max(0, Math.min(4, Math.floor(count))) : 0;
    const moved =
      !seat ||
      !this.lawyerSeat ||
      this.lawyerSeat.seat !== seat.seat ||
      this.lawyerSeat.cardRow.distanceToSquared(seat.cardRow) > 1e-4;
    const staying = this.lawyers.filter((l) => !l.leaving);
    if (moved) {
      for (const l of staying) this.dismissLawyer(l, 0);
      this.lawyerSeat = seat ? clonePose(seat) : null;
      if (this.lawyerSeat && this.lawyerSeat.cardRow.y < 0.1) this.lawyerSeat.cardRow.y = TABLE_TOP_Y;
    } else if (staying.length > n) {
      // A lawyer used up by a cancelled raid stays until that raid card tears, so you see it act.
      const wait = this.pendingTear();
      for (let k = staying.length - 1; k >= n; k--) this.dismissLawyer(staying[k]!, wait);
    }
    if (!this.lawyerSeat || n === 0) return;
    const have = this.lawyers.filter((l) => !l.leaving).length;
    for (let k = have; k < n; k++) {
      const card = this.take();
      card.reset(faceTexture("avukat", valueText("avukat", 0)));
      card.flipper.rotation.z = 0;
      const base = this.lawyerBase(k, n, new THREE.Vector3());
      this.lawyers.push({ card, t: 0, leaving: false, leaveIn: 0, base, phase: rand(0, TAU) });
      for (let s = 0; s < 10; s++) {
        this.sparks.spawn({ x: base.x + rand(-0.06, 0.06), y: base.y + rand(0.02, 0.2), z: base.z + rand(-0.06, 0.06), vy: rand(0.2, 0.6), size: rand(0.03, 0.06), life: rand(0.4, 0.8), color: pick(["#7CC4FF", PALETTE.gold, "#FFFFFF"]), frame: SPARK_STAR, spin: rand(-5, 5), drag: 2 });
      }
    }
  }

  /**
   * End of turn: sweep the turn's cards back into the deck, or toward `to` (e.g. the player's stack on
   * KASALA: the turn's cards turn into money on the way).
   */
  clearTurn(to?: THREE.Vector3): void {
    const all = this.row;
    this.row = [];
    this.rowSeat = null;
    const stagger = all.length > 1 ? Math.min(0.05, 0.22 / (all.length - 1)) : 0;
    const target = to ? to.clone() : null;
    all.forEach((live, k) => {
      this.settle(live);
      this.startSweep(live, k * stagger, target);
    });
    if (this.glowCard && all.includes(this.glowCard)) this.glowCard = null;
    if (!target || all.length === 0) this.restackIn = 0.35 + all.length * stagger;
    else this.restackIn = 0.2;
  }

  update(dt: number, time: number): void {
    void time;
    this.clock += dt;
    this.readCamera();
    this.syncFirstPerson();
    this.turnYaw = dampAngle(this.turnYaw, this.turnYawTarget, 4, dt);
    this.layoutTower(dt);

    const n = this.row.length;
    for (let i = 0; i < n; i++) {
      const live = this.row[i]!;
      this.slotPose(i, n, live.slotPos, live.slotQuat);
    }
    for (let i = this.row.length - 1; i >= 0; i--) this.step(this.row[i]!, dt);
    for (let i = this.loose.length - 1; i >= 0; i--) {
      const live = this.loose[i]!;
      if (!this.step(live, dt)) {
        this.loose.splice(i, 1);
        live.card.hide();
        this.free.push(live.card);
      }
    }
    this.updateGlow(dt);
    this.updateLawyers(dt);
    this.sparks.update(dt, this.stage.renderer, this.stage.camera);
    const tex = this.uploads.pop();
    if (tex) this.stage.renderer.initTexture(tex);
  }

  // --------------------------------------------------------------------------------- animation steps

  /** Advances one card; returns false when a loose card is done and can be recycled. */
  private step(live: Live, dt: number): boolean {
    live.t += dt;
    switch (live.state) {
      case "flip":
        this.stepFlip(live);
        break;
      case "row":
        this.stepRow(live, dt);
        break;
      case "torn":
        if (!this.stepTorn(live, dt)) return false;
        break;
      case "sweep":
        if (!this.stepSweep(live)) return false;
        break;
    }
    live.card.setOnTop(this.heroOrder(live));
    if (live.state !== "torn") this.apply(live, dt);
    return true;
  }

  /**
   * renderOrder base while `live` is a hero card up in front of the viewer (drawn on top of the scene), else
   * -1: from early in its flight, through the hold, until about half way down into the row (or through most
   * of a tear). A card already dropping sorts under the next one rising.
   */
  private heroOrder(live: Live): number {
    if (!live.hero) return -1;
    if (live.state === "torn") return live.t < TEAR_SEC * ON_TOP_TEAR ? ORDER_HELD : -1;
    if (live.state !== "flip" || live.t < T_ON_TOP) return -1;
    if (!live.dropping) return ORDER_HELD;
    return live.t - live.dropAt < DROP_SEC * ON_TOP_DROP ? ORDER_DROP : -1;
  }

  /** Pose of the showcase: in front of the reading basis, `HERO_FRAC` of the screen tall, facing the eye. */
  private heroPose(live: Live, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    if (!live.hero) {
      outPos.copy(live.hover);
      outQuat.copy(live.qHover);
      return;
    }
    const worldH = CARD_H * HERO_SCALE;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.stage.camera.fov) * 0.5);
    const dist = clamp(worldH / (2 * HERO_FRAC * tanHalf), 0.6, 1.8);
    // a little above the center line: clear of the hands, the chips and the action bar at the bottom
    outPos.copy(this.eye).addScaledVector(this.viewDir, dist).addScaledVector(this.viewUp, 2 * dist * tanHalf * HERO_RAISE);
    // never sink into the felt (a first-person eye looks down at the table)
    const minY = TABLE_TOP_Y + 0.05 + Math.abs(this.viewUp.y) * worldH * 0.5;
    if (outPos.y < minY) outPos.y = minY;
    _v4.copy(this.eye).sub(outPos).normalize();
    _v3.copy(this.viewUp).applyAxisAngle(_v4, live.roll);
    basisQuat(_v4, _v3, outQuat);
  }

  private stepFlip(live: Live): void {
    const t = live.t;
    const peak = live.hero ? HERO_SCALE : HOVER_SCALE;
    if (live.dropping || t >= live.dropAt) {
      this.stepDrop(live);
      return;
    }
    if (t >= live.tearAt) {
      this.tear(live);
      return;
    }
    const lift = _v.copy(live.from).addScaledVector(UP, 0.15);
    if (t < T_LIFT) {
      const u = t / T_LIFT;
      live.pos.copy(live.from).addScaledVector(UP, 0.15 * easeOutBack(u, 2.2));
      live.quat.copy(live.qDeck);
      live.flipAngle = Math.PI - u * 0.25;
      live.scale = 1 + Math.sin(u * Math.PI) * 0.08;
      return;
    }
    this.heroPose(live, _v2, _q);
    if (t < T_ARC) {
      const u = easeOutCubic((t - T_LIFT) / (T_ARC - T_LIFT));
      // quadratic arc lift → showcase, apex above the midpoint
      _v3.lerpVectors(lift, _v2, 0.5).addScaledVector(UP, live.hero ? 0.22 : 0.14);
      bezier(lift, _v3, _v2, u, live.pos);
      live.quat.slerpQuaternions(live.qDeck, _q, easeInOutCubic(u));
      live.flipAngle = Math.PI - 0.25 + 0.1 * u;
      live.scale = 1 + (peak * 0.85 - 1) * u;
      return;
    }
    // the 0.4 s slow-motion turn (§14), then the hold with a gentle breathing bob
    const u = clamp01((t - T_ARC) / (T_TURN - T_ARC));
    live.pos.copy(_v2).addScaledVector(this.camUp, Math.sin(t * 3.2) * 0.004 * peak);
    live.quat.copy(_q);
    live.flipAngle = (Math.PI - 0.15) * (1 - easeInOutSine(u));
    const pop = u >= 1 ? Math.exp(-(t - T_TURN) * 12) * Math.sin(Math.min(1, (t - T_TURN) * 8) * Math.PI) * 0.08 : 0;
    live.scale = peak * (0.85 + 0.15 * easeOutQuad(u)) * (1 + pop);
    if (u >= 1 && !live.revealed) this.reveal(live);
  }

  /** Hold over: settle from wherever the card is into its row slot. */
  private stepDrop(live: Live): void {
    if (!live.dropping) {
      if (!live.revealed) this.reveal(live);
      live.dropping = true;
      live.dropAt = live.t;
      live.dropFrom.copy(live.pos);
      live.dropQ.copy(live.quat);
      live.dropScale = live.scale;
      live.flipAngle = 0;
    }
    const u = clamp01((live.t - live.dropAt) / DROP_SEC);
    const e = easeInOutCubic(u);
    _v3.lerpVectors(live.dropFrom, live.slotPos, 0.5).addScaledVector(UP, live.raid ? 0.04 : 0.1);
    bezier(live.dropFrom, _v3, live.slotPos, easeInQuad(u) * 0.35 + e * 0.65, live.pos);
    live.quat.slerpQuaternions(live.dropQ, live.slotQuat, e);
    live.flipAngle = 0;
    live.scale = live.dropScale + (1 - live.dropScale) * e;
    if (u >= 1) this.land(live);
  }

  private stepRow(live: Live, dt: number): void {
    live.pos.x = damp(live.pos.x, live.slotPos.x, 14, dt);
    live.pos.y = damp(live.pos.y, live.slotPos.y + (live.marked ? 0.035 : 0), 14, dt);
    live.pos.z = damp(live.pos.z, live.slotPos.z, 14, dt);
    live.quat.slerp(live.slotQuat, 1 - Math.exp(-12 * dt));
    live.flipAngle = 0;
    live.scale = 1;
  }

  private stepTorn(live: Live, dt: number): boolean {
    const t = live.t;
    const k = clamp01(t / TEAR_SEC);
    const c = live.card;
    // gravity is world-down, expressed in the flipper's frame (the card may be facing the viewer)
    _q.copy(c.root.quaternion).multiply(c.flipper.quaternion).invert();
    _v.set(0, (-3.2 * dt) / Math.max(0.2, live.scale), 0).applyQuaternion(_q);
    for (let i = 0; i < 2; i++) {
      const h = c.halves[i]!;
      const v = live.tearVel[i]!;
      const w = live.tearSpin[i]!;
      v.add(_v);
      h.position.addScaledVector(v, dt);
      h.rotation.x += w.x * dt;
      h.rotation.y += w.y * dt;
      h.rotation.z += w.z * dt;
      h.scale.setScalar(1 - easeInQuad(k) * 0.6);
    }
    c.halfMat.opacity = 1 - easeInQuad(k);
    return k < 1;
  }

  private stepSweep(live: Live): boolean {
    if (live.t < live.delay) return true;
    const u = clamp01((live.t - live.delay) / SWEEP_SEC);
    const e = easeInOutCubic(u);
    const to = live.sweepTo ? _v3.copy(live.sweepTo) : this.deckTop(_v3);
    _v2.lerpVectors(live.sweepFrom, to, 0.5).addScaledVector(UP, live.sweepTo ? 0.12 : 0.2);
    bezier(live.sweepFrom, _v2, to, e, live.pos);
    flatQuat(this.towerYaw, _q);
    live.quat.slerpQuaternions(live.sweepQ, _q, e);
    live.flipAngle = live.sweepFlip + (Math.PI - live.sweepFlip) * e;
    const end = live.sweepTo ? 0.3 : 0.55;
    live.scale = live.sweepScale + (end - live.sweepScale) * e;
    if (u >= 1) {
      if (live.sweepTo) {
        const p = live.sweepTo;
        for (let k = 0; k < 4; k++) {
          this.sparks.spawn({ x: p.x, y: p.y + 0.02, z: p.z, vx: rand(-0.4, 0.4), vy: rand(0.3, 0.8), vz: rand(-0.4, 0.4), size: rand(0.025, 0.05), sizeEnd: 0.005, life: rand(0.3, 0.55), color: pick([PALETTE.gold, PALETTE.money, "#FFFFFF"]), frame: SPARK_STAR, gravity: 1.5, drag: 2 });
        }
      } else this.towerVel += 0.25;
      return false;
    }
    return true;
  }

  private apply(live: Live, dt: number): void {
    const c = live.card;
    c.root.position.copy(live.pos);
    c.root.quaternion.copy(live.quat);
    c.root.scale.setScalar(live.scale);
    c.flipper.rotation.z = live.flipAngle;
    // landing squash & stretch
    if (live.landT >= 0) {
      const lt = live.t - live.landT;
      const amp = live.raid ? 0.32 : 0.2;
      const s = amp * Math.exp(-lt * 9) * Math.cos(lt * 30);
      c.flipper.scale.set(1 + s, 1, 1 + s * 0.7);
      if (lt > 0.8) {
        c.flipper.scale.set(1, 1, 1);
        live.landT = -1;
      }
    }
    // nazar bead pop
    if (live.beadT >= 0) {
      const bt = live.t - live.beadT;
      c.bead.scale.setScalar(Math.max(0.001, easeOutElastic(clamp01(bt / 0.7))) * 1.15);
      c.bead.rotation.y = Math.sin(bt * 3) * 0.3;
    }
    // shimmer for rare+ (sweeps every couple of seconds); every other rim fades out once the card lies down
    if (live.state === "sweep") {
      c.sheenMat.uniforms.uAlpha!.value = 0;
      c.rimMat.opacity = Math.max(0, c.rimMat.opacity - dt * 4);
    } else if (live.marked && live.state === "row") {
      c.rimMat.color.set(PALETTE.gold);
      c.rimMat.opacity = 0.55 + 0.25 * Math.sin(this.clock * 6);
    } else if (live.revealed && SHIMMER.has(live.rarity)) {
      live.sheenT += dt;
      const cyc = live.sheenT % 2.4;
      c.sheenMat.uniforms.uPhase!.value = -0.35 + cyc * 1.25;
      c.sheenMat.uniforms.uAlpha!.value = live.rarity === "legendary" ? 0.9 : 0.7;
      if (live.state === "row") {
        const want = 0.1 + 0.05 * Math.sin(this.clock * 3 + live.sheenT);
        c.rimMat.opacity = c.rimMat.opacity > want ? Math.max(want, c.rimMat.opacity - dt * 2) : want;
      }
    } else if (live.state === "row") {
      c.rimMat.opacity = Math.max(0, c.rimMat.opacity - dt * 3);
    }
    if (live.state === "row" && c.faceMat.emissiveIntensity > FACE_EMISSIVE) {
      c.faceMat.emissiveIntensity = Math.max(FACE_EMISSIVE, c.faceMat.emissiveIntensity - dt * 1.5);
    }
    c.syncGlowVisibility();
    // fake contact shadow: under the card while it flies, a faint one once it lies in the row
    const h = Math.max(0, live.pos.y - TABLE_TOP_Y);
    c.shadow.visible = true;
    c.shadow.position.set(live.pos.x, TABLE_TOP_Y + 0.001, live.pos.z);
    c.shadow.rotation.y = live.state === "row" ? this.turnYaw : this.towerYaw;
    if (live.state === "row") {
      c.shadow.scale.setScalar(0.92);
      c.shadowMat.opacity = 0.2;
    } else {
      c.shadow.scale.setScalar(Math.min(1.6, live.scale) * (1 + h * 1.2));
      c.shadowMat.opacity = 0.5 * clamp01(1 - h / 0.9);
      if (c.shadowMat.opacity < 0.01) c.shadow.visible = false;
    }
  }

  /** Face fully up: resolve, burst, glow peak. */
  private reveal(live: Live): void {
    if (live.revealed) return;
    live.revealed = true;
    this.settle(live);
    const reduced = settings.get().reducedFlashing;
    const p = live.pos;
    const boost = RARITY_GLOW[live.rarity];
    const n = Math.round((reduced ? 8 : 14) + boost * (live.hero ? 14 : 18));
    const colors = [RARITIES[live.rarity].color, "#FFFFFF", live.raid ? "#2F6BFF" : PALETTE.gold];
    // Burst out in the card's plane (as seen by the viewer), so nothing flies into a first-person eye.
    const sc = live.scale;
    for (let k = 0; k < n; k++) {
      const a = rand(0, TAU);
      const sp = rand(0.35, 1.1) * boost * (live.hero ? 0.8 : 1);
      _v.copy(this.camRight).multiplyScalar(Math.cos(a)).addScaledVector(this.camUp, Math.sin(a) * 0.85 + 0.2);
      if (!live.hero) _v.y += 0.3;
      const ox = Math.cos(a) * CARD_W * 0.5 * sc;
      const oy = Math.sin(a) * CARD_H * 0.5 * sc;
      this.sparks.spawn({
        x: p.x + this.camRight.x * ox + this.camUp.x * oy,
        y: p.y + this.camRight.y * ox + this.camUp.y * oy,
        z: p.z + this.camRight.z * ox + this.camUp.z * oy,
        vx: _v.x * sp,
        vy: _v.y * sp,
        vz: _v.z * sp,
        size: rand(0.02, 0.05),
        sizeEnd: 0.005,
        life: rand(0.45, 0.85),
        color: pick(colors),
        frame: SPARK_STAR,
        gravity: 0.8,
        drag: 2.4,
        spin: rand(-8, 8),
      });
    }
    if (live.curse) {
      live.beadT = live.t;
      live.card.bead.visible = true;
      live.card.bead.scale.setScalar(0.001);
      for (let k = 0; k < 16; k++) {
        this.sparks.spawn({ x: p.x, y: p.y, z: p.z, vx: rand(-0.5, 0.5), vy: rand(0, 0.6), vz: rand(-0.5, 0.5), size: rand(0.03, 0.06), sizeEnd: 0.01, life: rand(0.5, 1), color: pick(["#B05CFF", "#5FC0FF", "#1E46B4"]), frame: SPARK_GLOW, drag: 2 });
      }
    }
    if (SHIMMER.has(live.rarity)) live.sheenT = 0;
  }

  private land(live: Live): void {
    live.state = "row";
    live.dropping = false;
    live.landT = live.t;
    live.pos.copy(live.slotPos);
    live.quat.copy(live.slotQuat);
    live.scale = 1;
    const p = live.slotPos;
    const n = live.raid ? 22 : 9;
    for (let k = 0; k < n; k++) {
      const a = rand(0, TAU);
      const sp = rand(0.25, live.raid ? 1.1 : 0.6);
      this.sparks.spawn({ x: p.x + Math.cos(a) * 0.08, y: p.y + 0.01, z: p.z + Math.sin(a) * 0.08, vx: Math.cos(a) * sp, vy: rand(0.1, 0.5), vz: Math.sin(a) * sp, size: rand(0.02, 0.045), life: rand(0.3, 0.6), color: live.raid ? pick(["#E5383B", "#FFB0B0"]) : "#FFF1D0", alpha: 0.7, frame: SPARK_DOT, drag: 4, gravity: 1 });
    }
  }

  /** Raid cancelled by a lawyer: the card rips in two and the halves tumble away. */
  private tear(live: Live): void {
    if (!live.revealed) this.reveal(live);
    const idx = this.row.indexOf(live);
    if (idx >= 0) this.row.splice(idx, 1);
    this.loose.push(live);
    if (this.glowCard === live) this.glowCard = null;
    live.state = "torn";
    live.t = 0;
    const c = live.card;
    this.apply(live, 0);
    c.halfMat.map = c.faceMat.map;
    c.halfMat.emissiveMap = c.faceMat.map;
    c.halfMat.opacity = 1;
    c.face.visible = false;
    c.back.visible = false;
    c.rimMat.opacity = 0;
    c.sheenMat.uniforms.uAlpha!.value = 0;
    c.syncGlowVisibility();
    c.shadow.visible = false;
    for (let i = 0; i < 2; i++) {
      const h = c.halves[i]!;
      h.visible = true;
      h.position.set(0, 0, 0);
      h.rotation.set(0, 0, 0);
      const side = i === 0 ? -1 : 1;
      // velocities in the card's flipper frame: apart along x, a little off the face (+y), down the card (+z)
      live.tearVel[i]!.set(side * rand(0.35, 0.5), rand(0.05, 0.15), rand(0.05, 0.2));
      live.tearSpin[i]!.set(rand(-2, 2), rand(-1, 1), side * rand(2.5, 4));
    }
    const p = live.pos;
    for (let k = 0; k < 24; k++) {
      const a = rand(0, TAU);
      const sp = rand(0.3, 0.9);
      _v.copy(this.camRight).multiplyScalar(Math.cos(a) * sp).addScaledVector(this.camUp, Math.sin(a) * sp + 0.2);
      this.sparks.spawn({ x: p.x, y: p.y, z: p.z, vx: _v.x, vy: _v.y, vz: _v.z, size: rand(0.02, 0.045), sizeEnd: 0.005, life: rand(0.4, 0.8), color: pick(["#E5383B", "#FFF4DF", "#7CC4FF"]), frame: k % 3 ? SPARK_DOT : SPARK_STAR, gravity: 2, drag: 1.5, spin: rand(-6, 6) });
    }
    // the lawyer that did it leaves now
    for (const l of this.lawyers) if (l.leaving && l.leaveIn > 0.05) l.leaveIn = 0.05;
  }

  private startSweep(live: Live, delay: number, to: THREE.Vector3 | null): void {
    if (live.state === "torn") return;
    live.state = "sweep";
    live.t = 0;
    live.delay = delay;
    live.landT = -1;
    live.dropping = false;
    live.sweepTo = to;
    live.sweepFrom.copy(live.pos);
    live.sweepQ.copy(live.quat);
    live.sweepFlip = live.flipAngle;
    live.sweepScale = live.scale;
    live.card.flipper.scale.set(1, 1, 1);
    this.loose.push(live);
  }

  /** Resolve a flip's promise once (reveal, guard timer, sweep or tear). */
  private settle(live: Live): void {
    if (live.guard) {
      window.clearTimeout(live.guard);
      live.guard = 0;
    }
    const r = live.resolve;
    live.resolve = null;
    r?.();
  }

  /** A card from the pool (a new one only if the pool ran dry). */
  private take(): CardMesh {
    return this.free.pop() ?? new CardMesh(this.group);
  }

  // ------------------------------------------------------------------------------------ glow + halo

  private updateGlow(dt: number): void {
    const live = this.glowCard;
    let target = 0;
    if (live && (live.state === "flip" || live.state === "row")) {
      const t = live.t;
      if (live.state === "flip") {
        if (t < T_ARC) target = 0.12 * clamp01(t / T_ARC);
        else if (t < T_TURN) target = 0.15 + 0.85 * easeInOutSine((t - T_ARC) / (T_TURN - T_ARC));
        else if (!live.dropping) target = 0.75 + 0.5 * Math.exp(-(t - T_TURN) * 6);
        else target = 0.75 - 0.45 * clamp01((t - live.dropAt) / DROP_SEC);
      } else {
        target = Math.max(0, 0.3 - (live.t - live.landT) * 1.2);
        if (target <= 0) this.glowCard = null;
      }
      const boost = RARITY_GLOW[live.rarity];
      // rim glow on the flying card; once it lies down, apply() fades it (shimmer cards keep a faint one)
      if (live.state === "flip") live.card.rimMat.opacity = clamp01(target * 0.6 * boost);
      // the face itself brightens with the glow (stands in for a point light)
      live.card.faceMat.emissiveIntensity = FACE_EMISSIVE + 0.3 * clamp01(target) * Math.min(1, boost);
    }
    this.glow = damp(this.glow, target, 18, dt);
    // With a hero card on top, its halo and rays must be too, and drawn before it (they sit behind the card):
    // they move into the opaque pass (additive either way: same program) between the dropping and held cards.
    this.setGlowOnTop(!!live && this.heroOrder(live) >= 0);
    const reduced = settings.get().reducedFlashing;
    const g = this.glow * (reduced ? 0.6 : 1);
    if (!live || g < 0.01) {
      this.halo.visible = false;
      this.rays.visible = false;
      this.raysMat.opacity = 0;
      return;
    }
    const p = live.pos;
    _v.copy(p).sub(this.eye);
    const dist = Math.max(0.2, _v.length());
    _v.multiplyScalar(1 / dist);
    // world height of the whole screen at the card's distance: no glow may fill it
    const screenH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.stage.camera.fov) * 0.5);
    const cardH = CARD_H * live.scale;
    this.halo.visible = true;
    this.halo.position.copy(p).addScaledVector(_v, 0.05);
    this.halo.scale.setScalar(Math.min(cardH * (1.25 + 0.5 * g), screenH * 0.55));
    this.haloMat.opacity = clamp01(g * HALO_ALPHA[live.rarity]);
    // rays (rare and up): fade by opacity, hide only once invisible
    const raysOn = RAYS.has(live.rarity) && live.state === "flip";
    const raysWant = raysOn ? clamp01((g - 0.3) * 0.7) * (reduced ? 0.5 : 1) : 0;
    this.raysMat.opacity = damp(this.raysMat.opacity, raysWant, raysOn ? 14 : 8, dt);
    this.rays.visible = this.raysMat.opacity > 0.01;
    if (this.rays.visible) {
      this.rays.position.copy(p).addScaledVector(_v, 0.07);
      this.rays.scale.setScalar(Math.min(cardH * (1.9 + 0.6 * g), screenH * 0.62));
      this.raysMat.rotation += dt * 0.9;
    }
  }

  private setGlowOnTop(on: boolean): void {
    if (on === this.glowOnTop) return;
    this.glowOnTop = on;
    for (const m of [this.haloMat, this.raysMat]) {
      m.transparent = !on;
      m.depthTest = !on;
    }
    this.halo.renderOrder = this.rays.renderOrder = on ? ORDER_GLOW : 2;
  }

  // ---------------------------------------------------------------------------------------- lawyers

  private dismissLawyer(l: Lawyer, after: number): void {
    if (l.leaving) return;
    l.leaving = true;
    l.leaveIn = Math.max(0, after);
    l.t = 0;
  }

  /** Seconds until an in-flight saved raid card tears (0 if none). */
  private pendingTear(): number {
    let wait = 0;
    for (const live of this.row) {
      if (live.state === "flip" && live.saved && Number.isFinite(live.tearAt)) wait = Math.max(wait, live.tearAt - live.t);
    }
    return wait > 0 ? Math.min(1.4, wait + 0.05) : 0;
  }

  /** Standing spot of lawyer k of n: inside the seat's area, between its card row and the deck. */
  private lawyerBase(k: number, n: number, out: THREE.Vector3): THREE.Vector3 {
    const seat = this.lawyerSeat;
    if (!seat) return out.set(0, TABLE_TOP_Y, 0);
    // UP × rowDir points from the seat toward the table center
    _v.crossVectors(UP, seat.rowDir).normalize();
    out.copy(seat.cardRow).addScaledVector(_v, 0.22).addScaledVector(seat.rowDir, (k - (n - 1) / 2) * 0.13);
    out.y = TABLE_TOP_Y;
    return out;
  }

  private updateLawyers(dt: number): void {
    let staying = 0;
    for (const l of this.lawyers) if (!l.leaving) staying++;
    let k = 0;
    for (let i = this.lawyers.length - 1; i >= 0; i--) {
      const l = this.lawyers[i]!;
      const c = l.card;
      // stand facing the viewer; tilt φ = 0 standing, π/2 lying flat (face up)
      let tilt: number;
      let scale = 1;
      let hop = 0;
      if (!l.leaving) {
        l.t += dt;
        // slide over when a neighbour comes or goes
        this.lawyerBase(staying - 1 - k++, staying, _v3);
        l.base.x = damp(l.base.x, _v3.x, 8, dt);
        l.base.z = damp(l.base.z, _v3.z, 8, dt);
        l.base.y = _v3.y;
        const u = clamp01(l.t / 0.45);
        tilt = (Math.PI / 2) * (1 - easeOutBack(u, 2));
        scale = 0.6 + 0.4 * easeOutBack(u, 1.6);
        hop = Math.max(0, Math.sin(l.t * 1.3 + l.phase)) ** 12 * 0.025;
      } else if (l.leaveIn > 0) {
        // waiting for its raid card to tear: a nervous little bounce
        l.leaveIn -= dt;
        tilt = 0;
        hop = Math.abs(Math.sin(this.clock * 14 + l.phase)) * 0.012;
      } else {
        l.t += dt;
        const u = clamp01(l.t / 0.5);
        tilt = (Math.PI / 2) * easeInQuad(Math.min(1, u * 1.6));
        scale = 1 - easeInQuad(clamp01((u - 0.5) / 0.5));
        if (l.t - dt < 0.3 && l.t >= 0.3) {
          for (let s = 0; s < 12; s++) {
            this.sparks.spawn({ x: c.root.position.x, y: c.root.position.y, z: c.root.position.z, vx: rand(-0.5, 0.5), vy: rand(0.1, 0.7), vz: rand(-0.5, 0.5), size: rand(0.03, 0.06), sizeEnd: 0.005, life: rand(0.4, 0.7), color: pick(["#7CC4FF", "#FFFFFF", PALETTE.gold]), frame: SPARK_STAR, drag: 2, spin: rand(-6, 6) });
          }
        }
        if (u >= 1) {
          c.hide();
          this.free.push(c);
          this.lawyers.splice(i, 1);
          continue;
        }
      }
      // facing: horizontal direction to the viewer
      _z.copy(this.eye).sub(l.base).setY(0);
      if (_z.lengthSq() < 1e-6) _z.set(0, 0, 1);
      _z.normalize();
      const sway = Math.sin(this.clock * 1.7 + l.phase) * 0.06;
      _z.applyAxisAngle(UP, sway);
      // normal N' = toViewer·cos φ + up·sin φ ; top = up·cos φ − toViewer·sin φ
      _v.copy(_z).multiplyScalar(Math.cos(tilt)).addScaledVector(UP, Math.sin(tilt));
      _v2.copy(UP).multiplyScalar(Math.cos(tilt)).addScaledVector(_z, -Math.sin(tilt));
      basisQuat(_v, _v2, _q2);
      c.root.quaternion.copy(_q2);
      c.root.scale.setScalar(scale);
      // pivot on the bottom edge: center = base + top·(H/2), standing on the felt
      c.root.position.copy(l.base).addScaledVector(_v2, (CARD_H / 2) * scale).addScaledVector(UP, ROW_LIFT + hop);
      c.flipper.rotation.z = 0;
      c.rimMat.color.set("#7CC4FF");
      c.rimMat.opacity = l.leaving && l.leaveIn <= 0 ? 0 : 0.26 + 0.1 * Math.sin(this.clock * 2.5 + l.phase);
      c.syncGlowVisibility();
      c.shadow.visible = false;
    }
  }

  // ----------------------------------------------------------------------------------------- layout

  /** Reading basis (first person: the eye's rest view, ignoring mouse-look; Masa: the camera). */
  private readCamera(): void {
    this.stage.readingBasis(this.camPos, this.camDir);
    if (this.camDir.lengthSq() < 1e-8) this.camDir.set(0, 0, -1);
    this.camDir.normalize();
    this.camRight.crossVectors(this.camDir, UP);
    if (this.camRight.lengthSq() < 1e-6) this.camRight.set(1, 0, 0);
    this.camRight.normalize();
    this.camUp.crossVectors(this.camRight, this.camDir).normalize();
    this.eye.setFromMatrixPosition(this.stage.camera.matrixWorld);
    this.stage.camera.getWorldDirection(this.viewDir);
    if (this.viewDir.lengthSq() < 1e-8) this.viewDir.copy(this.camDir);
    _v4.crossVectors(this.viewDir, UP);
    if (_v4.lengthSq() < 1e-6) _v4.copy(this.camRight);
    this.viewUp.crossVectors(_v4.normalize(), this.viewDir).normalize();
  }

  /**
   * First-person state for the local row (closer and tilted toward the eye). Re-aims the row on a view switch:
   * while the view blends between Masa and first person the reading basis can be the half-blended camera, so
   * the row (and the deck tower with it) keeps following it until the blend has settled, then holds.
   */
  private syncFirstPerson(): void {
    const fp = this.stage.firstPerson;
    this.fpSeat = fp.seat;
    this.fpBlend = fp.active || fp.blend > 0 ? clamp01(fp.blend) : 0;
    const blending = fp.blend > 0 && fp.blend < 1;
    if ((blending || this.wasBlending) && this.row.length > 0) this.turnYawTarget = this.cameraYaw();
    this.wasBlending = blending;
  }

  /** Yaw that turns a flat card's top away from the viewer (readable for them). */
  private cameraYaw(): number {
    const fx = this.camDir.x;
    const fz = this.camDir.z;
    if (fx * fx + fz * fz < 1e-6) return 0;
    return Math.atan2(-fx, -fz);
  }

  /** How much this turn's row is "mine in first person" (0..1). */
  private localRow(): number {
    const seat = this.rowSeat;
    return seat && this.fpSeat !== null && seat.seat === this.fpSeat ? this.fpBlend : 0;
  }

  /** Row slot i of n: position and orientation (fanned along rowDir, lying on the felt or tilted up locally). */
  private slotPose(i: number, n: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    const seat = this.rowSeat;
    if (!seat) {
      outPos.set(0, TABLE_TOP_Y + ROW_LIFT, 0);
      flatQuat(this.turnYaw, outQuat);
      return;
    }
    const local = this.localRow();
    const spacing = Math.min(0.105, 0.78 / Math.max(1, n - 1));
    const off = (i - (n - 1) / 2) * spacing;
    // base of the row; in first person your own row moves out toward you
    _v3.copy(seat.cardRow);
    const r = Math.hypot(_v3.x, _v3.z);
    if (local > 0 && r > 1e-3 && r < LOCAL_ROW_R) {
      const k = 1 + (LOCAL_ROW_R / r - 1) * local;
      _v3.x *= k;
      _v3.z *= k;
    }
    _v.crossVectors(UP, seat.rowDir).normalize();
    outPos.copy(_v3).addScaledVector(seat.rowDir, off).addScaledVector(_v, -off * off * 0.35);
    outPos.y = TABLE_TOP_Y + ROW_LIFT + i * ROW_STEP;
    const sign = seat.rowDir.dot(this.camRight) >= 0 ? 1 : -1;
    const yaw = this.turnYaw - off * sign * 0.6 * (1 - local * 0.5);
    flatQuat(yaw, outQuat);
    const tilt = LOCAL_ROW_TILT * local;
    if (tilt > 1e-3) {
      // lift the top (far) edge toward the eye, pivoting on the near edge that stays on the felt
      _q2.setFromAxisAngle(X_AXIS, tilt);
      _v2.set(0, (CARD_H / 2) * Math.sin(tilt), (CARD_H / 2) * (1 - Math.cos(tilt))).applyQuaternion(outQuat);
      outPos.add(_v2);
      outQuat.multiply(_q2);
    }
  }

  /** Current top of the deck tower (where cards are dealt from). */
  private deckTop(out: THREE.Vector3): THREE.Vector3 {
    const d = this.stage.anchors.deck;
    const baseY = this.towerBaseY();
    return out.set(d.x, baseY + this.towerH + 0.002, d.z);
  }

  private towerBaseY(): number {
    const d = this.stage.anchors.deck;
    if (d.y > TABLE_TOP_Y + 0.02) return d.y - this.towerFull;
    return TABLE_TOP_Y;
  }

  private layoutTower(dt: number): void {
    const d = this.stage.anchors.deck;
    const full = d.y > TABLE_TOP_Y + 0.03 ? Math.min(0.3, d.y - TABLE_TOP_Y) : DEFAULT_TOWER_H;
    if (Math.abs(full - this.towerFull) > 1e-4) {
      this.towerTarget = this.towerTarget === this.towerFull ? full : Math.min(this.towerTarget, full);
      this.towerFull = full;
    }
    if (this.restackIn >= 0) {
      this.restackIn -= dt;
      if (this.restackIn < 0) {
        this.towerTarget = this.towerFull;
        this.towerVel += 0.9;
      }
    }
    // springy height so dealing / restacking bounces a little
    if (dt > 0) {
      const acc = (this.towerTarget - this.towerH) * 260 - this.towerVel * 16;
      this.towerVel += acc * dt;
      this.towerH += this.towerVel * dt * 0.05;
      this.towerH = Math.max(0.01, this.towerH);
    }
    const squash = 1 - (this.towerH - this.towerTarget) * 1.5;
    this.tower.position.set(d.x, this.towerBaseY(), d.z);
    this.tower.scale.set(Math.max(0.9, Math.min(1.1, squash)), this.towerH, Math.max(0.9, Math.min(1.1, squash)));
    // turn smoothly toward this turn's viewer instead of snapping on the first deal
    this.towerYaw = dampAngle(this.towerYaw, this.turnYaw, 3, dt);
    this.tower.rotation.y = this.towerYaw;
  }
}

function bezier(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  const u = 1 - t;
  out.set(
    u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  );
  return out;
}
