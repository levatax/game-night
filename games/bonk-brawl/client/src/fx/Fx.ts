// Facade that owns every fx subsystem. Owner: client-fx.

import type * as THREE from "three";
import type { ArenaDef } from "../../../shared/maps";
import type { FloorQuery } from "../../../shared/sim/context";
import { ArcPreview } from "./ArcPreview";
import { BallVisuals } from "./Balls";
import { Feel } from "./Feel";
import { Particles } from "./Particles";
import { PopText } from "./PopText";
import { PowerUpVisuals } from "./PowerUps";
import { BlobShadows } from "./Shadows";

/** GameController talks to the subsystems directly through these fields. */
export class Fx {
  readonly balls: BallVisuals;
  readonly particles: Particles;
  readonly popText: PopText;
  readonly powerUps: PowerUpVisuals;
  readonly arc: ArcPreview;
  readonly shadows: BlobShadows;
  readonly feel = new Feel();

  constructor(scene: THREE.Scene) {
    this.balls = new BallVisuals(scene);
    this.particles = new Particles(scene);
    this.popText = new PopText(scene);
    this.powerUps = new PowerUpVisuals(scene);
    this.arc = new ArcPreview(scene);
    this.shadows = new BlobShadows(scene);
  }

  /** New arena loaded: pedestals + shadow ground query. */
  setArena(def: ArenaDef, q: FloorQuery): void {
    this.powerUps.setArena(def);
    this.shadows.setFloorQuery(q);
  }

  /** Per frame (cosmetic dt): particles + pop text. Balls/power-ups/shadows are synced separately. */
  update(dt: number): void {
    this.particles.update(dt);
    this.popText.update(dt);
  }

  /** Remove every transient effect (leaving a room / new round). */
  clear(): void {
    this.balls.clear();
    this.particles.clear();
    this.popText.clear();
    this.powerUps.clear();
  }

  dispose(): void {
    this.balls.dispose();
    this.particles.dispose();
    this.popText.dispose();
    this.powerUps.dispose();
    this.arc.dispose();
    this.shadows.dispose();
  }
}
