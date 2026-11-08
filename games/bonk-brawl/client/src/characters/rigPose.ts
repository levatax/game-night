// Writes a Pose onto an Animal's joints. Owner: client-characters.

import type * as THREE from "three";
import type { Animal } from "./Animal";
import type { Pose } from "./pose";

const MIN_SQUASH = 0.35;
const JAW_OPEN = 0.55;

/** Rest transforms captured once per animal (pose channels are offsets from these). */
interface RigRest {
  legLY: number;
  legRY: number;
  armLY: number;
  armRY: number;
}

const RESTS = new WeakMap<Animal, RigRest>();

/** Configure Euler orders and capture rest positions once per animal (turn/twirl first, then lean/pitch). */
export function prepareRig(animal: Animal): void {
  animal.parts.offset.rotation.order = "YXZ";
  animal.parts.spin.rotation.order = "YXZ";
  animal.rig.head.rotation.order = "YXZ";
  const { rig } = animal;
  if (!RESTS.has(animal)) {
    RESTS.set(animal, {
      legLY: rig.legL.position.y,
      legRY: rig.legR.position.y,
      armLY: rig.armL.position.y,
      armRY: rig.armR.position.y,
    });
  }
}

function resetPivot(o: THREE.Object3D): void {
  o.quaternion.identity();
  o.scale.set(1, 1, 1);
}

/** Apply every channel of `p` (see pose.ts for the sign conventions). */
export function applyPose(animal: Animal, p: Pose): void {
  const { rig, parts } = animal;

  // 1. Spring / scale pivots back to their rest transform (the spring rig re-deflects them after).
  const springs = parts.springs;
  for (let i = 0; i < springs.length; i++) resetPivot(springs[i].pivot);
  for (let i = 0; i < parts.cheeks.length; i++) resetPivot(parts.cheeks[i]);
  for (let i = 0; i < parts.eyeBulbs.length; i++) resetPivot(parts.eyeBulbs[i]);

  // 2. Pose channels.
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

  const rest = RESTS.get(animal);
  if (rest) {
    rig.legL.position.y = rest.legLY + Math.max(0, p.legLLift);
    rig.legR.position.y = rest.legRY + Math.max(0, p.legRLift);
  }

  // Tail: rig.extra is segment 0, parts.tail the rest; the curl grows toward the tip.
  const tail = parts.tail;
  const segs = tail.length + 1;
  rig.extra.rotation.set(p.extraX + p.tailCurl / segs, p.extraY, p.extraZ);
  if (tail.length > 0) {
    for (let i = 0; i < tail.length; i++) {
      const w = (i + 2) / segs;
      tail[i].rotation.set(p.tailCurl * w + p.extraX * 0.3, p.extraY * 0.35, p.extraZ * 0.3);
    }
  } else if (parts.tailTip) {
    parts.tailTip.rotation.set(p.extraX * 0.8 - 0.25, p.extraY * 0.7, p.extraZ * 0.5);
  }

  if (parts.jaw) parts.jaw.rotation.x = -JAW_OPEN * Math.max(0, p.jaw);
  if (parts.sac) {
    const s = Math.max(0, p.sac);
    parts.sac.visible = s > 0.02;
    parts.sac.scale.copy(animal.sacScale).multiplyScalar(Math.max(1e-3, s));
  }
  if (parts.belly) parts.belly.scale.copy(animal.bellyScale).multiplyScalar(Math.max(0.2, 1 + p.belly));

  const earR = parts.earR ?? parts.ears[0] ?? null;
  const earL = parts.earL ?? parts.ears[1] ?? null;
  if (earR) earR.rotation.z = -(p.ears + p.earR);
  if (earL) earL.rotation.z = p.ears + p.earL;

  const cheek = Math.max(0.2, 1 + p.cheeks);
  for (let i = 0; i < parts.cheeks.length; i++) parts.cheeks[i].scale.setScalar(cheek);
  const bulb = Math.max(0.15, 1 + p.bulbs);
  for (let i = 0; i < parts.eyeBulbs.length; i++) parts.eyeBulbs[i].scale.set(1, bulb, 1);
}
