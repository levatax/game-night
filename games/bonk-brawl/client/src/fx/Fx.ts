// Facade that owns every fx subsystem. Owner: client-fx.

import type * as THREE from "three";
import { CHARACTERS } from "../../../shared/constants";
import { shapeDistance, type ArenaDef } from "../../../shared/maps";
import type { FloorQuery } from "../../../shared/sim/context";
import type { CharacterId } from "../../../shared/types";
import { ArcPreview } from "./ArcPreview";
import { BallVisuals } from "./Balls";
import { Feel } from "./Feel";
import { Particles } from "./Particles";
import { PlayerTrails } from "./PlayerTrails";
import { PopText } from "./PopText";
import { PowerUpVisuals } from "./PowerUps";
import { BlobShadows } from "./Shadows";

/** Particle budget per graphics quality (multiplies counts and the live cap). */
const QUALITY_PARTICLES = { low: 0.5, medium: 1, high: 1.25 } as const;
/** Crumble bursts spread around a falling ring. */
const CRUMBLE_POINTS = 12;

/** GameController talks to the subsystems directly through these fields. */
export class Fx {
  readonly balls: BallVisuals;
  readonly particles: Particles;
  readonly popText: PopText;
  readonly powerUps: PowerUpVisuals;
  readonly arc: ArcPreview;
  readonly shadows: BlobShadows;
  /** Ribbon trails behind tumbling players (fed by PlayerEffects). */
  readonly trails: PlayerTrails;
  readonly feel = new Feel();
  private arena: ArenaDef | null = null;
  private readonly point = { x: 0, y: 0, z: 0 };

  constructor(scene: THREE.Scene) {
    this.balls = new BallVisuals(scene);
    this.particles = new Particles(scene);
    this.popText = new PopText(scene);
    this.powerUps = new PowerUpVisuals(scene);
    this.arc = new ArcPreview(scene);
    this.shadows = new BlobShadows(scene);
    this.trails = new PlayerTrails(scene);
    // A live ball's killing bounce lands with a little "thud" of dust.
    this.balls.onDeathBounce = (x, y, z) => {
      this.point.x = x;
      this.point.y = y;
      this.point.z = z;
      this.particles.burst("dust", this.point, { scale: 0.5 });
    };
  }

  /** New arena loaded: pedestals + shadow ground query. */
  setArena(def: ArenaDef, q: FloorQuery): void {
    this.arena = def;
    this.powerUps.setArena(def);
    this.shadows.setFloorQuery(q);
  }

  /** Graphics quality → particle budget. */
  setQuality(quality: "low" | "medium" | "high"): void {
    this.particles.setQualityScale(QUALITY_PARTICLES[quality]);
  }

  /** Per frame (cosmetic dt): particles + pop text + player trails. Balls/power-ups/shadows are synced separately. */
  update(dt: number): void {
    this.particles.update(dt);
    this.popText.update(dt);
    this.trails.update(dt);
  }

  /** KO pop (event table `ko`): white puff + feathers (birds) or fur tufts in the animal's colors + "OUT!". */
  koPop(pos: { x: number; y: number; z: number }, character: CharacterId): void {
    const colors = CHARACTERS[character].colors;
    this.point.x = pos.x;
    this.point.y = pos.y + 0.7;
    this.point.z = pos.z;
    this.particles.burst("puff", this.point, { scale: 1.3 });
    this.particles.burst("feathers", this.point, { color: colors.body });
    this.particles.burst("feathers", this.point, { color: colors.secondary, scale: 0.5 });
    this.popText.show("out", this.point);
  }

  /** Successful catch: bright flash + sparkles in the catcher's color + "CATCH!". */
  catchFlash(pos: { x: number; y: number; z: number }, color: string): void {
    this.particles.burst("sparkles", pos, { color, scale: 1.2 });
    this.particles.burst("stars", pos, { color: "#FFFFFF", scale: 0.6 });
    this.popText.show("catch", pos);
  }

  /** Sudden-death ring drop (Arena.onRingFall): debris in the arena's own colors all around the ring. */
  ringCrumble(ring: number): void {
    const def = this.arena;
    if (!def || ring < 0 || ring >= def.ringRadii.length) return;
    const inner = ring > 0 ? def.ringRadii[ring - 1] : 0;
    const radius = (inner + def.ringRadii[ring]) / 2;
    const offset = Math.random() * Math.PI * 2;
    for (let i = 0; i < CRUMBLE_POINTS; i++) {
      const a = offset + (i / CRUMBLE_POINTS) * Math.PI * 2;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      // Rounded-square islands: push the point out to the superellipse at this radius.
      const k = radius / Math.max(0.5, shapeDistance(def.shape, cx, cz));
      this.point.x = cx * k;
      this.point.y = -0.1;
      this.point.z = cz * k;
      this.particles.burst("crumbs", this.point, { color: i % 2 === 0 ? def.theme.sideColor : def.theme.floorColor, scale: 0.6 });
      if (i % 3 === 0) this.particles.burst("dust", this.point, { scale: 0.8 });
    }
  }

  /** Remove every transient effect (leaving a room / new round). */
  clear(): void {
    this.balls.clear();
    this.particles.clear();
    this.popText.clear();
    this.powerUps.clear();
    this.arc.update(null, "#FFFFFF");
    this.shadows.clear();
    this.trails.clear();
    this.feel.reset();
  }

  dispose(): void {
    this.balls.dispose();
    this.particles.dispose();
    this.popText.dispose();
    this.powerUps.dispose();
    this.arc.dispose();
    this.shadows.dispose();
    this.trails.dispose();
  }
}
