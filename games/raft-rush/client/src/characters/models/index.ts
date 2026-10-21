// Registry of the six Ship Tourists: proportions + build functions, baked once per character and shared by
// every instance (avatars, portraits, the dev harness). Owner: client-characters.

import { CHARACTERS } from "../../../../shared/constants";
import type { CharacterId } from "../../../../shared/types";
import { amcaSpec, buildAmca } from "./amca";
import { buildCocuk, cocukSpec } from "./cocuk";
import { ModelBuilder, type TouristBake, type TouristSpec } from "./common";
import { buildFenomen, fenomenSpec } from "./fenomen";
import { buildGelin, gelinSpec } from "./gelin";
import { buildKaptan, kaptanSpec } from "./kaptan";
import { buildSef, sefSpec } from "./sef";

interface ModelEntry {
  spec: TouristSpec;
  build: (b: ModelBuilder) => void;
}

const MODELS: Record<CharacterId, ModelEntry> = {
  kaptan: { spec: kaptanSpec, build: buildKaptan },
  fenomen: { spec: fenomenSpec, build: buildFenomen },
  amca: { spec: amcaSpec, build: buildAmca },
  gelin: { spec: gelinSpec, build: buildGelin },
  sef: { spec: sefSpec, build: buildSef },
  cocuk: { spec: cocukSpec, build: buildCocuk },
};

const bakes = new Map<CharacterId, TouristBake>();

/** The baked geometry set of a character (built on first use, then shared). */
export function getTouristBake(character: CharacterId): TouristBake {
  let bake = bakes.get(character);
  if (!bake) {
    const entry = MODELS[character];
    const builder = new ModelBuilder(entry.spec, CHARACTERS[character].colors);
    entry.build(builder);
    bake = builder.bake();
    bakes.set(character, bake);
  }
  return bake;
}

export function touristSpec(character: CharacterId): TouristSpec {
  return MODELS[character].spec;
}

export { SPIN_Y } from "./common";
export type { BoneName, TouristBake, TouristSpec } from "./common";
export { SELFIE_STICK_DIR } from "./fenomen";
