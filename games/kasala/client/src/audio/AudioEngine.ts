// All sound (§15). Owner: client-audio. PUBLIC API IS THE CONTRACT; fill in the bodies. Put the music in
// audio/Music.ts, the announcer in audio/Announcer.ts, synthesized effects in audio/sfx/**.
// Everything is synthesized with Web Audio (no audio files) except the announcer mp3s.
//
// - One AudioContext created lazily; unlock() on the first user gesture (Game calls it on pointerdown/keydown).
// - Buses: master → { music, sfx, announcer } with settings volumes (masterVolume, musicVolume, sfxVolume,
//   announcerVolume; live via settings.onChange). Announcer ducking: while a line plays, music −9 dB and sfx
//   −4 dB, ramped (§15 "ducking").
// - Music (§15): smoky lounge jazz — walking upright bass, brushed snare, vibraphone/Rhodes chords, ~92 bpm,
//   procedurally sequenced so it never loops audibly. setTension(0..1 siren level, see sirenTension) thins it
//   out from the second card (22% raid chance): the lead drops, a faint heartbeat (its own sfx bus layer)
//   starts, by card 4 only bass + a lone hi-hat remain and the heart beats on every beat. Modes:
//   "lobby" (relaxed jazz), "lounge" (in-game), "wheel" (stage snare roll + cymbal swells, no harmony),
//   "tango" (SON MASA: dramatic tango rhythm, bandoneon-ish saw pad), "victory" (brassy swing sting then
//   lounge), "off". Cross-fade between modes ~0.8 s.
// - Sfx: see SfxId. Card flip "fışşş" (filtered noise sweep), rarity bells (common: single soft ding … legendary:
//   bright arpeggio + "choir" pad), cash register "ka-ching", chip clicks, siren wail (police two-tone), door
//   kick/break (low thump + wood crack), handcuffs (metal clicks), wheel peg tick (tick(speed) pitch/volume
//   follows speed), wheel stop clunk, glass smash + coin cascade (kumbara), camera flash pop, moth flutter,
//   splash, sack rustle, table punch, kiss, crying, cigar sizzle, money counting riffle, mumbles ("ooo!",
//   "yok artık!", "hah!" as formant-synth grunts), UI clicks, countdown tick, stamp, drumroll.
// - Turn tension (§14): flipStep(flips, chance) on every safe card — a drum step that climbs one rung per
//   card, plus a relief "fyuuu" sting when the card was flipped at ≥ 30% risk; heckle(kind) — the table
//   shouting "ÇEVİR!" / "KASALA!" (formant synthesis, throttled, a bigger crowd when heckles pile up).
//
// Graph: sfx groups → sfx bus (+ room reverb send) → sfx duck ┐
//        Music layers → music bus → music duck ───────────────┼→ master → glue comp → limiter → out
//        Cemil Abi mp3s → announcer bus ──────────────────────┘
// Nothing here throws: no Web Audio, a blocked autoplay or a failed node all degrade to silence (announcer
// events still fire, see Announcer.ts).

import { RAID_BASE_CHANCE } from "../../../shared/constants";
import { settings } from "../app/settings";
import { Music, type MusicMode } from "./Music";
import { Announcer } from "./Announcer";
import { Kit, clamp01, makeRoomImpulse, vary } from "./sfx/kit";
import { MIN_GAP, SFX, wheelPeg } from "./sfx";
import { type HeckleKind, heckle, phew, tensionStep } from "./sfx/tension";

export type SfxId =
  | "flip"
  | "deal"
  | "bellCommon"
  | "bellUncommon"
  | "bellRare"
  | "bellLegendary"
  | "choir"
  | "kaching"
  | "coins"
  | "chips"
  | "chipCrack"
  | "siren"
  | "doorBreak"
  | "cuffs"
  | "sack"
  | "moths"
  | "cameraFlash"
  | "splash"
  | "wheelStop"
  | "glassBreak"
  | "heartbeat"
  | "punchTable"
  | "kiss"
  | "cry"
  | "cigar"
  | "countMoney"
  | "ooh"
  | "yokArtik"
  | "hah"
  | "boo"
  | "laugh"
  | "tick"
  | "timeout"
  | "stamp"
  | "drumroll"
  | "cymbal"
  | "whoosh"
  | "paper"
  | "click"
  | "hover"
  | "pop"
  | "deny"
  | "open"
  | "close";

export interface SfxOptions {
  /** 0..1 multiplier. */
  volume?: number;
  /** Playback-rate / pitch multiplier (1 = normal). */
  rate?: number;
  /** Stereo pan -1..1. */
  pan?: number;
}

type Ctor = typeof AudioContext;

/** −9 dB music, −4 dB sfx while Cemil Abi talks. */
const DUCK_MUSIC = 0.355;
const DUCK_SFX = 0.63;

/** Raid chance at which the siren level reaches 1 (card 6). */
const SIREN_FULL_CHANCE = 0.5;
/** A safe card flipped at this raid chance (or more) earns the relief sting. */
const RELIEF_CHANCE = 0.3;
/** Heckles: same shout no closer than this, any two no closer than ANY. */
const HECKLE_GAP = 0.9;
const HECKLE_ANY_GAP = 0.35;
/** Seconds for a run of heckles to calm back down (the crowd grows while they keep coming). */
const HECKLE_COOL = 2.5;

/**
 * The siren level AudioEngine.setTension expects for a raid chance: 0 at the base chance (8%), 0.33 at 22%
 * (card 2), 0.5 at 29%, 0.67 at 36%, 1 from 50% (card 6). Game can pass `sirenTension(raidChance)`.
 */
export function sirenTension(chance: number): number {
  if (!Number.isFinite(chance)) return 0;
  return clamp01((chance - RAID_BASE_CHANCE) / (SIREN_FULL_CHANCE - RAID_BASE_CHANCE));
}

export class AudioEngine {
  /** Cemil Abi. Subtitles listen to announcer.events "line". */
  readonly announcer: Announcer;

  private ctx: AudioContext | null = null;
  private failed = false;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicDuck: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private sfxDuck: GainNode | null = null;
  private annBus: GainNode | null = null;
  private kit: Kit | null = null;
  private music: Music | null = null;
  private mode: MusicMode = "off";
  /** Last setTension input: the music's only tension source (the siren the HUD shows, bribes included). */
  private tension = 0;
  private ducked = false;
  private readonly last = new Map<string, number>();
  private heckleHeat = 0;
  private heckleAt = -Infinity;

  constructor() {
    this.announcer = new Announcer();
    settings.onChange(() => this.applyVolumes(false));
    try {
      // Back from a background tab: some engines leave the context suspended/interrupted. Try a quiet
      // resume (allowed once the page had a gesture); if it is refused, the next tap's unlock() does it.
      document.addEventListener("visibilitychange", () => {
        const ctx = this.ctx;
        if (document.hidden || !ctx || ctx.state === "running" || ctx.state === "closed") return;
        void ctx.resume().catch(() => undefined);
      });
    } catch {
      /* no document */
    }
  }

  /** Create/resume the AudioContext (call from a user gesture). Safe to call often. */
  unlock(): void {
    // The speech fallback needs a gesture too (iOS Safari); the announcer primes it once.
    this.announcer.unlock();
    try {
      if (!this.ctx && !this.failed) this.init();
      const ctx = this.ctx;
      if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
      void ctx.resume().catch(() => undefined);
      // iOS Safari also wants a sound started inside the gesture (one silent sample, released when done).
      const b = ctx.createBufferSource();
      b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      b.connect(ctx.destination);
      b.onended = () => b.disconnect();
      b.start();
    } catch {
      /* stay silent */
    }
  }

  sfx(id: SfxId, opts?: SfxOptions): void {
    const kit = this.kit;
    if (!kit || !this.running) return;
    const recipe = SFX[id];
    if (!recipe) return;
    if (this.throttled(id, MIN_GAP[id] ?? 0.02)) return;
    const vol = Math.max(0, Math.min(2, num(opts?.volume, 1)));
    if (vol <= 0) return;
    const rate = Math.max(0.25, Math.min(4, num(opts?.rate, 1))) * vary(0.045);
    try {
      kit.withPan(num(opts?.pan, 0), () => recipe(kit, kit.now + 0.005, vol, rate));
    } catch (e) {
      console.warn("[kasala] sfx failed", id, e);
    }
  }

  setMusic(mode: MusicMode): void {
    this.mode = mode;
    try {
      this.music?.setMode(mode);
    } catch (e) {
      console.warn("[kasala] music.setMode failed", e);
    }
  }

  /**
   * 0..1 siren level (`sirenTension(raidChance)`; 0 when the siren is off): music thins out, the heartbeat
   * fades in (§14). This is the music's only tension input, so it always matches the siren the HUD shows
   * (a Rüşvet Zarfı that lowers the siren relaxes the music too, and 0 after the turn calms it at once).
   */
  setTension(level: number): void {
    this.tension = clamp01(level);
    try {
      this.music?.setTension(this.tension);
    } catch {
      /* ignore */
    }
  }

  /**
   * A safe card was flipped (§14): a drum step whose pitch, weight and riser climb with `flips` (1 = the
   * turn's first card), plus a relief sting ("fyuuu" + a warm major roll) when `chance` — the raid chance
   * the card was flipped at, i.e. the risk just survived — is ≥ 30%. Sound only: the music's tension
   * follows setTension (the siren level, which a bribe can lower), never the card count.
   */
  flipStep(flips: number, chance: number, opts?: SfxOptions): void {
    const n = Math.max(1, Math.min(12, Math.floor(num(flips, 1))));
    const kit = this.kit;
    if (!kit || !this.running) return;
    if (this.throttled("flipStep", 0.15)) return;
    const vol = Math.max(0, Math.min(2, num(opts?.volume, 1)));
    if (vol <= 0) return;
    const risk = clamp01(num(chance, 0));
    try {
      kit.withPan(num(opts?.pan, 0), () => {
        tensionStep(kit, kit.now + 0.005, vol, n);
        if (risk >= RELIEF_CHANCE) phew(kit, kit.now + 0.32, vol, (risk - RELIEF_CHANCE) / 0.2);
      });
    } catch (e) {
      console.warn("[kasala] flipStep failed", e);
    }
  }

  /**
   * The table heckles the active player (§20): "ÇEVİR!" (`flip`) or "KASALA!" (`cash`), shouted by a few
   * synthesized gangsters. Throttled; a run of heckles makes the crowd bigger (2 → 4 voices).
   */
  heckle(kind: HeckleKind, opts?: SfxOptions): void {
    const kit = this.kit;
    if (!kit || !this.running) return;
    const k: HeckleKind = kind === "cash" ? "cash" : "flip";
    const now = kit.now;
    if (this.recent("heckle", HECKLE_ANY_GAP) || this.recent(`heckle:${k}`, HECKLE_GAP)) return;
    this.last.set("heckle", now);
    this.last.set(`heckle:${k}`, now);
    const vol = Math.max(0, Math.min(2, num(opts?.volume, 0.8)));
    if (vol <= 0) return;
    const dt = Math.max(0, now - this.heckleAt);
    this.heckleHeat = this.heckleHeat * Math.exp(-dt / HECKLE_COOL) + 1;
    this.heckleAt = now;
    const size = 1 + Math.min(3, Math.round(this.heckleHeat));
    try {
      kit.withPan(num(opts?.pan, 0), () => heckle(kit, now + 0.005, vol, k, size));
    } catch (e) {
      console.warn("[kasala] heckle failed", e);
    }
  }

  /** Wheel peg click; speed 0..1 (pitch + volume follow it). */
  wheelTick(speed: number): void {
    const kit = this.kit;
    if (!kit || !this.running) return;
    const s = clamp01(speed);
    // At full speed pegs come very fast: thin them so they don't merge into a buzz.
    if (this.throttled("wheelTick", 0.018 + (1 - s) * 0.012)) return;
    try {
      wheelPeg(kit, kit.now + 0.003, s, 1);
    } catch {
      /* ignore */
    }
  }

  // ==== internals ========================================================================================

  private get running(): boolean {
    return !!this.ctx && this.ctx.state === "running";
  }

  private init(): void {
    const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
    const C = w.AudioContext ?? w.webkitAudioContext;
    if (!C) {
      this.failed = true;
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new C({ latencyHint: "interactive" });
    } catch (e) {
      console.warn("[kasala] Web Audio unavailable", e);
      this.failed = true;
      return;
    }
    try {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 14;
      comp.ratio.value = 3.2;
      comp.attack.value = 0.004;
      comp.release.value = 0.22;
      const limit = ctx.createDynamicsCompressor();
      limit.threshold.value = -2.5;
      limit.knee.value = 0;
      limit.ratio.value = 20;
      limit.attack.value = 0.001;
      limit.release.value = 0.1;
      const master = ctx.createGain();
      master.connect(comp).connect(limit).connect(ctx.destination);

      const musicDuck = ctx.createGain();
      musicDuck.connect(master);
      const musicBus = ctx.createGain();
      musicBus.connect(musicDuck);

      const sfxDuck = ctx.createGain();
      sfxDuck.connect(master);
      const sfxBus = ctx.createGain();
      sfxBus.connect(sfxDuck);

      // Cemil Abi: a gentle low cut keeps the voice clear over the bass.
      const annBus = ctx.createGain();
      const annHp = ctx.createBiquadFilter();
      annHp.type = "highpass";
      annHp.frequency.value = 85;
      annBus.connect(annHp).connect(master);

      let impulse: AudioBuffer | null = null;
      let sfxWet: GainNode | null = null;
      try {
        impulse = makeRoomImpulse(ctx, 1.6, 3);
        const verb = ctx.createConvolver();
        verb.buffer = impulse;
        sfxWet = ctx.createGain();
        const ret = ctx.createGain();
        ret.gain.value = 0.7;
        sfxWet.connect(verb).connect(ret).connect(sfxBus);
      } catch {
        impulse = null;
        sfxWet = null;
      }

      this.ctx = ctx;
      this.master = master;
      this.musicBus = musicBus;
      this.musicDuck = musicDuck;
      this.sfxBus = sfxBus;
      this.sfxDuck = sfxDuck;
      this.annBus = annBus;
      this.kit = new Kit(ctx, sfxBus, sfxWet);
      this.applyVolumes(true);
      try {
        this.music = new Music(ctx, musicBus, sfxBus, impulse);
        this.music.setMode(this.mode);
        this.music.setTension(this.tension);
      } catch (e) {
        console.warn("[kasala] music unavailable", e);
        this.music = null;
      }
      this.announcer.attach(ctx, annBus, (on) => this.duck(on));
    } catch (e) {
      console.warn("[kasala] audio graph failed", e);
      this.failed = !this.ctx;
    }
  }

  private applyVolumes(immediate: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.musicBus || !this.sfxBus || !this.annBus) return;
    const s = settings.get();
    // Perceptual-ish curve so the sliders feel linear.
    const curve = (x: number): number => clamp01(x) * clamp01(x);
    const now = ctx.currentTime;
    const set = (g: GainNode, x: number): void => {
      if (immediate) g.gain.value = x;
      else g.gain.setTargetAtTime(x, now, 0.03);
    };
    set(this.master, curve(s.masterVolume));
    set(this.musicBus, curve(s.musicVolume) * 1.1);
    set(this.sfxBus, curve(s.sfxVolume));
    set(this.annBus, curve(s.announcerVolume) * 1.15);
    if (this.ducked && s.announcerVolume <= 0.01) this.setDuck(false);
  }

  /** Announcer hook: dip music and sfx while a line is audible. */
  private duck(on: boolean): void {
    const s = settings.get();
    const audible = s.announcerVolume > 0.01 && s.masterVolume > 0.01;
    this.setDuck(on && audible);
  }

  private setDuck(on: boolean): void {
    const ctx = this.ctx;
    this.ducked = on;
    if (!ctx || !this.musicDuck || !this.sfxDuck) return;
    const now = ctx.currentTime;
    const tc = on ? 0.06 : 0.35;
    this.musicDuck.gain.setTargetAtTime(on ? DUCK_MUSIC : 1, now, tc);
    this.sfxDuck.gain.setTargetAtTime(on ? DUCK_SFX : 1, now, tc);
  }

  /** True if `key` was recorded less than `gap` seconds ago (does not record). */
  private recent(key: string, gap: number): boolean {
    const now = this.ctx?.currentTime ?? 0;
    const prev = this.last.get(key);
    return prev !== undefined && now - prev < gap && now >= prev;
  }

  /** True if a one-shot of `key` played less than `gap` seconds ago (and records this one otherwise). */
  private throttled(key: string, gap: number): boolean {
    if (this.recent(key, gap)) return true;
    this.last.set(key, this.ctx?.currentTime ?? 0);
    return false;
  }
}

const num = (v: number | undefined, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
