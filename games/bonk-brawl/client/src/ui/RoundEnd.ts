// Round-end card (3 s). Owner: client-ui.

import { el, play, setOutlinedText, setText } from "./dom";
import type { RoundEndModel, RoundEndRow } from "./models";

const COUNT_DELAY_MS = 450;
const COUNT_MS = 700;
const ROW_STAGGER_MS = 90;

interface Counter {
  node: HTMLElement;
  from: number;
  to: number;
  prefix: string;
  delay: number;
  done: boolean;
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * "<emoji> <Name> WINS ROUND 2!" (or "DRAW!") in the winner's color, a dancing emoji/portrait,
 * and per-player "+N" round points with running totals (count-up animation). The 3D winner dance
 * is the characters' "victory" trigger, not this card.
 */
export class RoundEndCard {
  readonly el: HTMLElement = document.createElement("div");

  private readonly card = el("div", "panel round-end__card");
  private readonly eyebrow = el("p", "round-end__eyebrow");
  private readonly portrait = el("div", "round-end__portrait");
  private readonly title = el("h2", "round-end__title outlined");
  private readonly subtitle = el("p", "round-end__subtitle");
  private readonly list = el("ol", "round-end__rows");
  private readonly footer = el("p", "round-end__next");
  private counters: Counter[] = [];
  private raf = 0;
  private startedAt = 0;
  private hideAnim: Animation | null = null;

  constructor() {
    this.el.className = "round-end";
    this.el.hidden = true;
    this.el.setAttribute("role", "status");
    this.card.append(this.eyebrow, this.portrait, this.title, this.subtitle, this.list, this.footer);
    this.el.append(this.card);
  }

  show(model: RoundEndModel): void {
    this.hideAnim?.cancel();
    this.hideAnim = null;
    this.renderHeader(model);
    this.renderRows(model.rows);
    this.footer.replaceChildren(
      model.nextRound > 0 ? `Round ${model.nextRound} coming up` : "Final results coming up",
      el("span", "waiting-dots", el("i"), el("i"), el("i")),
    );
    this.el.hidden = false;
    play(this.card, [
      { transform: "translateY(-60px) scale(0.7) rotate(-4deg)", opacity: 0 },
      { transform: "translateY(6px) scale(1.04) rotate(1deg)", opacity: 1, offset: 0.6 },
      { transform: "none", opacity: 1 },
    ], { duration: 520, easing: "cubic-bezier(.3,1.3,.5,1)" });
    this.startCounting();
  }

  hide(): void {
    if (this.el.hidden || this.hideAnim) return;
    cancelAnimationFrame(this.raf);
    const anim = play(this.card, [{ transform: "none", opacity: 1 }, { transform: "translateY(-30px) scale(0.9)", opacity: 0 }], {
      duration: 220,
      easing: "ease-in",
      fill: "forwards",
    });
    const done = () => {
      this.el.hidden = true;
      this.hideAnim = null;
      anim?.cancel();
    };
    if (!anim) return done();
    this.hideAnim = anim;
    anim.onfinish = done;
  }

  private renderHeader(model: RoundEndModel): void {
    const w = model.winner;
    this.eyebrow.textContent = `Round ${model.round} of ${model.totalRounds}`;
    this.card.style.setProperty("--slot", w?.color ?? "#FFCF33");
    this.card.classList.toggle("is-draw", !w);
    this.portrait.replaceChildren(el("span", "round-end__emoji", w ? w.emoji : "🤝"));
    setOutlinedText(this.title, w ? `${w.name} wins!` : "Draw!");
    this.subtitle.textContent = w ? `Last one standing in round ${model.round}` : "Nobody survived that one…";
  }

  private renderRows(rows: readonly RoundEndRow[]): void {
    this.counters = [];
    const items = rows.map((r, i) => {
      const plus = el("span", "round-end__plus", "+0");
      const total = el("span", "round-end__total", String(r.totalPoints - r.roundPoints));
      const delay = COUNT_DELAY_MS + i * ROW_STAGGER_MS;
      this.counters.push({ node: plus, from: 0, to: r.roundPoints, prefix: "+", delay, done: false });
      this.counters.push({ node: total, from: r.totalPoints - r.roundPoints, to: r.totalPoints, prefix: "", delay, done: false });

      const li = el(
        "li",
        "round-end__row",
        el("i", "color-dot"),
        el("span", "round-end__avatar", r.emoji),
        el("span", "round-end__name", r.name),
        r.isWinner ? el("span", "round-end__trophy", "🏆") : null,
        r.isYou ? el("span", "tag tag--you", "YOU") : null,
        plus,
        el("span", "round-end__total-wrap", total, el("small", "", "pts")),
      );
      li.style.setProperty("--slot", r.color);
      li.classList.toggle("is-winner", r.isWinner);
      li.classList.toggle("is-zero", r.roundPoints === 0);
      play(li, [{ transform: "translateX(-24px)", opacity: 0 }, { transform: "none", opacity: 1 }], {
        duration: 300,
        delay: 180 + i * ROW_STAGGER_MS,
        easing: "ease-out",
        fill: "backwards",
      });
      return li;
    });
    this.list.replaceChildren(...items);
  }

  private startCounting(): void {
    cancelAnimationFrame(this.raf);
    this.startedAt = performance.now();
    const tick = (now: number) => {
      let running = false;
      for (const c of this.counters) {
        if (c.done) continue;
        const t = Math.max(0, Math.min(1, (now - this.startedAt - c.delay) / COUNT_MS));
        const value = Math.round(c.from + (c.to - c.from) * easeOut(t));
        setText(c.node, `${c.prefix}${value}`);
        if (t < 1) {
          running = true;
          continue;
        }
        c.done = true;
        if (c.prefix && c.to > 0) play(c.node, [{ transform: "scale(1.6)" }, { transform: "scale(1)" }], { duration: 280, easing: "ease-out" });
      }
      if (running) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
