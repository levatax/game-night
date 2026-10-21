// First-time tips (coach marks), one at a time, each with an arrow to its control: first own turn → ÇEVİR,
// after the first card → KASALA! and the risk, first bet window → the bet tray, first attack → the target
// prompt, first ≥30% risk → the siren. A tip goes away when its moment passes (the player acted) or after
// TIP_SEC, and is never shown again on this browser (localStorage "kasala:coach:v1", best effort).

import { h, setText, show, toggle } from "./dom";

export type TipId = "flip" | "cash" | "bet" | "target" | "siren" | "market";

const STORAGE_KEY = "kasala:coach:v1";
const TIP_SEC = 6;
/** Wait for the anchor's own entry animation before measuring it. */
const SETTLE_SEC = 0.45;

interface Pending {
  id: TipId;
  anchor: HTMLElement;
  text: string;
  place: "above" | "below";
  wait: number;
}

function loadSeen(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export class Coach {
  readonly root: HTMLDivElement;
  private readonly text: HTMLSpanElement;
  private readonly seen = loadSeen();
  private pending: Pending | null = null;
  private current: TipId | null = null;
  private left = 0;

  constructor(private readonly host: HTMLElement) {
    this.root = h("div", "ks-hud-coach", host);
    this.root.setAttribute("role", "status");
    h("span", "ks-hud-coach__tag", this.root, "İPUCU");
    this.text = h("span", "ks-hud-coach__text", this.root);
  }

  /** The tip that is up (or waiting to go up). */
  get active(): TipId | null {
    return this.current ?? this.pending?.id ?? null;
  }

  /** Offer a tip; ignored when it was seen before or another tip is up. */
  offer(id: TipId, anchor: HTMLElement, text: string, place: "above" | "below" = "above"): void {
    if (this.seen.has(id) || this.current || this.pending) return;
    this.pending = { id, anchor, text, place, wait: SETTLE_SEC };
  }

  /** The moment for `id` passed (the player acted, the phase moved on). */
  dismiss(id: TipId): void {
    if (this.pending?.id === id) this.pending = null;
    if (this.current === id) this.close();
  }

  hideAll(): void {
    this.pending = null;
    if (this.current) this.close();
  }

  tick(dt: number): void {
    if (this.pending) {
      this.pending.wait -= dt;
      if (this.pending.wait <= 0) {
        const p = this.pending;
        this.pending = null;
        this.open(p);
      }
      return;
    }
    if (!this.current) return;
    this.left -= dt;
    if (this.left <= 0) this.close();
  }

  private open(p: Pending): void {
    // one layout read per tip (rare): the anchor must be on screen
    const r = p.anchor.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const host = this.host.getBoundingClientRect();
    const half = Math.min(170, host.width / 2);
    const cx = r.left - host.left + r.width / 2;
    const x = Math.max(half, Math.min(host.width - half, cx));
    const y = p.place === "above" ? r.top - host.top : r.bottom - host.top;
    this.root.style.left = `${Math.round(x)}px`;
    this.root.style.top = `${Math.round(y)}px`;
    this.root.style.setProperty("--ax", `${Math.round(cx - x)}px`);
    toggle(this.root, "ks-hud-coach--below", p.place === "below");
    setText(this.text, p.text);
    show(this.root, true);
    this.root.classList.remove("ks-hud-coach--in");
    void this.root.offsetWidth;
    this.root.classList.add("ks-hud-coach--in");
    this.current = p.id;
    this.left = TIP_SEC;
    this.seen.add(p.id);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.seen]));
    } catch {
      /* private mode: tips may repeat next time */
    }
  }

  private close(): void {
    this.current = null;
    this.left = 0;
    show(this.root, false);
  }
}
