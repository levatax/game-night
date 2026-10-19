// Procedural animation state machine. Owner: client-characters.

import type { CharacterId } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";
import type { Animal } from "./Animal";
import type { AnimTrigger, FaceExpression, TriggerOptions } from "./types";

/**
 * Continuous layer from derivePlayerAction(frame, character): idle (bouncy breathing), run (leg
 * swing + bob, speed from horizontal velocity), jump (stretch) / fall (arms up) / land (squash,
 * triggered on grounded rising edge), charge (wind-up arm back, wobble increasing with charge,
 * shake at full), catch (arms forward ready pose), whiff (flail), roll (tuck + 360° roll along
 * dir), stunned / knockback tumble (spin along velocity), ability per character (flap dash wings,
 * pound tuck/slam, belly-bounce puff-up, slide on belly, headbutt lunge), ghost (float + sway).
 * One-shot layer from trigger(): throw, catch hug, whiff, hit-react spin + dizzy face, pickup,
 * ability flourish, slam squash, emote ×3 (honk / wave / dance), victory dance, ko (pop).
 * Squash & stretch everywhere via rig.body scale (volume-preserving). Expressions: blink every
 * 2–5 s randomly; charging/angry/hurt/dizzy/happy/ko as states dictate.
 * Facing: root yaw follows frame.yaw for the local player and remote players (smoothed 15/s).
 */
export class Animator {
  constructor(animal: Animal, character: CharacterId) {
    void animal;
    void character;
  }

  /** Per frame with cosmetic dt (already scaled by hit-stop/slow-mo). */
  update(frame: PlayerFrame, dt: number): void {
    void frame;
    void dt;
  }

  trigger(anim: AnimTrigger, opts?: TriggerOptions): void {
    void anim;
    void opts;
  }

  get expression(): FaceExpression {
    return "idle";
  }
}
