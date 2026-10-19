// Cross-module types for characters. Owner: client-characters (written by architect, complete).

import type { EmoteId, Vec3Like } from "../../../shared/types";

/** Face sprite-sheet expressions (game1.md §10), in sheet order (4 columns × 2 rows, row-major). */
export type FaceExpression = "idle" | "blink" | "angry" | "hurt" | "dizzy" | "happy" | "charging" | "ko";
export const FACE_EXPRESSIONS: ReadonlyArray<FaceExpression> = [
  "idle",
  "blink",
  "angry",
  "hurt",
  "dizzy",
  "happy",
  "charging",
  "ko",
];

/**
 * One-shot animations triggered by events (continuous states come from derivePlayerAction).
 * throw      — throw follow-through (ThrowEvent / localThrow)
 * catch      — success "big hug" pose (CatchEvent, catcher)
 * whiff      — failed catch flail (WhiffEvent)
 * hit        — hit-react spin + stars (HitEvent target)
 * land       — squash on landing (detected client-side from grounded transitions)
 * pickup     — quick scoop (PickupEvent)
 * ability    — ability flourish (AbilityEvent): flap / leap / belly puff / smug wink / slide / lunge
 * slam       — Hopsworth's landing squash (ShockwaveEvent)
 * emote      — one of 3 emotes (opts.emote)
 * victory    — victory dance (RoundWinEvent winner, podium winner)
 * ko         — pop into a puff of feathers/fur leaving the animal's hat/accessory floating at the
 *              spot until the round ends (the winner's victory dance happens over it), then ghost
 *              floating ~1.5 m above opts.pos (KoEvent.pos; default: the frame position)
 * ringOut    — RingOutEvent victim: no pop; keep the body tumbling down out of view (cosmetic,
 *              the server froze it just below RING_OUT_Y), then the ghost appears ~1.5 m above
 *              opts.pos (RingOutEvent.pos = last grounded position, on the island)
 *
 * Ghost state persists while frame.alive is false and is cleared when the player is alive again
 * (next round) or on clear().
 */
export type AnimTrigger =
  | "throw"
  | "catch"
  | "whiff"
  | "hit"
  | "land"
  | "pickup"
  | "ability"
  | "slam"
  | "emote"
  | "victory"
  | "ko"
  | "ringOut";

export interface TriggerOptions {
  /** emote id for "emote". */
  emote?: EmoteId;
  /** Direction of the hit/knockback (hit-react spin axis), world space. */
  dir?: Vec3Like;
  /** 0..1 strength (land speed, charge). */
  strength?: number;
  /** World anchor for "ko" / "ringOut" (where the ghost / floating hat appears). */
  pos?: Vec3Like;
}

export interface CharacterSyncOptions {
  /** Player wearing the gold crown ("" none). */
  crownId: string;
  /** Local player id (its nameplate is hidden). */
  localId: string;
  /** Hide the local player's body (e.g. camera too close). */
  hideLocal: boolean;
}
