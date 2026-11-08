// Spring-bone descriptors shared by the model builders and the animator. Owner: client-characters (MODELS).
import type * as THREE from "three";

export type SpringKind =
  | "head" | "ear" | "tail" | "hat" | "ribbon" | "scarf" | "cap" | "pompom" | "bell"
  | "beard" | "crest" | "bulb" | "wing" | "cheek" | "belly" | "sac";

export interface SpringBone {
  /** Unique per animal; equals pivot.name. */
  name: string;
  kind: SpringKind;
  /** Pivot group the spring rotates (aim) or scales (scale). Rest transform: identity rotation, scale 1. */
  pivot: THREE.Object3D;
  mode: "aim" | "scale";
  /** Lagging point in the pivot's local space (m): ear/segment tip; scale mode: the jiggling surface point. */
  tip: readonly [number, number, number];
  /** Natural frequency (Hz) and damping ratio. */
  freq: number;
  damping: number;
  /** Gravity on the tip (m/s², 0 = none). */
  gravity: number;
  /** Max deflection (rad) for aim; max |scale − 1| for scale. */
  limit: number;
  /** Index of the parent bone in AnimalParts.springs (chains), −1 = none. Parents precede children. */
  parent: number;
  /** Scale mode: stretching local axis (default "y"). */
  axis?: "x" | "y" | "z";
}
