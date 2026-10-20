// The red police siren lamp on the back wall (§2, §14): a rotating beacon under a red glass dome on an iron
// bracket. setChance(raid chance 0..0.95): off at 0, then it glows and turns faster and faster; two additive
// beams sweep the room. `pulse` (0..1, peaks when a beam faces the table) drives the red room flood in Stage.
// The sweeping red spot is Stage's shared accent spot light: the siren publishes spotPos / spotTarget /
// spotIntensity. Reduced flashing: no sweep strobe, the flood breathes slowly instead. The static body is one
// StaticBatch; only the rotor turns.

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { toon } from "../toon";
import { StaticBatch } from "./batch";
import { SIREN_POS } from "./layout";
import { coneTexture, softDotTexture } from "./textures";

const SPOT_INTENSITY = 26;

export class Siren {
  readonly group = new THREE.Group();
  /** Sweeping spot (world): where it sits, where it points and how bright it is (Stage's accent spot). */
  readonly spotPos = new THREE.Vector3(SIREN_POS.x, SIREN_POS.y + 0.07, SIREN_POS.z + 0.36);
  readonly spotTarget = new THREE.Vector3(SIREN_POS.x, SIREN_POS.y - 0.07, SIREN_POS.z + 1.36);
  spotIntensity = 0;
  /** Smoothed chance 0..1. */
  level = 0;
  /** 0..1 flood pulse (beam facing the room). */
  pulse = 0;
  private target = 0;
  private rotor = new THREE.Group();
  private angle = 0;
  private domeMat: THREE.MeshToonMaterial;
  private beams: THREE.Mesh[] = [];
  private beamMats: THREE.MeshBasicMaterial[] = [];
  private glow: THREE.Sprite;
  private power = 1;

  constructor() {
    this.group.position.copy(SIREN_POS);
    const body = new StaticBatch();
    const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const iron = toon("#3A3540");
    body.addAt(new THREE.BoxGeometry(0.22, 0.3, 0.03), iron, v3(0, 0, 0.015), null, 1, { outline: 1.05 });
    body.addAt(new THREE.BoxGeometry(0.06, 0.05, 0.26), iron, v3(0, -0.08, 0.14), null, 1, { outline: 1.08 });
    body.addAt(new THREE.CylinderGeometry(0.15, 0.16, 0.07, 20), toon("#2A262E"), v3(0, -0.02, 0.28), null, 1, { outline: 1.05 });
    const bolts = toon("#8A8590");
    for (const [x, y] of [[-0.07, 0.1], [0.07, 0.1], [-0.07, -0.1], [0.07, -0.1]] as const) {
      body.addAt(new THREE.SphereGeometry(0.015, 6, 4), bolts, v3(x, y, 0.05), null, 1, { outline: 1.05 });
    }
    this.domeMat = toon("#E5383B", { emissive: PALETTE.siren, emissiveIntensity: 0.1, unique: true });
    body.addAt(new THREE.SphereGeometry(0.13, 22, 14, 0, Math.PI * 2, 0, Math.PI / 2), this.domeMat, v3(0, 0.05, 0.28), null, 1, { outline: 1.06 });
    body.addAt(new THREE.CylinderGeometry(0.135, 0.135, 0.06, 22), this.domeMat, v3(0, 0.03, 0.28));
    const wire = toon("#2A262E");
    for (let i = 0; i < 4; i++) {
      body.addAt(new THREE.TorusGeometry(0.14, 0.006, 4, 16, Math.PI), wire, v3(0, 0.06, 0.28), new THREE.Euler(0, (i / 4) * Math.PI, 0));
    }
    this.group.add(body.build("sirenBody"));

    // rotor: reflector + two opposite beams + the sweeping spotlight
    this.rotor.position.set(0, 0.07, 0.28);
    const reflector = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 12, 1, true, 0, Math.PI), toon("#FFD27A", { side: THREE.DoubleSide }));
    reflector.userData.noOutline = true;
    this.rotor.add(reflector);
    const coneTex = coneTexture();
    for (const s of [1, -1]) {
      const mat = new THREE.MeshBasicMaterial({
        map: coneTex,
        color: PALETTE.siren,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.42, 1.8, 18, 1, true), mat);
      // cylinder +y → beam direction (+x or −x), narrow end at the bulb
      beam.rotation.z = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      beam.position.x = s * 0.9;
      beam.renderOrder = 6;
      beam.raycast = () => {};
      beam.visible = false;
      this.rotor.add(beam);
      this.beams.push(beam);
      this.beamMats.push(mat);
    }
    this.group.add(this.rotor);

    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDotTexture(), color: PALETTE.siren, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0, fog: false }));
    this.glow.position.set(0, 0.06, 0.3);
    this.glow.scale.setScalar(0.8);
    this.glow.renderOrder = 6;
    this.glow.visible = false;
    this.group.add(this.glow);
  }

  setChance(chance: number): void {
    this.target = Math.max(0, Math.min(1, chance));
  }

  /** Global multiplier (lights out = 0). */
  setPower(p: number): void {
    this.power = p;
  }

  update(dt: number, time: number, reducedFlashing: boolean): void {
    this.level += (this.target - this.level) * (1 - Math.exp(-4 * dt));
    const on = this.level > 0.01 ? Math.min(1, this.level / 0.08) : 0;
    const speed = 0.8 + this.level * 13;
    this.angle += speed * dt * on;
    this.rotor.rotation.y = this.angle;
    // beam facing the room (+z) → pulse; two beams = two pulses per turn
    const facing = Math.abs(Math.sin(this.angle));
    const sweep = Math.pow(facing, 6);
    if (reducedFlashing) this.pulse = 0.65 + Math.sin(time * 1.6) * 0.15;
    else this.pulse = sweep;
    const p = on * this.power;
    const intensity = p * (0.25 + this.level * 0.75);
    this.domeMat.emissiveIntensity = 0.1 + intensity * (reducedFlashing ? 1.2 : 0.8 + sweep * 1.2);
    const beamAlpha = reducedFlashing ? 0.12 : 0.28;
    for (let i = 0; i < this.beams.length; i++) {
      const a = beamAlpha * intensity;
      this.beamMats[i]!.opacity = a;
      this.beams[i]!.visible = a > 0.002;
    }
    this.glow.material.opacity = intensity * (reducedFlashing ? 0.55 : 0.4 + sweep * 0.5);
    this.glow.visible = this.glow.material.opacity > 0.002;
    this.glow.scale.setScalar(0.6 + intensity * 0.6);
    // the sweeping spot follows whichever beam faces the room (never lights the wall it hangs on)
    let dx = Math.cos(this.angle);
    let dz = -Math.sin(this.angle);
    if (dz < 0) {
      dx = -dx;
      dz = -dz;
    }
    this.spotTarget.set(this.spotPos.x + dx, this.spotPos.y - 0.14, this.spotPos.z + dz);
    const roomward = THREE.MathUtils.smoothstep(dz, 0.15, 0.6);
    this.spotIntensity = SPOT_INTENSITY * intensity * (reducedFlashing ? 0.35 : roomward);
  }
}
