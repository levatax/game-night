// Lobby match settings (host edits, everyone else sees them read-only). Owner: client-ui.

import { ROUND_OPTIONS } from "../../../shared/constants";
import type { SettingsMsg } from "../../../shared/protocol";
import type { MapChoice, SettingsView } from "../../../shared/types";
import { button, el, setText, svg } from "./dom";
import { ICON_LOCK } from "./icons";
import { MAP_CHOICES } from "./models";
import { Optimistic } from "./optimistic";

const MAP_BLURB: Record<MapChoice, string> = {
  random: "New island every round",
  picnic: "Grassy, sunny, classic",
  bath: "Slippery tiles!",
  cake: "Sweet & crumbly",
};

export class LobbySettings {
  readonly el = el("div", "panel match-settings");

  private readonly lockNote = el("p", "match-settings__lock");
  private readonly mapButtons = new Map<MapChoice, HTMLButtonElement>();
  private readonly roundButtons = new Map<number, HTMLButtonElement>();
  private readonly powerSwitch = button("switch");
  private readonly powerLabel = el("span", "switch__state");
  private readonly map = new Optimistic<MapChoice>();
  private readonly rounds = new Optimistic<number>();
  private readonly powerUps = new Optimistic<boolean>();
  private isHost = false;
  private last: SettingsView | null = null;
  private lockText: string | null = null;

  constructor(private readonly onChange: (patch: SettingsMsg) => void) {
    const head = el("div", "panel__head", el("p", "panel__eyebrow", "Match settings"), this.lockNote);
    this.el.append(head, this.buildMaps(), this.buildRounds(), this.buildPowerUps());
  }

  update(settings: SettingsView, isHost: boolean, hostName: string): void {
    this.isHost = isHost;
    this.last = settings;
    this.el.classList.toggle("is-readonly", !isHost);
    const lockText = isHost ? "" : `Only the host${hostName ? ` (${hostName})` : ""} can change these`;
    if (lockText !== this.lockText) {
      this.lockText = lockText;
      this.lockNote.replaceChildren(svg(ICON_LOCK), lockText);
    }
    this.lockNote.hidden = isHost;
    this.render();
  }

  private render(): void {
    if (!this.last) return;
    const map = this.map.resolve(this.last.map);
    const rounds = this.rounds.resolve(this.last.rounds);
    const powerUps = this.powerUps.resolve(this.last.powerUps);
    for (const [value, b] of this.mapButtons) this.setChoice(b, value === map);
    for (const [value, b] of this.roundButtons) this.setChoice(b, value === rounds);
    this.powerSwitch.setAttribute("aria-checked", String(powerUps));
    this.powerSwitch.setAttribute("aria-disabled", String(!this.isHost));
    setText(this.powerLabel, powerUps ? "On" : "Off");
  }

  private setChoice(b: HTMLButtonElement, selected: boolean): void {
    b.setAttribute("aria-pressed", String(selected));
    b.setAttribute("aria-disabled", String(!this.isHost));
    b.classList.toggle("is-selected", selected);
  }

  private buildMaps(): HTMLElement {
    const grid = el("div", "map-grid");
    for (const choice of MAP_CHOICES) {
      const b = button(
        `map-tile map-tile--${choice.value}`,
        el("span", "map-tile__swatch"),
        el("span", "map-tile__name", choice.label),
        el("span", "map-tile__blurb", MAP_BLURB[choice.value]),
      );
      b.addEventListener("click", () => this.edit(() => this.map.set(choice.value), { map: choice.value }));
      this.mapButtons.set(choice.value, b);
      grid.append(b);
    }
    return this.group("Arena", grid);
  }

  private buildRounds(): HTMLElement {
    const seg = el("div", "segmented");
    for (const n of ROUND_OPTIONS) {
      const b = button("segmented__btn", String(n));
      b.setAttribute("aria-label", `${n} rounds`);
      b.addEventListener("click", () => this.edit(() => this.rounds.set(n), { rounds: n }));
      this.roundButtons.set(n, b);
      seg.append(b);
    }
    return this.group("Rounds", seg);
  }

  private buildPowerUps(): HTMLElement {
    const sw = this.powerSwitch;
    sw.setAttribute("role", "switch");
    sw.dataset.sound = "toggle";
    sw.setAttribute("aria-label", "Power-ups");
    sw.append(el("span", "switch__knob"), this.powerLabel);
    sw.addEventListener("click", () => {
      const next = sw.getAttribute("aria-checked") !== "true";
      this.edit(() => this.powerUps.set(next), { powerUps: next });
    });
    const row = el("div", "match-settings__row", el("span", "match-settings__hint", "🍌 👟 🔴 🎱"), sw);
    return this.group("Power-ups", row);
  }

  private group(label: string, control: HTMLElement): HTMLElement {
    return el("div", "match-settings__group", el("span", "match-settings__label", label), control);
  }

  private edit(apply: () => void, patch: SettingsMsg): void {
    if (!this.isHost) return;
    apply();
    this.render();
    this.onChange(patch);
  }
}
