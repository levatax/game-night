// "Pick your tourist": six cards (cartoon portrait on the outfit color, name, colored dots for whoever else picked
// it), the chosen one's catchphrase and perk underneath. ← / → browse. Duplicates are fine (seat colors tell
// players apart). Owner: client-ui.

import { CHARACTER_IDS } from "../../../../../shared/constants";
import type { CharacterId } from "../../../../../shared/types";
import { characterName, t } from "../../../i18n";
import { characterAccent, characterColor } from "../../content";
import { button, el, play, setText, svg } from "../../dom";
import { portraitSvg } from "../../icons";
import type { LobbyPlayerModel } from "../../models";

export class TouristPicker {
  readonly el = el("section", "rr-panel rr-picker");
  private readonly cards = new Map<CharacterId, HTMLButtonElement>();
  private readonly dots = new Map<CharacterId, HTMLElement>();
  private readonly detailName = el("span", "rr-picker__name");
  private readonly detailTag = el("span", "rr-picker__tagline");
  private readonly detailPerk = el("span", "rr-picker__perk");
  private selected: CharacterId | null = null;
  private dotsSig = "";

  constructor(private readonly onPick: (c: CharacterId) => void) {
    const grid = el("div", "rr-picker__grid");
    grid.setAttribute("role", "radiogroup");
    grid.setAttribute("aria-label", t("menu.pickTitle"));
    for (const id of CHARACTER_IDS) {
      const dots = el("span", "rr-picker__dots");
      const card = button("rr-tourist", el("span", "rr-tourist__face", svg(portraitSvg(id))), el("span", "rr-tourist__name", characterName(id)), dots);
      card.setAttribute("role", "radio");
      card.style.setProperty("--outfit", characterColor(id));
      card.style.setProperty("--accent", characterAccent(id));
      card.title = `${characterName(id)} · ${t(`characters.${id}_perk`)}`;
      card.addEventListener("click", () => this.onPick(id));
      this.cards.set(id, card);
      this.dots.set(id, dots);
      grid.append(card);
    }
    const head = el("div", "rr-panel__head", el("p", "rr-panel__eyebrow", `🧳 ${t("menu.pickTitle")}`), el("span", "rr-picker__hint", t("menu.pickHint")));
    const detail = el("div", "rr-picker__detail", el("div", "rr-picker__line", this.detailName, this.detailTag), el("div", "rr-picker__perk-row", el("b", "", `${t("menu.perk")}:`), this.detailPerk));
    this.el.append(head, grid, detail);
  }

  update(selected: CharacterId, players: readonly LobbyPlayerModel[]): void {
    if (selected !== this.selected) {
      const first = this.selected === null;
      this.selected = selected;
      for (const [id, card] of this.cards) {
        const on = id === selected;
        card.classList.toggle("is-selected", on);
        card.setAttribute("aria-checked", String(on));
      }
      setText(this.detailName, characterName(selected));
      setText(this.detailTag, t(`characters.${selected}_tagline`));
      setText(this.detailPerk, t(`characters.${selected}_perk`));
      const card = this.cards.get(selected);
      if (card && !first) play(card, [{ transform: "translateY(0) scale(1)" }, { transform: "translateY(-8px) scale(1.06)" }, { transform: "translateY(-4px) scale(1.03)" }], { duration: 260, easing: "ease-out" });
    }
    const others = players.filter((p) => !p.you);
    const sig = others.map((p) => `${p.character}:${p.color}:${p.nickname}`).join("|");
    if (sig === this.dotsSig) return;
    this.dotsSig = sig;
    for (const id of CHARACTER_IDS) {
      const pickers = others.filter((p) => p.character === id);
      const dots = this.dots.get(id);
      if (!dots) continue;
      dots.replaceChildren(
        ...pickers.map((p) => {
          const d = el("i", "rr-color-dot");
          d.style.setProperty("--slot", p.color);
          return d;
        }),
      );
      dots.title = pickers.length ? t("menu.pickedBy", { names: pickers.map((p) => p.nickname).join(", ") }) : "";
    }
  }

  /** ← / → from the keyboard. */
  step(dir: -1 | 1): void {
    const i = this.selected ? CHARACTER_IDS.indexOf(this.selected) : 0;
    const next = CHARACTER_IDS[(i + dir + CHARACTER_IDS.length) % CHARACTER_IDS.length];
    if (next) this.onPick(next);
  }
}
