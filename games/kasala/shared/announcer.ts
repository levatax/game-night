// Cemil Abi's announcer lines (game3.md §15). FROZEN CONTRACT.
// The SERVER picks a line for an event (pickLine: random, never the same line twice in a row for an event)
// and broadcasts ANNOUNCER { id }, so every client plays the same variation. Clients show `text` as a
// subtitle and play `audio/spiker/<id>.mp3` when it exists (client/vite.config.ts writes the list of
// recorded files to audio/spiker/manifest.json at build time).
// Priority (§15): wheel > raid > KASALA > everything else. Only one line plays at a time: a line of equal or
// higher priority interrupts the current one, a lower one is dropped.

export type AnnouncerEvent =
  | "matchStart"
  | "turnStart"
  | "betsOpen"
  | "betsClosed"
  | "bozukluk"
  | "tomar"
  | "canta"
  | "kulce"
  | "aklama"
  | "sirenMid"
  | "sirenCritical"
  | "timeLow"
  | "cashSmall"
  | "cashBig"
  | "raid"
  | "raidLate"
  | "raidFirst"
  | "harac"
  | "haracTuru"
  | "takas"
  | "tuzak"
  | "lanet"
  | "curseHit"
  | "avukat"
  | "lawyerSaved"
  | "rusvet"
  | "wheel"
  | "wheel_kumbara"
  | "wheel_x10"
  | "wheel_herkese100"
  | "wheel_karistir"
  | "wheel_herkeseOde"
  | "wheel_avukat"
  | "wheel_topluBaskin"
  | "wheel_birDaha"
  | "betsSettled"
  | "betsRaidersWon"
  | "betsCashLost"
  | "loanAccepted"
  | "loanDeclined"
  | "loanRepaid"
  | "taslik"
  | "lastChance"
  | "eliminated"
  | "ghostReturn"
  | "finalTable"
  | "matchEnd"
  | "podium"
  | "podiumAfter"
  | "title_bombaMiknatisi"
  | "title_borcKrali"
  | "title_korkak"
  | "title_korBahisci"
  | "title_karaListe"
  | "title_gozuKara";

export interface AnnouncerLine {
  /** File name without extension: audio/spiker/<id>.mp3 */
  id: string;
  text: string;
  /** Events this line can be picked for. */
  events: readonly AnnouncerEvent[];
  /** 3 = wheel, 2 = raid, 1 = KASALA, 0 = other. */
  priority: number;
}

const L = (id: string, text: string, events: AnnouncerEvent[], priority = 0): AnnouncerLine => ({ id, text, events, priority });

export const ANNOUNCER_LINES: readonly AnnouncerLine[] = [
  L("mac_basi_01", "Hoş geldiniz beyler, bayanlar. Kapıyı kilitleyin, telefonlar masaya. Bu gece kimse temiz çıkmıyor.", ["matchStart"]),
  L("mac_basi_02", "Cemil Abi'nin masasına hoş geldiniz. Kurallar basit: polis gelirse ben sizi tanımıyorum.", ["matchStart"]),
  L("mac_basi_03", "Fişler dağıtıldı, purolar yakıldı. Patron izliyor. Başlayalım.", ["matchStart"]),
  L("tur_basi_01", "Sıra sende evlat. Kartlar seni bekliyor.", ["turnStart"]),
  L("tur_basi_02", "Hadi bakalım, elini göster... Titremesin ama.", ["turnStart"]),
  L("tur_basi_03", "Masa senin. Ama polis de yakında, unutma.", ["turnStart"]),
  L("tur_basi_04", "Bu tur ya zengin olursun ya ünlü. Gazetenin üçüncü sayfasında.", ["turnStart"]),
  L("bahis_acildi_01", "Bahisler açıldı! Arkadaşına güveniyor musun? Ben güvenmezdim.", ["betsOpen"]),
  L("bahis_acildi_02", "Fişlerinizi koyun beyler. Dostluk sonra.", ["betsOpen"]),
  L("bahis_kapandi_01", "Bahisler kapandı. Artık dua etme zamanı.", ["betsClosed"]),
  L("bahis_kapandi_02", "Kimse kıpırdamasın. Kart dönüyor.", ["betsClosed"]),
  L("para_kucuk_01", "Bozukluk. Simit parası çıktı en azından.", ["bozukluk"]),
  L("para_kucuk_02", "Az ama öz. Annen gurur duyar.", ["bozukluk", "tomar"]),
  L("para_kucuk_03", "Bu parayla ancak çay ısmarlarsın.", ["bozukluk"]),
  L("para_buyuk_01", "Oooo! Çanta dolusu para! Kimse görmedi, değil mi?", ["canta"]),
  L("para_buyuk_02", "Külçe! Altın külçe! Bu masada böyle şey görmedim!", ["kulce"]),
  L("para_buyuk_03", "İşte bu! Para kokusunu buradan alıyorum.", ["canta", "kulce"]),
  L("carpan_01", "Kara para aklandı! Pot ikiye katlandı, tertemiz.", ["aklama"]),
  L("carpan_02", "İki katı! Muhasebeci şu an ağlıyor.", ["aklama"]),
  L("siren_orta_01", "Uzaktan bir siren sesi geliyor... Duyan var mı?", ["sirenMid"]),
  L("siren_orta_02", "Evlat, ben olsam o parayı cebe atardım. Ben olsam.", ["sirenMid"]),
  L("siren_orta_03", "Mahallede mavi ışıklar dolaşıyor. Sinirler gerildi.", ["sirenMid"]),
  L("siren_kritik_01", "Sireni duyuyorum! Kapıdalar! KAPIDALAR!", ["sirenCritical"]),
  L("siren_kritik_02", "Delisin sen! Bir kart daha mı? Cesur mu aptal mı, karar veremedim.", ["sirenCritical"]),
  L("siren_kritik_03", "Masadakiler nefesini tuttu. Ben de tuttum. Çabuk ol.", ["sirenCritical"]),
  L("sure_azaldi_01", "Saat işliyor evlat. Karar ver!", ["timeLow"]),
  L("sure_azaldi_02", "Düşünme, hisset! Yoksa ben senin yerine kasalarım.", ["timeLow"]),
  L("kasala_kucuk_01", "Kasaladı! Az ama sağlam. Korkaklık da bir yetenektir.", ["cashSmall"], 1),
  L("kasala_kucuk_02", "Tavuk gibi kaçtı ama cebi dolu. Saygı duyarım.", ["cashSmall"], 1),
  L("kasala_kucuk_03", "Para güvende. Cesaret biraz eksik ama olsun.", ["cashSmall"], 1),
  L("kasala_buyuk_01", "KASALADI! Büyük vurgun! Patron bu çocuğu işe alsın!", ["cashBig"], 1),
  L("kasala_buyuk_02", "İşte buna para kazanmak denir! Masada sessizlik... kıskançlıktan.", ["cashBig"], 1),
  L("kasala_buyuk_03", "Bu adamı vergi dairesine kimse ihbar etmesin!", ["cashBig"], 1),
  L("baskin_01", "POLİS! Herkes yere! ...Sen hariç. Sen kelepçeye.", ["raid", "raidLate"], 2),
  L("baskin_02", "Baskın! Paralar gitti, arkadaşınız da gitti. Merak etmeyin, geri gelir.", ["raid", "raidLate"], 2),
  L("baskin_03", "Dedim sana! Bir kart daha dedin, bir hücre kazandın.", ["raidLate"], 2),
  L("baskin_04", "Ah evlat... Komiser Rıfat yine iş başında. Para kumbaraya.", ["raid", "raidLate"], 2),
  L("baskin_ilk_kart_01", "Daha ilk kart! İlk kart! Bu masada rekor kırıldı!", ["raidFirst"], 2),
  L("baskin_ilk_kart_02", "Oturdun, çevirdin, tutuklandın. Hızlı adamsın.", ["raidFirst"], 2),
  L("harac_01", "Haraç kesildi! Bu masada kimsenin cebi güvende değil.", ["harac"]),
  L("harac_02", "Elini cebine soktular, fark etmedin bile.", ["harac"]),
  L("harac_03", "Haraç toplandı. Dostluk mu? O ne ki?", ["harac"]),
  L("harac_turu_01", "Haraç turu! Herkes onar lira bıraksın. Gönülden değil, zorla.", ["haracTuru"]),
  L("harac_turu_02", "Masada kim varsa ödüyor. Müsaadenizle.", ["haracTuru"]),
  L("takas_01", "TAKAS! Kasalar yer değiştirdi! Biri zengin uyandı, biri fakir!", ["takas"]),
  L("takas_02", "Ve kasalar el değiştirdi! Bu masada vefa yok beyler!", ["takas"]),
  L("tuzak_01", "Tuzak kuruldu. Sıradaki dikkatli olsun... Olamayacak tabii.", ["tuzak"]),
  L("tuzak_02", "Siren sıradakini bekliyor. Kim ayarladı bunu acaba?", ["tuzak"]),
  L("lanet_01", "Lanet okundu! Sıradaki para kartı boş çıkacak. Nazar değdi.", ["lanet"]),
  L("lanet_02", "Kara büyü mü bu? Mafyada da varmış demek.", ["lanet"]),
  L("lanet_tuttu_01", "İşte nazar! Para geldi, para gitti. Boncuk takacaktın.", ["curseHit"]),
  L("avukat_01", "Avukat geldi! Ücreti tuzlu ama çenesi sağlam.", ["avukat"]),
  L("avukat_02", "Artık bir avukatın var. Bir baskını savuşturur.", ["avukat"]),
  L("avukat_kurtardi_01", "Polis geldi, avukat konuştu, polis gitti. Hukuk devleti!", ["lawyerSaved"], 2),
  L("avukat_kurtardi_02", "Avukat kurtardı! Dosya kayboldu, şahit unuttu!", ["lawyerSaved"], 2),
  L("rusvet_01", "Komisere bir zarf gitti. Siren biraz kısıldı.", ["rusvet"]),
  L("rusvet_02", "Rüşvet verildi. Ben görmedim, siz de görmediniz.", ["rusvet"]),
  L("cark_iniyor_01", "Işıkları kısın! Patronun Çarkı iniyor!", ["wheel"], 3),
  L("cark_iniyor_02", "Patron bugün keyifli. Çark dönüyor, herkes dua etsin!", ["wheel"], 3),
  L("cark_iniyor_03", "ÇARK! ÇARK! Bu masa bu gece tarih yazıyor!", ["wheel"], 3),
  L("cark_kumbara_01", "KUMBARA PATLADI! JACKPOT! Herkes ağlasın, biri dans etsin!", ["wheel_kumbara"], 3),
  L("cark_kumbara_02", "Bütün kumbara! Patron kendi parasına bakıp ağlıyor!", ["wheel_kumbara"], 3),
  L("cark_x10_01", "Pot on katı! ON KATI! Matematik öğretmenim bunu görmeliydi!", ["wheel_x10"], 3),
  L("cark_herkese_100_01", "Patron cömert bugün! Herkese yüzer lira! Kimse alışmasın.", ["wheel_herkese100"], 3),
  L("cark_karistir_01", "Kasalar karıştırıldı! Zengin fakir, fakir zengin! Adalet bu işte!", ["wheel_karistir"], 3),
  L("cark_herkese_ode_01", "Çark konuştu: herkese ellişer lira dağıtacaksın. Hayırsever oldun, istemeden.", ["wheel_herkeseOde"], 3),
  L("cark_avukat_01", "Bedava avukat! Patronun kendi avukatı, en iyisi.", ["wheel_avukat"], 3),
  L("cark_toplu_baskin_01", "Toplu baskın! Herkes cebinden kumbaraya! Kimse kaçamaz!", ["wheel_topluBaskin"], 3),
  L("cark_bir_daha_01", "Bir daha! Çark bir daha dönüyor! Kalbim dayanmaz!", ["wheel_birDaha"], 3),
  L("bahis_sonuc_01", "Bahisler ödendi. Kazananlar sırıtıyor, kaybedenler intikam planlıyor.", ["betsSettled"]),
  L("bahis_sonuc_02", "Kimse arkadaşına güvenmemiş. Haklılarmış.", ["betsRaidersWon"]),
  L("bahis_sonuc_03", "Arkadaşına bahis koyan kaybetti. Bu masada ders bu.", ["betsCashLost"]),
  L("borc_verildi_01", "Borç verildi! Faiz işliyor, tik tak tik tak.", ["loanAccepted"]),
  L("borc_verildi_02", "Tefecilik başladı. Bu dostluk bitti, hayırlı olsun.", ["loanAccepted"]),
  L("borc_reddedildi_01", "Reddedildi! Kardeşim dediğin adam bu işte.", ["loanDeclined"]),
  L("borc_odendi_01", "Borç ödendi! Tefeci üzgün, sen özgürsün.", ["loanRepaid"]),
  L("taslik_01", "Artık bir taşlıksın. Kazandığının yarısı abine gidiyor.", ["taslik"]),
  L("taslik_02", "Borç boğaza dayandı! Hoş geldin, yeni ayakçımız.", ["taslik"]),
  L("son_sans_01", "Kasa sıfır! Biri borç verecek mi, yoksa balıkları mı besleyeceğiz?", ["lastChance"], 2),
  L("nehre_atildi_01", "Çimento ayakkabılar giyildi... Boğaz'ın serin sularına selam söyle.", ["eliminated"], 2),
  L("nehre_atildi_02", "Bir oyuncu daha nehirde. Balıklar zengin olacak.", ["eliminated"], 2),
  L("nehre_atildi_03", "Kasa sıfır, borç veren yok. Elveda dostum. Yüzmeyi bilseydin...", ["eliminated"], 2),
  L("mezardan_dondu_01", "Nehirden döndü! Islak ama döndü!", ["ghostReturn"], 1),
  L("mezardan_dondu_02", "Yosunlu, ıslak, sinirli... ama masada! Bu adam ölümsüz!", ["ghostReturn"], 1),
  L("son_masa_01", "Son masa beyler! Her şey iki katı! Kazanç da, ceza da!", ["finalTable"], 1),
  L("son_masa_02", "Son tur. Ya kral olursun ya bahşiş bırakırsın.", ["finalTable"], 1),
  L("mac_sonu_01", "Oyun bitti. Kaybedenler masayı devirmesin lütfen.", ["matchEnd"], 3),
  L("mac_sonu_02", "Ve gecenin babası belli oldu! Elini öpün!", ["podium"], 3),
  L("mac_sonu_03", "Paralar sayıldı. Polis gelmeden dağılalım.", ["podiumAfter"], 3),
  L("unvan_bomba_miknatisi_01", "Bomba Mıknatısı ödülü... polisin en sevdiği müşteriye!", ["title_bombaMiknatisi"], 3),
  L("unvan_borc_krali_01", "Borç Kralı! Herkese borcu var, kimseye ödemedi!", ["title_borcKrali"], 3),
  L("unvan_korkak_01", "En Büyük Korkak! Hep ikinci kartta kasaladı. Tavuklar gurur duysun.", ["title_korkak"], 3),
  L("unvan_kor_bahisci_01", "Kör Bahisçi! Bütün bahisleri kaybetti. Gözlük almanı öneririm.", ["title_korBahisci"], 3),
  L("unvan_kara_liste_01", "Kara Liste! Borcunu ödemeden kaçtı. Mahallede yüzüne bakan yok.", ["title_karaListe"], 3),
  L("unvan_kumarbaz_01", "Gözü Kara! En çok kartı tek turda çeviren deli bu.", ["title_gozuKara"], 3),
];

export const ANNOUNCER_BY_ID: Record<string, AnnouncerLine> = Object.fromEntries(ANNOUNCER_LINES.map((l) => [l.id, l]));

/** Lines that can be picked for an event. */
export function linesFor(event: AnnouncerEvent): AnnouncerLine[] {
  return ANNOUNCER_LINES.filter((l) => l.events.includes(event));
}

/**
 * Pick a random line for `event`, avoiding `lastId` (the previous line played for this event) when there is
 * a choice. `random` returns [0, 1). Returns null when the event has no lines.
 */
export function pickLine(event: AnnouncerEvent, lastId: string | undefined, random: () => number): AnnouncerLine | null {
  const all = linesFor(event);
  if (all.length === 0) return null;
  const pool = all.length > 1 && lastId ? all.filter((l) => l.id !== lastId) : all;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

/** Rough spoken length of a line, for subtitles when no mp3 is recorded yet. */
export function lineDurationSec(text: string): number {
  return Math.max(2.5, Math.min(7, text.length * 0.065));
}
