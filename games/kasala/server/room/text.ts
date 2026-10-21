// Nicknames and the Turkish NOTICE lines KasalaRoom sends. Owner: server.
// Names are never glued to Turkish suffixes here (vowel harmony depends on the name), so every line puts the
// name where no suffix is needed.

import { NICKNAME_MAX } from "../../shared/constants.js";
import type { NoticeMsg } from "../../shared/protocol.js";
import type { Rng } from "../rules.js";

/** Trim, strip control / invisible chars, collapse spaces, cut to NICKNAME_MAX. "" when nothing usable is left. */
export function cleanNickname(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, NICKNAME_MAX).join("").trim();
}

/** Make `name` unique among `taken` (case-insensitive, Turkish locale) by appending " 2", " 3"… within NICKNAME_MAX. */
export function uniqueNickname(name: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((t) => t.toLocaleLowerCase("tr")));
  if (!lower.has(name.toLocaleLowerCase("tr"))) return name;
  for (let n = 2; n < 100; n++) {
    const suffix = ` ${n}`;
    const base = Array.from(name).slice(0, NICKNAME_MAX - suffix.length).join("").trimEnd();
    const candidate = base + suffix;
    if (!lower.has(candidate.toLocaleLowerCase("tr"))) return candidate;
  }
  return name;
}

/** Default nickname when the player typed nothing usable. */
export function defaultNickname(n: number): string {
  return `Gangster ${n}`;
}

const n = (msg: string): NoticeMsg => ({ text: msg });
const one = (rng: Rng, lines: readonly string[]): string => lines[Math.min(lines.length - 1, Math.floor(rng() * lines.length))]!;

export const say = {
  joined: (rng: Rng, name: string) =>
    n(
      one(rng, [
        `🎩 ${name} masaya oturdu.`,
        `🚪 ${name} arka kapıdan süzüldü. Cüzdanlarınızı sıkı tutun.`,
        `🐾 ${name} geldi. Cemil Abi purosunu yaktı.`,
        `💼 ${name} çantasıyla içeri girdi. İçinde ne var, sormayın.`,
      ]),
    ),
  spectating: (name: string) => n(`👀 ${name} izlemeye geldi. Sonraki elde masada!`),
  left: (rng: Rng, name: string) =>
    n(one(rng, [`🚪 ${name} masadan kalktı.`, `💨 ${name} sireni duyunca arka kapıdan kaçtı.`, `🧥 ${name} paltosunu alıp gitti.`])),
  reconnecting: (name: string) => n(`📡 Bağlantı koptu: ${name}. Masada yeri tutuluyor…`),
  reconnected: (name: string) => n(`🔌 ${name} masaya geri döndü!`),
  host: (name: string) => n(`👑 Yeni host: ${name}`),
  cantStartFew: (min: number) => n(`🙅 Başlamak için en az ${min} oyuncu lazım.`),
  cantStartLazy: (names: string[]) => n(`🙅 Herkes hazır değil: ${names.join(", ")}`),
  rematch: () => n("🔁 Rövanş! Herkes lobiye, fişler yeniden dağıtılacak."),
  tooFew: () => n("😶 Masada yeterli oyuncu kalmadı. Hesaplar kapanıyor!"),
  betsRefunded: () => n("💸 Oyuncu masada değil: bahisler iade edildi."),
  loanLimit: (max: number) => n(`📒 Borç limiti aşıldı: kasanın yarısına kadar, en fazla ${max}$ verebilirsin.`),
  loanLimitOther: (name: string, max: number) => n(`📒 Borç verilemedi: ${name} en fazla ${max}$ verebilir.`),
  loanOffline: (name: string) => n(`📡 ${name} şu an bağlı değil.`),
  loanNotAllowed: () => n("📒 Bu oyuncuyla şu an borç işi yapılamaz."),
  repayBroke: () => n("💸 Kasada ödeyecek para yok."),
  flipFirst: () => n("Önce bir kart çevir!"),
  marketBroke: () => n("💸 Kasan bu kartın fiyatına yetmiyor."),
  botJoined: (name: string) => n(`🤖 ${name} masaya oturdu. Bot ama gözü açık.`),
  botLeft: (name: string) => n(`🤖 ${name} masadan kalktı.`),
  botMadeRoom: (name: string) => n(`🤖 ${name} yerini yeni gelene bıraktı.`),
  botTookOver: (name: string) => n(`🤖 ${name} gitti, yerine bot oturdu. Oyun devam!`),
  tableFull: (max: number) => n(`🙅 Masa dolu: en fazla ${max} kişi oturabilir.`),
  debtsForgiven: (name: string) => n(`🌊 ${name} nehirde: ona olan borçlar silindi.`),
};

/** Lobby bot names: the first BOT_NAMES entry not taken yet (case-insensitive), else a numbered fallback. */
export function botNickname(names: readonly string[], taken: Iterable<string>): string {
  const lower = new Set([...taken].map((t) => t.toLocaleLowerCase("tr")));
  const free = names.find((x) => !lower.has(x.toLocaleLowerCase("tr")));
  return free ?? uniqueNickname(names[0] ?? "Bot", taken);
}
