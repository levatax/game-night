// A fixed pool of point lights (count set by the quality tier) shared by every campfire, planted torch and held
// torch: each frame the nearest requests get a light (priority is only a small bonus, so your own torch in the
// jungle beats a camp full of fires 60 m away), lights too far to reach anything visible are skipped. The light count
// never changes during a match, so no material ever recompiles when a torch is lit (game4.md §16: at night only
// the campfire, torches and the moon light the island). Falloff is tuned so the lit pool ends at the gameplay
// radius ("the ring crabs won't enter"). Owner: client-render.

import * as THREE from "three";
import type { LightRequest } from "./island/Campfire";

/** Peak intensity at night (candela-ish, physical units) and the daytime share. */
const NIGHT_INTENSITY = 34;
const DAY_SHARE = 0.18;
const DECAY = 1.05;
/** Cutoff distance as a multiple of the gameplay radius. */
const CUTOFF = 1.45;
/** Each priority step is worth this many meters of distance. */
const PRIORITY_METERS = 4;
/** A light whose lit area ends farther than this from the focus is skipped (beyond the night fog). */
const MAX_REACH = 60;

const scored: Array<{ req: LightRequest; score: number }> = [];

export class LightPool {
  readonly group = new THREE.Group();
  private readonly lights: THREE.PointLight[] = [];

  constructor(count: number) {
    this.group.name = "lightPool";
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight("#FFB347", 0, 8, DECAY);
      light.name = `poolLight${i}`;
      light.castShadow = false;
      this.lights.push(light);
      this.group.add(light);
    }
  }

  get size(): number {
    return this.lights.length;
  }

  /** Assign this frame's requests (any order) around `focus`; `dark` 0 day .. 1 night. */
  assign(requests: ReadonlyArray<LightRequest>, focus: THREE.Vector3, dark: number): void {
    scored.length = 0;
    for (const req of requests) {
      if (req.intensity <= 0.001) continue;
      const d = req.pos.distanceTo(focus);
      if (d - req.radius * CUTOFF > MAX_REACH) continue;
      scored.push({ req, score: req.priority * PRIORITY_METERS - d });
    }
    scored.sort((a, b) => b.score - a.score);
    const k = DAY_SHARE + (1 - DAY_SHARE) * dark;
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i]!;
      const s = scored[i];
      if (!s) {
        light.intensity = 0;
        light.visible = true;
        continue;
      }
      light.position.copy(s.req.pos);
      light.color.copy(s.req.color);
      light.distance = s.req.radius * CUTOFF;
      light.intensity = NIGHT_INTENSITY * s.req.intensity * k * (s.req.radius / 5);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const l of this.lights) l.dispose();
  }
}
