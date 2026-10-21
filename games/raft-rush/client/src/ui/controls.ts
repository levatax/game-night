// Every key the UI prints: the control list shown in the hold-H guide and the Esc menu (game4.md §15 + ARCHITECTURE
// §2.1: F eats, M mutes), the key caps of the HUD and the {k…} placeholders of the coach / legend / panel / hotbar
// / HUD / feed / banner / Home strings (ui/keyStrings.test.ts checks every one is filled). All of them follow the active key preset (settings.keyPreset) and the player's keyboard layout
// (input/bindings.ts keyCap: AZERTY prints ZQSD, the left-handed preset IJKL). Owner: client-ui. Labels starting
// with "overlays.key_" are translated; the rest are key caps.

import { settings } from "../app/settings";
import { t, type Params } from "../i18n";
import { codesFor, keyCap, keyCapsVersion, type KeyAction } from "../input/bindings";
import { el } from "./dom";

export interface ControlRow {
  keys: string[];
  /** i18n key of the action. */
  action: string;
}

const SLOT_ACTIONS: ReadonlyArray<KeyAction> = ["slot1", "slot2", "slot3", "slot4"];
const WHEEL_ACTIONS: ReadonlyArray<KeyAction> = ["slot1", "slot2", "slot3", "slot4", "slot5", "slot6"];

/** The printed cap of one code ("Space" is translated). */
function capOf(code: string): string {
  return code === "Space" ? t("overlays.key_space") : keyCap(code);
}

/** The printed key of an action in the active preset ("E", "U" left-handed, "Boşluk" for jump in Turkish). */
export function keyLabel(action: KeyAction): string {
  return capOf(codesFor(action, settings.get().keyPreset)[0] ?? "");
}

/** The four movement caps in W A S D order. */
export function moveKeys(): string[] {
  return (["forward", "left", "back", "right"] as const).map(keyLabel);
}

/** "1–4" for consecutive digits, else the caps one by one ("7 8 9 0"). */
function rangeLabel(actions: ReadonlyArray<KeyAction>): string {
  const caps = actions.map(keyLabel);
  const nums = caps.map(Number);
  const consecutive = caps.every((c) => /^\d$/.test(c)) && nums.every((n, i) => i === 0 || n === nums[i - 1]! + 1);
  return consecutive && caps.length > 1 ? `${caps[0]}–${caps[caps.length - 1]}` : caps.join(" ");
}

/** Key caps of the four hotbar slots (badges on the hotbar and the chest pockets). */
export function slotKeys(): string[] {
  return SLOT_ACTIONS.map(keyLabel);
}

/** Key cap of wheel slice `i` (0-based; the slot digits). */
export function wheelKey(i: number): string {
  const action = WHEEL_ACTIONS[i];
  return action ? keyLabel(action) : String(i + 1);
}

/**
 * Placeholders for every string that names a key: {kMove} {kSprint} {kJump} {kInteract} {kEat} {kToss} {kSlots}
 * {kPing} {kEmote} {kLegend} {kStats} {kMute} {kPingKeys} {kEmoteKeys}. Pass to t(key, keyParams()).
 */
export function keyParams(): Params {
  return {
    kMove: moveKeys().join(""),
    kSprint: keyLabel("sprint"),
    kJump: keyLabel("jump"),
    kInteract: keyLabel("interact"),
    kEat: keyLabel("eat"),
    kToss: keyLabel("toss"),
    kSlots: rangeLabel(SLOT_ACTIONS),
    kPing: keyLabel("ping"),
    kEmote: keyLabel("emote"),
    kLegend: keyLabel("legend"),
    kStats: keyLabel("stats"),
    kMute: keyLabel("mute"),
    kPingKeys: rangeLabel(SLOT_ACTIONS),
    kEmoteKeys: rangeLabel(WHEEL_ACTIONS),
  };
}

/**
 * keyParams() under the caller's own params (theirs win), for renderers that take any key with any params: the
 * feed and the banner fill every line this way, so a feed.* / banner.* string may name a key wherever it is sent from.
 */
export function withKeys(params?: Params): Params {
  return params ? { ...keyParams(), ...params } : keyParams();
}

/** Changes whenever a printed key may have changed (preset, learned caps, mouse lock): rebuild key lists then. */
export function keysSignature(): string {
  const s = settings.get();
  return `${s.keyPreset}|${keyCapsVersion()}|${s.mouseLock ? 1 : 0}`;
}

/** The control rows for the active preset (key caps already resolved; "overlays.key_*" still to translate). */
export function controlRows(): ControlRow[] {
  return [
    { keys: moveKeys(), action: "overlays.ctl_move" },
    { keys: [settings.get().mouseLock ? "overlays.key_mouse" : "overlays.key_drag"], action: "overlays.ctl_look" },
    { keys: [keyLabel("jump")], action: "overlays.ctl_jump" },
    { keys: [keyLabel("sprint")], action: "overlays.ctl_sprint" },
    { keys: ["overlays.key_lmb"], action: "overlays.ctl_use" },
    { keys: ["overlays.key_rmb"], action: "overlays.ctl_catch" },
    { keys: [keyLabel("interact")], action: "overlays.ctl_interact" },
    { keys: [keyLabel("eat")], action: "overlays.ctl_eat" },
    { keys: [keyLabel("toss")], action: "overlays.ctl_toss" },
    { keys: [rangeLabel(SLOT_ACTIONS), "overlays.key_wheel"], action: "overlays.ctl_slots" },
    { keys: [keyLabel("ping"), "overlays.key_mmb"], action: "overlays.ctl_ping" },
    { keys: [keyLabel("emote"), rangeLabel(WHEEL_ACTIONS)], action: "overlays.ctl_emote" },
    { keys: [keyLabel("legend")], action: "overlays.ctl_legend" },
    { keys: [keyLabel("stats")], action: "overlays.ctl_stats" },
    { keys: ["Esc"], action: "overlays.ctl_menu" },
    { keys: [keyLabel("mute")], action: "overlays.ctl_mute" },
  ];
}

function rowLabel(k: string): string {
  return k.startsWith("overlays.") ? t(k) : k;
}

/** Fill (or refill) a `<dl>` of key caps → actions for the active preset. */
export function fillControlsList(list: HTMLElement): void {
  const rows = controlRows().map((row) => {
    const dt = el("dt");
    row.keys.forEach((k, i) => {
      if (i > 0) dt.append(el("span", "rr-controls__sep", "/"));
      dt.append(el("kbd", "", rowLabel(k)));
    });
    return el("div", "rr-controls__row", dt, el("dd", "", t(row.action)));
  });
  list.replaceChildren(...rows);
  list.dataset.keys = keysSignature();
}

/** A `<dl>` of key caps → actions. Refill it with refreshControlsList() when it is shown again. */
export function buildControlsList(className = "rr-controls"): HTMLElement {
  const list = el("dl", className);
  fillControlsList(list);
  return list;
}

/** Refill a list built by buildControlsList() when the preset or the learned caps changed since. */
export function refreshControlsList(list: HTMLElement): void {
  if (list.dataset.keys !== keysSignature()) fillControlsList(list);
}
