// Writes a Pose onto a tourist's bone groups. Owner: client-characters. Adapted from
// games/bonk-brawl/client/src/characters/rigPose.ts (bean rig: no jaw / sac / ears; torso puff; extra bone).

import type { Pose } from "./pose";
import type { TouristRig } from "./Tourist";

const MIN_SQUASH = 0.35;

/** Apply every channel of `p` (see pose.ts for the sign conventions). `extraSpin` adds a free spin (propeller). */
export function applyPose(rig: TouristRig, p: Pose, extraSpin = 0): void {
  rig.offset.position.set(0, p.lift, -p.fwd);
  rig.offset.rotation.set(-p.leanX, p.turn, -p.leanZ);

  // Volume-preserving squash & stretch around the feet.
  const sy = Math.max(MIN_SQUASH, 1 + p.crouch);
  const sxz = 1 / Math.sqrt(sy);
  const size = Math.max(0.01, 1 + p.size);
  rig.body.scale.set(sxz * size, sy * size, sxz * size);

  rig.spin.rotation.set(-p.pitch, p.spinY, -p.roll);
  rig.upper.rotation.set(-p.bend, -p.twist, 0);
  rig.head.rotation.set(-p.headX, -p.headY, -p.headZ);

  rig.armR.rotation.set(p.armRX, p.armRY, p.armRZ);
  rig.armL.rotation.set(p.armLX, -p.armLY, -p.armLZ);
  rig.legR.rotation.set(p.legRX, p.legYaw, p.legRZ);
  rig.legL.rotation.set(p.legLX, p.legYaw, -p.legLZ);

  if (rig.extra) rig.extra.rotation.set(p.extraX, p.extraY + extraSpin, p.extraZ);
  if (rig.torso) {
    const puff = Math.max(-0.2, p.puff);
    rig.torso.scale.set(1 + puff, 1 + puff * 0.55, 1 + puff);
  }
}
