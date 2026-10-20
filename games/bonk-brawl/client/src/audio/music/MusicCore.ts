// Context-agnostic music sequencer: decks (one per playing loop), crossfades, the sudden-death
// tension layer, tempo, jingles with ducking. Driven by pump(horizon), which a timer calls live
// (Music.ts) and the dev harness calls directly on an OfflineAudioContext.

import type { Jingle, MusicTrack } from "../Music";
import { safeDisconnect } from "../synth/dsp";
import { Band } from "./instruments";
import { JINGLES } from "./jingles";
import { playEvent, type PlayContext } from "./score";
import { SONGS, type Song } from "./songs";

/** Crossfade between different loops (s). */
const CROSSFADE = 0.6;
/** Fade-in when nothing was playing (s): music at round start should land on the beat. */
const FRESH_FADE = 0.12;
const TENSION_FADE = 1.2;
/** Lead time before the first step of a new deck (s). */
const START_LEAD = 0.06;
/** A retired deck is torn down this long after its last scheduled step (release tails). */
const TAIL = 2.5;
/** Loop level under a jingle, and how the loop comes back afterwards. */
const DUCK_LEVEL = 0.2;
const DUCK_IN_TAU = 0.05;
const DUCK_OUT_TAU = 0.35;
/** Overall music level into the engine's music bus (tuned against the sfx). */
const MUSIC_LEVEL = 0.6;
const JINGLE_LEVEL = 1.0;
const MIN_TEMPO = 0.5;
const MAX_TEMPO = 2;

interface Deck {
  readonly song: Song;
  readonly band: Band;
  readonly gain: GainNode;
  readonly tensionGain: GainNode;
  readonly tensionBand: Band;
  tension: boolean;
  /** Keep scheduling tension notes until this time while the layer fades out. */
  tensionUntil: number;
  step: number;
  nextTime: number;
  /** Set when fading out: no steps at/after this time; torn down after TAIL. */
  retireAt: number | null;
}

export class MusicCore {
  private readonly out: GainNode;
  private readonly glue: DynamicsCompressorNode;
  private readonly duck: GainNode;
  private readonly jingleBus: GainNode;
  private jingleBand: Band | null = null;
  private decks: Deck[] = [];
  private current: MusicTrack = "none";
  private tempo = 1;

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
    this.duck = ctx.createGain();
    this.duck.connect(this.glue);
    this.jingleBus = ctx.createGain();
    this.jingleBus.gain.value = JINGLE_LEVEL;
    this.jingleBus.connect(this.glue);
  }

  get track(): MusicTrack {
    return this.current;
  }

  /** True when nothing is scheduled or fading (the timer may sleep). */
  get idle(): boolean {
    return this.decks.length === 0;
  }

  play(track: MusicTrack): void {
    if (track === this.current) return;
    const now = this.ctx.currentTime;
    const song = songFor(track);
    const active = this.activeDeck();
    if (active && song && active.song === song) {
      // fight ⇄ suddenDeath: same groove, just layer the tension in or out.
      this.setTension(active, track === "suddenDeath", now);
    } else {
      if (active) this.retire(active, now, CROSSFADE);
      if (song) this.decks.push(this.createDeck(song, track === "suddenDeath", now, active ? CROSSFADE : FRESH_FADE));
    }
    this.current = track;
  }

  /** Fade everything out quickly (music "none"). */
  stop(): void {
    const now = this.ctx.currentTime;
    for (const d of this.decks) if (d.retireAt === null) this.retire(d, now, 0.25);
    this.current = "none";
  }

  setTempo(scale: number): void {
    if (!Number.isFinite(scale)) return;
    this.tempo = Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, scale));
  }

  get tempoScale(): number {
    return this.tempo;
  }

  /** Short stinger over the loop; the loop ducks to 20% and swells back afterwards. */
  jingle(kind: Jingle): number {
    const score = JINGLES[kind];
    const now = this.ctx.currentTime;
    const at = now + START_LEAD;
    const band = (this.jingleBand ??= new Band(this.ctx, this.jingleBus));
    const pc: PlayContext = { band, stepDur: 60 / score.bpm / 4, strumSpread: 0.012 };
    score.steps.forEach((events, i) => {
      for (const ev of events) playEvent(ev, at + i * pc.stepDur, pc);
    });
    const g = this.duck.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(DUCK_LEVEL, now, DUCK_IN_TAU);
    g.setTargetAtTime(1, at + score.duration - 0.3, DUCK_OUT_TAU);
    return score.duration;
  }

  /** Schedule every step that starts before `horizon` (absolute context time). */
  pump(horizon: number): void {
    const now = this.ctx.currentTime;
    for (const d of this.decks) this.pumpDeck(d, now, horizon);
    this.reap(now);
  }

  dispose(): void {
    for (const d of this.decks) this.teardown(d);
    this.decks = [];
    this.jingleBand?.dispose();
    for (const n of [this.duck, this.jingleBus, this.glue, this.out]) safeDisconnect(n);
    this.current = "none";
  }

  /* ------------------------------------------------------------------ private */

  private activeDeck(): Deck | null {
    for (let i = this.decks.length - 1; i >= 0; i--) if (this.decks[i].retireAt === null) return this.decks[i];
    return null;
  }

  private createDeck(song: Song, tension: boolean, now: number, fade: number): Deck {
    const gain = this.ctx.createGain();
    gain.connect(this.duck);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + START_LEAD + fade);
    const tensionGain = this.ctx.createGain();
    tensionGain.gain.value = tension ? 1 : 0;
    tensionGain.connect(gain);
    return {
      song,
      band: new Band(this.ctx, gain),
      gain,
      tensionGain,
      tensionBand: new Band(this.ctx, tensionGain),
      tension,
      tensionUntil: tension ? Infinity : 0,
      step: 0,
      nextTime: now + START_LEAD,
      retireAt: null,
    };
  }

  private setTension(d: Deck, on: boolean, now: number): void {
    if (d.tension === on) return;
    d.tension = on;
    const g = d.tensionGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(on ? 1 : 0, now + TENSION_FADE);
    d.tensionUntil = on ? Infinity : now + TENSION_FADE;
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

  /**
   * The timer fell behind (background tab, suspended context): skip the missed steps and stay on
   * the grid instead of bursting every late note at once.
   */
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
    for (const ev of d.song.steps[i]) playEvent(ev, at, pc);
    if (d.song.tension.length > 0 && time < d.tensionUntil) {
      const tpc: PlayContext = { band: d.tensionBand, stepDur: dur, strumSpread: d.song.strumSpread };
      for (const ev of d.song.tension[i]) playEvent(ev, at, tpc);
    }
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
    d.tensionBand.dispose();
    safeDisconnect(d.tensionGain);
    safeDisconnect(d.gain);
  }
}

function songFor(track: MusicTrack): Song | null {
  switch (track) {
    case "lobby":
      return SONGS.lobby;
    case "fight":
    case "suddenDeath":
      return SONGS.fight;
    case "none":
      return null;
  }
}
