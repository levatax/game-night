// Campfire workbench panel (§7): opened by the app when E resolves to `craft`. Recipe cards (green = craftable
// now, grey = missing something, "???" = a bottle recipe not found yet), each cost chip shows have/need from
// pockets + chest, a fuel bar for the fire, and the "fire is out" warning. Click a card (or press 1–9) to craft
// it (emits `craft`); the server answers with crafted / reject. Owner: client-ui.
// Keyboard: the cards are buttons (Tab / Enter / Space); the dialog itself takes the focus on open (a stray Space
// crafts nothing), Tab or an arrow goes on to the cards, Tab stays inside the panel, the arrows move between cards
// (Ui routes them to onKey) and a re-render keeps the focused card focused.

import type { ItemKind, RecipeId } from "../../../../shared/types";
import { clockText, itemName, recipeName, t } from "../../i18n";
import { itemIcon } from "../content";
import { keyParams } from "../controls";
import { arrowDir, button, el, fill, gridNeighbor, play, setHidden, setText, setVar, SHAKE_KEYFRAMES, svg, toggleClass, trapTab } from "../dom";
import { ICON_CLOSE, ICON_FLAME } from "../icons";
import type { CraftPanelModel, RecipeRowModel } from "../models";

/** Icon for a recipe's output (fuel and the team feast have none). */
function recipeIcon(r: RecipeRowModel): string {
  if (r.out) return itemIcon(r.out);
  return r.id === "fuel" ? "🔥" : r.id === "cook_kraken" ? "🍲" : r.id === "hut" ? "🛖" : r.id === "canoe" ? "🛶" : r.id === "bench_1" ? "🪚" : r.id === "bench_2" ? "⚒️" : "✨";
}

function rowSig(r: RecipeRowModel): string {
  return `${r.id}:${r.ok ? 1 : 0}${r.locked ? 1 : 0}:${r.gate ?? ""}${JSON.stringify(r.gateParams ?? {})}:${r.cost.map((c) => `${c.kind}${c.have}/${c.need}`).join(",")}`;
}

export class CraftPanel {
  readonly el = el("div", "rr-modal rr-craft");
  private readonly panel = el("div", "rr-panel rr-craft__panel");
  private readonly grid = el("div", "rr-craft__grid");
  private readonly fuelFill = el("span", "rr-craft__fuel-fill");
  private readonly fuelText = el("span", "rr-craft__fuel-text");
  private readonly fireWarn = el("p", "rr-craft__warn", `🧯 ${t("panels.fireOutWarn")}`);
  private readonly cards = new Map<RecipeId, HTMLButtonElement>();
  private order: RecipeId[] = [];
  private readonly keysNote = el("span", "rr-modal__keys");
  /** Camp bench tier badge (Campfire / Workbench / Anvil). */
  private readonly bench = el("span", "rr-craft__bench");
  private sig = "";
  private model: CraftPanelModel | null = null;

  constructor(
    private readonly onCraft: (recipe: RecipeId) => void,
    private readonly onError: () => void,
    onClose: () => void,
  ) {
    // The dialog itself holds the focus on open (Tab / the arrows go on to the cards from there).
    this.panel.tabIndex = -1;
    this.el.hidden = true;
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", t("panels.craftTitle"));
    const close = button("rr-btn rr-btn--icon rr-modal__close", svg(ICON_CLOSE));
    close.setAttribute("aria-label", t("overlays.close"));
    close.addEventListener("click", () => onClose());
    const fuel = el("div", "rr-craft__fuel", el("span", "rr-craft__fuel-icon", svg(ICON_FLAME)), el("span", "rr-craft__fuel-track", this.fuelFill), this.fuelText);
    const head = el("header", "rr-modal__head", el("h2", "rr-modal__title", `🔥 ${t("panels.craftTitle")}`), this.bench, fuel, close);
    const foot = el("footer", "rr-modal__foot", el("span", "", t("panels.craftHint")), this.keysNote);
    this.fireWarn.hidden = true;
    this.panel.append(head, this.fireWarn, this.grid, foot);
    this.el.append(this.panel);
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) onClose();
    });
  }

  get recipes(): readonly RecipeRowModel[] {
    return this.model?.recipes ?? [];
  }

  update(m: CraftPanelModel): void {
    this.model = m;
    setVar(this.fuelFill, "--v", `${Math.round(Math.max(0, Math.min(1, m.fuelFrac)) * 100)}%`);
    setText(this.fuelText, m.fireLit ? clockText(m.fuelSec) : t("hud.fireOut"));
    toggleClass(this.panel, "is-fire-out", !m.fireLit);
    setHidden(this.fireWarn, m.fireLit);
    setText(this.bench, `🛠️ ${t(`hud.bench_${Math.max(0, Math.min(2, m.benchTier ?? 0))}`)}`);
    const sig = m.recipes.map(rowSig).join("|");
    if (sig === this.sig) return;
    this.sig = sig;
    // Re-appending a focused card blurs it: put the focus back where it was.
    const focused = document.activeElement instanceof HTMLButtonElement && this.grid.contains(document.activeElement) ? document.activeElement : null;
    this.render(m.recipes);
    if (focused?.isConnected) focused.focus({ preventScroll: true });
    else if (focused) this.firstCard()?.focus({ preventScroll: true });
  }

  /** Tab kept inside the panel, arrow keys between the cards (Ui calls it while open). True when it was used. */
  onKey(e: KeyboardEvent): boolean {
    if (trapTab(this.panel, e)) return true;
    const dir = arrowDir(e.code);
    if (!dir) return false;
    if (document.activeElement === this.panel) {
      this.firstCard()?.focus(); // from the dialog into the grid
      return true;
    }
    const cards = this.order.map((id) => this.cards.get(id)).filter((c): c is HTMLButtonElement => !!c);
    const from = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (from < 0) return false;
    cards[gridNeighbor(cards, from, dir)]?.focus();
    return true;
  }

  /** Craft the n-th visible recipe (1-based hotkeys). */
  craftIndex(n: number): void {
    const id = this.order[n - 1];
    if (id) this.tryCraft(id);
  }

  onOpen(): void {
    const keys = keyParams();
    setText(this.keysNote, `${t("panels.keysHint")} · ${t("panels.closeHint", keys)}`);
    // Descriptions name keys (raft part: E, torch: Q): rebuild the cards for the current preset.
    this.sig = "";
    if (this.model) this.update(this.model);
    play(this.panel, [{ transform: "translateY(24px) scale(0.94)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 240, easing: "cubic-bezier(.3,1.4,.5,1)" });
    // Not on the first card: a Space out of jump habit (or a second Enter) must not craft it.
    this.panel.focus({ preventScroll: true });
  }

  private firstCard(): HTMLButtonElement | null {
    const id = this.order[0];
    return id ? (this.cards.get(id) ?? null) : null;
  }

  private render(rows: readonly RecipeRowModel[]): void {
    const keep = new Set(rows.map((r) => r.id));
    for (const [id, card] of this.cards) {
      if (!keep.has(id)) {
        card.remove();
        this.cards.delete(id);
      }
    }
    this.order = rows.map((r) => r.id);
    rows.forEach((r, i) => {
      const card = this.card(r, i);
      this.grid.append(card);
    });
  }

  private card(r: RecipeRowModel, index: number): HTMLButtonElement {
    let card = this.cards.get(r.id);
    if (!card) {
      card = button("rr-recipe");
      const id = r.id;
      card.addEventListener("click", () => this.tryCraft(id));
      this.cards.set(r.id, card);
    }
    const state = r.locked ? "locked" : r.ok ? "ok" : "no";
    card.className = `rr-recipe is-${state}`;
    card.setAttribute("aria-disabled", String(!r.ok));
    const cost = el("span", "rr-recipe__cost");
    for (const c of r.cost) cost.append(this.costChip(c.kind, c.have, c.need));
    // A bench / day gate says why ("Needs the Workbench", "Not before day 3", "Already built") instead of the blurb.
    const desc = r.locked ? t("panels.lockedHint") : r.gate ? `🔒 ${t(`reject.${r.gate}`, r.gateParams)}` : t(`panels.craftDesc_${r.id}`, keyParams());
    fill(
      card,
      index < 9 ? el("span", "rr-recipe__key", String(index + 1)) : null,
      el("span", "rr-recipe__icon", r.locked ? "❔" : recipeIcon(r)),
      el("span", "rr-recipe__body", el("span", "rr-recipe__name", r.locked ? t("panels.lockedName") : recipeName(r.id)), el("span", "rr-recipe__desc", desc), r.locked ? null : cost),
      el("span", "rr-recipe__go", r.id === "fuel" ? t("panels.feedBtn") : t("panels.craftBtn")),
    );
    card.title = r.locked ? t("panels.lockedHint") : recipeName(r.id);
    return card;
  }

  private costChip(kind: ItemKind, have: number, need: number): HTMLElement {
    const enough = have >= need;
    const chip = el("span", enough ? "rr-cost is-ok" : "rr-cost is-short", el("span", "rr-cost__icon", itemIcon(kind)), el("b", "", `${Math.min(have, 99)}/${need}`));
    chip.title = itemName(kind);
    return chip;
  }

  private tryCraft(id: RecipeId): void {
    const row = this.model?.recipes.find((r) => r.id === id);
    const card = this.cards.get(id);
    if (!row || !row.ok || row.locked) {
      if (card) play(card, SHAKE_KEYFRAMES, { duration: 320 });
      this.onError();
      return;
    }
    if (card) play(card, [{ transform: "scale(1)" }, { transform: "scale(0.94)" }, { transform: "scale(1.04)" }, { transform: "scale(1)" }], { duration: 260 });
    this.onCraft(id);
  }
}
