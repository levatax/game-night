// The hat / bow / bell / scarf left floating where an animal was knocked out. Owner: client-characters.

import * as THREE from "three";
import { CHARACTERS } from "../../../shared/constants";
import type { CharacterId, Vec3Like } from "../../../shared/types";
import { addOutline } from "../render/Toon";
import { buildMemento } from "./models";
import { AnimalMaterials, OUTLINE_THICKNESS, PartBuilder } from "./parts";
import { easeOutCubic } from "./pose";

/** Pops up from the head, then drifts down to hover at this height above the KO spot. */
const HOVER_Y = 0.6;
const START_Y = 1.25;
const PEAK_Y = 1.9;
const POP_SEC = 0.35;
const SETTLE_SEC = 0.9;
/** Mementos are shown a bit bigger than worn so they read from across the island. */
const MEMENTO_SCALE = 1.5;

export class KoMemento {
  readonly object = new THREE.Group();
  private readonly materials: AnimalMaterials;
  private readonly item: THREE.Group;
  private readonly anchor = new THREE.Vector3();
  private t = 0;
  private readonly spinDir = Math.random() < 0.5 ? -1 : 1;

  constructor(character: CharacterId, slotColor: string, at: Vec3Like) {
    this.materials = new AnimalMaterials(CHARACTERS[character].colors, slotColor);
    this.item = buildMemento(character, new PartBuilder(this.materials));
    for (const outline of addOutline(this.item, OUTLINE_THICKNESS)) outline.material = this.materials.outline;
    this.object.name = `memento:${character}`;
    this.item.scale.setScalar(MEMENTO_SCALE);
    this.object.add(this.item);
    this.anchor.set(at.x, at.y, at.z);
    this.update(0);
  }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    let y: number;
    if (t < POP_SEC) y = START_Y + (PEAK_Y - START_Y) * easeOutCubic(t / POP_SEC);
    else if (t < POP_SEC + SETTLE_SEC) y = PEAK_Y + (HOVER_Y - PEAK_Y) * easeInOutSine((t - POP_SEC) / SETTLE_SEC);
    else y = HOVER_Y + 0.07 * Math.sin((t - POP_SEC - SETTLE_SEC) * 2.4);
    this.object.position.set(this.anchor.x, this.anchor.y + y, this.anchor.z);
    const spin = t < POP_SEC + SETTLE_SEC ? 9 * (1 - t / (POP_SEC + SETTLE_SEC)) + 1 : 1;
    this.item.rotation.y += dt * spin * this.spinDir;
    this.item.rotation.z = 0.18 * Math.sin(t * 1.7);
    this.item.rotation.x = 0.12 * Math.sin(t * 1.3 + 1);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.materials.dispose();
  }
}

function easeInOutSine(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}
