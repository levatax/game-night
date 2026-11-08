// Registry of the six animal builders. Owner: client-characters.

import * as THREE from "three";
import type { CharacterId } from "../../../../shared/types";
import type { PartBuilder } from "../parts";
import { type BuiltModel, buildSkeleton, type ModelRegistry } from "./common";
import { buildGruff, gruffMemento, gruffSpec } from "./gruff";
import { buildHopsworth, hopsworthMemento, hopsworthSpec } from "./hopsworth";
import { buildMochi, mochiMemento, mochiSpec } from "./mochi";
import { buildPip, pipMemento, pipSpec } from "./pip";
import { buildQuacky, quackyMemento, quackySpec } from "./quacky";
import { buildWhiskers, whiskersMemento, whiskersSpec } from "./whiskers";

const MODELS: ModelRegistry = {
  quacky: { spec: quackySpec, build: buildQuacky, memento: quackyMemento },
  hopsworth: { spec: hopsworthSpec, build: buildHopsworth, memento: hopsworthMemento },
  mochi: { spec: mochiSpec, build: buildMochi, memento: mochiMemento },
  whiskers: { spec: whiskersSpec, build: buildWhiskers, memento: whiskersMemento },
  pip: { spec: pipSpec, build: buildPip, memento: pipMemento },
  gruff: { spec: gruffSpec, build: buildGruff, memento: gruffMemento },
};

/**
 * Build the full rig for `character` under a fresh root (feet at the origin, facing -Z) and merge
 * it (one mesh + one outline per pivot). `beforeFinish` sees the recorded primitives (tests).
 */
export function buildAnimalModel(character: CharacterId, b: PartBuilder, beforeFinish?: (b: PartBuilder) => void): BuiltModel {
  const entry = MODELS[character];
  const { root, skeleton } = buildSkeleton(b, entry.spec);
  const extras = entry.build(b, skeleton);
  beforeFinish?.(b);
  const finished = b.finish(root);
  return { root, skeleton, extras, spec: entry.spec, springs: skeleton.springs.bones, finished };
}

/** The floating KO memento (hat / bow / bell / scarf), centered on its origin, merged. */
export function buildMemento(character: CharacterId, b: PartBuilder): THREE.Group {
  const group = new THREE.Group();
  group.name = `memento:${character}`;
  MODELS[character].memento(b, group);
  b.finish(group);
  return group;
}

/** Body spec (dims, topY) of an animal. */
export function bodySpec(character: CharacterId): ModelRegistry[CharacterId]["spec"] {
  return MODELS[character].spec;
}

export { SPIN_PIVOT_Y } from "./common";
export type { BuiltModel, CharacterExtras, Skeleton } from "./common";
