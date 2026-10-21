// Event-driven visual effects: thrown / dropped item meshes (all 22 item kinds, spinning in flight, resting
// pickups bob + glow, bait fish smell lines), particle bursts, pop text, the dotted arc preview, 3D ping
// balloons, fishing bobbers + lines, blob shadows. Owner: client-fx. Signatures by the architect; keep them.
//
// Copied + adapted from games/bonk-brawl/client/src/fx/{Particles,billboard,PopText,popAtlas,Trail,Shadows,
// ArcPreview}.ts and games/kasala/client/src/scene/fx/Pool.ts. Subsystems (each its own file):
//   Projectiles (item visuals) · Particles (billboard bursts) · Chunks (3D debris on Pool) · PopText (+popAtlas)
//   · ArcPreview · Markers (ping balloons) · Bobbers (float + line) · ItemPops · ChargeGlows · BlobShadows.
//
// Frame order for the app: syncProjectiles(frames, dt) → setArc / setBobbers / setChargeGlow → update(dt).
// Extras beyond the architect's facade (optional): setIsland (shadow / debris ground), setQuality,
// setReducedFlashing, setChargeGlow, dispose, and the read-only subsystem fields for the dev harness.

import * as THREE from "three";
import { WATER_Y } from "../../../shared/constants";
import { heightAt } from "../../../shared/island/heightfield";
import type { IslandDef } from "../../../shared/island/types";
import type { ItemKind, MarkerKind, Vec3Like } from "../../../shared/types";
import type { ProjectileFrame } from "../net/types";
import { ArcPreview } from "./ArcPreview";
import { Bobbers } from "./Bobbers";
import { BURST_CHUNKS } from "./burstChunks";
import { ChargeGlows } from "./ChargeGlows";
import { Chunks } from "./Chunks";
import { ItemPops } from "./ItemPops";
import { Markers } from "./Markers";
import { BURST_COUNT, Particles } from "./Particles";
import { PopText } from "./PopText";
import { ProjectileVisuals } from "./Projectiles";
import { BlobShadows } from "./Shadows";

export type BurstKind =
  | "woodChips"
  | "stoneChips"
  | "leaves"
  | "berries"
  | "splash"
  | "ripple"
  | "hitStars"
  | "bonk"
  | "flip"
  | "blast"
  | "embers"
  | "smoke"
  | "sparkle"
  | "gold"
  | "dust"
  | "bubbles"
  | "feathers"
  | "crabBits"
  | "confetti"
  | "hearts";

export type PopStyle = "hit" | "big" | "good" | "bad" | "info" | "gold";

export interface BurstOptions {
  count?: number;
  color?: string;
  dir?: Vec3Like;
  scale?: number;
}

export interface MarkerVisual {
  id: string;
  kind: MarkerKind;
  pos: Vec3Like;
  color: string;
  /** Short label (already translated), e.g. "Wood needed". */
  label: string;
  /** Seconds to live (MARKER_TICKS / TICK_RATE). */
  ttl: number;
}

export interface Bobber {
  playerId: string;
  /** Line start (rod tip ≈ hand) and bobber on the water. */
  from: Vec3Like;
  pos: Vec3Like;
  /** Dipped: the bite window is open. */
  biting: boolean;
}

/** Every burst kind (dev harness, tests). */
export const BURST_KINDS: ReadonlyArray<BurstKind> = [
  "woodChips",
  "stoneChips",
  "leaves",
  "berries",
  "splash",
  "ripple",
  "hitStars",
  "bonk",
  "flip",
  "blast",
  "embers",
  "smoke",
  "sparkle",
  "gold",
  "dust",
  "bubbles",
  "feathers",
  "crabBits",
  "confetti",
  "hearts",
];

export const POP_STYLE_IDS: ReadonlyArray<PopStyle> = ["hit", "big", "good", "bad", "info", "gold"];

/** Particle budget per graphics quality (multiplies counts and the live cap). */
const QUALITY_PARTICLES = { low: 0.5, medium: 1, high: 1.25 } as const;

export class Fx {
  readonly particles: Particles;
  readonly chunks: Chunks;
  readonly popTexts: PopText;
  readonly arc: ArcPreview;
  readonly markers: Markers;
  readonly bobbers: Bobbers;
  readonly projectiles: ProjectileVisuals;
  readonly shadows: BlobShadows;
  readonly itemPops: ItemPops;
  readonly chargeGlows: ChargeGlows;
  private readonly root = new THREE.Group();

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.root.name = "fx";
    scene.add(this.root);
    this.shadows = new BlobShadows(this.root);
    this.particles = new Particles(this.root);
    this.chunks = new Chunks(this.root);
    this.popTexts = new PopText(this.root);
    this.arc = new ArcPreview(this.root);
    this.markers = new Markers(this.root, camera, this.particles);
    this.bobbers = new Bobbers(this.root, this.particles);
    this.projectiles = new ProjectileVisuals(this.root, this.particles, this.shadows);
    this.itemPops = new ItemPops(this.root, camera, this.popTexts);
    this.chargeGlows = new ChargeGlows(this.root, this.particles);
  }

  /** Per frame: item meshes for every projectile frame (create / move / remove by id). */
  syncProjectiles(frames: ProjectileFrame[], dt: number): void {
    this.shadows.begin();
    this.projectiles.sync(frames, dt);
    this.shadows.end();
  }

  /** Dotted arc preview (points from shared sampleTrajectory) or null to hide. */
  setArc(points: ReadonlyArray<Vec3Like> | null, color: string): void {
    this.arc.update(points, color);
  }

  burst(kind: BurstKind, pos: Vec3Like, opts?: BurstOptions): void {
    if (!finite(pos)) return;
    this.particles.burst(kind, pos, opts);
    const scale = Math.max(0.05, opts?.scale ?? 1);
    for (const spec of BURST_CHUNKS[kind]) {
      const count = opts?.count !== undefined ? Math.round((spec.count * opts.count) / Math.max(1, BURST_COUNT[kind])) : Math.round(spec.count * Math.min(3, scale));
      if (count <= 0) continue;
      this.chunks.burst(spec.chunk, pos, {
        count,
        colors: opts?.color ? [opts.color] : spec.colors,
        size: spec.size * Math.sqrt(scale),
        speed: spec.speed * Math.sqrt(scale),
        dir: opts?.dir,
      });
    }
  }

  popText(text: string, pos: Vec3Like, style: PopStyle): void {
    if (!finite(pos)) return;
    this.popTexts.show(text, pos, style);
    if (style === "gold") this.particles.burst("gold", pos, { scale: 0.8 });
  }

  /** Add a 3D ping balloon (replaces an older one from the same player). */
  marker(m: MarkerVisual): void {
    if (!finite(m.pos)) return;
    this.markers.add(m);
  }

  /** Fishing bobbers + lines this frame (empty array = none). */
  setBobbers(list: ReadonlyArray<Bobber>): void {
    this.bobbers.set(list);
  }

  /** Small floating icon over a node / site (e.g. the item a gather just gave): "+1 🪵". */
  itemPop(kind: ItemKind | "berry", count: number, pos: Vec3Like): void {
    if (!finite(pos)) return;
    this.itemPops.show(kind, count, pos);
  }

  update(dt: number): void {
    const step = Math.max(0, Math.min(dt, 0.1));
    this.chargeGlows.update(step);
    this.bobbers.update(step);
    this.markers.update(step);
    this.itemPops.update(step);
    this.particles.update(step);
    this.chunks.update(step);
    this.popTexts.update(step);
  }

  clear(): void {
    this.projectiles.clear();
    this.particles.clear();
    this.chunks.clear();
    this.popTexts.clear();
    this.arc.update(null, "#FFFFFF");
    this.markers.clear();
    this.bobbers.clear();
    this.itemPops.clear();
    this.chargeGlows.clear();
    this.shadows.clear();
  }

  /* ------------------------------------------------------------------ extras */

  /** Island for ground heights (blob shadows, debris bounces); null = flat sea level. */
  setIsland(island: IslandDef | null): void {
    const ground = island ? (x: number, z: number) => heightAt(island.grid, x, z) : null;
    this.shadows.setGround(ground);
    this.chunks.setGround(ground ? (x, z) => Math.max(WATER_Y, ground(x, z)) : null);
  }

  /** Graphics quality → particle / debris budget. */
  setQuality(quality: "low" | "medium" | "high"): void {
    this.particles.setQualityScale(QUALITY_PARTICLES[quality]);
    this.chunks.setQualityScale(QUALITY_PARTICLES[quality]);
  }

  /** settings.reducedFlashing: tone impact flashes down. */
  setReducedFlashing(on: boolean): void {
    this.particles.setReducedFlashing(on);
  }

  /**
   * Throw charge glow at a hand (world position) for `id` (player id): call every frame while charging; it grows
   * with `charge` 0..1 and sparkles at full charge. pos null / charge 0 removes it (it also fades out on its own).
   */
  setChargeGlow(id: string, pos: Vec3Like | null, charge: number, color: string): void {
    this.chargeGlows.set(id, pos && finite(pos) ? pos : null, charge, color);
  }

  /** Continuous emitter (e.g. embers over a lit campfire, bubbles over a swimmer); refresh every frame. */
  emit(key: string, kind: BurstKind, pos: Vec3Like, opts?: BurstOptions): void {
    if (!finite(pos)) return;
    this.particles.emit(key, kind, pos, opts);
  }

  dispose(): void {
    this.clear();
    this.projectiles.dispose();
    this.particles.dispose();
    this.chunks.dispose();
    this.popTexts.dispose();
    this.arc.dispose();
    this.markers.dispose();
    this.bobbers.dispose();
    this.itemPops.dispose();
    this.chargeGlows.dispose();
    this.shadows.dispose();
    this.root.removeFromParent();
  }
}

function finite(p: Vec3Like): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}
