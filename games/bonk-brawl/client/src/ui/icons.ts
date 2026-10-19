// Inline SVG icons (static, trusted markup). Owner: client-ui.
// Colors come from CSS (currentColor / custom properties) so one icon serves every player color.

const INK = "#2D2A32";

const HEART_PATH =
  "M50 88C20 68 5 50 5 30 5 14 17 4 31 4c9 0 15 5 19 12 4-7 10-12 19-12 14 0 26 10 26 26 0 20-15 38-45 58Z";

export const ICON_HEART_FULL = `
<svg viewBox="0 0 100 92" class="i-heart">
  <path d="${HEART_PATH}" fill="var(--heart-fill, #FF5A5F)" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
  <ellipse cx="29" cy="27" rx="10" ry="6.5" transform="rotate(-32 29 27)" fill="#fff" opacity="0.85"/>
  <circle cx="44" cy="20" r="3" fill="#fff" opacity="0.7"/>
</svg>`;

export const ICON_HEART_EMPTY = `
<svg viewBox="0 0 100 92" class="i-heart">
  <path d="${HEART_PATH}" fill="rgba(255,255,255,0.3)" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
</svg>`;

export const ICON_CROWN = `
<svg viewBox="0 0 64 50" class="i-crown">
  <path d="M7 42 4 12l15 13L32 5l13 20 15-13-3 30Z" fill="#FFD23F" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M8 40h48" stroke="${INK}" stroke-width="4"/>
  <circle cx="32" cy="31" r="4.5" fill="#FF5A5F" stroke="${INK}" stroke-width="3"/>
  <circle cx="17" cy="33" r="3" fill="#3FA7FF" stroke="${INK}" stroke-width="2.5"/>
  <circle cx="47" cy="33" r="3" fill="#7BE07B" stroke="${INK}" stroke-width="2.5"/>
</svg>`;

export const ICON_BALL = `
<svg viewBox="0 0 100 100" class="i-ball">
  <circle cx="50" cy="50" r="42" fill="var(--ball-fill, #FFF4DC)" stroke="${INK}" stroke-width="8"/>
  <path d="M12 42c22 14 54 14 76 0" fill="none" stroke="var(--ball-seam, #FF5A5F)" stroke-width="7" stroke-linecap="round"/>
  <path d="M26 72c16 8 32 8 48 0" fill="none" stroke="var(--ball-seam, #FF5A5F)" stroke-width="5" stroke-linecap="round" opacity="0.6"/>
  <ellipse cx="34" cy="26" rx="9" ry="5" transform="rotate(-30 34 26)" fill="#fff" opacity="0.9"/>
</svg>`;

export const ICON_ARROW = `
<svg viewBox="0 0 64 44" class="i-arrow">
  <path d="M6 5 58 22 6 39 17 22Z" fill="currentColor" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
</svg>`;

export const ICON_CHEVRON_LEFT = `
<svg viewBox="0 0 24 24" class="i-chevron"><path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const ICON_CHEVRON_RIGHT = `
<svg viewBox="0 0 24 24" class="i-chevron"><path d="m9 4 8 8-8 8" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const ICON_BACK = `
<svg viewBox="0 0 24 24" class="i-back"><path d="M20 12H5m6-7-7 7 7 7" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const ICON_CHECK = `
<svg viewBox="0 0 24 24" class="i-check"><path d="m4 12.5 5 5L20 6" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const ICON_LINK = `
<svg viewBox="0 0 24 24" class="i-link"><g fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4l-1.1 1.1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.1-1.1"/></g></svg>`;

export const ICON_GEAR = `
<svg viewBox="0 0 24 24" class="i-gear"><g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"><path d="M12 2.8l1.6 2.3 2.7-.6.6 2.7 2.3 1.6-1.2 2.5 1.2 2.5-2.3 1.6-.6 2.7-2.7-.6L12 21.2l-1.6-2.3-2.7.6-.6-2.7-2.3-1.6L6 12.7 4.8 10.2l2.3-1.6.6-2.7 2.7.6Z"/><circle cx="12" cy="12" r="3.2"/></g></svg>`;

export const ICON_LOCK = `
<svg viewBox="0 0 24 24" class="i-lock"><g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></g></svg>`;

export const ICON_SIGNAL = `
<svg viewBox="0 0 24 24" class="i-signal"><g fill="currentColor"><rect x="3" y="15" width="4" height="6" rx="1.2"/><rect x="10" y="10" width="4" height="11" rx="1.2" class="i-signal__mid"/><rect x="17" y="4" width="4" height="17" rx="1.2" class="i-signal__top"/></g></svg>`;

export const ICON_MOUSE = `
<svg viewBox="0 0 24 24" class="i-mouse"><g fill="none" stroke="currentColor" stroke-width="2.4"><rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v7M6 10h12" stroke-linecap="round"/></g><path d="M12 3a6 6 0 0 0-6 6v1h6Z" fill="#FFCF33" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>`;
