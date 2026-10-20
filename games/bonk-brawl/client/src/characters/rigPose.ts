// Writes a Pose onto an Animal's joints. Owner: client-characters.

import type { Animal } from "./Animal";
import type { Pose } from "./pose";

const MIN_SQUASH = 0.35;
const JAW_OPEN = 0.55;

/** Configure Euler orders once per animal (turn/twirl first, then lean/pitch). */
export function prepareRig(animal: Animal): void {
  animal.parts.offset.rotation.order = "YXZ";
  animal.parts.spin.rotation.order = "YXZ";
  animal.rig.head.rotation.order = "YXZ";
}

/** Apply every channel of `p` (see pose.ts for the sign conventions). */
export function applyPose(animal: Animal, p: Pose): void {
  const { rig, parts } = animal;

  parts.offset.position.set(0, p.lift, -p.fwd);
  parts.offset.rotation.set(-p.leanX, p.turn, -p.leanZ);

  // Volume-preserving squash & stretch around the feet.
  const sy = Math.max(MIN_SQUASH, 1 + p.crouch);
  const sxz = 1 / Math.sqrt(sy);
  const size = Math.max(0.01, 1 + p.size);
  rig.body.scale.set(sxz * size, sy * size, sxz * size);

  parts.spin.rotation.set(-p.pitch, p.spinY, -p.roll);
  parts.upper.rotation.set(-p.bend, -p.twist, 0);
  rig.head.rotation.set(-p.headX, -p.headY, -p.headZ);

  rig.armR.rotation.set(p.armRX, p.armRY, p.armRZ);
  rig.armL.rotation.set(p.armLX, -p.armLY, -p.armLZ);
  rig.legR.rotation.set(p.legRX, p.legYaw, p.legRZ);
  rig.legL.rotation.set(p.legLX, p.legYaw, -p.legLZ);

  rig.extra.rotation.set(p.extraX, p.extraY, p.extraZ);
  if (parts.tailTip) parts.tailTip.rotation.set(p.extraX * 0.8 - 0.25, p.extraY * 0.7, p.extraZ * 0.5);

  if (parts.jaw) parts.jaw.rotation.x = -JAW_OPEN * Math.max(0, p.jaw);
  if (parts.sac) {
    const s = Math.max(0, p.sac);
    parts.sac.visible = s > 0.02;
    parts.sac.scale.copy(animal.sacScale).multiplyScalar(Math.max(1e-3, s));
  }
  if (parts.belly) parts.belly.scale.copy(animal.bellyScale).multiplyScalar(1 + p.belly);

  const ears = parts.ears;
  for (let i = 0; i < ears.length; i++) ears[i].rotation.z = i === 0 ? -p.ears : p.ears;
}
