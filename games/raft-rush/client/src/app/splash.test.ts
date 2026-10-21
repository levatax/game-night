// The loading splash goes away without a flash: at once on a fast load or with reduced motion, faded otherwise,
// and dismissing twice (App.start + a boot error) is harmless. When the bundle never runs, index.html's fallback
// script offers a reload (run here against a fake DOM). Owner: client-app.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTINGS_STORAGE_KEY } from "../../../shared/constants";
import { dismissSplash, SPLASH_DELAY_MS, SPLASH_FADE_MS, SPLASH_ID, SPLASH_STALL_MS, type SplashClock, type SplashHost } from "./splash";

describe("index.html splash", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

  it("matches splash.ts: element id, card delay, fade time, and the settings key the inline script reads", () => {
    expect(html).toContain(`id="${SPLASH_ID}"`);
    expect(html).toContain(`ease-out ${SPLASH_DELAY_MS / 1000}s forwards`);
    expect(html).toContain(`transition: opacity ${SPLASH_FADE_MS / 1000}s`);
    expect(html).toContain(`localStorage.getItem("${SETTINGS_STORAGE_KEY}")`);
  });

  it("never blocks input, honors reduced motion, and carries both languages", () => {
    expect(/#rr-splash\s*\{[^}]*pointer-events:\s*none/.test(html)).toBe(true);
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain("Loading the island…");
    expect(html).toContain('data-tr="Ada yükleniyor…"');
  });
});

/* ------------------------------------------- index.html's no-bundle fallback */

interface FakeButton {
  type: string;
  className: string;
  textContent: string;
  focused: boolean;
  click(): void;
  addEventListener(type: string, fn: () => void): void;
  focus(): void;
}

/** Run index.html's fallback script (the inline one that defines offerReload) against a fake DOM. */
function runFallback(html: string, lang: "en" | "tr") {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const src = scripts.find((s) => s.includes("offerReload"));
  if (!src) throw new Error("index.html has no splash fallback script");
  const errorListeners: { fn: (event: { target: unknown }) => void; capture: unknown }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const classes = new Set<string>();
  const text = { textContent: "Loading the island…" };
  const buttons: FakeButton[] = [];
  let present = true;
  let reloads = 0;
  const splash = {
    classList: { contains: (c: string) => classes.has(c), add: (c: string) => void classes.add(c) },
    querySelector: (sel: string) => (sel === ".rr-splash__text" ? text : sel === ".rr-splash__card" ? { appendChild: (b: FakeButton) => void buttons.push(b) } : null),
  };
  const document = {
    documentElement: { lang },
    getElementById: (id: string) => (id === SPLASH_ID && present ? splash : null),
    createElement: (): FakeButton => {
      let onClick: () => void = () => undefined;
      return {
        type: "",
        className: "",
        textContent: "",
        focused: false,
        click: () => onClick(),
        addEventListener: (type, fn) => void (type === "click" && (onClick = fn)),
        focus() {
          this.focused = true;
        },
      };
    },
  };
  const window = { addEventListener: (type: string, fn: (event: { target: unknown }) => void, capture: unknown) => void (type === "error" && errorListeners.push({ fn, capture })) };
  const location = { reload: () => void reloads++ };
  const setTimeout = (fn: () => void, ms: number) => void timers.push({ fn, ms });
  new Function("window", "document", "location", "setTimeout", src)(window, document, location, setTimeout);
  return {
    errorListeners,
    timers,
    classes,
    text,
    buttons,
    reloads: () => reloads,
    loadError: (target: unknown) => errorListeners.forEach((l) => l.fn({ target })),
    remove: () => void (present = false),
  };
}

describe("index.html no-bundle fallback", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

  it("a module script or modulepreload that fails to load offers a reload at once; other resources don't", () => {
    const page = runFallback(html, "en");
    expect(page.errorListeners.map((l) => l.capture)).toEqual([true]); // load errors don't bubble
    page.loadError({ tagName: "LINK", rel: "stylesheet" }); // the web font
    page.loadError({ tagName: "IMG" });
    page.loadError(page); // a runtime error (target: window)
    expect(page.buttons).toHaveLength(0);
    expect(page.text.textContent).toBe("Loading the island…");
    page.loadError({ tagName: "LINK", rel: "modulepreload" });
    expect(page.text.textContent).toBe("The game couldn't load.");
    expect(page.classes.has("is-stuck")).toBe(true);
    expect(page.buttons.map((b) => [b.type, b.className, b.textContent, b.focused])).toEqual([["button", "rr-splash__reload", "Reload the page", true]]);
    page.buttons[0]!.click();
    expect(page.reloads()).toBe(1);
  });

  it("a splash still up after SPLASH_STALL_MS asks (in Turkish here); a later failure says so, with one button", () => {
    const page = runFallback(html, "tr");
    expect(page.timers.map((t) => t.ms)).toEqual([SPLASH_STALL_MS]);
    page.timers[0]!.fn();
    expect(page.text.textContent).toBe("Yükleme normalden uzun sürüyor.");
    expect(page.buttons.map((b) => b.textContent)).toEqual(["Sayfayı yenile"]);
    page.loadError({ tagName: "SCRIPT" });
    expect(page.text.textContent).toBe("Oyun yüklenemedi.");
    page.timers[0]!.fn();
    expect(page.text.textContent).toBe("Oyun yüklenemedi.");
    expect(page.buttons).toHaveLength(1);
  });

  it("does nothing once the app removed the splash or it is fading out", () => {
    const gone = runFallback(html, "en");
    gone.remove();
    gone.timers[0]!.fn();
    gone.loadError({ tagName: "SCRIPT" });
    expect(gone.buttons).toHaveLength(0);
    const fading = runFallback(html, "en");
    fading.classes.add("is-leaving");
    fading.timers[0]!.fn();
    expect(fading.buttons).toHaveLength(0);
    expect(fading.text.textContent).toBe("Loading the island…");
  });

  it("keeps the stuck card's Reload the only clickable part, and the script ES5 (an old browser must run it)", () => {
    expect(/\.rr-splash__reload\s*\{[^}]*pointer-events:\s*auto/.test(html)).toBe(true);
    const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).join("\n");
    expect(src).not.toMatch(/\b(?:const|let)\s|=>|`|,\s*\)/);
  });
});

function fakeDom(): { host: SplashHost; classes: string[]; removed: () => boolean; asked: string[] } {
  const classes: string[] = [];
  const asked: string[] = [];
  let gone = false;
  const node = { classList: { add: (c: string) => void classes.push(c) }, remove: () => void (gone = true) };
  return {
    host: {
      getElementById: (id: string) => {
        asked.push(id);
        return gone ? null : node;
      },
    },
    classes,
    removed: () => gone,
    asked,
  };
}

function fakeClock(now: number, reducedMotion = false): SplashClock & { timers: { fn: () => void; ms: number }[] } {
  const timers: { fn: () => void; ms: number }[] = [];
  return { now: () => now, reducedMotion: () => reducedMotion, later: (fn, ms) => void timers.push({ fn, ms }), timers };
}

describe("dismissSplash", () => {
  it("removes it at once on a fast load (its card never showed)", () => {
    const dom = fakeDom();
    const clock = fakeClock(SPLASH_DELAY_MS - 1);
    expect(dismissSplash(dom.host, clock)).toBe(false);
    expect(dom.asked).toEqual([SPLASH_ID]);
    expect(dom.removed()).toBe(true);
    expect(dom.classes).toEqual([]);
    expect(clock.timers).toHaveLength(0);
  });

  it("fades a visible splash out, then removes it", () => {
    const dom = fakeDom();
    const clock = fakeClock(2500);
    expect(dismissSplash(dom.host, clock)).toBe(true);
    expect(dom.classes).toEqual(["is-leaving"]);
    expect(dom.removed()).toBe(false);
    expect(clock.timers.map((t) => t.ms)).toEqual([SPLASH_FADE_MS]);
    clock.timers[0]!.fn();
    expect(dom.removed()).toBe(true);
  });

  it("skips the fade under prefers-reduced-motion", () => {
    const dom = fakeDom();
    const clock = fakeClock(2500, true);
    expect(dismissSplash(dom.host, clock)).toBe(false);
    expect(dom.removed()).toBe(true);
    expect(dom.classes).toEqual([]);
  });

  it("is a no-op once it's gone, and without a DOM", () => {
    const dom = fakeDom();
    dismissSplash(dom.host, fakeClock(0));
    expect(dismissSplash(dom.host, fakeClock(2500))).toBe(false);
    expect(dom.classes).toEqual([]);
    expect(dismissSplash(null, fakeClock(2500))).toBe(false);
  });
});
