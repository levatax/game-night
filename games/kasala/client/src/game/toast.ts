// Tiny toasts + the connection pill, in Game's own top layer. Owner: client-net-game.
// Used for things no other module shows: "Yeniden bağlanılıyor…", short deny reasons, view changes, server
// notices while the HUD is hidden (lobby joins / leaves). Styles are injected once (ks-game-* classes, theme
// tokens).
//
// Placement: a right-aligned column in the top-right corner. The HUD owns the top center (plate, turn strip,
// banners), the bottom-left corner and the bottom center, so the column is kept narrow enough to stay right of
// the plate at every size (--u is the HUD's own unit; the plate is well under 2 × 200 units wide) and toasts
// wrap instead of growing toward the middle.

const CSS = `
.ks-game-toasts{--u:clamp(0.8px,min(0.0729vw,0.1296vh),1.6px);--gut:calc(var(--u)*14);position:absolute;
  top:var(--gut);right:var(--gut);display:flex;flex-direction:column;align-items:flex-end;gap:6px;
  pointer-events:none;z-index:5;width:clamp(150px,calc(50vw - var(--u)*200 - var(--gut)),380px)}
.ks-game-toast{font:600 clamp(13px,calc(var(--u)*16),17px)/1.25 var(--font,"Fredoka",system-ui,sans-serif);
  color:var(--cream,#fff4df);background:rgba(36,31,43,.94);border:3px solid #000;border-radius:16px;
  padding:5px 14px 6px;box-shadow:0 4px 0 #000;max-width:100%;text-align:right;overflow-wrap:break-word;
  text-wrap:balance;transform-origin:100% 0;animation:ks-game-in .28s cubic-bezier(.2,1.6,.4,1) both}
.ks-game-toast--bad{background:#e5383b;color:#fff4df}
.ks-game-toast--good{background:#7bd389;color:#241f2b}
.ks-game-toast--out{animation:ks-game-out .25s ease-in both}
.ks-game-pill{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);pointer-events:none;z-index:6;
  font:700 16px var(--font,"Fredoka",system-ui,sans-serif);color:#241f2b;background:#ffc93c;border:3px solid #000;
  border-radius:999px;padding:8px 18px;box-shadow:0 4px 0 #000;display:none;align-items:center;gap:10px}
.ks-game-pill.is-on{display:flex;animation:ks-game-in .3s cubic-bezier(.2,1.6,.4,1) both}
.ks-game-pill i{width:12px;height:12px;border-radius:50%;background:#e5383b;box-shadow:0 0 0 0 rgba(229,56,59,.7);
  animation:ks-game-pulse 1s ease-out infinite}
@keyframes ks-game-in{from{opacity:0;transform:translateY(-10px) scale(.8)}to{opacity:1;transform:none}}
@keyframes ks-game-out{to{opacity:0;transform:translateY(-8px) scale(.9)}}
@keyframes ks-game-pulse{to{box-shadow:0 0 0 10px rgba(229,56,59,0)}}
@media (prefers-reduced-motion: reduce){.ks-game-toast,.ks-game-pill.is-on,.ks-game-pill i{animation:none}}
`;

export type ToastKind = "info" | "good" | "bad";

const MAX_TOASTS = 3;

export class Toasts {
  private stack: HTMLDivElement;
  private pillEl: HTMLDivElement;
  private pillText: HTMLSpanElement;

  constructor(layer: HTMLElement) {
    if (!document.getElementById("ks-game-style")) {
      const style = document.createElement("style");
      style.id = "ks-game-style";
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    this.stack = document.createElement("div");
    this.stack.className = "ks-game-toasts";
    this.stack.setAttribute("aria-live", "polite");
    this.pillEl = document.createElement("div");
    this.pillEl.className = "ks-game-pill";
    this.pillEl.setAttribute("role", "status");
    this.pillEl.appendChild(document.createElement("i"));
    this.pillText = document.createElement("span");
    this.pillEl.appendChild(this.pillText);
    layer.append(this.stack, this.pillEl);
  }

  /** Short message (plain text) for `sec` seconds. */
  show(text: string, kind: ToastKind = "info", sec = 2.4): void {
    if (!text) return;
    const last = this.stack.lastElementChild as HTMLElement | null;
    if (last && last.textContent === text && !last.classList.contains("ks-game-toast--out")) return; // no spam
    const el = document.createElement("div");
    el.className = `ks-game-toast${kind === "info" ? "" : ` ks-game-toast--${kind}`}`;
    el.textContent = text;
    this.stack.appendChild(el);
    while (this.stack.childElementCount > MAX_TOASTS) this.stack.firstElementChild?.remove();
    setTimeout(() => {
      el.classList.add("ks-game-toast--out");
      setTimeout(() => el.remove(), 260);
    }, sec * 1000);
  }

  /** Persistent status pill (null hides it). */
  pill(text: string | null): void {
    if (text === null) {
      this.pillEl.classList.remove("is-on");
      return;
    }
    this.pillText.textContent = text;
    this.pillEl.classList.add("is-on");
  }

  clear(): void {
    this.stack.replaceChildren();
    this.pill(null);
  }
}
