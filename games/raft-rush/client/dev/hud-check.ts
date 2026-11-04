// Browser check for the two HUD acceptance numbers (dev-only):
//   - night compass: overlapping mark pairs (union of pin + distance chip) across a full yaw sweep
//   - storm warning: HUD clock seconds vs live banner seconds, sampled while both are on screen
// Run with the dev Vite config (dev/vite.hud-check.config.ts) or bundle it with esbuild; the page writes the
// result JSON to #result and window.__hudCheck. Owner: client-ui.

import "../src/ui/ui.css";
import "../src/ui/hud.css";
import { Banner } from "../src/ui/hud/Banner";
import { Compass } from "../src/ui/hud/Compass";
import { DayClock } from "../src/ui/hud/DayClock";
import type { BannerModel, CompassMark, HudModel } from "../src/ui/models";

const root = document.createElement("div");
root.className = "rr-ui";
const hud = document.createElement("div");
hud.className = "rr-hud";
hud.dataset.mode = "play";
root.append(hud);
document.body.append(root);

const top = document.createElement("div");
top.className = "rr-hud__top";
const compass = new Compass();
const clock = new DayClock();
const banner = new Banner();
top.append(compass.el, clock.el);
hud.append(top, banner.el);

/** A crowded night: objectives, teammates, pings, resources and monsters all near the same bearings. */
function nightMarks(): CompassMark[] {
  const m: CompassMark[] = [];
  const add = (kind: CompassMark["kind"], bearing: number, dist: number, color: string, icon: string, label = ""): void => {
    m.push({ kind, bearing, dist, color, icon, label });
  };
  add("ping", -0.1, 9, "#3FA7F5", "📍", "Bahri");
  add("ping", 0.06, 12, "#3FA7F5", "📍", "Mercan");
  add("camp", 0.02, 18, "#FFB347", "🔥", "Camp");
  add("raft", -0.04, 32, "#B07A45", "🛶", "Raft");
  add("spring", 0.01, 24, "#3FB7D9", "💧", "Spring");
  add("secret", -0.12, 28, "#FFD166", "💰", "Chest");
  add("cave", 1.5, 44, "#FFF4DC", "⛰️", "Cave");
  add("player", 1.45, 6, "#5CC25B", "🧍", "Poyraz");
  add("player", -1.5, 7, "#FF6FB5", "🧍", "Yakamoz");
  add("player", 0.005, 5, "#3FB7D9", "🧍", "Deniz");
  add("player", -0.02, 11, "#FF9A5A", "🧍", "Efe");
  for (let i = 0; i < 5; i++) add("danger", -0.18 + i * 0.09, 14 + i * 2, "#FF4D3A", "🦀");
  add("resource", 0.3, 21, "#7CCB6B", "🌴");
  add("resource", -0.33, 26, "#7CCB6B", "🪨");
  return m;
}

function stormModel(sec: number): HudModel {
  return {
    phase: "playing",
    day: 3,
    days: 3,
    dayPhase: "night",
    phaseSecLeft: 120,
    stormSecLeft: sec,
    cycle: 0.96,
    weather: "clear",
    hp: 0.8,
    hunger: 0.5,
    thirst: 0.5,
    warmth: 0.6,
    low: { hp: false, hunger: false, thirst: false, warmth: false },
    slots: [
      { kind: "", count: 0, meter: -1 },
      { kind: "", count: 0, meter: -1 },
      { kind: "", count: 0, meter: -1 },
      { kind: "", count: 0, meter: -1 },
    ],
    activeSlot: 0,
    prompt: null,
    charge: 0,
    fishing: null,
    raft: {
      stage: 2,
      stages: 7,
      parts: [
        { item: "log", have: 1, need: 1 },
        { item: "nails", have: 3, need: 4 },
        { item: "rope", have: 2, need: 5 },
      ],
      lockDay: 0,
      assembly: -1,
      minHolders: 2,
      holders: 0,
      hp: 0.72,
      hpLow: false,
      ready: false,
      aboard: 0,
      total: 3,
    },
    status: { objective: "coach.obj_day3", launchDay: 7, launchOpen: false, boss: "tonight", spring: 9 },
    heavy: null,
    fire: { frac: 0.4, lit: true, low: true, secLeft: 22 },
    compass: { yaw: 0, marks: [] },
    downed: null,
    washed: null,
    boarded: false,
    launch: null,
    stormWarning: true,
    spectator: false,
    crosshair: "dot",
    teammates: [],
    needsPointer: false,
    reducedFlashing: false,
  };
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function unionRect(node: Element): Rect | null {
  const pin = node.querySelector(".rr-cmark__pin");
  if (!pin) return null;
  const a = pin.getBoundingClientRect();
  const dist = node.querySelector(".rr-cmark__dist");
  const b = dist ? dist.getBoundingClientRect() : null;
  if (!b || b.width < 0.5 || b.height < 0.5) return { left: a.left, top: a.top, right: a.right, bottom: a.bottom };
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
}

function compassSample(yaw: number, marks: CompassMark[]): { pairs: number; visible: number; hidden: number } {
  compass.update(yaw, marks);
  const nodes = [...compass.el.querySelectorAll<HTMLElement>(".rr-cmark")].filter((n) => !n.hidden);
  const rects = nodes.map(unionRect).filter((r): r is Rect => r !== null);
  let pairs = 0;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (overlaps(rects[i]!, rects[j]!)) pairs++;
  return { pairs, visible: rects.length, hidden: compass.el.querySelectorAll<HTMLElement>(".rr-cmark[hidden]").length };
}

function toSeconds(text: string): number | null {
  const mm = /(\d+):(\d{2})/.exec(text);
  if (mm) return Number(mm[1]) * 60 + Number(mm[2]);
  const s = /(\d+)/.exec(text);
  return s ? Number(s[1]) : null;
}

function stormSamples(): Array<{ hud: string; banner: string; diff: number | null }> {
  const bannerModel: BannerModel = {
    key: "banner.stormWarning",
    params: { sec: 30 },
    sub: "banner.stormWarningSub",
    tone: "bad",
    duration: 100,
  };
  banner.show(bannerModel, false);
  const out: Array<{ hud: string; banner: string; diff: number | null }> = [];
  for (let i = 0; i < 6; i++) {
    const model = stormModel(30 - i);
    clock.update(model);
    banner.syncCountdown(model);
    const hudText = clock.el.querySelector(".rr-clock__storm-text")?.textContent ?? "";
    const bannerText = banner.el.querySelector(".rr-banner__main")?.textContent ?? "";
    const h = toSeconds(hudText);
    const b = toSeconds(bannerText);
    out.push({ hud: hudText, banner: bannerText, diff: h !== null && b !== null ? h - b : null });
  }
  return out;
}

const marks = nightMarks();
let maxPairs = 0;
let minVisible = Infinity;
let maxHidden = 0;
for (let i = 0; i < 24; i++) {
  const s = compassSample((i / 24) * Math.PI * 2, marks);
  maxPairs = Math.max(maxPairs, s.pairs);
  minVisible = Math.min(minVisible, s.visible);
  maxHidden = Math.max(maxHidden, s.hidden);
}
compass.update(0, marks);
const atZero = compassSample(0, marks);
const storm = stormSamples();
const maxStormDiff = storm.reduce((m, s) => Math.max(m, Math.abs(s.diff ?? 0)), 0);
const result = {
  compass: { maxOverlappingPairs: maxPairs, atYawZero: atZero.pairs, minVisible: minVisible === Infinity ? 0 : minVisible, maxHidden },
  storm: { samples: storm, maxAbsDiffSec: maxStormDiff },
  pass: maxPairs <= 1 && maxStormDiff === 0,
};
(window as unknown as { __hudCheck: typeof result }).__hudCheck = result;
const pre = document.createElement("pre");
pre.id = "result";
pre.textContent = JSON.stringify(result, null, 2);
document.body.append(pre);
