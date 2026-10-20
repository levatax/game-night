// The one warm lamp over the table: a green enamel billiard shade on a cord out of a round well in the
// ceiling, swinging lazily like a slow pendulum. Inside it a SpotLight (#FFD9A0, the scene's only shadow
// caster) and a faint additive light cone that shows the cigar haze. Lights out (wheel): the shade is hoisted
// all the way up into the well (out of every shot, the swing settles, the light fades out as it goes in); on
// return it drops back with a bounce and flickers on. The shade is one StaticBatch riding the swing (~6 draws).

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { toon } from "../toon";
import { StaticBatch } from "./batch";
import { CEILING_Y, LAMP_HOIST_Y, LAMP_SHADE_Y, LAMP_WELL_DEPTH, TABLE_TOP_Y } from "./layout";
import { coneTexture } from "./textures";

const BASE_INTENSITY = 38;
/** Shade top (cap) and rim heights relative to the shade center. */
const SHADE_TOP = 0.2;
const SHADE_RIM = 0.13;

export class Lamp {
  readonly group = new THREE.Group();
  readonly spot: THREE.SpotLight;
  /** Brightness multiplier set by Stage (moods); 0 = off. */
  power = 1;
  /** Extra swing kick (raids, slams). */
  private swing = 0;
  private swingVel = 0;
  private swingZ = 0;
  private swingZVel = 0;
  private hang = new THREE.Group();
  /** Swinging cord from the pivot (the well's mouth) down to the shade. */
  private cord: THREE.Mesh;
  /** Fixed cord up the well to the rose. */
  private wellCord: THREE.Mesh;
  private cone: THREE.Mesh;
  private bulbMat = new THREE.MeshBasicMaterial({ color: "#FFF1C8" });
  private innerMat: THREE.MeshToonMaterial;
  private coneMat: THREE.MeshBasicMaterial;
  private baseColor = new THREE.Color(PALETTE.lamp);
  private tint = new THREE.Color(PALETTE.lamp);
  private shadeY = LAMP_SHADE_Y;
  private shadeVel = 0;
  private hoisted = false;
  private flickerT = 0;

  constructor() {
    this.group.position.set(0, CEILING_Y, 0);
    // the rose sits at the top of the well; the pivot is at the well's mouth (the ceiling plane)
    const roseBatch = new StaticBatch();
    roseBatch.addAt(new THREE.CylinderGeometry(0.07, 0.09, 0.05, 12), toon("#B8862E"), new THREE.Vector3(0, LAMP_WELL_DEPTH - 0.025, 0), null, 1, { outline: 1.06 });
    const rose = roseBatch.build("lampRose");
    const cordGeo = new THREE.CylinderGeometry(0.009, 0.009, 1, 6);
    cordGeo.translate(0, -0.5, 0);
    this.cord = new THREE.Mesh(cordGeo, toon(PALETTE.ink));
    this.cord.userData.noOutline = true;
    this.wellCord = new THREE.Mesh(cordGeo, this.cord.material);
    this.wellCord.userData.noOutline = true;
    this.wellCord.position.y = LAMP_WELL_DEPTH - 0.05;

    // shade (one batch riding the swing): green enamel outside, cream enamel inside, brass cap, ink rim
    const shadeBatch = new StaticBatch();
    const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const flat = new THREE.Euler(Math.PI / 2, 0, 0);
    shadeBatch.addAt(new THREE.CylinderGeometry(0.1, 0.36, 0.26, 28, 1, true), toon("#1E6B3A", { side: THREE.FrontSide }), at(0, 0, 0));
    this.innerMat = toon("#FFF1D0", { side: THREE.BackSide, emissive: "#FFD9A0", emissiveIntensity: 0.55, unique: true });
    shadeBatch.addAt(new THREE.CylinderGeometry(0.098, 0.355, 0.255, 28, 1, true), this.innerMat, at(0, 0, 0));
    shadeBatch.addAt(new THREE.CylinderGeometry(0.06, 0.1, 0.07, 16), toon("#C99A3A"), at(0, 0.16, 0), null, 1, { outline: 1.08 });
    shadeBatch.addAt(new THREE.SphereGeometry(0.035, 10, 8), toon("#C99A3A"), at(0, 0.21, 0), null, 1, { outline: 1.1 });
    shadeBatch.addAt(new THREE.TorusGeometry(0.36, 0.012, 5, 40), toon(PALETTE.ink), at(0, -0.13, 0), flat);
    shadeBatch.addAt(new THREE.TorusGeometry(0.1, 0.01, 5, 20), toon(PALETTE.ink), at(0, 0.13, 0), flat);
    shadeBatch.addAt(new THREE.SphereGeometry(0.075, 14, 10), this.bulbMat, at(0, -0.06, 0));

    // fake volumetric cone (additive, very faint)
    const coneH = LAMP_SHADE_Y - TABLE_TOP_Y - 0.1;
    this.coneMat = new THREE.MeshBasicMaterial({
      map: coneTexture(),
      color: PALETTE.lamp,
      transparent: true,
      opacity: 0.09,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 1.25, coneH, 32, 1, true), this.coneMat);
    cone.position.y = -0.13 - coneH / 2;
    cone.renderOrder = 5;
    cone.userData.noOutline = true;
    cone.raycast = () => {};
    this.cone = cone;

    const shade = new THREE.Group();
    shade.add(shadeBatch.build("lampShade"), cone);
    this.hang.add(this.cord, shade);
    this.group.add(rose, this.wellCord, this.hang);

    this.spot = new THREE.SpotLight(PALETTE.lamp, BASE_INTENSITY, 7.5, 0.95, 0.55, 1.35);
    this.spot.position.y = -0.08;
    this.spot.target.position.set(0, -6, 0);
    this.spot.shadow.camera.near = 0.3;
    this.spot.shadow.camera.far = 6;
    this.spot.shadow.bias = -0.0006;
    this.spot.shadow.normalBias = 0.025;
    this.spot.shadow.radius = 3;
    shade.add(this.spot, this.spot.target);
    this.layoutCord();
  }

  /** Shade at shadeY; the swinging cord runs from the pivot to the cap, the well cord from the rose to the cap / pivot. */
  private layoutCord(): void {
    const top = this.shadeY + SHADE_TOP - CEILING_Y;
    const shade = this.hang.children[1]!;
    shade.position.y = this.shadeY - CEILING_Y;
    this.cord.visible = top < -0.01;
    this.cord.scale.y = Math.max(0.01, -top);
    this.wellCord.scale.y = Math.max(0.01, LAMP_WELL_DEPTH - 0.05 - Math.max(0, top));
  }

  /** A shove (door slam, fist on the table): the lamp swings harder. */
  kick(strength: number): void {
    this.swingVel += (Math.random() < 0.5 ? -1 : 1) * strength * 0.9;
    this.swingZVel += (Math.random() - 0.5) * strength * 0.6;
  }

  /** Lights out: hoist the lamp to the ceiling (and back down when false, with a flicker). */
  setHoisted(on: boolean): void {
    if (on === this.hoisted) return;
    this.hoisted = on;
    if (!on) this.flickerT = 0.9;
  }

  /** Lamp color target (final table warms it toward red). */
  setTint(color: THREE.Color): void {
    this.tint.copy(color);
  }

  update(dt: number, time: number, reducedFlashing: boolean): void {
    // two damped pendulums (x and z), nudged by a lazy draft; hoisted, they settle (the shade must clear the well)
    const g = 9.81 / Math.max(0.4, CEILING_Y - this.shadeY + 0.2);
    const draftX = Math.sin(time * 0.37) * 0.04 + Math.sin(time * 0.11) * 0.03;
    const draftZ = Math.cos(time * 0.29) * 0.025;
    this.swingVel += (-g * this.swing + draftX) * dt;
    this.swingVel *= Math.max(0, 1 - 0.35 * dt);
    this.swing += this.swingVel * dt;
    this.swingZVel += (-g * this.swingZ + draftZ) * dt;
    this.swingZVel *= Math.max(0, 1 - 0.35 * dt);
    this.swingZ += this.swingZVel * dt;
    if (this.hoisted) {
      const settle = Math.exp(-6 * dt);
      this.swing *= settle;
      this.swingVel *= settle;
      this.swingZ *= settle;
      this.swingZVel *= settle;
    }
    this.hang.rotation.z = this.swing;
    this.hang.rotation.x = this.swingZ;

    // hoist spring: straight up into the well (critically damped, no overshoot through its top), back down
    // with a bounce
    const target = this.hoisted ? LAMP_HOIST_Y : LAMP_SHADE_Y;
    this.shadeVel += ((target - this.shadeY) * 40 - this.shadeVel * (this.hoisted ? 12.6 : 7)) * dt;
    this.shadeY += this.shadeVel * dt;
    this.layoutCord();
    // 0 = hanging in the room .. 1 = rim inside the well: the light goes out as it goes in
    const sunk = Math.max(0, Math.min(1, (this.shadeY - SHADE_RIM - (CEILING_Y - 0.45)) / 0.45));

    // flicker when the lamp comes back on
    let flick = 1;
    if (this.flickerT > 0) {
      this.flickerT = Math.max(0, this.flickerT - dt);
      if (!reducedFlashing) flick = Math.sin(this.flickerT * 47) > -0.2 ? 1 : 0.15;
      else flick = 1 - this.flickerT * 0.6;
    }
    const hum = 1 + Math.sin(time * 31) * 0.008;
    const p = Math.max(0, this.power) * flick * hum * (1 - sunk);
    this.baseColor.lerp(this.tint, 1 - Math.exp(-3 * dt));
    this.spot.color.copy(this.baseColor);
    this.spot.intensity = BASE_INTENSITY * p;
    this.bulbMat.color.setRGB(1, 0.94, 0.78).multiplyScalar(0.25 * (1 - sunk) + 0.75 * Math.min(1, p));
    this.innerMat.emissiveIntensity = 0.55 * Math.min(1, p);
    this.coneMat.opacity = 0.085 * Math.min(1, p);
    this.coneMat.color.copy(this.baseColor);
    this.cone.visible = this.coneMat.opacity > 0.002;
  }
}
