// Small shared UI helpers for every DOM module (Menu, Hud, Overlays, Fx, Game). Complete.
// Turkish formatting rules used everywhere: money is "250$" / "+50$" / "−34$", percentages are "%29",
// uppercase with toLocaleUpperCase("tr") (i → İ). Nicknames are user input: always esc() them.

import { ANIMAL_BY_ID, PLAYER_COLORS, type Animal } from "../../../shared/constants";

/** UI sound cue requested by DOM modules (Game maps them to AudioEngine.sfx). */
export type UiSound = "click" | "hover" | "pop" | "chip" | "deny" | "open" | "close";

export function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** 1250 → "1.250$". With `signed`: "+50$" / "−34$" (true minus sign). */
export function money(n: number, signed = false): string {
  const abs = Math.abs(Math.round(n)).toLocaleString("tr-TR");
  if (!signed) return `${n < 0 ? "−" : ""}${abs}$`;
  return `${n < 0 ? "−" : "+"}${abs}$`;
}

/** 0.29 → "%29". */
export function pct(x: number): string {
  return `%${Math.round(x * 100)}`;
}

export function upperTr(s: string): string {
  return s.toLocaleUpperCase("tr");
}

/** PLAYER_COLORS[i] (falls back to the first color). */
export function playerColor(i: number): string {
  return PLAYER_COLORS[i] ?? PLAYER_COLORS[0];
}

export function animalLabel(a: Animal): string {
  return ANIMAL_BY_ID[a]?.label ?? a;
}

// ---- Turkish case suffixes for nicknames: "Kedi'den", "Deniz'e", "Kurbağa'nın" (vowel harmony + consonant
// assimilation). Good enough for arbitrary nicknames; returns the name with an apostrophe and the suffix.
// A trailing number is inflected the way it is read aloud ("Rakip 2" → "iki" → "Rakip 2'de", "Deniz 3" →
// "üç" → "Deniz 3'te"), since the server's duplicate-name rule makes names like that common.
const BACK = "aıouâû";
const FRONT = "eiöüî";
const HARD = "fstkçşhp";

const ONES = ["sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
const TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];

/** The last word of a number as spoken in Turkish (only its sound matters for the suffix). */
function spokenTail(digits: string): string {
  const trimmed = digits.replace(/^0+(?=\d)/, "");
  if (trimmed.length > 9) return "milyar";
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n === 0) return "sıfır";
  if (n % 10 !== 0) return ONES[n % 10];
  if (n % 100 !== 0) return TENS[(n % 100) / 10];
  if (n % 1000 !== 0) return "yüz";
  if (n % 1_000_000 !== 0) return "bin";
  return "milyon";
}

/** The name as it sounds at its end: a trailing number becomes its spoken last word. */
function sounding(name: string): string {
  const s = name.toLocaleLowerCase("tr").trimEnd();
  const m = /(\d+)[^\p{L}\d]*$/u.exec(s);
  if (!m) return s;
  // "Rakip 2" → "rakip iki"; a number after letters with no space ("Ali2") reads the same way.
  return `${s.slice(0, m.index)} ${spokenTail(m[1])}`;
}

function lastVowel(name: string): string {
  const s = sounding(name);
  for (let i = s.length - 1; i >= 0; i--) if (BACK.includes(s[i]) || FRONT.includes(s[i])) return s[i];
  return "e";
}
function lastLetter(name: string): string {
  const s = sounding(name).replace(/[^a-zçğıöşüâîû]/g, "");
  return s[s.length - 1] ?? "e";
}
const isVowel = (c: string) => BACK.includes(c) || FRONT.includes(c);

/** Ablative (-den/-dan/-ten/-tan): "Kedi'den kesti". */
export function fromName(name: string): string {
  const v = lastVowel(name);
  const c = lastLetter(name);
  const d = HARD.includes(c) ? "t" : "d";
  return `${name}'${d}${BACK.includes(v) ? "a" : "e"}n`;
}
/** Locative (-de/-da/-te/-ta): "Sıra Kedi'de", "Sıra Rakip 2'de". */
export function atName(name: string): string {
  return fromName(name).slice(0, -1);
}
/** Dative (-e/-a/-ye/-ya): "Fare'ye verdi". */
export function toName(name: string): string {
  const v = lastVowel(name);
  const c = lastLetter(name);
  const a = BACK.includes(v) ? "a" : "e";
  return `${name}'${isVowel(c) ? "y" : ""}${a}`;
}
/** Genitive (-in/-ın/-un/-ün, -nin…): "Kurbağa'nın kasası". */
export function ofName(name: string): string {
  const v = lastVowel(name);
  const c = lastLetter(name);
  const i = "aıâ".includes(v) ? "ı" : "eiî".includes(v) ? "i" : "ouû".includes(v) ? "u" : "ü";
  return `${name}'${isVowel(c) ? "n" : ""}${i}n`;
}
/** Accusative (-i/-ı/-u/-ü, -yi…): "Kedi'yi kurtardı". */
export function accName(name: string): string {
  const v = lastVowel(name);
  const c = lastLetter(name);
  const i = "aıâ".includes(v) ? "ı" : "eiî".includes(v) ? "i" : "ouû".includes(v) ? "u" : "ü";
  return `${name}'${isVowel(c) ? "y" : ""}${i}`;
}

/** Creates an element with a class and optional innerHTML (trusted / pre-escaped HTML only). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", html = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}
