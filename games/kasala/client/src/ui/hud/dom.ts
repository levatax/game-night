// Tiny DOM helpers for the HUD: build once, patch in place. Every setter is a no-op when nothing changed,
// so update() can run on every patch without touching the DOM.

import type { Animal } from "../../../../shared/constants";
import type { UiSound } from "../../app/ui";

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  parent?: Element | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element | null,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (parent) parent.appendChild(node);
  return node;
}

export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function toggle(node: Element, cls: string, on: boolean): void {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on);
}

/** Set a CSS custom property / style property only when it changed. */
export function setVar(node: HTMLElement | SVGElement, name: string, value: string): void {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
}

export function setAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

export function setDisabled(btn: HTMLButtonElement, off: boolean): void {
  if (btn.disabled !== off) btn.disabled = off;
}

/** Restart a CSS animation class. */
export function replay(node: Element, cls: string): void {
  node.classList.remove(cls);
  if (node instanceof HTMLElement) void node.offsetWidth;
  else void node.getBoundingClientRect();
  node.classList.add(cls);
}

/** Show/hide with the shared `.ks-hud-on` toggle (CSS handles the pop in/out). */
export function show(node: Element, on: boolean): void {
  toggle(node, "ks-hud-on", on);
}

export const ANIMAL_ICON: Record<Animal, string> = {
  kedi: "🐱",
  kopek: "🐶",
  domuz: "🐷",
  fare: "🐭",
  kurbaga: "🐸",
  tavsan: "🐰",
};

export function animalIcon(a: Animal | string | undefined): string {
  return (a && ANIMAL_ICON[a as Animal]) || "🎩";
}

/** Turkish number: 1.8 → "1,8", 1250 → "1.250". */
export function trNum(n: number, maxDigits = 1): string {
  return n.toLocaleString("tr-TR", { maximumFractionDigits: maxDigits });
}

/** Clamp to [0, 1]. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Linear blend of two #RRGGBB colors. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const k = clamp01(t);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - k) + ((pb >> shift) & 255) * k);
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

/**
 * Wire a HUD button: hover/click UI sounds, never steals keyboard focus (Space/Enter must keep going to the
 * game, a focused button would fire twice), ignores clicks while disabled.
 */
export function wireButton(btn: HTMLButtonElement, sound: (k: UiSound) => void, fn: () => void, clickSound: UiSound | "" = "click"): void {
  btn.type = "button";
  btn.tabIndex = -1;
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("pointerenter", () => {
    if (!btn.disabled && !btn.classList.contains("ks-hud-off")) sound("hover");
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.blur();
    if (btn.disabled) return;
    if (clickSound) sound(clickSound);
    fn();
  });
}

/** Is the keyboard currently typing into a form control (then key-press visuals stay quiet)? */
export function typingInField(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return false;
  const tag = a.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || a.isContentEditable;
}
