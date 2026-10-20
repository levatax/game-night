// Home-screen attract loop: a LOCAL fake game at the table behind the menu (no server). Characters shows
// the sample gangsters and Cemil shuffling (characters.setAttract); this plays the rules on top of them:
// four fake seats take turns flipping real card faces, the siren lamp climbs with every card, someone
// KASALAs into a money rain or gets raided and the pot slides into the glass kumbara. Quiet on purpose
// (soft sfx, no announcer, no full-screen strobes) so it never fights the menu.

import {
  CARDS,
  CARD_BY_ID,
  PALETTE,
  PLAYER_COLORS,
  START_KASA,
  START_KUMBARA,
  raidChance,
  type CardDef,
} from "../../../shared/constants";
import type * as THREE from "three";
import type { CardMsg } from "../../../shared/protocol";
import { money } from "../app/ui";
import type { SeatProps } from "../scene/Stage";
import { withTimeout, type Ctx } from "./context";

const SEATS = 4;
const NAMES = ["Topal Rıza", "Kel Mahmut", "Sarı Necmi", "Çakal Cemal"];
/** Cards the demo can show without a target picker or the wheel. */
const POOL: readonly CardDef[] = CARDS.filter(
  (c) => c.kind === "money" || c.id === "aklama" || c.id === "rusvet" || c.id === "avukat",
);
const POOL_WEIGHT = POOL.reduce((sum, c) => sum + c.weight, 0);
const SOFT = 0.22;

function rollCard(): CardDef {
  let r = Math.random() * POOL_WEIGHT;
  for (const c of POOL) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return POOL[0];
}

type Mode = "idle" | "turn" | "between";

export class Attract {
  private on = false;
  private gen = 0;
  private mode: Mode = "idle";
  private timer = 0;
  private active = 0;
  private kasas: number[] = [];
  private kumbara = START_KUMBARA;
  private level = 0;
  private pot = 0;
  private flips = 0;
  private lawyers = 0;
  private flipping = false;

  constructor(private ctx: Ctx) {}

  get running(): boolean {
    return this.on;
  }

  start(): void {
    this.gen++;
    this.on = true;
    this.kasas = Array.from({ length: SEATS }, () => START_KASA);
    this.kumbara = START_KUMBARA;
    this.active = Math.floor(Math.random() * SEATS);
    this.mode = "between";
    this.timer = 2.2;
    this.newTurnState();
    this.ctx.cards.clearTurn();
    this.ctx.stage.setKumbara(this.kumbara);
    this.ctx.stage.setSiren(0);
    this.pushSeats(false);
  }

  stop(): void {
    if (!this.on) return;
    this.on = false;
    this.gen++;
    this.mode = "idle";
    this.flipping = false;
    this.ctx.cards.clearTurn();
    this.ctx.cards.setLawyers(null, 0);
    this.ctx.stage.setSiren(0);
    this.ctx.stage.setSeats([]);
  }

  update(dt: number): void {
    if (!this.on || this.flipping) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    if (this.mode === "between") {
      this.active = (this.active + 1) % SEATS;
      this.newTurnState();
      this.ctx.cards.clearTurn();
      this.ctx.cards.setLawyers(null, 0);
      this.ctx.stage.setSiren(raidChance(0));
      this.pushSeats(true);
      this.mode = "turn";
      this.timer = 1.1;
      return;
    }
    // Push your luck like a real gambler: bolder early, nervous once the lamp turns red.
    const chance = raidChance(this.level);
    const cashOdds = this.flips < 2 ? 0 : 0.12 + this.flips * 0.1 + chance * 0.5;
    if (Math.random() < cashOdds) this.cash();
    else this.flip();
  }

  private newTurnState(): void {
    this.level = 0;
    this.pot = 0;
    this.flips = 0;
    this.lawyers = 0;
  }

  private seatId(i: number): string {
    return `attract-${i}`;
  }

  private pushSeats(turnLive: boolean): void {
    const seats: SeatProps[] = this.kasas.map((kasa, i) => ({
      seat: i,
      color: PLAYER_COLORS[i],
      nickname: NAMES[i],
      kasa,
      active: turnLive && i === this.active,
      ghost: false,
      connected: true,
    }));
    this.ctx.stage.setSeats(seats);
  }

  private flip(): void {
    const c = this.ctx;
    const gen = this.gen;
    const pose = c.stage.seatPose(this.active, SEATS);
    this.flips++;
    const raidRoll = Math.random() < raidChance(this.level) * 0.85;
    const def = raidRoll ? CARD_BY_ID.baskin : rollCard();
    const saved = raidRoll && this.lawyers > 0;
    let value = 0;
    if (def.kind === "money") value = def.value;
    else if (def.id === "aklama") value = this.pot;
    if (!raidRoll) this.pot += value;
    if (saved) this.lawyers--;
    if (def.id === "avukat") this.lawyers++;
    this.level = def.id === "rusvet" ? Math.max(0, this.level + 1 - def.value) : this.level + 1;
    const msg: CardMsg = {
      playerId: this.seatId(this.active),
      flipNo: this.flips,
      card: def.id,
      rarity: def.rarity,
      value,
      pot: this.pot,
      sirenLevel: this.level,
      raidChance: raidChance(this.level),
      curseHit: false,
      saved,
      needsTarget: false,
    };
    this.flipping = true;
    c.audio.sfx("flip", { volume: SOFT });
    const done = pose ? c.cards.flip(msg, pose) : undefined;
    void withTimeout(done, 1600).then(() => {
      if (gen !== this.gen) return;
      this.flipping = false;
      const at = pose ? pose.stack.clone().setY(pose.stack.y + 0.1) : null;
      if (raidRoll && !saved) {
        this.raid(at);
        return;
      }
      if (at && value > 0) c.fx.floatText(at, money(value, true), PALETTE.money);
      if (at && def.id === "rusvet") c.fx.floatText(at, "Siren −2", PALETTE.money);
      if (at && saved) c.fx.floatText(at, "⚖️ Kurtuldu!", "#3FA7FF");
      if (value > 0) c.audio.sfx(value >= 50 ? "kaching" : "coins", { volume: SOFT });
      c.cards.setLawyers(this.lawyers > 0 && pose ? pose : null, this.lawyers);
      c.stage.setSiren(raidChance(this.level));
      this.timer = 1.3 + Math.random() * 0.9;
    });
  }

  private cash(): void {
    const c = this.ctx;
    const pose = c.stage.seatPose(this.active, SEATS);
    const at = pose ? pose.stack.clone().setY(pose.stack.y + 0.1) : null;
    this.kasas[this.active] += this.pot;
    if (at && this.pot > 0) {
      c.fx.moneyRain(at, this.pot);
      c.fx.floatText(at, `KASALA! ${money(this.pot, true)}`, PALETTE.money);
    }
    c.audio.sfx("kaching", { volume: SOFT });
    c.stage.setSiren(0);
    this.pushSeats(false);
    this.endTurn(2.6);
  }

  private raid(at: THREE.Vector3 | null): void {
    const c = this.ctx;
    const bribe = Math.min(this.kasas[this.active], Math.floor(this.kasas[this.active] * 0.1));
    this.kasas[this.active] -= bribe;
    this.kumbara += this.pot + bribe;
    c.fx.flash(PALETTE.siren, 0.18);
    c.audio.sfx("siren", { volume: SOFT * 0.8 });
    if (at) {
      c.fx.floatText(at, "BASKIN!", PALETTE.siren);
      void c.fx.chips(at, c.stage.anchors.kumbara, 5, PLAYER_COLORS[this.active]);
    }
    const gen = this.gen;
    setTimeout(() => {
      if (gen !== this.gen) return;
      c.stage.setKumbara(this.kumbara);
      c.stage.pulseKumbara("in");
    }, 700);
    c.stage.setSiren(0);
    // Rich enough fake tables keep the demo from going broke forever.
    if (this.kasas[this.active] < 60) this.kasas[this.active] = START_KASA;
    if (this.kumbara > 900) this.kumbara = START_KUMBARA;
    this.pushSeats(false);
    this.endTurn(3);
  }

  private endTurn(wait: number): void {
    this.mode = "between";
    this.timer = wait;
  }
}
