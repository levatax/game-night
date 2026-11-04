// "hud" strings: the always-on and contextual HUD widgets (bars, hotbar, clock, compass, raft, fire, fishing,
// downed / washed screens, boarding countdown, teammates, pointer veil, reconnect pill, graphics-reset card).
// English is the source of truth; tr must have every key (enforced by the type). Owner: client-ui. "|"-separated
// values are variants picked at random. {k…} placeholders are the player's keys: every caller passes
// ui/controls.ts keyParams() (Turkish says "{kInteract} tuşuna", so no suffix depends on the letter).
export const en = {
  // ------------------------------------------------------------------ bars
  bar_hp: "Health",
  bar_hunger: "Hunger",
  bar_thirst: "Thirst",
  bar_warmth: "Warmth",
  barLow: "low!",

  // ----------------------------------------------------------------- clock
  clockDay: "Day {day}/{days}",
  clockDusk: "Dusk {day}/{days}",
  clockNight: "Night {day}/{days}",
  clockLanding: "Washing ashore",
  clockLaunch: "Sailing away!",
  clockStorm: "THE STORM!",
  stormIn: "Storm in {t}",
  stormSoon: "STORM IN {t}!",
  weatherNow: "Weather: {weather}",

  // --------------------------------------------------------------- compass
  compassN: "N",
  compassE: "E",
  compassS: "S",
  compassW: "W",
  meters: "{d} m",
  seconds: "{n} s",

  // ------------------------------------------------------------------ raft
  raftTitle: "Raft",
  raftStage_0: "Keel",
  raftStage_1: "Deck",
  raftStage_2: "Mast",
  raftStage_3: "Sail",
  raftStage_4: "Rudder & Compass",
  raftStage_5: "Provisions",
  raftStage_6: "Launch",
  raftReady: "READY! Press {kInteract} on it",
  raftAboard: "{n}/{total} aboard",
  raftDone: "done",
  dayOf: "Day {d}/{n}",
  stageLocked: "Opens on day {day}",
  launchLocked: "The sea is too rough — launch window opens on day {day}",
  assemble: "Hold {kInteract} to assemble ({pct}%)",
  mastNeedsTwo: "Raising the mast needs 2 people",
  raftHp: "Raft integrity",
  bench_0: "Campfire",
  bench_1: "Workbench",
  bench_2: "Anvil",
  heavy: "Heavy load — walk beside a friend",
  escorted: "Escorted",
  bossTonight: "Captain Crab comes tonight",
  bossReturns: "Captain Crab returns every night until defeated",
  launchCountdown: "Push-off in {sec}s — everyone aboard!",
  springCharges: "Spring: {n}",

  // ------------------------------------------------------------------ fire
  fireTitle: "Fire",
  fireOut: "OUT!",
  fireLow: "LOW",

  // --------------------------------------------------- crosshair & actions
  chargeMax: "MAX!",
  holdE: "hold",
  fishWait: "Waiting for a bite…",
  fishBite: "CLICK NOW!",
  fishReel: "Reeling in…",

  // --------------------------------------------------------------- hotbar
  slotEmpty: "Empty hands",
  hint_throw: "Hold LMB: throw · {kToss}: toss",
  hint_eat: "{kEat}: eat",
  hint_drink: "{kEat}: drink",
  hint_eatThrow: "{kEat}: eat · hold LMB: throw",
  hint_bait: "{kEat}: eat · throw it as crab bait",
  hint_place: "LMB: place it",
  hint_torch: "LMB: swing · {kToss}: plant it",
  hint_rod: "LMB at foamy water: cast",
  hint_axe: "Chops fast · LMB on a palm: all coconuts",
  hint_raft: "Carry it to the raft: {kInteract}",
  hint_heavy: "Heavy! No sprinting · {kToss}: drop it",
  hint_hammer: "Assembles and repairs the raft, salvages the wreck",
  hint_jelly: "OUCH! Throw it into the fire!",
  hint_puffer: "It's going to blow! THROW IT!",
  hint_toss: "{kToss}: toss it to a friend",
  hint_kraken: "LMB: place it · or cook a feast",

  // --------------------------------------------------------- downed screen
  downTitle: "YOU'RE DOWN!",
  downSub: "Crawl to a friend: they can hold {kInteract} on you to help you up",
  downTimer: "The waves take you in {s}",
  downReviving: "A friend is pulling you up!",

  // --------------------------------------------------------- washed screen
  washTitle: "The waves washed you ashore",
  washJokes:
    "You're wearing seaweed now. It suits you.|A crab moved into your flip-flop.|You and a coconut named Wilson are best friends now.|Your sunscreen washed off. So did your dignity.|A seagull is judging you from a rock.",
  washLost: "The tide took everything in your pockets.",
  washRespawn: "You'll wake up at the wreck at dawn · {t}",
  washNoDawn: "No dawn is coming… cheer your friends on from the beach!",

  // ------------------------------------------------------ boarding & launch
  launchTitle: "BOARDING!",
  launchLeaves: "The raft leaves in {t}",
  launchAboard: "{n}/{total} aboard",
  launchGo: "Run to the raft and press {kInteract}!",
  launchBoarded: "You're aboard! Waiting for the stragglers…",

  // ------------------------------------------------------------ teammates
  mate_down: "DOWN",
  mate_washed: "ASHORE",
  mate_aboard: "ABOARD",
  mate_away: "AWAY",

  // ------------------------------------------- sound captions (Subtitle.ts)
  // {dir} is "" or " · " + one of dir_* (where the sound came from, relative to the view).
  cap_spawn_crab: "Claws clicking out of the surf{dir}",
  cap_spawn_puffer: "A puffer fish flops out of the waves{dir}",
  cap_fence: "Something is gnawing at a fence{dir}",
  cap_blast: "A puffer fish went off with a bang{dir}",
  cap_thunder: "Thunder rumbles in the distance",
  cap_thunderNear: "Thunder cracks across the sky!",
  dir_ahead: "ahead",
  dir_right: "to your right",
  dir_behind: "behind you",
  dir_left: "to your left",

  // ---------------------------------------------------------------- misc
  spectating: "Spectating · you'll be stranded next match",
  spectateHint: "Drag to look around · Click or Space: next teammate · Right-click: back",
  clickToPlay: "Click to play",
  clickHint: "opens the menu",
  veilKeys: "No mouse? Press Enter, then drag on the trackpad to look around",
  veilDrag: "Mouse lock is off: hold a mouse button and drag to look around",
  menuBtn: "Menu",

  // ----------------------------------------- connection pill & graphics card
  reconnecting: "Reconnecting… (attempt {n})",
  reconnectingHint: "The view is frozen until you're back. Your seat is kept for {sec} s.",
  gpuLostTitle: "The graphics were reset",
  gpuLostText: "Your browser restarted the graphics (a driver hiccup, or the tab napped in the background). Reload the page to bring the island back.",
  gpuLostReload: "Reload",
};

export const tr: Record<keyof typeof en, string> = {
  // ------------------------------------------------------------------ bars
  bar_hp: "Can",
  bar_hunger: "Açlık",
  bar_thirst: "Susuzluk",
  bar_warmth: "Isı",
  barLow: "az!",

  // ----------------------------------------------------------------- clock
  clockDay: "Gün {day}/{days}",
  clockDusk: "Akşam {day}/{days}",
  clockNight: "Gece {day}/{days}",
  clockLanding: "Karaya çıkış",
  clockLaunch: "Yola çıktık!",
  clockStorm: "FIRTINA!",
  stormIn: "Fırtınaya {t}",
  stormSoon: "FIRTINAYA {t}!",
  weatherNow: "Hava: {weather}",

  // --------------------------------------------------------------- compass
  compassN: "K",
  compassE: "D",
  compassS: "G",
  compassW: "B",
  meters: "{d} m",
  seconds: "{n} sn",

  // ------------------------------------------------------------------ raft
  raftTitle: "Sal",
  raftStage_0: "Omurga",
  raftStage_1: "Güverte",
  raftStage_2: "Direk",
  raftStage_3: "Yelken",
  raftStage_4: "Dümen ve Pusula",
  raftStage_5: "Erzak",
  raftStage_6: "Denize İndir",
  raftReady: "HAZIR! Üstünde {kInteract} tuşuna bas",
  raftAboard: "{n}/{total} salda",
  raftDone: "tamam",
  dayOf: "{d}/{n}. Gün",
  stageLocked: "{day}. gün açılır",
  launchLocked: "Deniz çok dalgalı — denize açılış {day}. gün",
  assemble: "Birleştirmek için {kInteract} tuşunu basılı tut (%{pct})",
  mastNeedsTwo: "Direği kaldırmak için 2 kişi gerek",
  raftHp: "Sal sağlamlığı",
  bench_0: "Kamp ateşi",
  bench_1: "Tezgâh",
  bench_2: "Örs",
  heavy: "Ağır yük — bir arkadaşınla yan yana yürü",
  escorted: "Destekleniyor",
  bossTonight: "Kaptan Yengeç bu gece geliyor",
  bossReturns: "Kaptan Yengeç yenilene kadar her gece dönecek",
  launchCountdown: "Açılmaya {sec} sn — herkes sala!",
  springCharges: "Kaynak: {n}",

  // ------------------------------------------------------------------ fire
  fireTitle: "Ateş",
  fireOut: "SÖNDÜ!",
  fireLow: "AZ",

  // --------------------------------------------------- crosshair & actions
  chargeMax: "TAM!",
  holdE: "basılı tut",
  fishWait: "Balık bekleniyor…",
  fishBite: "ŞİMDİ TIKLA!",
  fishReel: "Çekiliyor…",

  // --------------------------------------------------------------- hotbar
  slotEmpty: "Elin boş",
  hint_throw: "Sol tık basılı: fırlat · {kToss}: at",
  hint_eat: "{kEat}: ye",
  hint_drink: "{kEat}: iç",
  hint_eatThrow: "{kEat}: ye · sol tık basılı: fırlat",
  hint_bait: "{kEat}: ye · fırlatırsan yengeç yemi",
  hint_place: "Sol tık: yere koy",
  hint_torch: "Sol tık: salla · {kToss}: yere sapla",
  hint_rod: "Köpüren suya sol tık: olta at",
  hint_axe: "Hızlı keser · palmiyeye sol tık: tüm cevizler",
  hint_raft: "Sala götür: {kInteract}",
  hint_heavy: "Ağır! Koşamazsın · {kToss}: yere bırak",
  hint_hammer: "Salı birleştirir ve onarır, batıktan hurda söker",
  hint_jelly: "AH! Ateşe fırlat şunu!",
  hint_puffer: "Patlayacak! FIRLAT!",
  hint_toss: "{kToss}: arkadaşına at",
  hint_kraken: "Sol tık: yere koy · ya da ziyafet pişir",

  // --------------------------------------------------------- downed screen
  downTitle: "YERE DÜŞTÜN!",
  downSub: "Bir arkadaşına sürün: üstünde {kInteract} tuşunu basılı tutup seni kaldırabilir",
  downTimer: "Dalgalar seni {s} içinde alıp götürecek",
  downReviving: "Bir arkadaşın seni kaldırıyor!",

  // --------------------------------------------------------- washed screen
  washTitle: "Dalgalar seni kıyıya attı",
  washJokes:
    "Artık deniz yosunu giyiyorsun. Yakıştı.|Terliğine bir yengeç taşınmış.|Wilson adında bir hindistan ceviziyle artık kanka oldunuz.|Güneş kremin aktı gitti. Haysiyetin de.|Bir martı kayanın üstünden seni yargılıyor.",
  washLost: "Ceplerindeki her şeyi dalgalar aldı.",
  washRespawn: "Şafakta enkazın yanında uyanacaksın · {t}",
  washNoDawn: "Şafak gelmeyecek… arkadaşlarına kumsaldan tezahürat yap!",

  // ------------------------------------------------------ boarding & launch
  launchTitle: "BİNİŞ!",
  launchLeaves: "Sal kalkıyor: {t}",
  launchAboard: "{n}/{total} salda",
  launchGo: "Sala koş, {kInteract} tuşuna bas!",
  launchBoarded: "Saldasın! Geride kalanlar bekleniyor…",

  // ------------------------------------------------------------ teammates
  mate_down: "YERDE",
  mate_washed: "KIYIDA",
  mate_aboard: "SALDA",
  mate_away: "KOPTU",

  // ------------------------------------------- sound captions (Subtitle.ts)
  cap_spawn_crab: "Dalgaların içinden kıskaç tıkırtıları{dir}",
  cap_spawn_puffer: "Dalgalardan bir balon balığı çırpınarak çıktı{dir}",
  cap_fence: "Bir şey çiti kemiriyor{dir}",
  cap_blast: "Bir balon balığı güm diye patladı{dir}",
  cap_thunder: "Uzaklarda gök gürlüyor",
  cap_thunderNear: "Gök gürültüsü gökyüzünü yardı!",
  dir_ahead: "önünde",
  dir_right: "sağında",
  dir_behind: "arkanda",
  dir_left: "solunda",

  // ---------------------------------------------------------------- misc
  spectating: "İzleyicisin · bir sonraki maçta sen de mahsursun",
  spectateHint: "Sürükle: etrafa bak · Tık ya da Boşluk: sıradaki arkadaş · Sağ tık: geri",
  clickToPlay: "Oynamak için tıkla",
  clickHint: "menüyü açar",
  veilKeys: "Fare yok mu? Enter tuşuna bas, sonra etrafa bakmak için dokunmatik yüzeyde sürükle",
  veilDrag: "Fare kilidi kapalı: etrafa bakmak için fare tuşunu basılı tutup sürükle",
  menuBtn: "Menü",

  // ----------------------------------------- connection pill & graphics card
  reconnecting: "Yeniden bağlanılıyor… ({n}. deneme)",
  reconnectingHint: "Geri dönene kadar görüntü donuk. Yerin {sec} sn boyunca korunur.",
  gpuLostTitle: "Grafikler sıfırlandı",
  gpuLostText: "Tarayıcın grafikleri yeniden başlattı (bir sürücü aksaması ya da sekme arka planda uyuyakaldı). Adayı geri getirmek için sayfayı yenile.",
  gpuLostReload: "Yenile",
};
