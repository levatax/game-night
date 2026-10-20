// Tiny DOM helpers for the menu screens. User text (nicknames) only ever goes in through textContent.

/** Creates an element with a class, attributes and plain text. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  attrs?: Record<string, string>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Writes textContent only when it changed (20 Hz patches must not thrash the DOM). */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/** Replaces innerHTML with trusted static markup, only when it changed. */
export function setHtml(node: HTMLElement, key: string, html: string): void {
  if (node.dataset.k === key) return;
  node.dataset.k = key;
  node.innerHTML = html;
}

/** Restarts a one-shot CSS animation class. */
export function replay(node: HTMLElement, cls: string): void {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

export function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

/**
 * Radiogroup keyboard pattern on a set of buttons (role="radio"): arrows move focus to the next enabled
 * option and select it, Home / End jump to the ends. `onPick(index)` is called for the newly focused option.
 */
export function radioKeys(group: HTMLElement, buttons: HTMLButtonElement[], onPick: (i: number) => void): void {
  group.addEventListener("keydown", (e) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const cur = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (cur < 0) return;
    e.preventDefault();
    const n = buttons.length;
    const order: number[] = [];
    if (e.key === "Home") for (let i = 0; i < n; i++) order.push(i);
    else if (e.key === "End") for (let i = n - 1; i >= 0; i--) order.push(i);
    else {
      const dir = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
      for (let s = 1; s < n; s++) order.push((cur + dir * s + n * 2) % n);
    }
    for (const i of order) {
      const b = buttons[i]!;
      if (!b.disabled) {
        b.focus();
        onPick(i);
        return;
      }
    }
  });
}

/** Roving tabindex: the checked (or first enabled) option is the group's single tab stop. */
export function rovingTabs(buttons: HTMLButtonElement[], checked: number): void {
  let stop = checked >= 0 && !buttons[checked]?.disabled ? checked : buttons.findIndex((b) => !b.disabled);
  if (stop < 0) stop = 0;
  buttons.forEach((b, i) => {
    const t = i === stop ? 0 : -1;
    if (b.tabIndex !== t) b.tabIndex = t;
  });
}

/** Copies text to the clipboard (with a textarea fallback for plain-http LAN play). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", "", { readonly: "", "aria-hidden": "true" });
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}
