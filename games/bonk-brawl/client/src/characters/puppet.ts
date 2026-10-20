// Fake PlayerFrames for animals that aren't networked players (menu crowd, lobby preview, dev
// harness). Owner: client-characters.

import { MAX_HEARTS } from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";

/** A standing, alive, idle player frame at the origin facing -Z. */
export function createPuppetFrame(character: CharacterId, id = "puppet", slot = 0): PlayerFrame {
  return {
    id,
    isLocal: false,
    character,
    slot,
    nickname: "",
    hearts: MAX_HEARTS,
    connected: true,
    spectator: false,
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
    rollTicks: 0,
    rollCooldown: 0,
    stunTicks: 0,
    hurtTicks: 0,
    catchTicks: 0,
    catchCooldown: 0,
    whiffTicks: 0,
    chargeTicks: 0,
    throwTicks: 0,
    abilityTicks: 0,
    abilityPhase: 0,
    abilityCooldown: 0,
    zoomiesTicks: 0,
    curveArmed: false,
    powerUp: "",
    heldCount: 0,
    dirX: 0,
    dirZ: 0,
    alive: true,
  };
}
