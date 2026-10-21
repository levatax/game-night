// "reel" strings. English is the source of truth; tr must have every key (enforced by the type).
// quips_*: several one-liners separated by "|" (one is picked at random), so each language can have its own count.
export const en = {
  title: "🎰 {name}'s bonus case",
  someone: "Someone",
  chipAria: "Bonus card: {name} ({mult} coins if the tower stands). {text}",
  resultWin: "{mult} coins if your tower stands!",
  resultCursed: "Scary! But {mult} coins if your tower stands!",
  resultPlain: "Normal turn — just stack it!",
  cursedTag: "💀 CURSED! 💀",
  quips_common: "Meh. 🥱|Could be worse!|Boring. Safe. Beige.|The chef shrugs.|A fine, mild salsa.",
  quips_uncommon: "Ooh, spicy! 🌶️|Now we're cooking!|Fancy!|Things are getting weird…",
  quips_rare: "WHOA! 🤯|Big brain card!|The crowd goes mild!|Purple = danger. Probably.",
  quips_legendary: "JACKPOT!!! 🤑|CHA-CHING! 💰|The kitchen gods smile!|GOLDEN! Somebody call mom!",
  quips_cursed: "Oh no. Oh no no no. 💀|Cursed! 😱|Who angered the oven?!|That's… unfortunate.",
  quips_tease: "SO CLOSE! 😭|Noooo, the gold one! 😩|Missed it by a whisker! 🐭",
} satisfies Record<string, string>;

export const tr: Record<keyof typeof en, string> = {
  title: "🎰 {name} bonus kartını çekiyor",
  someone: "Biri",
  chipAria: "Bonus kart: {name} (kule ayakta kalırsa {mult} jeton). {text}",
  resultWin: "Kulen ayakta kalırsa {mult} jeton!",
  resultCursed: "Korkunç! Ama kulen ayakta kalırsa {mult} jeton!",
  resultPlain: "Normal tur — koy gitsin!",
  cursedTag: "💀 LANETLİ! 💀",
  quips_common: "Eh işte. 🥱|Daha kötüsü de olabilirdi!|Sıkıcı. Güvenli. Bej.|Şef omuz silkti.|Acısız, ılık bir salça.",
  quips_uncommon: "Oha, acılı! 🌶️|Şimdi pişiyoruz!|Havalı!|İşler tuhaflaşıyor…",
  quips_rare: "VAY BE! 🤯|Dâhi kartı!|Seyirci hafiften coştu!|Mor = tehlike. Galiba.",
  quips_legendary: "JACKPOT!!! 🤑|ŞAKIR ŞAKIR! 💰|Mutfak tanrıları gülümsüyor!|ALTIN! Annemi arayın!",
  quips_cursed: "Eyvah. Eyvah eyvah eyvah. 💀|Lanetli! 😱|Fırını kim kızdırdı?!|Bu… pek hayırlı olmadı.",
  quips_tease: "AZ KALDI! 😭|Hayıııır, altın olan! 😩|Kıl payı kaçtı! 🐭",
};
