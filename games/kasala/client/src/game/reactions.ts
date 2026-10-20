// Net event → the show: cards, fx, audio, camera beats and the other gangsters' reactions. Owner:
// client-net-game. No game decisions here (the server decided everything); Game.ts routes events in.
//
// Sequencing: CARD arrives together with what it caused (RAIDED, an instant ATTACK, WHEEL_START), and the
// state patch lands ~50 ms later. Everything a card causes waits for that card's flip to land (afterFlip),
// and the HUD-visible numbers are held at their pre-card values meanwhile (DisplayState), so the reveal is
// never spoiled. The wheel is the exception: it must start moving the instant WHEEL_START arrives so it
// lands exactly on WHEEL_RESULT (it descends from the ceiling while the card turns over).
//
// Event policy: every event is told ONCE, in one channel.
// - Turn outcomes (KASALA / BASKIN / JACKPOT) → fx.slam, with the player's name in the sub ("Kedi · +65$").
// - Card names → hud.banner, only for rare / legendary cards, attack cards and a raid the lawyer cancelled;
//   wheel slices the same way. The only other banners: my turn ("SIRA SENDE!"), SON MASA and the Battle
//   Royale moments (the river, a ghost's return).
// - Money deltas → 3D floats anchored to their owner's stack (never a nameless number at screen center).
// - The feed → only what nothing else showed: attacks on/by me, loans, interest, skipped turns, my ghost
//   progress, spectators' chatter, notices.
// First person: attention beats (stage.attend) turn the head toward what matters; outOfBody hands the shot
// to the Masa camera while my own avatar walks away (kelepçe / çuval raids, the river).

import * as THREE from "three";
import {
  BIG_CASH,
  CARD_BY_ID,
  FLIP_ANIM_SEC,
  HECKLE_CASH_TAUNT,
  HECKLE_FLIP_TAUNT,
  EMOTES,
  PALETTE,
  RARITIES,
  RAID_RESULT_SEC,
  RAID_RESULT_SHORT_SEC,
  SIREN_CRITICAL_CHANCE,
  SIREN_MID_CHANCE,
  SIREN_SHAKE_CHANCE,
  START_KASA,
  ROYALE_START_KASA,
  SMALL_CASH,
  TAUNTS,
  TRAP_LEVEL,
  WHEEL_HOLD_SEC,
  WHEEL_SLICE_BY_ID,
  boxAlive,
  boxWins,
  type CardId,
  type EmoteId,
} from "../../../shared/constants";
import type {
  AttackMsg,
  BetsSettledMsg,
  CardMsg,
  CashedMsg,
  EliminatedMsg,
  EmotedMsg,
  GhostReturnMsg,
  KasalaStateView,
  LastChanceMsg,
  LoanMsg,
  MatchEndMsg,
  RaidedMsg,
  RoundEndMsg,
  SavedMsg,
  TauntedMsg,
  TaslikMsg,
  TurnStartMsg,
  WheelResultMsg,
  WheelStartMsg,
} from "../../../shared/protocol";
import type { SfxId } from "../audio/AudioEngine";
import { money, pct, upperTr } from "../app/ui";
import type { Mood } from "../scene/Characters";
import { RAID_CUFFS_AT } from "../scene/characters/sequences";
import { Spots, Voices, withTimeout, type Ctx } from "./context";
import type { Director } from "./director";
import type { HeldFields } from "./display";
import * as feed from "./feed";
import { amTargeting, isParticipant, me, participants, sideBetsFor, validTargets } from "./turn";

const GREEN = PALETTE.money;
const RED = PALETTE.siren;
const GOLD = PALETTE.gold;
const PURPLE = RARITIES.legendary.color;
const BLUE = "#3FA7FF";
const FLIP_MAX_MS = FLIP_ANIM_SEC * 1000 + 350;
/** Surviving a card flipped at this raid chance (or more) earns a relief beat (§4: the thrill of push-your-luck). */
const SURVIVE_RISK = 0.22;
/** House-cut floats below this are noise. */
const HOUSE_CUT_FLOAT_MIN = 10;

const EMOTE_SFX: Record<EmoteId, SfxId> = {
  puro: "cigar",
  paraSay: "countMoney",
  yumruk: "punchTable",
  opucuk: "kiss",
  agla: "cry",
  allahAllah: "yokArtik",
};

const BELL: Record<string, SfxId> = {
  common: "bellCommon",
  uncommon: "bellUncommon",
  rare: "bellRare",
  legendary: "bellLegendary",
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const chipCount = (amount: number, per: number, lo: number, hi: number) => Math.round(clamp(amount / per, lo, hi));

/** A TAUNT index that is one of the one-tap heckles ("ÇEVİR!" / "KASALA!"). */
function heckleKind(index: number): "flip" | "cash" | null {
  if (index === HECKLE_FLIP_TAUNT) return "flip";
  if (index === HECKLE_CASH_TAUNT) return "cash";
  return null;
}

/** What the HUD showed last (pre-card values for the anti-spoiler hold). */
type Shown = Pick<KasalaStateView, "raidChance" | "sirenLevel" | "lawyers" | "curseArmed" | "kumbara" | "pendingCard" | "wheelSlice"> & {
  lastCard: KasalaStateView["lastCard"];
};

export class Show {
  readonly spots: Spots;
  private voices: Voices;
  /** The last card's flip animation (everything it caused waits for it). */
  private flip: { promise: Promise<void>; at: number } | null = null;
  /** performance.now() until which Fx may legitimately freeze time (Game guards the frame loop with it). */
  freezeUntil = 0;
  private shown: Shown | null = null;
  private targetMode: "" | "me" | "other" = "";
  /** Keyboard target (←/→), confirmed with Space / Enter. */
  private highlightId = "";
  // per-turn trackers (watch)
  private deadBets = new Set<string>();
  private betSeen = new Map<string, string>();
  private sirenTier = 0;
  private lastTick = -1;
  private wheelDown = false;
  private matchEnd: MatchEndMsg | null = null;
  private cardFocus = new THREE.Vector3();
  private rowAt = new THREE.Vector3();

  constructor(
    private ctx: Ctx,
    private director: Director,
  ) {
    this.spots = new Spots(ctx);
    this.voices = new Voices(ctx, this.spots);
  }

  private get s(): KasalaStateView | null {
    return this.ctx.net.state;
  }
  private get myId(): string {
    return this.ctx.net.myId;
  }
  private line(l: feed.FeedLine | null): void {
    if (l) this.ctx.hud.feed(l[0], l[1]);
  }
  /** First person is on screen right now (attention beats only make sense from a seat). */
  private get fp(): boolean {
    const f = this.ctx.stage.firstPerson;
    return !!f && f.active === true;
  }

  /** Targeting UI state: "me" while I pick an attack target. */
  get targeting(): "" | "me" | "other" {
    return this.targetMode;
  }

  /** Leaving the room / back to the lobby. */
  reset(): void {
    this.flip = null;
    this.shown = null;
    this.targetMode = "";
    this.highlightId = "";
    this.deadBets.clear();
    this.betSeen.clear();
    this.sirenTier = 0;
    this.lastTick = -1;
    this.matchEnd = null;
    this.ctx.characters.setTargetable(null);
    this.ctx.characters.highlight(null);
    this.ctx.hud.targetPrompt(null, false);
    this.ctx.stage.outOfBody(0);
    this.raiseWheel();
  }

  /** New match: back in my own body. */
  newMatch(): void {
    this.ctx.stage.outOfBody(0);
  }

  /** Resolves when the last card has landed face up (bounded, never rejects). */
  afterFlip(): Promise<void> {
    const f = this.flip;
    if (!f) return Promise.resolve();
    const left = FLIP_MAX_MS - (performance.now() - f.at);
    return left <= 0 ? Promise.resolve() : withTimeout(f.promise, left);
  }

  private freeze(sec: number): void {
    this.freezeUntil = performance.now() + sec * 1000;
    this.ctx.fx.freeze(sec);
  }

  private react(ids: Iterable<string>, mood: Mood, staggerMs = 70): void {
    let i = 0;
    for (const id of ids) {
      const delay = i++ * staggerMs + Math.random() * 40;
      if (delay < 5) this.ctx.characters.react(id, mood);
      else this.ctx.later.run(delay, () => this.ctx.characters.react(id, mood));
    }
  }

  /** Everyone at the table except these ids. */
  private others(...except: string[]): string[] {
    const s = this.s;
    if (!s) return [];
    return participants(s)
      .map((p) => p.id)
      .filter((id) => !except.includes(id));
  }

  private float(at: THREE.Vector3 | null, text: string, color: string): void {
    if (at) this.ctx.fx.floatText(at, text, color);
  }

  private stackOr(id: string): THREE.Vector3 {
    return this.spots.stack(id) ?? this.spots.center();
  }

  /** First person: look toward a player's head for a moment (tracks them if they move). */
  private attendHead(id: string, sec: number, weight: number, priority = 1): void {
    if (!this.fp || !id || id === this.myId || !this.spots.seated(id)) return;
    const v = new THREE.Vector3();
    this.ctx.stage.attend(() => this.spots.head(id, v), sec, weight, priority);
  }

  private attendPoint(at: THREE.Vector3, sec: number, weight: number, priority = 1): void {
    if (!this.fp) return;
    this.ctx.stage.attend(at, sec, weight, priority);
  }

  // ================================================================ match flow
  intro(state: KasalaStateView | null): void {
    const c = this.ctx;
    const royale = state?.settings.mode === "royale";
    const start = royale ? ROYALE_START_KASA : START_KASA;
    c.cards.clearTurn();
    this.newMatch();
    const mode = royale ? "Battle Royale: son kalan kazanır" : `Klasik · ${state?.totalRounds ?? 0} tur`;
    // The match title card: the one slam that isn't a turn outcome (it names the game itself).
    c.fx.slam("KASALA!", PALETTE.neonPink, `${mode} · Herkese ${money(start)}`);
    c.audio.sfx("cymbal", { volume: 0.7 });
    c.later.run(250, () => c.audio.sfx("chips"));
    c.stage.punch(0.15);
    if (state) this.react(this.others(), "happy", 120);
  }

  // ===================================================================== turns
  turnStart(m: TurnStartMsg): void {
    const c = this.ctx;
    const s = this.s;
    const myId = this.myId;
    this.flip = null;
    this.deadBets.clear();
    this.betSeen.clear();
    this.sirenTier = 0;
    this.lastTick = -1;
    c.cards.clearTurn();
    this.setTargeting("");

    const mine = m.playerId === myId;
    if (mine) {
      // The turn strip shows whose turn it is for everyone; only my own turn gets the banner.
      const subs: string[] = [];
      if (m.trapped) subs.push(`🪤 Tuzak! Siren ${TRAP_LEVEL}'den başlıyor`);
      if (m.cursed) subs.push("🧿 Lanetli: ilk para kartı boş");
      if (m.lawyers > 0) subs.push("⚖️ Avukatın hazır");
      // (The keys are the HUD's: its legend / coach marks show them on the first own turn.)
      c.hud.banner("SIRA SENDE!", GOLD, subs.join(" · ") || undefined);
      c.audio.sfx("cymbal", { volume: 0.45 });
      c.audio.sfx("pop");
      c.characters.react(myId, "nervous");
      if (this.fp) c.stage.recenter(0.6);
    } else {
      // Others' turns: no banner (the turn plate / strip names them, the HUD's bet tray asks for my bet);
      // a chip rattle tells my ears the bets are open.
      const p = me(s, myId);
      const canBet = m.betsOpen && !!p && !p.spectator && !!s && sideBetsFor(s, p) && isParticipant(s, myId);
      if (canBet) c.later.run(220, () => c.audio.sfx("chips", { volume: 0.35 }));
      c.audio.sfx("deal", { volume: 0.45, pan: this.spots.pan(m.playerId) });
    }
    if (m.trapped) {
      c.characters.react(m.playerId, "shock");
      this.voices.say("ooh", m.playerId, { volume: 0.55 });
    }
  }

  /** Reconnect / late join mid-turn: rebuild what the state can tell (the last card, targeting, bets). */
  rebuildTurn(s: KasalaStateView): void {
    const c = this.ctx;
    this.flip = null;
    this.deadBets.clear();
    this.betSeen.clear();
    s.bets.forEach((b) => this.betSeen.set(b.playerId, `${b.box}:${b.amount}`));
    this.sirenTier = 0;
    c.cards.clearTurn();
    const lc = s.lastCard;
    if (lc.flipNo > 0 && lc.id && lc.rarity) {
      const pose = this.spots.pose(s.activeId);
      if (pose) {
        const msg: CardMsg = {
          playerId: s.activeId,
          flipNo: lc.flipNo,
          card: lc.id,
          rarity: lc.rarity,
          value: lc.value,
          pot: s.turnPot,
          sirenLevel: s.sirenLevel,
          raidChance: s.raidChance,
          curseHit: false,
          saved: false,
          needsTarget: s.phase === "targeting",
        };
        this.flip = { promise: Promise.resolve(c.cards.flip(msg, pose)), at: performance.now() };
      }
    }
  }

  /** Per state patch during the bet window: whoever just put chips down pushes them in (no text). */
  watchBets(s: KasalaStateView): void {
    if (s.phase !== "betting") return;
    const c = this.ctx;
    const myId = this.myId;
    s.bets.forEach((b) => {
      const key = `${b.box}:${b.amount}`;
      if (this.betSeen.get(b.playerId) === key) return;
      this.betSeen.set(b.playerId, key);
      if (b.amount <= 0 && !b.ghost) return;
      c.characters.gesture(b.playerId, "push");
      if (b.playerId !== myId) c.audio.sfx("chips", { volume: 0.3, pan: this.spots.pan(b.playerId) });
    });
  }

  // ===================================================================== cards
  /** Snapshot of what the HUD showed (Game calls this on every present). */
  noteShown(v: KasalaStateView): void {
    const lc = v.lastCard;
    const sh = this.shown;
    if (sh) {
      sh.raidChance = v.raidChance;
      sh.sirenLevel = v.sirenLevel;
      sh.lawyers = v.lawyers;
      sh.curseArmed = v.curseArmed;
      sh.kumbara = v.kumbara;
      sh.pendingCard = v.pendingCard;
      sh.wheelSlice = v.wheelSlice;
      sh.lastCard = { flipNo: lc.flipNo, id: lc.id, rarity: lc.rarity, value: lc.value, targetId: lc.targetId };
      return;
    }
    this.shown = {
      raidChance: v.raidChance,
      sirenLevel: v.sirenLevel,
      lawyers: v.lawyers,
      curseArmed: v.curseArmed,
      kumbara: v.kumbara,
      pendingCard: v.pendingCard,
      wheelSlice: v.wheelSlice,
      lastCard: { flipNo: lc.flipNo, id: lc.id, rarity: lc.rarity, value: lc.value, targetId: lc.targetId },
    };
  }

  card(m: CardMsg): void {
    const c = this.ctx;
    const pose = this.spots.pose(m.playerId);
    // The risk this card was flipped at (what the HUD showed before it): survived → relief beat.
    const risk = this.shown?.raidChance ?? 0;

    // Hold the HUD at the pre-card picture until the card is face up.
    const held: HeldFields = { phase: "flipping", busy: true, turnPot: m.pot - m.value, flips: Math.max(0, m.flipNo - 1) };
    if (this.shown) Object.assign(held, this.shown);
    const token = c.display.hold(held, FLIP_MAX_MS);

    c.dealer.deal();
    c.characters.gesture(m.playerId, "knock");
    const pan = this.spots.pan(m.playerId);
    c.audio.sfx("deal", { volume: 0.5, pan });
    c.later.run(120, () => c.audio.sfx("flip", { pan }));
    const p = pose ? Promise.resolve(c.cards.flip(m, pose)) : Promise.resolve();
    this.flip = { promise: p, at: performance.now() };
    // First person: glance at someone else's card while it turns over.
    if (m.playerId !== this.myId && this.fp) {
      const v = this.cardFocus;
      c.stage.attend(() => (c.cards.focusPoint(v) ? v : null), 0.9, 0.5);
    }
    // The table leans in on deep flips.
    if (m.flipNo >= 4) this.react(this.others(m.playerId), "nervous", 50);

    c.later.after(p, FLIP_MAX_MS, () => {
      c.display.release(token);
      this.cardLanded(m, risk);
    });
  }

  private cardLanded(m: CardMsg, risk: number): void {
    const c = this.ctx;
    const def = CARD_BY_ID[m.card];
    if (!def) return;
    const id = m.playerId;
    const mine = id === this.myId;
    const color = RARITIES[m.rarity]?.color ?? GOLD;
    const at = this.stackOr(id);
    const head = this.spots.head(id);
    const others = this.others(id);
    const raid = def.kind === "raid";
    const safe = !raid || m.saved;

    const bell = BELL[m.rarity];
    if (bell) c.audio.sfx(bell);
    const rarePlus = m.rarity === "rare" || m.rarity === "legendary";
    if (rarePlus) {
      c.audio.sfx("choir", { volume: m.rarity === "legendary" ? 0.8 : 0.5 });
      c.fx.edgeGlow(color, m.rarity === "legendary" ? 1.6 : 1);
    }
    // One drum step per safe card, climbing with the count (plus a relief sting at high risk).
    if (safe) c.audio.flipStep(m.flipNo, risk);

    // Card names: a banner only for the rare ones, attacks and a raid the lawyer cancelled. The value of a
    // money card is told by the float at the stack, not the banner.
    if (raid && m.saved) c.hud.banner("AVUKAT KURTARDI!", BLUE, `${feed.subject(this.s, id, this.myId)} baskından kurtuldu`);
    else if (!raid && (rarePlus || def.kind === "attack")) c.hud.banner(upperTr(def.name), color, bannerSub(def.kind, m));

    switch (def.kind) {
      case "money":
        if (m.curseHit) {
          this.float(head ?? at, "🧿 NAZAR! 0$", PURPLE);
          c.audio.sfx("boo", { volume: 0.6 });
          c.fx.smoke(at);
          c.characters.react(id, "sad");
          this.react(others, "laugh");
          this.voices.say("hah", others[0] ?? null);
        } else {
          this.float(at, money(m.value, true), GREEN);
          c.audio.sfx(m.value >= 50 ? "kaching" : "coins", { volume: m.value >= 50 ? 0.85 : 0.7 });
          if (m.card === "kulce") {
            c.fx.moneyRain(at, m.value);
            c.stage.punch(0.08);
            c.characters.react(id, "cheer");
            this.react(others, "shock");
            this.voices.say("ooh", others[0] ?? null);
          } else {
            c.characters.react(id, m.value >= 50 ? "cheer" : "happy");
          }
        }
        break;
      case "multiplier":
        this.float(at, `×2 ${money(m.value, true)}`, GOLD);
        c.audio.sfx("kaching");
        c.stage.punch(0.1);
        c.characters.react(id, "laugh");
        this.react(others, "shock");
        break;
      case "protection":
        if (m.card === "avukat") {
          c.audio.sfx("paper");
          c.characters.react(id, "happy");
        } else {
          this.float(head ?? at, "✉️ SİREN −2", GREEN);
          c.audio.sfx("paper");
          c.later.run(300, () => this.voices.say("hah", id, { volume: 0.6 }));
          c.characters.react(id, "laugh");
        }
        break;
      case "special":
        c.audio.sfx("drumroll", { volume: 0.6 });
        this.react([id, ...others], "shock", 60);
        this.voices.say("ooh", others[0] ?? id, { volume: 0.7 });
        break;
      case "attack":
        c.audio.sfx("whoosh");
        c.characters.react(id, "laugh");
        if (m.needsTarget) this.react(others, "nervous", 60);
        break;
      case "raid":
        if (m.saved) {
          c.characters.lawyer(id);
          c.audio.sfx("siren", { volume: 0.4 });
          c.later.run(350, () => c.audio.sfx("paper"));
          c.characters.react(id, "laugh");
          this.react(others, "angry");
          this.voices.say("yokArtik", others[0] ?? null);
          // First person: the lawyer steps up beside my chair.
          if (mine) {
            const pose = this.spots.pose(id);
            if (pose) this.attendPoint(pose.chair.clone().add(new THREE.Vector3(0.45, 1.3, -0.2)), 1.4, 0.7, 2);
          }
        } else {
          this.freeze(0.3);
          c.fx.flash(RED, 0.85);
          c.audio.sfx("siren");
          c.stage.shake(0.55, 0.45);
          c.characters.react(id, "shock");
        }
        break;
    }
    if (safe && !raid && risk >= SURVIVE_RISK) this.survived(id, risk, others);
  }

  /** Lived through a scary card: the table gasps, the camera thumps, a "Kıl payı!" at the survivor's head. */
  private survived(id: string, risk: number, others: string[]): void {
    const c = this.ctx;
    const big = risk >= SIREN_CRITICAL_CHANCE;
    c.stage.punch(0.05 + risk * 0.3);
    this.voices.say("ooh", others[0] ?? null, { volume: Math.min(0.85, 0.35 + risk) }, 250);
    if (!big) return;
    this.react(others, "shock", 60);
    c.later.run(280, () => this.float(this.spots.head(id) ?? this.stackOr(id), `😮‍💨 Kıl payı! ${pct(risk)}`, GREEN));
  }

  // ================================================================ targeting
  /** Show / hide the targeting UI from the displayed phase (appears when the attack card is face up). */
  syncTargeting(v: KasalaStateView): void {
    let want: "" | "me" | "other" = "";
    if (v.phase === "targeting") want = amTargeting(v, this.myId) ? "me" : "other";
    if (want !== this.targetMode) this.setTargeting(want, v);
  }

  private setTargeting(mode: "" | "me" | "other", v: KasalaStateView | null = this.s): void {
    const c = this.ctx;
    this.targetMode = mode;
    this.highlightId = "";
    c.characters.highlight(null);
    if (mode === "") {
      c.characters.setTargetable(null);
      c.hud.targetPrompt(null, false);
      return;
    }
    const card = (v?.pendingCard || v?.lastCard.id || "harac") as CardId;
    if (mode === "me") {
      const targets = validTargets(v);
      c.characters.setTargetable(targets);
      c.hud.targetPrompt(card, true);
      c.audio.sfx("open");
      // One possible target: the server resolves it by itself in a moment; mark it so Space confirms at once.
      if (targets.length === 1) {
        this.highlightId = targets[0];
        c.characters.highlight(targets[0]);
      }
      if (targets[0]) this.attendHead(targets[0], 1.2, 0.8, 2);
    } else {
      c.characters.setTargetable(null);
      c.hud.targetPrompt(card, false);
    }
  }

  clearTargeting(): void {
    this.setTargeting("");
  }

  /** ←/→ while I pick a target: move the highlight (and the head) to the next valid target. */
  cycleTarget(dir: -1 | 1): string | null {
    if (this.targetMode !== "me") return null;
    const targets = validTargets(this.s);
    if (!targets.length) return null;
    const i = targets.indexOf(this.highlightId);
    const next = i < 0 ? (dir > 0 ? 0 : targets.length - 1) : (i + dir + targets.length) % targets.length;
    const id = targets[next];
    this.highlightId = id;
    this.ctx.characters.highlight(id);
    this.ctx.audio.sfx("hover", { volume: 0.6, pan: this.spots.pan(id) });
    this.attendHead(id, 1.1, 0.85, 2);
    return id;
  }

  /** The target Space / Enter would confirm right now (highlighted, or the only one). */
  targetChoice(): string | null {
    if (this.targetMode !== "me") return null;
    const targets = validTargets(this.s);
    if (this.highlightId && targets.includes(this.highlightId)) return this.highlightId;
    return targets.length === 1 ? targets[0] : null;
  }

  // =================================================================== attacks
  attack(m: AttackMsg): void {
    this.ctx.later.after(this.afterFlip(), FLIP_MAX_MS, () => this.attackLanded(m));
  }

  private attackLanded(m: AttackMsg): void {
    const c = this.ctx;
    const s = this.s;
    const myId = this.myId;
    this.setTargeting("");
    const from = m.fromId;
    const target = m.targetId;
    const fromAt = this.stackOr(from);
    const targetAt = target ? this.stackOr(target) : null;
    const iPaid = m.card === "haracTuru" && m.payers.some((p) => p.playerId === myId && p.amount > 0);
    // First person: whoever hit me gets a look.
    if ((target && target === myId) || iPaid) this.attendHead(from, 1.2, 0.8, 2);

    switch (m.card) {
      case "harac": {
        if (!targetAt) break;
        const token = c.display.hold({ turnPot: m.pot - m.amount }, 1600);
        c.audio.sfx("whoosh");
        this.float(targetAt, money(-m.amount, true), RED);
        c.characters.react(target, "angry");
        c.characters.react(from, "laugh");
        c.later.after(c.fx.chips(targetAt, fromAt, chipCount(m.amount, 10, 3, 14), feed.colorOf(s, target)), 1500, () => {
          c.display.release(token);
          this.float(fromAt, money(m.amount, true), GREEN);
          c.audio.sfx("coins");
          this.voices.say("hah", from);
        });
        break;
      }
      case "haracTuru": {
        const token = c.display.hold({ turnPot: m.pot - m.amount }, 1700);
        const flights: Promise<unknown>[] = [];
        m.payers.forEach((p, i) => {
          if (p.amount <= 0) return;
          const pAt = this.stackOr(p.playerId);
          c.later.run(i * 110, () => {
            this.float(pAt, money(-p.amount, true), RED);
            c.characters.react(p.playerId, "angry");
          });
          flights.push(Promise.resolve(c.fx.chips(pAt, fromAt, 3, feed.colorOf(s, p.playerId))));
        });
        c.audio.sfx("chips");
        c.characters.react(from, "laugh");
        c.later.after(Promise.all(flights), 1600, () => {
          c.display.release(token);
          if (m.amount > 0) this.float(fromAt, money(m.amount, true), GREEN);
          c.audio.sfx("coins");
          this.voices.say("laugh", from, { volume: 0.6 });
        });
        break;
      }
      case "tuzak": {
        const at = (target && this.spots.head(target)) || targetAt;
        this.float(at, "🪤 TUZAK", RED);
        c.audio.sfx("stamp");
        if (target) c.characters.react(target, "nervous");
        c.characters.react(from, "laugh");
        this.voices.say("hah", from);
        break;
      }
      case "lanet": {
        const at = (target && this.spots.head(target)) || targetAt;
        if (at) c.fx.smoke(at);
        this.float(at, "🧿 LANET", PURPLE);
        c.audio.sfx("cymbal", { volume: 0.4, rate: 0.7 });
        c.audio.sfx("boo", { volume: 0.4 });
        if (target) c.characters.react(target, "shock");
        c.characters.react(from, "laugh");
        break;
      }
      case "takas": {
        if (!targetAt) break;
        // The card banner already named it; the swap itself is chips both ways + both owners' floats.
        c.audio.sfx("whoosh");
        c.later.run(120, () => c.audio.sfx("whoosh", { rate: 0.8 }));
        void c.fx.chips(fromAt, targetAt, 10, feed.colorOf(s, from));
        void c.fx.chips(targetAt, fromAt, 10, feed.colorOf(s, target));
        c.stage.shake(0.3, 0.35);
        c.later.run(700, () => {
          this.float(fromAt, money(m.amount, true), m.amount >= 0 ? GREEN : RED);
          this.float(targetAt, money(-m.amount, true), m.amount <= 0 ? GREEN : RED);
          c.characters.react(from, m.amount >= 0 ? "cheer" : "angry");
          c.characters.react(target, m.amount >= 0 ? "angry" : "cheer");
          this.react(this.others(from, target), "shock");
          this.voices.say("yokArtik", target);
        });
        break;
      }
    }
    // The feed only for attacks on / by me (the floats told everyone else's).
    if (from === myId || target === myId || iPaid) this.line(feed.attackLine(s, m, myId));
  }

  // ===================================================================== wheel
  wheelStart(m: WheelStartMsg): void {
    const c = this.ctx;
    // Start NOW: the slice must land exactly when WHEEL_RESULT arrives.
    void c.wheel.spin(m.slice, m.descendMs, m.spinMs, m.turns, (speed) => c.audio.wheelTick(speed));
    this.wheelDown = true;
    c.later.run(m.descendMs, () => {
      c.dealer.spinWheel();
      c.audio.sfx("drumroll", { volume: 0.7 });
    });
    if (m.spin > 1) {
      // "BİR DAHA!" was already told by the previous result.
      this.react([m.playerId, ...this.others(m.playerId)], "shock", 40);
      return;
    }
    // The card banner said "PATRONUN ÇARKI"; the wheel itself is the show now (lights out, camera up).
    c.later.after(this.afterFlip(), FLIP_MAX_MS, () => {
      this.director.setWheel(true);
      c.stage.setLightsOut(true);
      c.audio.sfx("cymbal", { volume: 0.6 });
      this.react([m.playerId, ...this.others(m.playerId)], "shock", 80);
    });
  }

  wheelResult(m: WheelResultMsg): void {
    const c = this.ctx;
    const s = this.s;
    const myId = this.myId;
    const id = m.playerId;
    const slice = WHEEL_SLICE_BY_ID[m.slice];
    const at = this.stackOr(id);
    const others = this.others(id);
    const who = feed.subject(s, id, myId);
    const gain = m.deltas.find((d) => d.playerId === id)?.delta ?? 0;
    c.wheel.celebrate(m.slice);
    c.audio.sfx("wheelStop");
    c.stage.punch(0.18);

    // Money deltas: one float per owner, at their own stack.
    const floats = (delay: number, skip?: string) =>
      c.later.run(delay, () => {
        for (const d of m.deltas) {
          if (d.delta === 0 || d.playerId === skip) continue;
          this.float(this.stackOr(d.playerId), money(d.delta, true), d.delta > 0 ? GREEN : RED);
        }
      });

    switch (m.slice) {
      case "kumbara": {
        const k = this.spots.kumbara();
        c.stage.pulseKumbara("burst");
        c.fx.glassBurst(k);
        c.audio.sfx("glassBreak");
        c.stage.shake(0.75, 0.8);
        // JACKPOT is a turn outcome: the slam names the winner and the amount (no extra float for them).
        c.fx.slam("JACKPOT!", GOLD, `${who} · ${money(gain, true)}`);
        c.fx.confetti(1);
        this.attendPoint(k.clone(), 1.6, 1, 3);
        c.later.run(250, () => {
          void c.fx.chips(k, at, 16, GOLD);
          c.fx.moneyRain(at, Math.max(100, gain));
          c.audio.sfx("kaching");
          c.audio.sfx("coins");
        });
        c.characters.react(id, "cheer");
        this.react(others, "shock");
        c.later.run(1100, () => this.react(others, "sad"));
        this.voices.say("yokArtik", others[0] ?? null);
        floats(700, id);
        break;
      }
      case "x10":
        c.hud.banner("POT ×10!", PURPLE, `${who} · tur potu ${money(m.pot)}`);
        c.fx.moneyRain(at, m.pot);
        c.audio.sfx("kaching");
        c.audio.sfx("choir", { volume: 0.7 });
        c.characters.react(id, "cheer");
        this.react(others, "shock");
        this.voices.say("ooh", others[0] ?? null);
        break;
      case "herkese100":
        c.hud.banner("HERKESE 100$!", GREEN, "Patron cömert bugün");
        m.deltas.forEach((d, i) => {
          if (d.delta <= 0) return;
          c.later.run(i * 120, () => c.fx.moneyRain(this.stackOr(d.playerId), d.delta));
        });
        c.audio.sfx("coins");
        c.later.run(200, () => c.audio.sfx("kaching", { volume: 0.7 }));
        this.react([id, ...others], "cheer", 60);
        floats(400);
        break;
      case "karistir": {
        c.hud.banner("KASALAR KARIŞTI!", PALETTE.neonPink, "Zengin fakir, fakir zengin!");
        const center = this.spots.center();
        const ids = m.deltas.map((d) => d.playerId);
        ids.forEach((pid) => void c.fx.chips(this.stackOr(pid), center, 5, feed.colorOf(s, pid)));
        c.audio.sfx("whoosh");
        c.later.run(650, () => {
          ids.forEach((pid) => void c.fx.chips(center, this.stackOr(pid), 5, feed.colorOf(s, pid)));
          c.audio.sfx("whoosh", { rate: 0.85 });
          c.audio.sfx("chips");
        });
        c.later.run(1300, () => {
          for (const d of m.deltas) c.characters.react(d.playerId, d.delta > 0 ? "cheer" : d.delta < 0 ? "angry" : "shock");
          this.voices.say("yokArtik", ids[0] ?? null);
        });
        floats(1300);
        break;
      }
      case "herkeseOde": {
        c.hud.banner("HERKESE 50$ ÖDE!", "#FF8A3D", id === myId ? "Hayırsever oldun, istemeden" : `${who} herkese dağıtıyor`);
        let i = 0;
        for (const d of m.deltas) {
          if (d.playerId === id || d.delta <= 0) continue;
          const to = this.stackOr(d.playerId);
          c.later.run(i++ * 110, () => void c.fx.chips(at, to, 4, feed.colorOf(s, id)));
        }
        c.audio.sfx("chips");
        c.characters.react(id, "sad");
        this.react(others, "laugh");
        this.voices.say("laugh", others[0] ?? null);
        floats(600);
        break;
      }
      case "avukat":
        c.hud.banner("BEDAVA AVUKAT!", BLUE, "Bu tur ve sonraki tur korumalı");
        c.characters.lawyer(id);
        c.audio.sfx("paper");
        c.characters.react(id, "happy");
        this.react(others, "angry");
        break;
      case "topluBaskin": {
        c.hud.banner("TOPLU BASKIN!", RED, "Herkes cebinden kumbaraya!");
        c.audio.sfx("siren", { volume: 0.6 });
        const k = this.spots.kumbara();
        m.deltas.forEach((d, i) => {
          if (d.delta >= 0) return;
          c.later.run(i * 100, () => void c.fx.chips(this.stackOr(d.playerId), k, chipCount(-d.delta, 10, 2, 8), feed.colorOf(s, d.playerId)));
        });
        c.later.run(750, () => {
          c.stage.pulseKumbara("in");
          c.audio.sfx("chips");
        });
        this.react([id, ...others], "angry", 60);
        floats(300);
        break;
      }
      case "birDaha":
        c.hud.banner("BİR DAHA!", "#2EC4B6", "Çark yeniden dönüyor!");
        c.audio.sfx("cymbal");
        this.react([id, ...others], "shock", 40);
        break;
    }
    if (!slice) return;
    if (!m.again) c.later.run(WHEEL_HOLD_SEC * 1000, () => this.raiseWheel());
  }

  /** Hoist the wheel back and turn the lights on (idempotent). */
  raiseWheel(): void {
    const c = this.ctx;
    if (this.wheelDown || this.director.wheelActive || c.wheel.down) {
      this.wheelDown = false;
      c.wheel.raise();
      c.stage.setLightsOut(false);
    }
    this.director.setWheel(false);
  }

  // ==================================================================== result
  cashed(m: CashedMsg): void {
    const arrived = performance.now();
    this.ctx.later.after(this.afterFlip(), FLIP_MAX_MS, () => this.cashLanded(m, (performance.now() - arrived) / 1000));
  }

  /** `waited`: seconds already spent waiting for the card to land (the result phase is running meanwhile). */
  private cashLanded(m: CashedMsg, waited: number): void {
    const c = this.ctx;
    const s = this.s;
    const id = m.playerId;
    if (m.skipped) {
      // Nothing on the table tells this one: the feed does.
      this.line(feed.cashLine(s, m, this.myId));
      c.audio.sfx("pop", { volume: 0.4 });
      return;
    }
    const who = feed.subject(s, id, this.myId);
    const at = this.stackOr(id);
    const big = m.pot >= BIG_CASH;
    c.characters.gesture(id, "slam");
    c.characters.cash(id, big, m.resultSec > 0 ? Math.max(1, m.resultSec - waited) : undefined);
    if (m.auto && m.flips === 0) {
      c.fx.slam("SÜRE DOLDU", PALETTE.cream, `${who} · sıra yandı`);
      c.audio.sfx("timeout", { volume: 0.6 });
    } else if (m.pot > 0) {
      c.audio.sfx("kaching");
      c.later.run(160, () => c.audio.sfx("coins"));
      // §14: the turn's cards turn into chips that fly from the row onto the stack.
      const row = this.rowAt;
      if (c.cards.rowCenter(row)) void c.fx.chips(row, at, chipCount(m.pot, 10, 4, 20), feed.colorOf(s, id));
      c.cards.clearTurn(at);
      c.fx.moneyRain(at, m.pot);
      if (m.pot >= SMALL_CASH) c.fx.confetti(clamp(m.pot / 300, 0.25, 1));
      c.fx.slam("KASALA!", GREEN, `${who} · ${money(m.pot, true)}${m.auto ? " · süre doldu" : ""}`);
      c.stage.punch(big ? 0.25 : 0.12);
    } else {
      c.fx.slam("KASALA!", PALETTE.cream, `${who} · eli boş`);
      c.audio.sfx("boo", { volume: 0.4 });
    }
    // Taşlık: half the pot flies straight to the creditors (their own floats).
    m.taslikCut.forEach((cut, i) => {
      if (cut.amount <= 0) return;
      c.later.run(800 + i * 150, () => {
        const to = this.stackOr(cut.lenderId);
        void c.fx.chips(at, to, chipCount(cut.amount, 10, 2, 8), feed.colorOf(s, id));
        this.float(to, `⛓ ${money(cut.amount, true)}`, GREEN);
        c.audio.sfx("chips", { volume: 0.6 });
        c.characters.react(cut.lenderId, "laugh");
      });
    });
    // Bettors: the "Kasalar" box cheers, the raid boxes curse.
    const bettors = new Set<string>();
    s?.bets.forEach((b) => {
      bettors.add(b.playerId);
      c.characters.react(b.playerId, b.box === "cash" ? "cheer" : "angry");
    });
    const rest = this.others(id).filter((x) => !bettors.has(x));
    if (big) {
      this.react(rest, "shock");
      this.voices.say("ooh", rest[0] ?? null);
    } else if (m.flips <= 2 && m.pot > 0) {
      this.react(rest, "laugh");
      this.voices.say("boo", rest[0] ?? null, { volume: 0.45 });
    }
  }

  raided(m: RaidedMsg): void {
    const arrived = performance.now();
    this.ctx.later.after(this.afterFlip(), FLIP_MAX_MS, () => this.raidLanded(m, (performance.now() - arrived) / 1000));
  }

  /** `waited`: seconds already spent waiting for the card to land (the result phase is running meanwhile). */
  private raidLanded(m: RaidedMsg, waited: number): void {
    const c = this.ctx;
    const s = this.s;
    const id = m.playerId;
    const mine = id === this.myId;
    const at = this.stackOr(id);
    const seat = this.spots.seat(id);
    const full = m.resultSec > 0 ? m.resultSec : m.long ? RAID_RESULT_SEC : RAID_RESULT_SHORT_SEC;
    // What is left of the server's result phase: the choreography must fit it.
    const sec = Math.max(1.5, full - waited);
    // Beat times below were tuned for the full door sequence; a quick raid plays them faster.
    const k = clamp(sec / RAID_RESULT_SEC, 0.5, 1.2);
    const lost = m.potLost + m.bribe;

    // The one place the raid is told: who got raided and what it cost them (pot + bribe), in one number.
    const who = feed.subject(s, id, this.myId);
    c.fx.slam("BASKIN!", RED, lost > 0 ? `${who} · ${money(-lost, true)}` : `${who} · Komiser Rıfat iş başında`);
    c.characters.raid(id, m.anim, { long: m.long, sec });
    c.fx.flash(PALETTE.police, m.long ? 0.5 : 0.32);
    c.stage.shake(m.long ? 0.6 : 0.35, m.long ? 0.5 : 0.35);

    if (m.long) {
      // Full sequence: the door flies open, Komiser Rıfat walks in. The shot frames the door AND the raided
      // seat (Stage uses the seat), held while the arrest and the drag-out happen.
      c.stage.breakDoor();
      c.audio.sfx("doorBreak");
      c.later.run(140, () => c.audio.sfx("siren"));
      this.director.overrideFor("door", seat, clamp(sec - 1.4, 1.6, 4.5));
      c.dealer.hide(true);
      c.later.run(sec * 1000 - 300, () => c.dealer.hide(false));
    } else {
      c.audio.sfx("siren", { volume: 0.7 });
    }

    // First person.
    if (mine) {
      // My own avatar is walked out (cuffs / sack): watch it from the Masa camera, back in my chair after.
      if (m.long && (m.anim === "kelepce" || m.anim === "cuval")) c.stage.outOfBody(Math.max(1, sec - 0.8));
    } else if (!m.long) {
      // (The long sequence needs no beat here: Stage turns the door focus into door → raided player.)
      this.attendHead(id, Math.max(1, sec - 0.6), 0.7, 2);
    }

    // Sounds on the Characters choreography's fixed beats (scene/characters/sequences.ts): the long kelepçe's
    // cuffs click at RAID_CUFFS_AT from every seat, the quick one at ~0.85 s; the sack drops at ~1.4 s (long) /
    // ~0.5 s (quick); the wallet opens at 1.0 s (its moths are Characters' particles); the mugshot flash is at
    // 0.75 s in both versions.
    switch (m.anim) {
      case "kelepce":
        c.later.run(m.long ? RAID_CUFFS_AT * 1000 : 850, () => c.audio.sfx("cuffs"));
        break;
      case "cuval":
        c.later.run(m.long ? 1400 : 500, () => c.audio.sfx("sack"));
        break;
      case "bosCuzdan":
        c.later.run(1000, () => c.audio.sfx("moths"));
        break;
      case "sabika":
        c.later.run(750, () => {
          c.audio.sfx("cameraFlash");
          c.fx.flash("#FFFFFF", 0.9);
          const p = this.s?.players.get(id);
          if (p) c.overlays.mugshot(p);
        });
        break;
    }

    // The money leaves the stack for the kumbara (the slam already said how much: no second number).
    c.later.run(1000 * k, () => {
      if (lost <= 0) return;
      void c.fx.chips(at, this.spots.kumbara(), chipCount(lost, 12, 3, 12), feed.colorOf(s, id));
      c.audio.sfx("chips", { volume: 0.6 });
      c.later.run(650, () => c.stage.pulseKumbara("in"));
    });
    // Bettors who called it cheer; the rest of the table laughs (the friendship is over).
    c.later.run(1300 * k, () => {
      const bettors = new Set<string>();
      s?.bets.forEach((b) => {
        bettors.add(b.playerId);
        const wins = boxWins(b.box, { raided: true, raidFlip: m.flipNo });
        c.characters.react(b.playerId, wins ? "cheer" : "sad");
      });
      this.react(this.others(id).filter((x) => !bettors.has(x)), "laugh", 90);
      this.voices.say("laugh", this.others(id)[0] ?? null, { volume: 0.7 });
    });
  }

  // ====================================================================== bets
  betsSettled(m: BetsSettledMsg): void {
    const c = this.ctx;
    const s = this.s;
    const myId = this.myId;
    // My own result is the BetPanel's (one shout there); others get their chips and a float at their stack.
    c.hud.betsSettled(m, myId);
    const center = this.spots.center();
    const kumbara = this.spots.kumbara();
    let anyWin = false;
    let anyLoss = false;
    m.results.forEach((r, i) => {
      const at = this.stackOr(r.playerId);
      const color = feed.colorOf(s, r.playerId);
      const mine = r.playerId === myId;
      c.later.run(200 + i * 140, () => {
        if (r.won) {
          if (!r.ghost && r.delta > 0) {
            void c.fx.chips(center, at, chipCount(r.delta, 15, 3, 12), color);
            if (!mine) this.float(at, money(r.delta, true), GREEN);
          } else if (r.ghost && !mine) this.float(this.spots.head(r.playerId) ?? at, "👻 ✓", GREEN);
          c.characters.react(r.playerId, "cheer");
        } else {
          if (!r.ghost && r.amount > 0) void c.fx.chips(at, kumbara, chipCount(r.amount, 10, 2, 6), color);
          c.characters.react(r.playerId, "sad");
        }
      });
      if (r.won) anyWin = true;
      else anyLoss = true;
    });
    if (anyWin) c.later.run(250, () => c.audio.sfx("chips"));
    if (anyLoss) c.later.run(420, () => c.audio.sfx("chipCrack", { volume: 0.7 }));
    if (m.houseCut > 0) {
      c.later.run(700, () => {
        const at = this.stackOr(m.activeId);
        void c.fx.chips(kumbara, at, chipCount(m.houseCut, 5, 2, 6), GOLD);
        if (m.houseCut >= HOUSE_CUT_FLOAT_MIN) this.float(at, `${money(m.houseCut, true)} ev payı`, GOLD);
        c.characters.react(m.activeId, "laugh");
      });
    }
    if (m.toKumbara > 0) c.later.run(900, () => c.stage.pulseKumbara("in"));

    const mine = m.results.find((r) => r.playerId === myId);
    if (mine?.ghost) this.line(feed.ghostBetLine(mine.won, me(s, myId)?.ghostWins ?? 0));
    else if (mine?.won) c.later.run(300, () => c.audio.sfx("kaching"));
  }

  // ===================================================================== loans
  loan(m: LoanMsg): void {
    const c = this.ctx;
    const s = this.s;
    const myId = this.myId;
    const involved = m.fromId === myId || m.toId === myId;
    // A proposal pops up as an offer card for everyone; unanswered / withdrawn ones only matter to the two.
    const tell = m.event === "proposed" ? false : m.event === "expired" || m.event === "canceled" ? involved : true;
    if (tell) this.line(feed.loanLine(s, m, myId));
    const { lender, borrower } = feed.loanSides(m);
    switch (m.event) {
      case "proposed":
        c.audio.sfx(m.toId === myId ? "open" : "pop", { volume: 0.7 });
        c.characters.react(m.fromId, m.kind === "offer" ? "happy" : "nervous");
        break;
      case "accepted": {
        const from = this.stackOr(lender);
        const to = this.stackOr(borrower);
        void c.fx.chips(from, to, chipCount(m.amount, 15, 3, 12), feed.colorOf(s, lender));
        c.audio.sfx("chips");
        c.later.run(350, () => c.audio.sfx("stamp"));
        c.later.run(600, () => this.float(to, money(m.amount, true), GREEN));
        c.characters.react(lender, "laugh");
        c.characters.react(borrower, "happy");
        break;
      }
      case "declined":
        c.audio.sfx(involved ? "deny" : "boo", { volume: 0.5 });
        c.characters.react(m.fromId, "angry");
        c.characters.react(m.toId, "laugh");
        break;
      case "repaid":
      case "paidOff": {
        void c.fx.chips(this.stackOr(borrower), this.stackOr(lender), chipCount(m.amount, 15, 2, 10), feed.colorOf(s, borrower));
        c.audio.sfx("chips");
        if (m.event === "paidOff") {
          c.later.run(400, () => c.audio.sfx("kaching", { volume: 0.7 }));
          c.characters.react(borrower, "cheer");
          c.characters.react(lender, "sad");
        }
        break;
      }
      case "expired":
      case "canceled":
        break;
    }
  }

  taslik(m: TaslikMsg): void {
    const c = this.ctx;
    this.line(feed.taslikLine(this.s, m, this.myId));
    if (m.on) {
      c.audio.sfx("cuffs", { volume: 0.7 });
      c.characters.react(m.playerId, "sad");
    } else {
      c.audio.sfx("pop");
      c.characters.react(m.playerId, "cheer");
    }
  }

  roundEnd(m: RoundEndMsg): void {
    const c = this.ctx;
    for (const l of feed.roundEndLines(this.s, m, this.myId)) c.hud.feed(l[0], l[1]);
    if (m.interest.some((i) => i.after > i.before)) c.audio.sfx("tick", { volume: 0.5 });
    if (m.finalTableNext) {
      c.later.run(400, () => {
        c.hud.banner("SON MASA", RED, "Her şey ×2: kazanç da, ceza da!");
        c.audio.sfx("cymbal");
        c.audio.sfx("drumroll", { volume: 0.6 });
        this.react(this.others(), "nervous", 80);
      });
    }
  }

  // ==================================================================== royale
  lastChance(m: LastChanceMsg): void {
    const c = this.ctx;
    // The HUD's last chance panel tells it (from state).
    c.audio.sfx("siren", { volume: 0.45 });
    c.characters.react(m.playerId, "nervous");
    this.attendHead(m.playerId, 2, 0.6);
    if (m.playerId === this.myId && this.s?.settings.loans) c.later.run(600, () => c.overlays.toggleLoans(true));
  }

  saved(m: SavedMsg): void {
    const c = this.ctx;
    this.line(feed.savedLine(this.s, m, this.myId));
    this.float(this.spots.head(m.playerId) ?? this.stackOr(m.playerId), "KURTULDU!", GREEN);
    c.audio.sfx("kaching");
    c.characters.react(m.playerId, "cheer");
    c.characters.react(m.lenderId, "laugh");
  }

  eliminated(m: EliminatedMsg): void {
    const c = this.ctx;
    const s = this.s;
    const mine = m.playerId === this.myId;
    // Mine: Characters hands the camera to Masa for the river walk (a timed outOfBody), and from then on the
    // ghost flag keeps first person off (Game.syncView), so a missed GHOST_RETURN can never strand the camera.
    c.characters.eliminate(m.playerId);
    // Mine: the ghost rules (nothing else explains them). Others: the banner below tells it.
    if (mine) this.line(feed.eliminatedLine(s, m, this.myId));
    else this.attendHead(m.playerId, 2.4, 0.7, 2);
    c.audio.sfx("drumroll", { volume: 0.5 });
    this.react(this.others(m.playerId), "shock", 80);
    c.later.run(2600, () => {
      const at = this.spots.part(m.playerId, "chest") ?? this.stackOr(m.playerId);
      c.fx.splash(at);
      c.audio.sfx("splash");
      c.hud.banner("ŞLAP!", BLUE, `${feed.subject(s, m.playerId, this.myId)} nehirde · ${m.remaining} kişi kaldı`);
      this.react(this.others(m.playerId), "laugh", 90);
      this.voices.say("ooh", this.others(m.playerId)[0] ?? null);
    });
  }

  ghostReturn(m: GhostReturnMsg): void {
    const c = this.ctx;
    c.characters.ghostReturn(m.playerId);
    if (m.playerId === this.myId) c.stage.outOfBody(0);
    c.audio.sfx("splash", { volume: 0.7 });
    c.later.run(300, () => this.voices.say("ooh", this.others(m.playerId)[0] ?? null));
    c.hud.banner("NEHİRDEN DÖNDÜ!", GREEN, `${feed.subject(this.s, m.playerId, this.myId)} yeniden masada`);
    this.float(this.spots.head(m.playerId) ?? this.stackOr(m.playerId), money(m.kasa, true), GREEN);
    this.react(this.others(m.playerId), "shock");
  }

  // ==================================================================== social
  emoted(m: EmotedMsg): void {
    const c = this.ctx;
    if (!this.spots.seated(m.playerId)) {
      // A spectator has no seat (and no character): the feed is the only place this shows.
      const em = EMOTES.find((e) => e.id === m.emote);
      if (em) this.line(feed.spectatorEmoteLine(this.s, m.playerId, em.icon, em.label, this.myId));
      c.audio.sfx(EMOTE_SFX[m.emote] ?? "pop", { volume: 0.5 });
      return;
    }
    c.characters.emote(m.playerId, m.emote);
    c.audio.sfx(EMOTE_SFX[m.emote] ?? "pop", { pan: this.spots.pan(m.playerId), volume: 0.8 });
    // (The cigar smoke comes from the Characters clip itself, from the lips toward a rival.)
    switch (m.emote) {
      case "yumruk":
        // The fist lands on the rail at 0.3 s.
        c.later.run(300, () => c.stage.shake(0.18, 0.25));
        break;
      case "agla":
        this.react(this.others(m.playerId).slice(0, 2), "laugh", 150);
        break;
      default:
        break;
    }
  }

  taunted(m: TauntedMsg): void {
    const c = this.ctx;
    const s = this.s;
    const text = TAUNTS[m.index];
    if (text === undefined) return;
    const seated = this.spots.seated(m.playerId);
    // A heckle at the player whose turn it is: the crowd shouts, and the active player sees who.
    const kind = heckleKind(m.index);
    const heckled = !!kind && !!s && s.phase === "flipping" && m.playerId !== s.activeId;
    if (heckled && kind && s) {
      c.audio.heckle(kind);
      if (s.activeId === this.myId) c.hud.heckle(feed.nameText(s, m.playerId), kind);
    }
    if (!seated) {
      // Spectators have no bubble at the table: the feed carries their line.
      this.line(feed.tauntLine(s, m.playerId, text, this.myId));
      return;
    }
    c.characters.taunt(m.playerId, text);
    if (!heckled) this.voices.say(Math.random() < 0.5 ? "hah" : "yokArtik", m.playerId, { volume: 0.45 }, 300);
  }

  // ================================================================ match end
  setMatchEnd(m: MatchEndMsg | null): void {
    this.matchEnd = m;
  }

  /** Overlays.onStep: drive the 3D side of the match-end sequence. */
  matchEndStep(step: "collections" | "title" | "podium", index: number): void {
    const c = this.ctx;
    const m = this.matchEnd;
    const s = this.s;
    if (step === "collections") {
      this.director.setEndShot("table");
      (m?.collections ?? []).forEach((col, i) => {
        c.later.run(300 + i * 400, () => {
          if (col.paid > 0) {
            void c.fx.chips(this.stackOr(col.borrowerId), this.stackOr(col.lenderId), chipCount(col.paid, 15, 2, 10), feed.colorOf(s, col.borrowerId));
            c.audio.sfx("chips", { volume: 0.7 });
            c.characters.react(col.lenderId, "laugh");
          }
          if (col.wiped > 0) {
            c.later.run(350, () => c.audio.sfx("stamp"));
            c.characters.react(col.borrowerId, "shock");
          }
        });
      });
      return;
    }
    if (step === "title") {
      const t = m?.titles[index];
      if (!t) return;
      const seat = s?.players.get(t.playerId)?.seat;
      this.director.setEndShot(seat === undefined ? "table" : "seat", seat);
      c.audio.sfx("stamp");
      c.characters.react(t.playerId, t.title === "gozuKara" ? "laugh" : "sad");
      this.react(this.others(t.playerId), "laugh", 70);
      this.voices.say("laugh", this.others(t.playerId)[0] ?? null, { volume: 0.6 });
      return;
    }
    // podium
    const order = (m?.standings ?? [])
      .slice()
      .sort((a, b) => a.place - b.place)
      .map((x) => x.playerId);
    if (order.length) c.characters.podium(order);
    this.director.setEndShot("podium");
    c.fx.confetti(1);
    c.audio.sfx("cymbal");
    c.later.run(300, () => c.audio.sfx("kaching"));
    if (order[0]) c.characters.react(order[0], "cheer");
    if (order.length > 1) c.characters.react(order[order.length - 1], "sad");
  }

  // ============================================================ per-patch watch
  /** Live little reactions from the displayed state: dead bet boxes, siren tiers, decision clock ticks. */
  watch(v: KasalaStateView): void {
    const c = this.ctx;
    const myId = this.myId;
    if (v.phase !== "flipping" && v.phase !== "targeting") {
      this.lastTick = -1;
      if (v.phase !== "wheel") this.sirenTier = 0;
      return;
    }
    // Bets that can no longer win (§8: "kararan kutular").
    v.bets.forEach((b) => {
      if (this.deadBets.has(b.playerId) || boxAlive(b.box, v.flips)) return;
      this.deadBets.add(b.playerId);
      c.characters.react(b.playerId, "sad");
      this.voices.say(b.playerId === myId ? "boo" : "yokArtik", b.playerId, { volume: 0.5 }, 250);
    });
    // Siren tiers: the table holds its breath.
    const ch = v.raidChance;
    const tier = ch >= SIREN_SHAKE_CHANCE ? 3 : ch >= SIREN_CRITICAL_CHANCE ? 2 : ch >= SIREN_MID_CHANCE ? 1 : 0;
    if (tier > this.sirenTier) {
      if (tier >= 2) {
        this.react([v.activeId, ...this.others(v.activeId)], "nervous", 60);
        c.audio.sfx("heartbeat", { volume: tier >= 3 ? 0.8 : 0.55 });
      } else {
        this.react(this.others(v.activeId), "nervous", 80);
      }
    }
    this.sirenTier = tier;
    // Decision clock: tick tock in the last seconds (not before the first card: that timer flips for you).
    const mine = v.activeId === myId;
    if (!v.busy && v.timeTotal > 0 && v.flips > 0 && (v.phase === "flipping" || mine)) {
      const sec = Math.ceil(v.timeLeft);
      if (sec > 0 && sec <= 3 && sec !== this.lastTick) {
        this.lastTick = sec;
        c.audio.sfx("tick", { volume: mine ? 0.9 : 0.3, rate: 1 + (3 - sec) * 0.12 });
      } else if (sec > 3) this.lastTick = -1;
    }
  }
}

/** Banner sub-line for a card: its rule (attacks, protection, the wheel) or its rarity (money). */
function bannerSub(kind: string, m: CardMsg): string {
  switch (kind) {
    case "money":
    case "multiplier":
      return `${RARITIES[m.rarity]?.label ?? ""} kart`;
    default:
      return feed.cardValueText(m);
  }
}
