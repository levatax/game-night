// Net event → visuals / audio / chef reactions. Owner: client-game.
// Pure "show it" code: no game decisions here, Game.ts owns the state machine and the feed calls.

import * as THREE from "three";
import { CAKE_TOP_Y, CARD_BY_ID, PIECES, RARITY_COLORS, type EmoteId, type Rarity } from "../../../shared/constants";
import type {
  BetsMsg,
  EmotedMsg,
  HiccupMsg,
  ImpactMsg,
  JellyStateView,
  ResultMsg,
  RevealMsg,
  SpinResultMsg,
  ToppleMsg,
} from "../../../shared/protocol";
import type { Voice } from "../audio/AudioEngine";
import { localToWorld, screenOf, type Ctx, type Later } from "./context";
import { fmtDelta, fmtMult } from "./feed";

const EMOTE_VOICE: Record<EmoteId, Voice> = { cheer: "yes", gasp: "gasp", point: "hmm", laugh: "haha" };
const EMOTE_EMOJI: Record<EmoteId, string> = { cheer: "🎉", gasp: "😱", point: "👉", laugh: "🤣" };

const TIMBER = ["TIMBER!", "TIMBERRR!", "KA-SPLAT!", "OH NO!"];
const DING = ["DING!", "TA-DA!", "IT STANDS!", "DING DING!"];
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

const tmp = new THREE.Vector3();

function seedOf(state: JellyStateView | null, id: string): number {
  return state?.players.get(id)?.color ?? 0;
}

/** World point at the tower top (coins / confetti origin). */
function towerTop(ctx: Ctx, state: JellyStateView | null): THREE.Vector3 {
  const h = Math.max(0, (state?.towerHeightCm ?? 0) / 100);
  return localToWorld(ctx.stage, 0, CAKE_TOP_Y + h + 0.05, 0);
}

// -------------------------------------------------------------------------- the case
/** The reel stopped: stingers, edge glow, neon sign, jackpot / cursed theatrics. */
export function caseLanded(ctx: Ctx, state: JellyStateView | null, msg: SpinResultMsg, myId: string): void {
  const def = CARD_BY_ID[msg.card];
  const rarity = msg.rarity as Rarity;
  const color = RARITY_COLORS[rarity] ?? "#FFFFFF";
  const { fx, audio, stage, chefs, hud } = ctx;
  stage.setSign(`${def?.emoji ?? "🎰"} ${def?.name ?? msg.card} ${fmtMult(msg.multiplier)}`, color);
  fx.edgeGlow(color, rarity === "legendary" || rarity === "cursed" ? 2 : 1.1);
  audio.sfx("cardFlip");

  if (rarity === "legendary") {
    audio.stinger("legendary");
    audio.sfx("kaching");
    stage.jackpotLights(3);
    fx.coinShower(2.5);
    fx.popText("JACKPOT!", "big");
    chefs.reactAll("cheer");
  } else if (rarity === "cursed") {
    audio.stinger("cursed");
    audio.sfx("recordScratch");
    fx.flash(color, 0.35);
    stage.shake(0.35, 0.4);
    fx.popText("CURSED!", "bad");
    chefs.reactAll("gasp", msg.playerId);
    chefs.react(msg.playerId, "gasp");
    audio.voice("noo", seedOf(state, msg.playerId));
  } else if (rarity === "rare") {
    audio.sfx("ding");
    chefs.reactAll("gasp", msg.playerId);
  }

  const mine = msg.playerId === myId;
  const tone = rarity === "legendary" ? "gold" : rarity === "cursed" ? "bad" : rarity === "common" ? "neutral" : "good";
  if (def) hud.banner(mine ? `${def.emoji} ${def.name}! ${def.text}` : `${def.emoji} ${def.name} ${fmtMult(msg.multiplier)}`, tone);
}

// ------------------------------------------------------------------------- settling
let lastPuffAt = 0;

export function impact(ctx: Ctx, msg: ImpactMsg): void {
  const def = PIECES[msg.type];
  if (def) ctx.audio.impact(def.sound, msg.speed);
  ctx.tower.squish(msg.pieceId, Math.min(1, msg.speed / 3));
  const now = performance.now();
  if (msg.speed > 1 && now - lastPuffAt > 120) {
    lastPuffAt = now;
    ctx.fx.puff(localToWorld(ctx.stage, msg.x, msg.y, msg.z), Math.min(1, msg.speed / 4));
  }
}

export function hiccup(ctx: Ctx, state: JellyStateView | null, msg: HiccupMsg): void {
  ctx.audio.sfx("hic");
  const h = state?.hover;
  const at = h && h.active ? screenOf(ctx.stage, localToWorld(ctx.stage, h.x, h.y + 0.12, h.z)) : undefined;
  ctx.fx.popText(pick(["*hic*", "*HIC*", "*hic!*"]), "small", at);
  ctx.chefs.react(msg.playerId, "gasp");
}

export function topple(ctx: Ctx, state: JellyStateView | null, msg: ToppleMsg, later: Later): void {
  const { fx, audio, stage, chefs } = ctx;
  const where = localToWorld(stage, msg.x, Math.max(0.02, msg.y), msg.z);
  fx.freeze(0.3);
  fx.popText(pick(TIMBER), "big");
  audio.sfx("timber");
  audio.sfx("slideWhistle");
  audio.sfx("ooh");
  audio.stinger("topple");
  stage.shake(0.6, 0.5);
  later.run(320, () => {
    fx.splat(where);
    fx.splat(localToWorld(stage, 0, CAKE_TOP_Y + 0.02, 0));
    audio.sfx("splat");
  });
  // Pie to the face of whoever did it; the rest of the table laughs (or gasps, the softies).
  later.run(650, () => {
    chefs.react(msg.playerId, "pie");
    audio.sfx("pie");
    audio.voice("noo", seedOf(state, msg.playerId));
    state?.players.forEach((p) => {
      if (p.id === msg.playerId || p.spectator) return;
      chefs.react(p.id, Math.random() < 0.7 ? "laugh" : "gasp");
    });
  });
  later.run(900, () => {
    const someone = [...(state?.players.values() ?? [])].find((p) => p.id !== msg.playerId && !p.spectator);
    if (someone) audio.voice("haha", someone.color);
  });
}

// --------------------------------------------------------------------------- result
export function result(ctx: Ctx, state: JellyStateView | null, msg: ResultMsg, later: Later): void {
  const { fx, audio, chefs, hud, stage } = ctx;
  const head = chefs.headPosition(msg.playerId);
  if (msg.outcome === "stand") {
    const from = towerTop(ctx, state);
    fx.popText(pick(DING), "big");
    audio.sfx("ding");
    audio.stinger("stand");
    audio.sfx("partyPopper");
    later.run(250, () => audio.sfx("cheer"));
    fx.confetti(from, msg.multiplier / 5);
    chefs.react(msg.playerId, "cheer");
    audio.voice("yes", seedOf(state, msg.playerId));
    chefs.reactAll("cheer", msg.playerId);
    if (head && msg.delta > 0) {
      const count = Math.max(3, Math.min(24, Math.round(msg.delta / 3)));
      fx.coins(from, head, count, () => audio.sfx("coin"));
      later.run(900, () => {
        audio.sfx("kaching");
        fx.popText(`${fmtDelta(msg.delta)} 🪙`, "coin", screenOf(stage, head));
      });
    }
  } else {
    if (msg.insured) {
      fx.popText("INSURED! 📜", "coin", screenOf(stage, head));
      audio.sfx("kaching");
    } else if (msg.delta !== 0) {
      later.run(700, () => fx.popText(`${fmtDelta(msg.delta)} 🪙`, "bad", screenOf(stage, chefs.headPosition(msg.playerId))));
      audio.sfx("lose");
    }
  }
  if (msg.delta !== 0) hud.coinDelta(msg.playerId, msg.delta);
}

export function bets(ctx: Ctx, state: JellyStateView | null, msg: BetsMsg, myId: string): void {
  const { chefs, hud, audio, fx, stage } = ctx;
  let i = 0;
  for (const b of msg.bets) {
    if (b.amount <= 0) continue;
    hud.coinDelta(b.playerId, b.delta);
    const delay = 350 + i++ * 180;
    setTimeout(() => {
      chefs.react(b.playerId, b.won ? "cheer" : "cry");
      audio.voice(b.won ? "yes" : "noo", seedOf(state, b.playerId));
    }, delay);
    if (b.playerId === myId) {
      const at = screenOf(stage, chefs.headPosition(myId));
      fx.popText(b.won ? `BET WON ${fmtDelta(b.delta)} 🪙` : `BET LOST ${fmtDelta(b.delta)}`, b.won ? "coin" : "bad", at);
      audio.sfx(b.won ? "kaching" : "buzzer");
    }
  }
}

// -------------------------------------------------------------------------- social
export function emoted(ctx: Ctx, state: JellyStateView | null, msg: EmotedMsg): void {
  ctx.chefs.react(msg.playerId, msg.emote);
  ctx.audio.voice(EMOTE_VOICE[msg.emote] ?? "hmm", seedOf(state, msg.playerId));
  const head = ctx.chefs.headPosition(msg.playerId);
  if (head) ctx.fx.popText(EMOTE_EMOJI[msg.emote] ?? "❗", "small", screenOf(ctx.stage, tmp.copy(head).setY(head.y + 0.35)));
}

export function reveal(ctx: Ctx, msg: RevealMsg, later: Later): void {
  ctx.audio.stinger("reveal");
  if (!msg.saboteurId) return;
  // Overlays does its own drumroll + card flip; the devil hat pops a beat later.
  later.run(2600, () => {
    ctx.chefs.react(msg.saboteurId, "devil");
    ctx.audio.sfx("cackle");
    ctx.chefs.reactAll(msg.caught ? "point" : "gasp", msg.saboteurId);
  });
}
