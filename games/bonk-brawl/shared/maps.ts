// Arena data for Bonk Brawl. FROZEN CONTRACT (see docs/ARCHITECTURE.md, TECH_BRIEF §5).
//
// Pure data + trivial helpers. Coordinates: meters, Y up, floor top at y = 0, island centered
// on the origin. Yaw 0 faces -Z. Everything gameplay-relevant (rings, cover, pedestals, spawns,
// friction) is consumed by shared/sim and the server; `theme` and `decor` are renderer-only.
//
// Layout rules every arena follows:
// - ringRadii ascending; ring i covers shapeDistance in (ringRadii[i-1], ringRadii[i]]; ring 0 is the
//   inner disc (0, ringRadii[0]] and NEVER falls. The last radius is the island edge.
// - All cover footprints lie fully inside ring 0, so cover never falls.
// - Pedestals sit in ring 1, spawns in the outer rings on the 4 diagonals, facing the center.

import { DEFAULT_MAP, MAP_IDS } from "./constants.js";
import type { MapId } from "./types.js";

/* ================================================================= types */

export type ArenaShape = "circle" | "roundedSquare";

export type CoverKind =
  | "picnicTable"
  | "watermelon"
  | "basket"
  | "rubberDuck"
  | "soapBar"
  | "shampooBottle"
  | "candle"
  | "strawberry";

interface CoverBase {
  /** Renderer model to build for this cover piece. */
  kind: CoverKind;
  /** Footprint center. */
  x: number;
  z: number;
  /** Top surface height above the floor (players can stand on it; balls bounce off it). */
  height: number;
  /** Yaw rotation of the footprint (radians, same convention as player yaw). Ignored for cylinders. */
  rotation: number;
}

/** Vertical cylinder from y = 0 to y = height. */
export interface CoverCylinder extends CoverBase {
  shape: "cylinder";
  radius: number;
}

/** Oriented box from y = 0 to y = height; halfX/halfZ in its local (rotated) frame. */
export interface CoverBox extends CoverBase {
  shape: "box";
  halfX: number;
  halfZ: number;
}

export type CoverDef = CoverCylinder | CoverBox;

export interface Pedestal {
  x: number;
  z: number;
}

export interface SpawnPoint {
  x: number;
  z: number;
  /** Faces the island center: yaw = atan2(x, z). */
  yaw: number;
}

/** Ground handling. Bath Time is slippery (lower accel/decel → more momentum). */
export interface FrictionProfile {
  /** Player acceleration toward wish velocity on the ground (m/s²). */
  groundAccel: number;
  /** Player deceleration with no input on the ground (m/s²). */
  groundDecel: number;
  /** Ball rolling deceleration (m/s²). */
  ballRollDecel: number;
  /** Fraction of tangential ball velocity kept on a floor bounce. */
  ballBounceFriction: number;
}

export type FloorKind = "grass" | "tile" | "frosting";
/** What is visible below the island. */
export type VoidKind = "clouds" | "drainWater" | "duskSky";
/** Ambient particle flavor. */
export type AmbientKind = "butterflies" | "bubbles" | "balloons";
/** What ring segments turn into when they crumble. */
export type CrumbleKind = "dirt" | "tiles" | "crumbs";

export type DecorKind =
  | "tree"
  | "bush"
  | "flower"
  | "blanket"
  | "ants"
  | "faucet"
  | "bubbles"
  | "towel"
  | "sprinkles"
  | "balloon"
  | "cherry";

export interface DecorItem {
  kind: DecorKind;
  x: number;
  z: number;
  /** Base height (default 0 = on the floor). Items beyond the island edge float in the backdrop. */
  y?: number;
  scale: number;
  rotation: number;
  /** "ants": the marching path end point (ants walk x,z → to.x,to.z and loop). */
  to?: { x: number; z: number };
}

export interface ArenaTheme {
  /** Sky gradient (vertical shader). */
  skyTop: string;
  skyBottom: string;
  fogColor: string;
  fogNear: number;
  fogFar: number;
  floorKind: FloorKind;
  /** Floor base color and its toon-shadow color. */
  floorColor: string;
  floorShadeColor: string;
  /** Secondary floor color: tile grout / frosting sprinkles / grass flowers. */
  floorDetailColor: string;
  /** Island side / slab color (dirt, tub enamel, sponge cake). */
  sideColor: string;
  /** Rim trim along the island edge (grass lip, tub rim, frosting drip). */
  rimColor: string;
  voidKind: VoidKind;
  voidColor: string;
  cloudColor: string;
  cloudShadowColor: string;
  sunColor: string;
  sunIntensity: number;
  /** Sun direction (normalized by the renderer), pointing FROM the sun TO the scene. */
  sunDirection: { x: number; y: number; z: number };
  hemiSkyColor: string;
  hemiGroundColor: string;
  hemiIntensity: number;
  ambient: AmbientKind;
  crumble: CrumbleKind;
  /** Pedestal colors. */
  pedestalColor: string;
  pedestalTrimColor: string;
}

export interface ArenaDef {
  id: MapId;
  name: string;
  /** Lobby blurb. */
  description: string;
  shape: ArenaShape;
  /** Ascending outer radii (shapeDistance metric). ≥ 5 rings; the last is the island edge (≈ 15 m). */
  ringRadii: ReadonlyArray<number>;
  cover: ReadonlyArray<CoverDef>;
  /** Exactly 3 power-up pedestals. */
  pedestals: ReadonlyArray<Pedestal>;
  /** Exactly 4 spawns, used in slot order (slot 0 → spawns[0]). Slots 0/1 are opposite corners. */
  spawns: ReadonlyArray<SpawnPoint>;
  /** Center of the ball drop pattern (offsets in constants.BALL_DROP_OFFSETS). */
  ballDrop: { x: number; z: number };
  friction: FrictionProfile;
  theme: ArenaTheme;
  decor: ReadonlyArray<DecorItem>;
}

/* =============================================================== helpers */

/**
 * Distance metric of an arena shape: Euclidean for circles, superellipse
 * (|x|^4 + |z|^4)^(1/4) for rounded squares. Ring membership uses this metric.
 */
export function shapeDistance(shape: ArenaShape, x: number, z: number): number {
  if (shape === "circle") return Math.hypot(x, z);
  const x2 = x * x;
  const z2 = z * z;
  return Math.pow(x2 * x2 + z2 * z2, 0.25);
}

/** Yaw that faces the origin from (x, z). */
export function yawToCenter(x: number, z: number): number {
  return Math.atan2(x, z);
}

function spawn(x: number, z: number): SpawnPoint {
  return { x, z, yaw: yawToCenter(x, z) };
}

export function isMapId(value: unknown): value is MapId {
  return typeof value === "string" && (MAP_IDS as ReadonlyArray<string>).includes(value);
}

/** Arena by id; unknown ids fall back to the default map. */
export function getArena(id: MapId | string): ArenaDef {
  return isMapId(id) ? ARENAS[id] : ARENAS[DEFAULT_MAP];
}

/** World position of pedestal `index` (y = 0 floor; the pickup hovers at PEDESTAL_HEIGHT + POWERUP_HOVER_Y). */
export function pedestalPosition(arena: ArenaDef, index: number): Pedestal {
  return arena.pedestals[Math.max(0, Math.min(arena.pedestals.length - 1, index))];
}

/* ========================================================== shared bits */

const DEFAULT_FRICTION: FrictionProfile = {
  groundAccel: 60,
  groundDecel: 45,
  ballRollDecel: 4,
  ballBounceFriction: 0.85,
};

const SLIPPERY_FRICTION: FrictionProfile = {
  groundAccel: 22,
  groundDecel: 7,
  ballRollDecel: 1.5,
  ballBounceFriction: 0.95,
};

/** Diagonal corners; slot 0/1 opposite, then 2/3. */
const DIAGONAL_SPAWNS: ReadonlyArray<SpawnPoint> = [spawn(-7.5, 7.5), spawn(7.5, -7.5), spawn(7.5, 7.5), spawn(-7.5, -7.5)];

/** Three pedestals at radius 6.4 between the spawn diagonals (north, south-east, south-west). */
const RING1_PEDESTALS: ReadonlyArray<Pedestal> = [
  { x: 0, z: -6.4 },
  { x: 5.54, z: 3.2 },
  { x: -5.54, z: 3.2 },
];

/* ================================================================ arenas */

export const ARENAS: Readonly<Record<MapId, ArenaDef>> = {
  picnic: {
    id: "picnic",
    name: "Picnic Plateau",
    description: "A grassy floating island above fluffy clouds. Mind the ants.",
    shape: "circle",
    ringRadii: [5, 7.5, 10, 12.5, 15],
    cover: [
      { kind: "picnicTable", shape: "box", x: -2.8, z: 1.4, halfX: 1.5, halfZ: 0.75, height: 0.85, rotation: 0.35 },
      { kind: "watermelon", shape: "box", x: 2.9, z: 1.9, halfX: 1.2, halfZ: 0.35, height: 1.15, rotation: -0.6 },
      { kind: "basket", shape: "cylinder", x: 0.4, z: -3.3, radius: 0.75, height: 0.85, rotation: 0 },
    ],
    pedestals: RING1_PEDESTALS,
    spawns: DIAGONAL_SPAWNS,
    ballDrop: { x: 0, z: 0 },
    friction: DEFAULT_FRICTION,
    theme: {
      skyTop: "#6EC6FF",
      skyBottom: "#D6F1FF",
      fogColor: "#D6F1FF",
      fogNear: 40,
      fogFar: 120,
      floorKind: "grass",
      floorColor: "#7BD389",
      floorShadeColor: "#4FA36B",
      floorDetailColor: "#FFF6A8",
      sideColor: "#8D5B3A",
      rimColor: "#5FBF73",
      voidKind: "clouds",
      voidColor: "#FFFFFF",
      cloudColor: "#FFFFFF",
      cloudShadowColor: "#CFE3F2",
      sunColor: "#FFF4D6",
      sunIntensity: 2.4,
      sunDirection: { x: -0.45, y: -1, z: -0.3 },
      hemiSkyColor: "#BFE6FF",
      hemiGroundColor: "#7BD389",
      hemiIntensity: 1.1,
      ambient: "butterflies",
      crumble: "dirt",
      pedestalColor: "#C68B59",
      pedestalTrimColor: "#FFCF33",
    },
    decor: [
      { kind: "blanket", x: 5.2, z: -5.6, scale: 3, rotation: 0.3 },
      { kind: "ants", x: -9.5, z: -3, scale: 1, rotation: 0, to: { x: -6.5, z: -8.5 } },
      { kind: "tree", x: -11.5, z: -8.8, scale: 1.2, rotation: 0.4 },
      { kind: "tree", x: 12.6, z: 6.4, scale: 1.0, rotation: 1.9 },
      { kind: "tree", x: -4.2, z: 13.8, scale: 1.1, rotation: 2.7 },
      { kind: "bush", x: 13.6, z: -4.4, scale: 0.9, rotation: 0.8 },
      { kind: "bush", x: -13.9, z: 3.9, scale: 1.0, rotation: 2.2 },
      { kind: "flower", x: 3.4, z: 9.6, scale: 1, rotation: 0 },
      { kind: "flower", x: -8.8, z: 8.2, scale: 1, rotation: 1 },
      { kind: "flower", x: 9.4, z: -9.9, scale: 1, rotation: 2 },
      { kind: "flower", x: -1.8, z: -11.2, scale: 1, rotation: 3 },
    ],
  },

  bath: {
    id: "bath",
    name: "Bath Time",
    description: "A giant bathtub with slippery tiles. Momentum is your friend (or not).",
    shape: "roundedSquare",
    ringRadii: [5, 7.5, 10, 12.5, 14.5],
    cover: [
      { kind: "rubberDuck", shape: "cylinder", x: -3.0, z: -1.6, radius: 0.95, height: 1.35, rotation: 0.6 },
      { kind: "soapBar", shape: "box", x: 3.0, z: -1.8, halfX: 0.95, halfZ: 0.6, height: 0.55, rotation: 0.45 },
      { kind: "shampooBottle", shape: "cylinder", x: 0.2, z: 3.3, radius: 0.5, height: 1.9, rotation: 0 },
    ],
    pedestals: RING1_PEDESTALS,
    spawns: DIAGONAL_SPAWNS,
    ballDrop: { x: 0, z: 0 },
    friction: SLIPPERY_FRICTION,
    theme: {
      skyTop: "#9FDCEB",
      skyBottom: "#EAF8FB",
      fogColor: "#DDF3F8",
      fogNear: 35,
      fogFar: 110,
      floorKind: "tile",
      floorColor: "#F4F7FA",
      floorShadeColor: "#D5DEE6",
      floorDetailColor: "#C9D4DE",
      sideColor: "#FFFFFF",
      rimColor: "#E6EEF4",
      voidKind: "drainWater",
      voidColor: "#5FC3E4",
      cloudColor: "#FFFFFF",
      cloudShadowColor: "#D7EEF5",
      sunColor: "#FFFFFF",
      sunIntensity: 2.1,
      sunDirection: { x: 0.35, y: -1, z: -0.4 },
      hemiSkyColor: "#E3F6FB",
      hemiGroundColor: "#9FDCEB",
      hemiIntensity: 1.2,
      ambient: "bubbles",
      crumble: "tiles",
      pedestalColor: "#8FD3E8",
      pedestalTrimColor: "#FFFFFF",
    },
    decor: [
      { kind: "faucet", x: 0, z: -16.5, y: 1.5, scale: 2.2, rotation: 0 },
      { kind: "towel", x: 15.8, z: 9.5, y: 2, scale: 2, rotation: -1.57 },
      { kind: "bubbles", x: -10.5, z: 6.5, scale: 1.4, rotation: 0 },
      { kind: "bubbles", x: 9.5, z: -9, scale: 1.1, rotation: 0 },
      { kind: "bubbles", x: -6.8, z: -10.6, scale: 0.9, rotation: 0 },
      { kind: "bubbles", x: 11.2, z: 4.2, scale: 1.2, rotation: 0 },
    ],
  },

  cake: {
    id: "cake",
    name: "Cake Topper",
    description: "The top tier of a giant birthday cake at dusk. The edges crumble fast.",
    shape: "circle",
    ringRadii: [5, 7.25, 9.5, 11.75, 14],
    cover: [
      { kind: "candle", shape: "cylinder", x: -2.6, z: -2.4, radius: 0.32, height: 1.7, rotation: 0 },
      { kind: "candle", shape: "cylinder", x: 2.6, z: 2.4, radius: 0.32, height: 1.7, rotation: 0 },
      { kind: "strawberry", shape: "cylinder", x: 2.8, z: -2.2, radius: 0.8, height: 1.0, rotation: 0.3 },
      { kind: "strawberry", shape: "cylinder", x: -2.8, z: 2.2, radius: 0.8, height: 1.0, rotation: 2.1 },
    ],
    pedestals: RING1_PEDESTALS,
    spawns: DIAGONAL_SPAWNS,
    ballDrop: { x: 0, z: 0 },
    friction: DEFAULT_FRICTION,
    theme: {
      skyTop: "#4B2E83",
      skyBottom: "#F5A3C7",
      fogColor: "#C88BC0",
      fogNear: 35,
      fogFar: 110,
      floorKind: "frosting",
      floorColor: "#FFB7D5",
      floorShadeColor: "#E58FB6",
      floorDetailColor: "#FFF4A3",
      sideColor: "#F6D7A7",
      rimColor: "#FFFFFF",
      voidKind: "duskSky",
      voidColor: "#3A2A5C",
      cloudColor: "#F9D3E6",
      cloudShadowColor: "#B98BC7",
      sunColor: "#FFD2A6",
      sunIntensity: 1.9,
      sunDirection: { x: 0.6, y: -0.7, z: 0.2 },
      hemiSkyColor: "#C7A6F0",
      hemiGroundColor: "#FFB7D5",
      hemiIntensity: 1.0,
      ambient: "balloons",
      crumble: "crumbs",
      pedestalColor: "#FFFFFF",
      pedestalTrimColor: "#FF7FB0",
    },
    decor: [
      { kind: "sprinkles", x: 0, z: 0, scale: 14, rotation: 0 },
      { kind: "cherry", x: 10.6, z: -4.2, scale: 1, rotation: 0 },
      { kind: "cherry", x: -9.4, z: -6.8, scale: 1, rotation: 0 },
      { kind: "balloon", x: -18, z: -12, y: 4, scale: 1.4, rotation: 0 },
      { kind: "balloon", x: 17, z: -15, y: 7, scale: 1.2, rotation: 0 },
      { kind: "balloon", x: 20, z: 10, y: 2, scale: 1.6, rotation: 0 },
      { kind: "balloon", x: -16, z: 16, y: 6, scale: 1.3, rotation: 0 },
    ],
  },
};
