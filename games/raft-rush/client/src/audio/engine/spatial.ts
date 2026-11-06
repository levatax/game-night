// PannerNode / AudioListener helpers and the radio distance curves. Owner: client-fx-audio. Copied from
// games/bonk-brawl/client/src/audio/engine/spatial.ts (world units are meters, Y up, which is also Web Audio's
// convention, so positions pass through unchanged) with distances retuned for a ~100 m island, plus the pure
// curves for Emekli Amca's radio (§14/§18: the music source fades and gets tinny with distance).

import type { Vec3Like } from "../../../../shared/types";

/** Inverse distance model: full volume within 3 m, ~5% at 60 m, ~3% at the far shore (the island is ~100 m across). */
export const PANNER_REF_DISTANCE = 3;
export const PANNER_MAX_DISTANCE = 100;
export const PANNER_ROLLOFF = 1.1;

export function createPanner(ctx: BaseAudioContext, pos: Vec3Like, hrtf: boolean): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = hrtf ? "HRTF" : "equalpower";
  p.distanceModel = "inverse";
  p.refDistance = PANNER_REF_DISTANCE;
  p.maxDistance = PANNER_MAX_DISTANCE;
  p.rolloffFactor = PANNER_ROLLOFF;
  setPannerPosition(p, pos);
  return p;
}

/** A panner that only gives direction (no distance attenuation): the radio's gain is ours (radioGain). */
export function createDirectionalPanner(ctx: BaseAudioContext): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = "equalpower";
  p.distanceModel = "linear";
  p.refDistance = 1;
  p.maxDistance = 10000;
  p.rolloffFactor = 0;
  return p;
}

export function setPannerPosition(p: PannerNode, pos: Vec3Like): void {
  if (!isFiniteVec(pos)) return;
  // Older Safari lacks the AudioParam pose (positionX…); fall back to the legacy setter there.
  if (p.positionX) {
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
  } else {
    p.setPosition(pos.x, pos.y, pos.z);
  }
}

const scratchUp = { x: 0, y: 1, z: 0 };
const scratchFwd = { x: 0, y: 0, z: -1 };

/** Listener at `pos` looking along `forward`; "up" is re-orthogonalized so pitch never flips it. */
export function setListenerPose(l: AudioListener, pos: Vec3Like, forward: Vec3Like): void {
  if (!isFiniteVec(pos) || !isFiniteVec(forward)) return;
  const len = Math.hypot(forward.x, forward.y, forward.z);
  if (len < 1e-6) return;
  const f = scratchFwd;
  f.x = forward.x / len;
  f.y = forward.y / len;
  f.z = forward.z / len;
  orthoUp(f, scratchUp);
  const u = scratchUp;
  if (l.positionX) {
    l.positionX.value = pos.x;
    l.positionY.value = pos.y;
    l.positionZ.value = pos.z;
    l.forwardX.value = f.x;
    l.forwardY.value = f.y;
    l.forwardZ.value = f.z;
    l.upX.value = u.x;
    l.upY.value = u.y;
    l.upZ.value = u.z;
  } else {
    l.setPosition(pos.x, pos.y, pos.z);
    l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
  }
}

/** up = normalize((f × worldUp) × f), i.e. world up with the forward component removed. */
function orthoUp(f: Vec3Like, out: Vec3Like): void {
  const dot = f.y;
  let x = -dot * f.x;
  let y = 1 - dot * f.y;
  let z = -dot * f.z;
  const len = Math.hypot(x, y, z);
  if (len < 1e-4) {
    // Looking straight up/down: any horizontal up works.
    x = 0;
    y = 0;
    z = -1;
  } else {
    x /= len;
    y /= len;
    z /= len;
  }
  out.x = x;
  out.y = y;
  out.z = z;
}

export function isFiniteVec(v: Vec3Like): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/* ===================================================================== radio */

/** Within this distance (m) the radio plays at full volume ("you're carrying it"). */
export const RADIO_NEAR = 4;
/** Distance scale of the falloff (m): at RADIO_NEAR + RADIO_FALLOFF the music is at half volume. */
export const RADIO_FALLOFF = 13;
/** The radio never goes fully silent: the island always hums faintly. */
export const RADIO_FLOOR = 0.08;

/** Music gain for a listener `d` meters from Amca's radio (1 near, smooth falloff, RADIO_FLOOR far). */
export function radioGain(d: number): number {
  if (!Number.isFinite(d) || d <= RADIO_NEAR) return 1;
  const k = (d - RADIO_NEAR) / RADIO_FALLOFF;
  return RADIO_FLOOR + (1 - RADIO_FLOOR) / (1 + k * k);
}

/** Low-pass cutoff (Hz) of the radio at distance `d`: far away it sounds small and tinny. */
export function radioToneHz(d: number): number {
  if (!Number.isFinite(d) || d <= RADIO_NEAR) return 16000;
  const k = Math.min(1, (d - RADIO_NEAR) / 36);
  return 16000 * Math.pow(2400 / 16000, k);
}

/** High-pass cutoff (Hz): the far radio loses its bass (a transistor speaker across the beach). */
export function radioLowCutHz(d: number): number {
  if (!Number.isFinite(d) || d <= RADIO_NEAR) return 30;
  const k = Math.min(1, (d - RADIO_NEAR) / 30);
  return 30 + 290 * k;
}

/** 0 = flat (centered, carried), 1 = fully directional; ramps in between 2 and 8 m. */
export function radioDirectional(d: number): number {
  if (!Number.isFinite(d)) return 0;
  return Math.min(1, Math.max(0, (d - 2) / 6));
}
