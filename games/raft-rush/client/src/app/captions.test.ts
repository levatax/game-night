// Sound captions: bearings relative to the view, which cues get a caption (crabs / puffers crawling ashore,
// a gnawed fence, an unexplained blast, thunder), the rate limits and range, no caption under the night banner,
// and every caption key in English and Turkish with the same {placeholders}. Owner: client-app.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { BlastEvent, MonsterSpawnEvent, StructureHitEvent } from "../../../shared/protocol";
import * as hud from "../i18n/strings/hud";
import type { NetEventMap } from "../net/types";
import type { CaptionEntry, FeedEntry } from "../ui/models";
import { Emitter } from "../util/Emitter";
import { CAPTION_KEYS, GameFeedback } from "./feedback";
import { bearingOf, type FeedbackContext } from "./feedbackContext";

/** Any method call is accepted and ignored (fx, audio, coach…). */
function sink(): Record<string, unknown> {
  return new Proxy({}, { get: (_t, prop) => (prop === "then" ? undefined : () => undefined) });
}

function rig() {
  const camera = new THREE.PerspectiveCamera(); // at the origin, looking down −Z
  camera.updateMatrixWorld();
  const events = new Emitter<NetEventMap>();
  const captions: CaptionEntry[] = [];
  const feed: FeedEntry[] = [];
  const ctx = {
    net: { events, island: null, localSim: null, me: null },
    input: sink(),
    renderer: { camera, fp: sink() },
    characters: { trigger: () => undefined, monsters: sink(), fpArms: sink() },
    fx: sink(),
    audio: sink(),
    ui: { caption: (e: CaptionEntry) => captions.push(e), feed: (e: FeedEntry) => feed.push(e), banner: () => undefined, toast: () => undefined },
    dir: { name: () => "Ada", character: () => null, view: (id: string) => (id === "p1" ? {} : null), color: () => "#fff", seat: () => 0 },
    later: sink(),
    pings: sink(),
    coach: sink(),
    localId: "me",
    nowMs: 0,
    position: () => false,
  };
  const feedback = new GameFeedback(ctx as unknown as FeedbackContext);
  feedback.attach();
  return { ctx, events, captions, feed, feedback, camera };
}

const spawn = (kind: MonsterSpawnEvent["kind"], x: number, z: number): MonsterSpawnEvent => ({ tick: 0, id: `m${x}${z}`, kind, pos: { x, y: 0, z }, night: 1 });

describe("bearingOf", () => {
  it("splits the circle around the view into ahead / right / behind / left", () => {
    const at = { x: 0, z: 0 };
    expect(bearingOf(at, 0, { x: 0, z: -10 })).toBe("ahead");
    expect(bearingOf(at, 0, { x: 10, z: 0 })).toBe("right");
    expect(bearingOf(at, 0, { x: 0, z: 10 })).toBe("behind");
    expect(bearingOf(at, 0, { x: -10, z: 0 })).toBe("left");
    // Facing −X (yaw +90°): −X is ahead, −Z on the right.
    expect(bearingOf(at, Math.PI / 2, { x: -10, z: 0 })).toBe("ahead");
    expect(bearingOf(at, Math.PI / 2, { x: 0, z: -10 })).toBe("right");
    expect(bearingOf(at, 0, { x: 0.5, z: 0.5 })).toBeNull();
  });
});

describe("GameFeedback sound captions", () => {
  it("captions a crab crawling ashore within earshot, with its bearing from the camera, at most every 8 s", () => {
    const r = rig();
    r.events.emit("monsterSpawn", spawn("crab", 0, 12));
    expect(r.captions).toEqual([{ key: "hud.cap_spawn_crab", params: { dir: " · behind you" }, icon: "🦀" }]);
    r.ctx.nowMs = 2000;
    r.events.emit("monsterSpawn", spawn("crab", 12, 0));
    expect(r.captions).toHaveLength(1);
    r.ctx.nowMs = 9000;
    r.events.emit("monsterSpawn", spawn("puffer", 12, 0));
    r.events.emit("monsterSpawn", spawn("crab", 12, 0));
    expect(r.captions.map((c) => [c.key, c.params?.dir])).toEqual([
      ["hud.cap_spawn_crab", " · behind you"],
      ["hud.cap_spawn_puffer", " · to your right"],
      ["hud.cap_spawn_crab", " · to your right"],
    ]);
  });

  it("stays quiet for far-off crabs, the boss (it has a banner) and right under the night banner", () => {
    const r = rig();
    r.events.emit("monsterSpawn", spawn("crab", 0, 80));
    r.events.emit("monsterSpawn", spawn("boss", 0, 10));
    expect(r.captions).toHaveLength(0);
    r.ctx.nowMs = 10_000;
    r.events.emit("dayPhase", { tick: 0, day: 2, dayPhase: "night" });
    r.ctx.nowMs = 11_000;
    r.events.emit("monsterSpawn", spawn("crab", 0, 10));
    expect(r.captions).toHaveLength(0);
    r.ctx.nowMs = 13_500;
    r.events.emit("monsterSpawn", spawn("crab", 0, -10));
    expect(r.captions.map((c) => c.params?.dir)).toEqual([" · ahead"]);
  });

  it("captions a fence gnawed by a monster (not a player) and a blast nobody got a feed line for", () => {
    const r = rig();
    const hit = (byId: string): StructureHitEvent => ({ tick: 0, id: "s1", kind: "fence", hp: 2, byId, pos: { x: -8, y: 0, z: 0 } });
    r.events.emit("structureHit", hit("p1"));
    expect(r.captions).toHaveLength(0);
    r.events.emit("structureHit", hit("m1"));
    expect(r.captions.map((c) => [c.key, c.params?.dir])).toEqual([["hud.cap_fence", " · to your left"]]);
    const blast = (monsters: string[]): BlastEvent => ({ tick: 0, byId: "p1", pos: { x: 0, y: 0, z: -6 }, radius: 3, inHand: false, players: [], monsters });
    r.events.emit("blast", blast(["m2"]));
    expect(r.captions).toHaveLength(1);
    expect(r.feed.map((f) => f.key)).toEqual(["feed.blast"]);
    r.events.emit("blast", blast([]));
    expect(r.captions.map((c) => c.key)).toEqual(["hud.cap_fence", "hud.cap_blast"]);
  });

  it("captions thunder, loud or distant, at most every 6 s", () => {
    const r = rig();
    r.feedback.thunder(1);
    r.ctx.nowMs = 3000;
    r.feedback.thunder(0.3);
    r.ctx.nowMs = 7000;
    r.feedback.thunder(0.3);
    expect(r.captions.map((c) => c.key)).toEqual(["hud.cap_thunderNear", "hud.cap_thunder"]);
  });
});

describe("caption strings", () => {
  const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
  const en: Record<string, string> = hud.en;
  const tr: Record<string, string> = hud.tr;

  it("every caption key and bearing exists in English and Turkish with the same placeholders", () => {
    const keys = [...CAPTION_KEYS.map((k) => `cap_${k}`), "dir_ahead", "dir_right", "dir_behind", "dir_left", "spectateHint"];
    for (const k of keys) {
      expect(en[k], `en ${k}`).toBeTruthy();
      expect(tr[k], `tr ${k}`).toBeTruthy();
      expect(placeholders(tr[k]!), k).toEqual(placeholders(en[k]!));
    }
  });
});
