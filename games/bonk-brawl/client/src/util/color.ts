// Tiny color helpers. Written by the architect (complete).

/** "#RRGGBB" (or "#RGB") → 0xRRGGBB. */
export function hexToInt(hex: string): number {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return parseInt(h, 16) || 0;
}

/** 0xRRGGBB → "#rrggbb". */
export function intToHex(value: number): string {
  return "#" + (value & 0xffffff).toString(16).padStart(6, "0");
}

/** Mix two "#RRGGBB" colors (t = 0 → a, 1 → b). */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToInt(a);
  const y = hexToInt(b);
  const ch = (shift: number) => {
    const ca = (x >> shift) & 255;
    const cb = (y >> shift) & 255;
    return Math.round(ca + (cb - ca) * t) & 255;
  };
  return intToHex((ch(16) << 16) | (ch(8) << 8) | ch(0));
}

/** Darken/lighten: amount < 0 mixes toward black, > 0 toward white. */
export function shadeHex(hex: string, amount: number): string {
  return amount < 0 ? mixHex(hex, "#000000", -amount) : mixHex(hex, "#ffffff", amount);
}

/** "#RRGGBB" + alpha → "rgba(r, g, b, a)" for CSS / canvas. */
export function hexToRgba(hex: string, alpha: number): string {
  const v = hexToInt(hex);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
}
