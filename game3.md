# KASALA! — Oyun Tasarım Dokümanı (game3.md)

> Tarayıcıda 2–6 arkadaş için **3D, tamamen şansa dayalı, mafya kumarhanesi temalı bir kart oyunu**.
> Sıran gelince kart çevirirsin, potun büyür, polis sireni yaklaşır. İstediğin an **"KASALA!"** deyip parayı cebe atarsın. Bir kart daha çevirmeye kalkarsan baskın yiyebilirsin. Bu sırada arkadaşların senin batmana bahis oynar, kasandan haraç keser ve sana faizle borç verir.

## 1. Kararlar (görüşmeden)
| Konu | Karar |
|---|---|
| Çekirdek | Klasik bir kart oyunu değil: özgün **"şansını zorla"** kart çevirme. Çevirdikçe tur potu büyür, istediğin an **KASALA!** dersin |
| Tema | **Sahte mafya kumarhanesi**: dumanlı yeşil çuha, neon tabela, karikatür gangster hayvanlar |
| Tur yapısı | **Sırayla**: tek kişi kart çevirir, diğerleri seyirci bahsi yapar |
| Bela cezası | **Polis Baskını**: tur potu uçar + kasadan **%10 rüşvet** (Patronun Kumbarası'na gider) |
| Saldırı kartları | **Çevirince anında etki eder**, hedefi kartı çeviren seçer |
| Seyirci bahsi | **Kaçıncı kartta patlar?** `1–2 / 3–4 / 5+ / Kasalar` kutuları |
| Jackpot | Nadir **Patronun Çarkı** kartı: masaya dev 3D çarkıfelek iner |
| İhanet katmanı | **Borç & tefecilik**: faizli borç, borcu kasasını aşan **Taşlık** olur |
| Maç sonu | Lobide seçilir: **Klasik** (sabit tur, en zengin kazanır) veya **Battle Royale** (eleme) |
| Mizah | Baskın ceza animasyonları, emoteler & laf sokma, komik krupiye/spiker **Cemil Abi** |
| Dil | Oyun baştan sona **Türkçe**. Spiker replikleri §15'te dosya adlarıyla listelenir, mp3'ler ayrıca kaydedilir |
| Oyuncu | 2–6 |
| Süre | ~8–12 dk (Klasik) |
| Teknik | Three.js istemci, Node.js + Colyseus otoriter sunucu (Bonk Brawl / Jelly Jackpot ile aynı yığın). Fizik motoru gerekmez |

## 2. Tanıtım
Gece yarısı, bir pavyonun arka odası. Yeşil çuhalı yuvarlak masanın başında yaşlı timsah krupiye **Cemil Abi** puro tüttürüyor. Masada 2–6 gangster hayvan oturuyor: Kedi, Köpek, Domuz, Fare, Kurbağa, Tavşan; hepsi fötr şapkalı, çizgili takım elbiseli. Ortada ters kapalı kartlardan bir kule, tepede yanıp sönen neon **"KASALA"** tabelası, duvarda da kırmızı bir **polis sireni lambası**.

Sıran gelince kart çevirirsin. Para çıkar, çarpan çıkar, arkadaşının kasasından haraç kesmeni sağlayan kart çıkar. Her çevirmede siren biraz daha dolar ve **baskın ihtimali artar**. Diğer oyuncular senin kaçıncı kartta patlayacağına fiş koymuştur ve "BİR TANE DAHA ÇEVİR!" diye bağırırlar, çünkü 5+ kutusuna 50$ basmışlardır. Sen "KASALA!" dersen para cebe girer. Bir tane daha dersen kapı kırılabilir: **Komiser Rıfat** içeri dalar, seni kelepçeyle masadan sürükler ve potun kumbaraya gider.

Bazen çevirdiğin kart altın yaldızlı **Patronun Çarkı** olur. Işıklar söner, tavandan dev bir çarkıfelek iner ve masanın kaderi tek bir dönüşte değişir.

## 3. Neden eğlenceli
- **Tek kart daha:** Her çevirme küçük bir yazı-tura. Siren %50'yi geçince odada kimse nefes almaz.
- **Kart çevirme dopamini:** 0.4 sn yavaş çekim, nadirlik rengine göre parıltı (bronz → gümüş → altın → efsanevi mor), her para kartında kasa sesi, kombo sayacı.
- **Seyircinin çıkarı ile oyuncunun çıkarı çatışır:** Bahisler herkesin önünde durur. "Sakın kasalama, 5+'ta 50$'ım var!" Aktif oyuncu ise kaybeden bahislerden pay alır; bahisçileri batırmak için inadına ters oynar.
- **Kin:** Haraç kartını hep aynı kişiye oynayanlar, kasaları takas edip lideri dibe gönderenler, tuzağı sıradakine kuranlar.
- **Borç draması:** "Bana 100$ ver, faizini öderim, söz." Üç tur sonra borç 170$ olur ve o kişi artık birinin Taşlık'ıdır.
- **Çark anı:** Bütün masa çarkın yavaşlayışını izler. "KUMBARA! KUMBARA! ...Herkese 50$ öde. HAYIR!"

## 4. Oyun döngüsü
1. **Lobi:** Hayvan karakter + renk seçilir, Hazır'a basılır. Host modu (Klasik / Battle Royale), tur sayısını ve karar süresini seçer.
2. **Masa kurulumu:** Herkes **200$** ile başlar (Battle Royale: 150$). Patronun Kumbarası'nda **100$** vardır.
3. **Tur (~20 sn):**
   1. **Bahis (5 sn):** "Bahisler açıldı!" Seyirciler fişlerini kutulara koyar. Aktif oyuncu bahisleri canlı görür.
   2. **Çevirme:** Aktif oyuncu Space ile kart çevirir. Her karttan sonra **8 sn** içinde seçim yapar: **ÇEVİR** ya da **KASALA!** Süre dolarsa otomatik KASALA.
   3. **Sonuç:** KASALA → tur potu kasaya girer, para yağmuru. BASKIN → tur potu kumbaraya gider, kasadan %10 rüşvet kesilir, kelepçe animasyonu oynar.
   4. **Bahis ödemesi:** Kazanan kutular parlar, kaybeden fişler aktif oyuncuya doğru kayar (ev payı) ve kumbaraya akar.
4. **Sıra** saat yönünde döner. Her tam tur sonunda borç faizleri işler.
5. **Maç sonu:** Borçlar tahsil edilir → utanç unvanları → podyum → "Rövanş".

## 5. Siren sayacı (risk motoru)
Destede sabit sayıda bomba **yoktur**. Baskın ihtimalini sunucudaki bir **siren seviyesi** belirler; böylece ihtimal her çevirmede gözle görülür şekilde artar ve bahis oranları hesaplanabilir.

- Tur başında siren seviyesi **0**'dır (Tuzak kartı yediysen 2).
- Bir sonraki kartın **baskın olma ihtimali** = `%8 + seviye × %7` (en fazla %95). Kart çevrilince seviye +1 olur.
- HUD'daki siren lambası 12 dilimlidir ve dilimler doldukça yeşilden turuncuya, oradan kırmızıya döner. Yanında yüzde yazar: **"Sonraki kart: %29 BASKIN"**. Bilgi saklanmaz, karar oyuncunundur.

| Kaçıncı kart | Baskın ihtimali | Buraya kadar hayatta kalma |
|---|---|---|
| 1 | %8 | %92 |
| 2 | %15 | %78 |
| 3 | %22 | %61 |
| 4 | %29 | %43 |
| 5 | %36 | %28 |
| 6 | %43 | %16 |
| 7 | %50 | %8 |

Simülasyonla (Avukat ve Rüşvet Zarfı dahil) ortalama tur potu: 2 kartta durursan ~37$ (%79 başarı), 3'te ~58$ (%64), 4'te ~79$ (%48), 5'te ~99$ (%34). Beklenen değer 3–4 kartta en yüksektir, ama kumarbaz ruh 5'i ister.

## 6. Kartlar
Baskın değilse kart aşağıdaki ağırlıklarla seçilir. Kartın kenar rengi nadirliğini gösterir.

| Nadirlik | Renk |
|---|---|
| Sıradan | Bronz `#C9874B` |
| Seyrek | Gümüş `#C7D0DA` |
| Nadir | Altın `#FFC93C` |
| Efsanevi | Mor `#B05CFF` |
| Bela | Kırmızı `#E5383B` |

### Para kartları (tur potuna eklenir)
| Kart | Nadirlik | Ağırlık | Değer |
|---|---|---|---|
| **Bozukluk** | Sıradan | 25 | +10$ |
| **Tomar** | Sıradan | 18 | +25$ |
| **Çanta** | Seyrek | 12 | +50$ |
| **Külçe** | Nadir | 5 | +100$ |

### Çarpan
| Kart | Nadirlik | Ağırlık | Etki |
|---|---|---|---|
| **Kara Para Aklama** | Seyrek | 8 | Tur potu **×2** |

### Saldırı kartları (çevrildiği an hedef seçilir, 6 sn içinde seçilmezse rastgele)
| Kart | Nadirlik | Ağırlık | Etki |
|---|---|---|---|
| **Haraç** | Seyrek | 6 | Hedefin kasasının **%20'si** senin **tur potuna** geçer. Sıcak paradır: baskın yersen o da gider |
| **Haraç Turu** | Seyrek | 4 | Herkes **10$** öder, para tur potuna girer (hedef seçilmez) |
| **Tuzak** | Seyrek | 4 | **Sıradaki** oyuncunun siren seviyesi 2'den başlar (hedef otomatik) |
| **Lanet** | Nadir | 3 | Hedefin bir sonraki turunda çevirdiği **ilk para kartı 0$** verir (kartın üstünde nazar boncuğu belirir) |
| **Takas** | Efsanevi | 1 | Senin kasanla hedefin **kasası yer değiştirir**. Kalıcıdır, tur potundan bağımsızdır |

### Koruma kartları
| Kart | Nadirlik | Ağırlık | Etki |
|---|---|---|---|
| **Avukat** | Nadir | 4 | Bu tur içindeki ilk baskını iptal eder (kart masada senin önünde durur) |
| **Rüşvet Zarfı** | Seyrek | 6 | Siren seviyesi 2 düşer |

### Özel
| Kart | Nadirlik | Ağırlık | Etki |
|---|---|---|---|
| **Patronun Çarkı** | Efsanevi | 4 | Çark iner (bkz. §7). Sonra tur devam eder |
| **Polis Baskını** | Bela | siren formülü | Tur biter: tur potu → kumbara, kasadan %10 rüşvet → kumbara |

- Sonuçları sunucu, tur başında tohumlanmış bir RNG ile her çevirme anında belirler. İstemci sadece animasyonu oynatır, hile yapılamaz.

## 7. Patronun Çarkı (jackpot)
Işıklar söner, caz müziği kesilir, tavandan zincirlerle dev bir altın çark iner. Cemil Abi çarkı çevirir. Çark 4–6 sn boyunca tık tık seslerle yavaşlar ve sonuç kamerayla yakından gösterilir.

| Dilim | Ağırlık | Etki |
|---|---|---|
| **KUMBARAYI PATLAT** | %10 | Patronun Kumbarası'ndaki her şey senin **kasana** girer. Slot ışıkları, para yağmuru, ekran sarsıntısı |
| **POT ×10** | %8 | Tur potun on katına çıkar |
| **HERKESE 100$** | %15 | Masadaki herkes (sen dahil) kasasına 100$ alır |
| **KASALARI KARIŞTIR** | %10 | Bütün kasalar rastgele dağıtılır |
| **HERKESE 50$ ÖDE** | %14 | Kasandan her oyuncuya 50$ verirsin |
| **BEDAVA AVUKAT** | %15 | Bu turda ve bir sonraki turunda geçerli bir Avukat |
| **TOPLU BASKIN** | %13 | Herkes kasasının %10'unu kumbaraya öder |
| **BİR DAHA!** | %15 | Çark tekrar döner |

- Çark kartı da bir çevirme sayılır, yani siren yine +1 olur. Kazanılan para dilimine göre ya kasaya (Kumbara, Herkese 100$) ya da tur potuna (×10) gider.
- Çark sonucu da sunucuda, çark inmeden önce belirlenir.

## 8. Seyirci bahsi
- Sırası olmayan herkes, bahis penceresinde (5 sn) **bir** kutuya **10 / 25 / 50$** fiş koyar. Fiş kasadan düşer.
- Bahisler **herkese açıktır** (laf sokma malzemesi). İlk kart çevrilince kilitlenir.
- Kartlar çevrildikçe imkânsızlaşan kutular **canlı olarak kararır** ("1–2" kutusu, 3. kart güvenle açılınca söner).

| Kutu | Kazanırsa öder | Gerçek ihtimal* |
|---|---|---|
| **1–2. kartta baskın** | ×4 | ~%21 |
| **3–4. kartta baskın** | ×4 | ~%21 |
| **5+ kartta baskın** | ×10 | ~%8 |
| **Kasalar** | ×1.8 | ~%50 |

*Oyuncuların 2–6 kart arası rastgele durduğu varsayımıyla yapılan 400.000 turluk simülasyon. Her kutunun beklenen getirisi 0.6–0.9 arasıdır. Ev her zaman biraz kazanır, ama aktif oyuncuyu iyi tanıyan kazanır.

- **Ev payı:** Kaybeden bahislerin **%10'u aktif oyuncuya**, kalanı kumbaraya gider. Aktif oyuncunun bahisçileri yanıltmak için bir sebebi olur.
- Tur içinde Avukat bir baskını iptal ederse sayılan kart bir sonraki baskındır.

## 9. Borç & tefecilik
- **B** tuşu borç menüsünü açar. İstediğin an (sıran olmasa da) birinden **borç isteyebilir** ya da birine **borç teklif edebilirsin**: miktar + tur başına faiz (**%10 / %20 / %30**).
- Karşı tarafın kabul etmesi gerekir. Teklif ekranın ortasında, herkesin gördüğü bir pop-up olarak çıkar: *"Domuz, Kedi'ye 100$ verecek, tur faizi %20. Kabul?"* Kalanlar "VERME!" diye bağırır.
- Bir oyuncu, kasasının en fazla **%50'si** kadar borç verebilir.
- **Faiz** her tam tur sonunda kalan borca eklenir. HUD'daki **Borç Defteri** kimin kime ne kadar borçlu olduğunu kırmızı mürekkeple gösterir.
- **Geri ödeme:** Borç menüsünden istediğin an, tamamı ya da bir kısmı.
- **Taşlık:** Borcu kasasından fazla olan oyuncu **Taşlık** olur. KASALA kazancının **yarısı** doğrudan alacaklıya gider, karakterine bir boyunduruk tasması takılır. Borç kasanın altına inince tasma çıkar.
- **Maç sonu:** Ödenmemiş borç borçlunun kasasından alacaklıya aktarılır. Kasa yetmezse kalan borç silinir ve borçluya "Kara Liste" damgası basılır.

## 10. Maç modları
### Klasik
- Herkesin sıra sayısı: 2 oyuncu **10**, 3 oyuncu **8**, 4 oyuncu **6**, 5–6 oyuncu **5**.
- Son tam tur **"SON MASA"**dır: bütün para kartları, cezalar ve bahis ödemeleri **×2**. Işıklar kırmızıya döner.
- **En çok parası olan kazanır.** Eşitlikte en az baskın yiyen kazanır.

### Battle Royale
- Başlangıç 150$. Baskın rüşveti yüzde değil sabittir: **tur numarası × 20$** (1. turda 20$, 5. turda 100$).
- Siren tabanı her tam tur **+%2** artar, böylece maç uzayıp gitmez.
- Kasası **0$**'a düşen oyuncuya **15 sn "Son Şans"** verilir: biri borç verirse oyunda kalır (genellikle Taşlık olarak). Kimse vermezse çimento ayakkabılar giydirilir ve karakter **nehre atılır**.
- Nehre atılan oyuncu **hayalet** olur: bedava 10$'lık hayalet fişlerle bahis oynamaya devam eder. **3 doğru tahmin** yaparsa 50$ ile, ıslak ve yosunlu halde masaya döner (maç başına bir kez).
- **Masada son kalan kazanır.** 12 tam turda bitmezse en zengin kazanır.

## 11. Mizah
### Baskın cezaları (her baskında rastgele biri oynar)
- **Kelepçe:** Komiser Rıfat (bıyıklı bir buldog) kapıyı tekmeleyip girer, oyuncuyu kelepçeyle masadan sürükleyip çıkarır. 2 sn sonra karakter morarmış gözle, plakasıyla (sabıka fotoğrafı) geri oturur.
- **Çuval:** Kafaya çuval geçirilir, karakter körlemesine masaya çarpa çarpa çıkarılır.
- **Boş cüzdan:** Karakter cüzdanını açar, içinden güveler uçar, sinek vızıltısı gelir.
- **Sabıka fotoğrafı:** Flaş patlar, ekranda boy ölçü cetveliyle sabıka kartı belirir: *"SUÇU: Bir kart daha çevirmek."*
- Battle Royale elemesi: **Çimento ayakkabı** sahnesi. Karakter iskelede, ayakları kovada, sonra "şlap".

### Emoteler (T + 1–6)
| # | Emote | Animasyon |
|---|---|---|
| 1 | **Puro** | Purosunu yakar, dumanı rakibin yüzüne üfler |
| 2 | **Para say** | Tomarı yalayarak sayar, havaya atar |
| 3 | **Yumruk** | Masaya vurur, kartlar ve fişler zıplar |
| 4 | **Öpücük** | Çark ya da hedef oyuncu yönüne öpücük atar |
| 5 | **Ağla** | Mendil çıkarır, burnunu öter, iki kova gözyaşı akıtır |
| 6 | **Allah Allah** | İki elini havaya açar, başını sallar |

### Laf balonları (Y + 1–8, karakterin üstünde 3 sn)
"Kasala artık, korkak!" · "Bu masa bana bakar." · "Borcunu unutma kardeşim." · "Bir tane daha, bir tane daha!" · "Hesabını sorarım." · "Şans değil, yetenek." · "Polis seni sevmiş." · "Abi yapma ya…"

### Spiker / krupiye: Cemil Abi
Her önemli olayı abartılı, kuru bir mafya mizahıyla yorumlar. Metinler ekranın altında altyazı olarak da görünür; isimler sadece ekranda yazılır, seste söylenmez. Tüm replikler §15'te.

## 12. Kontroller (klavye + fare)
| Girdi | Eylem |
|---|---|
| **Space** | Kart çevir |
| **Enter** | KASALA! |
| **Karaktere tıkla** | Saldırı kartının hedefini seç |
| **1–4** | Bahis kutusu (1–2 / 3–4 / 5+ / Kasalar) |
| **Q / W / E** | Fiş miktarı 10 / 25 / 50$ |
| **B** | Borç menüsü |
| **T + 1–6** | Emote |
| **Y + 1–8** | Laf balonu |
| **Sağ tık sürükle** | Kamerayı masa etrafında döndür |
| **Tab** | Skor tablosu |
| **Esc** | Menü |

Her şey tıklanabilir butonlarla da yapılabilir. İşaretçi kilidi gerekmez, bu yüzden **mobil dokunmatik** destek v1'den hemen sonra mümkündür.

## 13. Sahne & sanat yönü
### Sahne
- Pavyonun arka odası: alçak tavan, sallanan tek bir yeşil abajur, tavanda puro dumanı (yavaş akan sis kartları), duvarda neon **"KASALA"** tabelası ve kırmızı siren lambası.
- Ortada yuvarlak **yeşil çuhalı masa**. Ortada ters kapalı kart kulesi, masanın kenarında **Patronun Kumbarası** (içi görünen, paraya göre dolan cam domuz kumbara).
- Masanın başında krupiye **Cemil Abi** (yaşlı timsah, altın dişli, kolunda saat). Kartları o dağıtır, çarkı o çevirir, baskında masanın altına saklanır.
- Her oyuncunun önünde **para yığını** (kasa büyüdükçe fiş kuleleri yükselir) ve isim plakası.
- Kapı, baskın animasyonu için sahnenin arka planındadır.

### Stil
- Bonk Brawl ve Jelly Jackpot ile aynı yol: low-poly, 3 kademeli `MeshToonMaterial`, palet atlası, siyah dış çizgiler, abartılı squash & stretch, glTF/GLB + Draco, KTX2. Toplam < 15 MB.
- Karanlık oda, sıcak abajur ışığı, neon vurgular. Kartlar ve paralar ortamdan parlak dursun.

### Palet
| Kullanım | Hex |
|---|---|
| Çuha | `#1F6B47` / gölge `#134A31` |
| Oda (duvar) | `#1C1720` |
| Abajur ışığı | `#FFD9A0` |
| Neon pembe | `#FF3C8E` |
| Siren kırmızı | `#E5383B` |
| Para yeşili | `#7BD389` |
| Altın | `#FFC93C` |
| UI mürekkep | `#241F2B` |

**Oyuncu renkleri** (şapka bandı, isim plakası, fişler): O1 `#FF5A5F` kırmızı · O2 `#3FA7FF` mavi · O3 `#7BE07B` yeşil · O4 `#FFC23F` sarı · O5 `#B07CFF` mor · O6 `#FF8BD1` pembe.

## 14. Kamera & oyun hissi
- **Varsayılan:** Masaya 40° yukarıdan bakan kamera. Aktif oyuncuya hafifçe döner.
- **Kart çevirme:** Kart havaya kalkar, 0.4 sn yavaş çekimde döner, nadirlik rengiyle parlar. Altın ve üstünde ekran kenarları parlar ve kısa bir koro sesi gelir.
- **Siren:** Seviye yükseldikçe oda kırmızı ışıkla nabız atar, müzik incelir, kalp atışı sesi duyulur. %50'nin üstünde kamera hafifçe titrer.
- **KASALA:** Fişler aktif oyuncunun yığınına uçar, para yağmuru, "ka-ching". Pot büyüklüğüne göre konfeti miktarı.
- **Baskın:** 0.3 sn donma karesi, flaş patlaması, kapı kırılır, kamera kapıya döner, ceza animasyonu.
- **Çark:** Işıklar söner, kamera çarka dalar, tık sesleri yavaşlar. Sonuç anında zoom + yavaş çekim.
- **Bahis ölümü:** Kararan kutudaki fişler çatlar ve kül olur.
- **Erişilebilirlik:** "Azaltılmış yanıp sönme" seçeneği siren nabzını ve flaşları yumuşatır.

## 15. Ses & spiker replikleri
- **Müzik:** Dumanlı lounge caz (kontrbas, fırça davul, vibrafon). Siren yükseldikçe tek hi-hat ve kalp atışına iner. Çarkta sahne trampeti, Son Masa'da tango.
- **Efektler:** Kart çevirme "fışşş", nadirlik zilleri, kasa "ka-ching", fiş şıkırtısı, siren, kapı kırılması, kelepçe, çark tıkırtısı, kumbara patlaması (cam + para yağmuru), emote sesleri, karakter mırıltıları ("ooo!", "yok artık!", "hah!").
- Ses ayarları: Ana, Müzik, Efekt, **Spiker**.

### Spiker replikleri (Cemil Abi)
Dosyalar: `games/kasala/client/public/audio/spiker/<dosya>.mp3`. Bir olayın birden çok varyasyonu varsa rastgele biri çalar (aynısı arka arkaya çalmaz). Spiker sesi diğer sesleri hafifçe kısar (ducking). Aynı anda tek replik çalar; olay önceliği: çark > baskın > KASALA > diğerleri.

| Dosya | Metin | Ne zaman |
|---|---|---|
| `mac_basi_01` | Hoş geldiniz beyler, bayanlar. Kapıyı kilitleyin, telefonlar masaya. Bu gece kimse temiz çıkmıyor. | Maç başı |
| `mac_basi_02` | Cemil Abi'nin masasına hoş geldiniz. Kurallar basit: polis gelirse ben sizi tanımıyorum. | Maç başı |
| `mac_basi_03` | Fişler dağıtıldı, purolar yakıldı. Patron izliyor. Başlayalım. | Maç başı |
| `tur_basi_01` | Sıra sende evlat. Kartlar seni bekliyor. | Tur başı |
| `tur_basi_02` | Hadi bakalım, elini göster... Titremesin ama. | Tur başı |
| `tur_basi_03` | Masa senin. Ama polis de yakında, unutma. | Tur başı |
| `tur_basi_04` | Bu tur ya zengin olursun ya ünlü. Gazetenin üçüncü sayfasında. | Tur başı |
| `bahis_acildi_01` | Bahisler açıldı! Arkadaşına güveniyor musun? Ben güvenmezdim. | Bahis penceresi açılır |
| `bahis_acildi_02` | Fişlerinizi koyun beyler. Dostluk sonra. | Bahis penceresi açılır |
| `bahis_kapandi_01` | Bahisler kapandı. Artık dua etme zamanı. | İlk kart çevrilir |
| `bahis_kapandi_02` | Kimse kıpırdamasın. Kart dönüyor. | İlk kart çevrilir |
| `para_kucuk_01` | Bozukluk. Simit parası çıktı en azından. | Bozukluk |
| `para_kucuk_02` | Az ama öz. Annen gurur duyar. | Bozukluk / Tomar |
| `para_kucuk_03` | Bu parayla ancak çay ısmarlarsın. | Bozukluk |
| `para_buyuk_01` | Oooo! Çanta dolusu para! Kimse görmedi, değil mi? | Çanta |
| `para_buyuk_02` | Külçe! Altın külçe! Bu masada böyle şey görmedim! | Külçe |
| `para_buyuk_03` | İşte bu! Para kokusunu buradan alıyorum. | Çanta / Külçe |
| `carpan_01` | Kara para aklandı! Pot ikiye katlandı, tertemiz. | Kara Para Aklama |
| `carpan_02` | İki katı! Muhasebeci şu an ağlıyor. | Kara Para Aklama |
| `siren_orta_01` | Uzaktan bir siren sesi geliyor... Duyan var mı? | Sonraki kart ≥ %30 |
| `siren_orta_02` | Evlat, ben olsam o parayı cebe atardım. Ben olsam. | Sonraki kart ≥ %30 |
| `siren_orta_03` | Mahallede mavi ışıklar dolaşıyor. Sinirler gerildi. | Sonraki kart ≥ %30 |
| `siren_kritik_01` | Sireni duyuyorum! Kapıdalar! KAPIDALAR! | Sonraki kart ≥ %45 |
| `siren_kritik_02` | Delisin sen! Bir kart daha mı? Cesur mu aptal mı, karar veremedim. | Sonraki kart ≥ %45 |
| `siren_kritik_03` | Masadakiler nefesini tuttu. Ben de tuttum. Çabuk ol. | Sonraki kart ≥ %45 |
| `sure_azaldi_01` | Saat işliyor evlat. Karar ver! | Karar süresinde 3 sn kaldı |
| `sure_azaldi_02` | Düşünme, hisset! Yoksa ben senin yerine kasalarım. | Karar süresinde 3 sn kaldı |
| `kasala_kucuk_01` | Kasaladı! Az ama sağlam. Korkaklık da bir yetenektir. | KASALA, pot < 60$ |
| `kasala_kucuk_02` | Tavuk gibi kaçtı ama cebi dolu. Saygı duyarım. | KASALA, pot < 60$ |
| `kasala_kucuk_03` | Para güvende. Cesaret biraz eksik ama olsun. | KASALA, pot < 60$ |
| `kasala_buyuk_01` | KASALADI! Büyük vurgun! Patron bu çocuğu işe alsın! | KASALA, pot ≥ 150$ |
| `kasala_buyuk_02` | İşte buna para kazanmak denir! Masada sessizlik... kıskançlıktan. | KASALA, pot ≥ 150$ |
| `kasala_buyuk_03` | Bu adamı vergi dairesine kimse ihbar etmesin! | KASALA, pot ≥ 150$ |
| `baskin_01` | POLİS! Herkes yere! ...Sen hariç. Sen kelepçeye. | Baskın |
| `baskin_02` | Baskın! Paralar gitti, arkadaşınız da gitti. Merak etmeyin, geri gelir. | Baskın |
| `baskin_03` | Dedim sana! Bir kart daha dedin, bir hücre kazandın. | Baskın, 4+ kartta |
| `baskin_04` | Ah evlat... Komiser Rıfat yine iş başında. Para kumbaraya. | Baskın |
| `baskin_ilk_kart_01` | Daha ilk kart! İlk kart! Bu masada rekor kırıldı! | Baskın, 1. kartta |
| `baskin_ilk_kart_02` | Oturdun, çevirdin, tutuklandın. Hızlı adamsın. | Baskın, 1. kartta |
| `harac_01` | Haraç kesildi! Bu masada kimsenin cebi güvende değil. | Haraç |
| `harac_02` | Elini cebine soktular, fark etmedin bile. | Haraç |
| `harac_03` | Haraç toplandı. Dostluk mu? O ne ki? | Haraç |
| `harac_turu_01` | Haraç turu! Herkes onar lira bıraksın. Gönülden değil, zorla. | Haraç Turu |
| `harac_turu_02` | Masada kim varsa ödüyor. Müsaadenizle. | Haraç Turu |
| `takas_01` | TAKAS! Kasalar yer değiştirdi! Biri zengin uyandı, biri fakir! | Takas |
| `takas_02` | Ve kasalar el değiştirdi! Bu masada vefa yok beyler! | Takas |
| `tuzak_01` | Tuzak kuruldu. Sıradaki dikkatli olsun... Olamayacak tabii. | Tuzak |
| `tuzak_02` | Siren sıradakini bekliyor. Kim ayarladı bunu acaba? | Tuzak |
| `lanet_01` | Lanet okundu! Sıradaki para kartı boş çıkacak. Nazar değdi. | Lanet |
| `lanet_02` | Kara büyü mü bu? Mafyada da varmış demek. | Lanet |
| `lanet_tuttu_01` | İşte nazar! Para geldi, para gitti. Boncuk takacaktın. | Lanetli para kartı 0$ verir |
| `avukat_01` | Avukat geldi! Ücreti tuzlu ama çenesi sağlam. | Avukat |
| `avukat_02` | Artık bir avukatın var. Bir baskını savuşturur. | Avukat |
| `avukat_kurtardi_01` | Polis geldi, avukat konuştu, polis gitti. Hukuk devleti! | Avukat baskını iptal eder |
| `avukat_kurtardi_02` | Avukat kurtardı! Dosya kayboldu, şahit unuttu! | Avukat baskını iptal eder |
| `rusvet_01` | Komisere bir zarf gitti. Siren biraz kısıldı. | Rüşvet Zarfı |
| `rusvet_02` | Rüşvet verildi. Ben görmedim, siz de görmediniz. | Rüşvet Zarfı |
| `cark_iniyor_01` | Işıkları kısın! Patronun Çarkı iniyor! | Patronun Çarkı |
| `cark_iniyor_02` | Patron bugün keyifli. Çark dönüyor, herkes dua etsin! | Patronun Çarkı |
| `cark_iniyor_03` | ÇARK! ÇARK! Bu masa bu gece tarih yazıyor! | Patronun Çarkı |
| `cark_kumbara_01` | KUMBARA PATLADI! JACKPOT! Herkes ağlasın, biri dans etsin! | Kumbarayı Patlat |
| `cark_kumbara_02` | Bütün kumbara! Patron kendi parasına bakıp ağlıyor! | Kumbarayı Patlat |
| `cark_x10_01` | Pot on katı! ON KATI! Matematik öğretmenim bunu görmeliydi! | Pot ×10 |
| `cark_herkese_100_01` | Patron cömert bugün! Herkese yüzer lira! Kimse alışmasın. | Herkese 100$ |
| `cark_karistir_01` | Kasalar karıştırıldı! Zengin fakir, fakir zengin! Adalet bu işte! | Kasaları Karıştır |
| `cark_herkese_ode_01` | Çark konuştu: herkese ellişer lira dağıtacaksın. Hayırsever oldun, istemeden. | Herkese 50$ Öde |
| `cark_avukat_01` | Bedava avukat! Patronun kendi avukatı, en iyisi. | Bedava Avukat |
| `cark_toplu_baskin_01` | Toplu baskın! Herkes cebinden kumbaraya! Kimse kaçamaz! | Toplu Baskın |
| `cark_bir_daha_01` | Bir daha! Çark bir daha dönüyor! Kalbim dayanmaz! | Bir Daha! |
| `bahis_sonuc_01` | Bahisler ödendi. Kazananlar sırıtıyor, kaybedenler intikam planlıyor. | Bahis ödemesi |
| `bahis_sonuc_02` | Kimse arkadaşına güvenmemiş. Haklılarmış. | Çoğunluk "baskın" kutularında kazandı |
| `bahis_sonuc_03` | Arkadaşına bahis koyan kaybetti. Bu masada ders bu. | Çoğunluk "Kasalar" kutusunda kaybetti |
| `borc_verildi_01` | Borç verildi! Faiz işliyor, tik tak tik tak. | Borç kabul edildi |
| `borc_verildi_02` | Tefecilik başladı. Bu dostluk bitti, hayırlı olsun. | Borç kabul edildi |
| `borc_reddedildi_01` | Reddedildi! Kardeşim dediğin adam bu işte. | Borç teklifi reddedildi |
| `borc_odendi_01` | Borç ödendi! Tefeci üzgün, sen özgürsün. | Borç tamamen ödendi |
| `taslik_01` | Artık bir taşlıksın. Kazandığının yarısı abine gidiyor. | Oyuncu Taşlık oldu |
| `taslik_02` | Borç boğaza dayandı! Hoş geldin, yeni ayakçımız. | Oyuncu Taşlık oldu |
| `son_sans_01` | Kasa sıfır! Biri borç verecek mi, yoksa balıkları mı besleyeceğiz? | Battle Royale, Son Şans başlar |
| `nehre_atildi_01` | Çimento ayakkabılar giyildi... Boğaz'ın serin sularına selam söyle. | Battle Royale elemesi |
| `nehre_atildi_02` | Bir oyuncu daha nehirde. Balıklar zengin olacak. | Battle Royale elemesi |
| `nehre_atildi_03` | Kasa sıfır, borç veren yok. Elveda dostum. Yüzmeyi bilseydin... | Battle Royale elemesi |
| `mezardan_dondu_01` | Nehirden döndü! Islak ama döndü! | Hayalet masaya döner |
| `mezardan_dondu_02` | Yosunlu, ıslak, sinirli... ama masada! Bu adam ölümsüz! | Hayalet masaya döner |
| `son_masa_01` | Son masa beyler! Her şey iki katı! Kazanç da, ceza da! | Klasik, son tur başı |
| `son_masa_02` | Son tur. Ya kral olursun ya bahşiş bırakırsın. | Klasik, son tur başı |
| `mac_sonu_01` | Oyun bitti. Kaybedenler masayı devirmesin lütfen. | Maç sonu |
| `mac_sonu_02` | Ve gecenin babası belli oldu! Elini öpün! | Podyum |
| `mac_sonu_03` | Paralar sayıldı. Polis gelmeden dağılalım. | Podyum sonrası |
| `unvan_bomba_miknatisi_01` | Bomba Mıknatısı ödülü... polisin en sevdiği müşteriye! | Utanç unvanı |
| `unvan_borc_krali_01` | Borç Kralı! Herkese borcu var, kimseye ödemedi! | Utanç unvanı |
| `unvan_korkak_01` | En Büyük Korkak! Hep ikinci kartta kasaladı. Tavuklar gurur duysun. | Utanç unvanı |
| `unvan_kor_bahisci_01` | Kör Bahisçi! Bütün bahisleri kaybetti. Gözlük almanı öneririm. | Utanç unvanı |
| `unvan_kara_liste_01` | Kara Liste! Borcunu ödemeden kaçtı. Mahallede yüzüne bakan yok. | Utanç unvanı |
| `unvan_kumarbaz_01` | Gözü Kara! En çok kartı tek turda çeviren deli bu. | Utanç unvanı |

Toplam **95 replik**. Kayıt ipucu: Cemil Abi yorgun ama keyifli, hafif hırıltılı, ağır ağır konuşan bir abi sesi. Büyük anlarda (çark, kumbara, takas) birden coşar.

## 16. UI / ekranlar (hepsi Türkçe)
1. **Ana sayfa:** Neon "KASALA!" logosu yanıp söner, takma ad alanı, **Masa Kur** / **Masaya Otur** (kodla). Arka planda Cemil Abi kart karıyor.
2. **Lobi:** Büyük oda kodu + "Linki kopyala" (`/r/ABCD`). En fazla 6 karakter kartı (isim, hayvan, renk, hazır ✓). Host ayarları: **Mod** (Klasik / Battle Royale), sıra sayısı (Otomatik / 3–12), karar süresi (5 / 8 / 12 sn), borç sistemi açık/kapalı, seyirci bahsi açık/kapalı.
3. **Oyun içi HUD:**
   - Üst orta: tur göstergesi + sıra şeridi (karakter ikonları), Son Masa'da kırmızı.
   - Orta: **TUR POTU** (büyük, sayarak artan rakam) + kombo sayacı.
   - Sol: **Siren lambası** (12 dilim) + "Sonraki kart: %29 BASKIN".
   - Alt orta (aktif oyuncu): **ÇEVİR** ve **KASALA!** butonları, karar süresi halkası, varsa Avukat kartı.
   - Alt sağ (seyirci): bahis kutuları + fiş seçici, canlı kararan kutular.
   - Üst sağ: kasa sıralaması + **Patronun Kumbarası** tutarı.
   - Sağ kenar: **Borç Defteri** (kırmızı mürekkep, taşlık tasması ikonu).
   - Akış: "🃏 Kedi **Çanta** çevirdi (+50$)", "🚨 Domuz BASKIN yedi (−34$)", "💸 Fare, Kurbağa'dan haraç kesti", "🎰 Tavşan KUMBARAYI PATLATTI (+420$)".
4. **Çark ekranı:** 3D sahnede, dilim isimleri büyük ve okunaklı, kazanan dilim yavaş çekimde parlar.
5. **Borç menüsü:** Oyuncu listesi, miktar kaydırıcısı, faiz seçimi, "Teklif Et" / "Borç İste" / "Öde".
6. **Maç sonu:** Borç tahsili animasyonu (fişler alacaklıya uçar) → **utanç unvanları** tek tek açılır ("Bomba Mıknatısı", "Borç Kralı", "En Büyük Korkak", "Kör Bahisçi", "Kara Liste", "Gözü Kara") → podyum.
7. **Podyum:** İlk 3 kişi fötr şapkalarıyla para yığınlarının üstünde. Sonuncunun kafasına çuval geçirilir. İstatistikler: en büyük KASALA, baskın sayısı, bahis kârı, verilen/alınan borç. **Rövanş** / **Lobiye dön**.
8. **Ayarlar (Esc):** Ses kaydırıcıları (Ana, Müzik, Efekt, Spiker), altyazı aç/kapa, grafik kalitesi, azaltılmış yanıp sönme.

**Yazı tipi:** Hub'la tutarlı olsun diye başlıklarda kalın ve yuvarlak bir font (Fredoka / Baloo 2), neon logoda ise art deco tarzı bir font (ör. "Monoton"). Türkçe karakter desteği (ğ, ş, ı, İ) kontrol edilmeli.

## 17. Çok oyunculu & ağ
### Mimari
- **Otoriter sunucu** (Node.js + **Colyseus**). Sıra, siren seviyesi, kart sonuçları, kasalar, bahisler, borçlar ve kumbara sunucuda tutulur.
- Sıra tabanlı ve fiziksiz olduğu için tahmin, interpolasyon ya da fizik gerekmez. Ağ trafiği olaylardan ibarettir.
- **RNG:** Maç başında tohumlanan sunucu RNG'si. Kart ve çark sonuçları sunucuda belirlenir, istemciye animasyonla birlikte gönderilir.

### Gizlilik
- Gizli rol yok. **Bahisler herkese açıktır** (bilinçli tasarım). Gizli tek şey, henüz çevrilmemiş kartların sonucudur ve bu sonuç sunucu çevirme anına kadar üretilmez.
- Borç teklifleri herkese yayınlanır (dram için).

### Odalar
- 4 harfli kod `ctx.codes.allocate(ctx.gameId)` ile alınır, `onDispose`'da bırakılır. Paylaşım linki `/r/ABCD`.
- En fazla **6** oyuncu. Maç sırasında katılan seyirci olur ve bir sonraki maçı bekler.
- Host çıkarsa hostluk sıradakine geçer. Bağlantı kopmasında **30 sn** yeniden bağlanma süresi (`allowReconnection`). Sırası gelen oyuncu bağlı değilse sırası otomatik KASALA ile (0 kart) geçer. Bahisleri iptal olur ve fişleri iade edilir.
- Son oyuncu çıktıktan 60 sn sonra oda kapanır.

### State (kavramsal şema)
- `Room`: phase (`lobby | betting | flipping | targeting | wheel | result | lastChance | matchEnd`), mode (`classic | royale`), round, turnIndex, turnOrder[], timer, settings, hostId, kumbara, sirenLevel, turnPot, isFinalTable.
- `Player`: id, nickname, animal, color, kasa, connected, eliminated, ghostWins, cursed, hasLawyer, trapped, stats (raids, biggestCash, betProfit, maxFlips, lent, borrowed).
- `Card` (son çevrilen): cardId, rarity, value, targetId.
- `Bet`: playerId, box, amount, ghost (herkese açık).
- `Debt`: id, lenderId, borrowerId, principal, ratePct, owed.
- Olaylar (tek seferlik mesajlar): `flip`, `cardResult`, `pickTarget`, `cash`, `raid`, `lawyerSaved`, `wheelStart`, `wheelResult`, `betPlaced`, `betSettle`, `loanOffer`, `loanAccept`, `loanDecline`, `loanRepay`, `taslik`, `lastChance`, `eliminated`, `ghostReturn`, `emote`, `taunt`, `announcer` (spiker repliği ID'si: tüm istemcilerde aynı varyasyon çalsın diye sunucu seçer).

### Bant genişliği
Olay başına birkaç yüz bayt. Saniyede birkaç mesaj, hepsi bu.

## 18. Teknik & hub entegrasyonu (şimdilik sadece plan, kod yok)
| Katman | Seçim |
|---|---|
| Dil | TypeScript (istemci, sunucu, ortak sabitler) |
| İstemci derleme | Vite, `base: "/games/kasala/"` |
| 3D | Three.js (`MeshToonMaterial`, GLTFLoader + Draco + KTX2Loader) |
| Fizik | Yok. Kart, çark ve para animasyonları tween'le (fiş yağmuru için basit parçacıklar) |
| Ağ | Colyseus sunucu + `colyseus.js` istemci, odalar `register(ctx)` içinde tanımlanır |
| UI | Canvas üstünde HTML/CSS katmanı (HUD, bahis kutuları, borç menüsü) |
| Ses | Web Audio (Three.js Audio). Spiker için ayrı kanal + ducking |

Hub klasörü (`README.md` → "Add a game"):
```
games/kasala/
  game.json            # id "kasala", players "2–6", duration "~10 dk", status oynanabilir olana kadar "soon"
  cover.svg            # 16:10 kapak: neon "KASALA!" tabelası, yeşil çuha, kırmızı siren
  server/index.ts      # export function register(ctx) → ctx.gameServer.define("kasala", KasalaRoom)
  client/vite.config.ts
  client/public/audio/spiker/*.mp3
  shared/              # denge sabitleri, kart tablosu, çark tablosu, mesaj tipleri, spiker replik tablosu
```

## 19. Denge sayıları (başlangıç değerleri, test oyunlarında ayarlanacak)
| Parametre | Değer |
|---|---|
| Başlangıç kasası | 200$ (Battle Royale: 150$) |
| Başlangıç kumbarası | 100$ |
| Baskın ihtimali | %8 + siren seviyesi × %7, en fazla %95 |
| Baskın cezası | Tur potu + kasanın %10'u (Battle Royale: tur no × 20$) |
| Kart ağırlıkları | Bozukluk 25, Tomar 18, Çanta 12, Külçe 5, ×2 8, Haraç 6, Haraç Turu 4, Tuzak 4, Lanet 3, Takas 1, Avukat 4, Rüşvet Zarfı 6, Çark 4 |
| Çark ağırlıkları | Kumbara 10, ×10 8, Herkese 100 15, Karıştır 10, Herkese 50 Öde 14, Avukat 15, Toplu Baskın 13, Bir Daha 15 |
| Bahis penceresi | 5 sn |
| Fişler | 10 / 25 / 50$ |
| Bahis ödemeleri | 1–2: ×4 · 3–4: ×4 · 5+: ×10 · Kasalar: ×1.8 |
| Ev payı | Kaybeden bahislerin %10'u aktif oyuncuya, %90'ı kumbaraya |
| Karar süresi | 8 sn, süre dolunca otomatik KASALA |
| Saldırı hedef seçimi | 6 sn, süre dolunca rastgele |
| Borç limiti | Verenin kasasının %50'si |
| Faiz seçenekleri | Tam tur başına %10 / %20 / %30 |
| Taşlık eşiği | Toplam borç > kasa |
| Taşlık kesintisi | KASALA kazancının %50'si alacaklıya |
| Son Masa | Klasik'te son tam tur, her şey ×2 |
| Battle Royale siren artışı | Tam tur başına taban +%2 |
| Son Şans süresi | 15 sn |
| Hayalet dönüşü | 3 doğru tahmin → 50$ ile dönüş, maç başına 1 kez |
| Klasik sıra sayısı | 2 oy.: 10 · 3 oy.: 8 · 4 oy.: 6 · 5–6 oy.: 5 |

**Maç süresi hesabı:** Bir tur ≈ bahis 5 sn + ortalama 3.2 kart × ~3 sn + sonuç ve ödeme ~4 sn ≈ **20 sn** (çark çıkarsa +8 sn). Klasik'te toplam tur sayısı 2 oyuncuda 20, 3 oyuncuda 24, 4 oyuncuda 24, 5 oyuncuda 25, 6 oyuncuda 30, yani **~7–10 dk** + lobi ve podyum için ~1.5 dk ≈ **8–12 dk**.

**Ekonomi kontrolü:** 3–4 kartta duran bir oyuncunun tur başına beklenen kazancı ~37$'dır. Baskın riski kasa büyüdükçe pahalılaşır (%10). Bu, öndekileri temkinli olmaya iter ve geride kalanlara yetişme şansı verir. Haraç ve Takas da lideri hedef tahtasına çevirir.

## 20. Geliştirme kilometre taşları
1. **M1 – Tek kişilik çekirdek:** Gri kutu masa, kart çevirme animasyonu, siren sayacı, para + çarpan kartları, KASALA/baskın, HUD iskeleti.
2. **M2 – Ağ:** Colyseus odası + kodlar, sıra düzeni, sunucu RNG'si, 2–6 oyuncu, yeniden bağlanma.
3. **M3 – Saldırı & çark:** Hedef seçimi, tüm saldırı/koruma kartları, Patronun Çarkı ve kumbara.
4. **M4 – Sosyal katman:** Seyirci bahsi (canlı kararan kutular, ev payı), borç & tefecilik, Taşlık, borç defteri.
5. **M5 – Sanat & ses:** Pavyon sahnesi, 6 gangster hayvan + Cemil Abi + Komiser Rıfat, baskın animasyonları, emoteler, müzik/efekt, **spiker mp3 entegrasyonu** (§15'teki ID tablosu `shared/` içine).
6. **M6 – Modlar & cila:** Battle Royale (Son Şans, nehir, hayaletler), Son Masa, utanç unvanları, podyum, ayarlar, azaltılmış yanıp sönme.
7. **M7 – Yayın & test:** Hub'a ekle (`status: "live"`), arkadaşlarla oyna, §19'u ayarla (özellikle siren adımı, bahis oranları ve Takas sıklığı).

**"Yeterince eğlenceli" tanımı:** Biri 5+ kutusuna 50$ basıp arkadaşına "ÇEVİR!" diye yalvarıyor, arkadaşı inadına KASALA diyor ve masa kahkahadan yıkılıyor.

## 21. İleri fikirler (v1'de yok)
- **Çifte ya da hiç:** KASALA dedikten sonra potu yazı-turaya basma seçeneği.
- **Kirli koz kartları:** Ele alınıp başkasının turunda oynanan nadir kartlar ("İhbar": aktif oyuncunun sirenini +2 yap).
- **Gizli muhbir** rolü (5–6 oyuncuda): kartların bir sonrakini görebilen, sonda oylanan bir hain.
- **Kader ortaklığı:** Seyirci, aktif oyuncunun turundan hisse satın alır.
- Mobil dokunmatik kontroller.
- Kozmetik açılımlar (altın diş, pırlanta yüzük, beyaz takım) ve localStorage'da tutulan "en büyük vurgun" rekoru.
- Ek spiker paketleri: Cemil Abi'nin yanına ikinci bir yorumcu (Komiser Rıfat'ın telsiz anonsları).
