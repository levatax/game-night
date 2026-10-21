// Lobby castaway list: one card per seat (portrait in the seat color, name, tourist, YOU / GUIDE / BOT tags, ready
// state, ping), bots show their role (Porter / Fisher / Guard / Cook) and the host can send them back (✕); empty
// seats invite a friend or (host) a helper bot. Adapted from games/bonk-brawl/client/src/ui/LobbyPlayers.ts.
// Owner: client-ui.

import { playerColor } from "../../../../../shared/constants";
import { characterName, t } from "../../../i18n";
import { pingLevel } from "../../content";
import { button, el, play, POP_KEYFRAMES, svg } from "../../dom";
import { ICON_BOT, ICON_CHECK, ICON_CLOSE, ICON_CROWN, ICON_PLUS, ICON_SIGNAL, portraitSvg } from "../../icons";
import type { LobbyPlayerModel } from "../../models";

interface SeatView {
  li: HTMLLIElement;
  signature: string;
  playerId: string | null;
  ready: boolean;
}

export interface SeatHandlers {
  onRemoveBot(id: string): void;
  onAddBot(): void;
}

function seatSignature(p: LobbyPlayerModel | undefined, isHost: boolean, canAddBot: boolean, firstEmpty: boolean): string {
  if (!p) return `empty|${isHost && canAddBot && firstEmpty}`;
  return [p.id, p.nickname, p.character, p.color, p.ready, p.host, p.bot, p.botRole, p.you, p.connected, Math.round(p.ping / 10), p.portrait.length, isHost].join("|");
}

/** Portrait: the rendered 3D portrait when Characters has one, else the SVG cartoon. */
export function portraitNode(p: Pick<LobbyPlayerModel, "character" | "portrait">): HTMLElement {
  if (p.portrait) {
    const img = el("img", "rr-portrait-img");
    img.src = p.portrait;
    img.alt = "";
    img.decoding = "async";
    return img;
  }
  return el("span", "rr-portrait-wrap", svg(portraitSvg(p.character)));
}

export class Seats {
  readonly el = el("ol", "rr-seats");
  private readonly views: SeatView[] = [];

  constructor(private readonly h: SeatHandlers) {}

  update(players: readonly LobbyPlayerModel[], maxPlayers: number, isHost: boolean, canAddBot: boolean): void {
    while (this.views.length < maxPlayers) {
      const li = el("li", "rr-seat");
      this.views.push({ li, signature: "", playerId: null, ready: false });
      this.el.append(li);
    }
    while (this.views.length > maxPlayers) this.views.pop()?.li.remove();
    const bySeat = new Map<number, LobbyPlayerModel>();
    for (const p of players) if (p.seat >= 0 && p.seat < maxPlayers) bySeat.set(p.seat, p);
    let firstEmpty = -1;
    for (let s = 0; s < maxPlayers; s++) if (!bySeat.has(s)) {
      firstEmpty = s;
      break;
    }
    this.views.forEach((v, seat) => this.render(v, seat, bySeat.get(seat), isHost, canAddBot, seat === firstEmpty));
  }

  private render(v: SeatView, seat: number, p: LobbyPlayerModel | undefined, isHost: boolean, canAddBot: boolean, firstEmpty: boolean): void {
    const signature = seatSignature(p, isHost, canAddBot, firstEmpty);
    if (signature === v.signature) return;
    v.signature = signature;
    const joined = !!p && v.playerId !== p.id;
    const becameReady = !!p && !joined && p.ready && !v.ready;
    v.playerId = p?.id ?? null;
    v.ready = p?.ready ?? false;
    v.li.replaceChildren();
    v.li.style.setProperty("--slot", p?.color ?? playerColor(seat));
    if (p) this.fill(v.li, p, isHost);
    else this.fillEmpty(v.li, seat, isHost && canAddBot && firstEmpty);
    if (joined) play(v.li, [{ transform: "scale(0.85) rotate(-2deg)", opacity: 0 }, { transform: "scale(1.04)", opacity: 1, offset: 0.6 }, { transform: "scale(1)" }], { duration: 420, easing: "ease-out" });
    if (becameReady) {
      const stamp = v.li.querySelector(".rr-seat__status");
      if (stamp) play(stamp, POP_KEYFRAMES, { duration: 380, easing: "ease-out" });
    }
  }

  private fill(li: HTMLLIElement, p: LobbyPlayerModel, isHost: boolean): void {
    li.className = "rr-seat rr-seat--filled";
    li.classList.toggle("is-you", p.you);
    li.classList.toggle("is-ready", p.ready && p.connected);
    li.classList.toggle("is-away", !p.connected && !p.bot);
    li.classList.toggle("is-bot", p.bot);
    const name = el("span", "rr-seat__name", p.nickname);
    name.title = p.nickname;
    const tags = el(
      "span",
      "rr-seat__tags",
      p.you ? el("span", "rr-tag rr-tag--you", t("menu.tagYou")) : null,
      p.host ? el("span", "rr-tag rr-tag--host", svg(ICON_CROWN), t("menu.tagHost")) : null,
      p.bot ? el("span", "rr-tag rr-tag--bot", svg(ICON_BOT), t("menu.tagBot")) : null,
    );
    const meta = el("div", "rr-seat__meta", this.status(p), el("span", "rr-seat__char", p.bot && p.botRole ? t(`characters.role_${p.botRole}`) : characterName(p.character)));
    if (!p.bot && p.connected && p.ping > 0) meta.append(el("span", `rr-seat__ping rr-ping--${pingLevel(p.ping)}`, svg(ICON_SIGNAL), `${Math.round(p.ping)} ms`));
    li.append(el("div", "rr-seat__avatar", portraitNode(p)), el("div", "rr-seat__body", el("div", "rr-seat__name-row", name, tags), meta));
    if (p.bot && p.botRole) li.title = `${t("menu.botRole", { role: t(`characters.role_${p.botRole}`) })} · ${t(`characters.role_${p.botRole}_desc`)}`;
    if (p.bot && isHost) {
      const remove = button("rr-btn rr-btn--icon rr-btn--tiny rr-seat__remove", svg(ICON_CLOSE));
      remove.title = t("menu.removeBot", { name: p.nickname });
      remove.setAttribute("aria-label", remove.title);
      const id = p.id;
      remove.addEventListener("click", () => this.h.onRemoveBot(id));
      li.append(remove);
    }
  }

  private status(p: LobbyPlayerModel): HTMLElement {
    if (p.bot) return el("span", "rr-seat__status rr-seat__status--bot", svg(ICON_CHECK), t("menu.statusReady"));
    if (!p.connected) return el("span", "rr-seat__status rr-seat__status--away", el("span", "rr-mini-spinner"), t("menu.statusAway"));
    if (p.ready) return el("span", "rr-seat__status rr-seat__status--ready", svg(ICON_CHECK), t("menu.statusReady"));
    return el("span", "rr-seat__status rr-seat__status--idle", t("menu.statusIdle"));
  }

  private fillEmpty(li: HTMLLIElement, seat: number, canAdd: boolean): void {
    li.className = "rr-seat rr-seat--empty";
    li.removeAttribute("title");
    const dots = el("span", "rr-waiting-dots", el("i"), el("i"), el("i"));
    li.append(
      el("div", "rr-seat__avatar rr-seat__avatar--empty", el("span", "rr-seat__slot", `P${seat + 1}`)),
      el("div", "rr-seat__body", el("span", "rr-seat__waiting", t("menu.seatWaiting"), dots), el("span", "rr-seat__invite", t("menu.seatInvite"))),
    );
    if (canAdd) {
      const add = button("rr-btn rr-btn--small rr-btn--go rr-seat__add", svg(ICON_PLUS), "🤖");
      add.title = t("menu.addBot");
      add.setAttribute("aria-label", t("menu.addBot"));
      add.addEventListener("click", () => this.h.onAddBot());
      li.append(add);
    }
  }
}
