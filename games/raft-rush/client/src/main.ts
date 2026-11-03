// Raft Rush client entry: boots the App (the UI loads its own styles), and shows a friendly card when the game
// can't run at all (no WebGL). The inline loading splash of index.html is removed by App.start(), or here when
// the boot fails. Owner: client-app.

import { App } from "./app/App";
import { settings, type Quality } from "./app/settings";
import { dismissSplash } from "./app/splash";
import { t } from "./i18n";

/** Shown instead of the game when it can't boot (usually no WebGL). */
function showFatal(uiRoot: HTMLElement, err: unknown): void {
  console.error("[raft-rush] failed to start", err);
  dismissSplash();
  const panel = document.createElement("div");
  panel.setAttribute("role", "alert");
  panel.style.cssText = "position:fixed;inset:0;display:grid;place-items:center;padding:24px;text-align:center;pointer-events:auto;font-size:18px;line-height:1.5";
  const box = document.createElement("div");
  box.style.cssText = "max-width:440px;background:#FFF4DC;color:#2D2A32;border:4px solid #2D2A32;border-radius:22px;padding:24px;box-shadow:0 8px 0 #2D2A32";
  const title = document.createElement("h1");
  title.textContent = t("feed.fatalTitle");
  title.style.cssText = "margin:0 0 8px;font-size:26px";
  const text = document.createElement("p");
  text.textContent = t("feed.fatalText");
  text.style.margin = "0 0 16px";
  const back = document.createElement("a");
  back.href = "/";
  back.textContent = t("feed.fatalBack");
  back.style.cssText = "color:#2D2A32;font-weight:600";
  box.append(title, text, back);
  panel.append(box);
  uiRoot.append(panel);
}

/** The page is served from this machine (the hub's `npm run dev` / `npm start`), never from a real host. */
function isLocalPage(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

const gameRoot = document.getElementById("game");
const uiRoot = document.getElementById("ui");
if (!gameRoot || !uiRoot) throw new Error("Raft Rush: missing #game or #ui root");

try {
  // Acceptance/debug readout: `?quality=low|medium|high` pins the tier before the renderer boots (so
  // `?stats=1&quality=high` measures a known setting), never override it with Auto.
  const requested = new URLSearchParams(location.search).get("quality");
  if (requested === "low" || requested === "medium" || requested === "high") {
    settings.set({ quality: requested as Quality, autoQuality: false });
  }
  const app = new App(gameRoot, uiRoot);
  // ?debug=1 on a dev bundle or a page served from this machine only: expose the app for console inspection. The
  // hub's `npm run dev` builds production bundles, hence the localhost case; a deployed host never gets the hook.
  const debug = (import.meta.env.DEV || isLocalPage(location.hostname)) && new URLSearchParams(location.search).has("debug");
  if (debug) (window as unknown as { __raft: App }).__raft = app;
  app.start().catch((err: unknown) => {
    console.error("[raft-rush] boot error", err);
    dismissSplash();
  });
} catch (err) {
  showFatal(uiRoot, err);
}
