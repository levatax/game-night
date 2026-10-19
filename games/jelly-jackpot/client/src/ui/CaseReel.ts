// The CS-style case opening reel (DOM + CSS). Owner: client-reel. PUBLIC API IS THE CONTRACT.
// Styles in ./reel.css. Tokens from ./theme.css.
//
// A horizontal strip of cards slides past a center marker (a golden arrow + glowing line). Each card: big
// emoji, name, ×multiplier, background gradient and thick border in RARITY_COLORS[rarity]; cursed cards
// look scorched with a tiny skull, legendary ones shimmer. Above the strip: "🎰 <nickname> opens a case".
// The reel lives in a silly slot-machine housing with googly eyes, chasing marquee bulbs and a lever.
//
// Flow (see protocol SpinStartMsg / SpinResultMsg):
//  - spin(nickname): show the reel and start a FAST scroll of random filler cards (the result isn't known
//    yet). It keeps scrolling until land().
//  - land(msg): rewrite the off-screen part of the strip so that msg.strip[msg.winIndex] comes to rest under
//    the marker exactly msg.landInMs from now. Motion is x(s) = x0 + D·(1 − (1 − s)^k) driven by
//    requestAnimationFrame; k = v0·T / D so the deceleration starts at exactly the spin's current speed.
//    The rest point sits a (seeded, same on every client) small offset inside the card for tension.
//    onTick(speed01) fires every time a card boundary passes the marker. On rest: the winner pops, others
//    dim, onLanded(msg). Legendary → golden rays + shimmer; cursed → shake + goo drips.
//  - After a short read beat the reel shrinks into a compact "current rule" chip that stays until hide().
//  - Tension trick: a legendary card adjacent to the winner makes the reel stop a hair away from it.
// Works at any viewport width (cards ~140 px, ~104 px on phones; the strip is clipped by the window).

import { CARDS, CARD_BY_ID, RARITIES, RARITY_COLORS, RARITY_ODDS, type CardDef, type CardId, type Rarity } from "../../../shared/constants";
import type { SpinResultMsg } from "../../../shared/protocol";
import "./reel.css";

export interface ReelCallbacks {
  onTick(speed01: number): void;
  onLanded(msg: SpinResultMsg): void;
}

type Mode = "off" | "spin" | "land" | "rest";

/** Full blur speed, in card pitches per second. */
const MAX_CARDS_PER_SEC = 22;
/** Seconds to spin up from 0 to full speed (after a tiny lever "wind-up" lurch backwards). */
const SPIN_UP_SEC = 0.35;
const WINDUP_SEC = 0.12;
/** How long the landed reel stays big before shrinking into the rule chip. */
const READ_MS = 1500;
/** Target deceleration exponent (higher = longer, creepier crawl at the end). */
const K_NORMAL = 3.4;
const K_TEASE = 4.4;

const QUIPS: Record<Rarity, string[]> = {
  common: ["Meh. 🥱", "Could be worse!", "Boring. Safe. Beige.", "The chef shrugs.", "A fine, mild salsa."],
  uncommon: ["Ooh, spicy! 🌶️", "Now we're cooking!", "Fancy!", "Things are getting weird…"],
  rare: ["WHOA! 🤯", "Big brain card!", "The crowd goes mild!", "Purple = danger. Probably."],
  legendary: ["JACKPOT!!! 🤑", "CHA-CHING! 💰", "The kitchen gods smile!", "GOLDEN! Somebody call mom!"],
  cursed: ["Oh no. Oh no no no. 💀", "Cursed! 😱", "Who angered the oven?!", "That's… unfortunate."],
};
const TEASE_QUIPS = ["SO CLOSE! 😭", "Noooo, the gold one! 😩", "Missed it by a whisker! 🐭"];

const BY_RARITY: Record<Rarity, CardDef[]> = {
  common: [],
  uncommon: [],
  rare: [],
  legendary: [],
  cursed: [],
};
for (const c of CARDS) BY_RARITY[c.rarity].push(c);
const ODDS_TOTAL = RARITY_ODDS.reduce((a, b) => a + b, 0);

/** A filler card rolled with the real case odds, so the strip looks like a believable case. */
function randomFiller(): CardId {
  let r = Math.random() * ODDS_TOTAL;
  let rarity: Rarity = "common";
  for (let i = 0; i < RARITIES.length; i++) {
    r -= RARITY_ODDS[i];
    if (r <= 0) {
      rarity = RARITIES[i];
      break;
    }
  }
  const pool = BY_RARITY[rarity];
  return pool[Math.floor(Math.random() * pool.length)].id;
}

/** Deterministic 0..1 from the strip, so every client rests on the same sub-card offset. */
function stripHash(strip: string[], salt: number): number {
  let h = 2166136261 ^ salt;
  for (const id of strip) for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10007) / 10007;
}

function fmtMult(m: number): string {
  return "×" + (Math.round(m * 100) / 100).toString();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

/** Card face markup shared by the strip cards and the chip. */
function buildCard(id: CardId, cls: string): HTMLDivElement {
  const def = CARD_BY_ID[id] ?? CARD_BY_ID.plain;
  const card = el("div", `${cls} jjr-r-${def.rarity}`);
  card.style.setProperty("--rc", RARITY_COLORS[def.rarity]);
  el("div", "jjr-card-emoji", card).textContent = def.emoji;
  el("div", "jjr-card-name", card).textContent = def.name;
  el("div", "jjr-card-mult", card).textContent = fmtMult(def.multiplier);
  if (def.rarity === "cursed") el("div", "jjr-card-skull", card).textContent = "💀";
  if (def.rarity === "legendary") el("div", "jjr-card-sparkle", card).textContent = "✨";
  return card;
}

export class CaseReel {
  private readonly cb: ReelCallbacks;
  private readonly wrap: HTMLDivElement;
  private readonly stage: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly housing: HTMLDivElement;
  private readonly win: HTMLDivElement;
  private readonly strip: HTMLDivElement;
  private readonly rays: HTMLDivElement;
  private readonly quip: HTMLDivElement;
  private readonly chip: HTMLDivElement;
  private readonly pupils: HTMLSpanElement[] = [];

  /** Logical card index → element (+ its id). Cards sit at translate = index · pitch (so `transform`/`scale` stay free for CSS animations). */
  private cards = new Map<number, { el: HTMLDivElement; id: CardId }>();
  private mode: Mode = "off";
  private raf = 0;
  private lastNow = 0;
  private spinT = 0;

  // Geometry (px). x = strip coordinate currently under the marker.
  private pitch = 150;
  private halfW = 400;
  private x = 0;
  private v = 0;
  private lastBoundary = 0;
  private blurLevel = -1;

  // Landing curve.
  private landT0 = 0;
  private landDur = 1;
  private landX0 = 0;
  private landD = 0;
  private landK = K_NORMAL;
  private winAt = 0;
  private teaseAt: number | null = null;
  private msg: SpinResultMsg | null = null;

  private collapseTimer = 0;
  private landTimer = 0;
  private leaveTimer = 0;
  private readonly onResize = () => this.measure();

  constructor(root: HTMLElement, callbacks: ReelCallbacks) {
    this.cb = callbacks;
    this.wrap = el("div", "jjr", root);
    this.wrap.setAttribute("aria-live", "polite");

    // Horizontal-only motion blur filters (SVG, referenced by the strip's CSS classes).
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "jjr-defs");
    svg.setAttribute("aria-hidden", "true");
    const defs = document.createElementNS(NS, "defs");
    [1.5, 4, 8].forEach((dev, i) => {
      const f = document.createElementNS(NS, "filter");
      f.setAttribute("id", `jjr-mb${i + 1}`);
      f.setAttribute("x", "-10%");
      f.setAttribute("width", "120%");
      const g = document.createElementNS(NS, "feGaussianBlur");
      g.setAttribute("stdDeviation", `${dev} 0`);
      f.appendChild(g);
      defs.appendChild(f);
    });
    svg.appendChild(defs);
    this.wrap.appendChild(svg);

    this.stage = el("div", "jjr-stage", this.wrap);
    this.title = el("div", "jjr-title", this.stage);
    this.housing = el("div", "jjr-housing", this.stage);

    const eyes = el("div", "jjr-eyes", this.housing);
    for (let i = 0; i < 2; i++) {
      const eye = el("span", "jjr-eye", eyes);
      this.pupils.push(el("span", "jjr-pupil", eye));
    }
    el("div", "jjr-bulbs jjr-bulbs--top", this.housing);
    el("div", "jjr-bulbs jjr-bulbs--bottom", this.housing);
    const lever = el("div", "jjr-lever", this.housing);
    el("span", "jjr-lever-stick", lever);
    el("span", "jjr-lever-ball", lever);

    this.win = el("div", "jjr-window", this.housing);
    this.rays = el("div", "jjr-rays", this.win);
    this.strip = el("div", "jjr-strip", this.win);
    el("div", "jjr-vignette", this.win);
    const marker = el("div", "jjr-marker", this.win);
    el("span", "jjr-arrow jjr-arrow--top", marker);
    el("span", "jjr-arrow jjr-arrow--bottom", marker);

    this.quip = el("div", "jjr-quip", this.stage);
    this.chip = el("div", "jjr-chip", this.wrap);

    window.addEventListener("resize", this.onResize);
  }

  // ----------------------------------------------------------------- public API

  spin(nickname: string): void {
    this.clearTimers();
    this.msg = null;
    this.teaseAt = null;
    this.chip.classList.remove("is-on");
    this.title.textContent = "";
    this.title.append("🎰 ");
    const b = el("b", "", this.title);
    b.textContent = nickname || "Someone";
    this.title.append(" opens a case");
    this.resetStrip();
    this.stage.className = "jjr-stage is-on is-spinning";
    this.housing.classList.remove("is-pulled");
    void this.housing.offsetWidth; // restart the lever animation
    this.housing.classList.add("is-pulled");
    this.measure();
    this.mode = "spin";
    this.spinT = 0;
    this.v = 0;
    this.startLoop();
  }

  land(msg: SpinResultMsg): void {
    // Late result with no spin running (e.g. missed SPIN_START): start a full-speed spin right now.
    if (this.mode !== "spin" && this.mode !== "land") {
      this.spin(this.title.querySelector("b")?.textContent ?? "");
      this.spinT = SPIN_UP_SEC + WINDUP_SEC;
      this.v = this.maxSpeed();
    }
    this.advanceTo(performance.now());
    this.msg = msg;

    const P = this.pitch;
    const T = Math.max(0.5, msg.landInMs / 1000);
    let v0 = Math.max(this.v, this.maxSpeed() * 0.35);
    const winId = msg.strip[msg.winIndex] ?? msg.card;
    const prev = msg.strip[msg.winIndex - 1];
    const next = msg.strip[msg.winIndex + 1];
    const winRarity = CARD_BY_ID[winId]?.rarity;
    const teaseNext = winRarity !== "legendary" && !!next && CARD_BY_ID[next]?.rarity === "legendary";
    const teasePrev = !teaseNext && winRarity !== "legendary" && !!prev && CARD_BY_ID[prev]?.rarity === "legendary";

    // Where inside the winning card we stop (fraction of pitch from its center; seeded so all clients agree).
    let off = (stripHash(msg.strip, 7) - 0.5) * 0.7 * P;
    if (teaseNext) off = 0.43 * P; // stopped just before the gold one
    if (teasePrev) off = -0.43 * P; // crawled just past the gold one
    const kTarget = teaseNext || teasePrev ? K_TEASE : K_NORMAL;

    // Pick the winner's logical index so the travel matches the current speed (D ≈ v0·T / k) and the
    // winner is still safely off-screen right now (we never swap a card the player can see).
    const firstHidden = Math.ceil((this.x + this.halfW) / P) + 1;
    const minD = this.halfW + 1.5 * P;
    const wantD = Math.max(minD, (v0 * T) / kTarget);
    let winAt = Math.round((this.x + wantD - off - P / 2) / P);
    while (winAt * P + P / 2 + off - this.x < minD || winAt - 1 < firstHidden) winAt++;
    const D = winAt * P + P / 2 + off - this.x;
    // k from the exact speed; keep it sane (very short landInMs may need a small speed bump instead).
    let k = (v0 * T) / D;
    if (k < 1.6) {
      k = 1.6;
      v0 = (k * D) / T;
    } else if (k > 6) {
      k = 6;
    }
    this.v = v0;

    // Rewrite the strip from the first hidden card onward: strip[i] sits at logical index base + i.
    const base = winAt - msg.winIndex;
    for (const [idx, c] of this.cards) {
      if (idx >= firstHidden) {
        c.el.remove();
        this.cards.delete(idx);
      }
    }
    for (let idx = firstHidden; idx < base; idx++) this.placeCard(idx, randomFiller()); // very long landInMs
    for (let i = 0; i < msg.strip.length; i++) {
      const idx = base + i;
      if (idx < firstHidden) continue;
      this.placeCard(idx, msg.strip[i]);
    }
    // Make sure there are cards up to the edge of the window at rest even for a short strip.
    const restRight = Math.ceil((this.x + D + this.halfW) / P) + 1;
    for (let idx = Math.max(firstHidden, base + msg.strip.length); idx <= restRight; idx++) this.placeCard(idx, randomFiller());

    this.winAt = winAt;
    this.teaseAt = teaseNext ? winAt + 1 : teasePrev ? winAt - 1 : null;
    this.landT0 = this.lastNow;
    this.landDur = T;
    this.landX0 = this.x;
    this.landD = D;
    this.landK = k;
    this.mode = "land";
    this.startLoop();
    // Safety net: rAF is paused in background tabs; still land (and fire onLanded) on time.
    this.clearTimers();
    this.landTimer = window.setTimeout(() => {
      this.landTimer = 0;
      if (this.mode === "land") this.advanceTo(Math.max(performance.now(), this.landT0 + T * 1000));
    }, T * 1000 + 120);
  }

  /** Instantly show a landed card without animation (reconnect / late join). */
  showLanded(msg: Pick<SpinResultMsg, "card" | "rarity" | "multiplier">): void {
    this.clearTimers();
    this.stopLoop();
    this.mode = "off";
    this.stage.className = "jjr-stage";
    this.showChip(msg.card, msg.rarity, msg.multiplier);
  }

  get spinning(): boolean {
    return this.mode === "spin" || this.mode === "land";
  }

  hide(): void {
    this.clearTimers();
    this.stopLoop();
    this.mode = "off";
    this.msg = null;
    this.stage.className = "jjr-stage";
    this.chip.classList.remove("is-on");
    this.rays.className = "jjr-rays";
  }

  // ------------------------------------------------------------------- internals

  private maxSpeed(): number {
    return MAX_CARDS_PER_SEC * this.pitch;
  }

  private measure(): void {
    const w = window.innerWidth;
    const cardW = w < 560 ? 104 : 140;
    const gap = w < 560 ? 8 : 12;
    const scale = (cardW + gap) / this.pitch;
    this.pitch = cardW + gap;
    // Keep the reel at the same card (and the landing curve on target) when the pitch changes.
    this.x *= scale;
    this.landX0 *= scale;
    this.landD *= scale;
    this.wrap.style.setProperty("--jjr-card-w", `${cardW}px`);
    this.wrap.style.setProperty("--jjr-gap", `${gap}px`);
    const ww = this.win.clientWidth;
    this.halfW = (ww > 0 ? ww : Math.min(900, w - 24)) / 2;
    for (const [idx, c] of this.cards) c.el.style.translate = `${idx * this.pitch}px 0`;
    this.applyTransform();
  }

  private resetStrip(): void {
    for (const c of this.cards.values()) c.el.remove();
    this.cards.clear();
    this.strip.classList.remove("is-landed");
    this.rays.className = "jjr-rays";
    this.quip.className = "jjr-quip";
    this.quip.textContent = "";
    this.housing.classList.remove("is-legendary", "is-cursed", "is-tease");
    // Start a random distance in so successive spins don't begin on the same card.
    this.x = Math.floor(Math.random() * 1000) * this.pitch + this.pitch / 2;
    this.lastBoundary = Math.floor(this.x / this.pitch);
    this.setBlur(0);
  }

  private placeCard(idx: number, id: CardId): void {
    const old = this.cards.get(idx);
    if (old) {
      if (old.id === id) return;
      old.el.remove();
    }
    const card = buildCard(id, "jjr-card");
    card.style.translate = `${idx * this.pitch}px 0`;
    this.strip.appendChild(card);
    this.cards.set(idx, { el: card, id });
  }

  /** Keep filler cards around the visible window while free-spinning; recycle the ones behind. */
  private fillAround(): void {
    const P = this.pitch;
    const left = Math.floor((this.x - this.halfW) / P) - 2;
    const right = Math.ceil((this.x + this.halfW) / P) + 3;
    for (const [idx, c] of this.cards) {
      if (idx < left) {
        c.el.remove();
        this.cards.delete(idx);
      }
    }
    if (this.mode !== "spin") return;
    for (let idx = left; idx <= right; idx++) if (!this.cards.has(idx)) this.placeCard(idx, randomFiller());
  }

  private startLoop(): void {
    if (this.raf) return;
    this.lastNow = performance.now();
    const frame = (now: number) => {
      this.raf = 0;
      this.advanceTo(now);
      if (this.mode === "spin" || this.mode === "land") this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Move the reel to time `now` (ms). Safe to call several times per frame. */
  private advanceTo(now: number): void {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    if (this.mode === "spin") {
      this.spinT += dt;
      const vmax = this.maxSpeed();
      if (this.spinT < WINDUP_SEC) {
        this.v = -this.pitch * 2.2; // lever lurch: the strip jerks back a bit first
      } else {
        const s = Math.min(1, (this.spinT - WINDUP_SEC) / SPIN_UP_SEC);
        this.v = vmax * s * s * (3 - 2 * s);
      }
      this.x += this.v * dt;
    } else if (this.mode === "land") {
      const s = Math.min(1, (now - this.landT0) / 1000 / this.landDur);
      const k = this.landK;
      this.x = this.landX0 + this.landD * (1 - Math.pow(1 - s, k));
      this.v = ((this.landD * k) / this.landDur) * Math.pow(1 - s, k - 1);
      if (s >= 1) {
        this.x = this.landX0 + this.landD;
        this.v = 0;
      }
    } else {
      return;
    }

    const speed01 = Math.min(1, Math.abs(this.v) / this.maxSpeed());
    const boundary = Math.floor(this.x / this.pitch);
    if (boundary !== this.lastBoundary) {
      this.lastBoundary = boundary;
      this.cb.onTick(speed01);
      if (speed01 < 0.35) this.bumpMarker();
    }
    this.setBlur(speed01 > 0.8 ? 3 : speed01 > 0.55 ? 2 : speed01 > 0.3 ? 1 : 0);
    this.fillAround();
    this.applyTransform();
    this.wiggleEyes(now, speed01);

    if (this.mode === "land" && this.v === 0) this.rest();
  }

  private applyTransform(): void {
    this.strip.style.transform = `translate3d(${(this.halfW - this.x).toFixed(2)}px,0,0)`;
  }

  private setBlur(level: number): void {
    if (level === this.blurLevel) return;
    this.blurLevel = level;
    this.strip.dataset.blur = String(level);
    this.housing.classList.toggle("is-fast", level >= 2);
  }

  private bumpMarker(): void {
    this.housing.classList.remove("is-tick");
    void this.housing.offsetWidth;
    this.housing.classList.add("is-tick");
  }

  /** Googly pupils rattle with speed and settle looking down at the marker. */
  private wiggleEyes(now: number, speed01: number): void {
    const t = now / 1000;
    this.pupils.forEach((p, i) => {
      const jx = Math.sin(t * (41 + i * 7)) * 5 * speed01;
      const jy = Math.cos(t * (37 - i * 5)) * 4 * speed01 + 3 * (1 - speed01);
      p.style.transform = `translate(${jx.toFixed(1)}px, ${jy.toFixed(1)}px)`;
    });
  }

  /** The reel stopped: pop the winner, dim the rest, rarity fireworks, quip, then shrink into the chip. */
  private rest(): void {
    const msg = this.msg;
    this.mode = "rest";
    this.stopLoop();
    this.setBlur(0);
    if (!msg) return;
    const def = CARD_BY_ID[msg.card] ?? CARD_BY_ID.plain;
    const rarity: Rarity = msg.rarity ?? def.rarity;

    this.strip.classList.add("is-landed");
    for (const [idx, c] of this.cards) {
      c.el.classList.toggle("is-win", idx === this.winAt);
      c.el.classList.toggle("is-tease", idx === this.teaseAt);
    }
    // Rays sit behind the winning card's center (it rests slightly off the marker).
    const cardCenter = this.winAt * this.pitch + this.pitch / 2;
    this.rays.style.left = `calc(50% + ${(cardCenter - this.x).toFixed(1)}px)`;
    this.rays.className = `jjr-rays jjr-r-${rarity} is-on`;
    this.rays.style.setProperty("--rc", RARITY_COLORS[rarity]);

    this.stage.classList.remove("is-spinning");
    this.stage.classList.add("is-landed");
    this.housing.style.setProperty("--rc", RARITY_COLORS[rarity]);
    this.housing.classList.toggle("is-legendary", rarity === "legendary");
    this.housing.classList.toggle("is-cursed", rarity === "cursed");
    this.housing.classList.toggle("is-tease", this.teaseAt !== null);
    this.pupils.forEach((p) => (p.style.transform = rarity === "cursed" ? "translate(0,-4px)" : "translate(0,5px)"));

    const lines = this.teaseAt !== null ? TEASE_QUIPS : QUIPS[rarity];
    this.quip.textContent = lines[Math.floor(Math.random() * lines.length)];
    this.quip.className = `jjr-quip is-on jjr-r-${rarity}`;
    this.quip.style.setProperty("--rc", RARITY_COLORS[rarity]);

    this.cb.onLanded(msg);

    this.collapseTimer = window.setTimeout(() => {
      this.collapseTimer = 0;
      this.stage.classList.add("is-leaving");
      this.leaveTimer = window.setTimeout(() => {
        this.leaveTimer = 0;
        this.stage.className = "jjr-stage";
        this.mode = "off";
      }, 320);
      this.showChip(msg.card, rarity, msg.multiplier);
    }, READ_MS);
  }

  private showChip(card: CardId, rarity: Rarity, multiplier: number): void {
    const def = CARD_BY_ID[card] ?? CARD_BY_ID.plain;
    const r: Rarity = rarity ?? def.rarity;
    this.chip.replaceChildren();
    this.chip.className = `jjr-chip jjr-r-${r}`;
    this.chip.style.setProperty("--rc", RARITY_COLORS[r]);
    el("span", "jjr-chip-emoji", this.chip).textContent = def.emoji;
    const body = el("span", "jjr-chip-body", this.chip);
    const top = el("span", "jjr-chip-top", body);
    el("span", "jjr-chip-name", top).textContent = def.name;
    el("span", "jjr-chip-mult", top).textContent = fmtMult(multiplier || def.multiplier);
    el("span", "jjr-chip-text", body).textContent = def.text;
    if (r === "cursed") el("span", "jjr-chip-skull", this.chip).textContent = "💀";
    void this.chip.offsetWidth;
    this.chip.classList.add("is-on");
  }

  private clearTimers(): void {
    if (this.collapseTimer) clearTimeout(this.collapseTimer);
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    if (this.landTimer) clearTimeout(this.landTimer);
    this.landTimer = 0;
    this.collapseTimer = 0;
    this.leaveTimer = 0;
  }
}
