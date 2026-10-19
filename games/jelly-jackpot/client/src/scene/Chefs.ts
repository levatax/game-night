// Bean-shaped chef avatars around the table. Owner: client-chefs. PUBLIC API IS THE CONTRACT.
//
// Look (game2.md §10): chunky jelly-bean bodies in the player color, big puffy chef hat (also player
// color tinted), googly eyes (googlyEyes/jiggleEyes from ./toon), rosy cheeks, a ridiculous curly
// mustache on some (pick by seat), tiny noodle arms, floating nameplate (canvas sprite) with the nickname
// and coin count. Idle: breathe/bob, blink, look at the tower. Reactions (react()):
//  - "lean"   lean in toward the tower (during others' hover)
//  - "cheer"  jump with arms up + squash & stretch
//  - "gasp"   hands on cheeks, eyes go huge
//  - "laugh"  shake + "HA HA" bubble
//  - "point"  point at the active chef
//  - "pie"    a cream pie flies in and SPLATS on the face; the face stays creamy (white blob + drips)
//             for ~4 s, eyes blink through the cream
//  - "cry"    little tear fountains (lost a bet)
//  - "devil"  the chef hat flies off spinning to reveal a tiny red devil hat with horns (+ red glow, laugh)
//  - "standUp" / "sitDown"  the active chef stands and raises arms as if puppeting the hover piece
// The active player's chef follows the hover piece with its arms (setHoldTarget).
//
// Implementation lives in ./chefs/: model.ts (mesh rig), Chef.ts (per-chef animation), labels.ts
// (nameplate / bubble canvases), pieFx.ts (flying pie, splatter, falling tin).

import * as THREE from "three";
import { CAKE_TOP_Y } from "../../../shared/constants";
import type { PlayerView } from "../../../shared/protocol";
import type { Stage } from "./Stage";
import { Chef } from "./chefs/Chef";
import { PieFx } from "./chefs/pieFx";

export type ChefReaction = "lean" | "cheer" | "gasp" | "laugh" | "point" | "pie" | "cry" | "devil" | "standUp" | "sitDown";

interface Queued {
  id: string;
  reaction: ChefReaction;
  at: number;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

export class Chefs {
  private root = new THREE.Group();
  private chefs = new Map<string, Chef>();
  private fx: PieFx;
  private queue: Queued[] = [];
  private time = 0;
  private activeId = "";
  private tower = new THREE.Vector3();
  private activeHead = new THREE.Vector3();
  private camRight = new THREE.Vector3(1, 0, 0);

  constructor(private stage: Stage) {
    this.root.name = "chefs";
    stage.world.add(this.root);
    this.fx = new PieFx(this.root);
  }

  /** Add/remove/update chefs from the player list (exclude spectators). Seats via stage.seat(p.seat, count). */
  sync(players: PlayerView[], activeId: string, myId: string): void {
    this.activeId = activeId;
    // Seat index = rank among non-spectators by seat number (equals p.seat when seats are compacted).
    const list = players.filter((p) => !p.spectator).sort((a, b) => a.seat - b.seat || (a.id < b.id ? -1 : 1));
    const count = list.length;
    const keep = new Set<string>();
    list.forEach((p, i) => {
      keep.add(p.id);
      let chef = this.chefs.get(p.id);
      if (chef && chef.removing) {
        // Came back while waving goodbye: rebuild fresh.
        this.destroy(chef);
        chef = undefined;
      }
      if (!chef) {
        chef = new Chef(p.id, p, i);
        chef.onTinFall = (tin) => this.dropTin(chef!, tin);
        this.root.add(chef.rig.root);
        this.chefs.set(p.id, chef);
      }
      const pose = this.stage.seat(i, count);
      chef.setSeat(pose.position, pose.yaw);
      chef.setPlayer(p, p.id === myId, p.id === activeId);
    });
    for (const [id, chef] of this.chefs) {
      if (!keep.has(id)) {
        chef.remove();
        chef.setHold(null);
        this.fx.cancelFor(chef);
      }
    }
  }

  react(playerId: string, reaction: ChefReaction): void {
    const chef = this.chefs.get(playerId);
    if (!chef || chef.removing) return;
    chef.react(reaction);
    if (reaction === "pie") this.throwPieAt(chef);
  }

  /** Everyone (optionally except one id) reacts, with small random delays so it looks natural. */
  reactAll(reaction: ChefReaction, exceptId?: string): void {
    let first = true;
    for (const id of this.chefs.keys()) {
      if (id === exceptId) continue;
      const delay = first ? 0 : Math.random() * 0.35;
      first = false;
      this.queue.push({ id, reaction, at: this.time + delay });
    }
  }

  /** The active chef's hands reach toward this world point (null = rest). */
  setHoldTarget(playerId: string, world: THREE.Vector3 | null): void {
    this.chefs.get(playerId)?.setHold(world);
  }

  /** World position of a chef's head (for coin bursts / pies / pop text), or null. */
  headPosition(playerId: string): THREE.Vector3 | null {
    const chef = this.chefs.get(playerId);
    if (!chef) return null;
    return chef.facePoint(new THREE.Vector3());
  }

  update(dt: number, time: number): void {
    this.time += dt;
    if (this.queue.length) {
      const due = this.queue.filter((q) => q.at <= this.time);
      if (due.length) {
        this.queue = this.queue.filter((q) => q.at > this.time);
        for (const q of due) this.react(q.id, q.reaction);
      }
    }

    // What "point" aims at: the active chef's face, or the tower when there's no one else to blame.
    this.stage.standGroup.updateWorldMatrix(true, false);
    this.tower.set(0, CAKE_TOP_Y + 0.15, 0);
    this.stage.standGroup.localToWorld(this.tower);
    this.root.updateWorldMatrix(true, false);
    const active = this.chefs.get(this.activeId);
    const hasActive = !!active && !active.removing;
    if (hasActive) active.facePoint(this.activeHead);

    this.camRight.setFromMatrixColumn(this.stage.camera.matrixWorld, 0);
    this.fx.update(dt);
    for (const [id, chef] of this.chefs) {
      const target = hasActive && id !== this.activeId ? this.activeHead : this.tower;
      chef.update(dt, time, target, this.camRight);
      if (chef.dead) this.destroy(chef);
    }
  }

  // ---------------------------------------------------------------- private
  private throwPieAt(chef: Chef): void {
    // Thrown from somewhere across the table, up high, with a bit of sideways randomness.
    const face = chef.facePoint(tmpA);
    const fwd = chef.forward(tmpB);
    const side = (Math.random() - 0.5) * 1.2;
    const from = new THREE.Vector3(
      face.x + fwd.x * 1.5 + fwd.z * side,
      face.y + 0.55 + Math.random() * 0.3,
      face.z + fwd.z * 1.5 - fwd.x * side,
    );
    this.fx.throwPie(chef, from);
  }

  private dropTin(chef: Chef, tin: THREE.Group): void {
    const fwd = chef.forward(tmpB);
    const vel = new THREE.Vector3(fwd.x * 0.6 + (Math.random() - 0.5) * 0.4, 0.6, fwd.z * 0.6 + (Math.random() - 0.5) * 0.4);
    this.fx.dropTin(tin, vel, chef.floorY + 0.02);
  }

  private destroy(chef: Chef): void {
    this.fx.cancelFor(chef);
    chef.dispose();
    if (this.chefs.get(chef.id) === chef) this.chefs.delete(chef.id);
  }
}
