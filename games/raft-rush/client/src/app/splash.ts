// The inline loading splash of client/index.html (#rr-splash, gap analysis N5). index.html paints it before the
// ~1.6 MB bundle arrives: a navy backdrop identical to the empty page, with a card that only fades in after
// SPLASH_DELAY_MS (so a fast load never flashes it), pointer-events: none, the text picked en / tr by an inline
// script, motion off under prefers-reduced-motion. App.start() removes it once the first screen is up (main.ts
// also does when the boot fails, so the fatal card is visible). When the bundle never runs, a second inline script
// in index.html turns it into "couldn't load" (a script / modulepreload load error) or "taking longer than usual"
// (still up after SPLASH_STALL_MS) with a Reload button, the only part that takes clicks. Owner: client-app.

/** id of the splash element in index.html. */
export const SPLASH_ID = "rr-splash";
/** Must match the card's animation-delay in index.html: before it, nothing but the backdrop is on screen. */
export const SPLASH_DELAY_MS = 350;
/** Fade-out (index.html: #rr-splash.is-leaving transition). */
export const SPLASH_FADE_MS = 300;
/** index.html's fallback: a splash still up this long after navigation offers a reload (the bundle may never run). */
export const SPLASH_STALL_MS = 30_000;

/** What dismissSplash() touches (the DOM in the game; plain fakes in tests). */
export interface SplashHost {
  getElementById(id: string): { classList: { add(token: string): void }; remove(): void } | null;
}

export interface SplashClock {
  /** ms since navigation (performance.now(): the same origin as the CSS animation timeline). */
  now(): number;
  /** prefers-reduced-motion: reduce. */
  reducedMotion(): boolean;
  later(fn: () => void, ms: number): void;
}

const browserClock: SplashClock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : 0),
  reducedMotion: () => {
    try {
      return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    } catch {
      return false;
    }
  },
  later: (fn, ms) => void window.setTimeout(fn, ms),
};

/**
 * Remove the splash (no-op when it's already gone). Before its card showed (fast load) or with reduced motion it
 * goes at once; otherwise it fades out over SPLASH_FADE_MS and is removed. Returns true when it faded.
 */
export function dismissSplash(host: SplashHost | null = typeof document !== "undefined" ? document : null, clock: SplashClock = browserClock): boolean {
  let splash: ReturnType<SplashHost["getElementById"]> = null;
  try {
    splash = host?.getElementById(SPLASH_ID) ?? null;
  } catch {
    return false;
  }
  if (!splash) return false;
  const node = splash;
  if (clock.now() < SPLASH_DELAY_MS || clock.reducedMotion()) {
    node.remove();
    return false;
  }
  node.classList.add("is-leaving");
  clock.later(() => node.remove(), SPLASH_FADE_MS);
  return true;
}
