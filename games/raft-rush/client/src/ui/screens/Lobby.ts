// Beach lobby (§4): the 3D preview island orbits in the middle (drawn by the app behind the UI), so everything
// hugs the edges: header (Leave, room code tiles + copy /r/CODE link), castaways on the left (portraits, ready,
// host crown, bot roles, add / remove bots), trip settings on the right (mode, difficulty, seed + biome preview),
// the tourist picker along the bottom, Ready / Set sail with the start hint. Adapted from
// games/bonk-brawl/client/src/ui/Lobby.ts. Owner: client-ui.
//
// Emits: leave, copyLink, character, ready, roomSettings, addBot, removeBot, start.

import type { CharacterId } from "../../../../shared/types";
import { t } from "../../i18n";
import type { Emitter } from "../../util/Emitter";
import { button, copyText, el, isTyping, play, POP_KEYFRAMES, setHidden, setText, svg, tr } from "../dom";
import { ICON_BACK, ICON_CHECK, ICON_LINK } from "../icons";
import type { LobbyModel, UiEventMap } from "../models";
import { Optimistic } from "./lobby/optimistic";
import { Seats } from "./lobby/Seats";
import { TouristPicker } from "./lobby/TouristPicker";
import { TripSettings } from "./lobby/TripSettings";

const COPIED_MS = 1800;
const COPY_FALLBACK_MS = 9000;
const START_COOLDOWN_MS = 1500;

export class LobbyScreen {
  readonly el = el("section", "rr-screen rr-screen--lobby");
  private readonly seats: Seats;
  private readonly picker: TouristPicker;
  private readonly trip: TripSettings;
  private readonly codeTiles = el("div", "rr-code__tiles");
  private readonly copyBtn = button("rr-btn rr-btn--small rr-code__copy");
  private readonly copyLabel = el("span", "", t("menu.copyLink"));
  private readonly copyFallback = el("input", "rr-code__fallback");
  private readonly seatsTitle = el("p", "rr-panel__eyebrow");
  private readonly readyBtn = button("rr-btn rr-btn--big rr-lobby__ready");
  private readonly readyLabel = el("span", "rr-btn__label");
  private readonly startBtn = button("rr-btn rr-btn--primary rr-btn--big rr-lobby__start");
  private readonly startHint = el("p", "rr-lobby__hint");
  private readonly soloNote = el("p", "rr-lobby__solo");
  private readonly waitHost = el("p", "rr-lobby__wait");
  private readonly character = new Optimistic<CharacterId>();
  private readonly ready = new Optimistic<boolean>();
  private model: LobbyModel | null = null;
  private code = "";
  private copiedTimer = 0;
  private startCooldownUntil = 0;
  private waitText = "";

  constructor(private readonly events: Emitter<UiEventMap>) {
    this.el.setAttribute("aria-label", t("menu.lobbyTitle"));
    this.seats = new Seats({
      onRemoveBot: (id) => this.events.emit("removeBot", { id }),
      onAddBot: () => this.events.emit("addBot", undefined),
    });
    this.picker = new TouristPicker((c) => this.selectCharacter(c));
    this.trip = new TripSettings((patch) => this.events.emit("roomSettings", patch));

    // Bots are added from the first empty seat (host); Ready / Set sail sit next to the tourist picker.
    const left = el("div", "rr-panel rr-lobby__seats", el("div", "rr-panel__head", this.seatsTitle), this.seats.el);
    const right = el("div", "rr-lobby__side", this.trip.el);
    this.el.append(this.buildHeader(), el("div", "rr-lobby__body", left, el("div", "rr-lobby__stage"), right), el("div", "rr-lobby__bottom", this.picker.el, this.buildActions()));
    document.addEventListener("keydown", (e) => this.onKey(e));
  }

  update(model: LobbyModel): void {
    this.model = model;
    this.renderCode(model.code);
    const humans = model.players.filter((p) => !p.bot).length;
    setText(this.seatsTitle, `🏝️ ${t("menu.seatsTitle", { n: model.players.length, max: model.maxPlayers })}`);
    this.seats.update(model.players, model.maxPlayers, model.isHost, model.canAddBot);
    const you = model.players.find((p) => p.id === model.youId);
    this.picker.update(this.character.resolve(you?.character ?? "kaptan"), model.players);
    const host = model.players.find((p) => p.host);
    this.trip.update(model, host?.nickname ?? "");
    this.renderActions(model, humans);
  }

  /* ------------------------------------------------------------- building */

  private buildHeader(): HTMLElement {
    const leave = button("rr-btn rr-btn--small rr-lobby__leave", svg(ICON_BACK), t("menu.leave"));
    leave.addEventListener("click", () => this.events.emit("leave", undefined));
    this.copyBtn.append(svg(ICON_LINK), this.copyLabel);
    this.copyBtn.addEventListener("click", () => void this.copyLink());
    this.codeTiles.setAttribute("role", "text");
    const fallback = this.copyFallback;
    fallback.readOnly = true;
    fallback.hidden = true;
    fallback.setAttribute("aria-label", t("menu.copyFallback"));
    fallback.title = t("menu.copyFallback");
    fallback.addEventListener("blur", () => (fallback.hidden = true));
    const code = el("div", "rr-code", el("span", "rr-code__label", t("menu.roomCode")), this.codeTiles, this.copyBtn, fallback);
    return el("header", "rr-lobby__header", leave, el("h1", "rr-lobby__title", `🏖️ ${t("menu.lobbyTitle")}`), code);
  }

  private buildActions(): HTMLElement {
    this.readyBtn.append(el("span", "rr-lobby__ready-icon", svg(ICON_CHECK)), this.readyLabel);
    this.readyBtn.addEventListener("click", () => this.toggleReady());
    this.startBtn.append(el("span", "rr-btn__label", `⛵ ${t("menu.start")}`));
    this.startBtn.addEventListener("click", () => this.start());
    this.startHint.id = "rr-start-hint";
    this.startHint.setAttribute("aria-live", "polite");
    this.waitHost.setAttribute("aria-live", "polite");
    return el("div", "rr-panel rr-lobby__actions", this.soloNote, el("div", "rr-lobby__buttons", this.readyBtn, this.startBtn), this.startHint, this.waitHost);
  }

  /* ------------------------------------------------------------ rendering */

  private renderCode(code: string): void {
    if (code === this.code) return;
    this.code = code;
    this.codeTiles.replaceChildren();
    this.codeTiles.setAttribute("aria-label", `${t("menu.roomCode")} ${code.split("").join(" ")}`);
    [...code].forEach((ch, i) => {
      const tile = el("span", "rr-code__tile", ch);
      tile.style.setProperty("--i", String(i));
      tile.setAttribute("aria-hidden", "true");
      this.codeTiles.append(tile);
    });
  }

  private renderActions(model: LobbyModel, humans: number): void {
    const ready = this.ready.resolve(model.ready);
    this.readyBtn.setAttribute("aria-pressed", String(ready));
    this.readyBtn.classList.toggle("is-ready", ready);
    this.readyBtn.classList.toggle("rr-btn--go", !ready);
    setText(this.readyLabel, ready ? t("menu.readyOn") : t("menu.readyBtn"));
    this.readyBtn.title = ready ? t("menu.readyTitleOff") : t("menu.readyTitleOn");

    const isHost = model.isHost;
    setHidden(this.startBtn, !isHost);
    setHidden(this.waitHost, isHost);
    const cooling = performance.now() < this.startCooldownUntil;
    this.startBtn.disabled = !model.canStart || cooling;
    this.startBtn.classList.toggle("is-go", model.canStart);
    if (model.startHint) this.startBtn.setAttribute("aria-describedby", this.startHint.id);
    else this.startBtn.removeAttribute("aria-describedby");
    const hint = isHost ? (model.canStart ? t("menu.startGo") : model.startHint ? tr(model.startHint, "menu") : "") : "";
    setText(this.startHint, hint);
    setHidden(this.startHint, !hint);
    this.startHint.classList.toggle("is-go", isHost && model.canStart);

    const bots = model.players.length - humans;
    const solo = humans === 1 && bots === 0 && model.autoBots > 0;
    setHidden(this.soloNote, !solo);
    if (solo) setText(this.soloNote, `🤖 ${t("menu.soloBots", { n: model.autoBots })}`);

    const host = model.players.find((p) => p.host);
    const waitText = t("menu.waitHost", { name: host ? host.nickname : "?" });
    if (waitText !== this.waitText) {
      this.waitText = waitText;
      this.waitHost.replaceChildren(waitText, el("span", "rr-waiting-dots", el("i"), el("i"), el("i")));
    }
  }

  /* ------------------------------------------------------------- actions */

  private selectCharacter(character: CharacterId): void {
    if (!this.model) return;
    this.character.set(character);
    this.update(this.model);
    this.events.emit("character", { character });
  }

  private toggleReady(): void {
    if (!this.model) return;
    const next = !this.ready.resolve(this.model.ready);
    this.ready.set(next);
    this.update(this.model);
    play(this.readyBtn, POP_KEYFRAMES, { duration: 320, easing: "ease-out" });
    this.events.emit("ready", { ready: next });
  }

  private start(): void {
    if (!this.model?.canStart) return;
    this.startCooldownUntil = performance.now() + START_COOLDOWN_MS;
    this.startBtn.disabled = true;
    window.setTimeout(() => this.model && this.update(this.model), START_COOLDOWN_MS + 100);
    this.events.emit("start", undefined);
  }

  private async copyLink(): Promise<void> {
    if (!this.model) return;
    const url = this.model.link || `${location.origin}/r/${this.model.code}`;
    this.events.emit("copyLink", undefined);
    const ok = await copyText(url);
    window.clearTimeout(this.copiedTimer);
    if (!ok) return this.showCopyFallback(url);
    this.copyBtn.classList.add("is-copied");
    this.copyBtn.replaceChildren(svg(ICON_CHECK), t("menu.copied"));
    play(this.copyBtn, POP_KEYFRAMES, { duration: 300 });
    this.copiedTimer = window.setTimeout(() => {
      this.copyBtn.classList.remove("is-copied");
      this.copyBtn.replaceChildren(svg(ICON_LINK), this.copyLabel);
    }, COPIED_MS);
  }

  /** Clipboard blocked: show the link pre-selected so Ctrl/Cmd+C works. */
  private showCopyFallback(url: string): void {
    this.events.emit("sound", { name: "uiError" });
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
    if (document.querySelector(".rr-ui .rr-modal:not([hidden])")) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      this.picker.step(e.key === "ArrowLeft" ? -1 : 1);
    }
  }
}
