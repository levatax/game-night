// "scene" strings. English is the source of truth; tr must have every key (enforced by the type).
// Keys ending in "Lines" are "|"-separated pools the chefs pick from at random.
export const en = {
  // Neon sign above the fridge when no card is showing (brand name, kept as is).
  signIdle: "JELLY JACKPOT",
  // Canvas labels on pieces.
  weightTag: "3 KG",
  soapLabel: "SOAP",
  // Nameplate tags.
  plateYou: "YOU",
  plateAway: "zzz",
  // Chef speech bubbles.
  cheerLines: "YESSS!|WOOO!|NAILED IT!|YIPPEE!|BOOYAH!",
  gaspLines: "OOH!|EEP!|GASP!|OH NO!|YIKES!",
  cryLines: "NOOO!|MY COINS!|WAAAH!|SOB!|WHYYY",
  pointLines: "LOOK!|THAT ONE!|OI!|SUS!",
  pieLines: "MMPH!|BLORP|*splat*|MMFF!",
  laughLines: "HA HA!|HA HA HA!|HO HO!|HEE HEE!",
  bye: "BYE!",
  devilLaugh: "MWAHAHA!",
  snore: "Zzz…",
  // Blindfold overlay caption (Fx DOM layer).
  blindCaption: "shhh… drop it from memory!",
} satisfies Record<string, string>;

export const tr: Record<keyof typeof en, string> = {
  signIdle: "JELLY JACKPOT",
  weightTag: "3 KG",
  soapLabel: "SABUN",
  plateYou: "SEN",
  plateAway: "zzz",
  cheerLines: "EVEEET!|OHAAA!|ÇAKTIM!|YAŞASIIIN!|İŞTE BU!",
  gaspLines: "OHA!|EYVAH!|HIIH!|AMAN!|YANDIK!",
  cryLines: "HAYIIIR!|PARALARIM!|ÜHÜÜÜ!|SNİF!|NEDEEEN",
  pointLines: "BAK BAK!|ŞU!|HOOP!|ŞÜPHELİ!",
  pieLines: "MMPH!|BLORP|*şlap*|MMFF!",
  laughLines: "HA HA!|HA HA HA!|KIH KIH!|Hİ Hİ!",
  bye: "BAY BAY!",
  devilLaugh: "MUHAHAHA!",
  snore: "Zzz…",
  blindCaption: "şşşt… ezbere bırak gitsin!",
};
