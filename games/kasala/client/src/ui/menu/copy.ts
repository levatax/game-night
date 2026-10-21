// Player-facing menu text (Turkish). Random pools keep the home and lobby screens from feeling static.

import { RAID_BRIBE_PCT } from "../../../../shared/constants";

const BRIBE = `%${Math.round(RAID_BRIBE_PCT * 100)}`;

export const TAGLINES = [
  "Kart çevir, vitrini doldur, polis gelmeden KASALA de!",
  "Bir kart daha… ne olabilir ki?",
  "Bu masada dostluk yok, faiz var.",
  "Kasala ya da kelepçe. Seçim senin.",
  "Komiser Rıfat bu gece nöbette.",
  "Cemil Abi kartları karıyor. Purosu da yanıyor.",
  "Siren çalınca kimse kimseyi tanımaz.",
  "Vitrinindeki Külçe'ye herkes göz dikti. Haberin olsun.",
] as const;

/** Nickname placeholders / dice rolls. Each fits NICKNAME_MAX (14). */
export const GANGSTER_NAMES = [
  "Kel Mahmut",
  "Topal Ziya",
  "Kumarbaz Kemal",
  "Çakal Cemal",
  "Tombul Tayfun",
  "Şanslı Şükrü",
  "Puro Remzi",
  "Fötr Ferhat",
  "Zarf Zeki",
  "Kasa Kadir",
  "Borçlu Bülent",
  "Sinsi Sinan",
  "Faizci Fikret",
  "Kuru Kâzım",
  "Dolar Doğan",
  "Bıçkın Bilal",
] as const;

/** Empty seat captions (one per seat index). */
export const EMPTY_SEATS = [
  "Boş sandalye",
  "Kodu gönder!",
  "Kuzenini çağır",
  "Puro bekliyor",
  "Fişler hazır",
  "Bir kişi daha?",
] as const;

/** Thinking statuses for players who aren't ready yet (picked per player, stays stable). */
export const NOT_READY = ["Düşünüyor…", "Purosunu yakıyor…", "Fiş sayıyor…", "Şapkasını düzeltiyor…"] as const;

export const MODE_INFO = {
  classic: { label: "Klasik" },
  royale: { label: "Battle Royale" },
} as const;

/** Home "Nasıl oynanır?" fold-out: the rule in one breath, then the keys. */
export const HOW_TO_RULE =
  `Kart çevir, para vitrine düşsün. Her kart sireni doldurur; baskında vitrin gider, kasandan da ${BRIBE} rüşvet kesilir. KASALA! deyince vitrinin en iyi kartı senin, kalanını rakipler Pazar'da sana ödeyip alır.`;
export const HOW_TO = [
  ["Space", "Kart çevir: para vitrine düşer, siren dolar."],
  ["Enter", "KASALA! En iyi kart(lar) kasana: 4. karttan sonra 2, 7.'den sonra 3."],
  ["1–9", "Pazar: rakibin vitrininden yarı fiyata kart seç (0: pas)."],
  ["B", "Borç ver, borç iste, faizini say."],
  ["V", "Görünüm: koltuğun ya da masanın üstü."],
] as const;

/** Lobby "Nasıl oynanır" strip: three steps, open by default. */
export const LOBBY_STEPS = [
  { icon: "🃏", key: "Space", title: "Kart çevir → vitrin dolar", text: "Sıran gelince kart aç. Para kartları önündeki vitrine dizilir." },
  { icon: "🚨", key: "", title: "Her kart sireni doldurur", text: `Baskında vitrin gider, kasandan da ${BRIBE} rüşvet kesilir.` },
  { icon: "🛒", key: "Enter", title: "KASALA! de, Pazar açılsın", text: "En iyi kart senin; kalanları rakipler yarı fiyata alır (1–9), parası sana. Aynı kartı isteyen olursa kasası az olan kapar." },
] as const;

/** Home + lobby: you can always fill the table with bots. */
export const SOLO_HINT = "🤖 Tek başına mısın? Masa kur, lobide boş sandalyelere bot ekle.";

/** Cemil Abi's lobby small talk (rotates in the lobby side panel). */
export const CEMIL_LOBBY = [
  "Telefonlar masaya, beyler. Kimse kayıt almıyor.",
  "Kurallar basit: polis gelirse ben sizi tanımıyorum.",
  "Kartlar karıldı, purolar yakıldı. Eksik olan sizsiniz.",
  "Bu masada borç verilir. Geri alınır mı? O ayrı mesele.",
  "Hazır mısınız? Ben otuz yıldır hazırım.",
  "Komiser Rıfat bu gece gelmez. Herhalde. Umarım.",
  "Kim kasalarsa çay benden. Kim baskın yerse hesap ondan.",
  "Fiş sayarken dudak oynatmayın evlatlar, ayıp oluyor.",
  "Bir kart daha diyenin sonunu hepimiz biliyoruz.",
] as const;
