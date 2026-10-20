// Lobby (§16.2). Left smoky panel: room code plaque + "Linki kopyala", up to MAX_PLAYERS player cards (animal
// portrait in a player-color fedora, nickname, animal · color, "HAZIR ✓" stamp, host crown, "SEN" tag, "🤖 BOT"
// tag), my disguise picker (animal + hat color, taken ones disabled) and a 3-step "Nasıl oynanır" strip (open by
// default, remembered when folded). The host fills empty chairs with "🤖 Bot ekle" and removes bots with "✕ Çıkar";
// bots are always ready and count toward MIN_PLAYERS. Right smoky panel: the house rules sheet (host edits,
// everyone else sees it read-only and live), "Hazırım" toggle, "Başlat" (host) with the reason it is locked,
// "Masadan kalk". Built once and updated in place, so focus and open <select>s survive the 20 Hz patches.

import {
  ANIMALS,
  DECISION_SEC_OPTIONS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLAYER_COLORS,
  PLAYER_COLOR_NAMES,
  ROYALE_MAX_ROUNDS,
  ROYALE_START_KASA,
  START_KASA,
  TURN_OPTIONS,
  classicRounds,
  type Animal,
} from "../../../../shared/constants";
import type { KasalaStateView, Mode, PlayerView, SettingsMsg, SettingsView } from "../../../../shared/protocol";
import { animalLabel, money, ofName, playerColor, type UiSound } from "../../app/ui";
import { CEMIL_LOBBY, EMPTY_SEATS, LOBBY_STEPS, MODE_INFO, NOT_READY } from "./copy";
import { copyText, h, pick, radioKeys, readStorage, replay, rovingTabs, setAttr, setHtml, setText, writeStorage } from "./dom";
import { animalPortrait, cemilPortrait, emptyPortrait, fedoraIcon } from "./portraits";

export interface LobbyCallbacks {
  onReady(ready: boolean): void;
  onAnimal(animal: Animal): void;
  onColor(color: number): void;
  onSettings(patch: SettingsMsg): void;
  onStart(): void;
  onLeave(): void;
  onAddBot(): void;
  onRemoveBot(id: string): void;
  sound(kind: UiSound): void;
  toast(text: string, ms?: number): void;
}

interface Seat {
  li: HTMLLIElement;
  portrait: HTMLElement;
  name: HTMLElement;
  sub: HTMLElement;
  status: HTMLElement;
  crown: HTMLElement;
  you: HTMLElement;
  bot: HTMLElement;
  /** Host only, on the first empty chair. */
  add: HTMLButtonElement;
  /** Host only, on bot cards. */
  kick: HTMLButtonElement;
  id: string;
  ready: boolean;
  pc: string;
}

interface Segmented {
  group: HTMLElement;
  buttons: HTMLButtonElement[];
  values: (string | number)[];
}

const MODES: Mode[] = ["classic", "royale"];
const MODE_DESC: Record<Mode, string> = {
  classic: `Herkes ${money(START_KASA)} ile başlar. Sabit tur, sonunda en zengin kazanır.`,
  royale: `Herkes ${money(ROYALE_START_KASA)} ile başlar. Kasası biten nehre, masada son kalan kazanır.`,
};

/** localStorage: "0" once the player folded the lobby how-to strip. */
const HOWTO_KEY = "kasala:lobby-howto";
/** A click on "Bot ekle" waits this long before the next one counts (one bot per click, no double adds). */
const ADD_BOT_COOLDOWN_MS = 450;

/** Stable small hash so a player's "thinking" caption doesn't flicker between patches. */
function hashIndex(id: string, n: number): number {
  let x = 0;
  for (let i = 0; i < id.length; i++) x = (x * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(x) % n;
}

export class LobbyScreen {
  readonly el: HTMLElement;
  private readonly cb: LobbyCallbacks;

  private readonly tiles: HTMLElement;
  private readonly urlText: HTMLElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly count: HTMLElement;
  private readonly seats: Seat[] = [];
  private readonly animalBtns: HTMLButtonElement[] = [];
  private readonly colorBtns: HTMLButtonElement[] = [];
  private readonly pickerNote: HTMLElement;

  private readonly modeSeg: Segmented;
  private readonly modeDesc: HTMLElement;
  private readonly turnsRow: HTMLElement;
  private readonly turnsSel: HTMLSelectElement;
  private readonly royaleNote: HTMLElement;
  private readonly decisionSeg: Segmented;
  private readonly loansBox: HTMLInputElement;
  private readonly loansState: HTMLElement;
  private readonly betsBox: HTMLInputElement;
  private readonly betsState: HTMLElement;
  private readonly rows: Record<keyof SettingsView, HTMLElement>;
  private readonly rulesNote: HTMLElement;

  private readonly readyBtn: HTMLButtonElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly reason: HTMLElement;
  private readonly leaveBtn: HTMLButtonElement;
  private readonly quip: HTMLElement;
  private quipTimer = 0;

  private code = "";
  private myReady = false;
  private canStart = false;
  private isHost = false;
  private myAnimal: Animal | "" = "";
  private myColor = -1;
  private prevSettings: SettingsView | null = null;
  private fresh = true;
  private lastAddBot = 0;

  constructor(cb: LobbyCallbacks) {
    this.cb = cb;
    this.el = h("section", "ks-menu-screen ks-menu-lobby", { "aria-label": "Lobi" });
    const grid = h("div", "ks-menu-lobby-grid");

    // ================================================================ main panel
    const main = h("div", "ks-menu-panel ks-menu-smoky ks-menu-lobby-main");
    const head = h("header", "ks-menu-lobby-head");
    const plaque = h("div", "ks-menu-plaque");
    plaque.appendChild(h("span", "ks-menu-plaque-label", { id: "ks-menu-code-label" }, "MASA KODU"));
    this.tiles = h("div", "ks-menu-tiles", { role: "text", "aria-labelledby": "ks-menu-code-label" });
    for (let i = 0; i < 4; i++) this.tiles.appendChild(h("span", "ks-menu-tile", { "aria-hidden": "true" }, "·"));
    this.urlText = h("span", "ks-menu-plaque-url");
    plaque.append(this.tiles, this.urlText);
    const headSide = h("div", "ks-menu-head-side");
    this.copyBtn = h("button", "ks-btn ks-menu-copy", { type: "button" }, "🔗 Linki kopyala");
    this.copyBtn.addEventListener("click", () => void this.copyLink());
    const mini = h("span", "ks-menu-mini-logo ks-neon", { "aria-hidden": "true" }, "KASALA!");
    headSide.append(mini, this.copyBtn);
    head.append(plaque, headSide);

    const seatsHead = h("div", "ks-menu-section-head");
    seatsHead.appendChild(h("h2", "ks-menu-h2", { id: "ks-menu-seats-h" }, "Masadakiler"));
    this.count = h("span", "ks-menu-count", { "aria-live": "polite" });
    seatsHead.appendChild(this.count);

    const list = h("ul", "ks-menu-seats", { "aria-labelledby": "ks-menu-seats-h" });
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const li = h("li", "ks-menu-seat ks-menu-seat--empty");
      li.style.setProperty("--tilt", `${[-1.4, 0.9, -0.6, 1.2, -1, 0.7][i] ?? 0}deg`);
      const crown = h("span", "ks-menu-crown", { title: "Masa sahibi", "aria-hidden": "true" });
      crown.innerHTML =
        '<svg viewBox="0 0 40 30" aria-hidden="true" focusable="false"><path d="M4 26L2 7L12 15L20 3L28 15L38 7L36 26Z" fill="#FFC93C" stroke="#241f2b" stroke-width="3" stroke-linejoin="round"/><circle cx="20" cy="18" r="3" fill="#FF3C8E" stroke="#241f2b" stroke-width="1.5"/></svg>';
      const you = h("span", "ks-menu-you", { "aria-hidden": "true" }, "SEN");
      const bot = h("span", "ks-menu-bot-tag", { "aria-hidden": "true" }, "🤖 BOT");
      const frame = h("div", "ks-menu-frame", { "aria-hidden": "true" });
      const portrait = h("div", "ks-menu-portrait");
      frame.appendChild(portrait);
      const name = h("span", "ks-menu-seat-name");
      const sub = h("span", "ks-menu-seat-sub");
      const status = h("span", "ks-menu-seat-status");
      const add = h("button", "ks-menu-add-bot", { type: "button", title: "Boş sandalyeye bir bot oturt" }, "🤖 Bot ekle");
      add.hidden = true;
      add.addEventListener("click", () => this.addBot());
      const kick = h("button", "ks-menu-kick", { type: "button" }, "✕ Çıkar");
      kick.hidden = true;
      const seat: Seat = { li, portrait, name, sub, status, crown, you, bot, add, kick, id: "", ready: false, pc: "" };
      kick.addEventListener("click", () => {
        if (!this.isHost || !seat.id) return;
        kick.disabled = true; // the next patch removes the card; re-armed if the server said no
        window.setTimeout(() => (kick.disabled = false), 1500);
        this.cb.onRemoveBot(seat.id);
      });
      li.append(crown, you, bot, kick, frame, name, sub, status, add);
      list.appendChild(li);
      this.seats.push(seat);
    }

    // My disguise: animal + hat color.
    const picker = h("div", "ks-menu-picker");
    const animalGroup = h("div", "ks-menu-pick-group ks-menu-pick-animals", { role: "radiogroup", "aria-labelledby": "ks-menu-pick-animal-h" });
    animalGroup.appendChild(h("span", "ks-menu-pick-label", { id: "ks-menu-pick-animal-h" }, "Hayvanın"));
    const animalRow = h("div", "ks-menu-pick-row");
    ANIMALS.forEach((a) => {
      const b = h("button", "ks-menu-animal", { type: "button", role: "radio", "aria-checked": "false", "aria-label": a.label });
      const pic = h("span", "ks-menu-animal-pic", { "aria-hidden": "true" });
      b.append(pic, h("span", "ks-menu-animal-name", { "aria-hidden": "true" }, a.label));
      b.addEventListener("click", () => this.pickAnimal(a.id));
      animalRow.appendChild(b);
      this.animalBtns.push(b);
    });
    animalGroup.appendChild(animalRow);
    radioKeys(animalGroup, this.animalBtns, (i) => this.pickAnimal(ANIMALS[i]!.id));

    const colorGroup = h("div", "ks-menu-pick-group ks-menu-pick-colors", { role: "radiogroup", "aria-labelledby": "ks-menu-pick-color-h" });
    colorGroup.appendChild(h("span", "ks-menu-pick-label", { id: "ks-menu-pick-color-h" }, "Şapka rengin"));
    const colorRow = h("div", "ks-menu-pick-row");
    PLAYER_COLORS.forEach((hex, i) => {
      const b = h("button", "ks-menu-swatch", { type: "button", role: "radio", "aria-checked": "false", "aria-label": PLAYER_COLOR_NAMES[i] ?? "" });
      b.style.setProperty("--sw", hex);
      b.innerHTML = fedoraIcon(hex);
      b.addEventListener("click", () => this.pickColor(i));
      colorRow.appendChild(b);
      this.colorBtns.push(b);
    });
    colorGroup.appendChild(colorRow);
    radioKeys(colorGroup, this.colorBtns, (i) => this.pickColor(i));
    this.pickerNote = h("p", "ks-menu-picker-note", { "aria-live": "polite" });
    picker.append(animalGroup, colorGroup);

    main.append(head, seatsHead, list, picker, this.pickerNote, this.howTo());

    // ================================================================ side panel
    const side = h("div", "ks-menu-panel ks-menu-smoky ks-menu-lobby-side");
    side.appendChild(h("h2", "ks-menu-h2 ks-menu-rules-h", { id: "ks-menu-rules-h" }, "Masa Kuralları"));
    const rules = h("div", "ks-menu-paper ks-menu-rules", { role: "group", "aria-labelledby": "ks-menu-rules-h" });

    let ruleIds = 0;
    const row = (labelText: string, labelFor?: string): HTMLElement => {
      const r = h("div", "ks-menu-rule");
      const id = `ks-menu-rule-${++ruleIds}`;
      r.appendChild(labelFor ? h("label", "ks-menu-rule-label", { for: labelFor, id }, labelText) : h("span", "ks-menu-rule-label", { id }, labelText));
      return r;
    };

    // Mode.
    const modeRow = row("Mod");
    this.modeSeg = this.segmented(
      modeRow,
      MODES.map((m) => (m === "classic" ? `💰 ${MODE_INFO.classic.label}` : `🌊 ${MODE_INFO.royale.label}`)),
      MODES,
      (v) => this.sendSetting({ mode: v as Mode }),
    );
    this.modeDesc = h("p", "ks-menu-rule-desc");
    modeRow.appendChild(this.modeDesc);

    // Turns (classic only).
    this.turnsRow = row("Sıra sayısı", "ks-menu-turns");
    this.turnsSel = h("select", "ks-menu-select", { id: "ks-menu-turns" });
    for (const t of TURN_OPTIONS) this.turnsSel.appendChild(h("option", undefined, { value: String(t) }, t === 0 ? "Otomatik" : `${t} sıra`));
    this.turnsSel.addEventListener("change", () => this.sendSetting({ turns: Number(this.turnsSel.value) }));
    this.royaleNote = h("span", "ks-menu-rule-static", undefined, `En fazla ${ROYALE_MAX_ROUNDS} tur`);
    this.turnsRow.append(this.turnsSel, this.royaleNote);

    // Decision time.
    const decRow = row("Karar süresi");
    this.decisionSeg = this.segmented(
      decRow,
      DECISION_SEC_OPTIONS.map((s) => `${s} sn`),
      [...DECISION_SEC_OPTIONS],
      (v) => this.sendSetting({ decisionSec: Number(v) }),
    );

    // Switches.
    const sw = (labelText: string, id: string, onChange: (on: boolean) => void): [HTMLElement, HTMLInputElement, HTMLElement] => {
      const r = row(labelText, id);
      const wrap = h("span", "ks-menu-switch-wrap");
      const box = h("input", "ks-menu-switch", { id, type: "checkbox", role: "switch" });
      const state = h("span", "ks-menu-switch-state", { "aria-hidden": "true" });
      box.addEventListener("change", () => onChange(box.checked));
      wrap.append(box, state);
      r.appendChild(wrap);
      return [r, box, state];
    };
    const [loansRow, loansBox, loansState] = sw("Borç sistemi", "ks-menu-loans", (on) => this.sendSetting({ loans: on }));
    const [betsRow, betsBox, betsState] = sw("Seyirci bahsi", "ks-menu-bets", (on) => this.sendSetting({ sideBets: on }));
    this.loansBox = loansBox;
    this.loansState = loansState;
    this.betsBox = betsBox;
    this.betsState = betsState;

    this.rulesNote = h("p", "ks-menu-rules-note");
    rules.append(modeRow, this.turnsRow, decRow, loansRow, betsRow, this.rulesNote);
    this.rows = { mode: modeRow, turns: this.turnsRow, decisionSec: decRow, loans: loansRow, sideBets: betsRow };

    // Actions.
    const actions = h("div", "ks-menu-actions");
    this.readyBtn = h("button", "ks-btn ks-menu-ready", { type: "button", "aria-pressed": "false" });
    this.readyBtn.addEventListener("click", () => {
      this.myReady = !this.myReady; // optimistic; the next patch confirms
      this.renderReady();
      this.cb.sound(this.myReady ? "chip" : "pop");
      this.cb.onReady(this.myReady);
    });
    this.startBtn = h("button", "ks-btn ks-menu-big ks-menu-start", { type: "button", "aria-describedby": "ks-menu-reason" }, "BAŞLAT");
    this.startBtn.addEventListener("click", () => {
      if (!this.isHost) return;
      if (!this.canStart) {
        replay(this.reason, "ks-menu-shake");
        this.cb.sound("deny");
        return;
      }
      this.cb.onStart();
    });
    this.reason = h("p", "ks-menu-reason", { id: "ks-menu-reason", "aria-live": "polite" });
    this.leaveBtn = h("button", "ks-btn ks-btn--ghost ks-menu-leave", { type: "button" }, "🚪 Masadan kalk");
    this.leaveBtn.addEventListener("click", () => this.cb.onLeave());
    actions.append(this.readyBtn, this.startBtn, this.reason, this.leaveBtn);

    // Cemil Abi's small talk fills the gap between the rules and the buttons.
    const cemil = h("figure", "ks-menu-cemil");
    const face = h("span", "ks-menu-cemil-face", { "aria-hidden": "true" });
    face.innerHTML = cemilPortrait();
    this.quip = h("blockquote", "ks-menu-cemil-quip");
    const cap = h("figcaption", "ks-menu-cemil-cap", undefined, "Cemil Abi");
    const bubble = h("div", "ks-menu-cemil-bubble");
    bubble.append(this.quip, cap);
    cemil.append(face, bubble);
    face.addEventListener("click", () => {
      this.nextQuip();
      replay(face, "ks-menu-boing");
      this.cb.sound("pop");
    });

    side.append(rules, cemil, actions);
    grid.append(main, side);
    this.el.appendChild(grid);
    this.renderReady();
  }

  /** Called when the lobby screen is shown / hidden. On show the next update animates nothing (no join pops). */
  setVisible(on: boolean): void {
    window.clearInterval(this.quipTimer);
    if (!on) return;
    this.fresh = true;
    this.prevSettings = null;
    this.nextQuip();
    this.quipTimer = window.setInterval(() => this.nextQuip(), 9000);
  }

  private nextQuip(): void {
    let line: string = pick(CEMIL_LOBBY);
    for (let i = 0; i < 4 && line === this.quip.textContent; i++) line = pick(CEMIL_LOBBY);
    this.quip.textContent = `“${line}”`;
    replay(this.quip, "ks-menu-quip-in");
  }

  update(state: KasalaStateView, myId: string): void {
    const players: PlayerView[] = [];
    state.players.forEach((p) => {
      if (!p.spectator) players.push(p);
    });
    players.sort((a, b) => a.seat - b.seat);
    const me = state.players.get(myId);
    const isHost = state.hostId === myId;
    this.isHost = isHost;
    const host = state.players.get(state.hostId);
    const hostName = host?.nickname ?? "Masa sahibi";
    const animate = !this.fresh;

    // ---- code plaque
    if (state.code !== this.code) {
      this.code = state.code;
      const chars = [...state.code.padEnd(4, "·")];
      this.tiles.replaceChildren(
        ...chars.map((ch, i) => {
          const t = h("span", "ks-menu-tile", { "aria-hidden": "true" }, ch);
          t.style.setProperty("--i", String(i));
          return t;
        }),
      );
      this.tiles.setAttribute("aria-label", `Masa kodu: ${state.code.split("").join(" ")}`);
      setText(this.urlText, state.code ? `${location.host}/r/${state.code}` : "");
      this.copyBtn.disabled = !state.code;
    }

    // ---- seats
    const botCount = players.reduce((n, p) => n + (p.bot ? 1 : 0), 0);
    setText(this.count, botCount ? `${players.length}/${MAX_PLAYERS} · 🤖 ${botCount}` : `${players.length}/${MAX_PLAYERS}`);
    let someoneReadied = false;
    let someoneJoined = false;
    this.seats.forEach((seat, i) => {
      const p = players[i];
      // The host fills the first empty chair (the server seats bots there too).
      const canAdd = isHost && !p && i === players.length;
      if (seat.add.hidden === canAdd) seat.add.hidden = !canAdd;
      if (!p) {
        if (seat.id !== "" || !seat.name.textContent) {
          seat.id = "";
          seat.ready = false;
          seat.li.className = "ks-menu-seat ks-menu-seat--empty";
          seat.li.style.removeProperty("--pc");
          seat.pc = "";
          seat.kick.hidden = true;
          setHtml(seat.portrait, "empty", emptyPortrait());
          setText(seat.name, EMPTY_SEATS[i % EMPTY_SEATS.length]!);
          setText(seat.sub, "");
          setText(seat.status, "");
          seat.li.setAttribute("aria-label", `Boş sandalye ${i + 1}`);
        }
        seat.li.classList.toggle("ks-menu-seat--open", canAdd);
        return;
      }
      const joined = seat.id !== p.id;
      if (joined) {
        seat.id = p.id;
        seat.li.classList.remove("ks-menu-seat--empty", "ks-menu-seat--open");
        seat.kick.disabled = false;
        if (animate) {
          replay(seat.li, "ks-menu-pop-in");
          someoneJoined = true;
        }
      }
      const isMe = p.id === myId;
      const isHostP = p.id === state.hostId;
      const ready = p.ready || p.bot; // bots are always ready
      const away = !p.connected && !p.bot;
      seat.li.classList.toggle("ks-menu-seat--me", isMe);
      seat.li.classList.toggle("ks-menu-seat--host", isHostP);
      seat.li.classList.toggle("ks-menu-seat--bot", p.bot);
      seat.li.classList.toggle("ks-menu-seat--ready", ready);
      seat.li.classList.toggle("ks-menu-seat--away", away);
      const kickable = isHost && p.bot;
      if (seat.kick.hidden === kickable) seat.kick.hidden = !kickable;
      if (kickable) setAttr(seat.kick, "aria-label", `${p.nickname} adlı botu masadan çıkar`);
      if (ready && !seat.ready && !joined && animate) {
        replay(seat.li, "ks-menu-hop");
        if (!isMe) someoneReadied = true;
      }
      seat.ready = ready;
      const hex = playerColor(p.color);
      if (seat.pc !== hex) {
        seat.pc = hex;
        seat.li.style.setProperty("--pc", hex);
      }
      setHtml(seat.portrait, `${p.animal}|${hex}|${ready}`, animalPortrait(p.animal, hex, ready ? "glad" : "smug"));
      setText(seat.name, p.nickname);
      setText(seat.sub, `${animalLabel(p.animal)} · ${PLAYER_COLOR_NAMES[p.color] ?? ""}`);
      setText(seat.status, away ? "Bağlantı koptu…" : ready ? "HAZIR ✓" : NOT_READY[hashIndex(p.id, NOT_READY.length)]!);
      const parts = [p.nickname, animalLabel(p.animal), PLAYER_COLOR_NAMES[p.color] ?? ""];
      if (p.bot) parts.push("bot");
      if (isHostP) parts.push("masa sahibi");
      if (isMe) parts.push("sen");
      parts.push(away ? "bağlantı koptu" : ready ? "hazır" : "hazır değil");
      setAttr(seat.li, "aria-label", parts.join(", "));
    });
    if (someoneReadied) this.cb.sound("chip");
    else if (someoneJoined) this.cb.sound("pop");

    // ---- my picker
    const takenAnimal = new Map<Animal, string>();
    const takenColor = new Map<number, string>();
    for (const p of players) {
      if (p.id === myId) continue;
      takenAnimal.set(p.animal, p.nickname);
      takenColor.set(p.color, p.nickname);
    }
    this.myAnimal = me?.animal ?? "";
    this.myColor = me?.color ?? -1;
    const myHex = playerColor(me ? me.color : 0);
    ANIMALS.forEach((a, i) => {
      const b = this.animalBtns[i]!;
      const owner = takenAnimal.get(a.id);
      const off = !me || owner !== undefined;
      if (b.disabled !== off) b.disabled = off;
      b.classList.toggle("ks-menu-taken", owner !== undefined);
      setAttr(b, "aria-checked", String(me?.animal === a.id));
      const label = owner !== undefined ? `${a.label} (${owner} seçti)` : a.label;
      setAttr(b, "aria-label", label);
      setAttr(b, "title", label);
      setHtml(b.firstElementChild as HTMLElement, `${a.id}|${myHex}`, animalPortrait(a.id, myHex));
    });
    rovingTabs(this.animalBtns, ANIMALS.findIndex((a) => a.id === me?.animal));
    PLAYER_COLORS.forEach((_, i) => {
      const b = this.colorBtns[i]!;
      const owner = takenColor.get(i);
      const off = !me || owner !== undefined;
      if (b.disabled !== off) b.disabled = off;
      b.classList.toggle("ks-menu-taken", owner !== undefined);
      setAttr(b, "aria-checked", String(me?.color === i));
      const label = owner !== undefined ? `${PLAYER_COLOR_NAMES[i]} (${owner} seçti)` : (PLAYER_COLOR_NAMES[i] ?? "");
      setAttr(b, "aria-label", label);
      setAttr(b, "title", label);
    });
    rovingTabs(this.colorBtns, me?.color ?? -1);
    setText(this.pickerNote, me?.ready ? "Hazırsın ama kılık değiştirmek serbest." : "");

    // ---- rules (live for everyone, editable by the host)
    const s = state.settings;
    const classicN = Math.max(players.length, MIN_PLAYERS);
    const autoLabel = `Otomatik (${classicRounds(classicN)})`;
    const autoOpt = this.turnsSel.options[0];
    if (autoOpt && autoOpt.textContent !== autoLabel) autoOpt.textContent = autoLabel;
    this.syncSeg(this.modeSeg, s.mode);
    setText(this.modeDesc, MODE_DESC[s.mode] ?? "");
    const royale = s.mode === "royale";
    this.turnsSel.hidden = royale;
    this.royaleNote.hidden = !royale;
    if (document.activeElement !== this.turnsSel && this.turnsSel.value !== String(s.turns)) this.turnsSel.value = String(s.turns);
    this.syncSeg(this.decisionSeg, s.decisionSec);
    if (this.loansBox.checked !== s.loans) this.loansBox.checked = s.loans;
    if (this.betsBox.checked !== s.sideBets) this.betsBox.checked = s.sideBets;
    setText(this.loansState, s.loans ? "Açık" : "Kapalı");
    setText(this.betsState, s.sideBets ? "Açık" : "Kapalı");
    for (const ctl of [this.turnsSel, this.loansBox, this.betsBox, ...this.modeSeg.buttons, ...this.decisionSeg.buttons]) {
      if (ctl.disabled !== !isHost) ctl.disabled = !isHost;
    }
    rovingTabs(this.modeSeg.buttons, this.modeSeg.values.indexOf(s.mode));
    rovingTabs(this.decisionSeg.buttons, this.decisionSeg.values.indexOf(s.decisionSec));
    this.el.classList.toggle("ks-menu-lobby--host", isHost);
    setText(this.rulesNote, isHost ? "Kurallar senin elinde, patron." : `Kuralları ${hostName} belirliyor.`);
    // Flash the rows that just changed so guests notice.
    const prev = this.prevSettings;
    if (prev && animate) {
      (Object.keys(this.rows) as (keyof SettingsView)[]).forEach((k) => {
        if (prev[k] !== s[k]) replay(this.rows[k], "ks-menu-flash");
      });
      if (!isHost && (Object.keys(this.rows) as (keyof SettingsView)[]).some((k) => prev[k] !== s[k])) this.cb.sound("pop");
    }
    this.prevSettings = { mode: s.mode, turns: s.turns, decisionSec: s.decisionSec, loans: s.loans, sideBets: s.sideBets };

    // ---- ready / start
    if (me) this.myReady = me.ready;
    this.readyBtn.disabled = !me;
    this.renderReady();
    // Bots count as present and ready gangsters.
    const present = players.filter((p) => p.connected || p.bot);
    const notReady = present.filter((p) => !p.ready && !p.bot);
    let reason = "";
    if (present.length < MIN_PLAYERS) {
      reason = isHost
        ? `En az ${MIN_PLAYERS} gangster lazım (botlar dahil). Kodu paylaş ya da boş sandalyeye 🤖 bot ekle!`
        : `En az ${MIN_PLAYERS} gangster lazım. Kodu paylaş!`;
    } else if (notReady.length === 1) {
      reason = notReady[0]!.id === myId ? "Bir sen kaldın: “Hazırım”a bas!" : `${notReady[0]!.nickname} daha hazır değil.`;
    } else if (notReady.length > 1) {
      reason = notReady.some((p) => p.id === myId) ? `${notReady.length} kişi hazır değil, sen de dahil.` : `${notReady.length} kişi daha hazır değil.`;
    }
    this.canStart = isHost && reason === "";
    this.startBtn.hidden = !isHost;
    setAttr(this.startBtn, "aria-disabled", String(!this.canStart));
    this.startBtn.classList.toggle("ks-menu-start--go", this.canStart);
    setAttr(this.startBtn, "title", this.canStart ? "Maçı başlat" : reason);
    if (isHost) reason = reason || (botCount ? `Herkes hazır (${botCount} bot dahil). Bas BAŞLAT'a, patron!` : "Herkes hazır. Bas BAŞLAT'a, patron!");
    else reason = reason ? `${reason} Sonra ${hostName} başlatacak.` : `Herkes hazır. ${ofName(hostName)} başlatması bekleniyor…`;
    setText(this.reason, reason);
    this.reason.classList.toggle("ks-menu-reason--go", this.canStart);

    this.fresh = false;
  }

  // ------------------------------------------------------------------ internals
  private segmented(parent: HTMLElement, labels: string[], values: (string | number)[], onPick: (v: string | number) => void): Segmented {
    const labelId = parent.firstElementChild?.id ?? "";
    const group = h("div", "ks-menu-seg", { role: "radiogroup" });
    if (labelId) group.setAttribute("aria-labelledby", labelId);
    const buttons = labels.map((label, i) => {
      const b = h("button", "ks-menu-seg-btn", { type: "button", role: "radio", "aria-checked": "false" }, label);
      b.addEventListener("click", () => {
        if (b.getAttribute("aria-checked") === "true") return;
        onPick(values[i]!);
      });
      group.appendChild(b);
      return b;
    });
    radioKeys(group, buttons, (i) => {
      if (buttons[i]!.getAttribute("aria-checked") !== "true") onPick(values[i]!);
    });
    parent.appendChild(group);
    return { group, buttons, values };
  }

  private syncSeg(seg: Segmented, value: string | number): void {
    seg.buttons.forEach((b, i) => setAttr(b, "aria-checked", String(seg.values[i] === value)));
  }

  private sendSetting(patch: SettingsMsg): void {
    if (!this.isHost) return;
    this.cb.sound("click");
    this.cb.onSettings(patch);
  }

  private pickAnimal(animal: Animal): void {
    if (animal === this.myAnimal) return;
    const b = this.animalBtns[ANIMALS.findIndex((a) => a.id === animal)];
    if (!b || b.disabled) return;
    replay(b, "ks-menu-boing");
    this.cb.sound("pop");
    this.cb.onAnimal(animal);
  }

  private pickColor(color: number): void {
    if (color === this.myColor) return;
    const b = this.colorBtns[color];
    if (!b || b.disabled) return;
    replay(b, "ks-menu-boing");
    this.cb.sound("chip");
    this.cb.onColor(color);
  }

  private addBot(): void {
    if (!this.isHost) return;
    const now = performance.now();
    if (now - this.lastAddBot < ADD_BOT_COOLDOWN_MS) return;
    this.lastAddBot = now;
    this.cb.onAddBot();
  }

  /** "Nasıl oynanır": three steps under the seats. Open by default; folding it is remembered. */
  private howTo(): HTMLElement {
    const box = h("details", "ks-menu-howto");
    box.open = readStorage(HOWTO_KEY) !== "0";
    const summary = h("summary", "ks-menu-howto-sum");
    summary.append(h("span", "ks-menu-howto-title", undefined, "📖 Nasıl oynanır?"), h("span", "ks-menu-howto-tag", undefined, "3 adımda"));
    summary.addEventListener("click", () => this.cb.sound(box.open ? "close" : "open"));
    box.addEventListener("toggle", () => writeStorage(HOWTO_KEY, box.open ? "1" : "0"));
    const steps = h("ol", "ks-menu-howto-steps");
    LOBBY_STEPS.forEach((step, i) => {
      const li = h("li", "ks-menu-howto-step");
      li.style.setProperty("--i", String(i));
      const icon = h("span", "ks-menu-howto-icon", { "aria-hidden": "true" }, step.icon);
      const text = h("span", "ks-menu-howto-text");
      const title = h("strong", "ks-menu-howto-step-title", undefined, step.title);
      text.append(title, h("span", "ks-menu-howto-step-desc", undefined, step.text));
      if (step.key) title.append(" ", h("kbd", "ks-key", undefined, step.key));
      li.append(h("span", "ks-menu-howto-no", { "aria-hidden": "true" }, String(i + 1)), icon, text);
      steps.appendChild(li);
    });
    box.append(summary, steps);
    return box;
  }

  private renderReady(): void {
    setAttr(this.readyBtn, "aria-pressed", String(this.myReady));
    setText(this.readyBtn, this.myReady ? "✓ Hazırsın" : "✋ Hazırım");
    this.readyBtn.classList.toggle("ks-menu-ready--on", this.myReady);
    setAttr(this.readyBtn, "title", this.myReady ? "Tekrar basarsan hazırlığını geri alırsın" : "Hazır olduğunu masaya bildir");
  }

  private async copyLink(): Promise<void> {
    if (!this.code) return;
    const url = `${location.origin}/r/${this.code}`;
    const ok = await copyText(url);
    if (ok) {
      replay(this.copyBtn, "ks-menu-copied");
      this.cb.sound("pop");
      this.cb.toast("Kopyalandı! Linki arkadaşlarına yolla.");
    } else {
      this.cb.sound("deny");
      this.cb.toast(`Kopyalanamadı. Link: ${url}`, 6000);
    }
  }
}
