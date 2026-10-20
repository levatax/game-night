// Audio harness: every sound, voice, loop, track and jingle of the AudioEngine in isolation, a
// spatial pad to hear HRTF panning, stress buttons for voice limiting, and an offline gallery that
// renders everything through OfflineAudioContext and checks it (not silent, no NaN, peak ≤ 1).
// Dev only (served by dev/vite.audio.config.ts, not in the build).
// Automation hook: window.audioHarness (see the bottom of this file).

import { CHARACTER_IDS, CHARACTERS } from "../../shared/constants";
import type { CharacterId, Vec3Like } from "../../shared/types";
import { AudioEngine, type LoopHandle } from "../src/audio/AudioEngine";
import type { Jingle, MusicTrack } from "../src/audio/Music";
import { MusicCore } from "../src/audio/music/MusicCore";
import { SONG_SOURCES } from "../src/audio/music/songs";
import { melodyLength, parseChords } from "../src/audio/music/theory";
import { SFX, SFX_IDS, type LoopId, type SfxId, type VoiceKind } from "../src/audio/Sfx";
import { Synth } from "../src/audio/synth/dsp";
import { LOOP_LEVEL, createLoop } from "../src/audio/synth/loops";
import { SFX_RECIPES, sfxGain } from "../src/audio/synth/sfxRecipes";
import { VOICE_KINDS, VOICE_LEVEL, synthVoice } from "../src/audio/synth/voices";

/* ===================================================================== setup */

const engine = new AudioEngine();
const volumes = { master: 0.8, music: 0.5, sfx: 0.9 };
engine.setVolumes(volumes.master, volumes.music, volumes.sfx);
for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, () => engine.unlock(), { capture: true });

const app = document.getElementById("app") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const voicesEl = document.getElementById("voices") as HTMLElement;
const peakEl = document.getElementById("peak") as HTMLElement;
const meter = document.getElementById("meter") as HTMLCanvasElement;

const listener = { pos: { x: 0, y: 1.6, z: 0 }, yaw: 0 };
let source: Vec3Like = { x: 3, y: 1, z: -5 };
let usePos = true;

/* ===================================================================== DOM helpers */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

function section(title: string, wide = false): HTMLElement {
  const s = el("section", { className: wide ? "wide" : "" }, [el("h2", { textContent: title })]);
  app.append(s);
  return s;
}

function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const b = el("button", { textContent: label, className });
  b.addEventListener("click", onClick);
  return b;
}

function slider(label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLLabelElement {
  const out = el("span", { textContent: value.toFixed(2) });
  const input = el("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) });
  input.addEventListener("input", () => {
    const v = Number(input.value);
    out.textContent = v.toFixed(2);
    onInput(v);
  });
  return el("label", { className: "row" }, [label, input, out]);
}

function sfxPos(): Vec3Like | undefined {
  return usePos ? { ...source } : undefined;
}

/* ===================================================================== header: volumes */

const header = document.querySelector("header") as HTMLElement;
header.append(
  slider("Master", 0, 1, 0.01, volumes.master, (v) => {
    volumes.master = v;
    engine.setVolumes(volumes.master, volumes.music, volumes.sfx);
  }),
  slider("Music", 0, 1, 0.01, volumes.music, (v) => {
    volumes.music = v;
    engine.setVolumes(volumes.master, volumes.music, volumes.sfx);
  }),
  slider("SFX", 0, 1, 0.01, volumes.sfx, (v) => {
    volumes.sfx = v;
    engine.setVolumes(volumes.master, volumes.music, volumes.sfx);
  }),
);

/* ===================================================================== SFX */

const SFX_GROUPS: ReadonlyArray<[string, SfxId[]]> = [
  ["Ball", ["bounce", "squeak", "throw", "throwHeavy", "pickup", "ballDrop", "boomerang"]],
  ["Combat", ["bonk", "ding", "catch", "crowdOoh", "whiff", "slideWhistle", "ko", "honk"]],
  ["Movement", ["jump", "land", "roll"]],
  ["Abilities", ["flapDash", "groundPoundLeap", "shockwave", "bellyBoing", "curveArm", "bellySlide", "headbutt"]],
  ["Power-ups", ["powerUpWarning", "powerUpSparkle", "powerUpPickup", "zoomies"]],
  ["Arena & round", ["ringShake", "crumbleRumble", "countdownTick", "countdownGo", "suddenDeath"]],
  ["UI", ["uiClick", "uiHover", "uiToggle", "uiError"]],
];

function buildSfxSection(): void {
  const s = section("Sound effects (at the pad's source position)");
  const listed = new Set<SfxId>();
  for (const [title, ids] of SFX_GROUPS) {
    s.append(el("h3", { textContent: title }));
    for (const id of ids) {
      listed.add(id);
      s.append(button(id, () => engine.play(id, { pos: sfxPos() }), SFX[id].bus === "ui" ? "alt" : ""));
    }
  }
  const rest = SFX_IDS.filter((id) => !listed.has(id));
  if (rest.length > 0) {
    s.append(el("h3", { textContent: "Other" }));
    for (const id of rest) s.append(button(id, () => engine.play(id, { pos: sfxPos() })));
  }
  s.append(el("h3", { textContent: "Game events (event → feedback table)" }));
  const char = (): CharacterId => voiceChar;
  s.append(
    button("hit (you threw)", () => {
      engine.play("bonk", { pos: sfxPos() });
      engine.voice(char(), "hit", { pos: sfxPos() });
      engine.play("ding");
    }),
    button("catch", () => {
      engine.play("catch", { pos: sfxPos() });
      engine.play("crowdOoh");
      engine.voice(char(), "catch", { pos: sfxPos() });
      slowMo(0.3, 150);
    }),
    button("ring-out", () => {
      engine.play("slideWhistle", { pos: sfxPos() });
      engine.voice(char(), "ko", { pos: sfxPos() });
    }),
    button("KO", () => {
      engine.play("ko", { pos: sfxPos() });
      engine.voice(char(), "ko", { pos: sfxPos() });
    }),
    button("throw + voice", () => {
      engine.play("throw", { pos: sfxPos() });
      engine.voice(char(), "throw", { pos: sfxPos() });
    }),
    button("countdown 3-2-1-GO", () => {
      [0, 1000, 2000].forEach((ms) => setTimeout(() => engine.play("countdownTick"), ms));
      setTimeout(() => engine.play("countdownGo"), 3000);
    }),
    button("power-up cycle", () => {
      engine.play("powerUpWarning", { pos: sfxPos() });
      setTimeout(() => engine.play("powerUpSparkle", { pos: sfxPos() }), 2000);
      setTimeout(() => engine.play("powerUpPickup", { pos: sfxPos() }), 3200);
    }),
    button("sudden death", () => {
      engine.play("suddenDeath");
      engine.playMusic("suddenDeath");
      rampTempo();
      refreshMusicButtons();
    }),
    button("ring shake → drop", () => {
      engine.play("ringShake", { pos: sfxPos() });
      setTimeout(() => engine.play("crumbleRumble", { pos: sfxPos() }), 800);
    }),
  );
}

/* ===================================================================== voices */

let voiceChar: CharacterId = "quacky";

function buildVoiceSection(): void {
  const s = section("Character voices");
  const table = el("table", { className: "voices" });
  const head = el("tr", {}, [el("th")]);
  for (const kind of VOICE_KINDS) head.append(el("th", { textContent: kind }));
  table.append(head);
  for (const id of CHARACTER_IDS) {
    const def = CHARACTERS[id];
    const row = el("tr", {}, [el("th", { textContent: def.name, title: `voice preset: ${def.voice}` })]);
    for (const kind of VOICE_KINDS) {
      row.append(
        el("td", {}, [
          button(kind, () => {
            voiceChar = id;
            engine.voice(id, kind as VoiceKind, { pos: sfxPos() });
          }),
        ]),
      );
    }
    table.append(row);
  }
  s.append(
    el("div", { className: "scroll-x" }, [table]),
    el("p", { className: "muted", textContent: "Hover a name for its voice preset. The last character clicked is used by the game-event buttons." }),
  );
}

/* ===================================================================== loops */

function buildLoopSection(): void {
  const s = section("Loops");
  s.append(el("h3", { textContent: "Charge (hold: param rises 0 → 1 in 1 s; release throws)" }));
  const charge = button("hold to charge", () => {});
  let loop: LoopHandle | null = null;
  let t0 = 0;
  let raf = 0;
  const tick = (): void => {
    const p = Math.min(1, (performance.now() - t0) / 1000);
    loop?.setParam(p);
    loop?.setPosition(source);
    charge.textContent = `charging ${(p * 100).toFixed(0)}%`;
    raf = requestAnimationFrame(tick);
  };
  const begin = (): void => {
    if (loop) return;
    charge.classList.add("down");
    loop = engine.startLoop("charge", { pos: sfxPos() });
    t0 = performance.now();
    tick();
  };
  const release = (): void => {
    if (!loop) return;
    cancelAnimationFrame(raf);
    const full = performance.now() - t0 >= 1000;
    loop.stop();
    loop = null;
    charge.classList.remove("down");
    charge.textContent = "hold to charge";
    engine.play(full ? "throwHeavy" : "throw", { pos: sfxPos() });
  };
  charge.addEventListener("pointerdown", begin);
  charge.addEventListener("pointerup", release);
  charge.addEventListener("pointerleave", release);
  s.append(charge);

  for (const id of ["slide", "zoomies"] as const) s.append(...speedLoop(id));
}

function speedLoop(id: LoopId): Node[] {
  let loop: LoopHandle | null = null;
  let speed = 0.7;
  const toggle = button(`${id}: off`, () => {
    if (loop) {
      loop.stop();
      loop = null;
      toggle.textContent = `${id}: off`;
      toggle.classList.remove("on");
      return;
    }
    loop = engine.startLoop(id, { pos: sfxPos() });
    loop.setParam(speed);
    toggle.textContent = `${id}: on`;
    toggle.classList.add("on");
  });
  const speedSlider = slider("speed", 0, 1, 0.01, speed, (v) => {
    speed = v;
    loop?.setParam(v);
  });
  return [el("h3", { textContent: id === "slide" ? "Pip belly slide" : "Zoomies patter" }), toggle, speedSlider];
}

/* ===================================================================== music */

const TRACKS: MusicTrack[] = ["none", "lobby", "fight", "suddenDeath"];
const trackButtons = new Map<MusicTrack, HTMLButtonElement>();
let tempo = 1;
let tempoSlider: HTMLLabelElement | null = null;
let rampTimer = 0;

function refreshMusicButtons(): void {
  const current = engine.musicTrack;
  for (const [t, b] of trackButtons) b.classList.toggle("on", t === current);
}

function setTempo(v: number): void {
  tempo = v;
  engine.setMusicTempo(v);
  const input = tempoSlider?.querySelector("input");
  const out = tempoSlider?.querySelector("span");
  if (input) input.value = String(v);
  if (out) out.textContent = v.toFixed(2);
}

/** Sudden-death ramp exactly like GameController: 1 → 1.35 over 25 s. */
function rampTempo(): void {
  clearInterval(rampTimer);
  const t0 = performance.now();
  rampTimer = window.setInterval(() => {
    const t = Math.min(1, (performance.now() - t0) / 25000);
    setTempo(1 + 0.35 * t);
    if (t >= 1) clearInterval(rampTimer);
  }, 100);
}

function buildMusicSection(): void {
  const s = section("Music");
  s.append(el("h3", { textContent: "Tracks (keys 1–4)" }));
  for (const t of TRACKS) {
    const b = button(t, () => {
      if (t !== "suddenDeath") {
        clearInterval(rampTimer);
        setTempo(1);
      }
      engine.playMusic(t);
      refreshMusicButtons();
    });
    trackButtons.set(t, b);
    s.append(b);
  }
  tempoSlider = slider("tempo", 0.8, 1.5, 0.01, tempo, (v) => {
    clearInterval(rampTimer);
    setTempo(v);
  });
  s.append(tempoSlider, button("SD ramp 1 → 1.35 (25 s)", rampTempo, "alt"));
  s.append(el("h3", { textContent: "Jingles (keys 5–7)" }));
  for (const j of ["roundWin", "matchWin", "roundLose"] as Jingle[]) s.append(button(j, () => engine.jingle(j)));
  s.append(
    el("p", {
      className: "muted",
      textContent: "Track switches crossfade (0.6 s); fight ⇄ suddenDeath keep the groove and fade the tension layer in/out.",
    }),
  );
}

/* ===================================================================== space */

let timeScale = 1;
let slowUntil = 0;
let orbit: LoopHandle | null = null;
let orbitAngle = 0;

function slowMo(scale: number, ms: number): void {
  timeScale = scale;
  slowUntil = performance.now() + ms;
}

const pad = el("canvas", { id: "pad", width: 520, height: 520 });
const PAD_METERS = 40;

function padToWorld(ev: PointerEvent): Vec3Like {
  const r = pad.getBoundingClientRect();
  const x = ((ev.clientX - r.left) / r.width - 0.5) * PAD_METERS;
  const z = ((ev.clientY - r.top) / r.height - 0.5) * PAD_METERS;
  return { x, y: 1, z };
}

function buildSpaceSection(): void {
  const s = section("Space & feel");
  pad.addEventListener("pointerdown", (ev) => {
    source = padToWorld(ev);
    engine.play("bounce", { pos: sfxPos() });
  });
  const posToggle = button("positional: on", () => {
    usePos = !usePos;
    posToggle.textContent = `positional: ${usePos ? "on" : "off"}`;
    posToggle.classList.toggle("on", usePos);
  }, "on");
  let hrtf = true;
  const hrtfToggle = button("HRTF: on", () => {
    hrtf = !hrtf;
    engine.setSpatialQuality(hrtf);
    hrtfToggle.textContent = `HRTF: ${hrtf ? "on" : "off"}`;
    hrtfToggle.classList.toggle("on", hrtf);
  }, "on");
  const orbitToggle = button("orbit a charge loop", () => {
    if (orbit) {
      orbit.stop();
      orbit = null;
      orbitToggle.classList.remove("on");
      return;
    }
    orbit = engine.startLoop("charge", { pos: source });
    orbit.setParam(0.6);
    orbitToggle.classList.add("on");
  });
  s.append(
    el("p", { className: "muted", textContent: "Click the island to place the sound (you = arrow, 40 m across). Headphones!" }),
    pad,
    posToggle,
    hrtfToggle,
    orbitToggle,
    button("throw from behind you", () => engine.play("throwHeavy", { pos: relative(0, 7) })),
    button("throw from the left", () => engine.play("throwHeavy", { pos: relative(-7, 0) })),
    button("throw in front", () => engine.play("throwHeavy", { pos: relative(0, -7) })),
    slider("listener yaw", -Math.PI, Math.PI, 0.01, 0, (v) => (listener.yaw = v)),
    slider("time scale", 0.05, 1, 0.01, 1, (v) => {
      timeScale = v;
      slowUntil = Infinity;
    }),
    button("catch slow-mo (0.3 × 150 ms)", () => slowMo(0.3, 150), "alt"),
    button("hit-stop (0 × 60 ms) + bonk", () => {
      engine.play("bonk", { pos: sfxPos() });
      slowMo(0, 60);
    }, "alt"),
  );
}

/** A point `right` m to the listener's right and `back` m behind them (yaw-relative). */
function relative(right: number, back: number): Vec3Like {
  const { yaw, pos } = listener;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  return { x: pos.x + rx * right - fx * back, y: 1, z: pos.z + rz * right - fz * back };
}

function drawPad(): void {
  const g = pad.getContext("2d");
  if (!g) return;
  const W = pad.width;
  const k = W / PAD_METERS;
  const toPx = (v: Vec3Like): [number, number] => [W / 2 + v.x * k, W / 2 + v.z * k];
  g.fillStyle = "#3d7fb8";
  g.fillRect(0, 0, W, W);
  g.fillStyle = "#7bd389";
  g.strokeStyle = "#4fa36b";
  g.lineWidth = 6;
  g.beginPath();
  g.arc(W / 2, W / 2, 15 * k, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.strokeStyle = "rgba(45,42,50,0.25)";
  g.lineWidth = 2;
  for (const r of [3, 10]) {
    g.beginPath();
    g.arc(W / 2, W / 2, r * k, 0, Math.PI * 2);
    g.stroke();
  }
  const [lx, lz] = toPx(listener.pos);
  g.save();
  g.translate(lx, lz);
  g.rotate(-listener.yaw);
  g.fillStyle = "#2d2a32";
  g.beginPath();
  g.moveTo(0, -22);
  g.lineTo(14, 14);
  g.lineTo(0, 6);
  g.lineTo(-14, 14);
  g.closePath();
  g.fill();
  g.restore();
  const dot = (v: Vec3Like, color: string): void => {
    const [x, z] = toPx(v);
    g.fillStyle = color;
    g.strokeStyle = "#2d2a32";
    g.lineWidth = 4;
    g.beginPath();
    g.arc(x, z, 13, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  };
  dot(source, "#ff5a5f");
  if (orbit) dot(orbitPos(), "#3fa7ff");
}

function orbitPos(): Vec3Like {
  return { x: Math.cos(orbitAngle) * 6, y: 1, z: Math.sin(orbitAngle) * 6 };
}

/* ===================================================================== stress */

function buildStressSection(): void {
  const s = section("Stress / voice limiting");
  s.append(
    button("60 bounces in 0.6 s", () => {
      for (let i = 0; i < 60; i++) {
        setTimeout(() => {
          const pos = { x: (Math.random() - 0.5) * 20, y: 0.3, z: (Math.random() - 0.5) * 20 };
          const strength = Math.random();
          engine.play("bounce", { pos, volume: 0.15 + 0.85 * strength, pitch: 1.15 - 0.3 * strength });
        }, i * 10);
      }
    }),
    button("every SFX at once", () => {
      for (const id of SFX_IDS) engine.play(id, { pos: sfxPos() });
    }, "danger"),
    button("4 players charging", () => {
      const loops = [0, 1, 2, 3].map((i) => engine.startLoop("charge", { pos: { x: Math.cos(i * 1.57) * 6, y: 1, z: Math.sin(i * 1.57) * 6 } }));
      const t0 = performance.now();
      const id = window.setInterval(() => {
        const p = (performance.now() - t0) / 1000;
        loops.forEach((l, i) => l.setParam(Math.min(1, p * (0.7 + i * 0.15))));
        if (p > 1.6) {
          clearInterval(id);
          loops.forEach((l) => l.stop());
        }
      }, 16);
    }),
    button("triple-shot volley (same frame)", () => {
      for (let i = 0; i < 3; i++) engine.play("throw", { pos: sfxPos() });
    }),
    button("bonk ×10 (same spot, 30 ms apart)", () => {
      for (let i = 0; i < 10; i++) setTimeout(() => engine.play("bonk", { pos: sfxPos() }), i * 30);
    }),
  );
  s.append(el("p", { className: "muted", textContent: "Watch the header: active voices stay ≤ 32 and the post-limiter peak stays under 0 dBFS." }));
}

/* ===================================================================== offline renders */

interface RenderSpec {
  name: string;
  group: string;
  seconds: number;
  /** Minimum loudest-50 ms-window RMS to count as "not silent". */
  minLoudness?: number;
  build(ctx: OfflineAudioContext, out: AudioNode): void;
}

interface RenderResult {
  name: string;
  group: string;
  ok: boolean;
  peak: number;
  rms: number;
  loudest: number;
  seconds: number;
  error: string | null;
  data: Float32Array | null;
  sampleRate: number;
}

const SAMPLE_RATE = 44100;
const DEFAULT_MIN_LOUDNESS = 0.01;

function sfxSpec(id: SfxId): RenderSpec {
  return {
    name: id,
    group: "sfx",
    seconds: 2.6,
    minLoudness: id === "uiHover" ? 0.004 : DEFAULT_MIN_LOUDNESS,
    build(ctx, out) {
      const g = ctx.createGain();
      g.gain.value = sfxGain(id);
      g.connect(out);
      const s = new Synth(ctx, g, 0.02, 1);
      SFX_RECIPES[id](s);
      if (s.endTime > 2.55) throw new Error(`ends at ${s.endTime.toFixed(2)} s (render window too short)`);
    },
  };
}

function voiceSpec(id: CharacterId, kind: VoiceKind): RenderSpec {
  return {
    name: `${id}.${kind}`,
    group: "voice",
    seconds: 2.4,
    build(ctx, out) {
      const g = ctx.createGain();
      g.gain.value = VOICE_LEVEL;
      g.connect(out);
      synthVoice(new Synth(ctx, g, 0.02, 1), CHARACTERS[id].voice, kind);
    },
  };
}

function loopSpec(id: LoopId): RenderSpec {
  return {
    name: `loop.${id}`,
    group: "loop",
    seconds: 2.2,
    build(ctx, out) {
      const g = ctx.createGain();
      g.gain.value = LOOP_LEVEL[id];
      g.connect(out);
      const loop = createLoop(ctx, id, g, 0.02);
      for (let i = 0; i <= 25; i++) loop.setParam(i / 25, 0.02 + i * 0.04);
      loop.stop(1.8, 0.08);
    },
  };
}

function musicSpec(name: string, seconds: number, script: (core: MusicCore, ctx: OfflineAudioContext) => void): RenderSpec {
  return {
    name,
    group: "music",
    seconds,
    build(ctx, out) {
      const core = new MusicCore(ctx, out);
      script(core, ctx);
    },
  };
}

/** Schedule `fn` when the offline render reaches `t` (then keep rendering). */
function at(ctx: OfflineAudioContext, t: number, fn: () => void): void {
  void ctx.suspend(t).then(() => {
    fn();
    void ctx.resume();
  });
}

function allSpecs(): RenderSpec[] {
  const specs: RenderSpec[] = SFX_IDS.map(sfxSpec);
  for (const id of CHARACTER_IDS) for (const kind of VOICE_KINDS) specs.push(voiceSpec(id, kind));
  for (const id of ["charge", "slide", "zoomies"] as LoopId[]) specs.push(loopSpec(id));
  specs.push(
    musicSpec("music.lobby", 12, (core) => {
      core.play("lobby");
      core.pump(12);
    }),
    musicSpec("music.fight", 12, (core) => {
      core.play("fight");
      core.pump(12);
    }),
    musicSpec("music.suddenDeath@1.35", 12, (core) => {
      core.setTempo(1.35);
      core.play("suddenDeath");
      core.pump(12);
    }),
    musicSpec("music.xfade lobby→fight", 9, (core, ctx) => {
      core.play("lobby");
      core.pump(4.2);
      at(ctx, 4, () => {
        core.play("fight");
        core.pump(9);
      });
    }),
    musicSpec("music.fight→suddenDeath", 9, (core, ctx) => {
      core.play("fight");
      core.pump(3.2);
      at(ctx, 3, () => {
        core.play("suddenDeath");
        core.pump(9);
      });
    }),
  );
  for (const j of ["roundWin", "matchWin", "roundLose"] as Jingle[]) {
    specs.push(musicSpec(`jingle.${j}`, 5, (core) => void core.jingle(j)));
  }
  specs.push(
    musicSpec("jingle.roundWin over fight (duck)", 8, (core, ctx) => {
      core.play("fight");
      core.pump(2.2);
      at(ctx, 2, () => {
        core.jingle("roundWin");
        core.pump(8);
      });
    }),
  );
  return specs;
}

async function render(spec: RenderSpec): Promise<RenderResult> {
  const base = { name: spec.name, group: spec.group, seconds: spec.seconds, sampleRate: SAMPLE_RATE };
  try {
    const ctx = new OfflineAudioContext(1, Math.ceil(spec.seconds * SAMPLE_RATE), SAMPLE_RATE);
    spec.build(ctx, ctx.destination);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    const a = analyze(data, SAMPLE_RATE);
    const ok = !a.nan && a.peak <= 1 && a.loudest >= (spec.minLoudness ?? DEFAULT_MIN_LOUDNESS);
    const error = a.nan ? "NaN in output" : a.peak > 1 ? "clips (peak > 1)" : ok ? null : "silent";
    return { ...base, ...a, ok, error, data };
  } catch (err) {
    return { ...base, ok: false, peak: 0, rms: 0, loudest: 0, error: String(err), data: null };
  }
}

function analyze(data: Float32Array, sr: number): { peak: number; rms: number; loudest: number; nan: boolean } {
  let peak = 0;
  let nan = false;
  let first = -1;
  let last = -1;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) {
      nan = true;
      continue;
    }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a > 1e-3) {
      if (first < 0) first = i;
      last = i;
    }
  }
  let sum = 0;
  for (let i = Math.max(0, first); i <= last; i++) sum += data[i] * data[i];
  const rms = first >= 0 ? Math.sqrt(sum / (last - first + 1)) : 0;
  const win = Math.floor(sr * 0.05);
  let loudest = 0;
  for (let i = 0; i + win <= data.length; i += win >> 1) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += data[j] * data[j];
    loudest = Math.max(loudest, Math.sqrt(s / win));
  }
  return { peak, rms, loudest, nan };
}

/* --------------------------------------------------------------------- spectrogram */

const FFT_N = 512;

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const ai = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j + len / 2] = re[i + j] - ar;
        im[i + j + len / 2] = im[i + j] - ai;
        re[i + j] += ar;
        im[i + j] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

function heat(v: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, v));
  const r = Math.min(255, 40 + 600 * t);
  const g = Math.max(0, Math.min(255, -180 + 520 * t));
  const b = Math.max(0, Math.min(255, 90 + 300 * t - 420 * t * t));
  return [r, g, b];
}

/** The audible span of a render (plus a little tail), so short sounds fill their thumbnail. */
function activeSpan(data: Float32Array, sr: number): Float32Array {
  let first = 0;
  let last = data.length - 1;
  while (first < data.length && Math.abs(data[first]) < 1e-3) first++;
  while (last > first && Math.abs(data[last]) < 1e-3) last--;
  if (first >= last) return data;
  return data.subarray(Math.max(0, first - Math.floor(sr * 0.01)), Math.min(data.length, last + Math.floor(sr * 0.05)));
}

/** Log-frequency spectrogram (60 Hz–14 kHz, dBFS −80..0) with the peak envelope drawn on top. */
function drawSpectrogram(canvas: HTMLCanvasElement, full: Float32Array, sr: number): void {
  const g = canvas.getContext("2d");
  if (!g) return;
  const data = activeSpan(full, sr);
  const W = canvas.width;
  const H = canvas.height;
  const img = g.createImageData(W, H);
  const re = new Float64Array(FFT_N);
  const im = new Float64Array(FFT_N);
  const fMin = 60;
  const fMax = Math.min(14000, sr / 2);
  for (let x = 0; x < W; x++) {
    const start = Math.floor((x / W) * Math.max(0, data.length - FFT_N));
    for (let i = 0; i < FFT_N; i++) {
      re[i] = (data[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1)));
      im[i] = 0;
    }
    fft(re, im);
    for (let y = 0; y < H; y++) {
      const f = fMin * Math.pow(fMax / fMin, 1 - y / (H - 1));
      const bin = Math.min(FFT_N / 2 - 1, Math.round((f / sr) * FFT_N));
      // A full-scale sine through a Hann window peaks at N/4.
      const mag = Math.hypot(re[bin], im[bin]) / (FFT_N / 4);
      const db = 20 * Math.log10(mag + 1e-9);
      const [r, gg, b] = heat((db + 80) / 80);
      const o = (y * W + x) * 4;
      img.data[o] = r;
      img.data[o + 1] = gg;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = "rgba(255,255,255,0.75)";
  g.lineWidth = 1;
  g.beginPath();
  const per = Math.max(1, Math.floor(data.length / W));
  for (let x = 0; x < W; x++) {
    let m = 0;
    for (let i = x * per; i < Math.min(data.length, (x + 1) * per); i++) m = Math.max(m, Math.abs(data[i]));
    const y = H - m * H;
    if (x === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
}

/* --------------------------------------------------------------------- gallery */

let results: RenderResult[] = [];
const gallery = el("div", { id: "gallery" });
const summary = el("div", { id: "summary", textContent: "Not rendered yet." });

function db(v: number): string {
  return v > 0 ? `${(20 * Math.log10(v)).toFixed(1)} dB` : "-∞";
}

function card(r: RenderResult): HTMLElement {
  const c = el("div", { className: r.ok ? "card" : "card fail", title: "Click to play the rendered buffer" });
  const canvas = el("canvas", { width: 240, height: 70 });
  c.append(
    el("div", { className: "name" }, [el("span", { textContent: r.name }), el("span", { className: r.ok ? "ok" : "bad", textContent: r.ok ? "✓" : "✗" })]),
    canvas,
    el("div", {
      className: "stats",
      textContent: r.error ?? `peak ${db(r.peak)} · rms ${db(r.rms)} · loudest ${db(r.loudest)}`,
    }),
  );
  if (r.data) drawSpectrogram(canvas, r.data, r.sampleRate);
  c.addEventListener("click", () => playBuffer(r));
  return c;
}

function playBuffer(r: RenderResult): void {
  const ctx = engine.audioContext;
  const out = engine.outputNode;
  if (!ctx || !out || !r.data) return;
  const buffer = ctx.createBuffer(1, r.data.length, r.sampleRate);
  buffer.copyToChannel(new Float32Array(r.data), 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const g = ctx.createGain();
  g.gain.value = 0.8;
  src.connect(g).connect(ctx.destination);
  src.start();
}

function scoreChecks(): string[] {
  const problems: string[] = [];
  for (const [id, src] of Object.entries(SONG_SOURCES)) {
    const steps = parseChords(src.chords).length * 16;
    for (const part of ["kazoo", "lead"] as const) {
      const len = melodyLength(src[part]);
      if (len !== steps) problems.push(`${id}.${part} is ${len} steps, expected ${steps}`);
    }
    // Every bar of a part must sum to 16 steps.
    for (const part of ["kazoo", "lead"] as const) {
      src[part].split("|").forEach((bar, i) => {
        const len = melodyLength(bar);
        if (len !== 16) problems.push(`${id}.${part} bar ${i + 1} is ${len} steps`);
      });
    }
  }
  return problems;
}

async function renderAll(filter?: string): Promise<Array<Omit<RenderResult, "data">>> {
  const specs = allSpecs().filter((s) => !filter || s.name.includes(filter) || s.group === filter);
  summary.textContent = `Rendering ${specs.length} sounds…`;
  gallery.replaceChildren();
  results = [];
  const t0 = performance.now();
  for (const spec of specs) {
    const r = await render(spec);
    results.push(r);
    gallery.append(card(r));
  }
  const failed = results.filter((r) => !r.ok);
  const problems = scoreChecks();
  const ms = (performance.now() - t0).toFixed(0);
  summary.textContent =
    `${results.length - failed.length}/${results.length} pass (${ms} ms)` +
    (failed.length ? ` · FAIL: ${failed.map((r) => `${r.name} (${r.error})`).join(", ")}` : "") +
    (problems.length ? ` · SCORE: ${problems.join("; ")}` : " · score bars OK");
  summary.className = failed.length || problems.length ? "bad" : "ok";
  return results.map(({ data: _data, ...rest }) => rest);
}

/** Full-viewport overlay of spectrograms at device resolution (for screenshots of a small pane). */
function showSheet(filter = "", page = 0, cols = 4, rows = 4): string {
  document.getElementById("sheet")?.remove();
  const list = results.filter((r) => r.data && (!filter || r.name.includes(filter) || r.group === filter));
  const perPage = cols * rows;
  const shown = list.slice(page * perPage, page * perPage + perPage);
  const dpr = window.devicePixelRatio || 1;
  const sheet = el("canvas", { id: "sheet" });
  sheet.width = Math.floor(window.innerWidth * dpr);
  sheet.height = Math.floor(window.innerHeight * dpr);
  Object.assign(sheet.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", zIndex: "50", background: "#0d0c10" });
  sheet.addEventListener("click", () => sheet.remove());
  document.body.append(sheet);
  const g = sheet.getContext("2d");
  if (!g) return "no 2d context";
  g.fillStyle = "#0d0c10";
  g.fillRect(0, 0, sheet.width, sheet.height);
  const cw = sheet.width / cols;
  const ch = sheet.height / rows;
  const label = Math.max(10, Math.round(ch * 0.13));
  shown.forEach((r, i) => {
    const x = (i % cols) * cw;
    const y = Math.floor(i / cols) * ch;
    const cell = document.createElement("canvas");
    cell.width = Math.floor(cw - 4);
    cell.height = Math.floor(ch - label - 6);
    if (r.data) drawSpectrogram(cell, r.data, r.sampleRate);
    g.drawImage(cell, x + 2, y + label + 4);
    g.fillStyle = r.ok ? "#fff" : "#ff5a5f";
    g.font = `600 ${label}px Fredoka, sans-serif`;
    const span = r.data ? activeSpan(r.data, r.sampleRate).length / r.sampleRate : 0;
    g.fillText(`${r.name} ${db(r.peak)} ${span.toFixed(2)}s`, x + 4, y + label);
  });
  return `${shown.length} of ${list.length} (page ${page + 1}/${Math.ceil(list.length / perPage)})`;
}

function buildOfflineSection(): void {
  const s = section("Offline renders (OfflineAudioContext): spectrogram 60 Hz–14 kHz, waveform peak overlay", true);
  s.append(
    button("Render everything", () => void renderAll()),
    button("SFX only", () => void renderAll("sfx"), "alt"),
    button("Voices only", () => void renderAll("voice"), "alt"),
    button("Music only", () => void renderAll("music"), "alt"),
    summary,
    gallery,
  );
}

/* ===================================================================== meter + loop */

let analyser: AnalyserNode | null = null;
const scope = new Float32Array(2048);
let peakHold = 0;
let peakHoldAt = 0;
let clips = 0;

function ensureAnalyser(): AnalyserNode | null {
  if (analyser) return analyser;
  const ctx = engine.audioContext;
  const out = engine.outputNode;
  if (!ctx || !out) return null;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  out.connect(analyser);
  return analyser;
}

function drawMeter(): void {
  const g = meter.getContext("2d");
  const a = ensureAnalyser();
  if (!g) return;
  const W = meter.width;
  const H = meter.height;
  g.fillStyle = "#1c1a20";
  g.fillRect(0, 0, W, H);
  if (!a) return;
  a.getFloatTimeDomainData(scope);
  let peak = 0;
  for (const v of scope) peak = Math.max(peak, Math.abs(v));
  if (peak >= 1) clips++;
  const now = performance.now();
  if (peak > peakHold || now - peakHoldAt > 1500) {
    peakHold = peak;
    peakHoldAt = now;
  }
  g.strokeStyle = peak >= 1 ? "#ff5a5f" : "#7be07b";
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i < scope.length; i += 4) {
    const x = (i / scope.length) * W;
    const y = H / 2 - scope[i] * (H / 2);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  peakEl.textContent = `peak ${db(peakHold)}${clips ? ` · clipped frames ${clips}` : ""}`;
}

function frame(): void {
  const now = performance.now();
  if (now > slowUntil && slowUntil !== Infinity) timeScale = 1;
  engine.setTimeScale(timeScale);
  const yaw = listener.yaw;
  engine.setListener(listener.pos, { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) });
  if (orbit) {
    orbitAngle += 0.012;
    orbit.setPosition(orbitPos());
  }
  statusEl.textContent = engine.ready ? `running · ${engine.musicTrack}` : "locked: click anything";
  statusEl.classList.toggle("on", engine.ready);
  voicesEl.textContent = `voices ${engine.activeVoices} · loops ${engine.activeLoops}`;
  refreshMusicButtons();
  drawPad();
  drawMeter();
  requestAnimationFrame(frame);
}

/* ===================================================================== keys */

window.addEventListener("keydown", (ev) => {
  if (ev.repeat) return;
  const track = TRACKS[Number(ev.key) - 1];
  if (track) {
    engine.playMusic(track);
    return;
  }
  const jingle = (["roundWin", "matchWin", "roundLose"] as Jingle[])[Number(ev.key) - 5];
  if (jingle) engine.jingle(jingle);
  if (ev.key === "b") engine.play("bonk", { pos: sfxPos() });
  if (ev.key === " ") {
    ev.preventDefault();
    engine.play("jump", { pos: sfxPos() });
  }
});

/* ===================================================================== boot */

buildSpaceSection();
buildSfxSection();
buildVoiceSection();
buildLoopSection();
buildMusicSection();
buildStressSection();
buildOfflineSection();
requestAnimationFrame(frame);

declare global {
  interface Window {
    audioHarness: {
      engine: AudioEngine;
      renderAll: typeof renderAll;
      results: () => ReadonlyArray<Omit<RenderResult, "data">>;
      scoreChecks: typeof scoreChecks;
      showSheet: typeof showSheet;
    };
  }
}

window.audioHarness = {
  engine,
  renderAll,
  results: () => results.map(({ data: _data, ...rest }) => rest),
  scoreChecks,
  showSheet,
};
