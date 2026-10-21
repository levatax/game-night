// Camp chest panel (§7): the shared chest's contents (Take = as many as fit / Take 1) next to your 4 pockets.
// With the mouse the held (active) slot carries Put in / Put 1 and the others show what they hold (a click on one
// takes it in hand via `onSelectSlot`, nothing moves); "Put all supplies in" stores every material / food / water
// stack (tools stay with you). Only the buttons move items on a mouse click. Emits `chest` ChestMsg; the server
// answers with chestChanged / reject. Owner: client-ui.
//
// Keyboard (Ui routes the panel's keys to onKey): the dialog itself takes the focus on open (a stray Space / Enter
// moves nothing); every chest tile and pocket is a focusable tile (role=button), Tab stays inside the panel, the
// arrows move between tiles, Enter / Space takes from the chest or puts a pocket in (Shift: just one), and a
// pocket's slot key (1–4, 7–0 left-handed) puts that pocket in. A click on a tile with no pointer behind it (a
// screen reader's activate, virtualClick) does what Enter does, as the tile's label says. Every put names its
// pocket (ChestMsg `slot`, putMsg), so a pocket that isn't held goes in at once and the held item stays in hand.

import type { ChestMsg } from "../../../../shared/protocol";
import type { ItemKind } from "../../../../shared/types";
import { ITEMS } from "../../../../shared/items";
import { settings, type KeyPreset } from "../../app/settings";
import { itemName, t } from "../../i18n";
import { bindingFor } from "../../input/bindings";
import { itemIcon } from "../content";
import { keyParams, slotKeys } from "../controls";
import { arrowDir, button, el, gridNeighbor, play, setDisabled, setText, SHAKE_KEYFRAMES, svg, trapTab } from "../dom";
import { ICON_CLOSE } from "../icons";
import type { ChestPanelModel } from "../models";

const PUT_ALL_CATEGORIES: ReadonlySet<string> = new Set(["material", "food", "water"]);

function modelSig(m: ChestPanelModel): string {
  return `${m.chest.map((c) => `${c.kind}${c.count}`).join(",")}|${m.slots.map((s) => `${s.kind}${s.count}`).join(",")}|${m.activeSlot}|${settings.get().keyPreset}`;
}

/** Slot (0-based) a key deposits from: the preset's slot keys, plus the plain digits 1–4 in every preset. */
export function slotOfKey(code: string, preset: KeyPreset = settings.get().keyPreset): number {
  const digit = bindingFor(code, preset)?.digit ?? 0;
  if (digit >= 1 && digit <= 4) return digit - 1;
  const plain = /^(?:Digit|Numpad)([1-4])$/.exec(code);
  return plain ? Number(plain[1]) - 1 : -1;
}

/**
 * The ChestMsg that puts pocket `slot` (0-based) of the panel model in (`one`: a single unit), or null when that
 * pocket is empty or unknown. It names the pocket, so it goes out at once whichever pocket is held here or on the
 * server, and the held item stays in hand; its `kind` makes the server refuse it when the pocket holds something
 * else by the time it lands. Pure, no DOM.
 */
export function putMsg(m: ChestPanelModel | null, slot: number, one: boolean): ChestMsg | null {
  const kind = m?.slots[slot]?.kind;
  if (!kind) return null;
  return one ? { op: "put", slot, kind, count: 1 } : { op: "put", slot, kind };
}

/** What a click event may also carry: PointerEvent's pointerType (Chromium, Safari) and Firefox's mozInputSource. */
type ClickLike = Pick<MouseEvent, "detail" | "isTrusted"> & { readonly pointerType?: string; readonly mozInputSource?: number };

/**
 * A click no pointer made: a screen reader's activate (NVDA / JAWS browse mode, VoiceOver's VO+Space) or a script's
 * click(). Firefox marks the screen reader's with input source 0 (unknown); elsewhere it's detail 0 without a
 * pointer type. A mouse, pen or touch click has detail ≥ 1. Pure.
 */
export function virtualClick(e: ClickLike): boolean {
  if (e.mozInputSource === 0 && e.isTrusted) return true;
  return e.detail === 0 && !e.pointerType;
}

export class ChestPanel {
  readonly el = el("div", "rr-modal rr-chest");
  private readonly panel = el("div", "rr-panel rr-chest__panel");
  private readonly chestGrid = el("div", "rr-chest__grid");
  private readonly pockets = el("div", "rr-chest__pockets");
  private readonly putAll = button("rr-btn rr-btn--primary rr-chest__putall", `📦 ${t("panels.chestPutAll")}`);
  private readonly heldNote = el("p", "rr-chest__note");
  private readonly keysNote = el("span", "rr-modal__keys");
  private sig = "";
  private model: ChestPanelModel | null = null;

  constructor(
    private readonly onChest: (msg: ChestMsg) => void,
    onClose: () => void,
    private readonly onSelectSlot: (slot: number) => void = () => {},
  ) {
    // The dialog itself holds the focus on open (arrows / Tab go on to the tiles from there).
    this.panel.tabIndex = -1;
    this.el.hidden = true;
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", t("panels.chestTitle"));
    const close = button("rr-btn rr-btn--icon rr-modal__close", svg(ICON_CLOSE));
    close.setAttribute("aria-label", t("overlays.close"));
    close.addEventListener("click", () => onClose());
    this.putAll.addEventListener("click", () => this.onChest({ op: "putAll" }));
    this.putAll.title = t("panels.chestPutAllHint");
    const head = el("header", "rr-modal__head", el("h2", "rr-modal__title", `🧺 ${t("panels.chestTitle")}`), el("span", "rr-modal__sub", t("panels.chestShared")), close);
    this.chestGrid.setAttribute("role", "group");
    this.chestGrid.setAttribute("aria-label", t("panels.chestTitle"));
    this.pockets.setAttribute("role", "group");
    this.pockets.setAttribute("aria-label", t("panels.chestPockets"));
    const left = el("section", "rr-chest__col rr-chest__col--chest", this.chestGrid);
    const right = el(
      "section",
      "rr-chest__col rr-chest__col--pockets",
      el("h3", "rr-chest__sec", `🎒 ${t("panels.chestPockets")}`),
      this.pockets,
      this.putAll,
      el("p", "rr-chest__note", t("panels.chestPutAllHint")),
      this.heldNote,
    );
    this.panel.append(head, el("div", "rr-chest__body", left, right), el("footer", "rr-modal__foot", this.keysNote));
    this.el.append(this.panel);
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) onClose();
    });
  }

  onOpen(): void {
    const keys = keyParams();
    setText(this.heldNote, t("panels.chestHeldOnly", keys));
    setText(this.keysNote, `${t("panels.chestKeys", keys)} · ${t("panels.closeHint", keys)}`);
    play(this.panel, [{ transform: "translateY(24px) scale(0.94)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 240, easing: "cubic-bezier(.3,1.4,.5,1)" });
    // Not on the first tile: a Space out of jump habit (or a second Enter) must not take the whole first stack.
    this.panel.focus({ preventScroll: true });
  }

  /** The panel closed (Ui hides it). Nothing to drop: every put goes out on the key press / click itself. */
  onClose(): void {}

  update(m: ChestPanelModel): void {
    this.model = m;
    const sig = modelSig(m);
    if (sig === this.sig) return;
    this.sig = sig;
    const focus = this.focusedKey();
    this.renderChest(m);
    this.renderPockets(m);
    if (focus) this.restoreFocus(focus);
  }

  /** A key while the panel is open (after Ui took E / Esc). True when it was used. */
  onKey(e: KeyboardEvent): boolean {
    if (trapTab(this.panel, e)) return true;
    const slot = slotOfKey(e.code);
    if (slot >= 0) {
      if (!e.repeat) this.putFrom(slot, e.shiftKey);
      return true;
    }
    const dir = arrowDir(e.code);
    const tiles = this.tiles();
    if (dir && document.activeElement === this.panel) {
      tiles[0]?.focus({ preventScroll: false }); // from the dialog into the grid
      return true;
    }
    const tile = this.tileOf(document.activeElement);
    if (!tile) return false;
    if (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space") {
      if (!e.repeat) this.activate(tile, e.shiftKey);
      return true;
    }
    if (!dir) return false;
    tiles[gridNeighbor(tiles, tiles.indexOf(tile), dir)]?.focus({ preventScroll: false });
    return true;
  }

  /* ------------------------------------------------------------- rendering */

  private renderChest(m: ChestPanelModel): void {
    const items = m.chest.filter((c) => c.count > 0);
    if (items.length === 0) {
      this.chestGrid.replaceChildren(el("p", "rr-chest__empty", `🕸️ ${t("panels.chestEmpty")}`));
      return;
    }
    this.chestGrid.replaceChildren(...items.map((c) => this.chestTile(c.kind, c.count)));
  }

  private chestTile(kind: ItemKind, count: number): HTMLElement {
    const take = this.mouseButton("rr-btn rr-btn--small rr-btn--go", t("panels.chestTake"), () => this.take(kind, false));
    const takeOne = this.mouseButton("rr-btn rr-btn--small", t("panels.chestTakeOne"), () => this.take(kind, true));
    takeOne.hidden = count <= 1;
    const tile = el(
      "div",
      "rr-item-tile",
      el("span", "rr-item-tile__icon", itemIcon(kind)),
      el("span", "rr-item-tile__name", itemName(kind)),
      el("span", "rr-item-tile__count", `×${count}`),
      el("span", "rr-item-tile__actions", take, takeOne),
    );
    tile.title = itemName(kind);
    // A mouse click on the tile itself only focuses it: Take / Take 1 (or Enter) move the items.
    this.makeTile(tile, `chest:${kind}`, t("panels.chestTileAria", { item: itemName(kind), count }));
    return tile;
  }

  private renderPockets(m: ChestPanelModel): void {
    let anySupply = false;
    const keys = slotKeys();
    const tiles = m.slots.map((s, i) => {
      const active = i === m.activeSlot;
      const key = keys[i] ?? String(i + 1);
      if (s.kind && PUT_ALL_CATEGORIES.has(ITEMS[s.kind].category)) anySupply = true;
      const tile = el("div", `rr-pocket${active ? " is-active" : ""}${s.kind ? "" : " is-empty"}`, el("span", "rr-pocket__key", key));
      const n = i + 1;
      if (!s.kind) {
        tile.append(el("span", "rr-pocket__name", t("panels.chestEmptySlot")));
        this.makeTile(tile, `pocket:${i}`, t("panels.pocketAriaEmpty", { n }));
        tile.setAttribute("aria-disabled", "true");
        return tile;
      }
      tile.append(
        el("span", "rr-pocket__icon", itemIcon(s.kind)),
        el("span", "rr-pocket__name", itemName(s.kind), s.count > 1 ? el("b", "", ` ×${s.count}`) : null),
      );
      const params = { n, key, item: itemName(s.kind), count: s.count };
      // A mouse click on another pocket takes it in hand (its Put in / Put 1 buttons appear); nothing goes in the
      // chest. On the held pocket's body it only focuses it.
      const onPointerClick = active ? undefined : () => this.hold(i);
      this.makeTile(tile, `pocket:${i}`, t(active ? "panels.pocketAriaHeld" : "panels.pocketAria", params), onPointerClick);
      if (active) {
        const put = this.mouseButton("rr-btn rr-btn--small rr-btn--primary", t("panels.chestPut"), () => this.putFrom(i, false));
        const putOne = this.mouseButton("rr-btn rr-btn--small", t("panels.chestPutOne"), () => this.putFrom(i, true));
        putOne.hidden = s.count <= 1;
        tile.append(el("span", "rr-pocket__held", `✋ ${t("panels.chestHeld")}`), el("span", "rr-pocket__actions", put, putOne));
      }
      return tile;
    });
    this.pockets.replaceChildren(...tiles);
    setDisabled(this.putAll, !anySupply);
  }

  /**
   * A focusable role=button tile; its inner buttons stay mouse-only (no nested controls for screen readers). A
   * virtual click (a screen reader's activate) does what Enter does; a mouse click on the tile runs `onPointerClick`.
   */
  private makeTile(tile: HTMLElement, key: string, label: string, onPointerClick?: () => void): void {
    tile.tabIndex = 0;
    tile.dataset.key = key;
    tile.setAttribute("role", "button");
    tile.setAttribute("aria-label", label);
    tile.addEventListener("click", (e) => {
      if (virtualClick(e)) this.activate(tile, false);
      else onPointerClick?.();
    });
  }

  private mouseButton(className: string, text: string, onClick: () => void): HTMLButtonElement {
    const b = button(className, text);
    b.tabIndex = -1;
    b.setAttribute("aria-hidden", "true");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  /* ------------------------------------------------------------ behaviour */

  private take(kind: ItemKind, one: boolean): void {
    this.onChest(one ? { op: "take", kind, count: 1 } : { op: "take", kind });
  }

  private activate(tile: HTMLElement, one: boolean): void {
    const key = tile.dataset.key ?? "";
    if (key.startsWith("chest:")) this.take(key.slice(6) as ItemKind, one);
    else if (key.startsWith("pocket:")) this.putFrom(Number(key.slice(7)), one);
  }

  /** Put pocket `slot` (0-based) into the chest, held or not (putMsg); an empty pocket shakes. */
  private putFrom(slot: number, one: boolean): void {
    const msg = putMsg(this.model, slot, one);
    if (msg) this.onChest(msg);
    else this.shake(`pocket:${slot}`);
  }

  /** Take pocket `slot` in hand (a click on a pocket that isn't held). */
  private hold(slot: number): void {
    const m = this.model;
    if (!m || slot === m.activeSlot || !m.slots[slot]?.kind) return;
    this.onSelectSlot(slot);
  }

  private shake(key: string): void {
    const tile = this.tiles().find((n) => n.dataset.key === key);
    if (tile) play(tile, SHAKE_KEYFRAMES, { duration: 320 });
  }

  /* ---------------------------------------------------------------- focus */

  private tiles(): HTMLElement[] {
    return [...this.panel.querySelectorAll<HTMLElement>(".rr-item-tile[data-key], .rr-pocket[data-key]")];
  }

  private tileOf(node: Element | null): HTMLElement | null {
    if (!(node instanceof HTMLElement) || !this.panel.contains(node)) return null;
    return node.dataset.key ? node : null;
  }

  /** Which tile has the focus (by identity, so it survives a re-render) and its place among the tiles. */
  private focusedKey(): { key: string; index: number } | null {
    const tile = this.tileOf(document.activeElement);
    return tile ? { key: tile.dataset.key ?? "", index: this.tiles().indexOf(tile) } : null;
  }

  /** After a re-render: the same tile again, or the one now in its place (the last wood was taken). */
  private restoreFocus(f: { key: string; index: number }): void {
    const tiles = this.tiles();
    const same = tiles.find((n) => n.dataset.key === f.key);
    const target = same ?? tiles[Math.min(f.index, tiles.length - 1)] ?? this.putAll;
    target.focus({ preventScroll: true });
  }
}
