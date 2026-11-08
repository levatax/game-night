// Animator smoke tests on the real rigs (node, no WebGL): every scenario stays finite, the tumble
// stands up in time, seeded runs are reproducible and hit-stop freezes the springs.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CHARACTER_IDS, CHARACTERS, DT, KNOCK_GETUP_TICKS } from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";
import type { Animal } from "./Animal";
import { Animator } from "./Animator";
import { buildAnimalModel } from "./models";
import { AnimalMaterials, PartBuilder } from "./parts";
import { createPuppetFrame } from "./puppet";
import type { FaceExpression } from "./types";

interface FakeAnimal {
  animal: Animal;
  faces: Array<[FaceExpression, FaceExpression]>;
}

/** The parts of Animal the Animator touches, built from the real model (no face canvas). */
function makeAnimal(character: CharacterId): FakeAnimal {
  const materials = new AnimalMaterials(CHARACTERS[character].colors, "#3B82F6", {
    eyes: new THREE.Texture(),
    mouth: new THREE.Texture(),
  });
  const built = buildAnimalModel(character, new PartBuilder(materials, { detail: "mid", cacheKey: `anim-test:${character}` }));
  const { root, skeleton: s, extras, springs } = built;
  const faces: Array<[FaceExpression, FaceExpression]> = [];
  const sacScale = new THREE.Vector3(1, 1, 1);
  const bellyScale = new THREE.Vector3(1, 1, 1);
  if (extras.sac) sacScale.copy(extras.sac.scale);
  if (s.belly) bellyScale.copy(s.belly.scale);
  const tail = extras.tail;
  const animal = {
    character,
    rig: {
      root,
      body: s.body,
      head: s.head,
      armL: s.armL,
      armR: s.armR,
      legL: s.legL,
      legR: s.legR,
      extra: s.extra,
      hand: s.hand,
      headTop: s.headTop,
    },
    parts: {
      offset: s.offset,
      spin: s.spin,
      upper: s.upper,
      jaw: extras.jaw,
      sac: extras.sac,
      belly: s.belly,
      ears: extras.ears,
      tailTip: tail[tail.length - 1] ?? null,
      ghostTail: s.ghostTail,
      accessory: extras.accessory,
      springs,
      earR: extras.ears[0] ?? null,
      earL: extras.ears[1] ?? null,
      tail,
      headwear: extras.headwear,
      cheeks: extras.cheeks,
      eyeBulbs: extras.eyeBulbs,
    },
    sacScale,
    bellyScale,
    setFaceParts(eyes: FaceExpression, mouth: FaceExpression) {
      faces.push([eyes, mouth]);
    },
  };
  return { animal: animal as unknown as Animal, faces };
}

function assertFinite(animal: Animal, label: string): void {
  animal.rig.root.traverse((o) => {
    const ok =
      Number.isFinite(o.position.x + o.position.y + o.position.z) &&
      Number.isFinite(o.quaternion.x + o.quaternion.y + o.quaternion.z + o.quaternion.w) &&
      Number.isFinite(o.scale.x + o.scale.y + o.scale.z);
    if (!ok) throw new Error(`${label}: non-finite transform on ${o.name || o.type}`);
  });
}

/** A scripted minute of play: run, reverse (skid), jump, charge + throws, catch, whiff, knockback, roll, ability, emotes. */
function script(anim: Animator, f: PlayerFrame, fake: FakeAnimal, fps: number): void {
  const dt = 1 / fps;
  let t = 0;
  const run = (sec: number, each?: (t: number) => void): void => {
    const end = t + sec;
    while (t < end) {
      t += dt;
      each?.(t);
      fake.animal.rig.root.position.set(f.x, f.y, f.z);
      anim.update(f, dt);
    }
    assertFinite(fake.animal, `${f.character} @${t.toFixed(2)}`);
  };
  run(0.5);
  f.vz = -6;
  run(0.8, () => (f.z += f.vz * dt));
  // Reverse: brake through zero (skid).
  f.skid = true;
  run(0.2, () => {
    f.vz = Math.min(6, f.vz + 80 * dt);
    f.z += f.vz * dt;
  });
  f.skid = false;
  f.vz = 0;
  run(0.3);
  // Jump.
  f.grounded = false;
  f.jumping = true;
  f.vy = 7.48;
  run(0.7, () => {
    f.vy -= 24 * dt;
    f.y = Math.max(0, f.y + f.vy * dt);
  });
  f.grounded = true;
  f.jumping = false;
  f.vy = 0;
  f.y = 0;
  anim.trigger("land", { strength: 0.8 });
  run(0.3);
  // Charge with a mega ball, throw; quick throw; triple.
  f.heldCount = 1;
  f.powerUp = "mega";
  run(1.1, () => (f.chargeTicks = Math.min(30, f.chargeTicks + 1)));
  f.chargeTicks = 0;
  f.powerUp = "";
  anim.trigger("throw", { strength: 1 });
  run(0.6);
  anim.trigger("throw", { strength: 0.05 });
  run(0.3);
  f.powerUp = "triple";
  f.chargeTicks = 10;
  run(0.2);
  f.chargeTicks = 0;
  anim.trigger("throw", { strength: 0.3 });
  run(0.5);
  f.heldCount = 0;
  f.powerUp = "";
  // Catch window → catch; whiff.
  f.catchTicks = 8;
  run(0.2);
  f.catchTicks = 0;
  anim.trigger("catch");
  run(0.8);
  f.whiffTicks = 18;
  anim.trigger("whiff");
  run(0.6, () => (f.whiffTicks = Math.max(0, f.whiffTicks - 1)));
  f.whiffTicks = 0;
  // Knockback with a floor bounce, slide, get-up.
  anim.trigger("hit", { dir: { x: 0, y: 0, z: 1 }, strength: 1 });
  f.stunTicks = 30;
  f.grounded = false;
  f.vx = 0;
  f.vz = 12;
  f.vy = 6;
  run(1.2, (time) => {
    f.stunTicks = Math.max(0, f.stunTicks - dt / DT);
    f.vy -= 18 * dt;
    f.y += f.vy * dt;
    f.z += f.vz * dt;
    if (f.y <= 0) {
      f.y = 0;
      if (f.vy < -5) {
        f.vy = -f.vy * 0.42;
        f.knockBounces = (f.knockBounces + 1) & 255;
      } else {
        f.vy = 0;
        f.grounded = true;
        f.vz = Math.max(0, f.vz - 14 * dt);
      }
    }
    void time;
  });
  f.stunTicks = 0;
  f.vz = 0;
  run(0.4);
  // Roll, ability, emotes, victory.
  f.rollTicks = 9;
  f.dirX = 1;
  run(0.35, () => (f.rollTicks = Math.max(0, f.rollTicks - 1)));
  f.rollTicks = 0;
  f.abilityTicks = 8;
  f.abilityPhase = 1;
  run(0.3, () => (f.abilityTicks = Math.max(0, f.abilityTicks - 1)));
  f.abilityTicks = 0;
  f.abilityPhase = 0;
  anim.trigger("ability");
  run(0.2);
  for (const emote of ["honk", "wave", "dance"] as const) {
    anim.trigger("emote", { emote });
    run(0.5);
  }
  run(10); // idle long enough for fidgets
  anim.trigger("victory");
  run(3.3);
  anim.trigger("ringOut");
  run(0.8);
  anim.reset();
  anim.setGhostMode(true);
  run(1);
}

describe("Animator", () => {
  for (const character of CHARACTER_IDS) {
    it(`${character}: a scripted match stays finite at 30 / 60 / 144 fps`, () => {
      for (const fps of [30, 60, 144]) {
        const fake = makeAnimal(character);
        const anim = new Animator(fake.animal, character, { seed: 42 });
        script(anim, createPuppetFrame(character), fake, fps);
        expect(fake.faces.length).toBeGreaterThan(3);
      }
    });
  }

  it("stands the body upright within 0.2 s of the stun ending (no unwind through the crossfade)", () => {
    for (const character of CHARACTER_IDS) {
      for (const flight of [0.2, 0.37, 0.5, 0.66]) {
        const fake = makeAnimal(character);
        const anim = new Animator(fake.animal, character, { seed: 1 });
        const f = createPuppetFrame(character);
        const dt = 1 / 60;
        anim.update(f, dt);
        anim.trigger("hit", { dir: { x: 0, y: 0, z: 1 }, strength: 0.6 });
        f.stunTicks = 20;
        f.grounded = false;
        f.vz = 8;
        f.vy = 4;
        let t = 0;
        while (t < flight) {
          t += dt;
          anim.update(f, dt);
        }
        f.grounded = true;
        f.vy = 0;
        f.vz = 1;
        for (let k = KNOCK_GETUP_TICKS + 3; k > 0; k--) {
          f.stunTicks = k;
          anim.update(f, DT);
        }
        f.stunTicks = 0;
        f.vz = 0;
        for (let s = 0; s < 0.2; s += dt) anim.update(f, dt);
        const spin = fake.animal.parts.spin.rotation;
        const pitch = Math.abs(Math.atan2(Math.sin(spin.x), Math.cos(spin.x)));
        expect(pitch, `${character} flight ${flight}`).toBeLessThan(0.08);
      }
    }
  });

  it("is reproducible with a seed", () => {
    const a = makeAnimal("whiskers");
    const b = makeAnimal("whiskers");
    const fa = new Animator(a.animal, "whiskers", { seed: 9 });
    const fb = new Animator(b.animal, "whiskers", { seed: 9 });
    const frameA = createPuppetFrame("whiskers");
    const frameB = createPuppetFrame("whiskers");
    for (let i = 0; i < 900; i++) {
      fa.update(frameA, 1 / 60);
      fb.update(frameB, 1 / 60);
    }
    expect(a.faces).toEqual(b.faces);
    expect(a.animal.rig.head.quaternion.angleTo(b.animal.rig.head.quaternion)).toBeLessThan(1e-9);
  });

  it("hit-stop (dt = 0) freezes the pose and the springs", () => {
    const fake = makeAnimal("pip");
    const anim = new Animator(fake.animal, "pip", { seed: 3 });
    const f = createPuppetFrame("pip");
    f.vz = -6;
    for (let i = 0; i < 30; i++) {
      f.z += f.vz / 60;
      fake.animal.rig.root.position.set(f.x, f.y, f.z);
      anim.update(f, 1 / 60);
    }
    const snapshot = fake.animal.parts.springs.map((b) => b.pivot.quaternion.clone());
    anim.update(f, 0);
    anim.update(f, 0);
    fake.animal.parts.springs.forEach((b, i) => expect(b.pivot.quaternion.angleTo(snapshot[i])).toBeLessThan(1e-6));
  });
});
