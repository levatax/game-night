// What the feedback wiring (feedback.ts, flow.ts) needs from the game view, plus tiny shared helpers.
// Owner: client-app.

import type { Vec3Like } from "../../../shared/types";
import type { AudioEngine } from "../audio/AudioEngine";
import type { Characters } from "../characters/Characters";
import type { Fx } from "../fx/Fx";
import type { Params } from "../i18n";
import type { Input } from "../input/Input";
import type { Net } from "../net/Net";
import type { Renderer } from "../render/Renderer";
import type { Tone } from "../ui/models";
import type { Ui } from "../ui/Ui";
import type { Coach } from "./coach";
import type { PingBoard } from "./frameHelpers";
import type { Later } from "./guard";
import type { PlayerDirectory } from "./viewModels";

/** Every client module the game view drives (each one wrapped by guard()). */
export interface GameModules {
  net: Net;
  input: Input;
  renderer: Renderer;
  characters: Characters;
  fx: Fx;
  audio: AudioEngine;
  ui: Ui;
}

export interface FeedbackContext extends GameModules {
  readonly dir: PlayerDirectory;
  readonly later: Later;
  readonly pings: PingBoard;
  readonly coach: Coach;
  /** Own sessionId ("" when not connected). */
  readonly localId: string;
  /** Frame clock (ms). */
  readonly nowMs: number;
  /** Rendered feet position of a player (falls back to the state), false when unknown. */
  position(id: string, out: Vec3Like): boolean;
}

export function point(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

export function above(p: Vec3Like, dy: number): Vec3Like {
  return { x: p.x, y: p.y + dy, z: p.z };
}

/** Unit horizontal direction of `v`, or undefined when it has no horizontal part. */
export function horizontalDir(v: Vec3Like): Vec3Like | undefined {
  const len = Math.hypot(v.x, v.z);
  return len > 1e-4 ? { x: v.x / len, y: 0, z: v.z / len } : undefined;
}

/** Rate limiter keyed by string (feed lines, voices, repeated SFX). */
export class Throttle {
  private readonly last = new Map<string, number>();

  /** True (and remembers now) when `key` didn't fire within `gapMs`. */
  allow(key: string, gapMs: number, nowMs: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && nowMs - prev < gapMs) return false;
    this.last.set(key, nowMs);
    return true;
  }

  clear(): void {
    this.last.clear();
  }
}

/** A feed line ("feed.<key>"). */
export function feedLine(ctx: FeedbackContext, key: string, icon: string, tone: Tone, params?: Params): void {
  ctx.ui.feed({ key: `feed.${key}`, params, icon, tone });
}

/** A sound caption ("hud.cap_<key>") for a cue that is only heard. */
export function captionLine(ctx: FeedbackContext, key: string, icon: string, params?: Params): void {
  ctx.ui.caption({ key: `hud.cap_${key}`, params, icon });
}

/** Where a sound comes from for someone at `from` looking along `yaw` (0 = −Z, as the camera): 90° sectors. */
export type Bearing = "ahead" | "right" | "behind" | "left";

/** Bearing of `to` from `from` facing `yaw`; null when it is right on top of you (under 1.5 m). */
export function bearingOf(from: { x: number; z: number }, yaw: number, to: { x: number; z: number }): Bearing | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 1.5) return null;
  // Facing (−sin yaw, −cos yaw), right hand (cos yaw, −sin yaw).
  const ahead = -Math.sin(yaw) * dx - Math.cos(yaw) * dz;
  const right = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
  if (Math.abs(ahead) >= Math.abs(right)) return ahead >= 0 ? "ahead" : "behind";
  return right >= 0 ? "right" : "left";
}

/** A center banner ("banner.<key>", optional "banner.<sub>"). */
export function bannerLine(
  ctx: FeedbackContext,
  key: string,
  tone: Tone,
  opts: { params?: Params; sub?: string; subParams?: Params; duration?: number } = {},
): void {
  ctx.ui.banner({
    key: `banner.${key}`,
    params: opts.params,
    sub: opts.sub ? `banner.${opts.sub}` : undefined,
    subParams: opts.subParams,
    tone,
    duration: opts.duration,
  });
}
