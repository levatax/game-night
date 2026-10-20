// Full scoreboard overlay (hold Tab). Owner: client-ui.

import { MAX_HEARTS } from "../../../shared/constants";
import { el, setHidden, svg } from "./dom";
import { formatPing, pingLevel } from "./format";
import { ICON_CROWN, ICON_SIGNAL } from "./icons";
import type { ScoreRow } from "./models";

const COLUMNS: ReadonlyArray<{ label: string; title: string; className?: string }> = [
  { label: "#", title: "Rank", className: "sb-rank" },
  { label: "Player", title: "Player", className: "sb-player" },
  { label: "Pts", title: "Points", className: "sb-points" },
  { label: "🏆 Wins", title: "Round wins" },
  { label: "💥 Hits", title: "Hits" },
  { label: "🧤 Catches", title: "Catches" },
  { label: "🌀 Ring-outs", title: "Ring-outs" },
  { label: "Hearts", title: "Hearts this round", className: "sb-hearts" },
  { label: "Ping", title: "Ping", className: "sb-ping" },
];

function signatureOf(rows: readonly ScoreRow[]): string {
  return rows
    .map((r) =>
      [r.id, r.nickname, r.emoji, r.color, r.points, r.hasCrown, r.isYou, r.alive, r.hearts, r.connected, Math.round(r.ping / 5), r.roundWins, r.hits, r.catches, r.ringOuts].join("|"),
    )
    .join(";");
}

function cell(className: string, ...children: Array<Node | string | null>): HTMLTableCellElement {
  return el("td", className, ...children);
}

function heartsCell(r: ScoreRow): HTMLTableCellElement {
  if (!r.connected) return cell("sb-hearts", el("span", "sb-badge sb-badge--away", "AWAY"));
  if (!r.alive) return cell("sb-hearts", el("span", "sb-badge sb-badge--out", "OUT"));
  const hearts = el("span", "sb-heart-row");
  for (let i = 0; i < MAX_HEARTS; i++) hearts.append(el("i", i < r.hearts ? "sb-heart is-full" : "sb-heart"));
  hearts.setAttribute("aria-label", `${r.hearts} hearts`);
  return cell("sb-hearts", hearts);
}

function playerCell(r: ScoreRow): HTMLTableCellElement {
  const name = el("span", "sb-name", r.nickname);
  name.title = r.nickname;
  return cell(
    "sb-player",
    el("span", "sb-avatar", r.emoji),
    name,
    r.hasCrown ? el("span", "sb-crown", svg(ICON_CROWN)) : null,
    r.isYou ? el("span", "tag tag--you", "YOU") : null,
  );
}

/** Columns: color/emoji, name (crown, "YOU"), points, round wins, hits, catches, ring-outs, hearts/OUT, ping. */
export class Scoreboard {
  readonly el: HTMLElement = document.createElement("div");

  private readonly body = el("tbody");
  private signature = "";
  private open = false;

  constructor() {
    this.el.className = "scoreboard";
    this.el.hidden = true;
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", "Scoreboard");

    const headRow = el("tr");
    for (const c of COLUMNS) {
      const th = el("th", c.className ?? "sb-stat", c.label);
      th.title = c.title;
      th.scope = "col";
      headRow.append(th);
    }
    const table = el("table", "sb-table", el("thead", "", headRow), this.body);
    const title = el("div", "sb-title", el("span", "sb-title__text", "Scoreboard"), el("span", "sb-title__hint", el("kbd", "", "Tab")));
    this.el.append(el("div", "panel sb-panel", title, table));
  }

  set(open: boolean, rows: readonly ScoreRow[]): void {
    if (open !== this.open) {
      this.open = open;
      setHidden(this.el, !open);
    }
    if (!open) return;
    const signature = signatureOf(rows);
    if (signature === this.signature) return;
    this.signature = signature;
    this.body.replaceChildren(...rows.map((r, i) => this.row(r, i)));
  }

  private row(r: ScoreRow, index: number): HTMLTableRowElement {
    const tr = el(
      "tr",
      "sb-row",
      cell("sb-rank", String(index + 1)),
      playerCell(r),
      cell("sb-points", String(r.points)),
      cell("sb-stat", String(r.roundWins)),
      cell("sb-stat", String(r.hits)),
      cell("sb-stat", String(r.catches)),
      cell("sb-stat", String(r.ringOuts)),
      heartsCell(r),
      cell(`sb-ping ping--${pingLevel(r.ping)}`, svg(ICON_SIGNAL), formatPing(r.ping)),
    );
    tr.style.setProperty("--slot", r.color);
    tr.classList.toggle("is-you", r.isYou);
    tr.classList.toggle("is-out", !r.alive || !r.connected);
    return tr;
  }
}
