// Lobby screen. Owner: client-ui.

import { MAX_PLAYERS } from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";
import type { Emitter } from "../util/Emitter";
import { CharacterCarousel } from "./CharacterCarousel";
import { button, el, isTyping, play, POP_KEYFRAMES, setHidden, setText, svg } from "./dom";
import { ICON_BACK, ICON_CHECK, ICON_LINK } from "./icons";
import { LobbyPlayers } from "./LobbyPlayers";
import { LobbySettings } from "./LobbySettings";
import type { LobbyModel, UiEventMap } from "./models";
import { Optimistic } from "./optimistic";

const COPIED_MS = 1800;
const COPY_FALLBACK_MS = 9000;

/** Copy text with the async clipboard API, falling back to a hidden textarea (http / old browsers). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/**
 * Big room code + "Copy link" (navigator.clipboard.writeText(shareUrl), toast "Link copied!"),
 * 4 player cards (nickname, character emoji/name, slot color, ready ✓, host crown icon, ping,
 * "Waiting for player…" for empty seats), character carousel (← → arrows over CHARACTER_IDS,
 * name, ability name + description from CHARACTERS) around `previewCanvas` (the App renders the
 * 3D turntable into it), Ready toggle, and host-only settings: map (MAP_CHOICES), rounds
 * (ROUND_OPTIONS), power-ups on/off, Start (disabled with startHint unless canStart).
 * Non-hosts see the settings read-only. Spectators see "Match in progress — you'll join the next one".
 * Emits selectCharacter, setReady, updateSettings, startMatch, leaveRoom.
 */
export class LobbyScreen {
  readonly el: HTMLElement = document.createElement("section");
  /** 3D character preview target (~320×320 CSS px; App sizes the renderer to its client size). */
  readonly previewCanvas: HTMLCanvasElement = document.createElement("canvas");

  private readonly events: Emitter<UiEventMap>;
  private readonly players = new LobbyPlayers();
  private readonly carousel: CharacterCarousel;
  private readonly settings: LobbySettings;

  private readonly codeTiles = el("div", "room-code__tiles");
  private readonly copyBtn = button("btn btn--small room-code__copy");
  private readonly copyLabel = el("span", "", "Copy link");
  private readonly copyFallback = el("input", "room-code__fallback");
  private readonly countEl = el("span", "lobby__count");
  private readonly seatsTitle = el("p", "panel__eyebrow");
  private readonly notice = el("p", "lobby__notice");
  private readonly readyBtn = button("btn btn--big lobby__ready");
  private readonly readyLabel = el("span", "btn__label");
  private readonly startBtn = button("btn btn--primary btn--big lobby__start");
  private readonly startHint = el("p", "lobby__hint");
  private readonly waitHost = el("p", "lobby__wait");

  private readonly character = new Optimistic<CharacterId>();
  private readonly ready = new Optimistic<boolean>();
  private model: LobbyModel | null = null;
  private code = "";
  private copiedTimer = 0;
  private startCooldownUntil = 0;
  private waitText = "";

  constructor(events: Emitter<UiEventMap>) {
    this.events = events;
    this.el.className = "screen screen--lobby";
    this.el.setAttribute("aria-label", "Lobby");
    this.carousel = new CharacterCarousel(this.previewCanvas, (c) => this.selectCharacter(c));
    this.settings = new LobbySettings((patch) => this.events.emit("updateSettings", patch));

    const main = el("div", "lobby__main", this.buildSeatsPanel(), this.carousel.el, this.buildSideColumn());
    this.el.append(this.buildHeader(), main);
    this.notice.hidden = true;
    document.addEventListener("keydown", (e) => this.onKey(e));
  }

  update(model: LobbyModel): void {
    this.model = model;
    this.renderCode(model.code);
    setText(this.countEl, `${model.players.length}/${MAX_PLAYERS} players`);
    setText(this.seatsTitle, `Players · ${model.players.length}/${MAX_PLAYERS}`);
    this.players.update(model.players, model.phase !== "lobby");
    this.renderSpectator(model);
    this.renderCarousel(model);
    this.renderSettings(model);
    this.renderActions(model);
  }

  /* ------------------------------------------------------------- building */

  private buildHeader(): HTMLElement {
    const leave = button("btn btn--small lobby__leave", svg(ICON_BACK), "Leave");
    leave.addEventListener("click", () => this.events.emit("leaveRoom", undefined));

    this.copyBtn.append(svg(ICON_LINK), this.copyLabel);
    this.copyBtn.addEventListener("click", () => void this.copyLink());
    this.codeTiles.setAttribute("role", "text");

    const fallback = this.copyFallback;
    fallback.readOnly = true;
    fallback.hidden = true;
    fallback.setAttribute("aria-label", "Room link: press Ctrl+C or Cmd+C to copy");
    fallback.title = "Press Ctrl+C / Cmd+C to copy";
    fallback.addEventListener("blur", () => (fallback.hidden = true));
    const code = el("div", "room-code", el("span", "room-code__label", "Room code"), this.codeTiles, this.copyBtn, fallback);
    return el("header", "lobby__header", leave, code, this.countEl);
  }

  private buildSeatsPanel(): HTMLElement {
    return el("div", "panel lobby__seats", this.seatsTitle, this.players.el);
  }

  private buildSideColumn(): HTMLElement {
    this.readyBtn.append(el("span", "lobby__ready-icon", svg(ICON_CHECK)), this.readyLabel);
    this.readyBtn.dataset.sound = "toggle";
    this.readyBtn.addEventListener("click", () => this.toggleReady());

    this.startBtn.dataset.sound = "confirm";
    this.startBtn.append(el("span", "btn__label", "Start match"), el("span", "lobby__start-arrow", "▶"));
    this.startBtn.addEventListener("click", () => this.start());
    this.startHint.id = "bb-start-hint";
    this.startHint.setAttribute("aria-live", "polite");
    this.waitHost.setAttribute("aria-live", "polite");

    const actions = el("div", "panel lobby__actions", this.notice, this.readyBtn, this.startBtn, this.startHint, this.waitHost);
    return el("div", "lobby__side", this.settings.el, actions);
  }

  /* ------------------------------------------------------------ rendering */

  private renderCode(code: string): void {
    if (code === this.code) return;
    this.code = code;
    this.codeTiles.replaceChildren();
    this.codeTiles.setAttribute("aria-label", `Room code ${code.split("").join(" ")}`);
    [...code].forEach((ch, i) => {
      const tile = el("span", "room-code__tile", ch);
      tile.style.setProperty("--i", String(i));
      tile.setAttribute("aria-hidden", "true");
      this.codeTiles.append(tile);
    });
  }

  private renderSpectator(model: LobbyModel): void {
    const watching = model.you.spectator || model.phase !== "lobby";
    setHidden(this.notice, !watching);
    if (watching) setText(this.notice, "👀 Match in progress — you'll join the next one");
  }

  private renderCarousel(model: LobbyModel): void {
    const you = model.players.find((p) => p.isYou);
    this.carousel.update({
      character: this.character.resolve(model.you.character),
      players: model.players,
      youId: model.you.id,
      color: you?.color ?? "#FFCF33",
      disabled: model.phase !== "lobby",
    });
  }

  private renderSettings(model: LobbyModel): void {
    const host = model.players.find((p) => p.isHost);
    this.settings.update(model.settings, model.you.isHost, host && !host.isYou ? host.nickname : "");
  }

  private renderActions(model: LobbyModel): void {
    const ready = this.ready.resolve(model.you.ready);
    const canReady = model.phase === "lobby" && !model.you.spectator;
    this.readyBtn.disabled = !canReady;
    this.readyBtn.setAttribute("aria-pressed", String(ready));
    this.readyBtn.classList.toggle("is-ready", ready);
    this.readyBtn.classList.toggle("btn--go", !ready);
    setText(this.readyLabel, ready ? "Ready!" : "I'm ready");
    this.readyBtn.title = ready ? "Click to un-ready" : "Let everyone know you're set";

    const isHost = model.you.isHost;
    setHidden(this.startBtn, !isHost);
    setHidden(this.waitHost, isHost || !canReady);
    const cooling = performance.now() < this.startCooldownUntil;
    this.startBtn.disabled = !model.canStart || cooling;
    this.startBtn.classList.toggle("is-ready", model.canStart);
    if (model.startHint) this.startBtn.setAttribute("aria-describedby", this.startHint.id);
    else this.startBtn.removeAttribute("aria-describedby");
    const hint = isHost ? (model.canStart ? "Everyone's ready. Let's bonk!" : model.startHint) : "";
    setText(this.startHint, hint);
    setHidden(this.startHint, !hint);
    this.startHint.classList.toggle("is-go", isHost && model.canStart);

    const host = model.players.find((p) => p.isHost);
    const waitText = `Waiting for ${host ? host.nickname : "the host"} to start`;
    if (waitText !== this.waitText) {
      this.waitText = waitText;
      this.waitHost.replaceChildren(waitText, el("span", "waiting-dots", el("i"), el("i"), el("i")));
    }
  }

  /* ------------------------------------------------------------- actions */

  private selectCharacter(character: CharacterId): void {
    if (!this.model || this.model.phase !== "lobby") return;
    this.character.set(character);
    this.renderCarousel(this.model);
    this.events.emit("selectCharacter", { character });
  }

  private toggleReady(): void {
    if (!this.model) return;
    const next = !this.ready.resolve(this.model.you.ready);
    this.ready.set(next);
    this.renderActions(this.model);
    play(this.readyBtn, POP_KEYFRAMES, { duration: 320, easing: "ease-out" });
    this.events.emit("setReady", { ready: next });
  }

  private start(): void {
    if (!this.model?.canStart) return;
    this.startCooldownUntil = performance.now() + 1500;
    this.startBtn.disabled = true;
    window.setTimeout(() => this.model && this.renderActions(this.model), 1600);
    this.events.emit("startMatch", undefined);
  }

  private async copyLink(): Promise<void> {
    if (!this.model) return;
    const url = this.model.shareUrl || `${location.origin}/r/${this.model.code}`;
    const ok = await copyText(url);
    window.clearTimeout(this.copiedTimer);
    if (!ok) return this.showCopyFallback(url);
    this.copyBtn.classList.add("is-copied");
    this.copyBtn.replaceChildren(svg(ICON_CHECK), "Link copied!");
    play(this.copyBtn, POP_KEYFRAMES, { duration: 300 });
    this.copiedTimer = window.setTimeout(() => {
      this.copyBtn.classList.remove("is-copied");
      this.copyBtn.replaceChildren(svg(ICON_LINK), this.copyLabel);
    }, COPIED_MS);
  }

  /** Clipboard blocked: show the link pre-selected so Ctrl/Cmd+C works. */
  private showCopyFallback(url: string): void {
    this.events.emit("uiSound", { kind: "error" });
    const field = this.copyFallback;
    field.value = url;
    field.hidden = false;
    field.focus();
    field.select();
    play(field, POP_KEYFRAMES, { duration: 260 });
    this.copiedTimer = window.setTimeout(() => (field.hidden = true), COPY_FALLBACK_MS);
  }

  private onKey(e: KeyboardEvent): void {
    if (this.el.hidden || this.el.inert || e.repeat || isTyping()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      this.carousel.step(e.key === "ArrowLeft" ? -1 : 1);
    }
  }
}
