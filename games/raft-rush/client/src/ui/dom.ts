// Tiny DOM helpers shared by every UI module: build once, patch in place. Owner: client-ui.
// Adapted from games/bonk-brawl/client/src/ui/dom.ts + games/kasala/client/src/ui/hud/dom.ts. Every setter is a
// no-op when nothing changed, so the HUD can call update() on every frame without touching the DOM.
// Reduced motion (the OS prefers-reduced-motion or settings.reducedFlashing): play() jumps every one-shot animation
// to its end and bindRootPrefs() sets .rr-reduced on the UI root (ui.css collapses the CSS animations too).

import { prefersReducedMotion, settings, type Settings } from "../app/settings";
import { t, type Params } from "../i18n";

type Child = Node | string | null | undefined | false;

/** Create an element with an optional class list and children (strings become text nodes). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Replace a node's children, skipping null / undefined / false entries. */
export function fill(node: Element, ...children: Child[]): void {
  node.replaceChildren(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
}

/** A real `<button type="button">` (never submits a surrounding form by accident). */
export function button(className: string, ...children: Child[]): HTMLButtonElement {
  const b = el("button", className, ...children);
  b.type = "button";
  return b;
}

const svgTemplate = typeof document !== "undefined" ? document.createElement("template") : null;

/** Parse trusted, static SVG markup (from icons.ts) into an element. */
export function svg(markup: string): SVGSVGElement {
  if (!svgTemplate) throw new Error("svg(): no DOM");
  svgTemplate.innerHTML = markup.trim();
  const node = svgTemplate.content.firstElementChild;
  if (!(node instanceof SVGSVGElement)) throw new Error("svg(): markup is not an <svg>");
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("focusable", "false");
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Create a namespaced SVG child element with attributes. */
export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element | null): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (parent) parent.appendChild(node);
  return node;
}

/** Set text only when it changed (cheap per-frame updates). */
export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** Display text drawn with a thick ink outline (`.rr-outlined` in ui.css reads data-text). */
export function setOutlinedText(node: HTMLElement, text: string): void {
  if (node.textContent === text) return;
  node.textContent = text;
  node.dataset.text = text;
}

/** Toggle `hidden` only when it changed. */
export function setHidden(node: HTMLElement | SVGElement, hidden: boolean): void {
  if (node instanceof HTMLElement) {
    if (node.hidden !== hidden) node.hidden = hidden;
  } else if (node.hasAttribute("hidden") !== hidden) {
    node.toggleAttribute("hidden", hidden);
  }
}

/** Toggle a class only when it changed. */
export function toggleClass(node: Element, cls: string, on: boolean): void {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on);
}

/** Set a CSS custom property only when its value changed. */
export function setVar(node: HTMLElement | SVGElement, name: string, value: string): void {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
}

export function setAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

export function setDisabled(btn: HTMLButtonElement | HTMLInputElement, off: boolean): void {
  if (btn.disabled !== off) btn.disabled = off;
}

/** UI motion is reduced: the OS asks for it, or the player turned on reduced flashing. */
export function reducedMotion(): boolean {
  return settings.get().reducedFlashing || prefersReducedMotion();
}

/**
 * One-shot keyframe animation that never needs a reflow to restart (null where WAAPI is missing). With reduced
 * motion it still runs, but with no duration or delay: it lands on its end state at once and onfinish / finished
 * still fire (leave animations still remove their node), so banner slams, toast pops, match-end entrances and
 * input shakes simply don't move.
 */
export function play(node: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  if (typeof node.animate !== "function") return null;
  if (reducedMotion()) return node.animate(keyframes, { ...options, duration: 0, delay: 0, endDelay: 0, iterations: 1 });
  return node.animate(keyframes, options);
}

/**
 * Mirror the UI settings on the UI root: `--hud-scale` (the HUD size slider; ui.css multiplies --u by it) and
 * `.rr-reduced` (reduced flashing: CSS animations collapse like under prefers-reduced-motion). Returns an unsubscribe.
 */
export function bindRootPrefs(root: HTMLElement): () => void {
  const apply = (s: Readonly<Settings>): void => {
    setVar(root, "--hud-scale", String(s.hudScale));
    toggleClass(root, "rr-reduced", s.reducedFlashing);
  };
  apply(settings.get());
  return settings.onChange((s, changed) => {
    if (changed.includes("hudScale") || changed.includes("reducedFlashing")) apply(s);
  });
}

/** Restart a CSS animation class. */
export function replay(node: Element, cls: string): void {
  node.classList.remove(cls);
  if (node instanceof HTMLElement) void node.offsetWidth;
  else void node.getBoundingClientRect();
  node.classList.add(cls);
}

export const POP_KEYFRAMES: Keyframe[] = [
  { transform: "scale(0.6)", offset: 0 },
  { transform: "scale(1.18)", offset: 0.55 },
  { transform: "scale(0.94)", offset: 0.8 },
  { transform: "scale(1)", offset: 1 },
];

export const SHAKE_KEYFRAMES: Keyframe[] = [
  { transform: "translateX(0)" },
  { transform: "translateX(-8px) rotate(-1deg)" },
  { transform: "translateX(7px) rotate(1deg)" },
  { transform: "translateX(-5px)" },
  { transform: "translateX(3px)" },
  { transform: "translateX(0)" },
];

/** True while focus is inside a text field (global hotkeys must not steal typing). */
export function isTyping(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return true;
  return active instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(active.type);
}

export type GridDir = "left" | "right" | "up" | "down";

/** The arrow keys' grid direction (null: not an arrow key). */
export function arrowDir(code: string): GridDir | null {
  return code === "ArrowLeft" ? "left" : code === "ArrowRight" ? "right" : code === "ArrowUp" ? "up" : code === "ArrowDown" ? "down" : null;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Arrow-key move in a wrapped grid of tiles: left / right step through the list (reading order); up / down go to
 * the nearest tile in the row above / below (by the boxes' centers), staying put at the edge. Without a layout
 * (all boxes empty) up / down step like left / right. Returns the new index (or `from`).
 */
export function neighborIndex(boxes: readonly Box[], from: number, dir: GridDir): number {
  if (from < 0 || from >= boxes.length) return boxes.length > 0 ? 0 : -1;
  const laidOut = boxes.some((b) => b.w > 0 && b.h > 0);
  if (dir === "left" || dir === "right" || !laidOut) {
    const step = dir === "left" || dir === "up" ? -1 : 1;
    return Math.max(0, Math.min(boxes.length - 1, from + step));
  }
  const a = boxes[from]!;
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  let best = from;
  let bestScore = Infinity;
  boxes.forEach((b, i) => {
    const dy = b.y + b.h / 2 - ay;
    if (i === from || (dir === "up" ? dy > -a.h / 2 : dy < a.h / 2)) return;
    const score = Math.abs(dy) * 1000 + Math.abs(b.x + b.w / 2 - ax);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/**
 * Keep Tab / Shift+Tab inside a modal panel: true when it moved the focus itself (the key was used). The focus on
 * the panel itself (a dialog focused on open) or outside it goes to the first item (Shift: the last).
 */
export function trapTab(container: HTMLElement, e: KeyboardEvent): boolean {
  if (e.code !== "Tab") return false;
  const items = [...container.querySelectorAll<HTMLElement>("button, input, [tabindex]")].filter(
    (n) => n.tabIndex >= 0 && !n.closest("[hidden]") && !(n as HTMLButtonElement).disabled,
  );
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return false;
  const active = document.activeElement;
  const outside = !active || active === container || !container.contains(active);
  if (e.shiftKey ? outside || active === first : outside || active === last) {
    (e.shiftKey ? last : first).focus();
    return true;
  }
  return false;
}

/** neighborIndex over live elements (their bounding boxes). */
export function gridNeighbor(items: readonly HTMLElement[], from: number, dir: GridDir): number {
  return neighborIndex(
    items.map((n) => {
      const r = n.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }),
    from,
    dir,
  );
}

/** Clamp to [0, 1] (NaN → 0). */
export function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

/**
 * Translate a key that may or may not carry its section ("nightComing" and "banner.nightComing" both work):
 * models give keys "under banner.* / feed.* / reject.*" and we don't want to depend on which spelling the app uses.
 */
export function tr(key: string, section: string, params?: Params): string {
  if (!key) return "";
  return t(key.includes(".") ? key : `${section}.${key}`, params);
}

/** Pick one "|"-separated variant of a string (quips, jokes). `seed` makes the choice stable for one event. */
export function pickVariant(text: string, seed: number): string {
  const parts = text.split("|");
  const i = Math.abs(Math.floor(seed)) % parts.length;
  return parts[i] ?? text;
}

/** Copy text with the async clipboard API, falling back to a hidden textarea (http / old browsers). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/**
 * HUD buttons never steal keyboard focus (Space / E must keep going to the game; a focused button would fire
 * twice on Enter) and ignore clicks while disabled.
 */
export function noFocus(btn: HTMLButtonElement): HTMLButtonElement {
  btn.tabIndex = -1;
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  return btn;
}

/** Wrap a bearing difference to (-PI, PI]. */
export function wrapAngle(a: number): number {
  const TAU = Math.PI * 2;
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}
