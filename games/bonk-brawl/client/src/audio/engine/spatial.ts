// PannerNode / AudioListener helpers. World units are meters, Y up (TECH_BRIEF §2), which is
// also Web Audio's coordinate convention, so positions pass through unchanged.

import type { Vec3Like } from "../../../../shared/types";

/** Inverse distance model: full volume within 3 m, ~8% at 40 m (the island is ~30 m across). */
export const PANNER_REF_DISTANCE = 3;
export const PANNER_MAX_DISTANCE = 40;
export const PANNER_ROLLOFF = 1;

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

function isFiniteVec(v: Vec3Like): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
