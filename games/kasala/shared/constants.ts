// KASALA! balance numbers, card / wheel / bet tables, characters, colors and timings. FROZEN CONTRACT
// (see docs/ARCHITECTURE.md). Shared by the server (rules, room) and the client (visuals, UI).
// Units: seconds and dollars ($). Every number here comes from game3.md §5–§10 and §19.
// Change values here, never re-declare them in a module. All player-facing text is Turkish.

export const GAME_ID = "kasala";
export const ROOM_NAME = "kasala";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const NICKNAME_MAX = 14;
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 4;

export const RECONNECT_STORAGE_KEY = "kasala:reconnect";
export const NICKNAME_STORAGE_KEY = "kasala:nickname";
export const SETTINGS_STORAGE_KEY = "kasala:settings";

// ------------------------------------------------------------------------- timing
/** Server tick (phase timers only, no physics). */
export const TICK_MS = 50;
/** Colyseus patch rate. */
export const PATCH_INTERVAL_MS = 50;

/** Match intro: table set up, Cemil Abi's welcome line. */
export const INTRO_SEC = 6;
/** Turn start with side bets open (§8). Closes early once every eligible bettor has bet or passed. */
export const BET_WINDOW_SEC = 5;
/** Round 1 bet window: new players need time to read the boxes. */
export const BET_WINDOW_FIRST_ROUND_SEC = 7;
/** Turn start when nobody can bet (side bets off / no bettor): just "Sıra sende". */
export const TURN_INTRO_SEC = 1.5;
/** Decision timer after each card (§4): ÇEVİR or KASALA!, auto KASALA at 0. */
export const DECISION_SEC_OPTIONS = [5, 8, 12] as const;
export const DEFAULT_DECISION_SEC = 8;
/**
 * Time to flip the FIRST card of a turn (the decision timer only runs after a card, §4). KASALA is not
 * allowed before the first card; when this runs out Cemil Abi flips the first card for you.
 */
export const FIRST_CARD_SEC = 10;
/** state.timeLeft is rounded up to this step (clients interpolate between patches). */
export const TIMER_QUANTUM_SEC = 0.25;
/** "Karar ver" warning (announcer sure_azaldi) when this much decision time is left. */
export const TIME_LOW_SEC = 3;
/**
 * Server-side lock after every FLIP while clients play the card animation (lift from the tower, 0.4 s
 * slow-mo turn, rarity glow). Input is ignored (`state.busy`) and the decision timer restarts after it.
 */
export const FLIP_ANIM_SEC = 1.3;
/** Attack cards with a chosen target (§6): pick within this time or a random target is used. */
export const TARGET_SEC = 6;
/** After an attack resolves (ATTACK broadcast) before flipping resumes. */
export const ATTACK_ANIM_SEC = 1.8;
/** After a Lawyer cancels a raid (CARD with saved = true) before flipping resumes. */
export const LAWYER_ANIM_SEC = 1.8;
/** Patronun Çarkı (§7): lowered from the ceiling, spins 4–6 s, holds on the result, goes back up. */
export const WHEEL_DESCEND_SEC = 1.8;
export const WHEEL_SPIN_MIN_SEC = 4;
export const WHEEL_SPIN_MAX_SEC = 6;
export const WHEEL_HOLD_SEC = 2.8;
export const WHEEL_ASCEND_SEC = 1.2;
/** Result phase length: KASALA celebration (small pot / pot ≥ BIG_CASH). */
export const CASH_RESULT_SEC = 2.4;
export const CASH_RESULT_BIG_SEC = 3.2;
/** Raid result: full door sequence (big or late raid, a player's first raid) / quick at-the-seat raid. */
export const RAID_RESULT_SEC = 5.5;
export const RAID_RESULT_SHORT_SEC = 3.6;
/** Bet payout phase (skipped when there were no bets). */
export const SETTLE_SEC = 1.4;
/** Battle Royale: a broke player waits this long for a loan (§10). */
export const LAST_CHANCE_SEC = 15;
/** Battle Royale: the cement shoes scene. */
export const ELIMINATION_SEC = 5;
/** Pending loan offers / requests expire after this. */
export const LOAN_OFFER_SEC = 15;
/** Speech bubble time (§11 laf balonları). */
export const TAUNT_SEC = 3;
/** Per-player rate limit for EMOTE / TAUNT. */
export const EMOTE_COOLDOWN_SEC = 1.5;
export const RECONNECT_GRACE_SEC = 30;
export const EMPTY_ROOM_DISPOSE_SEC = 60;

// ------------------------------------------------------------------------ economy
export const START_KASA = 200;
export const ROYALE_START_KASA = 150;
export const START_KUMBARA = 100;

/** §5: chance that the NEXT card is a raid = 8% + level × 7%, at most 95% (+ Battle Royale floor). */
export const RAID_BASE_CHANCE = 0.08;
export const RAID_STEP = 0.07;
export const RAID_MAX_CHANCE = 0.95;
/** Battle Royale: the siren floor rises this much per completed full round. */
export const ROYALE_FLOOR_STEP = 0.02;
export function raidChance(level: number, floorBonus = 0): number {
  return Math.min(RAID_MAX_CHANCE, RAID_BASE_CHANCE + Math.max(0, level) * RAID_STEP + floorBonus);
}
/** HUD siren lamp segments (§5). */
export const SIREN_SEGMENTS = 12;
/** Announcer siren_orta / siren_kritik thresholds and the ≥50% camera tremble (§14, §15). */
export const SIREN_MID_CHANCE = 0.2;
export const SIREN_CRITICAL_CHANCE = 0.33;
export const SIREN_SHAKE_CHANCE = 0.4;

/** Raid penalty: the turn pot goes to the kumbara, plus a bribe from the kasa (§6, §10). */
export const RAID_BRIBE_PCT = 0.1;
/** Battle Royale bribe is fixed: round × 20$. */
export const ROYALE_BRIBE_PER_ROUND = 20;

/** Tuzak: the next player's turn starts at this siren level. */
export const TRAP_LEVEL = 2;
/** Rüşvet Zarfı lowers the siren level by this much (after the usual +1, floored at 0). */
export const BRIBE_ENVELOPE_DROP = 2;
/** Haraç: this share of the target's kasa moves into the flipper's turn pot. */
export const HARAC_PCT = 0.2;
/** Haraç Turu: everyone else pays this (as much as they have) into the turn pot. */
export const HARAC_TURU_FEE = 10;
/** Classic SON MASA (last full round): money cards, penalties and bet payouts are doubled. */
export const FINAL_TABLE_MULT = 2;

/** Side bet chips (Q / W / E). */
export const CHIP_AMOUNTS = [10, 25, 50] as const;
/** Share of the losing bets that goes to the active player; the rest goes to the kumbara (§8). */
export const HOUSE_CUT_PCT = 0.1;

/** Loans (§9): a lender may lend at most this share of their kasa. */
export const LOAN_MAX_PCT = 0.5;
export const LOAN_MIN = 10;
/** Interest per completed full round, in percent. */
export const LOAN_RATES = [10, 20, 30] as const;
/** Taşlık: total debt > kasa. Half of every KASALA gain goes straight to the creditors. */
export const TASLIK_CUT_PCT = 0.5;

/** Battle Royale ghosts (§10). */
export const GHOST_CHIP = 10;
export const GHOST_WINS_TO_RETURN = 3;
export const GHOST_RETURN_KASA = 50;
export const ROYALE_MAX_ROUNDS = 12;

/** Lobby "sıra sayısı": 0 = auto (classicRounds), otherwise each player's number of turns. */
export const TURN_OPTIONS = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
/** §10 Klasik: number of full rounds (= turns per player) by player count. */
export function classicRounds(players: number): number {
  if (players <= 2) return 10;
  if (players === 3) return 8;
  if (players === 4) return 6;
  return 5;
}

/** Announcer KASALA lines: pot < SMALL → kasala_kucuk, pot ≥ BIG → kasala_buyuk. */
export const SMALL_CASH = 60;
export const BIG_CASH = 150;
/** "En Büyük Korkak": a KASALA with at most this many cards counts as an early cash. */
export const EARLY_CASH_FLIPS = 2;

// -------------------------------------------------------------------------- cards
export type Rarity = "common" | "uncommon" | "rare" | "legendary" | "trouble";
export const RARITIES: Record<Rarity, { label: string; color: string }> = {
  common: { label: "Sıradan", color: "#C9874B" },
  uncommon: { label: "Seyrek", color: "#C7D0DA" },
  rare: { label: "Nadir", color: "#FFC93C" },
  legendary: { label: "Efsanevi", color: "#B05CFF" },
  trouble: { label: "Bela", color: "#E5383B" },
};

export type CardKind = "money" | "multiplier" | "attack" | "protection" | "special" | "raid";
export type CardId =
  | "bozukluk"
  | "tomar"
  | "canta"
  | "kulce"
  | "aklama"
  | "harac"
  | "haracTuru"
  | "tuzak"
  | "lanet"
  | "takas"
  | "avukat"
  | "rusvet"
  | "cark"
  | "baskin";
/**
 * none: no target · pick: the flipper picks another player (TARGET_SEC, else random) ·
 * next: automatically the next player in turn order · all: everyone else.
 */
export type TargetRule = "none" | "pick" | "next" | "all";

export interface CardDef {
  id: CardId;
  /** Display name (Turkish). */
  name: string;
  kind: CardKind;
  rarity: Rarity;
  /** Draw weight among non-raid cards (§19). The raid card is drawn by the siren formula instead (weight 0). */
  weight: number;
  /** money: $ added to the pot · aklama: pot multiplier · harac: share of the target's kasa · haracTuru: fee · tuzak: siren level · rusvet: level drop. */
  value: number;
  target: TargetRule;
  /** Feed / UI icon. */
  icon: string;
  /** One-line rule text (Turkish). */
  desc: string;
}

export const CARDS: readonly CardDef[] = [
  { id: "bozukluk", name: "Bozukluk", kind: "money", rarity: "common", weight: 25, value: 10, target: "none", icon: "🪙", desc: "+10$ tur potuna" },
  { id: "tomar", name: "Tomar", kind: "money", rarity: "common", weight: 18, value: 25, target: "none", icon: "💵", desc: "+25$ tur potuna" },
  { id: "canta", name: "Çanta", kind: "money", rarity: "uncommon", weight: 12, value: 50, target: "none", icon: "💼", desc: "+50$ tur potuna" },
  { id: "kulce", name: "Külçe", kind: "money", rarity: "rare", weight: 5, value: 100, target: "none", icon: "💰", desc: "+100$ tur potuna" },
  { id: "aklama", name: "Kara Para Aklama", kind: "multiplier", rarity: "uncommon", weight: 8, value: 2, target: "none", icon: "🧼", desc: "Tur potu ×2" },
  { id: "harac", name: "Haraç", kind: "attack", rarity: "uncommon", weight: 6, value: HARAC_PCT, target: "pick", icon: "💸", desc: "Hedefin kasasının %20'si tur potuna geçer" },
  { id: "haracTuru", name: "Haraç Turu", kind: "attack", rarity: "uncommon", weight: 4, value: HARAC_TURU_FEE, target: "all", icon: "🎩", desc: "Herkes 10$ öder, para tur potuna girer" },
  { id: "tuzak", name: "Tuzak", kind: "attack", rarity: "uncommon", weight: 4, value: TRAP_LEVEL, target: "next", icon: "🪤", desc: "Sıradakinin sireni 2'den başlar" },
  { id: "lanet", name: "Lanet", kind: "attack", rarity: "rare", weight: 3, value: 0, target: "pick", icon: "🧿", desc: "Hedefin sonraki turundaki ilk para kartı 0$" },
  { id: "takas", name: "Takas", kind: "attack", rarity: "legendary", weight: 1, value: 0, target: "pick", icon: "🔄", desc: "Kasan hedefin kasasıyla yer değiştirir" },
  { id: "avukat", name: "Avukat", kind: "protection", rarity: "rare", weight: 4, value: 1, target: "none", icon: "⚖️", desc: "Bu turdaki ilk baskını iptal eder" },
  { id: "rusvet", name: "Rüşvet Zarfı", kind: "protection", rarity: "uncommon", weight: 6, value: BRIBE_ENVELOPE_DROP, target: "none", icon: "✉️", desc: "Siren seviyesi 2 düşer" },
  { id: "cark", name: "Patronun Çarkı", kind: "special", rarity: "legendary", weight: 4, value: 0, target: "none", icon: "🎡", desc: "Patronun Çarkı iner!" },
  { id: "baskin", name: "Polis Baskını", kind: "raid", rarity: "trouble", weight: 0, value: 0, target: "none", icon: "🚨", desc: "Tur potu kumbaraya, kasadan rüşvet" },
];

export const CARD_BY_ID: Record<CardId, CardDef> = Object.fromEntries(CARDS.map((c) => [c.id, c])) as Record<CardId, CardDef>;

// -------------------------------------------------------------------------- wheel
export type WheelSliceId = "kumbara" | "herkese100" | "topluBaskin" | "x10" | "herkeseOde" | "avukat" | "karistir" | "birDaha";
export interface WheelSliceDef {
  id: WheelSliceId;
  /** Big label painted on the wheel. */
  label: string;
  /** Probability weight in percent (§7, sums to 100). Slices are drawn equal-sized on the wheel. */
  weight: number;
  color: string;
  desc: string;
}
/** In wheel order: index 0 is at the top (under the pointer at rest), then clockwise as seen from the front. */
export const WHEEL_SLICES: readonly WheelSliceDef[] = [
  { id: "kumbara", label: "KUMBARAYI PATLAT", weight: 10, color: "#FFC93C", desc: "Kumbaradaki her şey kasana" },
  { id: "herkese100", label: "HERKESE 100$", weight: 15, color: "#7BD389", desc: "Masadaki herkes 100$ alır" },
  { id: "topluBaskin", label: "TOPLU BASKIN", weight: 13, color: "#E5383B", desc: "Herkes kasasının %10'unu kumbaraya öder" },
  { id: "x10", label: "POT ×10", weight: 8, color: "#B05CFF", desc: "Tur potu on katına çıkar" },
  { id: "herkeseOde", label: "HERKESE 50$ ÖDE", weight: 14, color: "#FF8A3D", desc: "Kasandan her oyuncuya 50$" },
  { id: "avukat", label: "BEDAVA AVUKAT", weight: 15, color: "#3FA7FF", desc: "Bu tur ve sonraki turun için avukat" },
  { id: "karistir", label: "KASALARI KARIŞTIR", weight: 10, color: "#FF3C8E", desc: "Bütün kasalar rastgele dağıtılır" },
  { id: "birDaha", label: "BİR DAHA!", weight: 15, color: "#2EC4B6", desc: "Çark tekrar döner" },
];
export const WHEEL_SLICE_BY_ID: Record<WheelSliceId, WheelSliceDef> = Object.fromEntries(
  WHEEL_SLICES.map((s) => [s.id, s]),
) as Record<WheelSliceId, WheelSliceDef>;
/** Wheel payouts. */
export const WHEEL_EVERYONE_GAIN = 100;
export const WHEEL_PAY_EACH = 50;
export const WHEEL_POT_MULT = 10;
export const WHEEL_RAID_PCT = 0.1;

// --------------------------------------------------------------------------- bets
export type BetBox = "b12" | "b34" | "b5p" | "cash";
export interface BetBoxDef {
  id: BetBox;
  /** Short label on the box. */
  label: string;
  /** Long description. */
  desc: string;
  /** Gross payout multiplier on a win (stake already left the kasa when the bet was placed). */
  payout: number;
}
/** In key order: keys 1–4. */
export const BET_BOXES: readonly BetBoxDef[] = [
  { id: "b12", label: "1–2", desc: "1. veya 2. kartta baskın", payout: 4 },
  { id: "b34", label: "3–4", desc: "3. veya 4. kartta baskın", payout: 4 },
  { id: "b5p", label: "5+", desc: "5. kart ve sonrasında baskın", payout: 10 },
  { id: "cash", label: "Kasalar", desc: "Baskın yemeden kasalar", payout: 1.5 },
];
export const BET_BOX_BY_ID: Record<BetBox, BetBoxDef> = Object.fromEntries(BET_BOXES.map((b) => [b.id, b])) as Record<BetBox, BetBoxDef>;

/** How a turn ended, for bets. raidFlip = the flip number (1-based) of the raid that ended the turn (lawyer-cancelled raids don't count). */
export interface TurnOutcome {
  raided: boolean;
  raidFlip: number;
}
export function boxWins(box: BetBox, outcome: TurnOutcome): boolean {
  if (box === "cash") return !outcome.raided;
  if (!outcome.raided) return false;
  if (box === "b12") return outcome.raidFlip <= 2;
  if (box === "b34") return outcome.raidFlip === 3 || outcome.raidFlip === 4;
  return outcome.raidFlip >= 5;
}
/** Can this box still win after `safeFlips` cards were flipped without ending the turn? (HUD dims dead boxes live.) */
export function boxAlive(box: BetBox, safeFlips: number): boolean {
  if (box === "b12") return safeFlips < 2;
  if (box === "b34") return safeFlips < 4;
  return true;
}

// --------------------------------------------------------------------- characters
export type Animal = "kedi" | "kopek" | "domuz" | "fare" | "kurbaga" | "tavsan";
export interface AnimalDef {
  id: Animal;
  label: string;
  /** Main fur / skin color. */
  fur: string;
  /** Secondary color (belly, inner ears, snout). */
  accent: string;
}
export const ANIMALS: readonly AnimalDef[] = [
  { id: "kedi", label: "Kedi", fur: "#F2A65A", accent: "#FFE3C2" },
  { id: "kopek", label: "Köpek", fur: "#B98A5E", accent: "#F1D9BC" },
  { id: "domuz", label: "Domuz", fur: "#F5A3B5", accent: "#FFD0DA" },
  { id: "fare", label: "Fare", fur: "#A9A9B8", accent: "#F4C6D0" },
  { id: "kurbaga", label: "Kurbağa", fur: "#7BC86C", accent: "#D8F0B8" },
  { id: "tavsan", label: "Tavşan", fur: "#F3EDE4", accent: "#FFC9D6" },
];
export const ANIMAL_BY_ID: Record<Animal, AnimalDef> = Object.fromEntries(ANIMALS.map((a) => [a.id, a])) as Record<Animal, AnimalDef>;

/** Player colors (hat band, name plate, chips), index = PlayerView.color (§13). */
export const PLAYER_COLORS = ["#FF5A5F", "#3FA7FF", "#7BE07B", "#FFC23F", "#B07CFF", "#FF8BD1"] as const;
export const PLAYER_COLOR_NAMES = ["Kırmızı", "Mavi", "Yeşil", "Sarı", "Mor", "Pembe"] as const;

export type EmoteId = "puro" | "paraSay" | "yumruk" | "opucuk" | "agla" | "allahAllah";
/** In key order: T + 1–6. */
export const EMOTES: readonly { id: EmoteId; label: string; icon: string }[] = [
  { id: "puro", label: "Puro", icon: "🚬" },
  { id: "paraSay", label: "Para say", icon: "💵" },
  { id: "yumruk", label: "Yumruk", icon: "👊" },
  { id: "opucuk", label: "Öpücük", icon: "😘" },
  { id: "agla", label: "Ağla", icon: "😭" },
  { id: "allahAllah", label: "Allah Allah", icon: "🙌" },
];
/** Speech bubbles, Y + 1–8 (index = TAUNT index). */
export const TAUNTS = [
  "Kasala artık, korkak!",
  "Bu masa bana bakar.",
  "Borcunu unutma kardeşim.",
  "Bir tane daha, bir tane daha!",
  "Hesabını sorarım.",
  "Şans değil, yetenek.",
  "Polis seni sevmiş.",
  "Abi yapma ya…",
] as const;
/**
 * One-tap heckles for players watching someone else's turn (§3 "BİR TANE DAHA ÇEVİR!"): they are sent as
 * TAUNT with these indexes, so the bubble, cooldown and sound are the taunt ones.
 */
export const HECKLE_FLIP_TAUNT = 3;
export const HECKLE_CASH_TAUNT = 0;

// --------------------------------------------------------------------------- bots
/** Bot nicknames (lobby "Bot ekle"); the server picks the first unused one. */
export const BOT_NAMES = [
  "Kambur Necmi", "Tombik Selim", "Sinsi Nuri", "Çakal Cemal", "Kumarbaz Raci", "Pala Hayri", "Fiyakalı Rıza",
] as const;
/** Bots "think" this long (random in range) before each action, so they read like people. */
export const BOT_THINK_MIN_SEC = 0.8;
export const BOT_THINK_MAX_SEC = 2.2;

/** Raid penalty animation, chosen by the server so every client plays the same one (§11). */
export type RaidAnim = "kelepce" | "cuval" | "bosCuzdan" | "sabika";
export const RAID_ANIMS: readonly RaidAnim[] = ["kelepce", "cuval", "bosCuzdan", "sabika"];

/** Shame titles at match end (§16.6). */
export type TitleId = "bombaMiknatisi" | "borcKrali" | "korkak" | "korBahisci" | "karaListe" | "gozuKara";
export const TITLES: readonly { id: TitleId; label: string; desc: string; icon: string }[] = [
  { id: "bombaMiknatisi", label: "Bomba Mıknatısı", desc: "En çok baskın yiyen", icon: "🚨" },
  { id: "borcKrali", label: "Borç Kralı", desc: "En çok borç alan", icon: "📒" },
  { id: "korkak", label: "En Büyük Korkak", desc: "En çok erken kasalayan", icon: "🐔" },
  { id: "korBahisci", label: "Kör Bahisçi", desc: "Bahislerde en çok kaybeden", icon: "🙈" },
  { id: "karaListe", label: "Kara Liste", desc: "Borcunu ödeyemeden kaçan", icon: "⛔" },
  { id: "gozuKara", label: "Gözü Kara", desc: "Tek turda en çok kart çeviren", icon: "🔥" },
];

// -------------------------------------------------------------------------- colors
/** §13 palette. */
export const PALETTE = {
  felt: "#1F6B47",
  feltShadow: "#134A31",
  wall: "#1C1720",
  lamp: "#FFD9A0",
  neonPink: "#FF3C8E",
  siren: "#E5383B",
  police: "#2F6BFF",
  money: "#7BD389",
  gold: "#FFC93C",
  ink: "#241F2B",
  cream: "#FFF4DF",
  wood: "#5A3524",
  woodDark: "#3A2116",
  smoke: "#B9B2C4",
} as const;
