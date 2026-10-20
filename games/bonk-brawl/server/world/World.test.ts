import { describe, expect, it } from "vitest";
import {
  BALL_RADIUS,
  CATCH_COOLDOWN_TICKS,
  CATCH_WINDOW_TICKS,
  HEADBUTT_KNOCK_H,
  HEADBUTT_KNOCK_UP,
  HURT_INVULN_TICKS,
  KNOCKBACK_H,
  KNOCKBACK_STUN_TICKS,
  KNOCKBACK_UP,
  MAX_HEARTS,
  MEGA_BALL_RADIUS,
  RING_FALLEN,
  RING_SHAKING,
  THROW_SPEED_MAX,
  TRIPLE_SPREAD_RAD,
  WHIFF_TICKS,
  ZOOMIES_MULT,
  ZOOMIES_TICKS,
  MOVE_SPEED,
} from "../../shared/constants.js";
import type { ArenaDef } from "../../shared/maps.js";
import { BTN, type InputCmd } from "../../shared/protocol.js";
import { ringIndexAt } from "../../shared/sim/geometry.js";
import { lcg, openArena } from "../../shared/sim/testkit.js";
import { throwSpeed } from "../../shared/sim/throw.js";
import type { CharacterId } from "../../shared/types.js";
import { BallEntity, BonkState, PlayerState } from "../schema.js";
import { toMessage, type GameEvent, type GameEventOf, type GameEventType } from "./events.js";
import { GameWorld, type WorldStepOptions } from "./World.js";

const PLAY: WorldStepOptions = { dtScale: 1, locked: false, combat: true };

type BallFields = Partial<Pick<BallEntity, "x" | "y" | "z" | "vx" | "vy" | "vz" | "state" | "kind" | "radius" | "ownerId" | "throwSeq" | "throwIndex" | "charge" | "curve" | "ageTicks">>;

/** A world with players (slot = index) and a cover-free picnic arena, already reset for a round. */
class Bench {
  readonly state = new BonkState();
  readonly world: GameWorld;
  readonly events: GameEvent[] = [];
  private readonly seqs = new Map<string, number>();

  constructor(players: Array<[string, CharacterId?]>, arena: ArenaDef = openArena()) {
    players.forEach(([id, character], slot) => {
      const p = new PlayerState();
      p.id = id;
      p.nickname = id;
      p.character = character ?? "quacky";
      p.slot = slot;
      this.state.players.set(id, p);
    });
    this.world = new GameWorld(this.state, arena, { random: lcg(7) });
    this.world.resetForRound(players.map(([id]) => id));
  }

  p(id: string): PlayerState {
    const p = this.state.players.get(id);
    if (!p) throw new Error(`no player ${id}`);
    return p;
  }

  place(id: string, x: number, z: number, yaw = 0): PlayerState {
    const p = this.p(id);
    Object.assign(p, { x, y: 0, z, yaw, pitch: 0, vx: 0, vy: 0, vz: 0, grounded: true });
    return p;
  }

  send(id: string, partial: Partial<InputCmd> = {}): number {
    const seq = (this.seqs.get(id) ?? 0) + 1;
    this.seqs.set(id, seq);
    const p = this.p(id);
    this.world.queueInput(id, { seq, moveX: 0, moveZ: 0, yaw: p.yaw, pitch: p.pitch, buttons: 0, ...partial });
    return seq;
  }

  tick(opts: WorldStepOptions = PLAY): GameEvent[] {
    this.state.tick++;
    const evs = this.world.step(opts);
    this.events.push(...evs);
    return evs;
  }

  run(ticks: number, each?: (i: number) => void): GameEvent[] {
    const out: GameEvent[] = [];
    for (let i = 0; i < ticks; i++) {
      each?.(i);
      out.push(...this.tick());
    }
    return out;
  }

  ball(fields: BallFields): BallEntity {
    const id = this.world.spawnBall();
    this.world.drainEvents();
    const b = this.state.balls.get(id);
    if (!b) throw new Error("ball missing");
    Object.assign(b, { y: BALL_RADIUS, ...fields });
    return b;
  }

  live(ownerId: string, fields: BallFields): BallEntity {
    return this.ball({ state: "live", ownerId, throwSeq: 1, ageTicks: 1, ...fields });
  }

  /** Drop a neutral ball at the player's feet and let them pick it up. */
  arm(id: string): BallEntity {
    const p = this.p(id);
    const b = this.ball({ x: p.x, z: p.z });
    this.tick();
    expect(b.state).toBe("held");
    expect(b.holderId).toBe(id);
    return b;
  }

  /** Hold THROW for `chargeTicks` ticks, then release. Returns the release tick's events. */
  throwBall(id: string, chargeTicks: number, look: Partial<InputCmd> = {}): GameEvent[] {
    for (let i = 0; i < chargeTicks; i++) {
      this.send(id, { ...look, buttons: BTN.THROW });
      this.tick();
    }
    this.send(id, look);
    return this.tick();
  }

  of<T extends GameEventType>(type: T, evs: GameEvent[] = this.events): Array<GameEventOf<T>> {
    return evs.filter((e): e is GameEventOf<T> => e.type === type);
  }
}

const speedOf = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);

describe("GameWorld: round setup", () => {
  it("places participants at their slot spawns and resets rings in place", () => {
    const b = new Bench([["a"], ["b"], ["c"]]);
    const rings = b.state.rings;
    b.world.dropRing(4);
    expect(b.state.rings[4]).toBe(RING_FALLEN);
    b.world.resetForRound(["a", "c"]);
    expect(b.state.rings).toBe(rings);
    expect([...b.state.rings]).toEqual([0, 0, 0, 0, 0]);
    const spawns = b.world.arena.spawns;
    expect(b.p("a")).toMatchObject({ alive: true, hearts: MAX_HEARTS, x: spawns[0].x, z: spawns[0].z, yaw: spawns[0].yaw });
    expect(b.p("c")).toMatchObject({ alive: true, x: spawns[2].x, z: spawns[2].z });
    expect(b.p("b").alive).toBe(false);
    expect(b.world.alivePlayers()).toEqual(["a", "c"]);
  });
});

describe("GameWorld: inputs", () => {
  it("consumes one input per tick, repeats without edges and acks lastSeq", () => {
    const b = new Bench([["a"]]);
    b.place("a", 0, 5);
    b.send("a", { moveZ: 1, buttons: BTN.JUMP });
    b.send("a", { moveZ: 1 });
    b.tick();
    expect(b.p("a").lastSeq).toBe(1);
    expect(b.p("a").grounded).toBe(false);
    b.tick();
    expect(b.p("a").lastSeq).toBe(2);
    b.tick();
    expect(b.p("a").lastSeq).toBe(2);
    expect(b.p("a").vz).toBeLessThan(0);
  });

  it("drops stale and malformed inputs and forgets the seq on clearInputs", () => {
    const b = new Bench([["a"]]);
    b.world.queueInput("a", { seq: 5, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 });
    b.world.queueInput("a", { seq: 3, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 });
    b.world.queueInput("a", { seq: 6, moveX: Number.NaN, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 });
    b.tick();
    b.tick();
    expect(b.p("a").lastSeq).toBe(5);
    b.world.clearInputs("a");
    expect(b.p("a").lastSeq).toBe(0);
    b.world.queueInput("a", { seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 });
    b.tick();
    expect(b.p("a").lastSeq).toBe(1);
  });

  it("caps the queue at 4 and carries the dropped input's edge bits forward", () => {
    const b = new Bench([["a"]]);
    b.place("a", 0, 5);
    b.send("a", { buttons: BTN.JUMP });
    for (let i = 0; i < 4; i++) b.send("a");
    b.tick();
    expect(b.p("a").lastSeq).toBe(2);
    expect(b.p("a").vy).toBeGreaterThan(0);
  });
});

describe("GameWorld: pickups and throws", () => {
  it("auto-picks up a neutral ball, holding at most one (two with Triple Shot)", () => {
    const b = new Bench([["a"]]);
    b.place("a", 0, 5);
    const first = b.arm("a");
    expect(b.of("pickup")).toHaveLength(1);
    expect(b.p("a").heldCount).toBe(1);
    expect(first.ownerId).toBe("");

    const second = b.ball({ x: 0, z: 5 });
    b.tick();
    expect(second.state).toBe("neutral");
    b.p("a").powerUp = "triple";
    b.tick();
    expect(second.state).toBe("held");
    expect(b.p("a").heldCount).toBe(2);
  });

  it("a quick tap throws at ~16 m/s and a full charge at 34 m/s", () => {
    const b = new Bench([["a"], ["b"]]);
    b.place("a", 0, 8);
    b.arm("a");
    const quick = b.of("throw", b.throwBall("a", 1))[0];
    expect(quick.charge).toBeCloseTo(1 / 30, 5);
    expect(speedOf(quick.velocities[0])).toBeCloseTo(throwSpeed(1 / 30), 5);
    expect(speedOf(quick.velocities[0])).toBeLessThan(17);
    const ball = b.state.balls.get(quick.ballIds[0]);
    expect(ball).toMatchObject({ state: "live", ownerId: "a", throwSeq: quick.throwSeq, throwIndex: 0, kind: "normal" });
    expect(quick.throwSeq).toBe(b.p("a").lastSeq);
    expect(b.p("a").heldCount).toBe(0);

    b.run(20);
    b.place("b", -6, 0);
    b.place("a", 6, 0);
    b.arm("a");
    const full = b.of("throw", b.throwBall("a", 40))[0];
    expect(full.charge).toBe(1);
    expect(speedOf(full.velocities[0])).toBeCloseTo(THROW_SPEED_MAX, 5);
  });

  it("removes the two Triple Shot bonus balls once they come to rest", () => {
    const b = new Bench([["a"]]);
    b.place("a", 0, 12);
    b.arm("a");
    b.p("a").powerUp = "triple";
    const ev = b.of("throw", b.throwBall("a", 1, { pitch: 1.2 }))[0];
    expect(ev.ballIds).toHaveLength(3);
    const balls = ev.ballIds.map((id) => b.state.balls.get(id));
    expect(balls.map((x) => x?.kind)).toEqual(["normal", "bonus", "bonus"]);
    expect(balls.map((x) => x?.throwIndex)).toEqual([0, 1, 2]);
    const yaw = (v: { x: number; z: number }) => Math.atan2(-v.x, -v.z);
    expect(yaw(ev.velocities[1]) - yaw(ev.velocities[0])).toBeCloseTo(TRIPLE_SPREAD_RAD, 5);
    expect(yaw(ev.velocities[0]) - yaw(ev.velocities[2])).toBeCloseTo(TRIPLE_SPREAD_RAD, 5);

    const lost = b.of("ballLost", b.run(450));
    expect(lost.map((l) => l.ballId).sort()).toEqual([ev.ballIds[1], ev.ballIds[2]].sort());
    expect(lost.every((l) => !l.respawn)).toBe(true);
    expect(b.state.balls.get(ev.ballIds[0])?.state).toBe("neutral");
    expect(b.world.countBalls()).toBe(1);
  });
});

describe("GameWorld: hits", () => {
  it("costs a heart, knocks back along the ball's travel and stuns", () => {
    const b = new Bench([["t"], ["v"]]);
    b.place("t", 0, 8);
    b.place("v", 0, 4);
    const ball = b.live("t", { x: 0, y: 1, z: 4.9, vz: -20 });
    const hit = b.of("hit", b.tick())[0];
    expect(hit).toMatchObject({ throwerId: "t", targetId: "v", heartsLeft: 2, fullCharge: false, kind: "normal" });
    expect(hit.knockback.x).toBeCloseTo(0, 6);
    expect(hit.knockback.y).toBeCloseTo(KNOCKBACK_UP, 6);
    expect(hit.knockback.z).toBeCloseTo(-KNOCKBACK_H, 6);
    const v = b.p("v");
    expect(v.hearts).toBe(2);
    expect(v).toMatchObject({ vy: KNOCKBACK_UP, stunTicks: KNOCKBACK_STUN_TICKS, hurtTicks: HURT_INVULN_TICKS, grounded: false });
    expect(v.vz).toBeCloseTo(-KNOCKBACK_H, 6);
    expect(ball.state).toBe("dead");
  });

  it("scales knockback ×1.5 at full charge and ×2 for a Mega Ball", () => {
    const b = new Bench([["t"], ["v"]]);
    b.place("v", 0, 4);
    b.live("t", { x: 0, y: 1, z: 4.9, vz: -20, charge: 1, kind: "mega", radius: MEGA_BALL_RADIUS });
    const hit = b.of("hit", b.tick())[0];
    expect(hit.fullCharge).toBe(true);
    expect(hit.knockback.z).toBeCloseTo(-KNOCKBACK_H * 3, 6);
    expect(hit.knockback.y).toBeCloseTo(KNOCKBACK_UP * 3, 6);
  });

  it("never hits its own thrower and passes through during post-hit mercy", () => {
    const b = new Bench([["t"], ["v"]]);
    b.place("t", 0, 4);
    const own = b.live("t", { x: 0, y: 1, z: 4.2, vz: -1 });
    expect(b.of("hit", b.tick())).toHaveLength(0);
    expect(own.state).toBe("live");

    b.place("v", 5, 0);
    b.p("v").hurtTicks = 10;
    const mercy = b.live("t", { x: 5, y: 1, z: 0.3, vz: -1 });
    expect(b.of("hit", b.tick())).toHaveLength(0);
    expect(mercy.state).toBe("live");
  });

  it("dodge-roll i-frames let a ball pass through", () => {
    const b = new Bench([["t"], ["v"]]);
    b.place("v", 0, 0);
    b.send("v", { moveX: 1, buttons: BTN.ROLL });
    const ball = b.live("t", { x: 0.44, y: 1, z: 0 });
    expect(b.of("hit", b.tick())).toHaveLength(0);
    expect(b.p("v").rollTicks).toBeGreaterThan(0);
    expect(ball.state).toBe("live");

    const control = new Bench([["t"], ["v"]]);
    control.place("v", 0, 0);
    control.live("t", { x: 0.1, y: 1, z: 0 });
    expect(control.of("hit", control.tick())).toHaveLength(1);
  });

  it("knocks out at 0 hearts and drops held balls as dead balls", () => {
    const b = new Bench([["t"], ["v"]]);
    b.place("v", 0, 4);
    const held = b.arm("v");
    b.p("v").hearts = 1;
    b.live("t", { x: 0, y: 1, z: 4.9, vz: -20 });
    const evs = b.tick();
    expect(b.of("hit", evs)[0].heartsLeft).toBe(0);
    expect(b.of("ko", evs)[0]).toMatchObject({ playerId: "v", byId: "t", cause: "hits" });
    expect(b.p("v")).toMatchObject({ alive: false, heldCount: 0, hearts: 0 });
    expect(held).toMatchObject({ state: "dead", holderId: "", ownerId: "" });
    expect(b.world.alivePlayers()).toEqual(["t"]);
  });
});

describe("GameWorld: catches", () => {
  it("catches a ball arriving inside the window: thrower loses a heart, no whiff", () => {
    const b = new Bench([["c"], ["t"]]);
    b.place("c", 0, 0);
    b.place("t", 0, -8);
    const ball = b.live("t", { x: 0, y: 1, z: -3, vz: 15 });
    b.send("c", { buttons: BTN.CATCH });
    const evs = b.run(4);
    const caught = b.of("catch", evs)[0];
    expect(caught).toMatchObject({ catcherId: "c", throwerId: "t", kept: true, rewindTicks: 0, throwerHeartsLeft: 2 });
    expect(b.of("hit", evs)).toHaveLength(0);
    expect(ball).toMatchObject({ state: "held", holderId: "c", kind: "normal" });
    expect(b.p("c")).toMatchObject({ heldCount: 1, catchTicks: 0, hearts: 3 });
    expect(b.p("t").hearts).toBe(2);
    expect(b.of("whiff", b.run(30))).toHaveLength(0);
  });

  it("whiffs when the window expires, then respects the 1 s cooldown", () => {
    const b = new Bench([["c"]]);
    b.place("c", 0, 0);
    b.send("c", { buttons: BTN.CATCH });
    const evs = b.run(CATCH_WINDOW_TICKS + 1);
    const whiffs = b.of("whiff", evs);
    expect(whiffs).toHaveLength(1);
    expect(whiffs[0].tick).toBe(1 + CATCH_WINDOW_TICKS);
    expect(b.p("c").whiffTicks).toBe(WHIFF_TICKS);

    b.run(WHIFF_TICKS);
    expect(b.p("c").whiffTicks).toBe(0);
    b.send("c", { buttons: BTN.CATCH });
    b.tick();
    expect(b.p("c").catchTicks).toBe(0);
    while (b.state.tick < 1 + CATCH_COOLDOWN_TICKS) b.tick();
    b.send("c", { buttons: BTN.CATCH });
    b.tick();
    expect(b.p("c").catchTicks).toBe(CATCH_WINDOW_TICKS);
  });

  it("catch wins over a hit from the front; a ball from behind still hits", () => {
    const front = new Bench([["c"], ["t"]]);
    front.place("c", 0, 0);
    front.live("t", { x: 0, y: 1, z: -1, vz: 15 });
    front.send("c", { buttons: BTN.CATCH });
    const evs = front.tick();
    expect(front.of("catch", evs)).toHaveLength(1);
    expect(front.of("hit", evs)).toHaveLength(0);

    const back = new Bench([["c"], ["t"]]);
    back.place("c", 0, 0);
    back.live("t", { x: 0, y: 1, z: 1, vz: -15 });
    back.send("c", { buttons: BTN.CATCH });
    const evs2 = back.tick();
    expect(back.of("catch", evs2)).toHaveLength(0);
    expect(back.of("hit", evs2)).toHaveLength(1);
  });

  it("lag compensation: a late press rewinds the ball history by the catcher's rewind ticks", () => {
    const setup = (rewind: number) => {
      const b = new Bench([["c"], ["t"]]);
      b.place("c", 0, 0);
      b.world.setRewindTicks("c", rewind);
      // Passes in front of the catcher (inside the catch sphere, never touching the capsule).
      b.live("t", { x: -1.5, y: 1, z: -0.8, vx: 15, vy: 2 });
      b.run(6);
      b.send("c", { buttons: BTN.CATCH });
      return { b, evs: b.run(CATCH_WINDOW_TICKS + 1) };
    };
    const lagged = setup(3);
    const caught = lagged.b.of("catch", lagged.evs);
    expect(caught).toHaveLength(1);
    expect(caught[0].rewindTicks).toBe(3);
    expect(lagged.b.of("whiff", lagged.evs)).toHaveLength(0);

    const instant = setup(0);
    expect(instant.b.of("catch", instant.evs)).toHaveLength(0);
    expect(instant.b.of("whiff", instant.evs)).toHaveLength(1);
  });

  it("lag compensation: a pending hit on a lagged player is converted by a late catch", () => {
    const run = (press: boolean) => {
      const b = new Bench([["c"], ["t"]]);
      b.place("c", 0, 0);
      b.world.setRewindTicks("c", 3);
      b.live("t", { x: 0, y: 1, z: -1, vz: 15 });
      const evs = b.tick();
      expect(b.of("hit", evs)).toHaveLength(0);
      b.tick();
      if (press) b.send("c", { buttons: BTN.CATCH });
      return { b, evs: b.run(10) };
    };
    const saved = run(true);
    expect(saved.b.of("hit", saved.evs)).toHaveLength(0);
    expect(saved.b.of("catch", saved.evs)[0]).toMatchObject({ catcherId: "c", rewindTicks: 3, kept: true });
    expect(saved.b.p("c").hearts).toBe(3);
    expect(saved.b.p("t").hearts).toBe(2);

    const hurt = run(false);
    const hit = hurt.b.of("hit", hurt.evs);
    expect(hit).toHaveLength(1);
    expect(hit[0].tick).toBe(4);
    expect(hurt.b.p("c").hearts).toBe(2);
  });

  it("a caught Triple Shot's sibling balls deflect off the catcher (one heart max)", () => {
    const b = new Bench([["c"], ["t"]]);
    b.place("c", 0, 0);
    b.live("t", { x: 0, y: 1, z: -1, vz: 15, throwSeq: 9, throwIndex: 0 });
    const side = b.live("t", { x: 0.3, y: 1, z: -1.6, vz: 15, throwSeq: 9, throwIndex: 1, kind: "bonus" });
    b.send("c", { buttons: BTN.CATCH });
    const evs = b.run(3);
    expect(b.of("catch", evs)).toHaveLength(1);
    expect(b.of("deflect", evs)[0]).toMatchObject({ ballId: side.id, playerId: "c" });
    expect(b.of("hit", evs)).toHaveLength(0);
    expect(b.p("t").hearts).toBe(2);
    expect(b.p("c").hearts).toBe(3);
  });

  it("a catch that empties the thrower's hearts knocks them out (cause caught)", () => {
    const b = new Bench([["c"], ["t"]]);
    b.place("c", 0, 0);
    b.p("t").hearts = 1;
    b.live("t", { x: 0, y: 1, z: -1, vz: 15 });
    b.send("c", { buttons: BTN.CATCH });
    const evs = b.tick();
    expect(b.of("ko", evs)[0]).toMatchObject({ playerId: "t", byId: "c", cause: "caught" });
    expect(evs.findIndex((e) => e.type === "catch")).toBeLessThan(evs.findIndex((e) => e.type === "ko"));
  });

  it("drops the caught ball at the catcher's feet when their hands are full", () => {
    const b = new Bench([["c"], ["t"]]);
    b.place("c", 0, 0);
    b.arm("c");
    const ball = b.live("t", { x: 0, y: 1, z: -1, vz: 15 });
    b.send("c", { buttons: BTN.CATCH });
    const caught = b.of("catch", b.tick())[0];
    expect(caught.kept).toBe(false);
    expect(ball.state).toBe("neutral");
    expect(b.p("c").heldCount).toBe(1);
  });
});

describe("GameWorld: abilities", () => {
  it("Flap Dash dashes 5 m and emits the ability with its direction", () => {
    const b = new Bench([["q", "quacky"]]);
    b.place("q", 0, 5);
    b.send("q", { buttons: BTN.ABILITY });
    const ev = b.of("ability", b.tick())[0];
    expect(ev).toMatchObject({ playerId: "q", ability: "flapDash", character: "quacky" });
    expect(ev.dir.z).toBeCloseTo(-1, 6);
    b.run(6);
    expect(5 - b.p("q").z).toBeGreaterThan(4.5);
  });

  it("Ground Pound's shockwave knocks nearby players away without damage", () => {
    const b = new Bench([["h", "hopsworth"], ["near"], ["far"]]);
    b.place("h", 0, 0);
    b.place("near", 2, 0);
    b.place("far", 6, 0);
    b.send("h", { buttons: BTN.ABILITY });
    const evs = b.run(60);
    const wave = b.of("shockwave", evs)[0];
    expect(wave).toMatchObject({ playerId: "h", radius: 3, affected: ["near"] });
    expect(b.p("near").hearts).toBe(3);
    expect(b.p("far").vx).toBe(0);
    expect(b.p("near").x).toBeGreaterThan(2.5);
  });

  it("Belly Bounce deflects live balls harmlessly", () => {
    const b = new Bench([["m", "mochi"], ["t"]]);
    b.place("m", 0, 0);
    b.send("m", { buttons: BTN.ABILITY });
    b.tick();
    const ball = b.live("t", { x: 0, y: 1, z: -1, vz: 15 });
    const evs = b.tick();
    expect(b.of("deflect", evs)[0]).toMatchObject({ playerId: "m", ballId: ball.id });
    expect(b.of("hit", evs)).toHaveLength(0);
    expect(ball.state).toBe("dead");
    expect(b.p("m").hearts).toBe(3);
  });

  it("Curveball steers toward the thrower's current aim during flight", () => {
    const flight = (curve: boolean) => {
      const b = new Bench([["w", "whiskers"]]);
      b.place("w", 0, 10);
      b.arm("w");
      if (curve) {
        b.send("w", { buttons: BTN.ABILITY });
        b.tick();
        expect(b.p("w").curveArmed).toBe(true);
      }
      const ev = b.of("throw", b.throwBall("w", 1, { pitch: 0.4 }))[0];
      expect(ev.curve).toBe(curve);
      const ball = b.state.balls.get(ev.ballIds[0]);
      b.run(8, () => b.send("w", { yaw: 0.6, pitch: 0.4 }));
      return ball?.vx ?? 0;
    };
    expect(flight(false)).toBeCloseTo(0, 6);
    expect(flight(true)).toBeLessThan(-1);
  });

  it("Belly Slide ducks head-height balls", () => {
    const b = new Bench([["p", "pip"], ["t"]]);
    b.place("p", 0, 5);
    b.send("p", { buttons: BTN.ABILITY });
    b.tick();
    expect(b.p("p").abilityTicks).toBeGreaterThan(0);
    const ball = b.live("t", { x: 0, y: 1.2, z: b.p("p").z });
    expect(b.of("hit", b.tick())).toHaveLength(0);
    expect(ball.state).toBe("live");

    const control = new Bench([["q"], ["t"]]);
    control.place("q", 0, 5);
    control.live("t", { x: 0, y: 1.2, z: 5 });
    expect(control.of("hit", control.tick())).toHaveLength(1);
  });

  it("Headbutt sends the target flying with no damage and ends the lunge", () => {
    const b = new Bench([["g", "gruff"], ["v"]]);
    b.place("g", 0, 0);
    b.place("v", 0, -1.8);
    b.send("g", { buttons: BTN.ABILITY });
    const ev = b.of("headbutt", b.tick())[0];
    expect(ev).toMatchObject({ attackerId: "g", targetId: "v" });
    expect(ev.knockback.z).toBeCloseTo(-HEADBUTT_KNOCK_H, 6);
    expect(ev.knockback.y).toBeCloseTo(HEADBUTT_KNOCK_UP, 6);
    expect(b.p("v")).toMatchObject({ hearts: 3, stunTicks: KNOCKBACK_STUN_TICKS });
    expect(b.p("g").abilityTicks).toBe(0);
  });
});

describe("GameWorld: power-ups", () => {
  const pickUp = (b: Bench, id: string, type: "mega" | "triple" | "boomerang" | "zoomies") => {
    const puId = b.world.spawnPowerUpWarning(0, type);
    const spot = b.state.powerUps.get(puId);
    if (!spot) throw new Error("power-up missing");
    b.place(id, spot.x, spot.z);
    b.tick();
    expect(b.state.powerUps.has(puId)).toBe(true);
    b.world.activatePowerUp(puId);
    const evs = b.tick();
    expect(b.state.powerUps.has(puId)).toBe(false);
    return b.of("powerUpPickup", evs)[0];
  };

  it("power-up events carry the protocol payload through toMessage()", () => {
    const b = new Bench([["a"]]);
    const ev = pickUp(b, "a", "mega");
    expect(toMessage(ev)).toMatchObject({ playerId: "a", type: "mega", id: ev.id });
    const warn = b.of("powerUpWarning")[0];
    expect(toMessage(warn)).toMatchObject({ type: "mega", pedestal: 0 });
  });

  it("Mega Ball: the next throw is a 2× ball with 2× knockback", () => {
    const b = new Bench([["a"], ["v"]]);
    b.place("v", 9, 9);
    pickUp(b, "a", "mega");
    expect(b.p("a").powerUp).toBe("mega");
    b.arm("a");
    const ev = b.of("throw", b.throwBall("a", 1))[0];
    expect(ev).toMatchObject({ kind: "mega", powerUp: "mega" });
    expect(b.state.balls.get(ev.ballIds[0])?.radius).toBe(MEGA_BALL_RADIUS);
    expect(b.p("a").powerUp).toBe("");
  });

  it("Triple Shot: three balls in a 15° spread", () => {
    const b = new Bench([["a"]]);
    pickUp(b, "a", "triple");
    b.arm("a");
    const ev = b.of("throw", b.throwBall("a", 1))[0];
    expect(ev.ballIds).toHaveLength(3);
    expect(ev.powerUp).toBe("triple");
    const seqs = new Set(ev.ballIds.map((id) => b.state.balls.get(id)?.throwSeq));
    expect(seqs).toEqual(new Set([ev.throwSeq]));
  });

  it("Boomerang returns to its thrower when it misses, and can hit on the way back", () => {
    const b = new Bench([["a"], ["v"]]);
    b.place("v", 10, 10);
    pickUp(b, "a", "boomerang");
    b.place("a", 0, 0);
    b.arm("a");
    const ev = b.of("throw", b.throwBall("a", 1, { pitch: 0.3 }))[0];
    expect(ev.kind).toBe("boomerang");
    const evs = b.run(90);
    const returns = b.of("boomerangReturn", evs);
    expect(returns.map((r) => r.caught)).toEqual([false, true]);
    expect(b.p("a").heldCount).toBe(1);
    expect(b.state.balls.get(ev.ballIds[0])).toMatchObject({ state: "held", holderId: "a", kind: "normal" });

    const back = new Bench([["a"], ["v"]]);
    back.place("v", 10, 10);
    pickUp(back, "a", "boomerang");
    back.place("a", 0, 0);
    back.arm("a");
    back.throwBall("a", 1, { pitch: 0.3 });
    let moved = false;
    const evs2 = back.run(90, () => {
      if (!moved && back.of("boomerangReturn").length > 0) {
        back.place("v", 0, -4);
        moved = true;
      }
    });
    expect(back.of("hit", evs2)[0]).toMatchObject({ throwerId: "a", targetId: "v", kind: "boomerang" });
  });

  it("Zoomies: +40% move speed for 6 s", () => {
    const b = new Bench([["a"]]);
    const ev = pickUp(b, "a", "zoomies");
    expect(ev.powerUpType).toBe("zoomies");
    expect(b.p("a").zoomiesTicks).toBe(ZOOMIES_TICKS);
    expect(b.p("a").powerUp).toBe("");
    b.place("a", 0, 10);
    b.run(30, () => b.send("a", { moveZ: 1 }));
    expect(Math.hypot(b.p("a").vx, b.p("a").vz)).toBeCloseTo(MOVE_SPEED * ZOOMIES_MULT, 5);
  });
});

describe("GameWorld: ring-outs, rings and balls leaving play", () => {
  const knockAndDrop = (delayTicks: number) => {
    const b = new Bench([["t"], ["v"]]);
    b.place("v", 0, 4);
    b.live("t", { x: 0, y: 1, z: 4.9, vz: -20 });
    expect(b.of("hit", b.tick())).toHaveLength(1);
    b.run(delayTicks);
    Object.assign(b.p("v"), { x: 0, z: 16, y: 0, vx: 0, vy: 0, vz: 0, grounded: false });
    return b.of("ringOut", b.run(60))[0];
  };

  it("credits the last hitter for a ring-out within 3 s", () => {
    const out = knockAndDrop(5);
    expect(out).toMatchObject({ playerId: "v", creditId: "t" });
  });

  it("gives no credit when the last hit was more than 3 s ago", () => {
    const out = knockAndDrop(100);
    expect(out).toMatchObject({ playerId: "v", creditId: "" });
  });

  it("reports the last grounded position and freezes the eliminated body", () => {
    const b = new Bench([["a"], ["b"]]);
    b.place("a", 0, 14.5);
    b.run(60, () => b.send("a", { moveZ: 1, yaw: Math.PI }));
    const out = b.of("ringOut")[0];
    expect(out.creditId).toBe("");
    expect(out.pos.z).toBeGreaterThan(14);
    expect(out.pos.y).toBe(0);
    const p = b.p("a");
    expect(p.alive).toBe(false);
    const frozen = p.y;
    b.run(5);
    expect(p.y).toBe(frozen);
  });

  it("shakes and drops rings (never ring 0) and removes stranded power-ups", () => {
    const b = new Bench([["a"]]);
    expect(b.world.outermostSolidRing()).toBe(4);
    b.world.shakeRing(0);
    b.world.dropRing(0);
    expect(b.state.rings[0]).toBe(0);
    b.world.shakeRing(4);
    expect(b.state.rings[4]).toBe(RING_SHAKING);
    b.world.dropRing(4);
    expect(b.state.rings[4]).toBe(RING_FALLEN);
    expect(b.world.outermostSolidRing()).toBe(3);
    const pu = b.world.spawnPowerUpWarning(0, "mega");
    b.world.dropRing(1);
    expect(b.state.powerUps.has(pu)).toBe(false);
    expect(b.of("ringShake", b.world.drainEvents()).map((e) => e.ring)).toEqual([4]);

    b.place("a", 0, 13.5);
    b.run(40);
    expect(b.p("a").alive).toBe(false);
  });

  it("reports balls that fall off the island (respawn) and removes them", () => {
    const b = new Bench([["a"]]);
    const ball = b.ball({ x: 0, y: 1, z: 15.5 });
    const lost = b.of("ballLost", b.run(40));
    expect(lost).toEqual([{ type: "ballLost", tick: lost[0].tick, ballId: ball.id, respawn: true }]);
    expect(b.state.balls.has(ball.id)).toBe(false);
  });

  it("spawns balls at random spots on the island, spread out", () => {
    const b = new Bench([["a"]]);
    const id = b.world.spawnBall();
    const spawn = b.of("ballSpawn", b.world.drainEvents())[0];
    expect(spawn.ballId).toBe(id);
    expect(b.state.balls.get(id)).toMatchObject({ state: "neutral", kind: "normal" });
    expect(b.world.countBalls()).toBe(1);
    const spots = [spawn.pos];
    for (let i = 0; i < 30; i++) {
      b.world.spawnBall();
      spots.push(b.of("ballSpawn", b.world.drainEvents())[0].pos);
    }
    for (const p of spots) expect(ringIndexAt(b.world.arena, p.x, p.z)).toBeGreaterThanOrEqual(0);
    expect(spots.some((p) => ringIndexAt(b.world.arena, p.x, p.z) >= 2)).toBe(true);
  });

  it("never drops balls on fallen, shaking or about-to-crumble rings", () => {
    const b = new Bench([["a"]]);
    const last = b.world.arena.ringRadii.length - 1;
    b.world.dropRing(last);
    b.world.shakeRing(last - 1);
    for (let i = 0; i < 60; i++) {
      b.world.spawnBall();
      const pos = b.of("ballSpawn", b.world.drainEvents())[0].pos;
      // last fell, last-1 shakes, last-2 is the outermost solid ring and may go next.
      expect(ringIndexAt(b.world.arena, pos.x, pos.z)).toBeLessThan(last - 2);
      expect(ringIndexAt(b.world.arena, pos.x, pos.z)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("GameWorld: players", () => {
  it("pushes overlapping players apart", () => {
    const b = new Bench([["a"], ["b"]]);
    b.place("a", 0, 5);
    b.place("b", 0.2, 5);
    b.tick();
    expect(Math.abs(b.p("a").x - b.p("b").x)).toBeGreaterThanOrEqual(0.9 - 1e-9);
  });

  it("eliminates a disconnecting player with a disconnect KO", () => {
    const b = new Bench([["a"], ["b"]]);
    b.place("a", 0, 5);
    const ball = b.arm("a");
    b.world.eliminate("a", "disconnect");
    const ko = b.of("ko", b.world.drainEvents())[0];
    expect(ko).toMatchObject({ playerId: "a", byId: "", cause: "disconnect" });
    expect(ball.state).toBe("dead");
    expect(b.p("a").alive).toBe(false);
  });

  it("stands disconnected players still and never fires their charge", () => {
    const b = new Bench([["a"]]);
    b.place("a", 0, 5);
    b.arm("a");
    b.send("a", { buttons: BTN.THROW, moveZ: 1 });
    b.tick();
    b.p("a").connected = false;
    const evs = b.run(10);
    expect(b.of("throw", evs)).toHaveLength(0);
    expect(b.p("a").heldCount).toBe(1);
  });
});
