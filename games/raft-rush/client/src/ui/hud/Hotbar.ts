// Bottom-center 4-slot hotbar (§7, §17): icon, stack count, torch burn / puffer fuse meter, active slot raised.
// Owner: client-ui. Above it the active item's name + what the mouse / keys do with it fades in for a few seconds
// whenever the held item changes (and stays while it's a jellyfish or a ticking puffer: that's urgent).
// The slot badges and the hint's keys follow the key preset / layout (ui/controls.ts).

import { ITEMS } from "../../../../shared/items";
import type { InvKind } from "../../../../shared/types";
import { settings } from "../../app/settings";
import { itemName, t } from "../../i18n";
import { itemIcon } from "../content";
import { keyParams, slotKeys } from "../controls";
import { el, replay, setHidden, setText, setVar, toggleClass } from "../dom";
import type { SlotModel } from "../models";

const NAME_SEC = 3;

interface SlotView {
  root: HTMLElement;
  key: HTMLElement;
  icon: HTMLElement;
  count: HTMLElement;
  meter: HTMLElement;
  kind: InvKind | null;
  countValue: number;
  meterValue: number;
}

/** i18n key for the usage hint under the held item's name. */
function hintKey(kind: InvKind): string {
  if (kind === "") return "";
  const def = ITEMS[kind];
  switch (kind) {
    case "jellyfish":
      return "hud.hint_jelly";
    case "puffer":
      return "hud.hint_puffer";
    case "torch":
      return "hud.hint_torch";
    case "rod":
      return "hud.hint_rod";
    case "axe":
      return "hud.hint_axe";
    case "raft_part":
    case "compass":
      return "hud.hint_raft";
    case "log":
    case "barrel":
      return "hud.hint_heavy";
    case "hammer":
      return "hud.hint_hammer";
    case "kraken":
      return "hud.hint_kraken";
    case "coconut":
      return "hud.hint_eatThrow";
    case "fish_raw":
      return "hud.hint_bait";
    default:
      break;
  }
  if (def.places) return "hud.hint_place";
  if (def.water > 0 && def.food === 0) return "hud.hint_drink";
  if (def.food > 0) return "hud.hint_eat";
  if (def.throwable) return "hud.hint_throw";
  return "hud.hint_toss";
}

export class Hotbar {
  readonly el = el("div", "rr-hotbar");
  private readonly slotsRow = el("div", "rr-hotbar__slots");
  private readonly label = el("div", "rr-hotbar__label");
  private readonly labelName = el("span", "rr-hotbar__name");
  private readonly labelHint = el("span", "rr-hotbar__hint");
  private readonly views: SlotView[] = [];
  private active = -1;
  private heldKind: InvKind | null = null;
  private labelTimer = 0;
  private urgent = false;

  constructor() {
    this.label.append(this.labelName, this.labelHint);
    this.label.hidden = true;
    for (let i = 0; i < 4; i++) {
      const icon = el("span", "rr-slot__icon");
      const count = el("span", "rr-slot__count");
      const meter = el("span", "rr-slot__meter", el("i"));
      const key = el("span", "rr-slot__key");
      const root = el("div", "rr-slot", key, icon, count, meter);
      this.views.push({ root, key, icon, count, meter, kind: null, countValue: -1, meterValue: -2 });
      this.slotsRow.append(root);
    }
    this.el.append(this.label, this.slotsRow);
    this.renderKeys();
    settings.onChange((_s, changed) => {
      if (changed.includes("keyPreset")) this.renderKeys();
    });
  }

  /** Slot badges: 1–4, or 7–0 with the left-handed preset. */
  private renderKeys(): void {
    const keys = slotKeys();
    this.views.forEach((v, i) => setText(v.key, keys[i] ?? String(i + 1)));
  }

  update(slots: readonly SlotModel[], activeSlot: number): void {
    for (let i = 0; i < this.views.length; i++) this.renderSlot(this.views[i]!, slots[i] ?? { kind: "", count: 0, meter: -1 });
    if (activeSlot !== this.active) {
      if (this.active >= 0) this.views[this.active]?.root.classList.remove("is-active");
      this.views[activeSlot]?.root.classList.add("is-active");
      if (this.active >= 0) {
        const v = this.views[activeSlot];
        if (v) replay(v.root, "is-picked");
      }
      this.active = activeSlot;
    }
    const held = slots[activeSlot]?.kind ?? "";
    if (held !== this.heldKind) {
      const first = this.heldKind === null;
      this.heldKind = held;
      this.showLabel(held, !first);
    }
  }

  private renderSlot(v: SlotView, s: SlotModel): void {
    if (s.kind !== v.kind) {
      v.kind = s.kind;
      setText(v.icon, itemIcon(s.kind));
      toggleClass(v.root, "is-empty", s.kind === "");
      v.root.title = s.kind ? itemName(s.kind) : "";
      toggleClass(v.root, "is-danger", s.kind === "puffer" || s.kind === "jellyfish");
      if (s.kind) replay(v.icon, "is-new");
    }
    const count = s.kind === "" ? 0 : s.count;
    if (count !== v.countValue) {
      v.countValue = count;
      setText(v.count, count > 1 ? `×${count}` : "");
    }
    const meter = s.kind === "" ? -1 : Math.round(s.meter * 50) / 50;
    if (meter !== v.meterValue) {
      v.meterValue = meter;
      setHidden(v.meter, meter < 0);
      if (meter >= 0) setVar(v.meter, "--v", `${Math.round(meter * 100)}%`);
      toggleClass(v.meter, "is-fuse", s.kind === "puffer");
      toggleClass(v.meter, "is-low", meter >= 0 && meter < 0.25);
    }
  }

  private showLabel(kind: InvKind, animate: boolean): void {
    window.clearTimeout(this.labelTimer);
    setText(this.labelName, kind ? itemName(kind) : t("hud.slotEmpty"));
    const hint = hintKey(kind);
    setText(this.labelHint, hint ? t(hint, keyParams()) : "");
    setHidden(this.labelHint, !hint);
    this.urgent = kind === "puffer" || kind === "jellyfish";
    toggleClass(this.label, "is-urgent", this.urgent);
    if (!animate && kind === "") {
      this.label.hidden = true;
      return;
    }
    this.label.hidden = false;
    replay(this.label, "is-in");
    if (this.urgent) return;
    this.labelTimer = window.setTimeout(() => {
      if (!this.urgent) this.label.hidden = true;
    }, NAME_SEC * 1000);
  }
}
