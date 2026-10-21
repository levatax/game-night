// Completeness of the fx parameter tables: every burst kind has particle colors / counts / emit rates and a debris
// entry, every pop style is defined, letter jitter is deterministic. Owner: client-fx-audio.

import { describe, expect, it } from "vitest";
import { BURST_CHUNKS } from "./burstChunks";
import { BURST_KINDS, POP_STYLE_IDS } from "./Fx";
import { BURST_COUNT, EMIT_RATE, PARTICLE_COLORS } from "./Particles";
import { POP_STYLES } from "./PopText";
import { graphemes, letterJitter } from "./popAtlas";

describe("fx tables", () => {
  it("lists all 20 burst kinds once", () => {
    expect(BURST_KINDS.length).toBe(20);
    expect(new Set(BURST_KINDS).size).toBe(20);
  });

  it("every burst kind has colors, counts, rates and a debris spec", () => {
    for (const kind of BURST_KINDS) {
      expect(PARTICLE_COLORS[kind], kind).toMatch(/^#[0-9A-F]{6}$/i);
      expect(BURST_COUNT[kind], kind).toBeGreaterThan(0);
      expect(EMIT_RATE[kind], kind).toBeGreaterThan(0);
      expect(Array.isArray(BURST_CHUNKS[kind]), kind).toBe(true);
      for (const spec of BURST_CHUNKS[kind]) {
        expect(spec.count).toBeGreaterThan(0);
        expect(spec.colors.length).toBeGreaterThan(0);
        expect(spec.size).toBeGreaterThan(0);
      }
    }
  });

  it("debris goes with the physical bursts", () => {
    for (const kind of ["woodChips", "stoneChips", "crabBits", "blast", "berries"] as const) expect(BURST_CHUNKS[kind].length).toBeGreaterThan(0);
    for (const kind of ["sparkle", "confetti", "splash", "ripple"] as const) expect(BURST_CHUNKS[kind].length).toBe(0);
  });

  it("defines every pop style", () => {
    expect(POP_STYLE_IDS.length).toBe(6);
    for (const id of POP_STYLE_IDS) {
      const st = POP_STYLES[id];
      expect(st.height).toBeGreaterThan(0);
      expect(st.life).toBeGreaterThan(0.5);
      expect(st.colors.top).toMatch(/^#/);
    }
    expect(POP_STYLES.big.height).toBeGreaterThan(POP_STYLES.hit.height);
    expect(POP_STYLES.info.burst).toBeNull();
  });

  it("splits text into graphemes and jitters deterministically", () => {
    expect(graphemes("ÇAT!")).toEqual(["Ç", "A", "T", "!"]);
    expect(graphemes("İYİ")).toHaveLength(3);
    expect(letterJitter(12.3, 2)).toEqual(letterJitter(12.3, 2));
    expect(Math.abs(letterJitter(5, 1).rot)).toBeLessThan(0.11);
  });
});
