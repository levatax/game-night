// Cemil Abi, the announcer (§11, §15). Owner: client-audio. PUBLIC API IS THE CONTRACT.
//
// say(id): look the line up in ANNOUNCER_BY_ID (shared/announcer.ts). Priority rule (§15): only one line at a
// time; a higher-priority line interrupts the playing one, a lower one is dropped. A line of the SAME
// priority interrupts only once the playing one has run for SAME_PRIORITY_GRACE_MS (~1.8 s); sooner it is
// dropped, so a fast flipper doesn't chop every sentence. Emit events "line" (subtitle + Cemil's jaw) with the
// text, its duration and how it is heard (`voice`), and "end" when it finishes.
// Audio: fetch `${import.meta.env.BASE_URL}audio/spiker/manifest.json` once ({ lines: string[] }); if the id is
// listed, play `${BASE_URL}audio/spiker/<id>.mp3` through the announcer bus (AudioEngine wires the bus via
// attach()) — duration = the mp3's duration. Otherwise, if settings.speechFallback and the browser has a
// Turkish speechSynthesis voice (lang starts with "tr"), speak the text with it (rate 1.1, pitch 0.75, volume
// on the same curve as the announcer bus); duration = lineDurationSec(text). The speech voice is kept
// unobtrusive: small talk (priority 0) never cuts off a sentence the voice is still reading (it is skipped),
// nothing queues up in the speech engine, nothing is read in a hidden tab. Otherwise subtitle only.
// Never request an mp3 that isn't in the manifest (no 404 noise). Missing manifest = no mp3s.
//
// Implementation notes: a line is accepted (priority bookkeeping) synchronously in say(); loading an mp3 is
// async, so "line" fires when playback actually starts (the subtitle matches the voice). If the mp3 takes
// too long or fails, the line falls back to speech / subtitle. An interrupted line emits "end" before the
// next "line". Timing never relies on audio callbacks alone (a suspended context or a silent speech engine
// still ends lines on time), so events fire in every mode, even with no audio at all.

import { ANNOUNCER_BY_ID, lineDurationSec, type AnnouncerLine } from "../../../shared/announcer";
import { settings, type Settings } from "../app/settings";
import { Emitter } from "../util/Emitter";

/** How a line is heard: a recorded mp3, the browser's speech voice, or not at all (subtitle only). */
export type AnnouncerVoice = "mp3" | "speech" | "none";

export interface AnnouncerLineEvent {
  id: string;
  text: string;
  /** Seconds the subtitle should stay up. */
  durationSec: number;
  priority: number;
  /** How the line is heard (a subtitle matters most when this is "none"). */
  voice: AnnouncerVoice;
}

/** Give up waiting for an mp3 (fetch + decode) after this and fall back. */
const LOAD_TIMEOUT_MS = 1600;
/** Decoded mp3 cache size. */
const CACHE_MAX = 24;
/** Lines worth having decoded before they're needed. */
const PREFETCH = ["mac_basi_01", "mac_basi_02", "mac_basi_03", "tur_basi_01", "tur_basi_02", "bahis_acildi_01", "bahis_acildi_02"];
/** A same-priority line arriving sooner than this after the playing one was accepted is dropped. */
const SAME_PRIORITY_GRACE_MS = 1800;
/** Speech fallback voice: a touch quicker than normal and low (Cemil Abi). */
const SPEECH_RATE = 1.1;
const SPEECH_PITCH = 0.75;

interface Current {
  seq: number;
  line: AnnouncerLine;
  /** performance.now() when say() accepted the line. */
  at: number;
  started: boolean;
  /** How the line is delivered (valid once started). */
  voice: AnnouncerVoice;
  timer: ReturnType<typeof setTimeout> | null;
  stopAudio: (() => void) | null;
}

export class Announcer {
  readonly events = new Emitter<{ line: AnnouncerLineEvent; end: { id: string } }>();

  private ctx: AudioContext | null = null;
  private bus: AudioNode | null = null;
  private onDuck: ((on: boolean) => void) | null = null;
  private ducked = false;
  private manifest: Set<string> | null = null;
  private manifestPromise: Promise<Set<string>> | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading = new Map<string, Promise<AudioBuffer | null>>();
  private current: Current | null = null;
  private seq = 0;
  private voice: SpeechSynthesisVoice | null = null;
  private voicesKnown = false;
  /** Our utterance while the speech engine is (supposed to be) reading it. */
  private utterance: SpeechSynthesisUtterance | null = null;
  /** The engine refused to speak without a user gesture; retried after the next unlock(). */
  private speechBlocked = false;
  private speechPrimed = false;

  constructor() {
    this.loadManifest();
    this.initVoices();
    settings.onChange((s) => this.onSettings(s));
    try {
      // Engines keep reading after the page goes away (bfcache / navigation) unless told otherwise, and a
      // voice talking out of a background tab is just noise.
      window.addEventListener("pagehide", () => this.stop());
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) this.silenceSpeech();
      });
    } catch {
      /* no window */
    }
  }

  /** Called by AudioEngine once its AudioContext exists: where mp3 playback goes and the ducking hook. */
  attach(ctx: AudioContext, bus: AudioNode, onDuck: (on: boolean) => void): void {
    this.ctx = ctx;
    this.bus = bus;
    this.onDuck = onDuck;
    void this.loadManifest().then((set) => {
      for (const id of PREFETCH) if (set.has(id)) void this.buffer(id);
    });
  }

  say(id: string): void {
    const line = ANNOUNCER_BY_ID[id];
    if (!line) return;
    const cur = this.current;
    if (cur) {
      if (line.priority < cur.line.priority) return;
      if (line.priority === cur.line.priority) {
        // Don't chop a line that has only just begun for another one of the same weight.
        if (now() - cur.at < SAME_PRIORITY_GRACE_MS) return;
        // The speech voice is never cut off mid-sentence for more small talk: that line is skipped.
        if (line.priority === 0 && cur.started && cur.voice === "speech") return;
      }
      this.finish(cur.seq);
    }
    const seq = ++this.seq;
    this.current = { seq, line, at: now(), started: false, voice: "none", timer: null, stopAudio: null };
    try {
      this.route(seq, line);
    } catch (e) {
      console.warn("[kasala] announcer", e);
      if (this.isCurrent(seq) && !this.current?.started) this.startSubtitle(seq, line);
    }
  }

  stop(): void {
    if (this.current) this.finish(this.current.seq);
    this.cancelSpeech();
  }

  get speaking(): boolean {
    return this.current !== null;
  }

  /** A line is playing and actually audible (mp3 or speech voice), not just a subtitle. */
  get voiced(): boolean {
    const cur = this.current;
    return !!cur && cur.started && cur.voice !== "none";
  }

  /**
   * Call from a user gesture (AudioEngine.unlock does): lifts a "not-allowed" speech block and, once, primes
   * the speech engine with a silent utterance (iOS Safari only speaks after one was started in a gesture).
   */
  unlock(): void {
    this.speechBlocked = false;
    if (this.speechPrimed || !this.voice || !settings.get().speechFallback) return;
    const s = this.synth();
    if (!s || typeof SpeechSynthesisUtterance === "undefined") return;
    this.speechPrimed = true;
    try {
      if (s.speaking || s.pending) return;
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      u.voice = this.voice;
      u.lang = this.voice.lang;
      s.speak(u);
    } catch {
      /* ignore */
    }
  }

  // ==== routing ==========================================================================================

  private route(seq: number, line: AnnouncerLine): void {
    if (this.manifest) {
      this.routeWith(seq, line, this.manifest);
      return;
    }
    // Manifest still loading: wait briefly, never longer than the mp3 budget.
    let settled = false;
    const fallback = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (this.isCurrent(seq)) this.routeWith(seq, line, new Set());
    }, LOAD_TIMEOUT_MS);
    void this.loadManifest().then((set) => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      if (this.isCurrent(seq)) this.routeWith(seq, line, set);
    });
  }

  private routeWith(seq: number, line: AnnouncerLine, manifest: Set<string>): void {
    if (manifest.has(line.id) && this.canPlayMp3()) {
      this.playMp3(seq, line);
      return;
    }
    this.speakOrSubtitle(seq, line);
  }

  private canPlayMp3(): boolean {
    return !!this.ctx && !!this.bus && this.ctx.state === "running";
  }

  private speakOrSubtitle(seq: number, line: AnnouncerLine): void {
    if (!this.trySpeak(seq, line)) this.startSubtitle(seq, line);
  }

  // ==== mp3 ==============================================================================================

  private playMp3(seq: number, line: AnnouncerLine): void {
    const cached = this.buffers.get(line.id);
    if (cached) {
      this.startBuffer(seq, line, cached);
      return;
    }
    let settled = false;
    const giveUp = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (this.isCurrent(seq)) this.speakOrSubtitle(seq, line);
    }, LOAD_TIMEOUT_MS);
    void this.buffer(line.id).then((buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(giveUp);
      if (!this.isCurrent(seq)) return;
      if (buf && this.canPlayMp3()) this.startBuffer(seq, line, buf);
      else this.speakOrSubtitle(seq, line);
    });
  }

  private startBuffer(seq: number, line: AnnouncerLine, buf: AudioBuffer): void {
    const ctx = this.ctx;
    const bus = this.bus;
    const cur = this.current;
    if (!ctx || !bus || !cur || cur.seq !== seq) return;
    let src: AudioBufferSourceNode;
    try {
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(bus);
      src.start(ctx.currentTime + 0.02);
    } catch {
      this.speakOrSubtitle(seq, line);
      return;
    }
    cur.stopAudio = () => {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
    };
    this.duck(true);
    const sec = buf.duration;
    this.begin(seq, line, sec, "mp3");
    cur.timer = setTimeout(() => this.finish(seq), (sec + 0.15) * 1000);
  }

  private loadManifest(): Promise<Set<string>> {
    if (this.manifestPromise) return this.manifestPromise;
    this.manifestPromise = (async () => {
      let set = new Set<string>();
      try {
        if (typeof fetch === "function") {
          const res = await fetch(`${import.meta.env.BASE_URL}audio/spiker/manifest.json`, { cache: "no-cache" });
          if (res.ok) {
            const text = await res.text();
            const data = JSON.parse(text) as { lines?: unknown };
            if (Array.isArray(data.lines)) set = new Set(data.lines.filter((x): x is string => typeof x === "string"));
          }
        }
      } catch {
        /* no manifest (dev server, offline) → no mp3s */
      }
      this.manifest = set;
      return set;
    })();
    return this.manifestPromise;
  }

  /** Fetch + decode one line (deduplicated, LRU-cached). Resolves null on any failure. */
  private buffer(id: string): Promise<AudioBuffer | null> {
    const hit = this.buffers.get(id);
    if (hit) {
      this.buffers.delete(id);
      this.buffers.set(id, hit);
      return Promise.resolve(hit);
    }
    const pending = this.loading.get(id);
    if (pending) return pending;
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(null);
    const p = (async (): Promise<AudioBuffer | null> => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}audio/spiker/${encodeURIComponent(id)}.mp3`);
        if (!res.ok) return null;
        const data = await res.arrayBuffer();
        const buf = await new Promise<AudioBuffer>((resolve, reject) => {
          const r = ctx.decodeAudioData(data, resolve, reject);
          if (r && typeof r.then === "function") r.then(resolve, reject);
        });
        this.buffers.set(id, buf);
        while (this.buffers.size > CACHE_MAX) {
          const oldest = this.buffers.keys().next().value;
          if (oldest === undefined) break;
          this.buffers.delete(oldest);
        }
        return buf;
      } catch {
        return null;
      } finally {
        this.loading.delete(id);
      }
    })();
    this.loading.set(id, p);
    return p;
  }

  // ==== speech fallback ==================================================================================

  private synth(): SpeechSynthesis | null {
    try {
      return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
    } catch {
      return null;
    }
  }

  private initVoices(): void {
    const s = this.synth();
    if (!s) return;
    const pickVoice = (): void => {
      try {
        const voices = s.getVoices();
        if (voices.length > 0) this.voicesKnown = true;
        const tr = voices.filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith("tr"));
        // Prefer a local (offline, low-latency) voice, then a male-sounding one for Cemil Abi.
        tr.sort((a, b) => score(b) - score(a));
        this.voice = tr[0] ?? null;
      } catch {
        this.voice = null;
      }
    };
    pickVoice();
    try {
      s.addEventListener("voiceschanged", pickVoice);
    } catch {
      // Old engines without EventTarget on speechSynthesis.
      try {
        s.onvoiceschanged = pickVoice;
      } catch {
        /* no voice list updates: the one-more-look in trySpeak still helps */
      }
    }
  }

  /** Speak with a Turkish voice; false when that isn't possible (then the caller shows a subtitle only). */
  private trySpeak(seq: number, line: AnnouncerLine): boolean {
    const st = settings.get();
    if (!st.speechFallback || this.speechBlocked) return false;
    // A voice reading out of a background tab is just noise.
    if (typeof document !== "undefined" && document.hidden) return false;
    const s = this.synth();
    if (!s || typeof SpeechSynthesisUtterance === "undefined") return false;
    if (!this.voice && !this.voicesKnown) {
      // Voices load async on some engines: one more look.
      try {
        const tr = s.getVoices().filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith("tr"));
        tr.sort((a, b) => score(b) - score(a));
        this.voice = tr[0] ?? null;
      } catch {
        /* ignore */
      }
    }
    if (!this.voice) return false;
    const volume = speechVolume(st);
    if (volume <= 0.001) return false;
    const cur = this.current;
    if (!cur || cur.seq !== seq) return true;
    let u: SpeechSynthesisUtterance | null = null;
    try {
      // Whatever is still in the engine at this point isn't ours (a stuck engine, a stale priming
      // utterance): clear it so nothing queues up behind or in front of this line.
      let busy = false;
      try {
        busy = s.speaking || s.pending;
      } catch {
        busy = false;
      }
      if (busy) s.cancel();
      const utt = new SpeechSynthesisUtterance(line.text);
      u = utt;
      utt.voice = this.voice;
      utt.lang = this.voice.lang;
      utt.rate = SPEECH_RATE;
      utt.pitch = SPEECH_PITCH;
      utt.volume = volume;
      const sec = lineDurationSec(line.text);
      const done = (): void => {
        if (this.utterance === utt) this.utterance = null;
        if (this.isCurrent(seq)) this.finish(seq);
      };
      utt.onend = done;
      utt.onerror = (ev: SpeechSynthesisErrorEvent) => {
        // Autoplay policy: no speech until the next gesture (lines stay subtitles meanwhile).
        if (ev?.error === "not-allowed") this.speechBlocked = true;
        done();
      };
      this.utterance = utt;
      s.speak(utt);
      if (s.paused) s.resume();
      cur.stopAudio = () => {
        if (this.utterance !== utt) return;
        this.utterance = null;
        try {
          s.cancel();
        } catch {
          /* ignore */
        }
      };
      this.duck(true);
      this.begin(seq, line, sec, "speech");
      // Safety net: engines that never fire onend (or hang) still end — and silence — the line.
      cur.timer = setTimeout(() => {
        if (this.isCurrent(seq)) this.finish(seq);
      }, Math.max(sec * 1.8, sec + 4) * 1000);
      return true;
    } catch {
      if (u && this.utterance === u) this.utterance = null;
      cur.stopAudio = null;
      return false;
    }
  }

  /** Silence our speech utterance, if one is still in the engine. */
  private cancelSpeech(): void {
    if (!this.utterance) return;
    this.utterance = null;
    try {
      this.synth()?.cancel();
    } catch {
      /* ignore */
    }
  }

  /** Speech turned off or muted mid-line: stop reading. */
  private onSettings(st: Settings): void {
    if (st.speechFallback && speechVolume(st) > 0.001) return;
    this.silenceSpeech();
  }

  /** Stop reading the current line aloud (its subtitle runs out on its own timer). */
  private silenceSpeech(): void {
    const cur = this.current;
    if (!cur || cur.voice !== "speech") return;
    const stop = cur.stopAudio;
    cur.stopAudio = null;
    cur.voice = "none";
    try {
      stop?.();
    } catch {
      /* ignore */
    }
    this.duck(false);
  }

  // ==== subtitle-only & lifecycle ========================================================================

  private startSubtitle(seq: number, line: AnnouncerLine): void {
    const cur = this.current;
    if (!cur || cur.seq !== seq) return;
    const sec = lineDurationSec(line.text);
    this.begin(seq, line, sec, "none");
    cur.timer = setTimeout(() => this.finish(seq), sec * 1000);
  }

  private begin(seq: number, line: AnnouncerLine, sec: number, voice: AnnouncerVoice): void {
    const cur = this.current;
    if (!cur || cur.seq !== seq || cur.started) return;
    cur.started = true;
    cur.voice = voice;
    this.events.emit("line", { id: line.id, text: line.text, durationSec: sec, priority: line.priority, voice });
  }

  /** End line `seq` (if it's still the current one): stop audio, unduck, emit "end". */
  private finish(seq: number): void {
    const cur = this.current;
    if (!cur || cur.seq !== seq) return;
    this.current = null;
    if (cur.timer) clearTimeout(cur.timer);
    const stop = cur.stopAudio;
    cur.stopAudio = null;
    try {
      stop?.();
    } catch {
      /* ignore */
    }
    this.duck(false);
    if (cur.started) this.events.emit("end", { id: cur.line.id });
  }

  private isCurrent(seq: number): boolean {
    return this.current?.seq === seq;
  }

  private duck(on: boolean): void {
    if (on === this.ducked) return;
    this.ducked = on;
    try {
      this.onDuck?.(on);
    } catch {
      /* ignore */
    }
  }
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Speech volume on the same curve as the announcer bus (AudioEngine.applyVolumes). */
function speechVolume(st: Settings): number {
  const a = Math.max(0, Math.min(1, st.announcerVolume));
  const m = Math.max(0, Math.min(1, st.masterVolume));
  return Math.min(1, a * a * m * m * 1.15);
}

function score(v: SpeechSynthesisVoice): number {
  let s = 0;
  if (v.localService) s += 2;
  if (/cem|erkek|male|tolga|mehmet/i.test(v.name)) s += 1;
  if (v.default) s += 0.5;
  return s;
}
