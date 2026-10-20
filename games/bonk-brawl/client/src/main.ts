// Bonk Brawl client entry. Owner: client-app.
import "./ui/ui.css";
import { App } from "./app/App";

/** Shown instead of the game when it can't boot at all (usually no WebGL). */
function showFatal(uiRoot: HTMLElement, err: unknown): void {
  console.error("[bonk-brawl] failed to start", err);
  const panel = document.createElement("div");
  panel.setAttribute("role", "alert");
  panel.style.cssText = [
    "position:fixed",
    "inset:0",
    "display:grid",
    "place-items:center",
    "padding:24px",
    "text-align:center",
    "pointer-events:auto",
    "font-size:18px",
    "line-height:1.5",
  ].join(";");
  const box = document.createElement("div");
  box.style.cssText = "max-width:420px;background:#fff;border:4px solid #2d2a32;border-radius:20px;padding:24px";
  const title = document.createElement("h1");
  title.textContent = "Bonk Brawl couldn't start";
  title.style.cssText = "margin:0 0 8px;font-size:26px";
  const text = document.createElement("p");
  text.textContent = "This game needs WebGL. Try a recent Chrome, Firefox, Edge or Safari, and make sure hardware acceleration is on.";
  text.style.margin = "0 0 16px";
  const back = document.createElement("a");
  back.href = "/";
  back.textContent = "← Back to Game Night";
  back.style.cssText = "color:#2d2a32;font-weight:600";
  box.append(title, text, back);
  panel.append(box);
  uiRoot.append(panel);
}

const gameRoot = document.getElementById("game");
const uiRoot = document.getElementById("ui");
if (!gameRoot || !uiRoot) throw new Error("Bonk Brawl: missing #game or #ui root");

try {
  const app = new App(gameRoot, uiRoot);
  app.start().catch((err: unknown) => console.error("[bonk-brawl] boot error", err));
} catch (err) {
  showFatal(uiRoot, err);
}
