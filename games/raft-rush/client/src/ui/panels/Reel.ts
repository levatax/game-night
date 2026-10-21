// "What did I get?" reels (§8): the fish loot strip and the treasure-chest strip, Jelly CaseReel style. A strip of
// rarity-colored cards decelerates past a golden marker (a tick on every card boundary) and stops exactly on the
// server's card, strip[stopIndex], at durationMs; the winner pops with rays, the rest dim, a result card says
// what it does and a quip lands. A shiny card parked next to a plain winner makes the reel stop a hair short of it
// ("SO CLOSE!"). Your own reels are big (top center, never over the crosshair); teammates' reels are small cards
// on the right edge. Adapted from games/jelly-jackpot/client/src/ui/CaseReel.ts + reel.css. Owner: client-ui.

import type { FishLoot, TreasureId } from "../../../../shared/types";
import { lootName, t, treasureName } from "../../i18n";
import { lootIcon, LOOT_RARITY, RARITY_COLORS, RARITY_RANK, TREASURE_ICON, TREASURE_RARITY, type Rarity } from "../content";
import { el, fill, pickVariant, setText } from "../dom";
import type { ReelModel } from "../models";

interface SpinCard {
  icon: string;
  name: string;
  rarity: Rarity;
  /** What it does (items.loot_<id>_desc / items.treasure_<id>_desc), already translated. */
  desc: string;
}

interface SpinHandlers {
  tick(speed01: number): void;
  rest(winAt: number, teaseAt: number | null): void;
}

/** Lever lurch before the spin (strip jerks back a little). */
const WINDUP_MS = 110;
/** Deceleration exponent (higher = longer crawl at the end). */
const K_NORMAL = 3.2;
const K_TEASE = 4.2;
/** Big reel: how long the result stays before the reel floats away. */
const READ_MS = 1900;
/** Small reels of teammates: extra time on screen after they stop. */
const MINI_READ_MS = 2200;
const MINI_MAX = 2;
const QUEUE_MAX = 2;

function cardOf(kind: ReelModel["kind"], id: FishLoot | TreasureId): SpinCard {
  if (kind === "treasure") {
    const tid = id as TreasureId;
    return { icon: TREASURE_ICON[tid] ?? "🎁", name: treasureName(tid), rarity: TREASURE_RARITY[tid] ?? "rare", desc: t(`items.treasure_${tid}_desc`) };
  }
  const fid = id as FishLoot;
  return { icon: lootIcon(fid), name: lootName(fid), rarity: LOOT_RARITY[fid] ?? "common", desc: t(`items.loot_${fid}_desc`) };
}

/** Deterministic 0..1 from the strip so the stop offset is the same for everyone watching the same catch. */
function stripHash(ids: readonly string[], salt: number): number {
  let h = 2166136261 ^ salt;
  for (const id of ids) for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10007) / 10007;
}

/** One strip in a window: builds the cards and drives the motion with requestAnimationFrame. */
class Spinner {
  readonly win: HTMLElement;
  private readonly strip = el("div", "rr-reel__strip");
  private readonly cards = new Map<number, HTMLElement>();
  private raf = 0;
  private safety = 0;
  private x = 0;
  private x0 = 0;
  private d = 0;
  private k = K_NORMAL;
  private t0 = 0;
  private dur = 1;
  private vmax = 1;
  private lastBoundary = 0;
  private halfW = 200;
  private winAt = 0;
  private teaseAt: number | null = null;
  private handlers: SpinHandlers | null = null;
  private done = false;
  private tickFlip = false;

  /** Card pitch in px (re-measured from CSS at every start; the constructor value is the fallback). */
  constructor(
    className: string,
    private pitch: number,
    private readonly names: boolean,
  ) {
    this.win = el("div", `rr-reel__window ${className}`, this.strip, el("div", "rr-reel__vignette"), el("div", "rr-reel__marker", el("i"), el("i")));
    this.strip.setAttribute("aria-hidden", "true");
  }

  start(strip: readonly SpinCard[], ids: readonly string[], stopIndex: number, durationMs: number, h: SpinHandlers): void {
    this.stop();
    this.handlers = h;
    this.done = false;
    for (const c of this.cards.values()) c.remove();
    this.cards.clear();
    const n = strip.length;
    const at = (i: number) => strip[((i % n) + n) % n]!;
    const stop = Math.max(0, Math.min(n - 1, stopIndex));
    // Cards are sized in CSS (--u units): measure the pitch from the first one (card width + its side gaps).
    this.place(0, strip[0]!);
    const probe = this.cards.get(0);
    if (probe && probe.offsetWidth > 0) this.pitch = probe.offsetWidth + 2 * probe.offsetLeft;
    if (probe) probe.style.translate = "0px 0";
    const P = this.pitch;
    // Fill a few cards before the strip so the window is never empty, and enough after the stop.
    for (let i = -6; i < Math.max(n, stop + 8); i++) if (i !== 0) this.place(i, i >= 0 && i < n ? strip[i]! : at(i + 3));

    const win = strip[stop]!;
    const prev = strip[stop - 1];
    const next = strip[stop + 1];
    const shinier = (c: SpinCard | undefined) => !!c && RARITY_RANK[c.rarity] >= RARITY_RANK.epic && RARITY_RANK[c.rarity] > RARITY_RANK[win.rarity];
    const teaseNext = shinier(next);
    const teasePrev = !teaseNext && shinier(prev);
    let off = (stripHash(ids, 7) - 0.5) * 0.6 * P;
    if (teaseNext) off = 0.42 * P;
    if (teasePrev) off = -0.42 * P;
    this.k = teaseNext || teasePrev ? K_TEASE : K_NORMAL;
    this.winAt = stop;
    this.teaseAt = teaseNext ? stop + 1 : teasePrev ? stop - 1 : null;

    const w = this.win.clientWidth;
    this.halfW = (w > 0 ? w : P * 5) / 2;
    this.x0 = P * 1.5;
    this.x = this.x0;
    this.d = stop * P + P / 2 + off - this.x0;
    this.dur = Math.max(400, durationMs - WINDUP_MS) / 1000;
    this.vmax = (this.d * this.k) / this.dur;
    this.lastBoundary = Math.floor(this.x / P);
    this.t0 = performance.now();
    this.apply();
    const frame = (now: number) => {
      this.raf = 0;
      this.advance(now);
      if (!this.done) this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
    // Background tabs pause rAF: still land on time.
    this.safety = window.setTimeout(() => this.advance(this.t0 + durationMs + 1), durationMs + 150);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    window.clearTimeout(this.safety);
    this.raf = 0;
    this.done = true;
  }

  private place(idx: number, c: SpinCard): void {
    const card = el("div", `rr-reel__card rr-rarity--${c.rarity}`, el("span", "rr-reel__card-icon", c.icon), this.names ? el("span", "rr-reel__card-name", c.name) : null);
    card.style.setProperty("--rc", RARITY_COLORS[c.rarity]);
    card.style.translate = `${idx * this.pitch}px 0`;
    this.strip.append(card);
    this.cards.set(idx, card);
  }

  private advance(now: number): void {
    if (this.done) return;
    const P = this.pitch;
    const elapsed = now - this.t0;
    let v = 0;
    if (elapsed < WINDUP_MS) {
      const s = elapsed / WINDUP_MS;
      this.x = this.x0 - 0.5 * P * Math.sin(s * Math.PI);
    } else {
      const s = Math.min(1, (elapsed - WINDUP_MS) / 1000 / this.dur);
      this.x = this.x0 + this.d * (1 - Math.pow(1 - s, this.k));
      v = ((this.d * this.k) / this.dur) * Math.pow(1 - s, this.k - 1);
      if (s >= 1) {
        this.x = this.x0 + this.d;
        v = 0;
      }
    }
    const boundary = Math.floor(this.x / P);
    if (boundary !== this.lastBoundary) {
      this.lastBoundary = boundary;
      this.handlers?.tick(Math.min(1, v / this.vmax));
      if (v < this.vmax * 0.35) {
        // Two identical keyframe classes in turn restart the marker flick on every slow boundary.
        this.tickFlip = !this.tickFlip;
        this.win.classList.toggle("is-tick-a", this.tickFlip);
        this.win.classList.toggle("is-tick-b", !this.tickFlip);
      }
    }
    this.strip.dataset.blur = v > this.vmax * 0.7 ? "2" : v > this.vmax * 0.4 ? "1" : "0";
    this.apply();
    if (elapsed >= WINDUP_MS && v === 0) this.rest();
  }

  private apply(): void {
    this.strip.style.transform = `translate3d(${(this.halfW - this.x).toFixed(2)}px,0,0)`;
  }

  private rest(): void {
    this.stop();
    this.strip.dataset.blur = "0";
    this.strip.classList.add("is-landed");
    for (const [idx, c] of this.cards) {
      c.classList.toggle("is-win", idx === this.winAt);
      c.classList.toggle("is-tease", idx === this.teaseAt);
    }
    this.handlers?.rest(this.winAt, this.teaseAt);
  }

  reset(): void {
    this.stop();
    this.strip.classList.remove("is-landed");
  }
}

export class Reel {
  readonly el = el("div", "rr-reels");
  private readonly stage = el("div", "rr-reel");
  private readonly title = el("div", "rr-reel__title");
  private readonly housing = el("div", "rr-reel__housing");
  private readonly rays = el("div", "rr-reel__rays");
  private readonly result = el("div", "rr-reel__result");
  private readonly quip = el("div", "rr-reel__quip");
  private readonly spinner = new Spinner("rr-reel__window--big", 112, true);
  private readonly minis = el("div", "rr-reel-minis");
  private readonly queue: ReelModel[] = [];
  /** The big reel on screen until it lands (its onLanded is still owed). */
  private current: ReelModel | null = null;
  private busy = false;
  private leaveTimer = 0;
  private lastTickAt = 0;
  private seed = 0;

  constructor(private readonly onTick: () => void) {
    this.housing.append(el("span", "rr-reel__bobber"), this.spinner.win);
    this.spinner.win.prepend(this.rays);
    // The result replaces the title above the window once it lands (keeps the reel clear of the crosshair).
    this.stage.append(this.title, this.result, this.housing, this.quip);
    this.stage.hidden = true;
    this.el.append(this.stage, this.minis);
    this.el.setAttribute("aria-live", "polite");
  }

  show(m: ReelModel, calm: boolean): void {
    if (m.strip.length === 0) return landed(m);
    if (m.who) return this.showMini(m);
    if (this.busy) {
      if (this.queue.length >= QUEUE_MAX) landed(this.queue.shift());
      this.queue.push(m);
      return;
    }
    this.startBig(m, calm);
  }

  clear(): void {
    this.spinner.stop();
    window.clearTimeout(this.leaveTimer);
    landed(this.current);
    this.current = null;
    for (const m of this.queue.splice(0)) landed(m);
    this.busy = false;
    this.stage.hidden = true;
    this.minis.replaceChildren();
  }

  private startBig(m: ReelModel, calm: boolean): void {
    this.busy = true;
    this.current = m;
    window.clearTimeout(this.leaveTimer);
    this.seed++;
    const cards = m.strip.map((id) => cardOf(m.kind, id));
    setText(this.title, t(m.kind === "treasure" ? "panels.reelTitleTreasure" : "panels.reelTitleFish"));
    this.stage.className = `rr-reel rr-reel--${m.kind}${calm ? " is-calm" : ""}`;
    this.stage.hidden = false;
    this.result.className = "rr-reel__result";
    this.result.replaceChildren();
    this.quip.className = "rr-reel__quip";
    this.quip.textContent = "";
    this.rays.className = "rr-reel__rays";
    this.housing.style.removeProperty("--rc");
    this.spinner.reset();
    this.spinner.start(cards, m.strip, m.stopIndex, Math.max(600, m.durationMs), {
      tick: (speed) => this.tick(speed),
      rest: (winAt, teaseAt) => {
        this.restBig(cards[winAt] ?? cards[0]!, teaseAt !== null);
        if (this.current === m) this.current = null;
        landed(m);
      },
    });
  }

  private tick(speed01: number): void {
    const now = performance.now();
    // A full-speed reel crosses ~30 cards a second: thin the ticks out while it's a blur.
    if (now - this.lastTickAt < (speed01 > 0.6 ? 90 : 40)) return;
    this.lastTickAt = now;
    this.onTick();
  }

  private restBig(win: SpinCard, tease: boolean): void {
    const rc = RARITY_COLORS[win.rarity];
    this.housing.style.setProperty("--rc", rc);
    this.stage.classList.add("is-landed", `rr-rarity--${win.rarity}`);
    this.rays.className = `rr-reel__rays is-on rr-rarity--${win.rarity}`;
    this.rays.style.setProperty("--rc", rc);

    const desc = win.desc;
    fill(
      this.result,
      el("span", "rr-reel__result-tag", t(`panels.rarity_${win.rarity}`)),
      el("span", "rr-reel__result-head", el("span", "rr-reel__result-icon", win.icon), el("span", "rr-reel__result-name", win.name)),
      desc ? el("span", "rr-reel__result-desc", desc) : null,
    );
    this.result.style.setProperty("--rc", rc);
    this.result.className = `rr-reel__result is-on rr-rarity--${win.rarity}`;
    this.quip.textContent = pickVariant(t(`panels.quips_${tease ? "tease" : win.rarity}`), this.seed * 7 + win.name.length);
    this.quip.style.setProperty("--rc", rc);
    this.quip.className = `rr-reel__quip is-on rr-rarity--${win.rarity}`;
    this.leaveTimer = window.setTimeout(() => this.leaveBig(), READ_MS);
  }

  private leaveBig(): void {
    this.stage.classList.add("is-leaving");
    this.leaveTimer = window.setTimeout(() => {
      this.stage.hidden = true;
      this.stage.classList.remove("is-leaving");
      this.busy = false;
      const next = this.queue.shift();
      if (next) this.startBig(next, this.stage.classList.contains("is-calm"));
    }, 320);
  }

  private showMini(m: ReelModel): void {
    while (this.minis.childElementCount >= MINI_MAX) this.minis.firstElementChild?.remove();
    const cards = m.strip.map((id) => cardOf(m.kind, id));
    const spinner = new Spinner("rr-reel__window--mini", 44, false);
    const result = el("div", "rr-reel-mini__result");
    const box = el(
      "div",
      `rr-reel-mini rr-reel-mini--${m.kind}`,
      el("div", "rr-reel-mini__title", t(m.kind === "treasure" ? "panels.reelTitleOtherTreasure" : "panels.reelTitleOther", { name: m.who })),
      spinner.win,
      result,
    );
    this.minis.append(box);
    spinner.start(cards, m.strip, m.stopIndex, Math.max(600, m.durationMs), {
      tick: () => undefined,
      rest: (winAt) => {
        const win = cards[winAt] ?? cards[0]!;
        result.replaceChildren(el("span", "", win.icon), el("b", "", win.name));
        result.style.setProperty("--rc", RARITY_COLORS[win.rarity]);
        box.classList.add("is-landed", `rr-rarity--${win.rarity}`);
        landed(m);
        window.setTimeout(() => {
          box.classList.add("is-leaving");
          window.setTimeout(() => box.remove(), 320);
        }, MINI_READ_MS);
      },
    });
  }
}

/** Fire a model's onLanded once (it is cleared so a second call does nothing). */
function landed(m: ReelModel | null | undefined): void {
  const fn = m?.onLanded;
  if (!m || !fn) return;
  m.onLanded = undefined;
  try {
    fn();
  } catch (err) {
    console.error("[reel] onLanded threw", err);
  }
}
