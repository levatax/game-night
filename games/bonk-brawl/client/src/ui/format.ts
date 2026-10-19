// Display formatting helpers. Owner: client-ui.

/** Seconds → "m:ss" (rounded up so "0:01" shows until the very end). */
export function formatClock(sec: number): string {
  const total = Math.max(0, Math.ceil(sec - 1e-6));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** "Whiskers" → "Whiskers'", "Bob" → "Bob's". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

export type PingLevel = "good" | "ok" | "bad";

export function pingLevel(ms: number): PingLevel {
  if (ms < 90) return "good";
  if (ms < 160) return "ok";
  return "bad";
}

export function formatPing(ms: number): string {
  return ms > 0 ? `${Math.round(ms)} ms` : "– ms";
}

const ORDINALS = ["th", "st", "nd", "rd"];

/** 1 → "1st", 2 → "2nd", 4 → "4th". */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : ORDINALS[n % 10] ?? "th";
  return `${n}${suffix}`;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
