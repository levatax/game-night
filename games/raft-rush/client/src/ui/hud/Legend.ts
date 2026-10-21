// Hold-H island guide (§15, §17): campfire recipes with their costs, the fishing luck table (base odds, rarity
// colors), the raft stages, the controls and the last feed lines. Passive: it never captures input (holding H
// must not release the pointer lock), so Ui opens it with openPanel("legend") and closes it on H release.
// Printed keys follow the key preset / layout (ui/controls.ts): refreshed each time it opens. The header's
// "Release H to close" names the key itself (no <kbd> next to it, the same as the scoreboard). Owner: client-ui.

import { FISH_LOOT, RECIPES, RECIPE_IDS } from "../../../../shared/items";
import type { ItemKind, RecipeId } from "../../../../shared/types";
import { itemName, lootName, recipeName, t } from "../../i18n";
import { itemIcon, lootIcon, LOOT_RARITY, RARITY_COLORS } from "../content";
import { buildControlsList, keyParams, keysSignature, refreshControlsList } from "../controls";
import { el, setHidden, setText } from "../dom";
import type { FeedHistoryEntry } from "./Feed";

/** Recipes shown in coop (duel-only ones hidden). */
const COOP_RECIPES: ReadonlyArray<RecipeId> = RECIPE_IDS.filter((id) => !RECIPES[id].duelOnly);

export class Legend {
  readonly el = el("div", "rr-legend");
  private readonly recipeRows = new Map<RecipeId, HTMLElement>();
  private readonly histList = el("ul", "rr-legend__hist");
  private readonly histBox = el("section", "rr-legend__col rr-legend__col--hist");
  private readonly controls = buildControlsList("rr-controls rr-controls--compact");
  /** "Release H to close" in the active key preset. */
  private readonly hint = el("span", "rr-legend__hint");
  private readonly keyNotes: Array<{ node: HTMLElement; key: string }> = [];
  private keysSig = "";
  private unlocked = new Set<RecipeId>();
  private histVersion = -1;

  constructor() {
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", t("overlays.legendTitle"));
    this.el.hidden = true;
    const head = el("header", "rr-legend__head", el("h2", "rr-legend__title", `🗺️ ${t("overlays.legendTitle")}`), this.hint);
    // The history column's heading is an emoji: give it (and the list) a real name.
    const histTitle = el("h3", "rr-legend__sec", el("span", "", "📜"));
    histTitle.id = "rr-legend-hist";
    histTitle.setAttribute("aria-label", t("overlays.legHistory"));
    histTitle.title = t("overlays.legHistory");
    histTitle.firstElementChild?.setAttribute("aria-hidden", "true");
    this.histList.setAttribute("aria-labelledby", histTitle.id);
    this.histBox.setAttribute("aria-labelledby", histTitle.id);
    this.histBox.append(histTitle, this.histList);
    const body = el("div", "rr-legend__body", this.buildRecipes(), el("div", "rr-legend__stack", this.buildLoot(), this.buildRaft()), el("div", "rr-legend__stack", this.buildControls(), this.histBox));
    this.el.append(head, body);
    this.renderKeys();
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  setOpen(open: boolean, history: readonly FeedHistoryEntry[], version: number): void {
    if (open) this.renderKeys();
    setHidden(this.el, !open);
    if (!open || version === this.histVersion) return;
    this.histVersion = version;
    this.histList.replaceChildren(
      ...[...history].reverse().map((h) => el("li", `rr-legend__line rr-tone--${h.tone}`, h.icon ? el("span", "", h.icon) : null, el("span", "", h.text))),
    );
    setHidden(this.histBox, history.length === 0);
  }

  /** Every printed key for the current preset / layout (cheap no-op when nothing changed). */
  private renderKeys(): void {
    const sig = keysSignature();
    if (sig === this.keysSig) return;
    this.keysSig = sig;
    const keys = keyParams();
    setText(this.hint, t("overlays.legendHint", keys));
    for (const n of this.keyNotes) setText(n.node, t(n.key, keys));
    refreshControlsList(this.controls);
  }

  /** A note whose text names keys (re-rendered with the preset). */
  private keyNote(key: string): HTMLElement {
    const node = el("p", "rr-legend__note");
    this.keyNotes.push({ node, key });
    return node;
  }

  /** Recipes the craft panel reported unlocked (the bottle recipe) show their real name. */
  setUnlocked(ids: Iterable<RecipeId>): void {
    const next = new Set(ids);
    if ([...next].every((id) => this.unlocked.has(id)) && next.size === this.unlocked.size) return;
    this.unlocked = next;
    for (const id of COOP_RECIPES) if (RECIPES[id].locked) this.recipeRow(id);
  }

  private buildRecipes(): HTMLElement {
    const list = el("ul", "rr-legend__recipes");
    for (const id of COOP_RECIPES) list.append(this.recipeRow(id));
    return el("section", "rr-legend__col", el("h3", "rr-legend__sec", t("overlays.legRecipes")), this.keyNote("overlays.legRecipesNote"), list);
  }

  /** Build (or rebuild in place) one recipe row. */
  private recipeRow(id: RecipeId): HTMLElement {
    const def = RECIPES[id];
    const hidden = def.locked && !this.unlocked.has(id);
    const out = def.out ? itemIcon(def.out) : id === "fuel" ? "🔥" : "🍽️";
    const cost = el("span", "rr-legend__cost");
    for (const [kind, n] of Object.entries(def.cost) as [ItemKind, number][]) {
      const chip = el("span", "rr-legend__chip", `${itemIcon(kind)}×${n}`);
      chip.title = itemName(kind);
      cost.append(chip);
    }
    const row = el(
      "li",
      hidden ? "rr-legend__recipe is-locked" : "rr-legend__recipe",
      el("span", "rr-legend__out", hidden ? "❔" : out),
      el("span", "rr-legend__name", hidden ? t("overlays.legLocked") : recipeName(id)),
      hidden ? null : cost,
    );
    this.recipeRows.get(id)?.replaceWith(row);
    this.recipeRows.set(id, row);
    return row;
  }

  private buildLoot(): HTMLElement {
    const total = FISH_LOOT.reduce((a, e) => a + e.weight, 0);
    const list = el("ul", "rr-legend__loot");
    for (const e of FISH_LOOT) {
      const pct = Math.max(1, Math.round((e.weight / total) * 100));
      const rarity = LOOT_RARITY[e.id];
      const li = el(
        "li",
        `rr-legend__lootrow rr-rarity--${rarity}`,
        el("span", "rr-legend__out", lootIcon(e.id)),
        el("span", "rr-legend__name", lootName(e.id)),
        el("span", "rr-legend__pct", `${pct}%`),
      );
      li.style.setProperty("--rc", RARITY_COLORS[rarity]);
      li.title = t(`items.loot_${e.id}_desc`);
      list.append(li);
    }
    return el("section", "rr-legend__col", el("h3", "rr-legend__sec", t("overlays.legLoot")), list, el("p", "rr-legend__note", t("overlays.legLootNote")));
  }

  private buildRaft(): HTMLElement {
    return el("section", "rr-legend__col", el("h3", "rr-legend__sec", t("overlays.legRaft")), this.keyNote("overlays.legRaftNote"));
  }

  private buildControls(): HTMLElement {
    return el("section", "rr-legend__col", el("h3", "rr-legend__sec", t("overlays.legControls")), this.controls);
  }
}
