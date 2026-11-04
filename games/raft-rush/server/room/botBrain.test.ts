// Unit tests for the pure bot brain (server/room/botBrain.ts + botSteer.ts + botAim.ts), game4.md §20
// "Bot beyni": goal priorities, the reconnect stand-in's movement-only menu, steering around a cylinder and
// along a cliff on a hand-made 32×32 heightfield, the stuck detector, the BFS fallback, and aimAt +
// stepProjectile landing within 1 m.
// Run: npx vitest run games/raft-rush/server/room

import { describe, expect, it } from "vitest";
import { DT, FIRE_FUEL_MAX_TICKS, RAFT_LAUNCH_STAGE, secToTicks } from "../../shared/constants.js";
import type { ProjectileContext } from "../../shared/sim/context.js";
import { createProjectileSim, stepProjectile } from "../../shared/sim/projectile.js";
import { computeThrowVelocity, throwOrigin } from "../../shared/sim/throw.js";
import type { ItemKind } from "../../shared/types.js";
import { aimVelocity, shotClear, solveAim } from "./botAim.js";
import { aimAt, aimFromPlayer, canCraft, chooseGoal, chooseStandInGoal, dutyOwner, shouldBoard, STAND_IN_GOALS } from "./botBrain.js";
import { raftAssemblyTicks, raftStageNeeds } from "../../shared/items.js";
import { raftProgress, raftUrgent, teamPlan } from "./botNeeds.js";
import { raftRows } from "./botSense.js";
import { NavGrid } from "./botNav.js";
import { newSteerMemory, steer, STUCK_WINDOW_TICKS, type SteerWorld } from "./botSteer.js";
import { cylinder, flatField, makeView, query, raise, walkStep } from "./botTestkit.js";
import type { BotMate, BotMonster, BotView, Goal } from "./botTypes.js";

function give(v: BotView, slot: number, kind: ItemKind, count = 1): void {
  v.self.slots[slot] = { kind, count };
}

function botMate(id: string, seat: number, role: BotMate["role"]): BotMate {
  return { id, seat, x: 0, z: 0, role, driven: true, human: false, alive: true, downed: false, downedTicks: 0, washed: false, boarded: false, hp: 100, hunger: 90, thirst: 90, slots: [] };
}

describe("chooseGoal priorities", () => {
  it("idles while input is locked or aboard", () => {
    expect(chooseGoal(makeView((v) => (v.clock.locked = true))).kind).toBe("idle");
    expect(chooseGoal(makeView((v) => (v.self.boarded = true))).kind).toBe("idle");
    expect(chooseGoal(makeView((v) => (v.clock.phase = "lobby"))).kind).toBe("idle");
  });

  it("gets rid of a fusing puffer before anything else", () => {
    const g = chooseGoal(
      makeView((v) => {
        give(v, 2, "puffer");
        v.self.hp = 10;
        v.self.hunger = 5;
        v.monsters.push({ id: "m1", kind: "crab", x: 9, y: 1, z: 0, mode: "hunt", hp: 2, vx: 0, vz: 0, targetId: "bot-1", carry: "" });
      }),
    );
    expect(g).toEqual({ kind: "throwAway", slot: 2, monsterId: "m1" });
  });

  it("flees on low hp with a crab close, but not from inside a light ring", () => {
    const crab = { id: "m1", kind: "crab" as const, x: 3, y: 1, z: 0, mode: "hunt" as const, hp: 2, vx: 0, vz: 0, targetId: "bot-1", carry: "" as const };
    const out = makeView((v) => {
      v.self.hp = 20;
      v.self.x = 20;
      v.monsters.push({ ...crab, x: 23 });
      give(v, 0, "stone", 2);
    });
    const g = chooseGoal(out);
    expect(g.kind).toBe("flee");
    const inLight = makeView((v) => {
      v.self.hp = 20;
      v.self.x = -4;
      v.self.z = 2;
      v.monsters.push({ ...crab, x: -1, z: 2 });
      give(v, 0, "stone", 2);
    });
    expect(chooseGoal(inLight).kind).toBe("attack");
  });

  it("revives a downed teammate before fighting or eating", () => {
    const g = chooseGoal(
      makeView((v) => {
        v.self.hunger = 30;
        give(v, 0, "coconut", 2);
        v.monsters.push({ id: "m1", kind: "crab", x: 15, y: 1, z: 0, mode: "hunt", hp: 2, vx: 0, vz: 0, targetId: "", carry: "" });
        v.mates.push({
          id: "h1",
          seat: 0,
          x: 8,
          z: 0,
          role: "",
          driven: false,
          human: true,
          alive: true,
          downed: true,
          downedTicks: secToTicks(8),
          washed: false,
          boarded: false,
          hp: 0,
          hunger: 50,
          thirst: 50,
          slots: [],
        });
      }),
    );
    expect(g).toEqual({ kind: "revive", playerId: "h1" });
  });

  it("skips a revive it can't reach before the timer runs out", () => {
    const g = chooseGoal(
      makeView((v) => {
        v.mates.push({ id: "h1", seat: 0, x: 60, z: 0, role: "", driven: false, human: true, alive: true, downed: true, downedTicks: 30, washed: false, boarded: false, hp: 0, hunger: 50, thirst: 50, slots: [] });
      }),
    );
    expect(g.kind).not.toBe("revive");
  });

  it("boards only during the push-off a human started; a bot-only team (or the storm close) starts it itself", () => {
    const human = { id: "h1", seat: 0, x: -30, z: -30, role: "" as const, driven: false, human: true, alive: true, downed: false, downedTicks: 0, washed: false, boarded: false, hp: 100, hunger: 80, thirst: 80, slots: [] };
    const waiting = makeView((v) => {
      ready(v);
      v.mates.push({ ...human });
    });
    expect(shouldBoard(waiting)).toBe(false);
    expect(chooseGoal(waiting).kind).not.toBe("board");
    // Even with the human right by the raft: the push-off is theirs to start.
    const close = makeView((v) => {
      ready(v);
      v.mates.push({ ...human, x: 8, z: 12 });
    });
    expect(chooseGoal(close).kind).not.toBe("board");
    const storm = makeView((v) => {
      ready(v);
      v.mates.push({ ...human });
      v.clock.stormLeft = secToTicks(60);
    });
    expect(chooseGoal(storm).kind).toBe("board");
    const countdown = makeView((v) => {
      ready(v);
      v.team.launchTicksLeft = 300;
      v.mates.push({ ...human });
    });
    expect(chooseGoal(countdown).kind).toBe("board");
    expect(chooseGoal(makeView((v) => ready(v))).kind).toBe("board");
    // Before the launch window opens (or with a weak raft) nobody boards.
    expect(shouldBoard(makeView((v) => (ready(v), (v.team.canBoard = false))))).toBe(false);
  });

  it("throws at a crab threatening the raft (stones before coconuts), and not without ammo", () => {
    const crab = { id: "m7", kind: "crab" as const, x: 9, y: 0.5, z: 17, mode: "bite" as const, hp: 2, vx: 0, vz: 0, targetId: "raft", carry: "" as const };
    const armed = makeView((v) => {
      v.self.x = 5;
      v.self.z = 10;
      give(v, 0, "coconut", 1);
      give(v, 1, "stone", 2);
      v.monsters.push(crab);
    });
    expect(chooseGoal(armed)).toEqual({ kind: "attack", monsterId: "m7", slot: 1 });
    const unarmed = makeView((v) => {
      v.self.x = 5;
      v.self.z = 10;
      v.monsters.push(crab);
    });
    expect(chooseGoal(unarmed).kind).not.toBe("attack");
  });

  it("attacks before eating, unless starving", () => {
    const base = (hunger: number) =>
      makeView((v) => {
        v.self.hunger = hunger;
        give(v, 0, "fish_cooked", 1);
        give(v, 1, "stone", 3);
        v.monsters.push({ id: "m1", kind: "crab", x: 8, y: 1, z: 0, mode: "hunt", hp: 2, vx: 0, vz: 0, targetId: "bot-1", carry: "" });
      });
    expect(chooseGoal(base(40)).kind).toBe("attack");
    expect(chooseGoal(base(10))).toEqual({ kind: "eat", slot: 0 });
  });

  it("eats / drinks from the inventory, else goes to the spring", () => {
    expect(chooseGoal(makeView((v) => ((v.self.thirst = 30), give(v, 3, "water", 2))))).toEqual({ kind: "eat", slot: 3 });
    expect(chooseGoal(makeView((v) => (v.self.thirst = 30))).kind).toBe("spring");
    const fromChest = makeView((v) => {
      v.self.thirst = 30;
      v.self.x = -5;
      v.self.z = 2;
      v.team.chest = { water: 2 };
    });
    expect(chooseGoal(fromChest)).toEqual({ kind: "chestTake", items: [{ kind: "water", count: 1 }] });
    expect(chooseGoal(makeView((v) => (v.self.hunger = 30))).kind).toBe("gather"); // berries
  });

  it("delivers a full load of keel rope, but nothing to a stage that isn't open yet", () => {
    const load = (v: BotView): void => {
      give(v, 0, "axe");
      give(v, 1, "rope", 5);
      give(v, 2, "rope", 5);
      give(v, 3, "rope", 5);
    };
    expect(chooseGoal(makeView(load)).kind).toBe("deliver");
    expect(chooseGoal(makeView((v) => (load(v), (v.team.stageOpen = false)))).kind).not.toBe("deliver");
  });

  it("Hamal crafts an axe when it can, otherwise chops", () => {
    const craftable = makeView((v) => {
      give(v, 0, "wood", 1);
      give(v, 1, "stone", 2);
      v.team.chest = { rope: 1 };
    });
    expect(chooseGoal(craftable)).toEqual({ kind: "craft", recipe: "axe", count: 1 });
    expect(chooseGoal(makeView())).toEqual({ kind: "gather", node: 0 });
  });

  it("Balıkçı makes a rod, then fishes", () => {
    const noRod = makeView((v) => {
      v.self.role = "balikci";
      give(v, 0, "wood", 2);
      give(v, 1, "rope", 1);
    });
    expect(chooseGoal(noRod)).toEqual({ kind: "craft", recipe: "rod", count: 1 });
    // (The provisions stage: the team lacks cooked food; the fire is fed and there is wood for tonight.)
    const rod = makeView((v) => {
      v.self.role = "balikci";
      give(v, 0, "rod");
      provisions(v);
      v.team.fireFuel = FIRE_FUEL_MAX_TICKS;
      v.team.chest = { wood: 10 };
    });
    expect(chooseGoal(rod)).toEqual({ kind: "fish", spot: 0 });
  });

  it("keeps the fire fuelled for the night at dusk", () => {
    const g = chooseGoal(
      makeView((v) => {
        v.clock.dayPhase = "dusk";
        v.clock.phaseLeft = secToTicks(8);
        v.team.fireFuel = secToTicks(10);
        give(v, 0, "wood", 4);
      }),
    );
    expect(g.kind).toBe("craft");
    if (g.kind === "craft") {
      expect(g.recipe).toBe("fuel");
      expect(g.count).toBeGreaterThanOrEqual(2);
    }
  });

  it("the raft guard (Bekçi first) takes a torch to the raft at night; the fire keeper plants one there at dusk", () => {
    const keel = (v: BotView): void => {
      v.team.stage = 1;
      v.team.raftHp = 100;
      v.team.fireFuel = FIRE_FUEL_MAX_TICKS;
      v.team.chest = { wood: 10 };
    };
    const hamal = botMate("bot-2", 2, "hamal");
    const crafts = makeView((v) => {
      keel(v);
      v.self.role = "bekci";
      v.clock.dayPhase = "dusk";
      v.clock.phaseLeft = secToTicks(8);
      v.team.chest = { wood: 10, rope: 2 };
      v.mates.push({ ...hamal });
    });
    expect(dutyOwner(crafts, "guard")).toBe("bot-1");
    expect(chooseGoal(crafts)).toEqual({ kind: "craft", recipe: "torch", count: 1 });
    const posted = makeView((v) => {
      keel(v);
      v.self.role = "bekci";
      v.clock.dayPhase = "night";
      v.clock.phaseLeft = secToTicks(40);
      give(v, 0, "stone", 3);
      give(v, 1, "torch");
      give(v, 2, "spear");
      give(v, 3, "axe");
      v.mates.push({ ...hamal });
    });
    expect(chooseGoal(posted).kind).toBe("guard");
    // Without a torch the guard stays in the fire's ring.
    const unarmed = makeView((v) => {
      keel(v);
      v.self.role = "bekci";
      v.clock.dayPhase = "night";
      v.clock.phaseLeft = secToTicks(40);
      v.team.chest = {};
      give(v, 2, "spear");
      give(v, 3, "axe");
      v.mates.push({ ...hamal });
    });
    expect(chooseGoal(unarmed).kind).toBe("camp");
    // The fire keeper (here the Hamal: no Aşçı / Balıkçı) plants its torch by the raft at dusk.
    const keeper = makeView((v) => {
      keel(v);
      v.self.role = "hamal";
      v.clock.dayPhase = "dusk";
      v.clock.phaseLeft = secToTicks(8);
      give(v, 2, "torch");
      v.mates.push({ ...botMate("bot-2", 2, "bekci") });
    });
    expect(dutyOwner(keeper, "fire")).toBe("bot-1");
    expect(chooseGoal(keeper)).toEqual({ kind: "plantTorch", slot: 2 });
  });

  it("stays at the camp at night instead of wandering off to work", () => {
    const g = chooseGoal(
      makeView((v) => {
        v.clock.dayPhase = "night";
        v.clock.phaseLeft = secToTicks(30);
        v.team.fireFuel = secToTicks(60);
      }),
    );
    expect(g.kind).toBe("camp");
  });

  it("burns a jellyfish in the fire", () => {
    expect(chooseGoal(makeView((v) => give(v, 1, "jellyfish")))).toEqual({ kind: "burn", slot: 1 });
  });

  it("keeps working the same node while it is still worth it", () => {
    const v = makeView((x) => {
      x.current = { kind: "gather", node: 1 };
      give(x, 0, "stone", 1);
    });
    expect(chooseGoal(v)).toEqual({ kind: "gather", node: 1 });
  });

  it("Aşçı tosses food to a hungry human", () => {
    const g = chooseGoal(
      makeView((v) => {
        v.self.role = "asci";
        give(v, 0, "fish_cooked", 2);
        v.mates.push({ id: "h1", seat: 0, x: 10, z: 0, role: "", driven: false, human: true, alive: true, downed: false, downedTicks: 0, washed: false, boarded: false, hp: 90, hunger: 20, thirst: 80, slots: [] });
      }),
    );
    expect(g).toEqual({ kind: "pass", playerId: "h1", slot: 0 });
  });
});

describe("chooseStandInGoal (reconnect stand-in)", () => {
  const crab = (id: string, x: number, z: number): BotMonster => ({ id, kind: "crab", x, y: 1, z, mode: "hunt", hp: 2, vx: 0, vz: 0, targetId: "", carry: "" });
  const human = (patch: Partial<BotMate> = {}): BotMate => ({ ...botMate("h1", 0, ""), driven: false, human: true, x: 8, z: 0, ...patch });
  const night = (v: BotView): void => {
    v.clock.dayPhase = "night";
    v.clock.phaseLeft = secToTicks(30);
  };

  /** Views where a full bot spends or changes its inventory (eat, throw, deliver, craft, plant, burn, pass, gather, …). */
  const tempting: [string, (v: BotView) => void][] = [
    ["hungry with food", (v) => ((v.self.hunger = 20), give(v, 0, "fish_cooked"))],
    ["thirsty with water", (v) => ((v.self.thirst = 20), give(v, 1, "water", 2))],
    ["thirsty, water in the chest", (v) => ((v.self.thirst = 20), (v.self.x = -5), (v.self.z = 2), (v.team.chest = { water: 2 }))],
    ["a puffer in the pocket", (v) => give(v, 2, "puffer")],
    ["a jellyfish and a lit fire", (v) => give(v, 3, "jellyfish")],
    ["stones and a crab at the raft", (v) => ((v.self.x = 5), (v.self.z = 10), give(v, 1, "stone", 2), v.monsters.push({ ...crab("m7", 9, 17), mode: "bite", targetId: "raft" }))],
    ["a full load of keel rope", (v) => (give(v, 0, "axe"), give(v, 1, "rope", 5), give(v, 2, "rope", 5), give(v, 3, "rope", 5))],
    ["an axe to craft", (v) => (give(v, 0, "wood", 1), give(v, 1, "stone", 2), (v.team.chest = { rope: 1 }))],
    ["a rod and a fish spot", (v) => ((v.self.role = "balikci"), give(v, 0, "rod"), provisions(v))],
    ["dusk, the fire short, wood in hand", (v) => ((v.clock.dayPhase = "dusk"), (v.clock.phaseLeft = secToTicks(8)), (v.team.fireFuel = secToTicks(10)), give(v, 0, "wood", 4))],
    ["dusk, the guard with a torch", (v) => ((v.self.role = "bekci"), (v.clock.dayPhase = "dusk"), (v.clock.phaseLeft = secToTicks(8)), give(v, 2, "torch"))],
    ["an Aşçı next to a hungry human", (v) => ((v.self.role = "asci"), give(v, 0, "fish_cooked", 2), v.mates.push(human({ x: 10, hunger: 20 })))],
    ["a coconut lying next to it", (v) => v.items.push({ id: "p1", kind: "coconut", x: 1.5, y: 1, z: 0, state: "rest", ownerId: "", baitTicks: 0 })],
    ["a free day to work", () => {}],
  ];

  it("never picks a goal that spends or changes the inventory, in every view where a full bot would", () => {
    for (const [name, patch] of tempting) {
      expect(STAND_IN_GOALS.has(chooseGoal(makeView(patch)).kind), name).toBe(false);
      for (const role of ["hamal", "balikci", "bekci", "asci"] as const) {
        const g = chooseStandInGoal(makeView((v) => ((v.self.role = role), patch(v))));
        expect(STAND_IN_GOALS.has(g.kind), `${name} (${role}): ${g.kind}`).toBe(true);
      }
    }
  });

  it("flees a crab that comes close at any hp (it can't fight back), but not from inside the light", () => {
    const g = chooseStandInGoal(
      makeView((v) => {
        v.self.x = 20;
        give(v, 0, "stone", 3);
        v.monsters.push(crab("m1", 23, 0));
      }),
    );
    expect(g).toMatchObject({ kind: "flee", from: "m1" });
    const lit = makeView((v) => {
      v.self.x = -4;
      v.self.z = 2;
      v.monsters.push(crab("m1", -1, 2));
    });
    expect(chooseStandInGoal(lit).kind).not.toBe("flee");
  });

  it("revives a downed teammate and crawls when downed itself", () => {
    const g = chooseStandInGoal(makeView((v) => v.mates.push(human({ downed: true, downedTicks: secToTicks(8), hp: 0 }))));
    expect(g).toEqual({ kind: "revive", playerId: "h1" });
    const downed = chooseStandInGoal(makeView((v) => ((v.self.downed = true), v.mates.push(human()))));
    expect(downed).toEqual({ kind: "crawl", to: { x: 8, z: 0 } });
  });

  it("boards the ready raft when the bots would (the push-off counting), else waits by it", () => {
    expect(chooseStandInGoal(makeView((v) => (ready(v), (v.team.launchTicksLeft = 600), v.mates.push(human({ x: 8, z: 12 })))))).toEqual({ kind: "board" });
    expect(chooseStandInGoal(makeView((v) => (ready(v), v.mates.push(human({ x: 8, z: 12 })))))).toMatchObject({ kind: "wait" });
    expect(chooseStandInGoal(makeView((v) => (ready(v), v.mates.push(human({ x: -30, z: -30 })))))).toMatchObject({ kind: "wait" });
  });

  it("keeps to the light after dark: the fire's ring, a planted torch, a teammate's torch, else a teammate", () => {
    // A camp spot plus the motor's 2.2 m ambling around it stays inside the light ring.
    const inRing = (g: Goal, l: { x: number; z: number; r: number }): boolean => g.kind === "camp" && Math.hypot(g.at.x - l.x, g.at.z - l.z) + 2.2 < l.r;
    const fire = chooseStandInGoal(makeView((v) => (night(v), (v.self.x = 30))));
    expect(inRing(fire, { x: -4, z: 2, r: 5 })).toBe(true);
    const out = (v: BotView): void => {
      night(v);
      v.team.fireFuel = 0;
      v.lights = [];
      v.mates.push(botMate("bot-2", 2, "hamal"));
    };
    const torch = chooseStandInGoal(makeView((v) => (out(v), v.torches.push({ x: 10, z: 10, life: 900 }), v.lights.push({ x: 10, z: 10, r: 4, kind: "planted" }))));
    expect(inRing(torch, { x: 10, z: 10, r: 4 })).toBe(true);
    const held = chooseStandInGoal(makeView((v) => (out(v), v.mates.push(human({ x: 12, z: -5 })), v.lights.push({ x: 12, z: -5, r: 4, kind: "torch" }))));
    expect(held).toEqual({ kind: "follow", playerId: "h1" });
    expect(chooseStandInGoal(makeView(out))).toEqual({ kind: "follow", playerId: "bot-2" });
  });

  it("rests at the fire when hurt, otherwise waits at the camp by day", () => {
    expect(chooseStandInGoal(makeView((v) => (v.self.hp = 30))).kind).toBe("warm");
    expect(chooseStandInGoal(makeView()).kind).toBe("camp");
    expect(chooseStandInGoal(makeView((v) => (v.clock.locked = true))).kind).toBe("idle");
  });
});

/** The provisions stage is current and open, nothing delivered yet. */
function provisions(v: BotView): void {
  v.team.stage = 5;
  v.team.rows = [{ item: "fish_cooked", kinds: ["fish_cooked", "crab_cooked", "fish_golden"], have: 0, need: 5 }, { item: "barrel", kinds: ["barrel"], have: 0, need: 2 }];
  v.team.nextRows = [];
}

/** Every stage assembled and the launch window open. */
function ready(v: BotView): void {
  v.team.stage = RAFT_LAUNCH_STAGE;
  v.team.rows = [];
  v.team.raftHp = 100;
  v.team.canBoard = true;
}

/** The deck (stage 1) is current, the mast next. */
function deck(v: BotView): void {
  v.team.stage = 1;
  v.team.raftHp = 100;
  v.team.rows = raftRows(1, () => 0, (i) => raftStageNeeds(1, 3)[i] ?? 0);
  v.team.nextRows = raftRows(2, () => 0, (i) => raftStageNeeds(2, 3)[i] ?? 0);
  v.team.raftWorkNeed = raftAssemblyTicks(1);
  v.team.fireFuel = FIRE_FUEL_MAX_TICKS;
}

describe("Long Tide economy (bill of materials, assembly, escort, repair)", () => {
  it("expands the raft's needs over RECIPES: planks → logs + the workbench, nails → the anvil + scrap", () => {
    const v = makeView((x) => {
      deck(x);
      x.team.chest = { wood: 20 };
    });
    const plan = teamPlan(v);
    // Deck: 12 planks = 4 sawn logs at the workbench (bench 1, not built yet).
    expect(plan.crafts.raft_part).toBeGreaterThanOrEqual(4);
    expect(plan.crafts.bench_1).toBe(1);
    expect(plan.raw.log).toBeGreaterThanOrEqual(4 + 1); // + the mast log (prestock)
    // The mast's nails need the anvil (bench 2) and scrap.
    expect(plan.crafts.nails).toBe(2);
    expect(plan.crafts.bench_2).toBe(1);
    expect(plan.raw.scrap).toBe(2 + 2);
    expect(plan.raw.rope).toBeGreaterThanOrEqual(4 + 5 + 2);
    // Planks in the chest count: fewer logs to saw.
    const stocked = teamPlan(makeView((x) => (deck(x), (x.team.chest = { wood: 20, raft_part: 6 }))));
    expect(stocked.crafts.raft_part).toBe(plan.crafts.raft_part! - 2);
    expect(stocked.raw.log).toBe(plan.raw.log - 2);
    // The workbench up: no bench_1 craft any more.
    expect(teamPlan(makeView((x) => (deck(x), (x.team.benchTier = 1)))).crafts.bench_1).toBeUndefined();
  });

  it("crafts the plan's processed materials at the camp (bench and day respected)", () => {
    const v = makeView((x) => {
      deck(x);
      x.self.x = -4;
      x.self.z = 4;
      x.team.benchTier = 1;
      x.team.chest = { log: 2, wood: 10 };
      give(x, 0, "axe");
      give(x, 1, "hammer");
    });
    // Both logs in the chest, as many planks as fit in its pockets.
    expect(chooseGoal(v)).toEqual({ kind: "craft", recipe: "raft_part", count: 2 });
    // No workbench yet: it builds the workbench first when it can.
    const noBench = makeView((x) => {
      deck(x);
      x.self.x = -4;
      x.self.z = 4;
      x.team.chest = { log: 2, wood: 10, rope: 4, stone: 4 };
      give(x, 0, "axe");
    });
    expect(chooseGoal(noBench)).toEqual({ kind: "craft", recipe: "bench_1", count: 1 });
    expect(canCraft(makeView((x) => ((x.team.benchTier = 1), (x.team.chest = { raft_part: 3, stone: 4, scrap: 2 }))), "bench_2")).toBe(false); // minDay 3
    expect(canCraft(makeView((x) => ((x.team.benchTier = 1), (x.clock.day = 3), (x.team.chest = { raft_part: 3, stone: 4, scrap: 2 }))), "bench_2")).toBe(true);
  });

  it("fells trees with an axe for logs, salvages the wreck with a hammer for scrap", () => {
    const keel = makeView((x) => {
      x.team.fireFuel = FIRE_FUEL_MAX_TICKS;
      x.team.benchTier = 1;
      x.team.chest = { wood: 10, rope: 10, stone: 10 };
      give(x, 0, "axe");
      give(x, 1, "hammer");
    });
    expect(chooseGoal(keel)).toEqual({ kind: "fell", node: 0 });
    // Without an axe there is no log to be had (hand chopping drops none).
    const noAxe = chooseGoal(makeView((x) => ((x.team.fireFuel = FIRE_FUEL_MAX_TICKS), (x.team.chest = { wood: 10, rope: 10, stone: 10 }))));
    expect(noAxe.kind).not.toBe("fell");
    const mast = makeView((x) => {
      x.team.stage = 2;
      x.team.raftHp = 100;
      x.team.benchTier = 2;
      x.clock.day = 3;
      x.team.rows = raftRows(2, (i) => (i === 1 ? 0 : (raftStageNeeds(2, 3)[i] ?? 0)), (i) => raftStageNeeds(2, 3)[i] ?? 0);
      x.team.nextRows = [];
      x.team.fireFuel = FIRE_FUEL_MAX_TICKS;
      x.team.chest = { wood: 10, rope: 10, stone: 10 };
      give(x, 0, "axe");
      give(x, 1, "hammer");
    });
    expect(chooseGoal(mast)).toEqual({ kind: "salvage" });
    expect(chooseGoal(makeView((x) => Object.assign(x, mast, { team: { ...mast.team, wreckScrap: 0 } }))).kind).not.toBe("salvage");
  });

  it("holds E at the raft once a stage's materials are in — both bots for the mast", () => {
    const full = (x: BotView, stage: number): void => {
      x.team.stage = stage;
      x.team.raftHp = 100;
      x.clock.day = 3;
      x.team.fireFuel = FIRE_FUEL_MAX_TICKS;
      x.team.rows = raftRows(stage, (i) => raftStageNeeds(stage, 3)[i] ?? 0, (i) => raftStageNeeds(stage, 3)[i] ?? 0);
      x.team.nextRows = raftRows(stage + 1, () => 0, (i) => raftStageNeeds(stage + 1, 3)[i] ?? 0);
    };
    expect(chooseGoal(makeView((x) => full(x, 0)))).toEqual({ kind: "assemble" });
    for (const role of ["hamal", "balikci"] as const) {
      const v = makeView((x) => {
        full(x, 2);
        x.self.role = role;
        x.mates.push(botMate("bot-2", 2, role === "hamal" ? "balikci" : "hamal"));
      });
      expect(chooseGoal(v), role).toEqual({ kind: "assemble" });
    }
    // Not before the stage's day: nothing to assemble yet.
    expect(chooseGoal(makeView((x) => (full(x, 2), (x.team.stageOpen = false)))).kind).not.toBe("assemble");
    // Too far away to come.
    expect(chooseGoal(makeView((x) => (full(x, 0), (x.self.x = -80), (x.self.z = -80)))).kind).not.toBe("assemble");
  });

  it("walks beside a teammate carrying a log (the nearest free bot), and carries its own log straight to the raft", () => {
    const carrier = { ...botMate("h1", 0, ""), x: 8, z: 0, driven: false, human: true, slots: [{ kind: "log" as const, count: 1 }] };
    const v = makeView((x) => {
      x.team.fireFuel = FIRE_FUEL_MAX_TICKS;
      x.team.benchTier = 1;
      x.team.chest = { wood: 10, rope: 10, stone: 10 };
      give(x, 0, "axe");
      give(x, 1, "hammer");
      x.mates.push({ ...carrier });
    });
    expect(chooseGoal(v)).toEqual({ kind: "escort", playerId: "h1" });
    // Someone already walks with them.
    const taken = makeView((x) => {
      x.team.fireFuel = FIRE_FUEL_MAX_TICKS;
      x.team.chest = { wood: 10, rope: 10, stone: 10 };
      x.mates.push({ ...carrier }, { ...botMate("bot-2", 2, "balikci"), x: 9, z: 0.5 });
    });
    expect(chooseGoal(taken).kind).not.toBe("escort");
    // Too far.
    expect(chooseGoal(makeView((x) => ((x.team.fireFuel = FIRE_FUEL_MAX_TICKS), x.mates.push({ ...carrier, x: 40, z: 0 })))).kind).not.toBe("escort");
    // Our own log: the keel takes it.
    expect(chooseGoal(makeView((x) => ((x.team.fireFuel = FIRE_FUEL_MAX_TICKS), give(x, 2, "log"))))).toEqual({ kind: "deliver" });
    // A log the current stage doesn't take (the deck: it becomes planks) goes into the chest.
    expect(chooseGoal(makeView((x) => (deck(x), give(x, 2, "log"))))).toEqual({ kind: "chestPut", items: [{ kind: "log", count: 1 }] });
  });

  it("patches the raft with a hammer and a plank (fetching planks from the chest) when its hp is low", () => {
    const low = (x: BotView): void => {
      x.team.stage = 2;
      x.team.raftHp = 40;
      x.clock.day = 3;
      x.team.fireFuel = FIRE_FUEL_MAX_TICKS;
      x.team.rows = raftRows(2, () => 0, (i) => raftStageNeeds(2, 3)[i] ?? 0);
      x.team.nextRows = [];
      give(x, 0, "axe");
      give(x, 1, "hammer");
    };
    expect(chooseGoal(makeView((x) => (low(x), give(x, 2, "raft_part", 2))))).toEqual({ kind: "repair" });
    expect(chooseGoal(makeView((x) => (low(x), (x.team.chest = { raft_part: 4 }))))).toEqual({ kind: "chestTake", items: [{ kind: "raft_part", count: 2 }] });
    // Healthy raft, or no hammer: no repair.
    expect(chooseGoal(makeView((x) => (low(x), (x.team.raftHp = 90), give(x, 2, "raft_part", 2)))).kind).not.toBe("repair");
    expect(chooseGoal(makeView((x) => (low(x), give(x, 1, "rope", 1), give(x, 2, "raft_part", 2)))).kind).not.toBe("repair");
  });
});

describe("pacing and duties", () => {
  it("measures raft progress over the stages (materials, then assembly)", () => {
    const v = makeView();
    expect(raftProgress(v.team)).toBe(0);
    for (const r of v.team.rows) r.have = r.need;
    const mats = raftProgress(v.team);
    expect(mats).toBeGreaterThan(0.1);
    v.team.raftWork = v.team.raftWorkNeed;
    expect(raftProgress(v.team)).toBeGreaterThan(mats);
    v.team.stage = RAFT_LAUNCH_STAGE;
    expect(raftProgress(v.team)).toBe(1);
  });

  it("calls everyone to the raft on the last day", () => {
    const v = makeView((x) => {
      x.self.role = "balikci";
      give(x, 0, "rod");
      x.clock.day = x.clock.days;
      x.team.fireFuel = FIRE_FUEL_MAX_TICKS;
      x.team.chest = { wood: 10 };
    });
    expect(raftUrgent(v)).toBe(true);
    // The keel needs rope: even the fisher goes for the rope bush.
    expect(chooseGoal(v)).toEqual({ kind: "gather", node: 2 });
    expect(raftUrgent(makeView((x) => (x.clock.day = 1)))).toBe(false);
  });

  it("spreads the team duties over the bots", () => {
    const v = makeView((x) => {
      x.self.role = "hamal";
      x.self.seat = 1;
      x.mates.push(botMate("bot-2", 2, "balikci"));
    });
    // Two bots, no Bekçi / Aşçı: the Hamal guards, the Balıkçı keeps the fire.
    expect(dutyOwner(v, "guard")).toBe("bot-1");
    expect(dutyOwner(v, "fire")).toBe("bot-2");
    const solo = makeView();
    expect(dutyOwner(solo, "guard")).toBe("bot-1");
    expect(dutyOwner(solo, "fire")).toBe("bot-1");
  });

  it("a teammate carrying the only torch plants it when the guard has none", () => {
    const v = makeView((x) => {
      x.self.role = "balikci";
      x.self.seat = 2;
      x.clock.dayPhase = "dusk";
      x.clock.phaseLeft = secToTicks(6);
      x.team.fireFuel = FIRE_FUEL_MAX_TICKS;
      x.team.stage = 1;
      x.team.raftHp = 100;
      x.team.chest = { wood: 10 };
      give(x, 1, "torch");
      x.mates.push(botMate("bot-9", 1, "bekci"));
    });
    expect(chooseGoal(v)).toEqual({ kind: "plantTorch", slot: 1 });
  });
});

/* ---------------------------------------------------------------- steering */

/** Walk with steer() + the kinematic walker until arrival; returns the path. */
function run(world: SteerWorld, from: { x: number; z: number }, to: { x: number; z: number }, maxTicks = 900) {
  const mem = newSteerMemory();
  let x = from.x;
  let z = from.z;
  let yaw = 0;
  const path: { x: number; z: number }[] = [];
  let arrived = false;
  let stuck = 0;
  for (let t = 0; t < maxTicks; t++) {
    const s = steer(world, { x, z, yaw }, { x: to.x, z: to.z, r: 0.6 }, mem);
    if (s.stuck) stuck++;
    if (s.arrived) {
      arrived = true;
      break;
    }
    yaw = s.yaw;
    const next = walkStep(world, x, z, s.dirX, s.dirZ, 4.6 * s.speed);
    x = next.x;
    z = next.z;
    path.push({ x, z });
  }
  return { arrived, path, stuck, ticks: path.length };
}

describe("steer", () => {
  it("gets around a cylinder in the way", () => {
    const terrain = flatField(33, 33, 1);
    const pillar = cylinder(0, 0, 1.2, 1);
    const world: SteerWorld = { ...query(terrain, [pillar]), nav: null };
    const r = run(world, { x: 0.1, z: 8 }, { x: 0, z: -8 });
    expect(r.arrived).toBe(true);
    expect(r.ticks).toBeLessThan(150);
    for (const p of r.path) expect(Math.hypot(p.x - pillar.x, p.z - pillar.z)).toBeGreaterThan(pillar.r + 0.3);
  });

  it("walks along a cliff to its end instead of into it", () => {
    // A 3 m high plateau wall across the way (x −16..6, z −2..2), target straight behind it.
    const terrain = flatField(33, 33, 0.5);
    raise(terrain, -16, 6, -2, 2, 3.5);
    const world: SteerWorld = { ...query(terrain), nav: null };
    const r = run(world, { x: -2, z: 9 }, { x: -2, z: -9 });
    expect(r.arrived).toBe(true);
    // Never climbed the plateau.
    for (const p of r.path) expect(p.x > 6 || p.z > 2.6 || p.z < -2.6).toBe(true);
  });

  it("detects being stuck: jump + random escape heading", () => {
    const terrain = flatField(33, 33, 1);
    const world: SteerWorld = { ...query(terrain), nav: null };
    const mem = newSteerMemory();
    let first = -1;
    let jumped = false;
    for (let t = 0; t < STUCK_WINDOW_TICKS + 5; t++) {
      // The bot "walks" but never moves (glued in place by something steer can't see).
      const s = steer(world, { x: 0, z: 0, yaw: 0 }, { x: 0, z: -10, r: 0.5 }, mem, () => 0.25);
      if (s.stuck && first < 0) {
        first = t;
        jumped = s.jump;
        // Escape heading is the rng's (0.25 turn = +z), not the target's (−z).
        expect(s.dirZ).toBeGreaterThan(0.9);
      }
    }
    expect(first).toBe(STUCK_WINDOW_TICKS);
    expect(jumped).toBe(true);
    expect(mem.stuckCount).toBe(1);
  });

  it("falls back to a BFS path out of a U-shaped trap", () => {
    const terrain = flatField(33, 33, 1);
    // A cup of rocks open to +z, the target behind its closed −z side.
    const rocks = [];
    for (let x = -4; x <= 4; x += 1) rocks.push(cylinder(x, -3, 0.6, 1));
    for (let z = -2; z <= 3; z += 1) rocks.push(cylinder(-4, z, 0.6, 1), cylinder(4, z, 0.6, 1));
    const q = query(terrain, rocks);
    const world: SteerWorld = { ...q, nav: new NavGrid(q) };
    const r = run(world, { x: 0, z: 0 }, { x: 0, z: -10 }, 1500);
    expect(r.arrived).toBe(true);
  });
});

/* ------------------------------------------------------------------ aiming */

describe("aimAt", () => {
  const terrain = flatField(97, 97, 0);
  const ctx: ProjectileContext = { ...query(terrain), dt: DT };

  /** Closest approach of the real projectile path to the target (before it lands). */
  function miss(kind: ItemKind, distM: number): number {
    const origin = { x: 0, y: 1.4, z: 0 };
    const target = { x: distM * 0.6, y: 0.3, z: -distM * 0.8 };
    const aim = aimAt(origin, target, kind, 0, () => 0.5);
    expect(aim).not.toBeNull();
    const vel = computeThrowVelocity(aim!.charge, aim!.yaw, aim!.pitch);
    const b = createProjectileSim(kind);
    Object.assign(b, { x: origin.x, y: origin.y, z: origin.z, vx: vel.x, vy: vel.y, vz: vel.z, state: "live" });
    let best = Infinity;
    for (let i = 0; i < 300; i++) {
      best = Math.min(best, Math.hypot(b.x - target.x, b.y - target.y, b.z - target.z));
      const r = stepProjectile(b, ctx);
      if (b.state !== "live" || r.sank) break;
    }
    return best;
  }

  for (const kind of ["coconut", "stone", "spear"] as ItemKind[]) {
    for (const d of [10, 20, 30]) {
      it(`${kind} lands within 1 m at ${d} m`, () => {
        expect(miss(kind, d)).toBeLessThan(1);
      });
    }
  }

  it("uses whole charge ticks and a flat-enough arc", () => {
    const aim = aimAt({ x: 0, y: 1.4, z: 0 }, { x: 0, y: 0.3, z: -20 }, "stone", 0, () => 0.5)!;
    expect(Number.isInteger(aim.chargeTicks)).toBe(true);
    expect(aim.charge).toBeCloseTo(aim.chargeTicks / 18, 9);
    expect(aim.pitch).toBeLessThan(0.4);
  });

  it("adds personality noise only when asked", () => {
    const o = { x: 0, y: 1.4, z: 0 };
    const t = { x: 0, y: 0.3, z: -15 };
    const exact = aimAt(o, t, "coconut", 0, () => 0.9)!;
    const noisy = aimAt(o, t, "coconut", 3, () => 0.9)!;
    expect(noisy.yaw).not.toBeCloseTo(exact.yaw, 4);
    expect(Math.abs(noisy.yaw - exact.yaw)).toBeLessThan((3 * 3 * Math.PI) / 180);
  });

  it("aims from a player's hand and leads a moving target", () => {
    const p = { x: 0, y: 0, z: 0 };
    const still = aimFromPlayer(p, { x: 0, y: 0.3, z: -15 }, null, "stone", 0, () => 0.5)!;
    const moving = aimFromPlayer(p, { x: 0, y: 0.3, z: -15 }, { x: 3, z: 0 }, "stone", 0, () => 0.5)!;
    // Leading a target moving toward +x turns the throw right (yaw decreases).
    expect(moving.yaw).toBeLessThan(still.yaw);
    const origin = throwOrigin({ ...p, yaw: still.yaw });
    expect(origin.y).toBeGreaterThan(1);
  });

  it("returns null out of range", () => {
    expect(aimAt({ x: 0, y: 1.4, z: 0 }, { x: 0, y: 0, z: -90 }, "stone", 0, () => 0.5)).toBeNull();
  });

  it("sees a trunk in the line of fire and lobs over it", () => {
    const field = flatField(65, 65, 0);
    const trunk = { ...cylinder(0, -6, 0.35, 0), top: 4 };
    const q = query(field, [trunk]);
    const origin = { x: 0, y: 1.4, z: 0 };
    const target = { x: 0, y: 0.3, z: -14 };
    const flat = solveAim(origin, target, "stone")!;
    expect(shotClear(q, origin, aimVelocity(flat), "stone", target, 0.5, [])).toBe(false);
    const lob = solveAim(origin, target, "stone", { high: true })!;
    expect(lob.pitch).toBeGreaterThan(0.6);
    expect(shotClear(q, origin, aimVelocity(lob), "stone", target, 0.5, [])).toBe(true);
    // A teammate standing in the way blocks too (near the target, where the stone flies at head height).
    const open = query(field);
    expect(shotClear(open, origin, aimVelocity(flat), "stone", target, 0.5, [{ x: 0, y: 0, z: -12, r: 0.47, h: 1.7 }])).toBe(false);
    expect(shotClear(open, origin, aimVelocity(flat), "stone", target, 0.5, [{ x: 3, y: 0, z: -12, r: 0.47, h: 1.7 }])).toBe(true);
    expect(shotClear(open, origin, aimVelocity(flat), "stone", target, 0.5, [])).toBe(true);
  });
});
