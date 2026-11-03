// "reject" strings: why an action was refused (RejectEvent.reason, Interaction.reason). English is the source of
// truth; tr must have every key (enforced by the type). Owner: client-ui. The reasons are exactly the ones
// server-world emits (docs/ARCHITECTURE.md §7): full, fireOut, missing, tooFar, locked, wrongStage,
// nothingToDeliver, notReady, empty, noRoom, noSpot, busy, dead.
export const en = {
  full: "Your pockets are full",
  fireOut: "The fire is out! Feed it wood",
  missing: "Missing ingredients",
  tooFar: "Too far away",
  locked: "That recipe is still a secret",
  wrongStage: "The raft doesn't need that right now",
  nothingToDeliver: "You have nothing the raft needs",
  notReady: "The raft isn't finished yet",
  empty: "There's nothing there",
  noRoom: "No room to put it here",
  noSpot: "Aim at the foamy water",
  busy: "Can't do that right now",
  dead: "Not while you're down",
  botDelivers: "The humans build this raft themselves",
};

export const tr: Record<keyof typeof en, string> = {
  full: "Ceplerin dolu",
  fireOut: "Ateş sönmüş! Odun at",
  missing: "Malzeme eksik",
  tooFar: "Çok uzaktasın",
  locked: "Bu tarif hâlâ bir sır",
  wrongStage: "Salın şu an buna ihtiyacı yok",
  nothingToDeliver: "Sende salın istediği bir şey yok",
  notReady: "Sal henüz bitmedi",
  empty: "Orada bir şey yok",
  noRoom: "Buraya koyacak yer yok",
  noSpot: "Köpüren suya nişan al",
  busy: "Şu an bunu yapamazsın",
  dead: "Yerdeyken olmaz",
  botDelivers: "Bu salı insanlar kendisi kurar",
};
