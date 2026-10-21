// Per-frame inputs of the renderer. Owner: client-render (written by the architect, complete).

import type { Timings } from "../../../shared/constants";
import type { ArrayView, Biome, Phase, StructureView, TeamView, Vec3Like, Weather } from "../../../shared/types";

/** A dynamic point light (lit torches in hands, planted torches are drawn from `structures`). */
export interface LightSource {
  x: number;
  y: number;
  z: number;
  /** Gameplay light radius (TORCH_LIGHT_RADIUS); the visual falloff should read as "the ring crabs won't enter". */
  radius: number;
  /** 0..1 (a torch about to burn out flickers down). */
  intensity: number;
}

/** Everything the island scene shows that changes during a match (read straight from the decoded state). */
export interface WorldFrame {
  phase: Phase;
  /** Fractional clockTicks (Net.clockTicksAt) and the timings it runs on. */
  clockTicks: number;
  timings: Readonly<Timings>;
  weather: Weather;
  biome: Biome;
  /** Remaining node amounts (IslandDef.nodes index): stumps / bare palms / pebbles / bare bushes at 0; palm coconut count. */
  nodes: ArrayView<number>;
  /** Per team: raft stage + progress (logs, mast, sail, crates appear as delivered), fire fuel (flame size; out at 0). */
  teams: ArrayView<TeamView>;
  /** Placed fences / torches / collectors / kraken / huts / canoes. */
  structures: Iterable<StructureView>;
  lights: LightSource[];
  /** Local eye position (shadow camera follow, water foam LOD, ambient particles). */
  focus: Vec3Like;
  /** 0..1 progress of the raft sailing away (launch phase), else 0. */
  launch: number;
  /** 0..1 progress of the storm (storm phase), or the storm warning build-up during the last 30 s of night 3. */
  storm: number;
  /** Secret chest revealed (draw it) per team. */
  secretShown: boolean[];
  /** Spring marker revealed (glint). */
  reducedFlashing: boolean;
}

/** First-person camera input for FpCamera.update(). */
export interface CameraFrame {
  /** Eye position (feet + EYE_HEIGHT / DOWNED_EYE_HEIGHT), already predicted + smoothed. */
  eye: Vec3Like;
  yaw: number;
  pitch: number;
  /** Horizontal speed m/s (head-bob, FOV). */
  speed: number;
  grounded: boolean;
  sprinting: boolean;
  swimming: boolean;
  downed: boolean;
  /** Washed ashore / spectating: free-ish slow orbit over the camp instead of the eye. */
  spectate: boolean;
  /** Charge fraction 0..1 (slight zoom). */
  charge: number;
  /** Base FOV from settings (degrees). */
  fov: number;
  headBob: boolean;
}
