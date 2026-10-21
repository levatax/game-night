// Host trip settings (§4): mode (Co-op; Island Wars shown disabled "soon"), difficulty (Vacation / Normal /
// Nightmare with a one-line blurb), and the island seed: Random (a new island every match) or a fixed seed (type
// one, roll the dice, or lock the island being previewed), with the preview's seed + biome always shown.
// Everyone else sees the same panel read-only. Adapted from games/bonk-brawl/client/src/ui/LobbySettings.ts.
// Owner: client-ui.

import { DIFFICULTY_IDS, SEED_MAX } from "../../../../../shared/constants";
import type { SettingsMsg } from "../../../../../shared/protocol";
import type { Biome, Difficulty, GameMode } from "../../../../../shared/types";
import { biomeName, difficultyName, t } from "../../../i18n";
import { BIOME_ICON, DIFFICULTY_ICON } from "../../content";
import { button, el, play, setHidden, setText, SHAKE_KEYFRAMES, svg } from "../../dom";
import { ICON_DICE, ICON_LOCK } from "../../icons";
import type { LobbyModel } from "../../models";
import { Optimistic } from "./optimistic";

type SeedMode = "random" | "fixed";

/** A uniformly random seed 1..SEED_MAX (0 means "random each match", so it's never rolled). */
function rollSeed(): number {
  const buf = new Uint32Array(1);
  try {
    crypto.getRandomValues(buf);
  } catch {
    buf[0] = Math.floor(Math.random() * SEED_MAX);
  }
  return Math.max(1, buf[0]! >>> 0);
}

/** Parse a typed seed: whole number 1..SEED_MAX, or null. */
export function parseSeed(raw: string): number | null {
  const s = raw.trim().replace(/[\s_.,]/g, "");
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 1 && n <= SEED_MAX ? n : null;
}

export class TripSettings {
  readonly el = el("section", "rr-panel rr-trip");
  private readonly lockNote = el("p", "rr-trip__lock");
  private readonly modeButtons = new Map<GameMode, HTMLButtonElement>();
  private readonly diffButtons = new Map<Difficulty, HTMLButtonElement>();
  private readonly diffHint = el("p", "rr-trip__hint");
  private readonly seedButtons = new Map<SeedMode, HTMLButtonElement>();
  private readonly seedRow = el("div", "rr-trip__seed-row");
  private readonly seedInput = el("input", "rr-field__input rr-trip__seed-input");
  private readonly seedApply = button("rr-btn rr-btn--small", t("menu.seedApply"));
  private readonly seedDice = button("rr-btn rr-btn--icon rr-btn--small rr-trip__dice", svg(ICON_DICE));
  private readonly seedNote = el("p", "rr-trip__hint");
  private readonly seedError = el("p", "rr-trip__error", t("menu.seedInvalid"));
  private readonly preview = el("div", "rr-trip__preview");
  private readonly previewSeed = el("span", "rr-trip__preview-seed");
  private readonly previewBiome = el("span", "rr-trip__biome");
  private readonly previewDesc = el("p", "rr-trip__biome-desc");
  private readonly mode = new Optimistic<GameMode>();
  private readonly difficulty = new Optimistic<Difficulty>();
  private readonly seedMode = new Optimistic<SeedMode>();
  private isHost = false;
  private model: LobbyModel | null = null;
  private lockText = "";
  private shownSeedSetting = -1;
  private biome: Biome | null = null;

  constructor(private readonly onChange: (patch: SettingsMsg) => void) {
    const head = el("div", "rr-panel__head", el("p", "rr-panel__eyebrow", `🗺️ ${t("menu.tripTitle")}`));
    this.el.append(head, this.lockNote, this.buildMode(), this.buildDifficulty(), this.buildSeed());
    this.seedError.hidden = true;
  }

  update(model: LobbyModel, hostName: string): void {
    this.model = model;
    this.isHost = model.isHost;
    this.el.classList.toggle("is-readonly", !model.isHost);
    const lockText = model.isHost ? "" : t("menu.hostOnly", { name: hostName || "?" });
    if (lockText !== this.lockText) {
      this.lockText = lockText;
      this.lockNote.replaceChildren(svg(ICON_LOCK), lockText);
    }
    setHidden(this.lockNote, model.isHost);
    this.render();
  }

  private render(): void {
    const m = this.model;
    if (!m) return;
    const mode = this.mode.resolve(m.mode);
    for (const [value, b] of this.modeButtons) this.setChoice(b, value === mode, value === "duel");
    const diff = this.difficulty.resolve(m.difficulty);
    for (const [value, b] of this.diffButtons) this.setChoice(b, value === diff, false);
    setText(this.diffHint, t(`menu.diffHint_${diff}`));

    const seedMode = this.seedMode.resolve(m.seedSetting === 0 ? "random" : "fixed");
    for (const [value, b] of this.seedButtons) this.setChoice(b, value === seedMode, false);
    const fixed = seedMode === "fixed";
    setHidden(this.seedRow, !fixed || !this.isHost);
    setText(this.seedNote, t(fixed ? "menu.seedFixedNote" : "menu.seedRandomNote"));
    if (fixed && m.seedSetting !== this.shownSeedSetting && document.activeElement !== this.seedInput) {
      this.shownSeedSetting = m.seedSetting;
      this.seedInput.value = m.seedSetting > 0 ? String(m.seedSetting) : String(m.previewSeed);
    }
    this.seedInput.disabled = !this.isHost;
    setText(this.previewSeed, t("menu.seedPreview", { seed: m.previewSeed }));
    if (m.biome !== this.biome) {
      this.biome = m.biome;
      setText(this.previewBiome, `${BIOME_ICON[m.biome]} ${biomeName(m.biome)}`);
      setText(this.previewDesc, t(`items.biome_${m.biome}_desc`));
      this.preview.dataset.biome = m.biome;
      play(this.preview, [{ transform: "scale(0.96)" }, { transform: "scale(1.02)" }, { transform: "scale(1)" }], { duration: 260 });
    }
  }

  private setChoice(b: HTMLButtonElement, selected: boolean, locked: boolean): void {
    b.setAttribute("aria-checked", String(selected));
    b.setAttribute("aria-disabled", String(!this.isHost || locked));
    b.classList.toggle("is-selected", selected);
  }

  private group(label: string, ...controls: HTMLElement[]): HTMLElement {
    return el("div", "rr-trip__group", el("span", "rr-trip__label", label), ...controls);
  }

  private buildMode(): HTMLElement {
    const seg = el("div", "rr-segmented rr-segmented--wide");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", t("menu.mode"));
    const coop = button("rr-segmented__btn", `🤝 ${t("menu.modeCoop")}`);
    coop.setAttribute("role", "radio");
    coop.title = t("menu.modeCoopHint");
    coop.addEventListener("click", () => this.edit(() => this.mode.set("coop"), { mode: "coop" }));
    const duel = button("rr-segmented__btn rr-segmented__btn--soon", `⚔️ ${t("menu.modeDuel")}`, el("span", "rr-soon", t("menu.soon")));
    duel.setAttribute("role", "radio");
    duel.title = t("menu.modeDuelHint");
    duel.addEventListener("click", () => {
      play(duel, SHAKE_KEYFRAMES, { duration: 300 });
    });
    this.modeButtons.set("coop", coop);
    this.modeButtons.set("duel", duel);
    seg.append(coop, duel);
    return this.group(t("menu.mode"), seg);
  }

  private buildDifficulty(): HTMLElement {
    const seg = el("div", "rr-segmented rr-segmented--wide");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", t("menu.difficulty"));
    for (const d of DIFFICULTY_IDS) {
      const b = button("rr-segmented__btn", `${DIFFICULTY_ICON[d]} ${difficultyName(d)}`);
      b.setAttribute("role", "radio");
      b.addEventListener("click", () => this.edit(() => this.difficulty.set(d), { difficulty: d }));
      this.diffButtons.set(d, b);
      seg.append(b);
    }
    return this.group(t("menu.difficulty"), seg, this.diffHint);
  }

  private buildSeed(): HTMLElement {
    const seg = el("div", "rr-segmented rr-segmented--wide");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", t("menu.seed"));
    const random = button("rr-segmented__btn", `🎲 ${t("menu.seedRandom")}`);
    random.setAttribute("role", "radio");
    random.addEventListener("click", () => this.edit(() => this.seedMode.set("random"), { seed: 0 }));
    const fixed = button("rr-segmented__btn", `📌 ${t("menu.seedFixed")}`);
    fixed.setAttribute("role", "radio");
    // Switching to "fixed" locks the island currently previewed (the most useful default).
    fixed.addEventListener("click", () => {
      const m = this.model;
      if (!m || m.seedSetting !== 0) return;
      this.edit(() => this.seedMode.set("fixed"), { seed: m.previewSeed > 0 ? m.previewSeed : rollSeed() });
    });
    this.seedButtons.set("random", random);
    this.seedButtons.set("fixed", fixed);
    seg.append(random, fixed);

    const input = this.seedInput;
    input.type = "text";
    input.inputMode = "numeric";
    input.maxLength = 10;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = t("menu.seedPlaceholder");
    input.setAttribute("aria-label", t("menu.seed"));
    input.addEventListener("input", () => {
      input.value = input.value.replace(/[^\d]/g, "").slice(0, 10);
      this.seedError.hidden = true;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.applySeed();
      }
    });
    this.seedApply.addEventListener("click", () => this.applySeed());
    this.seedDice.title = t("menu.seedRoll");
    this.seedDice.setAttribute("aria-label", t("menu.seedRoll"));
    this.seedDice.addEventListener("click", () => {
      const seed = rollSeed();
      input.value = String(seed);
      play(this.seedDice, [{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], { duration: 420, easing: "ease-out" });
      this.edit(() => this.seedMode.set("fixed"), { seed });
    });
    this.seedRow.append(input, this.seedDice, this.seedApply);
    this.preview.append(el("div", "rr-trip__preview-line", this.previewSeed, this.previewBiome), this.previewDesc);
    return this.group(t("menu.seed"), seg, this.seedRow, this.seedError, this.seedNote, this.preview);
  }

  private applySeed(): void {
    if (!this.isHost) return;
    const seed = parseSeed(this.seedInput.value);
    if (seed === null) {
      this.seedError.hidden = false;
      play(this.seedInput, SHAKE_KEYFRAMES, { duration: 320 });
      return;
    }
    this.seedError.hidden = true;
    this.seedInput.blur();
    this.edit(() => this.seedMode.set("fixed"), { seed });
  }

  private edit(apply: () => void, patch: SettingsMsg): void {
    if (!this.isHost) return;
    apply();
    this.render();
    this.onChange(patch);
  }
}
