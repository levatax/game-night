// Tiny DOM helpers shared by every UI module. Owner: client-ui.

type Child = Node | string | null | undefined | false;

/** Create an element with an optional class list and children (strings become text nodes). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** A real `<button type="button">` (never submits a surrounding form by accident). */
export function button(className: string, ...children: Child[]): HTMLButtonElement {
  const b = el("button", className, ...children);
  b.type = "button";
  return b;
}

const svgTemplate = document.createElement("template");

/** Parse trusted, static SVG markup (from icons.ts) into an element. */
export function svg(markup: string): SVGSVGElement {
  svgTemplate.innerHTML = markup.trim();
  const node = svgTemplate.content.firstElementChild;
  if (!(node instanceof SVGSVGElement)) throw new Error("svg(): markup is not an <svg>");
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("focusable", "false");
  return node;
}

/** Set text only when it changed (cheap per-frame updates). */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** Display text drawn with a thick ink outline (see `.outlined` in ui.css). */
export function setOutlinedText(node: HTMLElement, text: string): void {
  if (node.textContent === text) return;
  node.textContent = text;
  node.dataset.text = text;
}

/** Toggle `hidden` only when it changed. */
export function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}

/** Set a CSS custom property only when its value changed. */
export function setVar(node: HTMLElement, name: string, value: string): void {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
}

/** One-shot keyframe animation that never needs a reflow to restart. */
export function play(node: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  if (typeof node.animate !== "function") return null;
  return node.animate(keyframes, options);
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
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  if (active instanceof HTMLTextAreaElement) return true;
  return active instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(active.type);
}
