// Cemil Abi line picking for KasalaRoom. Owner: server.
// Every line goes through pickLine (shared/announcer.ts) with the previous line of the same event, so the same
// variation never plays twice in a row. The match-end sequence (titles, podium) is server-driven: matchEndScript
// spaces the lines by their spoken length so no line cuts the previous one off.

import { linesFor, lineDurationSec, pickLine } from "../../shared/announcer.js";
import type { AnnouncerEvent, AnnouncerLine } from "../../shared/announcer.js";
import type { MatchEndMsg } from "../../shared/protocol.js";
import type { Rng } from "../rules.js";

export class AnnouncerPicker {
  private last = new Map<AnnouncerEvent, string>();

  constructor(private rng: Rng) {}

  setRng(rng: Rng): void {
    this.rng = rng;
  }

  /** A line for `event` (never the previous one for this event when there is a choice), or null. */
  pick(event: AnnouncerEvent): AnnouncerLine | null {
    const line = pickLine(event, this.last.get(event), this.rng);
    if (line) this.last.set(event, line.id);
    return line;
  }
}

/** The longest spoken length among an event's lines (subtitle fallback timing). */
export function eventDurationSec(event: AnnouncerEvent): number {
  return linesFor(event).reduce((m, l) => Math.max(m, lineDurationSec(l.text)), 0);
}

export interface ScriptedLine {
  /** Seconds after MATCH_END. */
  at: number;
  event: AnnouncerEvent;
  playerId: string;
}

/** Overlays reveal one shame title roughly every this many seconds. */
const TITLE_STEP_SEC = 2.2;
const GAP_SEC = 0.35;

/**
 * Lines after MATCH_END: the "matchEnd" line plays at entry (not in here), then one line per shame title in
 * reveal order, then the podium and the after-podium line.
 */
export function matchEndScript(msg: Pick<MatchEndMsg, "titles" | "winnerId" | "collections">, scale = 1): ScriptedLine[] {
  const out: ScriptedLine[] = [];
  let at = eventDurationSec("matchEnd") + GAP_SEC + (msg.collections.length ? 1.2 : 0);
  for (const t of msg.titles) {
    const event = `title_${t.title}` as AnnouncerEvent;
    out.push({ at: at * scale, event, playerId: t.playerId });
    at += Math.max(TITLE_STEP_SEC, eventDurationSec(event) + GAP_SEC);
  }
  out.push({ at: at * scale, event: "podium", playerId: msg.winnerId });
  at += eventDurationSec("podium") + GAP_SEC + 1.5;
  out.push({ at: at * scale, event: "podiumAfter", playerId: "" });
  return out;
}
