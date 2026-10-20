// Builds every cover piece of an arena by `kind`. Cover never falls (it sits inside ring 0), so
// pieces hang off one group. Visual footprint == collision footprint (see each builder).

import * as THREE from "three";
import type { CoverDef } from "../../../../shared/maps";
import { createRng, hashString } from "../noise";
import type { ArenaKit } from "./kit";
import { buildRubberDuck, buildShampooBottle, buildSoapBar } from "./props/bath";
import { buildCandle, buildStrawberry } from "./props/cake";
import { placeOnCover, type PropBuild, type PropContext } from "./props/common";
import { buildBasket, buildPicnicTable, buildWatermelon } from "./props/picnic";

export function buildCover(kit: ArenaKit): THREE.Group {
  const group = new THREE.Group();
  group.name = "cover";
  let candles = 0;
  kit.def.cover.forEach((cover, i) => {
    const ctx: PropContext = { kit, rng: createRng(hashString(`${kit.def.id}:cover:${i}`)) };
    const built = buildPiece(ctx, cover, cover.kind === "candle" ? candles++ : 0);
    if (!built) return;
    placeOnCover(built.object, cover);
    built.object.userData.coverIndex = i;
    group.add(built.object);
    for (const a of built.animated ?? []) kit.animate(a);
  });
  return group;
}

/** Shape mismatches (a kind authored with the other footprint shape) fall back to a plain block. */
function buildPiece(ctx: PropContext, c: CoverDef, candleIndex: number): PropBuild | null {
  switch (c.kind) {
    case "picnicTable":
      return c.shape === "box" ? buildPicnicTable(ctx, c) : fallbackBlock(ctx, c);
    case "watermelon":
      return c.shape === "box" ? buildWatermelon(ctx, c) : fallbackBlock(ctx, c);
    case "basket":
      return c.shape === "cylinder" ? buildBasket(ctx, c) : fallbackBlock(ctx, c);
    case "rubberDuck":
      return c.shape === "cylinder" ? buildRubberDuck(ctx, c) : fallbackBlock(ctx, c);
    case "soapBar":
      return c.shape === "box" ? buildSoapBar(ctx, c) : fallbackBlock(ctx, c);
    case "shampooBottle":
      return c.shape === "cylinder" ? buildShampooBottle(ctx, c) : fallbackBlock(ctx, c);
    case "candle":
      return c.shape === "cylinder" ? buildCandle(ctx, c, candleIndex) : fallbackBlock(ctx, c);
    case "strawberry":
      return c.shape === "cylinder" ? buildStrawberry(ctx, c) : fallbackBlock(ctx, c);
  }
}

/** Plain toon prism with the exact collision shape (keeps gameplay honest for odd data). */
function fallbackBlock(ctx: PropContext, c: CoverDef): PropBuild {
  const geometry =
    c.shape === "cylinder"
      ? new THREE.CylinderGeometry(c.radius, c.radius, c.height, 20)
      : new THREE.BoxGeometry(c.halfX * 2, c.height, c.halfZ * 2);
  geometry.translate(0, c.height / 2, 0);
  const mesh = new THREE.Mesh(ctx.kit.bank.geo(geometry), ctx.kit.bank.toonColor(ctx.kit.def.theme.pedestalColor));
  mesh.receiveShadow = true;
  const group = new THREE.Group();
  group.add(mesh);
  return { object: group };
}
