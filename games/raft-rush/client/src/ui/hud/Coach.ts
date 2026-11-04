// First-match coach tips (§17: "Ateşe odun at"): one tip at a time, with an arrow to the HUD widget it explains,
// shown for TIP_MS, never again on this browser once seen (settings.seenTips; the settings menu's "Show tips
// again" clears it). Keys in the text follow the key preset / layout ({kInteract}… via ui/controls.ts keyParams).
// Adapted from games/kasala/client/src/ui/hud/Coach.ts. Owner: client-ui.
//
// The app calls Ui.coach(tipId) at the right moment; ids are the keys of COACH_TIPS (strings: coach.<id>).

import { settings } from "../../app/settings";
import { t } from "../../i18n";
import { keyParams } from "../controls";
import { el, replay, setText, toggleClass } from "../dom";

/** Which HUD area a tip points at. "center" = under the crosshair (no arrow target needed). */
export type CoachAnchor = "bars" | "hotbar" | "clock" | "raft" | "fire" | "compass" | "center" | "mates";

/** Every tip id the UI knows, with the widget it points at. */
export const COACH_TIPS = {
  move: "center",
  gather: "center",
  palm: "center",
  fire: "fire",
  craft: "center",
  raft: "raft",
  bars: "bars",
  spring: "compass",
  dusk: "clock",
  night: "center",
  torch: "hotbar",
  fishing: "hotbar",
  revive: "mates",
  downed: "center",
  board: "raft",
  ping: "compass",
  chest: "center",
  catch: "center",
  lowFire: "fire",
  storm: "clock",
  legend: "center",
  fellWithAxe: "center",
  heavyCarry: "hotbar",
  buildBench: "center",
  salvageWreck: "center",
  assemble: "raft",
  cookProvisions: "raft",
  guardRaft: "raft",
  killBoss: "clock",
} as const satisfies Record<string, CoachAnchor>;

export type CoachTipId = keyof typeof COACH_TIPS;

export function isCoachTip(id: string): id is CoachTipId {
  return Object.prototype.hasOwnProperty.call(COACH_TIPS, id);
}

const TIP_MS = 7000;
const QUEUE_MAX = 3;

export class Coach {
  readonly el = el("div", "rr-coach");
  private readonly text = el("span", "rr-coach__text");
  private readonly queue: CoachTipId[] = [];
  private current: CoachTipId | null = null;
  private timer = 0;
  private enabled = false;

  /** `anchorOf` returns the element a tip points at (or null: the tip floats at the top center). */
  constructor(
    private readonly host: HTMLElement,
    private readonly anchorOf: (a: CoachAnchor) => HTMLElement | null,
  ) {
    this.el.setAttribute("role", "status");
    this.el.append(el("span", "rr-coach__tag", `💡 ${t("coach.tag")}`), this.text);
    this.el.hidden = true;
  }

  /** Tips only show while the HUD is on screen; offers made meanwhile wait in the queue. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) this.hide();
    else this.next();
  }

  offer(id: string): void {
    if (!isCoachTip(id)) return;
    if (this.seen(id) || this.current === id || this.queue.includes(id)) return;
    if (this.queue.length >= QUEUE_MAX) this.queue.shift();
    this.queue.push(id);
    if (!this.current) this.next();
  }

  /** Close the current tip early (e.g. the player did the thing). */
  dismiss(id?: string): void {
    if (id && this.current !== id) {
      const i = this.queue.indexOf(id as CoachTipId);
      if (i >= 0) this.queue.splice(i, 1);
      return;
    }
    this.close();
  }

  private seen(id: string): boolean {
    return settings.get().seenTips.includes(id);
  }

  private next(): void {
    if (!this.enabled || this.current) return;
    while (this.queue.length > 0) {
      const id = this.queue.shift()!;
      if (this.seen(id)) continue;
      this.open(id);
      return;
    }
  }

  private open(id: CoachTipId): void {
    this.current = id;
    setText(this.text, t(`coach.${id}`, keyParams()));
    this.el.hidden = false;
    this.place(COACH_TIPS[id]);
    replay(this.el, "is-in");
    const seen = settings.get().seenTips;
    if (!seen.includes(id)) settings.set({ seenTips: [...seen, id] });
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.close(), TIP_MS);
  }

  /** One layout read per tip (rare): above the anchor when there's room, else below it. */
  private place(anchor: CoachAnchor): void {
    const target = anchor === "center" ? null : this.anchorOf(anchor);
    const host = this.host.getBoundingClientRect();
    const r = target && !target.hidden ? target.getBoundingClientRect() : null;
    if (!r || r.width <= 0 || r.height <= 0) {
      this.el.style.left = "50%";
      this.el.style.top = `${Math.round(host.height * 0.62)}px`;
      this.el.style.setProperty("--ax", "0px");
      toggleClass(this.el, "is-below", true);
      toggleClass(this.el, "no-arrow", true);
      return;
    }
    toggleClass(this.el, "no-arrow", false);
    const half = Math.min(170, host.width / 2 - 8);
    const cx = r.left - host.left + r.width / 2;
    const x = Math.max(half + 8, Math.min(host.width - half - 8, cx));
    const below = r.top - host.top < host.height * 0.3;
    const y = below ? r.bottom - host.top : r.top - host.top;
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;
    this.el.style.setProperty("--ax", `${Math.round(cx - x)}px`);
    toggleClass(this.el, "is-below", below);
  }

  private close(): void {
    window.clearTimeout(this.timer);
    this.current = null;
    this.el.hidden = true;
    window.setTimeout(() => this.next(), 400);
  }

  /** Leaving the game cuts the current tip short (it counts as seen); queued ones wait for the next match. */
  private hide(): void {
    window.clearTimeout(this.timer);
    this.current = null;
    this.el.hidden = true;
  }
}
