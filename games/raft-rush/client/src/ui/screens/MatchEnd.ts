// Match end (§4, §21): a win card ("WE ESCAPED!" with confetti, time to spare) or a lose card ("THE STORM WON",
// rain streaks), the island seed + biome (to replay it), team score, the MVP, every castaway's titles, aboard or
// left on the beach with Wilson, a stats table, and Rematch / Back to the beach (enabled once canRematch) with
// the auto-lobby countdown. Adapted from games/bonk-brawl/client/src/ui/MatchEnd.ts. Owner: client-ui.
//
// Emits rematch { ready: true } (Rematch!) / rematch { ready: false } (Back to the beach) and leave.

import { PLAYER_COLORS } from "../../../../shared/constants";
import type { TitleId } from "../../../../shared/types";
import { biomeName, characterName, clockText, t, titleName } from "../../i18n";
import type { Emitter } from "../../util/Emitter";
import { BIOME_ICON } from "../content";
import { button, el, play, setHidden, setOutlinedText, setText, svg } from "../dom";
import { ICON_CROWN } from "../icons";
import type { MatchEndModel, MatchEndRow, UiEventMap } from "../models";
import { portraitNode } from "./lobby/Seats";

const CONFETTI_PIECES = 52;
const RAIN_DROPS = 60;
const CONFETTI_COLORS = [...PLAYER_COLORS, "#FFFFFF", "#FFD166", "#3FB7D9"];

const TITLE_ICON: Record<TitleId, string> = {
  mvp: "🏆",
  crabSlayer: "🦀",
  fishLord: "🎣",
  porter: "🪵",
  hero: "🦸",
  tourist: "📸",
  victim: "🤕",
  coconutAddict: "🥥",
};

const STAT_COLS: ReadonlyArray<{ key: keyof MatchEndRow["stats"]; icon: string }> = [
  { key: "gathered", icon: "🪓" },
  { key: "delivered", icon: "🛶" },
  { key: "hits", icon: "🎯" },
  { key: "kills", icon: "🦀" },
  { key: "revives", icon: "🤝" },
  { key: "fish", icon: "🎣" },
  { key: "eaten", icon: "🍽️" },
  { key: "downs", icon: "💫" },
];

function rowsSignature(m: MatchEndModel): string {
  return `${m.win}|${m.reason}|${m.seed}|${m.teamScore}|${m.mvpId}|` + m.rows.map((r) => [r.id, r.place, r.score, r.aboard, r.titles.join(","), Object.values(r.stats).join(",")].join(":")).join(";");
}

export class MatchEndScreen {
  readonly el = el("section", "rr-screen rr-screen--end");
  private readonly sky = el("div", "rr-end__sky");
  private readonly card = el("div", "rr-panel rr-end__card");
  private readonly title = el("h1", "rr-end__title rr-outlined");
  private readonly sub = el("p", "rr-end__sub");
  private readonly facts = el("div", "rr-end__facts");
  private readonly mvp = el("div", "rr-end__mvp");
  private readonly crew = el("ul", "rr-end__crew");
  private readonly statsBody = el("tbody");
  private readonly rematchBtn = button("rr-btn rr-btn--primary rr-btn--big", el("span", "rr-btn__label", `🔁 ${t("overlays.meRematch")}`));
  private readonly lobbyBtn = button("rr-btn rr-btn--big", el("span", "rr-btn__label", `🏖️ ${t("overlays.meLobby")}`));
  private readonly leaveBtn = button("rr-link-btn", t("overlays.meLeave"));
  private readonly autoNote = el("p", "rr-end__auto");
  private signature = "";
  private chosen: boolean | null = null;
  private canRematch: boolean | null = null;

  constructor(private readonly events: Emitter<UiEventMap>) {
    this.el.setAttribute("aria-label", t("overlays.meStats"));
    this.rematchBtn.addEventListener("click", () => this.choose(true));
    this.lobbyBtn.addEventListener("click", () => this.choose(false));
    this.leaveBtn.addEventListener("click", () => this.events.emit("leave", undefined));
    this.autoNote.setAttribute("aria-live", "polite");
    const table = el("table", "rr-end__table", this.statsHead(), this.statsBody);
    const statsBox = el("details", "rr-end__stats", el("summary", "", `📊 ${t("overlays.meStats")}`), el("div", "rr-end__table-wrap", table));
    (statsBox as HTMLDetailsElement).open = true;
    const actions = el("div", "rr-end__actions", this.rematchBtn, this.lobbyBtn);
    const foot = el("footer", "rr-end__foot", actions, el("div", "rr-end__meta", this.autoNote, this.leaveBtn));
    this.card.append(el("header", "rr-end__head", this.title, this.sub), this.facts, el("div", "rr-end__mid", this.mvp, this.crew), statsBox, foot);
    this.el.append(this.sky, this.card);
  }

  update(m: MatchEndModel): void {
    const signature = rowsSignature(m);
    if (signature !== this.signature) {
      const fresh = this.signature === "";
      this.signature = signature;
      this.chosen = null;
      this.renderHead(m);
      this.renderFacts(m);
      this.renderMvp(m);
      this.renderCrew(m);
      this.renderStats(m.rows);
      if (fresh || !this.sky.hasChildNodes()) this.launchSky(m.win);
    }
    this.renderActions(m);
  }

  /** The screen became visible: fresh choice state and a new burst of confetti / rain. */
  onShow(): void {
    this.chosen = null;
    this.signature = "";
  }

  /* ------------------------------------------------------------ rendering */

  private renderHead(m: MatchEndModel): void {
    const key = m.win ? "overlays.meWin" : m.reason === "abandoned" ? "overlays.meAbandon" : "overlays.meLose";
    const subKey = m.win ? "overlays.meWinSub" : m.reason === "abandoned" ? "overlays.meAbandonSub" : "overlays.meLoseSub";
    this.el.classList.toggle("is-win", m.win);
    this.el.classList.toggle("is-lose", !m.win);
    setOutlinedText(this.title, `${m.win ? "⛵" : "🌩️"} ${t(key)}`);
    setText(this.sub, t(subKey, { t: clockText(m.secLeft) }));
    play(this.title, [{ transform: "scale(0.3) rotate(-8deg)", opacity: 0 }, { transform: "scale(1.12) rotate(2deg)", opacity: 1, offset: 0.6 }, { transform: "none", opacity: 1 }], {
      duration: 620,
      easing: "cubic-bezier(.3,1.3,.5,1)",
    });
  }

  private renderFacts(m: MatchEndModel): void {
    const fact = (icon: string, label: string, value: string, cls = "") => el("div", `rr-end__fact ${cls}`, el("span", "rr-end__fact-icon", icon), el("span", "rr-end__fact-label", label), el("b", "rr-end__fact-value", value));
    const facts: HTMLElement[] = [fact("⭐", t("overlays.meTeamScore"), String(m.teamScore), "is-score")];
    if (m.win) facts.push(fact("⏱️", t("overlays.meTimeLeft"), clockText(m.secLeft)));
    const island = fact(BIOME_ICON[m.biome], t("overlays.meIsland"), `${biomeName(m.biome)} · ${t("overlays.meSeed", { seed: m.seed })}`, "is-island");
    island.title = t("overlays.meReplay");
    facts.push(island);
    this.facts.replaceChildren(...facts, el("p", "rr-end__replay", `🌱 ${t("overlays.meReplay")}`));
  }

  private renderMvp(m: MatchEndModel): void {
    const row = m.rows.find((r) => r.id === m.mvpId);
    setHidden(this.mvp, !row);
    if (!row) return;
    this.mvp.style.setProperty("--slot", row.color);
    this.mvp.replaceChildren(
      el("span", "rr-end__mvp-crown", svg(ICON_CROWN)),
      el("div", "rr-end__mvp-face", portraitNode({ character: row.character, portrait: "" })),
      el("span", "rr-end__mvp-tag", t("overlays.meMvp")),
      el("b", "rr-end__mvp-name", row.nickname),
      el("span", "rr-end__mvp-score", t("overlays.mePts", { n: row.score })),
    );
    play(this.mvp, [{ transform: "translateY(-60px) rotate(-6deg)", opacity: 0 }, { transform: "translateY(6px)", opacity: 1, offset: 0.7 }, { transform: "none", opacity: 1 }], {
      duration: 560,
      delay: 300,
      easing: "ease-out",
      fill: "backwards",
    });
  }

  private renderCrew(m: MatchEndModel): void {
    const rows = [...m.rows].sort((a, b) => a.place - b.place);
    this.crew.replaceChildren(
      ...rows.map((r, i) => {
        const titles = el("span", "rr-end__titles");
        for (const id of r.titles.filter((x) => x !== "mvp")) {
          const chip = el("span", `rr-title-chip rr-title-chip--${id}`, el("span", "", TITLE_ICON[id]), titleName(id));
          chip.title = t(`overlays.title_${id}_desc`);
          titles.append(chip);
        }
        const fate = r.aboard ? el("span", "rr-end__fate is-aboard", `⛵ ${t("overlays.meAboard")}`) : el("span", "rr-end__fate is-left", `🏐 ${t("overlays.meLeft")}`);
        const li = el(
          "li",
          "rr-end__member",
          el("span", "rr-end__place", String(r.place)),
          el("span", "rr-end__face", portraitNode({ character: r.character, portrait: "" })),
          el(
            "span",
            "rr-end__who",
            el("span", "rr-end__name-row", el("b", "rr-end__name", r.nickname), r.you ? el("span", "rr-tag rr-tag--you", t("overlays.meYou")) : null, r.bot ? el("span", "rr-tag rr-tag--bot", "🤖") : null),
            el("span", "rr-end__char", characterName(r.character)),
            titles,
          ),
          fate,
          el("span", "rr-end__score", t("overlays.mePts", { n: r.score })),
        );
        li.style.setProperty("--slot", r.color);
        li.classList.toggle("is-you", r.you);
        li.classList.toggle("is-mvp", r.id === m.mvpId);
        play(li, [{ transform: "translateX(-30px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 320, delay: 450 + i * 90, easing: "ease-out", fill: "backwards" });
        return li;
      }),
    );
  }

  private statsHead(): HTMLElement {
    const tr = el("tr", "", el("th", "", t("overlays.mePlace")), el("th", "rr-end__th-player", t("overlays.col_player")), el("th", "", t("overlays.col_score")));
    for (const c of STAT_COLS) {
      const th = el("th", "", el("span", "rr-end__th-icon", c.icon), el("span", "rr-end__th-label", t(`overlays.stat_${c.key}`)));
      th.title = t(`overlays.stat_${c.key}`);
      tr.append(th);
    }
    return el("thead", "", tr);
  }

  private renderStats(rows: readonly MatchEndRow[]): void {
    const sorted = [...rows].sort((a, b) => a.place - b.place);
    this.statsBody.replaceChildren(
      ...sorted.map((r) => {
        const tr = el(
          "tr",
          r.you ? "is-you" : "",
          el("td", "", String(r.place)),
          el("td", "rr-end__td-player", el("i", "rr-color-dot"), r.nickname),
          el("td", "rr-end__td-score", String(r.score)),
          ...STAT_COLS.map((c) => el("td", "", String(r.stats[c.key]))),
        );
        tr.style.setProperty("--slot", r.color);
        return tr;
      }),
    );
  }

  private renderActions(m: MatchEndModel): void {
    if (m.canRematch !== this.canRematch) {
      const unlocked = this.canRematch === false && m.canRematch;
      this.canRematch = m.canRematch;
      if (unlocked) play(this.rematchBtn, [{ transform: "scale(1)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }], { duration: 360, easing: "ease-out" });
    }
    const locked = !m.canRematch || this.chosen !== null;
    this.rematchBtn.disabled = locked;
    this.lobbyBtn.disabled = locked;
    this.rematchBtn.classList.toggle("is-chosen", this.chosen === true);
    this.lobbyBtn.classList.toggle("is-chosen", this.chosen === false);
    const secs = Math.max(0, Math.ceil(m.secToLobby));
    const note = this.chosen !== null ? t("overlays.meHeading") : !m.canRematch ? t("overlays.meWait") : t("overlays.meAuto", { s: secs });
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

  /** Confetti for a win, slanted rain for a loss (both pure CSS animations). */
  private launchSky(win: boolean): void {
    const pieces: HTMLElement[] = [];
    const n = win ? CONFETTI_PIECES : RAIN_DROPS;
    for (let i = 0; i < n; i++) {
      const piece = el("i", win ? (i % 3 === 0 ? "rr-confetti is-round" : "rr-confetti") : "rr-rain");
      const s = piece.style;
      s.setProperty("--x", `${(Math.random() * 100).toFixed(1)}%`);
      s.setProperty("--drift", `${(Math.random() - 0.5) * 160}px`);
      s.setProperty("--spin", `${(Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 720)}deg`);
      s.setProperty("--delay", `${(Math.random() * (win ? 2.4 : 1.2)).toFixed(2)}s`);
      s.setProperty("--dur", `${(win ? 2.8 + Math.random() * 2.2 : 0.6 + Math.random() * 0.5).toFixed(2)}s`);
      s.setProperty("--c", CONFETTI_COLORS[i % CONFETTI_COLORS.length]!);
      pieces.push(piece);
    }
    this.sky.replaceChildren(...pieces);
  }
}
