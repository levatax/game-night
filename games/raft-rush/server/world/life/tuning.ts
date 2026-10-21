// Local tuning for the life systems (monsters, visitors, fishing reels, day events). Owner: server-world-life.
// Everything game4.md / shared/constants.ts specifies lives there; these are the in-between numbers the spec
// leaves open (reach distances, steering probes, how long a monkey sits in a tree…). Ticks are 30 Hz.

import { secToTicks } from "../../../shared/constants.js";

/* ------------------------------------------------------------- movement */

/** Forward probe length beyond the monster's radius (steering looks this far ahead). */
export const PROBE_DIST = 1.2;
/** Probe angles (degrees) tried in order; the sign of the first non-zero one follows the steering side memory. */
export const SWEEP_DEG: ReadonlyArray<number> = [0, 30, 60, 90, 135];
/** Keep preferring the side we last turned to for this long (no left/right flicker at a symmetric obstacle). */
export const STEER_HYSTERESIS_TICKS = 10;
/** Moved less than STUCK_EPS for this long while wanting to move → take a random detour. */
export const STUCK_TICKS = 15;
export const STUCK_EPS = 0.02;
export const DETOUR_TICKS = 20;
/** Steepest terrain a walker climbs (rise / run, ≈ 52°). */
export const CLIMB_GRADE = 1.3;
/** Walkers never go deeper than this (shore cells are 0.3–1.5 m deep; crabs stay on land + shallows). */
export const MONSTER_MIN_Y = -1.8;
/** Monkeys stay on dry land. */
export const MONKEY_MIN_Y = 0.05;
/** Light constraint pad: "inside" for movement means closer than r + LIGHT_PAD (a hair outside the true ring). */
export const LIGHT_PAD = 0.05;
/** Steering probes treat rings as this much bigger so walkers turn before the edge. */
export const PROBE_LIGHT_PAD = 0.1;
/** Knockback velocity kept per tick. */
export const KNOCK_DECAY = 0.85;
/** Knockback taken by armored crabs / the boss (× the projectile's knock vector). */
export const CRAB_KNOCK_MULT = 0.6;
export const BOSS_KNOCK_MULT = 0.25;
/** Soft separation: fraction of the overlap resolved per tick. */
export const SEPARATION_RATE = 0.5;
/** Turn smoothing toward the movement direction per tick (0..1). */
export const TURN_RATE = 0.35;
/** Emerging monsters wade ashore at this fraction of their speed. */
export const EMERGE_SPEED_MULT = 0.5;
/** Scared / escaping-light monsters hurry. */
export const SCARED_SPEED_MULT = 1.3;
/** Fleeing at dawn: a little faster than hunting. */
export const FLEE_SPEED_MULT = 1.15;
/** Dawn flee gives up (burrows into the sand and despawns) after this long. */
export const FLEE_TIMEOUT_TICKS = secToTicks(15);

/* -------------------------------------------------------------- combat */

/** Extra reach beyond the two radii for a bite. */
export const BITE_REACH = 0.35;
/** Wind-up before the bite lands (dodge window + client animation). */
export const BITE_WINDUP_TICKS = 6;
/** The bite still lands if the target is within reach + this when the wind-up ends. */
export const BITE_SLACK = 0.3;
/** Max feet height difference for a bite / contact. */
export const BITE_DY = 1.6;
/** A crab / boss within this of the raft center gnaws it. */
export const RAFT_GNAW_REACH = 2.5;
/** Crabs surround the raft on this ring (they don't stack on one spot). */
export const RAFT_SPREAD = 1.9;
/** Kaptan Yengeç gnaws this much hull wood per RAFT_GNAW_TICKS. */
export const BOSS_RAFT_GNAW = 2;
/** A puffer that reaches an unguarded raft pops and knocks this much wood off. */
export const PUFFER_RAFT_DAMAGE = 1;
/** Crabs at the chest rummage (cosmetic attack, no theft). */
export const CHEST_REACH = 1.5;
/** Puffers home on players from farther away than crabs (they roll fast). */
export const PUFFER_AGGRO_RADIUS = 18;
/** The boss only turns on players this close (or guarding the raft); otherwise it marches to the raft. */
export const BOSS_PLAYER_AGGRO = 4.5;
/** Keep chasing the current player target until it is this × the aggro radius away. */
export const AGGRO_KEEP_MULT = 1.4;
/** A puffer snagged on a fence sits there this long, then pops on the spikes (fence −1 hp). */
export const PUFFER_SNAG_TICKS = secToTicks(6);
/** Goal direction must point into a touched fence at least this much (dot) for a crab to gnaw it. */
export const FENCE_GNAW_DOT = 0.2;
/** Lit-player edge waiting: crabs spread around the ring edge by this angle step (radians). */
export const EDGE_SPREAD = 0.35;
/** Stand-off distance outside a ring edge. */
export const EDGE_STANDOFF = 0.45;

/* ------------------------------------------------------------ visitors */

/** Monkey: time spent grabbing at the chest / a victim. */
export const MONKEY_STEAL_TICKS = secToTicks(1);
/** Monkey: sits in its tree with the loot this long, then vanishes with it. */
export const MONKEY_TREE_TICKS = secToTicks(40);
/** Monkey: perch height above the tree base. */
export const MONKEY_TREE_HEIGHT = 3.2;
/** Monkey: gives up chasing a victim after this long (goes for the chest instead). */
export const MONKEY_CHASE_TICKS = secToTicks(20);
/** Monkeys spawn at a tree this far from the chest and escape to one this far. */
export const MONKEY_TREE_MIN = 9;
export const MONKEY_TREE_MAX = 24;
/** Monkeys go for Fenomen first when she is within this of the chest (§14 selfie stick). */
export const MONKEY_FENOMEN_RADIUS = 25;
/** Gull: cruising height above the terrain / sea and circle radius while taunting. */
export const GULL_FLY_HEIGHT = 6;
export const GULL_CIRCLE_RADIUS = 5;
/** Gull: starts this far out at sea from its victim. */
export const GULL_SPAWN_DIST = 28;
/** Gull: gives up the approach after this long. */
export const GULL_APPROACH_TICKS = secToTicks(25);
/** Gull: swoop duration at the victim. */
export const GULL_SWOOP_TICKS = secToTicks(0.4);
/** Visitors that leave (hit, done, dusk) despawn after this long. */
export const VISITOR_FLEE_TICKS = secToTicks(5);
/** Horizontal arrival distance for visitors. */
export const VISITOR_ARRIVE = 1.0;

/* -------------------------------------------------------------- events */

/** Wave gift: items land on dry sand (at least this high) inland of a shore cell. */
export const GIFT_MIN_Y = 0.2;
/** Wave gift: prefer shore cells within this of the camp (so players notice). */
export const GIFT_NEAR_CAMP = 40;
/** Wave gift: chance the first picker also gets a treasure reel. */
export const GIFT_TREASURE_CHANCE = 0.25;
/** Wave gift: materials (2 random) + a coconut. */
export const GIFT_MATERIALS = ["wood", "rope", "stone"] as const;
/** Gift pickup detection: a gift that vanished with a player this close was picked up by them. */
export const GIFT_PICKUP_SLACK = 1.2;
