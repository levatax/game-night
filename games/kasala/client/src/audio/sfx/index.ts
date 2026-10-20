// Every SfxId → its synthesized recipe. The Record type makes a missing id a compile error.

import type { SfxId } from "../AudioEngine";
import { CASINO, type Recipe } from "./casino";
import { EMOTES } from "./emotes";
import { POLICE } from "./police";
import { UI } from "./ui";

export type { Recipe } from "./casino";
export { wheelPeg } from "./casino";
export { thump } from "./emotes";

export const SFX: Record<SfxId, Recipe> = { ...CASINO, ...POLICE, ...EMOTES, ...UI };

/** Minimum gap between two identical one-shots (stops spam from stacking into mush). */
export const MIN_GAP: Partial<Record<SfxId, number>> = {
  hover: 0.04,
  click: 0.03,
  tick: 0.08,
  chips: 0.05,
  coins: 0.06,
  pop: 0.03,
  flip: 0.08,
  deal: 0.05,
  siren: 0.6,
  doorBreak: 0.4,
  heartbeat: 0.25,
  choir: 0.5,
  drumroll: 0.5,
  cymbal: 0.15,
  glassBreak: 0.5,
  kaching: 0.08,
};
