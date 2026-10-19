// Cross-module fx types. Owner: client-fx (written by architect, complete).

import type * as THREE from "three";

/**
 * stars      — hit stars (yellow/white, burst + orbit briefly)
 * puff       — white smoke puff (KO pop, landing, roll start)
 * confetti   — round/match win, catch celebration
 * speedLines — zoomies / dash streaks (attach with `follow`)
 * feathers   — KO pop for quacky/pip; fur tufts for the others (pass color)
 * dust       — knockback landing / skid trail
 * crumbs     — ring crumble (color by CrumbleKind: dirt / tile chips / cake crumbs)
 * sparkles   — power-up spawn/pickup, full-charge glint
 * shockwave  — expanding ground ring (Ground Pound), radius in opts.scale
 * bubbles    — Mochi belly bounce / Bath Time splash
 */
export type ParticleKind =
  | "stars"
  | "puff"
  | "confetti"
  | "speedLines"
  | "feathers"
  | "dust"
  | "crumbs"
  | "sparkles"
  | "shockwave"
  | "bubbles";

export interface BurstOptions {
  /** Tint (hex). Default per kind. */
  color?: string;
  /** Multiplies count and spread. Default 1. */
  scale?: number;
  /** Main direction for directional bursts (dust skid, speed lines). */
  dir?: { x: number; y: number; z: number };
}

/** Comic pop text sprites (hand-lettered look via canvas): BONK!, CATCH!, OUT!, plus extras. */
export type PopTextKind = "bonk" | "catch" | "out" | "miss" | "boing" | "ding";

/** Lets fx place held balls in hands and tint balls by owner without importing characters/net. */
export interface BallVisualContext {
  /** Fill `out` with the holder's hand world position; false if unknown (ball hidden). */
  handOf(playerId: string, out: THREE.Vector3): boolean;
  /** Slot color of a player ("#RRGGBB"), PALETTE.neutralBall if unknown. */
  colorOf(playerId: string): string;
}

/** Anything that gets a blob shadow on the ground. */
export interface ShadowCaster {
  x: number;
  y: number;
  z: number;
  /** Footprint radius (PLAYER_RADIUS, ball radius). */
  radius: number;
}
