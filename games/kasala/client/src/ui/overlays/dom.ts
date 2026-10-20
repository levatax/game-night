// Tiny DOM helpers shared by the overlay windows. Nicknames only ever reach the DOM through textContent.

import type { KasalaStateView, PlayerView } from "../../../../shared/protocol";
import { playerColor } from "../../app/ui";
import { animalPortrait } from "../menu/portraits";

export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", value?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (value !== undefined) e.textContent = value;
  return e;
};

export const vals = <T>(map: { values(): IterableIterator<T> }): T[] => [...map.values()];

export const who = (s: KasalaStateView, id: string): string => s.players.get(id)?.nickname ?? "Bilinmeyen oyuncu";

/** Animal head in the player's hat color (trusted enum-owned SVG). */
export const face = (p: PlayerView): HTMLElement => {
  const e = h("span", "ks-ov-face");
  e.setAttribute("aria-hidden", "true");
  e.innerHTML = animalPortrait(p.animal, playerColor(p.color));
  return e;
};

/** "🤖 BOT" tag shown next to server-controlled players. */
export const botBadge = (): HTMLElement => {
  const e = h("span", "ks-ov-bot", "🤖 BOT");
  e.title = "Bilgisayar oyuncusu";
  return e;
};

/** Player name cell: face + nickname (+ bot tag). */
export function nameTag(p: PlayerView, cls = "ks-ov-name"): HTMLElement {
  const e = h("span", cls);
  e.append(face(p), h("span", "ks-ov-name__text", p.nickname));
  if (p.bot) e.appendChild(botBadge());
  return e;
}

export function kbd(key: string): HTMLElement {
  return h("kbd", "", key);
}

export function btn(label: string, action: () => void, tone?: "green" | "red" | "ghost", cls = ""): HTMLButtonElement {
  const e = h("button", cls, label);
  e.type = "button";
  if (tone) e.dataset.tone = tone;
  e.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!e.disabled) action();
  });
  return e;
}

/** Writes textContent only when it changed (patches arrive at up to 20 Hz). */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** True when a key event belongs to a text field (overlay hotkeys must not eat typing). */
export function typing(e: KeyboardEvent): boolean {
  const t = e.target;
  return (
    t instanceof HTMLInputElement && t.type !== "checkbox" && t.type !== "range" ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}
