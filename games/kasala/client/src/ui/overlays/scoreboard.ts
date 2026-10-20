// Tab scoreboard: a summary strip (🐷 Patronun Kumbarası, round, mode, table size) over one aligned table of
// every seated player (kasa, borç / alacak, raids, best KASALA, bet profit, status flags, 🤖 bots).

import { GHOST_WINS_TO_RETURN } from "../../../../shared/constants";
import type { KasalaStateView, PlayerView } from "../../../../shared/protocol";
import { money } from "../../app/ui";
import { h, nameTag, vals } from "./dom";

const MODE_LABEL = { classic: "Klasik", royale: "Battle Royale" } as const;

function people(s: KasalaStateView): PlayerView[] {
  return vals(s.players).filter((p) => !p.spectator).sort((a, b) => (a.place && b.place ? a.place - b.place : 0) || b.kasa - a.kasa || a.seat - b.seat);
}

/** Changes whenever anything the table shows changes (the table is rebuilt only then). */
export function scoreSignature(s: KasalaStateView, myId: string): string {
  return (
    `${myId}:${s.phase}:${s.round}:${s.totalRounds}:${s.kumbara}:${s.activeId}:${s.settings.mode}|` +
    people(s)
      .map((p) => `${p.id}:${p.nickname}:${p.color}:${p.animal}:${p.bot}:${p.kasa}:${p.place}:${p.stats.raids}:${p.stats.biggestCash}:${p.stats.betProfit}:${p.taslik}:${p.ghost}:${p.ghostWins}:${p.karaListe}:${p.connected}:${p.cursed}:${p.trapped}:${p.lawyerNext}`)
      .join("|") +
    "|" + vals(s.debts).map((d) => `${d.id}:${d.lenderId}:${d.borrowerId}:${d.owed}`).join("|")
  );
}

function flags(s: KasalaStateView, p: PlayerView): string[] {
  const out: string[] = [];
  if (p.id === s.activeId && s.phase !== "lobby" && s.phase !== "matchEnd") out.push("🎴 Sırada");
  if (p.ghost) out.push(`👻 Hayalet ${p.ghostWins}/${GHOST_WINS_TO_RETURN}`);
  if (p.taslik) out.push("⛓ Taşlık");
  if (p.karaListe) out.push("⛔ Kara Liste");
  if (p.cursed) out.push("🧿 Lanetli");
  if (p.trapped) out.push("🪤 Tuzak");
  if (p.lawyerNext) out.push("⚖️ Avukat");
  if (!p.connected && !p.bot) out.push("🔌 Bağlı değil");
  return out;
}

const cell = (text: string, cls = ""): HTMLTableCellElement => h("td", cls, text);

export function buildScoreboard(s: KasalaStateView, myId: string): HTMLElement[] {
  const list = people(s);
  const debts = vals(s.debts).filter((d) => d.owed > 0);
  const bots = list.filter((p) => p.bot).length;

  const summary = h("div", "ks-ov-summary");
  const stat = (icon: string, label: string, value: string, cls = "") => {
    const e = h("div", `ks-ov-summary__item ${cls}`);
    e.append(h("span", "ks-ov-summary__icon", icon), h("small", "", label), h("strong", "", value));
    summary.appendChild(e);
  };
  stat("🐷", "Patronun Kumbarası", money(s.kumbara), "ks-ov-summary__item--kumbara");
  stat("🕰️", "Tur", s.round > 0 ? `${s.round}/${s.totalRounds}` : "—");
  stat(s.settings.mode === "royale" ? "🌊" : "💰", "Mod", MODE_LABEL[s.settings.mode] ?? "");
  stat("🪑", "Masada", bots ? `${list.length} kişi · ${bots} bot` : `${list.length} kişi`);
  stat("📒", "Açık borç", debts.length ? money(debts.reduce((n, d) => n + d.owed, 0)) : "—");

  const wrap = h("div", "ks-ov-table");
  const table = h("table");
  const head = h("tr");
  for (const [text, cls] of [
    ["#", "ks-ov-c-rank"],
    ["Oyuncu", ""],
    ["Kasa", "ks-ov-num"],
    ["Borcu", "ks-ov-num"],
    ["Alacağı", "ks-ov-num"],
    ["Baskın", "ks-ov-num"],
    ["En büyük KASALA", "ks-ov-num"],
    ["Bahis kârı", "ks-ov-num"],
    ["Durum", ""],
  ] as const) head.appendChild(h("th", cls, text));
  const thead = h("thead");
  thead.appendChild(head);
  const body = h("tbody");
  list.forEach((p, i) => {
    const tr = h("tr");
    if (p.id === myId) tr.dataset.me = "true";
    if (p.id === s.activeId && s.phase !== "lobby") tr.dataset.active = "true";
    if (p.ghost) tr.dataset.ghost = "true";
    const owes = debts.filter((d) => d.borrowerId === p.id).reduce((n, d) => n + d.owed, 0);
    const lent = debts.filter((d) => d.lenderId === p.id).reduce((n, d) => n + d.owed, 0);
    const who = h("td");
    who.appendChild(nameTag(p));
    if (p.id === myId) who.firstElementChild!.appendChild(h("span", "ks-ov-you", "SEN"));
    const status = h("td", "ks-ov-flags");
    const f = flags(s, p);
    if (!f.length) status.textContent = "—";
    for (const x of f) status.appendChild(h("span", "ks-ov-flag", x));
    tr.append(
      cell(String(p.place || i + 1), "ks-ov-c-rank"),
      who,
      cell(money(p.kasa), "ks-ov-num ks-ov-c-kasa"),
      cell(owes ? money(owes) : "—", owes ? "ks-ov-num ks-ov-neg" : "ks-ov-num"),
      cell(lent ? money(lent) : "—", "ks-ov-num"),
      cell(String(p.stats.raids), "ks-ov-num"),
      cell(p.stats.biggestCash ? money(p.stats.biggestCash) : "—", "ks-ov-num"),
      cell(money(p.stats.betProfit, true), p.stats.betProfit < 0 ? "ks-ov-num ks-ov-neg" : p.stats.betProfit > 0 ? "ks-ov-num ks-ov-pos" : "ks-ov-num"),
      status,
    );
    body.appendChild(tr);
  });
  table.append(thead, body);
  wrap.appendChild(table);
  return [summary, wrap];
}
