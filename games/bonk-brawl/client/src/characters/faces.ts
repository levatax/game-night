// Canvas-drawn face sprite sheets. Owner: client-characters.

import type * as THREE from "three";
import type { CharacterId } from "../../../shared/types";
import type { FaceExpression } from "./types";

/** Sheet layout: 512×512 canvas, 4 columns × 2 rows of 128×256 cells, FACE_EXPRESSIONS order. */
export const FACE_SHEET_SIZE = 512;
export const FACE_COLUMNS = 4;
export const FACE_ROWS = 2;

/**
 * Cached per character: eyes + mouth (+ beak/muzzle cues where the face plane covers them) for
 * the 8 expressions: idle, blink, angry, hurt, dizzy (spirals), happy, charging (determined squint),
 * ko ("X X"). Transparent background; the face plane sits on the head. Character flavor: Whiskers
 * smug half-lids, Hopsworth huge eyes, Mochi pink cheeks, etc. Texture repeat = (1/4, 1/2).
 */
export function getFaceSheet(character: CharacterId): THREE.CanvasTexture {
  void character;
  throw new Error("TODO(client-characters): getFaceSheet");
}

/** UV offset for an expression on a sheet with repeat (1/4, 1/2). Note: canvas row 0 is the TOP (v offset 0.5). */
export function faceOffset(expression: FaceExpression): { u: number; v: number } {
  void expression;
  return { u: 0, v: 0.5 }; // TODO(client-characters)
}
