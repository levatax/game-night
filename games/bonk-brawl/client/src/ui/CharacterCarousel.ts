// Lobby character carousel around the 3D turntable canvas. Owner: client-ui.

import { CHARACTER_IDS, CHARACTERS, TICK_RATE } from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";
import { button, el, play, setText, svg } from "./dom";
import { ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT } from "./icons";
import type { LobbyPlayerCard } from "./models";

export interface CarouselState {
  character: CharacterId;
  /** Everyone in the lobby (to show who else picked each animal). */
  players: readonly LobbyPlayerCard[];
  youId: string;
  /** Your slot color (turntable glow). */
  color: string;
  disabled: boolean;
}

const ANIMAL_LABEL: Record<string, string> = {
  duck: "Duck",
  frog: "Frog",
  bear: "Bear",
  cat: "Cat",
  penguin: "Penguin",
  goat: "Goat",
};

export class CharacterCarousel {
  readonly el = el("div", "panel carousel");

  private readonly prevBtn = button("btn btn--icon carousel__arrow carousel__arrow--prev", svg(ICON_CHEVRON_LEFT));
  private readonly nextBtn = button("btn btn--icon carousel__arrow carousel__arrow--next", svg(ICON_CHEVRON_RIGHT));
  private readonly stage = el("div", "carousel__stage");
  private readonly nameEl = el("h2", "carousel__name");
  private readonly animalEl = el("span", "carousel__animal");
  private readonly descEl = el("p", "carousel__desc");
  private readonly takenEl = el("p", "carousel__taken");
  private readonly abilityIcon = el("span", "ability-card__icon");
  private readonly abilityName = el("span", "ability-card__name");
  private readonly abilityCd = el("span", "ability-card__cd");
  private readonly abilityDesc = el("p", "ability-card__desc");
  private readonly chips = new Map<CharacterId, HTMLButtonElement>();
  private shown: CharacterId | null = null;
  private signature = "";

  constructor(canvas: HTMLCanvasElement, private readonly onSelect: (character: CharacterId) => void) {
    canvas.className = "carousel__canvas";
    canvas.setAttribute("aria-hidden", "true");
    this.prevBtn.setAttribute("aria-label", "Previous animal");
    this.nextBtn.setAttribute("aria-label", "Next animal");
    this.prevBtn.addEventListener("click", () => this.step(-1));
    this.nextBtn.addEventListener("click", () => this.step(1));

    this.stage.append(el("div", "carousel__pedestal"), canvas, this.prevBtn, this.nextBtn);
    const title = el("p", "panel__eyebrow", "Pick your animal");
    const nameRow = el("div", "carousel__name-row", this.nameEl, this.animalEl);
    const ability = el(
      "div",
      "ability-card",
      this.abilityIcon,
      el("div", "ability-card__text", el("div", "ability-card__head", el("kbd", "", "E"), this.abilityName, this.abilityCd), this.abilityDesc),
    );
    this.el.append(title, this.stage, nameRow, this.descEl, this.takenEl, ability, this.buildChips());
    this.el.setAttribute("aria-label", "Character select");
  }

  /** Move the selection one step (wraps). Ignored while disabled. */
  step(dir: -1 | 1): void {
    if (!this.shown || this.prevBtn.disabled) return;
    const i = CHARACTER_IDS.indexOf(this.shown);
    const next = CHARACTER_IDS[(i + dir + CHARACTER_IDS.length) % CHARACTER_IDS.length];
    this.pick(next);
  }

  update(state: CarouselState): void {
    const signature = this.signatureOf(state);
    if (signature === this.signature) return;
    this.signature = signature;

    const changed = this.shown !== state.character;
    this.shown = state.character;
    this.el.style.setProperty("--slot", state.color);
    for (const b of [this.prevBtn, this.nextBtn]) b.disabled = state.disabled;
    this.renderDetails(state.character, changed);
    this.renderTaken(state);
    this.renderChips(state);
  }

  private signatureOf(s: CarouselState): string {
    const picks = s.players.map((p) => `${p.id}:${p.character}:${p.color}:${p.nickname}`).join(",");
    return `${s.character}|${s.color}|${s.disabled}|${s.youId}|${picks}`;
  }

  private pick(character: CharacterId): void {
    if (character === this.shown) return;
    this.onSelect(character);
  }

  private buildChips(): HTMLElement {
    const row = el("div", "carousel__chips");
    row.setAttribute("role", "radiogroup");
    row.setAttribute("aria-label", "Animals");
    for (const id of CHARACTER_IDS) {
      const def = CHARACTERS[id];
      const chip = button("char-chip", el("span", "char-chip__emoji", def.emoji), el("span", "char-chip__picks"));
      chip.setAttribute("role", "radio");
      chip.setAttribute("aria-label", def.name);
      chip.title = `${def.name} · ${def.ability.name}`;
      chip.addEventListener("click", () => this.pick(id));
      this.chips.set(id, chip);
      row.append(chip);
    }
    return row;
  }

  private renderDetails(character: CharacterId, changed: boolean): void {
    const def = CHARACTERS[character];
    setText(this.nameEl, def.name);
    setText(this.animalEl, ANIMAL_LABEL[def.animal] ?? def.animal);
    setText(this.descEl, def.description);
    setText(this.abilityIcon, def.ability.icon);
    setText(this.abilityName, def.ability.name);
    setText(this.abilityCd, `${Math.round(def.ability.cooldownTicks / TICK_RATE)} s cooldown`);
    setText(this.abilityDesc, def.ability.description);
    if (changed) {
      play(this.nameEl, [{ transform: "translateY(10px) scale(0.9)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 260, easing: "cubic-bezier(.3,1.6,.5,1)" });
      play(this.abilityIcon, [{ transform: "scale(0.4) rotate(-30deg)" }, { transform: "scale(1.15) rotate(8deg)", offset: 0.6 }, { transform: "none" }], { duration: 380, easing: "ease-out" });
    }
  }

  private renderTaken(state: CarouselState): void {
    const others = state.players.filter((p) => p.id !== state.youId && p.character === state.character);
    this.takenEl.replaceChildren();
    this.takenEl.hidden = others.length === 0;
    if (others.length === 0) return;
    this.takenEl.append("Also picked by ");
    others.forEach((p, i) => {
      if (i > 0) this.takenEl.append(i === others.length - 1 ? " & " : ", ");
      const tag = el("span", "name-tag", el("i", "color-dot"), p.nickname);
      tag.style.setProperty("--slot", p.color);
      this.takenEl.append(tag);
    });
    this.takenEl.append(" · colors tell you apart");
  }

  private renderChips(state: CarouselState): void {
    for (const [id, chip] of this.chips) {
      const selected = id === state.character;
      chip.setAttribute("aria-checked", String(selected));
      chip.tabIndex = selected ? 0 : -1;
      chip.disabled = state.disabled;
      chip.classList.toggle("is-selected", selected);
      const picks = chip.querySelector(".char-chip__picks");
      if (!picks) continue;
      picks.replaceChildren();
      for (const p of state.players) {
        if (p.character !== id || p.id === state.youId) continue;
        const dot = el("i", "color-dot");
        dot.style.setProperty("--slot", p.color);
        picks.append(dot);
      }
    }
  }
}
