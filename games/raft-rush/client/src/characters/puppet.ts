// Fake PlayerFrames for tourists that aren't networked players (portraits, the dev harness, the Animator's
// initial motion info). Owner: client-characters. Adapted from games/bonk-brawl/client/src/characters/puppet.ts.

import { MAX_HP } from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";

/** A standing, alive, idle player frame at the origin facing −Z with full bars and empty hands. */
export function createPuppetFrame(character: CharacterId, id = "puppet", seat = 0): PlayerFrame {
  return {
    id,
    isLocal: false,
    character,
    seat,
    team: 0,
    nickname: "",
    bot: false,
    connected: true,
    spectator: false,
    washed: false,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    grounded: true,
    airTicks: 0,
    stunTicks: 0,
    chargeTicks: 0,
    throwTicks: 0,
    catchTicks: 0,
    catchCooldown: 0,
    channel: 0,
    channelTicks: 0,
    channelTarget: -1,
    swimming: false,
    swimTicks: 0,
    sprinting: false,
    activeSlot: 0,
    inv0: "",
    inv1: "",
    inv2: "",
    inv3: "",
    cnt0: 0,
    cnt1: 0,
    cnt2: 0,
    cnt3: 0,
    hp: MAX_HP,
    hunger: 100,
    thirst: 100,
    warmth: 100,
    alive: true,
    downed: false,
    boarded: false,
    loadMult: 100,
    fishState: 0,
    fishSpot: -1,
    fuseTicks: 0,
    torchTicks: 0,
    cosmetic: "",
    golden: false,
    speed: 0,
  };
}

/** The active inventory kind of a frame. */
export function heldKindOf(f: PlayerFrame): PlayerFrame["inv0"] {
  switch (f.activeSlot) {
    case 1:
      return f.inv1;
    case 2:
      return f.inv2;
    case 3:
      return f.inv3;
    default:
      return f.inv0;
  }
}

/** The active slot's count. */
export function heldCountOf(f: PlayerFrame): number {
  switch (f.activeSlot) {
    case 1:
      return f.cnt1;
    case 2:
      return f.cnt2;
    case 3:
      return f.cnt3;
    default:
      return f.cnt0;
  }
}
