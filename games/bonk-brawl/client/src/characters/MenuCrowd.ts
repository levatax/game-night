// Home-screen crowd of bouncing animals for render/MenuScene. Owner: client-characters.

import type * as THREE from "three";
import {
  CHARACTER_IDS,
  CHARGE_FULL_TICKS,
  EMOTE_IDS,
  GRAVITY,
  JUMP_VELOCITY,
  KNOCKBACK_STUN_TICKS,
  playerColor,
  TICK_RATE,
} from "../../../shared/constants";
import type { ArenaDef } from "../../../shared/maps";
import type { MenuCrowdFactory } from "../render/MenuScene";
import { Animal } from "./Animal";
import { Animator } from "./Animator";
import { createPuppetFrame } from "./puppet";
import type { PlayerFrame } from "../net/types";
import { createBlobShadow, type BlobShadow } from "./shadowBlob";

/** Animals stay inside this fraction of the island radius. */
const ROAM_FRACTION = 0.62;
const STROLL_SPEED = 3.2;
const RUN_SPEED = 5.5;
const ACCEL = 14;
const PERSONAL_SPACE = 1.1;
const COVER_MARGIN = 0.8;
const MAX_DT = 0.1;

type Activity = "wait" | "walk" | "windup" | "stunned";

interface Pending {
  at: number;
  run: () => void;
}

class CrowdMember {
  readonly animal: Animal;
  readonly animator: Animator;
  readonly frame: PlayerFrame;
  readonly shadow: BlobShadow;
  activity: Activity = "wait";
  timer: number;
  targetX = 0;
  targetZ = 0;
  speed = STROLL_SPEED;
  victim: CrowdMember | null = null;
  chargeSec = 0;
  stunSec = 0;

  constructor(index: number, x: number, z: number) {
    const character = CHARACTER_IDS[index % CHARACTER_IDS.length];
    this.animal = new Animal(character, playerColor(index));
    this.animator = new Animator(this.animal, character);
    this.frame = createPuppetFrame(character, `crowd${index}`, index);
    this.frame.x = x;
    this.frame.z = z;
    this.frame.yaw = Math.atan2(x, z);
    this.shadow = createBlobShadow(0.55, 0.28);
    this.timer = 0.5 + Math.random() * 2;
  }

  dispose(): void {
    this.shadow.dispose();
    this.animal.dispose();
  }
}

/** Wandering, hopping, emoting animals that pretend-throw at each other (no balls needed). */
class MenuCrowd {
  private readonly members: CrowdMember[] = [];
  private readonly roamRadius: number;
  private readonly pending: Pending[] = [];
  private clock = 0;

  constructor(
    scene: THREE.Scene,
    private readonly arena: ArenaDef,
  ) {
    this.roamRadius = arena.ringRadii[arena.ringRadii.length - 1] * ROAM_FRACTION;
    CHARACTER_IDS.forEach((_, i) => {
      const a = (i / CHARACTER_IDS.length) * Math.PI * 2 + 0.4;
      const r = this.roamRadius * (0.45 + 0.35 * Math.random());
      const [x, z] = this.freeSpot(Math.sin(a) * r, Math.cos(a) * r);
      const m = new CrowdMember(i, x, z);
      scene.add(m.animal.rig.root, m.shadow.mesh);
      this.members.push(m);
    });
  }

  update(dt: number): void {
    const step = Math.min(MAX_DT, Math.max(0, dt));
    this.clock += step;
    this.runPending();
    for (const m of this.members) {
      this.think(m, step);
      this.move(m, step);
    }
    this.separate();
    for (const m of this.members) {
      const f = m.frame;
      m.animator.update(f, step);
      m.animal.rig.root.position.set(f.x, f.y, f.z);
      m.shadow.mesh.position.set(f.x, 0.01, f.z);
      m.shadow.setLift(f.y);
    }
  }

  dispose(): void {
    for (const m of this.members) m.dispose();
    this.members.length = 0;
    this.pending.length = 0;
  }

  /* -------------------------------------------------------------- brain */

  private think(m: CrowdMember, dt: number): void {
    m.timer -= dt;
    switch (m.activity) {
      case "wait":
        if (m.timer <= 0) this.pickActivity(m);
        return;
      case "walk":
        if (Math.hypot(m.targetX - m.frame.x, m.targetZ - m.frame.z) < 0.4 || m.timer <= 0) this.rest(m);
        return;
      case "windup":
        this.windUp(m, dt);
        return;
      case "stunned":
        m.stunSec -= dt;
        m.frame.stunTicks = Math.max(0, Math.round(m.stunSec * TICK_RATE));
        if (m.stunSec <= 0 && m.frame.grounded) this.rest(m);
        return;
    }
  }

  private pickActivity(m: CrowdMember): void {
    const roll = Math.random();
    if (roll < 0.45) this.walkSomewhere(m);
    else if (roll < 0.62) this.hop(m);
    else if (roll < 0.8) this.emote(m);
    else this.startThrow(m);
  }

  private rest(m: CrowdMember): void {
    m.activity = "wait";
    m.timer = 0.6 + Math.random() * 1.8;
    m.frame.chargeTicks = 0;
  }

  private walkSomewhere(m: CrowdMember): void {
    const a = Math.random() * Math.PI * 2;
    const r = this.roamRadius * Math.sqrt(Math.random());
    [m.targetX, m.targetZ] = this.freeSpot(Math.sin(a) * r, Math.cos(a) * r);
    m.speed = Math.random() < 0.3 ? RUN_SPEED : STROLL_SPEED;
    m.activity = "walk";
    m.timer = 6;
  }

  private hop(m: CrowdMember): void {
    if (m.frame.grounded) {
      m.frame.vy = JUMP_VELOCITY * (0.7 + 0.3 * Math.random());
      m.frame.grounded = false;
    }
    m.timer = 0.9;
  }

  private emote(m: CrowdMember): void {
    m.animator.trigger("emote", { emote: EMOTE_IDS[Math.floor(Math.random() * EMOTE_IDS.length)] });
    m.timer = 2.2;
  }

  private startThrow(m: CrowdMember): void {
    const others = this.members.filter((o) => o !== m && o.activity !== "stunned");
    if (others.length === 0) {
      this.rest(m);
      return;
    }
    m.victim = others[Math.floor(Math.random() * others.length)];
    m.activity = "windup";
    m.chargeSec = 0;
    m.timer = 0.5 + Math.random() * 0.6;
  }

  private windUp(m: CrowdMember, dt: number): void {
    const victim = m.victim;
    if (!victim) {
      this.rest(m);
      return;
    }
    const dx = victim.frame.x - m.frame.x;
    const dz = victim.frame.z - m.frame.z;
    m.frame.yaw = Math.atan2(-dx, -dz);
    m.chargeSec += dt;
    m.frame.chargeTicks = Math.min(CHARGE_FULL_TICKS, Math.round(m.chargeSec * TICK_RATE));
    if (m.timer > 0) return;
    const strength = Math.min(1, m.frame.chargeTicks / CHARGE_FULL_TICKS);
    m.frame.chargeTicks = 0;
    m.animator.trigger("throw", { strength });
    const flight = Math.hypot(dx, dz) / (16 + 18 * strength);
    this.later(flight + 0.08, () => this.receive(victim, dx, dz, strength));
    this.rest(m);
  }

  /** The pretend ball arrives: a happy catch or a cartoon bonk with a little knockback hop. */
  private receive(victim: CrowdMember, dx: number, dz: number, strength: number): void {
    const len = Math.hypot(dx, dz) || 1;
    const dir = { x: dx / len, y: 0, z: dz / len };
    if (victim.activity === "stunned") return;
    if (Math.random() < 0.4) {
      victim.frame.yaw = Math.atan2(dir.x, dir.z);
      victim.animator.trigger("catch");
      this.rest(victim);
      return;
    }
    victim.animator.trigger("hit", { dir, strength });
    victim.activity = "stunned";
    victim.stunSec = (KNOCKBACK_STUN_TICKS / TICK_RATE) * (0.8 + strength);
    const kb = 3 + 3 * strength;
    victim.frame.vx = dir.x * kb;
    victim.frame.vz = dir.z * kb;
    victim.frame.vy = 3 + 2 * strength;
    victim.frame.grounded = false;
  }

  /* ---------------------------------------------------------- movement */

  private move(m: CrowdMember, dt: number): void {
    const f = m.frame;
    if (m.activity === "walk") {
      const dx = m.targetX - f.x;
      const dz = m.targetZ - f.z;
      const d = Math.hypot(dx, dz) || 1;
      const slow = Math.min(1, d / 1.2);
      this.accelerate(f, (dx / d) * m.speed * slow, (dz / d) * m.speed * slow, dt);
      if (Math.hypot(f.vx, f.vz) > 0.5) f.yaw = Math.atan2(-f.vx, -f.vz);
    } else if (m.activity !== "stunned" || f.grounded) {
      this.accelerate(f, 0, 0, dt * (m.activity === "stunned" ? 0.35 : 1));
    }
    f.x += f.vx * dt;
    f.z += f.vz * dt;
    if (!f.grounded) {
      f.vy += GRAVITY * dt;
      f.y += f.vy * dt;
      if (f.y <= 0) {
        const impact = -f.vy;
        f.y = 0;
        f.vy = 0;
        f.grounded = true;
        m.animator.trigger("land", { strength: Math.min(1, impact / 12) });
      }
    }
    this.keepInside(f);
  }

  private accelerate(f: PlayerFrame, tx: number, tz: number, dt: number): void {
    const dvx = tx - f.vx;
    const dvz = tz - f.vz;
    const dv = Math.hypot(dvx, dvz);
    const max = ACCEL * dt;
    const k = dv > max ? max / dv : 1;
    f.vx += dvx * k;
    f.vz += dvz * k;
  }

  /** Stay on the island and out of the cover props. */
  private keepInside(f: PlayerFrame): void {
    const r = Math.hypot(f.x, f.z);
    const limit = this.roamRadius * 1.15;
    if (r > limit) {
      f.x *= limit / r;
      f.z *= limit / r;
    }
    for (const c of this.arena.cover) {
      const radius = coverRadius(c) + COVER_MARGIN * 0.6;
      const dx = f.x - c.x;
      const dz = f.z - c.z;
      const d = Math.hypot(dx, dz);
      if (d < radius && d > 1e-4) {
        f.x = c.x + (dx / d) * radius;
        f.z = c.z + (dz / d) * radius;
      }
    }
  }

  private separate(): void {
    const ms = this.members;
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const a = ms[i].frame;
        const b = ms[j].frame;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d >= PERSONAL_SPACE || d < 1e-4) continue;
        const push = (PERSONAL_SPACE - d) / 2;
        a.x -= (dx / d) * push;
        a.z -= (dz / d) * push;
        b.x += (dx / d) * push;
        b.z += (dz / d) * push;
      }
    }
  }

  /** Nudge a point out of every cover footprint. */
  private freeSpot(x: number, z: number): [number, number] {
    let px = x;
    let pz = z;
    for (const c of this.arena.cover) {
      const radius = coverRadius(c) + COVER_MARGIN;
      const dx = px - c.x;
      const dz = pz - c.z;
      const d = Math.hypot(dx, dz);
      if (d < radius) {
        const a = d > 1e-4 ? Math.atan2(dx, dz) : Math.random() * Math.PI * 2;
        px = c.x + Math.sin(a) * radius;
        pz = c.z + Math.cos(a) * radius;
      }
    }
    return [px, pz];
  }

  /* -------------------------------------------------------------- timers */

  private later(sec: number, run: () => void): void {
    this.pending.push({ at: this.clock + sec, run });
  }

  private runPending(): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at > this.clock) continue;
      const [job] = this.pending.splice(i, 1);
      job.run();
    }
  }
}

function coverRadius(c: ArenaDef["cover"][number]): number {
  return c.shape === "cylinder" ? c.radius : Math.hypot(c.halfX, c.halfZ);
}

/**
 * Spawns all 6 animals (slot colors cycling) on the arena, wandering between random points,
 * hopping, emoting and occasionally "throwing" at each other (cosmetic only, no balls needed).
 */
export const createMenuCrowd: MenuCrowdFactory = (scene, arena) => {
  const crowd = new MenuCrowd(scene, arena);
  return {
    update(dt: number, elapsed: number) {
      void elapsed;
      crowd.update(dt);
    },
    dispose() {
      crowd.dispose();
    },
  };
};
