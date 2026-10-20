// Lobby player cards: MAX_PLAYERS seats by slot. Owner: client-ui.

import { CHARACTERS, MAX_PLAYERS, playerColor } from "../../../shared/constants";
import { el, play, POP_KEYFRAMES, svg } from "./dom";
import { formatPing, pingLevel } from "./format";
import { ICON_CHECK, ICON_CROWN, ICON_SIGNAL } from "./icons";
import type { LobbyPlayerCard } from "./models";

interface Seat {
  li: HTMLLIElement;
  signature: string;
  playerId: string | null;
  ready: boolean;
}

function seatSignature(p: LobbyPlayerCard | undefined, matchRunning: boolean): string {
  if (!p) return "empty";
  return [p.id, p.nickname, p.character, p.emoji, p.color, p.ready, p.isHost, p.isYou, p.connected, p.spectator, Math.round(p.ping / 5), matchRunning].join("|");
}

export class LobbyPlayers {
  readonly el = el("ol", "seats");
  private readonly seats: Seat[] = [];
  private matchRunning = false;

  constructor() {
    this.el.setAttribute("aria-label", "Players");
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const li = el("li", "seat");
      this.seats.push({ li, signature: "", playerId: null, ready: false });
      this.el.append(li);
    }
  }

  /** `matchRunning`: the room is mid-match (we're spectating), so seats show "Playing" instead of ready state. */
  update(players: readonly LobbyPlayerCard[], matchRunning = false): void {
    const bySlot = new Map<number, LobbyPlayerCard>();
    for (const p of players) if (p.slot >= 0 && p.slot < MAX_PLAYERS) bySlot.set(p.slot, p);
    this.matchRunning = matchRunning;
    this.seats.forEach((seat, slot) => this.renderSeat(seat, slot, bySlot.get(slot)));
  }

  private renderSeat(seat: Seat, slot: number, player: LobbyPlayerCard | undefined): void {
    const signature = seatSignature(player, this.matchRunning);
    if (signature === seat.signature) return;
    seat.signature = signature;

    const joined = !!player && seat.playerId !== player.id;
    const becameReady = !!player && !joined && player.ready && !seat.ready;
    seat.playerId = player?.id ?? null;
    seat.ready = player?.ready ?? false;

    seat.li.replaceChildren();
    seat.li.style.setProperty("--slot", player?.color ?? playerColor(slot));
    if (player) this.fillSeat(seat.li, player);
    else this.fillEmpty(seat.li, slot);

    if (joined) play(seat.li, [{ transform: "scale(0.85) rotate(-2deg)", opacity: 0 }, { transform: "scale(1.04)", opacity: 1, offset: 0.6 }, { transform: "scale(1)" }], { duration: 420, easing: "ease-out" });
    if (becameReady) {
      const stamp = seat.li.querySelector(".seat__status");
      if (stamp) play(stamp, POP_KEYFRAMES, { duration: 380, easing: "ease-out" });
    }
  }

  private fillSeat(li: HTMLLIElement, p: LobbyPlayerCard): void {
    li.className = "seat seat--filled";
    li.classList.toggle("is-you", p.isYou);
    li.classList.toggle("is-ready", p.ready && p.connected);
    li.classList.toggle("is-away", !p.connected);

    const avatar = el("div", "seat__avatar", el("span", "seat__emoji", p.emoji));
    const name = el("span", "seat__name", p.nickname);
    name.title = p.nickname;
    const ping = p.connected ? el("span", `seat__ping ping--${pingLevel(p.ping)}`, svg(ICON_SIGNAL), formatPing(p.ping)) : null;
    const nameRow = el("div", "seat__name-row", name, p.isYou ? el("span", "tag tag--you", "YOU") : null);
    const meta = el("div", "seat__meta", this.statusFor(p), el("span", "seat__char", CHARACTERS[p.character]?.name ?? p.character), ping);

    li.append(avatar, el("div", "seat__body", nameRow, meta));
    if (p.isHost) li.append(el("span", "seat__host", svg(ICON_CROWN), "HOST"));
    li.setAttribute("aria-label", this.describe(p));
  }

  private statusFor(p: LobbyPlayerCard): HTMLElement {
    if (!p.connected) return el("span", "seat__status seat__status--away", el("span", "mini-spinner"), "Reconnecting…");
    if (p.spectator) return el("span", "seat__status seat__status--watch", "👀 Watching");
    if (this.matchRunning) return el("span", "seat__status seat__status--playing", "🎮 Playing");
    if (p.ready) return el("span", "seat__status seat__status--ready", svg(ICON_CHECK), "READY");
    return el("span", "seat__status seat__status--idle", "Not ready");
  }

  private describe(p: LobbyPlayerCard): string {
    const parts = [p.nickname, CHARACTERS[p.character]?.name ?? p.character];
    if (p.isYou) parts.push("you");
    if (p.isHost) parts.push("host");
    parts.push(!p.connected ? "reconnecting" : p.spectator ? "watching" : this.matchRunning ? "playing" : p.ready ? "ready" : "not ready");
    return parts.join(", ");
  }

  private fillEmpty(li: HTMLLIElement, slot: number): void {
    li.className = "seat seat--empty";
    li.removeAttribute("aria-label");
    const dots = el("span", "waiting-dots", el("i"), el("i"), el("i"));
    li.append(
      el("div", "seat__avatar seat__avatar--empty", el("span", "seat__slot", `P${slot + 1}`)),
      el("div", "seat__body", el("span", "seat__waiting", "Waiting for player", dots), el("span", "seat__invite", "Share the code!")),
    );
  }
}
