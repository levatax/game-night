// Match end (§16.6, §16.7) views. Debt collection is a centered window over a dimmed table; the shame titles and
// the final standings are docked to the bottom on a light shade, so the 3D seat shots and the 3D podium above
// them stay visible. All builders return fresh nodes; Overlays swaps them per step (the podium's actions go to
// the window's fixed footer, outside the scrolling body).

import { TITLES, type TitleId } from "../../../../shared/constants";
import type { KasalaStateView, MatchEndMsg, PlayerView } from "../../../../shared/protocol";
import { money, type UiSound } from "../../app/ui";
import { btn, face, h, nameTag, who } from "./dom";

export interface EndCallbacks {
  onRematch(): void;
  onLeave(): void;
  sound(kind: UiSound): void;
}

const MEDALS = ["", "🥇", "🥈", "🥉"] as const;
const PLACE_WORD = ["", "Birinci", "İkinci", "Üçüncü"] as const;

/** The number behind a shame title (rules.ts titles(): raids, $ borrowed, early cashes, bet result, $ wiped, flips). */
const TITLE_VALUE: Record<TitleId, (v: number) => string> = {
  bombaMiknatisi: (v) => `${v} baskın yedi`,
  borcKrali: (v) => `${money(v)} borç aldı`,
  korkak: (v) => `${v} kez erken kasaladı`,
  korBahisci: (v) => `Bahiste ${money(v, true)}`,
  karaListe: (v) => `${money(v)} borcu yandı`,
  gozuKara: (v) => `Tek turda ${v} kart çevirdi`,
};

export function collectionsView(m: MatchEndMsg, s: KasalaStateView): HTMLElement[] {
  const out: HTMLElement[] = [h("h2", "ks-ov-title", "📒 Borç defteri kapanıyor"), h("p", "ks-ov-lead", "Son hesaplar tahsil ediliyor…")];
  if (!m.collections.length) {
    out.push(h("p", "ks-ov-lead", "Bu gece herkes hesabını temiz tuttu. Şimdilik…"));
    return out;
  }
  const list = h("ul", "ks-ov-ledger");
  m.collections.forEach((c, i) => {
    const li = h("li");
    li.style.setProperty("--i", String(i));
    const pair = h("span", "ks-ov-ledger__who");
    pair.append(h("strong", "", who(s, c.borrowerId)), h("span", "ks-ov-ledger__arrow", " → "), h("strong", "", who(s, c.lenderId)));
    li.append(pair, h("b", "ks-ov-money", `${money(c.paid)} ödendi`));
    if (c.wiped) li.appendChild(h("span", "ks-ov-ledger__wiped", `⛔ ${money(c.wiped)} KARA LİSTE`));
    list.appendChild(li);
  });
  out.push(list);
  return out;
}

/** One shame title: big icon, the title and what it means, and who earned it. */
export function titleView(m: MatchEndMsg, s: KasalaStateView, index: number): HTMLElement[] {
  const award = m.titles[index];
  if (!award) return [];
  const def = TITLES.find((x) => x.id === award.title);
  const p = s.players.get(award.playerId);
  const card = h("div", "ks-ov-shame");
  const text = h("div", "ks-ov-shame__text");
  text.append(
    h("p", "ks-ov-kicker", `UTANÇ UNVANI · ${index + 1}/${m.titles.length}`),
    h("h2", "ks-ov-shame__title", def?.label ?? "Unvan"),
    h("p", "ks-ov-shame__desc", def?.desc ?? ""),
  );
  const fact = TITLE_VALUE[award.title]?.(award.value);
  if (fact && award.value) text.appendChild(h("p", "ks-ov-shame__fact", fact));
  card.append(h("span", "ks-ov-shame__icon", def?.icon ?? "🎩"), text);
  if (p) {
    const winner = h("div", "ks-ov-shame__who");
    winner.append(face(p), h("strong", "", p.nickname));
    card.appendChild(winner);
  }
  return [card];
}

/**
 * Final standings: a medal row for the top three and the full stats table (`body`, scrolls when it does not fit
 * the docked window), plus Rövanş / Masadan kalk (`actions`, a fixed footer that never scrolls out of view).
 */
export function podiumView(m: MatchEndMsg, s: KasalaStateView, myId: string, cb: EndCallbacks): { body: HTMLElement[]; actions: HTMLElement } {
  const rows = [...m.standings]
    .sort((a, b) => a.place - b.place)
    .map((e) => ({ e, p: s.players.get(e.playerId) }))
    .filter((r): r is { e: (typeof m.standings)[number]; p: PlayerView } => !!r.p);
  const winner = rows[0];

  const head = h("header", "ks-ov-final__head");
  head.append(
    h("p", "ks-ov-kicker", `MAÇ BİTTİ · ${s.settings.mode === "royale" ? "BATTLE ROYALE" : "KLASİK"}`),
    h("h2", "ks-ov-title", winner ? "Gecenin babası belli!" : "Maç bitti!"),
  );
  if (winner?.e.playerId === myId) head.appendChild(h("p", "ks-ov-lead", "Elini öpsünler patron. 🎩"));

  const podium = h("ol", "ks-ov-podium");
  podium.setAttribute("aria-label", "Kürsü");
  for (const { e, p } of rows.slice(0, 3)) {
    const li = h("li", "ks-ov-podium__step");
    li.dataset.place = String(e.place);
    li.style.setProperty("--i", String(e.place - 1));
    if (e.playerId === myId) li.dataset.me = "true";
    const medal = h("span", "ks-ov-podium__medal", MEDALS[e.place] ?? `${e.place}.`);
    medal.setAttribute("aria-hidden", "true");
    const info = h("span", "ks-ov-podium__info");
    const name = h("strong", "ks-ov-podium__name", p.nickname);
    info.append(h("small", "ks-ov-podium__place", PLACE_WORD[e.place] ?? `${e.place}.`), name, h("span", "ks-ov-podium__money", money(e.kasa)));
    if (p.bot) name.appendChild(h("span", "ks-ov-bot", "🤖"));
    li.append(medal, face(p), info);
    li.setAttribute("aria-label", `${e.place}. ${p.nickname}, ${money(e.kasa)}`);
    podium.appendChild(li);
  }

  const wrap = h("div", "ks-ov-table");
  const table = h("table");
  const tr = h("tr");
  for (const [text, cls] of [
    ["#", "ks-ov-c-rank"],
    ["Oyuncu", ""],
    ["Kasa", "ks-ov-num"],
    ["En büyük KASALA", "ks-ov-num"],
    ["Baskın", "ks-ov-num"],
    ["Bahis", "ks-ov-num"],
    ["Verdi", "ks-ov-num"],
    ["Aldı", "ks-ov-num"],
  ] as const) tr.appendChild(h("th", cls, text));
  const thead = h("thead");
  thead.appendChild(tr);
  const body = h("tbody");
  for (const { e, p } of rows) {
    const row = h("tr");
    if (e.playerId === myId) row.dataset.me = "true";
    row.dataset.place = String(e.place);
    const name = h("td");
    name.appendChild(nameTag(p));
    const bet = p.stats.betProfit;
    row.append(
      h("td", "ks-ov-c-rank", e.place <= 3 ? MEDALS[e.place]! : `${e.place}.`),
      name,
      h("td", "ks-ov-num ks-ov-c-kasa", money(e.kasa)),
      h("td", "ks-ov-num", p.stats.biggestCash ? money(p.stats.biggestCash) : "—"),
      h("td", "ks-ov-num", String(p.stats.raids)),
      h("td", bet < 0 ? "ks-ov-num ks-ov-neg" : bet > 0 ? "ks-ov-num ks-ov-pos" : "ks-ov-num", money(bet, true)),
      h("td", "ks-ov-num", p.stats.lent ? money(p.stats.lent) : "—"),
      h("td", "ks-ov-num", p.stats.borrowed ? money(p.stats.borrowed) : "—"),
    );
    body.appendChild(row);
  }
  table.append(thead, body);
  wrap.appendChild(table);

  const grid = h("div", "ks-ov-final__grid");
  grid.append(podium, wrap);

  const actions = h("div", "ks-ov-actions ks-ov-final__actions");
  if (myId === s.hostId) actions.appendChild(btn("↻ Rövanş", () => { cb.onRematch(); cb.sound("click"); }, "green"));
  else actions.appendChild(h("span", "ks-ov-wait", "Host rövanşı başlatınca lobiye dönülecek…"));
  actions.appendChild(btn("🚪 Masadan kalk", () => cb.onLeave(), "ghost"));

  return { body: [head, grid], actions };
}
