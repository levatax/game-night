// Context-agnostic music sequencer: decks (one per playing loop), crossfades, tempo, jingles and ducking.
// Driven by pump(horizon), which the engine's ticker calls live and the dev harness may call directly. Owner:
// client-fx-audio. Adapted from games/bonk-brawl/client/src/audio/music/MusicCore.ts: songs come from the island
// seed's SongBook (setBook), and ducking is a set of timed requests (banners, boss entry, jingles).

import { safeDisconnect } from "../synth/dsp";
import { Band } from "./instruments";
import { buildJingles, type Jingle, type JingleScore } from "./jingles";
import { playEvent, type PlayContext } from "./score";
import type { Song, SongBook, SongId } from "./songs";

/** Crossfade between different loops (s). */
const CROSSFADE = 1.2;
/** Fade-in when nothing was playing (s). */
const FRESH_FADE = 0.5;
/** Lead time before the first step of a new deck (s). */
const START_LEAD = 0.06;
/** A retired deck is torn down this long after its last scheduled step (release tails). */
const TAIL = 2.5;
const DUCK_IN_TAU = 0.08;
const DUCK_OUT_TAU = 0.45;
/** Loop level under a jingle. */
const JINGLE_DUCK = 0.15;
/** Overall music level into the engine's music bus (tuned against the sfx). */
const MUSIC_LEVEL = 0.55;
const JINGLE_LEVEL = 1.0;
const MIN_TEMPO = 0.5;
const MAX_TEMPO = 2;

interface Deck {
  readonly song: Song;
  readonly band: Band;
  readonly gain: GainNode;
  step: number;
  nextTime: number;
  /** Set when fading out: no steps at/after this time; torn down after TAIL. */
  retireAt: number | null;
}

interface DuckRequest {
  level: number;
  until: number;
}

export class MusicCore {
  private readonly out: GainNode;
  private readonly glue: DynamicsCompressorNode;
  private readonly duckGain: GainNode;
  private readonly jingleBus: GainNode;
  private jingleBand: Band | null = null;
  private decks: Deck[] = [];
  private current: SongId | null = null;
  private book: SongBook | null = null;
  private jingles: Readonly<Record<Jingle, JingleScore>> | null = null;
  private tempo = 1;
  private ducks: DuckRequest[] = [];
  private duckLevel = 1;

  constructor(
    readonly ctx: BaseAudioContext,
    output: AudioNode,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = MUSIC_LEVEL;
    this.out.connect(output);
    // Tames downbeat pile-ups (kick + bass + strum + crash) so the mix can sit a little louder.
    this.glue = ctx.createDynamicsCompressor();
    this.glue.threshold.value = -14;
    this.glue.knee.value = 10;
    this.glue.ratio.value = 3;
    this.glue.attack.value = 0.006;
    this.glue.release.value = 0.2;
    this.glue.connect(this.out);
    this.duckGain = ctx.createGain();
    this.duckGain.connect(this.glue);
    this.jingleBus = ctx.createGain();
    this.jingleBus.gain.value = JINGLE_LEVEL;
    this.jingleBus.connect(this.glue);
  }

  get song(): SongId | null {
    return this.current;
  }

  get songBook(): SongBook | null {
    return this.book;
  }

  /** True when nothing is scheduled or fading (the timer may sleep). */
  get idle(): boolean {
    return this.decks.length === 0 && this.ducks.length === 0;
  }

  /** New island tune (seed change): a playing song crossfades into the new book's version. */
  setBook(book: SongBook): void {
    if (this.book && this.book.seed === book.seed) return;
    this.book = book;
    this.jingles = buildJingles(book.tune.key);
    const playing = this.current;
    if (playing) {
      this.current = null;
      this.play(playing);
    }
  }

  play(id: SongId | null): void {
    if (id === this.current) return;
    const now = this.ctx.currentTime;
    const song = id && this.book ? this.book.songs[id] : null;
    const active = this.activeDeck();
    if (active) this.retire(active, now, song ? CROSSFADE : 0.6);
    if (song) this.decks.push(this.createDeck(song, now, active ? CROSSFADE : FRESH_FADE));
    this.current = song ? id : null;
  }

  /** Fade everything out (music "off"). */
  stop(): void {
    this.play(null);
  }

  setTempo(scale: number): void {
    if (!Number.isFinite(scale)) return;
    this.tempo = Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, scale));
  }

  get tempoScale(): number {
    return this.tempo;
  }

  /** Short stinger over the loop (which ducks under it). Returns its duration (s). */
  jingle(kind: Jingle): number {
    if (!this.jingles) return 0;
    const score = this.jingles[kind];
    const now = this.ctx.currentTime;
    const at = now + START_LEAD;
    const band = (this.jingleBand ??= new Band(this.ctx, this.jingleBus));
    const pc: PlayContext = { band, stepDur: 60 / score.bpm / 4, strumSpread: 0.012 };
    score.steps.forEach((events, i) => {
      for (const ev of events) playEvent(ev, at + i * pc.stepDur, pc);
    });
    this.duck(JINGLE_DUCK, score.duration - 0.2);
    return score.duration;
  }

  /** Lower the loop to `level` (0..1) for `seconds` (overlapping requests: the deepest wins). */
  duck(level: number, seconds: number): void {
    if (!(seconds > 0)) return;
    this.ducks.push({ level: Math.min(1, Math.max(0, level)), until: this.ctx.currentTime + seconds });
    this.applyDuck(this.ctx.currentTime);
  }

  /** Schedule every step that starts before `horizon` (absolute context time). */
  pump(horizon: number): void {
    const now = this.ctx.currentTime;
    for (const d of this.decks) this.pumpDeck(d, now, horizon);
    this.reap(now);
    this.applyDuck(now);
  }

  dispose(): void {
    for (const d of this.decks) this.teardown(d);
    this.decks = [];
    this.jingleBand?.dispose();
    for (const n of [this.duckGain, this.jingleBus, this.glue, this.out]) safeDisconnect(n);
    this.current = null;
  }

  /* ------------------------------------------------------------------ private */

  private applyDuck(now: number): void {
    this.ducks = this.ducks.filter((r) => r.until > now);
    const level = this.ducks.reduce((m, r) => Math.min(m, r.level), 1);
    if (Math.abs(level - this.duckLevel) < 1e-3) return;
    const g = this.duckGain.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(level, now, level < this.duckLevel ? DUCK_IN_TAU : DUCK_OUT_TAU);
    this.duckLevel = level;
  }

  private activeDeck(): Deck | null {
    for (let i = this.decks.length - 1; i >= 0; i--) if (this.decks[i]!.retireAt === null) return this.decks[i]!;
    return null;
  }

  private createDeck(song: Song, now: number, fade: number): Deck {
    const gain = this.ctx.createGain();
    gain.connect(this.duckGain);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + START_LEAD + fade);
    return { song, band: new Band(this.ctx, gain), gain, step: 0, nextTime: now + START_LEAD, retireAt: null };
  }

  private retire(d: Deck, now: number, fade: number): void {
    const g = d.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
    d.retireAt = now + fade;
  }

  private stepDur(d: Deck): number {
    return 60 / (d.song.bpm * this.tempo) / 4;
  }

  private pumpDeck(d: Deck, now: number, horizon: number): void {
    const end = d.retireAt ?? Infinity;
    if (d.nextTime < now) this.realign(d, now);
    while (d.nextTime < horizon && d.nextTime < end) {
      const dur = this.stepDur(d);
      this.scheduleStep(d, d.step, d.nextTime, dur);
      d.nextTime += dur;
      d.step++;
    }
  }

  /** The timer fell behind (background tab): skip the missed steps and stay on the grid. */
  private realign(d: Deck, now: number): void {
    const dur = this.stepDur(d);
    const missed = Math.ceil((now - d.nextTime) / dur);
    d.step += missed;
    d.nextTime += missed * dur;
  }

  private scheduleStep(d: Deck, step: number, time: number, dur: number): void {
    const i = step % d.song.length;
    // Off-16ths lag a little: the shuffle that makes the ukulele bounce.
    const at = step % 2 === 1 ? time + d.song.swing * dur : time;
    const pc: PlayContext = { band: d.band, stepDur: dur, strumSpread: d.song.strumSpread };
    for (const ev of d.song.steps[i]!) playEvent(ev, at, pc);
  }

  private reap(now: number): void {
    if (!this.decks.some((d) => d.retireAt !== null && now > d.retireAt + TAIL)) return;
    this.decks = this.decks.filter((d) => {
      const dead = d.retireAt !== null && now > d.retireAt + TAIL;
      if (dead) this.teardown(d);
      return !dead;
    });
  }

  private teardown(d: Deck): void {
    d.band.dispose();
    safeDisconnect(d.gain);
  }
}
