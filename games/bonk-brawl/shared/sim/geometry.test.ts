import { describe, expect, it } from "vitest";
import { BALL_RADIUS, MEGA_BALL_RADIUS, PLAYER_HEIGHT, PLAYER_RADIUS, SLIDE_HEIGHT } from "../constants.js";
import { getArena, type CoverBox, type CoverCylinder } from "../maps.js";
import {
  coverTopAt,
  groundHeightAt,
  isFloorAt,
  pointInCover,
  raycastWorld,
  resolveCoverCollision,
  ringIndexAt,
  segmentCapsuleOverlap,
  sphereCapsuleOverlap,
  sphereCoverContact,
  type CoverHit,
} from "./geometry.js";
import { vec3 } from "./math.js";
import { solidRings } from "./testkit.js";

const picnic = getArena("picnic");
const bath = getArena("bath");
const cake = getArena("cake");
const table = picnic.cover[0] as CoverBox;
const basket = picnic.cover[2] as CoverCylinder;

describe("rings", () => {
  it("finds circle rings by Euclidean distance", () => {
    expect(ringIndexAt(picnic, 0, 0)).toBe(0);
    expect(ringIndexAt(picnic, 5, 0)).toBe(0);
    expect(ringIndexAt(picnic, 6, 0)).toBe(1);
    expect(ringIndexAt(picnic, 0, -14.9)).toBe(4);
    expect(ringIndexAt(picnic, 10.5, 10.5)).toBe(4); // 14.85 m
    expect(ringIndexAt(picnic, 11, 11)).toBe(-1); // 15.56 m: past the edge
  });

  it("uses the superellipse metric for rounded-square islands", () => {
    // (|x|^4 + |z|^4)^(1/4): the corners reach much further out than a circle would.
    expect(ringIndexAt(bath, 10.5, 10.5)).toBe(3); // 12.49
    expect(ringIndexAt(bath, 12, 12)).toBe(4); // 14.27 (a circle would be off the island at 16.97)
    expect(ringIndexAt(bath, 12.5, 12.5)).toBe(-1); // 14.86 > 14.5
    expect(ringIndexAt(bath, 14.4, 0)).toBe(4);
    expect(ringIndexAt(bath, 0, -14.6)).toBe(-1);
    expect(ringIndexAt(bath, -6, 6)).toBe(1); // 7.14: same point is a ring further in than on a circle
    expect(ringIndexAt(picnic, -6, 6)).toBe(2); // 8.49
  });

  it("has floor only where the ring is not fallen", () => {
    const q = { arena: picnic, rings: [0, 0, 0, 1, 2] };
    expect(isFloorAt(q, 0, 0)).toBe(true);
    expect(isFloorAt(q, 11, 0)).toBe(true); // shaking ring is still solid
    expect(isFloorAt(q, 14, 0)).toBe(false); // fallen
    expect(isFloorAt(q, 16, 0)).toBe(false); // beyond the edge
    expect(isFloorAt({ arena: picnic, rings: [] }, 14, 0)).toBe(true); // missing entries count as solid
  });
});

describe("cover footprints and support", () => {
  it("tests rotated box footprints in the box frame", () => {
    // Along the box's local +X axis (world right(rotation)), just inside and just outside.
    const rx = Math.cos(table.rotation);
    const rz = -Math.sin(table.rotation);
    expect(pointInCover(table, table.x + rx * 1.45, table.z + rz * 1.45, 0)).toBe(true);
    expect(pointInCover(table, table.x + rx * 1.55, table.z + rz * 1.55, 0)).toBe(false);
    expect(pointInCover(table, table.x + rx * 1.55, table.z + rz * 1.55, 0.1)).toBe(true);
    expect(pointInCover(basket, basket.x + 0.7, basket.z, 0)).toBe(true);
    expect(pointInCover(basket, basket.x + 0.8, basket.z, 0)).toBe(false);
  });

  it("reports the highest overlapping cover top", () => {
    expect(coverTopAt(picnic, table.x, table.z, 0)).toBe(table.height);
    expect(coverTopAt(picnic, 0, 0, 0.2)).toBe(-Infinity);
  });

  it("supports bodies on the floor and on cover tops they can reach", () => {
    const q = { arena: picnic, rings: solidRings(picnic) };
    expect(groundHeightAt(q, 0, 0, 0.27, 0)).toBe(0);
    expect(groundHeightAt(q, table.x, table.z, 0.27, 0)).toBe(0); // can't snap up a 0.85 m wall
    expect(groundHeightAt(q, table.x, table.z, 0.27, 0.6)).toBe(table.height);
    expect(groundHeightAt(q, table.x, table.z, 0.27, 2)).toBe(table.height);
    expect(groundHeightAt(q, 0, 0, 0.27, -0.5)).toBe(-Infinity); // below the island top: no snapping back
    expect(groundHeightAt(q, 20, 0, 0.27, 0)).toBe(-Infinity);
    expect(groundHeightAt({ arena: picnic, rings: [0, 0, 0, 0, 2] }, 13.5, 0, 0.27, 0)).toBe(-Infinity);
  });
});

describe("capsule vs cover", () => {
  it("pushes a capsule radially out of a cylinder and slides along it", () => {
    const pos = vec3(basket.x + 0.9, 0, basket.z);
    const vel = vec3(-5, 0, 2);
    expect(resolveCoverCollision(picnic, pos, PLAYER_RADIUS, PLAYER_HEIGHT, vel)).toBe(true);
    expect(Math.hypot(pos.x - basket.x, pos.z - basket.z)).toBeCloseTo(basket.radius + PLAYER_RADIUS, 9);
    expect(vel.x).toBeCloseTo(0, 9);
    expect(vel.z).toBe(2);
  });

  it("reflects the velocity with restitution and reports the impact", () => {
    const pos = vec3(basket.x + 0.9, 0, basket.z);
    const vel = vec3(-5, 0, 2);
    const hit: CoverHit = { impact: 0 };
    expect(resolveCoverCollision(picnic, pos, PLAYER_RADIUS, PLAYER_HEIGHT, vel, 0.5, hit)).toBe(true);
    expect(vel.x).toBeCloseTo(2.5, 9); // −5 reflected × 0.5
    expect(vel.z).toBe(2);
    expect(hit.impact).toBeCloseTo(5, 9);
    // Already moving away: untouched, no impact.
    const away = vec3(5, 0, 0);
    const none: CoverHit = { impact: 0 };
    resolveCoverCollision(picnic, vec3(basket.x + 0.9, 0, basket.z), PLAYER_RADIUS, PLAYER_HEIGHT, away, 0.5, none);
    expect(away.x).toBe(5);
    expect(none.impact).toBe(0);
  });

  it("pushes a capsule out of a rotated box", () => {
    const pos = vec3(table.x + 0.3, 0, table.z - 0.2);
    expect(resolveCoverCollision(picnic, pos, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(true);
    expect(pointInCover(table, pos.x, pos.z, PLAYER_RADIUS - 1e-6)).toBe(false);
  });

  it("ignores cover the capsule is standing on or stepping over", () => {
    const onTop = vec3(basket.x, basket.height, basket.z);
    expect(resolveCoverCollision(picnic, onTop, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(false);
    const below = vec3(basket.x + 0.5, -2, basket.z);
    expect(resolveCoverCollision(picnic, below, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(false);
  });
});

describe("sphere vs cover", () => {
  it("returns side and top contacts with outward normals", () => {
    const side = sphereCoverContact(picnic, vec3(basket.x + basket.radius + 0.2, 0.5, basket.z), BALL_RADIUS);
    expect(side).not.toBeNull();
    expect(side!.coverIndex).toBe(2);
    expect(side!.nx).toBeCloseTo(1, 9);
    expect(side!.depth).toBeCloseTo(0.05, 9);

    const top = sphereCoverContact(picnic, vec3(basket.x, basket.height + 0.2, basket.z), BALL_RADIUS);
    expect(top!.ny).toBe(1);
    expect(top!.depth).toBeCloseTo(0.05, 9);

    expect(sphereCoverContact(picnic, vec3(0, 0.5, 0), BALL_RADIUS)).toBeNull();
  });

  it("uses the mega radius for contacts", () => {
    const center = vec3(basket.x + basket.radius + 0.4, 0.5, basket.z);
    expect(sphereCoverContact(picnic, center, BALL_RADIUS)).toBeNull();
    expect(sphereCoverContact(picnic, center, MEGA_BALL_RADIUS)?.depth).toBeCloseTo(0.1, 9);
  });

  it("finds thin candles", () => {
    const candle = cake.cover[0] as CoverCylinder;
    const c = sphereCoverContact(cake, vec3(candle.x, 1, candle.z + 0.5), BALL_RADIUS);
    expect(c?.coverIndex).toBe(0);
    expect(c?.nz).toBeCloseTo(1, 9);
  });
});

describe("sphereCapsuleOverlap", () => {
  const feet = vec3(0, 0, 0);

  it("hits a standing player anywhere along the capsule", () => {
    expect(sphereCapsuleOverlap(vec3(0.6, 1.0, 0), BALL_RADIUS, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(true);
    expect(sphereCapsuleOverlap(vec3(0, 1.6, 0), BALL_RADIUS, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(true);
    expect(sphereCapsuleOverlap(vec3(0.75, 1.0, 0), BALL_RADIUS, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(false);
    expect(sphereCapsuleOverlap(vec3(0, 1.7, 0), BALL_RADIUS, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(false);
    expect(sphereCapsuleOverlap(vec3(0.9, 1.0, 0), BALL_RADIUS, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(false);
    expect(sphereCapsuleOverlap(vec3(0.9, 1.0, 0), MEGA_BALL_RADIUS, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(true);
  });

  it("lets chest-height balls fly over a belly slide but not low ones", () => {
    const chestBall = vec3(0.1, 1.0, 0);
    expect(sphereCapsuleOverlap(chestBall, BALL_RADIUS, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(true);
    expect(sphereCapsuleOverlap(chestBall, BALL_RADIUS, feet, PLAYER_RADIUS, SLIDE_HEIGHT)).toBe(false);
    expect(sphereCapsuleOverlap(vec3(0.3, 0.4, 0), BALL_RADIUS, feet, PLAYER_RADIUS, SLIDE_HEIGHT)).toBe(true);
    // The slide hitbox tops out at SLIDE_HEIGHT: a ball resting its bottom just above it misses.
    expect(sphereCapsuleOverlap(vec3(0, SLIDE_HEIGHT + BALL_RADIUS + 0.01, 0), BALL_RADIUS, feet, PLAYER_RADIUS, SLIDE_HEIGHT)).toBe(false);
  });

  it("follows the capsule's feet", () => {
    const raised = vec3(3, 0.85, -2);
    expect(sphereCapsuleOverlap(vec3(3, 1.85, -2.3), BALL_RADIUS, raised, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(true);
    expect(sphereCapsuleOverlap(vec3(3, 0.3, -2), BALL_RADIUS, raised, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(false);
  });
});

describe("segmentCapsuleOverlap", () => {
  const feet = vec3(0, 0, 0);

  it("catches a fast grazing pass that both tick samples miss", () => {
    // 34 m/s ball: 1.13 m per tick, passing 0.6 m beside the capsule axis at chest height.
    const a = vec3(-0.6, 1, 0.57);
    const b = vec3(-0.6, 1, -0.56);
    const r = BALL_RADIUS;
    expect(sphereCapsuleOverlap(a, r, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(false);
    expect(sphereCapsuleOverlap(b, r, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(false);
    expect(segmentCapsuleOverlap(a, b, r, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(true);
  });

  it("misses a pass outside the reach and matches the point test for a zero-length segment", () => {
    const a = vec3(-0.75, 1, 1);
    const b = vec3(-0.75, 1, -1);
    expect(segmentCapsuleOverlap(a, b, BALL_RADIUS, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(false);
    for (const p of [vec3(0.5, 0.2, 0), vec3(0, 1.7, 0.1), vec3(0.69, 1, 0), vec3(0.71, 1, 0), vec3(0, -0.3, 0)]) {
      expect(segmentCapsuleOverlap(p, p, BALL_RADIUS, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(
        sphereCapsuleOverlap(p, BALL_RADIUS, feet, PLAYER_RADIUS, PLAYER_HEIGHT),
      );
    }
  });

  it("respects the capsule ends (over the head, under a belly slide)", () => {
    const over = [vec3(-1, 2.0, 0), vec3(1, 2.0, 0)];
    expect(segmentCapsuleOverlap(over[0], over[1], BALL_RADIUS, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(false);
    const head = [vec3(-1, 1.0, 0), vec3(1, 1.0, 0)];
    expect(segmentCapsuleOverlap(head[0], head[1], BALL_RADIUS, feet, PLAYER_RADIUS, SLIDE_HEIGHT)).toBe(false);
    expect(segmentCapsuleOverlap(head[0], head[1], BALL_RADIUS, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(true);
    // Diving steeply through the capsule top.
    expect(segmentCapsuleOverlap(vec3(0.2, 2.5, 0), vec3(0.2, 1.2, 0), BALL_RADIUS, feet, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(true);
  });
});

describe("raycastWorld", () => {
  const q = { arena: picnic, rings: solidRings(picnic) };

  it("hits the floor from above", () => {
    expect(raycastWorld(q, vec3(0, 3, 0), vec3(0, -1, 0), 10)).toBeCloseTo(3, 9);
    expect(raycastWorld({ arena: picnic, rings: [0, 0, 0, 0, 2] }, vec3(13.5, 3, 0), vec3(0, -1, 0), 10)).toBe(10);
  });

  it("hits cover sides and tops, and returns 0 from inside", () => {
    const d = raycastWorld(q, vec3(basket.x + 3, 0.5, basket.z), vec3(-1, 0, 0), 10);
    expect(d).toBeCloseTo(3 - basket.radius, 9);
    const down = raycastWorld(q, vec3(basket.x, 4, basket.z), vec3(0, -1, 0), 10);
    expect(down).toBeCloseTo(4 - basket.height, 9);
    expect(raycastWorld(q, vec3(basket.x, 0.4, basket.z), vec3(1, 0, 0), 10)).toBe(0);
    const tableHit = raycastWorld(q, vec3(table.x, 0.5, table.z + 5), vec3(0, 0, -1), 10);
    expect(tableHit).toBeGreaterThan(3);
    expect(tableHit).toBeLessThan(5);
  });

  it("returns maxDist when nothing is in the way", () => {
    expect(raycastWorld(q, vec3(0, 2, 0), vec3(0, 0.6, 0.8), 7)).toBe(7);
  });
});
