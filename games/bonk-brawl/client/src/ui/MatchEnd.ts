// Match-end podium + stats. Owner: client-ui.

import { PLAYER_COLORS } from "../../../shared/constants";
import type { Emitter } from "../util/Emitter";
import { button, el, play, setHidden, setOutlinedText, setText, svg } from "./dom";
import { ordinal } from "./format";
import { ICON_CROWN } from "./icons";
import type { MatchEndModel, PodiumEntry, UiEventMap } from "./models";

const CONFETTI_PIECES = 46;
const CONFETTI_COLORS = [...PLAYER_COLORS, "#FFFFFF", "#8E6CFF", "#3FD6C6"];
/** Podium columns left → right: 2nd, 1st, 3rd. */
const PODIUM_ORDER = [2, 1, 3];
/** Reveal order: 3rd, then 2nd, then the winner. */
const REVEAL_DELAY_MS: Record<number, number> = { 3: 200, 2: 450, 1: 760 };
const MEDAL: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉", 4: "🕳️" };

type StatKey = "hits" | "catches" | "ringOuts" | "accuracy";

const AWARDS: ReadonlyArray<{ key: StatKey; icon: string; title: string; unit: string }> = [
  { key: "hits", icon: "💥", title: "Bonk Machine", unit: "hits" },
  { key: "catches", icon: "🧤", title: "Safe Hands", unit: "catches" },
  { key: "ringOuts", icon: "🌀", title: "Edge Lord", unit: "ring-outs" },
  { key: "accuracy", icon: "🎯", title: "Sharpshooter", unit: "% accuracy" },
];

function entriesSignature(entries: readonly PodiumEntry[]): string {
  return entries.map((e) => [e.id, e.place, e.name, e.emoji, e.color, e.points, e.isYou, Object.values(e.stats).join(",")].join("|")).join(";");
}

/** The single best player for a stat (no award on ties or zero). */
function awardWinner(entries: readonly PodiumEntry[], key: StatKey): PodiumEntry | null {
  let best: PodiumEntry | null = null;
  let tie = false;
  for (const e of entries) {
    const v = e.stats[key];
    if (!best || v > best.stats[key]) {
      best = e;
      tie = false;
    } else if (v === best.stats[key]) {
      tie = true;
    }
  }
  return best && !tie && best.stats[key] > 0 ? best : null;
}

/**
 * Podium 1st/2nd/3rd (4th drawn "falling into the void" with a CSS tumble animation), confetti
 * (CSS), per-player stats table (hits, catches, ring-outs, accuracy %), countdown to auto-lobby,
 * buttons Rematch (rematch {ready:true}) and Back to lobby (rematch {ready:false}), both disabled
 * until canRematch; plus a small "Leave" link (leaveRoom).
 */
export class MatchEndScreen {
  readonly el: HTMLElement = document.createElement("section");

  private readonly events: Emitter<UiEventMap>;
  private readonly confetti = el("div", "confetti");
  private readonly eyebrow = el("p", "match-end__eyebrow", "Match over");
  private readonly title = el("h1", "match-end__title outlined");
  private readonly podium = el("div", "podium");
  private readonly statsBody = el("tbody");
  private readonly awards = el("ul", "awards");
  private readonly rematchBtn = button("btn btn--primary btn--big match-end__rematch", el("span", "btn__label", "Rematch!"));
  private readonly lobbyBtn = button("btn btn--big match-end__lobby", el("span", "btn__label", "Back to lobby"));
  private readonly leaveBtn = button("link-btn match-end__leave", "Leave room");
  private readonly autoNote = el("p", "match-end__auto");
  private signature = "";
  private chosen: boolean | null = null;
  private canRematch: boolean | null = null;

  constructor(events: Emitter<UiEventMap>) {
    this.events = events;
    this.el.className = "screen screen--match-end";
    this.el.setAttribute("aria-label", "Match results");
    this.el.append(this.confetti, this.buildLayout());
  }

  update(model: MatchEndModel): void {
    const signature = entriesSignature(model.entries);
    if (signature !== this.signature) {
      const fresh = this.signature === "";
      this.signature = signature;
      this.chosen = null;
      this.renderTitle(model);
      this.renderPodium(model.entries);
      this.renderStats(model.entries);
      this.renderAwards(model.entries);
      if (fresh || !this.confetti.hasChildNodes()) this.launchConfetti();
    }
    this.renderActions(model);
  }

  /** Called when the screen becomes visible: fresh choice state and a new burst of confetti. */
  onShow(): void {
    this.chosen = null;
    this.launchConfetti();
  }

  /* ------------------------------------------------------------- building */

  private buildLayout(): HTMLElement {
    this.rematchBtn.addEventListener("click", () => this.choose(true));
    this.lobbyBtn.addEventListener("click", () => this.choose(false));
    this.leaveBtn.addEventListener("click", () => this.events.emit("leaveRoom", undefined));
    this.autoNote.setAttribute("aria-live", "polite");

    const head = el("header", "match-end__head", this.eyebrow, this.title);
    const stage = el("div", "match-end__stage", this.podium);
    const statsTable = el("table", "stats-table", this.statsHead(), this.statsBody);
    const stats = el("div", "panel match-end__stats", el("p", "panel__eyebrow", "Match stats"), statsTable, this.awards);
    const actions = el("div", "match-end__actions", this.rematchBtn, this.lobbyBtn);
    const foot = el("footer", "match-end__foot", actions, el("div", "match-end__meta", this.autoNote, this.leaveBtn));
    return el("div", "match-end__layout", head, stage, stats, foot);
  }

  private statsHead(): HTMLElement {
    const cols: Array<[string, string]> = [
      ["", "Place"],
      ["Player", "Player"],
      ["Pts", "Points"],
      ["💥", "Hits"],
      ["🧤", "Catches"],
      ["🌀", "Ring-outs"],
      ["🎯", "Accuracy"],
    ];
    const tr = el("tr");
    for (const [label, title] of cols) {
      const th = el("th", "", label);
      th.title = title;
      th.scope = "col";
      tr.append(th);
    }
    return el("thead", "", tr);
  }

  /* ------------------------------------------------------------ rendering */

  private renderTitle(model: MatchEndModel): void {
    const winner = model.entries.find((e) => e.id === model.winnerId) ?? model.entries[0];
    this.title.style.setProperty("--slot", winner?.color ?? "#FFCF33");
    setOutlinedText(this.title, winner ? `${winner.name} wins the match!` : "Match over!");
    if (winner?.isYou) setText(this.eyebrow, "🎉 Champion of the island 🎉");
    else setText(this.eyebrow, "Match over");
    play(this.title, [
      { transform: "scale(0.3) rotate(-8deg)", opacity: 0 },
      { transform: "scale(1.12) rotate(2deg)", opacity: 1, offset: 0.6 },
      { transform: "none", opacity: 1 },
    ], { duration: 620, easing: "cubic-bezier(.3,1.3,.5,1)" });
  }

  private renderPodium(entries: readonly PodiumEntry[]): void {
    const byPlace = new Map(entries.map((e) => [e.place, e] as const));
    const columns: HTMLElement[] = [];
    for (const place of PODIUM_ORDER) {
      const entry = byPlace.get(place);
      if (entry) columns.push(this.podiumColumn(entry, REVEAL_DELAY_MS[place] ?? 0));
    }
    const fourth = entries.reduce<PodiumEntry | undefined>((last, e) => (e.place >= 4 && (!last || e.place > last.place) ? e : last), undefined);
    this.podium.replaceChildren(...columns);
    if (fourth) this.podium.append(this.voidColumn(fourth));
    this.podium.classList.toggle("has-void", !!fourth);
  }

  private podiumColumn(e: PodiumEntry, delay: number): HTMLElement {
    const avatar = el("div", "podium__avatar", el("span", "podium__emoji", e.emoji), e.isYou ? el("span", "tag tag--you podium__you", "YOU") : null);
    if (e.place === 1) avatar.append(el("span", "podium__crown", svg(ICON_CROWN)));
    const tag = el("div", "podium__tag", el("span", "podium__name", e.name));
    tag.title = e.name;
    const block = el("div", "podium__block", el("span", "podium__place outlined", String(e.place)), el("span", "podium__pts", `${e.points} pts`));
    const place = block.querySelector(".podium__place");
    if (place instanceof HTMLElement) place.dataset.text = String(e.place);

    const col = el("div", `podium__col podium__col--${e.place}`, avatar, tag, block);
    col.style.setProperty("--slot", e.color);
    col.setAttribute("aria-label", `${ordinal(e.place)}: ${e.name}, ${e.points} points`);
    play(block, [{ transform: "scaleY(0)" }, { transform: "scaleY(1.06)", offset: 0.7 }, { transform: "scaleY(1)" }], {
      duration: 460,
      delay,
      easing: "ease-out",
      fill: "backwards",
    });
    play(avatar, [{ transform: "translateY(-120px)", opacity: 0 }, { transform: "translateY(8px)", opacity: 1, offset: 0.75 }, { transform: "none", opacity: 1 }], {
      duration: 520,
      delay: delay + 260,
      easing: "ease-in",
      fill: "backwards",
    });
    return col;
  }

  /** Last place (4th or lower): a hole in the ground the loser keeps tumbling into. */
  private voidColumn(e: PodiumEntry): HTMLElement {
    const faller = el("div", "void__faller", el("span", "void__emoji", e.emoji), e.isYou ? el("span", "tag tag--you podium__you", "YOU") : null);
    const col = el(
      "div",
      "podium__col podium__col--void",
      el("div", "void__stage", faller, el("div", "void__hole"), el("span", "void__ah", "aaaaa!")),
      el("div", "podium__tag", el("span", "podium__name", e.name)),
      el("p", "void__caption", `${ordinal(e.place)} · fell into the void · ${e.points} pts`),
    );
    col.style.setProperty("--slot", e.color);
    col.title = e.name;
    col.setAttribute("aria-label", `${ordinal(e.place)}: ${e.name}, ${e.points} points, fell into the void`);
    return col;
  }

  private renderStats(entries: readonly PodiumEntry[]): void {
    const rows = entries.map((e) => {
      const acc = Math.max(0, Math.min(100, Math.round(e.stats.accuracy)));
      const accCell = el("td", "stats-acc", el("span", "stats-acc__bar", el("i")), `${acc}%`);
      accCell.style.setProperty("--acc", `${acc}%`);
      const name = el("span", "stats-name", e.name);
      name.title = e.name;
      const tr = el(
        "tr",
        "stats-row",
        el("td", "stats-place", el("span", "", MEDAL[e.place] ?? ordinal(e.place))),
        el("td", "stats-player", el("i", "color-dot"), el("span", "stats-emoji", e.emoji), name, e.isYou ? el("span", "tag tag--you", "YOU") : null),
        el("td", "stats-points", String(e.points)),
        el("td", "", String(e.stats.hits)),
        el("td", "", String(e.stats.catches)),
        el("td", "", String(e.stats.ringOuts)),
        accCell,
      );
      tr.style.setProperty("--slot", e.color);
      tr.classList.toggle("is-you", e.isYou);
      return tr;
    });
    this.statsBody.replaceChildren(...rows);
  }

  private renderAwards(entries: readonly PodiumEntry[]): void {
    const items: HTMLElement[] = [];
    for (const a of AWARDS) {
      const winner = awardWinner(entries, a.key);
      if (!winner) continue;
      const li = el(
        "li",
        "award",
        el("span", "award__icon", a.icon),
        el("span", "award__text", el("b", "", a.title), el("span", "award__who", `${winner.emoji} ${winner.name} · ${winner.stats[a.key]} ${a.unit}`)),
      );
      li.style.setProperty("--slot", winner.color);
      items.push(li);
    }
    this.awards.replaceChildren(...items);
    setHidden(this.awards, items.length === 0);
  }

  private renderActions(model: MatchEndModel): void {
    if (model.canRematch !== this.canRematch) {
      const unlocked = this.canRematch === false && model.canRematch;
      this.canRematch = model.canRematch;
      if (unlocked) play(this.rematchBtn, [{ transform: "scale(1)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }], { duration: 360, easing: "ease-out" });
    }
    const locked = !model.canRematch || this.chosen !== null;
    this.rematchBtn.disabled = locked;
    this.lobbyBtn.disabled = locked;
    this.rematchBtn.classList.toggle("is-chosen", this.chosen === true);
    this.lobbyBtn.classList.toggle("is-chosen", this.chosen === false);

    const secs = Math.max(0, Math.ceil(model.autoLobbySec));
    let note: string;
    if (this.chosen !== null) note = "Heading back to the lobby…";
    else if (!model.canRematch) note = "Soak it in for a second…";
    else note = `Back to the lobby automatically in ${secs} s`;
    setText(this.autoNote, note);
  }

  /* ------------------------------------------------------------- actions */

  private choose(ready: boolean): void {
    if (!this.canRematch || this.chosen !== null) return;
    this.chosen = ready;
    this.rematchBtn.disabled = true;
    this.lobbyBtn.disabled = true;
    play(ready ? this.rematchBtn : this.lobbyBtn, [{ transform: "scale(0.92)" }, { transform: "scale(1.06)" }, { transform: "scale(1)" }], { duration: 300 });
    this.events.emit("rematch", { ready });
  }

  private launchConfetti(): void {
    const pieces: HTMLElement[] = [];
    for (let i = 0; i < CONFETTI_PIECES; i++) {
      const piece = el("i", i % 3 === 0 ? "confetti__piece is-round" : "confetti__piece");
      const s = piece.style;
      s.setProperty("--x", `${(Math.random() * 100).toFixed(1)}%`);
      s.setProperty("--drift", `${(Math.random() - 0.5) * 160}px`);
      s.setProperty("--spin", `${(Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 720)}deg`);
      s.setProperty("--delay", `${(Math.random() * 2.4).toFixed(2)}s`);
      s.setProperty("--dur", `${(2.8 + Math.random() * 2.2).toFixed(2)}s`);
      s.setProperty("--c", CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
      pieces.push(piece);
    }
    this.confetti.replaceChildren(...pieces);
  }
}
