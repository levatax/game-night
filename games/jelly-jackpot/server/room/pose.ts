// Hover/drop pose validation for JellyRoom. Owner: server-room.
// Untrusted client poses are parsed defensively, clamped into the legal hover cylinder
// (r ≤ HOVER_RADIUS, minY ≤ y ≤ maxY) and get a normalized quaternion.

import { HOVER_RADIUS } from "../../shared/constants.js";
import type { Pose } from "../../shared/protocol.js";

/** How far above the minimum drop height a piece may hover (no dropping from orbit). */
export const HOVER_MAX_ABOVE = 0.6;

const KEYS = ["x", "y", "z", "qx", "qy", "qz", "qw"] as const;

/** A Pose if every field is a finite number, else null. */
export function readPose(raw: unknown): Pose | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: Partial<Pose> = {};
  for (const k of KEYS) {
    const v = src[k];
    if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e4) return null;
    out[k] = v;
  }
  return out as Pose;
}

/** Clamp a pose into the hover volume and normalize its rotation (identity if degenerate). */
export function clampPose(p: Pose, minY: number): Pose {
  let { x, z } = p;
  const r = Math.hypot(x, z);
  if (r > HOVER_RADIUS) {
    x = (x / r) * HOVER_RADIUS;
    z = (z / r) * HOVER_RADIUS;
  }
  const y = Math.min(Math.max(p.y, minY), minY + HOVER_MAX_ABOVE);
  const len = Math.hypot(p.qx, p.qy, p.qz, p.qw);
  if (!(len > 1e-6)) return { x, y, z, qx: 0, qy: 0, qz: 0, qw: 1 };
  return { x, y, z, qx: p.qx / len, qy: p.qy / len, qz: p.qz / len, qw: p.qw / len };
}

/** The default hover pose: dead center, a little above the minimum drop height. */
export function centerPose(minY: number): Pose {
  return { x: 0, y: minY + 0.05, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
}

/** Pose + offset (hiccup hop). */
export function offsetPose(p: Pose, dx: number, dy: number, dz: number): Pose {
  return { ...p, x: p.x + dx, y: p.y + dy, z: p.z + dz };
}
