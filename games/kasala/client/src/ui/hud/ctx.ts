// Per-patch derived view of the room for the HUD sections, the smooth counters they share, and the little bits
// of game math the HUD prints (risk tiers, what a raid costs, rough bet-box odds).

import {
  BET_BOXES,
  FINAL_TABLE_MULT,
  PALETTE,
  RAID_BASE_CHANCE,
  RAID_BRIBE_PCT,
  ROYALE_BRIBE_PER_ROUND,
  SIREN_CRITICAL_CHANCE,
  SIREN_MID_CHANCE,
  SIREN_SEGMENTS,
  raidChance,
  type BetBox,
} from "../../../../shared/constants";
import type { KasalaStateView, Mode, Phase, PlayerView } from "../../../../shared/protocol";
import { clamp01, mixHex, setText } from "./dom";

export interface HudCtx {
  state: KasalaStateView;
  phase: Phase;
  myId: string;
  me: PlayerView | undefined;
  active: PlayerView | undefined;
  /** I am the active player. */
  myTurn: boolean;
  /** Changes whenever a new turn starts ("round:turn:activeId"). */
  turnKey: string;
  /** A turn is on the table (betting → settle). */
  inTurn: boolean;
  /** The turn's flipping is over (result / settle). */
  turnOver: boolean;
  /** Turn over by a raid (only meaningful when turnOver). */
  raided: boolean;
  /** Flip number that ended the turn on a raid (0 otherwise). */
  raidFlip: number;
  /** Players of the match in turn order (non-spectators). */
  order: PlayerView[];
  /** I watch only (joined mid-match or not in the room). */
  spectator: boolean;
  /** I play in this match (in the turn order, not a spectator). Ghosts are participants too. */
  participant: boolean;
  /** I may place a side bet right now (not active, betting open, side bets on). */
  canBet: boolean;
  /** settings.reducedFlashing. */
  calm: boolean;
}

export const TURN_PHASES: ReadonlySet<Phase> = new Set<Phase>(["betting", "flipping", "targeting", "wheel", "result", "market", "settle"]);
/** Phases in which cards are still being flipped this turn (the turn has not ended). */
export const LIVE_PHASES: ReadonlySet<Phase> = new Set<Phase>(["betting", "flipping", "targeting", "wheel"]);

// ----------------------------------------------------------------- risk tiers
export const GREEN = "#7BD389";
export const ORANGE = "#FF8A3D";
export const RED = PALETTE.siren;

/** 0 calm · 1 orange (siren_orta) · 2 red (siren_kritik). */
export function tierOf(chance: number): 0 | 1 | 2 {
  return chance >= SIREN_CRITICAL_CHANCE ? 2 : chance >= SIREN_MID_CHANCE ? 1 : 0;
}

export function tierColor(chance: number): string {
  const t = tierOf(chance);
  return t === 2 ? RED : t === 1 ? ORANGE : GREEN;
}

/** Color of risk segment i (0..n−1): green → orange → red along the strip. */
export function segColor(i: number, n = SIREN_SEGMENTS): string {
  const t = n <= 1 ? 1 : i / (n - 1);
  return t < 0.5 ? mixHex(GREEN, ORANGE, t / 0.5) : mixHex(ORANGE, RED, (t - 0.5) / 0.5);
}

/**
 * Lit segments for a raid chance. Starts at one segment for the base 8% and lights ~1.6 segments per safe card,
 * so the strip is half full at the typical 3-card decision and red and nearly full around card 5.
 */
export function litSegments(chance: number): number {
  if (chance <= 0) return 0;
  return Math.round(1 + clamp01((chance - RAID_BASE_CHANCE) / 0.49) * (SIREN_SEGMENTS - 1));
}

// ----------------------------------------------------------------- money math
/** Bribe a raid takes from the kasa on top of the pot (mirrors server rules.raidBribe). */
export function raidBribe(mode: Mode, kasa: number, round: number, finalTable: boolean): number {
  const k = Math.max(0, Math.floor(kasa));
  if (k <= 0) return 0;
  if (mode === "royale") return Math.min(k, Math.max(1, round) * ROYALE_BRIBE_PER_ROUND);
  return Math.min(k, Math.floor((k * Math.round(RAID_BRIBE_PCT * 100) * (finalTable ? FINAL_TABLE_MULT : 1)) / 100));
}

/** What a raid on the next card would cost the active player: the vitrin plus the bribe. */
export function raidCost(s: KasalaStateView, active: PlayerView | undefined): { pot: number; bribe: number } {
  const pot = Math.max(0, s.turnPot);
  const bribe = active ? raidBribe(s.settings.mode, active.kasa, s.round, s.finalTable) : 0;
  return { pot, bribe };
}

/**
 * Rough chance that each bet box wins for a turn starting at siren `level` (+ the Battle Royale floor). Model:
 * the first card is mandatory, after k safe cards a typical player stops with STOP[k]. Only a hint for the
 * bettor ("≈%21"); the HUD never claims it is exact.
 */
const STOP = [0, 0.08, 0.3, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85];
export function boxOdds(level: number, floor: number): Record<BetBox, number> {
  let alive = 1;
  let b12 = 0;
  let b34 = 0;
  let b5p = 0;
  for (let f = 1; f <= STOP.length && alive > 0.0005; f++) {
    const c = raidChance(level + f - 1, floor);
    const raid = alive * c;
    if (f <= 2) b12 += raid;
    else if (f <= 4) b34 += raid;
    else b5p += raid;
    alive *= 1 - c;
    alive *= 1 - (STOP[f] ?? 0.9);
  }
  const out = { b12, b34, b5p, cash: Math.max(0, 1 - b12 - b34 - b5p) } as Record<BetBox, number>;
  for (const def of BET_BOXES) out[def.id] = clamp01(out[def.id]);
  return out;
}

// ------------------------------------------------------------------ counters
/**
 * Smoothly counting number (pot, kasa, kumbara). Fast exponential approach with a minimum speed so small
 * changes still tick visibly; snaps when it gets close.
 */
export class Counter {
  shown = 0;
  target = 0;
  private primed = false;

  constructor(
    private readonly node: HTMLElement,
    private readonly fmt: (n: number) => string,
    private readonly speed = 7,
    private readonly minRate = 60,
  ) {
    setText(node, fmt(0));
  }

  /** Returns the change of the target (0 on the first call or when snapping). */
  set(value: number, snap = false): number {
    if (!this.primed || snap) {
      this.primed = true;
      this.target = value;
      this.shown = value;
      setText(this.node, this.fmt(value));
      return 0;
    }
    const delta = value - this.target;
    this.target = value;
    return delta;
  }

  get counting(): boolean {
    return this.shown !== this.target;
  }

  /** Advance; returns true while still counting. */
  tick(dt: number): boolean {
    if (this.shown === this.target) return false;
    const diff = this.target - this.shown;
    const step = Math.max(Math.abs(diff) * Math.min(1, dt * this.speed), dt * this.minRate);
    this.shown = Math.abs(diff) <= step ? this.target : this.shown + Math.sign(diff) * step;
    setText(this.node, this.fmt(Math.round(this.shown)));
    return this.shown !== this.target;
  }
}

/** Local countdown between (quantized) patches; resyncs when the server value drifts or the timer restarts. */
export class Countdown {
  left = 0;
  total = 1;
  running = false;

  sync(left: number, total: number, running: boolean): void {
    const restarted = total !== this.total || left > this.left + 0.3;
    if (!running) {
      this.running = false;
      this.left = Math.max(0, left);
      this.total = Math.max(0.001, total);
      return;
    }
    if (!this.running || restarted || Math.abs(left - this.left) > 0.35) this.left = Math.max(0, left);
    this.total = Math.max(0.001, total);
    this.running = true;
  }

  tick(dt: number): void {
    if (this.running) this.left = Math.max(0, this.left - dt);
  }

  get frac(): number {
    return Math.max(0, Math.min(1, this.left / this.total));
  }

  /** Whole seconds shown on screen. */
  get secs(): number {
    return Math.max(0, Math.ceil(this.left - 0.001));
  }
}

/** Write a 0..1 bar fill as a compositor-only transform, only when it moved by a visible step. */
export function setBar(node: HTMLElement, frac: number, last: { v: number }): void {
  const q = Math.round(clamp01(frac) * 400) / 400;
  if (q === last.v) return;
  last.v = q;
  node.style.transform = `scaleX(${q})`;
}
