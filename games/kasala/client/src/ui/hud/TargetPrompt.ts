// Top center while an attack card waits for a target: one compact line under the plate, so the table and the
// 3D target markers stay free to click. Mine: "🎯 HEDEF SEÇ · 💸 Haraç · Rakibe tıkla (←/→) · 5" plus the
// card's one-line rule. Others: "🎯 Kedi hedef seçiyor · 💸 Haraç · 5". With exactly one possible target it
// says so (the server resolves those by itself after a moment).

import { CARD_BY_ID, RARITIES, type CardId } from "../../../../shared/constants";
import { Countdown, type HudCtx } from "./ctx";
import { h, replay, setText, setVar, show, toggle } from "./dom";

export class TargetPrompt {
  readonly root: HTMLDivElement;
  private readonly title: HTMLSpanElement;
  private readonly cardIcon: HTMLSpanElement;
  private readonly cardName: HTMLSpanElement;
  private readonly num: HTMLSpanElement;
  private readonly desc: HTMLDivElement;
  private readonly timer = new Countdown();
  private promptCard: CardId | null = null;
  private promptMine = false;
  /** Game called targetPrompt(null) during this targeting phase (e.g. waiting for the server). */
  private promptSuppressed = false;
  private phaseKey = "";
  private promptKey = "";
  private visible = false;
  /** Exactly one possible target: nothing to choose. */
  private single = false;

  constructor(parent: HTMLElement) {
    this.root = h("div", "ks-hud-tprompt", parent);
    const line = h("div", "ks-hud-tprompt__line", this.root);
    h("span", "ks-hud-tprompt__aim", line, "🎯");
    this.title = h("span", "ks-hud-tprompt__title", line);
    const card = h("span", "ks-hud-tprompt__card", line);
    this.cardIcon = h("span", "ks-hud-tprompt__icon", card);
    this.cardName = h("span", "ks-hud-tprompt__name", card);
    this.num = h("span", "ks-hud-tprompt__num", line);
    this.desc = h("div", "ks-hud-tprompt__desc", this.root);
  }

  /** Explicit prompt from Game (null hides it until the next targeting phase). */
  setPrompt(card: CardId | null, mine: boolean): void {
    this.promptCard = card;
    this.promptMine = mine;
    this.promptSuppressed = card === null;
  }

  get shown(): boolean {
    return this.visible;
  }

  get mine(): boolean {
    return this.visible && this.root.classList.contains("ks-hud-tprompt--mine");
  }

  /** The prompt is up and there is a real choice (more than one possible target). */
  get choosing(): boolean {
    return this.mine && !this.single;
  }

  update(ctx: HudCtx): void {
    const s = ctx.state;
    const pKey = `${ctx.turnKey}:${ctx.phase}`;
    if (pKey !== this.phaseKey) {
      // a new phase: forget a stale explicit prompt / suppression from the previous targeting
      if (ctx.phase !== "targeting") {
        this.promptCard = null;
        this.promptSuppressed = false;
      }
      this.phaseKey = pKey;
    }
    const card = (this.promptCard ?? (s.pendingCard || null)) as CardId | null;
    const on = ctx.phase === "targeting" && !this.promptSuppressed && !!card;
    this.visible = on;
    show(this.root, on);
    if (!on) {
      this.timer.sync(0, 1, false);
      this.promptKey = "";
      return;
    }
    const mine = this.promptCard ? this.promptMine : ctx.myTurn;
    const def = card ? CARD_BY_ID[card] : undefined;
    const key = `${card}:${mine}`;
    if (key !== this.promptKey) {
      this.promptKey = key;
      replay(this.root, "ks-hud-enter");
    }
    toggle(this.root, "ks-hud-tprompt--mine", mine);

    let targets = 0;
    for (const p of ctx.order) if (p.id !== s.activeId && !p.ghost) targets++;
    this.single = targets <= 1;
    // One possible target: nothing to choose (the server resolves it by itself), so no "HEDEF SEÇ" call to action.
    if (mine) setText(this.title, this.single ? "TEK HEDEF" : "HEDEF SEÇ");
    else setText(this.title, `${ctx.active?.nickname ?? "Biri"} hedef seçiyor`);
    setText(this.cardIcon, def?.icon ?? "");
    setText(this.cardName, def?.name ?? "");
    setVar(this.root, "--rc", def ? RARITIES[def.rarity].color : RARITIES.uncommon.color);
    let desc = def?.desc ?? "";
    if (targets === 1) desc += `${desc ? " · " : ""}Tek rakip var: kart ona gidiyor…`;
    else if (mine) desc += `${desc ? " · " : ""}Bir rakibe tıkla (←/→ ile de seçersin). Süre biterse kader seçer.`;
    setText(this.desc, desc);
    this.timer.sync(s.timeLeft, s.timeTotal, s.timeTotal > 0 && s.timeLeft > 0);
  }

  tick(dt: number): void {
    if (!this.visible) return;
    this.timer.tick(dt);
    setText(this.num, this.timer.running ? String(this.timer.secs) : "");
  }
}
