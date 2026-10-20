// Gangster animal heads as inline SVG (viewBox 0 0 120 120): kedi, köpek, domuz, fare, kurbağa, tavşan, each
// in a fedora tinted with the player color (band in ink, a little feather). Flat cartoon style with thick ink
// outlines, no ids / gradients so any number of copies can live on one page. Static markup only (no user text).
// Moods: "smug" (half-lidded, smirk) and "glad" (eyes wide open, grin — used for ready players).

import { ANIMAL_BY_ID, type Animal } from "../../../../shared/constants";

const INK = "#241f2b";
const GOLD = "#FFC93C";
const NOSE = "#FF8FA3";
const BLUSH = "rgba(255,95,125,.32)";

export type Mood = "smug" | "glad";

/** Mixes a #rrggbb color toward white (amt > 0) or ink (amt < 0). */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const t = amt >= 0 ? [255, 255, 255] : [0x24, 0x1f, 0x2b];
  const a = Math.min(1, Math.abs(amt));
  const out = c.map((v, i) => Math.round(v + (t[i]! - v) * a));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const svg = (body: string, cls = "ks-menu-svg") =>
  `<svg class="${cls}" viewBox="0 0 120 120" aria-hidden="true" focusable="false">${body}</svg>`;

/** The fedora, sitting on the head with a gangster tilt. */
function fedora(color: string): string {
  const brim = shade(color, -0.24);
  const crease = shade(color, -0.34);
  const feather = shade(color, 0.5);
  return (
    `<g transform="rotate(-7 60 47)" stroke="${INK}" stroke-linejoin="round" stroke-linecap="round">` +
    `<ellipse cx="60" cy="47" rx="47" ry="8.5" fill="${brim}" stroke-width="3.5"/>` +
    `<path d="M30 47C29 33 31 20 41 15Q51 11 60 19Q69 11 79 15C89 20 91 33 90 47Z" fill="${color}" stroke-width="3.5"/>` +
    `<path d="M60 21V31" stroke="${crease}" stroke-width="2.5" fill="none"/>` +
    `<path d="M31 37Q60 41 89 37L89.6 46Q60 50 30.4 46Z" fill="${INK}" stroke-width="2"/>` +
    `<path d="M80 40Q86 31 93 26Q90 35 85 41Z" fill="${feather}" stroke-width="2"/>` +
    `<path d="M36 41C35 32 37 24 43 19" fill="none" stroke="#fff" stroke-opacity=".38" stroke-width="3"/>` +
    `</g>`
  );
}

/** Soft brim shadow across the forehead. */
const brimShadow = (rx = 30) => `<ellipse cx="60" cy="55.5" rx="${rx}" ry="4.5" fill="${INK}" opacity=".22"/>`;

/** One eye: half-lidded (smug) or wide open (glad). `lid` is the fur color the lid is painted with. */
function eye(x: number, y: number, r: number, lid: string, mood: Mood, look = 1.5): string {
  let s =
    `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 1.06}" fill="#fff" stroke="${INK}" stroke-width="3"/>` +
    `<circle cx="${x + look}" cy="${y + (mood === "smug" ? 2 : 0.8)}" r="${r * 0.5}" fill="${INK}"/>` +
    `<circle cx="${x + look - 1.2}" cy="${y + (mood === "smug" ? 0.6 : -0.8)}" r="${r * 0.17}" fill="#fff"/>`;
  if (mood === "smug") {
    s +=
      `<path d="M${x - r - 2} ${y - 0.4}Q${x} ${y - r * 0.95} ${x + r + 2} ${y - 0.4}L${x + r + 2} ${y - r - 3}L${x - r - 2} ${y - r - 3}Z" fill="${lid}"/>` +
      `<path d="M${x - r - 0.5} ${y}Q${x} ${y - r * 0.8} ${x + r + 0.5} ${y}" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`;
  }
  return s;
}

const eyes = (lx: number, rx: number, y: number, r: number, lid: string, mood: Mood) =>
  eye(lx, y, r, lid, mood) + eye(rx, y, r, lid, mood);

const line = (d: string, w = 2.5, color = INK) =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

const blush = (lx: number, rx: number, y: number) =>
  `<ellipse cx="${lx}" cy="${y}" rx="7" ry="4" fill="${BLUSH}"/><ellipse cx="${rx}" cy="${y}" rx="7" ry="4" fill="${BLUSH}"/>`;

// --------------------------------------------------------------------------- animals
type Parts = { back: string; head: string; face: string };

function kedi(fur: string, acc: string, mood: Mood): Parts {
  const back =
    `<path d="M36 60L16 29L52 45Z" fill="${fur}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>` +
    `<path d="M35 53L23 35L45 46Z" fill="${acc}"/>` +
    `<path d="M84 60L104 29L68 45Z" fill="${fur}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>` +
    `<path d="M85 53L97 35L75 46Z" fill="${acc}"/>`;
  const head =
    `<ellipse cx="60" cy="74" rx="36" ry="32" fill="${fur}" stroke="${INK}" stroke-width="3.5"/>` +
    line("M27 74L33 72M27 80L33 79", 2.5, shade(fur, -0.3)) +
    line("M93 74L87 72M93 80L87 79", 2.5, shade(fur, -0.3)) +
    `<ellipse cx="52.5" cy="85" rx="9.5" ry="7.5" fill="${acc}"/><ellipse cx="67.5" cy="85" rx="9.5" ry="7.5" fill="${acc}"/>`;
  const mouth =
    mood === "glad"
      ? `<path d="M51 85Q60 97 69 85Z" fill="#7a2f3c" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>`
      : line("M60 83Q60 88 53 89M60 83Q63 89 70 86");
  const face =
    brimShadow() +
    eyes(47, 73, 66, 7, fur, mood) +
    `<path d="M55.5 78H64.5L60 83Z" fill="${NOSE}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>` +
    mouth +
    line("M42 83L22 79M42 88L23 91M78 83L98 79M78 88L97 91", 2) +
    (mood === "smug" ? line("M69 88L86 97", 5) + line("M69 88L86 97", 2.4, "#E8C07A") : "");
  return { back, head, face };
}

function kopek(fur: string, acc: string, mood: Mood): Parts {
  const ear = shade(fur, -0.3);
  const head =
    `<ellipse cx="60" cy="73" rx="32" ry="32" fill="${fur}" stroke="${INK}" stroke-width="3.5"/>` +
    `<path d="M32 50Q13 55 15 80Q17 94 29 89Q35 74 40 55Z" fill="${ear}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>` +
    `<path d="M88 50Q107 55 105 80Q103 94 91 89Q85 74 80 55Z" fill="${ear}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>` +
    `<ellipse cx="60" cy="87" rx="17.5" ry="12.5" fill="${acc}" stroke="${INK}" stroke-width="3"/>`;
  const mouth =
    mood === "glad"
      ? `<path d="M48 89Q60 103 72 89Z" fill="#7a2f3c" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>` +
        `<path d="M55 95Q60 99 65 95Q62 91 58 91Z" fill="#FF7F95"/>`
      : `<path d="M50 89Q60 98 70 89Z" fill="#7a2f3c" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>` +
        `<rect x="61.5" y="89.5" width="4.5" height="4" rx="1" fill="${GOLD}" stroke="${INK}" stroke-width="1.4"/>`;
  const face =
    brimShadow(28) +
    eyes(48, 72, 66, 6.5, fur, mood) +
    line("M40 57L53 59M80 57L67 59", 3.2, shade(fur, -0.45)) +
    `<ellipse cx="60" cy="81" rx="7.5" ry="5.2" fill="${INK}"/><ellipse cx="57.5" cy="79.5" rx="2.2" ry="1.3" fill="#fff" opacity=".7"/>` +
    line("M60 86V89") +
    mouth;
  return { back: "", head, face };
}

function domuz(fur: string, acc: string, mood: Mood): Parts {
  const head =
    `<ellipse cx="60" cy="74" rx="35" ry="31" fill="${fur}" stroke="${INK}" stroke-width="3.5"/>` +
    `<path d="M30 53Q12 50 15 66Q26 67 38 59Z" fill="${fur}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` +
    `<path d="M29 56Q19 55 20 63Q27 63 34 59Z" fill="${acc}"/>` +
    `<path d="M90 53Q108 50 105 66Q94 67 82 59Z" fill="${fur}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` +
    `<path d="M91 56Q101 55 100 63Q93 63 86 59Z" fill="${acc}"/>` +
    blush(36, 84, 82);
  const mouth = mood === "glad" ? `<path d="M50 92Q60 101 70 92Z" fill="#7a2f3c" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>` : line("M51 94Q60 97 69 92");
  const face =
    brimShadow() +
    eyes(47, 73, 65, 6.5, fur, mood) +
    `<ellipse cx="60" cy="82" rx="13.5" ry="9.5" fill="${acc}" stroke="${INK}" stroke-width="3"/>` +
    `<ellipse cx="55.3" cy="82" rx="2.4" ry="3.8" fill="${INK}" opacity=".8"/><ellipse cx="64.7" cy="82" rx="2.4" ry="3.8" fill="${INK}" opacity=".8"/>` +
    mouth +
    `<circle cx="73" cy="65" r="10.5" fill="none" stroke="${INK}" stroke-width="5.5"/>` +
    `<circle cx="73" cy="65" r="10.5" fill="#fff" fill-opacity=".14" stroke="${GOLD}" stroke-width="2.8"/>` +
    line("M82 71Q91 86 85 103", 2, GOLD);
  return { back: "", head, face };
}

function fare(fur: string, acc: string, mood: Mood): Parts {
  const back =
    `<circle cx="21" cy="55" r="17" fill="${fur}" stroke="${INK}" stroke-width="3.5"/><circle cx="22" cy="56" r="10.5" fill="${acc}"/>` +
    `<circle cx="99" cy="55" r="17" fill="${fur}" stroke="${INK}" stroke-width="3.5"/><circle cx="98" cy="56" r="10.5" fill="${acc}"/>`;
  const head =
    `<path d="M60 106C48 106 28 90 28 72C28 52 43 42 60 42C77 42 92 52 92 72C92 90 72 106 60 106Z" fill="${fur}" stroke="${INK}" stroke-width="3.5"/>` +
    `<ellipse cx="60" cy="89" rx="14" ry="10.5" fill="${shade(fur, 0.45)}"/>`;
  const smoke = line("M93 89Q88 81 94 75Q100 69 95 61", 2.6, "rgba(220,214,232,.75)");
  const face =
    brimShadow(29) +
    eyes(48, 72, 67, 6, fur, mood) +
    `<circle cx="60" cy="83" r="4.6" fill="${NOSE}" stroke="${INK}" stroke-width="2"/>` +
    `<path d="M56.5 90H63.5V96.5H56.5Z" fill="#fff" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>` +
    line("M60 90V96.5", 1.6) +
    line("M44 84L22 80M44 89L23 93M76 84L98 80M76 89L97 93", 1.8) +
    (mood === "smug"
      ? `<g transform="rotate(14 66 92)"><rect x="65" y="89" width="22" height="6.5" rx="2" fill="#8B5A2B" stroke="${INK}" stroke-width="2"/>` +
        `<rect x="83" y="89" width="4" height="6.5" fill="#FF7A3D"/><path d="M71 89V95.5" stroke="${GOLD}" stroke-width="2.4"/></g>` +
        smoke
      : line("M51 92Q60 100 69 92", 2.5));
  return { back, head, face };
}

function kurbaga(fur: string, acc: string, mood: Mood): Parts {
  const head =
    `<ellipse cx="60" cy="79" rx="42" ry="27" fill="${fur}" stroke="${INK}" stroke-width="3.5"/>` +
    `<circle cx="35" cy="60" r="14" fill="${fur}" stroke="${INK}" stroke-width="3.5"/>` +
    `<circle cx="85" cy="60" r="14" fill="${fur}" stroke="${INK}" stroke-width="3.5"/>` +
    `<path d="M24 66Q60 76 96 66" fill="none" stroke="${fur}" stroke-width="9"/>` +
    `<ellipse cx="60" cy="95" rx="24" ry="8" fill="${acc}" opacity=".9"/>` +
    blush(30, 90, 84);
  const mouth =
    mood === "glad"
      ? `<path d="M30 82Q60 106 90 82Q60 92 30 82Z" fill="#7a2f3c" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`
      : line("M29 82Q58 98 91 80", 3) + `<path d="M83 86Q91 91 87 97Q81 93 83 86Z" fill="${NOSE}" stroke="${INK}" stroke-width="2"/>`;
  const face =
    eye(35, 62, 8.5, fur, mood, 1) +
    eye(85, 62, 8.5, fur, mood, 1) +
    `<circle cx="55" cy="75" r="1.7" fill="${INK}"/><circle cx="65" cy="75" r="1.7" fill="${INK}"/>` +
    mouth;
  return { back: "", head, face };
}

function tavsan(fur: string, acc: string, mood: Mood): Parts {
  // Long ears poke out through the hat; the whole rabbit is drawn a bit smaller (see animalPortrait).
  const back =
    `<g transform="rotate(-16 49 52)"><path d="M43 53C32 30 29 -4 40 -10C51 -14 58 14 55 53Z" fill="${fur}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>` +
    `<path d="M45 45C37 27 35 2 41 -3C47 -6 52 18 50 45Z" fill="${acc}"/></g>` +
    `<g transform="rotate(20 71 52)"><path d="M77 53C88 30 91 -4 80 -10C69 -14 62 14 65 53Z" fill="${fur}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>` +
    `<path d="M75 45C83 27 85 2 79 -3C73 -6 68 18 70 45Z" fill="${acc}"/></g>`;
  const head =
    `<ellipse cx="60" cy="74" rx="33" ry="31" fill="${fur}" stroke="${INK}" stroke-width="3.5"/>` +
    `<ellipse cx="53.5" cy="85" rx="8.5" ry="6.5" fill="#fff"/><ellipse cx="66.5" cy="85" rx="8.5" ry="6.5" fill="#fff"/>` +
    blush(37, 83, 80);
  const face =
    brimShadow(28) +
    eyes(48, 72, 66, 6.5, fur, mood) +
    line("M39 56L51 76", 2.6, "#D97E86") +
    line("M42 63L46 61M44 68L48 66", 2, "#D97E86") +
    `<path d="M56 79Q60 76 64 79Q60 84 56 79Z" fill="${NOSE}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>` +
    `<path d="M55.8 88H64.2V95.5H55.8Z" fill="#fff" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>` +
    line("M60 88V95.5", 1.6) +
    (mood === "glad" ? line("M47 86Q60 92 73 86", 2.5) : line("M51 86Q56 88 60 86Q64 88 69 85", 2.5));
  return { back, head, face };
}

const BUILDERS: Record<Animal, (fur: string, acc: string, mood: Mood) => Parts> = {
  kedi,
  kopek,
  domuz,
  fare,
  kurbaga,
  tavsan,
};

const cache = new Map<string, string>();

/** Full portrait markup for an animal in a fedora of `color` (#rrggbb). Cached per (animal, color, mood). */
export function animalPortrait(animal: Animal, color: string, mood: Mood = "smug"): string {
  const key = `${animal}|${color}|${mood}`;
  let out = cache.get(key);
  if (!out) {
    const def = ANIMAL_BY_ID[animal] ?? ANIMAL_BY_ID.kedi;
    const p = (BUILDERS[animal] ?? kedi)(def.fur, def.accent, mood);
    const body = p.back + p.head + fedora(color) + p.face;
    out = svg(animal === "tavsan" ? `<g transform="translate(6 12) scale(.9)">${body}</g>` : body);
    cache.set(key, out);
  }
  return out;
}

/** An empty seat: a shady silhouette in a dark fedora with a question mark. */
export function emptyPortrait(): string {
  return svg(
    `<ellipse cx="60" cy="74" rx="33" ry="31" fill="#fff" fill-opacity=".06" stroke="currentColor" stroke-width="3" stroke-dasharray="7 6"/>` +
      `<g opacity=".55">${fedora("#5b5163")}</g>` +
      `<text x="60" y="94" text-anchor="middle" font-size="34" font-weight="700" fill="currentColor" font-family="Fredoka, system-ui, sans-serif">?</text>`,
  );
}

/** Just the fedora (color swatches). */
export function fedoraIcon(color: string): string {
  return `<svg class="ks-menu-svg" viewBox="10 6 100 54" aria-hidden="true" focusable="false">${fedora(color)}</svg>`;
}

/** Cemil Abi, the old crocodile croupier, in profile facing right: long toothy snout (one gold tooth), half-lidded
 * eye under a dark fedora, cigar. */
export function cemilPortrait(): string {
  const skin = "#5E9B4F";
  const dark = shade(skin, -0.3);
  const belly = "#C9DFA0";
  return svg(
    `<path d="M22 78C18 58 30 42 50 42C60 42 66 48 68 54L104 60Q116 63 113 72Q111 77 102 78L58 82Q40 98 26 92Z" fill="${skin}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>` +
      `<path d="M50 84L100 80Q108 81 106 88Q103 94 92 95L56 98Q40 100 34 92Z" fill="${belly}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>` +
      `<path d="M62 81L65 87L68 80.6M72 80.3L75 86L78 79.9M82 79.6L85 85L88 79.2M92 78.8L95 84L98 78.4" fill="#fff" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>` +
      `<path d="M66 95L69 89.5L72 94.6M86 93.5L89 88.6L92 93" fill="#fff" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>` +
      `<path d="M76 94L79 88.8L82 93.8Z" fill="${GOLD}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>` +
      `<circle cx="105" cy="62" r="5" fill="${skin}" stroke="${INK}" stroke-width="3"/><ellipse cx="106" cy="61" rx="1.6" ry="1.2" fill="${INK}"/>` +
      `<g fill="${dark}"><circle cx="78" cy="66" r="2"/><circle cx="88" cy="68" r="1.6"/><circle cx="70" cy="70" r="1.6"/><circle cx="34" cy="70" r="2.2"/><circle cx="28" cy="80" r="1.8"/></g>` +
      `<g transform="translate(13 9) scale(.62)">${fedora("#54485f")}</g>` +
      `<circle cx="54" cy="50" r="10" fill="${skin}" stroke="${INK}" stroke-width="3.5"/>` +
      eye(55, 52, 6, skin, "smug", 2) +
      `<g transform="rotate(16 44 88)"><rect x="22" y="85" width="24" height="7" rx="2" fill="#8B5A2B" stroke="${INK}" stroke-width="2"/>` +
      `<rect x="22" y="85" width="4" height="7" fill="#FF7A3D"/><path d="M38 85V92" stroke="${GOLD}" stroke-width="2.4"/></g>` +
      line("M18 84Q12 76 17 68Q22 60 16 52", 2.6, "rgba(220,214,232,.7)"),
  );
}
