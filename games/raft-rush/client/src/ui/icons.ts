// Inline SVG icons and the six tourist portraits (static, trusted markup). Owner: client-ui.
// Adapted from games/bonk-brawl/client/src/ui/icons.ts. Colors come from the palette / CSS custom properties
// (currentColor, --slot) so one icon serves every player color. Bar icons sit next to the bar colors so the
// HUD never relies on color alone (§17 accessibility).

import { CHARACTERS, PALETTE } from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";

const INK = PALETTE.ink;

/* ================================================================ bars */

const HEART_PATH = "M50 88C20 68 5 50 5 30 5 14 17 4 31 4c9 0 15 5 19 12 4-7 10-12 19-12 14 0 26 10 26 26 0 20-15 38-45 58Z";

/** Health (red heart). */
export const ICON_HEART = `
<svg viewBox="0 0 100 92" class="rr-i rr-i--heart">
  <path d="${HEART_PATH}" fill="#FF5A5F" stroke="${INK}" stroke-width="8" stroke-linejoin="round"/>
  <ellipse cx="29" cy="27" rx="10" ry="6.5" transform="rotate(-32 29 27)" fill="#fff" opacity="0.85"/>
</svg>`;

/** Hunger (a cartoon drumstick). */
export const ICON_HUNGER = `
<svg viewBox="0 0 100 100" class="rr-i rr-i--hunger">
  <path d="M62 64 80 82" stroke="${INK}" stroke-width="20" stroke-linecap="round"/>
  <path d="M62 64 80 82" stroke="#FFF4DC" stroke-width="10" stroke-linecap="round"/>
  <circle cx="84" cy="76" r="9" fill="#FFF4DC" stroke="${INK}" stroke-width="6"/>
  <circle cx="76" cy="88" r="9" fill="#FFF4DC" stroke="${INK}" stroke-width="6"/>
  <path d="M40 8c20 0 34 14 34 32 0 14-8 22-16 26-10 5-20 2-28-6S16 44 16 34C16 18 26 8 40 8Z" fill="#E0874A" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
  <path d="M30 22c6-6 16-7 22-3" fill="none" stroke="#FFC79A" stroke-width="6" stroke-linecap="round"/>
</svg>`;

/** Thirst (a water drop). */
export const ICON_THIRST = `
<svg viewBox="0 0 100 100" class="rr-i rr-i--thirst">
  <path d="M50 6C38 26 18 44 18 64c0 18 14 30 32 30s32-12 32-30C82 44 62 26 50 6Z" fill="#3FB7D9" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
  <path d="M34 62c0 10 6 16 14 18" fill="none" stroke="#C9F1FF" stroke-width="7" stroke-linecap="round"/>
</svg>`;

/** Warmth / fire (a flame). */
export const ICON_FLAME = `
<svg viewBox="0 0 100 100" class="rr-i rr-i--flame">
  <path d="M52 4c4 18 26 28 26 54 0 20-14 36-30 36S20 80 20 62c0-14 8-22 14-28 0 10 4 16 10 18-2-18 2-34 8-48Z" fill="#FF9A3C" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
  <path d="M50 52c6 8 14 12 14 22 0 9-7 14-14 14s-13-5-13-13c0-6 4-10 7-13 1 5 3 7 6 8 0-6-1-12 0-18Z" fill="#FFD166"/>
</svg>`;

/* ============================================================== sky / day */

export const ICON_SUN = `
<svg viewBox="0 0 100 100" class="rr-i rr-i--sun">
  <g stroke="${INK}" stroke-width="7" stroke-linecap="round">
    <path d="M50 4v12M50 84v12M4 50h12M84 50h12M17 17l9 9M74 74l9 9M17 83l9-9M74 26l9-9"/>
  </g>
  <circle cx="50" cy="50" r="24" fill="#FFD166" stroke="${INK}" stroke-width="7"/>
  <ellipse cx="42" cy="42" rx="7" ry="4.5" transform="rotate(-35 42 42)" fill="#fff" opacity="0.8"/>
</svg>`;

export const ICON_MOON = `
<svg viewBox="0 0 100 100" class="rr-i rr-i--moon">
  <path d="M62 8a40 40 0 1 0 30 58A34 34 0 0 1 62 8Z" fill="#FFF4DC" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
  <circle cx="40" cy="58" r="6" fill="#E6D7A8"/><circle cx="54" cy="76" r="4" fill="#E6D7A8"/>
</svg>`;

export const ICON_STORM = `
<svg viewBox="0 0 100 100" class="rr-i rr-i--storm">
  <path d="M26 62c-12 0-20-8-20-18s8-18 19-18c3-12 13-20 26-20 15 0 26 10 28 24 9 1 15 8 15 16 0 9-7 16-17 16Z" fill="#6B7A99" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
  <path d="M50 56 38 78h12l-6 18 20-26H52l8-14Z" fill="#FFD166" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
</svg>`;

/* ================================================================== raft */

export const ICON_RAFT = `
<svg viewBox="0 0 100 100" class="rr-i rr-i--raft">
  <path d="M50 10v58" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>
  <path d="M54 14c18 8 26 22 26 40H54Z" fill="#FFF4DC" stroke="${INK}" stroke-width="6" stroke-linejoin="round"/>
  <g stroke="${INK}" stroke-width="6">
    <rect x="10" y="66" width="80" height="11" rx="5.5" fill="#B07A45"/>
    <rect x="14" y="76" width="72" height="11" rx="5.5" fill="#C98E55"/>
  </g>
  <path d="M4 92c8-4 14-4 22 0s14 4 22 0 14-4 22 0 14 4 26 0" fill="none" stroke="#3FB7D9" stroke-width="6" stroke-linecap="round"/>
</svg>`;

/* =============================================================== generic */

export const ICON_CROWN = `
<svg viewBox="0 0 64 50" class="rr-i rr-i--crown">
  <path d="M7 42 4 12l15 13L32 5l13 20 15-13-3 30Z" fill="#FFD166" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M8 40h48" stroke="${INK}" stroke-width="4"/>
  <circle cx="32" cy="31" r="4.5" fill="#FF5A5F" stroke="${INK}" stroke-width="3"/>
</svg>`;

export const ICON_CHECK = `
<svg viewBox="0 0 24 24" class="rr-i rr-i--check"><path d="m4 12.5 5 5L20 6" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const ICON_CLOSE = `
<svg viewBox="0 0 24 24" class="rr-i rr-i--close"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/></svg>`;

export const ICON_PLUS = `
<svg viewBox="0 0 24 24" class="rr-i rr-i--plus"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round"/></svg>`;

export const ICON_BACK = `
<svg viewBox="0 0 24 24" class="rr-i rr-i--back"><path d="M20 12H5m6-7-7 7 7 7" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const ICON_LINK = `
<svg viewBox="0 0 24 24" class="rr-i rr-i--link"><g fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4l-1.1 1.1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.1-1.1"/></g></svg>`;

export const ICON_GEAR = `
<svg viewBox="0 0 24 24" class="rr-i rr-i--gear"><g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"><path d="M12 2.8l1.6 2.3 2.7-.6.6 2.7 2.3 1.6-1.2 2.5 1.2 2.5-2.3 1.6-.6 2.7-2.7-.6L12 21.2l-1.6-2.3-2.7.6-.6-2.7-2.3-1.6L6 12.7 4.8 10.2l2.3-1.6.6-2.7 2.7.6Z"/><circle cx="12" cy="12" r="3.2"/></g></svg>`;

export const ICON_LOCK = `
<svg viewBox="0 0 24 24" class="rr-i rr-i--lock"><g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></g></svg>`;

export const ICON_SIGNAL = `
<svg viewBox="0 0 24 24" class="rr-i rr-i--signal"><g fill="currentColor"><rect x="3" y="15" width="4" height="6" rx="1.2"/><rect x="10" y="10" width="4" height="11" rx="1.2" class="rr-i-signal__mid"/><rect x="17" y="4" width="4" height="17" rx="1.2" class="rr-i-signal__top"/></g></svg>`;

export const ICON_MOUSE = `
<svg viewBox="0 0 24 24" class="rr-i rr-i--mouse"><g fill="none" stroke="currentColor" stroke-width="2.4"><rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v7M6 10h12" stroke-linecap="round"/></g><path d="M12 3a6 6 0 0 0-6 6v1h6Z" fill="#FFD166" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>`;

export const ICON_DICE = `
<svg viewBox="0 0 24 24" class="rr-i rr-i--dice"><rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="#FFF4DC" stroke="currentColor" stroke-width="2.6"/><g fill="currentColor"><circle cx="8.5" cy="8.5" r="1.7"/><circle cx="15.5" cy="15.5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="15.5" cy="8.5" r="1.7"/><circle cx="8.5" cy="15.5" r="1.7"/></g></svg>`;

export const ICON_SOUND = `
<svg viewBox="0 0 24 24" class="rr-i rr-i--sound"><path d="M4 9h4l5-4v14l-5-4H4Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;

export const ICON_MUTE = `
<svg viewBox="0 0 24 24" class="rr-i rr-i--mute"><path d="M4 9h4l5-4v14l-5-4H4Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="m16 9 6 6m0-6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;

export const ICON_BOT = `
<svg viewBox="0 0 24 24" class="rr-i rr-i--bot"><g stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M12 3v3" stroke-linecap="round"/><circle cx="12" cy="2.6" r="1.4" fill="currentColor"/><rect x="4" y="6.5" width="16" height="12" rx="4" fill="#C9F1FF"/></g><g fill="currentColor"><circle cx="9" cy="12" r="1.8"/><circle cx="15" cy="12" r="1.8"/><rect x="9" y="15.3" width="6" height="1.6" rx=".8"/></g></svg>`;

/* ============================================================ portraits */

/** Accessory layers per tourist, drawn over the shared bean head (viewBox 0 0 100 100, head center 50,48). */
function portraitParts(id: CharacterId): { back: string; hair: string; front: string; body: string } {
  const c = CHARACTERS[id].colors;
  switch (id) {
    case "kaptan":
      return {
        back: "",
        body: `<path d="M38 74 50 86 62 74" fill="none" stroke="${c.accent}" stroke-width="5" stroke-linejoin="round"/><circle cx="50" cy="94" r="2.6" fill="#FFD166" stroke="${INK}" stroke-width="1.5"/>`,
        hair: `<path d="M27 50c-3-4-3-10 0-13M73 50c3-4 3-10 0-13" stroke="${c.hair}" stroke-width="6" stroke-linecap="round"/>`,
        front: `<path d="M22 28c4-14 52-14 56 0l-2 6H24Z" fill="#FFFFFF" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
          <path d="M20 34h60l-3 6H23Z" fill="${c.accent}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
          <path d="M24 40c8 4 44 4 52 0" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>
          <circle cx="50" cy="28" r="5" fill="#FFD166" stroke="${INK}" stroke-width="2.5"/>
          <path d="M60 66h12v-5" fill="none" stroke="#6B4226" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          <rect x="68" y="55" width="8" height="7" rx="2" fill="#8A5A36" stroke="${INK}" stroke-width="2.5"/>`,
      };
    case "fenomen":
      return {
        back: `<circle cx="50" cy="46" r="38" fill="none" stroke="#FFFFFF" stroke-width="5" opacity="0.9"/><circle cx="50" cy="46" r="38" fill="none" stroke="${c.accent}" stroke-width="2" stroke-dasharray="3 5"/>`,
        body: `<path d="M44 76h12" stroke="${c.accent}" stroke-width="4" stroke-linecap="round"/>`,
        hair: `<path d="M24 52c-4-22 8-36 26-36s30 14 26 36c-2-10-6-16-10-18-8 4-24 4-32 0-4 2-8 8-10 18Z" fill="${c.hair}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
          <path d="M24 52c-2 8 0 16 4 20M76 52c2 8 0 16-4 20" fill="none" stroke="${c.hair}" stroke-width="7" stroke-linecap="round"/>`,
        front: `<g stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"><path d="M29 44h17l-2 9c-1 3-3 4-6 4h-4c-3 0-5-2-5-5Z" fill="${c.accent}"/><path d="M54 44h17l-1 8c0 3-2 5-5 5h-4c-3 0-5-1-6-4Z" fill="${c.accent}"/><path d="M46 46h8" fill="none"/></g>
          <path d="M33 47l5-1M58 47l5-1" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>`,
      };
    case "amca":
      return {
        back: "",
        body: `<g fill="${c.accent}" stroke="${INK}" stroke-width="1.5"><circle cx="34" cy="86" r="4"/><circle cx="64" cy="90" r="4"/><circle cx="48" cy="96" r="3.5"/></g><path d="M40 74 50 82 60 74" fill="#FFF4DC" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`,
        hair: `<path d="M25 48c-4-6-2-14 4-16M75 48c4-6 2-14-4-16" stroke="${c.hair}" stroke-width="8" stroke-linecap="round"/>`,
        front: `<path d="M38 62c4-4 8-4 12-1 4-3 8-3 12 1-4 4-8 4-12 1-4 3-8 3-12-1Z" fill="${c.hair}" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>
          <path d="M36 37c4-3 9-3 12 0M52 37c4-3 9-3 12 0" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`,
      };
    case "gelin":
      return {
        back: `<path d="M20 34c0-20 60-20 60 0l8 64H12Z" fill="#FFFFFF" opacity="0.88" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`,
        body: `<path d="M40 76c3 3 17 3 20 0" fill="none" stroke="${c.accent}" stroke-width="4" stroke-linecap="round"/>`,
        hair: `<path d="M25 46c-2-18 10-28 25-28s27 10 25 28c-6-8-14-12-25-12s-19 4-25 12Z" fill="${c.hair}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
          <g fill="#FFD1DC" stroke="${INK}" stroke-width="2"><circle cx="30" cy="30" r="4"/><circle cx="38" cy="24" r="4"/><circle cx="46" cy="21" r="4"/></g>`,
        front: `<rect x="28" y="38" width="44" height="16" rx="7" fill="${c.accent}" fill-opacity="0.55" stroke="${INK}" stroke-width="3.5"/>
          <path d="M72 46h6v-26" fill="none" stroke="#FF9A3C" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M34 42l6-2" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>`,
      };
    case "sef":
      return {
        back: "",
        body: `<path d="M38 74c4 6 20 6 24 0l-4 10h-16Z" fill="${c.accent}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`,
        hair: "",
        front: `<path d="M30 30c-10-2-12-16-2-20 4-8 16-8 22-2 6-6 18-6 22 2 10 4 8 18-2 20v6H30Z" fill="#FFFFFF" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
          <path d="M30 32h40" stroke="${INK}" stroke-width="3"/>
          <path d="M37 61c4-3 8-3 13 0 5-3 9-3 13 0-3 5-9 5-13 2-4 3-10 3-13-2Z" fill="${c.hair}" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>`,
      };
    case "cocuk":
      return {
        back: `<circle cx="14" cy="88" r="11" fill="${c.accent}" stroke="${INK}" stroke-width="3.5"/><circle cx="86" cy="88" r="11" fill="${c.accent}" stroke="${INK}" stroke-width="3.5"/>`,
        body: `<path d="M8 88h12M80 88h12" stroke="#FFF4DC" stroke-width="3" stroke-linecap="round"/>`,
        hair: `<path d="M27 38c0-14 10-22 23-22s23 8 23 22c-4-4-8-6-12-5l2-6-7 4-6-7-4 7-6-5v6c-5-1-9 2-13 6Z" fill="${c.hair}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>`,
        front: `<g fill="#C9853F" opacity="0.8"><circle cx="35" cy="56" r="1.6"/><circle cx="39" cy="59" r="1.6"/><circle cx="61" cy="59" r="1.6"/><circle cx="65" cy="56" r="1.6"/></g>
          <path d="M70 20c4-6 12-6 14 0 2 5-2 9-6 9h-6c-4 0-6-5-2-9Z" fill="#FFD166" stroke="${INK}" stroke-width="3"/><path d="M83 23l5 1-4 2" fill="#FF7A3D" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><circle cx="78" cy="22" r="1.4" fill="${INK}"/>`,
      };
  }
}

/** A cartoon bean-tourist head-and-shoulders portrait (fallback when Characters.portrait() hasn't rendered). */
export function portraitSvg(id: CharacterId): string {
  const def = CHARACTERS[id];
  const c = def.colors;
  const p = portraitParts(id);
  const grin = id === "cocuk" || id === "fenomen";
  const mouth = grin
    ? `<path d="M40 63c4 6 16 6 20 0Z" fill="#7A2E2E" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`
    : `<path d="M42 64c4 3 12 3 16 0" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>`;
  const eyes =
    id === "fenomen" || id === "gelin"
      ? ""
      : `<g><circle cx="40" cy="48" r="5.5" fill="#fff" stroke="${INK}" stroke-width="3"/><circle cx="60" cy="48" r="5.5" fill="#fff" stroke="${INK}" stroke-width="3"/><circle cx="41" cy="49" r="2.4" fill="${INK}"/><circle cx="61" cy="49" r="2.4" fill="${INK}"/></g>`;
  return `
<svg viewBox="0 0 100 100" class="rr-portrait rr-portrait--${id}">
  ${p.back}
  <path d="M14 104c0-22 16-34 36-34s36 12 36 34Z" fill="${c.outfit}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
  ${p.body}
  <ellipse cx="50" cy="50" rx="25" ry="27" fill="${c.skin}" stroke="${INK}" stroke-width="4"/>
  <g fill="#FF8A8A" opacity="0.5"><ellipse cx="33" cy="58" rx="5" ry="3"/><ellipse cx="67" cy="58" rx="5" ry="3"/></g>
  ${p.hair}
  ${eyes}
  ${mouth}
  ${p.front}
</svg>`;
}
