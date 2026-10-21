// Hold-Tab stats table (§17): every castaway with MVP points, gathered, delivered, hits, crabs, revives, fish,
// downs and ping. Passive (never captures input). Adapted from games/bonk-brawl/client/src/ui/Scoreboard.ts.
// Owner: client-ui.

import type { StatsView } from "../../../../shared/types";
import { t } from "../../i18n";
import { pingLevel } from "../content";
import { keyParams, keysSignature } from "../controls";
import { el, setHidden, setText, svg } from "../dom";
import { ICON_SIGNAL, portraitSvg } from "../icons";
import type { ScoreRow } from "../models";

type StatKey = keyof Pick<StatsView, "gathered" | "delivered" | "hits" | "kills" | "revives" | "fish" | "downs">;

export const SCORE_STATS: ReadonlyArray<{ key: StatKey; icon: string }> = [
  { key: "gathered", icon: "🪓" },
  { key: "delivered", icon: "🛶" },
  { key: "hits", icon: "🎯" },
  { key: "kills", icon: "🦀" },
  { key: "revives", icon: "🤝" },
  { key: "fish", icon: "🎣" },
  { key: "downs", icon: "💫" },
];

function signatureOf(rows: readonly ScoreRow[]): string {
  return rows
    .map((r) => [r.id, r.nickname, r.character, r.color, r.bot, r.you, r.score, Math.round(r.ping / 10), ...SCORE_STATS.map((s) => r.stats[s.key])].join("|"))
    .join(";");
}

export class Scoreboard {
  readonly el = el("div", "rr-scoreboard");
  private readonly body = el("tbody");
  /** "Hold Tab" in the active key preset (re-printed when the preset / layout changed). */
  private readonly hint = el("span", "rr-sb__hint");
  private keysSig = "";
  private signature = "";

  constructor() {
    this.el.hidden = true;
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", t("overlays.sbTitle"));
    const head = el("tr", "", el("th", "rr-sb__rank", "#"), el("th", "rr-sb__player", t("overlays.col_player")), el("th", "rr-sb__score", t("overlays.col_score")));
    for (const s of SCORE_STATS) head.append(el("th", "rr-sb__stat", el("span", "rr-sb__icon", s.icon), el("span", "rr-sb__label", t(`overlays.stat_${s.key}`))));
    head.append(el("th", "rr-sb__ping", t("overlays.col_ping")));
    const table = el("table", "rr-sb__table", el("thead", "", head), this.body);
    const title = el("div", "rr-sb__title", el("span", "", `🏝️ ${t("overlays.sbTitle")}`), this.hint);
    this.el.append(el("div", "rr-panel rr-sb", title, table));
  }

  set(rows: readonly ScoreRow[] | null): void {
    setHidden(this.el, !rows);
    if (!rows) return;
    const keys = keysSignature();
    if (keys !== this.keysSig) {
      this.keysSig = keys;
      setText(this.hint, t("overlays.sbHint", keyParams()));
    }
    const sorted = [...rows].sort((a, b) => b.score - a.score);
    const signature = signatureOf(sorted);
    if (signature === this.signature) return;
    this.signature = signature;
    this.body.replaceChildren(...sorted.map((r, i) => this.row(r, i)));
  }

  private row(r: ScoreRow, index: number): HTMLTableRowElement {
    const name = el("span", "rr-sb__name", r.nickname);
    name.title = r.nickname;
    const tr = el(
      "tr",
      "rr-sb__row",
      el("td", "rr-sb__rank", String(index + 1)),
      el(
        "td",
        "rr-sb__player",
        el("span", "rr-sb__face", svg(portraitSvg(r.character))),
        name,
        r.you ? el("span", "rr-tag rr-tag--you", t("overlays.meYou")) : null,
        r.bot ? el("span", "rr-tag rr-tag--bot", "🤖") : null,
      ),
      el("td", "rr-sb__score", String(r.score)),
      ...SCORE_STATS.map((s) => el("td", "rr-sb__stat", String(r.stats[s.key]))),
      el("td", `rr-sb__ping rr-ping--${r.bot ? "good" : pingLevel(r.ping)}`, r.bot ? "–" : el("span", "", svg(ICON_SIGNAL), `${Math.round(r.ping)}`)),
    );
    tr.style.setProperty("--slot", r.color);
    tr.classList.toggle("is-you", r.you);
    return tr;
  }
}
