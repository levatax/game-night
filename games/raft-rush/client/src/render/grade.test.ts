// grade.ts: the shader-chunk patches apply once, to this three build, and the toon ramp installs them.
// Owner: client-render.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { gradeToneMapping, installGrade } from "./grade";
import { getToonRamp } from "./Toon";

const chunks = THREE.ShaderChunk as unknown as Record<string, string>;

describe("color grade", () => {
  it("patches CustomToneMapping and the toon gradient once (idempotent)", () => {
    getToonRamp();
    expect(chunks.tonemapping_pars_fragment).toContain("Raft Rush grade");
    expect(chunks.gradientmap_pars_fragment).toContain("rampStep");
    const before = chunks.tonemapping_pars_fragment;
    expect(installGrade()).toBe(true);
    expect(chunks.tonemapping_pars_fragment).toBe(before);
    expect(chunks.tonemapping_pars_fragment!.match(/vec3 CustomToneMapping/g)).toHaveLength(1);
    expect(gradeToneMapping()).toBe(THREE.CustomToneMapping);
  });

  it("the toon ramp is soft: no pure-white lit band, a darker shade band", () => {
    const data = getToonRamp().image.data as Uint8Array;
    expect(data[2]).toBeLessThan(255);
    expect(data[0]).toBeLessThan(110);
  });
});
