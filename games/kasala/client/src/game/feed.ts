// Turkish feed lines + name helpers. Owner: client-net-game.
// Hud.feed takes trusted HTML: every nickname goes through esc() AFTER the case suffix is added. Lines about
// the local player use "Sen / senden / sana …" with second-person verbs. Plain-text APIs (banners, slams,
// subtitles) get plain() names with markup characters stripped, in case a module renders them as HTML.
// Event policy: the feed only tells what nothing else on screen showed (attacks on/by me, loans, interest,
// skipped turns, notices, spectators' chatter); reactions.ts decides which of these lines are pushed.

import {
  BET_BOX_BY_ID,
  CARD_BY_ID,
  GHOST_WINS_TO_RETURN,
  TRAP_LEVEL,
  WHEEL_EVERYONE_GAIN,
  WHEEL_PAY_EACH,
  type BetBox,
  type CardId,
} from "../../../shared/constants";
import type {
  AttackMsg,
  BetsSettledMsg,
  CardMsg,
  CashedMsg,
  EliminatedMsg,
  GhostReturnMsg,
  KasalaStateView,
  LoanMsg,
  MarketResultMsg,
  RaidedMsg,
  RoundEndMsg,
  SavedMsg,
  TaslikMsg,
  TurnStartMsg,
  WheelResultMsg,
} from "../../../shared/protocol";
import { accName, atName, esc, fromName, money, ofName, playerColor, toName } from "../app/ui";

export type FeedLine = [icon: string, html: string];
type State = KasalaStateView | null;

// ------------------------------------------------------------------- Turkish cases
// The suffix rules (vowel harmony, hard consonants, trailing numbers read aloud) live in app/ui.ts.
export { accName, atName };

export type Case = "nom" | "abl" | "dat" | "gen" | "acc" | "loc";
const ME: Record<Case, string> = { nom: "Sen", abl: "senden", dat: "sana", gen: "senin", acc: "seni", loc: "sende" };

export function inflect(name: string, c: Case): string {
  switch (c) {
    case "nom":
      return name;
    case "abl":
      return fromName(name);
    case "dat":
      return toName(name);
    case "gen":
      return ofName(name);
    case "acc":
      return accName(name);
    case "loc":
      return atName(name);
  }
}

/** Markup characters stripped (nicknames headed for plain-text APIs). */
export function plain(s: string): string {
  return s.replace(/[<>&"]/g, "");
}

/** Raw nickname (fallback "Biri"). */
export function nick(state: State, id: string): string {
  return state?.players.get(id)?.nickname || "Biri";
}

/** Nickname for plain-text UI, with an optional case suffix. */
export function nameText(state: State, id: string, c: Case = "nom"): string {
  return plain(inflect(nick(state, id), c));
}

/** Who a slam / banner sub-line is about: "Sen" for me, else the plain nickname. */
export function subject(state: State, id: string, myId: string): string {
  return id && id === myId ? "Sen" : nameText(state, id);
}

export function colorOf(state: State, id: string): string {
  const p = state?.players.get(id);
  return p ? playerColor(p.color) : "#FFF4DF";
}

/** Bold colored name (escaped), "Sen"/"senden"… for me. */
export function who(state: State, id: string, myId: string, c: Case = "nom"): string {
  const color = colorOf(state, id);
  const text = id && id === myId ? ME[c] : esc(inflect(nick(state, id), c));
  return `<b style="color:${color}">${text}</b>`;
}

const isMe = (id: string, myId: string) => !!id && id === myId;
const b = (s: string) => `<b>${esc(s)}</b>`;
const pos = (n: number) => `<b class="ks-money">${money(n, true)}</b>`;
const neg = (n: number) => `<b class="ks-neg">${money(-Math.abs(n), true)}</b>`;
const delta = (n: number) => (n < 0 ? neg(n) : pos(n));

export function cardName(card: CardId | ""): string {
  return card ? (CARD_BY_ID[card]?.name ?? card) : "";
}

// -------------------------------------------------------------------------- turns
export function turnLine(s: State, m: TurnStartMsg, myId: string): FeedLine {
  const me = isMe(m.playerId, myId);
  let html = me ? `${b("Sıra sende!")}` : `Sıra ${who(s, m.playerId, myId, "loc")}`;
  const notes: string[] = [];
  if (m.trapped) notes.push(`🪤 siren ${TRAP_LEVEL}'den başlıyor`);
  if (m.cursed) notes.push("🧿 lanetli");
  if (m.lawyers > 0) notes.push("⚖️ avukatlı");
  if (notes.length) html += ` <span style="opacity:.8">(${notes.join(", ")})</span>`;
  return ["🎲", html];
}

// -------------------------------------------------------------------------- cards
/** Feed line for a flipped card (null when another message tells the story: raids, instant attacks). */
export function cardLine(s: State, m: CardMsg, myId: string): FeedLine | null {
  const me = isMe(m.playerId, myId);
  const name = who(s, m.playerId, myId);
  const card = b(cardName(m.card));
  const def = CARD_BY_ID[m.card];
  const flipped = me ? "çevirdin" : "çevirdi";
  if (!def) return null;
  switch (def.kind) {
    case "money":
      if (m.curseHit) return ["🧿", `${name} ${card} ${flipped} ama nazar değdi: <b>0$</b>`];
      return [def.icon, `${name} ${card} ${flipped} (${pos(m.value)})`];
    case "multiplier":
      return ["🧼", `${name} kara parayı ${me ? "akladın" : "akladı"}: pot <b>×2</b> (${pos(m.value)})`];
    case "protection":
      if (m.card === "avukat") return ["⚖️", `${name} bir ${b("Avukat")} ${me ? "buldun" : "buldu"}. İlk baskın iptal!`];
      return ["✉️", `${name} komisere ${b("zarf")} ${me ? "verdin" : "verdi"}: siren <b>−2</b>`];
    case "special":
      return ["🎡", `${name} ${b("Patronun Çarkı")} kartını ${flipped}!`];
    case "attack":
      if (m.needsTarget) return [def.icon, `${name} ${card} ${flipped}, hedef ${me ? "seçiyorsun" : "seçiyor"}…`];
      return null;
    case "raid":
      if (m.saved) return ["⚖️", `Polis geldi, avukat konuştu: ${who(s, m.playerId, myId, "acc")} baskından kurtardı!`];
      return null;
  }
  return null;
}

/** Short value text for floating numbers and banners. */
export function cardValueText(m: CardMsg): string {
  const def = CARD_BY_ID[m.card];
  if (!def) return "";
  switch (def.kind) {
    case "money":
      return m.curseHit ? "0$" : money(m.value, true);
    case "multiplier":
      return `×2 (${money(m.value, true)})`;
    case "protection":
      return m.card === "avukat" ? "Bir baskın iptal" : "Siren −2";
    case "special":
      return "Çark iniyor!";
    case "attack":
      return def.desc;
    case "raid":
      return m.saved ? "Avukat kurtardı!" : "Polis kapıda!";
  }
  return "";
}

// ------------------------------------------------------------------------- attacks
export function attackLine(s: State, m: AttackMsg, myId: string): FeedLine {
  const meFrom = isMe(m.fromId, myId);
  const from = who(s, m.fromId, myId);
  const rnd = m.random ? ` <span style="opacity:.7">(süre doldu, rastgele hedef)</span>` : "";
  switch (m.card) {
    case "harac": {
      const meTarget = isMe(m.targetId, myId);
      return ["💸", `${from}${meFrom ? "" : ","} ${who(s, m.targetId, myId, "abl")} haraç ${meFrom ? "kestin" : "kesti"} (${meTarget ? neg(m.amount) : pos(m.amount)})${rnd}`];
    }
    case "haracTuru": {
      const paid = m.payers.find((p) => p.playerId === myId);
      const mine = paid ? ` · sen ${neg(paid.amount)}` : "";
      return ["🎩", `Haraç turu! Herkes ${who(s, m.fromId, myId, "dat")} haraç bıraktı (${pos(m.amount)}${mine})`];
    }
    case "tuzak":
      return ["🪤", `${from}${meFrom ? "" : ","} ${who(s, m.targetId, myId, "dat")} tuzak ${meFrom ? "kurdun" : "kurdu"}: siren ${TRAP_LEVEL}'den başlayacak${rnd}`];
    case "lanet":
      return ["🧿", `${from}${meFrom ? "" : ","} ${who(s, m.targetId, myId, "dat")} lanet ${meFrom ? "okudun" : "okudu"}: ilk para kartı boş çıkacak${rnd}`];
    case "takas": {
      if (meFrom) return ["🔄", `${from} ${who(s, m.targetId, myId)} ile kasaları takas ettin! (${delta(m.amount)})${rnd}`];
      if (isMe(m.targetId, myId)) return ["🔄", `${from} seninle kasaları takas etti! (${delta(-m.amount)})${rnd}`];
      return ["🔄", `${from}, ${who(s, m.targetId, myId)} ile kasaları takas etti! (${delta(m.amount)})${rnd}`];
    }
    default:
      return ["💥", `${from} ${b(cardName(m.card))} ${meFrom ? "oynadın" : "oynadı"}${rnd}`];
  }
}

// --------------------------------------------------------------------------- wheel
export function wheelLine(s: State, m: WheelResultMsg, myId: string): FeedLine {
  const me = isMe(m.playerId, myId);
  const name = who(s, m.playerId, myId);
  const mine = m.deltas.find((d) => d.playerId === m.playerId)?.delta ?? 0;
  switch (m.slice) {
    case "kumbara":
      return ["🎰", `${name} KUMBARAYI ${me ? "PATLATTIN" : "PATLATTI"} (${pos(mine)})`];
    case "x10":
      return ["🎰", `${me ? "Vitrinin" : `${who(s, m.playerId, myId, "gen")} vitrini`} ON KATINA çıktı! (${b(money(m.pot))})`];
    case "herkese100":
      return ["🎰", `Patron cömert: herkese ${pos(WHEEL_EVERYONE_GAIN)}!`];
    case "karistir":
      return ["🎰", `Kasalar karıştırıldı! Zengin fakir, fakir zengin.${mine ? ` ${who(s, m.playerId, myId)}: ${delta(mine)}` : ""}`];
    case "herkeseOde":
      return ["🎰", `${name} herkese ${b(money(WHEEL_PAY_EACH))} ${me ? "dağıttın" : "dağıttı"} (${neg(mine)})`];
    case "avukat":
      return ["🎰", `${me ? "Sana" : who(s, m.playerId, myId, "dat")} bedava avukat! Bu tur ve sonraki tur korumalı.`];
    case "topluBaskin":
      return ["🎰", `Toplu baskın! Herkes kasasının %10'unu kumbaraya ödedi (${pos(m.kumbaraDelta)} kumbaraya)`];
    case "birDaha":
      return ["🎰", `${b("BİR DAHA!")} Çark yeniden dönüyor…`];
  }
  return ["🎰", `${name} çarkı ${me ? "çevirdin" : "çevirdi"}`];
}

// -------------------------------------------------------------------- turn result
export function cashLine(s: State, m: CashedMsg, myId: string): FeedLine {
  const me = isMe(m.playerId, myId);
  const name = who(s, m.playerId, myId);
  if (m.skipped) return ["💤", `${name} masada değil, ${me ? "sıran" : "sırası"} geçti.`];
  const cards = `${m.flips} kart`;
  const cut = m.kept < m.pot ? ` · taşlık kesintisi ${neg(m.pot - m.kept)}` : "";
  if (m.auto) {
    if (m.flips === 0 || m.pot <= 0) return ["⏰", `Süre doldu: ${me ? "sıran" : `${who(s, m.playerId, myId, "gen")} sırası`} boşa geçti.`];
    return ["⏰", `Süre doldu: ${name} otomatik ${me ? "kasaladın" : "kasaladı"} (${pos(m.pot)}, ${cards})${cut}`];
  }
  if (m.pot <= 0) return ["🫥", `${name} eli boş ${me ? "kasaladın" : "kasaladı"}.`];
  return ["💰", `${me ? b("KASALADIN!") : `${name} ${b("KASALADI!")}`} ${pos(m.pot)} (${cards})${cut}`];
}

/** The Pazar from my side: what I sold, bought or lost in a clash (null when I wasn't part of it). */
export function marketLine(s: State, m: MarketResultMsg, myId: string): FeedLine | null {
  if (isMe(m.sellerId, myId)) {
    const kumbara = m.toKumbara > 0 ? ` · ${esc(money(m.toKumbara))} kumbaraya` : "";
    if (!m.sales.length) return ["🛒", m.toKumbara > 0 ? `Vitrininden kimse almadı: ${esc(money(m.toKumbara))} kumbaraya.` : "Pazar kapandı."];
    return ["💰", `Pazar: ${m.sales.length} kart sattın ${pos(m.feesKept)}${kumbara}`];
  }
  const bought = m.sales.find((x) => isMe(x.buyerId, myId));
  if (bought) {
    return ["🛒", `${b(accName(cardName(bought.card)))} ${esc(money(bought.fee))}'a aldın: ${pos(bought.value - bought.fee)} kâr`];
  }
  const lost = m.clashes.find((x) => x.loserIds.includes(myId));
  if (lost) {
    const card = m.sales.find((x) => x.flipNo === lost.flipNo)?.card ?? "";
    return ["😤", `${b(accName(cardName(card)))} ${who(s, lost.winnerId, myId)} kaptı: kasası seninkinden az.`];
  }
  return null;
}

export function raidLine(s: State, m: RaidedMsg, myId: string): FeedLine {
  const me = isMe(m.playerId, myId);
  const name = who(s, m.playerId, myId);
  const first = m.flipNo <= 1 ? " Daha ilk kart!" : m.flipNo >= 6 ? ` ${m.flipNo}. kartta!` : "";
  const parts: string[] = [];
  if (m.potLost > 0) parts.push(`pot ${b(money(m.potLost))} kumbaraya`);
  if (m.bribe > 0) parts.push(`rüşvet ${neg(m.bribe)}`);
  const tail = parts.length ? ` (${parts.join(", ")})` : "";
  return ["🚨", `${me ? b("BASKIN yedin!") : `${name} ${b("BASKIN")} yedi`}${tail}${first}`];
}

export function betsLine(s: State, m: BetsSettledMsg, myId: string): FeedLine | null {
  const list = m.results.filter((r) => r.amount > 0 || r.ghost);
  if (!list.length) return null;
  const parts = list.slice(0, 5).map((r) => {
    const box = BET_BOX_BY_ID[r.box as BetBox]?.label ?? r.box;
    const mark = r.won ? "✅" : "❌";
    const money_ = r.ghost ? "👻" : r.won ? pos(r.delta) : neg(r.amount);
    return `${who(s, r.playerId, myId)} ${esc(box)} ${mark} ${money_}`;
  });
  const more = list.length > 5 ? ` +${list.length - 5}` : "";
  return ["🎲", `Bahisler: ${parts.join(" · ")}${more}`];
}

// --------------------------------------------------------------------------- loans
/** Who lends to whom for an offer / request. */
export function loanSides(m: Pick<LoanMsg, "fromId" | "toId" | "kind" | "event">): { lender: string; borrower: string } {
  if (m.event === "repaid" || m.event === "paidOff") return { lender: m.toId, borrower: m.fromId };
  return m.kind === "offer" ? { lender: m.fromId, borrower: m.toId } : { lender: m.toId, borrower: m.fromId };
}

export function loanLine(s: State, m: LoanMsg, myId: string): FeedLine | null {
  const from = who(s, m.fromId, myId);
  const meFrom = isMe(m.fromId, myId);
  const amount = b(money(m.amount));
  const rate = `%${m.ratePct}`;
  const { lender, borrower } = loanSides(m);
  switch (m.event) {
    case "proposed":
      if (m.kind === "offer") return ["🤝", `${from}${meFrom ? "" : ","} ${who(s, m.toId, myId, "dat")} ${amount} borç ${meFrom ? "teklif ettin" : "teklif etti"} (tur faizi ${rate})`];
      return ["🙏", `${from}${meFrom ? "" : ","} ${who(s, m.toId, myId, "abl")} ${amount} borç ${meFrom ? "istedin" : "istedi"} (tur faizi ${rate})`];
    case "accepted":
      return ["💵", `${who(s, lender, myId)}${isMe(lender, myId) ? "" : ","} ${who(s, borrower, myId, "dat")} ${amount} borç ${isMe(lender, myId) ? "verdin" : "verdi"}. Faiz işliyor: ${rate}`];
    case "declined":
      return ["🚫", `${who(s, m.toId, myId)} teklifi ${isMe(m.toId, myId) ? "reddettin" : "reddetti"}. Kardeşim dediğin adam!`];
    case "expired":
      return ["⌛", `${who(s, m.fromId, myId, "gen")} borç ${m.kind === "offer" ? "teklifi" : "isteği"} cevapsız kaldı.`];
    case "canceled":
      return ["↩️", `${from} borç ${m.kind === "offer" ? "teklifinden" : "isteğinden"} ${meFrom ? "vazgeçtin" : "vazgeçti"}.`];
    case "repaid":
      return ["💸", `${who(s, borrower, myId)}${isMe(borrower, myId) ? "" : ","} ${who(s, lender, myId, "dat")} ${amount} ${isMe(borrower, myId) ? "ödedin" : "ödedi"}.`];
    case "paidOff":
      return ["✅", `${who(s, borrower, myId)} borcunu ${isMe(borrower, myId) ? "kapattın" : "kapattı"}! Tefeci üzgün.`];
  }
  return null;
}

export function taslikLine(s: State, m: TaslikMsg, myId: string): FeedLine {
  const me = isMe(m.playerId, myId);
  if (m.on) return ["⛓", `${me ? "Artık TAŞLIKSIN" : `${who(s, m.playerId, myId)} artık ${b("TAŞLIK")}`}: KASALA kazancının yarısı alacaklılara.`];
  return ["🔓", `${who(s, m.playerId, myId, "gen")} tasması çıktı. Özgürlük!`];
}

/** Interest and the Battle Royale floor (the round pill and the SON MASA banner tell the rest). */
export function roundEndLines(s: State, m: RoundEndMsg, myId: string): FeedLine[] {
  const lines: FeedLine[] = [];
  const grown = m.interest.filter((i) => i.after > i.before);
  if (grown.length > 0 && grown.length <= 3) {
    for (const i of grown) {
      const d = s?.debts.get(i.debtId);
      const owner = d ? `${who(s, d.borrowerId, myId, "gen")} borcu` : "Bir borç";
      lines.push(["📈", `Faiz işledi: ${owner} ${esc(money(i.before))} → ${b(money(i.after))}`]);
    }
  } else if (grown.length > 3) {
    lines.push(["📈", `Faiz işledi: ${grown.length} borç büyüdü. Tik tak, tik tak.`]);
  }
  if (m.floorBonus > 0) lines.push(["🚨", `Siren tabanı yükseldi: artık her kart en az ${b(`+%${Math.round(m.floorBonus * 100)}`)} daha riskli.`]);
  return lines;
}

// ---------------------------------------------------------------------- royale
export function lastChanceLine(s: State, id: string, myId: string): FeedLine {
  if (isMe(id, myId)) return ["🆘", `${b("Kasan sıfır!")} Birinden borç iste, yoksa nehre gidiyorsun.`];
  return ["🆘", `${who(s, id, myId, "gen")} kasası sıfır! Biri borç vermezse nehre gidiyor.`];
}

export function savedLine(s: State, m: SavedMsg, myId: string): FeedLine {
  return ["🛟", `${who(s, m.lenderId, myId)}${isMe(m.lenderId, myId) ? "" : ","} ${who(s, m.playerId, myId, "acc")} ${isMe(m.lenderId, myId) ? "kurtardın" : "kurtardı"}! Ama faiziyle…`];
}

export function eliminatedLine(s: State, m: EliminatedMsg, myId: string): FeedLine {
  const me = isMe(m.playerId, myId);
  const head = me ? `${b("Nehre atıldın.")} Hayalet fişlerle bahis oynamaya devam: ${GHOST_WINS_TO_RETURN} doğru tahmin → masaya dönüş!` : `${who(s, m.playerId, myId)} çimento ayakkabılarla nehre atıldı.`;
  return ["🌊", `${head} <span style="opacity:.8">(${m.remaining} kişi kaldı)</span>`];
}

export function ghostReturnLine(s: State, m: GhostReturnMsg, myId: string): FeedLine {
  const me = isMe(m.playerId, myId);
  return ["🧟", `${me ? b("Nehirden döndün!") : `${who(s, m.playerId, myId)} nehirden döndü!`} Islak, yosunlu ama masada (${pos(m.kasa)}).`];
}

export function tauntLine(s: State, id: string, text: string, myId: string): FeedLine {
  return ["💬", `${who(s, id, myId)}: “${esc(text)}”`];
}

/** A spectator's emote (no seat at the table, so nothing in 3D shows it). */
export function spectatorEmoteLine(s: State, id: string, icon: string, label: string, myId: string): FeedLine {
  return ["👀", `${who(s, id, myId)}: ${esc(icon)} ${esc(label)}`];
}

/** My ghost chip result: progress back to the table (nothing else spells out the count). */
export function ghostBetLine(won: boolean, wins: number): FeedLine {
  const n = Math.min(wins, GHOST_WINS_TO_RETURN);
  return won
    ? ["👻", `${b("Tahmin tuttu!")} ${n}/${GHOST_WINS_TO_RETURN} · masaya dönüşe bir adım daha.`]
    : ["👻", `Tahmin tutmadı. ${n}/${GHOST_WINS_TO_RETURN} doğru tahmin.`];
}

export function noticeLine(text: string): FeedLine {
  return ["📢", esc(text)];
}
