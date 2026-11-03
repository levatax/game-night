// Client probe: measures the three client-side acceptance criteria on the REAL browser client.
// Owner: qa. It does not change game code; it drives the built client over CDP.
//
//   node games/raft-rush/qa/client-probe.mjs --json
//
// Criteria measured:
//   AT3  first meaningful choice <= 20 s, >= 3 real choices in the first 60 s, no modal tutorial
//   AT4  night 2 compass: overlapping mark pairs <= 1, crab marks do not fill the 10-mark cap
//   AT5  storm clock: HUD chip and DAY banner show the same time (difference 0 s)
//
// It needs a built client (npm run build) and its own local server + headless Chrome. If either cannot be
// started, it reports {"error": ...} and the gate marks those criteria UNVERIFIED (never PASS).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client } from "colyseus.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? "") : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

// Unique ports by default: a leftover server from another worktree on the shared default port serves a
// different build and made the lobby probe fail. Pass --port/--cdp to pin them deliberately.
const PORT = Number(arg("port", String(3400 + (process.pid % 400))));
const CDP_PORT = Number(arg("cdp", String(9300 + (process.pid % 400))));
const VIEWPORTS = [ [1280, 800], [1920, 1080] ];
const BASE = `http://localhost:${PORT}`;
const CHROME = arg("chrome", "/opt/openmausbot-browser/chrome");
const JSON_OUT = flag("json");
const OUT = arg("out", path.join(HERE, "out", `probe-${STAMP}.json`));
const SEED = Number(arg("seed", "4242"));

const log = (...a) => {
  if (!JSON_OUT) process.stdout.write(a.join(" ") + "\n");
};

/* --------------------------------------------------------------- processes */

async function healthy(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await healthy(`${BASE}/healthz`)) return { child: null, note: "reused running server" };
  const child = spawn("npx", ["tsx", "server/index.ts"], {
    cwd: REPO,
    env: { ...process.env, NODE_ENV: "development", PORT: String(PORT) },
    stdio: "ignore",
    detached: false,
  });
  for (let i = 0; i < 60; i++) {
    if (await healthy(`${BASE}/healthz`)) return { child, note: "started server" };
    await sleep(500);
  }
  child.kill("SIGKILL");
  throw new Error("server did not become healthy on port " + PORT);
}

async function ensureChrome() {
  if (await healthy(`http://127.0.0.1:${CDP_PORT}/json/version`)) return { child: null, note: "reused Chrome" };
  const profile = path.join(HERE, `.chrome-profile-${PORT}`);
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1280,800",
    "about:blank",
  ];
  const child = spawn(CHROME, args, { stdio: "ignore" });
  for (let i = 0; i < 40; i++) {
    if (await healthy(`http://127.0.0.1:${CDP_PORT}/json/version`)) return { child, note: "started Chrome" };
    await sleep(250);
  }
  child.kill("SIGKILL");
  throw new Error("Chrome did not expose CDP on " + CDP_PORT);
}

/* --------------------------------------------------------------------- CDP */

class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  }
  static async open(cdpPort) {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const target = list.find((t) => t.type === "page") ?? (await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: "PUT" })).json());
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    const p = new Page(ws);
    await p.send("Page.enable");
    await p.send("Runtime.enable");
    return p;
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const i = ++this.id;
      const timer = setTimeout(() => {
        if (this.pending.has(i)) {
          this.pending.delete(i);
          rej(new Error(`CDP timeout: ${method}`));
        }
      }, 15000);
      this.pending.set(i, {
        res: (v) => { clearTimeout(timer); res(v); },
        rej: (e) => { clearTimeout(timer); rej(e); },
      });
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async ev(expression) {
    try {
      const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return undefined;
      return r.result.value;
    } catch {
      return undefined;
    }
  }
  async waitFor(expression, pred = (v) => !!v, timeoutMs = 15000, step = 120) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      last = await this.ev(expression);
      if (pred(last)) return last;
      await sleep(step);
    }
    return last;
  }
  async seedSettings(nickname) {
    const src = `try{sessionStorage.clear()}catch(e){};try{localStorage.setItem("raft-rush.settings.v1",JSON.stringify({mouseLock:false,language:"en",nickname:${JSON.stringify(nickname)},seenTips:[]}))}catch(e){}`;
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: src });
  }
  async goto(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState", (v) => v === "complete", 20000);
    await this.waitFor("!!document.querySelector('#app')", Boolean, 20000);
    await sleep(600);
  }
  async click(text) {
    return this.ev(
      `(()=>{const b=[...document.querySelectorAll('button,a')].find(e=>e.offsetParent!==null&&e.innerText.includes(${JSON.stringify(text)}));if(!b)return null;b.click();return b.innerText.trim();})()`,
    );
  }
  async shot(file) {
    try {
      const r = await this.send("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    } catch {
      /* screenshot is diagnostic only */
    }
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const KEYS = {
  w: { key: "w", code: "KeyW", vk: 87 },
  a: { key: "a", code: "KeyA", vk: 65 },
  s: { key: "s", code: "KeyS", vk: 83 },
  d: { key: "d", code: "KeyD", vk: 68 },
  e: { key: "e", code: "KeyE", vk: 69 },
  f: { key: "f", code: "KeyF", vk: 70 },
};

async function keyDown(p, k) {
  const d = KEYS[k];
  await p.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: d.key,
    code: d.code,
    windowsVirtualKeyCode: d.vk,
    nativeVirtualKeyCode: d.vk,
    text: d.key,
  });
}
async function keyUp(p, k) {
  const d = KEYS[k];
  await p.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: d.key,
    code: d.code,
    windowsVirtualKeyCode: d.vk,
    nativeVirtualKeyCode: d.vk,
  });
}

/** One drag-look gesture (mouseLock is forced off in settings, so drag-look is always available). */
async function setViewport(p, width, height) {
  await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
}

async function drag(p, dxPixels) {
  const x0 = 640;
  const y0 = 320;
  await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1 });
  await sleep(60);
  const steps = Math.max(2, Math.min(30, Math.round(Math.abs(dxPixels) / 20)));
  for (let i = 1; i <= steps; i++) {
    await p.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: x0 + (dxPixels * i) / steps,
      y: y0,
      button: "left",
      buttons: 1,
      deltaX: dxPixels / steps,
      deltaY: 0,
    });
    await sleep(12);
  }
  await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x0 + dxPixels, y: y0, button: "left", buttons: 0, clickCount: 1 });
  await sleep(120);
}

const MARKS_EXPR = `[...document.querySelectorAll('.rr-cmark')].filter(e=>!e.hidden).map(e=>{
  const d=e.querySelector('.rr-cmark__dist');
  const b=d?d.getBoundingClientRect():null;
  return {t:d?d.innerText:'',x:parseFloat(getComputedStyle(e).getPropertyValue('--x'))||0,
    left:Math.round(b?b.left:0),w:Math.round(b?b.width:0),
    edge:e.classList.contains('is-edge'),cls:e.className};
})`;

async function marks(p) {
  return (await p.ev(MARKS_EXPR)) ?? [];
}

function overlaps(ms) {
  const vis = ms.filter((m) => m.w > 0 && m.t).sort((a, b) => a.left - b.left);
  const pairs = [];
  for (let i = 1; i < vis.length; i++) {
    if (vis[i].left < vis[i - 1].left + vis[i - 1].w) pairs.push(`${vis[i - 1].t} <> ${vis[i].t}`);
  }
  return pairs;
}

/** Turn until the first mark whose label matches `re` is centered; returns false when no such mark. */
async function faceMark(p, re) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const ms = await marks(p);
    const m = ms.filter((x) => x.t && re.test(x.t)).sort((a, b) => (a.edge === b.edge ? 0 : a.edge ? 1 : -1))[0];
    if (!m) return false;
    if (Math.abs(m.x) < 0.05) return true;
    const k = 0.0022; // rad per dragged pixel (measured on this build)
    const dx = Math.max(-420, Math.min(420, (m.x * (Math.PI / 2)) / k));
    await drag(p, dx);
  }
  return true;
}

async function promptText(p) {
  return (await p.ev(`document.querySelector('[class*=prompt]')?.innerText||''`)) ?? "";
}

async function walkUntilPrompt(p, re, maxMs = 12000) {
  await keyDown(p, "w");
  const end = Date.now() + maxMs;
  let text = "";
  while (Date.now() < end) {
    text = await promptText(p);
    if (re.test(text)) break;
    await sleep(150);
  }
  await keyUp(p, "w");
  await sleep(120);
  return text;
}

async function inv(p) {
  return (
    (await p.ev(`(()=>{const m=window.__raft?.net?.me;if(!m)return null;const out={thirst:m.thirst,hunger:m.hunger,crafted:m.stats?.crafted??0,items:{}};for(let i=0;i<4;i++){const k=m['inv'+i],n=m['cnt'+i];if(k)out.items[k]=(out.items[k]||0)+n;}return out;})()`)) ?? null
  );
}

/* --------------------------------------------------------------- onboarding */

async function startOnboardingRun(p, nickname) {
  await p.seedSettings(nickname);
  await p.goto(`${BASE}/games/raft-rush/?debug=1`);
  await p.waitFor(`!!document.querySelector('.rr-screen--home:not([hidden])')`, Boolean, 20000);
  await sleep(600);

  // Device card (coarse pointer in headless) blocks the form.
  await p.click("Continue anyway");
  await sleep(400);
  const inputs = await p.ev(`[...document.querySelectorAll('input')].filter(e=>e.offsetParent!==null).map(e=>e.placeholder)`);
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("home form not visible: " + JSON.stringify(inputs));
  await p.ev(`(()=>{const e=document.querySelector('input.rr-field__input');e.focus();e.value=${JSON.stringify(nickname)};e.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
  if (!(await p.click("Start an island"))) throw new Error("Start an island button missing");
  const lobby = await p.waitFor(`!!document.querySelector('.rr-screen--lobby:not([hidden])')`, Boolean, 35000);
  if (!lobby) throw new Error("lobby did not open");
  await sleep(500);
  await p.click("I'm ready");
  await sleep(300);
  if (!(await p.click("Set sail"))) throw new Error("Set sail button missing");

  // AT5 is only observable while the landing banner is up (it is gone once playing starts): capture the
  // HUD chip and the "DAY 1 — Storm in …" banner together during the landing.
  let stormClock = null;
  const clock = await p.waitFor(
    `(()=>{const hud=document.querySelector('.rr-clock__storm-text')?.innerText||'';const ban=document.querySelector('.rr-banner__sub')?.innerText||'';return (hud.includes('Storm in')&&ban.includes('Storm in'))?{hud,ban}:null})()`,
    Boolean,
    9000,
  );
  if (clock) {
    const parse = (s) => {
      const m = /(\d+):(\d\d)/.exec(s);
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const a = parse(clock.hud);
    const b = parse(clock.ban);
    stormClock = { hud: clock.hud, banner: clock.ban, diffSeconds: a !== null && b !== null ? Math.abs(a - b) : null };
  }

  const phase = await p.waitFor(`window.__raft?.net?.state?.phase||''`, (v) => v === "playing", 45000);
  if (phase !== "playing") throw new Error("match never reached playing (phase=" + phase + ")");
  return { t0: Date.now(), stormClock };
}

async function onboardingProbe(p) {
  const result = { ok: false, error: null, stormClock: null, modal: null, choices: [], firstInputS: null, firstChoiceS: null, choices60: 0 };
  try {
    const started = await startOnboardingRun(p, "QA Probe");
    const t0 = started.t0;
    result.stormClock = started.stormClock;
    // First input: one priming click (pointer lock is refused headless, which enables drag-look), then F.
    await p.ev(`document.querySelector('.rr-veil__play')?.click()`);
    await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 640, y: 320, button: "left", buttons: 1, clickCount: 1 });
    await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 640, y: 320, button: "left", buttons: 0, clickCount: 1 });
    const firstInputS = (Date.now() - t0) / 1000;
    result.firstInputS = Math.round(firstInputS * 10) / 10;

    // Modal tutorial: a blocking tutorial dialog/card (the pointer veil is not a tutorial).
    result.modal = await p.ev(`(()=>{const vis=e=>!!(e&&e.offsetParent!==null&&e.getBoundingClientRect().width>0);const dialogs=[...document.querySelectorAll('.rr-modal')].filter(vis).map(e=>e.innerText.slice(0,80));const device=vis(document.querySelector('.rr-home__device'));const tips=[...document.querySelectorAll('[class*=tutorial]')].filter(vis).length;return {dialogs,device,tips};})()`);

    const mark = (type, extra) => {
      const t = Math.round(((Date.now() - t0) / 1000) * 10) / 10;
      result.choices.push({ type, t, ...extra });
      return t;
    };

    // Choice 1: drink the starting gourd (F). Real state change.
    await sleep(2200);
    const beforeDrink = await inv(p);
    await keyDown(p, "f");
    await sleep(150);
    await keyUp(p, "f");
    await sleep(700);
    const afterDrink = await inv(p);
    const drank = !!beforeDrink && !!afterDrink && afterDrink.thirst > beforeDrink.thirst;
    if (drank) result.firstChoiceS ??= mark("drink", { thirst: [beforeDrink.thirst, afterDrink.thirst] });

    // Choice 2: gather wood from the nearest wood/tree mark.
    let gathered = false;
    for (let tries = 0; tries < 2 && !gathered; tries++) {
      const faced = await faceMark(p, /Wood|Tree|Palm|Stone|Rock|Bush|Rope/i);
      if (!faced) break;
      const prompt = await walkUntilPrompt(p, /Tree|Palm|Wood|Rock|Stone|Bush|Rope|Berry/i, 14000);
      if (!/Tree|Palm|Wood|Rock|Stone|Bush|Rope|Berry/i.test(prompt)) continue;
      const b4 = await inv(p);
      await keyDown(p, "e");
      for (let i = 0; i < 8; i++) {
        await sleep(450);
        const now = await inv(p);
        if (now && b4) {
          const gained = Object.keys(now.items).some((k) => (now.items[k] ?? 0) > (b4.items[k] ?? 0));
          if (gained) {
            gathered = true;
            break;
          }
        }
      }
      await keyUp(p, "e");
      if (gathered) result.firstChoiceS ??= mark("gather", { prompt: prompt.slice(0, 40) });
    }

    // Choice 3: craft at the campfire (E) and click an affordable recipe.
    let crafted = false;
    if (await faceMark(p, /Camp/i)) {
      const prompt = await walkUntilPrompt(p, /Campfire|Camp/i, 12000);
      if (/Campfire|Camp/i.test(prompt)) {
        await keyDown(p, "e");
        await sleep(150);
        await keyUp(p, "e");
        await sleep(800);
        const panel = await p.ev(`(()=>{const btns=[...document.querySelectorAll('button')].filter(e=>e.offsetParent!==null);return btns.filter(b=>/Feed|Raft part|Axe|Torch|Spear|Fence|Cook|Rod/i.test(b.innerText)).map(b=>({t:b.innerText.trim().slice(0,40),disabled:b.disabled}))})()`);
        const b4 = await inv(p);
        const clicked = await p.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null&&!e.disabled&&/Feed|Raft part|Axe|Torch|Spear/i.test(e.innerText));if(!b)return null;b.click();return b.innerText.trim().slice(0,40);})()`);
        await sleep(900);
        const now = await inv(p);
        crafted = !!clicked && !!b4 && !!now && (now.crafted > b4.crafted || Object.keys(now.items).some((k) => (now.items[k] ?? 0) !== (b4.items[k] ?? 0)));
        if (crafted) result.firstChoiceS ??= mark("craft", { recipe: clicked, panel });
      }
    }

    await p.ev(`document.querySelector('.rr-veil__play')?.click()`);

    result.choices60 = result.choices.filter((c) => c.t <= 60).length;
    result.ok = true;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    await p.shot(path.join(HERE, "out", `onboarding-fail-${STAMP}.png`));
  }
  return result;
}

/* ------------------------------------------------------------------ compass */

async function compassAt(p, width, height) {
  const result = { width, height, ok: false, error: null, night2: false, maxOverlapPairs: 0, maxOverlaps: [], maxMarks: 0, maxCrabMarks: 0 };
  let room = null;
  try {
    await setViewport(p, width, height);
    const client = new Client(`ws://127.0.0.1:${PORT}`);
    room = await client.create("raft_rush", { nickname: "CompassProbe", character: "sef", fast: true, testSeed: SEED });
    const code = room.roomId;
    await sleep(500);
    await p.seedSettings('CompassProbe');
    await p.goto(`${BASE}/games/raft-rush/?room=${code}`);
    await p.waitFor(`!!document.querySelector('.rr-screen--home:not([hidden])') || !!document.querySelector('.rr-screen--lobby:not([hidden])')`, Boolean, 20000);
    await p.click("Continue anyway");
    await sleep(400);
    await p.ev(`(()=>{const e=document.querySelector('input.rr-field__input');if(e){e.value='CompassProbe';e.dispatchEvent(new Event('input',{bubbles:true}));}const c=document.querySelector('input.rr-field__input--code');if(c&&!c.value)c.value=${JSON.stringify(code)};return 1})()`);
    const joinedNow = await p.waitFor(
      `(()=>{const st=window.__raft?.net?.status||'';const lobby=!!document.querySelector('.rr-screen--lobby:not([hidden])');const code=document.querySelector('input.rr-field__input--code')?.value||'';return lobby?"lobby":st==="connecting"||st==="connected"?"joining":code.length===4?"ready":"wait"})()`,
      (v) => v === "lobby" || v === "joining" || v === "ready",
      9000,
    );
    if (joinedNow === "ready") {
      const ok = await p.click("Join");
      if (!ok) throw new Error("Join button missing on invite screen");
    }
    await p.waitFor(`window.__raft?.net?.state?.players?.size||0`, (v) => v >= 1, 20000);
    await sleep(800);
    room.send("addBot", {});
    room.send("addBot", {});
    await sleep(700);
    room.send("start", {});
    // Wait for night 2 and sample the compass across the short (fast-timer) night.
    const end = Date.now() + 45000;
    let sawNight2 = false;
    while (Date.now() < end) {
      const st = await p.ev(`(()=>{const s=window.__raft?.net?.state;return s?{day:s.day,dp:s.dayPhase,phase:s.phase}:null})()`);
      if (st && st.day === 2 && st.dp === "night" && st.phase === "playing") {
        sawNight2 = true;
        for (let i = 0; i < 6; i++) {
          const ms = await marks(p);
          const ov = overlaps(ms);
          const crabs = ms.filter((m) => /Crab/i.test(m.t)).length;
          if (ms.length > result.maxMarks) result.maxMarks = ms.length;
          if (ov.length > result.maxOverlapPairs) {
            result.maxOverlapPairs = ov.length;
            result.maxOverlaps = ov;
          }
          if (crabs > result.maxCrabMarks) result.maxCrabMarks = crabs;
          await sleep(150);
        }
        break;
      }
      await sleep(100);
    }
    result.night2 = sawNight2;
    if (!sawNight2) throw new Error("night 2 not reached before the timeout");
    if (result.maxCrabMarks < 3) throw new Error(`only ${result.maxCrabMarks} crab mark(s) observed; compass crowding not measurable`);
    result.ok = true;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    await p.shot(path.join(HERE, "out", `compass-fail-${width}x${height}-${STAMP}.png`));
  } finally {
    try {
      await room?.leave(true);
    } catch {
      /* ignore */
    }
  }
  return result;
}

async function compassProbe(p) {
  const viewports = [];
  for (const [w, h] of VIEWPORTS) viewports.push(await compassAt(p, w, h));
  const failed = viewports.filter((v) => !v.ok);
  return {
    ok: failed.length === 0,
    error: failed.length ? failed.map((v) => `${v.width}×${v.height}: ${v.error}`).join("; ") : null,
    viewports,
  };
}

/* --------------------------------------------------------------------- main */

async function main() {
  const out = { generatedAt: new Date().toISOString(), port: PORT, cdpPort: CDP_PORT, onboarding: null, compass: null, error: null };
  let server = null;
  let chrome = null;
  let page = null;
  try {
    server = await ensureServer();
    chrome = await ensureChrome();
    page = await Page.open(CDP_PORT);
    log("server:", server.note, "· browser:", chrome.note);
    if (!flag("no-onboarding")) {
      out.onboarding = await onboardingProbe(page);
      log("onboarding:", JSON.stringify(out.onboarding));
    }
    if (!flag("no-compass")) {
      out.compass = await compassProbe(page);
      log("compass:", JSON.stringify(out.compass));
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  } finally {
    page?.close();
    chrome?.child?.kill("SIGKILL");
    server?.child?.kill("SIGKILL");
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  if (JSON_OUT) {
    process.stdout.write("PROBE_JSON_BEGIN\n" + JSON.stringify(out, null, 2) + "\nPROBE_JSON_END\n");
  } else {
    process.stdout.write(`probe written to ${OUT}\n`);
  }
  process.exit(out.error ? 1 : 0);
}

main();
