// End-of-match screens + settings + emote wheel + connection banner (DOM). Owner: client-overlays.
// PUBLIC API IS THE CONTRACT. Styles in ./overlays.css (create it, import it here). Tokens from ./theme.css.
//
// - Vote (§13.5): "WHO RIGGED THE CASES?" grid of chef cards (color hat, name, coins); click a suspect (not
//   yourself: disabled), 20 s countdown bar from state.timeLeft/timeTotal, "voted ✓" ticks from player.voted.
//   showVotes(): votes are revealed one by one (arrows/strings from voter to suspect, 400 ms apart, a
//   ba-dum sound callback per vote).
// - Reveal (§13.6): drumroll pause then the Saboteur's card flips: "😈 IT WAS <NAME>!" (or "Nobody! It was
//   just bad luck 🍀" when saboteurId === ""), CAUGHT / ESCAPED stamp, the rig replay list (describe each
//   RigRecord: "Rigged: Deniz's turn, round 3 → Bowling Ball 🎳 (FELL)"), the hidden-bonus math and the
//   coin adjustments list.
// - Podium (§13.7): top 3 on a giant 3-tier cake (CSS), confetti, last place gets a pie 🥧 icon splatted on
//   their card; stats table (survived, topples, best ×, bet profit); host: "Rematch", everyone: "Back to Game
//   Night" (link to /). Non-host sees "Waiting for host…".
// - Settings (Esc) (§13.8): sliders master/music/sfx, camera sensitivity, invert orbit, graphics quality,
//   reduced flashing — bound to `settings` from ../app/settings (settings.set on input). "Leave room".
// - Emote wheel (T held / tap): 4 buttons cheer 🎉 / gasp 😱 / point 👉 / laugh 🤣.
// - Connection banner: "Reconnecting…" / "Disconnected — back to menu".
//
// All user text (nicknames, server reasons) goes in through textContent only: never innerHTML.
// Esc / T keys are owned by client-game / client-controls; this module only listens to 1–4 while the
// emote wheel is open (number-key shortcuts).

import "./overlays.css";
import {
  CARD_BY_ID,
  EMOTES,
  PLAYER_COLORS,
  SABOTEUR_ESCAPE_BONUS,
  SABOTEUR_TOPPLE_BONUS,
  VOTE_CORRECT_REWARD,
} from "../../../shared/constants";
import type { CardId, EmoteId } from "../../../shared/constants";
import type { JellyStateView, PlayerView, RevealMsg, VotesMsg } from "../../../shared/protocol";
import { settings } from "../app/settings";
import type { Quality, Settings } from "../app/settings";

export interface OverlayHandlers {
  onVote(suspectId: string): void;
  onRematch(): void;
  onLeave(): void;
  onEmote(emote: EmoteId): void;
  onUiSound(kind: "click" | "hover" | "pop" | "drum"): void;
}

// ------------------------------------------------------------------ silly copy
const VOTE_SUBTITLES = [
  "Somebody's been fiddling with the cases. Point a floury finger.",
  "One of you is a dirty cake criminal. Who smells like sabotage?",
  "The bowling balls didn't roll in by themselves. J'accuse!",
  "Trust no one. Especially the one humming innocently.",
];
const DRUMROLL_LINES = ["🥁 And the Saboteur was…", "🥁 The culprit is…", "🥁 Unmasking the cake crook…"];
const CAUGHT_QUIPS = [
  "Caught with frosting on their hands!",
  "Straight to cake jail. Do not pass GO.",
  "The kitchen has spoken. Shame. Shame. Shame.",
];
const ESCAPED_QUIPS = [
  "Got clean away, giggling into a napkin.",
  "Nobody suspected the quiet one. Classic.",
  "Escaped out the cat flap with a pocket full of coins.",
];
const NOBODY_QUIPS = [
  "Those cursed cards were 100% organic, free-range bad luck.",
  "No villain. Just gravity, and your terrible stacking.",
];
const WAITING_QUIPS = [
  "Waiting for host… (they're licking the spoon)",
  "Waiting for host… (they're crying into the frosting)",
  "Waiting for host… (they're picking cake out of their hair)",
];
const TIER_LABELS = ["🏆 TOP TIER", "🥈 MIDDLE LAYER", "🥉 BOTTOM SPONGE"];
const EMOTE_META: Record<EmoteId, { emoji: string; label: string }> = {
  cheer: { emoji: "🎉", label: "Cheer" },
  gasp: { emoji: "😱", label: "Gasp" },
  point: { emoji: "👉", label: "Point" },
  laugh: { emoji: "🤣", label: "Laugh" },
};
const QUALITY_META: { id: Quality; emoji: string; label: string }[] = [
  { id: "low", emoji: "🥔", label: "Potato" },
  { id: "medium", emoji: "🍞", label: "Toaster" },
  { id: "high", emoji: "🎩", label: "Fancy" },
];

// --------------------------------------------------------------------- helpers
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const colorOf = (p: PlayerView | undefined): string => PLAYER_COLORS[p?.color ?? 0] ?? PLAYER_COLORS[0];

/** Players in the match (no spectators), by seat. */
function matchPlayers(state: JellyStateView): PlayerView[] {
  const out: PlayerView[] = [];
  state.players.forEach((p) => {
    if (!p.spectator) out.push(p);
  });
  return out.sort((a, b) => a.seat - b.seat);
}

const nameOf = (state: JellyStateView, id: string): string =>
  state.players.get(id)?.nickname || "a mystery chef";

const signed = (n: number): string => (n > 0 ? `+${n}` : `${n}`);

/** Cartoon chef head: colored hat, googly eyes, little mouth. */
function chefAvatar(color: string, size: "s" | "m" | "l" = "m"): HTMLDivElement {
  const chef = h("div", `jjo-chef jjo-chef--${size}`);
  chef.style.setProperty("--hat", color);
  chef.append(h("div", "jjo-chef__horns"), h("div", "jjo-chef__hat"));
  const face = h("div", "jjo-chef__face");
  for (let i = 0; i < 2; i++) {
    const eye = h("span", "jjo-eye");
    const pupil = h("i");
    pupil.style.animationDelay = `${-Math.random() * 2}s`;
    eye.append(pupil);
    face.append(eye);
  }
  face.append(h("span", "jjo-chef__mouth"));
  chef.append(face);
  return chef;
}

function confetti(host: HTMLElement, count: number): void {
  const colors = [...PLAYER_COLORS, "#FFD700", "#FFF6E5"];
  const box = h("div", "jjo-confetti");
  for (let i = 0; i < count; i++) {
    const bit = h("span", Math.random() < 0.15 ? "jjo-confetti__sprinkle jjo-confetti__sprinkle--emoji" : "jjo-confetti__sprinkle");
    if (bit.classList.contains("jjo-confetti__sprinkle--emoji")) bit.textContent = pick(["🍒", "🧁", "🍩", "🪙", "🍬"]);
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.background = bit.textContent ? "transparent" : pick(colors);
    bit.style.animationDelay = `${Math.random() * 3}s`;
    bit.style.animationDuration = `${2.6 + Math.random() * 2.4}s`;
    bit.style.setProperty("--spin", `${(Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 720)}deg`);
    bit.style.setProperty("--drift", `${(Math.random() - 0.5) * 160}px`);
    box.append(bit);
  }
  host.append(box);
}

// ----------------------------------------------------------------------- class
interface VoteCard {
  el: HTMLButtonElement;
  coins: HTMLElement;
  tick: HTMLElement;
  count: HTMLElement;
  hits: number;
}

export class Overlays {
  private handlers: OverlayHandlers;
  private layer: HTMLDivElement;
  private endEl: HTMLDivElement;
  private settingsEl: HTMLDivElement;
  private wheelEl: HTMLDivElement;
  private bannerEl: HTMLDivElement;
  private bannerText: HTMLSpanElement;
  private bannerBtn: HTMLButtonElement;

  private screen: "none" | "vote" | "reveal" | "podium" = "none";
  private timers = new Set<number>();
  private myId = "";

  // vote screen
  private voteCards = new Map<string, VoteCard>();
  private voteBoard: HTMLDivElement | null = null;
  private voteSvg: SVGSVGElement | null = null;
  private voteBar: HTMLDivElement | null = null;
  private voteTime: HTMLSpanElement | null = null;
  private voteStatus: HTMLDivElement | null = null;
  private mySuspect = "";
  private votesDoneAt = 0;
  private lastMajority: { id: string; tie: boolean } | null = null;

  // podium screen
  private podiumFooter: HTMLDivElement | null = null;
  private podiumHost = "";

  // settings panel
  private settingsVisible = false;
  private bindings: ((s: Settings) => void)[] = [];

  // emote wheel
  private wheelVisible = false;

  constructor(root: HTMLElement, handlers: OverlayHandlers) {
    this.handlers = handlers;
    this.layer = h("div", "jjo-layer");
    this.endEl = h("div", "jjo-end");
    this.endEl.hidden = true;
    this.settingsEl = h("div", "jjo-settings");
    this.settingsEl.hidden = true;
    this.wheelEl = h("div", "jjo-wheel");
    this.wheelEl.hidden = true;
    this.bannerEl = h("div", "jjo-banner jj-panel");
    this.bannerEl.hidden = true;
    this.bannerEl.setAttribute("role", "status");
    this.bannerText = h("span", "jjo-banner__text");
    this.bannerBtn = h("button", "jj-btn jj-btn--pink jjo-banner__btn", "Back to menu");
    this.bannerBtn.addEventListener("click", () => {
      this.handlers.onUiSound("click");
      this.handlers.onLeave();
    });
    this.bannerEl.append(h("span", "jjo-banner__whisk", "🥄"), this.bannerText, this.bannerBtn);

    this.layer.append(this.endEl, this.wheelEl, this.settingsEl, this.bannerEl);
    root.append(this.layer);

    this.buildSettings();
    this.buildWheel();
    settings.onChange((s) => this.bindings.forEach((fn) => fn(s)));

    window.addEventListener("keydown", (e) => {
      if (!this.wheelVisible || e.repeat) return;
      const i = ["1", "2", "3", "4"].indexOf(e.key);
      if (i >= 0) {
        e.preventDefault();
        this.emote(EMOTES[i]!);
      }
    });
  }

  // ------------------------------------------------------------- timer utils
  private later(ms: number, fn: () => void): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }
  private clearTimers(): void {
    this.timers.forEach((id) => window.clearTimeout(id));
    this.timers.clear();
  }
  private get calm(): boolean {
    return settings.get().reducedFlashing;
  }

  /** Swap the end-screen content; clears pending animations of the previous screen. */
  private openEnd(kind: "vote" | "reveal" | "podium", content: HTMLElement): void {
    this.clearTimers();
    this.screen = kind;
    this.endEl.className = `jjo-end jjo-end--${kind}${this.calm ? " jjo-calm" : ""}`;
    this.endEl.replaceChildren(content);
    this.endEl.hidden = false;
    if (kind !== "vote") {
      this.voteCards.clear();
      this.voteBoard = this.voteSvg = null;
      this.voteBar = this.voteStatus = null;
      this.voteTime = null;
    }
    if (kind !== "podium") this.podiumFooter = null;
  }

  // ===================================================================== VOTE
  showVote(state: JellyStateView, myId: string): void {
    this.myId = myId;
    this.mySuspect = "";
    this.lastMajority = null;
    this.votesDoneAt = 0;
    this.voteCards.clear();

    const panel = h("div", "jjo-vote jj-panel");
    const title = h("h1", "jjo-title jjo-title--wobble", "WHO RIGGED THE CASES?");
    const sub = h("p", "jjo-sub", pick(VOTE_SUBTITLES));
    const timer = h("div", "jjo-timer");
    this.voteBar = h("div", "jjo-timer__fill");
    this.voteTime = h("span", "jjo-timer__label");
    timer.append(this.voteBar, this.voteTime);

    this.voteBoard = h("div", "jjo-vote__board");
    const grid = h("div", "jjo-vote__grid");
    const svgNs = "http://www.w3.org/2000/svg";
    this.voteSvg = document.createElementNS(svgNs, "svg") as SVGSVGElement;
    this.voteSvg.classList.add("jjo-vote__strings");
    this.voteSvg.setAttribute("aria-hidden", "true");

    const me = state.players.get(myId);
    const iCanVote = !!me && !me.spectator;
    for (const p of matchPlayers(state)) {
      const isMe = p.id === myId;
      const card = h("button", "jjo-vcard");
      card.type = "button";
      card.style.setProperty("--pc", colorOf(p));
      card.disabled = isMe || !iCanVote;
      card.dataset.id = p.id;
      const tick = h("span", "jjo-vcard__tick", "voted ✓");
      const count = h("span", "jjo-vcard__count");
      const coins = h("span", "jjo-vcard__coins");
      const name = h("span", "jjo-vcard__name", p.nickname);
      card.append(chefAvatar(colorOf(p)), name, coins, tick, count, h("span", "jjo-vcard__stamp", "SUSPECT!"));
      if (isMe) card.append(h("span", "jjo-vcard__me", "that's you, silly"));
      card.addEventListener("pointerenter", () => {
        if (!card.disabled) this.handlers.onUiSound("hover");
      });
      card.addEventListener("click", () => this.pickSuspect(p.id));
      grid.append(card);
      this.voteCards.set(p.id, { el: card, coins, tick, count, hits: 0 });
    }
    this.voteBoard.append(grid, this.voteSvg);
    this.voteStatus = h("div", "jjo-vote__status", iCanVote ? "Click a chef to accuse them. You can change your mind!" : "You're watching this one. Grab popcorn. 🍿");

    panel.append(title, sub, timer, this.voteBoard, this.voteStatus);
    const wrap = h("div", "jjo-end__scroll");
    wrap.append(panel);
    this.openEnd("vote", wrap);
    this.updateVote(state, myId);
  }

  private pickSuspect(id: string): void {
    const card = this.voteCards.get(id);
    if (!card || card.el.disabled || this.votesDoneAt) return;
    this.mySuspect = id;
    this.voteCards.forEach((c, cid) => c.el.classList.toggle("jjo-vcard--picked", cid === id));
    this.handlers.onUiSound("pop");
    this.handlers.onVote(id);
    if (this.voteStatus) this.voteStatus.textContent = `You pointed a sticky finger at ${card.el.querySelector(".jjo-vcard__name")?.textContent ?? "someone"} 🫵`;
  }

  /** Re-render the vote screen from state (voted ticks, timer). */
  updateVote(state: JellyStateView, myId: string): void {
    if (this.screen !== "vote") {
      this.showVote(state, myId);
      return;
    }
    this.myId = myId;
    this.voteCards.forEach((c, id) => {
      const p = state.players.get(id);
      if (!p) return;
      c.coins.textContent = `🪙 ${p.coins}`;
      c.tick.classList.toggle("jjo-vcard__tick--on", p.voted);
      c.el.classList.toggle("jjo-vcard--away", !p.connected);
    });
    if (this.voteBar && this.voteTime && !this.votesDoneAt) {
      const total = state.timeTotal > 0 ? state.timeTotal : 20;
      const frac = Math.max(0, Math.min(1, state.timeLeft / total));
      this.voteBar.style.width = `${frac * 100}%`;
      const secs = Math.ceil(state.timeLeft);
      this.voteTime.textContent = `⏱ ${secs}s`;
      this.voteBar.parentElement?.classList.toggle("jjo-timer--panic", secs <= 5 && secs > 0);
    }
  }

  showVotes(msg: VotesMsg, state: JellyStateView): void {
    if (this.screen !== "vote") this.showVote(state, this.myId);
    const step = 400;
    this.votesDoneAt = performance.now() + msg.votes.length * step + 1100;
    this.voteCards.forEach((c) => {
      c.el.disabled = true;
      c.hits = 0;
    });
    if (this.voteBar && this.voteTime) {
      this.voteBar.style.width = "0%";
      this.voteTime.textContent = "Pencils down!";
      this.voteBar.parentElement?.classList.remove("jjo-timer--panic");
    }
    if (this.voteStatus) this.voteStatus.textContent = msg.votes.length ? "Counting the tomatoes… 🍅" : "Nobody voted. Wow. Very brave.";

    msg.votes.forEach((v, i) => this.later(250 + i * step, () => this.throwVote(v.voterId, v.suspectId, state)));
    this.later(250 + msg.votes.length * step + 300, () => {
      const tie = !msg.majorityId;
      this.lastMajority = { id: msg.majorityId, tie };
      if (!this.voteStatus) return;
      if (tie) {
        this.voteStatus.textContent = msg.votes.length ? "A TIE?! Everyone's equally suspicious. 🤷" : "No votes, no verdict. 🦗";
      } else {
        this.voteStatus.textContent = `The kitchen blames ${nameOf(state, msg.majorityId)}!`;
        const card = this.voteCards.get(msg.majorityId);
        card?.el.classList.add("jjo-vcard--accused");
      }
      this.handlers.onUiSound("pop");
    });
  }

  /** One vote: a string from voter to suspect and a tomato that splats on the suspect's card. */
  private throwVote(voterId: string, suspectId: string, state: JellyStateView): void {
    const from = this.voteCards.get(voterId);
    const to = this.voteCards.get(suspectId);
    this.handlers.onUiSound("drum");
    if (!to || !this.voteBoard || !this.voteSvg) return;
    to.hits++;
    to.count.textContent = `🍅×${to.hits}`;
    to.count.classList.add("jjo-vcard__count--on");
    to.el.classList.remove("jjo-vcard--splat");
    void to.el.offsetWidth; // restart the wobble animation
    to.el.classList.add("jjo-vcard--splat");
    if (!from) return;

    const box = this.voteBoard.getBoundingClientRect();
    const a = from.el.getBoundingClientRect();
    const b = to.el.getBoundingClientRect();
    const x1 = a.left + a.width / 2 - box.left;
    const y1 = a.top + a.height * 0.35 - box.top;
    const x2 = b.left + b.width / 2 - box.left;
    const y2 = b.top + b.height * 0.35 - box.top;
    const cx = (x1 + x2) / 2;
    const cy = Math.min(y1, y2) - 70 - Math.random() * 30;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`);
    path.setAttribute("stroke", colorOf(state.players.get(voterId)));
    path.classList.add("jjo-string");
    this.voteSvg.append(path);

    const tomato = h("span", "jjo-tomato", "🍅");
    this.voteBoard.append(tomato);
    const frames: Keyframe[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const x = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
      const y = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;
      frames.push({ transform: `translate(${x}px, ${y}px) translate(-50%, -50%) rotate(${t * 540}deg)` });
    }
    const anim = tomato.animate(frames, { duration: 360, easing: "linear", fill: "forwards" });
    anim.onfinish = () => {
      tomato.remove();
      const splat = h("span", "jjo-splat", "💥");
      splat.style.left = `${x2 + (Math.random() - 0.5) * 40}px`;
      splat.style.top = `${y2 + (Math.random() - 0.5) * 30}px`;
      this.voteBoard?.append(splat);
    };
  }

  // =================================================================== REVEAL
  showReveal(msg: RevealMsg, state: JellyStateView): void {
    const wait = Math.max(0, this.votesDoneAt - performance.now());
    if (wait > 0 && this.screen === "vote") {
      this.later(wait, () => this.renderReveal(msg, state));
      return;
    }
    this.renderReveal(msg, state);
  }

  private renderReveal(msg: RevealMsg, state: JellyStateView): void {
    const panel = h("div", "jjo-reveal jj-panel");
    const drum = h("h1", "jjo-title jjo-reveal__drum", pick(DRUMROLL_LINES));
    const hasSab = msg.saboteurId !== "";
    const sab = hasSab ? state.players.get(msg.saboteurId) : undefined;

    // the flip card
    const flip = h("div", "jjo-flip");
    const inner = h("div", "jjo-flip__inner");
    const front = h("div", "jjo-flip__face jjo-flip__front");
    front.append(h("span", "jjo-flip__q", "?"), h("span", "jjo-flip__hint", "TOP SECRET RECIPE"));
    const back = h("div", `jjo-flip__face jjo-flip__back${hasSab ? " jjo-flip__back--evil" : " jjo-flip__back--lucky"}`);
    if (hasSab) {
      const avatar = chefAvatar(colorOf(sab), "l");
      avatar.classList.add("jjo-chef--unmask");
      back.append(avatar, h("div", "jjo-flip__name", `😈 IT WAS ${(sab?.nickname || "A GHOST").toUpperCase()}!`));
    } else {
      back.append(h("div", "jjo-flip__clover", "🍀"), h("div", "jjo-flip__name", "Nobody! It was just bad luck 🍀"));
    }
    const stamp = h("div", `jjo-stamp ${msg.caught ? "jjo-stamp--caught" : "jjo-stamp--escaped"}`, msg.caught ? "CAUGHT!" : "ESCAPED!");
    stamp.hidden = true;
    inner.append(front, back);
    flip.append(inner, stamp);

    const quip = h("p", "jjo-sub jjo-reveal__quip");
    quip.hidden = true;
    const details = h("div", "jjo-reveal__details");
    details.hidden = true;

    panel.append(drum, flip, quip, details);
    const wrap = h("div", "jjo-end__scroll");
    wrap.append(panel);
    this.openEnd("reveal", wrap);

    // drumroll: a few drum hits, speeding up
    const hits = [0, 380, 680, 920, 1100, 1240, 1350];
    hits.forEach((t) => this.later(t, () => this.handlers.onUiSound("drum")));
    if (!this.calm) this.later(200, () => panel.classList.add("jjo-reveal--shake"));

    this.later(1600, () => {
      panel.classList.remove("jjo-reveal--shake");
      flip.classList.add("jjo-flip--open");
      this.handlers.onUiSound("pop");
    });
    this.later(2300, () => {
      if (hasSab) {
        stamp.hidden = false;
        this.handlers.onUiSound("pop");
      }
      quip.textContent = hasSab ? pick(msg.caught ? CAUGHT_QUIPS : ESCAPED_QUIPS) : pick(NOBODY_QUIPS);
      quip.hidden = false;
    });
    this.later(2900, () => {
      this.fillRevealDetails(details, msg, state);
      details.hidden = false;
    });
  }

  private fillRevealDetails(box: HTMLElement, msg: RevealMsg, state: JellyStateView): void {
    const hasSab = msg.saboteurId !== "";
    const sabName = nameOf(state, msg.saboteurId);

    if (this.lastMajority) {
      const verdict = this.lastMajority.tie
        ? "The vote: a big fat tie. 🤷"
        : `The vote: the kitchen blamed ${nameOf(state, this.lastMajority.id)}${this.lastMajority.id === msg.saboteurId ? " ✅" : " ❌"}`;
      box.append(h("p", "jjo-verdict", verdict));
    }

    if (hasSab) {
      const rigSec = h("section", "jjo-sec");
      rigSec.append(h("h2", "jjo-sec__title", "🎰 The rig replay"));
      const list = h("ul", "jjo-rigs");
      if (msg.rigs.length === 0) {
        list.append(h("li", "jjo-rig jjo-rig--none", "Never rigged a single case. Sneaky… or just lazy? 🛋️"));
      }
      msg.rigs.forEach((r, i) => {
        const card = CARD_BY_ID[r.card as CardId];
        const fell = r.outcome === "fall";
        const li = h("li", `jjo-rig ${fell ? "jjo-rig--fell" : "jjo-rig--stood"}`);
        li.style.animationDelay = `${i * 0.18}s`;
        li.textContent = `Rigged: ${nameOf(state, r.victimId)}'s turn, round ${r.round} → ${card?.name ?? r.card} ${card?.emoji ?? "❓"} (${fell ? "FELL" : "STOOD"})`;
        list.append(li);
      });
      rigSec.append(list);

      const mathSec = h("section", "jjo-sec");
      mathSec.append(h("h2", "jjo-sec__title", "🧮 The hidden-bonus math"));
      const topples = Math.round(msg.hiddenBonus / SABOTEUR_TOPPLE_BONUS);
      const math = h("div", "jjo-math");
      math.append(h("div", "jjo-math__row", `${topples} topple${topples === 1 ? "" : "s"} on other turns × ${SABOTEUR_TOPPLE_BONUS} = ${msg.hiddenBonus} secret coins`));
      if (msg.caught) {
        math.append(
          h("div", "jjo-math__row jjo-math__row--bad", `Caught! ${sabName} forfeits the ${msg.hiddenBonus} 🚫`),
          h("div", "jjo-math__row jjo-math__row--good", `Every correct voter gets +${VOTE_CORRECT_REWARD} 🕵️`),
        );
      } else {
        math.append(
          h("div", "jjo-math__row jjo-math__row--good", `Escaped! ${msg.hiddenBonus} + ${SABOTEUR_ESCAPE_BONUS} escape bonus = ${msg.hiddenBonus + SABOTEUR_ESCAPE_BONUS} 💰`),
        );
      }
      mathSec.append(math);
      box.append(rigSec, mathSec);
    }

    const adjSec = h("section", "jjo-sec");
    adjSec.append(h("h2", "jjo-sec__title", "🪙 Coin adjustments"));
    const adj = h("ul", "jjo-adj");
    if (msg.adjustments.length === 0) adj.append(h("li", "jjo-adj__row jjo-adj__row--none", "Nothing changes. The coins stay exactly as greasy as before."));
    msg.adjustments.forEach((a, i) => {
      const li = h("li", `jjo-adj__row ${a.delta >= 0 ? "jjo-adj__row--up" : "jjo-adj__row--down"}`);
      li.style.animationDelay = `${i * 0.15}s`;
      const p = state.players.get(a.playerId);
      const dot = h("span", "jjo-dot");
      dot.style.background = colorOf(p);
      li.append(dot, h("span", "jjo-adj__name", nameOf(state, a.playerId)), h("span", "jjo-adj__reason", a.reason), h("span", "jjo-adj__delta", signed(a.delta)));
      adj.append(li);
    });
    adjSec.append(adj);
    box.append(adjSec);
  }

  // =================================================================== PODIUM
  showPodium(state: JellyStateView, myId: string): void {
    this.myId = myId;
    if (this.screen === "podium" && this.podiumFooter) {
      if (state.hostId !== this.podiumHost) this.fillPodiumFooter(state, myId);
      return;
    }
    const ranked = matchPlayers(state).sort((a, b) => {
      if (a.place && b.place) return a.place - b.place;
      if (a.place || b.place) return a.place ? -1 : 1;
      return b.coins - a.coins;
    });
    const last = ranked.length >= 2 ? ranked[ranked.length - 1] : undefined;

    const panel = h("div", "jjo-podium jj-panel");
    const winner = ranked[0];
    panel.append(
      h("h1", "jjo-title jjo-title--wobble", winner ? `${winner.nickname} TAKES THE CAKE!` : "THE CAKE IS A LIE"),
      h("p", "jjo-sub", "Final standings, fresh out of the oven."),
    );

    // the 3-tier cake: visual order 2nd, 1st, 3rd
    const cake = h("div", "jjo-cake");
    const slotOrder = [1, 0, 2];
    for (const idx of slotOrder) {
      const p = ranked[idx];
      const tier = h("div", `jjo-tier jjo-tier--${idx + 1}`);
      if (p) {
        const spot = h("div", "jjo-spot");
        spot.style.setProperty("--pc", colorOf(p));
        spot.style.animationDelay = `${0.2 + (2 - idx) * 0.35}s`;
        if (idx === 0) spot.append(h("span", "jjo-spot__crown", "👑"));
        spot.append(chefAvatar(colorOf(p), idx === 0 ? "l" : "m"), h("span", "jjo-spot__name", p.nickname), h("span", "jjo-spot__coins", `🪙 ${p.coins}`));
        if (p === last) this.addPie(spot);
        tier.append(spot);
      }
      const layer = h("div", "jjo-tier__cake");
      layer.append(h("span", "jjo-tier__drip"), h("span", "jjo-tier__label", TIER_LABELS[idx]!));
      if (idx === 0) layer.append(h("span", "jjo-tier__cherry", "🍒"));
      tier.append(layer);
      cake.append(tier);
    }
    const plate = h("div", "jjo-cake__plate");
    const cakeWrap = h("div", "jjo-cake__wrap");
    cakeWrap.append(cake, plate);
    panel.append(cakeWrap);

    // last place beyond the top 3 gets a seat on the shame stool
    if (last && ranked.indexOf(last) >= 3) {
      const shame = h("div", "jjo-shame");
      const spot = h("div", "jjo-spot jjo-spot--shame");
      spot.style.setProperty("--pc", colorOf(last));
      spot.append(chefAvatar(colorOf(last), "s"), h("span", "jjo-spot__name", last.nickname), h("span", "jjo-spot__coins", `🪙 ${last.coins}`));
      this.addPie(spot);
      shame.append(h("span", "jjo-shame__label", "🪑 The Stool of Shame"), spot);
      panel.append(shame);
    }

    // stats table
    const table = h("table", "jjo-stats");
    const head = h("tr");
    ["#", "Chef", "🪙", "Survived", "Topples", "Best ×", "Bet profit"].forEach((t) => head.append(h("th", undefined, t)));
    const thead = h("thead");
    thead.append(head);
    const tbody = h("tbody");
    ranked.forEach((p, i) => {
      const tr = h("tr", p.id === myId ? "jjo-stats__me" : undefined);
      const nameTd = h("td", "jjo-stats__name");
      const dot = h("span", "jjo-dot");
      dot.style.background = colorOf(p);
      nameTd.append(dot, document.createTextNode(p.nickname + (p === last ? " 🥧" : "")));
      const best = p.stats.bestMultiplierX10 > 0 ? `×${(p.stats.bestMultiplierX10 / 10).toFixed(1).replace(/\.0$/, "")}` : "—";
      const profit = h("td", p.stats.betProfit > 0 ? "jjo-pos" : p.stats.betProfit < 0 ? "jjo-neg" : undefined, signed(p.stats.betProfit));
      tr.append(h("td", undefined, `${p.place || i + 1}`), nameTd, h("td", undefined, `${p.coins}`), h("td", undefined, `${p.stats.survived}`), h("td", undefined, `${p.stats.topples}`), h("td", undefined, best), profit);
      tbody.append(tr);
    });
    table.append(thead, tbody);
    const tableWrap = h("div", "jjo-stats__wrap");
    tableWrap.append(table);
    panel.append(tableWrap);

    this.podiumFooter = h("div", "jjo-podium__footer");
    panel.append(this.podiumFooter);

    const wrap = h("div", "jjo-end__scroll");
    wrap.append(panel);
    this.openEnd("podium", wrap);
    this.fillPodiumFooter(state, myId);
    confetti(this.endEl, this.calm ? 40 : 110);
    this.later(1300, () => this.handlers.onUiSound("pop"));
    if (last) this.later(1900, () => this.handlers.onUiSound("pop")); // pie lands
  }

  private addPie(spot: HTMLElement): void {
    spot.classList.add("jjo-spot--pied");
    spot.append(h("span", "jjo-pie", "🥧"), h("span", "jjo-pie__splat"), h("span", "jjo-pie__tag", "LAST PLACE"));
  }

  private fillPodiumFooter(state: JellyStateView, myId: string): void {
    if (!this.podiumFooter) return;
    this.podiumHost = state.hostId;
    this.podiumFooter.replaceChildren();
    if (state.hostId === myId) {
      const re = h("button", "jj-btn jj-btn--green jjo-big", "🔁 Rematch!");
      re.type = "button";
      re.addEventListener("click", () => {
        this.handlers.onUiSound("click");
        this.handlers.onRematch();
      });
      this.podiumFooter.append(re);
    } else {
      this.podiumFooter.append(h("span", "jjo-waiting", pick(WAITING_QUIPS)));
    }
    const back = h("a", "jj-btn jj-btn--pink jjo-big", "🏠 Back to Game Night");
    back.href = "/";
    back.addEventListener("click", () => this.handlers.onUiSound("click"));
    this.podiumFooter.append(back);
  }

  /** Hide vote/reveal/podium. */
  hideEnd(): void {
    this.clearTimers();
    this.screen = "none";
    this.endEl.hidden = true;
    this.endEl.replaceChildren();
    this.voteCards.clear();
    this.voteBoard = this.voteSvg = null;
    this.voteBar = this.voteStatus = null;
    this.voteTime = null;
    this.podiumFooter = null;
    this.votesDoneAt = 0;
  }

  // ================================================================= SETTINGS
  private buildSettings(): void {
    const backdrop = h("div", "jjo-settings__backdrop");
    backdrop.addEventListener("click", () => this.toggleSettings(false));
    const panel = h("div", "jjo-settings__panel jj-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Settings");
    const top = h("div", "jjo-settings__top");
    const close = h("button", "jjo-x", "✕");
    close.type = "button";
    close.setAttribute("aria-label", "Close settings");
    close.addEventListener("click", () => {
      this.handlers.onUiSound("click");
      this.toggleSettings(false);
    });
    top.append(h("h2", "jjo-settings__title", "⚙️ Kitchen Settings"), close);
    panel.append(top);

    const slider = (label: string, emoji: string, key: "masterVolume" | "musicVolume" | "sfxVolume" | "cameraSensitivity", min: number, max: number, step: number, fmt: (v: number) => string) => {
      const row = h("label", "jjo-row");
      const out = h("span", "jjo-row__val");
      const input = h("input", "jjo-range");
      input.type = "range";
      input.min = `${min}`;
      input.max = `${max}`;
      input.step = `${step}`;
      const sync = (s: Settings) => {
        input.value = `${s[key]}`;
        out.textContent = fmt(s[key]);
        input.style.setProperty("--fill", `${((s[key] - min) / (max - min)) * 100}%`);
      };
      input.addEventListener("input", () => settings.set({ [key]: Number(input.value) }));
      input.addEventListener("change", () => this.handlers.onUiSound("click"));
      this.bindings.push(sync);
      row.append(h("span", "jjo-row__label", `${emoji} ${label}`), input, out);
      panel.append(row);
    };
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    panel.append(h("h3", "jjo-settings__group", "Noises"));
    slider("Master", "🔊", "masterVolume", 0, 1, 0.01, pct);
    slider("Music", "🎷", "musicVolume", 0, 1, 0.01, pct);
    slider("SFX", "📯", "sfxVolume", 0, 1, 0.01, pct);
    panel.append(h("h3", "jjo-settings__group", "Camera"));
    slider("Sensitivity", "🎥", "cameraSensitivity", 0.2, 3, 0.1, (v) => `×${v.toFixed(1)}`);

    const toggle = (label: string, emoji: string, key: "invertOrbit" | "reducedFlashing") => {
      const row = h("label", "jjo-row jjo-row--toggle");
      const input = h("input", "jjo-check");
      input.type = "checkbox";
      input.addEventListener("change", () => {
        this.handlers.onUiSound("click");
        settings.set({ [key]: input.checked });
      });
      this.bindings.push((s) => (input.checked = s[key]));
      row.append(h("span", "jjo-row__label", `${emoji} ${label}`), input, h("span", "jjo-switch"));
      panel.append(row);
    };
    toggle("Invert orbit", "🙃", "invertOrbit");

    panel.append(h("h3", "jjo-settings__group", "Graphics"));
    const qrow = h("div", "jjo-quality");
    for (const q of QUALITY_META) {
      const b = h("button", "jjo-quality__btn");
      b.type = "button";
      b.append(h("span", "jjo-quality__emoji", q.emoji), h("span", undefined, q.label));
      b.addEventListener("click", () => {
        this.handlers.onUiSound("click");
        settings.set({ quality: q.id });
      });
      this.bindings.push((s) => b.classList.toggle("jjo-quality__btn--on", s.quality === q.id));
      qrow.append(b);
    }
    panel.append(qrow);
    toggle("Reduced flashing", "😎", "reducedFlashing");

    const foot = h("div", "jjo-settings__foot");
    const back = h("button", "jj-btn jj-btn--green", "Back to the kitchen");
    back.type = "button";
    back.addEventListener("click", () => {
      this.handlers.onUiSound("click");
      this.toggleSettings(false);
    });
    const leave = h("button", "jj-btn jj-btn--red", "🚪 Leave room");
    leave.type = "button";
    leave.addEventListener("click", () => {
      this.handlers.onUiSound("click");
      this.toggleSettings(false);
      this.handlers.onLeave();
    });
    foot.append(back, leave);
    panel.append(foot, h("p", "jjo-settings__tip", "Tip: press Esc to close. Press it again to open. Revolutionary."));

    this.settingsEl.append(backdrop, panel);
    const s = settings.get();
    this.bindings.forEach((fn) => fn(s));
  }

  toggleSettings(force?: boolean): void {
    const next = force ?? !this.settingsVisible;
    if (next === this.settingsVisible) return;
    this.settingsVisible = next;
    this.settingsEl.hidden = !next;
    if (next) {
      const s = settings.get();
      this.bindings.forEach((fn) => fn(s));
      this.handlers.onUiSound("pop");
    }
  }

  get settingsOpen(): boolean {
    return this.settingsVisible;
  }

  // ============================================================== EMOTE WHEEL
  private buildWheel(): void {
    const ring = h("div", "jjo-wheel__ring");
    EMOTES.forEach((id, i) => {
      const meta = EMOTE_META[id];
      const b = h("button", `jjo-wheel__btn jjo-wheel__btn--${i}`);
      b.type = "button";
      b.append(h("span", "jjo-wheel__emoji", meta.emoji), h("span", "jjo-wheel__label", meta.label), h("kbd", "jjo-wheel__key", `${i + 1}`));
      b.addEventListener("pointerenter", () => this.handlers.onUiSound("hover"));
      b.addEventListener("click", () => this.emote(id));
      ring.append(b);
    });
    ring.append(h("div", "jjo-wheel__hub", "😶"));
    this.wheelEl.append(ring);
  }

  private emote(id: EmoteId): void {
    this.handlers.onUiSound("pop");
    this.handlers.onEmote(id);
    this.setEmoteWheel(false);
  }

  setEmoteWheel(visible: boolean): void {
    if (visible === this.wheelVisible) return;
    this.wheelVisible = visible;
    this.wheelEl.hidden = !visible;
  }

  // ======================================================= CONNECTION BANNER
  connection(status: "ok" | "reconnecting" | "disconnected"): void {
    if (status === "ok") {
      this.bannerEl.hidden = true;
      return;
    }
    this.bannerEl.hidden = false;
    this.bannerEl.classList.toggle("jjo-banner--dead", status === "disconnected");
    this.bannerText.textContent =
      status === "reconnecting" ? "Reconnecting… (someone tripped over the cable)" : "Disconnected — back to menu. The cake has left the building. 🫠";
    this.bannerBtn.hidden = status !== "disconnected";
  }
}
