# RAFT RUSH — Oyun Tasarım Dokümanı (game4.md)

> Tarayıcıda 1–6 arkadaş için **birinci şahıs, co-op ada hayatta kalma parti oyunu**. Gemi battı, bir adaya vurdunuz, **8 dakika sonra Büyük Fırtına geliyor**. Gündüz odun kes, balık tut, craft'la; gece kamp ateşini ve salı yengeçlerden koru. Üç gecenin sonunda sal denize inmezse hepiniz ikinci kez kazazedesiniz. Her ada bir tohumdan üretilir, her olta atışı bir piyango: **iki maç asla aynı hissettirmez.**

## 1. Kararlar (görüşmeden)
| Konu | Karar |
|---|---|
| Süre / hedef | **~8 dk.** Ekip birlikte **sal** inşa eder, erzak yükler ve fırtına gelmeden adadan kaçar |
| Tehlike | **Açlık / Susuzluk / Isı barları + gece canavarları** (yengeçler, kirpi topları, Kaptan Yengeç) |
| Çeşitlilik | **Prosedürel ada (seed)**: şekil, biyom, landmark'lar her maç farklı. **Balık tutma & şansa bağlı itemler**: loot tablosu, hazine sandıkları, tek kullanımlık güçler |
| İhanet | Yok. **Saf co-op**, maç sonunda **MVP** ve utanç unvanları |
| Kamera | **Birinci şahıs**, yürüyen FP kontrolcü (pointer lock, head-bob, FP kollar) |
| Karakterler | **Yeni set: "Gemi Turistleri"** (6 prosedürel fasulye-gövdeli turist) |
| Dil | **TR + EN**, Jelly Jackpot'un i18n sistemi; her string iki dilde zorunlu |
| Oyuncu | **1–6, solo oynanabilir** (yardımcı botlar). Ek mod **Ada Savaşı**: iki takım, iki ada, baskın ve ev yıkma |
| Savaş | **Fırlatma ağırlıklı**: hindistan cevizi, taş, mızrak, balık, çizme, kirpi balığı. Bonk Brawl'un top fiziği + yakalama |
| Craft | **Orta derinlik**: kamp ateşi tezgahında 8 tarif, 4 slot envanter, ortak kamp sandığı |
| Ton | Goofy turist mizahı: martı hırsızı, selfie çubuğu, "dalgalar seni kıyıya attı" |
| Teknik | Three.js istemci, Node.js + Colyseus otoriter sunucu, 30 Hz sim. Bonk Brawl / Jelly Jackpot / KASALA ile aynı yığın, yeni bağımlılık yok |

## 2. Tanıtım
Cruise gemisi "MS Neşe" bir kayaya çarptı. Kaptan hâlâ inkârda, Fenomen her şeyi çekiyor, Emekli Amca radyosunu kurtarmış, Balayı Gelini duvakla paletle sahile çıktı. 1–6 turist, 60 metrelik bir adada. HUD'da güneş yayı ilerliyor: **Gün 1/3**.

Gündüz odun kesersin, palmiyeyi sallayıp hindistan cevizi düşürürsün, pınardan kabukla su taşırsın, oltanı atarsın. Kamp ateşinin başında mızrak, meşale, balta, sal parçası craft'larsın. Kumsaldaki sal üç aşamada büyür: **gövde, direk-yelken, erzak**. Alacakaranlıkta ateşi beslersin, meşaleni yakarsın. Sonra gece: kıyıdan **gece yengeçleri** çıkar. Işığa girmezler ama ateş sönerse kampı basar, sal parçalarını kemirirler. Hindistan cevizini şarj edip fırlatırsın, yengeç ters döner, sabah onu pişirip yersin.

Üçüncü gece **Kaptan Yengeç** gelir, doğrudan salı hedefler. Biri "BALIĞI ATMA ORAYA!" diye bağırır çünkü yengeçler balığa koşar. Sal tamamsa herkes **E** ile biner, sal denize iner, fırtına arkanızdan kopar. Biri geç kaldıysa kumsalda kalır ve bir voleybol topuyla finale girer.

Bir sonraki maçta ada başka: bataklık biyomu, sis, pınar tepede, enkaz ters tarafta. Oltadan bu sefer **hazine sandığı** çıkar: içinden işaret fişeği, bir geceyi canavarsız geçirirsiniz. Ya da patlayan kirpi balığı çıkar ve arkadaşın onu elinde tutmaya çalışırken…

## 3. Neden eğlenceli
- **Panik dağılımı:** 8 dakika az. Kim odun kesiyor, kim su taşıyor, kim balık tutuyor? "ODUN! ODUN LAZIM!" Overcooked'un iş bölümü paniği, ama açık havada ve birinci şahısta.
- **Gece sal savunması:** Ateşin ışık halkası daralıyor, karanlıkta kırmızı gözler, meşaleyi kim tutuyor? Sal parçası kemirildikçe ilerleme çubuğu geri gidiyor.
- **Balık tutma = piyango:** Şamandıra batar, tık, reel döner. Çizme. Çizme. Balık. **ALTIN BALIK!** Jelly Jackpot'un case dopamini, survival sosuyla.
- **Barlar kavga çıkarır:** "Son hindistan cevizini kim yedi?" Açlık barı sıfırlanan oyuncu yavaşlar ve herkes onu taşımak zorunda kalır.
- **FP fırlatma hissi:** Şarj, bırak, yay. Arkadaşının kafasına hindistan cevizi. Takım modunda boğaz üzerinden tam şarj lob.
- **Her ada farklı:** Seed lobide yazar. "Dün 4471'de pınar tepedeydi, bugün 9023'te mağaranın içinde." Aynı seed tekrar oynanabilir, rekor kovalanır.
- **Final anı:** Sal iniyor, biri hâlâ ormanda. "KOŞ! KOŞŞŞ!" Fırtına 20 saniye sonra.

## 4. Oyun döngüsü & zaman çizelgesi
1. **Lobi:** İsim + turist karakteri seçilir. Host: mod (**Co-op** / **Ada Savaşı**), zorluk (**Tatil / Normal / Kabus**), bot ekle/çıkar (0–5), seed (rastgele ya da elle). Hazır'a basılır.
2. **Karaya çıkış (10 sn):** Herkes enkazın yanında kumsalda doğar; elinde rastgele 1 başlangıç eşyası (odun ×2, hindistan cevizi, taş, ip…). Enkaz sandığında 2 rastgele eşya. Banner: **"GÜN 1 — Fırtınaya 7:45"**.
3. **Gün döngüsü × 3:**
   | Faz | Süre | Ne olur |
   |---|---|---|
   | **Gündüz** | 95 sn | Topla, balık tut, craft, sal inşa et, su/yemek stokla. Günün hava olayı gündüz ortasında başlar |
   | **Alacakaranlık** | 10 sn | Gök turuncuya döner, davullar başlar. Banner: "GECE GELİYOR". Ateşi besle, meşale yak, sala yaklaş |
   | **Gece** | 50 sn | Yengeçler kıyıdan çıkar. Isı barı ateşten uzakta düşer. Yapılar ve oyuncular saldırı alır |
4. **Sal:** 3 aşama, kumsaldaki sal alanına eşya teslim edilerek dolar (bkz. §7). Üç aşama da tamamsa sal "HAZIR" olur; **tüm hayatta kalan oyuncular E ile bindiğinde** sal iner → kazandınız. Erken iniş = daha yüksek skor.
5. **Fırtına (3. gecenin sonu, 20 sn):** Sal inmediyse gök kararır, dalgalar yükselir, kamp uçar: **kaybettiniz**. Maç sonu ekranı yine açılır (istatistik + MVP + "Rövanş").
6. **Düşme / diriltme:** Can sıfırlanan oyuncu **düşer** (yerde sürünür, 10 sn). Arkadaş E'ye basılı tutarak 3 sn'de kaldırır (yarım can). Süre dolarsa "**Dalgalar seni kıyıya attı**": envanter kaybolur, sonraki şafakta enkazda yeniden doğar. Gece 3'te düşen oyuncu şafak olmadığı için **sala binemez**; ekip onu kaldırmak zorunda.

**Süre hesabı:** Karaya çıkış 10 sn + 3 × (95 + 10 + 50) sn = 475 sn + fırtına/iniş sahnesi ~20 sn ≈ **8 dk 15 sn**. Lobi ve podyum hariç.

## 5. Hayatta kalma barları
| Bar | Düşüş | Dolum | Sıfırda |
|---|---|---|---|
| **Açlık** | 100 → 0 yaklaşık 4 dk'da (25/dk); koşarken ×1.5 | Yemek (bkz. §6 tablo) | Hareket ×0.7, can −2/sn |
| **Susuzluk** | 100 → 0 yaklaşık 3 dk'da (33/dk); sıcak dalgasında ×2 | Pınar (+50), hindistan cevizi (+25), su toplayıcı (+40) | Hareket ×0.7, görüş kenarları bulanır, can −2/sn |
| **Isı** | Sadece **gece, yağmurda ve suda** düşer: ateşten uzakta 2/sn (50 sn'de biter) | Ateş 3 m içinde +5/sn, meşale elde −1/sn'e düşürür, mağara/kulübe yağmuru keser | Titreme, hareket ×0.6, can −2/sn |
| **Can** | Saldırı: yengeç ısırığı 15, kirpi topu 20, Kaptan Yengeç 35; her boş bar −2/sn | Zamanla değil: yemek yemek +10, ateş başında +3/sn, diriltme yarım can | **Düşer** (§4) |

Barlar sol altta üç küçük ikon olarak durur; sadece %30 altına inince yanıp söner ve bir feed satırı çıkar ("Fenomen açlıktan ölüyor"). Hindistan cevizi hem yemek hem su verdiği için **en sevilen kaynaktır** ve bilerek kıt tutulur (palmiye başına 2, 60 sn'de yeniden büyür).

## 6. Kaynaklar & dünya
| Kaynak | Nerede | Nasıl | Not |
|---|---|---|---|
| **Odun** | Ağaçlar (ağaç başına 3) | E basılı tut: elle 2.5 sn, baltayla 1 sn | Sal ve çoğu tarifin temeli |
| **İp** (sarmaşık) | Çalılar, sarmaşıklı ağaçlar | E, 1.5 sn | Olta, meşale, direk |
| **Taş** | Kayalar (kaya başına 2) | E, 2 sn | Mızrak, balta; fırlatılabilir |
| **Hindistan cevizi** | Palmiyeler (2'şer, 60 sn'de büyür) | Palmiyeye vur (sol tık) → düşer, E ile al | Yemek + su + mermi |
| **Böğürtlen** | Çalıların %40'ı | E, 1 sn | +15 açlık, anında yenir |
| **Tatlı su** | Pınar (adada 1 tane, seed'e göre yerde) | Kabuk/su kabağı ile E: +1 su kabı | Kap 4 slot'ta 1 yer tutar |
| **Balık** | Olta ile kıyı/kayalık balık noktaları | §8 mini oyun | Çiğ +20, pişmiş +45 açlık |
| **Enkaz** | Spawn noktası | Başlangıç sandığı: 2 rastgele eşya | Ayrıca 1 sal parçası "bedava" sayılır (gövde başlangıcı) |

**Gündüz küçük olayları (her gün 1, rastgele):** Martı **Şükrü** birinin elindeki balığı kapar (fırlatarak kovalanır, balık düşer). **Maymunlar** kamp sandığından 1 eşya çalar ve ağaca kaçar; hindistan cevizi atılırsa bırakırlar. **Dalga hediyesi**: kıyıya bir sandık vurur. **Yağmur** (§9).

## 7. Craft: kamp ateşi tezgahı
Kamp ateşi spawn'ın yanında hazır yanar ama **yakıt barı** vardır: 60 sn'de söner, odun atınca +30 sn. Sönerse gece ısı yok, ışık yok, tarif yok. Ateşin 3 m yakınında **E** craft panelini açar.

| Tarif | Maliyet | Ne yapar |
|---|---|---|
| **Mızrak** | 1 odun + 1 taş | Fırlatılır, saplanır, geri alınır. 2 hasar |
| **Olta** | 2 odun + 1 ip | Balık noktalarında balık tutar (§8) |
| **Meşale** | 1 odun + 1 ip | Elde 4 m ışık halkası, 90 sn yanar. Yengeçler halkaya girmez. Yere saplanabilir (sabit ışık) |
| **Balta** | 1 odun + 1 taş + 1 ip | Odun 1 sn'de kesilir, palmiye tek vuruşta tüm cevizleri döker |
| **Su toplayıcı** | 2 odun + 1 ip | Kampa kurulur; yağmurda dolar, E ile +40 su (3 kullanım) |
| **Çit parçası** | 2 odun | Yere konur; yengeçler 4 sn kemirerek geçer, kirpi topları takılır |
| **Pişir** | 1 çiğ balık / yengeç | Pişmiş balık +45, pişmiş yengeç +50 açlık |
| **Sal parçası** | 3 odun (+1 ip direk aşamasında) | Sal alanına taşınır (1 slot), E ile teslim |

Ada Savaşı ek tarifleri: **Kulübe** (6 odun + 2 ip; ekip evi, §13) ve **Kano** (4 odun + 2 ip; 2 kişilik, boğazı 6 sn'de geçer).

**Envanter:** 4 slot, slot başına tek tür yığın (odun ×5, taş ×3, ip ×5, cevizler ×3; aletler 1). **Kamp sandığı**: ateşin yanında sınırsız ortak depo, E ile koy/al. Tarifler sandıktaki malzemeyi de görür (kimse "malzemeyi bana ver" demek zorunda değil).

**Sal aşamaları (koltuk sayısına göre, bot dahil):**
| Koltuk | Gövde (odun) | Direk + yelken | Erzak |
|---|---|---|---|
| 2 | 10 | 4 odun + 4 ip | 2 yemek + 2 su |
| 3 | 13 | 4 odun + 5 ip | 3 yemek + 3 su |
| 4 | 16 | 4 odun + 6 ip | 4 yemek + 4 su |
| 5 | 20 | 4 odun + 7 ip | 5 yemek + 5 su |
| 6 | 24 | 4 odun + 8 ip | 6 yemek + 6 su |

Sal parçası 3 odun sayıldığından gövde 4–8 teslimattır. Yengeç kemirmesi gövdeden **1 odun/4 sn** düşürür; sal yakınında ekipten biri varken (`RAFT_GUARD_RADIUS` 6 m) yengeçler önce oyuncuyu hedefler.

## 8. Balık tutma & şans
Olta elde, bir **balık noktasına** (kıyıda köpüren su, seed'e göre 4–6 tane; kayalık biyomda daha çok) bakıp sol tık: şamandıra atılır. 2–6 sn sonra şamandıra **batar** ve 0.6 sn'lik pencere açılır: tık → yakaladın; geç kaldın → kaçtı. Yakalayınca ekranda Jelly'nin case reeli gibi bir **"Ne çıktı?"** şeridi döner ve sunucunun seçtiği kartta durur.

| Sonuç | Ağırlık | Etki |
|---|---|---|
| **Balık** | 45 | Çiğ +20 / pişmiş +45 açlık. Fırlatılırsa **yem**: 8 sn boyunca yengeçler oraya koşar |
| **Yengeç** | 12 | Pişmiş +50 açlık |
| **Çizme** | 10 | Hurda; fırlatılır, 1 hasar + geri itme. Kozmetik: giyilebilir |
| **Denizanası** | 8 | Elde tutunca −3 can/sn (komik "AAAH"); meşaleye atılırsa +60 sn yakıt |
| **Kirpi balığı** | 6 | Fırlatılınca 3 m alanda patlar: 2 hasar + yengeçleri ters çevirir. Elde 5 sn sonra kendisi patlar! |
| **Şişede mesaj** | 6 | Pusulada gizli **sandık** ya da pınar işaretlenir; ya da bir "efsane tarif" (ör. **Hindistan cevizi topu**: 3 ceviz → 3'lü atış) |
| **Hazine sandığı** | 5 | Sandık reeli açılır: **İşaret fişeği** (bir gece canavar gelmez), **Eski yelken** (direk aşaması anında tamam), **Korsan şapkası** (kozmetik + 20 puan), **Kaptan dürbünü** (pusulada tüm kaynaklar 30 sn), **Yakıt bidonu** (ateş 120 sn söner) |
| **Altın balık** | 3 | +100 açlık, +50 susuzluk, 25 MVP puanı, parıltılı nameplate |
| **Kraken dokunacı** | 1 | Yere konur: 10 sn boyunca etrafa vurur, yengeçleri fırlatır. Ya da pişirilir: tüm ekibe +30 açlık |

**Şans eğrisi:** Loot tablosu maç başında seed'den karıştırılır ve biyoma göre ağırlıklar oynar (bataklık: denizanası ×2; kayalık: sandık ×1.5). Aynı seed → aynı tablo, ama atış sırası oyuncu zamanlamasına bağlı olduğundan sonuç yine değişir. **Kötü şans koruması:** 4 ardışık hurda/denizanasından sonra bir sonraki atış en az Balık garantili.

## 9. Prosedürel ada & hava
**Seed** (32 bit) lobide gösterilir, elle girilebilir, paylaşılabilir ("bu adayı tekrar oyna"). Seed şunları belirler:
- **Ada şekli:** ~60 m çapında, elips maskeli fBm heightmap; kıyı çizgisi düşük frekanslı halka gürültüsüyle girintili çıkıntılı. Tepe 8–10 m. Sığ kıyı şeridi (yürünür), derin su (yüzülür).
- **Biyom** (4, aşağıdaki tablo).
- **Landmark'lar** rastgele yerleşir ama koridor garantisiyle (kamp↔spawn↔sal↔kıyı arası 2 m temiz): **Enkaz** (spawn, kumsal), **Kamp ateşi** (enkaza 8–12 m), **Sal kumsalı** (en düz kıyı hücresi), **Pınar** (içeride, çoğu zaman tepeye yakın), **Mağara** (yağmur/ısı sığınağı), **Gizli sandık** (yalnızca şişe mesajıyla bulunur), 4–6 **balık noktası**.
- **Kaynak yerleşimi:** 120 ağaç, 30 palmiye, 60 kaya, 80 çalı; biyom bu sayıları çarpar.

| Biyom | Karakter |
|---|---|
| **Tropik** | Bol palmiye, bol ceviz, standart yengeç. "Tatil" hissi |
| **Kayalık** | Taş çok, ağaç az, yemek az; balık noktaları ve sandık şansı fazla; uçurumlar |
| **Bataklık** | İp çok, böğürtlen çok, **sis** (görüş 30 m), yengeç ×1.5, denizanası ×2 |
| **Volkanik** | Gece ısı düşmez (sıcak toprak), taş çok, ağaç az; **kıpkırmızı gökyüzü**, kirpi topları ×2 |

**Hava olayları (günde 1, 2. günden itibaren garanti):**
| Olay | Etki |
|---|---|
| **Yağmur** | Su toplayıcılar dolar, pınar kuyruğu biter; **kamp ateşi söner** (kulübe/mağara altındaki yanar), ısı düşer, gökyüzü gri |
| **Sis** | Görüş 25 m, pusula işaretleri kaybolur (ping işaretleri kalır) |
| **Sıcak dalgası** | Susuzluk ×2, gölgede (ağaç altında) ×1 |
| **Dolunay** | Gece canavarı ×1.5 ama gece neredeyse gündüz gibi aydınlık |

## 10. Gece canavarları
| Gece | Gelenler | Davranış |
|---|---|---|
| 1 | **Yengeçler** (3 + koltuk) | Yavaş (3 m/sn), zırhlı; 2 hasarda **ters döner** (8 sn çaresiz, E ile toplanır → çiğ yengeç) |
| 2 | Yengeçler (5 + koltuk×1.5) + **Kirpi topları** (2) | Kirpi topu yuvarlanarak hızlı gelir, çite takılır, çarptığında 20 hasar + geri itme; 1 hasarla patlar |
| 3 | Yengeçler (6 + koltuk×2) + kirpi (3) + **Kaptan Yengeç** | Boss: 12 can, salı hedefler, 35 hasar, kıskaçla çiti kırar. Ters dönmez; ışıktan sadece yavaşlar. Yem balığına 5 sn kanar |

**Ortak kurallar:** Kıyıdan çıkarlar (kıyı hücrelerinden rastgele, kampın uzak tarafı ağırlıklı). **Işık halkasına girmezler** (ateş 5 m, meşale 4 m; boss hariç). Hedef önceliği: yakındaki oyuncu > yere atılmış balık/yem > sal > sandık > çit. Şafakta kıyıya geri kaçarlar. Zorluk çarpanları: Tatil ×0.6, Normal ×1, Kabus ×1.5 (ve boss gece 2'de de gelir).

**Yem mekaniği:** Yere düşen balık 8 sn boyunca 15 m içindeki tüm yengeçleri çeker. Co-op'ta salı kurtarmak için, Ada Savaşı'nda düşman kumsalına atmak için.

## 11. Fırlatma & savaş
Bonk Brawl'un fırlatma hissi birinci şahısta: **sol tık basılı** → şarj çubuğu (0.6 sn tam), **bırak** → yay. Nişan noktalı yay tahmini (ArcPreview) sadece tam şarjın %50'sinden sonra görünür. **Sağ tık**: yakalama; arkadaşının attığı cevizi/balığı yakalayıp paslaşma (takım modunda düşman atışı da yakalanır ve mermi senin olur).

| Fırlatılabilir | Hasar | Özellik |
|---|---|---|
| Hindistan cevizi | 1 | Sekerek 2 zıplar, tekrar alınır. Ağaca çarpınca ceviz düşürür! |
| Taş | 1 | Düz gider, sekmez |
| Mızrak | 2 | Saplanır, E ile geri alınır; en uzun menzil |
| Balık | 0 | **Yem** (§10) |
| Çizme | 1 | Geri itme ×2, komik "bonk" sesi |
| Kirpi balığı | 2, 3 m alan | Patlar, yengeçleri ters çevirir, oyuncuları (dost dahil) geri iter |
| Meşale (elde) | — | Yere saplanır: sabit ışık; sol tık ile **sallama**: 2 m içindeki yengeç 1 sn geri kaçar |

Yakın temas yok (mızrak bile fırlatılır). Dost ateşi: co-op'ta hasar yok ama geri itme var (şaka için). Vurulan oyuncu 0.3 sn sersemler. Ada Savaşı'nda düşman oyuncuya hasar tam.

## 12. Co-op katmanı
- **Ortak kamp sandığı** ve **ateş yakıtı barı** (HUD'da küçük alev ikonu; %20 altında herkese banner).
- **Ping sistemi (orta tık ya da V):** 4 dilimli çark: "**Buraya!**", "**Yardım!**", "**Bu lazım**" (baktığın kaynağa göre: "Odun lazım"), "**Tehlike!**". Pusula şeridinde 8 sn işaret, 3D'de balon, 1 sn/oyuncu hız sınırı.
- **Diriltme** (§4) ve **pas**: Q ile elindeki eşyayı önüne fırlat; arkadaş sağ tıkla yakalar. Uzun mesafe sal parçası paslaşma zinciri = en hızlı inşa.
- **Emoteler (T + 1–6):** Alkış, Panik, Dans, Yorgun, "Sus", Selfie (Fenomen için özel).
- **Sal yükleme animasyonu:** Teslim edilen her parça sal üzerinde görünür (kütükler, direk, yelken, sandıklar). İlerleme hem HUD'da hem sahnede okunur.
- **Yardımcı botlar:** Lobiden eklenir (0–5), solo başlayınca otomatik 2. Botlar gerçek oyuncu koltuğudur: aynı hareket, aynı envanter. Kişilikler:
  | Bot | Öncelik |
  |---|---|
  | **Hamal** | Odun/taş toplar, sala teslim eder |
  | **Balıkçı** | Olta yapar, balık tutar, pişirir, sandığa koyar |
  | **Bekçi** | Gündüz ceviz stoklar, gece salın başında fırlatır, meşale tutar |
  | **Aşçı** | Su ve yemek taşır, barı düşük oyuncuya yaklaşıp Q ile pas atar |
  Botlar maça ortasında çıkan oyuncunun koltuğunu devralır (KASALA kuralı). Bot düşünme gecikmesi 0.6–1.5 sn; insan gibi takılır, bazen yanlış yere ceviz atar.

## 13. Takım modu: "Ada Savaşı"
4–6 oyuncu (2v2, 3v3; botla tamamlanır). **Aynı dünyada iki ada**, arada 26–30 m sığ **boğaz**; seed'e göre bazen bir kum seti (yürünerek geçilir, gece köpekbalığı yüzgeci dolaşır).

- Her takımın kendi enkazı, ateşi, sandığı, sal kumsalı var. Gün 1'de **Kulübe** (6 odun + 2 ip) zorunlu: yoksa gece ısı ×2 düşer ve yengeçler sandığı yağmalar.
- **Düşman adaya geçiş:** yüzerek (hız ×0.5, susuzluk ×2, gece köpekbalığı 20 hasar) ya da **Kano** ile (2 kişi, 6 sn).
- **Saldırı yolları:** boğaz üzerinden tam şarj fırlatma (max menzil ~58 m, boğaz tam şarj lob ister), meşaleyle **kulübe/sal parçasını yakma** (sal gövdesi −3 odun, kulübe 3 vuruşta yıkılır), düşman sandığından çalıp kendi sandığına taşıma (1 slot, yakalanırsan düşürürsün), düşman kumsalına **balık atıp yengeçleri çekme**, kirpi balığıyla çit kırma.
- **Savunma:** Çit, meşale halkası, bekçi bot, salın yanında durmak (`RAFT_GUARD_RADIUS`: sahibi yakındayken sal hasar almaz, önce oyuncu hedeflenir).
- **Dengeleme kancaları:** baskına giden takımın kampına gece daha çok yengeç gelir (`monsterPressure = taban × (1 + 0.25 × dışarıdaki oyuncu) × (1 − 0.15 × meşale)`); son gece iki tarafta da ısı ×2 (ani ölüm); gece canavarları her iki adaya gelir ("ateşkes" dramı).
- **Kazanma:** **İlk salı indiren takım.** Rakibin kulübesi + salı tamamen yıkıldıysa anında kazanırsın. Fırtınaya kadar kimse inmediyse: sal ilerlemesi, sonra kulübe canı, sonra puan.

## 14. Mizah & karakterler: "Gemi Turistleri"
Altı prosedürel, fasulye gövdeli turist. Hepsi birinci şahısta kendi **kollarını** görür (kıyafet kolu karaktere göre), diğerleri tam gövdeyi görür.
| Karakter | Görünüş | Tik / küçük bonus |
|---|---|---|
| **Kaptan** | Beyaz üniforma, şapka, pipo | Pingleri "emir" tonunda; sal teslimi +%10 hızlı |
| **Fenomen** | Selfie çubuğu, güneş gözlüğü, ring light | Selfie emotu; maymunlar önce onun çubuğunu çalar |
| **Emekli Amca** | Hawaii gömleği, transistörlü radyo | Müziğin kaynağı odur: ondan uzaklaşınca müzik kısılır |
| **Balayı Gelini** | Duvak + palet + şnorkel | En hızlı yüzer |
| **Şef** | Önlük, kepçe | Pişirme 2× hızlı, pişmiş yemek +5 |
| **Kolluklu Çocuk** | Şişme kolluklar, ördek simidi | Suda ısı kaybetmez, en küçük hitbox |

**Mizah anları:** martı Şükrü balığını kapar ve 3 tur attıktan sonra düşürür; "**Dalgalar seni kıyıya attı**" ölüm ekranı (deniz yosunuyla); kirpi balığı elinde patlayan oyuncunun 2 sn **şişmesi**; maymunların selfie çubuğuyla ağaçta poz vermesi; sala binemeyen oyuncunun kumsalda bir voleybol topuyla el ele kalması ("Wilson finali"); yengeçlerin ters dönünce bacak sallaması; Kaptan'ın her gece "Gemi batmadı, demirledi" lafı (feed). Spiker yok; feed satırları + Jelly tarzı formant gibberish sesler (her turistin kendi tınısı).

## 15. Kontroller (klavye + fare)
| Tuş | İşlev |
|---|---|
| W A S D | Hareket |
| Fare | Bakış (pointer lock) |
| Space | Zıpla |
| Shift | Koş (açlık ×1.5) |
| Sol tık | Kullan: basılı tut şarj, bırak fırlat / palmiyeye vur / olta at / meşale salla |
| Sağ tık | Yakala |
| E | Etkileşim: topla (basılı), sandık, craft paneli, sal teslim, diriltme (basılı), sala bin |
| 1–4 / tekerlek | Envanter slotu |
| Q | Elindekini bırak / pas fırlat |
| Orta tık / V | Ping çarkı |
| T + 1–6 | Emote |
| H (basılı) | Lejant: tarifler, loot tablosu, kontroller |
| Tab | Skor / istatistik |
| Esc | Menü (ses, dil, hassasiyet, kalite) |

Dokunmatik v1'de yok.

## 16. Sahne & sanat yönü
- **Stil:** Flat-shaded toon (Bonk `Toon.ts` rampası + outline), pastel tropikal palet. Düşük poligon palmiyeler (6 kenarlı gövde + yaprak düzlemleri), 3–4 ağaç arketipi, 2 kaya, 2 çalı; `InstancedMesh` ile çizilir.
- **Zemin:** Heightmap'ten 4 chunk flat-shaded mesh; yüz rengi yükseklik/eğime göre (kum < 0.6 m, çimen, eğimde kaya), hash tabanlı renk titremesi.
- **Su:** 220 m tek düzlem, vertex dalga, kıyıya mesafeye göre köpük şeridi, yarı saydam; gece koyu lacivert + ay yansıması şeridi.
- **Gün-gece:** SkyDome gradient + güneş/ay yönü maç saatine bağlı; sis uzaklığı gündüz 160 m / gece 45 m; gece sadece ateş (point light), meşaleler ve ay; ateş böcekleri (instanced parçacık), yıldızlar.
- **Yengeçler:** Kırmızı-turuncu, neon gözlü, kıskaçları abartılı; Kaptan Yengeç'te kaptan şapkası (kazadan kalma).
- **Kamera:** FP, FOV 75°, koşarken +5, head-bob hız bazlı, fırlatmada hafif geri tepme (CameraShake), yakalamada zoom darbesi. Düşünce kamera yere iner, yarı siyah-beyaz.

**Palet:** Kum `#F4E4B0`, çimen `#7CCB6B`, orman yeşili `#3E8E52`, deniz `#3FB7D9` → gece `#102A4A`, gün batımı `#FF9A5A`, ateş `#FFB347`, yengeç `#FF4D3A`, HUD vurgu `#FFD166` (game.json `accent`).

## 17. HUD (KASALA sadeleştirme yaklaşımı)
"Her olay bir kez söylenir"; sahne ve nameplate'ler gerisini anlatır.
- **Sürekli, küçük:** sol altta 3 bar + can ikonları; alt ortada 4 slot hotbar; üst ortada güneş/ay yayı + "**Gün 2/3 — 1:35**"; üst sağda sal ilerleme (3 segment) + ateş yakıtı alevi; üstte **pusula şeridi** (kamp, sal, pınar, ping, şişe işaretleri).
- **Duruma bağlı:** nişangâh altında etkileşim ipucu ("E: Odun kes"), craft paneli (ateş başında E; tarifler yeşil/gri), balık zamanlama çubuğu, diriltme halkası, şarj çubuğu, takım modunda **TeamStrip** (iki salın ilerlemesi).
- **Kısa ömürlü:** feed (2 satır, 5 sn), banner ("GECE GELİYOR", "SAL HAZIR!", "FIRTINA!"), ping balonları, Coach ipuçları (ilk maç: "Ateşe odun at").
- **İsteğe bağlı:** H ile lejant; Tab ile istatistik tablosu (toplanan, teslim, vuruş, balık, diriltme).
- Erişilebilirlik: azaltılmış yanıp sönme, bar renklerinin yanında ikon, pointer lock olmayan tarayıcıda sürükle-bak yedeği.

## 18. Ses
Tamamı Web Audio sentezi (dosya yok):
- **Ambiyans:** dalga döngüsü (filtrelenmiş gürültü), gündüz martı/rüzgâr, gece cırcır böceği; alacakaranlıkta **davullar** girer, gece boyunca tempo yengeç sayısıyla artar.
- **Müzik:** Bonk `Band` motoru (Karplus-Strong ukulele, kazoo, ksilofon) ile prosedürel ada ezgisi; gece minör moda geçer; kaynak **Emekli Amca'nın radyosu** (uzaklaşınca kısılır, radyoyu yanında taşıyan kazanır).
- **SFX:** odun kesme "tok", ceviz düşme, şarj vınlaması, fırlatma "fiu", yengeç tıkırtısı, ters dönme "çat", kirpi patlaması, reel tıkları, ateş çıtırtısı, yağmur, fırtına gökgürültüsü.
- **Sesler:** her turistin formant gibberish tınısı (Jelly `voices.ts`), ping ve emotelerde kısa laf.
- Ducking: banner ve boss girişinde müzik kısılır.

## 19. Çok oyunculu & ağ
### Mimari
- **Otoriter sunucu** (Node.js + Colyseus), **30 Hz sim / 20 Hz patch** (Bonk Brawl ile aynı sabitler; kopyalanan Prediction/Interpolation/Clock/InputQueues bu tick'e göre yazılmış).
- **Sunucu sahibi:** barlar, envanter ve craft, kaynak düğümü miktarları, yapılar, canavar AI, fırlatma vuruşları, gün/gece saati, seed + otoriter heightfield, kazanma/MVP, botlar.
- **İstemci sahibi:** seed'den mesh/dekor üretimi, kendi oyuncusunun tahmini, uzak oyuncu interpolasyonu, fırlatma dead-reckoning, görsel/ses/i18n.
- **Ortak (`shared/`):** heightfield + cover sorgusu, `stepPlayer`, `stepProjectile`, fırlatma matematiği, ada üreteci.

### Determinizm (en kritik risk)
Sunucu V8, istemci JSC/SpiderMonkey olabilir; `Math.sin/cos/pow` motorlar arası bit-eşit değil. Oyun heightfield'ı bu yüzden **tamsayı hash (`hash2`, `Math.imul`) + bilinear/smoothstep + sqrt** ile üretilir, `Float32Array` gridde tutulur; FNV hash'i `welcome` mesajında (`gridHash`) gider, istemci karşılaştırıp uyuşmazlıkta uyarı verir. Kozmetik titreme istediğini kullanabilir, oyun yüksekliği kullanamaz.

### FP yürüme
Bonk `stepPlayer` çatısı korunur: sayaçlar → bakış → wish → edge tuşlar → şarj/fırlat → hız → alt adımlı integrate + cover push-out → zemin. Çıkarılır: roll, catch-whiff, yetenekler, zoomies. Eklenir: `heightAt` zemini; **basamak/uçurum kuralı** (alt adımda yükseklik farkı > 0.5 m → adımı reddet, kontur boyunca kay; ~56°'den dik eğim duvar olur); **yüzme** (`feetY < waterY − 0.6` → hız ×0.5, zıplama yok, `swimTicks`; sunucu ısı düşürür, 20 sn sonra boğulma); `gatherTicks` (E basılıyken hareket donar, sonuç sunucuda); `sprint`; pitch limiti 1.5 rad; göz yüksekliği 1.55 m; fırlatma başlangıcı göz + ileri 0.3 + sağ 0.25. Yeni `BTN` bitmask: THROW, JUMP, INTERACT, SPRINT, DROP, SLOT1–4. `Prediction.ts` algoritması değişmez, yalnızca ctx (`terrain, cover, waterY`).

### Fırlatmalar
`ball.ts` → `projectile.ts`: aynı durumlar (neutral/held/live/dead), zemine `normalAt` ile yansıma, su altına düşen kaybolur (cevizler palmiye altında yeniden doğar), mızrak saplanır (`stick`). `BallSync` → `ProjectileSync`: `ownerId + throwSeq` ile tahmin edilen atış eşleme aynen. Fırlatmalar state'te kalır (`MapSchema`, ≤32; yerde pickup olarak dururlar); `throw/hit/splash/stick/pickup` mesaj.

### Takım modu = tek oda, tek dünya
192×128 grid, iki ada + boğaz, tek tick döngüsü, tek fırlatma simülasyonu (boğaz üzerinden atılan ceviz entity devri gerektirmez). İki oda / alt dünya yaklaşımı reddedildi (matchMaker köprüsü, çift AI, transfer protokolü).

### Botlar
Gerçek `PlayerState` (`bot = true`), her tick bir `InputCmd` üretip aynı `InputQueues`'a girer → aynı `stepPlayer`, aynı çarpışma, aynı vuruş kuralları. `BotDesk` kabuğu KASALA'dan; `botBrain.ts` saf fonksiyonlar: `chooseGoal` (kaç → saldır → ye/iç → teslim et → topla → balık → cephane → kampta bekle), `steer` (1.5 m ileri probe, ±30/60/90/135° süpürme, 10 tick histerezis, sıkışma dedektörü → zıpla + rastgele yön), `aimAt` (kapalı form balistik + kişilik gürültüsü). Üreteç koridor garantisi verir; yedek plan 2 m yürünebilirlik gridinde BFS.

### Odalar
4 harfli kod `ctx.codes.allocate(ctx.gameId)`, `onDispose`'da bırakılır; `/r/ABCD`. En fazla 6 koltuk (bot dahil). Maç sırasında katılan seyirci olur. Host çıkarsa hostluk devredilir. Bağlantı kopmasında **30 sn** yeniden bağlanma (envanter ve konum korunur; o sırada bot devralır, dönünce geri verir). Son oyuncu çıktıktan 60 sn sonra oda kapanır. Test ortamı `RAFT_TEST=1` hızlı zamanlayıcılar (gün 4 sn, bar düşüşü ×20, sal maliyeti 1).

### State (kavramsal şema)
- `IslandState`: phase (`lobby | landing | playing | storm | matchEnd`), tick, matchStartTick, seed, layout (`solo | duel`), day, dayPhase (`day | dusk | night`), weather, settings (mode, difficulty, bots, seed), hostId, players, projectiles (≤32), monsters (≤16), structures (≤24), `nodes: array<uint8>` (yalnızca kalan miktar; konumlar seed'den), teams[] (raftStage, raftProgress, houseHp, campfireFuel, chest[], score), winnerTeam, winReason.
- `PlayerState` (≤60 alan, şema limiti 64): kimlik (id, nickname, character, slot, team, bot, ready, connected, ping, lastSeq) + sim (x y z vx vy vz yaw pitch, grounded, airTicks, stunTicks, chargeTicks, gatherTicks, swimTicks, sprinting, heldKind, gatherNode, alive, downed) + barlar (hp, hunger, thirst, warmth: uint8) + envanter (4 × kind/count düz alan) + stats (gathered, delivered, hits, kills, revives, fish, raids).
- `ProjectileEntity`: id, kind, x y z vx vy vz, state, ownerId, holderId, throwSeq, ageTicks, bounces, team.
- `MonsterState`: id, kind, x y z yaw, hp, mode (`emerge | hunt | bite | flipped | flee`), targetId, team.
- `StructureState`: id, kind (`campfire | chest | raft | fence | torch | collector | hut | canoe`), x z yaw, team, hp, stage, progress.
- Mesajlar: `welcome(seed, gridHash, tickRate)`, `ping/pong`, `notice{key, params}`, `dayPhase`, `weather`, `throw`, `hit`, `splash`, `stick`, `pickup`, `gather`, `craft`, `structureBuilt/Hit/Destroyed`, `monsterSpawn/Hurt/Flip/Die`, `playerDowned/Revived/Washed`, `fishCast/fishBite/fishResult`, `chestOpen`, `raftLaunch`, `storm`, `matchEnd`, `ping` (oyuncu pingi), `emote`.

### Bant genişliği
6 oyuncu × ~36 senkron alan, çoğu patch'te değişmez (Bonk 8 oyuncu × 30 alanı 20 Hz'de taşıyor). Canavarlar 16 × 8 alan ≈ 0.6 kB/patch en kötü. Barlar saniyede bir değişir. Tahmin: duel tepe noktasında ≤ 4 kB/s/istemci. Girdi: tick başına 1 `InputCmd`.

## 20. Teknik & yeniden kullanım haritası
Oyunlar **kod paylaşmaz** (KASALA mimari notu: "başka oyundan import etme, kopyala ve uyarla"). Bu yüzden "yeniden kullanım" = dosyayı `games/raft-rush/` altına kopyalayıp uyarlamak. Aşağıdaki tablo kaynağı ve uyarlama derecesini verir: **Aynen** (import/isim değişir), **Uyarla** (mantık değişir), **Yeni**.

### Hub
```
games/raft-rush/
  game.json            # id "raft-rush", players 1–6, duration "~8 min", status "beta" → "live"
  cover.svg            # 16:10: gün batımı, palmiye, yarım sal, kırmızı yengeç gözleri
  tsconfig.json        # games/bonk-brawl/tsconfig.json'dan aynen
  server/index.ts      # games/kasala/server/index.ts aynen → define("raft_rush", RaftRoom)
  server/hub.ts        # games/kasala/server/hub.ts aynen
  client/vite.config.ts  # base "/games/raft-rush/"
  shared/ server/ client/ test/
```

### Bonk Brawl'dan (hareket, fırlatma, ağ, render, ses)
| Kaynak | Hedef | Derece |
|---|---|---|
| `games/bonk-brawl/shared/sim/math.ts` | `shared/sim/math.ts` | Aynen |
| `games/bonk-brawl/shared/sim/player.ts` | `shared/sim/player.ts` | Uyarla (§19 FP yürüme) |
| `games/bonk-brawl/shared/sim/geometry.ts` | `shared/sim/geometry.ts` | Uyarla: cover/kapsül/raycast kalır, halkalar gider, cover'a `baseY` eklenir |
| `games/bonk-brawl/shared/sim/ball.ts`, `throw.ts` | `shared/sim/projectile.ts`, `throw.ts` | Uyarla: bumerang/curve/üçlü atış gider |
| `games/bonk-brawl/shared/sim/testkit.ts` | `shared/sim/testkit.ts` | Uyarla: `flatIsland()`, `slopeIsland()` |
| `games/bonk-brawl/shared/constants.ts` (tick/ağ bloğu) | `shared/constants.ts` | Aynen (TICK_RATE 30, PATCH 20, PREDICTION_SNAP_DIST 2 …) |
| `games/bonk-brawl/client/src/net/{Prediction,Interpolation,Clock,LocalHandoff,errors}.ts` + testleri | `client/src/net/` | Aynen (ctx tipi değişir) |
| `games/bonk-brawl/client/src/net/BallSync.ts` | `client/src/net/ProjectileSync.ts` | Uyarla |
| `games/bonk-brawl/server/world/inputs.ts` | `server/world/inputs.ts` | Aynen (BUTTON_MASK / EDGE_BUTTONS güncellenir) |
| `games/bonk-brawl/server/world/World.ts` | `server/world/World.ts` | Uyarla (adım sırası §19) |
| `games/bonk-brawl/server/BonkRoom.ts` | `server/RaftRoom.ts` | Uyarla: tick döngüsü, reconnect, ping, boş oda sayacı |
| `games/bonk-brawl/server/room/{timings,lobby,ping}.ts` | `server/room/` | Aynen / Uyarla |
| `games/bonk-brawl/client/src/input/Input.ts`, `bindings.ts` | `client/src/input/` | Uyarla (pointer lock, 30 Hz InputCmd, edge latching kalır) |
| `games/bonk-brawl/client/src/render/{Toon,noise,PostFx,quality,textures}.ts` | `client/src/render/` | Aynen (noise'a `valueNoise2/fbm2` **eklenir**, Bonk'ta yok) |
| `games/bonk-brawl/client/src/render/arena/{Baker,MeshBuilder,MaterialBank}.ts` | `client/src/render/kit/` | Aynen (sıfır import) |
| `games/bonk-brawl/client/src/render/sky/{SkyDome,CloudLayer,backdrops}.ts` | `client/src/render/sky/` | Uyarla: güneş/ay yönü ve renkler maç saatine bağlanır, `Stars` gece |
| `games/bonk-brawl/client/src/render/arena/decor/staticDecor.ts` | `client/src/render/island/Flora.ts` | Uyarla: `bakeTree/bakeBush` → arketip geometrileri, InstancedMesh |
| `games/bonk-brawl/client/src/render/camera/CameraShake.ts` | `client/src/render/FpCamera.ts` içinde | Aynen |
| `games/bonk-brawl/client/src/fx/{Particles,billboard,Feel,PopText,popAtlas,Trail,Shadows,ArcPreview}.ts` | `client/src/fx/` | Aynen / Uyarla (ArcPreview `TrajectoryOptions` aynı) |
| `games/bonk-brawl/client/src/audio/{AudioEngine,engine/*,synth/dsp,synth/blocks,music/MusicCore,music/instruments,music/theory,music/ticker}.ts` | `client/src/audio/` | Aynen; `Sfx.ts`, `sfxRecipes.ts`, `songs.ts` yeni içerik |
| `games/bonk-brawl/client/src/ui/{dom,icons,Lobby,LobbyPlayers,LobbySettings,MatchEnd,Scoreboard,SettingsMenu,Toasts}.ts`, `ui.css` | `client/src/ui/` | Uyarla |
| `games/bonk-brawl/client/src/ui/hud/{Reticle,Countdown,RoundTimer}.ts` | `client/src/ui/hud/` | Aynen |
| `games/bonk-brawl/client/src/characters/{Animator,clips,pose,rigPose,states,Nameplate,shadowBlob,puppet}.ts` | `client/src/characters/` | Uyarla (rig); `models/` **yeni** (6 turist) |
| `games/bonk-brawl/client/dev/*` | `client/dev/` | Uyarla: `?seed=` ile ada render harness'i |
| `games/bonk-brawl/test/room-smoke.test.ts` | `test/room-smoke.test.ts` | Uyarla |
| `games/bonk-brawl/docs/ARCHITECTURE.md` | `docs/ARCHITECTURE.md` | Şablon |

### Jelly Jackpot'tan (i18n, reel, sesler)
| Kaynak | Hedef | Derece |
|---|---|---|
| `games/jelly-jackpot/client/src/i18n/index.ts` | `client/src/i18n/index.ts` | Aynen (`t()`, `upper()`, `setLanguage` reconnect ile yeniden yükleme) |
| `games/jelly-jackpot/client/src/i18n/strings/*.ts` | `client/src/i18n/strings/{menu,hud,craft,items,feed,overlays,coach,scene,server,errors}.ts` | Kalıp (her dosya `en` + `tr: Record<keyof typeof en, string>`) |
| `games/jelly-jackpot/server/room/text.ts` + `server/text.test.ts` | `server/room/text.ts` + test | Uyarla (`notice{key, params}`, iki tarafın eşliği testle korunur) |
| `games/jelly-jackpot/client/src/app/settings.ts` (`Lang`) | `client/src/app/settings.ts` | Birleştir (Bonk settings + dil) |
| `games/jelly-jackpot/client/src/ui/CaseReel.ts` + `reel.css` | `client/src/ui/FishReel.ts` | Uyarla: balık loot şeridi ve sandık açma |
| `games/jelly-jackpot/client/src/audio/sfx/voices.ts` | `client/src/audio/voices.ts` | Uyarla: 6 turist tınısı |
| `games/jelly-jackpot/client/src/scene/toon.ts` (`googlyEyes`) | yengeç gözleri | Aynen |

### KASALA'dan (botlar, FP kollar, HUD disiplini)
| Kaynak | Hedef | Derece |
|---|---|---|
| `games/kasala/server/room/bots.ts` (`BotDesk`, `BotHost`) + `bots.test.ts` | `server/room/bots.ts` | Uyarla: plan/think-delay kabuğu kalır, kararlar `botBrain.ts`'e |
| `games/kasala/server/rules.ts` (saf karar fonksiyonları kalıbı) | `server/rules.ts`, `server/room/botBrain.ts` | Kalıp |
| `games/kasala/server/room/testing.ts` (seed knob) | `server/room/testing.ts` | Aynen |
| `games/kasala/server/KasalaRoom.test.ts` | `server/RaftRoom.test.ts` | Kalıp (in-process colyseus.js) |
| `games/kasala/client/src/scene/characters/fpArms.ts` | `client/src/characters/fpArms.ts` | Uyarla: kıyafet kolları, tutma/fırlatma/olta/meşale jestleri |
| `games/kasala/client/src/input/Controls.ts` (pointer lock + sürükle-bak yedeği) | `Input.ts` ile birleştir | Uyarla |
| `games/kasala/client/src/ui/keyGate.ts`, `ui/hud/dom.ts`, `ui/hud/{Banner,Feed,Subtitle,Coach,Legend}.ts` | `client/src/ui/` | Aynen |
| `games/kasala/client/src/scene/fx/Pool.ts` | `client/src/fx/Pool.ts` | Aynen (kor, yağmur, ateş böceği) |
| `games/kasala/client/src/scene/room/batch.ts` (`StaticBatch`) | `client/src/render/batch.ts` | Aynen (yapılar) |
| `games/kasala/client/src/game/context.ts` (`guard()`), `Stage.ts` auto-quality + `prewarm()` | `client/src/app/` | Aynen |

### Yeni yazılacaklar
- `shared/island/{noise(valueNoise2, fbm2), heightfield(heightAt, normalAt, slopeAt, inWater), generate(seed → IslandDef), placement(koridor garantisi)}.ts`, `shared/recipes.ts` (ITEMS, RECIPES, FISH_LOOT), `shared/sim/terrainCollide.ts`.
- `server/world/{monsters, survival, structures, nodes, fishing}.ts`, `server/room/botBrain.ts`, `server/schema.ts`.
- `client/src/render/island/{Terrain, Water, Flora, Structures, Campfire, DayNight}.ts`, `render/FpCamera.ts`, `characters/models/{kaptan, fenomen, amca, gelin, sef, cocuk}.ts`, monster modelleri.
- HUD: `ui/hud/{SurvivalBars, Inventory, InteractPrompt, CraftPanel, DayClock, Compass, PingWheel, TeamStrip}.ts`.

### Render bütçesi
Solo ~60 m ada: terrain 4 chunk ≈ 16k üçgen, su 4.6k, 120 ağaç ≈ 18k, 60 kaya 2.4k, 80 çalı 4.8k, 600 çim tutamı 2.4k, yapılar ≤ 4k, 6 karakter 9k, 12 canavar 10k, fx ≤ 4k → **≈ 75k üçgen, 35–50 draw call**. Duel ≈ 130k üçgen, < 70 draw. Tek yönlü güneş gölgesi (60 m orto, kamerayı takip eder); düşük kalitede gölge yok, instance sayısı yarı.

### Test planı (mevcut kalıplar)
- **Saf üreteç:** aynı seed → aynı `gridHash`; 50 seed'de spawn/kamp/sal karada, duel boğazı su, düğüm sayıları aralıkta, koridorlar temiz.
- **Sim:** `player.test.ts` (zıplama tepe, uçurum engeli, basamak, yüzme, iki kez koşulan replay `toEqual`), `projectile.test.ts` (parabol = `ballisticPoint`, zemin yansıması, su → kayıp, mızrak saplanma), `throw.test.ts` (kopya).
- **Kurallar:** `rules.test.ts`: bar düşüşleri zorluğa göre belgelenen sürede sıfırlanır, craft tam sayıyı tüketir ve eksikte reddeder, loot dağılımı 10k atışta ağırlıklara ± tolerans, kötü şans koruması, gün/gece takvimi MATCH_TICKS içinde 3 gece, `monsterPressure`, kazanma sırası, MVP sıralaması.
- **Bot beyni:** hedef öncelikleri, el yapımı 32×32 heightfield'da silindir ve uçurumu aşma, sıkışma dedektörü, `aimAt` + `stepProjectile` 10/20/30 m'de ≤ 1 m sapma.
- **World bench:** fırlatma canavara vurur ve olay üretir; toplama düğümü eksiltir ve slot doldurur; craft yapıyı ilerletir; gece spawn kamp çevresinden; sal inişi maçı bitirir; takımda dost ateşi kapalı, `RAFT_GUARD_RADIUS`.
- **In-process oda** (`RaftRoom.test.ts`, colyseus.js, `RAFT_TEST=1`): lobi/hazır/başla, `welcome` seed + gridHash, girdi oyuncuyu hareket ettirir, solo + 3 bot maçı saniyeler içinde `matchEnd`, 2v2 bot, reconnect envanteri korur, notice i18n anahtarları.
- **İstemci:** kopyalanan net testleri; `text.test.ts` sunucu↔istemci string eşliği.
- **Dengeleme harness'i** (`it.skip`): 30 seed × 3 zorluk bot-only maç, kazanma oranı bandı (Normal'de %55–75).

### Riskler
| Risk | Önlem |
|---|---|
| FP + heightmap tahmin uyuşmazlığı (motorlar arası float, mesh/grid farkı) | Tamsayı hash gürültü, `Float32Array`, `gridHash`; tüm eğim/su kuralları `shared/sim`'de; aynı `InputCmd` akışını sunucu World ve istemci Prediction'a veren kayıt-tekrar testi |
| Bot pathing (ağaç kümesi, uçurum, kıyı) | Koridor garantisi, probe-süpürme + sıkışma dedektörü, BFS yedeği, 50 seed "hedefe N sn'de ulaş" testi |
| 8 dk tempo/denge (botla çok kolay, solo imkânsız, gün 1 ölü zaman) | Her şey `constants.ts`'te, hızlı zamanlı harness, zorluk tablosu, spawn yakınına ceviz |
| Takım modu dünya boyutu / performans | Chunk'lı terrain, instancing, sis + near/far saate bağlı, canavar tavanı 16, kalite kademeleri; M1 harness'inde `low` profil |
| Flora draw call patlaması | Arketip başına `InstancedMesh`, çim instanced quad, yapılar `StaticBatch`; bütçe harness'te ölçülür |
| `PlayerState` 64 alan limiti | Envanter büyürse alt şemaya böl |
| Canavar AI CPU (30 Hz) | Karar 5 tick'te bir, hareket her tick |
| Pointer lock HTTPS ister | Bonk'tan bilinen; sürükle-bak yedeği |

## 21. Denge sayıları (başlangıç değerleri, test oyunlarında ayarlanacak)
| Parametre | Değer |
|---|---|
| Karaya çıkış / Gündüz / Alacakaranlık / Gece / Fırtına | 10 / 95 / 10 / 50 / 20 sn |
| Açlık / Susuzluk düşüşü | 25/dk / 33/dk (koşu ×1.5, sıcak dalgası susuzluk ×2) |
| Isı düşüşü (gece, ateşten uzak) | 2/sn; ateş 3 m içinde +5/sn; meşale elde −1/sn |
| Boş bar can kaybı | −2/sn (bar başına) |
| Yemek değerleri | Böğürtlen 15 · ceviz 25 (+25 su) · çiğ balık 20 · pişmiş balık 45 · pişmiş yengeç 50 · altın balık 100 |
| Su değerleri | Pınar kabı 50 · ceviz 25 · su toplayıcı 40 |
| Toplama süreleri | Odun 2.5 sn (balta 1) · ip 1.5 · taş 2 · böğürtlen 1 |
| Kaynak düğümleri (solo) | 120 ağaç ×3 odun · 30 palmiye ×2 ceviz (60 sn yenilenir) · 60 kaya ×2 taş · 80 çalı (%50 ip, %40 böğürtlen) |
| Ateş yakıtı | 60 sn tam, odun +30 sn, yakıt bidonu +120 sn |
| Meşale ömrü / ışık | 90 sn / 4 m (ateş 5 m) |
| Sal maliyeti | §7 tablosu (2 koltuk 10 odun … 6 koltuk 24 odun) |
| Yengeç kemirmesi | gövdeden −1 odun / 4 sn; sahibi 6 m içindeyse önce oyuncu |
| Canavar sayıları | Gece 1: 3 + koltuk · Gece 2: 5 + koltuk×1.5 + 2 kirpi · Gece 3: 6 + koltuk×2 + 3 kirpi + boss |
| Canavar canı / hasarı | Yengeç 2 / 15 · kirpi 1 / 20 · boss 12 / 35 |
| Fırlatma | Şarj 0.6 sn, THROW_SPEED_MAX 34, GRAVITY −20 (Bonk) → max menzil ≈ 58 m; boğaz 26–30 m |
| Fırlatma hasarları | Ceviz 1 · taş 1 · mızrak 2 · çizme 1 (+itme) · kirpi 2 alan 3 m · balık 0 (yem 8 sn, 15 m) |
| Balık tutma | Bekleme 2–6 sn, pencere 0.6 sn, loot §8, kötü şans koruması 4 |
| Düşme / diriltme | 10 sn süre, 3 sn basılı E, yarım can |
| Yeniden bağlanma | 30 sn |
| Bot düşünme | 0.6–1.5 sn; kişilik gürültüsü nişanda ±3° (Hamal/Aşçı), ±1° (Bekçi) |
| Zorluk | Tatil: canavar ×0.6, bar ×0.7 · Normal ×1 · Kabus: canavar ×1.5, bar ×1.3, boss gece 2'de de |
| MVP puanları | Toplanan 1 · sala teslim 3 · vuruş 2 · öldürme 5 · diriltme 10 · balık 2 · altın balık 25 · baskın 8 · sala ilk binen +5 |
| Utanç / şeref unvanları | **Yengeç Katili**, **Balıkçı Reis**, **Hamal**, **Kahraman** (diriltme), **Turist** (en az toplayan), **Kurban** (en çok düşen), **Hindistan Cevizi Bağımlısı** (en çok yiyen) |

**Tempo kontrolü:** 4 kişilik ekip gövde için 16 odun (balta ile ~16 sn kesme + taşıma), direk 4 odun + 6 ip, erzak 4 yemek + 4 su; verimli ekip gün 2'nin sonunda sal hazır eder ve gece 3'te boss'u savuşturup iner. Dağınık ekip gün 3'te erzak toplar ve fırtınaya 20 sn kala iner; bu hedef his.

## 22. Geliştirme kilometre taşları
1. **M1 – Seed'den ada:** `game.json` (`beta`), hub kaydı, `shared/island/*` + testler, istemcide terrain/su/flora/gök, `client/dev` harness'i `?seed=` ile, serbest kamera. *Demo:* yenile → farklı ve deterministik adalar, 4 biyom.
2. **M2 – Ağlı FP yürüme:** `RaftRoom` (lobi, karaya çıkış, oyun), sadece oyuncu şeması, `Input` + `Prediction/Interpolation/Clock`, heightfield üstünde `stepPlayer`, kapsül oyuncular + nameplate, `gridHash` kontrolü. *Demo:* 2 tarayıcıda yürü/zıpla/yüz, eğimde rubber-band yok.
3. **M3 – Topla, craft, fırlat:** kaynak düğümleri + etkileşim, envanter HUD, kamp ateşi tezgahı + tarifler, fırlatmalar (`stepProjectile`, `ProjectileSync`, yay), barlar + düşüş, gün/gece ışığı, basit balık atışı. *Demo:* co-op sal inşası, açlık önemli.
4. **M4 – Canavarlar, geceler, kazan/kaybet:** canavar AI/spawn, vuruş/düşme/diriltme, sal aşamaları + iniş, maç saati, fırtına, maç sonu + MVP, temel SFX/müzik. *Demo:* insanlarla tam 8 dk co-op maç.
5. **M5 – Botlar & solo:** `BotDesk` + `botBrain`, lobiden bot ekle/çıkar, otomatik doldurma, zorluklar, dengeleme harness'i yeşil. *Demo:* solo oynanabilir.
6. **M6 – Ada Savaşı:** duel layout, takım lobisi, kulübe/kano, yapı canı, baskın kuralları, boğaz atışları, dengeleme kancaları, TeamStrip. *Demo:* 2v2 baskın maçı.
7. **M7 – Cila & yayın:** 6 turist + FP kollar, balık reel UI, hava olayları ve gündüz olayları, ping çarkı, TR/EN tamam, instancing/kalite geçişi, `cover.svg`, docs, `status: "live"`.

**"Yeterince eğlenceli" tanımı:** Gece 3'te Kaptan Yengeç sala yürürken biri "BALIĞI ATMA ORAYA!" diye bağırıyor, biri meşaleyle önüne atlıyor, Fenomen selfie çekiyor ve sal 12 saniye kala iniyor.

## 23. İleri fikirler (v1'de yok)
- **Gizli hain** (ada sabotajcısı): ateşi gizlice söndürür, yem atar; sonda oylanır.
- **Günün adası:** herkes için aynı günlük seed, en hızlı iniş liderlik tablosu.
- Mobil dokunmatik kontroller.
- Kozmetikler (korsan şapkası, çizme, deniz yosunu peruk) ve "en hızlı kaçış" rekoru localStorage'da.
- Ek biyomlar (kar adası, mercan atolü), ek canavar (gece maymunları), **Kano yarışı** mini modu.
- Mevsimlik olay: "Kraken gecesi".
