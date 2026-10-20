// Decor dispatcher: every DecorItem of the arena by kind, plus per-theme extras (tufts, tub feet).
// Items on the island are baked into (or parented to) the ring segment under them so they fall
// with it; items beyond the edge float in the backdrop.

import type { DecorItem } from "../../../../../shared/maps";
import { createRng, hashString } from "../../noise";
import type { ArenaKit } from "../kit";
import { buildAnts } from "./ants";
import { BubbleRisers, buildFaucet, buildTowelRack } from "./bathDecor";
import { buildBalloon } from "./partyDecor";
import {
  bakeBlanket,
  bakeBush,
  bakeCherry,
  bakeFlowers,
  bakeFoam,
  bakeGrassTufts,
  bakeSprinkles,
  bakeTree,
  bakeTubFeet,
} from "./staticDecor";

export function buildDecor(kit: ArenaKit): void {
  const def = kit.def;
  const foam: DecorItem[] = [];
  let balloons = 0;
  def.decor.forEach((item, i) => {
    const rng = createRng(hashString(`${def.id}:decor:${i}`));
    switch (item.kind) {
      case "tree":
        return bakeTree(kit, item, rng);
      case "bush":
        return bakeBush(kit, item, rng);
      case "flower":
        return bakeFlowers(kit, item, rng);
      case "blanket":
        return bakeBlanket(kit, item, rng);
      case "ants":
        return buildAnts(kit, item);
      case "faucet":
        return buildFaucet(kit, item);
      case "bubbles":
        foam.push(item);
        return bakeFoam(kit, item, rng);
      case "towel":
        return buildTowelRack(kit, item);
      case "sprinkles":
        return bakeSprinkles(kit, item, rng);
      case "balloon":
        return buildBalloon(kit, item, balloons++);
      case "cherry":
        return bakeCherry(kit, item, rng);
    }
  });
  if (foam.length > 0) kit.animate(new BubbleRisers(kit, foam));
  const extras = createRng(hashString(`${def.id}:extras`));
  if (def.theme.floorKind === "grass") bakeGrassTufts(kit, extras);
  if (def.theme.floorKind === "tile") bakeTubFeet(kit);
}
