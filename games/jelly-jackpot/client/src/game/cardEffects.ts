// Screen-side card effects for the LOCAL active player only (everyone else sees normally). Owner: client-game.
// upsideDown → camera roll, fog → kitchen steam, blindfold → lights out 2 s into placing (until the drop).
// Mirror Hands / Tied Hands are Controls options (see placement.ts). Diffed, so update() is cheap per frame.

import type { CardId } from "../../../shared/constants";
import type { Phase } from "../../../shared/protocol";
import type { Fx } from "../scene/Fx";
import type { Stage } from "../scene/Stage";

/** Seconds into placing before the Blindfold drops. */
export const BLINDFOLD_DELAY_SEC = 2;

export interface CardEffectInput {
  phase: Phase;
  card: CardId | "";
  /** I am the active player. */
  mine: boolean;
  /** Seconds since placing started for this turn (0 outside placing). */
  placingElapsed: number;
  /** All my pieces for this turn are dropped. */
  doneDropping: boolean;
}

export class CardEffects {
  private upside = false;
  private fog = false;
  private blind = false;

  constructor(
    private stage: Stage,
    private fx: Fx,
  ) {}

  update(i: CardEffectInput): void {
    const inTurn = i.mine && (i.phase === "placing" || i.phase === "settling");
    this.setUpside(inTurn && i.card === "upsideDown");
    this.setFog(inTurn && i.card === "fog");
    this.setBlind(i.mine && i.phase === "placing" && i.card === "blindfold" && i.placingElapsed >= BLINDFOLD_DELAY_SEC && !i.doneDropping);
  }

  /** Turn everything off (end of turn, leaving the room). */
  reset(): void {
    this.setUpside(false);
    this.setFog(false);
    this.setBlind(false);
  }

  private setUpside(on: boolean): void {
    if (on === this.upside) return;
    this.upside = on;
    this.stage.setUpsideDown(on);
  }
  private setFog(on: boolean): void {
    if (on === this.fog) return;
    this.fog = on;
    this.stage.setFog(on);
  }
  private setBlind(on: boolean): void {
    if (on === this.blind) return;
    this.blind = on;
    this.fx.setBlindfold(on);
  }
}
