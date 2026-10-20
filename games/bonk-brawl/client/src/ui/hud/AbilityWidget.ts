// HUD bottom left: ability icon with a radial cooldown, plus small catch / roll cooldown pips.
// Owner: client-ui.

import { CHARACTER_IDS, CHARACTERS, TICK_RATE } from "../../../../shared/constants";
import { el, play, setHidden, setText, setVar } from "../dom";
import type { AbilityHud, HudModel } from "../models";

/** Ability name → cooldown seconds, to print the remaining seconds over the radial. */
const COOLDOWN_SEC_BY_NAME = new Map(
  CHARACTER_IDS.map((id) => [CHARACTERS[id].ability.name, CHARACTERS[id].ability.cooldownTicks / TICK_RATE] as const),
);

/** Radial fills are quantized so a 60 fps cooldown doesn't restyle more often than it can show. */
function quantize(frac: number): string {
  return (Math.round(Math.max(0, Math.min(1, frac)) * 200) / 200).toFixed(3);
}

class CooldownPip {
  readonly el: HTMLElement;
  private ready = true;

  constructor(icon: string, key: string, label: string) {
    this.el = el("div", "pip", el("span", "pip__icon", icon), el("kbd", "pip__key", key));
    this.el.setAttribute("aria-label", label);
  }

  update(frac: number): void {
    setVar(this.el, "--cd", quantize(frac));
    const ready = frac <= 0;
    if (ready === this.ready) return;
    this.ready = ready;
    this.el.classList.toggle("is-ready", ready);
    if (ready) play(this.el, [{ transform: "scale(1.3)" }, { transform: "scale(1)" }], { duration: 260, easing: "ease-out" });
  }
}

export class AbilityWidget {
  readonly el = el("div", "ability-hud");

  private readonly ring = el("div", "ability-hud__ring");
  private readonly icon = el("span", "ability-hud__icon");
  private readonly secs = el("span", "ability-hud__secs");
  private readonly name = el("span", "ability-hud__name");
  private readonly catchPip = new CooldownPip("🧤", "RMB", "Catch cooldown");
  private readonly rollPip = new CooldownPip("💨", "⇧", "Roll cooldown");
  private ready: boolean | null = null;
  private secsValue = -1;

  constructor() {
    this.ring.append(el("span", "ability-hud__cd"), this.icon, this.secs, el("kbd", "ability-hud__key", "E"));
    const pips = el("div", "ability-hud__pips", this.catchPip.el, this.rollPip.el);
    this.el.append(el("div", "ability-hud__main", this.ring, this.name), pips);
  }

  update(m: HudModel): void {
    this.renderAbility(m.ability);
    this.catchPip.update(m.catchCooldownFrac);
    this.rollPip.update(m.rollCooldownFrac);
  }

  private renderAbility(a: AbilityHud): void {
    setText(this.icon, a.icon);
    setText(this.name, a.name);
    setVar(this.ring, "--cd", quantize(a.ready ? 0 : a.cooldownFrac));
    this.ring.classList.toggle("is-armed", a.armed);
    this.ring.classList.toggle("is-active", a.active);

    const total = COOLDOWN_SEC_BY_NAME.get(a.name) ?? 0;
    const remaining = a.ready || a.active ? 0 : Math.ceil(a.cooldownFrac * total - 1e-3);
    if (remaining !== this.secsValue) {
      this.secsValue = remaining;
      setText(this.secs, remaining > 0 ? String(remaining) : "");
      setHidden(this.secs, remaining <= 0);
    }

    if (a.ready === this.ready) return;
    const becameReady = this.ready === false && a.ready;
    this.ready = a.ready;
    this.ring.classList.toggle("is-ready", a.ready);
    this.ring.setAttribute("aria-label", `${a.name}: ${a.ready ? "ready" : "cooling down"}`);
    if (becameReady) {
      play(this.ring, [{ transform: "scale(1)" }, { transform: "scale(1.28) rotate(-8deg)", offset: 0.4 }, { transform: "scale(1)" }], {
        duration: 420,
        easing: "ease-out",
      });
    }
  }
}
