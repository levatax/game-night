// "reel" strings. English is the source of truth; tr must have every key (enforced by the type).
// quips_*: several one-liners separated by "|" (one is picked at random), so each language can have its own count.
export const en = {
  title: "🎰 {name} opens a case",
  someone: "Someone",
  chipAria: "Current rule: {name} ({rarity}, {mult}). {text}",
  quips_common: "Meh. 🥱|Could be worse!|Boring. Safe. Beige.|The chef shrugs.|A fine, mild salsa.",
  quips_uncommon: "Ooh, spicy! 🌶️|Now we're cooking!|Fancy!|Things are getting weird…",
  quips_rare: "WHOA! 🤯|Big brain card!|The crowd goes mild!|Purple = danger. Probably.",
  quips_legendary: "JACKPOT!!! 🤑|CHA-CHING! 💰|The kitchen gods smile!|GOLDEN! Somebody call mom!",
  quips_cursed: "Oh no. Oh no no no. 💀|Cursed! 😱|Who angered the oven?!|That's… unfortunate.",
  quips_tease: "SO CLOSE! 😭|Noooo, the gold one! 😩|Missed it by a whisker! 🐭",
} satisfies Record<string, string>;

export const tr: Record<keyof typeof en, string> = {
  title: "🎰 {name} kasa açıyor",
  someone: "Biri",
  chipAria: "Şu anki kural: {name} ({rarity}, {mult}). {text}",
  quips_common: "Eh işte. 🥱|Daha kötüsü de olabilirdi!|Sıkıcı. Güvenli. Bej.|Şef omuz silkti.|Acısız, ılık bir salça.",
  quips_uncommon: "Oha, acılı! 🌶️|Şimdi pişiyoruz!|Havalı!|İşler tuhaflaşıyor…",
  quips_rare: "VAY BE! 🤯|Dâhi kartı!|Seyirci hafiften coştu!|Mor = tehlike. Galiba.",
  quips_legendary: "JACKPOT!!! 🤑|ŞAKIR ŞAKIR! 💰|Mutfak tanrıları gülümsüyor!|ALTIN! Annemi arayın!",
  quips_cursed: "Eyvah. Eyvah eyvah eyvah. 💀|Lanetli! 😱|Fırını kim kızdırdı?!|Bu… pek hayırlı olmadı.",
  quips_tease: "AZ KALDI! 😭|Hayıııır, altın olan! 😩|Kıl payı kaçtı! 🐭",
};
